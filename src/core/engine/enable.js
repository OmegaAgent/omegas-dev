// `enable <item_id>` — the deliberate second action that turns a quarantined item on.
//
// Quarantine means written-but-inert, not withheld (THR §3.4): the user has the item's
// exact bytes in place, in their own config, and can read what they are about to turn on.
// Enabling is therefore three things, in this order and never fewer:
//
//   1. show the CURRENT content at the pinned position — not the bundle's copy of it, the
//      bytes that are on this machine right now;
//   2. verify that content still hashes to the pin recorded at import. Drift means the
//      file changed after review, so the trust decision under review is not the decision
//      the user is being asked about, and the answer is no;
//   3. flip the runtime's own disabled idiom, and only that.
//
// The flip is derived from the surface descriptor, never from a per-runtime branch. Every
// disabled form is either a key the import ADDED (delete it, and the runtime's default —
// enabled — applies again), a relocation into a bucket that is not the runtime's key at
// all (move it back), or a missing exec bit (restore it).

import { sha256 } from "../bundle/digest.js";
import { safeReadText } from "../fsx/safe-read.js";
import { splitKeyPath, rebuildKeyPath } from "../fsx/paths.js";
import { formatFor } from "../formats/index.js";
import { unifiedDiff, keyDiff } from "./diff.js";
import { pruneEmpty, readTree, removeAt, resolveTargetKeyPath, stableJson, valueAt, writeKey } from "./keyedit.js";
import { pinsForItem, readLedger } from "./ledger.js";

export const ENABLE_EXIT = {
  OK: 0,
  NOT_FOUND: 1,
  // A pin that no longer matches is an integrity failure of the same family as a tampered
  // bundle: the thing being vouched for is not the thing that was reviewed.
  DRIFT: 6,
};

export async function planEnable({ itemId, env, adapters }) {
  const records = await readLedger(env.homeDir);
  const pins = pinsForItem(records, itemId);
  if (pins.length === 0) {
    return {
      ok: false,
      code: ENABLE_EXIT.NOT_FOUND,
      reason: `nothing with the id "${itemId}" was imported on this machine: it is not in the ledger`,
    };
  }
  const disabled = pins.filter((pin) => pin.state === "disabled");
  if (disabled.length === 0) {
    return { ok: false, code: ENABLE_EXIT.OK, reason: `${itemId} is already enabled`, pins };
  }

  const operations = [];
  const fileState = new Map();
  for (const pin of disabled) {
    const step = await planOne({ pin, env, adapters, fileState });
    if (!step.ok) return { ok: false, code: step.code, reason: step.reason, pin, pins };
    if (step.operation) operations.push(step.operation);
  }

  return {
    ok: true,
    code: ENABLE_EXIT.OK,
    item_id: itemId,
    pins: disabled,
    plan: {
      plan_version: "omegas.continuity.enableplan.v1",
      plan_id: `enable_${itemId.replace(/[^A-Za-z0-9]+/g, "-")}`,
      bundle_digest: disabled[0].bundle_digest ?? null,
      created_at: new Date().toISOString(),
      target: { runtimes: [], home_label: "~", os: env.os, project_root: null },
      operations,
      blocked: [],
      requires_credentials: [],
      summary: { operations: operations.length },
    },
  };
}

