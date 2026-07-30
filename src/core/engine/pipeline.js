// The orchestration, in order. Read-only in M1: scan → normalize → derive → effective
// → lint. Redaction lands between normalize and effective in M2, because an effective
// row keyed by a permission-rule string would otherwise carry an unredacted value into
// the bundle even though the item itself was redacted (spike-corrections §4).

import { lstatOrNull } from "../fsx/safe-read.js";
import { computeEffective } from "./effective.js";
import { lint } from "./lint.js";
import {
  absolutePathCandidates,
  deriveEdges,
  derivePortability,
  finalizeContentIds,
  normalize,
} from "./normalize.js";
import { scan, scanDerived } from "./scan.js";

const MAX_PROBES = 2000;

export async function runScan({ adapters, env }) {
  const scanResult = await scan({ adapters, env });
  const first = normalize({ adapters, env, scanResult });

  // Surfaces derived from another surface's items — a hook's script — need the items to
  // exist first, so they are a second pass over the same generic machinery.
  const derived = await scanDerived({ adapters, env, items: first.items });
  const second = normalize({
    adapters,
    env,
    scanResult: { files: derived.files, links: [], sources: [] },
    existing: first.state,
  });

  const items = second.items;
  const probes = await probePaths(items);
  deriveEdges({ items, env, probes });
  derivePortability(items);
  finalizeContentIds(items);

  const layers = second.layers;
  const effective = computeEffective({ items, layers });
  const findings = lint({ adapters, items, probes });

  return {
    items,
    layers,
    effective,
    findings,
    exclusions: mergeExclusions([
      scanResult.exclusions.list(),
      derived.exclusions.list(),
      first.exclusions,
      second.exclusions,
    ]),
    truncations: [...scanResult.truncations, ...derived.truncations],
    runtimes: scanResult.runtimes,
    projects: env.projects.map((project) => ({
      project_id: project.project_id,
      identity: project.identity,
      label: project.label,
      vcs: project.vcs ? { kind: project.vcs.kind, remote: project.vcs.remote, subpath: project.vcs.subpath } : null,
    })),
    unresolved_links: items.filter((item) => item.kind === "unresolved_link").length,
    complete: scanResult.truncations.length === 0,
  };
}

/**
 * One bounded existence sweep so the lints can tell a live path from a dead one. This
 * is `lstat` only — nothing is opened, nothing is read — and the results stay local.
 */
async function probePaths(items) {
  const probes = new Map();
  for (const candidate of absolutePathCandidates(items)) {
    if (probes.size >= MAX_PROBES) break;
    if (probes.has(candidate)) continue;
    probes.set(candidate, (await lstatOrNull(candidate)) !== null);
  }
  return probes;
}

function mergeExclusions(lists) {
  const byRule = new Map();
  for (const list of lists) {
    for (const record of list) {
      const existing = byRule.get(record.rule_id);
      if (!existing) {
        byRule.set(record.rule_id, { ...record });
        continue;
      }
      existing.matched += record.matched;
      existing.bytes_skipped += record.bytes_skipped;
      if (existing.unit !== record.unit) existing.unit = "mixed";
      if (!existing.note && record.note) existing.note = record.note;
    }
  }
  return [...byRule.values()].sort((a, b) => a.rule_id.localeCompare(b.rule_id));
}
