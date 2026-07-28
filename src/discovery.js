import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 256 * 1024;
const SKILL_SCAN_DEPTH = 2;
const IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".cache",
  ".npm",
  ".pnpm-store",
  "Library",
  "node_modules",
  "target",
  "dist",
  "build",
  "coverage",
  "vendor",
]);
const PROJECT_MARKERS = new Set([".claude", ".codex", ".mcp.json", "CLAUDE.md", "AGENTS.md"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function fileInfo(filename) {
  try {
    return await lstat(filename);
  } catch {
    return null;
  }
}

async function safeEntries(directory) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }
}

function insideRoot(root, filename) {
  const relative = path.relative(root, filename);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

async function readTextFile(filename, allowedRoot = path.dirname(filename)) {
  const info = await fileInfo(filename);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) return null;
  const [canonicalRoot, canonicalFile] = await Promise.all([
    realpath(allowedRoot).catch(() => null),
    realpath(filename).catch(() => null),
  ]);
  if (!canonicalRoot || !canonicalFile || !insideRoot(canonicalRoot, canonicalFile)) return null;
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0);
  const handle = await open(filename, flags).catch(() => null);
  if (!handle) return null;
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_FILE_BYTES) return null;
    const content = await handle.readFile("utf8");
    const after = await handle.stat();
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      content.includes("\0")
    ) return null;
    return content;
  } finally {
    await handle.close();
  }
}

export async function fingerprintFile(filename, allowedRoot) {
  const info = await fileInfo(filename);
  if (!info?.isFile() || info.isSymbolicLink()) return null;
  const [canonicalRoot, canonicalFile] = await Promise.all([
    realpath(allowedRoot).catch(() => null),
    realpath(filename).catch(() => null),
  ]);
  if (!canonicalRoot || !canonicalFile || !insideRoot(canonicalRoot, canonicalFile)) return null;
  return { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, canonicalFile };
}

export async function readFingerprintedText(file) {
  const current = await fingerprintFile(file.filename, file.allowedRoot);
  const expected = file.fingerprint;
  if (!current || !expected || ["dev", "ino", "size", "mtimeMs", "canonicalFile"].some((key) => current[key] !== expected[key])) {
    throw new Error(`${file.sourceLabel} changed after selection; rerun the transfer`);
  }
  const content = await readTextFile(file.filename, file.allowedRoot);
  const after = await fingerprintFile(file.filename, file.allowedRoot);
  if (content === null || !after || ["dev", "ino", "size", "mtimeMs", "canonicalFile"].some((key) => after[key] !== expected[key])) {
    throw new Error(`${file.sourceLabel} could not be read safely; rerun the transfer`);
  }
  return content;
}

function relativeLabel(rootLabel, root, filename) {
  return path.posix.join(rootLabel, path.relative(root, filename).split(path.sep).join("/"));
}

async function collectNamedFiles(directory, names, depth = 5) {
  const found = [];
  async function walk(current, remaining) {
    if (remaining < 0) return;
    for (const entry of await safeEntries(current)) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full, remaining - 1);
      } else if (entry.isFile() && names.has(entry.name)) {
        found.push(full);
      }
    }
  }
  await walk(directory, depth);
  return found;
}

async function collectMarkdownFiles(directory, depth = 5) {
  const found = [];
  async function walk(current, remaining) {
    if (remaining < 0) return;
    for (const entry of await safeEntries(current)) {
      if (entry.isSymbolicLink()) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full, remaining - 1);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
        found.push(full);
      }
    }
  }
  await walk(directory, depth);
  return found;
}

async function transferFile(filename, { root, rootLabel, source, kind }) {
  const content = await readTextFile(filename, root);
  if (content === null) return null;
  return {
    source,
    path: relativeLabel(rootLabel, root, filename),
    kind,
    content,
    sha256: sha256(content),
  };
}

