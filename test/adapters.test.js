import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ADAPTERS, adapterById, validateAdapters } from "../src/core/adapters/registry.js";
import {
  ALGEBRAS,
  CANONICAL_KINDS,
  CAPABILITY_LEVELS,
  FORMATS,
  PORTABILITY_VERDICTS,
  RESERVED_V1_1_KINDS,
  SCOPES,
  TRUST_TIERS,
} from "../src/core/model/kinds.js";

const ADAPTER_MODULES = ["claude.js", "codex.js", "hermes.js"];

function adapterSource(name) {
  return readFileSync(fileURLToPath(new URL(`../src/core/adapters/${name}`, import.meta.url)), "utf8");
}

function surfaceIds(runtime) {
  return adapterById(runtime).surfaces.map((surface) => surface.surface_id);
}

function walk(node, visit, path = "$", seen = new Set()) {
  visit(node, path);
  if (!node || typeof node !== "object") return;
  if (seen.has(node)) return;
  seen.add(node);
  for (const [key, value] of Object.entries(node)) walk(value, visit, `${path}.${key}`, seen);
}

// ── the registry is healthy ────────────────────────────────────────────────

test("validateAdapters returns zero problems for the shipped registry", () => {
  assert.deepEqual(validateAdapters(), []);
});

test("adapterById resolves each registered adapter and throws on an unknown id", () => {
  assert.equal(adapterById("claude").id, "claude");
  assert.equal(adapterById("codex").id, "codex");
  assert.equal(adapterById("hermes").id, "hermes");
  assert.throws(() => adapterById("nope"), /no adapter registered/);
});

// ── descriptor coverage: this is what stops a surface being quietly dropped ──

test("Claude declares every §2.1 discovery row", () => {
  const ids = surfaceIds("claude");
  const expected = [
    "claude.instructions.managed",
    "claude.instructions.user",
    "claude.instructions.project",
    "claude.instructions.local",
    "claude.rules.user",
    "claude.rules.project",
    "claude.skills.user",
    "claude.skills.project",
    "claude.skills.plugin",
    "claude.commands.user",
    "claude.commands.project",
    "claude.mcp.user",
    "claude.mcp.local",
    "claude.mcp.project",
    "claude.mcp.settings",
    "claude.mcp.managed",
    "claude.hooks.settings",
    "claude.hooks.plugin",
    "claude.hooks.frontmatter",
    "claude.hook_scripts",
    "claude.subagents.user",
    "claude.subagents.project",
    "claude.agent_memory",
    "claude.memory.auto",
    "claude.settings.managed",
    "claude.settings.user",
    "claude.settings.project",
    "claude.settings.local",
    "claude.permissions",
    "claude.plugins.installed",
    "claude.marketplaces",
    "claude.output_styles",
    "claude.keybindings",
    "claude.statusline",
    "claude.launch_config",
  ];
  for (const id of expected) assert.ok(ids.includes(id), `missing Claude surface ${id}`);
  assert.equal(ids.length, 35, "Claude surface count changed — update §2.1 coverage deliberately, never silently");
  assert.deepEqual(ids, expected, "Claude surfaces must stay in §2.1 table order");
});

test("Codex declares every §2.3 discovery row", () => {
  const ids = surfaceIds("codex");
  const expected = [
    "codex.instructions.global",
    "codex.instructions.project",
    "codex.config.system",
    "codex.config.user",
    "codex.config.profile",
    "codex.config.project",
    "codex.mcp",
    "codex.prompts",
    "codex.skills.codex_home",
    "codex.skills.agents_user",
    "codex.skills.repo",
    "codex.skills.admin",
    "codex.skills_config",
    "codex.hooks.json",
    "codex.hooks.inline",
    "codex.subagents",
    "codex.approval",
    "codex.sandbox",
    "codex.permission_profiles",
    "codex.rules",
    "codex.shell_env_policy",
    "codex.memories",
    "codex.model_providers",
    "codex.plugins",
    "codex.marketplaces",
    "codex.tui",
    "codex.notify",
    "codex.features",
    "codex.apps",
  ];
  for (const id of expected) assert.ok(ids.includes(id), `missing Codex surface ${id}`);
  assert.equal(ids.length, 29, "Codex surface count changed — update §2.3 coverage deliberately, never silently");
});

