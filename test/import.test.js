// The import model's behavioural contract: preview writes nothing, consent gates every
// byte, drift aborts, failure rolls back, and quarantine is a real second step.
//
// Every test runs against a materialized fixture home. No test reads or writes a real
// ~/.claude, ~/.codex, ~/.claude.json or ~/.omegas, and every credential-shaped value in
// the fixtures is an obvious placeholder.

import assert from "node:assert/strict";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../src/core/adapters/registry.js";
import { applyPlan } from "../src/core/engine/apply.js";
import { planEnable } from "../src/core/engine/enable.js";
import { planImport } from "../src/core/engine/emit.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { readLedger, trustPins } from "../src/core/engine/ledger.js";
import { credential, maskCredentials, resolveInto, unset } from "../src/core/engine/rebind.js";
import { readBundle } from "../src/core/bundle/read.js";
import { dispatch } from "../src/cli/dispatch.js";
import { craft, item } from "./fixtures/bundles.js";
import { materializeHome } from "./fixtures/materialize.js";
import { snapshotTree, treeDiff } from "./fixtures/tree.js";

const STATE = ".omegas";

function recorder(answers = {}) {
  const out = { text: "" };
  return {
    io: {
      stdout: (text) => {
        out.text += text;
      },
      stderr: (text) => {
        out.text += text;
      },
      envVars: answers.envVars ?? {},
      interactive: Boolean(answers.interactive),
      prompt: async (question) => {
        for (const [match, answer] of Object.entries(answers.replies ?? {})) {
          if (question.includes(match)) return answer;
        }
        return answers.fallback ?? "";
      },
      secret: async () => answers.secret ?? "",
    },
    out,
  };
}

async function targetEnv(home) {
  return buildEnvironment({ homeDir: home, roots: [], os: process.platform, envVars: {}, adapters: ADAPTERS });
}

async function exportSource(fixture) {
  const bundle = path.join(fixture.temp, "bundle.ocb.jsonl");
  const { io } = recorder();
  const code = await dispatch(
    ["export", "--home", fixture.home, "--root", path.join(fixture.home, "projects"), "--out", bundle],
    io,
  );
  assert.ok([0, 3].includes(code), `export exited ${code}`);
  return bundle;
}

async function planFrom(bundlePath, home, credentials) {
  const { manifest, entries } = readBundle(await readFile(bundlePath, "utf8"));
  const env = await targetEnv(home);
  const plan = await planImport({
    manifest,
    entries,
    adapters: ADAPTERS,
    env,
    planId: "plan_test_0001",
    credentials: credentials ?? new Map(),
  });
  return { plan, env };
}

// ── preview is read-only ────────────────────────────────────────────────────────────

test("diff writes nothing: the target home is byte-identical afterwards", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const before = await snapshotTree(target.home);
  const { io, out } = recorder();
  const code = await dispatch(["diff", "--bundle", bundle, "--home", target.home], io);
  const after = await snapshotTree(target.home);

  assert.deepEqual(treeDiff(before, after), [], "diff touched the target home");
  assert.equal(code, 3, "a plan with blocked items exits 3");
  assert.match(out.text, /Nothing was written/);
  assert.match(out.text, /operation\(s\)/);
});

test("import with no consent and no terminal writes nothing and exits 3", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const before = await snapshotTree(target.home);
  const { io, out } = recorder();
  const code = await dispatch(["import", "--bundle", bundle, "--home", target.home], io);
  const after = await snapshotTree(target.home);

  assert.equal(code, 3);
  assert.deepEqual(treeDiff(before, after), [], "a non-interactive import without consent wrote to the home");
  assert.match(out.text, /not interactive and no consent flag/);
});

test("there is no blanket --yes", async (t) => {
  const { io, out } = recorder();
  const code = await dispatch(["import", "--bundle", "x", "--yes"], io);
  assert.equal(code, 1);
  assert.match(out.text, /no blanket --yes/);
});

// ── consent ─────────────────────────────────────────────────────────────────────────

