// The orchestration, in order: scan → normalize → derive → REDACT → effective → lint.
// Redaction sits before the effective table because an effective row keyed by a
// permission-rule string would otherwise carry an unredacted value into the bundle even
// though the item itself was redacted (spike-corrections §4), and before content ids
// because a content id must address the bytes the bundle actually carries.
//
// It is not optional and there is no flag: every consumer — the terse scan, the report,
// the exporter — reads the redacted model, so the raw scan has no path to a rendering
// layer (THR §3.5, T-R8).

import { redact } from "../redact/index.js";
import { lstatOrNull } from "../fsx/safe-read.js";
import { readAssets } from "./assets.js";
import { computeEffective } from "./effective.js";
import { lint } from "./lint.js";
import {
  absolutePathCandidates,
  deriveEdges,
  derivePortability,
  dotfileCandidates,
  finalizeContentIds,
  normalize,
  resolveCandidatePath,
} from "./normalize.js";
import { scan, scanDerived } from "./scan.js";

const MAX_PROBES = 2000;

export async function runScan({ adapters, env, salt = undefined, payloadPolicy = null }) {
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
  const probes = await probePaths(items, env);
  deriveEdges({ items, env, probes });
  derivePortability(items);

  // Asset bytes are read BEFORE redaction so they pass through the same pass as
  // everything else; with no policy supplied nothing is read at all.
  const assets = await readAssets({ items, env, adapters, policy: payloadPolicy });
  const assetTexts = assets.texts;
  const redaction = redact({ items, adapters, salt, assetTexts });
  finalizeContentIds(items);

  const layers = second.layers;
  const effective = computeEffective({ items, layers });
  const findings = lint({ adapters, items, probes });

  return {
    items,
    layers,
    effective,
    findings,
    redactions: redaction.redactions,
    redaction: redaction.header,
    // Local-only, never serialized: the values this run redacted (the post-export gate
    // needs them), their shapes, and the pointer map. `scanEnvelope` does not read them.
    secret_values: redaction.secret_values,
    secret_shapes: redaction.shapes,
    secret_map: redaction.secret_map,
    asset_texts: assetTexts,
    exclusions: mergeExclusions([
      scanResult.exclusions.list(),
      derived.exclusions.list(),
      assets.exclusions.list(),
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
async function probePaths(items, env) {
  const probes = new Map();
  // Keyed by the candidate AS WRITTEN, because that is what deriveEdges looks up; the lstat
  // runs against what the candidate resolves to under the scanned home.
  for (const candidate of [...absolutePathCandidates(items), ...dotfileCandidates(items)]) {
    if (probes.size >= MAX_PROBES) break;
    if (probes.has(candidate)) continue;
    const target = resolveCandidatePath(candidate, env?.homeDir);
    if (target === null) continue;
    probes.set(candidate, (await lstatOrNull(target)) !== null);
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
