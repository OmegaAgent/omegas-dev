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
entrypoints, writes a readable JSON preview to `~/Downloads`, and does not contact Omegas
or upload anything.

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

When an MCP server name appears more than once, `manifest.mcp_conflicts` reports each
overlapping pair without choosing or activating a winner. `exact_duplicates` contains
definitions whose public URL or stdio configuration matches exactly. `conflicts` contains
different definitions and any comparison involving redacted arguments or environment keys,
because hidden values cannot be proven equal. Each report entry keeps the tool source,
global or project scope, project label, and source file; secret values are never included.

## Inspect locally

```sh
npx omegas-dev --dry-run
```

Add one or more roots when your projects live elsewhere:

```sh
npx omegas-dev --dry-run --root ~/Code --root ~/Work
```

The preview contains transferable context and should be treated as sensitive. It is
created with mode `0600`; remove it when you are finished reviewing it.

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
  --output <file> Sensitive local preview path
  --dry-run      Discover and write the preview without contacting Omegas
  --no-open      Print the browser link without opening it
  --yes          Open the browser automatically; upload still requires confirmation
  --help         Show command help
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
