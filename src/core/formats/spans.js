// Position bookkeeping shared by every format module (adapter-architecture §1.4).
// Two coordinate systems meet here. Parsers scan the JS string in UTF-16 code units because that
// is what charCodeAt/slice/regex operate on, but every offset a span records is a TRUE UTF-8 BYTE
// offset: an em-dash in a comment must not shift the recorded offsets of the keys after it, and
// the bundle addresses raw bytes, not JS strings. The code-unit -> byte prefix table is built once
// per parse and threaded through; rebuilding it per span is O(n^2) on a large settings.json.

const TABLE_CACHE = new Map();
const TABLE_CACHE_LIMIT = 4;

export function lineOffsets(text) {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) if (text.charCodeAt(i) === 10) offsets.push(i + 1);
  return offsets;
}

// 1-based line number of a code-unit position.
export function lineAt(offsets, cuPos) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid] <= cuPos) low = mid;
    else high = mid - 1;
  }
  return low + 1;
}

// table[i] is the UTF-8 byte offset of code unit i; table[text.length] is the total byte length.
export function byteTable(text) {
  const cached = TABLE_CACHE.get(text);
  if (cached) return cached;
  const table = buildByteTable(text);
  TABLE_CACHE.set(text, table);
  // The cache keys are whole file texts, so an unbounded map would retain every file the process
  // ever parsed.
  if (TABLE_CACHE.size > TABLE_CACHE_LIMIT) TABLE_CACHE.delete(TABLE_CACHE.keys().next().value);
  return table;
}

function buildByteTable(text) {
  const table = new Uint32Array(text.length + 1);
  let bytes = 0;
  let i = 0;
  while (i < text.length) {
    table[i] = bytes;
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
      i += 1;
    } else if (code < 0x800) {
      bytes += 2;
      i += 1;
    } else if (code >= 0xd800 && code <= 0xdbff && isLowSurrogate(text.charCodeAt(i + 1))) {
      // The pair's 4 bytes are charged to the leading unit, so the trailing unit's byte offset is
      // the end of the whole character and codeUnitIndex can never land inside one.
      bytes += 4;
      i += 1;
      table[i] = bytes;
      i += 1;
    } else {
      // A lone surrogate is 3 bytes because UTF-8 encoding replaces it with U+FFFD, which is what
      // Buffer.byteLength counts.
      bytes += 3;
      i += 1;
    }
  }
  table[text.length] = bytes;
  return table;
}

function isLowSurrogate(code) {
  return code >= 0xdc00 && code <= 0xdfff;
}

export function byteIndex(text, cuPos) {
  const table = byteTable(text);
  if (!Number.isInteger(cuPos) || cuPos < 0 || cuPos >= table.length) {
    throw new RangeError(`code-unit position ${cuPos} is outside the text`);
  }
  return table[cuPos];
}

// Inverse of byteIndex. Patch needs it: edits arrive as byte ranges but the splice happens on the
// JS string, so that bytes outside the edited range are never re-encoded.
export function codeUnitIndex(text, bytePos) {
  const table = byteTable(text);
  let low = 0;
  let high = table.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (table[mid] <= bytePos) low = mid;
    else high = mid - 1;
  }
  if (table[low] !== bytePos) {
    throw new RangeError(`byte offset ${bytePos} is not a UTF-8 character boundary in this text`);
  }
  return low;
}

export function spanAt(offsets, table, cuStart, cuEnd) {
  return {
    byte_start: table[cuStart],
    byte_end: table[cuEnd],
    line_start: lineAt(offsets, cuStart),
    line_end: lineAt(offsets, Math.max(cuStart, cuEnd - 1)),
  };
}

// The per-parse bundle: one line table and one byte table, built once and closed over.
export function positions(text) {
  const offsets = lineOffsets(text);
  const table = byteTable(text);
  return {
    text,
    offsets,
    table,
    span(cuStart, cuEnd) {
      return spanAt(offsets, table, cuStart, cuEnd);
    },
  };
}

// The one write path for an existing file (manifest §2.3): splice raw text over byte ranges,
// right to left so earlier offsets stay valid. resolveSpans is lazy — a patch with no key_path
// edit never parses, so an unparseable file can still be patched by span.
export function applyEdits(text, edits, resolveSpans) {
  if (!Array.isArray(edits)) throw new TypeError("patch expects an array of edits");
  if (edits.length === 0) return text;

  let spans = null;
  const resolved = edits.map((edit, index) => {
    if (!edit || typeof edit !== "object") throw new Error(`edit ${index} is not an object`);
    if (typeof edit.replacement !== "string") {
      throw new Error(`edit ${index} needs a string replacement`);
    }
    let span = edit.span;
    if (!span) {
      if (typeof edit.key_path !== "string") {
        throw new Error(`edit ${index} needs either a key_path or a span`);
      }
      if (spans === null) spans = resolveSpans();
      span = spans[edit.key_path];
      if (!span) throw new Error(`unknown key_path "${edit.key_path}"`);
    }
    const start = span.byte_start;
    const end = span.byte_end;
    if (!Number.isInteger(start) || !Number.isInteger(end)) {
      throw new Error(`edit ${index} has a span without integer byte offsets`);
    }
    if (end < start) throw new Error(`edit ${index} has byte_end before byte_start`);
    return { start, end, replacement: edit.replacement, index };
  });

  resolved.sort((a, b) => a.start - b.start || a.end - b.end);
  for (let n = 1; n < resolved.length; n += 1) {
    const previous = resolved[n - 1];
    const next = resolved[n];
    const overlaps = next.start < previous.end;
    // Two zero-length edits at the same offset do not overlap arithmetically, but their order is
    // undefined, so they are rejected rather than silently ordered.
    const ambiguous = next.start === previous.start && next.end === previous.end;
    if (overlaps || ambiguous) {
      throw new Error(
        `overlapping edits: bytes ${previous.start}-${previous.end} and ${next.start}-${next.end}`,
      );
    }
  }

  const pieces = [];
  let cursor = text.length;
  for (let n = resolved.length - 1; n >= 0; n -= 1) {
    const cuStart = codeUnitIndex(text, resolved[n].start);
    const cuEnd = codeUnitIndex(text, resolved[n].end);
    pieces.push(text.slice(cuEnd, cursor));
    pieces.push(resolved[n].replacement);
    cursor = cuStart;
  }
  pieces.push(text.slice(0, cursor));
  return pieces.reverse().join("");
}

// Assigning a parsed key straight onto a plain object lets a file containing "__proto__" mutate
// the prototype chain of everything downstream.
export function setKey(target, key, value) {
  if (key === "__proto__") {
    Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
    return;
  }
  target[key] = value;
}
