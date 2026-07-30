// The eight-step write path (adapter-architecture §5.3), and the only place in the tree
// where a consented operation becomes bytes on the target machine.
//
//   1. stage      per-run 0700 directory under the TARGET home's state dir
//   2. canonicalize entry names and target paths AGAIN, at write time
//   3. fingerprint every target — captured at plan time, carried on the operation
//   4. snapshot   every file the apply will touch, before the first write
//   5. re-verify  the WHOLE plan's fingerprints immediately before each write
//   6. write      temp + rename, O_NOFOLLOW | O_EXCL, containment re-checked at write time
//   7. roll back  everything from snapshots on any failure, and verify the restore
//   8. record     bundle digest, source, plan and per-item decisions in the ledger
//
// Step 5 is deliberately the whole plan and not just the next target. Two operations can
// write to one file, and a drift in operation seven invalidates the consent given for
// operation two — because what the user approved was the plan, not seven separate plans.
//
// Partial application is a corrupted setup, which is a worse outcome than a refused one.
// Every failure path here therefore ends in either "nothing changed" or "everything
// changed", never in between.

import { chmod } from "node:fs/promises";
import { sha256 } from "../bundle/digest.js";
import { APPLY_EXIT, ApplyError, createStaging, rollback, snapshot, verifyUnchanged, writeContained } from "../fsx/atomic.js";
import { canonicalKeyPath, canonicalRelPath, toPosix } from "../fsx/paths.js";
import { readTree, resolveTargetKeyPath, writeKey } from "./keyedit.js";
import { appendLedger, importRecord, pinRecord } from "./ledger.js";

export { APPLY_EXIT };

export const APPLY_STATUS = {
  APPLIED: "applied",
  NOTHING_CONSENTED: "nothing_consented",
  REFUSED: "refused",
  DRIFTED: "drifted",
  ROLLED_BACK: "rolled_back",
};

/**
 * @param plan          a WritePlan from emit.js, with consent already recorded on each op
 * @param env           the TARGET environment (home dir, declared roots, tokens)
 * @param source        provenance string for the ledger — where the bundle came from
 * @returns { code, status, applied[], skipped[], rolled_back[], staging, ledger_path }
 */
