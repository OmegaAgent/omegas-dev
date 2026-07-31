# Continuity

**Your Claude Code and Codex setup, explained — and moved, without moving a secret.**

Continuity (`@omegas/continuity`) reads the configuration of the AI coding agents on your machine and tells you
what is actually configured, where each piece came from, why a given value is the one in
effect, and what would survive a move to another machine or another runtime.

```sh
npx @omegas/continuity report --root ~/Code
```

It is open source, local-first and MIT. There is no account, no telemetry, and no network
socket: `src/core/` imports no HTTP, socket, DNS or subprocess module and has zero runtime
dependencies. Those are not promises in a README — they are assertions in
`test/purity.test.js`, plus a test that runs a full scan → redact → export → import-preview
cycle with `fetch`, `net.connect` and `dns.lookup` stubbed to throw.

---

## Why

Your working setup is bigger than a dotfile. It accumulates across global and project
directories, in seven file formats, under two runtimes with different precedence rules:
instructions, skills, commands, subagents, hooks and their scripts, MCP servers, memories,
settings, permission rules, sandbox profiles.

So the simple questions get hard. Which of my three `CLAUDE.md` files is winning? Why is
this permission still denied when I allowed it in the project? Which of my 80 skills would
actually work on a new laptop? What in here is a credential, and what merely looks like one?

## What it does

### Explain a setup

```sh
npx @omegas/continuity scan   --root ~/Code     # what is configured, in one summary
npx @omegas/continuity report --root ~/Code     # the same scan, with the reasoning shown
npx @omegas/continuity scan   --json            # the machine-readable envelope
```

`report` answers the question no other tool answers: **why is this the effective value?** It
prints each contested setting with its winner, every contributor that lost, and the reason
each one lost — including cases that surprise people, such as a broad user-scope `deny`
outranking a narrow project-scope `allow` because severity beats layer precedence.

It is equally explicit about what it did *not* read. A symlink pointing outside every known
directory becomes a listed node with a reason, not a silent skip. A file over the size cap
is truncated and reported with both sizes. Every path excluded by policy is named with the
rule that excluded it. Deliberate absence is data; silence is a bug.

### Know what would survive a move

```sh
npx @omegas/continuity compat --root ~/Code
npx @omegas/continuity compat --from claude --to codex
```

`compat` prints a matrix of `NATIVE` (moves as-is), `CONVERT` (moves, with the losses
listed), `ADVISE` (a proposal for a human, never applied silently), `UNSUPPORTED` (checked,
no equivalent) and `UNKNOWN` (not built — deliberately a different claim from
`UNSUPPORTED`).

No such matrix is stored anywhere in this codebase. Every cell is computed from the two
runtimes' capability declarations plus a transform table, each entry of which cites the
research behind it. That has consequences worth having:

- Your **individual** items are checked, not just their kinds. MCP servers convert from
  Claude to Codex — and one entry of yours declaring a websocket transport is reported as
  UNSUPPORTED on its own, because Codex has no websocket transport. A matrix alone would
  have told you that entry was fine.
- Some losses are **computed** rather than listed. An unrecognized key holding `null` on
  its way into a TOML file is reported as a loss because TOML has no null type, without
  anyone having written that down.
- A conversion that claims no loss fails the build. If it loses nothing, it is a
  relocation, and it has to say so.

### Share it, without sharing a secret

```sh
npx @omegas/continuity export --root ~/Code
```

One `.ocb.jsonl` bundle you can paste into a gist or commit to a repo. Credential values
become `{{OMEGA_REDACTED:<class>:<ref>}}` placeholders; the key name, the position, the
class and the site count stay in the clear, so a reader can reconstruct *"the Slack server
needs a bot token in `SLACK_BOT_TOKEN`"* without learning one byte of any value. The same
secret in five places gets the same `ref`, so re-binding it later is one answer, not five.

There is no `--include-secrets` and no second "complete" file. Before the bundle reaches
your disk, the tool re-scans its own serialized bytes with the full detector and aborts on
any high-confidence hit, writing nothing and exiting `5`. Recall is measured rather than
claimed: the suite seeds 212 fake credentials across every surface it reads and asserts the
per-tier percentage on every build.

### Read it as a page

