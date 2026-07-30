// A real TOML reader (adapter-architecture §1.4). The baseline's line scanner cannot represent
// arrays-of-tables ([[hooks.PreToolUse]]) or inline tables (env = { A = "b" }, the documented MCP
// form), so this replaces it rather than patching it.
//
// Supported: [table], [[array of tables]], nested and dotted headers, dotted keys, inline tables,
// basic and literal strings, multi-line basic and literal strings including the line-ending
// backslash and the leading-newline trim, integers with sign/underscores/0x/0o/0b, floats with
// exponents plus inf/nan, booleans, arrays (heterogeneous, multi-line, trailing commas), and
// comments anywhere.
//
// Deliberate choices, because a caller can be surprised by them:
// - Date-times, local dates and local times keep their LITERAL STRING form. Losslessness beats
//   typing here: a Date would lose the offset and the written precision, and the write path is
//   patch on raw bytes anyway.
// - Integers are JS numbers, so a 64-bit integer beyond Number.MAX_SAFE_INTEGER loses precision in
//   `value`. `raw` remains authoritative (manifest §2.1).
// - spans[path] covers the VALUE of a key, except for a [table] / [[array of tables]] path, whose
//   span starts at its header and covers all of its children — replacing it replaces the table.
// - Newlines inside an inline table are tolerated; TOML 1.0 forbids them. Being stricter than the
//   runtime would reject a file the runtime reads.

import { applyEdits, positions, setKey } from "./spans.js";

export const id = "toml";

const BARE_KEY = /[A-Za-z0-9_-]+/y;
const BARE_VALUE = /[^\s,\]}#]+/y;
const DATE_TIME_SUFFIX = /[ ][0-9]{2}:[0-9]{2}(?::[0-9]{2}(?:\.[0-9]+)?)?(?:[Zz]|[+-][0-9]{2}:[0-9]{2})?/y;
const LINE_CONTINUATION = /\\[ \t]*(?:\r\n|\n)[ \t\r\n]*/y;
const HEX4 = /^[0-9a-fA-F]{4}$/;
const HEX8 = /^[0-9a-fA-F]{8}$/;

const OFFSET_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})$/;
const LOCAL_DATE_TIME = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL_TIME = /^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;
const DEC_INT = /^[+-]?(?:0|[1-9](?:_?[0-9])*)$/;
const HEX_INT = /^[+-]?0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$/;
const OCT_INT = /^[+-]?0o[0-7](?:_?[0-7])*$/;
const BIN_INT = /^[+-]?0b[01](?:_?[01])*$/;
const FLOAT =
  /^[+-]?(?:0|[1-9](?:_?[0-9])*)(?:(?:\.[0-9](?:_?[0-9])*)(?:[eE][+-]?[0-9](?:_?[0-9])*)?|(?:[eE][+-]?[0-9](?:_?[0-9])*))$/;
const SPECIAL_FLOAT = /^[+-]?(?:inf|nan)$/;

