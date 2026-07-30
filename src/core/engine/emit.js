// Item[] + a target environment -> WritePlan (adapter-architecture §5.1).
//
// `emit()` NEVER writes. It produces the plan, and the plan is the entire consent
// mechanism — which makes its accuracy a security property, not a UX one (THR T-I13: "if
// the preview is stale, consent is void"). Everything a user is asked to approve is
// computed here from the exact bytes the writer will later produce.
//
// Four things this module is responsible for refusing, each a Critical in THR §2.4:
//
//   T-I1  every filesystem target is rebuilt from a DECLARED template plus a canonicalized
//         identity, and the result is contained against the target's declared roots. An
//         entry name is not the only attacker-controlled string that reaches a path: the
//         identity is interpolated into the template, so `../../.ssh` there is the same
//         escape wearing a different hat.
//   T-I5  a permission rule is an ADDITION. Array positions resolve to appends, never to
//         index writes, so importing rule 3 can never overwrite the target's rule 3.
//   T-I3  every EXECUTABLE item is planned in its runtime's own disabled idiom and can
//         only be consented to individually.
//   T-I10 an operation that would replace existing content says so, and cannot ride a
//         bulk accept.
//
// Cross-runtime items are planned as far as `blocked[]` and no further: the compat engine
// and its per-item loss review are M4, and a transform applied without that review is the
// silent-conversion failure the design doc refuses.

import { blobText } from "../bundle/read.js";
import { sha256 } from "../bundle/digest.js";
import { formatFor } from "../formats/index.js";
import {
  canonicalKeyPath,
  canonicalRelPath,
  expandTemplate,
  insideRoot,
  isUnresolved,
  joinKeyPath,
  matchKeyPattern,
  matchesPrefix,
  rebuildKeyPath,
  splitKeyPath,
  toPosix,
} from "../fsx/paths.js";
import { fingerprintFile } from "../fsx/fingerprint.js";
import { lstatOrNull, realpathOrNull, safeReadText } from "../fsx/safe-read.js";
import { RESERVED_V1_1_KINDS, maxTier } from "../model/kinds.js";
import { unifiedDiff, keyDiff } from "./diff.js";
import { clone, deepEqual, readTree, resolveTargetKeyPath, stableJson, valueAt, writeKey } from "./keyedit.js";
import { maskCredentials, refsIn, resolveInto } from "./rebind.js";
import { detectPresence } from "./scan.js";

export const PLAN_VERSION = "omegas.continuity.writeplan.v1";

export const BLOCK_REASONS = {
  cross_runtime: "cross-runtime apply lands after parity review; preview available",
  runtime_absent: "this runtime is not installed on the target machine",
  not_writable: "this surface declares no import target",
  scope: "v1 imports target user scope only; a project-scope write the runtime then ignores is a silently broken import",
  banned_scope: "the runtime ignores this key in this scope; writing it produces config that silently does nothing",
  refused: "the source bundle refused to carry this item",
  no_content: "the bundle did not carry this item's content at its payload policy",
  unresolved: "the target path could not be resolved on this machine",
  containment: "the resolved target escapes every declared root",
  malformed: "the item names a target this reader will not build",
  unsupported_write: "no writer is registered for this surface's format and write mode",
  reserved: "this kind is reserved for v1.1: declared so the bundle shape is stable, not written by this version",
  claim_mismatch:
    "this key belongs to another surface, and importing it under this one would apply that surface's rules instead of its owner's",
  no_quarantine: "this surface declares no disabled form, so an executable item cannot be written here inert",
  quarantine_switch:
    "this item lands disabled only if its OFF switch can also be written, and the switch target could not be prepared on this machine (unreadable, a symlink, or unresolvable); writing the body without its switch would import it live",
};

/**
 * @returns WritePlan — operations[] the user may consent to, blocked[] with a reason each,
 * requires_credentials[] and a summary. Nothing here touches the filesystem except reads.
 */
export async function planImport({
  manifest,
  entries,
  adapters,
  env,
  planId,
  now = new Date(),
  credentials = new Map(),
}) {
  const present = new Map();
  for (const adapter of adapters) present.set(adapter.id, await detectPresence(adapter, env));

  const roots = writableRoots(adapters, env);
  const operations = [];
  const blocked = [];
  const fileState = new Map();
  const credentialSites = new Map();

  for (const item of manifest.items ?? []) {
    for (const ref of refsIn(item)) {
      const record = credentialSites.get(ref) ?? { ref, class: null, key_names: new Set(), sites_count: 0 };
      record.sites_count += 1;
      for (const edge of item.related ?? []) {
        if (edge.rel === "requires_secret" && edge.ref === ref) {
          record.class = edge.class ?? record.class;
          for (const name of edge.key_names ?? []) record.key_names.add(name);
        }
      }
      credentialSites.set(ref, record);
    }

    const plannedFor = await planItem({
      item,
      manifest,
      entries,
      adapters,
      env,
      present,
      roots,
      fileState,
      credentials,
    });
    if (plannedFor.blocked) blocked.push(plannedFor.blocked);
    for (const operation of plannedFor.operations ?? []) operations.push(operation);
  }

  markCollisions(operations);
  stampPlannedCounts(operations);

  return {
    plan_version: PLAN_VERSION,
    plan_id: planId,
    bundle_digest: manifest.bundle?.digest ?? null,
    created_at: now.toISOString(),
    source: {
      generator: manifest.bundle?.generator ?? null,
      generator_version: manifest.bundle?.generator_version ?? null,
      created_at: manifest.bundle?.created_at ?? null,
      payload_policy: manifest.bundle?.payload_policy ?? null,
      complete: manifest.bundle?.complete ?? null,
    },
    target: {
      runtimes: adapters
        .filter((adapter) => present.get(adapter.id))
        .map((adapter) => ({ id: adapter.id, display_name: adapter.display_name })),
      home_label: "~",
      os: env.os,
      project_root: null,
      state_dir_relative: ".omegas/continuity",
    },
    operations,
    blocked,
    requires_credentials: [...credentialSites.values()].map((record) => ({
      ref: record.ref,
      class: record.class,
      key_names: [...record.key_names],
      sites_count: record.sites_count,
    })),
    summary: summarize(operations, blocked),
  };
}

