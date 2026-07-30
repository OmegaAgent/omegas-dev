// What ships is part of the trust story. A package that quietly grows a dependency, a
// fixture home, or an internal document naming un-rotated credentials is a different
// package from the one that was reviewed.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function packedFiles() {
  const { stdout } = await run("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout)[0].files.map((entry) => entry.path);
}

test("the package ships source and documentation, and nothing else", async () => {
  const files = await packedFiles();
  for (const required of ["package.json", "README.md", "SECURITY.md", "LICENSE", "bin/omegas-dev.js"]) {
    assert.ok(files.includes(required), `${required} is missing from the package`);
  }
  const allowed = /^(bin\/|src\/|docs\/[A-Z_]+\.md$|README\.md$|SECURITY\.md$|LICENSE$|package\.json$)/;
  const unexpected = files.filter((entry) => !allowed.test(entry));
  assert.deepEqual(unexpected, [], "these paths would publish and were not expected to");
});

test("no test, fixture or scratch file can be published", async () => {
  const files = await packedFiles();
  const forbidden = files.filter(
    (entry) => /^test\//.test(entry) || /fixture/i.test(entry) || /\.test\.js$/.test(entry) || /\.ocb\.jsonl$/.test(entry),
  );
  assert.deepEqual(forbidden, []);
});

test("the release checklist stays out of the tarball: it names un-rotated credential locations", async () => {
  const files = await packedFiles();
  assert.equal(files.includes("docs/RELEASE_CHECKLIST.md"), false);
});

test("the independent verification report is a repo-only artifact, not shipped", async () => {
  const files = await packedFiles();
  assert.equal(files.includes("docs/VERIFICATION.md"), false);
});

test("the release checklist puts the credential rotation first, and prints no value", async () => {
  const text = await readFile(path.join(repoRoot, "docs", "RELEASE_CHECKLIST.md"), "utf8");
  const firstItem = text.slice(text.indexOf("## 0."), text.indexOf("## 1."));
  assert.match(firstItem, /BLOCKING/);
  assert.match(firstItem, /rotate/i);
  assert.match(firstItem, /settings\.local\.json/);
  assert.match(firstItem, /default\.rules/);
  assert.match(text, /Do not publish until the founder approves/);

  // Identified by location only. A checklist that quotes the value it is asking you to
  // rotate has published the value.
  for (const shape of [/sk-[A-Za-z0-9_-]{16,}/, /gsk_[A-Za-z0-9]{16,}/, /xox[abeoprs]-/, /ghp_[A-Za-z0-9]{16,}/]) {
    assert.equal(shape.test(text), false, `the checklist appears to contain a credential-shaped string: ${shape}`);
  }
});

test("the version, the changelog heading and the export generator all agree", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const changelog = await readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const exporter = await readFile(path.join(repoRoot, "src", "cli", "export.js"), "utf8");

  assert.match(changelog, new RegExp(`^## ${manifest.version.replace(/\./g, "\\.")}$`, "m"));
  assert.equal(changelog.includes("## Unreleased"), false, "an unreleased section means the version was not cut");
  assert.match(exporter, new RegExp(`GENERATOR_VERSION = "${manifest.version.replace(/\./g, "\\.")}"`));
});

test("every named gate exists as a script and points at test files that exist", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  const present = new Set(await readdir(path.join(repoRoot, "test")));
  const gates = Object.entries(manifest.scripts).filter(([name]) => name.startsWith("gate:"));

  for (const required of ["gate:purity", "gate:secrets", "gate:network", "gate:adversarial", "gate:noop"]) {
    assert.ok(manifest.scripts[required], `${required} is not a script`);
  }
  for (const [name, command] of gates) {
    const targets = command.split(/\s+/).filter((token) => token.endsWith(".test.js"));
    assert.ok(targets.length > 0, `${name} runs no test file`);
    for (const target of targets) {
      assert.ok(present.has(path.basename(target)), `${name} points at a missing file: ${target}`);
    }
  }
  // The aggregate has to actually run all of them, or "npm run gates was green" is a
  // weaker statement than it sounds.
  for (const [name] of gates) {
    assert.ok(manifest.scripts.gates.includes(name), `npm run gates skips ${name}`);
  }
});

test("the CI workflow runs every gate on every supported Node version", async () => {
  const workflow = await readFile(path.join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  for (const name of Object.keys(manifest.scripts).filter((script) => script.startsWith("gate:"))) {
    assert.ok(workflow.includes(`npm run ${name}`), `CI does not run ${name}`);
  }
  assert.match(workflow, /node: \[20, 22, 24\]/);
  assert.match(workflow, /npm ls --prod/);
});

test("zero production dependencies, still", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});

test("the docs that ship cross-link to each other and none of the links dangle", async () => {
  const docsDir = path.join(repoRoot, "docs");
  const names = (await readdir(docsDir)).filter((entry) => entry.endsWith(".md"));
  assert.deepEqual(names.sort(), [
    "ARCHITECTURE.md",
    "BUNDLE_FORMAT.md",
    "CUTOVER.md",
    "IMPORT_MODEL.md",
    "RELEASE_CHECKLIST.md",
    "VERIFICATION.md",
  ]);

  for (const name of names) {
    const text = await readFile(path.join(docsDir, name), "utf8");
    for (const [, target] of text.matchAll(/\]\(([A-Z_]+\.md)\)/g)) {
      assert.ok(names.includes(target), `${name} links to ${target}, which does not exist`);
    }
    assert.ok(
      [...text.matchAll(/\]\(([A-Z_]+\.md)\)/g)].length > 0 || name === "RELEASE_CHECKLIST.md",
      `${name} links to no sibling document`,
    );
  }

  // The open/closed boundary is stated where an implementer will look for it.
  const architecture = await readFile(path.join(docsDir, "ARCHITECTURE.md"), "utf8");
  assert.match(architecture, /open\/closed boundary/i);
  assert.match(architecture, /exactly two things/);
  assert.match(architecture, /bundle format/i);
  assert.match(architecture, /exit codes/i);
});

test("the README states what the tool does not do yet", async () => {
  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  assert.match(readme, /## What this does NOT do yet/);
  assert.match(readme, /Cross-runtime transfer is preview only/);
  assert.match(readme, /No Hermes support/);
  assert.match(readme, /Transcripts, chat history and session state are out of scope/);
});

test("the changelog's known-limits section survives into this release", async () => {
  const changelog = await readFile(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const current = changelog.slice(changelog.indexOf("## 0.2.0"), changelog.indexOf("## 0.1.5"));
  assert.match(current, /### Known limits/);
  assert.match(current, /high-entropy/i);
  assert.match(current, /preview and report only/i);
});
