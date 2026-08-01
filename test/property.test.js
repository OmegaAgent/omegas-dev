// Property-based tests. Every other suite checks inputs a human enumerated; this one
// generates them and asserts invariants that must hold for ALL of them — the input nobody
// thought of. There is no fast-check and no dependency: a small in-repo seeded PRNG makes
// the whole run DETERMINISTIC, so a failure reproduces from the same seed on every machine
// and CI never flakes. Bump SEED to resample.

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { computeDigest, sha256 } from "../src/core/bundle/digest.js";
import { formatFor } from "../src/core/formats/index.js";
import { canonicalRelPath, insideRoot, toPosix } from "../src/core/fsx/paths.js";
import { redactText } from "../src/core/redact/deepwalk.js";
import { craft, item } from "./fixtures/bundles.js";

const SEED = 0x5eedc0de; // a fixed constant; deterministic across runs
const CASES = 300;

// mulberry32 — a tiny, well-understood 32-bit PRNG. Same seed, same stream, everywhere.
function makeRng(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function harness() {
  const rng = makeRng(SEED);
  const int = (min, max) => min + Math.floor(rng() * (max - min + 1));
  const pick = (choices) => choices[int(0, choices.length - 1)];
  const chance = (p) => rng() < p;
  const word = () => Array.from({ length: int(1, 8) }, () => pick([..."abcdefghijklmnopqrstuvwxyz0123456789_"])).join("");
  return { rng, int, pick, chance, word };
}

// The whole write path rests on this: a targeted edit moves the bytes of one span and
// nothing else. Mirrors the check in formats.test.js, applied to generated documents.
function assertOnlyRangeChanged(before, after, span, replacement, label) {
  const source = Buffer.from(before, "utf8");
  const result = Buffer.from(after, "utf8");
  const width = Buffer.byteLength(replacement, "utf8");
  assert.equal(
    result.subarray(0, span.byte_start).toString("utf8"),
    source.subarray(0, span.byte_start).toString("utf8"),
    `${label}: bytes before the edited span changed`,
  );
  assert.equal(result.subarray(span.byte_start, span.byte_start + width).toString("utf8"), replacement, `${label}: replacement`);
  assert.equal(
    result.subarray(span.byte_start + width).toString("utf8"),
    source.subarray(span.byte_end).toString("utf8"),
    `${label}: bytes after the edited span changed`,
  );
}

// ── property 1: format round-trip ─────────────────────────────────────────────────────

function scalar(h) {
  return h.pick([h.int(-9999, 9999), h.chance(0.5), `s_${h.word()}`, h.word()]);
}

function jsonTree(h, depth = 0) {
  const tree = {};
  const keys = h.int(1, 4);
  for (let i = 0; i < keys; i += 1) {
    const key = `k_${h.word()}`;
    if (depth < 2 && h.chance(0.3)) tree[key] = jsonTree(h, depth + 1);
    else if (h.chance(0.15)) tree[key] = null;
    else tree[key] = scalar(h);
  }
  if (Object.keys(tree).length === 0) tree.k_seed = scalar(h);
  return tree;
}

function generateDocument(format, h) {
  if (format === "json" || format === "jsonc") {
    return JSON.stringify(jsonTree(h), null, h.pick([2, 4]));
  }
  if (format === "toml") {
    const flat = {};
    const keys = h.int(1, 5);
    for (let i = 0; i < keys; i += 1) flat[`k_${h.word()}`] = h.pick([h.int(0, 9999), h.chance(0.5), `v_${h.word()}`]);
    return formatFor("toml").serialize(flat, undefined);
  }
  if (format === "dotenv") {
    const flat = {};
    const keys = h.int(1, 5);
    for (let i = 0; i < keys; i += 1) flat[`K_${h.word().toUpperCase()}`] = `v_${h.word()}`;
    return formatFor("dotenv").serialize(flat, undefined);
  }
  // md+frontmatter, generated as text: a frontmatter block plus a body.
  const lines = ["---"];
  const keys = h.int(1, 4);
  for (let i = 0; i < keys; i += 1) lines.push(`k_${h.word()}: v_${h.word()}`);
  lines.push("---", `# ${h.word()}`, `${h.word()} ${h.word()}`, "");
  return lines.join("\n");
}

test("property: parse->patch([]) is byte-exact, and a single-key edit moves only that key's span", () => {
  const h = harness();
  const formats = ["json", "jsonc", "toml", "md+frontmatter", "dotenv"];
  let checkedEdits = 0;
  for (let n = 0; n < CASES; n += 1) {
    const format = formats[n % formats.length];
    const module = formatFor(format);
    const text = generateDocument(format, h);

    // Round-trip: an empty patch returns the input byte-for-byte.
    const roundTripped = module.patch(text, []);
    assert.ok(
      Buffer.from(roundTripped, "utf8").equals(Buffer.from(text, "utf8")),
      `${format} #${n}: empty patch was not byte-exact`,
    );

    // Targeted edit: pick a real leaf span and patch only it.
    const parsed = module.parse(text);
    const editable = Object.entries(parsed.spans ?? {}).filter(([key]) => !key.startsWith("$"));
    if (editable.length === 0) continue;
    const [key, span] = editable[h.int(0, editable.length - 1)];
    const replacement = `"EDITED_${n}"`;
    const edited = module.patch(text, [{ span: { byte_start: span.byte_start, byte_end: span.byte_end }, replacement }]);
    assertOnlyRangeChanged(text, edited, span, replacement, `${format} #${n} @ ${key}`);
    checkedEdits += 1;
  }
  assert.ok(checkedEdits > CASES / 2, `too few targeted edits exercised (${checkedEdits})`);
});

// ── property 2: entry-name canonicalization ───────────────────────────────────────────

const HOSTILE_PARTS = [
  "..",
  ".",
  "safe",
  "dir",
  "foo",
  "..%2f",
  "%2e%2e",
  "café",
  "café", // NFD form of the same word
  "\u0000ctl",
  "tab\ttab",
  "con",
  "aux",
  "trail.",
  "trail ",
  "back\\slash",
  "x".repeat(300),
  "~root",
  "sub/leaf",
];

function hostileName(h) {
  const count = h.int(1, 4);
  const parts = Array.from({ length: count }, () => h.pick(HOSTILE_PARTS));
  let name = parts.join(h.pick(["/", "\\", "/", ""]));
  if (h.chance(0.25)) name = `/${name}`;
  if (h.chance(0.1)) name = `C:${name}`;
  return name;
}

test("property: the entry-name canonicalizer never yields an escaping or traversing name", () => {
  const h = harness();
  const root = path.resolve("/base/root");
  let refusals = 0;
  let accepts = 0;
  for (let n = 0; n < CASES; n += 1) {
    const name = hostileName(h);
    const result = canonicalRelPath(name);
    if (!result.ok) {
      refusals += 1;
      continue;
    }
    accepts += 1;
    const canon = result.name;
    const segments = canon.split("/");
    assert.ok(!canon.startsWith("/"), `#${n}: accepted an absolute name ${JSON.stringify(canon)}`);
    assert.ok(!/^[A-Za-z]:/.test(canon), `#${n}: accepted a drive-letter name ${JSON.stringify(canon)}`);
    assert.ok(!canon.startsWith("~"), `#${n}: accepted a home-relative name ${JSON.stringify(canon)}`);
    assert.ok(!canon.includes("\\"), `#${n}: accepted a backslash name ${JSON.stringify(canon)}`);
    assert.ok(canon.normalize("NFC") === canon, `#${n}: accepted a non-NFC name`);
    assert.ok(!/[\u0000-\u001F\u007F-\u009F]/.test(canon), `#${n}: accepted a control byte`);
    assert.ok(!segments.includes("..") && !segments.includes("."), `#${n}: accepted a traversal segment in ${JSON.stringify(canon)}`);
    // The clinching cross-check: joined under a root, an accepted name stays inside it.
    const joined = path.resolve(root, canon);
    assert.ok(insideRoot(root, joined), `#${n}: an accepted name escaped the root: ${JSON.stringify(canon)}`);
  }
  // The corpus is hostile by construction: it must exercise BOTH outcomes.
  assert.ok(refusals > 0, "no hostile name was refused — the corpus is not hostile");
  assert.ok(accepts > 0, "no name was accepted — the corpus proves nothing about the accept path");
});

// ── property 3: path containment ──────────────────────────────────────────────────────

test("property: insideRoot holds iff the resolved path is genuinely under the root", () => {
  const h = harness();
  const root = path.resolve("/base/root");
  const sep = path.sep;
  let inside = 0;
  let outside = 0;
  for (let n = 0; n < CASES; n += 1) {
    const segments = [];
    const depth = h.int(0, 6);
    for (let i = 0; i < depth; i += 1) segments.push(h.pick(["..", "sub", "leaf", "a", "b", "deep", ".."]));
    const resolved = path.resolve(root, ...segments);
    // Independent oracle: with no symlinks, the resolved path is the realpath, and it is
    // under the root exactly when it equals the root or sits beneath it as a string prefix.
    const oracle = resolved === root || resolved.startsWith(root + sep);
    assert.equal(insideRoot(root, resolved), oracle, `#${n}: insideRoot disagreed for ${JSON.stringify(toPosix(resolved))}`);
    if (oracle) inside += 1;
    else outside += 1;
  }
  assert.ok(inside > 0 && outside > 0, `the corpus did not exercise both sides (in ${inside}, out ${outside})`);
});

// ── property 4: redaction idempotence and no-survival ─────────────────────────────────

// Every shape here is a FAKE the detector is proven to catch (see redaction-corpus). None
// is a real credential; the generator only reshuffles their variable characters.
function fakeSecret(h) {
  const alnum = (len) => Array.from({ length: len }, () => h.pick([..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"])).join("");
  return h.pick([
    `sk-${alnum(40)}`,
    `xoxb-${h.int(1000000000, 9999999999)}-${h.int(1000000000, 9999999999)}-${alnum(24)}`,
    `ghp_${alnum(36)}`,
    `AKIA${Array.from({ length: 16 }, () => h.pick([..."ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"])).join("")}`,
    `AIza${alnum(35)}`,
    `${Buffer.from(alnum(36)).toString("base64")}`,
  ]);
}

function stableRefFor() {
  const refs = new Map();
  let n = 0;
  return (value) => {
    if (!refs.has(value)) refs.set(value, `s${(n += 1)}`);
    return refs.get(value);
  };
}

test("property: redact(redact(x)) == redact(x) and no seeded value survives one pass", () => {
  const h = harness();
  for (let n = 0; n < CASES; n += 1) {
    const seeded = [];
    const chunks = [];
    const count = h.int(1, 5);
    for (let i = 0; i < count; i += 1) {
      chunks.push(`filler_${h.word()} ${h.word()}`);
      const secret = fakeSecret(h);
      seeded.push(secret);
      chunks.push(h.chance(0.5) ? `token=${secret}` : `${secret}`);
    }
    chunks.push(`tail_${h.word()}`);
    const input = chunks.join(" ");

    const once = redactText(input, { generic: true, argv: true, refFor: stableRefFor() }).text;
    const twice = redactText(once, { generic: true, argv: true, refFor: stableRefFor() }).text;
    assert.equal(twice, once, `#${n}: redaction was not idempotent`);
    for (const secret of seeded) {
      assert.ok(!once.includes(secret), `#${n}: a seeded fake secret survived one pass`);
    }
  }
});

// ── property 5: digest stability ──────────────────────────────────────────────────────

function randomManifest(h, { mutateContent = false } = {}) {
  const count = h.int(1, 4);
  const items = [];
  for (let i = 0; i < count; i += 1) {
    items.push(
      item({
        item_id: `claude:user:setting:k_${h.word()}_${i}`,
        kind: "setting",
        surface_id: "claude.settings.user",
        identity: `k_${h.word()}_${i}`,
        identity_from: "key_path",
        key_path: `k_${h.word()}_${i}`,
        value: mutateContent && i === 0 ? `MUTATED_${h.word()}` : `v_${h.word()}`,
      }),
    );
  }
  return craft({ items });
}

test("property: the content digest ignores id/created_at and moves with any content change", () => {
  const h = harness();
  for (let n = 0; n < CASES; n += 1) {
    const bundle = randomManifest(h);
    const baseline = computeDigest(bundle.manifest, bundle.entries);
    assert.equal(bundle.manifest.bundle.digest, baseline, `#${n}: craft sealed a different digest`);

    // The envelope changes; the digest does not.
    const reEnveloped = JSON.parse(JSON.stringify(bundle.manifest));
    reEnveloped.bundle.id = `ocb_${h.word()}`;
    reEnveloped.bundle.created_at = new Date(h.int(0, 2 ** 31)).toISOString();
    assert.equal(
      computeDigest(reEnveloped, bundle.entries),
      baseline,
      `#${n}: the digest moved when only bundle.id/created_at changed`,
    );

    // Any change to item content moves the digest.
    const mutated = JSON.parse(JSON.stringify(bundle.manifest));
    mutated.items[0].payload.parsed.value = `${sha256(String(n))}`;
    assert.notEqual(
      computeDigest(mutated, bundle.entries),
      baseline,
      `#${n}: the digest ignored a change to item content`,
    );
  }
});
