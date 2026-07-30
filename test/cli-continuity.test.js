// The CLI seam: subcommand routing, the `--json` envelope, the exit-code contract, and
// the guarantee that the legacy hosted-transfer flow is reached byte-for-byte as before.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { EXIT, dispatch, isSubcommand, parseArgs } from "../src/cli/dispatch.js";
import { materializeHome } from "./fixtures/materialize.js";

const run = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BIN = path.join(repoRoot, "bin", "omegas-dev.js");

function capture() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), envVars: {} },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

test("only an explicit subcommand routes away from the legacy flow", () => {
  assert.equal(isSubcommand(["scan"]), true);
  assert.equal(isSubcommand(["report", "--json"]), true);
  assert.equal(isSubcommand([]), false);
  assert.equal(isSubcommand(["--help"]), false);
  assert.equal(isSubcommand(["--root", "/tmp"]), false);
  assert.equal(isSubcommand(["--dry-run"]), false);
});

test("the legacy flow still prints its own help, unchanged", async () => {
  const { stdout } = await run(process.execPath, [BIN, "--help"]);
  assert.ok(stdout.startsWith("Usage: npx omegas-dev"));
  assert.ok(stdout.includes("--help, -h"));
  assert.ok(!stdout.includes("omegas-dev <command>"), "the legacy help must not change shape");
});

test("subcommand help is separate and says which path networks", async () => {
  const { stdout } = await run(process.execPath, [BIN, "scan", "--help"]);
  assert.ok(stdout.startsWith("Usage: omegas-dev <command>"));
  assert.ok(stdout.includes("--home <dir>"));
  assert.ok(stdout.includes("--root <dir>"));
  assert.ok(stdout.includes("--json"));
  assert.match(stdout, /read-only/i);
  assert.match(stdout, /only path that contacts a server/i);
});

test("an unknown argument is a usage error, not a scan", async () => {
  const io = capture();
  const code = await dispatch(["scan", "--nope"], io.io);
  assert.equal(code, EXIT.USAGE);
  assert.match(io.stderr(), /unknown argument: --nope/);
  assert.equal(io.stdout(), "");
});

test("--root and --home require a value", () => {
  assert.throws(() => parseArgs(["scan", "--root"]), /--root requires a directory/);
  assert.throws(() => parseArgs(["scan", "--home"]), /--home requires a directory/);
});

