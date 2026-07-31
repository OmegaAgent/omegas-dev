// The private HTML report. Three properties, each asserted rather than promised:
// it renders a redacted bundle and cannot be handed anything else, it references nothing
// on a network, and it carries no secret value.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../src/core/adapters/registry.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { runScan } from "../src/core/engine/pipeline.js";
import { assembleBundle } from "../src/cli/export.js";
import { dispatch, EXIT } from "../src/cli/dispatch.js";
import { NotABundleError, htmlFromBundleFile, renderBundleHtml } from "../src/cli/html.js";
import { materializeHome } from "./fixtures/materialize.js";

async function scanFixture(t) {
  const fixture = await materializeHome("source");
  t.after(() => fixture.cleanup());
  const env = await buildEnvironment({
    homeDir: fixture.home,
    roots: [path.join(fixture.home, "projects")],
    os: process.platform,
    envVars: {},
    adapters: ADAPTERS,
  });
  const result = await runScan({ adapters: ADAPTERS, env, payloadPolicy: "definition" });
  const built = assembleBundle({ result, env, adapters: ADAPTERS, payloadPolicy: "definition" });
  return { fixture, env, result, built };
}

/**
 * The real property behind "no network references": nothing in the document can cause the
 * browser to fetch anything, and no markup points off the machine. Config VALUES are
 * escaped text — including the `/` character, which is why a URL a user configured can
 * appear on the page as characters without `//` ever existing in the file.
 */
function networkReferences(html) {
  // Inline `data:` URIs are not network references — they carry their bytes with them and
  // fetch nothing. The one on this page is the embedded font. We strip every data: payload
  // FIRST (base64 legitimately contains `/`, which must not be read as a URL), then scan the
  // remainder for anything that would reach off the machine, and finally assert positively
  // that the only `url()`/`@font-face` left is the inline font. That is a stronger statement
  // than a blanket ban on `url(`: it forbids every remote form AND pins what inline is allowed.
  const stripped = html.replace(/url\(\s*data:[^)]*\)/g, "url(data:_)");
  const hits = [];
  const forbidden = [
    ["//", "a protocol-relative or scheme URL"],
    ["src=", "a fetched source attribute"],
    ["srcset=", "a fetched source set"],
    ["href=", "a link target"],
    ["action=", "a form target"],
    ["@import", "a CSS import"],
    ["<script", "a script element"],
    ["<link", "a link element"],
    ["<iframe", "an embedded frame"],
    ["<img", "an image element"],
    ["<object", "an object element"],
    ["<embed", "an embed element"],
    ["<video", "a video element"],
    ["<audio", "an audio element"],
    ["<source", "a media source"],
    ["<track", "a media track"],
    ["<base", "a base URL"],
    ["<form", "a form"],
    ["fetch(", "a fetch call"],
    ["XMLHttpRequest", "an XHR"],
    ["WebSocket", "a socket"],
    ["EventSource", "a server-sent-events stream"],
    ["sendBeacon", "a beacon"],
  ];
  for (const [needle, what] of forbidden) {
    if (stripped.includes(needle)) hits.push(`${what} (${needle})`);
  }
  // Every url() that survives the strip is a remote one — a leak.
  for (const match of stripped.matchAll(/url\(([^)]*)\)/g)) {
    if (match[1].trim() !== "data:_") hits.push(`a non-inline url() (${match[1].trim()})`);
  }
  // @font-face may exist, but only sourced from an inline data: URI.
  for (const block of html.matchAll(/@font-face\s*\{([^}]*)\}/g)) {
    if (!/src:\s*url\(\s*data:/.test(block[1])) hits.push("a @font-face with a non-inline src");
  }
  return hits;
}

test("the HTML page contains no network reference of any kind", async (t) => {
  const { built } = await scanFixture(t);
  const html = renderBundleHtml(built.manifest);
  assert.deepEqual(networkReferences(html), []);
  // Belt and braces: the page declares a policy that blocks everything but its own
  // inline stylesheet, so it stays inert even after someone edits it.
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'/);
  assert.equal(html.includes("javascript:"), false);
});

test("the page carries no secret value, only the redaction side table", async (t) => {
  const { built, result } = await scanFixture(t);
  const html = renderBundleHtml(built.manifest);
  const secrets = [...(result.secret_values ?? new Set())];
  assert.ok(secrets.length > 0, "the fixture should seed some fake credentials");
  for (const secret of secrets) {
    assert.equal(html.includes(secret), false, `a secret value reached the page: ${secret.slice(0, 6)}…`);
  }
  // What it does carry: classes, counts, key names and sites — the auditable part.
  assert.match(html, /distinct secret/);
  assert.match(html, /openai\.api_key|slack\.token|http\.authorization/);
  assert.match(html, /ELEVENLABS_API_KEY|SLACK_BOT_TOKEN/);
});

