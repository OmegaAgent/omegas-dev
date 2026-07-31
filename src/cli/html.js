// `continuity report --html` — the local, private, self-contained visualizer.
//
// THREE PROPERTIES, ALL STRUCTURAL RATHER THAN PROMISED:
//
// 1. It is rendered from a REDACTED BUNDLE and nothing else. The only entry point takes a
//    bundle PATH, reads it through the same verifying reader an importer uses, and hands
//    the manifest to a renderer that rejects anything which is not one. A raw scan result
//    carries `_raw_text` on every item and has no `schema_version`; it cannot reach this
//    module even by mistake, which is the point — a screenshot of a raw scan is the leak
//    (THR §3.5, T-R8).
// 2. It makes no NETWORK request. There is no <script src>, no <link>, no @import, no
//    remote url(), no analytics, no telemetry, and no JavaScript at all — collapsing
//    sections are <details> elements, which are markup. The one font is embedded as a
//    `data:` URI (bytes carried inline, never fetched) and the page texture is drawn in
//    CSS. A restrictive CSP is declared as well, so the file is inert if later edited.
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
import { SCHIBSTED_GROTESK_WOFF_BASE64 } from "./report-font.js";

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
    masthead(manifest),
    verdictSection(manifest),
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
        `${JSON.stringify(manifest.schema_version)}. Run \`continuity export\` first — a raw scan result must ` +
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
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; font-src data:; base-uri 'none'; form-action 'none'">
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

