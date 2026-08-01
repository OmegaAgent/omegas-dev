// THR §3.2, "argv-aware redaction" — a command string is not prose. Tokenizing it as an
// argv keeps the portable part (the command, its subcommand, its harmless flags) and
// redacts only the credential-bearing token, which is why hook commands and MCP `args`
// live in `argv_positions` rather than in `secret_positions` (spike-corrections §3).
//
// Three shapes, all of which the baseline missed:
//   FOO=bar cmd        env-prefix assignment — the exact shape of the live finding (THR A1)
//   --header X         flag-following value
//   --token=X, -H X    inline and bundled forms

import { classifyValue, nameLooksSecret, plausibleSecretValue } from "./layers.js";
import { containsPlaceholder } from "./placeholder.js";

// Two separators, because two of the three shapes above use `=` and configuration files
// use `key: value`. The colon form requires whitespace after the colon and a value that
// does not start with `//`, which is what keeps `https://host` from parsing as an
// assignment named `https` — a mis-parse that would swallow the endpoint.
const ASSIGNMENT =
  /(?:^|[\s;&|("'`])(?:export\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*(?:=\s*|:[ \t]+)("(?:[^"\\]|\\.)*"|'[^']*'|[^\s;&|)"'`]+)/g;

const VALUE_FLAGS = new RegExp(
  "(?:^|\\s)(-H|-u|-p|-k|--header|--headers|--token|--api-key|--apikey|--key|--secret|--password|--passwd|--auth|--authorization|--credential|--bearer|--access-token|--private-key)(?:\\s+|=)(\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*'|[^\\s;&|)]+)",
  "g",
);

function unquote(raw) {
  const quoted = /^["'`]/.test(raw) && raw.length >= 2 && raw[0] === raw[raw.length - 1];
  return { text: quoted ? raw.slice(1, -1) : raw, offset: quoted ? 1 : 0 };
}

/**
 * `NAME=value` anywhere in a string. Runs on EVERY string, not only at argv positions: the
 * shape appears in prose (`export API_TOKEN=…`), in a permission rule, and in a dotenv
 * line, and all three are the same finding.
 */
export function assignmentSpans(text) {
  const source = String(text);
  const spans = [];
  ASSIGNMENT.lastIndex = 0;
  let match = ASSIGNMENT.exec(source);
  while (match !== null) {
    const [, name, raw] = match;
    const { text: value, offset } = unquote(raw);
    const start = match.index + match[0].length - raw.length + offset;
    const classified = classifyValue(value);
    const named = nameLooksSecret(name) && plausibleSecretValue(value);
    if (value.startsWith("//")) {
      ASSIGNMENT.lastIndex = match.index + match[0].length;
      match = ASSIGNMENT.exec(source);
      continue;
    }
    if (value.length > 0 && !containsPlaceholder(value) && (named || classified)) {
      spans.push({
        start,
        end: start + value.length,
        value,
        class: classified ? classified.class : "env.kv",
        tier: classified ? classified.tier : "HIGH",
        detector: "keyname",
        key_name: name,
      });
    }
    ASSIGNMENT.lastIndex = match.index + match[0].length;
    match = ASSIGNMENT.exec(source);
  }
  return spans;
}

/** Flag-following values. Only meaningful where the surface declared an argv position. */
export function flagValueSpans(text) {
  const source = String(text);
  const spans = [];
  VALUE_FLAGS.lastIndex = 0;
  let match = VALUE_FLAGS.exec(source);
  while (match !== null) {
    const [, flag, raw] = match;
    const { text: value, offset } = unquote(raw);
    const start = match.index + match[0].length - raw.length + offset;
    const classified = classifyValue(value);
    // A header argument carries its own key name (`Authorization: Bearer …`), which the
    // provider layer already reads; here the flag itself is the evidence.
    if (value.length >= 6 && !containsPlaceholder(value) && (classified || plausibleSecretValue(value) || /:/.test(value))) {
      spans.push({
        start,
        end: start + value.length,
        value,
        class: classified ? classified.class : "argv.flag_value",
        tier: classified ? classified.tier : "MEDIUM",
        detector: "argv",
        key_name: flag,
      });
    }
    VALUE_FLAGS.lastIndex = match.index + match[0].length;
    match = VALUE_FLAGS.exec(source);
  }
  return spans;
}

export function argvSpans(text) {
  return [...assignmentSpans(text), ...flagValueSpans(text)];
}
