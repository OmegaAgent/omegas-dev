// THR §3.2 Layer 5 — the parsed tree walked to every leaf, so layers 2-4 reach nested
// values, array elements and, the case that actually bit a surveyed machine, string
// leaves in arrays that are not env blocks at all (`permissions.allow[]`, THR A1).
//
// Plus the one bounded decode pass (T-R10): a span that is valid base64 or percent-encoded
// and decodes to printable text is rescanned once. One level, size-capped, no recursion —
// a decode loop is a denial-of-service surface, and two levels have never been observed.

import { setKey } from "../formats/spans.js";
import { splitKeyPath } from "../fsx/paths.js";
import { assignmentSpans, flagValueSpans } from "./argv.js";
import { isStructuralSpan } from "./entropy.js";
import { detectSpans, mergeSpans, tierRank } from "./layers.js";
import { containsPlaceholder, placeholder } from "./placeholder.js";

const DECODE_MAX_BYTES = 8192;
const BASE64_TOKEN = /[A-Za-z0-9+/]{16,}={0,2}/g;

/**
 * Every shape-based layer over one string, returned as the rewritten text plus the
 * findings that produced it. The caller assigns refs and records sites: this function is
 * pure so it can be run over a serialized bundle as the post-export gate (THR §3.5).
 */
export function redactText(text, { context = "", generic = false, argv = false, refFor } = {}) {
  const source = String(text);
  if (source.length === 0) return { text: source, findings: [] };

  const spans = [
    ...detectSpans(source, { context, generic }),
    ...assignmentSpans(source),
    ...(argv ? flagValueSpans(source) : []),
    ...decodedSpans(source, { context }),
  ];
  const merged = mergeSpans(spans);
  if (merged.length === 0) return { text: source, findings: [] };

  const findings = [];
  let out = "";
  let cursor = 0;
  for (const span of merged) {
    if (span.start < cursor) continue;
    const ref = refFor ? refFor(span.value) : null;
    findings.push({
      value: span.value,
      class: span.class,
      tier: span.tier,
      detectors: span.detectors,
      key_name: span.key_name ?? null,
      line_start: lineOf(source, span.start),
      ref,
    });
    out += source.slice(cursor, span.start) + placeholder(span.class, ref ?? "s0");
    cursor = span.end;
  }
  return { text: out + source.slice(cursor), findings };
}

/**
 * The bounded decode pass. An encoded blob cannot be spliced in place — rewriting half a
 * base64 token produces something that decodes to garbage — so a hit redacts the WHOLE
 * token and says `decoded` in its detector list, which is honest about why.
 */
function decodedSpans(source, { context }) {
  if (source.length > DECODE_MAX_BYTES) return [];
  const spans = [];

  BASE64_TOKEN.lastIndex = 0;
  let match = BASE64_TOKEN.exec(source);
  while (match !== null) {
    const token = match[0];
    const decoded = decodeBase64(token);
    if (decoded !== null && !containsPlaceholder(token)) {
      const inner = detectSpans(decoded, { context }).filter((span) => tierRank(span.tier) <= 1);
      if (inner.length > 0) {
        spans.push({
          start: match.index,
          end: match.index + token.length,
          value: token,
          class: inner[0].class,
          tier: inner[0].tier,
          detector: "decoded",
          key_name: null,
        });
      }
    }
    BASE64_TOKEN.lastIndex = match.index + token.length;
    match = BASE64_TOKEN.exec(source);
  }

  if (source.includes("%")) {
    const decoded = decodePercent(source);
    if (decoded !== null && decoded !== source) {
      for (const span of detectSpans(decoded, { context })) {
        const encoded = encodeURIComponent(span.value);
        const at = source.indexOf(encoded);
        if (at !== -1) {
          spans.push({
            start: at,
            end: at + encoded.length,
            value: span.value,
            class: span.class,
            tier: span.tier,
            detector: "decoded",
            key_name: null,
          });
        }
      }
    }
  }

  return spans;
}

