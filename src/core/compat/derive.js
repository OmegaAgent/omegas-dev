// The compatibility engine (adapter-architecture §3).
//
// There is no hand-written matrix. Every cell is a pure function of the two runtimes'
// declarations plus the transform table, so the matrix cannot drift away from what the
// adapters actually say — and when a runtime adds a key, the loss list grows by itself.
//
// Two properties the derivation exists to preserve:
//
//  1. KIND-level and ITEM-level verdicts differ. `mcp_server` is CONVERT for Claude→Codex
//     as a kind, and an individual entry with `"type": "ws"` is UNSUPPORTED for that item.
//     A matrix alone would lie about that entry, so `fidelity()` takes the item.
//  2. UNKNOWN is not UNSUPPORTED. UNSUPPORTED means "we checked and it cannot be done";
//     UNKNOWN means "we have not built this" (§4). Collapsing them would let the matrix
//     imply a verified negative about a runtime nobody has surveyed.

import { CANONICAL_KINDS } from "../model/kinds.js";
import { itemExceptionOf, transformFor, transformsOf, unexpressible } from "./transforms.js";

// The verdict vocabulary lives in model/kinds.js as FIDELITY, and it is not restated here:
// two copies of a closed set is one copy too many.

/**
 * `unresolved_link` and `opaque` are refusal kinds, not configuration: they record that
 * something was NOT read. Asking whether a refusal converts to another runtime is a
 * category error, so they are excluded from the matrix rather than rendered as a row of
 * UNSUPPORTED that would read like a capability claim.
 */
export const REFUSAL_KINDS = ["unresolved_link", "opaque"];

export const MATRIX_KINDS = CANONICAL_KINDS.filter((kind) => !REFUSAL_KINDS.includes(kind));

/**
 * The minimum an adapter has to expose for the matrix to be derivable. A bundle carries
 * exactly this much (`capabilities[]`), which is why a report rendered from a bundle
 * derives the same matrix offline, months later, without the adapters that produced it.
 */
export function runtimeProfile(adapter) {
  return {
    id: adapter.id,
    display_name: adapter.display_name ?? adapter.id,
    status: adapter.status,
    adapter_version: adapter.adapter_version,
    capabilities: adapter.capabilities ?? {},
    surfaces: (adapter.surfaces ?? []).map((surface) => ({
      surface_id: surface.surface_id,
      kind: surface.kind,
      format: surface.format,
    })),
    transforms: adapter.transforms ?? [],
  };
}

/** The same projection, read back out of a bundle's `capabilities[]` snapshot. */
export function profileFromSnapshot(snapshot) {
  return {
    id: snapshot.runtime,
    display_name: snapshot.display_name ?? snapshot.runtime,
    status: snapshot.status,
    adapter_version: snapshot.adapter_version,
    capabilities: snapshot.kinds ?? {},
    surfaces: snapshot.surfaces ?? [],
    transforms: snapshot.transforms ?? [],
  };
}

export function declaresKind(profile, kind) {
  return (profile.surfaces ?? []).some((surface) => surface.kind === kind);
}

/**
 * The surface an item of this kind would land on. A transform may target a DIFFERENT
 * kind than it reads — a Claude command becomes a Codex skill, a Codex rules file becomes
 * a Claude permission proposal — so the target surface is what the descriptor names, and
 * only falls back to same-kind when it names nothing resolvable.
 */
export function targetSurfaceFor({ kind, target, transform }) {
  const named = transform?.to?.surface_id
    ? (target.surfaces ?? []).find((surface) => surface.surface_id === transform.to.surface_id)
    : null;
  if (named) return named;
  return (target.surfaces ?? []).find((surface) => surface.kind === kind) ?? null;
}

/**
 * adapter-architecture §3.1, with one amendment and one shape change, both deliberate:
 *
 *  - AMENDMENT (step 5). The spec reads `if (c === "native" && S.id === T.id) return NATIVE`.
 *    Machine → machine is not a capability question: the item was read from a surface of
 *    this kind on this runtime and is written back to that same surface, byte for byte. So
 *    the same-runtime test is `T declares a surface of this kind`, which is the structural
 *    fact. Without it, Codex `command` (capability "convertible", because Codex's prompts
 *    are a lesser form than Claude's commands) derives UNSUPPORTED for X→X — false, since
 *    the file copies verbatim — and contradicts §3.2, which marks every same-runtime cell
 *    for a declared kind NATIVE.
 *  - SHAPE. The spec returns a bare string except for CONVERT. This returns one record
 *    always, whose `.verdict` is the spec's string. Uniform shape so a renderer never
 *    branches on the type of its own input.
 */
