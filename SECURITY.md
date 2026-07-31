# Security

## Reporting

Do not open a public issue containing credentials, configuration, transfer codes or
filesystem details. Email `hello@omegas.dev` with the subject `continuity security`.
Include the minimum reproduction needed, and never send a live secret — a redacted bundle
(`continuity export`) is usually enough, and is designed for exactly this.

If you found a secret of your own while using the tool, rotate it first and report second.

---

## What this tool is trusted with

It reads a developer's entire agent configuration, which is one of the more sensitive
things on the machine: instructions, permission rules, hook scripts, MCP server definitions
and, unavoidably, the credentials people have pasted into all of those. Three properties
follow from that, and each is enforced by a test rather than by intent.

**1. The local core cannot reach the network.** `src/core/` imports no `node:http(s)`,
`node:net`, `node:dns`, `node:tls`, `node:dgram`, `node:child_process` or
`node:worker_threads`, calls no `fetch`, spawns nothing, and imports nothing outside
itself. A separate test runs a full scan → redact → export → import-preview cycle with
`fetch`, `net.connect` and `dns.lookup` stubbed to throw. There are zero runtime
dependencies, so there is no transitive code to audit.

**2. Secret values never travel.** The one shareable artifact is the redacted one. There is
no `--include-secrets` flag and no second complete file. Before a bundle reaches the disk,
its serialized bytes are re-scanned with the full detector and a high-confidence hit aborts
the write entirely (exit `5`). The HTML report is rendered from that bundle and cannot be
handed a raw scan.

**3. Nothing is written without consent.** `scan`, `report`, `compat` and `diff` write
nothing at all. `import` applies only what was individually accepted against a specific
rendered diff, lands every executable item disabled, and rolls back in full on any failure.

## Reading

- Files are opened read-only with `O_NOFOLLOW`, and their identity (device, inode, size,
  mtime) is verified before and after reading, so a file swapped mid-read is an abort
  rather than a silent substitution.
- Symlinks get one of three outcomes: resolved when the target stays inside a declared
  root, recorded as a crossing when it lands in another declared root, or refused and
  listed as an `unresolved_link` item with its reason. There is no silent skip.
- Reads are bounded: per-file bytes, walk depth, entry counts, link hops. A breach is
  truncated and reported with both sizes, never dropped.
- Never-export rules keep whole classes out of every artifact: account, org and billing
  identity; machine and user fingerprints; trust decisions such as "this repo is trusted"
  or "these `.mcp.json` servers are approved"; OAuth locks and IPC state; and all
  transcripts and prompt history.

## Redaction

Five layers, unioned: declared secret positions, credential-named keys, clean-room provider
patterns, entropy scoring at declared sinks, and a deep walk of every parsed leaf with one
bounded base64/percent decode.

- A value replaced by a placeholder keeps its **class, key name, position and site count**
  in the clear. That is deliberate: it is what makes the redaction auditable and what lets
  a credential be re-bound on the target machine without ever moving it.
- The same value found in several places resolves to one `ref` with several sites, so a key
  pasted twice cannot be caught in one place and missed in the other.
- Confidence is reported, not flattened: a value recognized by shape is `high`, a value
  redacted for where it sat is `structural`, and the two are labelled separately everywhere
  they appear.
- A false positive costs a span, never a file. A skill that documents credential shapes
  survives byte for byte.
- Recall is measured on every build against a seeded corpus of 212 fake credentials spread
  across every surface the scanner reads.

## Importing a bundle

A bundle from someone else is hostile input and is treated as such.

- Entry names are canonicalized on write and re-checked on read. Traversal in raw, NFD,
  percent-encoded, backslash and mixed-separator forms, absolute and drive-letter names,
  control bytes, overlong paths, case-fold collisions and duplicate entries are refused
  with an exit code, not repaired.
- Digest mismatch, unknown `schema_version`, entry-count and size bombs are refused before
  anything is parsed into a planner.
- Writes are staged at `0700`, snapshotted, fingerprint-re-verified immediately before each
  write, made through `O_NOFOLLOW | O_EXCL` temp files plus `rename` with a write-time
  containment re-check, and rolled back in full — each restore verified — on any failure.
- Everything executable lands inert, in the runtime's own disabled idiom. Enabling it is a
  separate command that re-verifies the content hash pinned at import.
- Distinct exit codes exist so an automated consumer can tell "retry" from "stop and tell a
  human": `5` redaction gate, `6` integrity, `7` containment, `8` drift, `9` rolled back.

## Out of scope

Stated plainly, because an unstated limit reads as a covered one.

- **Transcripts, chat history and session state are never read.** Not a gap — a decision.
- **Shapeless high-entropy values are caught only by position.** An AWS secret access key
  or a bare hex string with nothing naming it is redacted when it sits in a declared secret
  position, and missed when it does not.
- **This is not a malware scanner.** An imported hook script is quarantined, hash-pinned
  and shown to you; nobody judges whether its contents are hostile. That judgement is
  yours, which is why enabling is a separate act.
- **A compromised machine is out of scope.** Anything that can read your home directory can
  read the same files this tool reads.
- **The redaction detector is defence in depth.** Read a bundle before you share it; the
  accompanying redaction report exists to make that a short job rather than a careful one.
- **Claude auto-memory items currently carry the munged project directory name**, which
  encodes the absolute path of the project on the machine that produced them. That name
  reaches the bundle. It discloses filesystem layout, not content, and is tracked as the
  first fix after `0.2.0`.

## The hosted flow

Running with no subcommand opens the optional authenticated Ωmegas transfer flow, the only
code path in this package that contacts a server.

- Release builds connect only to `https://api.omegas.dev` and `https://omegas.dev`. The
  development-only `--api` override requires `--unsafe-development-api` and accepts HTTPS
  or loopback origins only.
- A browser login alone cannot authorize an upload: the terminal requires a matching
  confirmation phrase and masked account first.
- The local preview it writes contains transferable context and is sensitive. It lands in
  `~/.omegas/state/previews` in owner-only directories at mode `0600`, and the run ends by
  offering to delete it; the default keeps the file, so delete it yourself when done.
- Optional `.env` transfer is separate from normal discovery: files are selected by name,
  read only after account confirmation, and sent as encrypted secret bundles. Their
  variable names and values never appear in the local preview.
- The hosted layer attaches to the open core through exactly two things: the published
  bundle format at a pinned `schema_version`, and CLI exit codes plus the `--json`
  envelope. It never imports an open-core module and never reads the state directory.
