// `continuity compat` — the derived compatibility view.
//
// Nothing in this file decides a verdict. Every cell, every loss and every per-item
// exception comes out of `core/compat/derive.js`, which computes them from the adapters'
// declarations; this module only arranges them for a terminal. That is the point of
// deriving the matrix: the renderer cannot disagree with the engine, because it has no
// opinion to disagree with.

import {
  MATRIX_KINDS,
  cellOf,
  compatForItems,
  compatSummary,
  matrix,
  runtimeProfile,
} from "../core/compat/derive.js";
import { table, truncate } from "./scan.js";

export const VERDICT_MEANINGS = {
  NATIVE: "moves as-is",
  CONVERT: "moves with named losses",
  ADVISE: "proposal for a human; never applied silently",
  UNSUPPORTED: "no equivalent — checked",
  UNKNOWN: "not yet supported — not checked",
};

export function buildCompat({ adapters, result = null, from = null, to = null }) {
  const profiles = adapters.map(runtimeProfile);
  const rows = matrix({ profiles });
  // Per-item reports against an unsurveyed runtime would be a page of UNKNOWN saying
  // nothing about the machine, so a `declared` runtime is included only when the user
  // names it. The matrix still shows it (§4: list it, do not hide it).
  const named = new Set([from, to].filter(Boolean));
  const pairs = [];
  for (const source of profiles) {
    for (const target of profiles) {
      if (from && source.id !== from) continue;
      if (to && target.id !== to) continue;
      if (source.status === "declared" && !named.has(source.id)) continue;
      if (target.status === "declared" && !named.has(target.id)) continue;
      pairs.push([source, target]);
    }
  }
  const reports = result
    ? pairs.map(([source, target]) => compatForItems({ items: result.items, source, target }))
    : [];
  return {
    profiles,
    rows,
    pairs: pairs.map(([source, target]) => ({ from: source.id, to: target.id })),
    reports,
    summaries: reports.map(compatSummary),
    coverage_gaps: coverageGaps(profiles),
  };
}

/**
 * A kind the adapter says the runtime can express while declaring no surface that reads
 * it. That is a Continuity coverage gap, not a runtime limitation, and printing it is the
 * difference between "we looked and found nothing" and "we never looked."
 */
export function coverageGaps(profiles) {
  const gaps = [];
  for (const profile of profiles) {
    if (profile.status === "declared") continue;
    for (const [kind, level] of Object.entries(profile.capabilities)) {
      if (level === "unsupported") continue;
      if (profile.surfaces.some((surface) => surface.kind === kind)) continue;
      gaps.push({ runtime: profile.id, kind, capability: level });
    }
  }
  return gaps;
}

export function compatEnvelope({ code, compat, env }) {
  return {
    ok: code === 0 || code === 3,
    code,
    command: "compat",
    schema_version: "omegas.continuity.v1",
    environment: { host: { os: env.os, home_label: "~" } },
    runtimes: compat.profiles.map((profile) => ({
      id: profile.id,
      status: profile.status,
      adapter_version: profile.adapter_version,
      surfaces_declared: profile.surfaces.length,
    })),
    matrix: compat.rows.map((row) => ({
      kind: row.kind,
      cells: row.cells.map((cell) => ({
        from: cell.from,
        to: cell.to,
        verdict: cell.verdict,
        applicable: cell.applicable,
        transform_id: cell.transform_id,
        target_kind: cell.target_kind ?? null,
        losses: cell.losses,
        inert_on_target: cell.inert_on_target,
        state_transfer: cell.state_transfer,
        evidence: cell.evidence,
        note: cell.note,
      })),
    })),
    pairs: compat.summaries,
    exceptions: compat.reports.flatMap((report) =>
      report.exceptions.map((entry) => ({ from: report.from, to: report.to, ...entry })),
    ),
    coverage_gaps: compat.coverage_gaps,
  };
}

