# Security

## Reporting

Do not open a public issue containing credentials, configuration, transfer codes, or filesystem
details. Email `hello@omegas.dev` with the subject `omegas-dev security`; include only the minimum
reproduction needed, and never send live secrets.

## Trust model

- Run the package only as `npx omegas-dev` and verify npm shows the package owner you expect.
- The CLI reads only documented Claude/Codex entrypoints, the current directory, and roots you pass
  explicitly. It rejects symlinks and files that change between discovery and upload.
- Release builds connect only to `https://api.omegas.dev` and `https://omegas.dev`.
- A browser login alone cannot authorize an upload. The terminal requires a matching confirmation
  phrase and masked account before reading selected `.env*` files or uploading.
- Context and selected secret files are encrypted while staged. Unapplied staging is retained for
  at most 24 hours; cancellation schedules immediate cleanup. Applied transfer records retain only
  import metadata, while Space-bound secret files remain until the owner deletes them.
- MCP configuration is imported as disconnected metadata. Credentials, authorization headers, URL
  query strings, and token-shaped values are not transferred.

The local preview intentionally contains transferable context. Treat it as sensitive. It is written
to `~/.omegas/state/previews` (owner-only directories, mode `0600`), and the run ends by offering to
delete it; the default answer keeps it, so delete it yourself once you are done.

Credential detection is a defence in depth, not a guarantee. It recognizes named vendor token
shapes, credential-bearing URLs and headers, and assignments to credential-named keys. It does not
recognize shapeless high-entropy values — an AWS secret access key or a bare hex string sitting on
its own, with nothing naming it — and it reads only the entrypoints listed in the README.
