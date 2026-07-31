// `continuity export` — the one artifact, and it is the redacted one.
//
// Order of operations is the security property (THR §3.5): build the bundle in memory,
// re-scan the SERIALIZED BYTES with the full detector, and only then touch the disk. A
// HIGH-tier hit means a plumbing bug somewhere upstream, so nothing is written at all and
// the command exits 5. There is no `--include-secrets` and no second file.
//
// Three artifacts land, and they are deliberately easy to tell apart (T-E2):
//   omegas-continuity-local-<date>.ocb.jsonl   the bundle       — shareable
//   redaction-review-local-<date>.md           the local report — 0600, never share
//   secrets/<bundle-id>.map.json               pointers + salt  — 0600, never share

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { SCHEMA_VERSION, buildBundle } from "../core/bundle/write.js";
import { continuityStateDir } from "../core/fsx/paths.js";
import { postExportScan } from "../core/redact/index.js";
import { renderRedactionReport, redactionSummary } from "../core/redact/report.js";
import { writeSecretMap } from "../core/redact/secretmap.js";
import { GLOBAL_NEVER_EXPORT } from "../core/policy/caps.js";
import { counts, table, warningsFor } from "./scan.js";

export const GENERATOR_VERSION = "0.2.0";
const ARTIFACT_MODE = 0o600;

export const EXIT_REDACTION_GATE = 5;

/**
 * The command. Build, gate, and only then write — so a gate failure leaves the filesystem
 * exactly as it was, with no partial artifact for a user to mistake for a safe one.
 */
export async function runExport({ options, result, env, adapters, code, io, refuse = false }) {
  if (refuse || result.runtimes.every((runtime) => !runtime.present)) {
    io.stderr(
      result.runtimes.some((runtime) => runtime.version_incompatible)
        ? "a runtime is below its adapter's supported floor; its format may not be what this version reads, so nothing was exported\n"
        : "no supported runtime was found on this machine; nothing to export\n",
    );
    return code;
  }
  let built;
  try {
    built = assembleBundle({ result, env, adapters, payloadPolicy: options.payloadPolicy });
  } catch (error) {
    if (!(error instanceof ExportGateError)) throw error;
    io.stderr(`${error.message}\n`);
    for (const hit of error.scan.hits.slice(0, 10)) {
      io.stderr(`  ${hit.kind}: ${hit.class ?? "unknown"} (${hit.tier})\n`);
    }
    io.stderr("This is a bug in the redaction pass, not in your configuration. Please report it.\n");
    return EXIT_REDACTION_GATE;
  }

  const paths = await writeArtifacts({
    result,
    env,
    built,
    outPath: options.out ? path.resolve(options.out) : null,
  });
  if (options.json) {
    io.stdout(`${JSON.stringify(exportEnvelope({ code, result, env, built, paths }), null, 2)}\n`);
    return code;
  }
  io.stdout(renderExport({ result, built, paths }));
  return code;
}

export function stateDir(homeDir) {
  return continuityStateDir(homeDir);
}

export function bundleId(now = new Date(), random = randomBytes(6)) {
  return `ocb_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${Buffer.from(random).toString("hex")}`;
}

export function defaultBundlePath(homeDir, now = new Date()) {
  return path.join(stateDir(homeDir), `omegas-continuity-local-${stamp(now)}.ocb.jsonl`);
}

export function defaultReportPath(homeDir, now = new Date()) {
  // A different basename STEM, not a different extension: `…-bundle.md` next to
  // `…-bundle.jsonl` is exactly the confusion T-E2 is about.
  return path.join(stateDir(homeDir), `redaction-review-local-${stamp(now)}.md`);
}

function stamp(now) {
  return now.toISOString().slice(0, 10).replace(/-/g, "");
}

export class ExportGateError extends Error {
  constructor(scan) {
    super(
      `post-export scan FAILED: ${scan.high_tier_hits} HIGH-tier hit(s) in the serialized bundle. ` +
        `No file was written.`,
    );
    this.name = "ExportGateError";
    this.scan = scan;
  }
}

/**
 * Builds the bundle and runs the gate. Pure with respect to the filesystem so a test can
 * assert the refusal without a directory to clean up.
 */
