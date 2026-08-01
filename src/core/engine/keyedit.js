// Writing ONE key into an existing configuration file, without disturbing a byte that
// key does not own (manifest §2.3).
//
// Two strategies, in order of preference:
//
//   1. The key already exists — replace the bytes of its VALUE through the format's own
//      span table. Comments, key order, indentation and every sibling survive exactly.
//   2. The key does not exist — splice a new member into the nearest ancestor that does,
//      rendering it at the indentation its siblings use.
//
// A whole-document `serialize(parse(text))` round-trip is the strategy of last resort and
// is used only for a file that does not exist yet, because re-serializing a user's config
// rewrites lines they never consented to change.
//
// The other half of this module is target-key-path resolution. An item's key path is where
// the value lived on the SOURCE machine — `permissions.allow[3]` — and writing there would
// overwrite the target's own fourth rule. Every array position therefore resolves to an
// APPEND on the target, which is also what makes "permissions are additions, never merges"
// true in the code rather than in a comment.

import { formatFor } from "../formats/index.js";
import { inline as tomlInline, renderKey as tomlKey } from "../formats/toml.js";
import { setKey } from "../formats/spans.js";
import { rebuildKeyPath, splitKeyPath } from "../fsx/paths.js";

const INDEXED = /^\[(\d+)\]$/;

export function readTree(format, text) {
  if (text === null || text === undefined || String(text).trim().length === 0) {
    return { value: format === "toml" ? {} : {}, key_order: {}, spans: {}, empty: true };
  }
  return { ...formatFor(format).parse(String(text)), empty: false };
}

export function valueAt(tree, keyPath) {
  let node = tree;
  for (const segment of splitKeyPath(keyPath)) {
    if (node === null || node === undefined) return undefined;
    const index = INDEXED.exec(segment);
    if (index) {
      if (!Array.isArray(node)) return undefined;
      node = node[Number(index[1])];
      continue;
    }
    if (typeof node !== "object" || Array.isArray(node)) return undefined;
    if (!Object.hasOwn(node, segment)) return undefined;
    node = node[segment];
  }
  return node;
}

/**
 * Where the source key path lands on the target.
 *
 * Object segments address the same key. Every array segment becomes an append: a leaf
 * array element appends at the end, and an intermediate array element appends a fresh
 * container that the rest of the path is then built inside. That is what turns "import
 * this permission rule" into an addition instead of a silent overwrite of rule N.
 *
 * `duplicate_of` is set when the exact value is already present in the destination array,
 * which makes a re-import a no-op instead of a second copy.
 */
export function resolveTargetKeyPath({ tree, keyPath, value }) {
  const segments = splitKeyPath(keyPath);
  const out = [];
  let node = tree;
  const losses = [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const last = i === segments.length - 1;
    const index = INDEXED.exec(segment);
    if (!index) {
      out.push(segment);
      node = node && typeof node === "object" && !Array.isArray(node) ? node[segment] : undefined;
      continue;
    }
    const array = Array.isArray(node) ? node : [];
    if (last) {
      const at = array.findIndex((entry) => deepEqual(entry, value));
      if (at !== -1) {
        return { key_path: rebuildKeyPath([...out, `[${at}]`]), append: false, duplicate_of: at, losses };
      }
      out.push(`[${array.length}]`);
      return { key_path: rebuildKeyPath(out), append: true, duplicate_of: null, losses };
    }
    // Before appending a container, look for one that already holds this exact value
    // further down the path. Without it, re-importing the same bundle adds a second
    // matcher group holding the same hook, every time, for ever.
    const remaining = rebuildKeyPath(segments.slice(i + 1));
    for (let n = 0; n < array.length; n += 1) {
      const inner = resolveTargetKeyPath({ tree: array[n], keyPath: remaining, value });
      if (inner.duplicate_of !== null) {
        return {
          key_path: rebuildKeyPath([...out, `[${n}]`, ...splitKeyPath(inner.key_path)]),
          append: false,
          duplicate_of: n,
          losses,
        };
      }
    }
    // An intermediate array element carries context the item model does not: a Claude hook
    // lives inside a matcher group, and the group's `matcher` is a sibling of the array the
    // hook is in, not part of the hook. Appending a fresh group is correct and lossy, so the
    // loss is declared on the operation rather than discovered later.
    losses.push(`array position ${rebuildKeyPath([...out, segment])} is appended as a new entry; sibling context at that level is not carried`);
    out.push(`[${array.length}]`);
    node = undefined;
  }
  return { key_path: rebuildKeyPath(out), append: false, duplicate_of: null, losses };
}

