// RawNode -> Item. Generic: every decision is read out of the surface descriptor.
//
// The load-bearing modelling choice is manifest §3.1 — settings decompose to KEYS, not
// files. Precedence, portability, consent and secret position are all per-key, and a
// file-level item cannot express three merge algebras at once.

import {
  captureKeyPattern,
  displayPath,
  globMatch,
  matchKeyPattern,
  matchesPrefix,
  toPosix,
  tokenize,
  tokenizeWithin,
} from "../fsx/paths.js";
import { contentId, disambiguate, expandIdentity, itemId } from "../model/identity.js";
import { makeItem, makeOrigin, makePayload, splitRecognized } from "../model/item.js";
import { maxTier } from "../model/kinds.js";
import { ExclusionLedger, embeddedRules, rulesFor } from "../policy/never-export.js";

export function normalize({ adapters, env, scanResult, existing = null }) {
  const state = existing ?? { items: [], layers: new Map(), taken: new Set(), trust: new Map() };
  const exclusions = new ExclusionLedger();
  if (!existing) resolveProjectTrust({ adapters, env, scanResult, trust: state.trust });

  // A project-scoped layer is qualified by its project. Manifest §3.2 writes the id as
  // `<runtime>/<scope>`, which is right for one project but collapses N of them into one
  // row — and trust, and therefore suppression, is decided per project (COD §4.4).
  const addLayer = (adapter, scope, sourceLabel, project = null) => {
    const suppressedBy = suppressionFor(state.trust, adapter, scope, project);
    const scoped = project && (scope === "project" || scope === "local");
    const layerId = scoped ? `${adapter.id}/${scope}#${project.project_id}` : `${adapter.id}/${scope}`;
    const layer = state.layers.get(layerId) ?? {
      layer_id: layerId,
      runtime: adapter.id,
      scope,
      project_id: project?.project_id ?? null,
      rank: adapter.layer_ranks?.[scope] ?? 0,
      source_label: sourceLabel ?? null,
      present: true,
      suppressed_by: null,
    };
    if (sourceLabel && !layer.source_label) layer.source_label = sourceLabel;
    if (suppressedBy) layer.suppressed_by = suppressedBy;
    state.layers.set(layerId, layer);
    return layerId;
  };

  const push = (item) => {
    item.item_id = disambiguate(item.item_id, state.taken);
    state.taken.add(item.item_id);
    state.items.push(item);
    return item;
  };

  const adapterOf = (id) => adapters.find((candidate) => candidate.id === id);
  const surfaceOf = (adapter, id) => adapter.surfaces.find((candidate) => candidate.surface_id === id);

  for (const node of scanResult.files) {
    const adapter = adapterOf(node.adapter_id);
    const surface = surfaceOf(adapter, node.surface_id);
    if (!surface) continue;
    const project = projectFromEncodedPath(surface, node, env) ?? node.project ?? null;
    const layerId = addLayer(adapter, node.scope, tokenize(node.abs_path, env), project);
    push(fileItem({ adapter, surface, node, env, layerId, project }));
  }

  for (const link of scanResult.links ?? []) {
    const adapter = adapterOf(link.adapter_id);
    const surface = surfaceOf(adapter, link.surface_id);
    if (!surface) continue;
    const layerId = addLayer(adapter, link.scope, null, link.project);
    push(unresolvedLinkItem({ adapter, surface, link, env, layerId }));
  }

  for (const source of scanResult.sources ?? []) {
    const adapter = adapterOf(source.adapter_id);
    if (!source.parsed) {
      if (source.parse_error) {
        const layerId = addLayer(adapter, source.scope, tokenize(source.abs_path, env), source.project);
        push(opaqueItem({ adapter, source, env, layerId }));
      }
      continue;
    }
    const layerId = addLayer(adapter, source.scope, tokenize(source.abs_path, env), source.project);
    const rules = embeddedRules(rulesFor(adapter, env.tokens));
    const surfaces = (adapter.surfaces ?? []).filter((surface) =>
      (surface.locations ?? []).some((location) => location.source_id === source.source_id),
    );
    const claimed = surfaces.flatMap((surface) => [
      ...(surface.claims ?? []),
      ...(surface.locations ?? [])
        .filter((location) => location.source_id === source.source_id && location.key_path && location.key_path !== "**")
        .map((location) => location.key_path),
    ]);

    // A never-export rule on an embedded key subtree prunes the subtree and records the
    // number of LEAVES pruned — a key rule has no natural file count, and a number
    // without a unit is a number a user cannot check (spike-corrections, note 3).
    const excludedPrefixes = [];
    for (const [keyPath, value] of enumeratePaths(source.parsed.value)) {
      if (excludedPrefixes.some((prefix) => isUnder(keyPath, prefix))) continue;
      const denied = rules.find(
        (entry) => sameFile(entry.path, source.abs_path) && matchKeyPattern(entry.key_prefix, keyPath),
      );
      if (!denied) continue;
      excludedPrefixes.push(keyPath);
      // The label names the RULE's key pattern, not the concrete key path: a concrete
      // path here can itself be an absolute project path, and a refusal record must not
      // leak the machine layout it was refusing to carry (THR C2/E4).
      exclusions.record(denied.rule, {
        label: `${displayPath(source.abs_path, env.homeDir)} [${denied.key_prefix}]`,
        count: countLeaves(value),
        unit: "keys",
        note: denied.scan_and_refuse ? "scanned for structure, refused for export" : null,
      });
    }
    const isExcluded = (keyPath) => excludedPrefixes.some((prefix) => isUnder(keyPath, prefix));

    for (const surface of surfaces) {
      for (const location of surface.locations.filter((entry) => entry.source_id === source.source_id)) {
        if (location.key_path === "**") {
          for (const [keyPath, value] of enumerateLeaves(source.parsed.value)) {
            if (isExcluded(keyPath)) continue;
            if (claimed.some((pattern) => matchesPrefix(pattern, keyPath))) continue;
            push(embeddedItem({ adapter, surface, location, source, env, addLayer, keyPath, value, captures: [] }));
          }
          continue;
        }
        for (const [keyPath, value] of enumeratePaths(source.parsed.value)) {
          if (isExcluded(keyPath)) continue;
          const captures = captureKeyPattern(location.key_path, keyPath);
          if (!captures) continue;
          push(embeddedItem({ adapter, surface, location, source, env, addLayer, keyPath, value, captures }));
        }
      }
    }
  }

  return {
    state,
    items: state.items,
    layers: [...state.layers.values()].sort((a, b) => b.rank - a.rank || a.layer_id.localeCompare(b.layer_id)),
    exclusions: exclusions.list(),
  };
}

