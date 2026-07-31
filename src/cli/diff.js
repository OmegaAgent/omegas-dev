// `continuity diff --bundle <path>` — the preview, and nothing but the preview.
//
// This command writes nothing. Not a staging directory, not a ledger line, not a temp
// file. That is asserted by a test that byte-compares the whole target home before and
// after, because "preview is read-only" is the promise the entire consent model rests on:
// if running the preview could change the machine, reviewing a plan would itself be an
// action requiring consent.
//
// The renderer's ordering is the one THR R4 asks for — authority and executable items
// first and always expanded, inert content after — because review fatigue is the real
// exploit, and a long diff that buries the dangerous line is an unread diff.

import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { readBundle } from "../core/bundle/read.js";
import { BundleError } from "../core/bundle/names.js";
import { planImport, publicPlan } from "../core/engine/emit.js";
import { table } from "./scan.js";

export const IMPORT_EXIT = {
  OK: 0,
  USAGE: 1,
  WARNINGS: 3,
  INTEGRITY: 6,
  ENTRY_REFUSED: 7,
  TOCTOU: 8,
  ROLLED_BACK: 9,
};

export function planId(now = new Date(), random = randomBytes(5)) {
  return `plan_${now.toISOString().slice(0, 10).replace(/-/g, "")}_${Buffer.from(random).toString("hex")}`;
}

/**
 * Read and verify a bundle. Every refusal the writer's contract implies is re-applied by
 * an independent reader here (entry-name canonicalization, per-entry digests, the bundle
 * digest, the declared-vs-delivered entry lists) before a single item is looked at.
 */
export async function loadBundle(bundlePath) {
  const serialized = await readFile(bundlePath, "utf8");
  return readBundle(serialized);
}

export async function buildPlan({ bundlePath, env, adapters, credentials, now = new Date() }) {
  const { manifest, entries } = await loadBundle(bundlePath);
  const plan = await planImport({
    manifest,
    entries,
    adapters,
    env,
    planId: planId(now),
    now,
    credentials: credentials ?? new Map(),
  });
  return { manifest, entries, plan };
}

export async function runDiff({ options, env, adapters, io }) {
  let built;
  try {
    built = await buildPlan({ bundlePath: options.bundle, env, adapters });
  } catch (error) {
    return reportBundleFailure(error, options, io);
  }
  // The preview plans with every credential unfilled, which is what the import would do
  // with no answers: it shows the most conservative outcome — the one where anything
  // needing a secret lands disabled — rather than a rosier version of it.
  const { plan } = built;
  if (options.json) {
    io.stdout(`${JSON.stringify(planEnvelope({ command: "diff", plan, bundlePath: options.bundle }), null, 2)}\n`);
  } else {
    io.stdout(renderPlan({ plan, bundlePath: options.bundle, mode: "preview" }));
  }
  return plan.blocked.length > 0 ? IMPORT_EXIT.WARNINGS : IMPORT_EXIT.OK;
}

export function reportBundleFailure(error, options, io) {
  if (error instanceof BundleError) {
    io.stderr(`${options.bundle}: ${error.message}\n`);
    return error.exitCode === 7 ? IMPORT_EXIT.ENTRY_REFUSED : IMPORT_EXIT.INTEGRITY;
  }
  if (error.code === "ENOENT") {
    io.stderr(`${options.bundle}: no such bundle\n`);
    return IMPORT_EXIT.USAGE;
  }
  throw error;
}

export function planEnvelope({ command, plan, bundlePath, applied = null }) {
  const clean = publicPlan(plan);
  return {
    ok: true,
    code: plan.blocked.length > 0 ? IMPORT_EXIT.WARNINGS : IMPORT_EXIT.OK,
    command,
    schema_version: clean.plan_version,
    bundle_path: bundlePath ? path.resolve(bundlePath) : null,
    bundle_digest: clean.bundle_digest,
    plan_id: clean.plan_id,
    target: clean.target,
    summary: clean.summary,
    operations: clean.operations,
    blocked: clean.blocked,
    requires_credentials: clean.requires_credentials,
    ...(applied ? { applied } : {}),
  };
}

const TIER_RANK = { EXECUTABLE: 0, DECLARATIVE: 1, INERT: 2 };

/** THR R4 — authority and executable first, always expanded; inert content last. */
export function rankOperations(operations) {
  return [...operations].sort((a, b) => {
    const authority = Number(Boolean(b.authority)) - Number(Boolean(a.authority));
    if (authority !== 0) return authority;
    const tier = (TIER_RANK[a.trust_tier] ?? 3) - (TIER_RANK[b.trust_tier] ?? 3);
    if (tier !== 0) return tier;
    return String(a.op_id).localeCompare(String(b.op_id));
  });
}