/** Roots a write may land in: every declared, non-project root of a present adapter. */
function writableRoots(adapters, env) {
  const roots = new Set();
  for (const root of env.declaredRoots ?? []) roots.add(root.path);
  roots.add(env.homeDir);
  return [...roots];
}

async function planItem({ item, manifest, entries, adapters, env, present, roots, fileState, credentials }) {
  const adapter = adapters.find((candidate) => candidate.id === item.runtime);
  if (!adapter) return { blocked: block(item, "unknown_runtime", BLOCK_REASONS.malformed) };
  if (!present.get(adapter.id)) {
    const anyPresent = adapters.some((candidate) => present.get(candidate.id));
    return {
      blocked: block(
        item,
        anyPresent ? "cross_runtime_preview_only" : "runtime_absent",
        anyPresent ? BLOCK_REASONS.cross_runtime : BLOCK_REASONS.runtime_absent,
      ),
    };
  }

  const surface = (adapter.surfaces ?? []).find((candidate) => candidate.surface_id === item.surface_id);
  if (!surface) return { blocked: block(item, "unknown_surface", BLOCK_REASONS.malformed) };
  if (item.export_refused) return { blocked: block(item, "never_export", BLOCK_REASONS.refused) };
  // A reserved kind is declared so the bundle's SHAPE is stable across versions, not so it
  // can be written by a version that has not modelled what writing it means.
  if (RESERVED_V1_1_KINDS.includes(item.kind)) {
    return { blocked: block(item, "reserved_kind", BLOCK_REASONS.reserved) };
  }

  const emit = surface.emit ?? {};
  if (!emit.target || emit.write_mode === "none") {
    return { blocked: block(item, "surface_not_writable", emit.post_import_note ?? BLOCK_REASONS.not_writable) };
  }
  if (item.scope !== "user") {
    return { blocked: block(item, "v1_user_scope_only", BLOCK_REASONS.scope) };
  }
  if ((emit.banned_in_scopes ?? []).includes(item.scope)) {
    return { blocked: block(item, "banned_in_scope", emit.post_import_note ?? BLOCK_REASONS.banned_scope) };
  }
  const owners = claimingSurfaces(item, adapter, surface);
  if (owners) {
    return { blocked: block(item, "surface_claim_mismatch", `${BLOCK_REASONS.claim_mismatch} (${owners.join(", ")})`) };
  }

  const target = await resolveTarget({ item, surface, env, roots });
  if (target.blocked) return { blocked: block(item, target.rule_id, target.reason) };

  const trustTier = effectiveTier(item, surface);
  // An executable item on a surface with no disabled form has nowhere inert to land, and
  // writing it live because the descriptor is silent is the quarantine failing open.
  if (trustTier === "EXECUTABLE" && !emit.disabled_form) {
    return { blocked: block(item, "no_disabled_form", BLOCK_REASONS.no_quarantine) };
  }
  const authority = isAuthority(item, surface);
  const context = {
    item,
    manifest,
    entries,
    surface,
    adapter,
    adapters,
    env,
    roots,
    fileState,
    credentials,
    trustTier,
    authority,
    target,
    quarantine: trustTier === "EXECUTABLE" && Boolean(surface.emit.disabled_form),
  };

  let planned;
  if (emit.write_mode === "merge_key") planned = await planKeyOperation(context);
  else if (emit.write_mode === "create_file") planned = await planFileOperation(context);
  else if (emit.write_mode === "relocate_dir") planned = await planDirectoryOperation(context);
  else return { blocked: block(item, "unsupported_write_mode", BLOCK_REASONS.unsupported_write) };
  return coupleQuarantine(context, planned);
}

/**
 * A quarantine is ONE atomic unit — the item's body plus the switch that disables it — and
 * the two are consented as a single decision at the STRICTER class. This closes two ways a
 * split could write a body live:
 *
 *   • Split consent class. A credential-quarantined skill's body is an inert `create_file`
 *     (bulk) while its disable switch is a `merge_key` (individual). Accepting the bulk half
 *     under `--yes-inert` wrote the SKILL.md and left `skillOverrides` off — a live skill the
 *     tool called DISABLED. Every operation of a disabled item is re-bound here to the
 *     switch's individual class, so none can ride a bulk accept and `--yes-inert` skips the
 *     whole item.
 *   • Missing switch. If a companion idiom needs a SEPARATE switch operation and one could
 *     not be planned (the switch file is a symlink, unreadable, or unresolvable — see
 *     `context.switchUnavailable`), a body on its own is a live import, so the whole item is
 *     refused rather than half-applied. A switch that is ALREADY off is not a failure:
 *     nothing needs writing, and the body is safe.
 */
