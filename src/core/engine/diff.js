// Unified diff over lines, and the key-level diff for an embedded write.
//
// The plan's accuracy is a security property (THR T-I13): the diff IS the consent
// mechanism, so it renders the bytes that will actually be written, computed from the same
// text the writer will produce — never from a summary of it.
//
// Myers is overkill here; the classic LCS table is exact, short, and bounded by a cap
// after which the diff degrades to a whole-file replacement rather than a wrong hunk.

const MAX_LCS_CELLS = 4_000_000;

export function unifiedDiff({ before, after, fromLabel = "current", toLabel = "after import", context = 3 }) {
  const a = splitLines(before ?? "");
  const b = splitLines(after ?? "");
  if (before === after) return null;
  const hunks =
    a.length * b.length > MAX_LCS_CELLS
      ? [wholeFile(a, b)]
      : groupHunks(script(a, b), a.length, b.length, context);
  if (hunks.length === 0) return null;
  const lines = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const hunk of hunks) {
    lines.push(
      `@@ -${hunk.a_start + 1},${hunk.a_count} +${hunk.b_start + 1},${hunk.b_count} @@`,
      ...hunk.lines,
    );
  }
  return `${lines.join("\n")}\n`;
}

export function splitLines(text) {
  const value = String(text ?? "");
  if (value.length === 0) return [];
  const lines = value.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function wholeFile(a, b) {
  return {
    a_start: 0,
    a_count: a.length,
    b_start: 0,
    b_count: b.length,
    lines: [...a.map((line) => `-${line}`), ...b.map((line) => `+${line}`)],
  };
}

/** The edit script as a flat list of {op, line, a_index, b_index}. */
function script(a, b) {
  const table = [];
  for (let i = 0; i <= a.length; i += 1) table.push(new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ op: " ", line: a[i], a_index: i, b_index: j });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      out.push({ op: "-", line: a[i], a_index: i, b_index: j });
      i += 1;
    } else {
      out.push({ op: "+", line: b[j], a_index: i, b_index: j });
      j += 1;
    }
  }
  while (i < a.length) {
    out.push({ op: "-", line: a[i], a_index: i, b_index: j });
    i += 1;
  }
  while (j < b.length) {
    out.push({ op: "+", line: b[j], a_index: i, b_index: j });
    j += 1;
  }
  return out;
}

function groupHunks(edits, aLength, bLength, context) {
  const changed = edits.map((edit) => edit.op !== " ");
  const hunks = [];
  let cursor = 0;
  while (cursor < edits.length) {
    if (!changed[cursor]) {
      cursor += 1;
      continue;
    }
    let start = cursor;
    let end = cursor;
    while (end < edits.length) {
      if (changed[end]) {
        cursor = end;
        end += 1;
        continue;
      }
      // Keep walking while another change is within 2*context lines, so neighbouring edits
      // land in one hunk instead of two overlapping ones.
      let lookahead = end;
      while (lookahead < edits.length && !changed[lookahead] && lookahead - cursor <= context * 2) lookahead += 1;
      if (lookahead < edits.length && changed[lookahead]) {
        end = lookahead;
        continue;
      }
      break;
    }
    const from = Math.max(0, start - context);
    const to = Math.min(edits.length, end + context);
    const slice = edits.slice(from, to);
    const aStart = slice.find((edit) => edit.op !== "+")?.a_index ?? aLength;
    const bStart = slice.find((edit) => edit.op !== "-")?.b_index ?? bLength;
    hunks.push({
      a_start: aStart,
      a_count: slice.filter((edit) => edit.op !== "+").length,
      b_start: bStart,
      b_count: slice.filter((edit) => edit.op !== "-").length,
      lines: slice.map((edit) => `${edit.op}${edit.line}`),
    });
    cursor = to;
  }
  return hunks;
}

/**
 * The key-level view of an embedded write. `from: undefined` means the key does not exist
 * on the target, which is the difference between "this changes your setting" and "this
 * adds one" — the two most important sentences in the whole preview.
 */
export function keyDiff({ keyPath, from, to }) {
  return [
    {
      key_path: keyPath,
      from: from === undefined ? null : from,
      to,
      change: from === undefined ? "add" : "replace",
    },
  ];
}