test("every canonical v1 kind that a runtime can carry is covered by at least one surface", () => {
  const covered = new Set();
  for (const adapter of ADAPTERS) for (const surface of adapter.surfaces) covered.add(surface.kind);
  const v1Kinds = CANONICAL_KINDS.filter(
    (kind) => !RESERVED_V1_1_KINDS.includes(kind) && kind !== "unresolved_link" && kind !== "opaque",
  );
  for (const kind of v1Kinds) assert.ok(covered.has(kind), `no surface declares kind ${kind}`);
});

test("every v1.1 reserved kind is declared, and says so in notes", () => {
  const reservedSurfaces = ADAPTERS.flatMap((adapter) => adapter.surfaces).filter((surface) =>
    RESERVED_V1_1_KINDS.includes(surface.kind),
  );
  const kinds = new Set(reservedSurfaces.map((surface) => surface.kind));
  for (const kind of RESERVED_V1_1_KINDS) assert.ok(kinds.has(kind), `reserved kind ${kind} has no descriptor`);
  for (const surface of reservedSurfaces) {
    assert.match(
      surface.notes || "",
      /RESERVED for v1\.1/,
      `${surface.surface_id} carries a v1.1 kind but does not say it is reserved and unpopulated in v1`,
    );
  }
});

// ── the encoded hazards §2.4 requires as FIELDS rather than comments ────────

test("Codex encodes the project banned-key list on the project config emit", () => {
  const projectConfig = adapterById("codex").surfaces.find((s) => s.surface_id === "codex.config.project");
  const banned = projectConfig.emit.banned_in_scopes;
  for (const key of [
    "openai_base_url",
    "chatgpt_base_url",
    "apps_mcp_product_sku",
    "model_provider",
    "model_providers",
    "notify",
    "profile",
    "profiles",
    "experimental_realtime_ws_base_url",
    "otel",
  ]) {
    assert.ok(banned.includes(key), `banned key ${key} missing from codex.config.project emit`);
  }
});

test("Codex refuses rather than warns on the pre-0.134 profile mechanism", () => {
  const codex = adapterById("codex");
  assert.equal(codex.detect.breaking_below, "0.134.0");
  const profile = codex.surfaces.find((s) => s.surface_id === "codex.config.profile");
  assert.match(profile.notes, /top-level keys only/);
  assert.match(profile.notes, /legacy no-ops since 0\.134\.0/);
});

test("codex.rules is declared, scanned and hard-refused for export", () => {
  const rules = adapterById("codex").surfaces.find((s) => s.surface_id === "codex.rules");
  assert.equal(rules.kind, "rule_script");
  assert.equal(rules.never_export.severity, "hard");
  assert.equal(rules.emit.target, null);
  assert.equal(rules.emit.write_mode, "none");
  assert.equal(rules.portability.class, "SECRET");
  assert.deepEqual(rules.argv_positions, ["$"]);
  const adapterRule = adapterById("codex").never_export.find((r) => r.rule_id === "codex.rules_secret_sink");
  assert.ok(adapterRule, "codex.rules must also appear in the adapter-level never_export table");
  assert.equal(adapterRule.severity, "hard");
});

test("[hooks.state] and [projects.<abs>] are never_export rules and never surfaces", () => {
  const codex = adapterById("codex");
  const ids = codex.surfaces.map((s) => s.surface_id);
  assert.ok(!ids.some((id) => /hooks\.state|projects/.test(id)));
  for (const surface of codex.surfaces) {
    for (const location of surface.locations) {
      assert.ok(
        !/hooks\.state|^projects/.test(location.key_path || ""),
        `${surface.surface_id} addresses a never-export key path`,
      );
    }
  }
  const ruleIds = codex.never_export.map((r) => r.rule_id);
  assert.ok(ruleIds.includes("codex.hooks_state"));
  assert.ok(ruleIds.includes("codex.project_trust"));
});

// ── spike-corrections §7.2 / §7.3 ──────────────────────────────────────────

