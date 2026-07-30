// ONE bounded walker, driven entirely by a descriptor's locations[]. It replaces the
// baseline's three hand-written traversals (discovery.js:108-142, :176-219, :546-573).
// Nothing here knows what a skill or a hook is: `match`, `glob`, `depth`, `order`,
// `ancestor_walk` and `at_most_one_per_dir` are the whole vocabulary.

import path from "node:path";
import { classifyLink, OUTCOME } from "./links.js";
import { globCaptures, globMatch, hasGlob, isUnresolved, toPosix } from "./paths.js";
import { lstatOrNull, safeEntries } from "./safe-read.js";

/**
 * Resolve a path template that may contain glob segments into the concrete paths that
 * exist today. `sources[]` needs this: a plugin hooks file lives at
 * `plugins/cache/*​/*​/*​/hooks/hooks.json`, and a Codex profile at `*.config.toml`.
 */
export async function expandGlobPath(pattern, { caps, ignoredDirs }) {
  if (isUnresolved(pattern)) return [];
  if (!hasGlob(pattern)) return [pattern];
  const posix = toPosix(pattern);
  const segments = posix.split("/");
  let frontier = [segments[0] === "" ? "/" : segments[0]];
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!hasGlob(segment)) {
      frontier = frontier.map((base) => path.join(base, segment));
      continue;
    }
    const next = [];
    for (const base of frontier) {
      if (next.length >= caps.walk_entries) break;
      for (const entry of await safeEntries(base)) {
        if (entry.isSymbolicLink()) continue;
        if (ignoredDirs.has(entry.name)) continue;
        if (!globMatch(segment, entry.name)) continue;
        next.push(path.join(base, entry.name));
        if (next.length >= caps.walk_entries) break;
      }
    }
    frontier = next;
    if (frontier.length === 0) return [];
  }
  const existing = [];
  for (const candidate of frontier) {
    if (await lstatOrNull(candidate)) existing.push(candidate);
  }
  return existing.sort();
}

/**
 * Collect the candidate nodes a single location describes.
 *
 * ctx: { location, base, roots, knownRoots, caps, ignoredDirs, onLink }
 * Returns [{ abs_path, captures, order_index, applied, applied_reason, link }].
 * `onLink(classification, absPath, name)` is called for every symlink encountered so a
 * refusal becomes a record rather than a `continue`.
 */
export async function collectLocation(ctx) {
  const { location } = ctx;
  if (location.match === "file") return collectFile(ctx);
  if (location.match === "glob") return collectGlob(ctx);
  if (location.match === "dir_of") return collectDirOf(ctx);
  return [];
}

async function collectFile(ctx) {
  const { location, base } = ctx;
  const directories = location.ancestor_walk ? await descendantDirectories(ctx, base) : [{ dir: base, depth: 0 }];
  const names = location.order ?? [null];
  const out = [];
  for (const { dir, depth } of directories) {
    let takenInDir = false;
    for (let index = 0; index < names.length; index += 1) {
      if (takenInDir && location.at_most_one_per_dir) break;
      const absPath = names[index] === null ? dir : path.join(dir, names[index]);
      const info = await lstatOrNull(absPath);
      if (info?.isSymbolicLink()) {
        await reportLink(ctx, absPath, path.basename(absPath));
        continue;
      }
      if (!info?.isFile()) continue;
      takenInDir = true;
      out.push({
        abs_path: absPath,
        captures: baseCaptures(absPath, base),
        order_index: index,
        // §2.1 — files below the launch directory are scanned but not loaded at launch.
        // Recording that as data is the difference between "absent" and "present but
        // lazy", which is exactly what a user cannot see today.
        applied: depth === 0,
        applied_reason: depth === 0 ? null : "lazy — loads when a file in that directory is read",
        link: null,
      });
    }
  }
  return out;
}

