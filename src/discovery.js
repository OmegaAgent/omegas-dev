import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
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
const SYMLINK_REASON = "symlink";
const OVERSIZE_REASON = `over ${MAX_FILE_BYTES / 1024} KB`;

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

async function readTextFile(filename, allowedRoot = path.dirname(filename), report = null) {
  const skip = (reason) => {
    if (report) report(filename, reason);
    return null;
  };
  const info = await fileInfo(filename);
  if (!info) return null;
  if (info.isSymbolicLink()) return skip(SYMLINK_REASON);
  if (!info.isFile()) return null;
  if (info.size > MAX_FILE_BYTES) return skip(OVERSIZE_REASON);
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
    if (!before.isFile()) return null;
    if (before.size > MAX_FILE_BYTES) return skip(OVERSIZE_REASON);
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

// A symlink this walker would otherwise have descended into or imported. Entries it would have
// ignored anyway (caches, hidden directories, unrelated file types) stay quiet.
function symlinkWorthReporting(name, matches) {
  if (IGNORED_DIRS.has(name) || name.startsWith(".")) return false;
  return matches(name) || path.extname(name) === "";
}

async function collectFiles(directory, matches, depth, report) {
  const found = [];
  async function walk(current, remaining) {
    if (remaining < 0) return;
    for (const entry of await safeEntries(current)) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        // Refusing a link is a decision the user has to be able to see: on many machines every
        // installed skill is a symlink into another agent's directory.
        if (report && symlinkWorthReporting(entry.name, matches)) report(full, SYMLINK_REASON);
        continue;
      }
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) await walk(full, remaining - 1);
      } else if (entry.isFile() && matches(entry.name)) {
        found.push(full);
      }
    }
  }
  await walk(directory, depth);
  return found;
}

function collectNamedFiles(directory, names, depth = 5, report = null) {
  return collectFiles(directory, (name) => names.has(name), depth, report);
}

function collectMarkdownFiles(directory, depth = 5, report = null) {
  return collectFiles(directory, (name) => name.toLowerCase().endsWith(".md"), depth, report);
}

// Warnings carry the same scope-relative label as the manifest, never an absolute path.
function skipReporter(warnings, root, rootLabel) {
  return (filename, reason) => {
    const message = `skipped (${reason}): ${relativeLabel(rootLabel, root, filename)}`;
    if (!warnings.includes(message)) warnings.push(message);
  };
}

async function transferFile(filename, { root, rootLabel, source, kind, report }) {
  const content = await readTextFile(filename, root, report);
  if (content === null) return null;
  return {
    source,
    path: relativeLabel(rootLabel, root, filename),
    kind,
    content,
    sha256: sha256(content),
  };
}

async function collectScopeFiles(root, rootLabel, report) {
  const contextFiles = [];
  const skills = [];
  const direct = [
    ["CLAUDE.md", "claude", "instructions"],
    ["AGENTS.md", "codex", "instructions"],
    [path.join(".claude", "CLAUDE.md"), "claude", "instructions"],
    [path.join(".codex", "AGENTS.md"), "codex", "instructions"],
  ];
  for (const [relative, source, kind] of direct) {
    const item = await transferFile(path.join(root, relative), { root, rootLabel, source, kind, report });
    if (item) contextFiles.push(item);
  }

  for (const [relative, source, kind] of [
    [path.join(".claude", "rules"), "claude", "context"],
    [path.join(".claude", "memory"), "claude", "memory"],
    [path.join(".codex", "memories"), "codex", "memory"],
  ]) {
    for (const filename of await collectMarkdownFiles(path.join(root, relative), 5, report)) {
      const item = await transferFile(filename, { root, rootLabel, source, kind, report });
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
      report,
    )) {
      const item = await transferFile(filename, { root, rootLabel, source, kind: "instructions", report });
      if (item) skills.push(item);
    }
  }
  return { context_files: contextFiles, skills, mcp_servers: [] };
}