test("scan on a home with no runtime exits 2 and says so", async () => {
  const empty = await mkdtemp(path.join(os.tmpdir(), "omegas-empty-"));
  try {
    const io = capture();
    const code = await dispatch(["scan", "--home", empty], io.io);
    assert.equal(code, EXIT.NO_RUNTIME);
    assert.match(io.stdout(), /claude {2,}false/);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("scan --json emits the documented envelope and exits 3 when there are warnings", async () => {
  const fixture = await materializeHome();
  try {
    const io = capture();
    const code = await dispatch(
      ["scan", "--home", fixture.home, "--root", path.join(fixture.home, "projects"), "--json"],
      io.io,
    );
    assert.equal(code, EXIT.WARNINGS, "unresolved links and findings are warnings, not failure");

    const envelope = JSON.parse(io.stdout());
    assert.equal(envelope.ok, true);
    assert.equal(envelope.code, 3);
    assert.equal(envelope.command, "scan");
    assert.equal(envelope.schema_version, "omegas.continuity.v1");
    for (const key of ["items", "layers", "effective", "findings", "exclusions", "truncations", "unresolved_links"]) {
      assert.ok(Object.hasOwn(envelope.counts, key), `counts.${key} is missing`);
    }
    assert.ok(envelope.counts.items > 40);
    assert.ok(envelope.warnings.length > 0);
    assert.equal(envelope.environment.host.home_label, "~");
    assert.ok(envelope.environment.runtimes.some((runtime) => runtime.id === "hermes" && runtime.present === false));

    // Origin fields, edges and labels are tokenized. A machine path inside PAYLOAD
    // content is different and deliberate: `raw`/`parsed` stay verbatim and the
    // tokenization travels as a proposed rewrite resolved at import (manifest §1.5, §2.2).
    for (const item of envelope.items) {
      assert.ok(!item.origin.path.includes(fixture.real), `${item.item_id} origin.path leaks the home path`);
      assert.ok(
        !String(item.origin.key_path ?? "").includes(fixture.real),
        `${item.item_id} origin.key_path leaks the home path`,
      );
      assert.ok(!item.origin.display_path.includes(fixture.real));
      for (const edge of item.related) {
        assert.ok(!String(edge.external ?? "").includes(fixture.real), `${item.item_id} edge leaks the home path`);
      }
    }
    for (const record of envelope.exclusions) {
      assert.ok(!record.label.includes(fixture.real), `${record.rule_id} label leaks the home path`);
    }
    const withAbsoluteCommand = envelope.items.find((item) =>
      String(item.payload?.parsed?.value?.command ?? "").startsWith("/Users/"),
    );
    assert.ok(
      withAbsoluteCommand.portability.rewrites.some((rewrite) => rewrite.detector === "path.absolute_home"),
      "a payload path left verbatim must travel with a proposed rewrite",
    );
    assert.equal(withAbsoluteCommand.portability.rewrites[0].applied, false);

    assert.ok(!io.stdout().includes("FAKE-ACCESS-TOKEN"), "the envelope carries a never-export value");
  } finally {
    await fixture.cleanup();
  }
});

test("report renders every section a reader needs, and nothing was written", async () => {
  const fixture = await materializeHome();
  try {
    const io = capture();
    const code = await dispatch(
      ["report", "--home", fixture.home, "--root", path.join(fixture.home, "projects")],
      io.io,
    );
    assert.equal(code, EXIT.WARNINGS);
    const text = io.stdout();
    for (const section of [
      "1  ENVIRONMENT",
      "2  ITEMS",
      "3  LAYERS",
      "4  EFFECTIVE VALUES",
      "5  COMPATIBILITY",
      "6  FINDINGS",
      "7  REDACTIONS",
      "8  REFUSALS AND LIMITS",
    ]) {
      assert.ok(text.includes(section), `the report is missing "${section}"`);
    }
    assert.match(text, /shape-confirmed/);
    assert.match(text, /positional only/);
    assert.match(text, /unresolved links {2,}1/);
    assert.match(text, /truncation/);
    assert.match(text, /severity beats layer rank/);
    assert.match(text, /project_untrusted/);
    assert.match(text, /Read-only: nothing was written/);
    // The report is a LOCAL artifact, so it names the home it read on its first line.
    // Everything else is tokenized or `~`-relative; the only other machine paths it can
    // show come from payload content, which is verbatim by contract.
    for (const line of text.split("\n")) {
      const allowed = line.startsWith("home ") || line.includes("command") || line.includes("Read(");
      if (!allowed) assert.ok(!line.includes(fixture.real), `report line leaks the home path: ${line}`);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("the bin routes a subcommand end to end and reports the exit code", async () => {
  const fixture = await materializeHome();
  try {
    const result = await run(process.execPath, [
      BIN,
      "scan",
      "--home",
      fixture.home,
      "--root",
      path.join(fixture.home, "projects"),
    ]).catch((error) => error);
    assert.equal(result.code, EXIT.WARNINGS, "a warning exit still produces output on stdout");
    assert.match(result.stdout, /runtime {2,}present/);
    assert.match(result.stdout, /unresolved_links {2,}1/);
  } finally {
    await fixture.cleanup();
  }
});

test("a runtime below its adapter's supported floor exits 10 rather than warning", async () => {
  const fixture = await materializeHome();
  try {
    const ok = capture();
    assert.equal(await dispatch(["scan", "--home", fixture.home, "--json"], ok.io), EXIT.WARNINGS);
    const detected = JSON.parse(ok.stdout()).environment.runtimes.find((runtime) => runtime.version === "0.144.5");
    assert.ok(detected, "the fixture's version file should be read without spawning anything");
    assert.equal(detected.version_incompatible, false);

    // Below `breaking_below`, a written config parses cleanly and silently does nothing,
    // so the adapter refuses rather than warns.
    await writeFile(path.join(fixture.home, ".codex", "version.json"), '{ "version": "0.100.0" }\n');
    const stale = capture();
    const code = await dispatch(["scan", "--home", fixture.home, "--json"], stale.io);
    assert.equal(code, EXIT.VERSION_INCOMPATIBLE);
    const incompatible = JSON.parse(stale.stdout()).environment.runtimes.find(
      (runtime) => runtime.version_incompatible,
    );
    assert.match(incompatible.version_note, /supported floor \(0\.134\.0\)/);
  } finally {
    await fixture.cleanup();
  }
});

test("a scan of a fixture home never touches the invoking user's real config", async () => {
  const fixture = await materializeHome();
  try {
    const io = capture();
    await dispatch(["scan", "--home", fixture.home, "--json"], io.io);
    const envelope = JSON.parse(io.stdout());
    for (const item of envelope.items) {
      assert.ok(
        !item.origin.display_path.includes(os.homedir()),
        `${item.item_id} came from the real home directory`,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});
