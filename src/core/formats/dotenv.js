// dotenv, ported from src/env.js into the uniform format contract. The semantics are deliberately
// conservative and are reproduced EXACTLY, not improved: an invalid or multi-line entry is skipped
// and reported in skipped_lines rather than guessed at, because a wrong guess about a credential
// file is worse than a gap. test/formats.test.js asserts parity against src/env.js on the same
// inputs, so the two cannot drift.
//
// spans[key] covers the RAW value as written, including its quotes, and excluding the trailing
// " # comment" that the parser strips from an unquoted value — replacing that range is exactly the
// edit that changes the value and nothing else.

import { applyEdits, positions, setKey } from "./spans.js";

const VALID_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const id = "dotenv";

export function environmentFromFilename(filename) {
  if (filename === ".env.local") return "local";
  if (filename === ".env.test") return "test";
  if (filename === ".env.prod" || filename === ".env.production") return "production";
  if (filename === ".env.dev" || filename === ".env.development") return "development";
  return "custom";
}

export function parse(text) {
  const pos = positions(text);
  const entries = {};
  const keys = [];
  const skipped = [];
  const spans = Object.create(null);
  spans["$"] = pos.span(0, text.length);

  let cursor = 0;
  let lineNumber = 0;
  while (cursor <= text.length) {
    lineNumber += 1;
    const newline = text.indexOf("\n", cursor);
    const hardEnd = newline === -1 ? text.length : newline;
    const end = hardEnd > cursor && text.charCodeAt(hardEnd - 1) === 0x0d ? hardEnd - 1 : hardEnd;
    readLine(text.slice(cursor, end), cursor, lineNumber);
    if (newline === -1) break;
    cursor = newline + 1;
  }

  function readLine(raw, offset, number) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) return;
    let base = offset + (raw.length - raw.trimStart().length);
    if (line.startsWith("export ")) {
      const rest = line.slice(7);
      base += 7 + (rest.length - rest.trimStart().length);
      line = rest.trimStart();
    }
    const equals = line.indexOf("=");
    if (equals <= 0) {
      skipped.push(number);
      return;
    }
    const key = line.slice(0, equals).trim();
    if (!VALID_KEY.test(key)) {
      skipped.push(number);
      return;
    }
    const rawValue = line.slice(equals + 1);
    const leading = rawValue.length - rawValue.trimStart().length;
    let value = rawValue.trim();
    const start = base + equals + 1 + leading;
    let stop = start + value.length;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, "\n").replace(/\\r/g, "\r").replace(/\\t/g, "\t");
    } else {
      value = value.replace(/\s+#.*$/, "").trimEnd();
      stop = start + value.length;
    }
    setKey(entries, key, value);
    if (!keys.includes(key)) keys.push(key);
    spans[key] = pos.span(start, stop);
  }

  return { value: entries, key_order: { $: keys }, spans, skipped_lines: skipped };
}

export function patch(text, edits) {
  return applyEdits(text, edits, () => parse(text).spans);
}

// Only for creating a file that does not exist (manifest §2.3).
export function serialize(value, keyOrder) {
  const order = Array.isArray(keyOrder) ? keyOrder : (keyOrder?.$ ?? []);
  const keys = [];
  for (const key of order) if (Object.hasOwn(value ?? {}, key)) keys.push(key);
  for (const key of Object.keys(value ?? {})) if (!keys.includes(key)) keys.push(key);
  const lines = keys.map((key) => `${key}=${renderValue(String(value[key] ?? ""))}`);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

// Quoting is chosen so that this parser reads back what was written: a value that would otherwise
// be truncated at a " #" or lose its leading space is double-quoted. Only \n, \r and \t are
// escaped, because those are the only escapes the parser undoes — escaping a backslash or a quote
// would survive into the value.
function renderValue(value) {
  if (value === "") return "";
  if (/^[^\s"'#]*$/.test(value)) return value;
  return `"${value.replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
}
