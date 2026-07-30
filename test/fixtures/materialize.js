// Copies a committed fixture home into a temp directory, substituting `__HOME__` for the
// materialized path. Both runtimes key some state by ABSOLUTE project path
// (`.claude.json` projects[], Codex `[projects."<abs>"]`), which cannot be committed.
//
// Every fixture home is fake by construction. No test ever reads a real ~/.claude,
// ~/.codex or ~/.claude.json, and every credential-shaped value in the tree is an
// obvious placeholder.

import { chmod, cp, lstat, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_HOMES = path.join(path.dirname(fileURLToPath(import.meta.url)), "homes");

const TEXT_EXTENSIONS = new Set([".md", ".json", ".toml", ".jsonl", ".sh", ".rules", ".mjs", ".js", ".txt"]);

export async function materializeHome(name = "source") {
  const temp = await mkdtemp(path.join(os.tmpdir(), "omegas-fixture-"));
  const home = path.join(temp, "home");
  await cp(path.join(FIXTURE_HOMES, name), home, { recursive: true, verbatimSymlinks: true });
  // `outside/` is a SIBLING of the home, not part of it: the escaping symlink has to
  // resolve somewhere that is genuinely outside every declared root, and one adapter
  // declares `${HOME}` itself as a root.
  await cp(path.join(FIXTURE_HOMES, "outside"), path.join(temp, "outside"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  const real = (await realpath(home).catch(() => home)) ?? home;
  await renameMungedDirectories(path.join(home, ".claude", "projects"), real);
  await substitute(home, real);
  return {
    home,
    real,
    temp,
    outside: path.join(temp, "outside"),
    cleanup: () => rm(temp, { recursive: true, force: true }),
  };
}

/**
 * Claude's auto-memory directories are the project's absolute path with separators
 * replaced by `-`, so their names cannot be committed. `__MUNGED_APP__` is renamed here
 * to the encoding of the materialized project path — forward, exactly as the engine
 * re-encodes it, never by inverting the name.
 */
async function renameMungedDirectories(projectsDir, home) {
  const encoded = path.join(home, "projects", "app").split(path.sep).join("-");
  const source = path.join(projectsDir, "__MUNGED_APP__");
  if (!(await lstat(source).catch(() => null))) return;
  await rename(source, path.join(projectsDir, encoded));
}

async function substitute(directory, home) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await substitute(full, home);
      continue;
    }
    if (!TEXT_EXTENSIONS.has(path.extname(entry.name)) && entry.name !== ".quiet") continue;
    const text = await readFile(full, "utf8");
    if (!text.includes("__HOME__")) continue;
    const info = await lstat(full);
    await writeFile(full, text.replaceAll("__HOME__", home));
    await chmod(full, info.mode & 0o777);
  }
}

/** Point a fixture symlink somewhere else, for the link-policy tests. */
export async function relink(linkPath, target) {
  await unlink(linkPath);
  await symlink(target, linkPath);
}

// Runnable directly, so a human can drive the real CLI against the committed fixtures:
//   node test/fixtures/materialize.js
//   node bin/omegas-dev.js report --home <printed home> --root <printed home>/projects
// The directory is NOT cleaned up: that is the point.
if (process.argv[1] && process.argv[1].endsWith("materialize.js")) {
  const fixture = await materializeHome(process.argv[2] ?? "source");
  process.stdout.write(`${fixture.home}\n`);
}
