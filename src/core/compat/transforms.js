// The transform table, ASSEMBLED — not re-typed.
//
// A TransformDescriptor is a relation between two runtimes, and every one of them is
// already declared as data on the adapter that owns the source side (adapter-architecture
// §1.1 "adapters declare, the engine executes"; §3.1 "A TransformDescriptor is also
// data"). Re-listing them here would create a second copy that drifts from the first,
// which is the exact failure the derived matrix exists to prevent — and the adapter
// registry already refuses a descriptor with no evidence citation, so the declarations
// are the checked copy.
//
// What this module contributes on top of those declarations is the machinery §3.1 names
// but does not locate:
//
//   transformFor()   the (kind, source runtime, target runtime) lookup fidelity() performs
//   itemExceptionOf()the per-ITEM exception check — `applies(x, i)` in the §3.1 pseudocode
//   unexpressible()  what the TARGET FORMAT can physically hold, which is what turns an
//                    item's `unrecognized` bag into listed losses without anyone declaring
//                    them one by one
//
// Nothing here knows a runtime name. Every runtime-specific fact arrives as data.

/**
 * The closed operator set for a per-item exception. Closed for the same reason the lint
 * operator set is closed (§1.5): a predicate the engine cannot enumerate is a callback
 * smuggled into a data file.
 */
export const ITEM_EXCEPTION_OPS = ["value_in", "value_not_in", "has_key", "missing_key"];

/**
 * What a format can physically hold at a leaf position. This is the input to
 * `unexpressible()`, and it is deliberately conservative: only differences that are
 * genuine spec-level limits are listed, because a false loss is as dishonest as a hidden
 * one. Each entry says why in `limits`, and that string is what the user reads.
 */
export const FORMAT_CAPACITY = {
  json: { null: true, nested: true, arrays: true, limits: [] },
  jsonc: { null: true, nested: true, arrays: true, limits: [] },
  jsonl: { null: true, nested: true, arrays: true, limits: [] },
  yaml: { null: true, nested: true, arrays: true, limits: [] },
  "md+frontmatter": {
    null: true,
    nested: true,
    arrays: true,
    limits: [],
    note: "the frontmatter block is YAML, so a structured key survives the move",
  },
  toml: {
    null: false,
    nested: true,
    arrays: true,
    limits: ["TOML v1.0.0 defines no null type, so a null-valued key has no representation and is dropped"],
  },
  md: {
    null: false,
    nested: false,
    arrays: false,
    limits: ["a plain markdown file is prose: a structured key has nowhere to live in it"],
  },
  dotenv: {
    null: false,
    nested: false,
    arrays: false,
    limits: ["dotenv holds flat KEY=value strings only; a nested object or list has no representation"],
  },
  starlark: {
    null: false,
    nested: false,
    arrays: false,
    limits: ["Continuity parses Starlark read-only and never writes it, so nothing can be expressed into it"],
  },
  binary: {
    null: false,
    nested: false,
    arrays: false,
    limits: ["an opaque file carries bytes, not keys"],
  },
  none: { null: false, nested: false, arrays: false, limits: ["this surface is never written"] },
};

/** Every transform either runtime declares, in declaration order. */
export function transformsOf(profiles) {
  return profiles.flatMap((profile) => profile.transforms ?? []);
}

/**
 * §3.1: `transforms.find(x => x.kind === K && x.from.runtime === S.id && x.to.runtime === T.id)`.
 * The surface ids on a descriptor name the DEFAULT pair; they are not part of the match,
 * because the verdict is a property of the kind and the two runtimes.
 */
export function transformFor({ kind, from, to, transforms }) {
  return transforms.find((entry) => entry.kind === kind && entry.from?.runtime === from && entry.to?.runtime === to) ?? null;
}

/**
 * `applies(x, i)` from the §3.1 pseudocode, inverted so the REASON survives: a transform
 * does not apply to an item that trips one of its declared exceptions, and the exception
 * carries its own verdict and citation. Returning the exception rather than a boolean is
 * what lets the UI say "this one entry, because its transport is ws" instead of silently
 * degrading the whole kind.
 */
export function itemExceptionOf(transform, item) {
  if (!transform || !item) return null;
  for (const exception of transform.item_exceptions ?? []) {
    if (predicateHolds(exception.when, item)) return exception;
  }
  return null;
}

function predicateHolds(when, item) {
  if (!when || !ITEM_EXCEPTION_OPS.includes(when.op)) return false;
  const value = readPath(item, when.at);
  if (when.op === "value_in") return when.values.includes(value);
  if (when.op === "value_not_in") return value !== undefined && !when.values.includes(value);
  if (when.op === "has_key") return value !== undefined;
  return value === undefined;
}

function readPath(root, dotted) {
  let node = root;
  for (const step of String(dotted ?? "").split(".")) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = node[step];
  }
  return node;
}

/**
 * §3.1 property 2 — computed, never declared. A key in the item's `unrecognized` bag is a
 * key neither side's descriptor set knows about; whether it SURVIVES the move is a
 * question about the target format, not about anyone's opinion. Deriving it here is what
 * stops the matrix drifting as the runtimes add keys.
 *
 * Returns one record per unexpressible key, with the reason, so CONVERT can always list
 * its losses.
 */
export function unexpressible(unrecognized, format) {
  const capacity = FORMAT_CAPACITY[format];
  if (!capacity || !unrecognized || typeof unrecognized !== "object") return [];
  const losses = [];
  const walk = (node, at) => {
    if (node === null) {
      if (!capacity.null) losses.push(loss(at, "null", format, capacity));
      return;
    }
    if (Array.isArray(node)) {
      if (!capacity.arrays) losses.push(loss(at, "list", format, capacity));
      else for (const [index, entry] of node.entries()) walk(entry, `${at}[${index}]`);
      return;
    }
    if (typeof node === "object") {
      if (!capacity.nested) losses.push(loss(at, "object", format, capacity));
      else for (const [key, value] of Object.entries(node)) walk(value, `${at}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(unrecognized)) walk(value, key);
  return losses;
}

function loss(keyPath, shape, format, capacity) {
  return {
    key_path: keyPath,
    value_shape: shape,
    target_format: format,
    reason: capacity.limits[0] ?? `${format} cannot hold a ${shape} value`,
    derived: true,
  };
}