export function removeAt({ tree, keyPath }) {
  const next = clone(tree);
  const segments = splitKeyPath(keyPath);
  let node = next;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const index = INDEXED.exec(segments[i]);
    node = index ? node?.[Number(index[1])] : node?.[segments[i]];
    if (node === undefined || node === null) return next;
  }
  const leaf = segments[segments.length - 1];
  const index = INDEXED.exec(leaf);
  if (index && Array.isArray(node)) node.splice(Number(index[1]), 1);
  else if (node && typeof node === "object") delete node[leaf];
  return next;
}

/**
 * Drop containers that a removal has just emptied, up to (but never past) `stopAt`.
 *
 * Enabling a quarantined hook moves it out of Continuity's parking bucket; without this,
 * the bucket keeps an empty matcher group for every item ever enabled. The stop path is
 * required so this can only ever tidy a structure the import created, never a user's own
 * empty array that they put there on purpose.
 */
export function pruneEmpty({ tree, keyPath, stopAt }) {
  const next = clone(tree);
  const stop = splitKeyPath(stopAt).length;
  const segments = splitKeyPath(keyPath);
  for (let depth = segments.length - 1; depth > stop; depth -= 1) {
    const parentPath = rebuildKeyPath(segments.slice(0, depth));
    const value = valueAt(next, parentPath);
    const empty =
      (Array.isArray(value) && value.length === 0) ||
      (isPlainObject(value) && Object.keys(value).length === 0);
    if (!empty) break;
    const parent = valueAt(next, rebuildKeyPath(segments.slice(0, depth - 1)));
    const leaf = segments[depth - 1];
    const index = INDEXED.exec(leaf);
    if (index && Array.isArray(parent)) parent.splice(Number(index[1]), 1);
    else if (isPlainObject(parent)) delete parent[leaf];
    else break;
  }
  return next;
}

function assign(node, segments, value) {
  const [head, ...rest] = segments;
  const index = INDEXED.exec(head);
  if (rest.length === 0) {
    if (index) node[Number(index[1])] = value;
    else setKey(node, head, value);
    return;
  }
  const childIsIndex = INDEXED.test(rest[0]);
  let child = index ? node[Number(index[1])] : node[head];
  if (child === undefined || child === null || typeof child !== "object") {
    child = childIsIndex ? [] : {};
    if (index) node[Number(index[1])] = child;
    else setKey(node, head, child);
  }
  assign(child, rest, value);
}

/**
 * Produce the new file text. `text` may be null for a file that does not exist yet.
 */
