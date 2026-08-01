// The cutover projection: a Continuity bundle manifest -> the legacy
// `omegas.local-transfer.v1` payload the hosted Omegas API already accepts.
//
// WHY THIS EXISTS. The hosted import endpoint speaks one shape today. Rewriting the
// server and the scanner in the same change would mean cutting over with no way to
// compare the two, so this is a PARITY ARTIFACT first and a migration path second: it
// lets the new core produce the old payload, byte-comparable against what
// `discovery.js` produces for the surfaces both cover. `docs/CUTOVER.md` records what
// parity has been proven and what has not.
//
// IT IS NOT WIRED IN. Nothing in `src/cli.js` calls it. The legacy upload path still
// runs the legacy scanner; switching that over is a separate, reviewable change made
// after the parity evidence is read by a human.
//
// PURE. No filesystem, no network, no clock unless one is passed in. Everything it needs
// arrives as the manifest plus the bundle's entry table.

import { createHash } from "node:crypto";

export const LEGACY_SCHEMA_VERSION = "omegas.local-transfer.v1";

/**
 * The legacy format's own vocabulary, which is why this table is an enumeration rather
 * than a lookup into something generic: `local-transfer.v1` has exactly three buckets and
 * three file kinds, and no amount of new runtimes will add a fourth. Anything not listed
 * here is carried by Continuity and has no legacy home — reported as `coverage.only_new`
 * rather than silently dropped.
 */
const LEGACY_SURFACES = {
  // ── global ──
  "claude.instructions.user": { bucket: "context_files", kind: "instructions" },
  "codex.instructions.global": { bucket: "context_files", kind: "instructions" },
  "codex.memories": { bucket: "context_files", kind: "memory" },
  "claude.skills.user": { bucket: "skills", kind: "instructions" },
  "codex.skills.codex_home": { bucket: "skills", kind: "instructions" },
  "codex.skills.agents_user": { bucket: "skills", kind: "instructions" },
  "claude.mcp.user": { bucket: "mcp_servers" },
  "codex.mcp": { bucket: "mcp_servers" },
  // ── project ──
  "claude.instructions.project": { bucket: "context_files", kind: "instructions" },
  "codex.instructions.project": { bucket: "context_files", kind: "instructions" },
  "claude.rules.project": { bucket: "context_files", kind: "context" },
  "claude.memory.auto": { bucket: "context_files", kind: "memory", relabel: ".claude-memory" },
  "claude.skills.project": { bucket: "skills", kind: "instructions" },
  "claude.mcp.project": { bucket: "mcp_servers" },
  "claude.mcp.local": { bucket: "mcp_servers" },
};

/** How a tokenized origin path becomes the legacy label. */
const ROOT_LABELS = {
  "${CLAUDE_HOME}": "global/.claude",
  "${CODEX_HOME}": "global/.codex",
  "${HOME}": "global",
};

/**
 * The projection. Returns the payload plus the list of ways it deliberately differs from
 * what the legacy scanner would produce, because a migration that hides its differences
 * is how a silent regression ships.
 */
export function projectLocalTransferV1({ manifest, entries, generatedAt = null }) {
  if (manifest?.schema_version !== "omegas.continuity.v1") {
    throw new TypeError(`local-transfer.v1 projection needs a Continuity bundle manifest, got ${JSON.stringify(manifest?.schema_version)}`);
  }
  const labels = new Map((manifest.projects ?? []).map((project) => [project.project_id, project.label]));
  const global = emptyScope();
  const projects = new Map();
  const onlyNew = [];

  for (const item of manifest.items ?? []) {
    const mapping = LEGACY_SURFACES[item.surface_id];
    if (!mapping) {
      onlyNew.push({ item_id: item.item_id, kind: item.kind, surface_id: item.surface_id });
      continue;
    }
    // A never-exported item has no bytes to send and never had any.
    if (item.export_refused) continue;

    const scope = item.project_id === null ? global : projectScope(projects, item.project_id);
    const label = item.project_id === null ? null : labels.get(item.project_id) ?? item.project_id;

    if (mapping.bucket === "mcp_servers") {
      const entry = mcpEntry(item, label);
      if (entry) scope.mcp_servers.push(entry);
      continue;
    }
    const file = fileEntry(item, mapping, label, entries);
    if (file) scope[mapping.bucket].push(file);
  }

  const payload = {
    schema_version: LEGACY_SCHEMA_VERSION,
    generated_at: generatedAt ?? manifest.bundle.created_at,
    global: sortScope(global),
    projects: [...projects.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([projectId, scope]) => ({
        key: projectId,
        name: labels.get(projectId) ?? projectId,
        source_label: labels.get(projectId) ?? projectId,
        ...sortScope(scope),
      })),
  };

  return { payload, differences: DIFFERENCES, coverage: { only_new: onlyNew } };
}

/**
 * Every way this payload is NOT what `discoverTransfer()` would have produced. Each one
 * is a deliberate improvement or a deliberate simplification, and each is asserted by
 * `test/cutover.test.js` so it cannot quietly become something else.
 */