// Daylight, pulled 1:1 from the live omegas.dev tokens (apps/web/src/styles/app.css):
// zinc-neutral base, one saturated color (foliage green), oak for a small mark, the dot
// lattice as the band material, radius capped at 10px. The font is embedded, not linked.
const STYLE = `
@font-face {
  font-family: "Schibsted Grotesk";
  font-style: normal;
  font-weight: 400 800;
  font-display: swap;
  src: url(data:font/woff;base64,${SCHIBSTED_GROTESK_WOFF_BASE64}) format("woff");
}
:root {
  color-scheme: light dark;
  --canvas: #ffffff; --stone: #fafafa; --ink: #09090b; --muted: #71717a;
  --green: #3d6b44; --green-deep: #33593a; --oak: #b98a4a;
  --border: #e4e4e7; --scrim: 9, 9, 11; --dot: #e7e7ea;
  --radius: 10px;
}
@media (prefers-color-scheme: dark) {
  :root {
    --canvas: #0a0a0b; --stone: #17171a; --ink: #f4f4f5; --muted: #a1a1aa;
    --green: #4c8455; --green-deep: #4c8455; --oak: #c79a5c;
    --border: #27272a; --scrim: 0, 0, 0; --dot: #1e1e23;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0; padding: 0; color: var(--ink);
  background-color: var(--stone);
  background-image: radial-gradient(var(--dot) 1.3px, transparent 1.4px);
  background-size: 22px 22px; background-position: -1px -1px;
  font-family: "Schibsted Grotesk", system-ui, -apple-system, Segoe UI, sans-serif;
  font-size: 16.5px; line-height: 1.6; font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
}
main { max-width: 64rem; margin: 0 auto; padding: 2.5rem 1.25rem 5rem; }
h1 { font-size: clamp(2rem, 4.5vw, 2.9rem); line-height: 1.08; letter-spacing: -0.022em; font-weight: 700; margin: 0; }
h2 { font-size: 1.35rem; letter-spacing: -0.015em; font-weight: 650; margin: 3.25rem 0 1rem; }
h3 { font-size: .95rem; font-weight: 600; margin: 1.5rem 0 .5rem; color: var(--muted); }
p { margin: .55rem 0; }
a { color: inherit; }
.lede { font-size: 1.15rem; line-height: 1.5; color: var(--muted); max-width: 46rem; margin: 1rem 0 0; }
.lede strong { color: var(--ink); font-weight: 600; }
.muted { color: var(--muted); }
.section-note { color: var(--muted); font-size: .95rem; max-width: 52rem; margin: .4rem 0 1.25rem; }

/* wordmark */
.mark { display: flex; align-items: baseline; gap: .55rem; margin-bottom: 2.25rem; }
.mark .word { font-weight: 650; font-size: 1.05rem; letter-spacing: -0.01em; }
.mark .omega { color: var(--green); }
.mark .omega svg { width: .72em; height: .71em; display: inline-block; vertical-align: baseline; }
.mark .sep { color: var(--border); }
.mark .ctx { color: var(--muted); font-weight: 500; font-size: 1.05rem; }

/* chips */
.chips { display: flex; flex-wrap: wrap; gap: .4rem; margin: 1.4rem 0 0; }
.chip { display: inline-flex; align-items: center; gap: .4rem; font-size: .8rem; color: var(--muted);
  border: 1px solid var(--border); border-radius: 999px; padding: .28rem .7rem; background: var(--canvas); }
.chip .dot { width: .42rem; height: .42rem; border-radius: 999px; background: var(--green); flex: none; }

/* verdict buckets */
.buckets { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; margin: 2rem 0 0; }
@media (max-width: 46rem) { .buckets { grid-template-columns: 1fr; } }
.bucket { background: var(--canvas); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.4rem 1.35rem; }
.bucket .cap { display: flex; align-items: center; gap: .5rem; font-size: .82rem; font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.bucket .cap .dot { width: .55rem; height: .55rem; border-radius: 999px; flex: none; }
.bucket .n { font-size: 2.6rem; line-height: 1; font-weight: 700; letter-spacing: -0.03em; margin: .7rem 0 .1rem; }
.bucket .of { color: var(--muted); font-size: .9rem; }
.bucket .desc { margin: .7rem 0 .5rem; font-size: .95rem; }
.bucket .kinds { color: var(--muted); font-size: .86rem; }
.b-moves .n, .b-moves .cap .dot { color: var(--green); }
.b-moves .cap .dot { background: var(--green); }
.b-review .n { color: var(--oak); }
.b-review .cap .dot { background: var(--oak); }
.b-stays .n { color: var(--ink); }
.b-stays .cap .dot { background: var(--muted); }

/* generic surfaces */
.card { background: var(--canvas); border: 1px solid var(--border); border-radius: var(--radius); padding: 1.1rem 1.25rem; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1.25rem; margin: 0; font-size: .9rem; }
dl.meta dt { color: var(--muted); }
dl.meta dd { margin: 0; }
table { width: 100%; border-collapse: collapse; margin: .5rem 0 1rem; font-size: .9rem; }
th, td { text-align: left; padding: .55rem .7rem; border-bottom: 1px solid var(--border); vertical-align: top; }
thead th { color: var(--muted); font-weight: 600; white-space: nowrap; font-size: .82rem; letter-spacing: .02em; text-transform: uppercase; }
tbody tr:last-child td { border-bottom: none; }
td.num { text-align: right; }
.scroll { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); background: var(--canvas); }
.scroll table { margin: 0; }
.scroll th, .scroll td { padding-left: 1rem; padding-right: 1rem; }
code, .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .84em; }
code { background: var(--stone); padding: .1em .38em; border-radius: 5px; word-break: break-all; border: 1px solid var(--border); }
details { border: 1px solid var(--border); border-radius: var(--radius); background: var(--canvas); margin: .6rem 0; overflow: hidden; }
details > summary { cursor: pointer; padding: .7rem .95rem; font-weight: 600; font-size: .92rem; list-style: none; }
details > summary::-webkit-details-marker { display: none; }
details > summary::before { content: "›"; display: inline-block; width: 1em; color: var(--muted); transition: none; }
details[open] > summary::before { content: "⌄"; }
details[open] > summary { border-bottom: 1px solid var(--border); }
details > div { padding: .85rem .95rem; }
.tag { display: inline-block; font-size: .74rem; letter-spacing: .02em; padding: .12em .5em; border: 1px solid var(--border);
  border-radius: 6px; color: var(--muted); white-space: nowrap; background: var(--stone); }
.v-NATIVE { color: var(--green); font-weight: 600; }
.v-CONVERT { color: var(--oak); font-weight: 600; }
.v-ADVISE { color: var(--oak); }
.v-UNSUPPORTED { color: var(--muted); }
.v-UNKNOWN { color: var(--muted); font-style: italic; }
.v-na { color: var(--border); }
.sev-critical { color: #8c2f2f; font-weight: 600; }
.sev-warn { color: var(--oak); }
.sev-info { color: var(--muted); }
.loss { margin: .15rem 0 .15rem 1rem; color: var(--muted); font-size: .9rem; }
.contributor { font-size: .88rem; padding: .12rem 0 .12rem 1rem; color: var(--muted); }
.applied { color: var(--ink); font-weight: 600; }
.empty { color: var(--muted); font-style: italic; }
footer { margin-top: 3.5rem; padding-top: 1.25rem; border-top: 1px solid var(--border); color: var(--muted); font-size: .86rem; }
`;