function coupleQuarantine(context, planned) {
  if (!planned.operations) return planned;
  const live = planned.operations.filter((operation) => operation.action !== "skip");
  if (!live.some((operation) => operation.disabled_on_write)) return planned;

  const form = context.surface.emit.disabled_form;
  const needsSwitch = Boolean(form) && (form.mode === "companion_key" || form.mode === "companion_entry");
  const hasSwitch = live.some((operation) => operation.role === "quarantine");
  if (needsSwitch && !hasSwitch && context.switchUnavailable) {
    return { blocked: block(context.item, "quarantine_switch_unavailable", BLOCK_REASONS.quarantine_switch) };
  }

  for (const operation of live) {
    operation.disabled_on_write = true;
    if (operation.consent?.mode === "bulk") {
      operation.consent = {
        mode: "individual",
        granted: false,
        reason: "quarantined: it lands disabled, and turning it on is a second, deliberate action",
      };
      operation.bulk_barred = true;
      operation.requires_enable = true;
    }
  }
  return planned;
}

/**
 * The emit template is the only source of a filesystem target. `{identity}` is the one
 * attacker-controlled substitution, so it is canonicalized before it is interpolated and
 * the result is contained afterwards — belt and braces, because the template itself could
 * one day gain a second substitution.
 */
async function resolveTarget({ item, surface, env, roots }) {
  const template = String(surface.emit.target);
  const identity = String(item.identity?.value ?? item.name ?? "");
  if (template.includes("{munged}")) {
    return {
      blocked: true,
      rule_id: "munged_path_recompute",
      reason:
        "this target encodes the project's absolute path in its directory name; recomputing it for the target machine is not implemented in v1",
    };
  }
  if (template.includes("{identity}")) {
    const canonical = canonicalRelPath(identity);
    if (!canonical.ok) {
      return { blocked: true, rule_id: "identity_refused", reason: `identity refused: ${canonical.reason}` };
    }
  }
  const expanded = expandTemplate(template.split("{identity}").join(identity), env.tokens);
  if (isUnresolved(expanded) || expanded.includes("${PROJECT}")) {
    return { blocked: true, rule_id: "unresolvable_target", reason: BLOCK_REASONS.unresolved };
  }
  const directory = expanded.endsWith("/");
  const absolute = directory ? expanded.slice(0, -1) : expanded;
  const contained = await containedTarget(absolute, roots);
  if (!contained.ok) {
    return { blocked: true, rule_id: "containment", reason: `${BLOCK_REASONS.containment}: ${contained.reason}` };
  }
  return { path: absolute, directory, display: displayFor(absolute, env), resolved: contained.resolved };
}

/**
 * Plan-time containment. The write path re-checks this against the realpath of the
 * deepest existing ancestor at write time, because a plan-time check alone is defeated by
 * a symlink an earlier operation in the same import created (T-I2).
 */
async function containedTarget(absolute, roots) {
  const segments = toPosix(absolute).split("/");
  if (segments.some((segment) => segment === "..")) return { ok: false, reason: "parent segment in the resolved path" };
  let existing = absolute;
  const missing = [];
  for (;;) {
    if (await lstatOrNull(existing)) break;
    missing.push(existing.slice(existing.lastIndexOf("/") + 1));
    const parent = existing.slice(0, existing.lastIndexOf("/"));
    if (!parent || parent === existing) return { ok: false, reason: "no existing ancestor" };
    existing = parent;
  }
  const canonical = await realpathOrNull(existing);
  if (!canonical) return { ok: false, reason: "unresolvable ancestor" };
  const resolved = [canonical, ...missing.reverse()].join("/");
  for (const root of roots) {
    const canonicalRoot = await realpathOrNull(root);
    if (canonicalRoot && insideRoot(canonicalRoot, resolved)) return { ok: true, resolved };
  }
  return { ok: false, reason: "outside every declared root" };
}

function displayFor(absolute, env) {
  const home = toPosix(env.homeDir);
  const posix = toPosix(absolute);
  return posix.startsWith(`${home}/`) ? `~${posix.slice(home.length)}` : posix;
}

// ── whole-file writes ───────────────────────────────────────────────────────────────

async function planFileOperation(context) {
  const { item, entries, target } = context;
  const carried = blobText(entries, item.payload?.raw?.entry);
  if (typeof carried !== "string") {
    return { blocked: block(item, "content_not_carried", BLOCK_REASONS.no_content) };
  }
  const bound = resolveInto(carried, context.credentials);
  quarantineForMissingCredentials(context, bound.unresolved);
  const masked = maskCredentials(carried, context.credentials);
  const before = await wholeFileState(target.path, context);
  const operation = baseOperation(context, {
    action: "create_file",
    target_path: target.path,
    display_path: target.display,
    key_path: null,
  });
  operation.before = before;
  operation.after = { sha256: `sha256:${sha256(bound.text)}`, bytes: Buffer.byteLength(bound.text), entry: item.payload?.raw?.entry ?? null };
  operation.diff = {
    unified: unifiedDiff({
      before: before.text ?? "",
      after: masked,
      fromLabel: before.exists ? target.display : "(no such file)",
      toLabel: target.display,
    }),
    key_diff: null,
  };
  operation.needs_credentials = bound.unresolved;
  operation._after_text = bound.text;
  operation._item_content = bound.text;
  operation._file_mode = fileModeFor(context);
  if (before.exists && before.sha256 === operation.after.sha256) {
    operation.action = "skip";
    operation.skip_reason = "identical content already present";
  } else {
    cacheWholeFile(target.path, context, before, bound.text, operation.after.sha256);
  }
  finishConsent(operation, context, { replaces: before.exists && before.sha256 !== operation.after.sha256 });
  return { operations: [operation] };
}