async function planOne({ pin, env, adapters, fileState }) {
  const surface = surfaceFor(adapters, pin.surface_id);
  const cached = fileState.get(pin.target_path);
  const current = cached ?? (await readCurrent(pin.target_path, env));
  if (!current.ok) return { ok: false, code: ENABLE_EXIT.NOT_FOUND, reason: current.reason };

  // Step 2 — the drift check, before anything is rendered as enableable.
  const format = surface?.format ?? "json";
  const observed = pin.key_path ? observedKeyContent(current.text, format, pin.key_path) : current.text;
  if (observed === undefined) {
    return {
      ok: false,
      code: ENABLE_EXIT.DRIFT,
      reason: `${pin.key_path} is no longer present in ${pin.target_path}; nothing to enable`,
    };
  }
  const digest = `sha256:${sha256(observed)}`;
  if (digest !== pin.content_sha256) {
    return {
      ok: false,
      code: ENABLE_EXIT.DRIFT,
      reason:
        `the content at ${pin.key_path ?? pin.target_path} has changed since it was imported, ` +
        `so the review that quarantined it no longer describes what is there. Re-import or edit it deliberately, then try again.`,
    };
  }

  const form = surface?.emit?.disabled_form ?? null;
  const mode = form?.mode ?? pin.disabled_form_mode;

  if (mode === "no_exec_bit" || (!pin.key_path && pin.source_exec_bit)) {
    return {
      ok: true,
      operation: {
        op_id: `${pin.op_id}#enable`,
        item_id: pin.item_id,
        action: "rewrite_file",
        target_path: pin.target_path,
        display_path: pin.target_path,
        key_path: null,
        trust_tier: "EXECUTABLE",
        authority: false,
        collides_with: [],
        disabled_on_write: false,
        consent: { mode: "individual", granted: false, reason: "restores the executable bit" },
        before: current.before,
        after: { sha256: digest, bytes: Buffer.byteLength(current.text) },
        diff: { unified: null, key_diff: null },
        preview_text: current.text,
        rollback: { snapshot_entry: null },
        _after_text: current.text,
        _item_content: current.text,
        _file_mode: 0o700,
      },
    };
  }

  if (!pin.key_path) {
    return { ok: true, operation: null };
  }

  const tree = readTree(format, current.text).value ?? {};
  const value = valueAt(tree, pin.key_path);
  let nextText;
  let keyChange;

  if (mode === "relocate_key") {
    // The quarantine bucket is Continuity's, not the runtime's. Enabling moves the value
    // into the runtime's real key path, where the array position is resolved the same way
    // an import resolves one: by appending, never by overwriting position N.
    const runtimeRoot = runtimeRootFor(surface);
    if (!runtimeRoot) {
      return { ok: false, code: ENABLE_EXIT.NOT_FOUND, reason: `${pin.surface_id} does not declare where an enabled item lives` };
    }
    const segments = splitKeyPath(pin.key_path);
    const destination = resolveTargetKeyPath({
      tree,
      keyPath: rebuildKeyPath([runtimeRoot, ...segments.slice(1)]),
      value,
    });
    const removed = pruneEmpty({
      tree: removeAt({ tree, keyPath: pin.key_path }),
      keyPath: pin.key_path,
      stopAt: splitKeyPath(pin.key_path)[0],
    });
    const withoutText = writeSubtree(format, current.text, pin.key_path, removed);
    nextText = writeKey({ format, text: withoutText, keyPath: destination.key_path, value });
    keyChange = keyDiff({ keyPath: destination.key_path, from: undefined, to: value });
  } else {
    // in_entry, companion_key and companion_entry all disable by ADDING a key. Deleting it
    // restores the runtime's default, which is the enabled state, and leaves everything the
    // user may have edited since import exactly where it is.
    const disabledKey = form?.mode === "in_entry" && form.key_path !== "$" ? `${pin.key_path}.${form.key_path}` : pin.key_path;
    const removeKey = form?.mode === "companion_entry" ? `${pin.key_path}.${firstSetKey(form)}` : disabledKey;
    const removed = removeAt({ tree, keyPath: removeKey });
    nextText = writeSubtree(format, current.text, removeKey, removed);
    keyChange = keyDiff({ keyPath: removeKey, from: valueAt(tree, removeKey), to: null });
  }

  const operation = {
    op_id: `${pin.op_id}#enable`,
    item_id: pin.item_id,
    action: "rewrite_file",
    target_path: pin.target_path,
    display_path: pin.target_path,
    key_path: pin.key_path,
    trust_tier: "EXECUTABLE",
    authority: false,
    collides_with: [],
    disabled_on_write: false,
    consent: { mode: "individual", granted: false, reason: "turns the quarantined item on" },
    before: current.before,
    after: { sha256: `sha256:${sha256(nextText)}`, bytes: Buffer.byteLength(nextText) },
    diff: {
      unified: unifiedDiff({ before: current.text, after: nextText, fromLabel: pin.target_path, toLabel: pin.target_path }),
      key_diff: keyChange,
    },
    preview_text: renderValue(value),
    rollback: { snapshot_entry: null },
    _after_text: nextText,
    _item_content: stableJson(value),
    _file_mode: 0o600,
  };
  fileState.set(pin.target_path, { ...current, text: nextText });
  return { ok: true, operation };
}

/**
 * Write a removal back into the file.
 *
 * A removal has no span to patch, so the whole TOP-LEVEL subtree it happened inside is
 * re-rendered over its own bytes — never just the leaf's parent. Rewriting the parent
 * cannot express a deletion that happened ABOVE it: once an emptied matcher group is
 * pruned, `Stop[0]` names a different group than it did a moment earlier, so "write the
 * parent back" copies the surviving group over itself and leaves the array one member too
 * long. Everything outside the named subtree keeps its exact bytes.
 */
function writeSubtree(format, text, keyPath, tree) {
  const root = splitKeyPath(keyPath)[0];
  const value = valueAt(tree, root);
  if (value !== undefined) return writeKey({ format, text, keyPath: root, value });
  // The subtree is gone entirely — the last parked item was just enabled — so there is no
  // span left to patch, and the document is re-rendered in its own declared key order.
  const module = formatFor(format);
  return module.serialize(tree, module.parse(text).key_order);
}

function firstSetKey(form) {
  return Object.keys(form.set ?? {})[0] ?? "enabled";
}

function runtimeRootFor(surface) {
  const declared = surface?.embedded_in?.key_path;
  if (!declared) return null;
  return splitKeyPath(declared)[0] ?? null;
}

function observedKeyContent(text, format, keyPath) {
  let tree;
  try {
    tree = readTree(format, text).value ?? {};
  } catch {
    return undefined;
  }
  const value = valueAt(tree, keyPath);
  return value === undefined ? undefined : stableJson(value);
}

async function readCurrent(target, env) {
  const result = await safeReadText(target, [env.homeDir], env.caps.file_bytes);
  if (!result.ok) return { ok: false, reason: `${target} could not be read (${result.reason})` };
  return {
    ok: true,
    text: result.text,
    before: { exists: true, sha256: `sha256:${sha256(result.text)}`, fingerprint: result.fingerprint, bytes: result.bytes },
  };
}

function surfaceFor(adapters, surfaceId) {
  for (const adapter of adapters) {
    const surface = (adapter.surfaces ?? []).find((candidate) => candidate.surface_id === surfaceId);
    if (surface) return surface;
  }
  return null;
}

function renderValue(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