export function assembleBundle({ result, env, adapters, payloadPolicy, now = new Date(), id = bundleId(now) }) {
  const build = (redactionHeader) =>
    buildBundle({
      bundleId: id,
      createdAt: now.toISOString(),
      generatorVersion: GENERATOR_VERSION,
      items: result.items,
      layers: result.layers,
      effective: result.effective,
      redactions: result.redactions,
      redactionHeader,
      findings: result.findings,
      exclusions: result.exclusions,
      truncations: result.truncations,
      runtimes: result.runtimes,
      projects: result.projects,
      capabilities: capabilitiesOf(adapters),
      neverExport: neverExportOf(adapters),
      environment: { host: { os: env.os, arch: process.arch, home_label: "~" } },
      payloadPolicy,
      assetTexts: result.asset_texts ?? new Map(),
      caps: env.caps,
      complete: result.complete,
    });

  const secrets = result.secret_values ?? new Set();
  const draft = build(result.redaction);
  const first = postExportScan(draft.serialized, secrets);
  if (first.status !== "passed") throw new ExportGateError(first);

  // The header records that the gate ran, and the header is inside the digest — so the
  // stamped bundle is a different byte string from the one just scanned. It is scanned
  // again. "Re-scan the serialized bytes" has to mean the bytes that reach the disk.
  const stamped = build({ ...result.redaction, post_export_scan: { status: "passed", high_tier_hits: 0 } });
  const scan = postExportScan(stamped.serialized, secrets);
  if (scan.status !== "passed") throw new ExportGateError(scan);
  return { ...stamped, scan };
}

export async function writeArtifacts({ result, env, built, outPath, reportPath, now }) {
  const bundlePath = outPath ?? defaultBundlePath(env.homeDir, now);
  const review = reportPath ?? defaultReportPath(env.homeDir, now);
  await mkdir(path.dirname(bundlePath), { recursive: true, mode: 0o700 });
  await mkdir(path.dirname(review), { recursive: true, mode: 0o700 });

  await refuseToClobber(bundlePath);
  await writeAtomic(bundlePath, built.serialized);
  const report = renderRedactionReport({
    header: built.manifest.redaction,
    redactions: result.redactions,
    exclusions: result.exclusions,
    truncations: result.truncations,
    shapes: result.secret_shapes ?? new Map(),
    bundle: { path: bundlePath, digest: built.manifest.bundle.digest },
  });
  await writeAtomic(review, report);
  const mapPath = await writeSecretMap({
    stateDir: stateDir(env.homeDir),
    bundleId: built.manifest.bundle.id,
    map: result.secret_map,
    secretValues: result.secret_values ?? new Set(),
  });
  return { bundlePath, reportPath: review, secretMapPath: mapPath };
}

/**
 * Re-exporting replaces yesterday's bundle, which is the point. Replacing something that
 * is NOT a bundle is a typo in `--out` destroying a file, so the target is read first and
 * has to identify itself before it can be overwritten.
 */
async function refuseToClobber(target) {
  const existing = await readFile(target, "utf8").catch(() => null);
  if (existing === null || existing.trim().length === 0) return;
  const firstLine = existing.slice(0, existing.indexOf("\n") + 1 || undefined);
  let looksLikeBundle = false;
  try {
    looksLikeBundle = JSON.parse(firstLine).schema_version === SCHEMA_VERSION;
  } catch {
    looksLikeBundle = false;
  }
  if (!looksLikeBundle) {
    throw new Error(`${target} exists and is not a Continuity bundle; refusing to overwrite it`);
  }
}

/**
 * Temp file plus rename, so a reader never sees a half-written bundle and the mode is
 * right from the moment the bytes exist rather than one syscall later.
 */
async function writeAtomic(target, text) {
  const temporary = `${target}.tmp-${randomBytes(4).toString("hex")}`;
  await writeFile(temporary, text, { mode: ARTIFACT_MODE, flag: "wx" });
  await rename(temporary, target);
}

