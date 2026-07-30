// The compatibility engine, checked against the research rather than against itself.
//
// The expectation table below is adapter-architecture §3.2 transcribed verbatim. It is
// not derived from the code, and the code is not allowed to edit it: where the derivation
// and the research disagree, the disagreement is NAMED here with the reason, because a
// quietly-adjusted expectation is how a "derived" matrix becomes a hand-maintained one.

import assert from "node:assert/strict";
import test from "node:test";
import { ADAPTERS, adapterById } from "../src/core/adapters/registry.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { runScan } from "../src/core/engine/pipeline.js";
import {
  MATRIX_KINDS,
  cellOf,
  compatForItems,
  fidelity,
  matrix,
  profileFromSnapshot,
  runtimeProfile,
} from "../src/core/compat/derive.js";
import { FORMAT_CAPACITY, unexpressible } from "../src/core/compat/transforms.js";
import { capabilitiesOf } from "../src/cli/export.js";
import { materializeHome } from "./fixtures/materialize.js";

const claude = runtimeProfile(adapterById("claude"));
const codex = runtimeProfile(adapterById("codex"));
const hermes = runtimeProfile(adapterById("hermes"));

/**
 * adapter-architecture §3.2, column order C→C, C→X, X→X, X→C. `n/a` is the table's own
 * informal marker for "this cell does not describe a transfer that can happen"; the
 * derivation expresses the same thing either as a cell no runtime declares (rendered n/a)
 * or as UNSUPPORTED, and `satisfies()` accepts both for that marker only.
 */
