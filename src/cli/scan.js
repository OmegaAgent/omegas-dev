// `omegas-dev scan` — the terse view, plus the `--json` envelope both commands share.
// The envelope is half of the open/closed seam (adapter-architecture §6.1): the hosted
// layer consumes exit codes and this shape, and never imports an open-core module.

import { publicItem } from "../core/model/item.js";

export const SCHEMA_VERSION = "omegas.continuity.v1";

export function scanEnvelope({ command, code, result, env }) {
  return {
    ok: code === 0 || code === 3,
    code,
    command,
    schema_version: SCHEMA_VERSION,
    complete: result.complete,
    environment: {
      host: { os: env.os, home_label: "~" },
      runtimes: result.runtimes,
    },
    projects: result.projects,
    layers: result.layers,
    counts: counts(result),
    items: result.items.map(publicItem),
    effective: result.effective,
    // The envelope carries the redaction header and side table because every consumer of
    // it — including the hosted layer — must render the redacted model, and re-binding a
    // placeholder needs the class and the site list (THR §3.3, T-R8).
    redaction: result.redaction,
    redactions: result.redactions,
    findings: result.findings,
    exclusions: result.exclusions,
    truncations: result.truncations,
    warnings: warningsFor(result),
  };
}

export function counts(result) {
  return {
    items: result.items.length,
    layers: result.layers.length,
    effective: result.effective.length,
    findings: result.findings.length,
    exclusions: result.exclusions.length,
    unresolved_links: result.unresolved_links,
    truncations: result.truncations.length,
  };
}

export function warningsFor(result) {
  const warnings = [];
  for (const record of result.truncations) {
    warnings.push(`truncated at the ${record.cap}-byte cap: ${record.display_path} (${record.bytes} bytes on disk)`);
  }
  if (result.unresolved_links > 0) {
    warnings.push(`${result.unresolved_links} symlink(s) resolve outside every declared root and are listed as nodes`);
  }
  for (const finding of result.findings) {
    if (finding.severity === "critical") warnings.push(`${finding.rule}: ${finding.message}`);
  }
  return warnings;
}

export function renderScan({ result, env }) {
  const lines = [];
  lines.push(`home                ~ = ${env.homeDir}`);
  lines.push("");
  lines.push(
    table(
      ["runtime", "present", "status", "version", "home", "surfaces"],
      result.runtimes.map((runtime) => [
        runtime.id,
        String(runtime.present),
        runtime.status,
        runtime.version ?? "-",
        runtime.home_label ?? "-",
        String(runtime.surfaces_declared),
      ]),
    ),
  );
  lines.push("");
  const byKind = tally(result.items, (item) => item.kind);
  lines.push(table(["kind", "items"], [...byKind].map(([kind, count]) => [kind, String(count)])));
  lines.push("");
  const summary = counts(result);
  for (const [key, value] of Object.entries(summary)) {
    lines.push(`${key.padEnd(18)}${value}`);
  }
  const warnings = warningsFor(result);
  if (warnings.length > 0) {
    lines.push("");
    for (const warning of warnings) lines.push(`Warning: ${warning}`);
  }
  return `${lines.join("\n")}\n`;
}

export function tally(list, keyOf) {
  const counted = new Map();
  for (const entry of list) {
    const key = keyOf(entry);
    counted.set(key, (counted.get(key) ?? 0) + 1);
  }
  return [...counted.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
}

export function table(headers, rows) {
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length), 3),
  );
  const line = (cells) => cells.map((cell, index) => String(cell ?? "").padEnd(widths[index])).join("  ").trimEnd();
  return [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n");
}

export function truncate(text, width) {
  const value = String(text ?? "");
  return value.length <= width ? value : `${value.slice(0, width - 1)}…`;
}
