// Manifest §1.1 — identity is derived, deterministic and DECLARED. Never random, never
// content-derived. This is the fix for `<slug>-<randomUUID().slice(0,8)>`
// (discovery.js:504), which regenerated every run and made re-import, reconciliation
// and diff impossible.

import { createHash } from "node:crypto";

export function scopeRef(scope, projectId) {
  if (scope === "project" || scope === "local") return `${scope}#${projectId ?? "unknown"}`;
  return scope;
}

export function itemId({ runtime, scope, projectId, kind, logicalName }) {
  return `${runtime}:${scopeRef(scope, projectId)}:${kind}:${logicalName}`;
}

export function contentId(text) {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Three ranked methods, each recording its own portability confidence (manifest §1.1).
 * `vcs` also collapses the monorepo aliasing problem: today any directory containing a
 * marker becomes its own project, so per-package CLAUDE.md files in one repo fan out
 * into N unrelated projects (discovery.js:23,:433; INV §4.6).
 */
export function projectIdentity({ vcsRemote, subpath, relPathFromHome, basename }) {
  if (vcsRemote) {
    const normalized = String(vcsRemote)
      .trim()
      .replace(/^git@([^:]+):/, "$1/")
      .replace(/^[a-z+]+:\/\//, "")
      .replace(/\.git$/, "");
    const suffix = subpath ? `#${subpath}` : "";
    return {
      project_id: `git-${normalized.replace(/[/:]/g, "-")}${suffix ? `-${slug(subpath)}` : ""}`,
      identity: {
        method: "vcs",
        value: `git:${normalized}${suffix}`,
        confidence: "high",
        stable_across_runs: true,
        stable_across_machines: true,
      },
      label: basename,
    };
  }
  if (relPathFromHome) {
    const digest = createHash("sha256").update(relPathFromHome).digest("hex").slice(0, 12);
    return {
      project_id: `marker-${digest}`,
      identity: {
        method: "marker",
        value: `marker:${digest}`,
        confidence: "medium",
        stable_across_runs: true,
        stable_across_machines: false,
        note: "records the $HOME-relative shape only; there is no remote to anchor to",
      },
      label: basename,
    };
  }
  return {
    project_id: `label-${slug(basename)}`,
    identity: {
      method: "label",
      value: `label:${slug(basename)}`,
      confidence: "low",
      stable_across_runs: true,
      stable_across_machines: false,
      note: "explicitly ambiguous — two unrelated directories can share a basename",
    },
    label: basename,
  };
}

/**
 * Array-index identities genuinely COLLIDE, they do not merely reorder
 * (spike-corrections, modelling note 1): two sources contributing `permissions.allow[0]`
 * in one scope produce one id. Suffix deterministically rather than drop — a dropped
 * item is a permission rule the user never sees.
 */
export function disambiguate(id, taken) {
  if (!taken.has(id)) return id;
  let suffix = 2;
  while (taken.has(`${id}#${suffix}`)) suffix += 1;
  return `${id}#${suffix}`;
}

/** Expand `{relpath}` / `{dirname}` / `{key_path}` / `{field}` / `{0}`… in a template. */
export function expandIdentity(template, vars) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (whole, name) =>
    Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null
      ? String(vars[name])
      : whole,
  );
}
