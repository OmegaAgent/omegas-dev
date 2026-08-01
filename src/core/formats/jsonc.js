// JSON with // and /* */ comments and tolerated trailing commas — the shape VS Code-family and
// several agent runtimes accept. Comments never reach `value`; they survive because the write path
// is patch on the original bytes, never a re-serialize (manifest §2.3).

import { createJsonParser, serialize as serializeJson } from "./json.js";
import { applyEdits } from "./spans.js";

export const id = "jsonc";

export const parse = createJsonParser({ comments: true, trailingCommas: true });

export function patch(text, edits) {
  return applyEdits(text, edits, () => parse(text).spans);
}

// A newly created file gets no comments; there is nothing to preserve yet.
export function serialize(value, keyOrder) {
  return serializeJson(value, keyOrder);
}
