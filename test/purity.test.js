// The architecture's teeth. Every rule the design doc states as a boundary is asserted
// here mechanically, because a boundary that is only a convention is a boundary that is
// gone in six months (adapter-architecture §1.1, §6).

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ADAPTERS, validateAdapters } from "../src/core/adapters/registry.js";

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CORE = path.join(repoRoot, "src", "core");

/**
 * Comment lines are dropped before the runtime-name check. The rule the design doc
 * states is about literals and branches in CODE — a comment that names Claude while
 * explaining why the code does NOT branch on it is the opposite of a violation.
 */
function codeOnly(source) {
  return source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");
}

function importSpecifiers(source) {
  return [...source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+"([^"]+)"/gm)].map((match) => match[1]);
}

async function jsFiles(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await jsFiles(full)));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

const NETWORK_IMPORTS = [
  "node:http",
  "node:https",
  "node:net",
  "node:dns",
  "node:tls",
  "node:dgram",
  "node:child_process",
  "node:worker_threads",
];

test("core/ never networks and never spawns", async () => {
  for (const file of await jsFiles(CORE)) {
    const source = codeOnly(await readFile(file, "utf8"));
    const label = path.relative(repoRoot, file);
    for (const module of NETWORK_IMPORTS) {
      assert.ok(!source.includes(`"${module}"`), `${label} imports ${module}`);
      assert.ok(!source.includes(`'${module}'`), `${label} imports ${module}`);
    }
    // A leading `.` means a method on something else — `RegExp.prototype.exec` is not
    // `child_process.exec`. The import assertions above are the real gate; these catch a
    // global that slipped in without one.
    assert.ok(!/(?<![.\w])fetch\s*\(/.test(source), `${label} calls fetch`);
    assert.ok(!/(?<![.\w])spawn(Sync)?\s*\(/.test(source), `${label} spawns a process`);
    assert.ok(!/(?<![.\w])exec(Sync|File)?\s*\(/.test(source), `${label} executes a command`);
  }
});

test("core/ never imports cli/ or hosted/", async () => {
  for (const file of await jsFiles(CORE)) {
    const source = await readFile(file, "utf8");
    const label = path.relative(repoRoot, file);
    for (const specifier of importSpecifiers(source)) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      assert.ok(
        resolved.startsWith(CORE),
        `${label} imports outside core/: ${specifier}`,
      );
    }
  }
});

test("engine/ is runtime-agnostic: no vendor name and no switch on a runtime id", async () => {
  for (const file of await jsFiles(path.join(CORE, "engine"))) {
    const source = await readFile(file, "utf8");
    const label = path.relative(repoRoot, file);
    const hits = [...codeOnly(source).matchAll(/claude|codex|hermes/gi)].map((match) => match[0]);
    assert.deepEqual(hits, [], `${label} contains runtime-name literal(s): ${hits.join(", ")}`);
    assert.ok(!/switch\s*\(\s*\w*\.?(id|runtime)\s*\)/.test(source), `${label} switches on a runtime id`);
  }
});

test("fsx/, formats/, model/, policy/, redact/ and bundle/ are runtime-agnostic too", async () => {
  for (const directory of ["fsx", "formats", "model", "policy", "redact", "bundle"]) {
    for (const file of await jsFiles(path.join(CORE, directory))) {
      const source = await readFile(file, "utf8");
      const label = path.relative(repoRoot, file);
      const hits = [...codeOnly(source).matchAll(/claude|codex|hermes/gi)].map((match) => match[0]);
      assert.deepEqual(hits, [], `${label} contains runtime-name literal(s): ${hits.join(", ")}`);
    }
  }
});

test("adapters/ import nothing but model/kinds.js", async () => {
  for (const file of await jsFiles(path.join(CORE, "adapters"))) {
    if (path.basename(file) === "registry.js") continue;
    const source = await readFile(file, "utf8");
    const label = path.relative(repoRoot, file);
    for (const specifier of importSpecifiers(source)) {
      assert.equal(specifier, "../model/kinds.js", `${label} imports ${specifier}`);
    }
    assert.equal(
      (source.match(/export default/g) ?? []).length,
      1,
      `${label} must have exactly one default export`,
    );
  }
});

test("adapters are inert data: zero function values at any depth", () => {
  const seen = new Set();
  const walk = (node, at) => {
    if (typeof node === "function") assert.fail(`function value at ${at}`);
    if (node === null || typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);
    for (const [key, value] of Object.entries(node)) walk(value, `${at}.${key}`);
  };
  for (const adapter of ADAPTERS) walk(adapter, adapter.id);
});

test("the registry's own invariants hold for every shipped adapter", () => {
  assert.deepEqual(validateAdapters(), []);
});

test("every declared surface carries a non-empty evidence citation", () => {
  for (const adapter of ADAPTERS) {
    for (const surface of adapter.surfaces) {
      assert.ok(
        typeof surface.evidence === "string" && surface.evidence.trim().length > 0,
        `${adapter.id}/${surface.surface_id} has no evidence`,
      );
    }
  }
});

test("a declared-only adapter declares zero surfaces and says why", () => {
  for (const adapter of ADAPTERS.filter((candidate) => candidate.status === "declared")) {
    assert.equal(adapter.surfaces.length, 0, `${adapter.id} claims surfaces while only "declared"`);
    assert.ok(adapter.detect?.reason?.length > 0, `${adapter.id} does not say why it is undetected`);
  }
});

test("spike-corrections §2/§3: `$` is a deep-scan position, never an unconditional secret position", () => {
  for (const adapter of ADAPTERS) {
    for (const surface of adapter.surfaces) {
      assert.ok(
        !(surface.secret_positions ?? []).includes("$"),
        `${surface.surface_id} would positionally redact every leaf`,
      );
      if (surface.kind === "hook") {
        assert.ok(
          !(surface.secret_positions ?? []).includes("command"),
          `${surface.surface_id} would redact the hook command, which is the portable content`,
        );
      }
    }
  }
});

test("a position is either a secret position or an argv position, never both", () => {
  // The two treatments contradict each other: one erases the value, the other keeps the
  // command and redacts the credential-bearing token inside it. A key listed twice gets
  // erased, which is how a hook command or an `apiKeyHelper` silently stops working.
  for (const adapter of ADAPTERS) {
    for (const surface of adapter.surfaces) {
      const argv = new Set(surface.argv_positions ?? []);
      for (const position of surface.secret_positions ?? []) {
        assert.ok(!argv.has(position), `${surface.surface_id}: "${position}" is both a secret and an argv position`);
      }
    }
  }
});

test("lint predicates use only the closed operator set", async () => {
  const { LINT_OPERATORS } = await import("../src/core/engine/lint.js");
  const walk = (predicate, label) => {
    assert.ok(LINT_OPERATORS.includes(predicate.op), `${label} uses unknown operator "${predicate.op}"`);
    for (const inner of predicate.rules ?? []) walk(inner, label);
    if (predicate.rule) walk(predicate.rule, label);
  };
  for (const adapter of ADAPTERS) {
    for (const rule of adapter.lints ?? []) walk(rule.predicate, `${adapter.id}/${rule.lint_id}`);
  }
});

test("package.json declares zero production dependencies", async () => {
  const manifest = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(manifest.dependencies, undefined);
  assert.equal(manifest.peerDependencies, undefined);
  assert.equal(manifest.optionalDependencies, undefined);
});

test("the source tree contains no raw control characters", async () => {
  const roots = ["src", "bin", "test"].map((entry) => path.join(repoRoot, entry));
  for (const root of roots) {
    for (const file of await jsFiles(root)) {
      const source = await readFile(file, "utf8");
      for (let index = 0; index < source.length; index += 1) {
        const code = source.charCodeAt(index);
        const control = (code < 32 && code !== 9 && code !== 10) || code === 127 || (code >= 128 && code <= 159);
        assert.ok(!control, `${path.relative(repoRoot, file)} contains a raw control character at ${index}`);
      }
    }
  }
});