// Only `scheme://…` counts as a URL here. `Authorization: Bearer …` and `C:\dir\server.js` also
// parse as URLs, with the whole value as an opaque path, so sanitizeUrl would hand them back
// verbatim; they belong to the header rule and to the plain-argument rules below.
function urlWithAuthority(value) {
  const text = String(value).trim();
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function redactArgument(value) {
  const text = String(value);
  if (/^[A-Za-z0-9-]+\s*:(?!\/\/)\s*.+/.test(text)) return text.replace(/(:\s*).+$/, "$1<redacted>");
  // A connection string in argv carries its password in the userinfo, where none of the
  // assignment rules can see it.
  if (urlWithAuthority(text)) return sanitizeUrl(text);
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

// Vendor prefixes only. Shapeless high-entropy values (an AWS secret access key, a bare 40-char
// hex string) need entropy scoring and the surrounding context to separate them from digests and
// identifiers; that lands with the redaction layer, not here.
const CREDENTIAL_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  // Slack bot, user, and legacy tokens, then app-level tokens.
  /\bxox[abeoprs]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[0-9]-[A-Za-z0-9-]{10,}/g,
  // Stripe live keys: the underscore defeats the sk- pattern above.
  /\b[sr]k_live_[A-Za-z0-9]{16,}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}\b/g,
  /\bnpm_[A-Za-z0-9]{20,}\b/g,
  /\bhf_[A-Za-z0-9]{20,}\b/g,
  // Three base64url segments: a signed JWT from any issuer.
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
];
// Documentation and .env.example files carry token-shaped strings on purpose. Dropping a whole
// file over one of those costs the user real content, so a named placeholder segment wins.
const PLACEHOLDER_SEGMENT = /(?:^|[-_])(?:your|example|sample|placeholder|redacted|here|x{3,})(?:$|[-_])/i;

