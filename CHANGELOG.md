# Changelog

## Unreleased

The read-only core of Continuity. Two new subcommands explain a configuration; the hosted
transfer flow is unchanged and is still reached by a bare invocation and its own flags.

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