/**
 * The compatibility snapshot (milestone M4). It carries everything `compat/derive.js`
 * reads — capability levels, the declared surfaces with their formats, and the transform
 * descriptors — so the matrix in a report is DERIVED from the bundle months later rather
 * than trusted from whatever version happens to be installed then. It is also why the
 * HTML report can be a pure function of a bundle file.
 */
export function capabilitiesOf(adapters) {
  return adapters.map((adapter) => ({
    runtime: adapter.id,
    display_name: adapter.display_name ?? adapter.id,
    adapter_version: adapter.adapter_version,
    status: adapter.status,
    kinds: adapter.capabilities ?? {},
    surfaces: (adapter.surfaces ?? []).map((surface) => ({
      surface_id: surface.surface_id,
      kind: surface.kind,
      format: surface.format,
    })),
    transforms: adapter.transforms ?? [],
  }));
}

export function neverExportOf(adapters) {
  const rules = [...adapters.flatMap((adapter) => adapter.never_export ?? []), ...GLOBAL_NEVER_EXPORT];
  return rules.map((rule) => ({
    rule_id: rule.rule_id,
    match: rule.match,
    class: rule.class,
    severity: rule.severity,
    reason: rule.reason,
  }));
}

export function exportEnvelope({ code, result, env, built, paths }) {
  return {
    ok: code === 0 || code === 3,
    code,
    command: "export",
    schema_version: built.manifest.schema_version,
    complete: built.manifest.bundle.complete,
    bundle: {
      id: built.manifest.bundle.id,
      digest: built.manifest.bundle.digest,
      entry_count: built.manifest.bundle.entry_count,
      byte_count: built.manifest.bundle.byte_count,
      payload_policy: built.manifest.bundle.payload_policy,
      path: paths.bundlePath,
    },
    redaction: built.manifest.redaction,
    redaction_summary: redactionSummary({ header: built.manifest.redaction, redactions: result.redactions }),
    report_path: paths.reportPath,
    secret_map_path: paths.secretMapPath,
    counts: counts(result),
    exclusions: result.exclusions,
    truncations: result.truncations,
    warnings: warningsFor(result),
    environment: { host: { os: env.os, home_label: "~" }, runtimes: result.runtimes },
  };
}

export function renderExport({ result, built, paths }) {
  const summary = redactionSummary({ header: built.manifest.redaction, redactions: result.redactions });
  const lines = [];
  lines.push(`bundle              ${paths.bundlePath}`);
  lines.push(`digest              ${built.manifest.bundle.digest}`);
  lines.push(`entries             ${built.manifest.bundle.entry_count} (${built.manifest.bundle.byte_count} bytes)`);
  lines.push(`payload policy      ${built.manifest.bundle.payload_policy}`);
  lines.push(`post-export scan    ${built.manifest.redaction.post_export_scan.status}`);
  lines.push("");
  lines.push(
    `redacted            ${summary.distinct_secrets} distinct secret(s) across ${summary.placeholder_sites} site(s)`,
  );
  lines.push(`  shape-confirmed   ${summary.shape_confirmed}`);
  lines.push(`  positional only   ${summary.positional_only}`);
  if (summary.classes.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["class", "tier", "refs", "sites"],
        summary.classes.map((entry) => [entry.class, entry.tier, String(entry.refs), String(entry.sites)]),
      ),
    );
  }
  if (result.exclusions.length > 0) {
    lines.push("");
    lines.push(
      table(
        ["never-exported", "matched", "unit", "bytes"],
        result.exclusions.map((record) => [
          record.rule_id,
          String(record.matched),
          record.unit,
          String(record.bytes_skipped),
        ]),
      ),
    );
  }
  if (result.truncations.length > 0) {
    lines.push("");
    for (const record of result.truncations) {
      lines.push(`Warning: truncated ${record.display_path} at ${record.cap} bytes (${record.bytes} on disk)`);
    }
  }
  lines.push("");
  lines.push(`local report        ${paths.reportPath}   (0600 — contains more than the bundle)`);
  lines.push(`secret map          ${paths.secretMapPath}   (0600 — pointers only, never values)`);
  lines.push("");
  lines.push("The bundle carries placeholders, never values. Nothing was uploaded.");
  return `${lines.join("\n")}\n`;
}
