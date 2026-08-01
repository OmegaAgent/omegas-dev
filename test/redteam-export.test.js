// Red team, guarantee 7 (never-export) and guarantee 1 (zero-secret bundle).
//
// The never-export table matches PATHS. Two things reach a bundle without going past a
// path the table knows:
//
//   • a hard link, which gives one inode a second name — the table sees the second name
//     and has no way to recognize it;
//   • a skill's assets, which were read straight through `safeReadText` and never met the
//     table at all, so a `deploy.pem` inside a skill directory was carried by policy while
//     the identical file one directory up was a hard refusal.
//
// Both are asserted here by planting a canary in a never-export sink and byte-scanning the
// bundle the real exporter writes. A canary is a fixed marker rather than a credential
// shape on purpose: a shape would be caught by the redactor, and what is under test is the
// POLICY, not the detector.
//
// The second half of the file measures the detector's own edges. Those tests do not
// assert that recall is perfect — it is not, and the shipped report says so. They assert
// that the tool's disclosures match its behaviour, and they pin the one structural claim
// that matters: the post-export scan is a backstop against plumbing bugs, not an
// independent second opinion, because it runs the same detector over the same bytes.

import assert from "node:assert/strict";
import { link, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { dispatch } from "../src/cli/dispatch.js";
import { postExportScan } from "../src/core/redact/index.js";
import { redactText } from "../src/core/redact/deepwalk.js";
import { materializeHome } from "./fixtures/materialize.js";

function recorder() {
  const out = { text: "" };
  return {
    io: { stdout: (t) => (out.text += t), stderr: (t) => (out.text += t), envVars: {}, interactive: false },
    out,
  };
}

async function exportBundle(fixture, extraArgs = []) {
  const out = path.join(fixture.temp, `bundle-${extraArgs.join("-") || "default"}.ocb.jsonl`);
  const { io, out: log } = recorder();
  const code = await dispatch(
    ["export", "--home", fixture.home, "--root", path.join(fixture.home, "projects"), "--out", out, ...extraArgs],
    io,
  );
  return { code, text: await readFile(out, "utf8").catch(() => ""), log: log.text };
}

test("red team: a hard link cannot smuggle a never-export sink into the bundle", async (t) => {
  const fixture = await materializeHome("source");
  t.after(() => fixture.cleanup());

  await writeFile(
    path.join(fixture.home, ".codex", "auth.json"),
    `${JSON.stringify({ tokens: { access_token: "FAKE-ACCESS-TOKEN" }, marker: "NEVEREXPORT-CANARY-0001" }, null, 2)}\n`,
  );
  // The sink, given a second name inside a directory the scanner walks.
  await mkdir(path.join(fixture.home, ".claude", "skills", "hardlink-skill"), { recursive: true });
  await link(
    path.join(fixture.home, ".codex", "auth.json"),
    path.join(fixture.home, ".claude", "skills", "hardlink-skill", "SKILL.md"),
  );

  const bundle = await exportBundle(fixture);
  assert.ok(bundle.text.length > 0, `export wrote no bundle: ${bundle.log}`);
  assert.ok(!bundle.text.includes("NEVEREXPORT-CANARY-0001"), "a hard link carried a never-export sink into the bundle");
  assert.ok(!bundle.text.includes("FAKE-ACCESS-TOKEN"), "the sink's credential reached the bundle");

  // Refused, not silently dropped: absence has to be data.
  assert.ok(
    /global\.multiple_hard_links/.test(bundle.text),
    "the refusal is not recorded anywhere a reader could see it",
  );
  // And the structure still travels, which is what separates a refusal from a silence.
  assert.ok(bundle.text.includes("hardlink-skill"), "the refused item vanished instead of being reported");
});

test("red team: a skill asset matching a never-export rule is refused at every payload policy", async (t) => {
  const fixture = await materializeHome("source");
  t.after(() => fixture.cleanup());

  const skill = path.join(fixture.home, ".claude", "skills", "deployer");
  await mkdir(path.join(skill, "references"), { recursive: true });
  await writeFile(path.join(skill, "SKILL.md"), "---\nname: deployer\n---\ndeploys things\n");
  // Names the GLOBAL never-export table calls private key material, wherever they sit.
  await writeFile(path.join(skill, "references", "prod.key"), "OPAQUE-KEYFILE-CANARY-0002\n");
  await writeFile(path.join(skill, "id_rsa"), "IDRSA-CANARY-0003\n");
  await writeFile(path.join(skill, "references", "chain.pem"), "PEMFILE-CANARY-0004\n");
  // A neighbouring asset with no rule against it, so the test proves a REFUSAL rather
  // than an exporter that simply carries nothing.
  await writeFile(path.join(skill, "references", "runbook.md"), "ORDINARY-ASSET-0005\n");

  for (const policy of ["definition", "definition+scripts", "full"]) {
    const bundle = await exportBundle(fixture, ["--payload-policy", policy]);
    assert.ok(bundle.text.length > 0, `export wrote no bundle at ${policy}: ${bundle.log}`);
    for (const canary of ["OPAQUE-KEYFILE-CANARY-0002", "IDRSA-CANARY-0003", "PEMFILE-CANARY-0004"]) {
      assert.ok(!bundle.text.includes(canary), `payload_policy=${policy} carried ${canary}`);
    }
    if (policy !== "definition") {
      assert.ok(
        bundle.text.includes("ORDINARY-ASSET-0005"),
        `payload_policy=${policy} carried no assets at all, so the refusal above proves nothing`,
      );
    }
  }
});

test("red team: a value redacted in one file is swept out of every other file", async (t) => {
  const fixture = await materializeHome("source");
  t.after(() => fixture.cleanup());

  // Positional-only: the value has no recognizable shape, and is redacted purely because
  // it sits in an MCP server's env block. It then appears again in prose, where nothing
  // would recognize it on its own.
  const shapeless = "quorum-lantern-ferry-88";
  const store = JSON.parse(await readFile(path.join(fixture.home, ".claude.json"), "utf8"));
  store.mcpServers = {
    ...(store.mcpServers ?? {}),
    swept: { command: "node", args: ["server.js"], env: { SERVICE_TOKEN: shapeless } },
  };
  await writeFile(path.join(fixture.home, ".claude.json"), `${JSON.stringify(store, null, 2)}\n`);
  await writeFile(
    path.join(fixture.home, ".claude", "CLAUDE.md"),
    `# Notes\n\nThe staging service token is ${shapeless} and it is used by the deploy step.\n`,
  );

  const bundle = await exportBundle(fixture);
  assert.ok(bundle.text.length > 0, `export wrote no bundle: ${bundle.log}`);
  assert.ok(!bundle.text.includes(shapeless), "a value redacted at one site survived at another");
  assert.ok(bundle.text.includes("SERVICE_TOKEN"), "the key name was erased along with the value");
});

test("red team: the post-export gate refuses rather than ships when a secret sits in a key NAME", async (t) => {
  const fixture = await materializeHome("source");
  t.after(() => fixture.cleanup());

  // Redaction hides values and never structure, and a key name is structure — so a
  // credential used as a map key is not something the redactor will rewrite. What must
  // then happen is a refusal, because the alternative is shipping it.
  const store = JSON.parse(await readFile(path.join(fixture.home, ".claude.json"), "utf8"));
  store.mcpServers = {
    ...(store.mcpServers ?? {}),
    "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB": { command: "node", args: ["s.js"] },
  };
  await writeFile(path.join(fixture.home, ".claude.json"), `${JSON.stringify(store, null, 2)}\n`);

  const bundle = await exportBundle(fixture);
  assert.equal(bundle.code, 5, `expected the redaction gate to refuse, got exit ${bundle.code}`);
  assert.equal(bundle.text, "", "a bundle was written despite the gate failing");
  assert.ok(/redaction pass/.test(bundle.log), "the refusal does not say what failed");
});

test("red team: the post-export scan is a backstop, not an independent second opinion", () => {
  // Stated plainly because it is the guarantee's real shape: the gate re-runs the SAME
  // detector over the serialized bytes, so a value no layer recognizes is invisible to
  // both. Recall is therefore the single point of failure, and any claim that the gate
  // makes a bundle secret-free REGARDLESS of recall is an overclaim.
  const shapeless = "the staging password is correct-horse-battery-staple";
  assert.deepEqual(redactText(shapeless, { generic: true, argv: true }).findings, [], "fixture is no longer shapeless");

  const serialized = JSON.stringify({ items: [{ payload: { parsed: { value: shapeless } } }] });
  assert.equal(postExportScan(serialized, new Set()).status, "passed", "the fixture no longer demonstrates this");

  // The other half of the gate is what actually carries the guarantee: once ANY layer has
  // seen a value once, the byte scan finds every other copy of it, in any field, whatever
  // recognized it the first time. That is what makes partial redaction a refusal.
  const seen = postExportScan(serialized, new Set([shapeless]));
  assert.equal(seen.status, "failed");
  assert.equal(seen.hits[0].kind, "redacted_value_present");
});

test("red team: the detector's blind spots are exactly the disclosed ones", () => {
  // Measured in the gate's own configuration, because that is the security-relevant one:
  // `generic` is off there, so a LOW-tier entropy hit would not fail the export either.
  const real = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";
  const gateSees = (text) =>
    redactText(text, { generic: false, argv: true }).findings.some((finding) => finding.tier === "HIGH");

  // Covered, and each of these was a plausible evasion before it was measured.
  assert.ok(gateSees(`token = "${real}"`), "the baseline shape is not detected at all");
  assert.ok(gateSees(Buffer.from(real).toString("base64")), "one level of base64 is no longer decoded");
  assert.ok(
    gateSees(`token = "${real.slice(0, 20)}" +\n  "${real.slice(20)}"`),
    "a token split across two source lines is no longer caught by its surviving prefix",
  );

  // Not covered, and disclosed as such. Each `false` is a gap the report names; a change
  // that closes one has to come past this test and update the disclosure with it.
  const doubleEncoded = Buffer.from(Buffer.from(real).toString("base64")).toString("base64");
  assert.equal(gateSees(doubleEncoded), false, "two decode levels now work; update the disclosed limit");
  assert.equal(gateSees(Buffer.from(real).toString("hex")), false, "hex decoding now works; update the disclosed limit");
  assert.equal(
    gateSees("the staging password is correct-horse-battery-staple"),
    false,
    "shapeless prose secrets now match; update the disclosed limit",
  );
});