/**
 * A directory-container item is its definition file plus whatever assets the bundle
 * actually carried. Each lands as its own operation so the preview lists every file, and
 * so a refusal on one asset never half-writes a skill.
 */
async function planDirectoryOperation(context) {
  const { item, entries, target } = context;
  const operations = [];
  const definitionName = basenameOf(item.origin?.path ?? "SKILL.md");
  const definition = blobText(entries, item.payload?.raw?.entry);
  if (typeof definition !== "string") {
    return { blocked: block(item, "content_not_carried", BLOCK_REASONS.no_content) };
  }

  const members = [{ relative: definitionName, text: definition, exec_bit: false, entry: item.payload?.raw?.entry }];
  for (const asset of item.assets ?? []) {
    if (!asset.included || !asset.entry) continue;
    const canonical = canonicalRelPath(asset.display_path ?? "");
    if (!canonical.ok) {
      return { blocked: block(item, "asset_path_refused", `asset path refused: ${canonical.reason}`) };
    }
    const text = blobText(entries, asset.entry);
    if (typeof text !== "string") continue;
    members.push({ relative: canonical.name, text, exec_bit: Boolean(asset.exec_bit), entry: asset.entry });
  }

  for (const member of members) {
    const memberPath = `${target.path}/${member.relative}`;
    const contained = await containedTarget(memberPath, context.roots);
    if (!contained.ok) {
      return { blocked: block(item, "containment", `${BLOCK_REASONS.containment}: ${contained.reason}`) };
    }
    const bound = resolveInto(member.text, context.credentials);
    quarantineForMissingCredentials(context, bound.unresolved);
    const masked = maskCredentials(member.text, context.credentials);
    const before = await wholeFileState(memberPath, context);
    const operation = baseOperation(context, {
      action: "create_file",
      target_path: memberPath,
      display_path: `${target.display}/${member.relative}`,
      key_path: null,
      op_suffix: member.relative,
    });
    operation.before = before;
    operation.after = {
      sha256: `sha256:${sha256(bound.text)}`,
      bytes: Buffer.byteLength(bound.text),
      entry: member.entry ?? null,
    };
    operation.diff = {
      unified: unifiedDiff({
        before: before.text ?? "",
        after: masked,
        fromLabel: before.exists ? operation.display_path : "(no such file)",
        toLabel: operation.display_path,
      }),
      key_diff: null,
    };
    operation.needs_credentials = bound.unresolved;
    operation._after_text = bound.text;
    operation._item_content = bound.text;
    // THR §3.4 — a skill's scripts land without the exec bit. A file that cannot be
    // executed is the quarantine idiom for a payload the runtime reaches by path.
    operation._file_mode = 0o600;
    operation.source_exec_bit = member.exec_bit;
    if (before.exists && before.sha256 === operation.after.sha256) {
      operation.action = "skip";
      operation.skip_reason = "identical content already present";
    } else {
      cacheWholeFile(memberPath, context, before, bound.text, operation.after.sha256);
    }
    finishConsent(operation, context, { replaces: before.exists && before.sha256 !== operation.after.sha256 });
    operations.push(operation);
  }

  const companion = await planCompanion(context, target.path);
  if (companion) operations.push(companion);
  return { operations };
}

// ── embedded key writes ─────────────────────────────────────────────────────────────

