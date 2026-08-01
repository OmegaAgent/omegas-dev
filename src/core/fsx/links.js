// THR §3.1 / manifest §1.4 — three outcomes instead of two. The binary follow/refuse
// choice is what makes 61 real skills invisible on a surveyed machine; the third
// outcome is a NODE, never a silence.

import path from "node:path";
import { insideRoot } from "./paths.js";
import { lstatOrNull, readLinkTarget, realpathOrNull } from "./safe-read.js";

export const OUTCOME = {
  INTERNAL: "internal",
  CROSSING: "crossing",
  UNRESOLVED: "unresolved",
};

/**
 * @param linkPath absolute path of the link itself
 * @param ownRoots the declared roots of the surface that found it
 * @param allRoots every declared root of every adapter — the "known agent root" set
 */
export async function classifyLink(linkPath, ownRoots, allRoots, maxHops = 4) {
  const info = await lstatOrNull(linkPath);
  if (!info?.isSymbolicLink()) return null;

  let current = linkPath;
  let hops = 0;
  const visited = new Set();
  let rawTarget = null;
  while (hops < maxHops) {
    const step = await lstatOrNull(current);
    if (!step?.isSymbolicLink()) break;
    const target = await readLinkTarget(current);
    if (target === null) break;
    if (rawTarget === null) rawTarget = target;
    const next = path.isAbsolute(target) ? target : path.resolve(path.dirname(current), target);
    if (visited.has(next)) {
      return unresolved(hops, rawTarget, null, "symlink cycle detected");
    }
    visited.add(next);
    current = next;
    hops += 1;
  }

  const resolved = await realpathOrNull(current);
  if (!resolved) {
    return unresolved(
      hops,
      rawTarget,
      null,
      hops >= maxHops ? "symlink hop cap exceeded" : "link target does not resolve",
    );
  }

  for (const root of ownRoots) {
    const canonical = await realpathOrNull(root);
    if (canonical && insideRoot(canonical, resolved)) {
      return { outcome: OUTCOME.INTERNAL, hops, raw_target: rawTarget, resolved, from_root: root, to_root: root };
    }
  }
  for (const root of allRoots) {
    const canonical = await realpathOrNull(root);
    if (canonical && insideRoot(canonical, resolved)) {
      return {
        outcome: OUTCOME.CROSSING,
        hops,
        raw_target: rawTarget,
        resolved,
        from_root: ownRoots[0] ?? null,
        to_root: root,
      };
    }
  }
  return unresolved(hops, rawTarget, resolved, "target outside every declared root");
}

function unresolved(hops, rawTarget, resolved, refusal) {
  return { outcome: OUTCOME.UNRESOLVED, hops, raw_target: rawTarget, resolved, refusal };
}
