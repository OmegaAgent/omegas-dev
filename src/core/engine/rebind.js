// Import-side re-binding of the placeholders the export side left behind
// (canonical-manifest §4.4, THR §3.3).
//
// The bundle carries `{{OMEGA_REDACTED:<class>:<ref>}}` and a side table saying which key
// names each ref filled. On the target machine every ref becomes ONE decision — take it
// from an environment variable, read it from a local `.env`, type it, or leave it unset —
// and that decision fills every site the ref occupies. Same-value linkage is the whole
// reason refs exist: a token pasted into both an MCP env block and a CLAUDE.md is one
// question, not two, and answering it once is what stops half a setup from working.
//
// The hard rule in this file: a resolved value goes into the bytes of the target file and
// nowhere else. Not the plan, not the ledger, not a log line, not an error message. Every
// display path in the codebase goes through `maskCredentials`, which renders the SOURCE of
// a value ("the value of $SLACK_BOT_TOKEN") and never the value.

import { parse as parseDotenv } from "../formats/dotenv.js";

const PLACEHOLDER_GLOBAL = /\{\{OMEGA_REDACTED:([A-Za-z0-9_.]+):(s[0-9]+)\}\}/g;

export const CREDENTIAL_SOURCES = ["env", "dotenv", "typed", "unset"];

/** Every ref an item mentions, from its declared list and from its carried bytes. */
export function refsIn(item) {
  const refs = new Set(item.redaction_refs ?? []);
  for (const ref of placeholderRefs(JSON.stringify(item.payload?.parsed ?? null))) refs.add(ref);
  return [...refs];
}

export function placeholderRefs(text) {
  const refs = new Set();
  if (typeof text !== "string") return [];
  PLACEHOLDER_GLOBAL.lastIndex = 0;
  let match = PLACEHOLDER_GLOBAL.exec(text);
  while (match !== null) {
    refs.add(match[2]);
    match = PLACEHOLDER_GLOBAL.exec(text);
  }
  return [...refs];
}

/**
 * A credential record. `value` is the only field that ever holds plaintext, and nothing
 * outside the writer is allowed to read it — `describe()` is what every other caller gets.
 */
export function credential({ ref, source, detail, value }) {
  if (!CREDENTIAL_SOURCES.includes(source)) throw new TypeError(`unknown credential source "${source}"`);
  return { ref, source, detail: detail ?? null, value: source === "unset" ? null : String(value ?? "") };
}

export function describe(record) {
  if (!record || record.source === "unset") return "left unset";
  if (record.source === "env") return `the value of $${record.detail}`;
  if (record.source === "dotenv") return `${record.detail} read from a local .env`;
  return "a value you typed";
}

export function fromEnv({ ref, name, envVars }) {
  const value = envVars?.[name];
  if (typeof value !== "string" || value.length === 0) return null;
  return credential({ ref, source: "env", detail: name, value });
}

/**
 * The dotenv parser is the conservative one from M0: it skips a line it cannot read rather
 * than guessing. A miss here has to be a miss, because guessing produces a config that
 * looks filled and is not.
 */
export function fromDotenv({ ref, name, text }) {
  const parsed = parseDotenv(String(text ?? ""));
  const value = parsed?.value?.[name];
  if (typeof value !== "string" || value.length === 0) return null;
  return credential({ ref, source: "dotenv", detail: name, value });
}

export function unset(ref) {
  return credential({ ref, source: "unset" });
}

/**
 * Substitute resolved values into a string or a parsed tree. Unresolved refs are left as
 * their placeholder — a bundle imported with unfilled placeholders is VALID; the affected
 * item lands in the disabled state with a "needs a credential" status rather than being
 * dropped, so the user can see the shape of what they still have to supply.
 */
export function resolveInto(input, credentials) {
  const unresolved = new Set();
  const substitute = (text) =>
    text.replace(PLACEHOLDER_GLOBAL, (whole, className, ref) => {
      const record = credentials.get(ref);
      if (!record || record.source === "unset" || !record.value) {
        unresolved.add(ref);
        return whole;
      }
      return record.value;
    });
  const value = walk(input, substitute);
  return { value, text: typeof value === "string" ? value : null, unresolved: [...unresolved] };
}

/** The display twin of `resolveInto`: never the value, always where the value comes from. */
export function maskCredentials(input, credentials) {
  return walk(input, (text) =>
    text.replace(PLACEHOLDER_GLOBAL, (whole, className, ref) => {
      const record = credentials.get(ref);
      if (!record || record.source === "unset") return whole;
      return `<${describe(record)}>`;
    }),
  );
}

function walk(node, transform) {
  if (typeof node === "string") return transform(node);
  if (Array.isArray(node)) return node.map((entry) => walk(entry, transform));
  if (node && typeof node === "object") {
    const out = {};
    for (const [key, value] of Object.entries(node)) out[key] = walk(value, transform);
    return out;
  }
  return node;
}

/**
 * Non-interactive default. There is no "guess from the environment" mode: filling a
 * credential is a decision, and a run with no human present cannot make it.
 */
export function autoUnset(requests) {
  const credentials = new Map();
  for (const request of requests) credentials.set(request.ref, unset(request.ref));
  return credentials;
}
