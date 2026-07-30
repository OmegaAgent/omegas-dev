// THR §3.3 / manifest §4.1 — the placeholder grammar and the value-identity ref registry.
//
//   {{OMEGA_REDACTED:<class>:<ref>}}
//
// No length, no prefix, no suffix, no digest of any value reaches the bundle (T-R6). The
// ref is a bundle-local sequential label assigned by value identity, so the same secret in
// five places is one ref five times — which is what defeats partial redaction (T-R5).
//
// Identity is HMAC-SHA256(random per-bundle salt, normalized value) rather than a bare
// sha256: a bare digest of a low-entropy secret is offline-crackable and correlates the
// same secret across two bundles. The salt lives only in the local secret map. Only the
// LABEL is emitted, so the bundle carries no value-derived bytes at all.

import { createHmac, randomBytes } from "node:crypto";

export const PLACEHOLDER_PATTERN = /\{\{OMEGA_REDACTED:[A-Za-z0-9_.]+:s[0-9]+\}\}/;
const PLACEHOLDER_GLOBAL = /\{\{OMEGA_REDACTED:[A-Za-z0-9_.]+:s[0-9]+\}\}/g;

export function placeholder(className, ref) {
  return `{{OMEGA_REDACTED:${className}:${ref}}}`;
}

/** Idempotency: an already-placeholdered span is never re-wrapped (manifest §4.1). */
export function containsPlaceholder(text) {
  return PLACEHOLDER_PATTERN.test(String(text));
}

export function placeholderSpans(text) {
  const spans = [];
  PLACEHOLDER_GLOBAL.lastIndex = 0;
  let match = PLACEHOLDER_GLOBAL.exec(text);
  while (match !== null) {
    spans.push({ start: match.index, end: match.index + match[0].length });
    match = PLACEHOLDER_GLOBAL.exec(text);
  }
  return spans;
}

/**
 * Replace `needle` everywhere EXCEPT inside a placeholder that is already there.
 *
 * Without the exception a value-linked sweep can rewrite the inside of its own output: a
 * detector class id like `unknown.high_entropy` is a plausible high-entropy span, and once
 * it is a known value, replacing it blindly produces
 * `{{OMEGA_REDACTED:{{OMEGA_REDACTED:…}}:s7}}` — a nested placeholder that no reader can
 * parse and no importer can re-bind.
 */
export function replaceOutsidePlaceholders(text, needle, replacement) {
  const source = String(text);
  if (needle.length === 0 || !source.includes(needle)) return source;
  const spans = placeholderSpans(source);
  let out = "";
  let cursor = 0;
  for (const span of spans) {
    out += source.slice(cursor, span.start).split(needle).join(replacement);
    out += source.slice(span.start, span.end);
    cursor = span.end;
  }
  return out + source.slice(cursor).split(needle).join(replacement);
}

/**
 * Trailing whitespace and surrounding quotes are not part of a credential, so two sites
 * that differ only there must still resolve to one ref.
 */
export function normalizeValue(value) {
  return String(value).trim().replace(/^["'`]|["'`]$/g, "");
}

export class RefRegistry {
  constructor(salt = randomBytes(32).toString("hex")) {
    this.salt = salt;
    this.byIdentity = new Map();
  }

  /**
   * Labels are handed out in first-encounter order, so two exports of identical content
   * produce identical labels even though the salt differs. That is what keeps the bundle
   * digest stable and the diff readable across runs (T-R9).
   */
  refFor(value) {
    const identity = createHmac("sha256", this.salt).update(normalizeValue(value)).digest("hex");
    const existing = this.byIdentity.get(identity);
    if (existing) return existing;
    const ref = `s${this.byIdentity.size + 1}`;
    this.byIdentity.set(identity, ref);
    return ref;
  }

  get size() {
    return this.byIdentity.size;
  }
}
