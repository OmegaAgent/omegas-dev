// The write primitives (adapter-architecture §5.3, THR §3.4). Nothing else in the tree
// creates or replaces a file on the target machine.
//
// The rules, each closing a named threat:
//   • per-run staging at 0700 under the TARGET home's state dir           T-S5
//   • snapshot every file the apply will touch, before the first write    §5.3.4
//   • re-verify each target's fingerprint immediately before its write    T-I13
//   • realpath(dirname(target)) containment re-checked AT WRITE TIME      T-I2
//   • O_NOFOLLOW | O_EXCL on the temp file, then rename into place        T-I2
//   • any failure rolls every written file back and verifies the restore  T-I10
//
// The write-time containment re-check is the one that matters most: a plan-time check is
// defeated by a symlink that an earlier operation in the same import created.

import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { continuityStateDir, insideRoot } from "./paths.js";
import { fingerprintFile, sameFingerprint } from "./fingerprint.js";
import { lstatOrNull, realpathOrNull } from "./safe-read.js";

export const STAGING_MODE = 0o700;
export const FILE_MODE = 0o600;

export const APPLY_EXIT = {
  // adapter-architecture §6.1. Distinct codes because they are the difference between
  // "retry" and "stop and tell a human".
  CONTAINMENT: 7,
  TOCTOU: 8,
  ROLLED_BACK: 9,
};

export class ApplyError extends Error {
  constructor(message, exitCode, detail = {}) {
    super(message);
    this.name = "ApplyError";
    this.exitCode = exitCode;
    Object.assign(this, detail);
  }
}

/**
 * One staging directory per run, under the target home so a test home and a real home can
 * never share one. `mkdtemp` rather than a predictable name: a predictable staging path in
 * a shared location is a symlink-plant target of its own.
 */
