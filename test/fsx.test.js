// The filesystem layer in isolation: token expansion, containment, glob and key-path
// matching, the three-outcome symlink policy, the guarded read, and entry-name
// canonicalization.

import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fingerprintFile, readFingerprinted, sameFingerprint } from "../src/core/fsx/fingerprint.js";
import { OUTCOME, classifyLink } from "../src/core/fsx/links.js";
import {
  canonicalEntryName,
  captureKeyPattern,
  displayPath,
  expandTemplate,
  globCaptures,
  globMatch,
  insideRoot,
  matchesPrefix,
  tokenize,
} from "../src/core/fsx/paths.js";
import { safeReadText } from "../src/core/fsx/safe-read.js";
import { collectLocation, expandGlobPath } from "../src/core/fsx/walk.js";
import { CAPS, IGNORED_DIRS } from "../src/core/policy/caps.js";

async function temp() {
  const root = await mkdtemp(path.join(os.tmpdir(), "omegas-fsx-"));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("template expansion handles defaults, nesting and per-platform roots", () => {
  const vars = { HOME: "/h", "root:managed": "/Library/X" };
  assert.equal(expandTemplate("${HOME}/.config", vars), "/h/.config");
  assert.equal(expandTemplate("${MISSING:-${HOME}/fallback}", vars), "/h/fallback");
  assert.equal(expandTemplate("${MISSING:-${HOME}/fallback}", { ...vars, MISSING: "/set" }), "/set");
  assert.equal(expandTemplate("${root:managed}/CLAUDE.md", vars), "/Library/X/CLAUDE.md");
  // An unresolvable reference is left verbatim so the caller can skip the location
  // rather than silently expanding to a wrong path.
  assert.equal(expandTemplate("${PROJECT}/x", vars), "${PROJECT}/x");
});

test("tokenization prefers the most specific token and never emits a machine path", () => {
  const env = { tokens: { HOME: "/h", CLAUDE_HOME: "/h/.claude" }, projects: [{ path: "/h/code/app" }] };
  assert.equal(tokenize("/h/.claude/settings.json", env), "${CLAUDE_HOME}/settings.json");
  assert.equal(tokenize("/h/.claude.json", env), "${HOME}/.claude.json");
  assert.equal(tokenize("/h/code/app/CLAUDE.md", env), "${PROJECT}/CLAUDE.md");
  assert.equal(displayPath("/h/code/app", "/h"), "~/code/app");
  assert.equal(displayPath("/h", "/h"), "~");
});

test("containment refuses a sibling that shares a name prefix", () => {
  assert.equal(insideRoot("/h/.claude", "/h/.claude/skills/a"), true);
  assert.equal(insideRoot("/h/.claude", "/h/.claude"), true);
  assert.equal(insideRoot("/h/.claude", "/h/.claude-evil/x"), false);
  assert.equal(insideRoot("/h/.claude", "/h/other"), false);
  assert.equal(insideRoot("/h/.claude", "/h/.claude/../other"), false);
});

test("globs cover segments, depth, alternation and captures", () => {
  assert.equal(globMatch("/h/**/*.md", "/h/a/b/c.md"), true);
  assert.equal(globMatch("/h/*/x", "/h/a/b/x"), false);
  assert.equal(globMatch("/h/{sessions,archived}/**", "/h/archived/a/b.json"), true);
  assert.deepEqual(globCaptures("/h/cache/*/*/*/skills", "/h/cache/mk/own/plug/skills"), ["mk", "own", "plug"]);
  assert.equal(globCaptures("/h/cache/*/skills", "/h/other"), null);
});

test("key-path patterns capture wildcards in order and distinguish indices", () => {
  assert.deepEqual(captureKeyPattern("hooks.*[*].hooks[*]", "hooks.Stop[0].hooks[1]"), ["Stop", "0", "1"]);
  assert.deepEqual(captureKeyPattern("projects.*.mcpServers.*", "projects./a/b.mcpServers.slack"), ["/a/b", "slack"]);
  assert.equal(captureKeyPattern("permissions.*[*]", "permissions.allow"), null);
  assert.deepEqual(captureKeyPattern("permissions.*[*]", "permissions.allow[3]"), ["allow", "3"]);
  // `$` is the whole item: a deep-scan marker, never an unconditional match.
  assert.deepEqual(captureKeyPattern("$", "anything.at.all"), []);
  assert.equal(matchesPrefix("hooks.**", "hooks.Stop[0].hooks[1].command"), true);
  assert.equal(matchesPrefix("hooks.**", "permissions.allow[0]"), false);
});

test("entry names are refused, never repaired", () => {
  const cases = [
    ["../escape", "empty, dot or parent segment"],
    ["/absolute", "absolute or home-relative entry name"],
    ["~/home", "absolute or home-relative entry name"],
    ["blobs\\win", "backslash separator"],
    ["items/CON", "reserved Windows basename or trailing dot/space"],
    ["elsewhere/x", "entry name outside the fixed prefix set"],
  ];
  for (const [name, reason] of cases) {
    const result = canonicalEntryName(name, new Map());
    assert.equal(result.ok, false, `${name} should be refused`);
    assert.match(result.reason, new RegExp(reason.replace(/[()]/g, "\\$&")));
  }
  assert.equal(canonicalEntryName("blobs/ab/abcd", new Map()).ok, true);

  const seen = new Map();
  assert.equal(canonicalEntryName("blobs/AB/File", seen).ok, true);
  const collision = canonicalEntryName("blobs/ab/file", seen);
  assert.equal(collision.ok, false);
  assert.match(collision.reason, /case-fold collision/);
});

test("safeReadText truncates over-cap files and reports it, never returning silence", async () => {
  const { root, cleanup } = await temp();
  try {
    const file = path.join(root, "big.md");
    await writeFile(file, "x".repeat(1000));
    const result = await safeReadText(file, [root], 100);
    assert.equal(result.ok, true);
    assert.equal(result.truncated, true);
    assert.equal(result.read_bytes, 100);
    assert.equal(result.bytes, 1000);
    assert.equal(result.text.length, 100);
  } finally {
    await cleanup();
  }
});

test("safeReadText refuses a symlink, a binary file and a target outside the root", async () => {
  const { root, cleanup } = await temp();
  try {
    const inside = path.join(root, "inside");
    const outside = path.join(root, "outside");
    await mkdir(inside, { recursive: true });
    await mkdir(outside, { recursive: true });

    const target = path.join(outside, "secret.md");
    await writeFile(target, "secret\n");
    const link = path.join(inside, "link.md");
    await symlink(target, link);
    assert.equal((await safeReadText(link, [inside], 1024)).reason, "symlink");

    const binary = path.join(inside, "binary.bin");
    await writeFile(binary, Buffer.from([0x41, 0x00, 0x42]));
    assert.equal((await safeReadText(binary, [inside], 1024)).reason, "binary content (NUL byte)");

    await writeFile(path.join(outside, "plain.md"), "plain\n");
    const escaped = await safeReadText(path.join(outside, "plain.md"), [inside], 1024);
    assert.equal(escaped.reason, "realpath outside every declared root");

    assert.equal((await safeReadText(path.join(inside, "nope.md"), [inside], 1024)).reason, "missing");
  } finally {
    await cleanup();
  }
});

test("the symlink policy has three outcomes, and a cycle is refused rather than followed", async () => {
  const { root, cleanup } = await temp();
  try {
    const ownRoot = path.join(root, "own");
    const otherRoot = path.join(root, "other");
    const elsewhere = path.join(root, "elsewhere");
    for (const directory of [ownRoot, otherRoot, elsewhere]) await mkdir(directory, { recursive: true });
    await writeFile(path.join(ownRoot, "real.md"), "real\n");
    await writeFile(path.join(otherRoot, "shared.md"), "shared\n");
    await writeFile(path.join(elsewhere, "away.md"), "away\n");

    await symlink(path.join(ownRoot, "real.md"), path.join(ownRoot, "internal.md"));
    await symlink(path.join(otherRoot, "shared.md"), path.join(ownRoot, "crossing.md"));
    await symlink(path.join(elsewhere, "away.md"), path.join(ownRoot, "escaping.md"));

    const roots = [ownRoot];
    const known = [ownRoot, otherRoot];
    assert.equal((await classifyLink(path.join(ownRoot, "internal.md"), roots, known)).outcome, OUTCOME.INTERNAL);

    const crossing = await classifyLink(path.join(ownRoot, "crossing.md"), roots, known);
    assert.equal(crossing.outcome, OUTCOME.CROSSING);
    assert.equal(crossing.to_root, otherRoot);

    const escaping = await classifyLink(path.join(ownRoot, "escaping.md"), roots, known);
    assert.equal(escaping.outcome, OUTCOME.UNRESOLVED);
    assert.equal(escaping.refusal, "target outside every declared root");

    await symlink(path.join(ownRoot, "b.md"), path.join(ownRoot, "a.md"));
    await symlink(path.join(ownRoot, "a.md"), path.join(ownRoot, "b.md"));
    const cycle = await classifyLink(path.join(ownRoot, "a.md"), roots, known);
    assert.equal(cycle.outcome, OUTCOME.UNRESOLVED);
    assert.match(cycle.refusal, /cycle|does not resolve/);
  } finally {
    await cleanup();
  }
});

test("a fingerprint detects drift between selection and read", async () => {
  const { root, cleanup } = await temp();
  try {
    const file = path.join(root, "settings.json");
    await writeFile(file, "{}\n");
    const first = await fingerprintFile(file, [root]);
    assert.ok(first);
    assert.equal(sameFingerprint(first, await fingerprintFile(file, [root])), true);

    const read = await readFingerprinted({ filename: file, roots: [root], fingerprint: first, maxBytes: 1024 });
    assert.equal(read.text, "{}\n");

    await new Promise((resolve) => setTimeout(resolve, 12));
    await writeFile(file, "{ \"changed\": true }\n");
    assert.equal(sameFingerprint(first, await fingerprintFile(file, [root])), false);
    await assert.rejects(
      readFingerprinted({ filename: file, roots: [root], fingerprint: first, maxBytes: 1024, label: "settings" }),
      /changed since it was selected/,
    );
  } finally {
    await cleanup();
  }
});

test("the walker honours `order`, `dir_of` and its depth cap", async () => {
  const { root, cleanup } = await temp();
  try {
    await mkdir(path.join(root, "skills", "alpha"), { recursive: true });
    await mkdir(path.join(root, "skills", "beta", "nested", "deep"), { recursive: true });
    await writeFile(path.join(root, "skills", "alpha", "SKILL.md"), "alpha\n");
    await writeFile(path.join(root, "skills", "beta", "SKILL.md"), "beta\n");
    await writeFile(path.join(root, "AGENTS.override.md"), "override\n");
    await writeFile(path.join(root, "AGENTS.md"), "base\n");

    const context = { roots: [root], knownRoots: [root], caps: CAPS, ignoredDirs: IGNORED_DIRS };

    const dirOf = await collectLocation({
      ...context,
      base: path.join(root, "skills"),
      location: { match: "dir_of", glob: "*/SKILL.md", scope: "user" },
    });
    assert.deepEqual(
      dirOf.map((node) => node.captures.dirname).sort(),
      ["alpha", "beta"],
      "identity comes from the directory, and a nested directory is not a second skill",
    );

    const ordered = await collectLocation({
      ...context,
      base: root,
      location: { match: "file", order: ["AGENTS.override.md", "AGENTS.md"], scope: "user" },
    });
    assert.deepEqual(ordered.map((node) => node.order_index), [0, 1], "both files are found, in declared order");
  } finally {
    await cleanup();
  }
});

test("a glob inside a source path expands to the files that exist today", async () => {
  const { root, cleanup } = await temp();
  try {
    await mkdir(path.join(root, "cache", "mk", "own", "plug", "hooks"), { recursive: true });
    await writeFile(path.join(root, "cache", "mk", "own", "plug", "hooks", "hooks.json"), "{}\n");
    const found = await expandGlobPath(path.join(root, "cache", "*", "*", "*", "hooks", "hooks.json"), {
      caps: CAPS,
      ignoredDirs: IGNORED_DIRS,
    });
    assert.equal(found.length, 1);
    assert.ok(found[0].endsWith("plug/hooks/hooks.json"));

    const missing = await expandGlobPath(path.join(root, "cache", "*", "nope.json"), {
      caps: CAPS,
      ignoredDirs: IGNORED_DIRS,
    });
    assert.deepEqual(missing, []);
  } finally {
    await cleanup();
  }
});

test("an exec-bit file is reported as executable so trust can escalate", async () => {
  const { root, cleanup } = await temp();
  try {
    const file = path.join(root, "script.sh");
    await writeFile(file, "#!/bin/sh\nexit 0\n");
    await chmod(file, 0o755);
    const result = await safeReadText(file, [root], 1024);
    assert.equal(result.exec_bit, true);
  } finally {
    await cleanup();
  }
});