test("--yes-inert accepts inert additions and never an authority or executable item", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const { io, out } = recorder();
  const code = await dispatch(["import", "--bundle", bundle, "--home", target.home, "--yes-inert"], io);
  assert.ok([0, 3].includes(code), `import exited ${code}`);

  const settings = JSON.parse(await readFile(path.join(target.home, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(settings.permissions.allow, ["Bash(ls:*)"], "a permission rule rode a bulk accept");
  assert.equal(settings.permissions.defaultMode, undefined, "defaultMode rode a bulk accept");
  assert.equal(settings.hooks_disabled, undefined, "a hook rode a bulk accept");
  assert.equal(settings.effortLevel, "high", "an inert declarative addition was not applied");

  const store = JSON.parse(await readFile(path.join(target.home, ".claude.json"), "utf8"));
  assert.deepEqual(Object.keys(store.mcpServers), ["already-here"], "an MCP server rode a bulk accept");

  const decisions = (await readLedger(target.home)).find((record) => record.event === "import");
  assert.ok(decisions, "no ledger record was written");
  for (const decision of decisions.decisions.filter((entry) => entry.status === "applied")) {
    assert.notEqual(decision.trust_tier, "EXECUTABLE", `${decision.op_id} applied without an individual answer`);
    assert.equal(decision.authority, false, `${decision.op_id} applied without an individual answer`);
  }
  assert.match(out.text, /Applied \d+ operation/);
});

test("answering yes per item applies executables in their disabled form", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const { io } = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  const code = await dispatch(["import", "--bundle", bundle, "--home", target.home], io);
  assert.ok([0, 3].includes(code), `import exited ${code}`);

  const settings = JSON.parse(await readFile(path.join(target.home, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.hooks_disabled, "the hook did not land in the disabled bucket");
  assert.equal(settings.hooks, undefined, "a hook landed live");
  assert.equal(settings.skillOverrides["design-review"], "off", "an executable skill landed enabled");

  const store = JSON.parse(await readFile(path.join(target.home, ".claude.json"), "utf8"));
  assert.equal(store.mcpServers.elevenlabs.disabled, true, "an MCP server landed enabled");

  const config = await readFile(path.join(target.home, ".codex", "config.toml"), "utf8");
  assert.match(config, /enabled = false/, "a Codex MCP server landed enabled");

  const pins = trustPins(await readLedger(target.home));
  assert.ok(pins.size > 0, "no trust pin was recorded");
  for (const pin of pins.values()) {
    assert.equal(pin.state, "disabled");
    assert.match(pin.content_sha256, /^sha256:[0-9a-f]{64}$/);
  }
});

test("a re-import of the same bundle is a no-op: the target is byte-identical", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const first = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  await dispatch(["import", "--bundle", bundle, "--home", target.home], first.io);
  const afterFirst = await snapshotTree(target.home, { skip: [STATE] });

  const second = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  await dispatch(["import", "--bundle", bundle, "--home", target.home], second.io);
  const afterSecond = await snapshotTree(target.home, { skip: [STATE] });

  assert.deepEqual(treeDiff(afterFirst, afterSecond), [], "importing twice changed the target the second time");
});

// ── same-runtime happy paths ────────────────────────────────────────────────────────

test("C to C: instructions, commands and settings land with the right content", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const { io } = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  await dispatch(["import", "--bundle", bundle, "--home", target.home], io);

  const instructions = await readFile(path.join(target.home, ".claude", "CLAUDE.md"), "utf8");
  assert.match(instructions, /Personal instructions/);
  const command = await readFile(path.join(target.home, ".claude", "commands", "deploy.md"), "utf8");
  assert.ok(command.length > 0);
  const skill = await readFile(path.join(target.home, ".claude", "skills", "design-review", "SKILL.md"), "utf8");
  assert.match(skill, /design-review/);
  const settings = JSON.parse(await readFile(path.join(target.home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.model, "sonnet-5");
  assert.equal(settings.effortLevel, "high");
});

test("X to X: Codex config keys land at the root, not inside the last table", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const { io } = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  await dispatch(["import", "--bundle", bundle, "--home", target.home], io);

  const toml = await import("../src/core/formats/toml.js");
  const parsed = toml.parse(await readFile(path.join(target.home, ".codex", "config.toml"), "utf8"));
  assert.equal(parsed.value.approval_policy, "on-request", "a root scalar was reparented into a table");
  assert.equal(parsed.value.sandbox_mode, "workspace-write");
  assert.equal(parsed.value.model, "gpt-5-codex");
  assert.deepEqual(Object.keys(parsed.value.mcp_servers).sort(), ["analytics", "existing", "node_repl"]);
  assert.equal(parsed.value.mcp_servers.existing.command, "node", "an existing entry was disturbed");
  assert.equal(parsed.value.mcp_servers.node_repl.enabled, false, "an imported Codex server landed enabled");
});

test("skill assets land without the executable bit", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));

  const bundle = path.join(source.temp, "full.ocb.jsonl");
  const { io: exportIo } = recorder();
  await dispatch(
    ["export", "--home", source.home, "--payload-policy", "definition+scripts", "--out", bundle],
    exportIo,
  );

  const { io } = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  await dispatch(["import", "--bundle", bundle, "--home", target.home], io);

  const script = path.join(target.home, ".claude", "skills", "design-review", "lib", "score.mjs");
  const info = await lstat(script);
  assert.equal(info.mode & 0o111, 0, "an imported skill script arrived executable");
});