async function collectScopeFiles(root, rootLabel) {
  const contextFiles = [];
  const skills = [];
  const direct = [
    ["CLAUDE.md", "claude", "instructions"],
    ["AGENTS.md", "codex", "instructions"],
    [path.join(".claude", "CLAUDE.md"), "claude", "instructions"],
    [path.join(".codex", "AGENTS.md"), "codex", "instructions"],
  ];
  for (const [relative, source, kind] of direct) {
    const item = await transferFile(path.join(root, relative), { root, rootLabel, source, kind });
    if (item) contextFiles.push(item);
  }

  for (const [relative, source, kind] of [
    [path.join(".claude", "rules"), "claude", "context"],
    [path.join(".claude", "memory"), "claude", "memory"],
    [path.join(".codex", "memories"), "codex", "memory"],
  ]) {
    for (const filename of await collectMarkdownFiles(path.join(root, relative))) {
      const item = await transferFile(filename, { root, rootLabel, source, kind });
      if (item) contextFiles.push(item);
    }
  }

  for (const [relative, source] of [
    [path.join(".claude", "skills"), "claude"],
    [path.join(".codex", "skills"), "codex"],
  ]) {
    // Installed skills are either direct children or one collection deep (for example,
    // gstack/review/SKILL.md). Do not descend into a skill repository's internal editor mirrors,
    // fixtures, caches, or vendored agent directories and import those as separate user skills.
    for (const filename of await collectNamedFiles(
      path.join(root, relative),
      new Set(["SKILL.md"]),
      SKILL_SCAN_DEPTH,
    )) {
      const item = await transferFile(filename, { root, rootLabel, source, kind: "instructions" });
      if (item) skills.push(item);
    }
  }
  return { context_files: contextFiles, skills, mcp_servers: [] };
}

function redactArgument(value) {
  const text = String(value);
  if (/^[A-Za-z0-9-]+\s*:(?!\/\/)\s*.+/.test(text)) return text.replace(/(:\s*).+$/, "$1<redacted>");
  if (/(api[_-]?key|access[_-]?token|credential|signature|secret|password)=/i.test(text)) return text.replace(/=.+$/, "=<redacted>");
  if (/^bearer\s+/i.test(text)) return "Bearer <redacted>";
  if (credentialToken(text)) return "<redacted>";
  return text;
}

function sensitiveFlag(value) {
  return /^--?(?:h|header|api[-_]?key|token|access[-_]?token|credential|signature|secret|password|authorization|auth)$/i.test(String(value));
}

function redactArguments(values) {
  const result = [];
  let redactNext = false;
  for (const value of values) {
    if (redactNext) {
      result.push("<redacted>");
      redactNext = false;
      continue;
    }
    const redacted = redactArgument(value);
    result.push(redacted);
    if (sensitiveFlag(value)) redactNext = true;
  }
  return result;
}

function sanitizeUrl(raw) {
  if (typeof raw !== "string") return undefined;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    const segments = url.pathname.split("/");
    let redactRemainder = false;
    url.pathname = segments.map((segment) => {
      if (redactRemainder || credentialToken(segment)) return "<redacted>";
      if (/^(?:token|secret|key|auth|credential|signature)$/i.test(segment)) {
        redactRemainder = true;
      }
      return segment;
    }).join("/");
    // MCP inventory needs the endpoint, never query parameters or fragments. Default-deny avoids
    // guessing which providers hide credentials under names such as signature or credential.
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return redactArgument(raw);
  }
}

function credentialToken(value) {
  const text = String(value).trim();
  return /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16})\b/.test(text)
    || hasUnredactedBearer(text);
}

