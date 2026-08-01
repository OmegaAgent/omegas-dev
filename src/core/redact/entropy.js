// THR §3.2 Layer 4 — Shannon entropy over quoted/assigned spans, plus the validators the
// other layers share: structural-placeholder suppression, digest recognition and Luhn.
//
// The load-bearing rule (THR §3.2, manifest §4.1) is that suppression is evaluated PER
// MATCHED SPAN, never per line. A real secret sitting on the same line as the word
// "EXAMPLE" is still caught, because the span is the token, not the sentence.

/** Bits per character. 0 for the empty string. */
export function shannonEntropy(value) {
  const text = String(value);
  if (text.length === 0) return 0;
  const counts = new Map();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const probability = count / text.length;
    bits -= probability * Math.log2(probability);
  }
  return bits;
}

/**
 * The alphabet a value draws from, which sets the entropy a random string of that
 * alphabet would reach: hex tops out near 4 bits/char, base64 near 6. One threshold for
 * every charset would either miss hex secrets or flood on base64 prose.
 */
export function charsetClass(value) {
  const text = String(value);
  if (/^[0-9]+$/.test(text)) return "numeric";
  if (/^[0-9a-f]+$/i.test(text)) return "hex";
  if (/^[A-Za-z0-9+/=_-]+$/.test(text)) return "base64ish";
  return "mixed";
}

const ENTROPY_FLOOR = { numeric: Infinity, hex: 3.4, base64ish: 4.0, mixed: 3.6 };

/** True when a value's randomness is consistent with a generated credential. */
export function highEntropy(value, { minLength = 20 } = {}) {
  const text = String(value);
  if (text.length < minLength) return false;
  const floor = ENTROPY_FLOOR[charsetClass(text)];
  return shannonEntropy(text) >= floor;
}

/**
 * Content digests are everywhere in these files — git shas in instructions, `sha256:` in
 * lockfile prose, `trusted_hash` in a hook trust ledger. They are high-entropy and they
 * are not credentials, so the generic detector skips the exact widths that identify them.
 */
export function looksLikeDigest(value) {
  const text = String(value);
  return /^[0-9a-f]+$/i.test(text) && [7, 8, 32, 40, 56, 64, 96, 128].includes(text.length);
}

// Suppression list (manifest §4.1). Deliberately does NOT include "fake": a shape-accurate
// fake value is exactly what a seeded-recall corpus is made of, and treating "fake" as a
// placeholder would make the recall gate unfalsifiable. "example" IS suppressed, because
// vendors publish canonical example keys (AKIAIOSFODNN7EXAMPLE) that appear verbatim in
// documentation the user legitimately wants to carry.
const STRUCTURAL_SPAN = [
  /^\$\{[^}]*\}$/,
  /^\$[A-Za-z_][A-Za-z0-9_]*$/,
  /^%[A-Za-z_][A-Za-z0-9_]*%$/,
  /^<[^>]*>$/,
  /^\[[^\]]*\]$/,
  /^x{3,}$/i,
  /^\.{3,}$/,
  /^-+$/,
  /^\*{3,}$/,
];

const STRUCTURAL_WORDS = [
  "example",
  "changeme",
  "change_me",
  "placeholder",
  "redacted",
  "your-",
  "your_",
  "yourkey",
  "yourtoken",
  "my-secret",
  "todo",
  "insert-",
  "replace-",
  "dummy",
  "sample",
  "notarealkey",
  "xxxxx",
];

// Values that ARE the documentation. Matched exactly, not as a substring, so `password`
// is a placeholder and `password123` is a password. Every one of these appears verbatim in
// the connection strings and env templates people ship in READMEs; treating them as
// credentials is how a `.env.example` gets mangled by a tool that was trying to help.
const DOC_VALUES = new Set([
  "password",
  "passwd",
  "pass",
  "secret",
  "username",
  "user",
  "admin",
  "root",
  "token",
  "apikey",
  "api_key",
  "value",
  "string",
  "none",
  "null",
  "true",
  "false",
  "localhost",
]);

/** A span that is documentation, not a value. Evaluated on the SPAN, never on the line. */
export function isStructuralSpan(value) {
  const text = String(value).trim();
  if (text.length === 0) return true;
  if (DOC_VALUES.has(text.toLowerCase())) return true;
  if (STRUCTURAL_SPAN.some((pattern) => pattern.test(text))) return true;
  const lower = text.toLowerCase();
  if (STRUCTURAL_WORDS.some((word) => lower.includes(word))) return true;
  // A value that is only one repeated character carries no secret.
  return /^(.)\1*$/.test(text);
}

/** Luhn check digit — the one validator that makes a 16-digit run worth reporting. */
export function luhn(value) {
  const digits = String(value).replace(/[ -]/g, "");
  if (!/^[0-9]{12,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    let digit = digits.charCodeAt(index) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}
