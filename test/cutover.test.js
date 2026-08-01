// Cutover parity: the new core can produce the payload the hosted API already accepts.
//
// The test runs BOTH scanners over the same fixture homes and compares. Anything the two
// disagree about is either asserted as an intentional difference (with the reason living
// in `DIFFERENCES`) or fails the test. There is no third category — an unexplained
// difference between the old path and the new one is the whole risk of a cutover.

import assert from "node:assert/strict";
import path from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ADAPTERS } from "../src/core/adapters/registry.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { runScan } from "../src/core/engine/pipeline.js";
import { assembleBundle } from "../src/cli/export.js";
import { discoverTransfer } from "../src/discovery.js";
import { DIFFERENCES, LEGACY_SCHEMA_VERSION, projectLocalTransferV1, sanitizeUrl } from "../src/hosted/local-transfer-v1.js";
import { materializeHome } from "./fixtures/materialize.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function bothScanners(t, name = "source") {
  const fixture = await materializeHome(name);
  t.after(() => fixture.cleanup());
  const roots = [path.join(fixture.home, "projects")];
  const env = await buildEnvironment({
    homeDir: fixture.home,
    roots,
    os: process.platform,
    envVars: {},
    adapters: ADAPTERS,
  });
  const result = await runScan({ adapters: ADAPTERS, env, payloadPolicy: "definition" });
  const built = assembleBundle({ result, env, adapters: ADAPTERS, payloadPolicy: "definition" });
  const entries = new Map(built.entries.map((entry) => [entry.name, entry]));
  const projected = projectLocalTransferV1({ manifest: built.manifest, entries });
  const legacy = await discoverTransfer({ roots, home: fixture.home });
  return { fixture, built, entries, projected, legacy };
}

const byPath = (files) => new Map(files.map((file) => [file.path, file]));
const byName = (servers) => new Map(servers.map((server) => [`${server.source}:${server.name}`, server]));

/**
 * The three entries the new scanner finds and the old one does not. Each is a bug in the
 * old scanner that the architecture doc predicted, so they are named individually rather
 * than counted.
 */
const COVERAGE_GAINS = {
  "global/.codex/AGENTS.override.md":
    "the legacy collector reads .codex/AGENTS.md and nothing else, so the override file — whose whole " +
    "semantic is REPLACING that file — was invisible to it (COD §4.1)",
  "global/.codex/skills/shared-skill/SKILL.md":
    "the legacy collector refuses every symlink and warns; Continuity's three-outcome link policy resolves " +
    "a link that stays inside a declared root and only refuses one that escapes",
};

test("the projection produces a well-formed legacy payload", async (t) => {
  const { projected } = await bothScanners(t);
  assert.equal(projected.payload.schema_version, LEGACY_SCHEMA_VERSION);
  assert.match(projected.payload.generated_at, /^\d{4}-\d{2}-\d{2}T/);
  for (const bucket of ["context_files", "skills", "mcp_servers"]) {
    assert.ok(Array.isArray(projected.payload.global[bucket]), `global.${bucket}`);
  }
  for (const project of projected.payload.projects) {
    for (const field of ["key", "name", "source_label", "context_files", "skills", "mcp_servers"]) {
      assert.ok(field in project, `a project is missing ${field}`);
    }
  }
});

test("PARITY: every context file and skill the legacy scanner finds, the projection finds too", async (t) => {
  const { projected, legacy } = await bothScanners(t);
  for (const bucket of ["context_files", "skills"]) {
    const mine = byPath(projected.payload.global[bucket]);
    for (const file of legacy.manifest.global[bucket]) {
      const match = mine.get(file.path);
      assert.ok(match, `the projection is missing ${bucket} ${file.path}`);
      assert.equal(match.source, file.source, `${file.path}: source`);
      assert.equal(match.kind, file.kind, `${file.path}: kind`);
    }
  }
});