const RESEARCHED = {
  instructions: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
  skill: ["NATIVE", "NATIVE", "NATIVE", "NATIVE"],
  command: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
  mcp_server: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
  hook: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
  subagent: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
  memory: ["NATIVE", "ADVISE", "ADVISE", "ADVISE"],
  setting: ["NATIVE", "ADVISE", "NATIVE", "ADVISE"],
  permission_rule: ["NATIVE", "ADVISE", "n/a", "ADVISE"],
  sandbox_profile: ["n/a", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
  rule_script: ["n/a", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
  plugin: ["NATIVE", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
  marketplace: ["NATIVE", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
  model_provider: ["n/a", "n/a", "NATIVE", "UNSUPPORTED"],
  statusline: ["NATIVE", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
  launch_config: ["NATIVE", "UNSUPPORTED", "n/a", "n/a"],
};

/**
 * The two cells where the derivation contradicts §3.2 outright. Both are the SAME fact
 * placed in a different row: §3.2 asserts the Codex-rules → Claude-permissions conversion
 * under `permission_rule`, and the derivation reports it under `rule_script`, which is the
 * kind Codex actually produces (Codex declares no `permission_rule` surface at all). The
 * union of the two rows says the same thing in both places — "permissions ⇄ rules is
 * advisory in both directions", which is what §3.3 verifies verbatim from COD §4.9.
 *
 * These are asserted rather than silenced: if either one changes, this test fails.
 */
const DISAGREEMENTS = {
  "permission_rule/codex->claude": {
    researched: "ADVISE",
    derived: "UNSUPPORTED",
    why:
      "Codex declares no permission_rule surface, so no item of this kind exists to advise about. " +
      "The advisory verdict §3.2 puts here is derived one row down, under rule_script.",
  },
  "rule_script/codex->claude": {
    researched: "UNSUPPORTED",
    derived: "ADVISE",
    why:
      "§3.2's rule_script row reads UNSUPPORTED ('no Starlark evaluator in Claude'), which is true of " +
      "EXECUTING the script and not of the conversion. §3.3 verifies COD §4.9 verbatim — 'lossy in both " +
      "directions and should be treated as advisory output requiring human review' — and codex.js declares " +
      "rule_script.codex-to-claude with fidelity advisory on that citation. The declaration wins.",
  },
};

function derivedGrid() {
  const rows = matrix({ profiles: [claude, codex] });
  const grid = {};
  for (const row of rows) {
    grid[row.kind] = [
      ["claude", "claude"],
      ["claude", "codex"],
      ["codex", "codex"],
      ["codex", "claude"],
    ].map(([from, to]) => {
      const cell = cellOf(rows, row.kind, from, to);
      return cell.applicable ? cell.verdict : "n/a";
    });
  }
  return grid;
}

const COLUMN_LABELS = ["claude->claude", "claude->codex", "codex->codex", "codex->claude"];

test("the derived matrix reproduces the researched verdicts in adapter-architecture §3.2", () => {
  const grid = derivedGrid();
  const unexplained = [];
  for (const [kind, expected] of Object.entries(RESEARCHED)) {
    assert.ok(grid[kind], `${kind} is missing from the derived matrix entirely`);
    for (const [index, want] of expected.entries()) {
      const got = grid[kind][index];
      const key = `${kind}/${COLUMN_LABELS[index]}`;
      const documented = DISAGREEMENTS[key];
      if (documented) {
        assert.equal(documented.researched, want, `${key}: the transcribed research value drifted`);
        assert.equal(got, documented.derived, `${key}: the documented disagreement changed shape`);
        continue;
      }
      // `n/a` in the table means "no transfer happens here"; the derivation says that
      // either by declaring no surface on either side, or by UNSUPPORTED.
      const ok = want === "n/a" ? got === "n/a" || got === "UNSUPPORTED" : got === want;
      if (!ok) unexplained.push(`${key}: research says ${want}, derivation says ${got}`);
    }
  }
  assert.deepEqual(unexplained, [], "undocumented disagreements between the research and the derivation");
});

test("exactly two cells disagree with §3.2, and both are documented with a reason", () => {
  assert.equal(Object.keys(DISAGREEMENTS).length, 2);
  for (const [key, record] of Object.entries(DISAGREEMENTS)) {
    assert.ok(record.why.length > 80, `${key}: a disagreement needs a reason, not a label`);
  }
});

test("the derived matrix is frozen against silent drift", () => {
  // The exact derivation, including the cells §3.2 marks n/a. If any verdict moves for
  // any reason, this fails and someone has to say why in the diff.
  assert.deepEqual(derivedGrid(), {
    instructions: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
    skill: ["NATIVE", "NATIVE", "NATIVE", "NATIVE"],
    command: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
    mcp_server: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
    hook: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
    hook_script: ["NATIVE", "UNSUPPORTED", "n/a", "UNSUPPORTED"],
    subagent: ["NATIVE", "CONVERT", "NATIVE", "CONVERT"],
    memory: ["NATIVE", "ADVISE", "ADVISE", "ADVISE"],
    setting: ["NATIVE", "ADVISE", "NATIVE", "ADVISE"],
    permission_rule: ["NATIVE", "ADVISE", "n/a", "UNSUPPORTED"],
    sandbox_profile: ["n/a", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
    rule_script: ["n/a", "UNSUPPORTED", "NATIVE", "ADVISE"],
    plugin: ["NATIVE", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
    marketplace: ["NATIVE", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
    model_provider: ["n/a", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
    output_style: ["NATIVE", "UNSUPPORTED", "n/a", "UNSUPPORTED"],
    statusline: ["NATIVE", "UNSUPPORTED", "NATIVE", "UNSUPPORTED"],
    keybindings: ["NATIVE", "UNSUPPORTED", "n/a", "UNSUPPORTED"],
    launch_config: ["NATIVE", "UNSUPPORTED", "n/a", "UNSUPPORTED"],
  });
});

// ── §3.3, the verification table, claim by claim ────────────────────────────────

test("§3.3: skills are near-lossless in both directions, and the difference is inert keys", () => {
  for (const [source, target] of [[claude, codex], [codex, claude]]) {
    const cell = fidelity("skill", source, target);
    assert.equal(cell.verdict, "NATIVE", `skill ${source.id}->${target.id}`);
    assert.deepEqual(cell.losses, []);
    assert.ok(cell.inert_on_target.length > 0, "the source-only keys are kept, not dropped");
    assert.match(cell.evidence, /agentskills\.io|byte-identical/);
  }
  // The enablement STATE is the lossy part, and it is reported separately from the content.
  const forward = fidelity("skill", claude, codex);
  assert.equal(forward.state_transfer[0].fidelity, "lossy");
  assert.match(forward.state_transfer[0].note, /boolean/);
});

test("§3.3: hooks are high fidelity and land untrusted on Codex, which the evidence says out loud", () => {
  const cell = fidelity("hook", claude, codex);
  assert.equal(cell.verdict, "CONVERT");
  assert.match(cell.evidence, /UNTRUSTED/i);
  assert.ok(cell.losses.some((loss) => /19 Claude-only events/.test(loss.reason)));
});

test("§3.3: permissions and rules are advisory in BOTH directions", () => {
  assert.equal(fidelity("permission_rule", claude, codex).verdict, "ADVISE");
  assert.equal(fidelity("rule_script", codex, claude).verdict, "ADVISE");
  const back = fidelity("rule_script", codex, claude);
  assert.equal(back.target_kind, "permission_rule", "the Codex rules file lands as a Claude permission proposal");
  assert.match(back.evidence, /advisory/i);
});

test("§3.3: Claude memories are portable, Codex memories are essentially nil", () => {
  assert.equal(fidelity("memory", claude, claude).verdict, "NATIVE");
  assert.equal(fidelity("memory", codex, codex).verdict, "ADVISE");
  assert.match(fidelity("memory", claude, codex).evidence, /not to hand-edit|generated/i);
});

test("§3.3: AGENTS.override.md replace-semantics has no Claude equivalent, and is listed as a loss", () => {
  const cell = fidelity("instructions", codex, claude);
  assert.equal(cell.verdict, "CONVERT");
  assert.ok(cell.losses.some((loss) => /AGENTS\.override\.md/.test(loss.reason)));
});

test("§3.3: a Claude command's default Codex target is a skill, not a deprecated prompt", () => {
  const cell = fidelity("command", claude, codex);
  assert.equal(cell.verdict, "CONVERT");
  assert.equal(cell.target_kind, "skill");
  assert.equal(cell.target_surface_id, "codex.skills.repo");
  const transform = adapterById("claude").transforms.find((entry) => entry.transform_id === "command.claude-to-codex");
  const alternative = transform.alternative_targets[0];
  assert.equal(alternative.surface_id, "codex.prompts");
  assert.ok(alternative.drops.some((drop) => /project scope/.test(drop)), "the prompts path's losses are still recorded");
});

test("§3.3's one correction: MCP is CONVERT, not NATIVE, and X->C loses ten real fields", () => {
  const back = fidelity("mcp_server", codex, claude);
  assert.equal(back.verdict, "CONVERT");
  for (const field of ["startup_timeout_sec", "tool_timeout_sec", "enabled_tools", "disabled_tools", "oauth_resource"]) {
    assert.ok(back.losses.some((loss) => loss.reason === field), `X->C should lose ${field}`);
  }
  assert.equal(back.losses.length >= 10, true, "the ten Codex-only fields are all listed");
});

// ── the two properties §3.1 exists to preserve ──────────────────────────────────

test("§3.1 property 1: an item-level exception outranks its kind's headline verdict", () => {
  const kindVerdict = fidelity("mcp_server", claude, codex);
  assert.equal(kindVerdict.verdict, "CONVERT");

  const websocket = mcpItem({ type: "ws", url: "wss://example.test/stream" });
  const cell = fidelity("mcp_server", claude, codex, websocket);
  assert.equal(cell.verdict, "UNSUPPORTED");
  assert.equal(cell.item_exception.exception_id, "mcp.transport.ws");
  assert.match(cell.item_exception.reason, /websocket/);
  assert.match(cell.item_exception.evidence, /COD §4\.5/);
});

test("§3.1 property 1: an unconfirmed transport is UNKNOWN, never UNSUPPORTED", () => {
  const sse = fidelity("mcp_server", claude, codex, mcpItem({ type: "sse", url: "https://example.test/sse" }));
  assert.equal(sse.verdict, "UNKNOWN", "presumed-dropped-but-unconfirmed is not a verified negative");
  assert.match(sse.item_exception.evidence, /unconfirmed/i);
});

test("§3.1 property 1: an ordinary entry keeps the kind's verdict", () => {
  const stdio = fidelity("mcp_server", claude, codex, mcpItem({ command: "node", args: ["server.js"] }));
  assert.equal(stdio.verdict, "CONVERT");
  assert.equal(stdio.item_exception, null);
});

test("§3.1 property 2: losses are COMPUTED from an item's unrecognized keys, not declared", () => {
  const item = mcpItem({ type: "http", url: "https://example.test" }, { experimentalRetry: null });
  const cell = fidelity("mcp_server", claude, codex, item);
  assert.equal(cell.verdict, "CONVERT");
  const computed = cell.losses.filter((loss) => loss.derived && !loss.declared);
  assert.equal(computed.length, 1);
  assert.equal(computed[0].key_path, "experimentalRetry");
  assert.equal(computed[0].value_shape, "null");
  assert.equal(computed[0].target_format, "toml");
  assert.match(computed[0].reason, /TOML v1\.0\.0 defines no null type/);
});

test("unexpressible() answers a question about the FORMAT, not about anyone's opinion", () => {
  assert.deepEqual(unexpressible({ a: null }, "json"), [], "JSON holds null");
  assert.equal(unexpressible({ a: null }, "toml").length, 1, "TOML does not");
  assert.equal(unexpressible({ a: { b: 1 } }, "dotenv").length, 1, "dotenv holds flat strings only");
  assert.deepEqual(unexpressible({ a: { b: 1 } }, "md+frontmatter"), [], "YAML frontmatter holds structure");
  assert.deepEqual(unexpressible({ a: 1 }, "toml"), [], "a scalar is fine");
  assert.deepEqual(unexpressible({}, "toml"), []);
  assert.deepEqual(unexpressible(undefined, "toml"), []);
  // Nested: the walk reaches the leaf and names the path that cannot land.
  const deep = unexpressible({ outer: { inner: null } }, "toml");
  assert.equal(deep[0].key_path, "outer.inner");
});

test("every format the adapters declare has a declared capacity", () => {
  for (const adapter of ADAPTERS) {
    for (const surface of adapter.surfaces) {
      assert.ok(FORMAT_CAPACITY[surface.format], `${surface.surface_id} uses format "${surface.format}" with no capacity entry`);
    }
  }
});

// ── §4, the Hermes slot ─────────────────────────────────────────────────────────

test("§4: a declared adapter yields UNKNOWN, never UNSUPPORTED, in either direction", () => {
  for (const kind of ["skill", "hook", "sandbox_profile"]) {
    const into = fidelity(kind, claude, hermes);
    const outOf = fidelity(kind, hermes, claude);
    assert.equal(into.verdict, "UNKNOWN", `claude->hermes ${kind}`);
    assert.equal(outOf.verdict, "UNKNOWN", `hermes->claude ${kind}`);
    assert.match(into.note, /not surveyed/);
  }
});

test("§4: UNKNOWN and UNSUPPORTED are never the same string anywhere in the matrix", () => {
  const rows = matrix({ profiles: [claude, codex, hermes] });
  const hermesCells = rows.flatMap((row) => row.cells.filter((cell) => cell.from === "hermes" || cell.to === "hermes"));
  assert.ok(hermesCells.length > 0);
  assert.equal(
    hermesCells.every((cell) => cell.verdict === "UNKNOWN"),
    true,
    "no cell involving an unsurveyed runtime may assert a verified negative",
  );
});

// ── invariants ──────────────────────────────────────────────────────────────────

test("CONVERT always lists at least one loss", () => {
  const rows = matrix({ profiles: [claude, codex, hermes] });
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.verdict !== "CONVERT") continue;
      assert.ok(cell.losses.length > 0, `${row.kind} ${cell.from}->${cell.to} converts but names no loss`);
      for (const loss of cell.losses) assert.ok(loss.reason.length > 0);
    }
  }
});

test("every cross-runtime cell that is not UNSUPPORTED or UNKNOWN cites its evidence", () => {
  const rows = matrix({ profiles: [claude, codex] });
  for (const row of rows) {
    for (const cell of row.cells) {
      if (cell.from === cell.to) continue;
      if (["UNSUPPORTED", "UNKNOWN"].includes(cell.verdict)) continue;
      assert.ok(cell.evidence && cell.evidence.length > 20, `${row.kind} ${cell.from}->${cell.to} has no citation`);
    }
  }
});

test("the matrix covers every canonical kind except the refusal kinds", () => {
  const rows = matrix({ profiles: [claude, codex] });
  const covered = new Set(rows.map((row) => row.kind));
  for (const kind of MATRIX_KINDS) {
    // A kind neither runtime declares is dropped from the view rather than shown as a
    // row of UNSUPPORTED, which would read like a capability claim.
    if (!covered.has(kind)) {
      assert.equal(
        fidelity(kind, claude, claude).source_declares || fidelity(kind, codex, codex).source_declares,
        false,
        `${kind} is missing from the matrix but is declared somewhere`,
      );
    }
  }
  assert.equal(covered.has("unresolved_link"), false, "a refusal is not a portability question");
  assert.equal(covered.has("opaque"), false);
});

// ── derivable offline, from a bundle ────────────────────────────────────────────

test("the same matrix derives from a bundle's capability snapshot, with no adapters present", () => {
  const snapshot = capabilitiesOf(ADAPTERS);
  const offline = snapshot.map(profileFromSnapshot);
  const online = matrix({ profiles: [claude, codex, hermes] });
  const fromBundle = matrix({ profiles: offline });
  assert.deepEqual(
    fromBundle.map((row) => [row.kind, row.cells.map((cell) => cell.verdict)]),
    online.map((row) => [row.kind, row.cells.map((cell) => cell.verdict)]),
  );
  // And the snapshot is self-contained: formats and transforms travel with it, so a
  // reader months later does not need the adapter that produced the bundle.
  assert.ok(offline[0].surfaces.length > 0);
  assert.ok(offline[0].transforms.length > 0);
  assert.ok(offline[0].surfaces.every((surface) => surface.format));
});

// ── against a real scan ─────────────────────────────────────────────────────────

test("per-item compat over a fixture home finds the exception the kind headline hides", async (t) => {
  const fixture = await materializeHome("source");
  t.after(() => fixture.cleanup());
  const env = await buildEnvironment({
    homeDir: fixture.home,
    roots: [`${fixture.home}/projects`],
    os: process.platform,
    envVars: {},
    adapters: ADAPTERS,
  });
  const result = await runScan({ adapters: ADAPTERS, env });
  const report = compatForItems({ items: result.items, source: claude, target: codex });

  assert.ok(report.items.length > 0);
  assert.equal(report.items.every((entry) => entry.kind !== "unresolved_link"), true);

  const websocket = report.exceptions.find((entry) => entry.item_id.endsWith("mcp_server:realtime_feed"));
  assert.ok(websocket, "the ws MCP entry should depart from the CONVERT headline");
  assert.equal(websocket.kind_verdict, "CONVERT");
  assert.equal(websocket.verdict, "UNSUPPORTED");

  const computed = report.items
    .flatMap((entry) => entry.losses.map((loss) => ({ item_id: entry.item_id, ...loss })))
    .filter((loss) => !loss.declared);
  assert.ok(
    computed.some((loss) => loss.key_path === "experimentalRetry" && loss.target_format === "toml"),
    "the null-valued unknown key is reported as a computed loss",
  );

  // Same runtime is the machine-to-machine case and loses nothing.
  const sameRuntime = compatForItems({ items: result.items, source: claude, target: claude });
  assert.equal(
    sameRuntime.items.every((entry) => entry.verdict === "NATIVE" || entry.verdict === "ADVISE"),
    true,
  );
});

function mcpItem(value, unrecognized = {}) {
  return {
    item_id: "claude:user:mcp_server:test",
    kind: "mcp_server",
    runtime: "claude",
    name: "test",
    payload: { format: "json", parsed: { value }, recognized: value, unrecognized },
    origin: { display_path: "~/.claude.json" },
  };
}