```sh
npx @omegas/continuity report --html ~/setup.html --bundle ~/setup.ocb.jsonl
```

One self-contained HTML file: environment, items with provenance and portability, every
contested value with its winner and why, the compatibility matrix with its losses,
findings, the redaction summary, and the refusals with their units.

It is rendered **from the redacted bundle and from nothing else** — the renderer takes a
bundle path and refuses anything that is not a sealed manifest, so there is no argument you
could pass that would render live configuration. And it references nothing: no script, no
stylesheet link, no font, no image, no telemetry, no JavaScript at all. Open it with the
network unplugged and it looks identical. It is meant to be safe to screenshot, and it
lands `0600` because being safe to screenshot deliberately is not the same as being safe to
leave world-readable.

### Land it on another machine

```sh
npx @omegas/continuity diff   --bundle setup.ocb.jsonl    # exactly what it would write. writes nothing
npx @omegas/continuity import --bundle setup.ocb.jsonl    # the same plan, applied item by item
npx @omegas/continuity enable claude:user:hook:Stop.0.0   # turn on one quarantined item
```

`diff` creates no staging directory, no ledger line and no temporary file; a test
byte-compares the whole target home before and after to keep that true.

`import` applies nothing without a recorded consent against a specific rendered diff.
Permission rules are **additions**: an array position resolves to an append against the
array on your machine, so importing rule 3 can never overwrite yours. `--yes-inert` accepts
inert additions only and can never cover an authority change, an executable item, or a
write that replaces content you already have. There is no blanket `--yes`.

Everything executable — hook commands, stdio MCP servers, skill scripts — lands **written
but inert**, in the runtime's own disabled idiom (`"disabled": true`, `enabled = false`, a
`hooks_disabled` block, no execute bit). You read it in place, then `enable` it as a
separate act; `enable` shows the current content, verifies it still matches the hash
recorded at import, and refuses if it changed.

Writes are staged at `0700`, snapshotted, fingerprint-re-verified immediately before each
write, made through `O_NOFOLLOW | O_EXCL` temp files plus `rename`, and rolled back in full
on any failure.

---

## What this does NOT do yet

The honest list. Every item here is a real limit, not a roadmap tease.

- **Cross-runtime transfer is preview only.** Claude ⇄ Codex conversions are derived,
  explained and shown in the write plan, and `import` refuses to apply them. Only
  same-runtime transfer (your machine → your other machine) writes anything.
- **No Hermes support.** The adapter exists as an identity with zero surfaces. Every cell
  involving it reads `UNKNOWN`, and it is listed rather than hidden — so "we don't support
  it" can't be mistaken for "you don't have it".
- **Transcripts, chat history and session state are out of scope by design.** They are the
  densest store of secrets on a developer machine and no rule reads them. This is not a
  feature waiting to be built.
- **Some kinds are declared but not yet read.** `continuity compat` prints its own coverage
  gaps — kinds a runtime supports that this tool does not scan yet — so a missing surface
  never reads as a missing capability.
- **Shapeless high-entropy secrets are caught only by position.** An AWS secret access key
  or a bare hex string with nothing naming it is redacted when it sits in a declared secret
  position, and missed when it does not.
- **Credential detection is defence in depth, not a guarantee.** Read the bundle before you
  share it. The tool makes that possible on purpose: the redaction report tells you exactly
  what it found, what class it thought each value was, and how confident it was.

## Security model, in brief

- Source files are opened read-only, with `O_NOFOLLOW`, and re-checked for change while
  being read.
- Symlinks get one of three outcomes — resolved inside a declared root, recorded as
  crossing between roots, or refused and listed — never a silent skip.
- Never-export rules keep whole classes of data out of any artifact: account and billing
  identity, machine fingerprints, trust decisions, OAuth locks, transcripts, history.
- Redaction runs as five layers whose results are unioned: declared position, key name,
  clean-room provider patterns, entropy at declared sinks, and a deep walk of every parsed
  leaf with one bounded decode. A false positive costs a span, never a file.
- Imported bundles are hostile input. Entry names are canonicalized and re-checked on read;
  traversal, case-fold collisions, duplicate entries, count and size bombs and tampered
  digests are refused with distinct exit codes rather than repaired.
- [SECURITY.md](SECURITY.md) has the full threat model, the out-of-scope list, and how to
  report something privately.

