import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  ensurePreviewDirectory,
  help,
  offerPreviewDeletion,
  previewDirectory,
  previewFilename,
  writePreview,
} from "../src/cli.js";

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const MANIFEST = { schema_version: "omegas.local-transfer.v1", global: {}, projects: [] };

function answering(answer, asked = []) {
  return {
    asked,
    question: async (prompt) => {
      asked.push(prompt);
      return answer;
    },
  };
}

async function quietly(action) {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = () => true;
  try {
    return await action();
  } finally {
    process.stdout.write = write;
  }
}

test("the default preview lands in the state directory, not in Downloads", async () => {
  const home = "/fixture/home";
  const filename = previewFilename(home, new Date("2026-07-30T12:34:56.000Z"));
  assert.equal(path.dirname(filename), path.join(home, ".omegas", "state", "previews"));
  assert.equal(path.basename(filename), "omegas-transfer-preview-2026-07-30T12-34-56-000Z.json");
  assert.ok(!filename.includes("Downloads"));
});

test("the preview directory is created owner-only at every level", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const directory = await ensurePreviewDirectory(home);
    assert.equal(directory, previewDirectory(home));
    for (const level of [[".omegas"], [".omegas", "state"], [".omegas", "state", "previews"]]) {
      const info = await stat(path.join(home, ...level));
      assert.equal(info.mode & 0o777, 0o700, `${level.join("/")} is not 0700`);
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("the preview file is written once, owner-only, without secret values", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    await ensurePreviewDirectory(home);
    const filename = previewFilename(home);
    await writePreview(filename, MANIFEST, [
      {
        project_key: "omega-0000",
        source_label: "omega/.env.local",
        environment: "local",
        entries: { API_TOKEN: "sk-proj-FAKE0000FAKE0000FAKE0000" },
      },
    ]);

    const info = await stat(filename);
    assert.equal(info.mode & 0o777, 0o600);
    const preview = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(preview.secret_files[0].variable_count, 1);
    assert.ok(!JSON.stringify(preview).includes("API_TOKEN"));
    assert.ok(!JSON.stringify(preview).includes("FAKE0000"));
    // An existing preview is never overwritten in place.
    await assert.rejects(writePreview(filename, MANIFEST, []), /EEXIST/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("the end-of-run prompt keeps the preview unless deletion is confirmed", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    await ensurePreviewDirectory(home);
    const kept = previewFilename(home, new Date("2026-07-30T00:00:00.000Z"));
    await writePreview(kept, MANIFEST, []);

    const empty = answering("");
    assert.equal(await quietly(() => offerPreviewDeletion(empty, kept, true)), false);
    assert.equal(empty.asked.length, 1);
    assert.ok(empty.asked[0].includes("[y/N]"), "deletion must default to keeping the file");
    assert.ok((await stat(kept)).isFile());

    const deleted = previewFilename(home, new Date("2026-07-30T00:00:01.000Z"));
    await writePreview(deleted, MANIFEST, []);
    assert.equal(await quietly(() => offerPreviewDeletion(answering("y"), deleted, true)), true);
    await assert.rejects(stat(deleted), /ENOENT/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("a non-interactive run is never prompted and keeps the preview", async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    await ensurePreviewDirectory(home);
    const filename = previewFilename(home);
    await writePreview(filename, MANIFEST, []);

    const rl = answering("y");
    assert.equal(await offerPreviewDeletion(rl, filename, false), false);
    assert.deepEqual(rl.asked, []);
    assert.ok((await stat(filename)).isFile());
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("help documents every flag the parser accepts, and the README matches", async () => {
  const source = await readFile(path.join(repoRoot, "src", "cli.js"), "utf8");
  const accepted = [...source.matchAll(/arg === "(--[a-z-]+)"/g)].map((match) => match[1]);
  assert.ok(accepted.includes("--help"), "the parser should accept --help");

  const text = help();
  for (const flag of new Set(accepted)) {
    assert.ok(text.includes(flag), `--help does not document ${flag}`);
  }

  const readme = await readFile(path.join(repoRoot, "README.md"), "utf8");
  for (const flag of new Set(accepted)) {
    assert.ok(readme.includes(flag), `README does not document ${flag}`);
  }
  assert.ok(readme.includes(".omegas/state/previews"), "README still points at the old location");
});

test("the CLI prints help and exits cleanly", async () => {
  const { stdout } = await run(process.execPath, [path.join(repoRoot, "bin", "omegas-dev.js"), "--help"]);
  assert.ok(stdout.startsWith("Usage: npx @omegas/continuity"));
  assert.ok(stdout.includes("--help, -h"));
});

test("top-level --help discloses the Continuity subcommands alongside the hosted flow", async () => {
  const { stdout } = await run(process.execPath, [path.join(repoRoot, "bin", "omegas-dev.js"), "--help"]);
  for (const command of ["scan", "report", "compat", "export", "diff", "import", "enable"]) {
    assert.ok(stdout.includes(command), `top-level --help never mentions the ${command} subcommand`);
  }
  // Both worlds are named, so a reader can tell the local commands from the hosted transfer.
  assert.match(stdout, /Continuity/, "the local commands are not identified as Continuity");
  assert.match(stdout, /Hosted transfer/, "the hosted transfer flow is no longer labelled");
});

// os.homedir() follows $HOME on POSIX only, and this test must never see a real home.
test("a dry run writes the preview into the fixture home and reports what it refused", { skip: process.platform === "win32" }, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-dev-"));
  try {
    const home = path.join(temp, "home");
    const project = path.join(home, "Code", "omega");
    await mkdir(path.join(project, ".claude", "rules"), { recursive: true });
    await writeFile(path.join(project, "CLAUDE.md"), "Project context\n");
    await writeFile(path.join(project, ".claude", "rules", "big.md"), `# Big\n${"a".repeat(300 * 1024)}\n`);
    // The connection-string leak reproduced end to end in research/cli-inventory.md §5.2.
    await writeFile(
      path.join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: { pg: { command: "uvx", args: ["mcp-postgres", "postgresql://user:pw-must-not-leak@db.host/app"] } },
      }),
    );

    const { stdout } = await run(
      process.execPath,
      [path.join(repoRoot, "bin", "omegas-dev.js"), "--dry-run", "--root", project],
      { env: { ...process.env, HOME: home } },
    );

    const previews = await readdir(previewDirectory(home));
    assert.equal(previews.length, 1, "the preview belongs in the state directory");
    const preview = await readFile(path.join(previewDirectory(home), previews[0]), "utf8");
    assert.ok(!preview.includes("pw-must-not-leak"), "the DSN password reached the preview");
    assert.ok(preview.includes("postgresql://db.host/app"), "the endpoint should survive redaction");
    assert.ok(stdout.includes("Warning: skipped (over 256 KB): omega/.claude/rules/big.md"));
    assert.ok(!stdout.includes("Delete the local preview"), "a non-interactive run must not prompt");
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
