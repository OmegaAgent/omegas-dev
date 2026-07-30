// `omegas-dev report --html` — the local, private, self-contained visualizer.
//
// THREE PROPERTIES, ALL STRUCTURAL RATHER THAN PROMISED:
//
// 1. It is rendered from a REDACTED BUNDLE and nothing else. The only entry point takes a
//    bundle PATH, reads it through the same verifying reader an importer uses, and hands
//    the manifest to a renderer that rejects anything which is not one. A raw scan result
//    carries `_raw_text` on every item and has no `schema_version`; it cannot reach this
//    module even by mistake, which is the point — a screenshot of a raw scan is the leak
//    (THR §3.5, T-R8).
// 2. It makes no network request. There is no <script src>, no <link>, no @import, no
//    url(), no font download, no analytics, no telemetry, and no JavaScript at all —
//    collapsing sections are <details> elements, which are markup. A restrictive CSP is
//    declared as well, so the file is inert even if it is later edited by someone else.
// 3. It contains no secret values. It renders the redaction SIDE TABLE — classes, counts,
//    key names, the item and key path of each site — because that is what makes the
//    redaction auditable, and never a value, because the bundle does not carry one.
//
// Config values are escaped text. Some of them are URLs, because people configure URLs;
// they appear as characters in a text node, never as an attribute a browser would fetch.

import { readFile } from "node:fs/promises";
import { readBundle } from "../core/bundle/read.js";
import { matrix, profileFromSnapshot, cellOf } from "../core/compat/derive.js";
import { SCHEMA_VERSION } from "../core/bundle/write.js";

/** The only way to get HTML: a path to a bundle, verified on the way in. */
export async function htmlFromBundleFile(bundlePath) {
  const serialized = await readFile(bundlePath, "utf8");
  const { manifest } = readBundle(serialized);
  return renderBundleHtml(manifest);
}

/**
 * The renderer. It asserts its input is a bundle manifest rather than trusting the
 * caller: this is the type-level isolation M4 asks for, expressed the only way a
 * dynamically typed language can express it — as a refusal.
 */
export function renderBundleHtml(manifest) {
  assertRedactedBundle(manifest);
  const body = [
    header(manifest),
    environmentSection(manifest),
    compatibilitySection(manifest),
    itemsSection(manifest),
    effectiveSection(manifest),
    findingsSection(manifest),
    redactionSection(manifest),
    limitsSection(manifest),
    footer(manifest),
  ].join("\n");
  return document(manifest, body);
}

export class NotABundleError extends TypeError {}

function assertRedactedBundle(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new NotABundleError("the HTML report renders a bundle manifest; received something else");
  }
  if (manifest.schema_version !== SCHEMA_VERSION) {
    throw new NotABundleError(
      `the HTML report renders a redacted bundle only. Expected schema_version ${SCHEMA_VERSION}, got ` +
        `${JSON.stringify(manifest.schema_version)}. Run \`omegas-dev export\` first — a raw scan result must ` +
        `never reach a rendering layer.`,
    );
  }
  if (!manifest.bundle?.digest || !manifest.redaction) {
    throw new NotABundleError("bundle manifest is missing its digest or redaction header; refusing to render it");
  }
  // A raw Item carries engine-internal fields (`_raw_text`, `_surface`, `_captures`).
  // `publicItem()` strips them on the way into a bundle, so their presence means this
  // object never went through the redaction/export path at all.
  for (const item of manifest.items ?? []) {
    for (const key of Object.keys(item)) {
      if (key.startsWith("_")) {
        throw new NotABundleError(
          `item ${item.item_id} carries the engine-internal field "${key}": this is a raw scan, not a bundle`,
        );
      }
    }
  }
}

// ── document shell ─────────────────────────────────────────────────────────────