test("PARITY: content is byte-identical wherever no credential was redacted", async (t) => {
  const { projected, legacy } = await bothScanners(t);
  let identical = 0;
  let redacted = 0;
  for (const bucket of ["context_files", "skills"]) {
    const mine = byPath(projected.payload.global[bucket]);
    for (const file of legacy.manifest.global[bucket]) {
      const match = mine.get(file.path);
      if (match.content === file.content) {
        assert.equal(match.sha256, file.sha256, `${file.path}: identical content must produce an identical digest`);
        identical += 1;
        continue;
      }
      // The only licensed reason to differ: a placeholder stands where a value stood.
      assert.match(match.content, /\{\{OMEGA_REDACTED:/, `${file.path} differs for a reason other than redaction`);
      redacted += 1;
    }
  }
  assert.ok(identical > 0, "the fixture should contain files with nothing to redact");
  assert.equal(identical + redacted, [...byPath(legacy.manifest.global.context_files).keys()].length + legacy.manifest.global.skills.length);
});

test("PARITY: every MCP server matches field for field, including the redacted ones", async (t) => {
  const { projected, legacy } = await bothScanners(t);
  const mine = byName(projected.payload.global.mcp_servers);
  for (const server of legacy.manifest.global.mcp_servers) {
    const match = mine.get(`${server.source}:${server.name}`);
    assert.ok(match, `the projection is missing MCP server ${server.source}:${server.name}`);
    assert.equal(match.transport, server.transport, `${server.name}: transport`);
    assert.equal(match.command, server.command, `${server.name}: command`);
    assert.deepEqual(match.args_redacted, server.args_redacted, `${server.name}: args`);
    assert.equal(match.url, server.url, `${server.name}: url`);
    assert.equal(match.source_file, server.source_file, `${server.name}: source_file`);
    // env_keys is the one field with a known asymmetry, asserted separately below.
    if (server.env_keys.length > 0) assert.deepEqual(match.env_keys, server.env_keys, `${server.name}: env_keys`);
  }
});

test("PARITY: projects match on name, files and servers; only the key differs, and it differs on purpose", async (t) => {
  const { projected, legacy } = await bothScanners(t);
  const mine = new Map(projected.payload.projects.map((project) => [project.name, project]));
  assert.equal(mine.size, legacy.manifest.projects.length, "the two scanners find the same number of projects");

  for (const project of legacy.manifest.projects) {
    const match = mine.get(project.name);
    assert.ok(match, `the projection is missing project ${project.name}`);
    assert.equal(match.source_label, project.source_label);
    assert.deepEqual(
      match.context_files.map((file) => file.path).sort(),
      project.context_files.map((file) => file.path).sort(),
      `${project.name}: context files`,
    );
    assert.deepEqual(
      match.skills.map((file) => file.path).sort(),
      project.skills.map((file) => file.path).sort(),
      `${project.name}: skills`,
    );
    assert.deepEqual(
      match.mcp_servers.map((server) => server.name).sort(),
      project.mcp_servers.map((server) => server.name).sort(),
      `${project.name}: mcp servers`,
    );

    // The documented difference, asserted rather than described: the legacy key carries
    // eight random hex characters and changes every run; ours is derived and does not.
    assert.match(project.key, /-[0-9a-f]{8}$/, "the legacy key should be random-suffixed");
    assert.doesNotMatch(match.key, /-[0-9a-f]{8}$/);
    assert.notEqual(match.key, project.key);
  }
});

test("DIFFERENCE: project keys are deterministic — the same manifest projects to the same bytes twice", async (t) => {
  const { built, entries, legacy, fixture } = await bothScanners(t);
  const first = projectLocalTransferV1({ manifest: built.manifest, entries });
  const second = projectLocalTransferV1({ manifest: built.manifest, entries });
  assert.equal(JSON.stringify(first.payload), JSON.stringify(second.payload));

  const legacyAgain = await discoverTransfer({ roots: [path.join(fixture.home, "projects")], home: fixture.home });
  const legacyKeys = legacy.manifest.projects.map((project) => project.key).sort();
  const legacyKeysAgain = legacyAgain.manifest.projects.map((project) => project.key).sort();
  assert.notDeepEqual(legacyKeys, legacyKeysAgain, "the legacy scanner really does produce a new key every run");
});

test("DIFFERENCE: the three entries the projection finds and the legacy scanner misses", async (t) => {
  const { projected, legacy } = await bothScanners(t);
  const legacyPaths = new Set([
    ...legacy.manifest.global.context_files.map((file) => file.path),
    ...legacy.manifest.global.skills.map((file) => file.path),
  ]);
  const minePaths = [
    ...projected.payload.global.context_files.map((file) => file.path),
    ...projected.payload.global.skills.map((file) => file.path),
  ];
  const extra = minePaths.filter((entry) => !legacyPaths.has(entry)).sort();
  assert.deepEqual(extra, Object.keys(COVERAGE_GAINS).sort(), "an undocumented coverage difference appeared");

  // The symlinked skill is the one the legacy scanner warns about by name.
  assert.ok(legacy.warnings.some((warning) => /skipped \(symlink\).*shared-skill/.test(warning)));

  // And the inline-table MCP env, which the legacy line-based TOML scanner cannot read.
  const mine = byName(projected.payload.global.mcp_servers).get("codex:node_repl");
  const theirs = byName(legacy.manifest.global.mcp_servers).get("codex:node_repl");
  assert.deepEqual(theirs.env_keys, [], "the legacy scanner reads no env keys from an inline table");
  assert.deepEqual(mine.env_keys, ["NODE_REPL_TRUSTED_CODE_PATHS", "GITHUB_TOKEN"]);
});

test("DIFFERENCE: no file is dropped for looking credential-like", async (t) => {
  const { projected } = await bothScanners(t);
  const all = [
    ...projected.payload.global.context_files,
    ...projected.payload.global.skills,
    ...projected.payload.projects.flatMap((project) => [...project.context_files, ...project.skills]),
  ];
  // The design skill documents credential SHAPES on purpose; whole-file exclusion would
  // delete it (THR §4.2 Gap 3). It is here, and it is redacted rather than absent.
  assert.ok(all.some((file) => /design-review/.test(file.path)));
  for (const file of all) assert.ok(file.content.length > 0, `${file.path} was carried empty`);
});

test("every documented difference names a field, both behaviours, and a reason", () => {
  assert.ok(DIFFERENCES.length >= 5);
  for (const difference of DIFFERENCES) {
    for (const field of ["id", "field", "legacy", "projected", "why"]) {
      assert.ok(difference[field]?.length > 10, `difference ${difference.id} has a thin ${field}`);
    }
  }
});

test("the projection is pure: no filesystem, no network, no clock of its own", async () => {
  const source = await readFile(path.join(repoRoot, "src", "hosted", "local-transfer-v1.js"), "utf8");
  for (const module of ["node:fs", "node:fs/promises", "node:http", "node:https", "node:net", "node:child_process", "node:os"]) {
    assert.equal(source.includes(`"${module}"`), false, `the projection imports ${module}`);
  }
  assert.equal(/new Date\(\)/.test(source), false, "the timestamp comes from the bundle, not from the clock");
});

test("the projection is NOT wired into the shipping upload path", async () => {
  for (const file of ["src/cli.js", "src/api.js", "src/discovery.js", "src/cli/dispatch.js", "src/cli/export.js"]) {
    const source = await readFile(path.join(repoRoot, file), "utf8");
    assert.equal(source.includes("local-transfer-v1"), false, `${file} imports the cutover projection`);
  }
});

test("the projection refuses anything that is not a Continuity manifest", () => {
  assert.throws(() => projectLocalTransferV1({ manifest: {}, entries: new Map() }), TypeError);
  assert.throws(
    () => projectLocalTransferV1({ manifest: { schema_version: LEGACY_SCHEMA_VERSION }, entries: new Map() }),
    TypeError,
  );
});

test("sanitizeUrl keeps the endpoint and drops everything that could hide a credential", () => {
  assert.equal(sanitizeUrl("https://user:pw@host.test/a/b?token=x#frag"), "https://host.test/a/b");
  assert.equal(sanitizeUrl("not a url"), "not a url");
  assert.equal(sanitizeUrl(undefined), undefined);
});
