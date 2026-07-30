// Path tokenization, containment, glob and key-path matching. No I/O: everything here
// is a pure string operation so the engine can reason about a location without touching
// the disk.

import path from "node:path";

// discovery.js:45-48 — the relative-path check with the `..${sep}` prefix test. Ported
// rather than re-derived; it is the one containment primitive the baseline got right.
export function insideRoot(root, filename) {
  const relative = path.relative(root, filename);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export function toPosix(value) {
  return String(value).split(path.sep).join("/");
}

/**
 * `${NAME}`, `${NAME:-fallback}` (the fallback may itself contain templates), and
 * `${root:<root_id>}` for the per-platform roots that cannot be written as one string.
 * Unresolvable references are left verbatim so a caller can test for `${` and skip the
 * location rather than silently expanding to a wrong path.
 */
export function expandTemplate(template, vars) {
  const text = String(template ?? "");
  let out = "";
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("${", i);
    if (open === -1) {
      out += text.slice(i);
      break;
    }
    out += text.slice(i, open);
    const close = matchingBrace(text, open + 1);
    if (close === -1) {
      out += text.slice(open);
      break;
    }
    const body = text.slice(open + 2, close);
    const split = topLevelDefault(body);
    const name = split === -1 ? body : body.slice(0, split);
    const fallback = split === -1 ? null : body.slice(split + 2);
    if (Object.prototype.hasOwnProperty.call(vars, name) && vars[name] !== undefined && vars[name] !== null) {
      out += String(vars[name]);
    } else if (fallback !== null) {
      out += expandTemplate(fallback, vars);
    } else {
      out += text.slice(open, close + 1);
    }
    i = close + 1;
  }
  return out;
}