async function planKeyOperation(context) {
  const { item, surface, target, env } = context;
  const sourceKeyPath = item.origin?.key_path;
  if (!sourceKeyPath) return { blocked: block(item, "no_key_path", BLOCK_REASONS.malformed) };

  const format = surface.format;
  let module;
  try {
    module = formatFor(format);
  } catch {
    return { blocked: block(item, "unsupported_format", BLOCK_REASONS.unsupported_write) };
  }
  if (typeof module.serialize !== "function") {
    return { blocked: block(item, "unsupported_format", BLOCK_REASONS.unsupported_write) };
  }

  const state = await keyedFileState(target.path, context, format);
  if (state.error) return { blocked: block(item, "target_unreadable", state.error) };

  const rawValue = clone(item.payload?.parsed?.value);
  if (rawValue === undefined) return { blocked: block(item, "no_value", BLOCK_REASONS.malformed) };
  const probe = resolveInto(rawValue, context.credentials);
  quarantineForMissingCredentials(context, probe.unresolved);

  const quarantined = shouldQuarantine(context);
  const relocated = quarantined ? relocateKeyPath(sourceKeyPath, surface.emit.disabled_form) : sourceKeyPath;
  const canonical = canonicalKeyPath(relocated);
  if (!canonical.ok) return { blocked: block(item, "key_path_refused", `key path refused: ${canonical.reason}`) };

  const disabled = quarantined ? applyInEntryDisable(rawValue, surface.emit.disabled_form) : rawValue;
  const bound = resolveInto(disabled, context.credentials);
  const masked = maskCredentials(disabled, context.credentials);

  const resolvedKey = resolveTargetKeyPath({ tree: state.tree, keyPath: canonical.name, value: bound.value });
  const beforeValue = valueAt(state.tree, resolvedKey.key_path);

  let afterText;
  let maskedText;
  try {
    afterText = writeKey({ format, text: state.text, keyPath: resolvedKey.key_path, value: bound.value });
    maskedText = writeKey({ format, text: state.text, keyPath: resolvedKey.key_path, value: masked });
  } catch (error) {
    return { blocked: block(item, "write_not_expressible", error.message) };
  }

  const operation = baseOperation(context, {
    action: "merge_key",
    target_path: target.path,
    display_path: target.display,
    key_path: resolvedKey.key_path,
  });
  operation.source_key_path = sourceKeyPath;
  // An append's index is not a promise. The user consents to "add this rule", and the
  // index it lands at depends on which other operations they also accept, so the writer
  // re-resolves it from the array it is actually appending to.
  operation.append = resolvedKey.append;
  operation.before = { ...state.before, value_present: beforeValue !== undefined };
  operation.after = { sha256: `sha256:${sha256(afterText)}`, bytes: Buffer.byteLength(afterText), entry: null };
  operation.diff = {
    unified: unifiedDiff({
      before: state.text ?? "",
      after: maskedText,
      fromLabel: state.before.exists ? target.display : "(no such file)",
      toLabel: target.display,
    }),
    key_diff: keyDiff({ keyPath: resolvedKey.key_path, from: beforeValue, to: masked }),
  };
  operation.needs_credentials = bound.unresolved;
  operation.losses = resolvedKey.losses;
  operation.dangling = await danglingReferences(bound.value, context);
  operation._after_text = afterText;
  operation._before_text = state.before.text ?? "";
  operation._item_content = stableJson(bound.value);
  operation._file_mode = fileModeFor(context);
  operation._format = format;
  operation._value = bound.value;
  operation._disabled_form = quarantined ? surface.emit.disabled_form : null;

  if (resolvedKey.duplicate_of !== null || deepEqual(beforeValue, bound.value)) {
    operation.action = "skip";
    operation.skip_reason = "an identical entry is already present at this position";
  }
  finishConsent(operation, context, {
    replaces: beforeValue !== undefined && !deepEqual(beforeValue, bound.value),
  });

  // Chaining the projected text into the shared file state is what makes two operations
  // against one settings.json compose: the second one diffs against the first one's result
  // instead of silently discarding it.
  if (operation.action !== "skip") {
    context.fileState.set(target.path, {
      text: afterText,
      masked: maskedText,
      before: state.before,
      tree: readTree(format, afterText).value,
      format,
    });
  }

  const operations = [operation];
  const companion = await planCompanion(context, target.path);
  if (companion) operations.push(companion);
  return { operations };
}

/**
 * A companion operation is the quarantine that lives in ANOTHER file: a skill's own bytes
 * are inert, but the runtime's enable-state key is what decides whether the agent loads it
 * (`skillOverrides: "off"`, `[[skills.config]] enabled = false`). Both runtimes supply the
 * idiom; the engine only has to place it where the descriptor says.
 */
async function planCompanion(context, writtenPath) {
  const form = context.surface.emit.disabled_form;
  if (!shouldQuarantine(context)) return null;
  if (!form || (form.mode !== "companion_key" && form.mode !== "companion_entry")) return null;
  const companionSurface = (context.adapter.surfaces ?? []).find(
    (candidate) => candidate.surface_id === form.surface_id,
  );
  // From here down a `null` return means the switch genuinely CANNOT be written on this
  // machine — not that it is unnecessary. `coupleQuarantine` reads the flag and refuses the
  // whole item, because a body written without its switch is a live import.
  if (!companionSurface?.emit?.target) return switchUnavailable(context);

  const targetPath = expandTemplate(companionSurface.emit.target, context.env.tokens);
  if (isUnresolved(targetPath)) return switchUnavailable(context);
  const contained = await containedTarget(targetPath, context.roots);
  if (!contained.ok) return switchUnavailable(context);
  const format = companionSurface.format;
  const state = await keyedFileState(targetPath, context, format);
  if (state.error) return switchUnavailable(context);

  const identity = String(context.item.identity?.value ?? context.item.name ?? "");
  let keyPath;
  let value;
  if (form.mode === "companion_key") {
    keyPath = form.key_path.split("{identity}").join(identity);
    value = form.value;
  } else {
    const array = valueAt(state.tree, form.array_path);
    const existing = Array.isArray(array)
      ? array.findIndex((entry) => entry && entry[form.match_key] === writtenPath)
      : -1;
    keyPath = joinKeyPath(form.array_path, `[${existing === -1 ? (Array.isArray(array) ? array.length : 0) : existing}]`);
    value = { [form.match_key]: writtenPath, ...form.set };
  }
  const canonical = canonicalKeyPath(keyPath);
  if (!canonical.ok) return switchUnavailable(context);

  const beforeValue = valueAt(state.tree, canonical.name);
  // The switch is already off: nothing to write, and the body rides safely on the existing
  // one. This is NOT a switch failure, so the flag stays clear and the item is not refused.
  if (deepEqual(beforeValue, value)) return null;
  let afterText;
  try {
    afterText = writeKey({ format, text: state.text, keyPath: canonical.name, value });
  } catch {
    return switchUnavailable(context);
  }
  const display = displayFor(targetPath, context.env);
  const operation = baseOperation(context, {
    action: "merge_key",
    target_path: targetPath,
    display_path: display,
    key_path: canonical.name,
    op_suffix: "quarantine",
  });
  // The switch lives in the COMPANION surface's file (settings.json), not the skill's own
  // md+frontmatter — `enable` must read it back with that surface's format, so the pin
  // records the companion surface, not the item's.
  operation.surface_id = companionSurface.surface_id;
  operation.role = "quarantine";
  operation.before = { ...state.before, value_present: beforeValue !== undefined };
  operation.after = { sha256: `sha256:${sha256(afterText)}`, bytes: Buffer.byteLength(afterText), entry: null };
  operation.diff = {
    unified: unifiedDiff({
      before: state.text ?? "",
      after: afterText,
      fromLabel: state.before.exists ? display : "(no such file)",
      toLabel: display,
    }),
    key_diff: keyDiff({ keyPath: canonical.name, from: beforeValue, to: value }),
  };
  operation.needs_credentials = [];
  operation.disabled_on_write = true;
  operation._after_text = afterText;
  operation._before_text = state.before.text ?? "";
  operation._item_content = stableJson(value);
  operation._file_mode = 0o600;
  operation._format = format;
  operation._value = value;
  operation._disabled_form = form;
  operation.consent = {
    mode: "individual",
    granted: false,
    reason: "records the imported item as disabled; it rides the same decision as the item it quarantines",
  };
  operation.bulk_barred = true;
  operation.requires_enable = true;
  operation.replaces_existing = beforeValue !== undefined;
  context.fileState.set(targetPath, {
    text: afterText,
    masked: afterText,
    before: state.before,
    tree: readTree(format, afterText).value,
    format,
  });
  return operation;
}