function decodeBase64(token) {
  if (token.length % 4 !== 0 && !token.includes("=")) return null;
  const decoded = Buffer.from(token, "base64").toString("utf8");
  if (decoded.length < 8) return null;
  // Only printable text is worth rescanning; binary that happens to decode is noise.
  return /^[\x20-\x7E\r\n\t]+$/.test(decoded) ? decoded : null;
}

function decodePercent(source) {
  try {
    return decodeURIComponent(source);
  } catch {
    return null;
  }
}

/**
 * THR A4 — a URL at a declared secret position is not redacted whole: the endpoint is the
 * portable part. Userinfo is stripped, credential-ish query parameters are placeholdered,
 * and a fragment that could carry a token is dropped. Everything else survives verbatim.
 */
export function redactUrl(raw, { refFor, note }) {
  let url;
  try {
    url = new URL(String(raw));
  } catch {
    return null;
  }
  let changed = false;
  if (url.password) {
    const value = decodePercent(url.password) ?? url.password;
    const ref = refFor(value);
    note({ value, class: "url.credential", tier: "HIGH", detectors: ["positional"], key_name: url.username || null });
    // Assign to `password`, not to a hand-built `user:placeholder` username: the URL
    // serializer percent-encodes a colon inside a username, which would destroy the
    // userinfo structure the placeholder is there to preserve.
    url.password = placeholder("url.credential", ref);
    changed = true;
  }
  if (url.search) {
    const params = new URLSearchParams(url.search);
    for (const [key, value] of [...params.entries()]) {
      if (value.length < 6 || isStructuralSpan(value) || containsPlaceholder(value)) continue;
      const findings = detectSpans(value, { context: key });
      const credentialName = /token|key|secret|password|auth|sig|session|code/i.test(key);
      if (findings.length === 0 && !credentialName) continue;
      const className = findings.length > 0 ? findings[0].class : "url.credential";
      const ref = refFor(value);
      note({
        value,
        class: className,
        tier: findings.length > 0 ? findings[0].tier : "HIGH",
        detectors: findings.length > 0 ? ["positional", "regex"] : ["positional"],
        key_name: key,
      });
      params.set(key, placeholder(className, ref));
      changed = true;
    }
    url.search = params.toString();
  }
  if (url.hash && url.hash.length > 8) {
    url.hash = "";
    changed = true;
  }
  if (!changed) return null;
  // The URL serializer percent-encodes the braces and colons of a placeholder. The
  // placeholder grammar is published contract, so it is written back in its literal form.
  return url
    .toString()
    .replace(/%7B%7BOMEGA_REDACTED%3A([A-Za-z0-9_.]+)%3A(s[0-9]+)%7D%7D/gi, "{{OMEGA_REDACTED:$1:$2}}")
    .replace(/%7B%7BOMEGA_REDACTED:([A-Za-z0-9_.]+):(s[0-9]+)%7D%7D/gi, "{{OMEGA_REDACTED:$1:$2}}");
}

export function* stringLeavesOf(value, prefix = "") {
  if (typeof value === "string") {
    yield [prefix, value];
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) yield* stringLeavesOf(value[index], `${prefix}[${index}]`);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      yield* stringLeavesOf(child, prefix ? `${prefix}.${key}` : key);
    }
  }
}

export function setAtPath(root, keyPath, value) {
  const segments = splitKeyPath(keyPath);
  if (segments.length === 0) return false;
  let cursor = root;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    const next = /^\[[0-9]+\]$/.test(segment) ? cursor[Number(segment.slice(1, -1))] : cursor[segment];
    if (next === undefined || next === null) return false;
    cursor = next;
  }
  const last = segments[segments.length - 1];
  if (/^\[[0-9]+\]$/.test(last)) cursor[Number(last.slice(1, -1))] = value;
  else setKey(cursor, last, value);
  return true;
}

export function lastKeyName(keyPath) {
  const segments = splitKeyPath(keyPath).filter((segment) => !/^\[[0-9]+\]$/.test(segment));
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

function lineOf(text, offset) {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}
