// Markdown with YAML frontmatter — the SKILL.md / agent / command surface.
//
// The point of this parser is that EVERY key survives verbatim. `allowed_tools` (underscore)
// outnumbers the documented `allowed-tools` 160 to 117 on a surveyed machine (manifest §2.1), so
// a parser that normalizes, drops or "fixes" unknown keys would silently change behaviour on more
// files than it left alone. Unknown keys land in `frontmatter` and in `key_order` exactly as
// written; classifying them into recognized/unrecognized is the engine's job, not the parser's.
//
// Deliberate choices:
// - Scalars stay STRINGS. `preamble-tier: 2` parses as "2", matching the worked example in
//   manifest §2.1; YAML's implicit typing would change the manifest's shape for no gain.
// - A trailing " # …" is NOT stripped from a plain scalar even though YAML calls it a comment:
//   skill descriptions contain "#" constantly and losing the tail is worse than keeping it. Only
//   whole-line comments are treated as comments.
// - key_order is a flat ARRAY of top-level frontmatter keys (this surface has one container).
// - body_offset is a UTF-8 BYTE offset, like every other offset here. Slice `body` instead.
// - spans of the fence block and of the body are "$frontmatter" and "$body"; "$" is the whole
//   file. The "$" prefix cannot collide with a YAML key because it is not in the key charset.

import { applyEdits, positions, setKey } from "./spans.js";

export const id = "md+frontmatter";

const OPEN_FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;
const COMMENT_LINE = /^[ \t]*#/;
const KEY_LINE = /^([ \t]*)([A-Za-z0-9_./-]+)[ \t]*:[ \t]*(.*?)[ \t]*$/d;
const LIST_ITEM = /^([ \t]*)-[ \t]*(.*?)[ \t]*$/d;
const BLOCK_SCALAR = /^[|>][+-]?[0-9]*$/;

export function parse(text) {
  const pos = positions(text);
  const lines = scanLines(text);
  const spans = Object.create(null);
  spans["$"] = pos.span(0, text.length);

  const close = frontmatterEnd(text, lines);
  if (close === -1) {
    return {
      value: { frontmatter: null, body: text },
      frontmatter: null,
      body: text,
      body_offset: 0,
      key_order: [],
      spans: Object.assign(spans, { $body: pos.span(0, text.length) }),
    };
  }

  const bodyStart = Math.min(lines[close].next, text.length);
  const { frontmatter, keyOrder } = readBlock(text, lines, 1, close, spans, pos);
  spans.$frontmatter = pos.span(0, bodyStart);
  spans.$body = pos.span(bodyStart, text.length);
  const body = text.slice(bodyStart);
  return {
    value: { frontmatter, body },
    frontmatter,
    body,
    body_offset: pos.table[bodyStart],
    key_order: keyOrder,
    spans,
  };
}

export function patch(text, edits) {
  return applyEdits(text, edits, () => parse(text).spans);
}

// Only for creating a file that does not exist (manifest §2.3).
export function serialize(value, keyOrder) {
  const frontmatter = value?.frontmatter ?? null;
  const body = value?.body ?? "";
  if (!frontmatter) return body;
  const order = keyOrder ?? value?.key_order ?? Object.keys(frontmatter);
  const keys = [];
  for (const key of order) if (Object.hasOwn(frontmatter, key)) keys.push(key);
  for (const key of Object.keys(frontmatter)) if (!keys.includes(key)) keys.push(key);
  const lines = ["---"];
  for (const key of keys) lines.push(...renderEntry(key, frontmatter[key]));
  lines.push("---", "");
  return lines.join("\n") + body;
}

// Plain markdown: the same result shape with no frontmatter, so the engine reads md and
// md+frontmatter through one code path.
export const md = {
  id: "md",
  parse(text) {
    const pos = positions(text);
    return {
      value: { frontmatter: null, body: text },
      frontmatter: null,
      body: text,
      body_offset: 0,
      key_order: [],
      spans: { $: pos.span(0, text.length), $body: pos.span(0, text.length) },
    };
  },
  patch(text, edits) {
    return applyEdits(text, edits, () => md.parse(text).spans);
  },
  serialize(value) {
    return typeof value === "string" ? value : (value?.body ?? "");
  },
};