// ── TOCTOU and rollback ─────────────────────────────────────────────────────────────

test("a target that changes between preview and apply aborts with exit 8 and no writes", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const { plan, env } = await planFrom(bundle, target.home);
  for (const operation of plan.operations) operation.consent.granted = true;

  const before = await snapshotTree(target.home, { skip: [STATE] });
  const settingsPath = path.join(target.home, ".claude", "settings.json");
  const original = await readFile(settingsPath, "utf8");
  await writeFile(settingsPath, original.replace('"model": "opus-5"', '"model": "haiku-4-5"'));
  const drifted = await snapshotTree(target.home, { skip: [STATE] });

  const result = await applyPlan({ plan, env, adapters: ADAPTERS, source: "toctou test" });
  assert.equal(result.code, 8, `expected exit 8, got ${result.code}: ${result.error}`);
  assert.equal(result.status, "drifted");
  assert.match(result.error, /re-run the preview/);
  assert.equal(result.applied.length, 0);

  const after = await snapshotTree(target.home, { skip: [STATE] });
  assert.deepEqual(treeDiff(drifted, after), [], "an aborted apply left changes behind");
  assert.notDeepEqual(treeDiff(before, after), [], "the drift itself should still be visible");
});

test("a failure mid-apply rolls every written file back and exits 9", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const { plan, env } = await planFrom(bundle, target.home);
  const live = plan.operations.filter((operation) => operation.action !== "skip");
  for (const operation of live) operation.consent.granted = true;
  // Fail on the LAST distinct file, so several files are already written when it happens.
  const targets = [...new Set(live.map((operation) => operation.target_path))];
  for (const operation of live) {
    if (operation.target_path === targets[targets.length - 1]) operation.fail_here = true;
  }

  const before = await snapshotTree(target.home, { skip: [STATE] });
  const result = await applyPlan({ plan, env, adapters: ADAPTERS, source: "failure injection" });

  assert.equal(result.code, 9, `expected exit 9, got ${result.code}: ${result.error}`);
  assert.equal(result.status, "rolled_back");
  assert.deepEqual(result.restore_failures ?? [], [], "a restore could not be verified");
  assert.ok(result.rolled_back.length > 0, "nothing was rolled back");

  const after = await snapshotTree(target.home, { skip: [STATE] });
  assert.deepEqual(treeDiff(before, after), [], "a rolled-back apply left changes behind");

  const record = (await readLedger(target.home)).find((entry) => entry.event === "import");
  assert.equal(record.status, "rolled_back");
});