export async function createStaging({ homeDir, planId }) {
  const base = path.join(continuityStateDir(homeDir), "runs");
  await mkdir(base, { recursive: true, mode: STAGING_MODE });
  await chmod(base, STAGING_MODE).catch(() => {});
  const dir = await mkdtemp(path.join(base, `${planId}-`));
  await chmod(dir, STAGING_MODE);
  await mkdir(path.join(dir, "snapshots"), { recursive: true, mode: STAGING_MODE });
  return {
    dir,
    snapshots: path.join(dir, "snapshots"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

/**
 * A target is legal when its directory resolves inside a root the caller declared. The
 * check runs on the REALPATH of the deepest existing ancestor, so a symlinked parent
 * cannot smuggle a write out of the tree, and it runs again immediately before the write.
 */
export async function assertContained(target, roots, label = "target") {
  if (!path.isAbsolute(target)) {
    throw new ApplyError(`${label} ${target} is not an absolute path`, APPLY_EXIT.CONTAINMENT, { target });
  }
  const canonicalRoots = [];
  for (const root of roots) {
    const canonical = await realpathOrNull(root);
    if (canonical) canonicalRoots.push(canonical);
  }
  if (canonicalRoots.length === 0) {
    throw new ApplyError(`no declared root exists to contain ${label} ${target}`, APPLY_EXIT.CONTAINMENT, { target });
  }

  // Walk up to the deepest ancestor that exists; everything below it will be created by
  // this apply and therefore cannot already be a link.
  let existing = path.dirname(target);
  const missing = [];
  for (;;) {
    if (await lstatOrNull(existing)) break;
    missing.push(path.basename(existing));
    const parent = path.dirname(existing);
    if (parent === existing) {
      throw new ApplyError(`no existing ancestor for ${label} ${target}`, APPLY_EXIT.CONTAINMENT, { target });
    }
    existing = parent;
  }
  const canonicalExisting = await realpathOrNull(existing);
  if (!canonicalExisting) {
    throw new ApplyError(`${label} ${target} has an unresolvable parent`, APPLY_EXIT.CONTAINMENT, { target });
  }
  const canonicalTarget = path.join(canonicalExisting, ...missing.reverse(), path.basename(target));
  if (!canonicalRoots.some((root) => insideRoot(root, canonicalTarget))) {
    throw new ApplyError(
      `${label} ${target} resolves outside every declared root`,
      APPLY_EXIT.CONTAINMENT,
      { target, resolved: canonicalTarget },
    );
  }
  // An existing target that is a symlink is refused outright rather than followed: writing
  // "through" it is exactly T-I2, and replacing it silently would destroy a link the user
  // put there on purpose.
  const info = await lstatOrNull(target);
  if (info?.isSymbolicLink()) {
    throw new ApplyError(`${label} ${target} is a symlink; refusing to write through it`, APPLY_EXIT.CONTAINMENT, {
      target,
    });
  }
  if (info && !info.isFile()) {
    throw new ApplyError(`${label} ${target} exists and is not a regular file`, APPLY_EXIT.CONTAINMENT, { target });
  }
  return canonicalTarget;
}

/**
 * The snapshot is the restore point. A file that does not exist yet is snapshotted as
 * `existed: false`, so rolling it back means deleting it — otherwise a failed apply leaves
 * behind exactly the files it was refused permission to leave behind.
 */
export async function snapshot({ staging, target, index }) {
  const info = await lstatOrNull(target);
  if (!info) return { target, existed: false, fingerprint: null, snapshot_entry: null };
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new ApplyError(`cannot snapshot ${target}: not a regular file`, APPLY_EXIT.CONTAINMENT, { target });
  }
  const entry = path.join(staging.snapshots, `${String(index).padStart(4, "0")}-${path.basename(target)}`);
  const bytes = await readFile(target);
  await writeFile(entry, bytes, { mode: FILE_MODE, flag: "wx" });
  return {
    target,
    existed: true,
    mode: info.mode & 0o7777,
    fingerprint: await fingerprintFile(target, [path.dirname(target)]),
    snapshot_entry: entry,
    bytes: bytes.length,
  };
}

/**
 * Write one file: containment re-check, temp file in the SAME directory (so `rename` is
 * atomic and never crosses a filesystem), then rename over the target.
 */
export async function writeContained({ target, text, roots, mode = FILE_MODE, label = "target", created = [] }) {
  await assertContained(target, roots, label);
  const directory = path.dirname(target);
  // Track the directories this write brings into existence, so a rollback can remove them
  // too. A restore that leaves behind an empty `~/.claude/skills/evil/` has not restored
  // anything the user would recognise as their machine.
  let missing = directory;
  const fresh = [];
  while (!(await lstatOrNull(missing))) {
    fresh.unshift(missing);
    const parent = path.dirname(missing);
    if (parent === missing) break;
    missing = parent;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const entry of fresh) created.push(entry);
  // Re-check after mkdir: creating the directory chain is the moment a racing symlink
  // would appear, and it is cheap to look again.
  await assertContained(target, roots, label);

  const temporary = path.join(directory, `.omegas-tmp-${process.pid}-${Date.now()}-${counter()}`);
  const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0);
  let handle = null;
  try {
    handle = await open(temporary, flags, mode);
    await handle.writeFile(text, "utf8");
  } finally {
    if (handle) await handle.close();
  }
  try {
    await chmod(temporary, mode);
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return target;
}

let sequence = 0;
function counter() {
  sequence += 1;
  return sequence;
}

/**
 * Restore every snapshot and PROVE it: a rollback that silently half-worked is worse than
 * the failure it is recovering from, so each restored file's fingerprint is re-read and
 * compared against the one captured before the apply.
 */
export async function rollback(snapshots, createdDirectories = []) {
  const restored = [];
  const failures = [];
  for (const record of [...snapshots].reverse()) {
    try {
      if (!record.existed) {
        await rm(record.target, { force: true });
        if (await lstatOrNull(record.target)) failures.push({ target: record.target, reason: "could not remove" });
        else restored.push({ target: record.target, state: "removed" });
        continue;
      }
      const bytes = await readFile(record.snapshot_entry);
      const directory = path.dirname(record.target);
      const temporary = path.join(directory, `.omegas-restore-${process.pid}-${counter()}`);
      await writeFile(temporary, bytes, { mode: record.mode ?? FILE_MODE, flag: "wx" });
      await rename(temporary, record.target);
      await chmod(record.target, record.mode ?? FILE_MODE).catch(() => {});
      const after = await fingerprintFile(record.target, [directory]);
      // dev/ino/mtimeMs necessarily differ after a restore-by-rename; the property that
      // matters is that the BYTES came back, so size plus content is what is asserted.
      const same = after && record.fingerprint && after.size === record.fingerprint.size;
      const identical = Buffer.compare(bytes, await readFile(record.target)) === 0;
      if (!same || !identical) {
        failures.push({ target: record.target, reason: "restored content does not match the snapshot" });
      } else {
        restored.push({ target: record.target, state: "restored" });
      }
    } catch (error) {
      failures.push({ target: record.target, reason: error.message });
    }
  }
  // Deepest first, and only if empty: a directory that picked up an unrelated file while
  // the apply was running is not ours to delete.
  for (const directory of [...createdDirectories].sort((a, b) => b.length - a.length)) {
    await rmdir(directory).catch(() => {});
  }
  return { restored, failures };
}

/** T-I13: the fingerprint captured at plan time, re-read immediately before the write. */
export async function verifyUnchanged({ target, before }) {
  const info = await lstatOrNull(target);
  const exists = Boolean(info);
  if (exists !== Boolean(before?.exists)) {
    return { ok: false, reason: exists ? "target appeared since the preview" : "target disappeared since the preview" };
  }
  if (!exists) return { ok: true };
  if (info.isSymbolicLink()) return { ok: false, reason: "target became a symlink since the preview" };
  const now = await fingerprintFile(target, [path.dirname(target)]);
  if (!sameFingerprint(now, before.fingerprint)) {
    return { ok: false, reason: "target changed since you reviewed this" };
  }
  return { ok: true };
}
