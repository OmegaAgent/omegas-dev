// Manifest §5.4 — the exclusion list is not code, it is a rule table declared by each
// adapter plus the runtime-agnostic rows in caps.js. This module only MATCHES rules and
// counts hits. Every rule that fires produces a visible `exclusions[]` record:
// deliberate absence is data, and silence is the bug (THR §4.2 Gap 4).

import { expandTemplate, globMatch, isUnresolved, matchesPrefix, toPosix } from "../fsx/paths.js";
import { GLOBAL_NEVER_EXPORT } from "./caps.js";

/**
 * `severity` decides whether a declared surface may still reach the path:
 *   hard — never, no override. The file is not opened at all…
 *   …except when `class` is `secret_sink`, which is SCAN-AND-REFUSE: the structure is
 *   reported so the user learns what exists, and the bytes never leave (COD §5.1).
 *   soft — the sweep reports it, but a surface that explicitly declares the path still
 *   reads it. This is what lets a plugin skill be scanned while the plugin cache as a
 *   whole stays out of the bundle.
 */
export function rulesFor(adapter, vars) {
  const declared = [...(adapter?.never_export ?? []), ...GLOBAL_NEVER_EXPORT];
  return declared.map((rule) => {
    const [pathPart, keyPart = null] = String(rule.match).split("#");
    return {
      rule,
      path: expandTemplate(pathPart, vars),
      key_prefix: keyPart,
      scan_and_refuse: rule.class === "secret_sink",
      blocks_declared_surface: rule.severity === "hard" && rule.class !== "secret_sink",
    };
  });
}

/**
 * Not a path rule, and deliberately not in the declared table: every rule above matches a
 * NAME, and a hard link gives one inode a second name. A regular file with more than one
 * link inside a scanned root may therefore BE a never-export sink under a name the table
 * cannot recognize, and nothing the reader can see from here distinguishes the two.
 *
 * Treated as a `secret_sink` rather than a hard refusal, which is the same answer the
 * table gives for a file whose shape is worth reporting and whose bytes are not: the
 * structure is described, the bytes are dropped, and the refusal is a visible record.
 */
export const MULTIPLE_LINK_RULE = {
  rule_id: "global.multiple_hard_links",
  class: "secret_sink",
  severity: "hard",
  reason:
    "this file has more than one name on disk, so a never-export rule may match its other name; its structure is reported and its bytes are not carried",
};

export function fileRules(rules) {
  return rules.filter((entry) => entry.key_prefix === null && !isUnresolved(entry.path));
}

export function embeddedRules(rules) {
  return rules.filter((entry) => entry.key_prefix !== null && !isUnresolved(entry.path));
}

export function matchFileRule(rules, absPath) {
  const candidate = toPosix(absPath);
  return rules.find((entry) => candidate === toPosix(entry.path) || globMatch(entry.path, candidate)) ?? null;
}

export function matchEmbeddedRule(rules, sourcePath, keyPath) {
  const candidate = toPosix(sourcePath);
  return (
    rules.find(
      (entry) =>
        (toPosix(entry.path) === candidate || globMatch(entry.path, candidate)) &&
        matchesPrefix(entry.key_prefix, keyPath),
    ) ?? null
  );
}

/**
 * The ledger. Counts carry a UNIT (spike-corrections, modelling note 3): whole files are
 * counted in `files`, embedded key subtrees in `keys`, because a rule matching
 * `config.toml#hooks.state` has no natural file count and a number without a unit is
 * a number a user cannot check.
 */
export class ExclusionLedger {
  constructor() {
    this.byRule = new Map();
  }

  record(rule, { label, bytes = 0, count = 1, unit = "files", note = null } = {}) {
    const existing = this.byRule.get(rule.rule_id) ?? {
      rule_id: rule.rule_id,
      class: rule.class,
      severity: rule.severity,
      reason: rule.reason,
      matched: 0,
      unit,
      bytes_skipped: 0,
      label,
      note,
    };
    existing.matched += count;
    existing.bytes_skipped += bytes;
    if (existing.unit !== unit) existing.unit = "mixed";
    if (note && !existing.note) existing.note = note;
    if (label && existing.label !== label) existing.label = commonLabel(existing.label, label);
    this.byRule.set(rule.rule_id, existing);
    return existing;
  }

  list() {
    return [...this.byRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
  }
}

// Two hits under one rule collapse to the directory they share, so the label stays a
// location the reader recognizes without listing every path.
function commonLabel(a, b) {
  if (!a) return b;
  const left = a.split("/");
  const right = b.split("/");
  const shared = [];
  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    if (left[i] !== right[i]) break;
    shared.push(left[i]);
  }
  return shared.length > 0 ? `${shared.join("/")}/…` : a;
}
