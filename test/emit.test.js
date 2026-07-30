// The WritePlan's shape and the primitives underneath it: where a key lands, what a
// preview says about it, and which decisions can never be made in bulk.

import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, validateAdapters } from "../src/core/adapters/registry.js";
import { readBundle } from "../src/core/bundle/read.js";
import { PLAN_VERSION, planImport, publicPlan } from "../src/core/engine/emit.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { unifiedDiff } from "../src/core/engine/diff.js";
import { readTree, resolveTargetKeyPath, stableJson, valueAt, writeKey } from "../src/core/engine/keyedit.js";
import { canonicalKeyPath, canonicalRelPath } from "../src/core/fsx/paths.js";
import { DISABLED_FORM_MODES, WRITE_MODES } from "../src/core/model/kinds.js";
import { craft, item } from "./fixtures/bundles.js";
import { materializeHome } from "./fixtures/materialize.js";

async function planFor(records, home) {
  const bundle = craft({ items: records });
  const { manifest, entries } = readBundle(bundle.serialized);
  const env = await buildEnvironment({ homeDir: home, roots: [], os: process.platform, envVars: {}, adapters: ADAPTERS });
  return planImport({ manifest, entries, adapters: ADAPTERS, env, planId: "plan_unit" });
}

// ── key placement ───────────────────────────────────────────────────────────────────

test("an array position resolves to an append, never to the source index", () => {
  const tree = { permissions: { allow: ["Bash(ls:*)", "Bash(cat:*)"] } };
  const resolved = resolveTargetKeyPath({ tree, keyPath: "permissions.allow[0]", value: "Bash(git status:*)" });
  assert.equal(resolved.key_path, "permissions.allow[2]");
  assert.equal(resolved.append, true);
  assert.equal(resolved.duplicate_of, null);
});

test("an identical array entry resolves to the existing position, so a re-import is a no-op", () => {
  const tree = { permissions: { allow: ["Bash(ls:*)", "Bash(git status:*)"] } };
  const resolved = resolveTargetKeyPath({ tree, keyPath: "permissions.allow[0]", value: "Bash(git status:*)" });
  assert.equal(resolved.duplicate_of, 1);
  assert.equal(resolved.append, false);
});

test("a nested array finds an existing container instead of appending a second one", () => {
  const hook = { type: "command", command: "notify.sh" };
  const tree = { hooks_disabled: { Stop: [{ hooks: [hook] }] } };
  const resolved = resolveTargetKeyPath({ tree, keyPath: "hooks_disabled.Stop[0].hooks[0]", value: hook });
  assert.equal(resolved.duplicate_of, 0);
  assert.equal(resolved.key_path, "hooks_disabled.Stop[0].hooks[0]");
});

test("a nested array append declares the sibling context it cannot carry", () => {
  const tree = { hooks_disabled: { Stop: [{ matcher: "*", hooks: [{ type: "command", command: "a.sh" }] }] } };
  const resolved = resolveTargetKeyPath({
    tree,
    keyPath: "hooks_disabled.Stop[0].hooks[0]",
    value: { type: "command", command: "b.sh" },
  });
  assert.equal(resolved.key_path, "hooks_disabled.Stop[1].hooks[0]");
  assert.equal(resolved.losses.length, 1);
  assert.match(resolved.losses[0], /sibling context/);
});

// ── surgical writes ─────────────────────────────────────────────────────────────────

test("writing an existing JSON key replaces its value and nothing else", () => {
  const source = '{\n  // not really json, but the bytes survive anyway\n  "model": "opus-5",\n  "keep": [1, 2]\n}\n';
  const text = writeKey({ format: "jsonc", text: source, keyPath: "model", value: "sonnet-5" });
  assert.match(text, /not really json/);
  assert.match(text, /"model": "sonnet-5"/);
  assert.match(text, /"keep": \[1, 2\]/);
});

test("writing a new JSON key keeps sibling formatting and indentation", () => {
  const source = '{\n    "model": "opus-5"\n}\n';
  const text = writeKey({ format: "json", text: source, keyPath: "effortLevel", value: "high" });
  assert.equal(JSON.parse(text).effortLevel, "high");
  assert.equal(JSON.parse(text).model, "opus-5");
  assert.match(text, /"model": "opus-5",\n/);
});

