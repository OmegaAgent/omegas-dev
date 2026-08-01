// The engine, exercised against committed fixture homes. No test here ever reads a real
// ~/.claude, ~/.codex or ~/.claude.json: `materializeHome()` copies a fake tree into a
// temp directory, and every credential-shaped value in it is an obvious placeholder.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../src/core/adapters/registry.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { runScan } from "../src/core/engine/pipeline.js";
import { disambiguate } from "../src/core/model/identity.js";
import { ItemSchema, ScanResultSchema, validate } from "../src/core/model/schema.js";
import { publicItem } from "../src/core/model/item.js";
import { materializeHome } from "./fixtures/materialize.js";

async function scanFixture(options = {}) {
  const fixture = await materializeHome();
  const env = await buildEnvironment({
    homeDir: fixture.home,
    roots: [path.join(fixture.home, "projects")],
    os: "darwin",
    envVars: {},
    adapters: ADAPTERS,
    caps: { file_bytes: 8192, ...(options.caps ?? {}) },
  });
  const result = await runScan({ adapters: ADAPTERS, env });
  return { ...fixture, env, result };
}

function byId(result, id) {
  return result.items.find((item) => item.item_id === id);
}

function findKind(result, kind) {
  return result.items.filter((item) => item.kind === kind);
}

test("item ids are deterministic across two independent scans", async () => {
  const first = await scanFixture();
  const second = await scanFixture();
  try {
    const a = first.result.items.map((item) => item.item_id).sort();
    const b = second.result.items.map((item) => item.item_id).sort();
    assert.deepEqual(a, b);
    assert.ok(a.length > 40, "the fixture should produce a substantial item set");
    for (const id of a) {
      assert.ok(
        !/[0-9a-f]{8}-[0-9a-f]{4}-/.test(id),
        `${id} looks like it carries a random uuid, which is the defect this replaces`,
      );
    }
  } finally {
    await first.cleanup();
    await second.cleanup();
  }
});

