// The published bundle contract (manifest §5): the digest and its scope, entry-name
// canonicalization on read, caps, and payload_policy. Everything here is the part of the
// format a third-party implementation has to agree with byte for byte.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../src/core/adapters/registry.js";
import { readBundle } from "../src/core/bundle/read.js";
import { computeDigest, manifestDigestInput, sha256 } from "../src/core/bundle/digest.js";
import { BUNDLE_EXIT, blobName } from "../src/core/bundle/names.js";
import { PAYLOAD_POLICIES, buildBundle, serialize } from "../src/core/bundle/write.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { runScan } from "../src/core/engine/pipeline.js";
import { BundleManifestSchema, validate } from "../src/core/model/schema.js";
import { assembleBundle, capabilitiesOf, neverExportOf } from "../src/cli/export.js";
import { materializeHome } from "./fixtures/materialize.js";

async function scanFixture(fixture, payloadPolicy = "definition") {
  const env = await buildEnvironment({
    homeDir: fixture.home,
    roots: [path.join(fixture.home, "projects")],
    os: process.platform,
    envVars: {},
    adapters: ADAPTERS,
  });
  const result = await runScan({ adapters: ADAPTERS, env, salt: "bundle-salt", payloadPolicy });
  return { env, result };
}

function build(result, env, overrides = {}) {
  return buildBundle({
    bundleId: "ocb_fixed",
    createdAt: "2026-07-30T00:00:00.000Z",
    generatorVersion: "0.2.0",
    items: result.items,
    layers: result.layers,
    effective: result.effective,
    redactions: result.redactions,
    redactionHeader: result.redaction,
    findings: result.findings,
    exclusions: result.exclusions,
    truncations: result.truncations,
    runtimes: result.runtimes,
    projects: result.projects,
    capabilities: capabilitiesOf(ADAPTERS),
    neverExport: neverExportOf(ADAPTERS),
    environment: { host: { os: env.os, arch: "test", home_label: "~" } },
    assetTexts: result.asset_texts ?? new Map(),
    caps: env.caps,
    complete: result.complete,
    ...overrides,
  });
}