// ── masthead ─────────────────────────────────────────────────────────────────

// The canonical Ω mark (custom SVG per the design system — never the font's own glyph).
const OMEGA =
  '<svg viewBox="0 0 358 358" fill="none" aria-hidden="true"><path fill="currentColor" d="M179 7C273.924 7 350.876 84.007 350.876 179C350.876 224.943 332.875 266.677 303.548 297.529H343.751C351.621 297.529 358 303.912 358 311.788V336.741C358 344.616 351.621 351 343.751 351H219.075V290.57C264.767 274.131 297.443 230.385 297.443 179C297.443 113.539 244.414 60.4715 179 60.4715C113.586 60.4715 60.5572 113.539 60.5572 179C60.5572 230.385 93.2333 274.131 138.925 290.57V351H14.2488C6.37939 351 4.01632e-07 344.616 0 336.741V311.788C0 303.912 6.37939 297.529 14.2488 297.529H54.4521C25.125 266.677 7.12438 224.943 7.12438 179C7.12438 84.007 84.0757 7 179 7Z"/></svg>';

function masthead() {
  // Wordmark: the custom Ω SVG stands in for the "o" (never the font's own glyph), then
  // "megas", then the product context. No kicker label above the verdict — the wordmark
  // already names the document and the verdict headline carries the page.
  return `<div class="mark"><span class="word"><span class="omega">${OMEGA}</span>megas</span><span class="sep">/</span><span class="ctx">Continuity</span></div>`;
}

// ── verdict + buckets ──────────────────────────────────────────────────────────

const KIND_LABELS = {
  instructions: ["instruction file", "instruction files"],
  skill: ["skill", "skills"],
  command: ["command", "commands"],
  mcp_server: ["MCP server", "MCP servers"],
  hook: ["hook", "hooks"],
  hook_script: ["hook script", "hook scripts"],
  subagent: ["subagent", "subagents"],
  memory: ["memory file", "memory files"],
  setting: ["setting", "settings"],
  permission_rule: ["permission rule", "permission rules"],
  sandbox_profile: ["sandbox profile", "sandbox profiles"],
  rule_script: ["rule script", "rule scripts"],
  plugin: ["plugin", "plugins"],
  marketplace: ["marketplace", "marketplaces"],
  statusline: ["status line", "status lines"],
  keybindings: ["keybinding set", "keybinding sets"],
  output_style: ["output style", "output styles"],
  unresolved_link: ["unresolved link", "unresolved links"],
};

function kindLabel(kind, count) {
  const pair = KIND_LABELS[kind];
  if (pair) return count === 1 ? pair[0] : pair[1];
  return `${kind.replaceAll("_", " ")}${count === 1 ? "" : "s"}`;
}