export function fidelity(kind, source, target, item = null) {
  const base = {
    kind,
    from: source.id,
    to: target.id,
    losses: [],
    inert_on_target: [],
    state_transfer: [],
    transform_id: null,
    item_exception: null,
    evidence: null,
    note: null,
    source_declares: declaresKind(source, kind),
    target_declares: declaresKind(target, kind),
  };

  // §4 — a `declared` adapter has been surveyed by nobody. Saying UNSUPPORTED here would
  // assert a verified negative we have not earned. The rule is stated for the target and
  // holds just as strongly for the source: nothing is known about what a Hermes
  // configuration even contains, so "Hermes cannot move to Claude" is not ours to claim.
  for (const runtime of [target, source]) {
    if (runtime.status === "declared") {
      return {
        ...base,
        verdict: "UNKNOWN",
        note: `${runtime.id} is declared, not surveyed: no surface has been verified, so nothing has been checked either way`,
      };
    }
  }

  const capability = target.capabilities[kind] ?? "unsupported";
  const transforms = transformsOf([source, target]);
  const transform = transformFor({ kind, from: source.id, to: target.id, transforms });

  // AMENDMENT to step 2. A transform may read one kind and write another: a Claude
  // command becomes a Codex skill, a Codex `.rules` file becomes a Claude permission
  // proposal. Checking only `capabilities[K]` makes such a transform unreachable and
  // reports UNSUPPORTED for a conversion §3.3 verifies as advisory ("lossy in both
  // directions … requiring human review", COD §4.9). So an unsupported KIND is rescued
  // exactly when a declared transform lands it on a surface of a kind the target does
  // support — never otherwise.
  const targetSurface = targetSurfaceFor({ kind, target, transform });
  const landingKind = targetSurface?.kind ?? kind;
  const landingCapability = target.capabilities[landingKind] ?? "unsupported";
  if (capability === "unsupported" && !(transform && landingKind !== kind && landingCapability !== "unsupported")) {
    return { ...base, verdict: "UNSUPPORTED", note: `${target.id} has no representation for ${kind}` };
  }

  if (transform) {
    const record = {
      ...base,
      transform_id: transform.transform_id,
      evidence: transform.evidence ?? null,
      inert_on_target: transform.inert_on_target ?? [],
      state_transfer: transform.state_transfer ?? [],
      target_surface_id: targetSurface?.surface_id ?? null,
      target_kind: landingKind,
      target_format: targetSurface?.format ?? null,
    };

    // Property 1: the item-level exception outranks the kind-level verdict, and carries
    // its own reason so the UI can name the one entry that cannot go.
    const exception = itemExceptionOf(transform, item);
    if (exception) {
      return {
        ...record,
        verdict: exception.verdict,
        item_exception: {
          exception_id: exception.exception_id,
          reason: exception.reason,
          evidence: exception.evidence ?? transform.evidence ?? null,
        },
        note: exception.reason,
      };
    }

    const operations = transform.operations ?? [];
    const drops = transform.drops ?? [];
    if (operations.length > 0 && operations.every((operation) => operation === "relocate") && drops.length === 0) {
      return {
        ...record,
        verdict: "NATIVE",
        note:
          record.inert_on_target.length > 0
            ? `relocation only; ${record.inert_on_target.length} source-only key(s) survive the move and are ignored by ${target.id}`
            : "relocation only",
      };
    }
    if (transform.fidelity === "advisory") {
      return {
        ...record,
        verdict: "ADVISE",
        losses: drops.map(asLoss),
        note:
          landingKind === kind
            ? "human review required; never applied silently"
            : `human review required; the proposal is a ${target.id} ${landingKind}, never a silent write`,
      };
    }

    // Property 2: declared drops plus whatever the target FORMAT cannot hold. CONVERT
    // always lists its losses, and this is where the computed half comes from.
    const computed = item ? unexpressible(item.payload?.unrecognized, record.target_format) : [];
    return {
      ...record,
      verdict: "CONVERT",
      losses: [...drops.map(asLoss), ...computed],
      note:
        landingKind === kind
          ? null
          : `lands as ${target.id} ${landingKind} (${record.target_surface_id}), not as ${kind}`,
    };
  }

  if (capability === "advisory") {
    return {
      ...base,
      verdict: "ADVISE",
      note: `${target.id} can only approximate ${kind}; the output is a proposal for a human, not a write`,
    };
  }

  // The amended step 5. Machine → machine, which is the core Continuity case.
  if (source.id === target.id && base.target_declares) {
    return { ...base, verdict: "NATIVE", note: "same runtime: the item returns to the surface it came from" };
  }

  return {
    ...base,
    verdict: "UNSUPPORTED",
    note:
      base.source_declares || base.target_declares
        ? `no transform is declared from ${source.id} to ${target.id} for ${kind}`
        : `neither ${source.id} nor ${target.id} declares a surface of this kind`,
  };
}