test('a bare "$" never means unconditional redaction — it is a deep-scan position', () => {
  for (const adapter of ADAPTERS) {
    for (const surface of adapter.surfaces) {
      assert.ok(
        !(surface.secret_positions || []).includes("$"),
        `${surface.surface_id}: "$" in secret_positions would placeholder every leaf (spike-corrections §7.2)`,
      );
    }
  }
  const permissions = adapterById("claude").surfaces.find((s) => s.surface_id === "claude.permissions");
  assert.deepEqual(permissions.deep_scan_positions, ["$"]);
  assert.deepEqual(permissions.secret_positions, []);
});

test("hook command positions are argv positions, not secret positions", () => {
  const hookSurfaces = ADAPTERS.flatMap((a) => a.surfaces).filter((s) => s.kind === "hook");
  assert.ok(hookSurfaces.length >= 5);
  for (const surface of hookSurfaces) {
    assert.ok(surface.argv_positions.includes("command"), `${surface.surface_id}: command must be argv-scanned`);
    assert.ok(
      !surface.secret_positions.includes("command"),
      `${surface.surface_id}: unconditional redaction destroys the portable content (spike-corrections §7.3)`,
    );
  }
});

test("MCP surfaces keep concrete secret key paths", () => {
  for (const surface of ADAPTERS.flatMap((a) => a.surfaces).filter((s) => s.kind === "mcp_server")) {
    assert.ok(surface.secret_positions.includes("env.*"), `${surface.surface_id}: env.* must be redacted positionally`);
    assert.ok(surface.secret_positions.includes("url"), `${surface.surface_id}: url userinfo must be redacted positionally`);
  }
});

// ── evidence and confidence ────────────────────────────────────────────────

test("every surface carries a non-empty evidence citation", () => {
  for (const adapter of ADAPTERS) {
    for (const surface of adapter.surfaces) {
      assert.equal(typeof surface.evidence, "string", `${surface.surface_id}: evidence must be a string`);
      assert.ok(surface.evidence.trim().length > 20, `${surface.surface_id}: evidence is not a real citation`);
    }
  }
});

test('every confidence "low" surface explains itself in notes', () => {
  const low = ADAPTERS.flatMap((a) => a.surfaces).filter((s) => s.confidence === "low");
  assert.equal(low.length, 2, "the research could not confirm exactly two surfaces");
  for (const surface of low) {
    assert.ok(surface.notes && surface.notes.trim().length > 0, `${surface.surface_id}: low confidence needs notes`);
    assert.match(surface.notes, /CONFIDENCE LOW/, `${surface.surface_id}: notes must say why the surface is uncertain`);
  }
  assert.deepEqual(
    low.map((s) => s.surface_id).sort(),
    ["claude.launch_config", "claude.mcp.settings"],
  );
});

test("every lint carries evidence and a closed-set operator", () => {
  const OPS = new Set([
    "has_key",
    "missing_key",
    "matches",
    "not_matches",
    "path_is_absolute",
    "references_missing_path",
    "value_in",
    "value_not_in",
    "count_gt",
    "sibling_exists",
    "edge_absent",
    "edge_present",
    "and",
    "or",
    "not",
  ]);
  const assertOp = (predicate, lintId) => {
    assert.ok(OPS.has(predicate.op), `${lintId}: operator "${predicate.op}" is outside the closed set (§1.5)`);
    for (const rule of predicate.rules || []) assertOp(rule, lintId);
    if (predicate.rule) assertOp(predicate.rule, lintId);
  };
  for (const adapter of ADAPTERS) {
    for (const lint of adapter.lints) {
      assert.ok(lint.evidence && lint.evidence.length > 20, `${lint.lint_id}: missing evidence`);
      assert.equal(typeof lint.auto_fixable, "boolean", `${lint.lint_id}: auto_fixable must be declared`);
      assertOp(lint.predicate, lint.lint_id);
    }
  }
});

test("the six v1 lints ship", () => {
  const ids = ADAPTERS.flatMap((a) => a.lints).map((l) => l.lint_id);
  for (const id of [
    "skill.frontmatter.underscore_variant",
    "instructions.invisible_to_runtime",
    "hook.gated_by_sentinel",
    "path.absolute_home",
    "permission.dead_rule",
    "mcp.url_without_type",
    "secret.in_permission_rule",
  ]) {
    assert.ok(ids.includes(id), `missing v1 lint ${id}`);
  }
});

