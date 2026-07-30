// The read side. Every rule the writer applied is RE-APPLIED here, because a bundle
// arrives from somewhere else and its manifest is attacker-controlled JSON (THR §3.4).
//
// Three refusals, three exit codes, no repairs:
//   7  an entry name violates canonicalization  — zip-slip and its Unicode/case variants
//   6  a digest does not match                  — tampering in transit (T-I11)
//   6  an unknown schema_version                — readers refuse unknown majors
//
// Nothing here writes to the filesystem. Staging, consent and apply are M3; this module
// exists now so the writer's contract is verified by an independent reader from day one.

import { CAPS } from "../policy/caps.js";
import { computeDigest, sha256 } from "./digest.js";
import { BUNDLE_EXIT, BundleError, assertEntryName } from "./names.js";
import { SCHEMA_VERSION } from "./write.js";

export function readBundle(serialized, { verifyDigest = true, caps = CAPS } = {}) {
  // T-I12 — the caps are checked on the way IN, before anything is parsed into memory or
  // reaches a planner. A bundle is attacker-supplied input, and "we would have noticed
  // later" is not a bound.
  const totalBytes = Buffer.byteLength(String(serialized));
  if (totalBytes > caps.bundle_bytes) {
    throw new BundleError(
      `bundle is ${totalBytes} bytes, over the ${caps.bundle_bytes}-byte cap`,
      BUNDLE_EXIT.INVALID,
    );
  }
  const lines = String(serialized).split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) throw new BundleError("empty bundle", BUNDLE_EXIT.INVALID);
  if (lines.length - 1 > caps.entries) {
    throw new BundleError(`bundle carries ${lines.length - 1} entries, over the ${caps.entries} cap`, BUNDLE_EXIT.INVALID);
  }

  let manifest;
  try {
    manifest = JSON.parse(lines[0]);
  } catch (error) {
    throw new BundleError(`manifest line is not JSON: ${error.message}`, BUNDLE_EXIT.INVALID);
  }
  if (manifest?.schema_version !== SCHEMA_VERSION) {
    throw new BundleError(
      `unknown schema_version ${JSON.stringify(manifest?.schema_version)}; this reader speaks ${SCHEMA_VERSION}`,
      BUNDLE_EXIT.INVALID,
    );
  }

  const seenFold = new Map();
  const entries = new Map();
  for (const line of lines.slice(1)) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (error) {
      throw new BundleError(`entry line is not JSON: ${error.message}`, BUNDLE_EXIT.INVALID);
    }
    assertEntryName(entry.name, seenFold);
    // A duplicate name is not a harmless repeat: the two lines carry different bytes, and
    // whichever the reader keeps decides what gets written. Refuse rather than pick.
    if (entries.has(entry.name)) {
      throw new BundleError(`entry ${entry.name} appears twice`, BUNDLE_EXIT.INVALID, { entry_name: entry.name });
    }
    if (typeof entry.content !== "string") {
      throw new BundleError(`entry ${entry.name} carries no content`, BUNDLE_EXIT.INVALID);
    }
    if (Buffer.byteLength(entry.content) > caps.entry_blob_bytes) {
      throw new BundleError(
        `entry ${entry.name} is over the ${caps.entry_blob_bytes}-byte per-entry cap`,
        BUNDLE_EXIT.INVALID,
        { entry_name: entry.name },
      );
    }
    const digest = `sha256:${sha256(entry.content)}`;
    if (digest !== entry.sha256) {
      throw new BundleError(`entry digest mismatch for ${entry.name}`, BUNDLE_EXIT.INVALID, { entry_name: entry.name });
    }
    entries.set(entry.name, entry);
  }

  // The declared entry list and the delivered lines have to agree in both directions: an
  // undeclared entry is smuggled content, and a declared-but-absent entry is a dangling
  // pointer that would look like a missing file at apply time.
  for (const declared of manifest.entries ?? []) {
    if (!entries.has(declared.name)) {
      throw new BundleError(`manifest declares ${declared.name}, which is not in the bundle`, BUNDLE_EXIT.INVALID);
    }
  }
  for (const name of entries.keys()) {
    if (!(manifest.entries ?? []).some((declared) => declared.name === name)) {
      throw new BundleError(`bundle carries ${name}, which the manifest does not declare`, BUNDLE_EXIT.INVALID);
    }
  }

  if (verifyDigest) {
    const recomputed = computeDigest(manifest, manifest.entries ?? []);
    if (recomputed !== manifest.bundle?.digest) {
      throw new BundleError("bundle digest mismatch", BUNDLE_EXIT.INVALID, {
        expected: manifest.bundle?.digest,
        actual: recomputed,
      });
    }
  }

  return { manifest, entries };
}

/** Resolve an item's raw bytes from the entry table. Returns null when not carried. */
export function blobText(entries, pointer) {
  if (!pointer) return null;
  const entry = entries.get(pointer);
  return entry ? entry.content : null;
}
