// Walk every descriptor's locations[] and emit RawNodes, link nodes, exclusion records
// and truncation records. Refusals and unknowns are first-class data here, never a bare
// `continue` — that silence is the defect the whole architecture exists to close
// (THR §4.2 Gap 4: 61 real skills vanished with no trace).
//
// Nothing in this file branches on a runtime name. Everything it does is read out of a
// descriptor.

import path from "node:path";
import { formatFor } from "../formats/index.js";
import { OUTCOME } from "../fsx/links.js";
import {
  displayPath,
  expandTemplate,
  globCaptures,
  hasGlob,
  isUnresolved,
  linkLabel,
  toPosix,
  tokenize,
  tokenizeWithin,
} from "../fsx/paths.js";
import { eolOf, lstatOrNull, safeEntries, safeReadText } from "../fsx/safe-read.js";
import { collectLocation, expandGlobPath } from "../fsx/walk.js";
import { IGNORED_DIRS } from "../policy/caps.js";
import { ExclusionLedger, fileRules, matchFileRule, rulesFor } from "../policy/never-export.js";
import { allRootPaths, contextsFor, rootPathsFor } from "./environment.js";

export async function scan({ adapters, env }) {
  const exclusions = new ExclusionLedger();
  const truncations = [];
  const sources = [];
  const files = [];
  const links = [];
  const runtimes = [];
  const knownRoots = allRootPaths(env, adapters);

  for (const adapter of adapters) {
    const present = await detectPresence(adapter, env);
    const version = present ? await detectVersion(adapter, env) : null;
    const breaking = adapter.detect?.breaking_below ?? null;
    const incompatible = Boolean(version && breaking && compareSemver(version, breaking) < 0);
    runtimes.push({
      id: adapter.id,
      display_name: adapter.display_name,
      present,
      status: adapter.status,
      adapter_version: adapter.adapter_version,
      version,
      detected_by: adapter.detect?.present_if?.[0]?.kind ?? null,
      home_label: homeLabel(adapter, env),
      surfaces_declared: adapter.surfaces.length,
      version_incompatible: incompatible,
      // `breaking_below` lets an adapter REFUSE rather than warn: below it, a written
      // config parses cleanly and silently does nothing, which is worse than an error.
      version_note: incompatible ? `below the adapter's supported floor (${breaking})` : null,
    });
    if (!present) continue;

    const rules = rulesFor(adapter, env.tokens);
    await collectSources({ adapter, env, rules, sources, exclusions, truncations });
    await collectSurfaces({ adapter, env, rules, knownRoots, files, links, exclusions, truncations });
    await sweepDeniedPaths({ adapter, env, rules, exclusions });
  }

  return { sources, files, links, exclusions, truncations, runtimes };
}

// ── sources: files opened once, addressed by many embedded surfaces ─────────────────

async function collectSources({ adapter, env, rules, sources, exclusions, truncations }) {
  for (const descriptor of adapter.sources ?? []) {
    for (const context of contextsFor(env, descriptor)) {
      const template = expandTemplate(descriptor.path, context.tokens);
      if (isUnresolved(template)) continue;
      const concrete = hasGlob(template)
        ? await expandGlobPath(template, { caps: env.caps, ignoredDirs: IGNORED_DIRS })
        : [template];
      for (const absPath of concrete) {
        const roots = rootPathsFor(adapter, context.tokens, env);
        const read = await readGuarded({
          absPath,
          roots,
          rules: fileRules(rules),
          env,
          exclusions,
          truncations,
          surfaceId: descriptor.source_id,
          maxBytes: env.caps.file_bytes,
        });
        if (!read) continue;
        const { parsed, parse_error } = parseText(descriptor.format, read.result.text);
        sources.push({
          adapter_id: adapter.id,
          source_id: descriptor.source_id,
          scope: descriptor.scope,
          project: context.project,
          abs_path: absPath,
          path_captures: hasGlob(template) ? globCaptures(template, absPath) ?? [] : [],
          format: descriptor.format,
          text: read.result.text,
          truncated: read.result.truncated,
          fingerprint: read.result.fingerprint,
          export_refused: read.export_refused,
          export_refused_by: read.export_refused_by,
          parsed,
          parse_error,
        });
      }
    }
  }
}

