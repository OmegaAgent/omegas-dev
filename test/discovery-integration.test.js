import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverTransfer, readFingerprintedText } from "../src/discovery.js";

test("maps Claude project memory without leaking absolute paths", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "CLAUDE.md"), "Project context\n");

    const encodedProject = (await realpath(project)).split(path.sep).join("-");
    const memory = path.join(home, ".claude", "projects", encodedProject, "memory");
    await mkdir(memory, { recursive: true });
    await writeFile(path.join(memory, "MEMORY.md"), "Project memory\n");

    const skill = path.join(home, ".claude", "skills", "review");
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, "SKILL.md"), "Review skill\n");

    const { manifest } = await discoverTransfer({ roots: [project], home, maxDepth: 1 });
    assert.equal(manifest.projects.length, 1);
    assert.ok(
      manifest.projects[0].context_files.some(
        (file) => file.path === "omega/.claude-memory/MEMORY.md" && file.kind === "memory",
      ),
    );
    assert.equal(manifest.global.skills.length, 1);
    assert.ok(!JSON.stringify(manifest).includes(temp));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("skips symlinked context and credential-shaped files", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    await mkdir(path.join(project, ".claude", "rules"), { recursive: true });
    const outside = path.join(temp, "outside.md");
    await writeFile(outside, "outside context\n");
    await symlink(outside, path.join(project, "CLAUDE.md"));
    await writeFile(
      path.join(project, ".claude", "rules", "private.md"),
      "API_TOKEN=actual-secret-value\n",
    );

    const { manifest, warnings } = await discoverTransfer({ roots: [project], home, maxDepth: 1 });
    assert.equal(manifest.projects.length, 1);
    assert.equal(manifest.projects[0].context_files.length, 0);
    assert.ok(warnings.some((warning) => warning.includes("credential material")));
    assert.ok(!JSON.stringify(manifest).includes("outside context"));
    assert.ok(!JSON.stringify(manifest).includes("actual-secret-value"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("aborts if a selected env file changes before upload", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "CLAUDE.md"), "Project context\n");
    const envPath = path.join(project, ".env.local");
    await writeFile(envPath, "TOKEN=first-value\n");
    const { envFiles } = await discoverTransfer({ roots: [project], home, maxDepth: 1 });
    assert.equal(envFiles.length, 1);
    await writeFile(envPath, "TOKEN=second-and-different-value\n");
    await assert.rejects(readFingerprintedText(envFiles[0]), /changed after selection/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("treats home config as global and ignores nested skill repository mirrors", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    const editorExtension = path.join(home, ".vscode", "extensions", "fake-extension");
    const agentWorkspace = path.join(home, ".openclaw", "workspace");
    const globalSkill = path.join(home, ".claude", "skills", "review");
    const globalMirror = path.join(
      home,
      ".claude",
      "skills",
      "gstack",
      ".agents",
      "skills",
      "internal-copy",
    );
    const projectSkill = path.join(project, ".claude", "skills", "team");
    const projectMirror = path.join(
      project,
      ".claude",
      "skills",
      "team",
      ".cursor",
      "skills",
      "internal-copy",
    );
    await Promise.all([
      mkdir(globalSkill, { recursive: true }),
      mkdir(globalMirror, { recursive: true }),
      mkdir(projectSkill, { recursive: true }),
      mkdir(projectMirror, { recursive: true }),
      mkdir(editorExtension, { recursive: true }),
      mkdir(agentWorkspace, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(project, "CLAUDE.md"), "Project context\n"),
      writeFile(path.join(globalSkill, "SKILL.md"), "Global review skill\n"),
      writeFile(path.join(globalMirror, "SKILL.md"), "Global internal mirror\n"),
      writeFile(path.join(projectSkill, "SKILL.md"), "Project team skill\n"),
      writeFile(path.join(projectMirror, "SKILL.md"), "Project internal mirror\n"),
      writeFile(path.join(editorExtension, "CLAUDE.md"), "Editor extension fixture\n"),
      writeFile(path.join(agentWorkspace, "AGENTS.md"), "Agent runtime fixture\n"),
    ]);

    const { manifest } = await discoverTransfer({ roots: [home], home, maxDepth: 3 });
    assert.equal(manifest.projects.length, 1);
    assert.equal(manifest.projects[0].name, "omega");
    assert.equal(manifest.global.skills.length, 1);
    assert.equal(manifest.projects[0].skills.length, 1);
    assert.ok(!JSON.stringify(manifest).includes("internal mirror"));
    assert.ok(!JSON.stringify(manifest).includes("Editor extension fixture"));
    assert.ok(!JSON.stringify(manifest).includes("Agent runtime fixture"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("reports exact MCP duplicates separately from conflicts without exposing secrets", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    await mkdir(path.join(project, ".codex"), { recursive: true });
    await writeFile(path.join(project, "AGENTS.md"), "Project context\n");
    await writeFile(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          docs: { url: "https://docs.example.test/mcp" },
          deploy: { command: "npx", args: ["deploy-server"], env: { DEPLOY_TOKEN: "global-secret" } },
        },
      }),
    );
    await writeFile(
      path.join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          docs: { url: "https://docs.example.test/mcp" },
          runner: { command: "npx", args: ["runner", "--mode", "safe"] },
        },
      }),
    );
    await writeFile(
      path.join(project, ".codex", "config.toml"),
      `[mcp_servers.runner]\ncommand = "npx"\nargs = ["runner", "--mode", "fast"]\n\n[mcp_servers.deploy]\ncommand = "npx"\nargs = ["deploy-server"]\n\n[mcp_servers.deploy.env]\nDEPLOY_TOKEN = "project-secret"\n`,
    );

    const { manifest } = await discoverTransfer({ roots: [project], home, maxDepth: 1 });

    assert.deepEqual(manifest.mcp_conflicts.exact_duplicates, [{
      identity: "docs",
      definitions: [
        { source: "claude", scope: "global", project: undefined, source_file: ".claude.json" },
        { source: "claude", scope: "project", project: "omega", source_file: "omega/.mcp.json" },
      ],
    }]);
    assert.deepEqual(
      manifest.mcp_conflicts.conflicts.map((item) => item.identity).sort(),
      ["deploy", "runner"],
    );
    assert.ok(manifest.mcp_conflicts.conflicts.every((item) => item.definitions.every((definition) => definition.scope)));
    assert.ok(!JSON.stringify(manifest).includes("global-secret"));
    assert.ok(!JSON.stringify(manifest).includes("project-secret"));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