// ── item constructors ──────────────────────────────────────────────────────────────

function fileItem({ adapter, surface, node, env, layerId, project }) {
  const parsed = node.parsed ?? {};
  const frontmatter = parsed.frontmatter ?? null;
  const fieldName = surface.identity.field ?? "name";
  // Identity comes only from the declared field, wherever that format keeps it:
  // frontmatter for a Claude subagent (CLA §8.1), a top-level TOML key for a Codex one
  // ("source of truth, not the filename" — COD §4.13). Never the path.
  const declaredField = frontmatter?.[fieldName] ?? fieldOf(parsed.value, fieldName);
  const identityValue = expandIdentity(surface.identity.template, {
    ...node.captures,
    key_path: "",
    field: declaredField ?? node.captures.basename,
    ...Object.fromEntries((node.captures.path ?? []).map((capture, index) => [String(index), capture])),
  });
  const projectId = project?.project_id ?? null;
  const { recognized, unrecognized } = splitRecognized(frontmatter ?? {}, surface.recognized_keys);
  const trust = (node.assets ?? []).some((asset) => asset.exec_bit) || node.exec_bit
    ? maxTier(surface.trust_tier, "EXECUTABLE")
    : surface.trust_tier;

  const item = makeItem({
    item_id: itemId({
      runtime: adapter.id,
      scope: node.scope,
      projectId,
      kind: surface.kind,
      logicalName: identityValue,
    }),
    kind: node.parse_error ? "opaque" : surface.kind,
    runtime: adapter.id,
    surface_id: surface.surface_id,
    scope: node.scope,
    layer_id: layerId,
    project_id: projectId,
    name: identityValue,
    identity: {
      from: surface.identity.from,
      value: identityValue,
      stable_across_runs: true,
      stable_across_machines: surface.identity.from !== "composite",
    },
    origin: makeOrigin({
      path: tokenize(node.abs_path, env),
      display_path: displayPath(node.abs_path, env.homeDir),
      span: parsed.spans?.$ ?? null,
      link: node.link ? linkView(node.link, env) : null,
    }),
    payload: makePayload({
      format: node.format,
      raw: {
        sha256: contentId(node.text),
        bytes: node.bytes,
        encoding: "utf-8",
        eol: node.eol,
        ...(node.truncated ? { truncated: true } : {}),
      },
      parsed: frontmatter
        ? { frontmatter, key_order: parsed.key_order ?? [], body_entry: null }
        : { value: parsed.value ?? null, key_order: parsed.key_order ?? {} },
      recognized,
      unrecognized,
      extra: {
        ...(node.parse_error ? { parse_error: node.parse_error } : {}),
        ...(node.truncated ? { truncated: true } : {}),
      },
    }),
    assets: node.assets ?? [],
    portability: { verdict: surface.portability.class, reasons: [], rewrites: [] },
    trust_tier: trust,
    authority: surface.authority === true,
    applied: node.applied ?? true,
    applied_reason: node.applied_reason ?? null,
    export_refused: node.export_refused ?? false,
    export_refused_by: node.export_refused_by ?? null,
    // A scan-and-refuse surface keeps its STRUCTURE and drops its bytes here, not at the
    // export boundary. "The bytes never leave" (COD §5.1) is a stronger claim if they
    // were never retained in the first place.
    _raw_text: node.export_refused ? null : node.text,
    _body_text: node.export_refused ? null : (parsed.body ?? node.text),
    _truncated: node.truncated,
    _eol: node.eol,
    _captures: node.captures.path ?? [],
    _surface: surface,
    _order_index: node.order_index,
    _fingerprint: node.fingerprint,
    _abs_path: node.abs_path,
  });
  if (node.derived_from_item) {
    item.related.push({ rel: "referenced_by", item_id: node.derived_from_item });
  }
  return item;
}