// ── surfaces: file-backed locations ────────────────────────────────────────────────

async function collectSurfaces({ adapter, env, rules, knownRoots, files, links, exclusions, truncations }) {
  for (const surface of adapter.surfaces ?? []) {
    for (const location of surface.locations ?? []) {
      // Embedded locations are resolved by normalize against sources[]; derived_from
      // locations need the items that reference them, so both are later passes.
      if (location.match === "embedded" || location.source_id) continue;
      if (location.match === "derived_from") continue;
      for (const context of contextsFor(env, location)) {
        const template = expandTemplate(location.path ?? "", context.tokens);
        if (isUnresolved(template)) continue;
        // Containment is judged against the root the LOCATION declares. Using every
        // adapter root would make `${HOME}` (declared because `.claude.json` lives
        // there) swallow the whole machine and erase the crossing/internal distinction.
        const roots = locationRoots(adapter, location, context.tokens, env);
        const bases = hasGlob(template)
          ? await expandGlobPath(template, { caps: env.caps, ignoredDirs: IGNORED_DIRS })
          : [template];
        for (const base of bases) {
          const captured = hasGlob(template) ? globCaptures(template, base) ?? [] : [];
          const collected = await collectLocation({
            location,
            base,
            roots,
            knownRoots,
            caps: env.caps,
            ignoredDirs: IGNORED_DIRS,
            onLink: async (classification, absPath, name) => {
              if (classification.outcome !== OUTCOME.UNRESOLVED) return;
              links.push({
                adapter_id: adapter.id,
                surface_id: surface.surface_id,
                scope: location.scope,
                project: context.project,
                name,
                abs_path: absPath,
                link: {
                  target_display: linkLabel(classification.resolved, classification.raw_target, env.homeDir),
                  refusal: classification.refusal,
                  hops: classification.hops,
                },
              });
            },
          });
          for (const candidate of collected) {
            const node = await readNode({
              adapter,
              surface,
              location,
              context,
              env,
              roots: [...roots, ...(candidate.extra_roots ?? [])],
              rules,
              exclusions,
              truncations,
              candidate,
              pathCaptures: captured,
            });
            if (node) files.push(node);
          }
        }
      }
    }
  }
}

async function readNode({ adapter, surface, location, context, env, roots, rules, exclusions, truncations, candidate, pathCaptures }) {
  // A surface cap narrows the global cap, never widens it: `caps.max_bytes` records the
  // runtime's own budget (Codex truncates instructions at 32 KiB), and the run's cap is
  // the user's. The smaller of the two is the honest one.
  const maxBytes = Math.min(surface.caps?.max_bytes ?? env.caps.file_bytes, env.caps.file_bytes);
  const read = await readGuarded({
    absPath: candidate.abs_path,
    roots,
    rules: fileRules(rules),
    env,
    exclusions,
    truncations,
    surfaceId: surface.surface_id,
    maxBytes,
    claimedBySurface: true,
  });
  if (!read) return null;

  const { parsed, parse_error } = parseText(surface.format, read.result.text);
  const containerDir = surface.container === "directory" ? path.dirname(candidate.abs_path) : null;
  const assets = containerDir
    ? await collectAssets(containerDir, roots, env, candidate.abs_path, surface)
    : [];

  return {
    adapter_id: adapter.id,
    surface_id: surface.surface_id,
    kind: surface.kind,
    scope: location.scope,
    project: context.project,
    format: surface.format,
    container: surface.container,
    abs_path: candidate.abs_path,
    container_dir: containerDir,
    assets,
    text: read.result.text,
    bytes: read.result.bytes,
    exec_bit: read.result.exec_bit,
    eol: eolOf(read.result.text),
    truncated: read.result.truncated,
    fingerprint: read.result.fingerprint,
    export_refused: read.export_refused,
    export_refused_by: read.export_refused_by,
    parsed,
    parse_error,
    captures: { ...candidate.captures, path: pathCaptures },
    order_index: candidate.order_index,
    applied: candidate.applied,
    applied_reason: candidate.applied_reason,
    link: candidate.link,
  };
}

