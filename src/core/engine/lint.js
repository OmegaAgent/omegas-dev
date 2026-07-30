// adapter-architecture §1.5 — lints are declarative rules with a CLOSED operator set.
// A lint that needs a new operator gets the operator added HERE, which is the correct
// place for logic, rather than a callback smuggled into an adapter.
//
// Findings are data in the bundle, because "your config has a detectable problem" is a
// large part of the product's legible value and it has to survive being shared.

import { enumerateStringLeaves } from "./normalize.js";

const OPERATORS = {
  has_key: (ctx, rule) => isObject(subject(ctx, rule)) && hasOwn(subject(ctx, rule), rule.key),
  missing_key: (ctx, rule) => !(isObject(subject(ctx, rule)) && hasOwn(subject(ctx, rule), rule.key)),

  matches: (ctx, rule) => anyLeaf(subject(ctx, rule), (leaf) => new RegExp(rule.pattern).test(leaf)),
  not_matches: (ctx, rule) => !anyLeaf(subject(ctx, rule), (leaf) => new RegExp(rule.pattern).test(leaf)),

  path_is_absolute: (ctx, rule) => anyLeaf(subject(ctx, rule), (leaf) => /^(\/|[A-Za-z]:\\)/.test(leaf.trim())),

  // An absolute path the scanner probed and did not find. This is what turns a stale
  // permission rule pointing at a deleted worktree into a reported condition.
  references_missing_path: (ctx, rule) =>
    anyLeaf(subject(ctx, rule), (leaf) =>
      [...pathsIn(leaf)].some((candidate) => ctx.probes.get(candidate) === false),
    ),

  value_in: (ctx, rule) => anyLeaf(subject(ctx, rule), (leaf) => (rule.values ?? []).includes(leaf)),
  value_not_in: (ctx, rule) => anyLeaf(subject(ctx, rule), (leaf) => !(rule.values ?? []).includes(leaf)),

  count_gt: (ctx, rule) => {
    const value = subject(ctx, rule);
    const size = Array.isArray(value) ? value.length : isObject(value) ? Object.keys(value).length : 0;
    return size > rule.value;
  },

  sibling_exists: (ctx, rule) => ctx.siblings(rule).length > 0,

  edge_present: (ctx, rule) => edges(ctx, rule).length > 0,
  edge_absent: (ctx, rule) => edges(ctx, rule).length === 0,

  and: (ctx, rule) => (rule.rules ?? []).every((inner) => evaluate(ctx, inner)),
  or: (ctx, rule) => (rule.rules ?? []).some((inner) => evaluate(ctx, inner)),
  not: (ctx, rule) => !evaluate(ctx, rule.rule),
};

export const LINT_OPERATORS = Object.keys(OPERATORS);

export function lint({ adapters, items, probes = new Map() }) {
  const findings = [];
  let counter = 0;

  for (const adapter of adapters) {
    for (const rule of adapter.lints ?? []) {
      const runtime = rule.applies_to?.runtime ?? adapter.id;
      const kind = rule.applies_to?.kind ?? "*";
      for (const item of items) {
        if (runtime !== "*" && item.runtime !== runtime) continue;
        if (kind !== "*" && item.kind !== kind) continue;
        if (rule.applies_to?.name && item.name !== rule.applies_to.name) continue;
        if (rule.applies_to?.surface_id && item.surface_id !== rule.applies_to.surface_id) continue;
        const ctx = context(item, items, probes);
        if (!evaluate(ctx, rule.predicate)) continue;
        counter += 1;
        findings.push({
          finding_id: `f${counter}`,
          rule: rule.lint_id,
          severity: rule.severity,
          item_id: item.item_id,
          project_id: item.project_id ?? null,
          message: rule.message,
          evidence: rule.evidence ?? null,
          suggested_fix: rule.suggested_fix ?? null,
          auto_fixable: rule.auto_fixable ?? false,
        });
      }
    }
  }

  return findings.concat(refusalFindings(items, findings.length));
}

function evaluate(ctx, rule) {
  const operator = OPERATORS[rule?.op];
  if (!operator) throw new Error(`unknown lint operator "${rule?.op}"`);
  return operator(ctx, rule);
}

function context(item, items, probes) {
  return {
    item,
    items,
    probes,
    siblings: (rule) =>
      items.filter(
        (candidate) =>
          candidate !== item &&
          (!rule.kind || candidate.kind === rule.kind) &&
          (!rule.runtime || candidate.runtime === rule.runtime) &&
          (!rule.name || candidate.name === rule.name) &&
          (rule.scope !== "same" || sameScope(candidate, item)),
      ),
  };
}

function sameScope(a, b) {
  return a.scope === b.scope && (a.project_id ?? null) === (b.project_id ?? null);
}

function edges(ctx, rule) {
  return (ctx.item.related ?? []).filter(
    (edge) =>
      (!rule.rel || edge.rel === rule.rel) &&
      (!rule.target_name ||
        String(edge.item_id ?? edge.external ?? "").includes(rule.target_name)),
  );
}

function subject(ctx, rule) {
  if (!rule.in) return ctx.item;
  return String(rule.in)
    .split(".")
    .reduce((node, key) => (node === null || node === undefined ? node : node[key]), ctx.item);
}

function anyLeaf(value, predicate) {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return predicate(value);
  for (const [, leaf] of enumerateStringLeaves(value, "")) {
    if (predicate(leaf)) return true;
  }
  return false;
}

function* pathsIn(text) {
  for (const [, candidate] of String(text).matchAll(
    /(?:^|["'`\s=(:,])(\/(?:Users|home|opt|usr|etc|var|private)\/[^\s"'`,;)\]]*)/g,
  )) {
    yield candidate;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Refusals are findings too. A refused symlink is a reported condition, not an absence:
 * on the surveyed machine this is the difference between "0 Codex skills" and 61
 * visible, correctly-explained nodes (THR §2.1, §4.2 Gap 4).
 */
function refusalFindings(items, startIndex) {
  const out = [];
  const unresolved = items.filter((item) => item.kind === "unresolved_link");
  if (unresolved.length > 0) {
    out.push({
      finding_id: `f${startIndex + out.length + 1}`,
      rule: "link.unresolved",
      severity: "warn",
      item_id: null,
      project_id: null,
      message: `${unresolved.length} entr${unresolved.length === 1 ? "y" : "ies"} resolve outside every declared root; each is listed as an unresolved_link node rather than silently skipped`,
      evidence: "THR §3.1 / §4.2 Gap 4",
      suggested_fix: null,
      auto_fixable: false,
    });
  }
  const opaque = items.filter((item) => item.kind === "opaque");
  if (opaque.length > 0) {
    out.push({
      finding_id: `f${startIndex + out.length + 1}`,
      rule: "parse.opaque",
      severity: "warn",
      item_id: null,
      project_id: null,
      message: `${opaque.length} file${opaque.length === 1 ? "" : "s"} matched a surface but could not be parsed; carried as opaque with raw bytes intact`,
      evidence: "manifest §1.2 — `opaque` exists so an unknown is first-class data",
      suggested_fix: null,
      auto_fixable: false,
    });
  }
  return out;
}