function embeddedItem({ adapter, surface, location, source, env, addLayer, keyPath, value, captures }) {
  const identityValue = expandIdentity(surface.identity.template, {
    key_path: keyPath,
    basename: keyPath.split(".").pop(),
    field: fieldOf(value, surface.identity.field ?? "name") ?? keyPath.split(".").pop(),
    ...Object.fromEntries(captures.map((capture, index) => [String(index), capture])),
  });
  // The LOCATION carries the scope, not the file: `~/.claude.json` is a user-scope file
  // that also holds project-local MCP entries under `projects["<abs>"]` (CLA §3.1).
  const scope = location.scope ?? source.scope;
  const project = projectFromCaptures(surface, captures, env) ?? source.project ?? null;
  const layerId = addLayer(adapter, scope, tokenize(source.abs_path, env), project);
  const projectId = project?.project_id ?? null;
  const isObject = value !== null && typeof value === "object" && !Array.isArray(value);
  const { recognized, unrecognized } = isObject
    ? splitRecognized(value, surface.recognized_keys)
    : { recognized: {}, unrecognized: {} };
  const composite = surface.identity.from === "composite";

  return makeItem({
    item_id: itemId({
      runtime: adapter.id,
      scope,
      projectId,
      kind: surface.kind,
      logicalName: identityValue,
    }),
    kind: surface.kind,
    runtime: adapter.id,
    surface_id: surface.surface_id,
    scope,
    layer_id: layerId,
    project_id: projectId,
    name: identityValue,
    identity: {
      from: surface.identity.from,
      value: identityValue,
      stable_across_runs: !composite,
      stable_across_machines: !composite,
      ...(composite
        ? { note: "array-index identity; a reordered array changes the id — content_id is the reliable join" }
        : {}),
    },
    origin: makeOrigin({
      path: tokenize(source.abs_path, env),
      display_path: displayPath(source.abs_path, env.homeDir),
      // The key path is an origin field, and some runtimes key a block by absolute
      // project path, so it is tokenized too. The span still points at the real bytes.
      key_path: tokenizeWithin(keyPath, env),
      span: source.parsed.spans?.[keyPath] ?? null,
    }),
    payload: makePayload({
      format: source.format,
      raw: null,
      parsed: { value, key_order: source.parsed.key_order?.[keyPath] ?? [] },
      recognized,
      unrecognized,
    }),
    portability: { verdict: surface.portability.class, reasons: [], rewrites: [] },
    trust_tier: surface.trust_tier,
    authority: surface.authority === true,
    export_refused: source.export_refused ?? false,
    export_refused_by: source.export_refused_by ?? null,
    _captures: captures,
    _surface: surface,
    _fingerprint: source.fingerprint,
    _abs_path: source.abs_path,
  });
}

