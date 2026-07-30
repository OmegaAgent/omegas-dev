# Changelog

## 0.2.0

The Continuity release. New subcommands explain a configuration, export it as a redacted
bundle, land it on another machine, and say what would survive a move to a different
runtime; the hosted transfer flow is unchanged and is still reached by a bare invocation
and its own flags.

### Compatibility, derived rather than maintained

- `omegas-dev compat` prints what would survive moving a configuration between runtimes:
  a matrix of NATIVE / CONVERT / ADVISE / UNSUPPORTED / UNKNOWN, the losses behind every
  CONVERT, the source-only keys that survive a move but are ignored on the other side, and
  the evidence citation behind each verdict. `report` carries the same table as a section.
- **There is no hand-written matrix anywhere in the codebase.** Every cell is computed from
  the two adapters' capability declarations plus the transform table, and a golden test
  compares the computed table against the researched verdicts, cell by cell. Two cells
  disagree with the research; both are named in the test with the reason, rather than
  quietly adjusted (see *Known limits*).
- Kind-level and item-level verdicts are separate questions. `mcp_server` converts
  Claude → Codex as a kind, and an individual entry declaring a websocket transport is
  UNSUPPORTED for that entry alone — reported as an exception against its kind's headline,
  because a matrix on its own would misrepresent it.
- Some losses are **computed, not declared**: a key in an item's `unrecognized` bag is
  checked against what the target format can physically hold, so a null-valued key headed
  for TOML is listed as a loss without anyone having written it down. This is what keeps
  the loss list from drifting as the runtimes add keys.
- UNKNOWN and UNSUPPORTED stay different claims. UNSUPPORTED means checked and impossible;
  UNKNOWN means not built. Every cell involving an unsurveyed runtime reads UNKNOWN, and
  that runtime is listed rather than hidden — so "we don't support Hermes" can never be
  mistaken for "you don't have Hermes". The same applies at item level: an MCP entry using
  the SSE transport, whose Codex status the research could not confirm either way, is
  UNKNOWN rather than a negative nobody earned.
- A CONVERT that lists no loss is now a build failure: the adapter registry rejects any
  transform declaring `fidelity: "convert"` with an empty `drops[]`, because a conversion
  that loses nothing is a relocation and should say so.

### The local HTML report

- `omegas-dev report --html <out.html> --bundle <bundle.ocb.jsonl>` writes ONE
  self-contained page: environment and runtimes, items by kind with provenance and
  portability verdicts, every contested value with its winner and the reason each
  contributor lost, the derived compatibility matrix with its losses, findings, the
  redaction summary, and the refusals and limits with their units.
- It is **rendered from the redacted bundle and from nothing else**. The renderer takes a
  bundle path, verifies it through the same reader an importer uses, and refuses any input
  that is not a sealed manifest — including one wearing the right `schema_version` while
  carrying engine-internal fields. There is no code path from a live scan to a shareable
  page, which is the point: the screenshot of a raw scan is the leak.
- It references nothing on a network. No script tag, no stylesheet link, no font, no image,
  no `fetch`, no telemetry, and no JavaScript at all — a test asserts the absence of every
  request-initiating construct, and the page declares a `default-src 'none'` policy on top.
  Values are escaped text, so a URL you configured shows up as characters rather than as
  something a browser would load.
- Light and dark are both handled by `prefers-color-scheme`, with the whole stylesheet
  inline. The file lands `0600`: a complete picture of a configuration is safe to
  screenshot deliberately, which is not the same as safe to leave world-readable.

### Cutover parity

- `src/hosted/local-transfer-v1.js` projects a Continuity bundle into the legacy
  `omegas.local-transfer.v1` payload the hosted API already accepts. It is a pure function
  of the manifest — no filesystem, no network, no clock — and it is deliberately **not
  wired into the upload path**; a test asserts no shipping module imports it.
- Parity is proven, not asserted: both scanners run over the same fixture homes in-test and
  every file, skill and MCP server the legacy scanner finds is matched field for field.
  Every difference is enumerated with its reason — deterministic project keys instead of a
  fresh random key per run, redacted content instead of raw bytes, and no whole-file
  dropping for looking credential-like.
- The comparison also documents three things the new scanner finds and the old one misses:
  `AGENTS.override.md` (whose entire semantic is replacing `AGENTS.md`), a skill reached
  through a symlink that stays inside a declared root, and the environment variable names
  of an MCP server declared with a TOML inline table, which the old line-based scanner
  could not parse. `docs/CUTOVER.md` records what parity has been proven, what has not, and
  the rollback story.

### Release engineering

- Every release gate is a named npm script — `gate:purity`, `gate:secrets`, `gate:network`,
  `gate:adversarial`, `gate:noop`, `gate:compat`, `gate:cutover` — and each runs as its own
  step in CI across Node 20, 22 and 24, so a failure names the property that broke. CI also
  asserts zero production dependencies and that no test or fixture file can be published.
- `docs/RELEASE_CHECKLIST.md` gates publishing, starting with the blocking founder item.

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

### Known limits

Carried forward and added to, because a release that only lists what works is advertising.

- **Shapeless high-entropy values are still not detected by shape.** An AWS secret access
  key or a bare hex string with nothing naming it is caught only when it sits in a declared
  secret position. This is unchanged from 0.1.5; the entropy layer narrowed it, it did not
  close it.
- **Cross-runtime transfer is preview and report only.** Claude ⇄ Codex conversions are
  derived, explained and shown in the write plan, and `import` refuses to apply them.
  Same-runtime (machine → machine) is the only path that writes.
- **Two compatibility cells disagree with the research**, both about the same fact placed
  in a different row. `permission_rule` codex → claude derives UNSUPPORTED because Codex
  declares no surface of that kind, and `rule_script` codex → claude derives ADVISE because
  a transform for it is declared with an evidence citation. The research's §3.2 table puts
  the advisory verdict in the first row and UNSUPPORTED in the second. Both are asserted in
  `test/compat.test.js` with the reasoning, and neither expectation was edited to match the
  code.
- **Coverage gaps are ours, not the runtimes'.** `omegas-dev compat` lists every kind a
  runtime supports that Continuity does not yet read — Codex hook scripts and keybindings
  today — so a surface nobody has implemented never reads as a capability that does not
  exist.
- **Transcripts, history and session state are out of scope by design**, not pending. They
  are the highest-density secret store on a developer machine and no rule reads them.
- **Claude's auto-memory items carry the munged project directory name**, which encodes the
  absolute project path of the machine that produced them. That name reaches the bundle.
  It is a filesystem-layout disclosure inside an artifact meant to be shareable; the fix is
  tokenizing that path segment, and it is tracked as the first item after this release.
- **No Hermes adapter.** It exists as an identity with zero surfaces and is reported as
  UNKNOWN everywhere, which is the honest state rather than a gap being hidden.

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
