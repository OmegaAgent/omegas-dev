// `omegas-dev compat` — the surfacing, not the derivation (that is compat.test.js).
// What matters here is that the command shows the exceptions and the losses instead of
// only the headline, and that the JSON envelope carries the same facts as the text.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { EXIT, dispatch, parseArgs } from "../src/cli/dispatch.js";
import { materializeHome } from "./fixtures/materialize.js";

function capture() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), envVars: {} },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function runCompat(t, args = []) {
  const fixture = await materializeHome("source");
  t.after(() => fixture.cleanup());
  const io = capture();
  const code = await dispatch(
    ["compat", "--home", fixture.home, "--root", path.join(fixture.home, "projects"), ...args],
    io.io,
  );
  return { code, io, fixture };
}

test("compat prints the derived matrix, the losses and the per-item exceptions", async (t) => {
  const { code, io } = await runCompat(t);
  assert.equal(code, EXIT.WARNINGS);
  const text = io.stdout();

  for (const section of ["0  RUNTIMES", "1  DERIVED COMPATIBILITY MATRIX", "2  LOSSES, BY CELL", "3  THIS MACHINE, ITEM BY ITEM"]) {
    assert.ok(text.includes(section), `compat is missing "${section}"`);
  }
  // The legend distinguishes the two negatives, which is the §4 claim in user-facing form.
  assert.match(text, /UNSUPPORTED\s+no equivalent — checked/);
  assert.match(text, /UNKNOWN\s+not yet supported — not checked/);
  // A declared runtime is listed rather than hidden.
  assert.match(text, /hermes\s+declared/);
  assert.match(text, /detection not implemented/);
  // Losses are named, with the citation that backs them.
  assert.match(text, /loses\s+@-imports/);
  assert.match(text, /inert on target/);
  assert.match(text, /evidence\s+COD §4\.7/);
  // The per-item exception the matrix alone would misrepresent.
  assert.match(text, /DEPART from the kind headline/);
  assert.match(text, /realtime_feed/);
  assert.match(text, /websocket transport/);
  // The computed loss, which nobody declared.
  assert.match(text, /experimentalRetry \(null -> toml\)/);
  assert.match(text, /Read-only: nothing was written/);
});

test("compat --json carries the same facts, in the shared envelope shape", async (t) => {
  const { code, io } = await runCompat(t, ["--json"]);
  assert.equal(code, EXIT.WARNINGS);
  const envelope = JSON.parse(io.stdout());
  assert.equal(envelope.command, "compat");
  assert.equal(envelope.schema_version, "omegas.continuity.v1");
  assert.equal(envelope.ok, true);

  const skill = envelope.matrix.find((row) => row.kind === "skill");
  const claudeToCodex = skill.cells.find((cell) => cell.from === "claude" && cell.to === "codex");
  assert.equal(claudeToCodex.verdict, "NATIVE");
  assert.ok(claudeToCodex.inert_on_target.length > 0);

  const mcp = envelope.matrix.find((row) => row.kind === "mcp_server");
  const mcpCell = mcp.cells.find((cell) => cell.from === "claude" && cell.to === "codex");
  assert.equal(mcpCell.verdict, "CONVERT");
  assert.ok(mcpCell.losses.length > 0);
  assert.ok(mcpCell.evidence.length > 0);

  const exception = envelope.exceptions.find((entry) => entry.item_id.endsWith("mcp_server:realtime_feed"));
  assert.ok(exception, "the ws entry should be reported as an exception");
  assert.equal(exception.verdict, "UNSUPPORTED");
  assert.equal(exception.kind_verdict, "CONVERT");

  // Coverage gaps are ours, not the runtime's, and the envelope says so rather than
  // letting a missing surface read as a missing capability.
  assert.ok(Array.isArray(envelope.coverage_gaps));
  assert.ok(envelope.coverage_gaps.some((gap) => gap.runtime === "codex" && gap.kind === "hook_script"));
});

test("compat --from and --to narrow the view", async (t) => {
  const { code, io } = await runCompat(t, ["--from", "claude", "--to", "codex"]);
  assert.equal(code, EXIT.WARNINGS);
  const text = io.stdout();
  assert.match(text, /clau->code/);
  assert.equal(/code->clau/.test(text), false, "the reverse direction should not be shown");
});

test("compat rejects a runtime it does not know", async (t) => {
  const { code, io } = await runCompat(t, ["--from", "gemini"]);
  assert.equal(code, EXIT.USAGE);
  assert.match(io.stderr(), /--from must name a known runtime/);
});

test("--from and --to belong to compat alone", () => {
  assert.throws(() => parseArgs(["scan", "--from", "claude"]), /--from applies to `compat` only/);
  assert.throws(() => parseArgs(["report", "--to", "codex"]), /--to applies to `compat` only/);
});

test("the text report folds in the compat section, with the exceptions visible", async (t) => {
  const fixture = await materializeHome("source");
  t.after(() => fixture.cleanup());
  const io = capture();
  const code = await dispatch(
    ["report", "--home", fixture.home, "--root", path.join(fixture.home, "projects")],
    io.io,
  );
  assert.equal(code, EXIT.WARNINGS);
  const text = io.stdout();
  assert.match(text, /5\s{2}COMPATIBILITY/);
  assert.match(text, /no hand-maintained matrix/i);
  assert.match(text, /depart from their kind's headline verdict/);
  assert.match(text, /Losses computed from the items' own unrecognized keys/);
  assert.match(text, /omegas-dev compat/);
});

test("an unsurveyed runtime is listed, is never a verified negative, and does not fill the table", async (t) => {
  const { io } = await runCompat(t);
  const text = io.stdout();
  // It appears in the runtime list...
  assert.match(text, /hermes\s+declared/);
  // ...and nowhere in the matrix columns, which are the two surveyed runtimes only.
  const matrixHeader = text.split("\n").find((line) => line.startsWith("kind "));
  assert.equal(/herm/.test(matrixHeader), false, "an unsurveyed runtime should not own a column by default");
  // Naming it explicitly brings it in, and every cell is UNKNOWN.
  const named = await runCompat(t, ["--to", "hermes"]);
  const cells = named.io
    .stdout()
    .split("\n")
    .filter((line) => /^(instructions|skill|hook|mcp_server)\s/.test(line));
  assert.ok(cells.length > 0);
  for (const line of cells) {
    assert.equal(/UNSUPPORTED/.test(line), false, `an unsurveyed target must not read UNSUPPORTED: ${line}`);
    assert.match(line, /UNKNOWN/);
  }
});