function unresolvedLinkItem({ adapter, surface, link, env, layerId }) {
  const projectId = link.project?.project_id ?? null;
  return makeItem({
    item_id: itemId({
      runtime: adapter.id,
      scope: link.scope,
      projectId,
      kind: "unresolved_link",
      logicalName: link.name,
    }),
    kind: "unresolved_link",
    runtime: adapter.id,
    surface_id: surface.surface_id,
    scope: link.scope,
    layer_id: layerId,
    project_id: projectId,
    name: link.name,
    identity: { from: "dirname", value: link.name, stable_across_runs: true, stable_across_machines: false },
    origin: makeOrigin({
      path: tokenize(link.abs_path, env),
      display_path: displayPath(link.abs_path, env.homeDir),
      link: { target_display: link.link.target_display, refusal: link.link.refusal, hops: link.link.hops },
    }),
    payload: null,
    portability: {
      verdict: "MACHINE-LOCAL",
      reasons: ["symlink target lies outside every declared root"],
      rewrites: [],
    },
    trust_tier: "INERT",
    related: [
      {
        rel: "external_reference",
        external: link.link.target_display,
        note: "the portability story is 'install it', not 'copy these files'",
      },
    ],
    _surface: surface,
  });
}

function opaqueItem({ adapter, source, env, layerId }) {
  return makeItem({
    item_id: itemId({
      runtime: adapter.id,
      scope: source.scope,
      projectId: source.project?.project_id ?? null,
      kind: "opaque",
      logicalName: source.source_id,
    }),
    kind: "opaque",
    runtime: adapter.id,
    surface_id: source.source_id,
    scope: source.scope,
    layer_id: layerId,
    project_id: source.project?.project_id ?? null,
    name: source.source_id,
    identity: { from: "relpath", value: source.source_id, stable_across_runs: true, stable_across_machines: true },
    origin: makeOrigin({
      path: tokenize(source.abs_path, env),
      display_path: displayPath(source.abs_path, env.homeDir),
    }),
    payload: makePayload({
      format: source.format,
      raw: { sha256: contentId(source.text), bytes: Buffer.byteLength(source.text), encoding: "utf-8", eol: "lf" },
      parsed: null,
      extra: { parse_error: source.parse_error },
    }),
    portability: { verdict: "MACHINE-LOCAL", reasons: ["file could not be parsed"], rewrites: [] },
    trust_tier: "INERT",
    _raw_text: source.text,
    _abs_path: source.abs_path,
  });
}