/**
 * One guarded read. A `hard` never-export rule refuses the open outright; a
 * `secret_sink` rule reads the structure and marks the bytes as refused for export
 * (COD §5.1 — "its structure is still reported; its bytes never leave"); a `soft` rule
 * yields to a surface that explicitly declared the path.
 */
async function readGuarded({ absPath, roots, rules, env, exclusions, truncations, surfaceId, maxBytes, claimedBySurface = false }) {
  const denied = matchFileRule(rules, absPath);
  const info = await lstatOrNull(absPath);
  if (denied) {
    const refusesOpen = denied.blocks_declared_surface || (!claimedBySurface && !denied.scan_and_refuse);
    if (refusesOpen) {
      if (info) {
        exclusions.record(denied.rule, {
          label: safeLabel(absPath, env),
          bytes: info.size ?? 0,
          unit: "files",
        });
      }
      return null;
    }
    if (denied.scan_and_refuse && info) {
      exclusions.record(denied.rule, {
        label: safeLabel(absPath, env),
        bytes: info.size ?? 0,
        unit: "files",
        note: "scanned for structure, refused for export",
      });
    }
  }
  if (!info?.isFile()) return null;
  const result = await safeReadText(absPath, roots, maxBytes);
  if (!result.ok) return null;
  if (result.truncated) {
    truncations.push({
      path: tokenize(absPath, env),
      display_path: displayPath(absPath, env.homeDir),
      surface_id: surfaceId,
      bytes: result.bytes,
      kept_bytes: result.read_bytes,
      cap: maxBytes,
      reason: "per-file byte cap",
    });
  }
  return {
    result,
    export_refused: Boolean(denied?.scan_and_refuse),
    export_refused_by: denied?.scan_and_refuse ? denied.rule.rule_id : null,
  };
}

/**
 * A refusal record names a location without carrying a machine layout: home-relative, and
 * with any path a runtime encoded into a directory name substituted too (THR C2/E4).
 */
function safeLabel(absPath, env) {
  return tokenizeWithin(displayPath(absPath, env.homeDir), env);
}

function parseText(format, text) {
  try {
    return { parsed: formatFor(format).parse(text), parse_error: null };
  } catch (error) {
    return { parsed: null, parse_error: String(error?.message ?? error) };
  }
}

/**
 * payload_policy `definition` (manifest §5.5): assets are LISTED with size and exec bit,
 * not carried. The bundle states exactly what it did not carry, and an exec-bit asset
 * escalates its item's trust tier.
 */
async function collectAssets(directory, roots, env, definitionPath, surface) {
  const roles = surface.assets?.roles ?? {};
  const assets = [];
  const walk = async (current, depth, prefix) => {
    if (depth > 3 || assets.length >= 500) return;
    for (const entry of (await safeEntries(current)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full, depth + 1, relative);
        continue;
      }
      if (full === definitionPath) continue;
      const info = await lstatOrNull(full);
      if (!info) continue;
      assets.push({
        display_path: relative,
        role: roleFor(relative, roles),
        bytes: info.size,
        exec_bit: Boolean(info.mode & 0o111),
        included: false,
        reason: "payload_policy=definition",
      });
    }
  };
  await walk(directory, 1, "");
  return assets;
}

function roleFor(relative, roles) {
  for (const [pattern, role] of Object.entries(roles)) {
    const regex = new RegExp(`^${pattern.replace(/\*\*/g, ".*").replace(/(?<!\.)\*/g, "[^/]*")}$`);
    if (regex.test(relative)) return role;
  }
  return /\.(mjs|cjs|js|ts|sh|bash|zsh|py|rb|pl)$/.test(relative) ? "script" : "reference";
}