export function parse(text) {
  const pos = positions(text);
  const root = {};
  const spans = Object.create(null);
  const keyOrder = Object.create(null);
  // Container paths whose span must grow to cover every child (manifest §2.3 patching).
  const regions = new Map();
  // path -> "table" | "implicit" | "array" | "dotted" | "value" | "inline". Redefinition throws
  // rather than silently overwriting, which is the failure mode of the baseline scanner.
  const defined = new Map();
  // A leading BOM is skipped rather than rejected: an invisible character must not cost the user
  // the whole file, and the bytes survive anyway because the write path is patch.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let currentNode = root;
  let currentPrefix = "";

  keyOrder["$"] = [];

  const fail = (message) => {
    const at = Math.min(i, text.length);
    throw new SyntaxError(`${message} at byte ${pos.table[at]} (line ${pos.span(at, at).line_start})`);
  };

  function skipInline() {
    for (;;) {
      const code = text.charCodeAt(i);
      if (code === 0x20 || code === 0x09) i += 1;
      else return;
    }
  }

  function skipTrivia() {
    for (;;) {
      const code = text.charCodeAt(i);
      if (code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) {
        i += 1;
        continue;
      }
      if (code === 0x23) {
        while (i < text.length && text.charCodeAt(i) !== 0x0a) i += 1;
        continue;
      }
      return;
    }
  }

  function requireLineEnd() {
    skipInline();
    if (i >= text.length) return;
    const code = text.charCodeAt(i);
    if (code === 0x0a || code === 0x0d || code === 0x23) return;
    fail("unexpected content after a value");
  }

  function pushOrder(bucket, key) {
    const list = (keyOrder[bucket] ??= []);
    if (!list.includes(key)) list.push(key);
  }

  function markRegion(path, start, end) {
    const region = regions.get(path);
    if (!region) {
      regions.set(path, { start, end });
      return;
    }
    if (start < region.start) region.start = start;
    if (end > region.end) region.end = end;
  }

  function extendAncestors(path, start, end) {
    for (const ancestor of ancestorsOf(path)) {
      if (regions.has(ancestor)) markRegion(ancestor, start, end);
    }
  }

  function readEscape() {
    const escape = text[i + 1];
    i += 2;
    if (escape === "b") return "\b";
    if (escape === "t") return "\t";
    if (escape === "n") return "\n";
    if (escape === "f") return "\f";
    if (escape === "r") return "\r";
    if (escape === '"') return '"';
    if (escape === "\\") return "\\";
    if (escape === "u" || escape === "U") {
      const width = escape === "u" ? 4 : 8;
      const hex = text.slice(i, i + width);
      if (!(width === 4 ? HEX4 : HEX8).test(hex)) {
        i -= 2;
        fail(`invalid \\${escape} escape`);
      }
      i += width;
      return String.fromCodePoint(parseInt(hex, 16));
    }
    i -= 2;
    return fail(`invalid escape \\${escape ?? ""}`);
  }

  function readMultilineString(quote) {
    i += 3;
    if (text.charCodeAt(i) === 0x0a) i += 1;
    else if (text.charCodeAt(i) === 0x0d && text.charCodeAt(i + 1) === 0x0a) i += 2;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated multi-line string");
      const c = text[i];
      if (c === quote) {
        let run = 0;
        while (text[i + run] === quote) run += 1;
        if (run >= 3) {
          if (run > 5) fail("too many quotes closing a multi-line string");
          out += quote.repeat(run - 3);
          i += run;
          return out;
        }
        out += quote.repeat(run);
        i += run;
        continue;
      }
      if (quote === '"' && c === "\\") {
        LINE_CONTINUATION.lastIndex = i;
        if (LINE_CONTINUATION.test(text)) {
          i = LINE_CONTINUATION.lastIndex;
          continue;
        }
        out += readEscape();
        continue;
      }
      out += c;
      i += 1;
    }
  }

  function readBasicString() {
    if (text.charCodeAt(i + 1) === 0x22 && text.charCodeAt(i + 2) === 0x22) return readMultilineString('"');
    i += 1;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated string");
      const code = text.charCodeAt(i);
      if (code === 0x22) {
        i += 1;
        return out;
      }
      if (code === 0x0a) fail("newline inside a single-line string");
      if (code === 0x5c) {
        out += readEscape();
        continue;
      }
      out += text[i];
      i += 1;
    }
  }

  function readLiteralString() {
    if (text.charCodeAt(i + 1) === 0x27 && text.charCodeAt(i + 2) === 0x27) return readMultilineString("'");
    i += 1;
    let out = "";
    for (;;) {
      if (i >= text.length) fail("unterminated literal string");
      const code = text.charCodeAt(i);
      if (code === 0x27) {
        i += 1;
        return out;
      }
      if (code === 0x0a) fail("newline inside a single-line literal string");
      out += text[i];
      i += 1;
    }
  }

  function readKeySegments() {
    const segments = [];
    for (;;) {
      skipInline();
      const code = text.charCodeAt(i);
      if (code === 0x22) segments.push(readBasicString());
      else if (code === 0x27) segments.push(readLiteralString());
      else {
        BARE_KEY.lastIndex = i;
        const match = BARE_KEY.exec(text);
        if (!match) fail("expected a key");
        segments.push(match[0]);
        i = BARE_KEY.lastIndex;
      }
      skipInline();
      if (text.charCodeAt(i) === 0x2e) {
        i += 1;
        continue;
      }
      return segments;
    }
  }

  function classify(token) {
    if (token === "true") return true;
    if (token === "false") return false;
    if (OFFSET_DATE_TIME.test(token) || LOCAL_DATE_TIME.test(token)) return token;
    if (LOCAL_DATE.test(token) || LOCAL_TIME.test(token)) return token;
    const bare = token.replace(/_/g, "");
    if (DEC_INT.test(token)) return Number(bare);
    if (HEX_INT.test(token)) return radix(bare, 16);
    if (OCT_INT.test(token)) return radix(bare, 8);
    if (BIN_INT.test(token)) return radix(bare, 2);
    if (FLOAT.test(token)) return Number(bare);
    if (SPECIAL_FLOAT.test(token)) {
      if (token.endsWith("nan")) return Number.NaN;
      return token.startsWith("-") ? -Infinity : Infinity;
    }
    return fail(`unrecognized value "${token}"`);
  }

  function readBareValue() {
    BARE_VALUE.lastIndex = i;
    const match = BARE_VALUE.exec(text);
    if (!match) fail("expected a value");
    let token = match[0];
    i = BARE_VALUE.lastIndex;
    // TOML allows a space between a date and its time; the bare-token scan stops at that space.
    if (LOCAL_DATE.test(token)) {
      DATE_TIME_SUFFIX.lastIndex = i;
      const suffix = DATE_TIME_SUFFIX.exec(text);
      if (suffix) {
        token += suffix[0];
        i = DATE_TIME_SUFFIX.lastIndex;
      }
    }
    return classify(token);
  }

  function readArray(keyPath) {
    i += 1;
    const value = [];
    for (;;) {
      skipTrivia();
      if (i >= text.length) fail("unterminated array");
      if (text.charCodeAt(i) === 0x5d) {
        i += 1;
        return value;
      }
      value.push(readValue(`${keyPath}[${value.length}]`));
      skipTrivia();
      if (i >= text.length) fail("unterminated array");
      if (text.charCodeAt(i) === 0x2c) {
        i += 1;
        continue;
      }
      if (text.charCodeAt(i) === 0x5d) {
        i += 1;
        return value;
      }
      fail("expected ',' or ']' in an array");
    }
  }

  function readInlineTable(keyPath) {
    i += 1;
    const value = {};
    keyOrder[keyPath] ??= [];
    for (;;) {
      skipTrivia();
      if (i >= text.length) fail("unterminated inline table");
      if (text.charCodeAt(i) === 0x7d) {
        i += 1;
        return value;
      }
      const segments = readKeySegments();
      skipInline();
      if (text.charCodeAt(i) !== 0x3d) fail("expected '=' in an inline table");
      i += 1;
      const childPath = declareOrder(keyPath, segments);
      if (Object.hasOwn(spans, childPath)) fail(`key "${childPath}" is defined more than once`);
      assignInto(value, segments, readValue(childPath));
      skipTrivia();
      if (i >= text.length) fail("unterminated inline table");
      if (text.charCodeAt(i) === 0x2c) {
        i += 1;
        continue;
      }
      if (text.charCodeAt(i) === 0x7d) {
        i += 1;
        return value;
      }
      fail("expected ',' or '}' in an inline table");
    }
  }

  function readValue(keyPath) {
    skipInline();
    const start = i;
    const code = text.charCodeAt(i);
    let value;
    if (code === 0x22) value = readBasicString();
    else if (code === 0x27) value = readLiteralString();
    else if (code === 0x5b) value = readArray(keyPath);
    else if (code === 0x7b) value = readInlineTable(keyPath);
    else value = readBareValue();
    spans[keyPath] = pos.span(start, i);
    return value;
  }

  function declareOrder(prefix, segments) {
    let bucket = prefix || "$";
    let path = prefix;
    for (let n = 0; n < segments.length; n += 1) {
      pushOrder(bucket, segments[n]);
      path = path ? `${path}.${segments[n]}` : segments[n];
      if (n < segments.length - 1) {
        keyOrder[path] ??= [];
        bucket = path;
      }
    }
    return path;
  }

  function assignInto(node, segments, value) {
    let cursor = node;
    for (let n = 0; n < segments.length - 1; n += 1) {
      const segment = segments[n];
      if (cursor[segment] === undefined) setKey(cursor, segment, {});
      cursor = cursor[segment];
    }
    setKey(cursor, segments[segments.length - 1], value);
  }

  function declareAssignment(segments, start) {
    let path = currentPrefix;
    for (let n = 0; n < segments.length; n += 1) {
      const segment = segments[n];
      const next = path ? `${path}.${segment}` : segment;
      if (n === segments.length - 1) {
        if (defined.has(next)) fail(`key "${next}" is defined more than once`);
        pushOrder(path || "$", segment);
        return next;
      }
      const kind = defined.get(next);
      if (kind === "value" || kind === "inline" || kind === "array") {
        fail(`"${next}" is already defined as a ${kind}`);
      }
      if (!kind) {
        defined.set(next, "dotted");
        pushOrder(path || "$", segment);
        keyOrder[next] ??= [];
        markRegion(next, start, start);
      }
      path = next;
    }
    return path;
  }

  function readTableHeader() {
    const start = i;
    const isArray = text.charCodeAt(i + 1) === 0x5b;
    i += isArray ? 2 : 1;
    const segments = readKeySegments();
    skipInline();
    if (isArray) {
      if (text.charCodeAt(i) !== 0x5d || text.charCodeAt(i + 1) !== 0x5d) fail("expected ']]'");
      i += 2;
    } else {
      if (text.charCodeAt(i) !== 0x5d) fail("expected ']'");
      i += 1;
    }
    const headerEnd = i;
    requireLineEnd();

    let node = root;
    let prefix = "";
    for (let n = 0; n < segments.length; n += 1) {
      const segment = segments[n];
      const last = n === segments.length - 1;
      const path = prefix ? `${prefix}.${segment}` : segment;
      const kind = defined.get(path);
      if (last && isArray) {
        if (kind && kind !== "array") fail(`"${path}" is already defined as a ${kind}`);
        if (!kind) {
          setKey(node, segment, []);
          defined.set(path, "array");
          pushOrder(prefix || "$", segment);
        }
        markRegion(path, start, headerEnd);
        const element = {};
        node[segment].push(element);
        const elementPath = `${path}[${node[segment].length - 1}]`;
        defined.set(elementPath, "table");
        keyOrder[elementPath] ??= [];
        markRegion(elementPath, start, headerEnd);
        node = element;
        prefix = elementPath;
        continue;
      }
      if (kind === "value" || kind === "inline") fail(`"${path}" is already defined as a ${kind}`);
      if (kind === "array") {
        // A [t] header cannot re-open a [[t]] array of tables; only a deeper header may descend
        // into its most recent element.
        if (last) fail(`"${path}" is already defined as an array of tables`);
        const index = node[segment].length - 1;
        if (index < 0) fail(`"${path}" has no array element to extend`);
        markRegion(path, start, headerEnd);
        prefix = `${path}[${index}]`;
        markRegion(prefix, start, headerEnd);
        node = node[segment][index];
        continue;
      }
      if (!kind) {
        setKey(node, segment, {});
        defined.set(path, last ? "table" : "implicit");
        pushOrder(prefix || "$", segment);
        keyOrder[path] ??= [];
      } else if (last && kind !== "implicit") {
        fail(`table "${path}" is defined more than once`);
      } else if (last) {
        defined.set(path, "table");
      }
      markRegion(path, start, headerEnd);
      node = node[segment];
      prefix = path;
    }
    currentNode = node;
    currentPrefix = prefix;
    keyOrder[prefix || "$"] ??= [];
  }

  function readAssignment() {
    const start = i;
    const segments = readKeySegments();
    skipInline();
    if (text.charCodeAt(i) !== 0x3d) fail("expected '='");
    i += 1;
    const path = declareAssignment(segments, start);
    const value = readValue(path);
    assignInto(currentNode, segments, value);
    defined.set(path, isPlainObject(value) ? "inline" : "value");
    extendAncestors(path, start, i);
    requireLineEnd();
  }

  for (;;) {
    skipTrivia();
    if (i >= text.length) break;
    if (text.charCodeAt(i) === 0x5b) readTableHeader();
    else readAssignment();
  }

  for (const [path, region] of regions) spans[path] = pos.span(region.start, region.end);
  spans["$"] = pos.span(0, text.length);
  return { value: root, key_order: keyOrder, spans };
}