function hasUnredactedBearer(value) {
  const words = String(value).split(/\s+/);
  for (let index = 0; index + 1 < words.length; index += 1) {
    if (!/^bearer$/i.test(words[index])) continue;
    const candidate = words[index + 1].replace(/^[\x27"`,;\)\]\}]+|[\x27"`,;\)\]\}]+$/g, "");
    if (
      candidate.length >= 12
      && !candidate.startsWith("$")
      && !candidate.startsWith("<")
      && !/^redacted$/i.test(candidate)
    ) return true;
  }
  return false;
}

function hasCredentialAssignment(line) {
  const trimmed = line.trim().replace(/^export /, "").trim();
  const delimiter = trimmed.includes("=") ? "=" : trimmed.includes(":") ? ":" : null;
  if (!delimiter) return false;
  const splitAt = trimmed.indexOf(delimiter);
  const key = trimmed.slice(0, splitAt).trim().replace(/^[\x27"]+|[\x27"]+$/g, "");
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  const lowerKey = key.toLowerCase();
  if (!["key", "token", "secret", "password", "credential", "signature"].some(
    (needle) => lowerKey.indexOf(needle) > 0,
  )) return false;
  const candidate = trimmed
    .slice(splitAt + 1)
    .trim()
    .replace(/^[\x27"]+|[\x27"]+$/g, "")
    .split(/\s+/)[0] || "";
  return candidate.length >= 8
    && !candidate.startsWith("${")
    && !candidate.startsWith("<")
    && !/^(?:example|placeholder|redacted|your[-_])/i.test(candidate);
}

export function containsCredentialLike(content) {
  if (credentialToken(content)) return true;
  return content.split(/\r?\n/).some(hasCredentialAssignment);
}

function removeSensitiveFiles(scope, warnings) {
  for (const field of ["context_files", "skills"]) {
    scope[field] = scope[field].filter((file) => {
      if (!containsCredentialLike(file.content)) return true;
      warnings.push(`${file.path} was skipped because it appears to contain credential material`);
      return false;
    });
  }
}

function normalizeMcpServers(value, source, sourceFile) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([name, config]) => {
    const item = config && typeof config === "object" ? config : {};
    const env = item.env && typeof item.env === "object" ? item.env : {};
    return {
      source,
      name,
      transport: item.command ? "stdio" : item.type === "sse" ? "sse" : item.url ? "streamable_http" : "unknown",
      command: typeof item.command === "string" ? item.command : undefined,
      args_redacted: Array.isArray(item.args) ? redactArguments(item.args) : [],
      url: sanitizeUrl(item.url),
      env_keys: Object.keys(env).filter((key) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)),
      source_file: sourceFile,
    };
  });
}

async function readJson(filename, allowedRoot = path.dirname(filename)) {
  const text = await readTextFile(filename, allowedRoot);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseTomlString(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function parseTomlArray(value) {
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  const matches = inner.match(/"(?:\\.|[^"\\])*"|'[^']*'|[^,]+/g) || [];
  return matches.map(parseTomlString);
}

export function parseCodexMcpToml(text, sourceFile = ".codex/config.toml") {
  const servers = new Map();
  let current = null;
  let inEnv = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line) continue;
    const section = line.match(/^\[mcp_servers\.(?:"([^"]+)"|([^\.\]]+))(?:\.(env))?\]$/);
    if (section) {
      const name = section[1] || section[2];
      if (!servers.has(name)) servers.set(name, { envKeys: new Set() });
      current = servers.get(name);
      inEnv = Boolean(section[3]);
      continue;
    }
    if (line.startsWith("[")) {
      current = null;
      inEnv = false;
      continue;
    }
    if (!current) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const key = line.slice(0, equals).trim().replace(/^['"]|['"]$/g, "");
    const rawValue = line.slice(equals + 1).trim();
    if (inEnv) {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) current.envKeys.add(key);
    } else if (key === "args") current.args = redactArguments(parseTomlArray(rawValue));
    else if (["command", "url", "transport", "type"].includes(key)) current[key] = parseTomlString(rawValue);
  }
  return [...servers.entries()].map(([name, value]) => ({
    source: "codex",
    name,
    transport: value.command ? "stdio" : value.transport || value.type || (value.url ? "streamable_http" : "unknown"),
    command: value.command,
    args_redacted: value.args || [],
    url: sanitizeUrl(value.url),
    env_keys: [...value.envKeys],
    source_file: sourceFile,
  }));
}

async function collectMcpForProject(projectRoot, rootLabel, claudeConfig) {
  const items = [];
  for (const relative of [".mcp.json", path.join(".claude", "settings.json"), path.join(".claude", "settings.local.json")]) {
    const config = await readJson(path.join(projectRoot, relative), projectRoot);
    items.push(...normalizeMcpServers(config?.mcpServers, "claude", path.posix.join(rootLabel, relative.split(path.sep).join("/"))));
  }
  const projectConfig = claudeConfig?.projects?.[projectRoot];
  items.push(...normalizeMcpServers(projectConfig?.mcpServers, "claude", ".claude.json"));
  const codexPath = path.join(projectRoot, ".codex", "config.toml");
  const codex = await readTextFile(codexPath, projectRoot);
  if (codex !== null) items.push(...parseCodexMcpToml(codex, path.posix.join(rootLabel, ".codex/config.toml")));
  return items;
}

async function collectClaudeProjectMemory(home, projectRoot, rootLabel) {
  // Claude Code encodes an absolute project path by replacing path separators with `-`.
  // We use this only to locate the directory locally; the absolute path never enters the manifest.
  const encodedProject = projectRoot.split(path.sep).join("-");
  const memoryRoot = path.join(home, ".claude", "projects", encodedProject, "memory");
  const memories = [];
  for (const filename of await collectMarkdownFiles(memoryRoot, 2)) {
    const item = await transferFile(filename, {
      root: memoryRoot,
      rootLabel: path.posix.join(rootLabel, ".claude-memory"),
      source: "claude",
      kind: "memory",
    });
    if (item) memories.push(item);
  }
  return memories;
}

async function discoverProjectRoots(roots, maxDepth) {
  const projects = new Set();
  async function walk(directory, depth) {
    const entries = await safeEntries(directory);
    if (entries.some((entry) => PROJECT_MARKERS.has(entry.name))) projects.add(directory);
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      // A home scan should find user projects, not editor extensions or agent runtime state under
      // directories such as .vscode, .cursor, .openclaw, or .gstack. An explicitly supplied hidden
      // root is still scanned as the root; only hidden descendants are excluded.
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      await walk(path.join(directory, entry.name), depth + 1);
    }
  }
  for (const root of roots) await walk(root, 0);
  return [...projects].sort();
}

async function collectGlobal(home, claudeConfig) {
  const rootLabel = "global";
  const contextFiles = [];
  const skills = [];
  for (const [relative, source, kind] of [
    [path.join(".claude", "CLAUDE.md"), "claude", "instructions"],
    [path.join(".codex", "AGENTS.md"), "codex", "instructions"],
    [path.join(".codex", "memories", "MEMORY.md"), "codex", "memory"],
    [path.join(".codex", "memories", "memory_summary.md"), "codex", "memory"],
  ]) {
    const item = await transferFile(path.join(home, relative), { root: home, rootLabel, source, kind });
    if (item) contextFiles.push(item);
  }
  for (const [relative, source] of [[path.join(".claude", "skills"), "claude"], [path.join(".codex", "skills"), "codex"]]) {
    // This reaches direct personal skills plus collections such as gstack/<skill>, without
    // descending into nested repos, editor mirrors, fixtures, or caches inside those collections.
    for (const filename of await collectNamedFiles(
      path.join(home, relative),
      new Set(["SKILL.md"]),
      SKILL_SCAN_DEPTH,
    )) {
      const item = await transferFile(filename, { root: home, rootLabel, source, kind: "instructions" });
      if (item) skills.push(item);
    }
  }
  const mcpServers = normalizeMcpServers(claudeConfig?.mcpServers, "claude", ".claude.json");
  const codex = await readTextFile(path.join(home, ".codex", "config.toml"), home);
  if (codex !== null) mcpServers.push(...parseCodexMcpToml(codex));
  const uniqueSkills = [];
  const skillDigests = new Set();
  for (const skill of skills) {
    if (skillDigests.has(skill.sha256)) continue;
    skillDigests.add(skill.sha256);
    uniqueSkills.push(skill);
  }
  return { context_files: contextFiles, skills: uniqueSkills, mcp_servers: mcpServers };
}

export async function discoverTransfer({ roots, home, maxDepth = 4 }) {
  const canonicalRoots = [];
  for (const root of roots) {
    const canonical = await realpath(root).catch(() => null);
    if (canonical && !canonicalRoots.includes(canonical)) canonicalRoots.push(canonical);
  }
  const claudeConfig = await readJson(path.join(home, ".claude.json"), home);
  const canonicalHome = await realpath(home).catch(() => null);
  // The user's home directory contains the global .claude/.codex entrypoints by design. When the
  // CLI is launched from ~, those markers must not manufacture a "home" project Space or cause
  // global skills to be scanned again as project-local skills.
  const projectRoots = (await discoverProjectRoots(canonicalRoots, maxDepth)).filter(
    (projectRoot) => projectRoot !== canonicalHome,
  );
  const projects = [];
  const envFiles = [];
  const warnings = [];
  for (const projectRoot of projectRoots) {
    const name = path.basename(projectRoot);
    const key = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"}-${randomUUID().slice(0, 8)}`;
    const scope = await collectScopeFiles(projectRoot, name);
    scope.context_files.push(...(await collectClaudeProjectMemory(home, projectRoot, name)));
    scope.mcp_servers.push(...(await collectMcpForProject(projectRoot, name, claudeConfig)));
    removeSensitiveFiles(scope, warnings);
    projects.push({ key, name, source_label: name, ...scope });
    for (const entry of await safeEntries(projectRoot)) {
      if (!entry.isFile() || !entry.name.startsWith(".env")) continue;
      if ([".env.example", ".env.sample", ".env.template"].includes(entry.name)) continue;
      const filename = path.join(projectRoot, entry.name);
      const fingerprint = await fingerprintFile(filename, projectRoot);
      if (!fingerprint) continue;
      envFiles.push({ projectKey: key, projectName: name, filename, allowedRoot: projectRoot, fingerprint, sourceLabel: path.posix.join(name, entry.name) });
    }
  }
  const global = await collectGlobal(home, claudeConfig);
  removeSensitiveFiles(global, warnings);
  return {
    manifest: {
      schema_version: "omegas.local-transfer.v1",
      generated_at: new Date().toISOString(),
      global,
      projects,
    },
    envFiles,
    warnings,
  };
}
