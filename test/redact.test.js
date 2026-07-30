// The redaction pass, unit by unit, plus the two invariants the milestone turns on:
// nothing unredacted survives into the derived tables, and a false positive never costs
// the user a file.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../src/core/adapters/registry.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { runScan } from "../src/core/engine/pipeline.js";
import { argvSpans, assignmentSpans, flagValueSpans } from "../src/core/redact/argv.js";
import { redactText } from "../src/core/redact/deepwalk.js";
import { charsetClass, isStructuralSpan, luhn, shannonEntropy } from "../src/core/redact/entropy.js";
import { PATTERNS, classifyValue, detectSpans, mergeSpans, nameLooksSecret } from "../src/core/redact/layers.js";
import { RefRegistry, containsPlaceholder, replaceOutsidePlaceholders } from "../src/core/redact/placeholder.js";
import { redact } from "../src/core/redact/index.js";
import { PRECISION_LINES, seededHome } from "./fixtures/seeded.js";
import { materializeHome } from "./fixtures/materialize.js";

const ref = () => "s1";
const scan = (text, options = {}) => redactText(text, { refFor: ref, ...options });

test("every pattern has a stable dotted id, a tier, and a global regex", () => {
  const seen = new Set();
  for (const pattern of PATTERNS) {
    assert.match(pattern.class, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, `${pattern.class} is not a dotted id`);
    assert.ok(["HIGH", "MEDIUM", "LOW"].includes(pattern.tier), `${pattern.class} has tier ${pattern.tier}`);
    assert.ok(pattern.regex.global, `${pattern.class} needs a global regex to find every occurrence`);
    seen.add(pattern.class);
  }
  assert.ok(seen.size >= 25, `only ${seen.size} classes; the design calls for roughly 25-30`);
});

test("Shannon entropy, charset and Luhn behave", () => {
  assert.equal(shannonEntropy(""), 0);
  assert.equal(shannonEntropy("aaaa"), 0);
  assert.ok(shannonEntropy("abcdefgh") > 2.9);
  assert.equal(charsetClass("0123456789"), "numeric");
  assert.equal(charsetClass("deadbeef"), "hex");
  assert.equal(charsetClass("aGVsbG8gd29ybGQ="), "base64ish");
  assert.equal(luhn("4242424242424242"), true);
  assert.equal(luhn("4242424242424241"), false);
});

test("structural suppression is per span, and `fake` is not a placeholder word", () => {
  assert.equal(isStructuralSpan("${API_TOKEN}"), true);
  assert.equal(isStructuralSpan("<YOUR_TOKEN>"), true);
  assert.equal(isStructuralSpan("changeme"), true);
  assert.equal(isStructuralSpan("AKIAIOSFODNN7EXAMPLE"), true);
  assert.equal(isStructuralSpan("xxxxxxxx"), true);
  // A seeded corpus is built out of shape-accurate fakes; treating "fake" as a placeholder
  // would make the recall gate unfalsifiable.
  assert.equal(isStructuralSpan("ghp_FAKE0000FAKE0000FAKE0000FAKE0000ab"), false);
  // The word EXAMPLE next to a real secret must not save the secret: suppression looks at
  // the span, not the line.
  const line = "EXAMPLE: use ghp_aB3dE5gH7jK9lM1nO3pQ5rS7tU9vW1xY3zA5 for staging";
  const found = scan(line);
  assert.equal(found.findings.length, 1);
  assert.equal(found.findings[0].class, "github.token");
});

test("the key-name layer fires on a bare TOKEN= and stands down on `author`", () => {
  assert.equal(nameLooksSecret("TOKEN"), true, "the baseline off-by-one (T-R2) must stay closed");
  assert.equal(nameLooksSecret("SECRET"), true);
  assert.equal(nameLooksSecret("api_key"), true);
  assert.equal(nameLooksSecret("author"), false);
  assert.equal(nameLooksSecret("keywords"), false);
  assert.equal(nameLooksSecret("model"), false);
});