## The hosted flow

Run with no subcommand and you get the optional authenticated Ωmegas transfer flow, which
is the only code path in this package that contacts a server:

```sh
npx @omegas/continuity --dry-run     # scan and write a local preview; contacts nothing
npx @omegas/continuity               # the hosted review flow
```

The two are deliberately hard to confuse: every read-only command requires an explicit
subcommand, and none of them can reach the network. The hosted layer attaches to this core
through exactly two things — the published bundle format and the CLI exit codes plus
`--json` envelope. It never imports a module from `src/core/`.

`--dry-run` writes a local preview containing the full text of everything discovered, so it
is sensitive. It lands in `~/.omegas/state/previews` at mode `0600` inside owner-only
directories, and the run ends by offering to delete it; the default answer keeps the file.

```text
Usage: npx @omegas/continuity [options]

  --root <dir>    Root to scan (repeatable; defaults to the current directory)
  --output <file> Sensitive local preview path (default: ~/.omegas/state/previews)
  --dry-run       Discover and write the preview without contacting Omegas
  --no-open       Print the browser link without opening it
  --yes           Open the browser automatically; secrets still require a separate answer
  --help, -h      Show this help
```

The development-only `--api` override requires `--unsafe-development-api` and accepts only
HTTPS or loopback origins.

## Documentation

| Document | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How the engine is built and which guarantees are enforced by tests |
| [docs/BUNDLE_FORMAT.md](docs/BUNDLE_FORMAT.md) | The published format contract, for anyone writing a reader |
| [docs/IMPORT_MODEL.md](docs/IMPORT_MODEL.md) | Trust tiers, consent, quarantine, rollback — and what it does not protect you from |
| [docs/CUTOVER.md](docs/CUTOVER.md) | Moving the hosted import onto this core, and the parity already proven |
| [docs/MIGRATION.md](docs/MIGRATION.md) | Coming from the old `omegas-dev` package name — what changed, and what did not |
| [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) | What gates a release |

## CLI reference

```text
continuity <command> [options]

  scan     Read every declared configuration surface and print what was found
  report   The same scan, rendered as a multi-section report
  compat   The derived compatibility matrix, its losses, and per-item exceptions
  export   Write a redacted, content-addressed bundle you can share
  diff     Preview exactly what importing a bundle would write. Writes nothing
  import   Walk the same plan and apply only what you consent to, item by item
  enable   Turn on one quarantined item, after showing you what it is

  --home <dir>          Home directory to read (default: your home directory)
  --root <dir>          Project root to scan for project-scope config (repeatable)
  --json                Emit the machine-readable result envelope on stdout
  --max-file-bytes <n>  Per-file read cap; a breach is truncated and reported, never dropped
  --out <path>          export only: where to write the bundle
  --payload-policy <p>  export only: definition | definition+scripts | full
  --bundle <path>       diff / import: the bundle to read
                        report --html: the redacted bundle the page is rendered from
  --html <path>         report only: write one self-contained HTML page from --bundle
  --from / --to <rt>    compat only: restrict the matrix to one direction
  --yes-inert           import only: bulk-accept inert additions only
```

Exit codes: `0` success, `1` usage, `2` no supported runtime, `3` completed with warnings,
`5` the export gate refused, `6` integrity failure, `7` import blocked on containment, `8`
import aborted on drift, `9` import rolled back, `10` a runtime older than this tool
supports.

## Development

Requires Node.js 20 or newer.

```sh
npm test          # the whole suite
npm run check     # every source file parses
npm run gates     # the named release gates, one at a time
```

Each gate is also its own script — `gate:purity`, `gate:secrets`, `gate:network`,
`gate:adversarial`, `gate:noop`, `gate:compat`, `gate:cutover` — so a failure names the
property that broke. Every test runs against a committed fake home under
`test/fixtures/homes/`; nothing in the suite reads a real `~/.claude`, `~/.codex` or
`~/.claude.json`, and every credential-shaped value in the fixtures is an obvious
placeholder.

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution boundaries.

## Project status

Early, working software. `0.2.0` is the first release with the full read → explain →
export → import path, and its behaviour is covered by the public test suite. Issues and
focused pull requests are welcome.

## License

[MIT](LICENSE)