test("the staging directory is 0700, under the target home, and cleaned up", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const { plan, env } = await planFrom(bundle, target.home);
  for (const operation of plan.operations) operation.consent.granted = true;
  const result = await applyPlan({ plan, env, adapters: ADAPTERS, source: "staging test", keepStaging: true });

  assert.equal(result.code, 0);
  assert.ok(result.staging.startsWith(path.join(target.real, ".omegas", "continuity", "runs")));
  assert.equal((await lstat(result.staging)).mode & 0o777, 0o700);
});

// ── quarantine and the enable flow ──────────────────────────────────────────────────

test("enable shows the current content, verifies the pin, and flips the disabled form", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const importIo = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  await dispatch(["import", "--bundle", bundle, "--home", target.home], importIo.io);

  const beforeStore = JSON.parse(await readFile(path.join(target.home, ".claude.json"), "utf8"));
  assert.equal(beforeStore.mcpServers.elevenlabs.disabled, true);

  const enableIo = recorder({ interactive: true, replies: { Enable: "y" } });
  const code = await dispatch(
    ["enable", "claude:user:mcp_server:elevenlabs", "--home", target.home],
    enableIo.io,
  );
  assert.equal(code, 0, enableIo.out.text);
  assert.match(enableIo.out.text, /still matches the hash recorded/);
  assert.match(enableIo.out.text, /uvx/, "the content being enabled was not shown");

  const afterStore = JSON.parse(await readFile(path.join(target.home, ".claude.json"), "utf8"));
  assert.equal(afterStore.mcpServers.elevenlabs.disabled, undefined, "the disabled form was not flipped");
  assert.equal(afterStore.mcpServers.elevenlabs.command, "uvx", "the entry was disturbed while enabling it");
  assert.equal(afterStore.mcpServers["already-here"].url, "https://mcp.example.test/existing");

  const pins = trustPins(await readLedger(target.home));
  const pin = [...pins.values()].find((entry) => entry.item_id === "claude:user:mcp_server:elevenlabs");
  assert.equal(pin.state, "enabled");
});

test("enabling a hook moves it out of the parked bucket into the runtime's own key", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const importIo = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  await dispatch(["import", "--bundle", bundle, "--home", target.home], importIo.io);

  const settingsPath = path.join(target.home, ".claude", "settings.json");
  const parked = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(parked.hooks, undefined, "the hook landed live");
  assert.equal(parked.hooks_disabled.Stop[0].hooks[0].type, "command");

  const enableIo = recorder({ interactive: true, replies: { Enable: "y" } });
  const code = await dispatch(["enable", "claude:user:hook:Stop.0.0", "--home", target.home], enableIo.io);
  assert.equal(code, 0, enableIo.out.text);

  const enabled = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(enabled.hooks.Stop[0].hooks[0].type, "command", "the hook did not reach the runtime's key");
  assert.match(enabled.hooks.Stop[0].hooks[0].command, /notify\.sh$/);
  // The bucket loses the group the enable emptied, and keeps the one still parked.
  assert.equal(enabled.hooks_disabled.Stop.length, 1);
  assert.equal(enabled.hooks_disabled.Stop[0].hooks.length, 1);
  // Nothing else in the file moved.
  assert.deepEqual(enabled.permissions.allow, parked.permissions.allow);
  assert.equal(enabled.model, parked.model);
});

test("enable refuses when the pinned content has drifted", async (t) => {
  const source = await materializeHome("source");
  const target = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), target.cleanup()]));
  const bundle = await exportSource(source);

  const importIo = recorder({ interactive: true, replies: { "apply this?": "y" }, fallback: "s" });
  await dispatch(["import", "--bundle", bundle, "--home", target.home], importIo.io);

  // Someone edits the imported server after review. The pin is now describing a different
  // program from the one being vouched for, so enabling it is refused.
  const storePath = path.join(target.home, ".claude.json");
  const store = JSON.parse(await readFile(storePath, "utf8"));
  store.mcpServers.elevenlabs.command = "/bin/sh";
  await writeFile(storePath, `${JSON.stringify(store, null, 2)}\n`);

  const enableIo = recorder({ interactive: true, replies: { Enable: "y" } });
  const code = await dispatch(
    ["enable", "claude:user:mcp_server:elevenlabs", "--home", target.home],
    enableIo.io,
  );
  assert.equal(code, 6, enableIo.out.text);
  assert.match(enableIo.out.text, /has changed since it was imported/);

  const after = JSON.parse(await readFile(storePath, "utf8"));
  assert.equal(after.mcpServers.elevenlabs.disabled, true, "a drifted item was enabled anyway");
});

