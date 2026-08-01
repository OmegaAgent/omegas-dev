// Manifest §5.5. Every cap breach is a REPORTED condition, never a silent truncation:
// a scan that drops anything without a record fails its own self-check. The 0.1.4
// defect this closes is a 360 KB rules file that vanished with no `Skipped:` line
// (INV §4.6).

export const CAPS = {
  file_bytes: 1024 * 1024,
  entry_blob_bytes: 4 * 1024 * 1024,
  entries: 5000,
  items: 20000,
  bundle_bytes: 64 * 1024 * 1024,
  depth: 16,
  link_hops: 4,
  // Bounds that keep one walk from becoming a whole-disk scan.
  ancestor_depth: 4,
  sweep_depth: 4,
  walk_entries: 20000,
  project_depth: 4,
};

export function capsFor(overrides) {
  return { ...CAPS, ...(overrides ?? {}) };
}

export const IGNORED_DIRS = new Set([
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

/**
 * Runtime-agnostic never-export rules (manifest §5.4, "Outside the agent roots"). The
 * per-runtime rows live in each adapter, because they are that runtime's own layout;
 * these are true regardless of which agent is installed.
 */
export const GLOBAL_NEVER_EXPORT = [
  {
    rule_id: "global.ssh",
    match: "${HOME}/.ssh/**",
    class: "auth",
    severity: "hard",
    reason: "private keys and known-hosts; outside every agent root and never in scope",
  },
  {
    rule_id: "global.cloud_credentials",
    match: "${HOME}/{.aws,.gnupg,.docker}/**",
    class: "auth",
    severity: "hard",
    reason: "cloud and signing credentials; outside every agent root and never in scope",
  },
  {
    rule_id: "global.dotfile_credentials",
    match: "${HOME}/{.netrc,.npmrc,.pypirc}",
    class: "auth",
    severity: "hard",
    reason: "plaintext registry and host credentials",
  },
  {
    rule_id: "global.key_material",
    match: "${HOME}/**/{id_rsa,id_ed25519,id_ecdsa,id_dsa}",
    class: "auth",
    severity: "hard",
    reason: "private key material matched by name anywhere under home",
  },
  {
    rule_id: "global.certificates",
    match: "${HOME}/**/*.{pem,p12,pfx,key}",
    class: "auth",
    severity: "hard",
    reason: "certificate and private-key files matched by extension anywhere under home",
  },
  {
    rule_id: "global.keychain",
    match: "${HOME}/Library/Keychains/**",
    class: "auth",
    severity: "hard",
    reason: "the OS keychain is never invoked and never read, in any tier",
  },
];
