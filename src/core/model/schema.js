// A hand-rolled declarative validator. Not zod, not ajv — zero runtime dependencies is
// a trust asset for this package (INV §7), and JSON Schema's `type` assumptions cannot
// model the union this domain actually has: Codex `approval_policy` is a string OR a
// table (COD §4.9). Union is a first-class combinator here.

import {
  ALGEBRAS,
  CANONICAL_KINDS,
  FORMATS,
  PORTABILITY_VERDICTS,
  SCOPES,
  SEVERITIES,
  TRUST_TIERS,
} from "./kinds.js";

export const t = {
  string: (options = {}) => ({ type: "string", ...options }),
  number: (options = {}) => ({ type: "number", ...options }),
  boolean: () => ({ type: "boolean" }),
  literal: (value) => ({ type: "literal", value }),
  enum: (values) => ({ type: "enum", values }),
  array: (item, options = {}) => ({ type: "array", item, ...options }),
  object: (shape, options = {}) => ({ type: "object", shape, ...options }),
  record: (value) => ({ type: "record", value }),
  union: (...variants) => ({ type: "union", variants }),
  nullable: (inner) => ({ type: "union", variants: [inner, { type: "null" }] }),
  optional: (inner) => ({ type: "optional", inner }),
  any: () => ({ type: "any" }),
  null: () => ({ type: "null" }),
};

export function validate(schema, value, pathLabel = "$") {
  const problems = [];
  check(schema, value, pathLabel, problems);
  return problems;
}

export function assertValid(schema, value, label = "value") {
  const problems = validate(schema, value, label);
  if (problems.length > 0) {
    throw new TypeError(`${label} failed validation:\n  ${problems.join("\n  ")}`);
  }
  return value;
}