test("a new TOML root key goes above the first table, not under the last one", async () => {
  const toml = await import("../src/core/formats/toml.js");
  const source = '# a comment\nmodel = "x"\n\n[mcp_servers.one]\ncommand = "node"\n';
  const text = writeKey({ format: "toml", text: source, keyPath: "approval_policy", value: "never" });
  const parsed = toml.parse(text);
  assert.equal(parsed.value.approval_policy, "never");
  assert.equal(parsed.value.mcp_servers.one.command, "node");
  assert.match(text, /# a comment/);
});

test("a new TOML table is appended with a header, and an existing one is replaced with a header", async () => {
  const toml = await import("../src/core/formats/toml.js");
  const source = 'model = "x"\n\n[mcp_servers.one]\ncommand = "node"\n';
  const added = writeKey({ format: "toml", text: source, keyPath: "mcp_servers.two", value: { command: "go", enabled: false } });
  assert.equal(toml.parse(added).value.mcp_servers.two.command, "go");
  const replaced = writeKey({ format: "toml", text: added, keyPath: "mcp_servers.one", value: { command: "deno", enabled: false } });
  const parsed = toml.parse(replaced);
  assert.equal(parsed.value.mcp_servers.one.command, "deno");
  assert.equal(parsed.value.mcp_servers.one.enabled, false);
  assert.equal(parsed.value.mcp_servers.two.command, "go");
});

test("appending to a TOML array of tables emits [[path]], which TOML can actually parse", async () => {
  const toml = await import("../src/core/formats/toml.js");
  const source = 'model = "x"\n\n[[hooks.PreToolUse]]\nmatcher = "Bash"\n';
  const text = writeKey({
    format: "toml",
    text: source,
    keyPath: "hooks.PreToolUse[1].hooks[0]",
    value: { type: "command", command: "guard.sh" },
  });
  const parsed = toml.parse(text);
  assert.equal(parsed.value.hooks.PreToolUse.length, 2);
  assert.equal(parsed.value.hooks.PreToolUse[0].matcher, "Bash");
  assert.equal(parsed.value.hooks.PreToolUse[1].hooks[0].command, "guard.sh");
});

test("a file that does not exist yet is created from the key alone", () => {
  const text = writeKey({ format: "json", text: null, keyPath: "permissions.allow[0]", value: "Bash(ls:*)" });
  assert.deepEqual(JSON.parse(text).permissions.allow, ["Bash(ls:*)"]);
});

// ── diffs ───────────────────────────────────────────────────────────────────────────

test("a unified diff names both sides and marks the changed lines only", () => {
  const diff = unifiedDiff({ before: "a\nb\nc\n", after: "a\nB\nc\n", fromLabel: "old", toLabel: "new" });
  assert.match(diff, /^--- old\n\+\+\+ new\n/);
  assert.match(diff, /-b\n/);
  assert.match(diff, /\+B\n/);
  assert.ok(!/[-+]a/.test(diff), "an unchanged line was marked as a change");
});

test("identical content produces no diff at all", () => {
  assert.equal(unifiedDiff({ before: "same\n", after: "same\n" }), null);
});

// ── canonicalization ────────────────────────────────────────────────────────────────

test("a path fragment is refused for the same reasons an entry name is", () => {
  for (const bad of ["../x", "/etc/x", "~/x", "a\u0000b", "a/../b", "%2e%2e%2fetc", "con.txt", "x."]) {
    assert.equal(canonicalRelPath(bad).ok, false, `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(canonicalRelPath("skills/my-skill/SKILL.md").ok, true);
});

test("a key path is refused when it could poison a prototype or address a wildcard", () => {
  for (const bad of ["__proto__", "a.__proto__.b", "constructor.prototype", "a.*", "a.**", "", "a\u0007b"]) {
    assert.equal(canonicalKeyPath(bad).ok, false, `${JSON.stringify(bad)} was accepted`);
  }
  assert.equal(canonicalKeyPath("mcpServers.slack.env.TOKEN").ok, true);
  assert.equal(canonicalKeyPath("permissions.allow[2]").ok, true);
});

// ── the plan ────────────────────────────────────────────────────────────────────────

test("the plan carries every field the design doc specifies", async (t) => {
  const fixture = await materializeHome("target");
  t.after(() => fixture.cleanup());

  const plan = await planFor(
    [
      item({
        item_id: "claude:user:instructions:CLAUDE.md",
        kind: "instructions",
        surface_id: "claude.instructions.user",
        identity: "CLAUDE.md",
        identity_from: "relpath",
        origin_path: "${CLAUDE_HOME}/CLAUDE.md",
        display_path: "~/.claude/CLAUDE.md",
        format: "md",
        raw_text: "# imported\n",
      }),
    ],
    fixture.home,
  );

  assert.equal(plan.plan_version, PLAN_VERSION);
  for (const field of ["plan_id", "bundle_digest", "created_at", "target", "operations", "blocked", "requires_credentials", "summary"]) {
    assert.ok(field in plan, `the plan has no ${field}`);
  }
  const operation = plan.operations[0];
  for (const field of [
    "op_id",
    "item_id",
    "kind",
    "trust_tier",
    "authority",
    "action",
    "target_path",
    "key_path",
    "before",
    "after",
    "diff",
    "disabled_on_write",
    "consent",
    "rollback",
    "collides_with",
  ]) {
    assert.ok(field in operation, `the operation has no ${field}`);
  }
  assert.equal(operation.before.exists, true);
  assert.match(operation.before.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.ok(operation.before.fingerprint.ino > 0, "no fingerprint was captured at plan time");
  assert.match(operation.after.sha256, /^sha256:[0-9a-f]{64}$/);
  assert.equal(operation.consent.granted, false);
});

test("the public projection strips the writer's internal state", async (t) => {
  const fixture = await materializeHome("target");
  t.after(() => fixture.cleanup());
  const plan = await planFor(
    [
      item({
        item_id: "claude:user:setting:model",
        kind: "setting",
        surface_id: "claude.settings.user",
        identity: "model",
        identity_from: "key_path",
        key_path: "model",
        value: "sonnet-5",
        trust_tier: "DECLARATIVE",
      }),
    ],
    fixture.home,
  );
  const clean = publicPlan(plan);
  const serialized = JSON.stringify(clean);
  assert.ok(!serialized.includes("_after_text"), "the serialized plan carries the writer's buffer");
  assert.ok(!serialized.includes("_item_content"));
  assert.ok(plan.operations[0]._after_text.length > 0, "the internal buffer was dropped from the live plan too");
});

test("two operations targeting one path name each other", async (t) => {
  const fixture = await materializeHome("target");
  t.after(() => fixture.cleanup());
  const plan = await planFor(
    [
      item({
        item_id: "codex:user:instructions:AGENTS.override.md",
        kind: "instructions",
        runtime: "codex",
        surface_id: "codex.instructions.global",
        identity: "AGENTS.override.md",
        identity_from: "relpath",
        origin_path: "${CODEX_HOME}/AGENTS.override.md",
        display_path: "~/.codex/AGENTS.override.md",
        format: "md",
        raw_text: "# override\n",
      }),
      item({
        item_id: "codex:user:instructions:AGENTS.md",
        kind: "instructions",
        runtime: "codex",
        surface_id: "codex.instructions.global",
        identity: "AGENTS.md",
        identity_from: "relpath",
        origin_path: "${CODEX_HOME}/AGENTS.md",
        display_path: "~/.codex/AGENTS.md",
        format: "md",
        raw_text: "# base\n",
      }),
    ],
    fixture.home,
  );
  const [first, second] = plan.operations;
  assert.deepEqual(first.collides_with, [second.op_id]);
  assert.deepEqual(second.collides_with, [first.op_id]);
});

test("the summary counts what the user is being asked to decide", async (t) => {
  const fixture = await materializeHome("target");
  t.after(() => fixture.cleanup());
  const plan = await planFor(
    [
      item({
        item_id: "claude:user:permission_rule:allow[0]",
        kind: "permission_rule",
        surface_id: "claude.permissions",
        identity: "allow[0]",
        identity_from: "composite",
        key_path: "permissions.allow[0]",
        value: "Bash(curl:*)",
        trust_tier: "DECLARATIVE",
        authority: true,
      }),
      item({
        item_id: "claude:user:hook:Stop.0.0",
        kind: "hook",
        surface_id: "claude.hooks.settings",
        identity: "Stop.0.0",
        identity_from: "composite",
        key_path: "hooks.Stop[0].hooks[0]",
        value: { type: "command", command: "notify.sh" },
        trust_tier: "EXECUTABLE",
      }),
    ],
    fixture.home,
  );
  assert.equal(plan.summary.authority_changes, 1);
  assert.equal(plan.summary.executable_count, 1);
  assert.equal(plan.summary.quarantined, 1);
  assert.ok(plan.summary.bytes_written > 0);
});

// ── declarations ────────────────────────────────────────────────────────────────────

test("every writable EXECUTABLE surface declares how the runtime turns it off", () => {
  assert.deepEqual(validateAdapters(), []);
  for (const adapter of ADAPTERS) {
    for (const surface of adapter.surfaces) {
      const emit = surface.emit;
      assert.ok(WRITE_MODES.includes(emit.write_mode), `${surface.surface_id}: ${emit.write_mode}`);
      if (emit.disabled_form) {
        assert.ok(
          DISABLED_FORM_MODES.includes(emit.disabled_form.mode),
          `${surface.surface_id}: unknown disabled_form mode ${emit.disabled_form.mode}`,
        );
      }
      if (surface.trust_tier === "EXECUTABLE" && emit.write_mode !== "none" && emit.target) {
        assert.ok(emit.disabled_form, `${surface.surface_id} is writable, executable, and has no quarantine`);
      }
    }
  }
});

test("a stable JSON rendering is what a trust pin is taken over", () => {
  assert.equal(stableJson({ b: 1, a: [2, { d: 4, c: 3 }] }), '{"a":[2,{"c":3,"d":4}],"b":1}');
  assert.equal(stableJson({ a: 1, b: 2 }), stableJson({ b: 2, a: 1 }));
});

test("reading a tree and addressing a value round-trips through both formats", () => {
  const json = readTree("json", '{"a":{"b":[1,2]}}');
  assert.deepEqual(valueAt(json.value, "a.b[1]"), 2);
  const toml = readTree("toml", 'a = 1\n[b]\nc = "d"\n');
  assert.equal(valueAt(toml.value, "b.c"), "d");
});
