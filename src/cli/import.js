// `omegas-dev import` and `omegas-dev enable`.
//
// The consent flow is the product. Its rules, in the order they bind:
//
//   • Nothing is applied without a recorded consent against a SPECIFIC rendered diff.
//   • `--yes-inert` bulk-accepts inert and declarative additions ONLY. It can never cover
//     an authority item, an executable item, or a write that replaces content you have.
//   • Authority and executable items are prompted one at a time, with the concrete
//     authority or the concrete command shown, every time, with no "and the rest" option.
//   • A non-interactive run with no consent flag prints the plan, writes nothing, exits 3.
//     Silence is not consent, and a pipe cannot answer a question.
//
// Credential re-binding runs before the plan is finalised, because whether an item lands
// enabled or disabled depends on whether its credential resolved — so asking afterwards
// would mean consenting to a diff that is not the one applied.

import { readFile } from "node:fs/promises";
import readline from "node:readline";
import { ADAPTERS } from "../core/adapters/registry.js";
import { applyPlan } from "../core/engine/apply.js";
import { planEnable } from "../core/engine/enable.js";
import { appendLedger, enableRecord } from "../core/engine/ledger.js";
import { autoUnset, describe, fromDotenv, fromEnv, unset } from "../core/engine/rebind.js";
import { IMPORT_EXIT, buildPlan, planEnvelope, rankOperations, renderPlan, reportBundleFailure } from "./diff.js";

export async function runImport({ options, env, adapters = ADAPTERS, io }) {
  const interactive = Boolean(io.interactive) && typeof io.prompt === "function";

  let first;
  try {
    first = await buildPlan({ bundlePath: options.bundle, env, adapters });
  } catch (error) {
    return reportBundleFailure(error, options, io);
  }

  const credentials = interactive
    ? await askForCredentials({ requests: first.plan.requires_credentials, io, env })
    : autoUnset(first.plan.requires_credentials);
  const { plan } = await buildPlan({ bundlePath: options.bundle, env, adapters, credentials });

  io.stdout(renderPlan({ plan, bundlePath: options.bundle, mode: "import" }));

  const live = plan.operations.filter((operation) => operation.action !== "skip");
  if (live.length === 0) {
    io.stdout("Nothing to apply.\n");
    return plan.blocked.length > 0 ? IMPORT_EXIT.WARNINGS : IMPORT_EXIT.OK;
  }

  if (!interactive && !options.yesInert) {
    io.stdout(
      "\nThis run is not interactive and no consent flag was given, so nothing was applied.\n" +
        "Re-run with a terminal to answer per item, or pass --yes-inert to accept the inert\n" +
        "additions only (authority and executable items always need an individual answer).\n",
    );
    if (options.json) io.stdout(`${JSON.stringify(planEnvelope({ command: "import", plan, bundlePath: options.bundle }), null, 2)}\n`);
    return IMPORT_EXIT.WARNINGS;
  }

  const granted = await collectConsent({ operations: live, options, io, interactive });
  if (granted === 0) {
    io.stdout("\nNothing consented to; nothing was written.\n");
    return IMPORT_EXIT.OK;
  }

  const result = await applyPlan({ plan, env, adapters, source: options.bundle });
  io.stdout(renderApply(result));
  if (options.json) {
    io.stdout(
      `${JSON.stringify(
        planEnvelope({ command: "import", plan, bundlePath: options.bundle, applied: result }),
        null,
        2,
      )}\n`,
    );
  }
  return result.code === 0 && plan.blocked.length > 0 ? IMPORT_EXIT.WARNINGS : result.code;
}

/**
 * One question per ref, not one per site — the whole point of value-identity refs is that
 * a token pasted in five places is one decision. The typed answer is read with echo off
 * and is never written anywhere but the target file.
 */
