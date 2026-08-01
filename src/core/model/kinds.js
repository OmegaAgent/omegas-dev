// The canonical vocabulary (manifest §1.2). Closed, extensible only by adapter
// declaration. Kinds marked v1.1 are RESERVED but not populated in v1, so a bundle
// never changes shape when the rest land.
//
// This is the only module an adapter may import. Everything else about an adapter is
// inert data.

export const CANONICAL_KINDS = [
  // v1 — populated
  "instructions",
  "skill",
  "command",
  "mcp_server",
  "hook",
  "hook_script",
  "subagent",
  "memory",
  "setting",
  "permission_rule",
  "sandbox_profile",
  "rule_script",
  // v1.1 — reserved
  "plugin",
  "marketplace",
  "model_provider",
  "output_style",
  "statusline",
  "keybindings",
  "launch_config",
  // refusals and unknowns are first-class kinds, never a silence
  "unresolved_link",
  "opaque",
];

export const RESERVED_V1_1_KINDS = [
  "plugin",
  "marketplace",
  "model_provider",
  "output_style",
  "statusline",
  "keybindings",
  "launch_config",
];

export function isCanonicalKind(kind) {
  return CANONICAL_KINDS.includes(kind);
}

// THR §3.4. Escalation only: content may raise a tier (a skill shipping an exec-bit
// script becomes EXECUTABLE) but nothing ever lowers one.
export const TRUST_TIERS = { INERT: 0, DECLARATIVE: 1, EXECUTABLE: 2 };

export function maxTier(a, b) {
  return TRUST_TIERS[a] >= TRUST_TIERS[b] ? a : b;
}

// Manifest §3.3 — seven, because a single merge abstraction is wrong for at least two
// of every three surfaces (COD §5.6).
export const ALGEBRAS = [
  "override",
  "override_whole_entry",
  "concatenate",
  "first_non_empty",
  "aggregate",
  "union_with_resolution",
  "coexist",
];

export const SCOPES = ["managed", "system", "user", "profile", "project", "local", "plugin", "session"];

export const PORTABILITY_VERDICTS = ["PORTABLE", "REWRITE", "MACHINE-LOCAL", "SECRET", "DERIVED"];

export const CAPABILITY_LEVELS = ["native", "convertible", "advisory", "unsupported"];

export const FIDELITY = ["NATIVE", "CONVERT", "ADVISE", "UNSUPPORTED", "UNKNOWN"];

export const FORMATS = [
  "md",
  "md+frontmatter",
  "json",
  "jsonc",
  "toml",
  "jsonl",
  "yaml",
  "starlark",
  "dotenv",
  "binary",
  "none",
];

export const SEVERITIES = ["info", "warn", "critical"];

// adapter-architecture §1.3 emit block. `none` is how a surface declares that Continuity
// reads it but never writes it — an org-owned layer, a re-resolvable cache, a never-export
// sink. It is a first-class answer, not a missing one.
export const WRITE_MODES = ["create_file", "merge_key", "append_section", "relocate_dir", "none"];

/**
 * The closed set of quarantine idioms (THR §3.4). Each is the RUNTIME's own way of saying
 * "present but inert", which is why quarantine costs nothing to implement and reads as
 * native to the user:
 *
 *   in_entry         a key inside the written entry     (`enabled = false`, `disabled: true`)
 *   relocate_key     the entry moves to a parked bucket (`hooks` -> `hooks_disabled`)
 *   companion_key    an enable-state key in another file(`skillOverrides.<name>: "off"`)
 *   companion_entry  a row in another file's table       (`[[skills.config]] enabled = false`)
 *   no_exec_bit      the file lands without the exec bit (skill scripts, hook scripts)
 */
export const DISABLED_FORM_MODES = ["in_entry", "relocate_key", "companion_key", "companion_entry", "no_exec_bit"];
