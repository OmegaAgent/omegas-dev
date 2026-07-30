// discovery.js:79-102 — {dev, ino, size, mtimeMs} plus the canonical path, captured at
// plan time and re-verified immediately before a write. M1 only captures them; the
// re-verify loop that aborts an apply on drift lands with the write path in M3.

import { lstatOrNull, realpathOrNull, safeReadText } from "./safe-read.js";
import { insideRoot } from "./paths.js";

const FIELDS = ["dev", "ino", "size", "mtimeMs", "canonicalFile"];

export async function fingerprintFile(filename, roots) {
  const info = await lstatOrNull(filename);
  if (!info?.isFile() || info.isSymbolicLink()) return null;
  const canonicalFile = await realpathOrNull(filename);
  if (!canonicalFile) return null;
  let contained = false;
  for (const root of roots ?? []) {
    const canonicalRoot = await realpathOrNull(root);
    if (canonicalRoot && insideRoot(canonicalRoot, canonicalFile)) {
      contained = true;
      break;
    }
  }
  if (!contained) return null;
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, canonicalFile };
}

export function sameFingerprint(a, b) {
  if (!a || !b) return false;
  return FIELDS.every((field) => a[field] === b[field]);
}

/**
 * Read a file whose fingerprint was captured earlier, refusing if anything drifted
 * between selection and read. Partial application is a corrupted setup — a worse
 * outcome than a refused one (adapter-architecture §5.3).
 */
export async function readFingerprinted({ filename, roots, fingerprint, maxBytes, label }) {
  const before = await fingerprintFile(filename, roots);
  if (!sameFingerprint(before, fingerprint)) {
    throw new Error(`${label ?? filename} changed since it was selected; re-run the scan`);
  }
  const result = await safeReadText(filename, roots, maxBytes);
  const after = await fingerprintFile(filename, roots);
  if (!result.ok || !sameFingerprint(after, fingerprint)) {
    throw new Error(`${label ?? filename} could not be read safely; re-run the scan`);
  }
  return result;
}