function credentialToken(value) {
  const text = String(value).trim();
  for (const pattern of CREDENTIAL_PATTERNS) {
    for (const [match] of text.matchAll(pattern)) {
      if (!PLACEHOLDER_SEGMENT.test(match)) return true;
    }
  }
  return hasUnredactedBearer(text);
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

// These files are markdown, so an assignment most plausibly appears inside a code span, a list
// item, or a block quote. The framing has to come off before the key is read, in either order:
// `- \`TOKEN=…\`` and `` `- TOKEN=…` `` are both real shapes.
function stripMarkdownFraming(line) {
  let text = line.trim();
  for (let pass = 0; pass < 2; pass += 1) {
    text = text.replace(/^(?:[-*+>]\s*)+/, "").replace(/^`+/, "").replace(/`+$/, "").trim();
  }
  return text;
}

function hasCredentialAssignment(line) {
  const trimmed = stripMarkdownFraming(line).replace(/^export /, "").trim();
  const delimiter = trimmed.includes("=") ? "=" : trimmed.includes(":") ? ":" : null;
  if (!delimiter) return false;
  const splitAt = trimmed.indexOf(delimiter);
  const key = trimmed.slice(0, splitAt).trim().replace(/^[\x27"`]+|[\x27"`]+$/g, "");
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return false;
  const lowerKey = key.toLowerCase();
  // A key that *is* the needle — TOKEN, SECRET, PASSWORD, KEY — has to count.
  if (!["key", "token", "secret", "password", "credential", "signature"].some(
    (needle) => lowerKey.includes(needle),
  )) return false;
  const value = trimmed.slice(splitAt + 1).trim().replace(/^[\x27"`]+|[\x27"`]+$/g, "");
  // A colon is prose punctuation as well as an assignment: "Token: describe the token you want"
  // must not cost the user the whole file. A secret is a single token, never a sentence.
  if (delimiter === ":" && /\s/.test(value)) return false;
  const candidate = value.split(/\s+/)[0] || "";
  return candidate.length >= 8 && !isPlaceholderValue(candidate);
}

// A credential documented inline sits inside a code span: Set `MY_TOKEN=…` before running.
function assignmentCandidates(line) {
  const spans = line.match(/`[^`]+`/g) || [];
  return [line, ...spans.map((span) => span.slice(1, -1))];
}

function isPlaceholderValue(value) {
  return value.length < 6
    || value.startsWith("$")
    || value.startsWith("<")
    || value.startsWith("{")
    || /^(?:password|passwd|pass|pw|secret|token|credential|changeme)$/i.test(value)
    || /^(?:example|placeholder|redacted|your[-_])/i.test(value)
    || PLACEHOLDER_SEGMENT.test(value);
}

// scheme://user:password@host — the password sits in the authority, where neither the assignment
// nor the header rule can see it.
const CREDENTIAL_URL = /\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s:/@]*:([^\s/@]+)@/g;

function hasCredentialUrl(content) {
  for (const [, secret] of String(content).matchAll(CREDENTIAL_URL)) {
    if (!isPlaceholderValue(secret)) return true;
  }
  return false;
}

// A credential-bearing header embedded in prose or a shell example, which the whole-line
// assignment parse cannot reach: curl -H "x-api-key: abc123def456".
const CREDENTIAL_HEADER =
  /\b(?:x-)?(?:api[-_]?key|authorization|access[-_]?token|token|secret|password|credential|signature)\s*:\s*([^\s"\x27]{12,})/gi;

function hasCredentialHeader(line) {
  for (const [, value] of stripMarkdownFraming(line).matchAll(CREDENTIAL_HEADER)) {
    // A digit keeps ordinary prose ("Token: configuration") out of a whole-file exclusion.
    if (/\d/.test(value) && !isPlaceholderValue(value)) return true;
  }
  return false;
}

export function containsCredentialLike(content) {
  if (credentialToken(content) || hasCredentialUrl(content)) return true;
  return content
    .split(/\r?\n/)
    .some((line) => assignmentCandidates(line).some(hasCredentialAssignment) || hasCredentialHeader(line));
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

async function readJson(filename, allowedRoot = path.dirname(filename), report = null) {
  const text = await readTextFile(filename, allowedRoot, report);
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

async function collectMcpForProject(projectRoot, rootLabel, claudeConfig, report) {
  const items = [];
  for (const relative of [".mcp.json", path.join(".claude", "settings.json"), path.join(".claude", "settings.local.json")]) {
    const config = await readJson(path.join(projectRoot, relative), projectRoot, report);
    items.push(...normalizeMcpServers(config?.mcpServers, "claude", path.posix.join(rootLabel, relative.split(path.sep).join("/"))));
  }
  const projectConfig = claudeConfig?.projects?.[projectRoot];
  items.push(...normalizeMcpServers(projectConfig?.mcpServers, "claude", ".claude.json"));
  const codexPath = path.join(projectRoot, ".codex", "config.toml");
  const codex = await readTextFile(codexPath, projectRoot, report);
  if (codex !== null) items.push(...parseCodexMcpToml(codex, path.posix.join(rootLabel, ".codex/config.toml")));
  return items;
}

async function collectClaudeProjectMemory(home, projectRoot, rootLabel, warnings) {
  // Claude Code encodes an absolute project path by replacing path separators with `-`.
  // We use this only to locate the directory locally; the absolute path never enters the manifest.
  const encodedProject = projectRoot.split(path.sep).join("-");
  const memoryRoot = path.join(home, ".claude", "projects", encodedProject, "memory");
  const memoryLabel = path.posix.join(rootLabel, ".claude-memory");
  const report = skipReporter(warnings, memoryRoot, memoryLabel);
  const memories = [];
  for (const filename of await collectMarkdownFiles(memoryRoot, 2, report)) {
    const item = await transferFile(filename, {
      root: memoryRoot,
      rootLabel: memoryLabel,
      source: "claude",
      kind: "memory",
      report,
    });
    if (item) memories.push(item);
  }
  return memories;
}

async function discoverProjectRoots(roots, maxDepth, warnings) {
  const projects = new Set();
  async function walk(directory, depth, report) {
    const entries = await safeEntries(directory);
    if (entries.some((entry) => PROJECT_MARKERS.has(entry.name))) projects.add(directory);
    if (depth >= maxDepth) return;
    for (const entry of entries) {
      // A home scan should find user projects, not editor extensions or agent runtime state under
      // directories such as .vscode, .cursor, .openclaw, or .gstack. An explicitly supplied hidden
      // root is still scanned as the root; only hidden descendants are excluded.
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // Only a link to a directory was ever a scan candidate. Resolving the type reads nothing;
        // the link is still refused rather than followed.
        const target = await stat(full).catch(() => null);
        if (target?.isDirectory()) report(full, SYMLINK_REASON);
        continue;
      }
      await walk(full, depth + 1, report);
    }
  }
  for (const root of roots) {
    await walk(root, 0, skipReporter(warnings, root, path.basename(root)));
  }
  return [...projects].sort();
}

async function collectGlobal(home, claudeConfig, report) {
  const rootLabel = "global";
  const contextFiles = [];
  const skills = [];
  for (const [relative, source, kind] of [
    [path.join(".claude", "CLAUDE.md"), "claude", "instructions"],
    [path.join(".codex", "AGENTS.md"), "codex", "instructions"],
    [path.join(".codex", "memories", "MEMORY.md"), "codex", "memory"],
    [path.join(".codex", "memories", "memory_summary.md"), "codex", "memory"],
  ]) {
    const item = await transferFile(path.join(home, relative), { root: home, rootLabel, source, kind, report });
    if (item) contextFiles.push(item);
  }
  for (const [relative, source] of [[path.join(".claude", "skills"), "claude"], [path.join(".codex", "skills"), "codex"]]) {
    // This reaches direct personal skills plus collections such as gstack/<skill>, without
    // descending into nested repos, editor mirrors, fixtures, or caches inside those collections.
    for (const filename of await collectNamedFiles(
      path.join(home, relative),
      new Set(["SKILL.md"]),
      SKILL_SCAN_DEPTH,
      report,
    )) {
      const item = await transferFile(filename, { root: home, rootLabel, source, kind: "instructions", report });
      if (item) skills.push(item);
    }
  }
  const mcpServers = normalizeMcpServers(claudeConfig?.mcpServers, "claude", ".claude.json");
  const codex = await readTextFile(path.join(home, ".codex", "config.toml"), home, report);
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
  const warnings = [];
  const canonicalRoots = [];
  for (const root of roots) {
    const canonical = await realpath(root).catch(() => null);
    if (canonical && !canonicalRoots.includes(canonical)) canonicalRoots.push(canonical);
  }
  const globalReport = skipReporter(warnings, home, "global");
  const claudeConfig = await readJson(path.join(home, ".claude.json"), home, globalReport);
  const canonicalHome = await realpath(home).catch(() => null);
  // The user's home directory contains the global .claude/.codex entrypoints by design. When the
  // CLI is launched from ~, those markers must not manufacture a "home" project Space or cause
  // global skills to be scanned again as project-local skills.
  const projectRoots = (await discoverProjectRoots(canonicalRoots, maxDepth, warnings)).filter(
    (projectRoot) => projectRoot !== canonicalHome,
  );
  const projects = [];
  const envFiles = [];
  for (const projectRoot of projectRoots) {
    const name = path.basename(projectRoot);
    const key = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "project"}-${randomUUID().slice(0, 8)}`;
    const report = skipReporter(warnings, projectRoot, name);
    const scope = await collectScopeFiles(projectRoot, name, report);
    scope.context_files.push(...(await collectClaudeProjectMemory(home, projectRoot, name, warnings)));
    scope.mcp_servers.push(...(await collectMcpForProject(projectRoot, name, claudeConfig, report)));
    removeSensitiveFiles(scope, warnings);
    projects.push({ key, name, source_label: name, ...scope });
    for (const entry of await safeEntries(projectRoot)) {
      if (!entry.name.startsWith(".env")) continue;
      if ([".env.example", ".env.sample", ".env.template"].includes(entry.name)) continue;
      const filename = path.join(projectRoot, entry.name);
      if (entry.isSymbolicLink()) {
        report(filename, SYMLINK_REASON);
        continue;
      }
      if (!entry.isFile()) continue;
      const fingerprint = await fingerprintFile(filename, projectRoot);
      if (!fingerprint) continue;
      envFiles.push({ projectKey: key, projectName: name, filename, allowedRoot: projectRoot, fingerprint, sourceLabel: path.posix.join(name, entry.name) });
    }
  }
  const global = await collectGlobal(home, claudeConfig, globalReport);
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
