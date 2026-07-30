// Read-only STRUCTURAL parse (adapter-architecture §6). Codex `rules/*.rules` is a
// Starlark file, and it is on the never-export table as a hard secret sink: a live API
// key was found inside a `curl -H` argv in one on the first machine examined (COD §5.1).
//
// So this parser exists to report SHAPE and nothing else — how many rules there are,
// what decisions they carry, and which commands are allow-listed by name. It never
// evaluates, and the bytes it reads never leave the machine. `patch` and `serialize`
// deliberately refuse: there is no write path for a surface we will not export.

import { byteTable, lineOffsets, spanAt } from "./spans.js";

export const id = "starlark";

const CALL = /(^|\n)[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*\(/g;

export function parse(text) {
  const offsets = lineOffsets(text);
  const table = byteTable(text);
  const spans = Object.create(null);
  const rules = [];
  spans.$ = spanAt(offsets, table, 0, text.length);

  for (const match of text.matchAll(CALL)) {
    const name = match[2];
    const open = match.index + match[0].length - 1;
    const close = matchingParen(text, open);
    if (close === -1) continue;
    const body = text.slice(open + 1, close);
    const keyPath = `rules[${rules.length}]`;
    const positional = bareStrings(body);
    const argv = commandPrefix(positional);
    rules.push({
      call: name,
      argv,
      argv_length: positional.length,
      argv_truncated: argv.length < positional.length,
      decision: keywordValue(body, "decision"),
      justification: keywordValue(body, "justification") === null ? null : "<present>",
      keywords: keywordNames(body),
    });
    spans[keyPath] = spanAt(offsets, table, match.index + (match[1] ? match[1].length : 0), close + 1);
  }

  return {
    value: { rules, rule_count: rules.length },
    key_order: { $: ["rules", "rule_count"] },
    spans,
  };
}

export function patch(text, edits) {
  if (!edits || edits.length === 0) return text;
  throw new Error("starlark is scan-and-refuse: there is no write path for this format");
}

export function serialize() {
  throw new Error("starlark is scan-and-refuse: there is no write path for this format");
}

function matchingParen(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i += 1;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "(" || c === "[") depth += 1;
    else if (c === ")" || c === "]") {
      depth -= 1;
      if (depth === 0 && c === ")") return i;
    }
  }
  return -1;
}

/**
 * Commands are reported BY NAME (§2.5f), which means the leading run of bare words and
 * flags and nothing after it. The surveyed file's live API key sat inside an argv
 * element — `"Authorization: Bearer …"` in a `curl -H` rule (COD §5.1) — so an element
 * that is not a bare word ends the prefix and is counted rather than carried.
 */
function commandPrefix(positional) {
  const out = [];
  for (const element of positional) {
    if (!/^[A-Za-z0-9._@/=+-]+$/.test(element)) break;
    out.push(element);
  }
  return out;
}

function bareStrings(body) {
  const head = body.split(/,\s*[A-Za-z_][A-Za-z0-9_]*\s*=/)[0];
  return [...head.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1] ?? match[2]);
}

function keywordValue(body, name) {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`).exec(body);
  return match ? match[1] : null;
}

function keywordNames(body) {
  return [...body.matchAll(/(?:^|,)\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/g)].map((match) => match[1]);
}
