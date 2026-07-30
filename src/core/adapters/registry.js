// The registry is the ONLY module in adapters/ that contains logic, and the only one
// that imports anything beyond ../model/kinds.js. It exists so the §4 status invariant
// is asserted rather than assumed: a fabricated surface list cannot land without a
// citation attached to each entry.

import {
  ALGEBRAS,
  CANONICAL_KINDS,
  CAPABILITY_LEVELS,
  DISABLED_FORM_MODES,
  FORMATS,
  PORTABILITY_VERDICTS,
  SCOPES,
  SEVERITIES,
  TRUST_TIERS,
  WRITE_MODES,
} from "../model/kinds.js";
import claude from "./claude.js";
import codex from "./codex.js";
import hermes from "./hermes.js";

export const ADAPTERS = [claude, codex, hermes];

const STATUSES = ["supported", "partial", "declared"];
const CONTAINERS = ["file", "directory", "embedded"];
const CONFIDENCES = ["high", "low"];
const TRUST_TIER_NAMES = Object.keys(TRUST_TIERS);

export function adapterById(id) {
  const adapter = ADAPTERS.find((candidate) => candidate.id === id);
  if (!adapter) throw new Error(`no adapter registered with id "${id}"`);
  return adapter;
}

/**
 * adapter-architecture §4 — every invariant the design doc makes enforceable,
 * returned as a list of human-readable problem strings. Empty list = healthy.
 */