function matchingBrace(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function topLevelDefault(body) {
  let depth = 0;
  for (let i = 0; i < body.length - 1; i += 1) {
    if (body[i] === "{") depth += 1;
    else if (body[i] === "}") depth -= 1;
    else if (depth === 0 && body[i] === ":" && body[i + 1] === "-") return i;
  }
  return -1;
}

export function isUnresolved(value) {
  return String(value).includes("${");
}

/**
 * Only values that are ABSOLUTE PATHS may stand in for a token. The token table is seeded
 * from the process environment, where a variable holding a one-character value is normal
 * (macOS sets `XPC_SERVICE_NAME=0`); substituting that by value rewrites every array index
 * in every key path into `${XPC_SERVICE_NAME}`, which the import planner then cannot
 * address. A token substitution is a path substitution or it is nothing.
 */
function pathTokens(env) {
  return Object.entries(env.tokens ?? {}).filter(
    ([name, value]) =>
      typeof value === "string" &&
      !name.includes(":") &&
      (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) &&
      value.length > 1,
  );
}

/**
 * Manifest §1.3 / THR C2 — `origin.path` is tokenized, so a bundle carries no username
 * and no machine layout. Longest value first, otherwise `${HOME}` would shadow
 * `${CLAUDE_HOME}`.
 */
export function tokenize(absPath, env) {
  const out = toPosix(absPath);
  // Projects first, longest first: a project usually lives INSIDE the home directory, so
  // checking `${HOME}` first would swallow every project path. Longest-first also picks
  // the nested package over the repository root in a monorepo.
  const projects = [...(env.projects ?? [])].sort((a, b) => String(b.path).length - String(a.path).length);
  for (const project of projects) {
    const posix = toPosix(project.path);
    if (out === posix) return "${PROJECT}";
    if (out.startsWith(`${posix}/`)) return `\${PROJECT}${out.slice(posix.length)}`;
  }
  const pairs = pathTokens(env).sort((a, b) => b[1].length - a[1].length);
  for (const [token, value] of pairs) {
    const posix = toPosix(value);
    if (out === posix) return `\${${token}}`;
    if (out.startsWith(`${posix}/`)) return `\${${token}}${out.slice(posix.length)}`;
  }
  return out;
}

/**
 * Tokenize absolute paths that appear INSIDE a larger string — a key path like
 * `projects."/Users/x/code/app".mcpServers.slack` embeds one, and `origin.key_path` is an
 * origin field, so it may not carry a machine layout either (THR C2).
 */
export function tokenizeWithin(text, env) {
  const candidates = [
    ...(env.projects ?? []).map((project) => ["${PROJECT}", toPosix(project.path)]),
    ...pathTokens(env).map(([name, value]) => [`\${${name}}`, toPosix(value)]),
  ].sort((a, b) => b[1].length - a[1].length);
  let out = String(text);
  for (const [token, value] of candidates) {
    if (!value) continue;
    out = out.split(value).join(token);
    // A runtime that encodes an absolute path into a single directory name (separators
    // replaced by `-`) leaks the same layout in a different spelling, so the encoded form
    // is substituted too.
    const encoded = value.split("/").join("-");
    if (encoded !== value) out = out.split(encoded).join(`${token}:encoded`);
  }
  return out;
}

export function displayPath(absPath, homeDir) {
  const out = toPosix(absPath);
  const home = toPosix(homeDir);
  if (out === home) return "~";
  if (out.startsWith(`${home}/`)) return `~${out.slice(home.length)}`;
  return out;
}

/**
 * A refused link must be describable without leaking a machine layout (THR C2/E4).
 * The author-written relative target is both truthful and machine-independent.
 */
export function linkLabel(resolved, rawTarget, homeDir) {
  const home = toPosix(homeDir);
  if (resolved && (toPosix(resolved) === home || toPosix(resolved).startsWith(`${home}/`))) {
    return displayPath(resolved, homeDir);
  }
  if (rawTarget && !path.isAbsolute(rawTarget)) return rawTarget;
  const segments = toPosix(resolved ?? rawTarget ?? "").split("/").filter(Boolean);
  return `…/${segments.slice(-2).join("/")}`;
}

// ── globs ───────────────────────────────────────────────────────────────────────────
// Supports `*` (one segment), `**` (any depth), `?`, and `{a,b}` alternation, which the
// never-export table uses to keep one rule per class instead of one rule per directory.

export function globToRegExp(pattern, { capture = false } = {}) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += capture ? "(.*)" : ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        out += capture ? "([^/]*)" : "[^/]*";
      }
      continue;
    }
    if (c === "?") {
      out += capture ? "([^/])" : "[^/]";
      continue;
    }
    if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close !== -1) {
        const options = pattern.slice(i + 1, close).split(",").map(escapeRegExp);
        out += `(?:${options.join("|")})`;
        i = close;
        continue;
      }
    }
    out += escapeRegExp(c);
  }
  return new RegExp(`^${out}$`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function globMatch(pattern, candidate) {
  return globToRegExp(pattern).test(toPosix(candidate));
}

/** Wildcard captures in order, or null. Used to expand `{0}`,`{1}` in an identity template. */
export function globCaptures(pattern, candidate) {
  const match = globToRegExp(pattern, { capture: true }).exec(toPosix(candidate));
  return match ? match.slice(1) : null;
}

export function hasGlob(value) {
  return /[*?{]/.test(String(value));
}

// ── key paths ───────────────────────────────────────────────────────────────────────
// Dot-separated segments; array indices are `[i]`. `*` matches one non-index segment,
// `[*]` one index, `**` any depth. `$` is the whole item (deep-scan, never an
// unconditional match — spike-corrections §2).

export function splitKeyPath(keyPath) {
  if (!keyPath) return [];
  return String(keyPath)
    .replace(/\[(\d+|\*)\]/g, ".[$1]")
    .split(".")
    .filter((segment) => segment !== "");
}

export function joinKeyPath(...parts) {
  return parts
    .filter((part) => part !== "" && part !== null && part !== undefined)
    .reduce((acc, part) => {
      const text = String(part);
      if (!acc) return text;
      return text.startsWith("[") ? `${acc}${text}` : `${acc}.${text}`;
    }, "");
}

export function matchKeyPattern(pattern, keyPath) {
  return captureKeyPattern(pattern, keyPath) !== null;
}

export function captureKeyPattern(pattern, keyPath) {
  if (pattern === "$") return [];
  const p = splitKeyPath(pattern);
  const k = splitKeyPath(keyPath);
  const captures = [];
  return walkKeyPattern(p, 0, k, 0, captures) ? captures : null;
}

function segmentMatches(segment, actual) {
  if (segment === "*") return !/^\[\d+\]$/.test(actual);
  if (segment === "[*]") return /^\[\d+\]$/.test(actual);
  if (segment.includes("{") || segment.includes("*")) return globMatch(segment, actual);
  return segment === actual;
}

function walkKeyPattern(p, pi, k, ki, captures) {
  if (pi === p.length) return ki === k.length;
  const segment = p[pi];
  if (segment === "**") {
    for (let next = ki; next <= k.length; next += 1) {
      const branch = captures.slice();
      if (walkKeyPattern(p, pi + 1, k, next, branch)) {
        captures.length = 0;
        captures.push(...branch);
        return true;
      }
    }
    return false;
  }
  if (ki === k.length) return false;
  if (!segmentMatches(segment, k[ki])) return false;
  if (segment === "*" || segment === "[*]") captures.push(k[ki].replace(/^\[|\]$/g, ""));
  return walkKeyPattern(p, pi + 1, k, ki + 1, captures);
}

/** True when the pattern matches the leaf itself or any of its ancestors. */
export function matchesPrefix(pattern, keyPath) {
  const segments = splitKeyPath(keyPath);
  for (let end = segments.length; end > 0; end -= 1) {
    if (matchKeyPattern(pattern, rebuildKeyPath(segments.slice(0, end)))) return true;
  }
  return false;
}

export function rebuildKeyPath(segments) {
  return segments.reduce((acc, segment) => {
    if (segment.startsWith("[")) return `${acc}${segment}`;
    return acc ? `${acc}.${segment}` : segment;
  }, "");
}

// ── bundle entry names ──────────────────────────────────────────────────────────────
// Manifest §5.2 — applied on write AND re-applied on read. A violation on read is a hard
// refusal, not a repair (THR §3.4, T-I1). Lands in M1 so M2's writer inherits it.

const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const ENTRY_PREFIXES = ["blobs/", "items/", "derived/"];

/**
 * One bounded decode pass, then re-check.
 *
 * `blobs/%2e%2e%2fetc/passwd` carries no literal `..`, so a check on the raw bytes passes
 * it. This reader never decodes an entry name — but the bundle format is published, and a
 * second implementation that does decode would build a traversal out of a name we called
 * safe. A name that DECODES to a separator, a parent segment or a control byte is refused
 * on that basis alone, and the refusal names the decoded form.
 */
function percentDecoded(raw) {
  if (!/%[0-9a-fA-F]{2}/.test(raw)) return null;
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === raw ? null : decoded;
  } catch {
    return raw;
  }
}

function decodesToTraversal(raw) {
  const decoded = percentDecoded(raw);
  if (decoded === null) return false;
  if (decoded === raw) return true;
  const segments = decoded.split("/");
  return (
    decoded.includes("\\") ||
    decoded.startsWith("/") ||
    decoded.startsWith("~") ||
    /^[A-Za-z]:/.test(decoded) ||
    /[\u0000-\u001F\u007F-\u009F]/.test(decoded) ||
    segments.some((segment) => segment === ".." || segment === "." || segment === "") ||
    segments.length !== raw.split("/").length
  );
}

export function canonicalEntryName(name, seenFold) {
  const raw = String(name);
  if (raw.normalize("NFC") !== raw) return rejectEntry(raw, "not Unicode NFC");
  if (decodesToTraversal(raw)) return rejectEntry(raw, "percent-encoding decodes to a path separator or parent segment");
  if (raw.includes("\\")) return rejectEntry(raw, "backslash separator");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) {
    return rejectEntry(raw, "absolute or home-relative entry name");
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(raw)) return rejectEntry(raw, "control byte in entry name");
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return rejectEntry(raw, "empty, dot or parent segment");
  }
  if (segments.length > 16) return rejectEntry(raw, "path depth over 16");
  if (segments.some((segment) => Buffer.byteLength(segment) > 255)) return rejectEntry(raw, "segment over 255 bytes");
  if (Buffer.byteLength(raw) > 1024) return rejectEntry(raw, "path over 1024 bytes");
  if (segments.some((segment) => RESERVED_WIN.test(segment) || /[. ]$/.test(segment))) {
    return rejectEntry(raw, "reserved Windows basename or trailing dot/space");
  }
  if (!ENTRY_PREFIXES.some((prefix) => raw.startsWith(prefix))) {
    return rejectEntry(raw, `entry name outside the fixed prefix set (${ENTRY_PREFIXES.join(", ")})`);
  }
  if (seenFold) {
    const folded = raw.toLowerCase();
    if (seenFold.has(folded) && seenFold.get(folded) !== raw) {
      return rejectEntry(raw, `case-fold collision with ${seenFold.get(folded)}`);
    }
    seenFold.set(folded, raw);
  }
  return { ok: true, name: raw };
}

