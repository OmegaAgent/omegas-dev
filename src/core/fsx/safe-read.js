// The one read primitive. Ported, not re-derived, from src/discovery.js:50-102 —
// O_NOFOLLOW opens, lstat before plus fstat twice around the read, NUL-byte rejection,
// realpath containment against a declared root, and a byte cap.
//
// It returns a discriminated result rather than `null`, because a refusal that produces
// silence is the defect this architecture exists to close (THR §4.2 Gap 4). Over-cap
// files are TRUNCATED and reported, never dropped.

import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { insideRoot } from "./paths.js";

export async function lstatOrNull(filename) {
  try {
    return await lstat(filename);
  } catch {
    return null;
  }
}

export async function realpathOrNull(filename) {
  try {
    return await realpath(filename);
  } catch {
    return null;
  }
}

export async function safeEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function readLinkTarget(filename) {
  try {
    return await readlink(filename);
  } catch {
    return null;
  }
}

export async function pathExists(filename) {
  return (await lstatOrNull(filename)) !== null;
}

export async function containedIn(canonicalFile, roots) {
  for (const root of roots) {
    if (!root) continue;
    const canonicalRoot = await realpathOrNull(root);
    if (canonicalRoot && insideRoot(canonicalRoot, canonicalFile)) return true;
  }
  return false;
}

export async function safeReadText(filename, roots, maxBytes) {
  const info = await lstatOrNull(filename);
  if (!info) return { ok: false, reason: "missing" };
  if (info.isSymbolicLink()) return { ok: false, reason: "symlink" };
  if (!info.isFile()) return { ok: false, reason: "not a regular file" };

  const canonicalFile = await realpathOrNull(filename);
  if (!canonicalFile) return { ok: false, reason: "unresolvable realpath" };
  if (!(await containedIn(canonicalFile, roots))) {
    return { ok: false, reason: "realpath outside every declared root" };
  }

  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  let handle = null;
  try {
    handle = await open(filename, flags);
  } catch {
    return { ok: false, reason: "open refused (O_NOFOLLOW)" };
  }
  try {
    const before = await handle.stat();
    if (!before.isFile()) return { ok: false, reason: "not a regular file" };
    const truncated = before.size > maxBytes;
    const length = truncated ? maxBytes : before.size;
    const buffer = Buffer.alloc(length);
    if (length > 0) await handle.read(buffer, 0, length, 0);
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs
    ) {
      return { ok: false, reason: "file changed during read" };
    }
    if (buffer.includes(0)) return { ok: false, reason: "binary content (NUL byte)" };
    return {
      ok: true,
      text: buffer.toString("utf8"),
      bytes: before.size,
      read_bytes: length,
      truncated,
      exec_bit: Boolean(before.mode & 0o111),
      fingerprint: {
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeMs: before.mtimeMs,
        canonicalFile,
      },
    };
  } finally {
    await handle.close();
  }
}

export function eolOf(text) {
  return text.includes("\r\n") ? "crlf" : "lf";
}