function topKinds(list, n = 4) {
  const counts = new Map();
  for (const item of list) counts.set(item.kind, (counts.get(item.kind) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, n).map(([kind, count]) => `${count} ${esc(kindLabel(kind, count))}`);
  const rest = sorted.slice(n).reduce((sum, [, count]) => sum + count, 0);
  if (rest > 0) head.push(`${rest} more`);
  return head.join(" · ");
}

/**
 * The three buckets a non-expert actually wants: what moves, what to look at, what stays.
 * Derived from the same portability verdict and trust tier the detailed sections show — so
 * the headline and the tables can never disagree.
 */
function classifyItems(manifest) {
  const buckets = { moves: [], review: [], stays: [] };
  for (const item of manifest.items ?? []) {
    const verdict = item.portability?.verdict;
    const hasSecret = (item.redaction_refs ?? []).length > 0 || verdict === "SECRET";
    if (item.kind === "unresolved_link" || verdict === "MACHINE-LOCAL" || verdict === "DERIVED") {
      buckets.stays.push(item);
    } else if (item.trust_tier === "EXECUTABLE" || item.authority || verdict === "REWRITE" || hasSecret) {
      buckets.review.push(item);
    } else {
      buckets.moves.push(item);
    }
  }
  return buckets;
}

function verdictSection(manifest) {
  const { moves, review, stays } = classifyItems(manifest);
  const total = moves.length + review.length + stays.length;
  const protectedCount = (manifest.exclusions ?? []).reduce((sum, record) => sum + (record.matched ?? 0), 0);

  const runtimes = (manifest.environment?.runtimes ?? []).filter((r) => r.present).map((r) => r.display_name ?? r.id);
  const runtimeLine =
    runtimes.length === 0 ? "your setup" : runtimes.length === 1 ? runtimes[0] : `${runtimes.slice(0, -1).join(", ")} and ${runtimes[runtimes.length - 1]}`;

  const lede =
    `Scanned <strong>${runtimeLine}</strong> on this machine. ` +
    `<strong>${moves.length}</strong> item${moves.length === 1 ? "" : "s"} move as-is, ` +
    `<strong>${review.length}</strong> need${review.length === 1 ? "s" : ""} a quick look, and ` +
    `<strong>${stays.length}</strong> stay here by design. ` +
    (protectedCount > 0 ? `${protectedCount} protected item${protectedCount === 1 ? "" : "s"} — credentials, history, trust state — were never packed.` : "");

  const headline =
    total === 0
      ? "Nothing to move yet."
      : `${moves.length} of ${total} items are ready to move.`;

  return `<section>
<h1>${esc(headline)}</h1>
<p class="lede">${lede}</p>
<div class="chips">
<span class="chip"><span class="dot"></span>On your machine</span>
<span class="chip"><span class="dot"></span>Redacted — no values</span>
<span class="chip"><span class="dot"></span>No network, no script</span>
<span class="chip"><span class="dot"></span>Safe to screenshot</span>
</div>
<div class="buckets">
<div class="bucket b-moves">
<div class="cap"><span class="dot"></span>Moves as-is</div>
<div class="n">${moves.length}</div>
<p class="desc">Travel unchanged and land ready to use. Nothing to do.</p>
<p class="kinds">${moves.length ? topKinds(moves) : "&mdash;"}</p>
</div>
<div class="bucket b-review">
<div class="cap"><span class="dot"></span>Needs your review</div>
<div class="n">${review.length}</div>
<p class="desc">Import switched off, or need a path or credential rebuilt. You approve each one.</p>
<p class="kinds">${review.length ? topKinds(review) : "&mdash;"}</p>
</div>
<div class="bucket b-stays">
<div class="cap"><span class="dot"></span>Stays on this machine</div>
<div class="n">${stays.length}</div>
<p class="desc">Machine-specific or protected${protectedCount > 0 ? `, plus ${protectedCount} file${protectedCount === 1 ? "" : "s"} never packed` : ""}. Never moves.</p>
<p class="kinds">${stays.length ? topKinds(stays) : "&mdash;"}</p>
</div>
</div>
<p class="section-note" style="margin-top:1.5rem">Local, private, redacted. Safe to screenshot. This file was written on your machine and has never left it — no link, script, font or image loads from anywhere, and every credential the scan found was replaced by a placeholder before this page existed. Below: the full record, including everything left out on purpose.</p>
</section>`;
}

// ── sections ───────────────────────────────────────────────────────────────────

function environmentSection(manifest) {
  const bundle = manifest.bundle;
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
<div class="card"><dl class="meta">
<dt>bundle</dt><dd class="mono">${esc(bundle.id)}</dd>
<dt>digest</dt><dd class="mono">${esc(bundle.digest)}</dd>
<dt>created</dt><dd>${esc(bundle.created_at)}</dd>
<dt>generator</dt><dd>${esc(`${bundle.generator} ${bundle.generator_version}`)}</dd>
<dt>payload policy</dt><dd>${esc(bundle.payload_policy)}</dd>
<dt>complete</dt><dd>${bundle.complete ? "yes — no cap was reached" : "NO — a cap was reached; see limits"}</dd>
<dt>post-export scan</dt><dd>${esc(manifest.redaction.post_export_scan?.status ?? "not recorded")}</dd>
</dl></div>
<div class="scroll" style="margin-top:1rem">${table(["runtime", "present", "status", "version", "home", "adapter", "surfaces"], rows)}</div>
<p class="section-note">A runtime with status <em>declared</em> has not been surveyed. That is different from absent: detection is not implemented, so nothing about it has been checked either way.</p>
${projects.length > 0 ? `<h3>Projects</h3><div class="scroll">${table(["project_id", "identity", "confidence", "portable id", "label"], projects)}</div>` : ""}
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
  return `<h3>Layers</h3><div class="scroll">${table(["layer", "scope", "rank", "present", "suppressed by", "source"], rows)}</div>`;
}

function compatibilitySection(manifest) {
  const snapshots = manifest.capabilities ?? [];
  if (snapshots.length === 0) return "";
  const profiles = snapshots.map(profileFromSnapshot);
  const rows = matrix({ profiles });
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
${cell.evidence ? `<p class="section-note">${esc(cell.evidence)}</p>` : ""}`,
  )
  .join("\n")}
</div></details>`);
  }

  return `<h2>2 &nbsp;Compatibility</h2>
<p class="section-note">In plain terms: on the same machine everything moves. Between runtimes, skills move unchanged, most things convert with the small losses spelled out below, permissions are advice you review, and a few things have no equivalent. Every verdict here is <em>derived</em> from the adapter declarations in this bundle, not a hand-written table — <span class="v-NATIVE">NATIVE</span> moves as-is, <span class="v-CONVERT">CONVERT</span> moves with the listed losses, <span class="v-ADVISE">ADVISE</span> is a proposal a human applies, UNSUPPORTED means checked and impossible, UNKNOWN means not yet built, and <em>n/a</em> means neither runtime declares that kind.</p>
<div class="scroll">${tableRaw(head, body)}</div>
${
  declaredOnly.length > 0
    ? `<p class="section-note">Also declared, and deliberately not a column: ${declaredOnly
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
  const blocks = [...byKind.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, list]) => {
      const rows = list.map((item) => [
        `<code>${esc(item.name)}</code>`,
        esc(item.runtime),
        esc(item.scope),
        `<code>${esc(item.origin?.display_path ?? "-")}</code>${
          item.origin?.key_path ? `<br><span class="muted mono">${esc(item.origin.key_path)}</span>` : ""
        }`,
        `${esc(item.portability?.verdict ?? "-")}${
          (item.portability?.reasons ?? []).length > 0
            ? `<br><span class="muted">${esc(item.portability.reasons.join("; "))}</span>`
            : ""
        }`,
        `${esc(item.trust_tier)}${item.authority ? ` <span class="tag">AUTHORITY</span>` : ""}`,
        item.redaction_refs?.length > 0 ? `<span class="tag">${item.redaction_refs.length} redacted</span>` : "",
      ]);
      return `<details><summary>${esc(kindLabel(kind, list.length))} &nbsp;<span class="muted">${list.length}</span></summary><div class="scroll">
${tableRaw(["name", "runtime", "scope", "provenance", "portability", "trust", "secrets"], rows)}
</div></details>`;
    });

  return `<h2>3 &nbsp;Items</h2>
<p class="section-note">Every item says where it came from and whether it survives the move. PORTABLE travels unchanged; REWRITE needs a path or identifier rebuilt on the target; MACHINE-LOCAL is meaningless elsewhere; SECRET carries a credential position; DERIVED is regenerated by the runtime.</p>
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
${row.note ? `<p class="section-note">${esc(row.note)}</p>` : ""}
</div></details>`;
  });
  return `<h2>4 &nbsp;Effective values</h2>
<p class="section-note">${rows.length} row(s), ${contested.length} of them contested by more than one layer. Each contested row shows the winner, everything it shadowed, and the merge rule that decided it — the question a settings file cannot answer on its own.</p>
${contested.length === 0 ? `<p class="empty">No key is set in more than one place.</p>` : blocks.join("\n")}
${contested.length > 200 ? `<p class="section-note">${contested.length - 200} further contested row(s) omitted from this page.</p>` : ""}`;
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
${finding.item_id ? `<p class="section-note">item: <code>${esc(finding.item_id)}</code></p>` : ""}
${finding.suggested_fix ? `<p>suggested fix: ${esc(finding.suggested_fix)}${finding.auto_fixable ? ` <span class="tag">auto-fixable</span>` : ""}</p>` : ""}
${finding.evidence ? `<p class="section-note">${esc(finding.evidence)}</p>` : ""}
</div></details>`,
  );
  return `<h2>5 &nbsp;Findings</h2>