// ── shared helpers ──────────────────────────────────────────────────────────────────

/**
 * The current text of a whole-file target, chained through the plan. Two surfaces can emit
 * to one path (Codex's AGENTS.override.md and AGENTS.md both land on AGENTS.md), and
 * without chaining each of them diffs against the original file — so both look like they
 * apply, both do, and which one survives depends on plan order. Chaining makes the second
 * one's preview say what it really does: replace the first one's content.
 */
async function wholeFileState(absolute, context) {
  const cached = context.fileState.get(absolute);
  if (cached) return { ...cached.before, text: cached.text, sha256: cached.sha256 ?? cached.before.sha256, exists: true };
  return readTarget(absolute, context);
}

function cacheWholeFile(absolute, context, before, text, digest) {
  context.fileState.set(absolute, { before, text, masked: text, sha256: digest, format: null, tree: null });
}

async function readTarget(absolute, context) {
  const info = await lstatOrNull(absolute);
  if (!info) return { exists: false, sha256: null, fingerprint: null, text: null, bytes: 0 };
  if (info.isSymbolicLink()) {
    return { exists: true, symlink: true, sha256: null, fingerprint: null, text: null, bytes: info.size };
  }
  const result = await safeReadText(absolute, [context.env.homeDir], context.env.caps.file_bytes);
  if (!result.ok) {
    return { exists: true, unreadable: result.reason, sha256: null, fingerprint: null, text: null, bytes: info.size };
  }
  return {
    exists: true,
    sha256: `sha256:${sha256(result.text)}`,
    bytes: result.bytes,
    fingerprint: await fingerprintFile(absolute, [context.env.homeDir]),
    text: result.text,
  };
}

async function keyedFileState(absolute, context, format) {
  const cached = context.fileState.get(absolute);
  if (cached) return { text: cached.text, tree: cached.tree, before: cached.before };
  const before = await readTarget(absolute, context);
  if (before.symlink) return { error: "the target is a symlink; refusing to write through it" };
  if (before.unreadable) return { error: `the target could not be read (${before.unreadable})` };
  let tree;
  try {
    tree = readTree(format, before.text).value ?? {};
  } catch (error) {
    return { error: `the target does not parse as ${format}: ${error.message}` };
  }
  const state = { text: before.text, tree, before, masked: before.text, format };
  context.fileState.set(absolute, state);
  return state;
}

function baseOperation(context, { action, target_path, display_path, key_path, op_suffix }) {
  const { item } = context;
  return {
    op_id: `${item.item_id}${op_suffix ? `#${op_suffix}` : ""}`,
    item_id: item.item_id,
    runtime: item.runtime,
    surface_id: item.surface_id,
    kind: item.kind,
    name: item.name,
    trust_tier: context.trustTier,
    authority: context.authority,
    action,
    target_path,
    display_path,
    key_path,
    collides_with: [],
    disabled_on_write: shouldQuarantine(context),
    post_import_note: context.surface.emit.post_import_note ?? null,
    losses: [],
    needs_credentials: [],
    consent: { mode: "bulk", granted: false, reason: "" },
    rollback: { snapshot_entry: null },
  };
}

/**
 * The consent table (adapter-architecture §5.2), evaluated from declarations only.
 * `bulk_barred` is the flag `--yes-inert` reads: it can never cover an EXECUTABLE item, an
 * authority item, or a write that replaces content the user already has.
 */