test("the renderer refuses a raw scan result: the isolation is structural, not documented", async (t) => {
  const { result, built } = await scanFixture(t);
  assert.throws(() => renderBundleHtml(result), NotABundleError);
  assert.throws(() => renderBundleHtml({ items: result.items }), NotABundleError);
  assert.throws(() => renderBundleHtml(null), NotABundleError);
  assert.throws(() => renderBundleHtml("a string"), NotABundleError);
  assert.throws(() => renderBundleHtml([built.manifest]), NotABundleError);

  // A manifest wearing the right schema_version but carrying engine-internal item fields
  // is a raw scan in a costume, and is refused on that evidence.
  const costume = JSON.parse(JSON.stringify(built.manifest));
  costume.items[0]._raw_text = "the unredacted bytes";
  assert.throws(() => renderBundleHtml(costume), /raw scan, not a bundle/);

  // A bundle missing its digest or redaction header never went through export.
  const noDigest = JSON.parse(JSON.stringify(built.manifest));
  noDigest.bundle.digest = "";
  assert.throws(() => renderBundleHtml(noDigest), NotABundleError);
});

test("the only way to produce a page is a bundle FILE, verified on the way in", async (t) => {
  const { built } = await scanFixture(t);
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-html-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bundlePath = path.join(temp, "bundle.ocb.jsonl");
  await writeFile(bundlePath, built.serialized);

  const html = await htmlFromBundleFile(bundlePath);
  assert.match(html, /Configuration report/);

  // Tampering is caught by the same reader an importer uses, so a doctored bundle cannot
  // be laundered into a nice-looking report.
  const tampered = path.join(temp, "tampered.ocb.jsonl");
  const lines = built.serialized.split("\n");
  const manifest = JSON.parse(lines[0]);
  manifest.items[0].name = "something-else";
  lines[0] = JSON.stringify(manifest);
  await writeFile(tampered, lines.join("\n"));
  await assert.rejects(() => htmlFromBundleFile(tampered), /digest mismatch/);
});

test("the page renders every section a reader needs", async (t) => {
  const { built } = await scanFixture(t);
  const html = renderBundleHtml(built.manifest);
  for (const heading of [
    "Configuration report",
    "Local, private, redacted. Safe to screenshot.",
    "1 &nbsp;Environment",
    "2 &nbsp;Compatibility",
    "3 &nbsp;Items",
    "4 &nbsp;Effective values",
    "5 &nbsp;Findings",
    "6 &nbsp;Redaction",
    "7 &nbsp;Refusals and limits",
  ]) {
    assert.ok(html.includes(heading), `the page is missing "${heading}"`);
  }
  // Provenance, portability, the derived matrix, the merge explanation, the units.
  assert.match(html, /~&#47;\.claude\.json/);
  assert.match(html, /MACHINE-LOCAL|REWRITE|PORTABLE|SECRET/);
  assert.match(html, /v-NATIVE|v-CONVERT/);
  assert.match(html, /APPLIED/);
  assert.match(html, /shadowed/);
  assert.match(html, /never-export|Never exported/i);
  assert.match(html, /keys|files/);
  assert.match(html, /Unresolved links/);
  assert.match(html, /no script/);
});

test("the page is one file: no companion asset, no directory", async (t) => {
  const { built } = await scanFixture(t);
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-html-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bundlePath = path.join(temp, "bundle.ocb.jsonl");
  await writeFile(bundlePath, built.serialized);
  const out = path.join(temp, "out", "report.html");

  const io = capture();
  const code = await dispatch(["report", "--html", out, "--bundle", bundlePath], io.io);
  assert.equal(code, EXIT.OK);
  const info = await stat(out);
  assert.equal(info.mode & 0o777, 0o600, "the page is a complete picture of a configuration; it is not world-readable");
  const html = await readFile(out, "utf8");
  assert.deepEqual(networkReferences(html), []);
  assert.match(io.stdout(), /no network reference of any kind/);
});

test("a tampered bundle exits 6, the published integrity code, and writes no page", async (t) => {
  const { built } = await scanFixture(t);
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-html-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const bundlePath = path.join(temp, "tampered.ocb.jsonl");
  const out = path.join(temp, "report.html");

  const lines = built.serialized.split("\n");
  const manifest = JSON.parse(lines[0]);
  manifest.items[0].name = "planted";
  lines[0] = JSON.stringify(manifest);
  await writeFile(bundlePath, lines.join("\n"));

  const io = capture();
  const code = await dispatch(["report", "--html", out, "--bundle", bundlePath], io.io);
  assert.equal(code, EXIT.INTEGRITY);
  assert.match(io.stderr(), /digest mismatch/);
  await assert.rejects(() => readFile(out, "utf8"), { code: "ENOENT" });
});

test("`report --html` without a bundle refuses, and says how to make one", async () => {
  const io = capture();
  const code = await dispatch(["report", "--html", "/tmp/should-not-exist.html"], io.io);
  assert.equal(code, EXIT.USAGE);
  assert.match(io.stderr(), /renders a redacted bundle/);
  assert.match(io.stderr(), /omegas-dev export/);
});

test("`--html` is rejected on any command that is not report", async () => {
  for (const command of ["scan", "export", "diff"]) {
    const io = capture();
    const code = await dispatch([command, "--html", "/tmp/x.html"], io.io);
    assert.equal(code, EXIT.USAGE);
    assert.match(io.stderr(), /--html applies to `report` only/);
  }
});

function capture() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text), envVars: {} },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}
