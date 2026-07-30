# omegas-dev

**Your Claude Code and Codex setup, in one view.**

`omegas-dev` is an open-source, local-first CLI for visualizing, understanding, and
transferring your personal AI coding configuration. It turns scattered instructions,
skills, memories, and MCP server definitions into one structured preview you can inspect
before deciding what moves with you.

```sh
npx omegas-dev --dry-run
```

The dry run stays local. It scans documented Claude Code and Codex configuration
entrypoints, writes a readable JSON preview to `~/.omegas/state/previews`, and does not
contact Omegas or upload anything.

## Why this exists

Your working setup is larger than one dotfile. It accumulates across global and project
directories:

- instructions such as `CLAUDE.md` and `AGENTS.md`
- personal and project skills
- project memories and rules
- MCP server names, transports, commands, and environment variable names
- optional project `.env*` files, handled through a separate explicit flow

That makes it difficult to answer simple questions: What have I configured? Which parts
belong to Claude or Codex? What is global? What is project-specific? What can I safely move?

`omegas-dev` builds that map without following symlinks, printing secrets, or silently
uploading your files.

## What it understands

| Area | Claude Code | Codex |
| --- | --- | --- |
| Instructions | `CLAUDE.md`, `.claude/CLAUDE.md`, rules | `AGENTS.md`, `.codex/AGENTS.md` |
| Skills | Global and project `SKILL.md` files | Global and project `SKILL.md` files |
| Memory | Project memory and `.claude/memory` | `.codex/memories` |
| MCP | `.claude.json`, `.mcp.json`, Claude settings | `.codex/config.toml` |
| Scope | Global configuration and discovered projects | Global configuration and discovered projects |

The resulting manifest keeps source and scope visible, so you can understand where each
item came from instead of receiving an opaque archive.

## Explain a setup, read-only

`scan` and `report` read your configuration and explain it. They write nothing, upload
nothing, and open no network socket or subprocess.

```sh
npx omegas-dev scan --root ~/Code       # what is configured, in one summary
npx omegas-dev report --root ~/Code     # the same scan, with the reasoning shown
npx omegas-dev scan --json              # the machine-readable envelope
```

`report` answers the question no other tool does: **why is this the effective value?** It
prints each contested setting with its winner, every contributor that lost, and the reason
each one lost — including the cases that surprise people, such as a broad user-scope `deny`
outranking a narrow project-scope `allow` because severity beats layer precedence.

It is equally explicit about what it did *not* read. A symlink pointing outside every known
directory becomes a listed node with a reason, not a silent skip; a file over the size cap
is truncated and reported with both sizes; every path excluded by policy is named along with
the rule that excluded it. Deliberate absence is data — silence is a bug.

| Option | Meaning |
| --- | --- |
| `--home <dir>` | Home directory to read (default: yours) |
| `--root <dir>` | Project root to scan, repeatable |
| `--json` | Emit the result envelope on stdout |
| `--max-file-bytes <n>` | Per-file read cap; a breach is truncated and reported, never dropped |

Exit codes: `0` success, `1` usage error, `2` no supported runtime found, `3` completed with
warnings, `5` the export gate refused, `10` a detected runtime is older than this tool
supports.

`docs/ARCHITECTURE.md` describes how this is built and which guarantees are enforced by
tests rather than by convention.

## Share a setup, without sharing a secret

```sh
npx omegas-dev export --root ~/Code     # one file, redacted, content-addressed
```

`export` writes a single `.ocb.jsonl` bundle you can paste into a gist or commit to a repo.
Credential values are replaced by `{{OMEGA_REDACTED:<class>:<ref>}}` placeholders; the key
name, the position, the class and the site count stay in the clear, so a reader can
reconstruct *"the Slack server needs a bot token in `SLACK_BOT_TOKEN`"* without learning one
byte of any value. The same secret in five places gets the same `ref`, so re-binding is one
answer, not five.

There is no `--include-secrets` and there is no second, "complete" file. Before the bundle
reaches your disk, the tool re-scans its own serialized bytes with the full detector and
aborts on any high-confidence hit — writing nothing and exiting `5`. Recall is a measured
number, not a claim: the test suite seeds 212 fake credentials across every surface it
reads and asserts the percentage each release.

Two companion files land beside it, both mode `0600` and neither meant to be shared: a
local review report (which says more than the bundle) and a secret map holding pointers to
where each value lives on this machine — never a value, not even hashed.

`docs/BUNDLE_FORMAT.md` is the published format contract, written for anyone implementing a
reader.

## Inspect locally

```sh
npx omegas-dev --dry-run
```

Add one or more roots when your projects live elsewhere:

```sh
npx omegas-dev --dry-run --root ~/Code --root ~/Work
```

The preview contains the full text of everything discovered, so it is sensitive. It is
written to `~/.omegas/state/previews` with mode `0600` inside owner-only directories, and
the run ends by offering to delete it. The default answer keeps the file; `--output`
writes it wherever you prefer instead.

Anything the scan refuses is reported rather than dropped in silence: files over 256 KB,
refused symlinks, and files excluded for containing credential material each print a
`Warning:` line naming the path.

## Review and transfer

Run without `--dry-run` to open the authenticated Omegas review flow:

```sh
npx omegas-dev
```

The transfer sequence is deliberately explicit:

1. The CLI inventories documented Claude Code and Codex entrypoints.
2. A short-lived browser claim binds the terminal to your signed-in account.
3. The terminal and browser show the same confirmation phrase and masked account.
4. A local preview is written before any configuration is uploaded.
5. You approve or cancel the upload in the terminal.
6. The browser shows the imported instructions, skills, memories, MCP proposals, and
   project mapping for final review.

The discovery and preview code is fully open source in this repository. The optional
hosted review and import destination is [Omegas](https://omegas.dev).

## Privacy and security boundaries

- Source files are read-only.
- Symlinks are not followed.
- Files are size-limited and checked for changes while being read.
- Credential-shaped context files are excluded from the manifest.
- MCP values are reduced to metadata; tokens, authorization headers, URL queries, and
  token-shaped arguments are removed.
- Raw Claude Code and Codex configuration files are never uploaded as opaque blobs.
- Absolute filesystem paths are not included in the manifest.
- There are no runtime dependencies, install scripts, background processes, or telemetry.
- Release builds connect only to `https://api.omegas.dev` and `https://omegas.dev`.

Optional `.env*` transfer is separate from normal discovery. Files are selected by name,
read only after account confirmation, and sent as encrypted secret bundles. Their variable
names and values never appear in the local preview.

Read [SECURITY.md](SECURITY.md) for the complete trust model and private reporting process.

## CLI options

```text
Usage: npx omegas-dev [options]

  --root <dir>   Root to scan (repeatable; defaults to the current directory)
  --output <file> Sensitive local preview path (default: ~/.omegas/state/previews)
  --dry-run      Discover and write the preview without contacting Omegas
  --no-open      Print the browser link without opening it
  --yes          Open the browser automatically; secrets still require a separate answer
  --help, -h     Show this help
```

The development-only `--api` override requires `--unsafe-development-api` and accepts only
HTTPS or loopback origins.

## Development

Requires Node.js 20 or newer.

```sh
npm test
npm run check
npm run pack:dry-run
```

The CLI intentionally uses only Node.js standard-library modules. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution boundaries and the local workflow.

## Project status

`omegas-dev` is early, working software. The current `0.1.x` line is used for the Omegas
configuration import flow, and its discovery, redaction, preview, and transfer behavior is
covered by the public test suite. Issues and focused pull requests are welcome.

## License

[MIT](LICENSE)
