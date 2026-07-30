# Changelog

## Unreleased

The core of Continuity. New subcommands explain a configuration, export it as a redacted
bundle, and land it on another machine; the hosted transfer flow is unchanged and is still
reached by a bare invocation and its own flags.

- `omegas-dev diff` previews exactly what importing a bundle would write, and writes
  nothing at all — no staging directory, no ledger line, no temp file, asserted by a
  byte-comparison of the whole target home before and after.
- `omegas-dev import` applies nothing without a recorded consent against a specific
  rendered diff. `--yes-inert` covers inert additions only; an authority change, an
  executable item, or a write that replaces existing content always needs an individual
  answer, and there is no blanket `--yes` to ask for. A non-interactive run with no consent
  flag prints the plan and exits 3.
- Permission rules are **additions, never merges**. Every array position resolves to an
  append against the array as it stands on the target, so importing the source's rule 3
  cannot overwrite the target's rule 3, and an identical rule already present is a no-op.
  Wildcard-class rules (`Bash(*)`, `WebFetch(domain:*)`) are labelled and hard-blocked from
  any bulk accept.
- Everything executable lands **written but inert**, in the runtime's own disabled idiom —
  `"disabled": true`, `enabled = false`, a `hooks_disabled` block, `skillOverrides: "off"`,
  `[[skills.config]] enabled = false`, or simply no execute bit. `omegas-dev enable
  <item_id>` is the separate second action: it shows the current content, verifies it still
  hashes to the value pinned at import, and refuses on drift.
- The write path stages at `0700` under the target home, snapshots every file it will touch,
  re-verifies the whole plan's fingerprints immediately before each write, writes through
  `O_NOFOLLOW | O_EXCL` temp files plus `rename` with a write-time containment re-check, and
  rolls every file back — verifying each restore — on any failure. New exit codes: 6
  integrity, 7 containment, 8 drift, 9 rolled back.
- Credentials are re-bound on import, one decision per ref, applied to every site that ref
  occupies. A resolved value reaches the target file and nothing else: not the plan, not the
  ledger, not the diff you consent to, which renders the value's *source* instead. Leaving
  one unset is valid and lands the item disabled with a "needs a credential" status.
- A local `ledger.jsonl` records what was imported, from which bundle, on whose say-so, and
  which items are pinned to which content hash. It holds hashes and decisions, never bytes
  and never a credential.
- Security Gate 1 ships: 70+ hostile bundles built in-test — traversal in raw, NFD,
  percent-encoded, backslash and mixed-separator forms, absolute, home-relative and
  drive-letter names, control bytes, overlong paths, case-fold collisions, duplicate
  entries, count and size bombs, tampered digests, truncation, prototype-poisoning key
  paths, identity traversal, `curl | sh` hook plants, shell-spawning MCP servers, `Bash(*)`
  widening, a `bypassPermissions` flip and a `CLAUDE.md` exfiltration payload. Every one is
  blocked or quarantined, with zero writes outside the state directory.
- Hardening found while building the above: bundle entry names that percent-decode into a
  traversal are refused; duplicate entry names are refused rather than silently
  last-wins; entry-count, per-entry and total-size caps are enforced before parsing; and
  path tokenization now only substitutes values that are absolute paths, fixing exported key
  paths being corrupted into `permissions.allow[${XPC_SERVICE_NAME}]` on machines where an
  environment variable holds a one-character value.
- `docs/IMPORT_MODEL.md` documents the trust tiers, consent rules, quarantine and enable
  flow, rollback guarantees and ledger — including an explicit list of what the model does
  not protect against.
- `omegas-dev scan` and `omegas-dev report` read every declared configuration surface and
  explain it: what is configured, which layer it came from, and why a given value wins.
  Both are read-only, and `src/core/` contains no network module, no subprocess and no
  dependency — each asserted by a test rather than promised.
- Runtimes are now described by **data, not code**. An adapter is one inert object
  declaring locations, merge semantics, trust tiers and never-export rules; a single engine
  walks it. Adding a runtime is adding a file. Tests fail the build if an adapter grows a
  function, or if the engine mentions a runtime by name.
- Precedence is computed rather than asserted. Seven merge algebras are implemented, and
  the report shows each contested value with its winner, every contributor that lost and
  the reason — including severity outranking layer precedence, and layers suppressed
  because a runtime does not trust that project.
- Item identity is deterministic and derived from whatever the runtime itself treats as the
  identity, replacing the random per-run key that made re-import and diffing impossible.
  Nested packages in one repository now collapse onto that repository instead of fanning
  out into unrelated projects.