function rejectEntry(name, reason) {
  return { ok: false, name, reason };
}

// ── import-side path fragments ──────────────────────────────────────────────────────
// An entry NAME is not the only attacker-controlled string that reaches a filesystem
// target. An item's identity is interpolated into its surface's emit template
// (`${CLAUDE_HOME}/skills/{identity}/`), so an identity of `../../.ssh` is the same
// zip-slip with a different spelling (THR T-I1). The same rules apply, minus the fixed
// prefix set, which is a bundle-entry convention rather than a path property.

export function canonicalRelPath(fragment, { allowSlash = true } = {}) {
  const raw = String(fragment ?? "");
  if (raw.length === 0) return rejectEntry(raw, "empty path fragment");
  if (raw.normalize("NFC") !== raw) return rejectEntry(raw, "not Unicode NFC");
  if (decodesToTraversal(raw)) return rejectEntry(raw, "percent-encoding decodes to a path separator or parent segment");
  if (raw.includes("\\")) return rejectEntry(raw, "backslash separator");
  if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.startsWith("~")) {
    return rejectEntry(raw, "absolute or home-relative path fragment");
  }
  if (/[\u0000-\u001F\u007F-\u009F]/.test(raw)) return rejectEntry(raw, "control byte in path fragment");
  if (!allowSlash && raw.includes("/")) return rejectEntry(raw, "path separator in a single-segment fragment");
  const segments = raw.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return rejectEntry(raw, "empty, dot or parent segment");
  }
  if (segments.length > 16) return rejectEntry(raw, "path depth over 16");
  if (segments.some((segment) => Buffer.byteLength(segment) > 255)) return rejectEntry(raw, "segment over 255 bytes");
  if (Buffer.byteLength(raw) > 1024) return rejectEntry(raw, "path over 1024 bytes");
  if (segments.some((segment) => RESERVED_WIN.test(segment) || /[. ]$/.test(segment))) {
    return rejectEntry(raw, "reserved Windows basename or trailing dot/space");
  }
  return { ok: true, name: raw };
}