test("argv redaction keeps the command and takes the credential", () => {
  const rule = "Bash(GROQ_API_KEY=gsk_aB3dE5gH7jK9lM1nO3pQ5rS7 cargo run:*)";
  const { text, findings } = scan(rule, { argv: true, generic: true });
  assert.ok(text.startsWith("Bash(GROQ_API_KEY="), "the env-prefix key name is the portable part");
  assert.ok(text.endsWith(" cargo run:*)"), "the command survives");
  assert.equal(findings[0].class, "groq.api_key");

  const hook = 'curl -H "Authorization: Bearer aB3dE5gH7jK9lM1nO3pQ" https://api.example.test/ping';
  const hooked = scan(hook, { argv: true });
  assert.ok(hooked.text.startsWith("curl -H \"Authorization: Bearer {{OMEGA_REDACTED:"));
  assert.ok(hooked.text.includes("https://api.example.test/ping"), "the endpoint survives");

  assert.equal(assignmentSpans("MY_TOKEN=abcdefg").length, 0, "a 7-character value is not a credential");
  assert.equal(assignmentSpans("export API_TOKEN=aB3dE5gH7jK9lM1nO3pQ").length, 1);
  assert.equal(flagValueSpans("cmd --password=hunter2secret1234").length, 1);
  assert.equal(argvSpans("cmd --transport sse").length, 0);
  // A URL must not parse as an assignment named `https`.
  assert.equal(assignmentSpans("see https://mcp.example.test/sse for details").length, 0);
});

test("the generic layer only fires where a surface declared a deep-scan sink", () => {
  const blob = "note: kQ8vN2xR7pL4mZ1yB6tC3wF5dG0hJ2kL";
  assert.equal(scan(blob, { generic: false }).findings.length, 0);
  assert.equal(scan(blob, { generic: true }).findings.length, 1);
  // A content digest is high-entropy and is not a credential.
  assert.equal(scan("sha: 0a1b2c3d4e5f60718293a4b5c6d7e8f9a0b1c2d3", { generic: true }).findings.length, 0);
});

test("a bounded decode pass catches a base64-wrapped secret", () => {
  const wrapped = Buffer.from("GITHUB_TOKEN=ghp_aB3dE5gH7jK9lM1nO3pQ5rS7tU9vW1xY3zA5").toString("base64");
  const { text, findings } = scan(`payload: ${wrapped}`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].detectors.includes("decoded"), true);
  assert.ok(!text.includes(wrapped), "the wrapper is replaced whole; half a base64 token decodes to garbage");
});

test("the more specific span wins an overlap, and detectors union", () => {
  const merged = mergeSpans([
    { start: 0, end: 40, value: "long", class: "unknown.high_entropy", tier: "LOW", detector: "entropy" },
    { start: 8, end: 40, value: "short", class: "github.token", tier: "HIGH", detector: "regex" },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].class, "github.token");
  assert.deepEqual(merged[0].detectors.sort(), ["entropy", "regex"]);
});

test("placeholders are idempotent and never nest", () => {
  const once = scan("token: ghp_aB3dE5gH7jK9lM1nO3pQ5rS7tU9vW1xY3zA5");
  const twice = scan(once.text);
  assert.equal(twice.findings.length, 0, "an existing placeholder must never be re-wrapped");
  assert.equal(twice.text, once.text);
  assert.ok(containsPlaceholder(once.text));
  const nested = replaceOutsidePlaceholders(once.text, "github.token", "REPLACED");
  assert.equal(nested, once.text, "a sweep must not rewrite the inside of a placeholder");
});

test("one value gets one ref no matter how many times it is seen", () => {
  const registry = new RefRegistry("fixed-salt");
  assert.equal(registry.refFor("ghp_aaaa"), "s1");
  assert.equal(registry.refFor("ghp_aaaa"), "s1");
  assert.equal(registry.refFor(" ghp_aaaa "), "s1", "whitespace is not part of a credential");
  assert.equal(registry.refFor("ghp_bbbb"), "s2");
});

test("classifyValue names the vendor, and the two sk- families stay apart", () => {
  assert.equal(classifyValue("sk-ant-api03-aB3dE5gH7jK9lM1nO3pQ").class, "anthropic.api_key");
  assert.equal(classifyValue("sk-proj-aB3dE5gH7jK9lM1nO3pQ5rS7").class, "openai.api_key");
  assert.equal(classifyValue("hello world"), null);
});

