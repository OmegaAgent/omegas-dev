// Manifest §5.1, as amended by spike-corrections §1 — the digest is CONTENT-addressed.
//
//   digest = sha256( join("\n", sorted("<entry_name>\0<entry_sha256>") + "manifest\0<manifest_sha256>") )
//
// where manifest_sha256 is taken over the manifest with `digest`, `bundle.id` AND
// `bundle.created_at` blanked. Blanking the last two is what makes the property real:
// without it, two exports of identical content produce different digests (fresh id, fresh
// timestamp), which breaks reconciliation and cross-implementation agreement. `id` and
// `created_at` stay IN the manifest; they are simply outside digest scope.
//
// The field separator is a literal NUL byte. Entry names may legally contain any
// non-control character, so a printable separator would be ambiguous — and an ambiguous
// separator is a forgeable digest, because two different entry lists can be crafted to
// serialize identically.

import { createHash } from "node:crypto";

export const DIGEST_ALGO = "sha256";
const SEPARATOR = "\u0000";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The manifest fields that are recorded but never hashed. */
export const DIGEST_EXCLUDED = ["bundle.digest", "bundle.id", "bundle.created_at"];

export function manifestDigestInput(manifest) {
  const skeleton = JSON.parse(JSON.stringify(manifest));
  skeleton.bundle.digest = "";
  skeleton.bundle.id = "";
  skeleton.bundle.created_at = "";
  return JSON.stringify(skeleton);
}

export function computeDigest(manifest, entries) {
  const records = entries
    .map((entry) => `${entry.name}${SEPARATOR}${normalizeDigest(entry.sha256)}`)
    .sort();
  records.push(`manifest${SEPARATOR}sha256:${sha256(manifestDigestInput(manifest))}`);
  return `sha256:${sha256(records.join("\n"))}`;
}

function normalizeDigest(value) {
  const text = String(value);
  return text.startsWith("sha256:") ? text : `sha256:${text}`;
}