export function renderCompat({ compat, from, to }) {
  const out = [];
  const section = (title) => {
    out.push("");
    out.push("=".repeat(78));
    out.push(title);
    out.push("=".repeat(78));
  };

  // A `declared` runtime is listed as a runtime and named as UNKNOWN, but it does not get
  // matrix columns unless asked for by name: nine columns of UNKNOWN would bury the two
  // runtimes that have actually been surveyed (§4 — list it, do not hide it, do not let
  // it dominate).
  const named = new Set([from, to].filter(Boolean));
  const shown = compat.profiles.filter((profile) => profile.status !== "declared" || named.has(profile.id));
  const columns = [];
  for (const source of shown) {
    for (const target of shown) {
      if (from && source.id !== from) continue;
      if (to && target.id !== to) continue;
      columns.push([source.id, target.id]);
    }
  }

  section("0  RUNTIMES");
  out.push(
    table(
      ["runtime", "status", "adapter", "surfaces", "note"],
      compat.profiles.map((profile) => [
        profile.id,
        profile.status,
        profile.adapter_version,
        String(profile.surfaces.length),
        profile.status === "declared"
          ? "detection not implemented — every cell is UNKNOWN, not UNSUPPORTED"
          : "surveyed; every surface carries an evidence citation",
      ]),
    ),
  );

  section("1  DERIVED COMPATIBILITY MATRIX");
  out.push("Every cell is computed from the two adapters' declarations plus the transform table.");
  out.push("No hand-maintained matrix exists, which is why this cannot quietly go stale.");
  out.push("");
  for (const [verdict, meaning] of Object.entries(VERDICT_MEANINGS)) {
    out.push(`  ${verdict.padEnd(12)} ${meaning}`);
  }
  out.push(`  ${"n/a".padEnd(12)} neither runtime declares this kind`);
  out.push("");
  out.push(
    table(
      ["kind", ...columns.map(([source, target]) => `${abbrev(source)}->${abbrev(target)}`)],
      compat.rows.map((row) => [
        row.kind,
        ...columns.map(([source, target]) => {
          const cell = cellOf(compat.rows, row.kind, source, target);
          if (!cell) return "-";
          return cell.applicable ? cell.verdict : "n/a";
        }),
      ]),
    ),
  );
  const missing = MATRIX_KINDS.filter((kind) => !compat.rows.some((row) => row.kind === kind));
  if (missing.length > 0) out.push(`\nkinds no runtime declares: ${missing.join(", ")}`);

  section("2  LOSSES, BY CELL");
  out.push("A CONVERT that lists nothing would be a lie: the reason it is not NATIVE is the loss.");
  for (const [source, target] of columns) {
    if (source === target) continue;
    for (const row of compat.rows) {
      const cell = cellOf(compat.rows, row.kind, source, target);
      if (!cell || !cell.applicable) continue;
      if (cell.verdict === "NATIVE" && cell.inert_on_target.length === 0) continue;
      if (cell.verdict === "UNSUPPORTED" || cell.verdict === "UNKNOWN") continue;
      out.push("");
      out.push(`${source} -> ${target}  ${row.kind}  [${cell.verdict}]${cell.transform_id ? `  ${cell.transform_id}` : ""}`);
      if (cell.target_kind && cell.target_kind !== row.kind) {
        out.push(`  lands as       ${target} ${cell.target_kind} (${cell.target_surface_id})`);
      }
      for (const loss of cell.losses) {
        out.push(`  loses          ${loss.key_path ? `${loss.key_path}: ` : ""}${loss.reason}`);
      }
      if (cell.inert_on_target.length > 0) {
        out.push(`  inert on target ${truncate(cell.inert_on_target.join(", "), 58)}`);
        out.push("                  (kept byte-for-byte in the file; the target runtime ignores them)");
      }
      for (const entry of cell.state_transfer) {
        out.push(`  state          ${entry.from} -> ${entry.to} (${entry.fidelity}): ${entry.note}`);
      }
      if (cell.evidence) out.push(`  evidence       ${truncate(cell.evidence, 120)}`);
    }
  }

  if (compat.reports.length > 0) {
    section("3  THIS MACHINE, ITEM BY ITEM");
    out.push("The kind headline and the per-item verdict are different questions (§3.1).");
    for (const [index, report] of compat.reports.entries()) {
      const summary = compat.summaries[index];
      if (report.from === report.to) continue;
      out.push("");
      out.push(`${report.from} -> ${report.to}: ${summary.items} item(s)`);
      out.push(
        `  ${Object.entries(summary.by_verdict)
          .map(([verdict, count]) => `${verdict} ${count}`)
          .join("   ") || "none"}`,
      );
      if (report.exceptions.length === 0) {
        out.push("  no item departs from its kind's headline verdict");
        continue;
      }
      out.push(`  ${report.exceptions.length} item(s) DEPART from the kind headline:`);
      for (const entry of report.exceptions) {
        out.push(`    ${entry.item_id}`);
        out.push(`      kind says ${entry.kind_verdict}, this item is ${entry.verdict}`);
        out.push(`      ${entry.item_exception?.reason ?? ""}`);
        if (entry.item_exception?.evidence) out.push(`      evidence: ${truncate(entry.item_exception.evidence, 110)}`);
      }
    }
    const computed = compat.reports.flatMap((report) =>
      report.items.flatMap((entry) =>
        entry.losses.filter((loss) => !loss.declared).map((loss) => ({ item_id: entry.item_id, ...loss })),
      ),
    );
    if (computed.length > 0) {
      out.push("");
      out.push("Computed losses (from each item's own unrecognized keys, not from a list):");
      for (const loss of computed) {
        out.push(`  ${loss.item_id}  ${loss.key_path} (${loss.value_shape} -> ${loss.target_format})`);
        out.push(`    ${loss.reason}`);
      }
    }
  }

  if (compat.coverage_gaps.length > 0) {
    section("4  COVERAGE GAPS");
    out.push("Kinds a runtime supports that Continuity does not yet read. Not a runtime limit — ours.");
    out.push("");
    out.push(
      table(
        ["runtime", "kind", "declared capability"],
        compat.coverage_gaps.map((gap) => [gap.runtime, gap.kind, gap.capability]),
      ),
    );
  }

  out.push("");
  out.push("Read-only: nothing was written, nothing was uploaded, no network or subprocess was used.");
  return `${out.join("\n")}\n`;
}

function abbrev(id) {
  return id.slice(0, 4);
}