export async function applyPlan({ plan, env, adapters, source = "local file", keepStaging = false }) {
  const consented = plan.operations.filter((operation) => operation.action !== "skip" && operation.consent?.granted);
  const skipped = plan.operations.filter((operation) => !consented.includes(operation));

  if (consented.length === 0) {
    return {
      code: 0,
      status: APPLY_STATUS.NOTHING_CONSENTED,
      applied: [],
      skipped: skipped.map(decisionOf),
      rolled_back: [],
      staging: null,
      ledger_path: null,
    };
  }

  const roots = writableRoots(env);
  // Step 2 — every path that reaches the filesystem is re-derived and re-checked here,
  // against the same rules the planner used, because the plan is a data structure that
  // could have been produced by anything.
  for (const operation of consented) {
    const violation = recheck(operation, env);
    if (violation) {
      return {
        code: APPLY_EXIT.CONTAINMENT,
        status: APPLY_STATUS.REFUSED,
        applied: [],
        skipped: skipped.map(decisionOf),
        rolled_back: [],
        error: violation,
        staging: null,
        ledger_path: await record({ plan, env, source, decisions: skipped.map(decisionOf), status: "refused" }),
      };
    }
  }

  const staging = await createStaging({ homeDir: env.homeDir, planId: plan.plan_id });
  const snapshots = [];
  const applied = [];
  const createdDirectories = [];
  let index = 0;

  try {
    // Step 4 — snapshot every distinct file first. Two operations against one settings.json
    // share one restore point, taken before either of them ran.
    const touched = [...new Set(consented.map((operation) => operation.target_path))];
    for (const target of touched) {
      snapshots.push(await snapshot({ staging, target, index: index++ }));
    }

    // Writes are composed PER FILE from the granted operations only. The planner chains
    // its projections so each preview reads against the state its predecessors would
    // produce; if the user then declines one of those predecessors, replaying its
    // successor's projected text verbatim would apply the declined change too. Composing
    // here from the granted subset is what makes "nothing is applied without consent" hold
    // for a partial acceptance, which is the normal case.
    const byFile = groupByFile(consented);
    const written = new Set();

    for (const [target, operations] of byFile) {
      // Step 5 — re-verify the fingerprints of every target this plan has not written yet.
      for (const candidate of consented) {
        if (written.has(candidate.target_path)) continue;
        const check = await verifyUnchanged({ target: candidate.target_path, before: candidate.before });
        if (!check.ok) {
          throw new ApplyError(
            `${candidate.display_path}: ${check.reason}; re-run the preview`,
            APPLY_EXIT.TOCTOU,
            { op_id: candidate.op_id, target: candidate.target_path },
          );
        }
      }

      const composed = compose(operations);
      if (operations.some((operation) => operation.fail_here)) {
        // A test hook, and deliberately a plain property rather than a callback: the
        // rollback path is only trustworthy if it is exercised by the real writer.
        throw new ApplyError(`injected failure at ${target}`, APPLY_EXIT.ROLLED_BACK);
      }

      const mode = operations.reduce((highest, operation) => Math.max(highest, operation._file_mode ?? 0o600), 0o600);
      await writeContained({
        target,
        text: composed.text,
        roots,
        mode,
        label: operations[0].display_path ?? "target",
        created: createdDirectories,
      });
      // Never the exec bit unless an enable step asked for it. A skill script that arrives
      // executable is the quarantine failing open.
      await chmod(target, mode).catch(() => {});
      written.add(target);
      for (const operation of operations) {
        applied.push({
          op_id: operation.op_id,
          ...decisionOf(operation),
          key_path: composed.paths.get(operation.op_id) ?? operation.key_path,
          file_sha256: `sha256:${sha256(composed.text)}`,
        });
      }
    }
  } catch (error) {
    const restored = await rollback(snapshots, createdDirectories);
    const code = error instanceof ApplyError ? error.exitCode : APPLY_EXIT.ROLLED_BACK;
    const ledgerPath = await record({
      plan,
      env,
      source,
      decisions: [...applied.map((entry) => ({ ...entry, status: "rolled_back" })), ...skipped.map(decisionOf)],
      status: code === APPLY_EXIT.TOCTOU ? "aborted_toctou" : "rolled_back",
      note: error.message,
    });
    if (!keepStaging) await staging.cleanup();
    return {
      code,
      status: code === APPLY_EXIT.TOCTOU ? APPLY_STATUS.DRIFTED : APPLY_STATUS.ROLLED_BACK,
      applied: [],
      skipped: skipped.map(decisionOf),
      rolled_back: restored.restored,
      restore_failures: restored.failures,
      error: error.message,
      staging: keepStaging ? staging.dir : null,
      ledger_path: ledgerPath,
    };
  }

  const pins = consented
    .filter((operation) => operation.disabled_on_write || operation.trust_tier === "EXECUTABLE")
    .map((operation) =>
      pinRecord({
        plan,
        operation,
        contentSha256: `sha256:${sha256(String(operation._item_content ?? operation._after_text))}`,
        state: operation.disabled_on_write ? "disabled" : "enabled",
      }),
    );
  const ledgerPath = await record({
    plan,
    env,
    source,
    decisions: [...applied, ...skipped.map(decisionOf)],
    status: "applied",
    extra: pins,
  });
  if (!keepStaging) await staging.cleanup();

  return {
    code: 0,
    status: APPLY_STATUS.APPLIED,
    applied,
    skipped: skipped.map(decisionOf),
    rolled_back: [],
    staging: keepStaging ? staging.dir : null,
    ledger_path: ledgerPath,
  };
}

function groupByFile(operations) {
  const byFile = new Map();
  for (const operation of operations) {
    const bucket = byFile.get(operation.target_path) ?? [];
    bucket.push(operation);
    byFile.set(operation.target_path, bucket);
  }
  return byFile;
}