function scanLines(text) {
  const lines = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf("\n", start);
    if (newline === -1) {
      lines.push({ start, end: text.length, next: text.length });
      return lines;
    }
    const end = newline > start && text.charCodeAt(newline - 1) === 0x0d ? newline - 1 : newline;
    lines.push({ start, end, next: newline + 1 });
    start = newline + 1;
  }
}

// Index of the closing fence line, or -1 when the file has no frontmatter. An unterminated opening
// fence counts as no frontmatter rather than an error — the runtimes treat it as body text.
function frontmatterEnd(text, lines) {
  // A leading BOM is skipped rather than treated as body text.
  const opening = text.slice(lines[0]?.start ?? 0, lines[0]?.end ?? 0).replace(/^\uFEFF/, "");
  if (lines.length < 2 || !OPEN_FENCE.test(opening)) return -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (CLOSE_FENCE.test(text.slice(lines[index].start, lines[index].end))) return index;
  }
  return -1;
}

function readBlock(text, lines, first, last, spans, pos) {
  const frontmatter = {};
  const keyOrder = [];
  let index = first;
  while (index < last) {
    const line = lines[index];
    const content = text.slice(line.start, line.end);
    if (content.trim() === "" || COMMENT_LINE.test(content)) {
      index += 1;
      continue;
    }
    const match = KEY_LINE.exec(content);
    if (!match || match[1].length > 0) {
      index += 1;
      continue;
    }
    const key = match[2];
    const rest = match[3];
    const [restStart, restEnd] = match.indices[3];
    let value;
    let span;

    if (BLOCK_SCALAR.test(rest)) {
      const block = readBlockScalar(text, lines, index + 1, last, rest[0]);
      value = block.value;
      index = block.index;
      span = pos.span(line.start + restStart, block.end);
    } else if (rest !== "") {
      value = readScalar(rest);
      span = pos.span(line.start + restStart, line.start + restEnd);
      if (Array.isArray(value)) recordInlineItems(rest, line.start + restStart, key, spans, pos);
      index += 1;
    } else {
      const block = readNested(text, lines, index + 1, last, key, spans, pos);
      value = block.value;
      span = block.span ?? pos.span(line.start + restEnd, line.start + restEnd);
      index = block.index;
    }

    setKey(frontmatter, key, value);
    spans[key] = span;
    if (!keyOrder.includes(key)) keyOrder.push(key);
  }
  return { frontmatter, keyOrder };
}

// A block list or a one-level-deep nested map. Deeper nesting is left out of `value` on purpose:
// nothing in the surveyed corpus needs it, and raw stays authoritative for what is not modelled.
function readNested(text, lines, start, last, key, spans, pos) {
  let index = start;
  while (index < last) {
    const content = text.slice(lines[index].start, lines[index].end);
    if (content.trim() === "" || COMMENT_LINE.test(content)) {
      index += 1;
      continue;
    }
    break;
  }
  if (index >= last) return { value: "", index: start, span: null };

  const content = text.slice(lines[index].start, lines[index].end);
  if (LIST_ITEM.test(content)) return readList(text, lines, index, last, key, spans, pos);
  const match = KEY_LINE.exec(content);
  if (match && match[1].length > 0) return readMap(text, lines, index, last, key, spans, pos);
  return { value: "", index: start, span: null };
}

function readList(text, lines, start, last, key, spans, pos) {
  const value = [];
  let index = start;
  let end = lines[start].end;
  let spanStart = null;
  while (index < last) {
    const line = lines[index];
    const content = text.slice(line.start, line.end);
    if (content.trim() === "" || COMMENT_LINE.test(content)) {
      index += 1;
      continue;
    }
    const match = LIST_ITEM.exec(content);
    if (!match) break;
    const [itemStart, itemEnd] = match.indices[2];
    if (spanStart === null) spanStart = line.start + match.indices[1][1];
    spans[`${key}[${value.length}]`] = pos.span(line.start + itemStart, line.start + itemEnd);
    value.push(readScalar(match[2]));
    end = line.end;
    index += 1;
  }
  return { value, index, span: pos.span(spanStart ?? lines[start].start, end) };
}

