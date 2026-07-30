// Builds the scan environment from adapter DECLARATIONS only: the token table, the
// declared roots (which are the containment boundary for the symlink policy), and the
// discovered projects. Nothing here knows the name of any runtime.
//
// The environment is an explicit argument all the way down — home directory, project
// roots, os, environment variables. That is what lets a test hand the engine a fixture
// home and know that no real config was ever opened.

import path from "node:path";
import { expandTemplate, isUnresolved, toPosix } from "../fsx/paths.js";
import { lstatOrNull, realpathOrNull, safeEntries, safeReadText } from "../fsx/safe-read.js";
import { CAPS, IGNORED_DIRS, capsFor } from "../policy/caps.js";
import { projectIdentity } from "../model/identity.js";

export async function buildEnvironment({ homeDir, roots = [], os = process.platform, envVars = {}, adapters, caps }) {
  const effectiveCaps = capsFor(caps);
  // Canonicalize up front. A home reached through a symlink (a temp dir on macOS, an
  // automounted home on Linux) would otherwise fail every containment and tokenization
  // check, because `realpath` on the files returns the other spelling.
  const canonicalHome = (await realpathOrNull(homeDir)) ?? homeDir;
  const vars = { HOME: canonicalHome };
  homeDir = canonicalHome;
  roots = await Promise.all(roots.map(async (root) => (await realpathOrNull(root)) ?? root));

  // Per-platform roots resolve first: a token may reference one (`${root:claude_managed}`),
  // because a path that differs by OS cannot be written as a single string.
  for (const adapter of adapters) {
    for (const root of adapter.roots ?? []) {
      if (root.platform) {
        const resolved = root.platform[os] ?? null;
        if (resolved) vars[`root:${root.root_id}`] = resolved;
      }
    }
  }

  for (const adapter of adapters) {
    for (const [name, template] of Object.entries(adapter.tokens ?? {})) {
      // An environment variable of the same name as a declared token wins: that is the
      // runtime's own override mechanism (CLAUDE_CONFIG_DIR, CODEX_HOME).
      const override = envVars[name];
      vars[name] = override && String(override).length > 0 ? String(override) : expandTemplate(template, vars);
    }
  }
  for (const [name, value] of Object.entries(envVars)) {
    if (!Object.prototype.hasOwnProperty.call(vars, name)) vars[name] = String(value);
  }

  const declaredRoots = [];
  for (const adapter of adapters) {
    for (const root of adapter.roots ?? []) {
      if (root.root_id === "project" || String(root.path ?? "").includes("${PROJECT}")) continue;
      const resolved = root.platform
        ? vars[`root:${root.root_id}`]
        : expandTemplate(root.path ?? "", vars);
      if (!resolved || isUnresolved(resolved)) continue;
      declaredRoots.push({ adapter_id: adapter.id, root_id: root.root_id, scope: root.scope, path: resolved });
    }
  }

  const markers = new Set(adapters.flatMap((adapter) => adapter.project_markers ?? []));
  const projects = await discoverProjects({
    homeDir,
    roots: roots.length > 0 ? roots : [],
    markers,
    declaredRoots,
    caps: effectiveCaps,
  });

  return { homeDir, os, tokens: vars, declaredRoots, projects, caps: effectiveCaps, envVars };
}

/** A location that mentions `${PROJECT}` is evaluated once per discovered project. */
export function contextsFor(env, location) {
  const usesProject =
    String(location.path ?? "").includes("${PROJECT}") || location.root_id === "project";
  if (!usesProject) return [{ tokens: env.tokens, project: null }];
  return env.projects.map((project) => ({
    tokens: { ...env.tokens, PROJECT: project.path },
    project,
  }));
}

export function rootPathsFor(adapter, tokens, env) {
  const out = [];
  for (const root of adapter.roots ?? []) {
    const resolved = root.platform ? tokens[`root:${root.root_id}`] : expandTemplate(root.path ?? "", tokens);
    if (resolved && !isUnresolved(resolved)) out.push(resolved);
  }
  if (env && out.length === 0) out.push(env.homeDir);
  return out;
}

/** Every declared root of every adapter — the "known agent root" set the link policy uses. */
export function allRootPaths(env, adapters) {
  const roots = new Set(env.declaredRoots.map((root) => root.path));
  for (const project of env.projects) roots.add(project.path);
  for (const adapter of adapters) {
    for (const root of adapter.roots ?? []) {
      const resolved = root.platform
        ? env.tokens[`root:${root.root_id}`]
        : expandTemplate(root.path ?? "", env.tokens);
      if (resolved && !isUnresolved(resolved)) roots.add(resolved);
    }
  }
  return [...roots];
}

async function discoverProjects({ homeDir, roots, markers, declaredRoots, caps }) {
  const rootPaths = new Set(declaredRoots.map((root) => root.path));
  const found = [];
  const seen = new Set();

  const walk = async (directory, depth) => {
    if (depth > caps.project_depth || found.length >= caps.walk_entries) return;
    const entries = await safeEntries(directory);
    const names = new Set(entries.map((entry) => entry.name));
    const isProject =
      directory !== homeDir && !rootPaths.has(directory) && [...markers].some((marker) => names.has(marker));
    if (isProject && !seen.has(directory)) {
      seen.add(directory);
      found.push(directory);
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      // An explicitly supplied hidden root is still scanned as a root; only hidden
      // descendants are skipped, so agent state directories never become projects.
      if (entry.name.startsWith(".") && depth > 0) continue;
      const child = path.join(directory, entry.name);
      if (rootPaths.has(child)) continue;
      await walk(child, depth + 1);
    }
  };

  for (const root of roots) await walk(root, 0);

  const projects = [];
  for (const directory of found.sort()) {
    const repo = await enclosingRepo(directory, caps);
    const subpath = repo && repo.root !== directory ? toPosix(path.relative(repo.root, directory)) : null;
    const identity = projectIdentity({
      vcsRemote: repo?.remote ?? null,
      subpath,
      relPathFromHome: toPosix(path.relative(homeDir, directory)) || null,
      basename: path.basename(directory),
    });
    projects.push({
      ...identity,
      path: directory,
      vcs: repo?.remote ? { kind: "git", remote: repo.remote, repo_root: repo.root, subpath } : null,
    });
  }
  return projects;
}

/**
 * Walk up for a `.git` directory so per-package markers inside one repository collapse
 * onto that repository with a `#subpath` rather than fanning out into N unrelated
 * projects (manifest §1.1; the defect at discovery.js:23,:433).
 */
async function enclosingRepo(directory, caps) {
  let current = directory;
  for (let depth = 0; depth <= caps.depth; depth += 1) {
    const gitPath = path.join(current, ".git");
    const info = await lstatOrNull(gitPath);
    if (info?.isDirectory()) {
      return { root: current, remote: await readGitRemote(gitPath, current, caps) };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

async function readGitRemote(gitPath, repoRoot, caps) {
  const configPath = path.join(gitPath, "config");
  const info = await lstatOrNull(configPath);
  if (!info?.isFile()) return null;
  const result = await safeReadText(configPath, [repoRoot], Math.min(caps.file_bytes, CAPS.file_bytes));
  if (!result.ok) return null;
  const match = /^\s*url\s*=\s*(.+)$/m.exec(result.text);
  return match ? match[1].trim() : null;
}