// ── detection: declarations only, never a spawned process ──────────────────────────

async function detectPresence(adapter, env) {
  const checks = adapter.detect?.present_if ?? [];
  if (checks.length === 0) return false;
  for (const check of checks) {
    const target = expandTemplate(check.path ?? "", env.tokens);
    if (isUnresolved(target)) continue;
    const info = await lstatOrNull(target);
    if (check.kind === "dir_exists" && info?.isDirectory()) return true;
    if (check.kind === "file_exists" && info?.isFile()) return true;
  }
  return false;
}

/**
 * A list of strategies tried in order. `command` strategies are skipped: open core does
 * not spawn (THR §3.6), so the file-key strategy has to be able to stand alone.
 */
async function detectVersion(adapter, env) {
  for (const strategy of adapter.detect?.version ?? []) {
    if (strategy.kind !== "file_key") continue;
    const absPath = expandTemplate(strategy.path ?? "", env.tokens);
    if (isUnresolved(absPath)) continue;
    const info = await lstatOrNull(absPath);
    if (!info?.isFile()) continue;
    const result = await safeReadText(absPath, [env.homeDir], env.caps.file_bytes);
    if (!result.ok) continue;
    try {
      const format = formatFor(absPath.endsWith(".toml") ? "toml" : "json");
      const parsed = format.parse(result.text);
      const value = String(strategy.key_path)
        .split(".")
        .reduce((node, key) => (node === null || node === undefined ? node : node[key]), parsed.value);
      if (typeof value === "string" && value.length > 0) return value;
    } catch {
      continue;
    }
  }
  return null;
}

/** Numeric-prefix comparison. A version that is not semver-shaped makes no claim. */
function compareSemver(a, b) {
  const parse = (value) => (/^\d+(\.\d+)*/.exec(String(value))?.[0] ?? "").split(".").map(Number);
  const left = parse(a);
  const right = parse(b);
  if (left.length === 0 || right.length === 0) return 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

function locationRoots(adapter, location, tokens, env) {
  const declared = (adapter.roots ?? []).find((root) => root.root_id === location.root_id);
  if (!declared) return rootPathsFor(adapter, tokens, env);
  const resolved = declared.platform
    ? tokens[`root:${declared.root_id}`]
    : expandTemplate(declared.path ?? "", tokens);
  return resolved && !isUnresolved(resolved) ? [resolved] : rootPathsFor(adapter, tokens, env);
}

function homeLabel(adapter, env) {
  const first = (adapter.roots ?? [])[0];
  if (!first) return null;
  const resolved = first.platform
    ? env.tokens[`root:${first.root_id}`]
    : expandTemplate(first.path ?? "", env.tokens);
  return resolved && !isUnresolved(resolved) ? tokenize(resolved, env) : null;
}

/**
 * Named deny-list sweep (THR §3.1). Deny-list beats allow-list because the cost of a
 * miss is unbounded — and a rule that fires must be VISIBLE even when no surface would
 * ever have looked there. This is how a user learns that 947 transcripts exist and were
 * deliberately not read.
 */
async function sweepDeniedPaths({ adapter, env, rules, exclusions }) {
  const applicable = fileRules(rules);
  if (applicable.length === 0) return;
  const roots = new Set();
  for (const root of adapter.roots ?? []) {
    const resolved = root.platform
      ? env.tokens[`root:${root.root_id}`]
      : expandTemplate(root.path ?? "", env.tokens);
    if (resolved && !isUnresolved(resolved)) roots.add(resolved);
  }
  const visited = new Set();
  for (const root of roots) {
    const walk = async (directory, depth) => {
      if (depth > env.caps.sweep_depth || visited.has(directory)) return;
      visited.add(directory);
      for (const entry of await safeEntries(directory)) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(directory, entry.name);
        const matched = matchFileRule(applicable, full);
        if (matched) {
          const info = await lstatOrNull(full);
          if (entry.isDirectory()) {
            const { count, bytes } = await measureTree(full, env.caps.sweep_depth - depth);
            exclusions.record(matched.rule, {
              label: safeLabel(full, env),
              bytes,
              count,
              unit: "files",
            });
          } else {
            exclusions.record(matched.rule, {
              label: safeLabel(full, env),
              bytes: info?.size ?? 0,
              unit: "files",
            });
          }
          continue;
        }
        if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name)) await walk(full, depth + 1);
      }
    };
    await walk(root, 1);
  }
}