export function validateAdapters(adapters = ADAPTERS) {
  const problems = [];
  const seenAdapterIds = new Set();
  const seenSurfaceIds = new Set();

  for (const adapter of adapters) {
    const id = adapter && adapter.id ? adapter.id : "<unnamed adapter>";

    if (!adapter || typeof adapter !== "object") {
      problems.push(`${id}: adapter must be an object literal`);
      continue;
    }
    if (seenAdapterIds.has(adapter.id)) problems.push(`${id}: duplicate adapter id`);
    seenAdapterIds.add(adapter.id);

    if (!STATUSES.includes(adapter.status)) {
      problems.push(`${id}: status "${adapter.status}" is not one of ${STATUSES.join(" | ")}`);
    }
    if (!adapter.adapter_version) problems.push(`${id}: missing adapter_version`);
    if (!adapter.detect || typeof adapter.detect !== "object") problems.push(`${id}: missing detect descriptor`);

    // Adapters are data. This walk covers the WHOLE adapter, not only surfaces.
    for (const path of collectFunctionPaths(adapter, id)) {
      problems.push(`${path}: adapters are data — function values are not permitted at any depth`);
    }

    const surfaces = Array.isArray(adapter.surfaces) ? adapter.surfaces : null;
    if (!surfaces) {
      problems.push(`${id}: surfaces[] must be an array`);
      continue;
    }

    // §4 status invariant.
    if (adapter.status === "declared") {
      if (surfaces.length > 0) problems.push(`${id}: status "declared" requires zero surfaces, found ${surfaces.length}`);
      if (!adapter.detect || !nonEmptyString(adapter.detect.reason)) {
        problems.push(`${id}: status "declared" requires a non-empty detect.reason explaining what was not surveyed`);
      }
    }
    if (adapter.status === "supported" && surfaces.length === 0) {
      problems.push(`${id}: status "supported" requires at least one surface`);
    }
    if (adapter.status === "partial") {
      if (surfaces.length === 0) problems.push(`${id}: status "partial" requires at least one declared surface`);
      if (!Array.isArray(adapter.known_gaps) || adapter.known_gaps.length === 0) {
        problems.push(`${id}: status "partial" requires a non-empty known_gaps[]`);
      }
    }

    const sourceIds = new Set();
    for (const source of adapter.sources || []) {
      if (!nonEmptyString(source.source_id)) {
        problems.push(`${id}: a sources[] entry is missing source_id`);
        continue;
      }
      if (sourceIds.has(source.source_id)) problems.push(`${id}/${source.source_id}: duplicate source_id`);
      sourceIds.add(source.source_id);
      if (!FORMATS.includes(source.format)) {
        problems.push(`${id}/${source.source_id}: format "${source.format}" is not in FORMATS`);
      }
      if (!SCOPES.includes(source.scope)) {
        problems.push(`${id}/${source.source_id}: scope "${source.scope}" is not in SCOPES`);
      }
    }

    const surfaceIdsInAdapter = new Set();
    for (const surface of surfaces) {
      const label = `${id}/${surface.surface_id || "<unnamed surface>"}`;

      if (!nonEmptyString(surface.surface_id)) {
        problems.push(`${label}: missing surface_id`);
      } else {
        if (seenSurfaceIds.has(surface.surface_id)) problems.push(`${label}: duplicate surface_id`);
        seenSurfaceIds.add(surface.surface_id);
        surfaceIdsInAdapter.add(surface.surface_id);
      }

      // Anti-fabrication gate: a surface without a citation is a claim without evidence.
      if (!nonEmptyString(surface.evidence)) problems.push(`${label}: missing evidence citation`);
      if (!CONFIDENCES.includes(surface.confidence)) {
        problems.push(`${label}: confidence "${surface.confidence}" is not high | low`);
      }
      if (surface.confidence === "low" && !nonEmptyString(surface.notes)) {
        problems.push(`${label}: confidence "low" requires notes explaining what could not be confirmed`);
      }

      if (!CANONICAL_KINDS.includes(surface.kind)) {
        problems.push(`${label}: kind "${surface.kind}" is not in CANONICAL_KINDS`);
      }
      if (!FORMATS.includes(surface.format)) {
        problems.push(`${label}: format "${surface.format}" is not in FORMATS`);
      }
      if (!CONTAINERS.includes(surface.container)) {
        problems.push(`${label}: container "${surface.container}" is not file | directory | embedded`);
      }
      if (!TRUST_TIER_NAMES.includes(surface.trust_tier)) {
        problems.push(`${label}: trust_tier "${surface.trust_tier}" is not a TRUST_TIERS key`);
      }
      if (!CAPABILITY_LEVELS.includes(surface.capability)) {
        problems.push(`${label}: capability "${surface.capability}" is not in CAPABILITY_LEVELS`);
      }

      if (!surface.merge || !ALGEBRAS.includes(surface.merge.algebra)) {
        problems.push(`${label}: merge.algebra "${surface.merge && surface.merge.algebra}" is not in ALGEBRAS`);
      }
      if (surface.merge && !nonEmptyString(surface.merge.group)) {
        problems.push(`${label}: merge.group is required — it is what makes several surfaces share one effective row`);
      }

      if (!surface.portability || !PORTABILITY_VERDICTS.includes(surface.portability.class)) {
        problems.push(
          `${label}: portability.class "${surface.portability && surface.portability.class}" is not in PORTABILITY_VERDICTS`,
        );
      }

      if (!Array.isArray(surface.locations) || surface.locations.length === 0) {
        problems.push(`${label}: locations[] must be a non-empty array`);
      } else {
        for (const location of surface.locations) {
          if (location.scope !== undefined && !SCOPES.includes(location.scope)) {
            problems.push(`${label}: location scope "${location.scope}" is not in SCOPES`);
          }
          if (location.source_id !== undefined && !sourceIds.has(location.source_id)) {
            problems.push(`${label}: location references unknown source_id "${location.source_id}"`);
          }
          if (location.match === "embedded" && !nonEmptyString(location.source_id)) {
            problems.push(`${label}: an embedded location must name the source_id it reads`);
          }
        }
      }

      if (!surface.emit || typeof surface.emit !== "object") {
        problems.push(`${label}: emit descriptor is required (write_mode "none" is how a surface declares it is never written)`);
      } else {
        problems.push(...validateEmit(label, surface, surfaces));
      }
    }

    // A derived location must point at a surface this adapter actually declares.
    for (const surface of surfaces) {
      for (const location of surface.locations || []) {
        if (location.match === "derived_from" && !surfaceIdsInAdapter.has(location.surface_id)) {
          problems.push(`${id}/${surface.surface_id}: derived_from references unknown surface_id "${location.surface_id}"`);
        }
      }
    }

    for (const [kind, level] of Object.entries(adapter.capabilities || {})) {
      if (!CANONICAL_KINDS.includes(kind)) problems.push(`${id}: capabilities key "${kind}" is not a canonical kind`);
      if (!CAPABILITY_LEVELS.includes(level)) {
        problems.push(`${id}: capabilities.${kind} = "${level}" is not in CAPABILITY_LEVELS`);
      }
    }

    for (const lint of adapter.lints || []) {
      const label = `${id}/${lint.lint_id || "<unnamed lint>"}`;
      if (!nonEmptyString(lint.lint_id)) problems.push(`${label}: missing lint_id`);
      if (!SEVERITIES.includes(lint.severity)) problems.push(`${label}: severity "${lint.severity}" is not in SEVERITIES`);
      if (!lint.predicate || typeof lint.predicate !== "object" || !nonEmptyString(lint.predicate.op)) {
        problems.push(`${label}: predicate must be a declarative operator object`);
      }
      if (!nonEmptyString(lint.evidence)) problems.push(`${label}: missing evidence citation`);
      if (!nonEmptyString(lint.message)) problems.push(`${label}: missing message`);
    }

    for (const rule of adapter.never_export || []) {
      const label = `${id}/${rule.rule_id || "<unnamed rule>"}`;
      if (!nonEmptyString(rule.rule_id)) problems.push(`${label}: missing rule_id`);
      if (!nonEmptyString(rule.match)) problems.push(`${label}: missing match pattern`);
      // Deliberate absence is data: a rule with no reason cannot be explained to a user.
      if (!nonEmptyString(rule.reason)) problems.push(`${label}: never_export rule requires a reason`);
    }

    for (const transform of adapter.transforms || []) {
      const label = `${id}/${transform.transform_id || "<unnamed transform>"}`;
      if (!nonEmptyString(transform.transform_id)) problems.push(`${label}: missing transform_id`);
      if (!CANONICAL_KINDS.includes(transform.kind)) problems.push(`${label}: kind "${transform.kind}" is not a canonical kind`);
      if (!nonEmptyString(transform.evidence)) problems.push(`${label}: missing evidence citation`);
    }
  }

  return problems;
}