function readMap(text, lines, start, last, key, spans, pos) {
  const value = {};
  const indent = KEY_LINE.exec(text.slice(lines[start].start, lines[start].end))[1].length;
  let index = start;
  let end = lines[start].end;
  while (index < last) {
    const line = lines[index];
    const content = text.slice(line.start, line.end);
    if (content.trim() === "" || COMMENT_LINE.test(content)) {
      index += 1;
      continue;
    }
    const match = KEY_LINE.exec(content);
    if (!match || match[1].length < indent) break;
    if (match[1].length > indent) {
      index += 1;
      end = line.end;
      continue;
    }
    const [restStart, restEnd] = match.indices[3];
    setKey(value, match[2], readScalar(match[3]));
    spans[`${key}.${match[2]}`] = pos.span(line.start + restStart, line.start + restEnd);
    end = line.end;
    index += 1;
  }
  return { value, index, span: pos.span(lines[start].start + indent, end) };
}

function readBlockScalar(text, lines, start, last, style) {
  const collected = [];
  let index = start;
  let end = start > 0 ? lines[start - 1].end : 0;
  let indent = null;
  while (index < last) {
    const line = lines[index];
    const content = text.slice(line.start, line.end);
    if (content.trim() === "") {
      collected.push("");
      end = line.end;
      index += 1;
      continue;
    }
    const leading = content.length - content.trimStart().length;
    if (leading === 0) break;
    if (indent === null) indent = leading;
    collected.push(content.slice(Math.min(indent, leading)));
    end = line.end;
    index += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1] === "") collected.pop();
  return { value: collected.join(style === ">" ? " " : "\n"), index, end };
}

function readScalar(raw) {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInline(value.slice(1, -1)).map((part) => readScalar(part.text));
  }
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1);
  }
  return value;
}

function recordInlineItems(rest, base, key, spans, pos) {
  const open = rest.indexOf("[");
  const inner = rest.slice(open + 1, rest.lastIndexOf("]"));
  const parts = splitInline(inner);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    spans[`${key}[${index}]`] = pos.span(base + open + 1 + part.start, base + open + 1 + part.end);
  }
}

// Split a flow sequence on top-level commas, keeping each item's offsets inside the brackets.
function splitInline(inner) {
  const parts = [];
  let quote = null;
  let start = 0;
  const push = (end) => {
    const text = inner.slice(start, end);
    const leading = text.length - text.trimStart().length;
    const trimmed = text.trim();
    if (trimmed === "" && end >= inner.length) return;
    parts.push({ text: trimmed, start: start + leading, end: start + leading + trimmed.length });
  };
  for (let index = 0; index < inner.length; index += 1) {
    const c = inner[index];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === ",") {
      push(index);
      start = index + 1;
    }
  }
  push(inner.length);
  return parts;
}

function renderEntry(key, value) {
  if (Array.isArray(value)) return [`${key}: [${value.map((item) => renderScalar(String(item))).join(", ")}]`];
  if (value && typeof value === "object") {
    const lines = [`${key}:`];
    for (const [child, entry] of Object.entries(value)) lines.push(`  ${child}: ${renderScalar(String(entry))}`);
    return lines;
  }
  const text = String(value ?? "");
  if (text.includes("\n")) return [`${key}: |`, ...text.split("\n").map((line) => `  ${line}`)];
  return [`${key}: ${renderScalar(text)}`];
}

function renderScalar(text) {
  if (text === "") return '""';
  if (/^[[\]{}>|&*!%@`'"]/.test(text) || text !== text.trim() || text.includes(", ")) return JSON.stringify(text);
  return text;
}
