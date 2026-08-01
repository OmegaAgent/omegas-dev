// The shared format registry, keyed by the surface descriptor's `format` field
// (adapter-architecture §1.4). Parsers are never per-adapter: an adapter declares a format name,
// the engine looks it up here, and every entry answers the same four exports.

import * as dotenv from "./dotenv.js";
import * as json from "./json.js";
import * as jsonc from "./jsonc.js";
import * as mdFrontmatter from "./md-frontmatter.js";
import * as starlark from "./starlark.js";
import * as toml from "./toml.js";
import { applyEdits } from "./spans.js";

// A file the engine must carry without understanding it: a binary blob, a lockfile, anything a
// descriptor marks unparseable. It answers the contract with empty structure so the engine has no
// special case, and it can still be patched by explicit span.
const opaque = {
  id: "opaque",
  parse() {
    return { value: null, key_order: {}, spans: {} };
  },
  patch(text, edits) {
    return applyEdits(text, edits, () => ({}));
  },
  serialize(value) {
    return typeof value === "string" ? value : "";
  },
};

export const FORMATS = {
  json,
  jsonc,
  toml,
  "md+frontmatter": mdFrontmatter,
  md: mdFrontmatter.md,
  dotenv,
  starlark,
  opaque,
  binary: { ...opaque, id: "binary" },
};

export function formatFor(name) {
  const format = Object.hasOwn(FORMATS, name) ? FORMATS[name] : undefined;
  if (!format) {
    throw new Error(
      `no parser registered for format "${name}" (known: ${Object.keys(FORMATS).join(", ")})`,
    );
  }
  return format;
}

export { dotenv, json, jsonc, mdFrontmatter, toml };