function finishConsent(operation, context, { replaces }) {
  operation.replaces_existing = Boolean(replaces);
  if (operation.action === "skip") {
    operation.consent = { mode: "none", granted: true, reason: operation.skip_reason };
    operation.bulk_barred = false;
    return;
  }
  const wildcard = wildcardAuthority(context.item);
  if (context.trustTier === "EXECUTABLE") {
    operation.consent = {
      mode: "individual",
      granted: false,
      reason: "executable: this runs on your machine, so it lands disabled and enabling it is a second action",
    };
    operation.requires_enable = true;
    operation.bulk_barred = true;
    return;
  }
  if (context.authority) {
    operation.consent = {
      mode: "individual",
      granted: false,
      reason: wildcard
        ? "authority: a wildcard-class rule grants blanket permission and can never ride a bulk accept"
        : "authority: this changes what your agent is permitted to do",
    };
    operation.wildcard_authority = wildcard;
    operation.bulk_barred = true;
    return;
  }
  if (replaces) {
    operation.consent = {
      mode: "individual",
      granted: false,
      reason: "replaces content you already have at this position",
    };
    operation.bulk_barred = true;
    return;
  }
  operation.consent = {
    mode: "bulk",
    granted: false,
    reason:
      context.item.kind === "instructions"
        ? "inert to the OS, read by your agent every session — the full text is rendered above"
        : "inert or declarative addition",
  };
  operation.bulk_barred = false;
}

/**
 * THR R6 — an imported hook or MCP server whose program is not on this machine is a
 * dangling reference: a correctness bug with a security consequence, because a file that
 * later appears at that path silently becomes the thing the agent runs. The planner says
 * so up front rather than letting the user discover it when the hook stops firing.
 */