// ── derived views over the item set ────────────────────────────────────────────────

/**
 * Edges declared by `derive_edges` on a surface. A hook's command points at a script; a
 * script that reads a sentinel file which EXISTS is currently muted (CLA §4.4). Both are
 * conditions a settings-only port silently changes, so they are carried as data.
 */
export function deriveEdges({ items, env, probes }) {
  const byAbsPath = new Map(items.filter((item) => item._abs_path).map((item) => [item._abs_path, item]));
  for (const item of items) {
    for (const rule of item._surface?.derive_edges ?? []) {
      if (rule.from === "argv0") {
        const command = item.payload?.parsed?.value?.command;
        if (typeof command !== "string") continue;
        const argv0 = command.trim().split(/\s+/)[0];
        const target = byAbsPath.get(argv0);
        // An external reference is tokenized too: a bundle carries no machine layout,
        // and an edge is bundle content just as much as an item is (THR C2/E4).
        if (target) item.related.push({ rel: rule.rel, item_id: target.item_id });
        else item.related.push({ rel: rule.rel, external: tokenize(argv0, env), resolved: false });
        continue;
      }
      if (rule.from === "body" && rule.detector === "existing_dotfile_path") {
        for (const candidate of dotfileReferences(item._raw_text ?? "")) {
          const resolved = probes.get(candidate);
          if (resolved === true) {
            item.related.push({
              rel: rule.rel,
              external: displayPath(candidate, env.homeDir),
              note: "sentinel present: this behaviour is currently gated off",
            });
          }
        }
      }
    }
  }
  // A hook script is reachable from its hook, and the hook's gate is the script's gate:
  // a reader looking at the hook must see that it is muted.
  for (const item of items) {
    for (const edge of item.related.filter((entry) => entry.rel === "references_path" && entry.item_id)) {
      const script = items.find((candidate) => candidate.item_id === edge.item_id);
      for (const gate of script?.related.filter((entry) => entry.rel === "gated_by") ?? []) {
        item.related.push({ ...gate });
      }
    }
  }
}