export const DIFFERENCES = [
  {
    id: "project-key-deterministic",
    field: "projects[].key",
    legacy: "`<slug>-<8 random hex>` from randomUUID(), so the same machine produces a different key every run",
    projected: "the Continuity project_id, which is derived from the git remote (or a content marker) and is stable",
    why: "a random key makes two scans of the same machine look like two different machines to the server",
  },
  {
    id: "content-redacted",
    field: "context_files[].content, skills[].content",
    legacy: "the raw file bytes, credentials included",
    projected: "the redacted bytes, with `{{OMEGA_REDACTED:class:ref}}` in place of each credential value",
    why: "secrets never travel is the Continuity invariant; this is the whole point of the cutover",
  },
  {
    id: "sha256-of-what-is-sent",
    field: "context_files[].sha256",
    legacy: "digest of the raw bytes",
    projected: "digest of the bytes actually carried, which for a file with no credential in it is the same value",
    why: "a digest has to address what was sent, or it cannot be used to verify what was received",
  },
  {
    id: "no-file-dropping",
    field: "context_files[], skills[]",
    legacy: "`removeSensitiveFiles()` deletes any file whose content looks credential-like, losing the whole file",
    projected: "the file is kept and the credential inside it is replaced",
    why: "whole-file exclusion on a detector verdict destroys legitimate security-tooling content (THR §4.2 Gap 3)",
  },
  {
    id: "url-query-stripped",
    field: "mcp_servers[].url",
    legacy: "sanitizeUrl(): credentials, query and fragment removed",
    projected: "the same default-deny treatment, applied to the already-redacted URL",
    why: "matching the legacy posture exactly means the server sees no new class of value",
  },
  {
    id: "argv-placeholder-shape",
    field: "mcp_servers[].args_redacted",
    legacy: "`<redacted>` — opaque, and the same string for every value",
    projected: "`{{OMEGA_REDACTED:class:ref}}` — says what class of value was there and can be re-bound locally",
    why: "an opaque marker cannot be re-bound on the target machine, which makes the import unusable without a human",
  },
];

// ── entry builders ─────────────────────────────────────────────────────────────

function fileEntry(item, mapping, label, entries) {
  const pointer = item.payload?.raw?.entry;
  const content = pointer ? entries.get(pointer)?.content : null;
  // A file whose bytes were not carried (a cap, or a definition-only payload policy) has
  // nothing to send. Reporting it as an empty file would be worse than omitting it.
  if (typeof content !== "string") return null;
  return {
    source: item.runtime,
    path: legacyPath(item, mapping, label),
    kind: mapping.kind,
    content,
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function mcpEntry(item, label) {
  const value = item.payload?.parsed?.value;
  if (!value || typeof value !== "object") return null;
  const env = value.env && typeof value.env === "object" ? value.env : {};
  return {
    source: item.runtime,
    name: item.name,
    transport: value.command ? "stdio" : value.type === "sse" ? "sse" : value.url ? "streamable_http" : "unknown",
    command: typeof value.command === "string" ? value.command : undefined,
    args_redacted: Array.isArray(value.args) ? value.args.map(String) : [],
    url: sanitizeUrl(value.url),
    env_keys: Object.keys(env).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)),
    source_file: sourceFileLabel(item, label),
  };
}

/**
 * The legacy label for a file: a root name, then the path under it. Continuity's origin
 * path is already tokenized, so this is a rename rather than a computation — no absolute
 * path is reconstructed here, and none is available to reconstruct.
 */
export function legacyPath(item, mapping, label) {
  const tokenized = item.origin?.path ?? "";
  if (mapping.relabel) {
    // Claude's auto-memory lives under a munged copy of the project's absolute path. The
    // legacy collector relabels it to `<project>/.claude-memory/<file>` precisely so that
    // encoding does not travel; the projection keeps that behaviour.
    const base = tokenized.split("/").pop();
    return `${label}/${mapping.relabel}/${base}`;
  }
  for (const [token, root] of Object.entries(ROOT_LABELS)) {
    if (tokenized.startsWith(`${token}/`)) return `${root}/${tokenized.slice(token.length + 1)}`;
  }
  if (tokenized.startsWith("${PROJECT}/")) return `${label}/${tokenized.slice("${PROJECT}/".length)}`;
  return tokenized;
}

function sourceFileLabel(item, label) {
  const tokenized = item.origin?.path ?? "";
  if (tokenized === "${HOME}/.claude.json") return ".claude.json";
  if (tokenized === "${CODEX_HOME}/config.toml") return ".codex/config.toml";
  if (tokenized.startsWith("${PROJECT}/")) return `${label}/${tokenized.slice("${PROJECT}/".length)}`;
  return legacyPath(item, {}, label);
}

/**
 * The legacy default-deny for URLs: no credentials in the authority, no query, no
 * fragment. Reimplemented in eight lines rather than imported from `discovery.js`,
 * because the point of the cutover is that the legacy scanner can eventually be deleted.
 */
export function sanitizeUrl(raw) {
  if (typeof raw !== "string") return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function emptyScope() {
  return { context_files: [], skills: [], mcp_servers: [] };
}

function projectScope(projects, projectId) {
  if (!projects.has(projectId)) projects.set(projectId, emptyScope());
  return projects.get(projectId);
}

/** Deterministic order, so two runs over the same machine produce the same bytes. */
function sortScope(scope) {
  return {
    context_files: [...scope.context_files].sort((a, b) => a.path.localeCompare(b.path)),
    skills: [...scope.skills].sort((a, b) => a.path.localeCompare(b.path)),
    mcp_servers: [...scope.mcp_servers].sort(
      (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name),
    ),
  };
}
