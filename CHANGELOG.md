# Changelog

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