test("a built manifest validates against the published schema", async () => {
  const fixture = await materializeHome();
  try {
    const { env, result } = await scanFixture(fixture);
    const built = build(result, env);
    assert.deepEqual(validate(BundleManifestSchema, built.manifest, "manifest"), []);
    // The item projection carries no engine-internal field.
    for (const item of built.manifest.items) {
      for (const key of Object.keys(item)) assert.ok(!key.startsWith("_"), `${item.item_id} leaks ${key}`);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("the digest excludes bundle.id and created_at, and nothing else about the content", async () => {
  const fixture = await materializeHome();
  try {
    const { env, result } = await scanFixture(fixture);
    const first = build(result, env, { bundleId: "ocb_one", createdAt: "2026-07-30T01:00:00.000Z" });
    const second = build(result, env, { bundleId: "ocb_two", createdAt: "2027-01-01T09:30:00.000Z" });
    assert.equal(
      first.manifest.bundle.digest,
      second.manifest.bundle.digest,
      "two exports of identical content must agree, or reconciliation is impossible",
    );
    assert.notEqual(first.manifest.bundle.id, second.manifest.bundle.id);
    assert.notEqual(first.manifest.bundle.created_at, second.manifest.bundle.created_at);

    // …and it is genuinely content-addressed: change one byte of content, change the digest.
    const mutated = JSON.parse(JSON.stringify(first.manifest));
    mutated.items[0].name = `${mutated.items[0].name}-changed`;
    assert.notEqual(computeDigest(mutated, first.entries), first.manifest.bundle.digest);

    // The blanked fields really are blank in the hash input.
    const input = JSON.parse(manifestDigestInput(first.manifest));
    assert.equal(input.bundle.id, "");
    assert.equal(input.bundle.created_at, "");
    assert.equal(input.bundle.digest, "");
  } finally {
    await fixture.cleanup();
  }
});

test("a bundle round-trips through an independent reader", async () => {
  const fixture = await materializeHome();
  try {
    const { env, result } = await scanFixture(fixture);
    const built = build(result, env);
    const { manifest, entries } = readBundle(built.serialized);
    assert.equal(manifest.bundle.digest, built.manifest.bundle.digest);
    assert.equal(entries.size, built.manifest.bundle.entry_count);
    for (const declared of manifest.entries) {
      assert.equal(entries.get(declared.name).sha256, declared.sha256);
    }
    assert.equal(manifest.items.length, built.manifest.items.length);
  } finally {
    await fixture.cleanup();
  }
});

test("blobs are content-addressed, so identical content is stored once", () => {
  const digest = sha256("hello");
  assert.equal(blobName(digest), `blobs/${digest.slice(0, 2)}/${digest}`);
  assert.equal(blobName(`sha256:${digest}`), blobName(digest));
});

test("the reader refuses every canonicalization violation rather than repairing it", async () => {
  const fixture = await materializeHome();
  try {
    const { env, result } = await scanFixture(fixture);
    const built = build(result, env);
    const lines = built.serialized.split("\n").filter((line) => line.length > 0);
    const manifest = JSON.parse(lines[0]);
    const sample = JSON.parse(lines[1]);

    const cases = [
      ["absolute", "/etc/passwd"],
      ["home-relative", "~/.ssh/authorized_keys"],
      ["parent segment", "blobs/../../etc/passwd"],
      ["backslash separator", "blobs\\aa\\bb"],
      ["windows drive", "C:/blobs/aa/bb"],
      ["control byte", "blobs/aa/b\u0001b"],
      ["outside the prefix set", "sneaky/aa/bb"],
      ["over-deep", `blobs/${"a/".repeat(20)}b`],
      ["over-long segment", `blobs/aa/${"a".repeat(300)}`],
      ["reserved windows name", "blobs/aa/CON"],
      ["trailing dot", "blobs/aa/name."],
      ["empty segment", "blobs//bb"],
    ];
    for (const [label, name] of cases) {
      const entry = { ...sample, name };
      const doctored = serialize({ ...manifest, entries: [{ ...manifest.entries[0], name }] }, [
        { ...entry, encoding: "utf-8", content: sample.content },
      ]);
      assert.throws(
        () => readBundle(doctored, { verifyDigest: false }),
        (error) => error.exitCode === BUNDLE_EXIT.ENTRY_REFUSED,
        `${label} was not refused`,
      );
    }

    // NFD is the interesting one: the `..` only appears after normalization.
    const decomposed = "blobs/aa/e\u0301";
    assert.throws(
      () =>
        readBundle(
          serialize({ ...manifest, entries: [{ ...manifest.entries[0], name: decomposed }] }, [
            { ...sample, name: decomposed, encoding: "utf-8", content: sample.content },
          ]),
          { verifyDigest: false },
        ),
      (error) => error.exitCode === BUNDLE_EXIT.ENTRY_REFUSED,
    );

    // A case-fold collision between two entries is refused even though each name is legal.
    const collision = serialize({ ...manifest, entries: [] }, [
      { name: "blobs/aa/abc", sha256: `sha256:${sha256("x")}`, encoding: "utf-8", content: "x" },
      { name: "blobs/aa/ABC", sha256: `sha256:${sha256("y")}`, encoding: "utf-8", content: "y" },
    ]);
    assert.throws(
      () => readBundle(collision, { verifyDigest: false }),
      (error) => error.exitCode === BUNDLE_EXIT.ENTRY_REFUSED,
    );
  } finally {
    await fixture.cleanup();
  }
});

test("the reader refuses a tampered entry, a smuggled entry and an unknown schema", async () => {
  const fixture = await materializeHome();
  try {
    const { env, result } = await scanFixture(fixture);
    const built = build(result, env);
    const lines = built.serialized.split("\n").filter((line) => line.length > 0);
    const manifest = JSON.parse(lines[0]);
    const entries = lines.slice(1).map((line) => JSON.parse(line));

    const tampered = [...entries];
    tampered[0] = { ...tampered[0], content: `${tampered[0].content} tampered` };
    assert.throws(
      () => readBundle(serialize(manifest, tampered.map((entry) => ({ ...entry })))),
      /entry digest mismatch/,
    );

    const smuggled = [
      ...entries,
      { name: "blobs/ff/ffff", sha256: `sha256:${sha256("extra")}`, encoding: "utf-8", content: "extra" },
    ];
    assert.throws(() => readBundle(serialize(manifest, smuggled)), /does not declare/);

    const missing = serialize(manifest, entries.slice(1));
    assert.throws(() => readBundle(missing), /which is not in the bundle/);

    assert.throws(
      () => readBundle(serialize({ ...manifest, schema_version: "omegas.continuity.v2" }, entries)),
      /unknown schema_version/,
    );

    const wrongDigest = serialize({ ...manifest, bundle: { ...manifest.bundle, digest: "sha256:00" } }, entries);
    assert.throws(() => readBundle(wrongDigest), /digest mismatch/);
  } finally {
    await fixture.cleanup();
  }
});

test("caps refuse an oversized blob and say so instead of dropping the item", async () => {
  const fixture = await materializeHome();
  try {
    const { env, result } = await scanFixture(fixture);
    const built = build(result, env, { caps: { ...env.caps, entry_blob_bytes: 64 } });
    assert.ok(built.manifest.truncations.some((record) => record.reason.includes("entry_blob_bytes")));
    assert.equal(built.manifest.bundle.complete, false);
    const refused = built.manifest.items.find((item) => item.payload?.raw?.included === false);
    assert.ok(refused, "an item whose blob is refused is still carried, with its structure");
    assert.equal(refused.payload.raw.entry, null);
  } finally {
    await fixture.cleanup();
  }
});

test("payload_policy is a declared choice, and what it left behind is listed", async () => {
  const fixture = await materializeHome();
  try {
    const definition = await scanFixture(fixture, "definition");
    const withDefinition = build(definition.result, definition.env, { payloadPolicy: "definition" });
    const skill = withDefinition.manifest.items.find((item) => item.name === "design-review");
    assert.ok(skill.assets.length > 0, "the fixture skill ships assets");
    for (const asset of skill.assets) {
      assert.equal(asset.included, false);
      assert.equal(asset.reason, "payload_policy=definition");
      assert.ok(asset.bytes > 0, "a left-behind asset still states its size");
      assert.match(asset.sha256, /^sha256:[0-9a-f]{64}$/, "and its digest, so a reader can compare");
    }

    const scripts = await scanFixture(fixture, "definition+scripts");
    const withScripts = build(scripts.result, scripts.env, { payloadPolicy: "definition+scripts" });
    const carried = withScripts.manifest.items
      .flatMap((item) => item.assets ?? [])
      .filter((asset) => asset.included);
    assert.ok(carried.length > 0, "definition+scripts has to actually carry a script");
    for (const asset of carried) {
      assert.match(asset.entry, /^blobs\//);
      assert.ok(withScripts.manifest.entries.some((entry) => entry.name === asset.entry));
    }
    assert.ok(withScripts.manifest.bundle.byte_count > withDefinition.manifest.bundle.byte_count);
    assert.deepEqual(PAYLOAD_POLICIES, ["definition", "definition+scripts", "full"]);
  } finally {
    await fixture.cleanup();
  }
});

test("the never-export table travels as data, and no placeholder ever nests", async () => {
  const fixture = await materializeHome();
  try {
    const { env, result } = await scanFixture(fixture);
    const built = assembleBundle({
      result,
      env,
      adapters: ADAPTERS,
      payloadPolicy: "definition",
      now: new Date("2026-07-30T00:00:00.000Z"),
      id: "ocb_policy",
    });
    const rules = built.manifest.policy.never_export;
    assert.ok(rules.length > 10, "the exclusion list is a rule table, not code");
    for (const rule of rules) {
      assert.ok(rule.rule_id && rule.match && rule.reason, `${rule.rule_id} is missing a field`);
      assert.ok(!rule.match.includes(fixture.real), "a policy rule must not carry a machine path");
    }
    assert.ok(built.manifest.policy.caps.file_bytes > 0);

    assert.equal(
      /\{\{OMEGA_REDACTED:[^}]*\{\{/.test(built.serialized),
      false,
      "a nested placeholder is unparseable and unbindable",
    );
    for (const [whole, klass, ref] of built.serialized.matchAll(/\{\{OMEGA_REDACTED:([^:}]+):([^}]+)\}\}/g)) {
      // The header states the grammar itself; that occurrence is documentation.
      if (whole === built.manifest.redaction.placeholder_format) continue;
      assert.match(klass, /^[a-z][a-z0-9_.]*$/);
      assert.match(ref, /^s[0-9]+$/);
    }
  } finally {
    await fixture.cleanup();
  }
});