export function patch(text, edits) {
  return applyEdits(text, edits, () => parse(text).spans);
}

// Only for creating a file that does not exist (manifest §2.3). key_order is honoured within each
// container, but TOML itself forces every sub-table after its parent's bare keys — a key written
// after a [table] header belongs to that table — so a parent's order is scalars first, then
// tables, never the author's interleaving.
export function serialize(value, keyOrder) {
  const lines = [];
  emitTable(value ?? {}, "", "$", lines, keyOrder);
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

function emitTable(node, path, bucket, lines, keyOrder) {
  const tables = [];
  for (const key of orderedKeys(node, keyOrder?.[bucket])) {
    const entry = node[key];
    if (isPlainObject(entry) || isTableArray(entry)) {
      tables.push(key);
      continue;
    }
    lines.push(`${renderKey(key)} = ${inline(entry)}`);
  }
  for (const key of tables) {
    const childPath = path ? `${path}.${renderKey(key)}` : renderKey(key);
    const entry = node[key];
    if (Array.isArray(entry)) {
      for (let index = 0; index < entry.length; index += 1) {
        if (lines.length > 0) lines.push("");
        lines.push(`[[${childPath}]]`);
        emitTable(entry[index], childPath, `${childPath}[${index}]`, lines, keyOrder);
      }
      continue;
    }
    if (lines.length > 0) lines.push("");
    lines.push(`[${childPath}]`);
    emitTable(entry, childPath, childPath, lines, keyOrder);
  }
}

function orderedKeys(node, order) {
  const keys = [];
  if (Array.isArray(order)) for (const key of order) if (Object.hasOwn(node, key)) keys.push(key);
  for (const key of Object.keys(node)) if (!keys.includes(key)) keys.push(key);
  return keys;
}

export function renderKey(key) {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

export function inline(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (value === Infinity) return "inf";
    if (value === -Infinity) return "-inf";
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(inline).join(", ")}]`;
  if (isPlainObject(value)) {
    return `{ ${Object.entries(value)
      .map(([key, entry]) => `${renderKey(key)} = ${inline(entry)}`)
      .join(", ")} }`;
  }
  return JSON.stringify(String(value));
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTableArray(value) {
  return Array.isArray(value) && value.length > 0 && value.every(isPlainObject);
}

function radix(token, base) {
  const negative = token.startsWith("-");
  const digits = token.replace(/^[+-]/, "").slice(2);
  const magnitude = parseInt(digits, base);
  return negative ? -magnitude : magnitude;
}

// Parent paths of a key path, nearest first: a.b[0].c -> a.b[0], a.b, a.
function ancestorsOf(path) {
  const out = [];
  let current = path;
  for (;;) {
    const bracket = current.lastIndexOf("[");
    const dot = current.lastIndexOf(".");
    if (bracket > dot) current = current.slice(0, bracket);
    else if (dot > 0) current = current.slice(0, dot);
    else return out;
    out.push(current);
  }
}