test("hook.gated_by_sentinel reads an edge the adapter actually derives", () => {
  const claude = adapterById("claude");
  const lint = claude.lints.find((l) => l.lint_id === "hook.gated_by_sentinel");
  assert.deepEqual(lint.predicate, { op: "edge_present", rel: "gated_by" });
  const hooks = claude.surfaces.find((s) => s.surface_id === "claude.hooks.settings");
  assert.ok(
    hooks.derive_edges.some((edge) => edge.rel === "gated_by"),
    "the lint's edge must be derived by the surface, not invented by the engine",
  );
});

// ── purity: adapters are data ──────────────────────────────────────────────

test("adapter modules import nothing but ../model/kinds.js", () => {
  for (const name of ADAPTER_MODULES) {
    const source = adapterSource(name);
    assert.ok(!/from\s+["']node:fs["']/.test(source), `${name} imports node:fs`);
    assert.ok(!/from\s+["']node:path["']/.test(source), `${name} imports node:path`);
    assert.ok(!/require\s*\(/.test(source), `${name} uses require()`);
    const imports = [...source.matchAll(/^\s*import\s.+?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.equal(specifier, "../model/kinds.js", `${name} imports ${specifier}`);
    }
  }
});

test("adapter modules have exactly one default export", () => {
  for (const name of ADAPTER_MODULES) {
    const source = adapterSource(name);
    const defaults = source.match(/^export default /gm) || [];
    assert.equal(defaults.length, 1, `${name} must have exactly one default export`);
    const named = source.match(/^export (?!default)/gm) || [];
    assert.equal(named.length, 0, `${name} must have no named exports`);
  }
});

test("no function value exists at any depth in any adapter", () => {
  for (const adapter of ADAPTERS) {
    walk(adapter, (node, path) => {
      assert.notEqual(typeof node, "function", `${adapter.id}: function value at ${path}`);
      if (node !== null && typeof node === "object") {
        assert.ok(
          Array.isArray(node) || Object.getPrototypeOf(node) === Object.prototype,
          `${adapter.id}: non-plain object at ${path}`,
        );
      }
    });
  }
});

test("every adapter survives a JSON round-trip unchanged", () => {
  for (const adapter of ADAPTERS) {
    assert.deepEqual(JSON.parse(JSON.stringify(adapter)), adapter, `${adapter.id} is not pure JSON data`);
  }
});

// ── vocabulary conformance ─────────────────────────────────────────────────

test("every declared value comes from the canonical vocabulary", () => {
  const tiers = Object.keys(TRUST_TIERS);
  for (const adapter of ADAPTERS) {
    const sourceIds = new Set(adapter.sources.map((s) => s.source_id));
    for (const surface of adapter.surfaces) {
      assert.ok(CANONICAL_KINDS.includes(surface.kind), `${surface.surface_id}: kind`);
      assert.ok(FORMATS.includes(surface.format), `${surface.surface_id}: format`);
      assert.ok(ALGEBRAS.includes(surface.merge.algebra), `${surface.surface_id}: algebra`);
      assert.ok(CAPABILITY_LEVELS.includes(surface.capability), `${surface.surface_id}: capability`);
      assert.ok(tiers.includes(surface.trust_tier), `${surface.surface_id}: trust_tier`);
      assert.ok(PORTABILITY_VERDICTS.includes(surface.portability.class), `${surface.surface_id}: portability`);
      for (const location of surface.locations) {
        if (location.scope !== undefined) assert.ok(SCOPES.includes(location.scope), `${surface.surface_id}: scope`);
        if (location.source_id !== undefined) {
          assert.ok(sourceIds.has(location.source_id), `${surface.surface_id}: dangling source_id`);
        }
      }
    }
  }
});

test("every never_export rule states a reason", () => {
  for (const adapter of ADAPTERS) {
    for (const rule of adapter.never_export) {
      assert.ok(rule.reason && rule.reason.trim().length > 10, `${adapter.id}/${rule.rule_id}: reason`);
      assert.ok(["hard", "soft"].includes(rule.severity), `${adapter.id}/${rule.rule_id}: severity`);
    }
  }
});

test("authority-bearing surfaces are the ones the consent table names", () => {
  const authoritative = ADAPTERS.flatMap((a) => a.surfaces)
    .filter((s) => s.authority === true)
    .map((s) => s.surface_id);
  for (const id of [
    "claude.permissions",
    "claude.marketplaces",
    "codex.approval",
    "codex.sandbox",
    "codex.permission_profiles",
    "codex.rules",
    "codex.marketplaces",
  ]) {
    assert.ok(authoritative.includes(id), `${id} must be authority: true — it never rides a bulk accept`);
  }
});

test("every EXECUTABLE surface that can be written declares a disabled form", () => {
  for (const adapter of ADAPTERS) {
    for (const surface of adapter.surfaces) {
      if (surface.trust_tier !== "EXECUTABLE") continue;
      if (surface.emit.write_mode === "none") continue;
      assert.ok(
        surface.emit.disabled_form,
        `${surface.surface_id}: EXECUTABLE items are quarantined on write, so a disabled form is required (§5.2)`,
      );
    }
  }
});

// ── the Hermes invariant ───────────────────────────────────────────────────

test("Hermes is declared, empty, and explains why", () => {
  const hermes = adapterById("hermes");
  assert.equal(hermes.status, "declared");
  assert.deepEqual(hermes.surfaces, []);
  assert.deepEqual(hermes.capabilities, {});
  assert.deepEqual(hermes.transforms, []);
  assert.deepEqual(hermes.lints, []);
  assert.deepEqual(hermes.never_export, []);
  assert.equal(typeof hermes.detect.reason, "string");
  assert.ok(hermes.detect.reason.trim().length > 0);
  assert.match(hermes.detect.reason, /no installation surveyed/);
});

// ── negative tests: the invariants actually bite ───────────────────────────

function baseSurface(overrides = {}) {
  return {
    surface_id: "fake.surface",
    kind: "instructions",
    confidence: "high",
    evidence: "FAKE §1 — a citation long enough to pass the length check",
    locations: [{ scope: "user", root_id: "fake_home", path: "${HOME}/x", match: "file" }],
    format: "md",
    container: "file",
    identity: { from: "relpath", template: "{relpath}" },
    recognized_keys: [],
    merge: { algebra: "concatenate", group: "fake.instructions", effective_key: "chain" },
    secret_positions: [],
    deep_scan_positions: [],
    argv_positions: [],
    portability: { class: "PORTABLE", rewrites: [] },
    trust_tier: "INERT",
    capability: "native",
    emit: { target: null, write_mode: "none" },
    ...overrides,
  };
}

function baseAdapter(overrides = {}) {
  return {
    id: "fake",
    display_name: "Fake",
    status: "supported",
    adapter_version: "0.0.1",
    detect: { present_if: [], version: [] },
    tokens: {},
    roots: [],
    layer_ranks: {},
    project_markers: [],
    secret_key_allowlist: [],
    sources: [],
    surfaces: [baseSurface()],
    capabilities: {},
    transforms: [],
    lints: [],
    never_export: [],
    ...overrides,
  };
}

test("negative: the fixture adapter itself is valid, so each failure is isolated", () => {
  assert.deepEqual(validateAdapters([baseAdapter()]), []);
});

test("negative: a declared adapter with surfaces is a problem", () => {
  const problems = validateAdapters([baseAdapter({ status: "declared", detect: { reason: "not surveyed" } })]);
  assert.ok(problems.some((p) => /status "declared" requires zero surfaces/.test(p)), problems.join("\n"));
});

test("negative: a declared adapter without a detect.reason is a problem", () => {
  const problems = validateAdapters([baseAdapter({ status: "declared", surfaces: [] })]);
  assert.ok(problems.some((p) => /requires a non-empty detect\.reason/.test(p)), problems.join("\n"));
});

test("negative: a supported adapter with no surfaces is a problem", () => {
  const problems = validateAdapters([baseAdapter({ surfaces: [] })]);
  assert.ok(problems.some((p) => /requires at least one surface/.test(p)), problems.join("\n"));
});

test("negative: a surface with no evidence is a problem", () => {
  const problems = validateAdapters([baseAdapter({ surfaces: [baseSurface({ evidence: "" })] })]);
  assert.ok(problems.some((p) => /missing evidence citation/.test(p)), problems.join("\n"));
});

test('negative: a "partial" adapter with no known_gaps is a problem', () => {
  const problems = validateAdapters([baseAdapter({ status: "partial" })]);
  assert.ok(problems.some((p) => /requires a non-empty known_gaps/.test(p)), problems.join("\n"));
  assert.deepEqual(validateAdapters([baseAdapter({ status: "partial", known_gaps: ["hooks not surveyed"] })]), []);
});

test("negative: a function value anywhere in an adapter is a problem", () => {
  const problems = validateAdapters([
    baseAdapter({ surfaces: [baseSurface({ portability: { class: "PORTABLE", rewrites: [{ detector: () => true }] } })] }),
  ]);
  assert.ok(problems.some((p) => /function values are not permitted/.test(p)), problems.join("\n"));
});

test("negative: a dangling source_id is a problem", () => {
  const problems = validateAdapters([
    baseAdapter({
      surfaces: [
        baseSurface({
          container: "embedded",
          format: "json",
          locations: [{ scope: "user", source_id: "does.not.exist", key_path: "a.*", match: "embedded" }],
        }),
      ],
    }),
  ]);
  assert.ok(problems.some((p) => /unknown source_id "does\.not\.exist"/.test(p)), problems.join("\n"));
});

test("negative: an off-vocabulary kind, algebra, format, scope or tier is a problem", () => {
  const cases = [
    [{ kind: "not_a_kind" }, /kind "not_a_kind" is not in CANONICAL_KINDS/],
    [{ merge: { algebra: "merge_hard", group: "g", effective_key: "chain" } }, /algebra "merge_hard" is not in ALGEBRAS/],
    [{ format: "rst" }, /format "rst" is not in FORMATS/],
    [{ trust_tier: "SPICY" }, /trust_tier "SPICY" is not a TRUST_TIERS key/],
    [{ capability: "maybe" }, /capability "maybe" is not in CAPABILITY_LEVELS/],
    [{ portability: { class: "MOSTLY", rewrites: [] } }, /portability\.class "MOSTLY" is not in PORTABILITY_VERDICTS/],
    [
      { locations: [{ scope: "galaxy", root_id: "r", path: "p", match: "file" }] },
      /location scope "galaxy" is not in SCOPES/,
    ],
  ];
  for (const [override, pattern] of cases) {
    const problems = validateAdapters([baseAdapter({ surfaces: [baseSurface(override)] })]);
    assert.ok(problems.some((p) => pattern.test(p)), `${pattern} not raised; got:\n${problems.join("\n")}`);
  }
});

test("negative: a duplicate surface_id is a problem", () => {
  const problems = validateAdapters([baseAdapter({ surfaces: [baseSurface(), baseSurface()] })]);
  assert.ok(problems.some((p) => /duplicate surface_id/.test(p)), problems.join("\n"));
});

test("negative: a never_export rule without a reason is a problem", () => {
  const problems = validateAdapters([
    baseAdapter({ never_export: [{ rule_id: "x", match: "${HOME}/y", class: "auth", severity: "hard" }] }),
  ]);
  assert.ok(problems.some((p) => /never_export rule requires a reason/.test(p)), problems.join("\n"));
});

test('negative: a "low" confidence surface without notes is a problem', () => {
  const problems = validateAdapters([baseAdapter({ surfaces: [baseSurface({ confidence: "low" })] })]);
  assert.ok(problems.some((p) => /confidence "low" requires notes/.test(p)), problems.join("\n"));
});

test("negative: a derived_from location pointing at an unknown surface is a problem", () => {
  const problems = validateAdapters([
    baseAdapter({
      surfaces: [baseSurface({ locations: [{ match: "derived_from", surface_id: "ghost", position: "command" }] })],
    }),
  ]);
  assert.ok(problems.some((p) => /derived_from references unknown surface_id "ghost"/.test(p)), problems.join("\n"));
});