async function measureTree(directory, remainingDepth) {
  let count = 0;
  let bytes = 0;
  const walk = async (current, depth) => {
    if (depth > Math.max(remainingDepth, 1) || count >= 20000) return;
    for (const entry of await safeEntries(current)) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      const info = await lstatOrNull(full);
      count += 1;
      bytes += info?.size ?? 0;
    }
  };
  await walk(directory, 1);
  return { count: Math.max(count, 1), bytes };
}

/**
 * Second pass: surfaces whose location is `derived_from` another surface's items — a
 * hook's `command` is a path to a script, and a hook config without its script is a
 * broken config (CLA §4.5, THR B2).
 */
export async function scanDerived({ adapters, env, items }) {
  const files = [];
  const truncations = [];
  const exclusions = new ExclusionLedger();
  const seen = new Set();

  for (const adapter of adapters) {
    const rules = fileRules(rulesFor(adapter, env.tokens));
    for (const surface of adapter.surfaces ?? []) {
      for (const location of (surface.locations ?? []).filter((entry) => entry.match === "derived_from")) {
        if (location.position !== "command") continue;
        const sourceItems = items.filter((item) => item.surface_id === location.surface_id);
        for (const item of sourceItems) {
          const command = commandOf(item);
          if (!command) continue;
          const absPath = resolveCommandPath(command, env);
          if (!absPath || seen.has(absPath)) continue;
          seen.add(absPath);
          const roots = rootPathsFor(adapter, env.tokens, env);
          const read = await readGuarded({
            absPath,
            roots,
            rules,
            env,
            exclusions,
            truncations,
            surfaceId: surface.surface_id,
            maxBytes: surface.caps?.max_bytes ?? env.caps.file_bytes,
            claimedBySurface: true,
          });
          if (!read) continue;
          files.push({
            adapter_id: adapter.id,
            surface_id: surface.surface_id,
            kind: surface.kind,
            scope: item.scope,
            project: null,
            format: surface.format,
            container: surface.container,
            abs_path: absPath,
            container_dir: null,
            text: read.result.text,
            bytes: read.result.bytes,
            exec_bit: read.result.exec_bit,
            eol: eolOf(read.result.text),
            truncated: read.result.truncated,
            fingerprint: read.result.fingerprint,
            export_refused: read.export_refused,
            export_refused_by: read.export_refused_by,
            parsed: null,
            parse_error: null,
            captures: {
              relpath: path.basename(absPath),
              basename: path.basename(absPath),
              dirname: path.basename(path.dirname(absPath)),
              path: [],
            },
            order_index: null,
            applied: true,
            applied_reason: null,
            link: null,
            derived_from_item: item.item_id,
          });
        }
      }
    }
  }
  return { files, truncations, exclusions };
}

function commandOf(item) {
  const value = item.payload?.parsed?.value;
  if (value && typeof value === "object" && typeof value.command === "string") return value.command;
  if (typeof value === "string") return value;
  return null;
}

/** argv0 of a hook command, resolved only when it is an absolute path we may read. */
function resolveCommandPath(command, env) {
  const argv0 = String(command).trim().split(/\s+/)[0]?.replace(/^["']|["']$/g, "");
  if (!argv0) return null;
  const expanded = expandTemplate(argv0, env.tokens);
  if (!path.isAbsolute(expanded)) return null;
  return toPosix(expanded) === expanded ? expanded : expanded;
}