export function writeKey({ format, text, keyPath, value }) {
  const module = formatFor(format);
  const source = text === null || text === undefined ? "" : String(text);
  if (source.trim().length === 0) {
    const tree = {};
    assign(tree, splitKeyPath(keyPath), value);
    return module.serialize(tree, {});
  }

  const parsed = module.parse(source);
  const span = parsed.spans[keyPath];
  if (span) {
    return module.patch(source, [
      {
        key_path: keyPath,
        // A TOML table's span covers its `[header]` as well as its body, so replacing it
        // with an inline table would leave a value with no key. Re-render the whole table
        // instead, header included.
        replacement:
          format === "toml" && isTableShaped(value)
            ? tomlTableReplacement(keyPath, value).replace(/\n+$/, "")
            : renderValue(format, value, indentAt(source, span.byte_start)),
      },
    ]);
  }

  const segments = splitKeyPath(keyPath);
  for (let cut = segments.length - 1; cut >= 1; cut -= 1) {
    const ancestorPath = rebuildKeyPath(segments.slice(0, cut));
    const ancestorSpan = parsed.spans[ancestorPath];
    const ancestorValue = valueAt(parsed.value, ancestorPath);
    if (!ancestorSpan || ancestorValue === undefined || ancestorValue === null) continue;
    const missing = segments.slice(cut);
    const nested = nest(missing.slice(1), value);
    if (format === "toml") {
      // Appending to an array of tables is `[[path]]`, not `[path.[n]]` — TOML has no
      // syntax for an indexed table header, and the index is implied by position.
      return INDEXED.test(missing[0])
        ? appendToml(source, segments.slice(0, cut), [nested])
        : appendToml(source, [...segments.slice(0, cut), missing[0]], nested);
    }
    return spliceJson({ source, span: ancestorSpan, container: ancestorValue, segment: missing[0], value: nested });
  }

  // Nothing on the path exists: splice into the document root.
  const rootSpan = parsed.spans.$;
  const nested = nest(segments.slice(1), value);
  if (format === "toml") return appendToml(source, [segments[0]], nested);
  if (!rootSpan) throw new Error(`cannot write ${keyPath}: the target has no addressable root`);
  return spliceJson({ source, span: rootSpan, container: parsed.value, segment: segments[0], value: nested });
}

function nest(segments, value) {
  if (segments.length === 0) return value;
  const [head, ...rest] = segments;
  const inner = nest(rest, value);
  return INDEXED.test(head) ? [inner] : { [head]: inner };
}

function spliceJson({ source, span, container, segment, value }) {
  const body = source.slice(byteToUnit(source, span.byte_start), byteToUnit(source, span.byte_end));
  const openIndent = indentAt(source, span.byte_start);
  const childIndent = `${openIndent}  `;
  const index = INDEXED.exec(segment);
  const closer = Array.isArray(container) ? "]" : "}";
  const opener = Array.isArray(container) ? "[" : "{";
  if (!body.trimStart().startsWith(opener)) {
    throw new Error(`cannot insert into a ${typeof container} at this position`);
  }
  const member =
    index || Array.isArray(container)
      ? renderValue("json", value, childIndent)
      : `${JSON.stringify(segment)}: ${renderValue("json", value, childIndent)}`;
  const close = body.lastIndexOf(closer);
  const head = body.slice(0, close).replace(/\s*$/, "");
  const empty = head === opener;
  const replacement = empty
    ? `${opener}\n${childIndent}${member}\n${openIndent}${closer}`
    : `${head},\n${childIndent}${member}\n${openIndent}${closer}`;
  return `${source.slice(0, byteToUnit(source, span.byte_start))}${replacement}${source.slice(byteToUnit(source, span.byte_end))}`;
}

/**
 * TOML gets an append rather than a splice. A new `[table]` at the end of the file is the
 * format's own idiom for "one more entry", it cannot disturb a comment, and it avoids
 * re-declaring a table header, which is a parse error rather than a merge.
 */
