// The LOCAL redaction report (THR §3.5). It is a separate 0600 file in the state dir with
// a different basename stem from the bundle, so the two artifacts can never be confused
// for one another in a directory listing or a tab-completion (T-E2).
//
// Two sections, because a single ranked list would let a structural hit borrow the
// credibility of a shape-confirmed one (spike-corrections, modelling note 4):
//
//   SHAPE-CONFIRMED  a detector recognized the value itself
//   POSITIONAL ONLY  the value was redacted for WHERE it sat, and nothing more is claimed
//
// Deviation from THR §3.3, deliberate: the threat model permits the local report to carry
// length, entropy and the first/last characters of a value. This report carries length,
// charset and entropy but NO characters of any value. The judgement call is that "51 chars,
// base64ish, 4.9 bits" is enough for a human to decide whether a finding is real, and a
// long-lived on-disk artifact holding fragments of live credentials is a worse trade.

export function redactionSummary({ header, redactions }) {
  const byClass = new Map();
  for (const record of redactions) {
    const entry = byClass.get(record.class) ?? { class: record.class, tier: record.tier, refs: 0, sites: 0 };
    entry.refs += 1;
    entry.sites += record.sites.length;
    byClass.set(record.class, entry);
  }
  return {
    distinct_secrets: header.distinct_secrets,
    placeholder_sites: header.placeholder_sites,
    shape_confirmed: header.shape_confirmed,
    positional_only: header.positional_only,
    classes: [...byClass.values()].sort((a, b) => b.sites - a.sites || a.class.localeCompare(b.class)),
  };
}

export function renderRedactionReport({
  header,
  redactions,
  exclusions = [],
  truncations = [],
  bundle = {},
  shapes = new Map(),
}) {
  const summary = redactionSummary({ header, redactions });
  // Shape detail is keyed by REF, never by value: the report describes a credential
  // without holding one.
  const shapeFor = (record) => shapes.get(record.ref) ?? null;

  const lines = [];
  lines.push("# Continuity redaction report");
  lines.push("");
  lines.push("**This file contains more than the bundle.** It lists where every credential-shaped");
  lines.push("value was found on this machine. It is mode 0600, it is not part of the bundle, and");
  lines.push("nothing here is uploaded. Delete it once you have read it.");
  lines.push("");
  lines.push(`- bundle: \`${bundle.path ?? "(not written)"}\``);
  lines.push(`- digest: \`${bundle.digest ?? "-"}\``);
  lines.push(`- detector: ${header.engine_version} / ${header.pattern_set}`);
  lines.push(
    `- post-export scan: **${header.post_export_scan.status}** (${header.post_export_scan.high_tier_hits} HIGH-tier hit(s))`,
  );
  lines.push("");
  lines.push("## Summary");
  lines.push("");
  lines.push(`- distinct secrets: **${summary.distinct_secrets}** across **${summary.placeholder_sites}** site(s)`);
  lines.push(`- shape-confirmed: **${summary.shape_confirmed}** — a detector recognized the value`);
  lines.push(`- positional only: **${summary.positional_only}** — redacted for where it sat, nothing more claimed`);
  if (header.allowlisted_keys.length > 0) {
    lines.push(`- shown, not redacted (curated allowlist): ${header.allowlisted_keys.map(code).join(", ")}`);
  }
  lines.push("");
  if (summary.classes.length > 0) {
    lines.push("| class | tier | refs | sites |");
    lines.push("|---|---|---|---|");
    for (const entry of summary.classes) {
      lines.push(`| \`${entry.class}\` | ${entry.tier} | ${entry.refs} | ${entry.sites} |`);
    }
    lines.push("");
  }

  for (const [title, confidence, blurb] of [
    ["Shape-confirmed", "high", "A detector recognized the value itself: a provider prefix, a DSN password, a JWT, or a high-entropy blob at a declared sink."],
    ["Positional only", "structural", "Redacted because of WHERE it sat — an env block, a header map, a URL credential position. No claim is made about the value; a harmless feature flag in an env block lands here."],
  ]) {
    const rows = redactions.filter((record) => (confidence === "high" ? record.confidence === "high" : record.confidence !== "high"));
    lines.push(`## ${title} (${rows.length})`);
    lines.push("");
    lines.push(blurb);
    lines.push("");
    if (rows.length === 0) {
      lines.push("_None._");
      lines.push("");
      continue;
    }
    for (const record of rows) {
      const shape = shapeFor(record);
      lines.push(`### \`${record.ref}\` — \`${record.class}\` (${record.tier})`);
      lines.push("");
      lines.push(`- detectors: ${record.detector.map(code).join(", ")}`);
      if (record.key_names.length > 0) lines.push(`- key names: ${record.key_names.map(code).join(", ")}`);
      if (shape) lines.push(`- shape: ${shape.length} chars, ${shape.charset}, ${shape.entropy} bits/char`);
      lines.push(`- sites (${record.sites.length}):`);
      for (const site of record.sites) {
        const at = site.key_path ? ` \`${site.key_path}\`` : site.span ? ` line ${site.span.line_start}` : "";
        lines.push(`  - \`${site.item_id}\`${at}`);
      }
      lines.push("");
    }
  }

  lines.push("## Refusals and limits");
  lines.push("");
  if (exclusions.length === 0 && truncations.length === 0) {
    lines.push("_Nothing was excluded or truncated._");
  }
  for (const record of exclusions) {
    lines.push(
      `- \`${record.rule_id}\` — ${record.matched} ${record.unit}, ${record.bytes_skipped} bytes skipped (${record.label ?? "-"})`,
    );
    if (record.note) lines.push(`  - ${record.note}`);
  }
  for (const record of truncations) {
    lines.push(`- truncated \`${record.display_path}\` at ${record.cap} bytes (${record.bytes} on disk)`);
  }
  lines.push("");
  lines.push("## What is not covered");
  lines.push("");
  lines.push("- Session transcripts and log databases are never scanned and never exported.");
  lines.push("- A credential written in plain prose with no recognizable shape (\"the staging password is …\")");
  lines.push("  has no detector. Read the diff.");
  lines.push("- Recall is measured, not assumed: see the corpus numbers in the project's test suite.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function code(value) {
  return `\`${value}\``;
}