async function collectGlob(ctx) {
  const { location, base, caps, ignoredDirs } = ctx;
  const pattern = path.posix.join(toPosix(base), location.glob ?? "*");
  const maxDepth = location.depth ?? caps.depth;
  const out = [];
  const walk = async (directory, depth) => {
    if (depth > maxDepth || out.length >= caps.walk_entries) return;
    for (const entry of (await safeEntries(directory)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= caps.walk_entries) return;
      if (ignoredDirs.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const classification = await reportLink(ctx, full, entry.name);
        if (!classification || classification.outcome === OUTCOME.UNRESOLVED) continue;
        const info = await lstatOrNull(classification.resolved);
        if (info?.isDirectory()) await walk(full, depth + 1);
        else if (globMatch(pattern, full)) out.push(node(ctx, full, base, classification));
        continue;
      }
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      if (globMatch(pattern, full)) out.push(node(ctx, full, base, null));
    }
  };
  await walk(base, 1);
  return out;
}

/**
 * `dir_of`: the identity comes from the DIRECTORY, and the definition file inside it is
 * what gets read (CLA §2.4). This is also where the three-outcome link policy earns its
 * keep — most installed skills on a real machine are symlinks.
 */
async function collectDirOf(ctx) {
  const { location, base, caps } = ctx;
  const glob = location.glob ?? "*/SKILL.md";
  const childName = glob.split("/").slice(1).join("/") || glob;
  const dirPattern = glob.split("/")[0];
  const out = [];
  for (const entry of (await safeEntries(base)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (out.length >= caps.walk_entries) break;
    if (dirPattern !== "*" && !globMatch(dirPattern, entry.name)) continue;
    const full = path.join(base, entry.name);
    if (entry.isSymbolicLink()) {
      const classification = await reportLink(ctx, full, entry.name);
      if (!classification || classification.outcome === OUTCOME.UNRESOLVED) continue;
      out.push(node(ctx, path.join(full, childName), base, classification, entry.name));
      continue;
    }
    if (!entry.isDirectory()) {
      // A bare definition file directly under the root (the plugin-root SKILL.md case).
      if (globMatch(childName, entry.name)) out.push(node(ctx, full, base, null, path.basename(base)));
      continue;
    }
    out.push(node(ctx, path.join(full, childName), base, null, entry.name));
  }
  return out;
}

function node(ctx, absPath, base, classification, dirname = null) {
  return {
    abs_path: absPath,
    captures: baseCaptures(absPath, base, dirname),
    order_index: null,
    applied: true,
    applied_reason: null,
    link: classification ? linkField(ctx, classification) : null,
    extra_roots: classification?.resolved ? [classification.resolved] : [],
  };
}

function linkField(ctx, classification) {
  return {
    via_link: true,
    hops: classification.hops,
    outcome: classification.outcome,
    from_root: classification.from_root ?? null,
    to_root: classification.to_root ?? null,
    resolved: classification.resolved ?? null,
    raw_target: classification.raw_target ?? null,
  };
}

function baseCaptures(absPath, base, dirname = null) {
  const relative = toPosix(path.relative(base, absPath));
  return {
    relpath: relative && !relative.startsWith("..") ? relative : path.basename(absPath),
    basename: path.basename(absPath),
    dirname: dirname ?? path.basename(path.dirname(absPath)),
  };
}

async function reportLink(ctx, absPath, name) {
  const classification = await classifyLink(absPath, ctx.roots, ctx.knownRoots, ctx.caps.link_hops);
  if (classification && ctx.onLink) await ctx.onLink(classification, absPath, name);
  return classification;
}

/**
 * `ancestor_walk` describes a chain of directories that each may carry their own
 * instruction file. Bounded by the same depth cap as everything else.
 */
async function descendantDirectories(ctx, base) {
  const { caps, ignoredDirs } = ctx;
  const out = [{ dir: base, depth: 0 }];
  const walk = async (directory, depth) => {
    if (depth >= Math.min(caps.ancestor_depth, caps.depth) || out.length >= caps.walk_entries) return;
    for (const entry of (await safeEntries(directory)).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || ignoredDirs.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      out.push({ dir: full, depth: depth + 1 });
      await walk(full, depth + 1);
    }
  };
  await walk(base, 0);
  return out;
}

/** Path captures for a location whose base itself contained globs (plugin caches). */
export function pathCaptures(patternBase, concreteBase) {
  return globCaptures(toPosix(patternBase), toPosix(concreteBase)) ?? [];
}
