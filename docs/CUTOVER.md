# Cutover: switching the hosted import to the Continuity core

The hosted Ωmegas import endpoint speaks one payload shape today,
`omegas.local-transfer.v1`, produced by `src/discovery.js`. The Continuity core
(`src/core/`) is a different, better scanner producing a different, richer shape. This
document is the plan for moving from one to the other without a flag day, and the record of
what has actually been proven so far.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) for how the core is built,
[BUNDLE_FORMAT.md](BUNDLE_FORMAT.md) for the shape the hosted layer will eventually consume,
[IMPORT_MODEL.md](IMPORT_MODEL.md) for the write path,
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) for what gates a publish.

---

## 1. The shape of the change

```
today       cli.js → discovery.js ────────────────────────────► POST /transfer  (local-transfer.v1)

step 1      cli.js → core/ → hosted/local-transfer-v1.js ─────► POST /transfer  (local-transfer.v1)
            (same payload, better scanner, no server change)

step 2      cli.js → core/ → bundle ──────────────────────────► POST /bundle    (continuity.v1)
            (server learns the new shape; the old endpoint stays until nothing calls it)

step 3      discovery.js deleted
```

`src/hosted/local-transfer-v1.js` is step 1, written and tested but **not wired in**. A
test asserts that no shipping module imports it, so it cannot become live by accident.
Nothing about the hosted server changes in step 1: it keeps receiving the payload it
already parses, produced by code that was compared against the old code first.

## 2. What parity has been proven

`test/cutover.test.js` runs **both scanners over the same fixture homes in the same
process** and compares the results. This is the whole point of the projection existing
before it is used: the two can be diffed while both still work.

Proven, and asserted every build:

| Property | Assertion |
|---|---|
| Nothing is lost | Every context file, skill and MCP server the legacy scanner finds is present in the projection, matched by path or by `source:name` |
| Fields agree | `source`, `kind` on files; `transport`, `command`, `args_redacted`, `url`, `source_file` on MCP servers |
| Content agrees | Byte-identical wherever no credential was redacted, and the digest of identical content is identical |
| Projects agree | Same count, same names, same `source_label`, same file and server sets per project |
| Determinism | Projecting the same manifest twice produces the same bytes; the legacy scanner produces different project keys on every run |
| Purity | The projection imports no `node:fs`, no network module and no clock — the timestamp comes from the bundle |
| Not wired in | No shipping module imports the projection |

## 3. Intentional differences

Each one lives in `DIFFERENCES` in `src/hosted/local-transfer-v1.js` and is asserted by
name. None of them is a regression; the first three are the reason the cutover is worth
doing at all.

| Difference | Legacy | Projection | Why |
|---|---|---|---|
| `projects[].key` | `<slug>-<8 random hex>`, new on every run | the Continuity `project_id`, derived from the git remote or a content marker | a random key makes two scans of one machine look like two machines to the server |
| file `content` | raw bytes, credentials included | redacted bytes with `{{OMEGA_REDACTED:class:ref}}` placeholders | secrets never travel; this is the invariant the whole core is built around |
| `sha256` | digest of the raw bytes | digest of the bytes actually carried | a digest must address what was sent, or it cannot verify what was received |
| dropped files | `removeSensitiveFiles()` deletes any file whose content looks credential-like | the file is kept and the credential inside it is replaced | whole-file exclusion destroys legitimate security-tooling content (THR §4.2 Gap 3) |
| `mcp_servers[].url` | `sanitizeUrl()`: credentials, query and fragment stripped | the same default-deny, reimplemented in the projection | matching the legacy posture exactly means the server sees no new class of value |
| `args_redacted` | `<redacted>`, the same opaque string for every value | `{{OMEGA_REDACTED:class:ref}}` | an opaque marker cannot be re-bound on the target machine |
| ordering | insertion order | sorted by path, then by `source:name` | two runs over an unchanged machine should produce the same bytes |

### Three things the new scanner finds and the old one misses

These are asserted individually, because "it found more" is exactly the claim that needs
evidence.

1. **`~/.codex/AGENTS.override.md`.** The legacy collector reads `.codex/AGENTS.md` and
   stops. The override file's entire semantic is *replacing* that file (COD §4.1), so
   missing it means transferring a Codex environment whose instructions are not the ones in
   effect.
2. **A skill reached through a symlink.** The legacy collector refuses every symlink and
   emits a warning. Continuity's three-outcome link policy resolves a link that stays
   inside a declared root and refuses only one that escapes — so a skills directory built
   out of symlinks reports skills rather than reporting nothing.
3. **MCP environment variable names declared with a TOML inline table.** `env = { A = "b" }`
   is the documented Codex form (COD §4.5). The legacy line-based scanner cannot represent
   it and returned an empty `env_keys`, which reads as "this server needs no credentials".

## 4. What has NOT been proven

Honest gaps, in the order they need closing:

- **Server-side acceptance.** The projection has never been posted to the real endpoint.
  Parity is structural (field-for-field against the legacy producer), not behavioural. Step
  1 needs one staging upload compared against a legacy upload of the same machine.
- **Redacted content on the server side.** The hosted import currently receives raw file
  content. Feeding it placeholder-bearing content is correct for the invariant and is a
  behaviour change for whatever renders it. That has to be checked before, not after.
- **Project identity continuity.** Existing hosted Spaces are keyed by the legacy random
  key. Switching to a deterministic `project_id` means the server sees new keys for
  projects it already knows. Either the server maps old to new once, or the first
  post-cutover import creates duplicates.
- **Real-machine scale.** Parity is proven on fixture homes with tens of items. It has not
  been run against a machine with 80 skills and 1.2 GB of transcripts.
- **`.env` transfer.** The legacy flow's separate encrypted `.env` path is untouched here
  and is out of scope for the projection, which never reads a `.env` file.

## 5. Rollback

Step 1 is a one-line switch and reverts the same way.

- The switch is which module `src/cli.js` calls to build the payload. Reverting is
  restoring that call; the legacy scanner stays in the tree until step 3, and its tests
  keep running until it is deleted.
- No data migration is involved, because the payload shape does not change. A rolled-back
  client produces the legacy payload again and the server never knew the difference —
  except for project keys, which is why key mapping has to be settled before step 1 ships,
  not after.
- Steps 2 and 3 are separate decisions with their own rollback stories. The bundle-format
  endpoint is additive, so step 2 rolls back by routing to the old endpoint. Step 3 —
  deleting `discovery.js` — is the only irreversible one, and it should not happen until
  the parity test has nothing left to compare against.

## 6. Why the projection is not wired in yet

Wiring it in is a product decision that changes what the hosted service receives from real
users: redacted content instead of raw, stable keys instead of random ones. The engineering
is done and the evidence is in the test suite; the sequencing belongs to whoever owns the
server side. Until then the projection earns its place by being the thing that proves the
new scanner does not lose anything the old one found.