export function renderPlan({ plan, bundlePath, mode = "preview" }) {
  const lines = [];
  lines.push(`bundle              ${bundlePath ?? "(none)"}`);
  lines.push(`digest              ${plan.bundle_digest ?? "(unverified)"}`);
  lines.push(`plan                ${plan.plan_id}`);
  lines.push(`target runtimes     ${plan.target.runtimes.map((runtime) => runtime.display_name).join(", ") || "(none detected)"}`);
  lines.push("");

  const live = plan.operations.filter((operation) => operation.action !== "skip");
  const skipped = plan.operations.filter((operation) => operation.action === "skip");
  lines.push(
    `${live.length} operation(s), ${plan.summary.authority_changes} authority change(s), ` +
      `${plan.summary.executable_count} executable item(s), ${plan.summary.quarantined} quarantined, ` +
      `${plan.blocked.length} blocked, ${skipped.length} already present`,
  );
  lines.push("");

  if (plan.requires_credentials.length > 0) {
    lines.push("Credentials this bundle needs (the bundle carries none of them):");
    lines.push(
      table(
        ["ref", "class", "key names", "sites"],
        plan.requires_credentials.map((entry) => [
          entry.ref,
          entry.class ?? "unknown",
          entry.key_names.join(", ") || "-",
          String(entry.sites_count),
        ]),
      ),
    );
    lines.push("");
  }

  for (const operation of rankOperations(live)) {
    lines.push(header(operation));
    for (const reason of operation.losses ?? []) lines.push(`  ! ${reason}`);
    if ((operation.needs_credentials ?? []).length > 0) {
      lines.push(
        `  ! needs ${operation.needs_credentials.join(", ")}; ` +
          (operation.disabled_on_write
            ? "lands disabled until you supply it"
            : "lands with the placeholder in place until you supply it"),
      );
    }
    for (const missing of operation.dangling ?? []) {
      lines.push(`  ! references ${missing}, which does not exist on this machine`);
    }
    if (operation.collides_with?.length > 0) {
      lines.push(`  ! also written by ${operation.collides_with.join(", ")}`);
    }
    if (operation.post_import_note) lines.push(`  note: ${operation.post_import_note}`);
    lines.push(`  consent: ${operation.consent.mode} — ${operation.consent.reason}`);
    if (operation.diff?.key_diff) {
      for (const change of operation.diff.key_diff) {
        lines.push(`  ${change.change === "add" ? "+" : "~"} ${change.key_path} = ${render(change.to)}`);
        if (change.change === "replace") lines.push(`    was ${render(change.from)}`);
      }
    }
    if (operation.diff?.unified) {
      lines.push(...operation.diff.unified.trimEnd().split("\n").map((line) => `  ${line}`));
    }
    lines.push("");
  }

  if (skipped.length > 0) {
    lines.push("Already present, nothing to do:");
    for (const operation of skipped) lines.push(`  ${operation.op_id} — ${operation.skip_reason}`);
    lines.push("");
  }

  if (plan.blocked.length > 0) {
    lines.push("Blocked — previewed, never applied:");
    lines.push(
      table(
        ["item", "kind", "rule", "reason"],
        plan.blocked.map((entry) => [entry.item_id, entry.kind, entry.rule_id, entry.reason]),
      ),
    );
    lines.push("");
  }

  lines.push(
    mode === "preview"
      ? "Nothing was written. `continuity import --bundle <path>` walks the same plan and asks per item."
      : "",
  );
  return `${lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n")}\n`;
}

function header(operation) {
  const badges = [];
  if (operation.authority) badges.push(operation.wildcard_authority ? "AUTHORITY (wildcard)" : "AUTHORITY");
  if (operation.trust_tier === "EXECUTABLE") badges.push("EXECUTABLE");
  if (operation.disabled_on_write) badges.push("lands DISABLED");
  if (operation.replaces_existing) badges.push("REPLACES existing content");
  if (operation.kind === "instructions") badges.push("read by your agent every session");
  return `${operation.action} ${operation.display_path}${operation.key_path ? ` § ${operation.key_path}` : ""}` +
    `${badges.length > 0 ? `   [${badges.join(", ")}]` : ""}`;
}

function render(value) {
  if (value === null || value === undefined) return "(absent)";
  return typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value);
}