/**
 * Replay one file's granted operations onto the bytes that are on disk right now.
 *
 * A whole-file write (`create_file`, and the enable path's rewrites) supplies the text
 * outright; a key write re-resolves its position against the tree as it stands, so an
 * append lands after whatever the user actually accepted rather than at the index the
 * preview happened to compute.
 *
 * When every operation the planner chained is granted, the composition must reproduce the
 * planner's own projection exactly. That equality is asserted rather than assumed: it is
 * the property that keeps the rendered diff and the written bytes the same artifact.
 */
function compose(operations) {
  const paths = new Map();
  let text = null;
  for (const operation of operations) {
    if (operation.action !== "merge_key") {
      text = String(operation._after_text);
      paths.set(operation.op_id, operation.key_path);
      continue;
    }
    if (text === null) text = operation._before_text ?? "";
    const format = operation._format ?? "json";
    const tree = readTree(format, text).value ?? {};
    const resolved = operation.append
      ? resolveTargetKeyPath({ tree, keyPath: operation.key_path, value: operation._value })
      : { key_path: operation.key_path, duplicate_of: null };
    if (resolved.duplicate_of !== null) {
      paths.set(operation.op_id, resolved.key_path);
      continue;
    }
    text = writeKey({ format, text, keyPath: resolved.key_path, value: operation._value });
    paths.set(operation.op_id, resolved.key_path);
  }
  const last = operations[operations.length - 1];
  if (operations.length === (last._planned_op_count ?? operations.length) && typeof last._after_text === "string") {
    if (last._after_text !== text) {
      throw new ApplyError(
        `${last.target_path}: composing the accepted operations did not reproduce the previewed file`,
        APPLY_EXIT.ROLLED_BACK,
      );
    }
  }
  return { text: text ?? "", paths };
}

function writableRoots(env) {
  const roots = new Set(env.declaredRoots?.map((root) => root.path) ?? []);
  roots.add(env.homeDir);
  return [...roots];
}

/**
 * Step 2, in full. A plan is data; it may have been produced by an older version, edited
 * by hand, or handed over by a caller that trusted the bundle more than it should have.
 * Every rule the planner applied is applied again before a byte is written.
 */
function recheck(operation, env) {
  const target = operation.target_path;
  if (typeof target !== "string" || !target.startsWith("/")) {
    return `${operation.op_id}: target is not an absolute path`;
  }
  const posix = toPosix(target);
  if (posix.split("/").some((segment) => segment === "..")) {
    return `${operation.op_id}: parent segment in the target path`;
  }
  if (posix.normalize("NFC") !== posix) return `${operation.op_id}: target path is not Unicode NFC`;
  const home = toPosix(env.homeDir);
  const relative = posix.startsWith(`${home}/`) ? posix.slice(home.length + 1) : null;
  if (relative) {
    const canonical = canonicalRelPath(relative);
    if (!canonical.ok) return `${operation.op_id}: ${canonical.reason}`;
  }
  if (operation.key_path) {
    const canonical = canonicalKeyPath(operation.key_path);
    if (!canonical.ok) return `${operation.op_id}: ${canonical.reason}`;
  }
  return null;
}

function decisionOf(operation) {
  return {
    op_id: operation.op_id,
    item_id: operation.item_id,
    kind: operation.kind,
    surface_id: operation.surface_id,
    trust_tier: operation.trust_tier,
    authority: Boolean(operation.authority),
    action: operation.action,
    target_path: operation.target_path,
    key_path: operation.key_path ?? null,
    after_sha256: operation.after?.sha256 ?? null,
    disabled_on_write: Boolean(operation.disabled_on_write),
    needs_credentials: operation.needs_credentials ?? [],
    consent: {
      mode: operation.consent?.mode ?? "none",
      granted: Boolean(operation.consent?.granted),
      reason: operation.consent?.reason ?? "",
    },
    status: operation.action === "skip" ? "skipped" : operation.consent?.granted ? "applied" : "declined",
  };
}

async function record({ plan, env, source, decisions, status, note, extra = [] }) {
  const main = importRecord({ plan, source, decisions, status });
  if (note) main.note = note;
  return appendLedger({ homeDir: env.homeDir, records: [main, ...extra] });
}