function asLoss(entry) {
  if (typeof entry === "string") return { key_path: null, reason: entry, declared: true };
  return { ...entry, declared: true };
}

/**
 * Render-ready: every kind against every ordered pair of runtimes. `applicable` is false
 * when NEITHER runtime declares the kind — the cell is not a capability claim in that
 * case, it is an absence, and a renderer shows "n/a" rather than "UNSUPPORTED".
 */
export function matrix({ profiles, kinds = MATRIX_KINDS, item = null }) {
  const rows = [];
  for (const kind of kinds) {
    const cells = [];
    for (const source of profiles) {
      for (const target of profiles) {
        const cell = fidelity(kind, source, target, item);
        cells.push({ ...cell, applicable: cell.source_declares || cell.target_declares });
      }
    }
    if (cells.every((cell) => !cell.applicable && cell.verdict !== "UNKNOWN")) continue;
    rows.push({ kind, cells });
  }
  return rows;
}

/** One cell, by name, out of a rendered matrix. */
export function cellOf(rows, kind, from, to) {
  const row = rows.find((entry) => entry.kind === kind);
  return row ? row.cells.find((cell) => cell.from === from && cell.to === to) ?? null : null;
}

/**
 * The per-item pass: what would actually happen to the items on THIS machine, which is a
 * different question from what the kind permits. Items whose verdict differs from their
 * kind's headline are the exceptions the §3.1 note is about, and they are reported
 * separately because they are the ones a matrix would misrepresent.
 */
export function compatForItems({ items, source, target }) {
  const headline = new Map();
  const results = [];
  for (const item of items) {
    if (item.runtime !== source.id) continue;
    if (REFUSAL_KINDS.includes(item.kind)) continue;
    if (!headline.has(item.kind)) headline.set(item.kind, fidelity(item.kind, source, target));
    const kindVerdict = headline.get(item.kind);
    const itemVerdict = fidelity(item.kind, source, target, item);
    results.push({
      item_id: item.item_id,
      kind: item.kind,
      name: item.name,
      display_path: item.origin?.display_path ?? null,
      verdict: itemVerdict.verdict,
      kind_verdict: kindVerdict.verdict,
      exception: itemVerdict.verdict !== kindVerdict.verdict,
      item_exception: itemVerdict.item_exception,
      losses: itemVerdict.losses,
      transform_id: itemVerdict.transform_id,
    });
  }
  return {
    from: source.id,
    to: target.id,
    kinds: [...headline.entries()].map(([kind, verdict]) => ({ kind, ...verdict })),
    items: results,
    exceptions: results.filter((entry) => entry.exception),
  };
}

/**
 * A summary a renderer can print without walking the item list twice.
 */
export function compatSummary(report) {
  const byVerdict = new Map();
  for (const entry of report.items) byVerdict.set(entry.verdict, (byVerdict.get(entry.verdict) ?? 0) + 1);
  return {
    from: report.from,
    to: report.to,
    items: report.items.length,
    by_verdict: Object.fromEntries([...byVerdict.entries()].sort()),
    exceptions: report.exceptions.length,
    distinct_losses: new Set(report.items.flatMap((entry) => entry.losses.map((loss) => loss.reason))).size,
  };
}
