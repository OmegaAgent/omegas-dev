import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverTransfer } from "../src/discovery.js";

const OVERSIZED_BYTES = 300 * 1024;

test("warns instead of silently dropping an oversized file", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    await mkdir(path.join(project, ".claude", "rules"), { recursive: true });
    await writeFile(path.join(project, "CLAUDE.md"), "Project context\n");
    await writeFile(
      path.join(project, ".claude", "rules", "big.md"),
      `# Big rule\n${"a".repeat(OVERSIZED_BYTES)}\n`,
    );
    await writeFile(path.join(project, ".claude", "rules", "small.md"), "# Small rule\n");

    const { manifest, warnings } = await discoverTransfer({ roots: [project], home, maxDepth: 1 });
    const paths = manifest.projects[0].context_files.map((file) => file.path);
    assert.ok(paths.includes("omega/.claude/rules/small.md"));
    assert.ok(!paths.includes("omega/.claude/rules/big.md"));
    assert.ok(
      warnings.includes("skipped (over 256 KB): omega/.claude/rules/big.md"),
      `no size warning in ${JSON.stringify(warnings)}`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("warns for every refused symlink, with a scope-relative label", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    const outside = path.join(temp, "outside");
    await mkdir(path.join(outside, "shared-skill"), { recursive: true });
    await mkdir(path.join(project, ".claude", "skills"), { recursive: true });
    await mkdir(path.join(home, ".codex", "skills"), { recursive: true });
    await writeFile(path.join(outside, "shared-skill", "SKILL.md"), "Shared skill\n");
    await writeFile(path.join(outside, "context.md"), "Outside context\n");
    await writeFile(path.join(outside, "secrets.env"), "TOKEN=first-value\n");

    // The real-world shape: an agent's skills directory that is entirely symlinks into another
    // agent's directory, plus a linked instructions file and a linked .env.
    await symlink(path.join(outside, "context.md"), path.join(project, "CLAUDE.md"));
    await symlink(path.join(outside, "shared-skill"), path.join(project, ".claude", "skills", "linked-skill"));
    await symlink(path.join(outside, "shared-skill"), path.join(home, ".codex", "skills", "review"));
    await symlink(path.join(outside, "secrets.env"), path.join(project, ".env.local"));

    const { manifest, envFiles, warnings } = await discoverTransfer({
      roots: [project],
      home,
      maxDepth: 1,
    });

    assert.equal(manifest.projects[0].context_files.length, 0);
    assert.equal(manifest.projects[0].skills.length, 0);
    assert.equal(manifest.global.skills.length, 0);
    assert.equal(envFiles.length, 0);
    for (const expected of [
      "skipped (symlink): omega/CLAUDE.md",
      "skipped (symlink): omega/.claude/skills/linked-skill",
      "skipped (symlink): omega/.env.local",
      "skipped (symlink): global/.codex/skills/review",
    ]) {
      assert.ok(warnings.includes(expected), `missing warning: ${expected}\ngot ${JSON.stringify(warnings)}`);
    }
    assert.ok(!JSON.stringify(warnings).includes(temp), "a warning leaked an absolute path");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("warns for a symlinked directory that would otherwise have been scanned for projects", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    const elsewhere = path.join(temp, "elsewhere", "linked-project");
    await mkdir(project, { recursive: true });
    await mkdir(elsewhere, { recursive: true });
    await writeFile(path.join(project, "CLAUDE.md"), "Project context\n");
    await writeFile(path.join(elsewhere, "CLAUDE.md"), "Linked project context\n");
    await symlink(path.join(temp, "elsewhere"), path.join(home, "Linked"));

    const { manifest, warnings } = await discoverTransfer({ roots: [home], home, maxDepth: 3 });
    assert.equal(manifest.projects.length, 1);
    assert.ok(!JSON.stringify(manifest).includes("Linked project context"));
    assert.ok(
      warnings.some((warning) => warning.startsWith("skipped (symlink): ") && warning.endsWith("/Linked")),
      `no project-root symlink warning in ${JSON.stringify(warnings)}`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("stays quiet about symlinks it would never have imported", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    await mkdir(path.join(project, ".claude", "rules"), { recursive: true });
    await writeFile(path.join(project, "CLAUDE.md"), "Project context\n");
    await writeFile(path.join(temp, "diagram.png"), "not really a png\n");
    await symlink(path.join(temp, "diagram.png"), path.join(project, ".claude", "rules", "diagram.png"));

    const { warnings } = await discoverTransfer({ roots: [project], home, maxDepth: 1 });
    assert.deepEqual(warnings, []);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