async function askForCredentials({ requests, io, env }) {
  const credentials = new Map();
  for (const request of requests) {
    const names = request.key_names.length > 0 ? request.key_names.join(", ") : "(unnamed)";
    io.stdout(
      `\nCredential ${request.ref} — ${request.class ?? "unknown class"}, used at ${request.sites_count} site(s) as ${names}\n`,
    );
    const answer = (
      await io.prompt("  [e] take from an environment variable  [f] read from a .env file  [t] type it  [s] skip (lands disabled): ")
    )
      .trim()
      .toLowerCase();

    if (answer === "e") {
      const name = (await io.prompt(`  environment variable name [${request.key_names[0] ?? ""}]: `)).trim() || request.key_names[0];
      const record = fromEnv({ ref: request.ref, name, envVars: env.envVars ?? {} });
      if (!record) {
        io.stdout(`  $${name} is not set in this shell; leaving ${request.ref} unset.\n`);
        credentials.set(request.ref, unset(request.ref));
        continue;
      }
      io.stdout(`  ${request.ref} will be filled from ${describe(record)}.\n`);
      credentials.set(request.ref, record);
      continue;
    }
    if (answer === "f") {
      const file = (await io.prompt("  path to the .env file: ")).trim();
      const name = (await io.prompt(`  variable name [${request.key_names[0] ?? ""}]: `)).trim() || request.key_names[0];
      const text = await readFile(file, "utf8").catch(() => null);
      const record = text === null ? null : fromDotenv({ ref: request.ref, name, text });
      if (!record) {
        io.stdout(`  ${name} was not found in ${file}; leaving ${request.ref} unset.\n`);
        credentials.set(request.ref, unset(request.ref));
        continue;
      }
      io.stdout(`  ${request.ref} will be filled from ${describe(record)}.\n`);
      credentials.set(request.ref, record);
      continue;
    }
    if (answer === "t" && typeof io.secret === "function") {
      const value = await io.secret("  value (not echoed, never logged): ");
      if (value.length === 0) {
        credentials.set(request.ref, unset(request.ref));
        continue;
      }
      credentials.set(request.ref, { ref: request.ref, source: "typed", detail: null, value });
      io.stdout(`  ${request.ref} will be filled from a value you typed.\n`);
      continue;
    }
    credentials.set(request.ref, unset(request.ref));
    io.stdout(`  ${request.ref} left unset; anything that needs it lands disabled.\n`);
  }
  return credentials;
}

async function collectConsent({ operations, options, io, interactive }) {
  let granted = 0;
  for (const operation of rankOperations(operations)) {
    if (!operation.bulk_barred && options.yesInert) {
      operation.consent.granted = true;
      operation.consent.mode = "bulk";
      operation.consent.reason = "--yes-inert: inert or declarative addition, accepted in bulk";
      granted += 1;
      continue;
    }
    if (!interactive) continue;

    io.stdout(`\n${operation.action} ${operation.display_path}${operation.key_path ? ` § ${operation.key_path}` : ""}\n`);
    io.stdout(`  ${operation.consent.reason}\n`);
    if (operation.diff?.unified) io.stdout(`${operation.diff.unified}`);
    else if (operation.diff?.key_diff) {
      for (const change of operation.diff.key_diff) io.stdout(`  ${change.key_path} = ${JSON.stringify(change.to)}\n`);
    }
    const answer = (await io.prompt("  apply this? [y/N]: ")).trim().toLowerCase();
    if (answer === "y" || answer === "yes") {
      operation.consent.granted = true;
      operation.consent.mode = "individual";
      granted += 1;
    }
  }
  return granted;
}

