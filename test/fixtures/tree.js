// A whole-directory content snapshot, used to prove the two claims the import model rests
// on: `diff` writes nothing at all, and a refused apply writes nothing outside its own
// staging directory.
//
// The comparison is by CONTENT, not by mtime, because a copy that restores the same bytes
// with a fresh timestamp is a successful rollback, not a failure — and because a test that
// compares timestamps fails for reasons that have nothing to do with the property.

import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import path from "node:path";

export async function snapshotTree(root, { skip = [] } = {}) {
  const out = new Map();
  const walk = async (directory, relative) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const key = relative ? `${relative}/${entry.name}` : entry.name;
      if (skip.some((prefix) => key === prefix || key.startsWith(`${prefix}/`))) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        out.set(key, `symlink:${await readlink(full).catch(() => "?")}`);
        continue;
      }
      if (entry.isDirectory()) {
        out.set(key, "dir");
        await walk(full, key);
        continue;
      }
      const info = await lstat(full);
      const bytes = await readFile(full).catch(() => Buffer.alloc(0));
      out.set(key, `file:${(info.mode & 0o7777).toString(8)}:${createHash("sha256").update(bytes).digest("hex")}`);
    }
  };
  await walk(root, "");
  return out;
}

/** The changed keys between two snapshots, as readable "path: before -> after" lines. */
export function treeDiff(before, after) {
  const changes = [];
  for (const [key, value] of after) {
    if (!before.has(key)) changes.push(`${key}: added (${value})`);
    else if (before.get(key) !== value) changes.push(`${key}: changed`);
  }
  for (const key of before.keys()) {
    if (!after.has(key)) changes.push(`${key}: removed`);
  }
  return changes.sort();
}