function check(schema, value, at, problems) {
  switch (schema.type) {
    case "any":
      return;
    case "null":
      if (value !== null) problems.push(`${at}: expected null`);
      return;
    case "optional":
      if (value === undefined) return;
      check(schema.inner, value, at, problems);
      return;
    case "literal":
      if (value !== schema.value) problems.push(`${at}: expected ${JSON.stringify(schema.value)}`);
      return;
    case "enum":
      if (!schema.values.includes(value)) {
        problems.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.values.join(", ")}`);
      }
      return;
    case "string":
      if (typeof value !== "string") problems.push(`${at}: expected a string`);
      else if (schema.nonEmpty && value.length === 0) problems.push(`${at}: expected a non-empty string`);
      else if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
        problems.push(`${at}: does not match ${schema.pattern}`);
      }
      return;
    case "number":
      if (typeof value !== "number" || Number.isNaN(value)) problems.push(`${at}: expected a number`);
      return;
    case "boolean":
      if (typeof value !== "boolean") problems.push(`${at}: expected a boolean`);
      return;
    case "array": {
      if (!Array.isArray(value)) {
        problems.push(`${at}: expected an array`);
        return;
      }
      if (schema.nonEmpty && value.length === 0) problems.push(`${at}: expected a non-empty array`);
      value.forEach((entry, index) => check(schema.item, entry, `${at}[${index}]`, problems));
      return;
    }
    case "record": {
      if (!isPlainObject(value)) {
        problems.push(`${at}: expected an object`);
        return;
      }
      for (const [key, entry] of Object.entries(value)) check(schema.value, entry, `${at}.${key}`, problems);
      return;
    }
    case "object": {
      if (!isPlainObject(value)) {
        problems.push(`${at}: expected an object`);
        return;
      }
      for (const [key, inner] of Object.entries(schema.shape)) {
        const present = Object.prototype.hasOwnProperty.call(value, key);
        if (!present) {
          if (inner.type !== "optional") problems.push(`${at}.${key}: required`);
          continue;
        }
        check(inner, value[key], `${at}.${key}`, problems);
      }
      if (schema.exact) {
        for (const key of Object.keys(value)) {
          if (!Object.prototype.hasOwnProperty.call(schema.shape, key)) problems.push(`${at}.${key}: unexpected key`);
        }
      }
      return;
    }
    case "union": {
      const attempts = schema.variants.map((variant) => validate(variant, value, at));
      if (attempts.some((found) => found.length === 0)) return;
      problems.push(`${at}: matched none of ${schema.variants.length} variants (${attempts[0][0] ?? "no detail"})`);
      return;
    }
    default:
      problems.push(`${at}: unknown schema type ${schema.type}`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ── the shapes this milestone validates ─────────────────────────────────────────────

export const SpanSchema = t.object({
  byte_start: t.number(),
  byte_end: t.number(),
  line_start: t.number(),
  line_end: t.number(),
});

export const OriginSchema = t.object({
  path: t.string({ nonEmpty: true }),
  display_path: t.string({ nonEmpty: true }),
  key_path: t.nullable(t.string()),
  span: t.nullable(SpanSchema),
  link: t.nullable(t.record(t.any())),
});

export const PayloadSchema = t.object({
  format: t.enum(FORMATS),
  raw: t.nullable(t.record(t.any())),
  parsed: t.nullable(t.record(t.any())),
  recognized: t.record(t.any()),
  unrecognized: t.record(t.any()),
  parse_error: t.optional(t.string()),
  truncated: t.optional(t.boolean()),
});

export const ItemSchema = t.object({
  item_id: t.string({ nonEmpty: true }),
  kind: t.enum(CANONICAL_KINDS),
  runtime: t.string({ nonEmpty: true }),
  surface_id: t.string({ nonEmpty: true }),
  scope: t.enum(SCOPES),
  layer_id: t.string({ nonEmpty: true }),
  project_id: t.nullable(t.string()),
  name: t.string(),
  identity: t.object({
    from: t.string(),
    value: t.string(),
    stable_across_runs: t.boolean(),
    stable_across_machines: t.boolean(),
    note: t.optional(t.string()),
  }),
  origin: OriginSchema,
  payload: t.nullable(PayloadSchema),
  assets: t.array(t.any()),
  portability: t.object({
    verdict: t.enum(PORTABILITY_VERDICTS),
    reasons: t.array(t.string()),
    rewrites: t.array(t.any()),
  }),
  trust_tier: t.enum(Object.keys(TRUST_TIERS)),
  authority: t.optional(t.literal(true)),
  applied: t.boolean(),
  applied_reason: t.optional(t.string()),
  export_refused: t.optional(t.literal(true)),
  export_refused_by: t.optional(t.string()),
  content_id: t.nullable(t.string()),
  redaction_refs: t.array(t.string()),
  related: t.array(t.any()),
});

export const LayerSchema = t.object({
  layer_id: t.string({ nonEmpty: true }),
  runtime: t.string(),
  scope: t.enum(SCOPES),
  rank: t.number(),
  source_label: t.nullable(t.string()),
  present: t.boolean(),
  suppressed_by: t.optional(t.nullable(t.string())),
});

export const EffectiveSchema = t.object({
  surface_id: t.string(),
  runtime: t.string(),
  key: t.union(t.string(), t.number(), t.boolean(), t.null()),
  algebra: t.enum(ALGEBRAS),
  value: t.any(),
  winner: t.nullable(t.string()),
  contributors: t.array(
    t.object({
      item_id: t.string(),
      layer_id: t.string(),
      rank: t.number(),
      applied: t.boolean(),
      reason: t.nullable(t.string()),
      order_index: t.optional(t.number()),
    }),
  ),
  note: t.nullable(t.string()),
});

export const FindingSchema = t.object({
  finding_id: t.string(),
  rule: t.string(),
  severity: t.enum(SEVERITIES),
  item_id: t.nullable(t.string()),
  project_id: t.optional(t.nullable(t.string())),
  message: t.string({ nonEmpty: true }),
  evidence: t.optional(t.any()),
  suggested_fix: t.optional(t.nullable(t.string())),
  auto_fixable: t.boolean(),
});

export const ExclusionSchema = t.object({
  rule_id: t.string(),
  class: t.string(),
  severity: t.string(),
  reason: t.string(),
  matched: t.number(),
  unit: t.enum(["files", "keys", "mixed"]),
  bytes_skipped: t.number(),
  label: t.nullable(t.string()),
  note: t.nullable(t.string()),
});

export const TruncationSchema = t.object({
  path: t.string(),
  display_path: t.string(),
  surface_id: t.string(),
  bytes: t.number(),
  kept_bytes: t.number(),
  cap: t.number(),
  reason: t.string(),
});

export const ScanResultSchema = t.object({
  items: t.array(ItemSchema),
  layers: t.array(LayerSchema),
  effective: t.array(EffectiveSchema),
  findings: t.array(FindingSchema),
  exclusions: t.array(ExclusionSchema),
  truncations: t.array(TruncationSchema),
  runtimes: t.array(t.any()),
  projects: t.array(t.any()),
});
