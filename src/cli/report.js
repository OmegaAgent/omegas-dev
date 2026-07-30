// `omegas-dev report` — the multi-section read-only report. It answers the three
// questions the manifest exists to make answerable without opening a source file:
// what is configured, where did it come from, and why is this the effective value.

import { counts, table, tally, truncate, warningsFor } from "./scan.js";

export function renderReport({ result, env }) {
  const out = [];
  const section = (title) => {
    out.push("");
    out.push("=".repeat(78));
    out.push(title);
    out.push("=".repeat(78));
  };

  section("1  ENVIRONMENT");
  out.push(`home                ~ = ${env.homeDir}`);
  out.push(`declared roots      ${env.declaredRoots.map((root) => `${root.adapter_id}:${root.root_id}`).join(", ") || "none"}`);
  out.push("");
  out.push(
    table(
      ["runtime", "present", "status", "version", "home", "adapter", "surfaces"],
      result.runtimes.map((runtime) => [
        runtime.id,
        String(runtime.present),
        runtime.status,
        runtime.version ?? "-",
        runtime.home_label ?? "-",
        runtime.adapter_version,
        String(runtime.surfaces_declared),
      ]),
    ),
  );
  if (result.projects.length > 0) {
    out.push("");
    out.push(
      table(
        ["project_id", "method", "confidence", "portable", "label"],
        result.projects.map((project) => [
          truncate(project.project_id, 40),
          project.identity.method,
          project.identity.confidence,
          String(project.identity.stable_across_machines),
          project.label,
        ]),
      ),
    );
  }

  section("2  ITEMS");
  const summary = counts(result);
  out.push(`items               ${summary.items}`);
  out.push("");
  out.push(table(["kind", "count"], tally(result.items, (item) => item.kind).map(([k, v]) => [k, String(v)])));
  out.push("");
  out.push(table(["runtime", "count"], tally(result.items, (item) => item.runtime).map(([k, v]) => [k, String(v)])));
  out.push("");
  out.push(table(["scope", "count"], tally(result.items, (item) => item.scope).map(([k, v]) => [k, String(v)])));
  out.push("");
  out.push(
    table(["trust tier", "count"], tally(result.items, (item) => item.trust_tier).map(([k, v]) => [k, String(v)])),
  );
  const authority = result.items.filter((item) => item.authority);
  if (authority.length > 0) {
    out.push("");
    out.push(`${authority.length} item(s) carry AUTHORITY: they grant or change permissions and never import in bulk.`);
  }

  section("3  LAYERS");
  out.push(
    table(
      ["layer_id", "scope", "rank", "present", "suppressed_by", "source"],
      result.layers.map((layer) => [
        layer.layer_id,
        layer.scope,
        String(layer.rank),
        String(layer.present),
        layer.suppressed_by ?? "-",
        truncate(layer.source_label ?? "-", 46),
      ]),
    ),
  );

  section("4  EFFECTIVE VALUES");
  out.push(`rows                ${result.effective.length}`);
  const contested = result.effective.filter((row) => row.contributors.length > 1);
  out.push(`contested rows      ${contested.length}`);
  out.push("");
  for (const row of contested.slice(0, 40)) {
    const scope = row.project_id ? ` @ ${row.project_id}` : "";
    out.push(`  [${row.algebra}] ${row.surface_id}${scope} :: ${truncate(row.key, 60)}  ->  ${describeValue(row)}`);
    for (const contributor of row.contributors) {
      const mark = contributor.applied ? "APPLIED " : "shadowed";
      out.push(
        `     ${mark} rank ${String(contributor.rank).padStart(3)}  ${truncate(contributor.item_id, 58)}  ${contributor.reason ?? ""}`,
      );
    }
    if (row.note) out.push(`     note: ${row.note}`);
  }
  if (contested.length > 40) out.push(`  … ${contested.length - 40} more contested rows`);

  section("5  FINDINGS");
  if (result.findings.length === 0) {
    out.push("none");
  } else {
    out.push(
      table(
        ["id", "severity", "rule", "item"],
        result.findings.map((finding) => [
          finding.finding_id,
          finding.severity,
          finding.rule,
          truncate(finding.item_id ?? "-", 46),
        ]),
      ),
    );
    out.push("");
    for (const finding of result.findings) out.push(`  ${finding.finding_id}: ${finding.message}`);
  }

  section("6  REDACTIONS");
  // The report renders the REDACTED model, like every other consumer: the raw scan has no
  // path to a rendering layer, because the screenshot of this output is the leak (T-R8).
  out.push(
    `redacted            ${result.redaction.distinct_secrets} distinct secret(s) across ` +
      `${result.redaction.placeholder_sites} site(s)`,
  );
  out.push(`  shape-confirmed   ${result.redaction.shape_confirmed}  (a detector recognized the value)`);
  out.push(`  positional only   ${result.redaction.positional_only}  (redacted for where it sat; nothing more claimed)`);
  if (result.redaction.allowlisted_keys.length > 0) {
    out.push(`  shown, not hidden ${result.redaction.allowlisted_keys.join(", ")}`);
  }
  if (result.redactions.length > 0) {
    out.push("");
    out.push(
      table(
        ["ref", "class", "tier", "confidence", "key names", "sites"],
        result.redactions.map((record) => [
          record.ref,
          record.class,
          record.tier,
          record.confidence,
          truncate(record.key_names.join(", ") || "-", 34),
          String(record.sites.length),
        ]),
      ),
    );
    out.push("");
    out.push("Values are gone; key names, positions and counts are not. Run `export` for a shareable bundle.");
  }

  section("7  REFUSALS AND LIMITS");
  out.push("Deliberate absence is data. Every rule that fired is listed; silence would be the bug.");
  out.push("");
  if (result.exclusions.length === 0) {
    out.push("exclusions          none fired");
  } else {
    out.push(
      table(
        ["rule_id", "class", "matched", "unit", "bytes", "label"],
        result.exclusions.map((record) => [
          record.rule_id,
          record.class,
          String(record.matched),
          record.unit,
          String(record.bytes_skipped),
          truncate(record.label ?? "-", 40),
        ]),
      ),
    );
  }
  out.push("");
  if (result.truncations.length === 0) {
    out.push("truncations         none");
  } else {
    for (const record of result.truncations) {
      out.push(
        `truncation          ${record.display_path}: ${record.bytes} bytes, kept ${record.kept_bytes} (cap ${record.cap}) — ${record.reason}`,
      );
    }
  }
  out.push("");
  const unresolved = result.items.filter((item) => item.kind === "unresolved_link");
  if (unresolved.length === 0) {
    out.push("unresolved links    none");
  } else {
    out.push(`unresolved links    ${unresolved.length}`);
    for (const item of unresolved) {
      out.push(`  ${item.name} -> ${item.origin.link?.target_display ?? "?"}`);
      out.push(`     refusal: ${item.origin.link?.refusal ?? "?"}`);
    }
  }

  const warnings = warningsFor(result);
  if (warnings.length > 0) {
    out.push("");
    for (const warning of warnings) out.push(`Warning: ${warning}`);
  }
  out.push("");
  out.push("Read-only: nothing was written, nothing was uploaded, no network or subprocess was used.");
  return `${out.join("\n")}\n`;
}

function describeValue(row) {
  if (row.winner === null && (row.algebra === "concatenate" || row.algebra === "aggregate")) {
    return "(no single winner)";
  }
  if (row.value === null || row.value === undefined) return "(none)";
  return truncate(typeof row.value === "string" ? row.value : JSON.stringify(row.value), 50);
}
