// JSON with a per-key span for every parsed key (adapter-architecture §1.4), so emit can replace
// the bytes of one key rather than re-serializing the tree (manifest §2.3).
//
// spans[path] covers the VALUE of that path, not the key token: replacing it rewrites the value
// and leaves the key, the punctuation and every sibling byte alone. The root value is "$".
// Key paths are dotted with [i] array indices; a key that itself contains "." produces a path
// indistinguishable from nesting, which is accepted rather than escaped so paths match the
// examples in the design docs (mcpServers.slack.env.TOKEN).

import { applyEdits, positions, setKey } from "./spans.js";

const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const KEYWORD = /true|false|null/y;

export const id = "json";

// json.js and jsonc.js are the same scanner with two switches thrown, rather than two parsers that
// drift apart.
export function createJsonParser({ comments = false, trailingCommas = false } = {}) {
  return function parseJsonLike(text) {
    const pos = positions(text);
    const spans = Object.create(null);
    const keyOrder = Object.create(null);
    // A leading BOM is skipped rather than rejected: an invisible character must not cost the user
    // the whole file, and the bytes survive anyway because the write path is patch.
    let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

    const fail = (message) => {
      const at = Math.min(i, text.length);
      throw new SyntaxError(
        `${message} at byte ${pos.table[at]} (line ${pos.span(at, at).line_start})`,
      );
    };

    function skipTrivia() {
      for (;;) {
        while (i < text.length && WHITESPACE.has(text.charCodeAt(i))) i += 1;
        if (!comments || text.charCodeAt(i) !== 0x2f) return;
        if (text.charCodeAt(i + 1) === 0x2f) {
          i += 2;
          while (i < text.length && text.charCodeAt(i) !== 0x0a) i += 1;
          continue;
        }
        if (text.charCodeAt(i + 1) === 0x2a) {
          const end = text.indexOf("*/", i + 2);
          if (end === -1) {
            i = text.length;
            fail("unterminated block comment");
          }
          i = end + 2;
          continue;
        }
        return;
      }
    }

    function readString() {
      if (text.charCodeAt(i) !== 0x22) fail("expected a string");
      i += 1;
      let out = "";
      for (;;) {
        if (i >= text.length) fail("unterminated string");
        const code = text.charCodeAt(i);
        if (code === 0x22) {
          i += 1;
          return out;
        }
        if (code === 0x5c) {
          const escape = text[i + 1];
          i += 2;
          if (escape === "n") out += "\n";
          else if (escape === "t") out += "\t";
          else if (escape === "r") out += "\r";
          else if (escape === "b") out += "\b";
          else if (escape === "f") out += "\f";
          else if (escape === '"' || escape === "\\" || escape === "/") out += escape;
          else if (escape === "u") {
            const hex = text.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
              i -= 2;
              fail("invalid \\u escape");
            }
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
          } else {
            i -= 2;
            fail(`invalid escape \\${escape ?? ""}`);
          }
          continue;
        }
        if (code < 0x20) fail("unescaped control character in string");
        out += text[i];
        i += 1;
      }
    }

    function readValue(keyPath) {
      skipTrivia();
      if (i >= text.length) fail("unexpected end of input");
      const start = i;
      const path = keyPath || "$";
      let value;
      const code = text.charCodeAt(i);
      if (code === 0x7b) {
        value = readObject(keyPath, path);
      } else if (code === 0x5b) {
        value = readArray(keyPath);
      } else if (code === 0x22) {
        value = readString();
      } else {
        KEYWORD.lastIndex = i;
        const keyword = KEYWORD.exec(text);
        if (keyword) {
          i = KEYWORD.lastIndex;
          value = keyword[0] === "true" ? true : keyword[0] === "false" ? false : null;
        } else {
          NUMBER.lastIndex = i;
          const number = NUMBER.exec(text);
          if (!number) fail("unexpected token");
          i = NUMBER.lastIndex;
          value = Number(number[0]);
        }
      }
      spans[path] = pos.span(start, i);
      return value;
    }

    function readObject(keyPath, path) {
      i += 1;
      const value = {};
      const keys = [];
      skipTrivia();
      if (text.charCodeAt(i) === 0x7d) i += 1;
      else
        for (;;) {
          skipTrivia();
          if (trailingCommas && text.charCodeAt(i) === 0x7d) {
            i += 1;
            break;
          }
          const key = readString();
          skipTrivia();
          if (text.charCodeAt(i) !== 0x3a) fail("expected ':'");
          i += 1;
          // Duplicate keys are last-wins because that is what the runtimes' own JSON.parse does;
          // key_order still lists the key once, in first-seen position.
          setKey(value, key, readValue(keyPath ? `${keyPath}.${key}` : key));
          if (!keys.includes(key)) keys.push(key);
          skipTrivia();
          if (text.charCodeAt(i) === 0x2c) {
            i += 1;
            continue;
          }
          if (text.charCodeAt(i) !== 0x7d) fail("expected '}' or ','");
          i += 1;
          break;
        }
      keyOrder[path] = keys;
      return value;
    }

    function readArray(keyPath) {
      i += 1;
      const value = [];
      skipTrivia();
      if (text.charCodeAt(i) === 0x5d) i += 1;
      else
        for (;;) {
          skipTrivia();
          if (trailingCommas && text.charCodeAt(i) === 0x5d) {
            i += 1;
            break;
          }
          value.push(readValue(`${keyPath || "$"}[${value.length}]`));
          skipTrivia();
          if (text.charCodeAt(i) === 0x2c) {
            i += 1;
            continue;
          }
          if (text.charCodeAt(i) !== 0x5d) fail("expected ']' or ','");
          i += 1;
          break;
        }
      return value;
    }

    const value = readValue("");
    skipTrivia();
    if (i < text.length) fail("unexpected trailing content");
    return { value, key_order: keyOrder, spans };
  };
}

export const parse = createJsonParser();

export function patch(text, edits) {
  return applyEdits(text, edits, () => parse(text).spans);
}

// Only for creating a file that does not exist (manifest §2.3).
export function serialize(value, keyOrder) {
  return `${JSON.stringify(reorder(value, keyOrder, ""), null, 2)}\n`;
}

export function reorder(value, keyOrder, path) {
  if (Array.isArray(value)) return value.map((entry, index) => reorder(entry, keyOrder, `${path || "$"}[${index}]`));
  if (!value || typeof value !== "object") return value;
  const bucket = keyOrder?.[path || "$"];
  const out = {};
  const child = (key) => reorder(value[key], keyOrder, path ? `${path}.${key}` : key);
  if (Array.isArray(bucket)) {
    for (const key of bucket) if (Object.hasOwn(value, key)) setKey(out, key, child(key));
  }
  for (const key of Object.keys(value)) if (!Object.hasOwn(out, key)) setKey(out, key, child(key));
  return out;
}