- Refusals became data. A symlink resolving outside every known directory is a listed node
  with a reason; an over-cap file is truncated and recorded with both sizes; every policy
  exclusion is reported with its rule, a count and a unit.
- Configuration is read losslessly. Undocumented keys survive verbatim and are reported as
  findings rather than rewritten or dropped, and edits are applied as byte-range patches so
  comments, key order and formatting cannot be lost.
- Six lints ship, each grounded in a condition found on a real machine — including a hook
  silently muted by a sentinel file, and a permission rule pointing at a directory that no
  longer exists.
- `omegas-dev export` writes a shareable bundle that carries **no credential value**.
  Values become `{{OMEGA_REDACTED:<class>:<ref>}}` placeholders; the key name, position,
  class and site count stay in the clear. The same value anywhere on the machine resolves
  to the same `ref`, which is what stops a key pasted into two places from being caught in
  one and missed in the other. There is no `--include-secrets` flag and no second file.
- Redaction runs as five layers whose results are unioned — position, key name, ~30
  clean-room provider patterns, entropy at declared sinks, and a deep walk of every parsed
  leaf with one bounded base64/percent decode. It reports how sure it is: a value
  recognized by shape is `high`, a value redacted for where it sat is `structural`, and the
  two are separated everywhere they are shown.
- A false positive costs a span, never a file. The 0.1.5 behaviour of dropping a whole file
  on any match is gone; a skill that documents credential shapes now survives byte for byte.
- Recall is measured rather than claimed. A seeded corpus of 212 fake credentials spread
  across every surface the scanner reads runs on every build and asserts per-tier recall,
  alongside a precision corpus of the placeholders and example keys that must survive.
- Before a bundle reaches the disk the tool re-scans its own serialized bytes with the full
  detector and aborts on any HIGH-tier hit, writing nothing and exiting `5`.
- The bundle digest is content-addressed and excludes `bundle.id` and `created_at`, so two
  exports of an unchanged setup agree. Entry names are canonicalized on write and re-checked
  on read, where a violation is a refusal rather than a repair.
- `docs/BUNDLE_FORMAT.md` publishes the format: digest algorithm and scope, canonicalization
  rules, placeholder grammar, redaction header, caps and `payload_policy`.

## 0.1.5

Hardening release. No new surfaces are read and nothing new is uploaded.

- The local preview moved from `~/Downloads` to `~/.omegas/state/previews`, inside
  owner-only directories and still created with mode `0600`. The run now ends by offering
  to delete it; the default answer keeps the file, non-interactive runs are not prompted,
  and `--output` still overrides the location.
- Files the scan refuses are reported instead of vanishing. Files over 256 KB and refused
  symlinks now each produce a warning naming the path, in every walker. A skills directory
  made entirely of symlinks previously reported zero skills and said nothing.
- Redaction fixes:
  - A key that *is* the credential word now counts. `TOKEN=`, `KEY=`, `SECRET=`, and
    `PASSWORD=` were missed; only prefixed keys such as `MY_TOKEN=` were caught.
  - Assignments framed as markdown are read through the framing: code spans, list items,
    and block quotes.
  - Any MCP argument that parses as a `scheme://` URL is sanitized. This closes the
    connection-string leak that kept `postgresql://user:password@host/db` verbatim in the
    preview, including its password.
  - Added Slack, Stripe live, Google, npm, Hugging Face, and JWT token shapes, plus
    detection of credential-bearing URLs and headers such as `x-api-key: …`.
  - Precision held: `${VAR}`, `<YOUR_TOKEN>`, `your-token-here`, `.env.example` values, and
    short values are still kept, and a colon line whose value is a sentence is treated as
    prose rather than an assignment.
- Known limit, unchanged: shapeless high-entropy values, such as an AWS secret access key
  or a bare hex string with nothing naming it, are not detected. That needs the
  entropy-aware redaction layer.
- `--help` is listed in the help output. README and SECURITY.md describe the new preview
  location and state the detector's limits.

## 0.1.4

- Published the source in a dedicated public repository.
- Reframed the CLI around visualizing, understanding, and transferring personal Claude
  Code and Codex configuration.
- Added public contribution guidance and continuous integration.
- Updated npm metadata to point to the public source and issue tracker.

## 0.1.3

- Added authenticated terminal-to-browser confirmation before upload.
- Added local preview generation and explicit upload approval.
- Added safe discovery for instructions, skills, memories, MCP metadata, and optional
  secret-file bundles.