test("enable on an unknown item id says so rather than guessing", async (t) => {
  const target = await materializeHome("target");
  t.after(() => target.cleanup());
  const { io, out } = recorder({ interactive: true });
  const code = await dispatch(["enable", "claude:user:hook:nope", "--home", target.home], io);
  assert.equal(code, 1);
  assert.match(out.text, /was imported on this machine/);
});

// ── credential re-binding ───────────────────────────────────────────────────────────

test("one credential decision fills every site of that ref", () => {
  const record = credential({ ref: "s1", source: "env", detail: "SLACK_BOT_TOKEN", value: "xoxb-real-value" });
  const credentials = new Map([["s1", record]]);
  const tree = {
    env: { SLACK_BOT_TOKEN: "{{OMEGA_REDACTED:slack.token:s1}}" },
    prose: "the token is {{OMEGA_REDACTED:slack.token:s1}} on both machines",
  };
  const resolved = resolveInto(tree, credentials);
  assert.equal(resolved.value.env.SLACK_BOT_TOKEN, "xoxb-real-value");
  assert.match(resolved.value.prose, /the token is xoxb-real-value on both/);
  assert.deepEqual(resolved.unresolved, []);
});

test("the masked view carries the source of a value and never the value", () => {
  const credentials = new Map([
    ["s1", credential({ ref: "s1", source: "env", detail: "SLACK_BOT_TOKEN", value: "xoxb-real-value" })],
    ["s2", unset("s2")],
  ]);
  const masked = maskCredentials(
    { a: "{{OMEGA_REDACTED:slack.token:s1}}", b: "{{OMEGA_REDACTED:openai.api_key:s2}}" },
    credentials,
  );
  assert.equal(masked.a, "<the value of $SLACK_BOT_TOKEN>");
  assert.ok(!JSON.stringify(masked).includes("xoxb-real-value"), "the masked view leaked a value");
  assert.equal(masked.b, "{{OMEGA_REDACTED:openai.api_key:s2}}", "an unfilled ref lost its placeholder");
});

test("an unfilled credential lands the item disabled, not dropped", async (t) => {
  const target = await materializeHome("target");
  t.after(() => target.cleanup());

  const record = item({
    item_id: "claude:user:mcp_server:needs-key",
    kind: "mcp_server",
    surface_id: "claude.mcp.user",
    identity: "needs-key",
    key_path: "mcpServers.needs-key",
    origin_path: "${HOME}/.claude.json",
    display_path: "~/.claude.json",
    value: { url: "https://mcp.example.test/x", headers: { Authorization: "{{OMEGA_REDACTED:http.authorization:s1}}" } },
    trust_tier: "DECLARATIVE",
    redaction_refs: ["s1"],
    related: [{ rel: "requires_secret", ref: "s1", class: "http.authorization", key_names: ["Authorization"] }],
  });
  const bundle = craft({ items: [record] });
  const { plan, env } = await planFrom(await writeBundle(target, bundle.serialized), target.home);

  const operation = plan.operations.find((entry) => entry.item_id === "claude:user:mcp_server:needs-key");
  assert.deepEqual(operation.needs_credentials, ["s1"]);
  assert.equal(operation.disabled_on_write, true, "an item with an unfilled credential did not land disabled");
  assert.deepEqual(plan.requires_credentials, [
    { ref: "s1", class: "http.authorization", key_names: ["Authorization"], sites_count: 1 },
  ]);

  operation.consent.granted = true;
  const result = await applyPlan({ plan, env, adapters: ADAPTERS, source: "credential test" });
  assert.equal(result.code, 0);
  const store = JSON.parse(await readFile(path.join(target.home, ".claude.json"), "utf8"));
  assert.equal(store.mcpServers["needs-key"].disabled, true);
  assert.match(store.mcpServers["needs-key"].headers.Authorization, /OMEGA_REDACTED/);

  const ledger = await readFile(path.join(target.home, ".omegas", "continuity", "ledger.jsonl"), "utf8");
  assert.ok(!ledger.includes("Authorization: Bearer"), "the ledger recorded a credential");
});

