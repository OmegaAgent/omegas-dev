// `<state>/ledger.jsonl` — what was imported, from which bundle, on whose say-so, and
// which executable items are pinned to which content hash (THR T-E5, §3.4).
//
// Two jobs in one append-only file:
//
//   1. Reconstructible history. A user who runs `import` twice and a support engineer
//      reading the file six months later must both be able to answer "where did this hook
//      come from and who said yes to it" without the original terminal session.
//   2. Hash-pinned trust. Codex already does exactly this with
//      `[hooks.state."<file>:<event>:<i>:<j>"] trusted_hash`, so an imported item that is
//      later EDITED loses its pin and has to be reviewed again. Copying their shape means
//      the model feels native and we inherit working revocation semantics.
//
// What the ledger records is hashes and decisions. It never records a credential value, a
// resolved placeholder, or the bytes of anything — a decision log that leaks the thing it
// logs decisions about is a worse artifact than no log.

import { appendFile, chmod, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { continuityStateDir } from "../fsx/paths.js";

export const LEDGER_MODE = 0o600;

export function ledgerPath(homeDir) {
  return path.join(continuityStateDir(homeDir), "ledger.jsonl");
}

export async function appendLedger({ homeDir, records }) {
  const target = ledgerPath(homeDir);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const lines = records.map((record) => JSON.stringify(scrub(record))).join("\n");
  await appendFile(target, `${lines}\n`, { mode: LEDGER_MODE });
  await chmod(target, LEDGER_MODE).catch(() => {});
  return target;
}

export async function readLedger(homeDir) {
  const text = await readFile(ledgerPath(homeDir), "utf8").catch(() => "");
  const records = [];
  for (const line of text.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A corrupt line is skipped rather than fatal: a truncated append must not make the
      // whole history unreadable, and the surrounding records are still true.
      records.push({ event: "unreadable_record", raw_bytes: line.length });
    }
  }
  return records;
}

/**
 * The current pin for each OPERATION: last write wins. Keyed by op_id rather than item_id
 * because one item can land as several writes — a skill is its definition, its assets and
 * the enable-state key that quarantines it — and enabling has to flip all of them.
 */
export function trustPins(records) {
  const pins = new Map();
  for (const record of records) {
    if (record.event === "trust_pin") {
      pins.set(record.op_id ?? record.item_id, {
        item_id: record.item_id,
        op_id: record.op_id ?? record.item_id,
        kind: record.kind ?? null,
        surface_id: record.surface_id ?? null,
        target_path: record.target_path,
        key_path: record.key_path ?? null,
        content_sha256: record.content_sha256,
        state: record.state,
        disabled_form_mode: record.disabled_form_mode ?? null,
        source_exec_bit: Boolean(record.source_exec_bit),
        plan_id: record.plan_id ?? null,
        bundle_digest: record.bundle_digest ?? null,
        ts: record.ts,
      });
    }
    if (record.event === "enable") {
      for (const [key, pin] of pins) {
        if (pin.item_id !== record.item_id) continue;
        pins.set(key, { ...pin, state: "enabled", ts: record.ts });
      }
    }
  }
  return pins;
}

/** Every pin belonging to one item, in the order they were written. */
export function pinsForItem(records, itemId) {
  return [...trustPins(records).values()].filter((pin) => pin.item_id === itemId);
}

export function importRecord({ plan, source, decisions, status }) {
  return {
    ts: new Date().toISOString(),
    event: "import",
    plan_id: plan.plan_id,
    bundle_digest: plan.bundle_digest,
    source,
    status,
    target_runtimes: plan.target.runtimes.map((runtime) => runtime.id),
    counts: plan.summary,
    decisions,
  };
}

export function pinRecord({ plan, operation, contentSha256, state = "disabled" }) {
  return {
    ts: new Date().toISOString(),
    event: "trust_pin",
    plan_id: plan.plan_id,
    bundle_digest: plan.bundle_digest,
    item_id: operation.item_id,
    op_id: operation.op_id,
    kind: operation.kind,
    surface_id: operation.surface_id,
    target_path: operation.target_path,
    key_path: operation.key_path,
    content_sha256: contentSha256,
    disabled_form_mode: operation._disabled_form?.mode ?? null,
    source_exec_bit: Boolean(operation.source_exec_bit),
    state,
  };
}

export function enableRecord({ itemId, targetPath, keyPath, contentSha256 }) {
  return {
    ts: new Date().toISOString(),
    event: "enable",
    item_id: itemId,
    target_path: targetPath,
    key_path: keyPath ?? null,
    content_sha256: contentSha256,
  };
}

/**
 * Belt and braces against a future caller handing the ledger something it should not
 * hold. Keys that could carry plaintext are dropped rather than trusted to be absent.
 */
const FORBIDDEN = new Set(["value", "values", "text", "content", "secret", "credential", "credentials", "after_text"]);

function scrub(node) {
  if (Array.isArray(node)) return node.map(scrub);
  if (!node || typeof node !== "object") return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (FORBIDDEN.has(key) || key.startsWith("_")) continue;
    out[key] = scrub(value);
  }
  return out;
}