function document(manifest, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>${esc(`Omegas Continuity report — ${manifest.bundle.id}`)}</title>
<style>
${STYLE}
</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --ink: #1b1a17; --muted: #63605a;
  --line: #e3e0d9; --accent: #2f6b41; --warn: #8a5a12; --crit: #8c2f2f;
  --code: #f4f2ee;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #16171a; --panel: #1d1f23; --ink: #e9e7e2; --muted: #a09c94;
    --line: #2f3237; --accent: #7fb98f; --warn: #d6a55a; --crit: #e08a8a;
    --code: #24262b;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; padding: 2rem 1.25rem 4rem;
  background: var(--bg); color: var(--ink);
  font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
main { max-width: 62rem; margin: 0 auto; }
h1 { font-size: 1.5rem; margin: 0 0 .35rem; letter-spacing: -0.01em; }
h2 { font-size: 1.05rem; margin: 2.5rem 0 .75rem; padding-bottom: .35rem; border-bottom: 1px solid var(--line); }
h3 { font-size: .92rem; margin: 1.5rem 0 .5rem; color: var(--muted); font-weight: 600; }
p { margin: .5rem 0; }
.sub { color: var(--muted); font-size: .88rem; }
.banner {
  background: var(--panel); border: 1px solid var(--line); border-left: 4px solid var(--accent);
  border-radius: 6px; padding: 1rem 1.15rem; margin-bottom: 1.5rem;
}
.banner ul { margin: .6rem 0 0; padding-left: 1.1rem; }
.banner li { margin: .2rem 0; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .2rem 1rem; margin: .75rem 0 0; font-size: .87rem; }
dl.meta dt { color: var(--muted); }
dl.meta dd { margin: 0; }
table { width: 100%; border-collapse: collapse; margin: .5rem 0 1rem; font-size: .86rem; }
th, td { text-align: left; padding: .38rem .55rem; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 600; white-space: nowrap; }
td.num { text-align: right; font-variant-numeric: tabular-nums; }
.scroll { overflow-x: auto; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .84em; }
code { background: var(--code); padding: .08em .32em; border-radius: 3px; word-break: break-all; }
details { border: 1px solid var(--line); border-radius: 6px; background: var(--panel); margin: .5rem 0; }
details > summary { cursor: pointer; padding: .5rem .75rem; font-weight: 600; font-size: .9rem; }
details[open] > summary { border-bottom: 1px solid var(--line); }
details > div { padding: .65rem .75rem; }
.tag {
  display: inline-block; font-size: .72rem; letter-spacing: .02em; padding: .1em .45em;
  border: 1px solid var(--line); border-radius: 3px; color: var(--muted); white-space: nowrap;
}
.v-NATIVE { color: var(--accent); font-weight: 600; }
.v-CONVERT { color: var(--warn); font-weight: 600; }
.v-ADVISE { color: var(--warn); }
.v-UNSUPPORTED { color: var(--muted); }
.v-UNKNOWN { color: var(--muted); font-style: italic; }
.v-na { color: var(--line); }
.sev-critical { color: var(--crit); font-weight: 600; }
.sev-warn { color: var(--warn); }
.sev-info { color: var(--muted); }
.loss { margin: .15rem 0 .15rem 1rem; color: var(--muted); font-size: .85rem; }
.contributor { font-size: .84rem; padding: .1rem 0 .1rem .9rem; color: var(--muted); }
.applied { color: var(--ink); font-weight: 600; }
.empty { color: var(--muted); font-style: italic; }
footer { margin-top: 3rem; padding-top: 1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: .82rem; }
`;

// ── sections ───────────────────────────────────────────────────────────────────

function header(manifest) {
  const bundle = manifest.bundle;
  return `<section class="banner">
<h1>Configuration report</h1>
<p class="sub">Local, private, redacted. Safe to screenshot.</p>
<ul>
<li>This file was written on your machine and has never left it. It contains no link, script, font or image that would load from anywhere.</li>
<li>It is rendered from a redacted bundle: every credential the scan found was replaced by a <code>{{OMEGA_REDACTED:class:ref}}</code> placeholder before this page existed. Key names, positions and counts are here; values are not.</li>
<li>Deliberate absences are listed, not silent: what was refused, what was truncated, and what could not be resolved each have a section.</li>
</ul>
<dl class="meta">
<dt>bundle</dt><dd class="mono">${esc(bundle.id)}</dd>
<dt>digest</dt><dd class="mono">${esc(bundle.digest)}</dd>
<dt>created</dt><dd>${esc(bundle.created_at)}</dd>
<dt>generator</dt><dd>${esc(`${bundle.generator} ${bundle.generator_version}`)}</dd>
<dt>payload policy</dt><dd>${esc(bundle.payload_policy)}</dd>
<dt>complete</dt><dd>${bundle.complete ? "yes — no cap was reached" : "NO — a cap was reached; see limits"}</dd>
<dt>post-export scan</dt><dd>${esc(manifest.redaction.post_export_scan?.status ?? "not recorded")}</dd>
</dl>
</section>`;
}

function environmentSection(manifest) {
  const runtimes = manifest.environment?.runtimes ?? [];
  const rows = runtimes.map((runtime) => [
    esc(runtime.display_name ?? runtime.id),
    runtime.present ? "yes" : "no",
    esc(runtime.status),
    esc(runtime.version ?? "-"),
    esc(runtime.home_label ?? "-"),
    esc(runtime.adapter_version),
    String(runtime.surfaces_declared ?? 0),
  ]);
  const projects = (manifest.projects ?? []).map((project) => [
    esc(project.project_id),
    esc(project.identity?.method ?? "-"),
    esc(project.identity?.confidence ?? "-"),
    project.identity?.stable_across_machines ? "yes" : "no",
    esc(project.label ?? "-"),
  ]);
  return `<h2>1 &nbsp;Environment</h2>
${table(["runtime", "present", "status", "version", "home", "adapter", "surfaces"], rows)}
<p class="sub">A runtime with status <em>declared</em> has not been surveyed. That is different from absent: it means detection is not implemented, so nothing about it has been checked either way.</p>
${projects.length > 0 ? `<h3>Projects</h3>${table(["project_id", "identity", "confidence", "portable id", "label"], projects)}` : ""}
${layersTable(manifest)}`;
}

function layersTable(manifest) {
  const layers = manifest.layers ?? [];
  if (layers.length === 0) return "";
  const rows = layers.map((layer) => [
    esc(layer.layer_id),
    esc(layer.scope),
    String(layer.rank),
    layer.present ? "yes" : "no",
    esc(layer.suppressed_by ?? "-"),
    esc(layer.source_label ?? "-"),
  ]);
  return `<h3>Layers</h3>${table(["layer", "scope", "rank", "present", "suppressed by", "source"], rows)}`;
}

function compatibilitySection(manifest) {
  const snapshots = manifest.capabilities ?? [];
  if (snapshots.length === 0) return "";
  const profiles = snapshots.map(profileFromSnapshot);
  const rows = matrix({ profiles });
  // A `declared` runtime is named below rather than given a column of UNKNOWN against
  // every kind: it belongs in the list (hiding it would leave a reader unable to tell
  // "we don't support it" from "you don't have it") but it is not a comparison.
  const surveyed = profiles.filter((profile) => profile.status !== "declared");
  const declaredOnly = profiles.filter((profile) => profile.status === "declared");
  const pairs = surveyed.flatMap((source) => surveyed.map((target) => [source.id, target.id]));
  const head = ["kind", ...pairs.map(([from, to]) => `${from} &rarr; ${to}`)];
  const body = rows.map((row) => [
    esc(row.kind),
    ...pairs.map(([from, to]) => {
      const cell = cellOf(rows, row.kind, from, to);
      if (!cell) return `<span class="v-na">-</span>`;
      if (!cell.applicable) return `<span class="v-na">n/a</span>`;
      return `<span class="v-${cell.verdict}">${cell.verdict}</span>`;
    }),
  ]);

  const detail = [];
  for (const [from, to] of pairs) {
    if (from === to) continue;
    const interesting = rows
      .map((row) => cellOf(rows, row.kind, from, to))
      .filter((cell) => cell && cell.applicable && (cell.losses.length > 0 || cell.inert_on_target.length > 0));
    if (interesting.length === 0) continue;
    detail.push(`<details><summary>${esc(`${from} → ${to}`)} — ${interesting.length} kind(s) with losses or inert keys</summary><div>
${interesting
  .map(
    (cell) => `<h3>${esc(cell.kind)} <span class="v-${cell.verdict}">${cell.verdict}</span>${
      cell.target_kind && cell.target_kind !== cell.kind
        ? ` <span class="tag">lands as ${esc(cell.target_kind)}</span>`
        : ""
    }</h3>
${cell.losses.map((loss) => `<p class="loss">loses ${loss.key_path ? `<code>${esc(loss.key_path)}</code>: ` : ""}${esc(loss.reason)}</p>`).join("\n")}
${
  cell.inert_on_target.length > 0
    ? `<p class="loss">kept but ignored by the target: ${cell.inert_on_target.map((key) => `<code>${esc(key)}</code>`).join(" ")}</p>`
    : ""
}
${cell.state_transfer.map((entry) => `<p class="loss">state ${esc(entry.from)} &rarr; ${esc(entry.to)} (${esc(entry.fidelity)}): ${esc(entry.note)}</p>`).join("\n")}
${cell.evidence ? `<p class="sub">${esc(cell.evidence)}</p>` : ""}`,
  )
  .join("\n")}
</div></details>`);
  }

  return `<h2>2 &nbsp;Compatibility</h2>
<p class="sub">Derived from the adapter declarations carried in this bundle, not from a hand-written table. NATIVE moves as-is; CONVERT moves with the losses listed below; ADVISE is a proposal for a human and is never applied silently; UNSUPPORTED means checked and impossible; UNKNOWN means not yet built, which is a different claim. <em>n/a</em> means neither runtime declares that kind at all.</p>
<div class="scroll">${tableRaw(head, body)}</div>
${
  declaredOnly.length > 0
    ? `<p class="sub">Also declared, and deliberately not a column: ${declaredOnly
        .map((profile) => `<strong>${esc(profile.display_name)}</strong>`)
        .join(", ")}. Detection is not implemented, so every cell against it would read UNKNOWN — which is not the same as a runtime you do not have installed.</p>`
    : ""
}
${detail.join("\n")}`;
}

function itemsSection(manifest) {
  const items = manifest.items ?? [];
  const byKind = new Map();
  for (const item of items) {
    if (!byKind.has(item.kind)) byKind.set(item.kind, []);
    byKind.get(item.kind).push(item);
  }
  const summary = [...byKind.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([kind, list]) => [esc(kind), String(list.length)]);

  const blocks = [...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, list]) => {
      const rows = list.map((item) => [
        `<code>${esc(item.name)}</code>`,
        esc(item.runtime),
        esc(item.scope),
        `<code>${esc(item.origin?.display_path ?? "-")}</code>${
          item.origin?.key_path ? `<br><span class="sub mono">${esc(item.origin.key_path)}</span>` : ""
        }`,
        `${esc(item.portability?.verdict ?? "-")}${
          (item.portability?.reasons ?? []).length > 0
            ? `<br><span class="sub">${esc(item.portability.reasons.join("; "))}</span>`
            : ""
        }`,
        `${esc(item.trust_tier)}${item.authority ? ` <span class="tag">AUTHORITY</span>` : ""}`,
        item.redaction_refs?.length > 0 ? `<span class="tag">${item.redaction_refs.length} redacted</span>` : "",
      ]);
      return `<details><summary>${esc(kind)} &nbsp;<span class="sub">${list.length}</span></summary><div class="scroll">
${tableRaw(["name", "runtime", "scope", "provenance", "portability", "trust", "secrets"], rows)}
</div></details>`;
    });

  return `<h2>3 &nbsp;Items</h2>
<p class="sub">Every item says where it came from and whether it would survive the move. PORTABLE travels unchanged; REWRITE needs a path or identifier rebuilt on the target; MACHINE-LOCAL is meaningless elsewhere; SECRET carries a credential position; DERIVED is regenerated by the runtime.</p>
${table(["kind", "count"], summary)}
${blocks.join("\n")}`;
}

function effectiveSection(manifest) {
  const rows = manifest.effective ?? [];
  const contested = rows.filter((row) => (row.contributors ?? []).length > 1);
  if (rows.length === 0) return "";
  const blocks = contested.slice(0, 200).map((row) => {
    const contributors = row.contributors
      .map(
        (contributor) =>
          `<p class="contributor${contributor.applied ? " applied" : ""}">${
            contributor.applied ? "APPLIED" : "shadowed"
          } &nbsp;rank ${contributor.rank} &nbsp;<code>${esc(contributor.item_id)}</code>${
            contributor.reason ? ` — ${esc(contributor.reason)}` : ""
          }</p>`,
      )
      .join("\n");
    return `<details><summary><code>${esc(row.key)}</code> <span class="tag">${esc(row.algebra)}</span> ${esc(
      row.runtime,
    )}${row.project_id ? ` @ ${esc(row.project_id)}` : ""}</summary><div>
<p>effective value: ${row.winner === null && (row.algebra === "concatenate" || row.algebra === "aggregate") ? `<span class="empty">no single winner — every contributor is part of the result</span>` : `<code>${esc(describeValue(row.value))}</code>`}</p>
${contributors}
${row.note ? `<p class="sub">${esc(row.note)}</p>` : ""}
</div></details>`;
  });
  return `<h2>4 &nbsp;Effective values</h2>
<p class="sub">${rows.length} row(s), ${contested.length} of them contested by more than one layer. Each contested row shows the winner, everything it shadowed, and the merge rule that decided it — which is the question a settings file cannot answer on its own.</p>
${contested.length === 0 ? `<p class="empty">No key is set in more than one place.</p>` : blocks.join("\n")}
${contested.length > 200 ? `<p class="sub">${contested.length - 200} further contested row(s) omitted from this page.</p>` : ""}`;
}

function findingsSection(manifest) {
  const findings = manifest.findings ?? [];
  if (findings.length === 0) {
    return `<h2>5 &nbsp;Findings</h2><p class="empty">No lint fired.</p>`;
  }
  const blocks = findings.map(
    (finding) => `<details><summary><span class="sev-${esc(finding.severity)}">${esc(finding.severity)}</span> &nbsp;${esc(
      finding.rule,
    )}</summary><div>
<p>${esc(finding.message)}</p>
${finding.item_id ? `<p class="sub">item: <code>${esc(finding.item_id)}</code></p>` : ""}
${finding.suggested_fix ? `<p>suggested fix: ${esc(finding.suggested_fix)}${finding.auto_fixable ? ` <span class="tag">auto-fixable</span>` : ""}</p>` : ""}
${finding.evidence ? `<p class="sub">${esc(finding.evidence)}</p>` : ""}
</div></details>`,
  );
  return `<h2>5 &nbsp;Findings</h2>
<p class="sub">${findings.length} finding(s). A finding is a condition that is true of this configuration, with the evidence for why it matters.</p>
${blocks.join("\n")}`;
}

function redactionSection(manifest) {
  const header_ = manifest.redaction;
  const records = manifest.redactions ?? [];
  const rows = records.map((record) => [
    `<code>${esc(record.ref)}</code>`,
    esc(record.class),
    esc(record.tier),
    esc(record.confidence),
    esc((record.key_names ?? []).join(", ") || "-"),
    String((record.sites ?? []).length),
  ]);
  const sites = records.flatMap((record) =>
    (record.sites ?? []).map((site) => [
      `<code>${esc(record.ref)}</code>`,
      `<code>${esc(site.item_id)}</code>`,
      `<code>${esc(site.key_path ?? "-")}</code>`,
    ]),
  );
  return `<h2>6 &nbsp;Redaction</h2>
<p><strong>${header_.distinct_secrets}</strong> distinct secret(s) across <strong>${header_.placeholder_sites}</strong> site(s). ${header_.shape_confirmed} were recognised by a detector; ${header_.positional_only} were redacted for <em>where they sat</em>, with nothing more claimed about them.</p>
<p class="sub">Values are gone. Classes, key names, positions and counts are kept on purpose: they are what makes the redaction auditable, and what lets a credential be re-bound on the target machine without ever moving it.</p>
${
  (header_.allowlisted_keys ?? []).length > 0
    ? `<p class="sub">Shown rather than hidden, because they are configuration and not credentials: ${header_.allowlisted_keys
        .map((key) => `<code>${esc(key)}</code>`)
        .join(" ")}</p>`
    : ""
}
${records.length === 0 ? `<p class="empty">Nothing matched.</p>` : tableRaw(["ref", "class", "tier", "confidence", "key names", "sites"], rows)}
${sites.length > 0 ? `<details><summary>Sites (${sites.length})</summary><div class="scroll">${tableRaw(["ref", "item", "key path"], sites)}</div></details>` : ""}`;
}

function limitsSection(manifest) {
  const exclusions = manifest.exclusions ?? [];
  const truncations = manifest.truncations ?? [];
  const unresolved = (manifest.items ?? []).filter((item) => item.kind === "unresolved_link");
  const exclusionRows = exclusions.map((record) => [
    `<code>${esc(record.rule_id)}</code>`,
    esc(record.class),
    `<span class="num">${record.matched}</span>`,
    esc(record.unit),
    String(record.bytes_skipped ?? 0),
    esc(record.reason ?? "-"),
  ]);
  return `<h2>7 &nbsp;Refusals and limits</h2>
<p class="sub">Deliberate absence is data. Everything below was left out on purpose, with the rule that decided it and the unit it was counted in — silence here would be the bug.</p>
<h3>Never exported</h3>
${
  exclusions.length === 0
    ? `<p class="empty">No never-export rule fired.</p>`
    : `<div class="scroll">${tableRaw(["rule", "class", "matched", "unit", "bytes", "reason"], exclusionRows)}</div>`
}
<h3>Truncations</h3>
${
  truncations.length === 0
    ? `<p class="empty">Nothing was truncated.</p>`
    : table(
        ["path", "bytes on disk", "kept", "cap", "reason"],
        truncations.map((record) => [
          esc(record.display_path),
          String(record.bytes),
          String(record.kept_bytes),
          String(record.cap),
          esc(record.reason),
        ]),
      )
}
<h3>Unresolved links</h3>
${
  unresolved.length === 0
    ? `<p class="empty">Every symlink resolved inside a declared root.</p>`
    : table(
        ["name", "target", "refusal"],
        unresolved.map((item) => [
          esc(item.name),
          esc(item.origin?.link?.target_display ?? "?"),
          esc(item.origin?.link?.refusal ?? "?"),
        ]),
      )
}`;
}

function footer(manifest) {
  return `<footer>
<p>Rendered from bundle <span class="mono">${esc(manifest.bundle.id)}</span> (<span class="mono">${esc(
    manifest.bundle.digest,
  )}</span>) by ${esc(manifest.bundle.generator)} ${esc(manifest.bundle.generator_version)}.</p>
<p>No account, no network, no telemetry. This page loads nothing and runs no script.</p>
</footer>`;
}

// ── helpers ────────────────────────────────────────────────────────────────────

function table(headers, rows) {
  return tableRaw(headers.map(esc), rows.map((row) => row.map((cell) => cell)));
}

function tableRaw(headers, rows) {
  if (rows.length === 0) return `<p class="empty">none</p>`;
  const head = headers.map((header_) => `<th>${header_}</th>`).join("");
  const body = rows.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("\n");
  return `<table><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

function describeValue(value) {
  if (value === null || value === undefined) return "(none)";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

/**
 * Escaping is the whole safety story for content: a config value is data, and it lands in
 * a text node with every character that could open a tag or an attribute neutralised. The
 * forward slash is escaped too, so a value containing `</style>` or a scheme can never
 * close an element or be mistaken for markup by a lenient parser.
 */
export function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;")
    .replaceAll("/", "&#47;");
}