test("a URL keeps its endpoint and loses its credential, in both positions", () => {
  const items = (url) => [
    {
      item_id: "x:1",
      name: "x",
      surface_id: "s",
      origin: { key_path: "" },
      payload: { format: "json", raw: null, parsed: { value: { url } }, recognized: {}, unrecognized: {} },
      redaction_refs: [],
      related: [],
      _surface: { secret_positions: ["url"], deep_scan_positions: [], argv_positions: [], recognized_keys: [] },
      _raw_text: null,
      _body_text: null,
    },
  ];

  const userinfo = items("https://svc:hunter2secret@mcp.example.test/sse");
  redact({ items: userinfo, adapters: [], salt: "u" });
  assert.match(
    userinfo[0].payload.parsed.value.url,
    /^https:\/\/svc:\{\{OMEGA_REDACTED:url\.credential:s1\}\}@mcp\.example\.test\/sse$/,
    "the userinfo structure must survive: user, colon, placeholder, host",
  );

  const query = items("https://mcp.example.test/sse?access_token=aB3dE5gH7jK9lM1nO3pQ&mode=stream");
  redact({ items: query, adapters: [], salt: "q" });
  const rewritten = query[0].payload.parsed.value.url;
  assert.ok(rewritten.startsWith("https://mcp.example.test/sse?"), "the endpoint is the portable part");
  assert.ok(rewritten.includes("mode=stream"), "a non-credential parameter is untouched");
  assert.ok(!rewritten.includes("aB3dE5gH7jK9lM1nO3pQ"));

  const plain = items("https://mcp.example.test/sse");
  redact({ items: plain, adapters: [], salt: "p" });
  assert.equal(plain[0].payload.parsed.value.url, "https://mcp.example.test/sse", "a plain endpoint is not a secret");
});

test("proximity is required before a shapeless 40-character blob is called an AWS key", () => {
  const blob = "aB3dE5gH7jK9lM1nO3pQ5rS7tU9vW1xY3zA5bC7d";
  assert.equal(detectSpans(`value = ${blob}`).length, 0);
  assert.equal(detectSpans(`aws_secret_access_key = ${blob}`)[0].class, "aws.secret_key");
});

// ── the precision half of Gate 2 ────────────────────────────────────────────────────

for (const line of PRECISION_LINES) {
  test(`precision: keeps ${JSON.stringify(line.slice(0, 48))}`, () => {
    const { text, findings } = scan(line, { generic: true, argv: true });
    assert.equal(text, line, `false positive: ${findings.map((finding) => finding.class).join(", ")}`);
  });
}