function renderApply(result) {
  const lines = [""];
  if (result.status === "applied") {
    lines.push(`Applied ${result.applied.length} operation(s).`);
    const disabled = [...new Set(result.applied.filter((entry) => entry.disabled_on_write).map((entry) => entry.item_id))];
    if (disabled.length > 0) {
      lines.push("");
      lines.push("Written DISABLED — read them, then turn each on deliberately:");
      for (const itemId of disabled) lines.push(`  omegas-dev enable ${itemId}`);
    }
  } else if (result.status === "nothing_consented") {
    lines.push("Nothing consented to; nothing was written.");
  } else if (result.status === "drifted") {
    lines.push(`Aborted: ${result.error}`);
    lines.push(`Rolled back ${result.rolled_back.length} file(s); your configuration is as it was.`);
  } else if (result.status === "rolled_back") {
    lines.push(`Failed mid-apply: ${result.error}`);
    lines.push(`Rolled back ${result.rolled_back.length} file(s) and verified each restore.`);
    for (const failure of result.restore_failures ?? []) lines.push(`  ! ${failure.target}: ${failure.reason}`);
  } else if (result.status === "refused") {
    lines.push(`Refused before writing anything: ${result.error}`);
  }
  if (result.ledger_path) lines.push("", `ledger              ${result.ledger_path}`);
  return `${lines.join("\n")}\n`;
}

// ── enable ──────────────────────────────────────────────────────────────────────────

export async function runEnable({ options, env, adapters = ADAPTERS, io }) {
  const interactive = Boolean(io.interactive) && typeof io.prompt === "function";
  const planned = await planEnable({ itemId: options.itemId, env, adapters });
  if (!planned.ok) {
    io.stderr(`${planned.reason}\n`);
    return planned.code;
  }
  if (planned.plan.operations.length === 0) {
    io.stdout(`${options.itemId} has nothing to enable.\n`);
    return IMPORT_EXIT.OK;
  }

  io.stdout(`${options.itemId} is currently disabled. This is exactly what it is, on this machine, right now:\n\n`);
  for (const operation of planned.plan.operations) {
    io.stdout(`${operation.target_path}${operation.key_path ? ` § ${operation.key_path}` : ""}\n`);
    if (operation.preview_text) io.stdout(`${indent(operation.preview_text)}\n`);
    if (operation.diff?.unified) io.stdout(`${operation.diff.unified}\n`);
  }
  io.stdout("Its content still matches the hash recorded when it was imported.\n");

  if (!interactive) {
    io.stdout("\nThis run is not interactive, so nothing was enabled. Re-run with a terminal.\n");
    return IMPORT_EXIT.WARNINGS;
  }
  const answer = (await io.prompt(`\nEnable ${options.itemId}? [y/N]: `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") {
    io.stdout("Left disabled.\n");
    return IMPORT_EXIT.OK;
  }
  for (const operation of planned.plan.operations) operation.consent.granted = true;

  const result = await applyPlan({ plan: planned.plan, env, adapters, source: `enable ${options.itemId}` });
  if (result.code !== 0) {
    io.stderr(`${result.error ?? "enable failed"}\n`);
    return result.code;
  }
  await appendLedger({
    homeDir: env.homeDir,
    records: planned.plan.operations.map((operation) =>
      enableRecord({
        itemId: planned.item_id,
        targetPath: operation.target_path,
        keyPath: operation.key_path,
        contentSha256: operation.after.sha256,
      }),
    ),
  });
  io.stdout(`Enabled ${options.itemId}.\n`);
  return IMPORT_EXIT.OK;
}

function indent(text) {
  return String(text)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

/** Terminal helpers, kept out of core: core never reads a TTY. */
export function terminalIo(base) {
  const rl = () => readline.createInterface({ input: process.stdin, output: process.stdout });
  return {
    ...base,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    prompt: (question) =>
      new Promise((resolve) => {
        const face = rl();
        face.question(question, (answer) => {
          face.close();
          resolve(answer);
        });
      }),
    secret: (question) =>
      new Promise((resolve) => {
        const muted = { write: () => {}, end: () => {} };
        process.stdout.write(question);
        const face = readline.createInterface({ input: process.stdin, output: muted, terminal: true });
        face.question("", (answer) => {
          face.close();
          process.stdout.write("\n");
          resolve(answer);
        });
      }),
  };
}