async function danglingReferences(value, context) {
  if (context.trustTier !== "EXECUTABLE") return [];
  const candidates = new Set();
  const walk = (node) => {
    if (candidates.size >= 8) return;
    if (typeof node === "string") {
      const match = /(^|\s)(\/[^\s"']{2,})/.exec(node);
      if (match) candidates.add(match[2]);
      return;
    }
    if (Array.isArray(node)) for (const entry of node) walk(entry);
    else if (node && typeof node === "object") for (const entry of Object.values(node)) walk(entry);
  };
  walk(value);
  const missing = [];
  for (const candidate of candidates) {
    if (!(await lstatOrNull(candidate))) missing.push(displayFor(candidate, context.env));
  }
  return missing;
}

function shouldQuarantine(context) {
  return Boolean(context.quarantine);
}

/** Records that a needed disable switch could not be planned, and returns no operation. */
function switchUnavailable(context) {
  context.switchUnavailable = true;
  return null;
}

/**
 * An item whose credentials were left unset lands DISABLED, not dropped: the user sees the
 * shape of what they still have to supply, in place, and the runtime never spawns a server
 * whose token is a placeholder (THR §3.3, import-side re-binding).
 */
function quarantineForMissingCredentials(context, unresolved) {
  if (unresolved.length === 0) return;
  if (!context.surface.emit.disabled_form) return;
  context.quarantine = true;
}

/**
 * Which surface owns a key is a declared fact, and the SCAN side already applies it: a
 * catch-all surface skips every key another surface claims, so a hook is never scanned as
 * a plain setting. `surface_id` is a BUNDLE field, though, and the bundle is the author's,
 * so the import side has to re-derive the same answer instead of trusting the label.
 *
 * Without this, a relabelling swaps a strict surface's rules for a permissive one's: the
 * same bytes at the same key path, declared to be a `setting` rather than a `hook`, get a
 * DECLARATIVE tier, no disabled form and a bulk-consentable operation — and land live.
 *
 * A bare `*` or `**` claim is a catch-all rather than a claim on a named key, so it is not
 * evidence of ownership and would otherwise make every sibling key unimportable.
 */
function claimingSurfaces(item, adapter, surface) {
  const keyPath = item.origin?.key_path;
  if (!keyPath) return null;
  const owners = [];
  for (const candidate of adapter.surfaces ?? []) {
    const patterns = [
      ...(candidate.claims ?? []),
      ...(candidate.locations ?? []).map((location) => location.key_path),
    ].filter((pattern) => pattern && pattern !== "*" && pattern !== "**" && pattern !== "$");
    if (patterns.some((pattern) => matchesPrefix(pattern, keyPath))) owners.push(candidate.surface_id);
  }
  if (owners.length === 0 || owners.includes(surface.surface_id)) return null;
  return owners;
}

/**
 * `argv_positions` is the surface's own statement that a position holds a COMMAND LINE —
 * the runtime spawns what it finds there. Until now that declaration only reached the
 * redactor, so a settings key the adapter itself describes as an argv position could be
 * imported as an inert-looking `setting`.
 */
function carriesArgvPosition(item, surface) {
  const keyPath = item.origin?.key_path;
  if (!keyPath) return false;
  return (surface.argv_positions ?? []).some(
    (pattern) =>
      pattern &&
      pattern !== "$" &&
      // The position may name the item itself or an ancestor of it (`apiKeyHelper`), or
      // sit inside the value the item carries (`statusLine.command` under `statusLine`).
      (matchesPrefix(pattern, keyPath) || matchesPrefix(keyPath, pattern)),
  );
}

function effectiveTier(item, surface) {
  const fromAssets = (item.assets ?? []).some((asset) => asset.exec_bit) ? "EXECUTABLE" : "INERT";
  const fromArgv = carriesArgvPosition(item, surface) ? "EXECUTABLE" : "INERT";
  return maxTier(
    maxTier(maxTier(item.trust_tier ?? surface.trust_tier, surface.trust_tier), fromAssets),
    fromArgv,
  );
}

function isAuthority(item, surface) {
  if (item.authority === true || surface.authority === true) return true;
  const key = item.identity?.value;
  if (!key) return false;
  return (surface.key_policy?.REVIEW_REQUIRED ?? []).some((pattern) => matchKeyPattern(pattern, key));
}

/**
 * A wildcard-class rule is one whose argument is `*` or `<class>:*` — blanket authority
 * over a whole tool. `Bash(git status:*)` is NOT one: its prefix is the point.
 */
function wildcardAuthority(item) {
  const value = item.payload?.parsed?.value;
  if (typeof value !== "string") return false;
  const match = /^[A-Za-z]+\((.*)\)$/.exec(value.trim());
  if (!match) return value.trim() === "*";
  const argument = match[1].trim();
  return argument === "*" || /^[A-Za-z_]+:\*$/.test(argument);
}

function relocateKeyPath(keyPath, form) {
  if (!form || form.mode !== "relocate_key") return keyPath;
  const segments = splitKeyPath(keyPath);
  return rebuildKeyPath([form.key_path, ...segments.slice(1)]);
}

function applyInEntryDisable(value, form) {
  if (!form || form.mode !== "in_entry") return value;
  if (form.key_path === "$") return form.value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const next = clone(value);
  const segments = splitKeyPath(form.key_path);
  let node = next;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (!node[segments[i]] || typeof node[segments[i]] !== "object") node[segments[i]] = {};
    node = node[segments[i]];
  }
  node[segments[segments.length - 1]] = form.value;
  return next;
}

function fileModeFor(context) {
  const form = context.surface.emit.disabled_form;
  if (shouldQuarantine(context) && form?.mode === "no_exec_bit") return form.file_mode ?? 0o600;
  return 0o600;
}

function basenameOf(tokenizedPath) {
  const posix = toPosix(tokenizedPath);
  return posix.slice(posix.lastIndexOf("/") + 1) || "SKILL.md";
}

/**
 * spike-corrections §"Modelling notes" — two legitimate operations can target one path
 * (Codex's `AGENTS.override.md` and `AGENTS.md` both emit to `AGENTS.md`). Naming the
 * collision on both sides is what lets the preview say "these two disagree" instead of
 * letting the later one silently win.
 */
function markCollisions(operations) {
  const byPosition = new Map();
  for (const operation of operations) {
    if (operation.action === "skip") continue;
    const position = `${operation.target_path}::${operation.key_path ?? ""}`;
    const bucket = byPosition.get(position) ?? [];
    bucket.push(operation);
    byPosition.set(position, bucket);
  }
  for (const bucket of byPosition.values()) {
    if (bucket.length < 2) continue;
    for (const operation of bucket) {
      operation.collides_with = bucket.filter((other) => other !== operation).map((other) => other.op_id);
    }
  }
}

/**
 * How many operations the planner chained onto each file. The writer compares its own
 * composition against the planner's projection when — and only when — every one of them
 * was accepted, which is the case where the two must be byte-identical.
 */
function stampPlannedCounts(operations) {
  const counts = new Map();
  for (const operation of operations) {
    if (operation.action === "skip") continue;
    counts.set(operation.target_path, (counts.get(operation.target_path) ?? 0) + 1);
  }
  for (const operation of operations) operation._planned_op_count = counts.get(operation.target_path) ?? 0;
}

function block(item, ruleId, reason) {
  return {
    item_id: item.item_id,
    runtime: item.runtime,
    surface_id: item.surface_id,
    kind: item.kind,
    name: item.name,
    trust_tier: item.trust_tier,
    rule_id: ruleId,
    reason,
  };
}

function summarize(operations, blocked) {
  const live = operations.filter((operation) => operation.action !== "skip");
  const byTier = {};
  const byKind = {};
  for (const operation of live) {
    byTier[operation.trust_tier] = (byTier[operation.trust_tier] ?? 0) + 1;
    byKind[operation.kind] = (byKind[operation.kind] ?? 0) + 1;
  }
  return {
    operations: live.length,
    skipped: operations.length - live.length,
    blocked: blocked.length,
    by_trust_tier: byTier,
    by_kind: byKind,
    authority_changes: live.filter((operation) => operation.authority).length,
    executable_count: live.filter((operation) => operation.trust_tier === "EXECUTABLE").length,
    quarantined: live.filter((operation) => operation.disabled_on_write).length,
    replaces_existing: live.filter((operation) => operation.replaces_existing).length,
    bytes_written: live.reduce((total, operation) => total + (operation.after?.bytes ?? 0), 0),
  };
}

/** The bundle-facing projection: internal working state never reaches a file or a socket. */
export function publicPlan(plan) {
  return {
    ...plan,
    operations: plan.operations.map((operation) => {
      const out = {};
      for (const [key, value] of Object.entries(operation)) {
        if (key.startsWith("_")) continue;
        out[key] = value;
      }
      return out;
    }),
  };
}
