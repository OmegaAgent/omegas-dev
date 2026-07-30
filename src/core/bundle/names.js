// Manifest §5.2 — entry-name canonicalization, applied on write AND re-applied on read.
// A violation on read is a hard REFUSAL, never a repair: a repaired name is an attacker's
// name that we decided to trust (THR §3.4, T-I1).
//
// The canonicalization itself lives in fsx/paths.js because it is a pure string rule the
// scanner shares. This module is the bundle-side contract around it: the fixed prefix set,
// the content-addressed blob name, and the error that carries an exit code.

import { canonicalEntryName } from "../fsx/paths.js";

export const ENTRY_PREFIXES = ["blobs/", "items/", "derived/"];

export const BUNDLE_EXIT = {
  REDACTION_GATE: 5,
  INVALID: 6,
  ENTRY_REFUSED: 7,
};

export class BundleError extends Error {
  constructor(message, exitCode, detail = {}) {
    super(message);
    this.name = "BundleError";
    this.exitCode = exitCode;
    Object.assign(this, detail);
  }
}

/**
 * Blobs are content-addressed, so an entry name carries NO user path information and a
 * collision is impossible by construction. The human-meaningful path lives in
 * `origin.display_path`, which is data and never a filesystem target.
 */
export function blobName(digest) {
  const hex = String(digest).replace(/^sha256:/, "");
  return `blobs/${hex.slice(0, 2)}/${hex}`;
}

export function assertEntryName(name, seenFold) {
  const result = canonicalEntryName(name, seenFold);
  if (!result.ok) {
    throw new BundleError(`entry name refused: ${result.reason}`, BUNDLE_EXIT.ENTRY_REFUSED, {
      entry_name: name,
      reason: result.reason,
    });
  }
  return result.name;
}

export { canonicalEntryName };
