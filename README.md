# omegas-dev

`omegas-dev` is the user-initiated migration helper for Omegas. It discovers Claude Code and
Codex context, skills, project memories, and MCP server metadata, then opens an authenticated
review before anything is applied.

```sh
npx omegas-dev
```

The CLI is read-only on your source files. It has no dependencies, install scripts, background
process, or telemetry. Release builds upload only to `https://api.omegas.dev` and accept browser
claims only from `https://omegas.dev`.

## What happens

1. The CLI inventories the current project and documented Claude/Codex global entrypoints.
2. It creates a mode-`0600` local preview in Downloads and opens a 15-minute browser claim.
3. The browser and terminal show the same confirmation phrase and masked account. You must confirm
   that match in the terminal; `--yes` never skips this step.
4. The encrypted payload is staged for review. Projects can become new Spaces or map to Spaces you
   already own.
5. Selected context and skills are stored as progressively disclosed Space wiki sources. They are
   not appended to the base system prompt.
6. MCP definitions appear as disconnected proposals. Tokens are never copied; remote servers must
   be authorized again, and local stdio servers are not activated in the cloud.

Symlinks are not followed. Files are checked again before they are read, credential-shaped context
is excluded, raw Claude/Codex configuration is never uploaded, and absolute filesystem paths are
not included in the transfer manifest.

## Optional secret-file transfer

Secrets are a separate yes/no choice. If you opt in, you select `.env*` files by filename rather
than selecting individual variables. Those files are fingerprinted during discovery and read only
after the authenticated claim; a changed file aborts the transfer. The API seals the values
immediately, and the browser receives only filename, environment label, and variable count.

Imported secret files are stored per Space under Settings. Omegas does not automatically inject
them into agents or MCP servers. Delete them there when they are no longer needed.

## Inspect before uploading

```sh
npx omegas-dev --dry-run
```

The preview contains the context that would be transferred and should be treated as sensitive. It
is created with mode `0600`; remove it after review. Use `--no-open` to copy the browser link
manually. Add more project roots with repeated `--root` flags:

```sh
npx omegas-dev --root ~/Code --root ~/Work
```

Local development APIs require both the explicit unsafe flag and a loopback URL:

```sh
node bin/omegas-dev.js --unsafe-development-api --api http://localhost:8080
```

See [SECURITY.md](SECURITY.md) for the trust model and private reporting instructions.