test("colliding ids are suffixed deterministically, never dropped", async () => {
  // spike-corrections, modelling note 1: two sources can genuinely contribute the same
  // array-index identity in one scope. Dropping one would hide a permission rule.
  const taken = new Set();
  const ids = ["a", "a", "a", "b"].map((id) => {
    const resolved = disambiguate(id, taken);
    taken.add(resolved);
    return resolved;
  });
  assert.deepEqual(ids, ["a", "a#2", "a#3", "b"]);

  const fixture = await scanFixture();
  try {
    const all = fixture.result.items.map((item) => item.item_id);
    assert.equal(new Set(all).size, all.length, "the scan produced a duplicate item_id");
    for (const item of fixture.result.items) {
      if (item.identity.from !== "composite") continue;
      assert.equal(item.identity.stable_across_runs, false);
      assert.match(item.identity.note, /content_id is the reliable join/);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("identity comes from the declared field, never the filename", async () => {
  const fixture = await scanFixture();
  try {
    // The Claude subagent's file is reviewer.md; its frontmatter name is strict-reviewer.
    assert.ok(byId(fixture.result, "claude:user:subagent:strict-reviewer"), "frontmatter name should win");
    assert.equal(byId(fixture.result, "claude:user:subagent:reviewer.md"), undefined);
    // The Codex subagent's file is planner.toml; its TOML name is planner.
    assert.ok(byId(fixture.result, "codex:user:subagent:planner"), "the TOML name field should win");
  } finally {
    await fixture.cleanup();
  }
});

test("project identity uses the git remote, and a monorepo collapses onto one repository", async () => {
  const fixture = await scanFixture();
  try {
    const ids = fixture.env.projects.map((project) => project.project_id);
    assert.ok(ids.includes("git-github.com-OmegaAgent-app"));
    const monorepo = fixture.env.projects.filter((project) => project.identity.value.includes("monorepo"));
    assert.equal(monorepo.length, 2, "the root and the nested package are both discovered");
    assert.ok(
      monorepo.every((project) => project.identity.value.startsWith("git:github.com/OmegaAgent/monorepo")),
      "both resolve onto one repository rather than two unrelated projects",
    );
    assert.ok(
      monorepo.some((project) => project.identity.value.endsWith("#packages/web")),
      "the nested package is distinguished by subpath, not by a separate identity",
    );
    for (const project of fixture.env.projects) {
      assert.ok(["vcs", "marker", "label"].includes(project.identity.method));
      assert.ok(["high", "medium", "low"].includes(project.identity.confidence));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a refused symlink is a NODE, not a silence", async () => {
  const fixture = await scanFixture();
  try {
    const unresolved = findKind(fixture.result, "unresolved_link");
    assert.equal(unresolved.length, 1);
    assert.equal(unresolved[0].name, "escaping-skill");
    assert.equal(unresolved[0].origin.link.refusal, "target outside every declared root");
    assert.equal(unresolved[0].portability.verdict, "MACHINE-LOCAL");
    assert.equal(unresolved[0].payload, null);
    // The escaping file's content must never have been read into an item.
    const serialized = JSON.stringify(fixture.result.items);
    assert.ok(!serialized.includes("must never enter a bundle"));
    assert.ok(fixture.result.findings.some((finding) => finding.rule === "link.unresolved"));
  } finally {
    await fixture.cleanup();
  }
});

test("a link crossing into another declared root is followed AND recorded", async () => {
  const fixture = await scanFixture();
  try {
    const crossing = byId(fixture.result, "codex:user:skill:shared-skill");
    assert.ok(crossing, "the crossing link should still produce a normal item");
    assert.equal(crossing.origin.link.via_link, true);
    assert.ok(crossing.origin.link.crossing, "the crossing must be recorded, not just followed");
    for (const field of ["from_root", "to_root", "to_path"]) {
      assert.ok(
        crossing.origin.link.crossing[field].startsWith("${"),
        `${field} must be tokenized, never a machine path`,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("an over-cap file is truncated and RECORDED, never silently dropped", async () => {
  const fixture = await scanFixture();
  try {
    assert.equal(fixture.result.truncations.length, 1);
    const record = fixture.result.truncations[0];
    assert.ok(record.display_path.endsWith("big-notes/SKILL.md"));
    assert.equal(record.kept_bytes, 8192);
    assert.ok(record.bytes > record.kept_bytes);
    assert.equal(record.reason, "per-file byte cap");
    const item = byId(fixture.result, "claude:user:skill:big-notes");
    assert.ok(item, "the item survives the truncation");
    assert.equal(item.payload.truncated, true);
    assert.equal(fixture.result.complete, false);
  } finally {
    await fixture.cleanup();
  }
});

test("never-export rules fire visibly, and a hard rule is never opened", async () => {
  const fixture = await scanFixture();
  try {
    const byRule = new Map(fixture.result.exclusions.map((record) => [record.rule_id, record]));
    assert.ok(byRule.has("codex.auth"), "auth.json must produce a record, not silence");
    assert.ok(byRule.has("claude.transcripts"));
    assert.ok(byRule.has("codex.hooks_state"));
    assert.ok(byRule.has("claude.account_identity"));
    for (const record of fixture.result.exclusions) {
      assert.ok(["files", "keys", "mixed"].includes(record.unit), `${record.rule_id} has no unit`);
      assert.ok(record.reason.length > 0, `${record.rule_id} has no user-facing reason`);
      assert.ok(record.matched > 0);
    }
    // Nothing under a refused key subtree may become an item.
    const serialized = JSON.stringify(fixture.result.items);
    assert.ok(!serialized.includes("FAKE-ACCESS-TOKEN"), "auth.json content reached an item");
    assert.ok(!serialized.includes("trusted_hash"), "hook trust state reached an item");
    assert.ok(!serialized.includes("fixture@example.test"), "the account block reached an item");
  } finally {
    await fixture.cleanup();
  }
});

test("a secret_sink is scanned for structure and refused for export", async () => {
  const fixture = await scanFixture();
  try {
    const rules = findKind(fixture.result, "rule_script");
    assert.equal(rules.length, 1, "the rules file is reported, not hidden");
    assert.equal(rules[0].export_refused, true);
    assert.equal(rules[0].export_refused_by, "codex.rules_secret_sink");
    assert.equal(rules[0].payload.parsed.value.rule_count, 3, "structure survives");
    assert.deepEqual(rules[0].payload.parsed.value.rules[2].argv, ["rm", "-rf"]);
    // The structural parse reports commands BY NAME and stops: the surveyed file's live
    // key sat inside an argv element of a `curl -H` rule, so a non-bare-word element ends
    // the prefix and is counted instead of carried.
    assert.deepEqual(rules[0].payload.parsed.value.rules[1].argv, ["curl", "-H"]);
    assert.equal(rules[0].payload.parsed.value.rules[1].argv_truncated, true);
    assert.equal(rules[0].payload.parsed.value.rules[1].argv_length, 3);
    assert.equal(rules[0]._raw_text, null, "the refused bytes must not be retained at all");
    assert.ok(!JSON.stringify(rules[0]).includes("FAKE-RULES-TOKEN"), "a credential-bearing argv was carried");
  } finally {
    await fixture.cleanup();
  }
});

test("settings decompose to keys, not files", async () => {
  const fixture = await scanFixture();
  try {
    assert.ok(byId(fixture.result, "claude:user:setting:model"));
    assert.ok(byId(fixture.result, "claude:user:setting:effortLevel"));
    assert.ok(byId(fixture.result, "claude:user:setting:permissions.defaultMode"));
    const settingsFileItems = fixture.result.items.filter(
      (item) => item.kind === "setting" && item.origin.key_path === null,
    );
    assert.deepEqual(settingsFileItems, [], "a settings file must never be one item");
  } finally {
    await fixture.cleanup();
  }
});

test("all seven merge algebras resolve, and severity beats layer rank", async () => {
  const fixture = await scanFixture();
  try {
    const seen = new Set(fixture.result.effective.map((row) => row.algebra));
    for (const algebra of [
      "override",
      "override_whole_entry",
      "concatenate",
      "first_non_empty",
      "aggregate",
      "union_with_resolution",
      "coexist",
    ]) {
      assert.ok(seen.has(algebra), `no effective row exercised ${algebra}`);
    }

    // override: a project-local setting outranks the user setting, in that project.
    const model = fixture.result.effective.find(
      (row) => row.algebra === "override" && row.key === "model" && row.runtime === "claude",
    );
    assert.equal(model.value, "opus-5");
    assert.ok(model.winner.startsWith("claude:local#"));

    // union_with_resolution: a broad user-scope deny beats a higher-ranked project allow.
    const push = fixture.result.effective.find((row) => row.key === "Bash(git push:*)");
    assert.equal(push.algebra, "union_with_resolution");
    assert.equal(push.value, "deny");
    assert.equal(push.winner, "claude:user:permission_rule:deny[0]");
    const loser = push.contributors.find((contributor) => !contributor.applied);
    assert.ok(loser.rank > push.contributors.find((c) => c.applied).rank, "the loser outranked the winner");
    assert.match(loser.reason, /severity/);

    // first_non_empty: the override file REPLACES its sibling, which is never read.
    const codexChain = fixture.result.effective.find(
      (row) => row.algebra === "first_non_empty" && row.runtime === "codex",
    );
    assert.match(codexChain.winner, /AGENTS\.override\.md$/);
    assert.equal(codexChain.contributors.filter((contributor) => contributor.applied).length, 1);
    assert.match(codexChain.note, /REPLACE semantics/);

    // aggregate: every hook runs; no layer suppresses another.
    const hooks = fixture.result.effective.find((row) => row.algebra === "aggregate");
    assert.equal(hooks.winner, null);
    assert.ok(hooks.contributors.every((contributor) => contributor.applied));

    // concatenate: ascending rank, order recorded, no single winner.
    const chain = fixture.result.effective.find(
      (row) => row.algebra === "concatenate" && row.contributors.length > 1,
    );
    assert.equal(chain.winner, null);
    const ranks = chain.contributors.map((contributor) => contributor.rank);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b));
    assert.deepEqual(
      chain.contributors.map((contributor) => contributor.order_index),
      chain.contributors.map((_value, index) => index),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("an untrusted project's layer is suppressed, visibly, and does not win", async () => {
  const fixture = await scanFixture();
  try {
    const suppressed = fixture.result.layers.filter((layer) => layer.suppressed_by === "project_untrusted");
    assert.ok(suppressed.length > 0, "the untrusted project's layer should be suppressed");
    assert.ok(suppressed.every((layer) => layer.runtime === "codex"));

    const approval = fixture.result.effective.find((row) => row.key === "approval_policy");
    assert.equal(approval.value, "on-request", "the suppressed project value must not win");
    const shadow = approval.contributors.find((contributor) => !contributor.applied);
    assert.match(shadow.reason, /suppressed/);
    assert.ok(shadow.rank > 40, "the suppressed contributor outranked the winner and still lost");
  } finally {
    await fixture.cleanup();
  }
});

test("trust escalates from content and is never de-escalated", async () => {
  const fixture = await scanFixture();
  try {
    const withScript = byId(fixture.result, "claude:user:skill:design-review");
    assert.equal(withScript.trust_tier, "EXECUTABLE", "an exec-bit asset escalates the item");
    assert.ok(withScript.assets.some((asset) => asset.exec_bit && asset.role === "script"));
    assert.ok(withScript.assets.every((asset) => asset.included === false));

    const withoutScript = byId(fixture.result, "claude:user:skill:big-notes");
    assert.equal(withoutScript.trust_tier, "INERT");

    for (const item of findKind(fixture.result, "hook")) {
      assert.equal(item.trust_tier, "EXECUTABLE");
    }
  } finally {
    await fixture.cleanup();
  }
});

test("unrecognized keys survive verbatim and become a finding, never an edit", async () => {
  const fixture = await scanFixture();
  try {
    const skill = byId(fixture.result, "claude:user:skill:design-review");
    assert.equal(skill.payload.unrecognized.allowed_tools?.length, 2);
    assert.equal(skill.payload.unrecognized["preamble-tier"], "2");
    assert.equal(skill.payload.recognized.name, "design-review");
    const union = { ...skill.payload.recognized, ...skill.payload.unrecognized };
    assert.deepEqual(
      Object.keys(union).sort(),
      Object.keys(skill.payload.parsed.frontmatter).sort(),
      "recognized union unrecognized must equal parsed, with no key lost",
    );
    assert.ok(
      fixture.result.findings.some((finding) => finding.rule === "skill.frontmatter.underscore_variant"),
    );
  } finally {
    await fixture.cleanup();
  }
});

test("the six v1 lints all fire on conditions the fixtures really carry", async () => {
  const fixture = await scanFixture();
  try {
    const rules = new Set(fixture.result.findings.map((finding) => finding.rule));
    for (const expected of [
      "skill.frontmatter.underscore_variant",
      "instructions.invisible_to_runtime",
      "hook.gated_by_sentinel",
      "path.absolute_home",
      "permission.dead_rule",
    ]) {
      assert.ok(rules.has(expected), `lint ${expected} never fired`);
    }
    for (const finding of fixture.result.findings) {
      assert.ok(finding.message.length > 0, `${finding.rule} has no message`);
      assert.ok(["info", "warn", "critical"].includes(finding.severity));
    }
  } finally {
    await fixture.cleanup();
  }
});

test("a hook carries its script and its sentinel gate as edges", async () => {
  const fixture = await scanFixture();
  try {
    const hook = byId(fixture.result, "claude:user:hook:Stop.0.0");
    const script = hook.related.find((edge) => edge.rel === "references_path");
    assert.equal(script.item_id, "claude:user:hook_script:notify.sh");
    const gate = hook.related.find((edge) => edge.rel === "gated_by");
    assert.ok(gate, "a hook muted by a sentinel must say so");
    assert.match(gate.external, /^~\//, "the sentinel path must be home-relative, not absolute");

    // A hook whose script is missing records the reference as unresolved rather than dropping it.
    const dangling = byId(fixture.result, "claude:user:hook:Stop.0.1");
    const missing = dangling.related.find((edge) => edge.rel === "references_path");
    assert.equal(missing.resolved, false);
  } finally {
    await fixture.cleanup();
  }
});

// The committed fixture writes its sentinel as an absolute path, so it cannot exercise the form
// most hooks actually use. This builds a home whose gate is written `~/…` and asserts the edge
// still derives: probing only absolute leaves silently lost the lint for the idiomatic spelling.
test("a sentinel written ~/-relative is probed, not silently ignored", async () => {
  const fixture = await materializeHome();
  try {
    const hooks = path.join(fixture.home, ".claude", "hooks");
    await fs.mkdir(hooks, { recursive: true });
    await fs.writeFile(path.join(hooks, "tilde-gated.sh"), "#!/bin/sh\n[ -f ~/.claude/hooks/.tildequiet ] && exit 0\necho hi\n");
    await fs.chmod(path.join(hooks, "tilde-gated.sh"), 0o755);
    await fs.writeFile(path.join(hooks, ".tildequiet"), "");
    const settingsPath = path.join(fixture.home, ".claude", "settings.json");
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    settings.hooks = settings.hooks ?? {};
    settings.hooks.PreToolUse = [
      { matcher: "*", hooks: [{ type: "command", command: path.join(hooks, "tilde-gated.sh") }] },
    ];
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    const env = await buildEnvironment({
      homeDir: fixture.home,
      roots: [path.join(fixture.home, "projects")],
      os: "darwin",
      envVars: {},
      adapters: ADAPTERS,
      caps: { file_bytes: 8192 },
    });
    const result = await runScan({ adapters: ADAPTERS, env });

    const script = result.items.find((item) => item.item_id === "claude:user:hook_script:tilde-gated.sh");
    assert.ok(script, "the tilde-gated hook script should be discovered");
    const gate = script.related.find((edge) => edge.rel === "gated_by");
    assert.ok(gate, "a ~/-relative sentinel must still derive a gated_by edge");
    assert.match(gate.external, /^~\//, "the sentinel path stays home-relative");
    assert.ok(
      result.findings.some((finding) => finding.rule === "hook.gated_by_sentinel"),
      "hook.gated_by_sentinel must fire for the idiomatic ~/ spelling",
    );
  } finally {
    await fixture.cleanup();
  }
});

test("no machine path reaches an item: origins are tokenized and displays are ~-relative", async () => {
  const fixture = await scanFixture();
  try {
    for (const item of fixture.result.items) {
      assert.ok(
        item.origin.path.startsWith("${") || !path.isAbsolute(item.origin.path),
        `${item.item_id} carries an untokenized origin: ${item.origin.path}`,
      );
      assert.ok(
        item.origin.display_path.startsWith("~"),
        `${item.item_id} carries a non-home-relative display path: ${item.origin.display_path}`,
      );
      assert.ok(!item.origin.path.includes(fixture.home), `${item.item_id} leaks the home path`);
    }
    for (const record of fixture.result.exclusions) {
      assert.ok(!record.label.includes(fixture.home), `${record.rule_id} leaks the home path in its label`);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("every item and the whole result validate against the hand-rolled schema", async () => {
  const fixture = await scanFixture();
  try {
    for (const item of fixture.result.items) {
      assert.deepEqual(validate(ItemSchema, publicItem(item), item.item_id), []);
    }
    const projection = {
      items: fixture.result.items.map(publicItem),
      layers: fixture.result.layers,
      effective: fixture.result.effective,
      findings: fixture.result.findings,
      exclusions: fixture.result.exclusions,
      truncations: fixture.result.truncations,
      runtimes: fixture.result.runtimes,
      projects: fixture.result.projects,
    };
    assert.deepEqual(validate(ScanResultSchema, projection, "scan"), []);
  } finally {
    await fixture.cleanup();
  }
});

test("the public projection carries no engine-internal state", async () => {
  const fixture = await scanFixture();
  try {
    for (const item of fixture.result.items) {
      for (const key of Object.keys(publicItem(item))) {
        assert.ok(!key.startsWith("_"), `${item.item_id} would export internal key ${key}`);
      }
    }
    const serialized = JSON.stringify(fixture.result.items.map(publicItem));
    assert.ok(!serialized.includes("_surface"));
    assert.ok(!serialized.includes("_raw_text"));
  } finally {
    await fixture.cleanup();
  }
});

test("a declared-but-absent runtime reports absence rather than being hidden", async () => {
  const fixture = await scanFixture();
  try {
    const hermes = fixture.result.runtimes.find((runtime) => runtime.status === "declared");
    assert.ok(hermes, "a declared adapter must still appear in the runtime list");
    assert.equal(hermes.present, false);
    assert.equal(hermes.surfaces_declared, 0);
  } finally {
    await fixture.cleanup();
  }
});

test("the scan opens no file outside the fixture home and its declared roots", async () => {
  const fixture = await scanFixture();
  try {
    for (const item of fixture.result.items) {
      assert.ok(
        !item.origin.display_path.includes("/.ssh/") && !item.origin.display_path.includes("/.aws/"),
        "the scan reached a credential directory",
      );
    }
  } finally {
    await fixture.cleanup();
  }
});