/**
 * The emit block is what the import planner executes, so its invariants are security
 * invariants. The load-bearing one is the last: an EXECUTABLE surface that Continuity can
 * WRITE must declare how the runtime turns it off. Without a disabled form there is no
 * quarantine, and "written but inert" quietly becomes "written and live".
 */
function validateEmit(label, surface, surfaces) {
  const problems = [];
  const emit = surface.emit;
  if (!WRITE_MODES.includes(emit.write_mode)) {
    problems.push(`${label}: emit.write_mode "${emit.write_mode}" is not one of ${WRITE_MODES.join(" | ")}`);
  }
  const writable = emit.write_mode !== "none" && emit.target !== null && emit.target !== undefined;
  if (emit.write_mode !== "none" && !nonEmptyString(emit.target)) {
    problems.push(`${label}: emit.write_mode "${emit.write_mode}" needs a target template`);
  }
  if (emit.write_mode === "none" && emit.target) {
    problems.push(`${label}: emit.write_mode "none" must not name a target`);
  }

  const form = emit.disabled_form;
  if (form) {
    if (!DISABLED_FORM_MODES.includes(form.mode)) {
      problems.push(`${label}: disabled_form.mode "${form.mode}" is not one of ${DISABLED_FORM_MODES.join(" | ")}`);
    }
    if (form.mode !== "no_exec_bit" && !nonEmptyString(form.key_path) && !nonEmptyString(form.array_path)) {
      problems.push(`${label}: disabled_form needs the key path the runtime reads to decide this item is off`);
    }
    if (form.mode === "companion_key" || form.mode === "companion_entry") {
      if (!surfaces.some((candidate) => candidate.surface_id === form.surface_id)) {
        problems.push(`${label}: disabled_form.surface_id "${form.surface_id}" is not a surface of this adapter`);
      }
    }
    if (form.mode === "companion_entry" && (!nonEmptyString(form.array_path) || !nonEmptyString(form.match_key))) {
      problems.push(`${label}: a companion_entry disabled_form needs array_path and match_key`);
    }
  } else if (writable && surface.trust_tier === "EXECUTABLE") {
    problems.push(
      `${label}: an EXECUTABLE surface with an import target must declare a disabled_form — without one there is no quarantine`,
    );
  }
  return problems;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function collectFunctionPaths(node, path, found = [], seen = new Set()) {
  if (typeof node === "function") {
    found.push(path);
    return found;
  }
  if (!node || typeof node !== "object") return found;
  if (seen.has(node)) return found;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) {
    collectFunctionPaths(value, `${path}.${key}`, found, seen);
  }
  return found;
}