function appendToml(source, pathSegments, value) {
  const dotted = pathSegments.map((segment) => (INDEXED.test(segment) ? segment : tomlKey(segment))).join(".");
  const fragment = tomlFragment(dotted, value);
  const separator = source.endsWith("\n") ? "" : "\n";
  // A bare `key = value` belongs to whatever table header precedes it, so appending a
  // TOP-LEVEL key to the end of a file that already has tables silently reparents it —
  // `approval_policy` after `[[hooks.PreToolUse.hooks]]` becomes a key of that hook. A
  // root scalar therefore goes in above the first table header, which is the only position
  // that means what it says.
  if (!fragment.startsWith("[")) {
    const firstTable = /^\[/m.exec(`${source}${separator}`);
    if (firstTable) {
      const at = firstTable.index;
      return `${source.slice(0, at)}${fragment}\n${source.slice(at)}`;
    }
  }
  return `${source}${separator}\n${fragment}`;
}

function tomlFragment(dotted, value) {
  if (Array.isArray(value) && value.length > 0 && value.every(isPlainObject)) {
    return value.map((entry) => `[[${dotted}]]\n${tomlBody(dotted, entry)}`).join("\n");
  }
  if (isPlainObject(value)) {
    // A table whose keys are all sub-tables needs no header of its own: TOML creates the
    // parent implicitly, and an empty `[skills]` above `[[skills.config]]` is noise in a
    // file the user reads.
    const body = tomlBody(dotted, value);
    return hasScalars(value) || body.length === 0 ? `[${dotted}]\n${body}` : body;
  }
  return `${dotted} = ${tomlInline(value)}\n`;
}

function hasScalars(node) {
  return Object.values(node).some(
    (entry) => !isPlainObject(entry) && !(Array.isArray(entry) && entry.length > 0 && entry.every(isPlainObject)),
  );
}

function tomlBody(dotted, node) {
  const scalars = [];
  const tables = [];
  for (const [key, entry] of Object.entries(node)) {
    if (isPlainObject(entry) || (Array.isArray(entry) && entry.length > 0 && entry.every(isPlainObject))) {
      tables.push(tomlFragment(`${dotted}.${tomlKey(key)}`, entry));
      continue;
    }
    scalars.push(`${tomlKey(key)} = ${tomlInline(entry)}`);
  }
  return `${scalars.join("\n")}${scalars.length > 0 ? "\n" : ""}${tables.length > 0 ? `\n${tables.join("\n")}` : ""}`;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTableShaped(value) {
  return isPlainObject(value) || (Array.isArray(value) && value.length > 0 && value.every(isPlainObject));
}

/**
 * The `[header]` form of a key path, and the value shape that goes under it. A trailing
 * index means "the last element of this array of tables", which is the only array position
 * TOML can name; an index anywhere else is not expressible, and saying so is better than
 * emitting a header no parser accepts.
 */
function tomlTableReplacement(keyPath, value) {
  const segments = splitKeyPath(keyPath);
  const trailing = INDEXED.test(segments[segments.length - 1]);
  const base = trailing ? segments.slice(0, -1) : segments;
  if (base.some((segment) => INDEXED.test(segment))) {
    throw new Error(`TOML cannot address ${keyPath}: an array element below the last position has no header form`);
  }
  return tomlFragment(base.map(tomlKey).join("."), trailing ? [value] : value);
}

export function renderValue(format, value, indent = "") {
  if (format === "toml") return tomlInline(value);
  const text = JSON.stringify(value, null, 2);
  return text.split("\n").join(`\n${indent}`);
}

function indentAt(source, bytePos) {
  const unit = byteToUnit(source, bytePos);
  const lineStart = source.lastIndexOf("\n", Math.max(0, unit - 1)) + 1;
  const match = /^[ \t]*/.exec(source.slice(lineStart, unit));
  return match ? match[0] : "";
}

// The span table records UTF-8 byte offsets; splicing happens on the JS string.
function byteToUnit(source, bytePos) {
  let bytes = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (bytes >= bytePos) return i;
    const code = source.codePointAt(i);
    if (code > 0xffff) {
      bytes += 4;
      i += 1;
    } else if (code > 0x7ff) bytes += 3;
    else if (code > 0x7f) bytes += 2;
    else bytes += 1;
  }
  return source.length;
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) return a.length === b.length && a.every((entry, index) => deepEqual(entry, b[index]));
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  return keysA.length === keysB.length && keysA.every((key, index) => key === keysB[index] && deepEqual(a[key], b[key]));
}

/**
 * Key-sorted JSON. The trust pin is taken over an ITEM's content, not over the file that
 * holds it — otherwise a second, unrelated import into the same settings.json would revoke
 * every pin in it, and "editing this hook re-arms review" would mean "editing anything
 * re-arms review", which is the same as no pin at all.
 */
export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isPlainObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

export function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isPlainObject(value)) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) setKey(out, key, clone(entry));
    return out;
  }
  return value;
}
