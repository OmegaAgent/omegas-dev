// THR §3.2 — five layers, union of results. A value is redacted if ANY layer fires, and
// every finding records which layers fired so the report can say how sure it is.
//
//   1  positional  — a value at a declared secret position (deepwalk.js applies it)
//   2  key name    — deny-list substring ANYWHERE, curated allowlist, plausibility gate
//   3  provider    — the pattern table below
//   4  entropy     — generic high-entropy spans, at declared deep-scan positions only
//   5  deep walk   — every leaf of every parsed format, plus one bounded decode (deepwalk.js)
//
// The pattern table is written CLEAN-ROOM from each vendor's own published token format
// (prefix, alphabet, length) — the documented shape of a credential, not anyone's code.
// Ids are stable dotted strings because they are published contract: they appear in every
// placeholder, and a reader on another machine must be able to look one up.

import { charsetClass, highEntropy, isStructuralSpan, looksLikeDigest, luhn, shannonEntropy } from "./entropy.js";
import { containsPlaceholder, placeholderSpans } from "./placeholder.js";

export const TIERS = ["HIGH", "MEDIUM", "LOW"];

/**
 * `near` requires a context word within `window` characters of the match. It is what makes
 * a shapeless 40-character blob reportable as an AWS secret key without reporting every
 * 40-character blob on the machine.
 *
 * `group` names a capture: for a DSN or a header the match spans context we want to KEEP,
 * and only the capture is the credential.
 */