<p class="section-note">${findings.length} finding(s). A finding is a condition that is true of this configuration, with the evidence for why it matters.</p>
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
<p class="section-note">Values are gone. Classes, key names, positions and counts are kept on purpose: they are what makes the redaction auditable, and what lets a credential be re-bound on the target machine without ever moving it.</p>
${
  (header_.allowlisted_keys ?? []).length > 0
    ? `<p class="section-note">Shown rather than hidden, because they are configuration and not credentials: ${header_.allowlisted_keys
        .map((key) => `<code>${esc(key)}</code>`)
        .join(" ")}</p>`
    : ""
}
${records.length === 0 ? `<p class="empty">Nothing matched.</p>` : `<div class="scroll">${tableRaw(["ref", "class", "tier", "confidence", "key names", "sites"], rows)}</div>`}
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
<p class="section-note">Deliberate absence is data. Everything below was left out on purpose, with the rule that decided it and the unit it was counted in — silence here would be the bug.</p>
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
    : `<div class="scroll">${table(
        ["path", "bytes on disk", "kept", "cap", "reason"],
        truncations.map((record) => [
          esc(record.display_path),
          String(record.bytes),
          String(record.kept_bytes),
          String(record.cap),
          esc(record.reason),
        ]),
      )}</div>`
}
<h3>Unresolved links</h3>
${
  unresolved.length === 0
    ? `<p class="empty">Every symlink resolved inside a declared root.</p>`
    : `<div class="scroll">${table(
        ["name", "target", "refusal"],
        unresolved.map((item) => [
          esc(item.name),
          esc(item.origin?.link?.target_display ?? "?"),
          esc(item.origin?.link?.refusal ?? "?"),
        ]),
      )}</div>`
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