const DOTFILE_REFERENCE = /(["'`\s])((?:\/|~\/|\$\{?\w+\}?\/)[^\s"'`)]*\/\.[A-Za-z0-9_.-]+)/g;

function* dotfileReferences(text) {
  for (const [, , candidate] of String(text).matchAll(DOTFILE_REFERENCE)) yield candidate;
}

/**
 * The absolute-path roots worth probing. Shared with lint.js on purpose: the lints look
 * their candidates up in the map the pipeline builds from THIS list, so two copies that
 * drift apart silently stop finding each other's paths.
 */
export const PROBEABLE_ROOTS = "Users|home|opt|usr|etc|var|private|tmp";

/**
 * Dotfile references exactly as written, because `deriveEdges` looks the probe map up by the
 * written form. Probing only absolute leaves left the idiomatic `~/…` sentinel unprobed, so
 * `hook.gated_by_sentinel` could not fire on the form most hooks actually use.
 */
export function* dotfileCandidates(items) {
  for (const item of items) {
    for (const candidate of dotfileReferences(item._raw_text ?? "")) yield candidate;
  }
}

/**
 * The absolute path a written candidate denotes, or null when it denotes nothing this scan can
 * resolve. `~` and `${HOME}` are the scanned home — never the scanning process's own — so a scan
 * of someone else's home never probes ours.
 */
export function resolveCandidatePath(candidate, homeDir) {
  if (candidate.startsWith("/")) return candidate;
  if (!homeDir) return null;
  if (candidate.startsWith("~/")) return `${homeDir}/${candidate.slice(2)}`;
  const named = candidate.match(/^\$\{?(\w+)\}?\/(.+)$/);
  if (named && named[1] === "HOME") return `${homeDir}/${named[2]}`;
  return null;
}

/** Absolute-looking path leaves, so the pipeline can probe them once for the lints. */
export function* absolutePathCandidates(items) {
  for (const item of items) {
    for (const [, value] of stringLeaves(item)) {
      for (const [match] of String(value).matchAll(
        new RegExp(`(?:^|["'\`\\s=(])(\\/(?:${PROBEABLE_ROOTS})\\/[^\\s"'\`,;)\\]]*)`, "g"),
      )) {
        yield match.replace(/^["'`\s=(]/, "");
      }
    }
  }
}

/** Manifest §1.5 — rewrites are PROPOSALS carried alongside untouched raw bytes. */
export function derivePortability(items) {
  for (const item of items) {
    const surface = item._surface;
    if (!surface?.portability) continue;
    const absolute = [...stringLeaves(item)].filter(([, value]) => /(^|[\s"'`=(])\/(Users|home)\//.test(value));
    if (absolute.length > 0) {
      const rewrite = (surface.portability.rewrites ?? []).find((entry) => entry.detector === "path.absolute_home");
      if (item.portability.verdict === "PORTABLE") item.portability.verdict = "REWRITE";
      item.portability.reasons.push("absolute home path embedded in a value");
      if (rewrite) {
        item.portability.rewrites.push({
          rewrite_id: rewrite.rewrite_id,
          detector: rewrite.detector,
          from: "/Users/<user>|/home/<user>",
          to: rewrite.target,
          applied: false,
          requires_consent: true,
        });
      }
    }
    if (item.portability.reasons.length === 0) {
      item.portability.reasons.push("no absolute paths, no machine-bound identifiers");
    }
  }
}

/**
 * Runs AFTER redaction, and re-derives the raw digest as well as the content id. Both
 * must address the bytes the bundle actually carries: a digest taken at read time is a
 * digest of the version with the credential still in it, and shipping that alongside the
 * redacted bytes is both inconsistent and a small leak of content identity.
 */
export function finalizeContentIds(items) {
  for (const item of items) {
    if (item.kind === "unresolved_link") continue;
    const canonical = item._raw_text ?? JSON.stringify(item.payload?.parsed?.value ?? null);
    item.content_id = contentId(canonical);
    if (typeof item._raw_text === "string" && item.payload?.raw) {
      item.payload.raw.sha256 = contentId(item._raw_text);
      item.payload.raw.bytes = Buffer.byteLength(item._raw_text);
    }
  }
}

// ── traversal helpers, shared with lint ────────────────────────────────────────────

export function* stringLeaves(item) {
  if (typeof item._raw_text === "string") yield ["", item._raw_text];
  const value = item.payload?.parsed?.value;
  if (value !== undefined) yield* enumerateStringLeaves(value, "");
  const frontmatter = item.payload?.parsed?.frontmatter;
  if (frontmatter !== undefined && frontmatter !== null) yield* enumerateStringLeaves(frontmatter, "");
}

export function* enumerateStringLeaves(value, prefix) {
  if (typeof value === "string") {
    yield [prefix, value];
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      yield* enumerateStringLeaves(value[index], `${prefix}[${index}]`);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      yield* enumerateStringLeaves(child, prefix ? `${prefix}.${key}` : key);
    }
  }
}

export function* enumeratePaths(value, prefix = "") {
  if (prefix !== "") yield [prefix, value];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) yield* enumeratePaths(value[index], `${prefix}[${index}]`);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      yield* enumeratePaths(child, prefix ? `${prefix}.${key}` : key);
    }
  }
}

export function* enumerateLeaves(value, prefix = "") {
  const isContainer = value !== null && typeof value === "object";
  if (!isContainer || (Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0)) {
    if (prefix !== "") yield [prefix, value];
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) yield* enumerateLeaves(value[index], `${prefix}[${index}]`);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    yield* enumerateLeaves(child, prefix ? `${prefix}.${key}` : key);
  }
}

function countLeaves(value) {
  let count = 0;
  for (const _leaf of enumerateLeaves(value, "root")) count += 1;
  return Math.max(count, 1);
}

function fieldOf(value, field) {
  if (value && typeof value === "object" && typeof value[field] === "string") return value[field];
  return null;
}

/**
 * A key-path capture that IS an absolute project path — `.claude.json` keys its
 * project-local blocks that way (CLA §3.1). Declared per surface as
 * `project_from: { capture: N }`, never guessed.
 */
function projectFromCaptures(surface, captures, env) {
  const index = surface.project_from?.capture;
  if (index === undefined || captures[index] === undefined) return null;
  const wanted = toPosix(captures[index]);
  return env.projects.find((project) => toPosix(project.path) === wanted) ?? null;
}

/**
 * Claude encodes a project's absolute path into a directory name by replacing separators
 * with `-`. The encoding is lossy and MUST NOT be inverted (CLA §12.2, manifest §9.3):
 * instead we re-encode each known project forward and match. An unmatched directory
 * stays unattributed rather than being decoded into a guess.
 */
function projectFromEncodedPath(surface, node, env) {
  const rule = surface.project_from;
  if (rule?.relpath_segment === undefined) return null;
  const segment = String(node.captures.relpath ?? "").split("/")[rule.relpath_segment];
  if (!segment) return null;
  return env.projects.find((project) => encodePath(project.path) === segment) ?? null;
}

function encodePath(value) {
  return toPosix(value).split("/").join("-");
}

function isUnder(keyPath, prefix) {
  return keyPath === prefix || keyPath.startsWith(`${prefix}.`) || keyPath.startsWith(`${prefix}[`);
}

function sameFile(rulePath, absPath) {
  return toPosix(rulePath) === toPosix(absPath) || globMatch(rulePath, absPath);
}

function linkView(link, env) {
  return {
    via_link: true,
    hops: link.hops,
    ...(link.outcome === "crossing"
      ? {
          crossing: {
            from_root: link.from_root ? tokenize(link.from_root, env) : null,
            to_root: link.to_root ? tokenize(link.to_root, env) : null,
            to_path: link.resolved ? tokenize(link.resolved, env) : null,
          },
        }
      : {}),
    target_display: link.raw_target ?? null,
  };
}

/**
 * A project the runtime does not trust skips that runtime's project layers entirely
 * (COD §4.4; CLA §3.4, §7.4). Recording it as `suppressed_by` lets the viewer explain an
 * absence rather than showing a gap (manifest §3.2).
 *
 * The trust flag is read locally and never carried. It is on the never-export table
 * precisely because exporting it would pre-trust a repository the target user never
 * consented to — which is a different question from whether we may look at it here to
 * explain why a layer is missing.
 */
function resolveProjectTrust({ adapters, env, scanResult, trust }) {
  for (const adapter of adapters) {
    const probe = adapter.project_trust;
    if (!probe) continue;
    const source = (scanResult.sources ?? []).find((entry) => entry.source_id === probe.source_id);
    const container = source?.parsed?.value?.[probe.container_key];
    for (const project of env.projects) {
      const record = container?.[project.path];
      const value = record === null || record === undefined ? undefined : record[probe.key];
      const trusted =
        value === undefined
          ? !probe.default_untrusted
          : (probe.trusted_values ?? [true]).includes(value);
      trust.set(`${adapter.id}/${project.project_id}`, trusted);
    }
  }
}

function suppressionFor(trust, adapter, scope, project) {
  if (!project || (scope !== "project" && scope !== "local")) return null;
  const known = trust.get(`${adapter.id}/${project.project_id}`);
  return known === false ? "project_untrusted" : null;
}