export const PATTERNS = [
  {
    class: "pem.private_key",
    tier: "HIGH",
    regex: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?(?:-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----|$)/g,
    structural_exempt: true,
  },
  { class: "aws.access_key_id", tier: "HIGH", regex: /\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b/g },
  {
    class: "aws.secret_key",
    tier: "HIGH",
    regex: /\b[A-Za-z0-9/+]{40}\b/g,
    near: /aws|amazon|s3|secret[_-]?access/i,
    window: 240,
    validate: (value) => !looksLikeDigest(value) && shannonEntropy(value) >= 3.5,
  },
  { class: "github.token", tier: "HIGH", regex: /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g },
  { class: "github.fine_grained_pat", tier: "HIGH", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { class: "gitlab.token", tier: "HIGH", regex: /\bglpat-[A-Za-z0-9_-]{16,}\b/g },
  { class: "slack.token", tier: "HIGH", regex: /\bxox[abeoprs]-[A-Za-z0-9-]{10,}\b/g },
  { class: "slack.app_token", tier: "HIGH", regex: /\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b/g },
  { class: "slack.webhook", tier: "HIGH", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_/-]{12,}/g },
  { class: "stripe.secret_key", tier: "HIGH", regex: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
  { class: "stripe.webhook_secret", tier: "HIGH", regex: /\bwhsec_[A-Za-z0-9]{16,}\b/g },
  { class: "anthropic.api_key", tier: "HIGH", regex: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g },
  // The negative lookahead keeps the two `sk-` families apart, so a placeholder names the
  // vendor a reader has to go get a new key from.
  { class: "openai.api_key", tier: "HIGH", regex: /\bsk-(?!ant-)(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}\b/g },
  { class: "google.api_key", tier: "HIGH", regex: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { class: "google.oauth_client_secret", tier: "HIGH", regex: /\bGOCSPX-[A-Za-z0-9_-]{16,}\b/g },
  { class: "groq.api_key", tier: "HIGH", regex: /\bgsk_[A-Za-z0-9]{20,}\b/g },
  { class: "npm.token", tier: "HIGH", regex: /\bnpm_[A-Za-z0-9]{24,}\b/g },
  { class: "huggingface.token", tier: "HIGH", regex: /\bhf_[A-Za-z0-9]{24,}\b/g },
  { class: "sendgrid.api_key", tier: "HIGH", regex: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g },
  { class: "pypi.token", tier: "HIGH", regex: /\bpypi-[A-Za-z0-9_-]{32,}\b/g },
  {
    class: "twilio.api_key",
    tier: "HIGH",
    regex: /\bSK[0-9a-fA-F]{32}\b/g,
    near: /twilio|\bAC[0-9a-fA-F]{32}\b|auth[_-]?token/i,
    window: 240,
  },
  {
    class: "twilio.account_sid",
    tier: "MEDIUM",
    regex: /\bAC[0-9a-fA-F]{32}\b/g,
    near: /twilio|\bSK[0-9a-fA-F]{32}\b|auth[_-]?token/i,
    window: 240,
  },
  { class: "jwt.token", tier: "HIGH", regex: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}/g },
  {
    class: "db.dsn_credential",
    tier: "HIGH",
    regex: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@"']+:([^\s@/"']{3,})@/g,
    group: 1,
  },
  {
    class: "url.credential",
    tier: "HIGH",
    regex: /[?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|passwd|sig|signature|auth|session)=([^&\s"'`#<>,;)\]}]{6,})/gi,
    group: 1,
  },
  {
    class: "http.authorization",
    tier: "HIGH",
    regex: /\b(?:authorization|proxy-authorization|x-api-key|x-auth-token|api-key|private-token)"?\s*[:=]\s*"?(?:Bearer\s+|Basic\s+|Token\s+|token\s+)?([^\s"'`,;)\]}]{8,})/gi,
    group: 1,
  },
  // RFC 6750 / RFC 7617 — the scheme word is the evidence, and keeping it in the clear is
  // the structure-preserving contract at work: a reader learns the header wanted a bearer
  // token without learning the token.
  {
    class: "http.authorization",
    tier: "HIGH",
    regex: /\b(?:Bearer|Basic|Token)\s+([A-Za-z0-9._~+/=-]{8,})/g,
    group: 1,
  },
  { class: "figma.token", tier: "MEDIUM", regex: /\bfigd_[A-Za-z0-9_-]{16,}\b/g },
  { class: "linear.api_key", tier: "MEDIUM", regex: /\blin_api_[A-Za-z0-9]{16,}\b/g },
  { class: "provider.sk_opaque", tier: "MEDIUM", regex: /\bsk_[0-9a-f]{32,}\b/g },
  {
    class: "card.number",
    tier: "LOW",
    regex: /\b(?:[0-9]{4}[ -]?){3}[0-9]{1,7}\b/g,
    validate: (value) => luhn(value),
  },
];

// THR §3.2 Layer 2 — substring ANYWHERE, which is the fix for the baseline's
// `indexOf(needle) > 0` off-by-one that let a bare `TOKEN=` through (T-R2).
export const KEY_NEEDLES = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "signature",
  "auth",
  "session",
  "cookie",
  "private",
  "salt",
  "pin",
  "otp",
  "webhook",
  "bearer",
];

// Key names whose own text defeats the needle list without carrying a value: the needle is
// in the WORD, not in the meaning. Kept short and shown in the report, so a user can see
// what we chose not to redact rather than having to trust that the list is right.
const NEEDLE_EXEMPT = /^(author|authors|authored_by|keywords|keybindings|key_order|session_name|pinned|pin_to|description|public_key_path|private_repo)$/i;

export function nameLooksSecret(name) {
  const text = String(name ?? "");
  if (text.length === 0) return false;
  if (NEEDLE_EXEMPT.test(text)) return false;
  const lower = text.toLowerCase();
  return KEY_NEEDLES.some((needle) => lower.includes(needle));
}

/**
 * A path is a location, not a credential. Layers 2 and 4 both stand down on one; layer 3
 * does not, because a URL with userinfo is a path AND a credential.
 */
export function looksLikePath(value) {
  const text = String(value);
  return /^(?:~|\.{1,2})?\//.test(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\$\{?[A-Za-z_]/.test(text);
}

/**
 * The plausibility gate the name-based layer needs. Without it, `author: Jane Doe` is a
 * credential because the key contains "auth" — the T-R4 failure wearing a different hat.
 */
export function plausibleSecretValue(value) {
  const text = String(value);
  if (text.length < 12) return false;
  if (/\s/.test(text)) return false;
  if (isStructuralSpan(text) || containsPlaceholder(text)) return false;
  if (looksLikePath(text)) return false;
  if (looksLikeDigest(text)) return false;
  const charset = charsetClass(text);
  if (charset === "numeric") return false;
  return shannonEntropy(text) >= 3.0 || classifyValue(text) !== null;
}

/** The class a whole value would be reported as, or null when nothing recognizes it. */
export function classifyValue(value, context = "") {
  const text = String(value);
  const found = detectSpans(text, { context })
    .filter((span) => span.start === 0 && span.end === text.length)
    .sort((a, b) => tierRank(a.tier) - tierRank(b.tier));
  return found.length > 0 ? found[0] : null;
}

export function tierRank(tier) {
  const index = TIERS.indexOf(tier);
  return index === -1 ? TIERS.length : index;
}

/**
 * Layers 3 and 4 over one string. `context` is text that is NOT part of the string but is
 * adjacent to it in the source — the key name of the leaf, the surrounding line — which is
 * what the proximity validators read. It is never redacted and never emitted.
 *
 * `generic` enables the LOW-tier unknown-blob detector. It is off by default and on only
 * at positions a surface DECLARED as a deep-scan sink (a permission rule, a rule script,
 * prose), because it is the only layer whose false-positive rate is a product risk.
 */
export function detectSpans(text, { context = "", generic = false } = {}) {
  const source = String(text);
  if (source.length === 0) return [];
  const suppressed = placeholderSpans(source);
  const overlapsPlaceholder = (start, end) =>
    suppressed.some((span) => start < span.end && end > span.start);
  const spans = [];

  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    let match = pattern.regex.exec(source);
    while (match !== null) {
      const groupIndex = pattern.group ?? 0;
      const captured = match[groupIndex];
      if (captured !== undefined && captured.length > 0) {
        const start = groupIndex === 0 ? match.index : source.indexOf(captured, match.index);
        const end = start + captured.length;
        if (start !== -1 && accept(pattern, captured, source, start, end)) {
          spans.push({
            start,
            end,
            value: captured,
            class: pattern.class,
            tier: pattern.tier,
            detector: "regex",
            key_name: null,
          });
        }
      }
      if (pattern.regex.lastIndex === match.index) pattern.regex.lastIndex += 1;
      match = pattern.regex.exec(source);
    }
  }

  if (generic) {
    for (const span of genericSpans(source)) {
      if (!overlapsPlaceholder(span.start, span.end)) spans.push(span);
    }
  }

  return spans.filter((span) => !overlapsPlaceholder(span.start, span.end));

  function accept(pattern, value, haystack, start, end) {
    if (overlapsPlaceholder(start, end)) return false;
    if (!pattern.structural_exempt && isStructuralSpan(value)) return false;
    if (pattern.validate && !pattern.validate(value)) return false;
    if (pattern.near) {
      const window = pattern.window ?? 200;
      const around =
        haystack.slice(Math.max(0, start - window), start) +
        " " +
        haystack.slice(end, end + window) +
        " " +
        context;
      if (!pattern.near.test(around)) return false;
    }
    return true;
  }
}

// Layer 4 proper: quoted or assigned spans whose randomness has no other explanation.
// Bare words in prose are never candidates — the span has to be delimited, which is the
// difference between "a secret someone pasted" and "a sentence".
//
// `=` and `:` are separators here, never body characters (base64 padding is the one
// exception, and it only appears at the end). Admitting them into the body is how a
// generic span swallows `GITHUB_TOKEN=ghp_…` whole and takes the key name with it — which
// would destroy the one thing the structure-preserving contract promises to keep.
const QUOTED_OR_ASSIGNED = /(?:^|[\s"'`=:,([{])([A-Za-z0-9+/_.-]{20,}={0,2})(?=$|[\s"'`,)\]}<;])/g;

function genericSpans(source) {
  const spans = [];
  QUOTED_OR_ASSIGNED.lastIndex = 0;
  let match = QUOTED_OR_ASSIGNED.exec(source);
  while (match !== null) {
    const value = match[1];
    const start = match.index + match[0].length - value.length;
    if (
      !isStructuralSpan(value) &&
      !containsPlaceholder(value) &&
      !looksLikePath(value) &&
      !looksLikeDigest(value) &&
      // A lowercase dotted identifier is a name, not a token: `unknown.high_entropy`,
      // `mcp_servers.analytics.env`, `com.example.app`. Real credentials in this alphabet
      // carry digits or mixed case, and treating a name as a secret poisons the
      // value-linked sweep with a string that appears everywhere.
      !/^[a-z][a-z_]*(?:\.[a-z][a-z_]*)+$/.test(value) &&
      !/^[a-z][a-z0-9+.-]*:\/\//i.test(value) &&
      !/\.(?:md|json|toml|js|mjs|ts|sh|py|txt|yaml|yml|lock)$/i.test(value) &&
      // 20 is the shortest length at which a random token is reliably separable from a
      // long English word: "internationalization" is 20 characters and reaches ~3.2
      // bits/char, well under the 4.0 floor a base64-alphabet span has to clear.
      highEntropy(value, { minLength: 20 })
    ) {
      spans.push({
        start,
        end: start + value.length,
        value,
        class: "unknown.high_entropy",
        tier: "LOW",
        detector: "entropy",
        key_name: null,
      });
    }
    QUOTED_OR_ASSIGNED.lastIndex = match.index + 1;
    match = QUOTED_OR_ASSIGNED.exec(source);
  }
  return spans;
}

/**
 * Overlapping findings collapse to one placeholder whose detector list is the union — a
 * value caught by both the position and the pattern is one secret with two witnesses, not
 * two secrets.
 *
 * The SPECIFIC span wins, not the longest one. Sorting by length would let a LOW-tier
 * generic blob swallow the HIGH-tier provider match inside it, losing both the class a
 * reader needs and any surrounding text that was not a credential. Ties go to the longer
 * span, so a DSN password is never cut in half.
 */
export function mergeSpans(spans) {
  const ranked = [...spans].sort(
    (a, b) => tierRank(a.tier) - tierRank(b.tier) || b.end - b.start - (a.end - a.start) || a.start - b.start,
  );
  const accepted = [];
  for (const span of ranked) {
    const overlap = accepted.find((other) => span.start < other.end && span.end > other.start);
    if (overlap) {
      for (const detector of span.detectors ?? [span.detector]) {
        if (!overlap.detectors.includes(detector)) overlap.detectors.push(detector);
      }
      if (!overlap.key_name && span.key_name) overlap.key_name = span.key_name;
      continue;
    }
    accepted.push({ ...span, detectors: [...(span.detectors ?? [span.detector])] });
  }
  return accepted.sort((a, b) => a.start - b.start);
}