// `__proto__` in a key path is the JSON tree's version of the same escape: a write at
// `mcpServers.__proto__.command` mutates every object downstream instead of one entry.
const POISONED_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function canonicalKeyPath(keyPath) {
  const raw = String(keyPath ?? "");
  if (raw.length === 0) return { ok: false, name: raw, reason: "empty key path" };
  if (raw.normalize("NFC") !== raw) return { ok: false, name: raw, reason: "not Unicode NFC" };
  if (/[\u0000-\u001F\u007F-\u009F]/.test(raw)) return { ok: false, name: raw, reason: "control byte in key path" };
  if (raw.includes("${")) return { ok: false, name: raw, reason: "unexpanded token in key path" };
  if (Buffer.byteLength(raw) > 1024) return { ok: false, name: raw, reason: "key path over 1024 bytes" };
  const segments = splitKeyPath(raw);
  if (segments.length === 0) return { ok: false, name: raw, reason: "empty key path" };
  if (segments.length > 24) return { ok: false, name: raw, reason: "key depth over 24" };
  for (const segment of segments) {
    if (POISONED_KEYS.has(segment)) return { ok: false, name: raw, reason: `prototype-poisoning key "${segment}"` };
    if (segment === "*" || segment === "**" || segment === "[*]") {
      return { ok: false, name: raw, reason: "wildcard in a concrete key path" };
    }
  }
  return { ok: true, name: raw, segments };
}

/** The Continuity state directory, always resolved against the TARGET home, never `os.homedir()`. */
export function continuityStateDir(homeDir) {
  return path.join(homeDir, ".omegas", "continuity");
}