test("a false positive never removes or truncates a file", async () => {
  const fixture = await materializeHome();
  try {
    const docs = [
      "# Redaction patterns",
      "",
      "GitHub tokens start with ghp_ and Slack tokens with xoxb-.",
      "AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE",
      "SESSION_SECRET=changeme",
      "Authorization: Bearer <YOUR_TOKEN>",
      "",
    ].join("\n");
    const { writeFile, mkdir } = await import("node:fs/promises");
    const dir = path.join(fixture.home, ".claude", "skills", "security-docs");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: security-docs\ndescription: documents credential shapes so they can be recognized\n---\n\n${docs}`,
    );

    const env = await buildEnvironment({
      homeDir: fixture.home,
      roots: [],
      os: process.platform,
      envVars: {},
      adapters: ADAPTERS,
    });
    const result = await runScan({ adapters: ADAPTERS, env, salt: "precision" });
    const item = result.items.find((entry) => entry.name === "security-docs");
    assert.ok(item, "the file must still be there — dropping it hides the structure AND says nothing");
    assert.ok(item._raw_text.includes(docs), "the body must survive byte for byte");
    assert.equal(item.redaction_refs.length, 0, "nothing in a shapes-documentation skill is a credential");
  } finally {
    await fixture.cleanup();
  }
});

// ── pipeline order ──────────────────────────────────────────────────────────────────

test("redaction runs before the effective table and the lints", async () => {
  const fixture = await seededHome({ perSurface: 3 });
  try {
    const env = await buildEnvironment({
      homeDir: fixture.home,
      roots: [path.join(fixture.home, "projects")],
      os: process.platform,
      envVars: {},
      adapters: ADAPTERS,
    });
    const result = await runScan({ adapters: ADAPTERS, env, salt: "ordering", payloadPolicy: "definition" });
    const derived = JSON.stringify({ effective: result.effective, findings: result.findings });
    for (const placement of fixture.placements) {
      assert.ok(
        !derived.includes(placement.secret),
        `${placement.surface} reached a derived table unredacted (${placement.class})`,
      );
    }
    // The effective table is keyed by rule strings for permissions, which is exactly the
    // row that carried an unredacted value before the ordering was fixed.
    const rules = result.effective.filter((row) => row.surface_id.includes("permissions"));
    assert.ok(rules.length > 0, "the fixture seeds permission rules");
    assert.ok(rules.some((row) => String(row.key).includes("OMEGA_REDACTED")));
  } finally {
    await fixture.cleanup();
  }
});

test("redaction hides values and never structure", async () => {
  const fixture = await materializeHome();
  try {
    const env = await buildEnvironment({
      homeDir: fixture.home,
      roots: [],
      os: process.platform,
      envVars: {},
      adapters: ADAPTERS,
    });
    const result = await runScan({ adapters: ADAPTERS, env, salt: "structure" });
    const server = result.items.find((item) => item.item_id.endsWith("mcp_server:elevenlabs"));
    assert.deepEqual(Object.keys(server.payload.parsed.value.env), ["ELEVENLABS_API_KEY"], "the key name stays");
    assert.equal(server.payload.parsed.value.command, "uvx", "the command stays");
    assert.match(server.payload.parsed.value.env.ELEVENLABS_API_KEY, /^\{\{OMEGA_REDACTED:[a-z0-9_.]+:s\d+\}\}$/);

    const remote = result.items.find((item) => item.item_id.endsWith("mcp_server:analytics"));
    assert.ok(remote.payload.parsed.value.url.startsWith("https://mcp.example.test/"), "the endpoint stays");
    assert.ok(remote.payload.parsed.value.headers.Authorization.startsWith("Bearer "), "the scheme word stays");

    // No length, no prefix, no suffix, no digest of a value anywhere in the side table.
    for (const record of result.redactions) {
      const serialized = JSON.stringify(record);
      assert.ok(!/"length"|"prefix"|"suffix"|"sha256"|"entropy"/.test(serialized), `${record.ref} leaks a value shape`);
    }

    // A file's recorded digest addresses the bytes that travel, not the ones that were
    // read: shipping a pre-redaction digest beside post-redaction content is both a
    // contradiction and a small leak of content identity.
    const redactedFile = result.items.find(
      (item) => item.redaction_refs.length > 0 && typeof item._raw_text === "string" && item.payload?.raw,
    );
    if (redactedFile) {
      const { createHash } = await import("node:crypto");
      const digest = `sha256:${createHash("sha256").update(redactedFile._raw_text).digest("hex")}`;
      assert.equal(redactedFile.payload.raw.sha256, digest);
      assert.equal(redactedFile.content_id, digest);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("an allowlisted key is shown rather than redacted, and the report says so", async () => {
  const fixture = await materializeHome();
  try {
    const env = await buildEnvironment({
      homeDir: fixture.home,
      roots: [],
      os: process.platform,
      envVars: {},
      adapters: ADAPTERS,
    });
    const result = await runScan({ adapters: ADAPTERS, env, salt: "allowlist" });
    const server = result.items.find((item) => item.item_id.endsWith("mcp_server:node_repl"));
    assert.equal(server.payload.parsed.value.env.NODE_REPL_TRUSTED_CODE_PATHS, "/opt/tools");
    assert.ok(result.redaction.allowlisted_keys.includes("NODE_REPL_TRUSTED_CODE_PATHS"));
  } finally {
    await fixture.cleanup();
  }
});

test("a positional hit with no shape is reported as structural, not high confidence", async () => {
  const fixture = await materializeHome();
  try {
    const env = await buildEnvironment({
      homeDir: fixture.home,
      roots: [],
      os: process.platform,
      envVars: {},
      adapters: ADAPTERS,
    });
    const result = await runScan({ adapters: ADAPTERS, env, salt: "confidence" });
    const flags = result.redactions.find((record) => record.key_names.includes("OMEGA_FEATURE_FLAGS"));
    assert.ok(flags, "a value in a declared env position is redacted whatever it looks like");
    assert.equal(flags.confidence, "structural", "claiming high confidence here would overstate the finding");
    const shaped = result.redactions.find((record) => record.class === "slack.token");
    assert.equal(shaped.confidence, "high");
  } finally {
    await fixture.cleanup();
  }
});

test("redact() is a pure function of its inputs: same items, same refs", () => {
  const items = () => [
    {
      item_id: "x:1",
      name: "x",
      surface_id: "s",
      origin: { key_path: "env.A" },
      payload: { format: "json", raw: null, parsed: { value: { A: "ghp_aB3dE5gH7jK9lM1nO3pQ5rS7tU9vW1xY3zA5" } }, recognized: {}, unrecognized: {} },
      redaction_refs: [],
      related: [],
      _surface: { secret_positions: ["env.*"], deep_scan_positions: [], argv_positions: [], recognized_keys: [] },
      _raw_text: null,
      _body_text: null,
    },
  ];
  const first = redact({ items: items(), adapters: [], salt: "a" });
  const second = redact({ items: items(), adapters: [], salt: "b" });
  assert.deepEqual(
    first.redactions.map((record) => [record.ref, record.class]),
    second.redactions.map((record) => [record.ref, record.class]),
    "a different salt must not change the labels a reader sees",
  );
});