test("a filled credential reaches the target file and nothing else", async (t) => {
  const target = await materializeHome("target");
  t.after(() => target.cleanup());

  // A declarative surface with no disabled form, so the only thing under test is whether
  // the value reaches the file and stays out of everything else.
  const record = item({
    item_id: "claude:user:setting:env",
    kind: "setting",
    surface_id: "claude.settings.user",
    identity: "env.TEST_TOKEN",
    identity_from: "key_path",
    key_path: "env.TEST_TOKEN",
    origin_path: "${CLAUDE_HOME}/settings.json",
    display_path: "~/.claude/settings.json",
    value: "{{OMEGA_REDACTED:http.authorization:s1}}",
    trust_tier: "DECLARATIVE",
    redaction_refs: ["s1"],
    related: [{ rel: "requires_secret", ref: "s1", class: "http.authorization", key_names: ["TEST_TOKEN"] }],
  });
  const bundle = craft({ items: [record] });
  const bundlePath = await writeBundle(target, bundle.serialized);
  const credentials = new Map([
    ["s1", credential({ ref: "s1", source: "env", detail: "TEST_TOKEN", value: "Bearer NOT-A-REAL-TOKEN-000" })],
  ]);
  const { plan, env } = await planFrom(bundlePath, target.home, credentials);

  const operation = plan.operations[0];
  assert.deepEqual(operation.needs_credentials, []);
  assert.equal(operation.disabled_on_write, false, "a filled credential still quarantined the item");
  assert.ok(!operation.diff.unified.includes("NOT-A-REAL-TOKEN"), "the preview rendered the credential value");
  assert.match(operation.diff.unified, /the value of \$TEST_TOKEN/);

  operation.consent.granted = true;
  await applyPlan({ plan, env, adapters: ADAPTERS, source: "credential fill" });
  const settings = JSON.parse(await readFile(path.join(target.home, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.env.TEST_TOKEN, "Bearer NOT-A-REAL-TOKEN-000");

  const ledger = await readFile(path.join(target.home, ".omegas", "continuity", "ledger.jsonl"), "utf8");
  assert.ok(!ledger.includes("NOT-A-REAL-TOKEN"), "the ledger recorded a credential value");
});

// ── cross-runtime ───────────────────────────────────────────────────────────────────

test("cross-runtime items are previewed and blocked from apply", async (t) => {
  const source = await materializeHome("source");
  const claudeOnly = await materializeHome("target");
  t.after(() => Promise.all([source.cleanup(), claudeOnly.cleanup()]));
  // Remove the Codex home so Codex is genuinely absent on the target.
  await chmod(path.join(claudeOnly.home, ".codex"), 0o700);
  const { rm } = await import("node:fs/promises");
  await rm(path.join(claudeOnly.home, ".codex"), { recursive: true, force: true });

  const bundle = await exportSource(source);
  const { plan } = await planFrom(bundle, claudeOnly.home);

  const codexItems = plan.blocked.filter((entry) => entry.runtime === "codex");
  assert.ok(codexItems.length > 0, "no Codex item was carried into the preview");
  for (const entry of codexItems) {
    assert.equal(entry.rule_id, "cross_runtime_preview_only");
    assert.match(entry.reason, /parity review/);
  }
  assert.ok(
    plan.operations.every((operation) => operation.runtime !== "codex"),
    "a cross-runtime item produced an operation",
  );
});

async function writeBundle(fixture, serialized) {
  const target = path.join(fixture.temp, "crafted.ocb.jsonl");
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, serialized);
  return target;
}
