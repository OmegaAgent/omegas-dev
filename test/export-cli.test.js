// `omegas-dev export` end to end: the artifacts it writes, the modes it writes them with,
// the exit codes, and security Gate 5 — a full scan → redact → export cycle with the
// network and process APIs stubbed to throw.

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../src/core/adapters/registry.js";
import { readBundle } from "../src/core/bundle/read.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { runScan } from "../src/core/engine/pipeline.js";
import { EXIT, dispatch, parseArgs } from "../src/cli/dispatch.js";
import {
  EXIT_REDACTION_GATE,
  ExportGateError,
  assembleBundle,
  defaultBundlePath,
  defaultReportPath,
  runExport,
  stateDir,
} from "../src/cli/export.js";
import { assertNoValues } from "../src/core/redact/secretmap.js";
import { materializeHome } from "./fixtures/materialize.js";
import { seededHome } from "./fixtures/seeded.js";

const require = createRequire(import.meta.url);

function capture() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), envVars: {} },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function modeOf(file) {
  return (await stat(file)).mode & 0o777;
}

test("export writes one shareable artifact plus two local-only ones", async () => {
  const fixture = await seededHome({ perSurface: 3 });
  try {
    const io = capture();
    const code = await dispatch(
      ["export", "--home", fixture.home, "--root", path.join(fixture.home, "projects"), "--json"],
      io.io,
    );
    assert.equal(code, EXIT.WARNINGS, "the fixture has unresolved links and findings");

    const envelope = JSON.parse(io.stdout());
    assert.equal(envelope.ok, true);
    assert.equal(envelope.command, "export");
    assert.equal(envelope.schema_version, "omegas.continuity.v1");
    assert.match(envelope.bundle.digest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(envelope.bundle.payload_policy, "definition");
    assert.equal(envelope.redaction.post_export_scan.status, "passed");
    assert.ok(envelope.redaction_summary.distinct_secrets > 20);

    // The three artifacts, and the two that must never be shared are 0600 with a basename
    // stem that cannot be confused with the bundle's (T-E2).
    assert.equal(await modeOf(envelope.bundle.path), 0o600);
    assert.equal(await modeOf(envelope.report_path), 0o600);
    assert.equal(await modeOf(envelope.secret_map_path), 0o600);
    const bundleStem = path.basename(envelope.bundle.path).split(".")[0];
    const reportStem = path.basename(envelope.report_path).split(".")[0];
    assert.notEqual(bundleStem, reportStem);
    assert.ok(!reportStem.startsWith(bundleStem));

    const bundleText = await readFile(envelope.bundle.path, "utf8");
    const { manifest } = readBundle(bundleText);
    assert.equal(manifest.bundle.digest, envelope.bundle.digest);

    // Nothing seeded reached the shareable artifact.
    for (const placement of fixture.placements) {
      assert.ok(!bundleText.includes(placement.secret), `${placement.surface} leaked into the bundle file`);
    }

    // The local report is allowed to say more, but never a value.
    const report = await readFile(envelope.report_path, "utf8");
    assert.match(report, /contains more than the bundle/);
    assert.match(report, /## Shape-confirmed/);
    assert.match(report, /## Positional only/);
    for (const placement of fixture.placements) {
      assert.ok(!report.includes(placement.secret), "the local report must not carry a value either");
    }

    // The secret map is pointers and a salt. Nothing else.
    const map = JSON.parse(await readFile(envelope.secret_map_path, "utf8"));
    assert.match(map.salt, /^[0-9a-f]{64}$/);
    assert.equal(map.bundle_id, envelope.bundle.id);
    for (const [ref, entry] of Object.entries(map.refs)) {
      assert.match(ref, /^s[0-9]+$/);
      assert.ok(Array.isArray(entry.sites) && entry.sites.length > 0);
      assert.ok(entry.class);
      assert.ok(!("value" in entry) && !("digest" in entry) && !("length" in entry));
    }
    for (const placement of fixture.placements) {
      assert.ok(!JSON.stringify(map).includes(placement.secret), "the map must hold pointers, not values");
    }
    assert.equal(map.salt in map.refs, false);
  } finally {
    await fixture.cleanup();
  }
});

test("the human rendering names the artifacts and the counts", async () => {
  const fixture = await materializeHome();
  try {
    const io = capture();
    const code = await dispatch(["export", "--home", fixture.home], io.io);
    assert.equal(code, EXIT.WARNINGS);
    const text = io.stdout();
    assert.match(text, /post-export scan {2,}passed/);
    assert.match(text, /redacted {2,}\d+ distinct secret\(s\)/);
    assert.match(text, /shape-confirmed/);
    assert.match(text, /positional only/);
    assert.match(text, /never-exported/);
    assert.match(text, /local report/);
    assert.match(text, /secret map/);
    assert.match(text, /placeholders, never values/);
  } finally {
    await fixture.cleanup();
  }
});

test("--out, --payload-policy and the absence of --include-secrets", async () => {
  const fixture = await materializeHome();
  try {
    const target = path.join(fixture.temp, "shared", "setup.ocb.jsonl");
    const io = capture();
    const code = await dispatch(
      ["export", "--home", fixture.home, "--out", target, "--payload-policy", "definition+scripts", "--json"],
      io.io,
    );
    assert.equal(code, EXIT.WARNINGS);
    const envelope = JSON.parse(io.stdout());
    assert.equal(envelope.bundle.path, target);
    assert.equal(envelope.bundle.payload_policy, "definition+scripts");
    readBundle(await readFile(target, "utf8"));

    // The flag does not exist, and saying so is better than "unknown argument".
    assert.throws(() => parseArgs(["export", "--include-secrets"]), /no --include-secrets/);
    assert.throws(() => parseArgs(["export", "--payload-policy", "everything"]), /--payload-policy must be one of/);
    assert.throws(() => parseArgs(["scan", "--out", "/tmp/x"]), /applies to `export` only/);

    const bad = capture();
    assert.equal(await dispatch(["export", "--home", fixture.home, "--include-secrets"], bad.io), EXIT.USAGE);
    assert.match(bad.stderr(), /never moves a credential value/);
  } finally {
    await fixture.cleanup();
  }
});

test("re-export replaces a bundle but refuses to overwrite anything else", async () => {
  const fixture = await materializeHome();
  try {
    const target = path.join(fixture.temp, "setup.ocb.jsonl");
    const first = capture();
    await dispatch(["export", "--home", fixture.home, "--out", target, "--json"], first.io);
    const before = JSON.parse(first.stdout()).bundle.digest;

    const again = capture();
    await dispatch(["export", "--home", fixture.home, "--out", target, "--json"], again.io);
    assert.equal(JSON.parse(again.stdout()).bundle.digest, before, "re-exporting the same home is idempotent");

    const { writeFile } = await import("node:fs/promises");
    const precious = path.join(fixture.temp, "notes.md");
    await writeFile(precious, "# my notes\n");
    await assert.rejects(
      dispatch(["export", "--home", fixture.home, "--out", precious], capture().io),
      /refusing to overwrite it/,
    );
    assert.equal(await readFile(precious, "utf8"), "# my notes\n");
  } finally {
    await fixture.cleanup();
  }
});

test("the post-export gate aborts with exit 5 and writes nothing", async () => {
  const fixture = await materializeHome();
  try {
    const env = await buildEnvironment({
      homeDir: fixture.home,
      roots: [],
      os: process.platform,
      envVars: {},
      adapters: ADAPTERS,
    });
    const result = await runScan({ adapters: ADAPTERS, env, salt: "gate" });

    // Simulate the failure the gate exists to catch: a value the redaction pass believes
    // it handled is still present in the serialized bytes. `sonnet-5` is a real string in
    // the fixture's settings, so the check has something to find.
    result.secret_values.add("sonnet-5");
    assert.throws(
      () => assembleBundle({ result, env, adapters: ADAPTERS, payloadPolicy: "definition" }),
      (error) => error instanceof ExportGateError && error.scan.status === "failed",
    );

    const io = capture();
    const code = await runExport({
      options: { payloadPolicy: "definition", out: null, json: false },
      result,
      env,
      adapters: ADAPTERS,
      code: EXIT.OK,
      io: io.io,
    });
    assert.equal(code, EXIT_REDACTION_GATE);
    assert.equal(code, EXIT.REDACTION_GATE, "the two definitions of exit 5 must not drift");
    assert.match(io.stderr(), /post-export scan FAILED/);
    assert.match(io.stderr(), /No file was written/);
    assert.match(io.stderr(), /bug in the redaction pass/);
    assert.equal(io.stdout(), "");

    // Nothing on disk: not a bundle, not a report, not a temp file.
    const entries = await readdir(stateDir(fixture.home)).catch(() => []);
    assert.deepEqual(entries, [], "a refused export must leave the filesystem untouched");
  } finally {
    await fixture.cleanup();
  }
});

test("a clean home exports with exit 0 and an empty redaction table", async () => {
  const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const home = await mkdtemp(path.join(os.tmpdir(), "omegas-clean-"));
  try {
    await mkdir(path.join(home, ".claude"), { recursive: true });
    await writeFile(path.join(home, ".claude", "CLAUDE.md"), "# Notes\n\nBe concise.\n");

    const io = capture();
    const code = await dispatch(["export", "--home", home, "--json"], io.io);
    assert.equal(code, EXIT.OK, "nothing to warn about means exit 0");
    const envelope = JSON.parse(io.stdout());
    assert.equal(envelope.redaction.distinct_secrets, 0);
    assert.equal(envelope.redaction.post_export_scan.status, "passed");
    assert.equal(envelope.warnings.length, 0);
    // An empty redaction table still produces a valid, readable bundle.
    const { manifest } = readBundle(await readFile(envelope.bundle.path, "utf8"));
    assert.deepEqual(manifest.redactions, []);
    assert.ok(manifest.items.length > 0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("export refuses a home with no runtime rather than writing an empty bundle", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const os = await import("node:os");
  const empty = await mkdtemp(path.join(os.tmpdir(), "omegas-empty-export-"));
  try {
    const io = capture();
    const code = await dispatch(["export", "--home", empty], io.io);
    assert.equal(code, EXIT.NO_RUNTIME);
    assert.match(io.stderr(), /nothing to export/);
    assert.deepEqual(await readdir(stateDir(empty)).catch(() => []), []);
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("assertNoValues refuses to write a map that would carry a value", () => {
  assert.throws(
    () => assertNoValues({ refs: { s1: { note: "ghp_aB3dE5gH7jK9lM1nO3pQ" } } }, new Set(["ghp_aB3dE5gH7jK9lM1nO3pQ"])),
    /refusing to write/,
  );
  assert.equal(assertNoValues({ refs: { s1: { class: "github.token" } } }, new Set(["ghp_aB3dE5gH7jK9lM1nO3pQ"])), true);
});

test("default artifact paths live in the state dir under the scanned home", () => {
  const now = new Date("2026-07-30T00:00:00.000Z");
  assert.equal(
    defaultBundlePath("/home/u", now),
    path.join("/home/u", ".omegas", "continuity", "omegas-continuity-local-20260730.ocb.jsonl"),
  );
  assert.equal(
    defaultReportPath("/home/u", now),
    path.join("/home/u", ".omegas", "continuity", "redaction-review-local-20260730.md"),
  );
});

// ── Security Gate 5 (THR §3.6): no network, no subprocess, for the whole cycle ──────

test("Gate 5 — a full scan → redact → export cycle with the network stubbed to throw", async () => {
  const fixture = await seededHome({ perSurface: 3 });
  const net = require("node:net");
  const dns = require("node:dns");
  const tls = require("node:tls");
  const http = require("node:http");
  const https = require("node:https");
  const childProcess = require("node:child_process");
  const saved = {
    fetch: globalThis.fetch,
    netConnect: net.connect,
    netCreateConnection: net.createConnection,
    dnsLookup: dns.lookup,
    dnsPromisesLookup: dns.promises.lookup,
    tlsConnect: tls.connect,
    httpRequest: http.request,
    httpsRequest: https.request,
    spawn: childProcess.spawn,
    spawnSync: childProcess.spawnSync,
    fork: childProcess.fork,
  };
  const boom = (what) => () => {
    throw new Error(`open core touched ${what}`);
  };
  try {
    globalThis.fetch = boom("fetch");
    net.connect = boom("net.connect");
    net.createConnection = boom("net.createConnection");
    dns.lookup = boom("dns.lookup");
    dns.promises.lookup = boom("dns.promises.lookup");
    tls.connect = boom("tls.connect");
    http.request = boom("http.request");
    https.request = boom("https.request");
    childProcess.spawn = boom("spawn");
    childProcess.spawnSync = boom("spawnSync");
    childProcess.fork = boom("fork");

    const io = capture();
    const code = await dispatch(
      ["export", "--home", fixture.home, "--root", path.join(fixture.home, "projects"), "--json"],
      io.io,
    );
    assert.equal(code, EXIT.WARNINGS);
    const envelope = JSON.parse(io.stdout());
    assert.equal(envelope.redaction.post_export_scan.status, "passed");
    readBundle(await readFile(envelope.bundle.path, "utf8"));
  } finally {
    globalThis.fetch = saved.fetch;
    net.connect = saved.netConnect;
    net.createConnection = saved.netCreateConnection;
    dns.lookup = saved.dnsLookup;
    dns.promises.lookup = saved.dnsPromisesLookup;
    tls.connect = saved.tlsConnect;
    http.request = saved.httpRequest;
    https.request = saved.httpsRequest;
    childProcess.spawn = saved.spawn;
    childProcess.spawnSync = saved.spawnSync;
    childProcess.fork = saved.fork;
    await fixture.cleanup();
  }
});
