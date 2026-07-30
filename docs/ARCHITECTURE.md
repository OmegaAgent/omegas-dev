# Architecture

`omegas-dev` reads the configuration of local AI coding agents and explains it: what is
configured, where it came from, and why a given value is the one in effect. This document
describes how the reading engine is built and, more importantly, which properties are
enforced by tests rather than by convention.

Everything below is implemented in `src/core/`. It has **zero runtime dependencies**, runs
on Node ≥ 20 stdlib only, and never opens a network socket or spawns a process — all three
are asserted in `test/purity.test.js`.

Related: [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md) is the published artifact contract,
[IMPORT_MODEL.md](IMPORT_MODEL.md) the write path and its consent rules,
[CUTOVER.md](CUTOVER.md) the plan for moving the hosted import onto this core, and
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md) what gates a publish.

---

## 1. The one rule

> Never hand-code a separate path per item when a generic abstraction exists.

A tool that supports N agents by writing N traversals is a tool that rots. So:

**Adapters are inert data. One engine walks them.**

An adapter (`src/core/adapters/claude.js`, `codex.js`, `hermes.js`) is a single default
export containing no functions at any depth. It declares where a runtime keeps things, how
those things merge, how dangerous they are, and what may never leave the machine. The
engine (`src/core/engine/`) contains all the logic and knows the name of no runtime.

Adding a runtime is adding a data file. Adding a *surface* to an existing runtime is adding
an object to an array. Neither touches engine code — which is the acceptance test for
whether the design actually obeys the rule.

These are enforced mechanically:

| Check | Assertion |
|---|---|
| `adapters/*.js` imports | Nothing but `../model/kinds.js`. No `node:fs`, no `node:path`, no engine modules. |
| `adapters/*.js` values | Exactly one default export; zero function values at any depth. |
| `engine/`, `fsx/`, `formats/`, `model/`, `policy/`, `redact/`, `bundle/`, `compat/` | Contain no `claude`/`codex`/`hermes` literal in code, and no `switch` on a runtime id. `compat/` is the interesting one: the compatibility matrix is *about* named runtimes and still must not name one. |
| `core/` | No `node:http(s)`, `node:net`, `node:dns`, `node:tls`, `node:child_process`; no `fetch`; no imports outside `core/`. |
| `package.json` | No `dependencies`, `peerDependencies` or `optionalDependencies`. |

---

## 2. The pipeline

```
scan → normalize → derive → effective → lint
```

- **`engine/scan.js`** walks every descriptor's `locations[]` through one bounded walker
  (`fsx/walk.js`) and emits raw nodes, link records, exclusion records and truncation
  records.
- **`engine/normalize.js`** turns raw nodes into `Item`s, decomposing embedded structures
  down to individual keys.
- **`engine/scan.js#scanDerived`** resolves surfaces defined in terms of other surfaces —
  a hook's `command` points at a script, and a hook config without its script is a broken
  config.
- **`engine/effective.js`** computes the effective-value table from the declared merge
  algebras.
- **`engine/lint.js`** evaluates declarative lint rules over the item set.

`engine/pipeline.js` runs them in order. Redaction and export land between `normalize` and
`effective` in a later milestone, because an effective row keyed by a permission-rule
string would otherwise carry an unredacted value even though the item itself was redacted.

The whole pipeline takes an explicit environment — home directory, project roots, OS,
environment variables (`engine/environment.js`). Nothing reads `os.homedir()` implicitly,
which is what lets every test run against a fake fixture home and know that no real
configuration was ever opened.

---

## 3. Refusals are data

The defect this architecture exists to close is **silence**. In the tool's earlier form, a
symlink it declined to follow was a bare `continue`, and a file over the size cap returned
`null` with no warning — so a machine with 61 symlinked skills reported zero skills, and a
360 KB instructions file vanished without a line of output.

Every refusal is now a record:

| Situation | Result |
|---|---|
| Symlink resolving outside every declared root | an item of kind `unresolved_link`, with the refusal reason and a machine-independent label |
| Symlink resolving into another declared root | a normal item, flagged with `origin.link.crossing` |
| File over the byte cap | truncated, item kept, `truncations[]` record with both sizes |
| Path matched by a never-export rule | `exclusions[]` record with a rule id, a count, a unit and a user-facing reason |
| File a surface matched but no parser understands | an item of kind `opaque`, raw bytes intact |

A scan that dropped something without a record would fail its own tests.

---

## 4. The item model

One shape for every kind, so a viewer, a diff and an importer all read the same fields.

```
item_id = <runtime>:<scope_ref>:<kind>:<logical_name>
```

Identity is **derived, deterministic and declared** — never random, never content-derived.
`logical_name` comes from whatever the runtime itself treats as the identity, declared per
surface: the *directory* for a personal skill, the frontmatter `name` for a Claude
subagent, a top-level TOML `name` for a Codex one, the map key for an MCP server. Hard-coding
"use the filename" would be wrong for four of those five.

Array-index identities can genuinely collide, so duplicates are suffixed deterministically
(`…#2`) rather than dropped, and the item records that the id is unstable under reordering.

Two ids, two questions: `item_id` answers *is this the same thing*, `content_id` answers
*has it changed*.

**Settings decompose to keys, not files.** A `settings.json` is not an item; each key in it
is. Precedence is per key, portability is per key, and the diff a user consents to is per
key. One file cannot express three merge algebras at once.

**Losslessness.** Every payload carries `raw` (authoritative), `parsed`, `recognized` and
`unrecognized`. `recognized ∪ unrecognized = parsed`, always, with no key lost and author
order preserved. An undocumented key is reported as a **finding**, never rewritten and never
dropped — rewriting it would change behaviour and dropping it would destroy configuration.

**Project identity** is tried in three ranked ways, each recording its own portability
confidence: a normalized VCS remote (stable across machines), a hash of the `$HOME`-relative
path, or a slugified basename (explicitly ambiguous). VCS identity is also what stops a
monorepo from fanning out into N unrelated projects: nested packages collapse onto one
repository with distinct `#subpath` scopes.

---

## 5. The seven merge algebras

A single "merge" abstraction is wrong for most surfaces, so the algebra is per-surface data
and the engine implements exactly these:

| Algebra | Resolution |
|---|---|
| `override` | highest rank wins, per key |
| `override_whole_entry` | the highest-rank source supplies the **entire** entry; fields never merge across scopes |
| `concatenate` | all applied in ascending rank; later text has more influence |
| `first_non_empty` | the first non-empty file at a level wins and the rest are never read |
| `aggregate` | all applied simultaneously; **no layer suppresses another** |
| `union_with_resolution` | arrays merge; conflicts resolved by a declared severity order, **not** by rank |
| `coexist` | duplicates all remain addressable; no resolution |

Precedence is resolved **in the context of a project**: a project-scoped item competes with
the user-scope items that also apply there, and two projects are two independent
resolutions.

A layer the runtime does not trust is **suppressed**, and a suppressed layer does not
participate at all — it cannot win and it cannot shadow. Recording it as `suppressed_by`
lets the report explain an absence instead of showing a gap.

The row worth building a UI around is `union_with_resolution`: a project-scoped `allow`
losing to a user-scoped `deny`, because severity beats layer rank. That is the
surprising-but-correct case a user cannot see anywhere today.

---

## 6. Formats: patch, never re-serialize

Parsers live in `src/core/formats/`, keyed by the descriptor's `format` field, never per
adapter. Every one exposes the same three functions:

```js
parse(text)  -> { value, key_order, spans }
patch(text, edits) -> text
serialize(value, key_order) -> text   // only ever used to create a new file
```

Round-tripping a config through a parser loses comments, key order and formatting, so the
write path is **span replacement on the original bytes**. `patch(text, [])` returns the
input byte-for-byte, and a targeted edit changes only that key's bytes — both are property
tests over a committed corpus.

Span offsets are **true UTF-8 byte offsets**, not UTF-16 code-unit indices.

`starlark.js` is deliberately different: it is a read-only *structural* parser, and its
`patch`/`serialize` throw. It reports how many rules exist, what they decide, and which
commands are allow-listed **by name** — an argv element that is not a bare word ends the
prefix and is counted rather than carried, because a live API key was found inside exactly
such an element on a real machine.

---

## 7. Trust, authority and never-export

Every surface declares a trust tier: `INERT`, `DECLARATIVE` or `EXECUTABLE`. Content may
**escalate** a tier — a skill shipping a script with the exec bit becomes `EXECUTABLE` — but
nothing ever lowers one. A surface that grants or changes permissions also declares
`authority: true`, which is what will keep it out of any bulk action.

The never-export table is data, not code, so it is auditable and testable. Per-runtime rules
live in each adapter; runtime-agnostic ones (`~/.ssh`, `~/.aws`, `**/*.pem`, the OS keychain)
live in `policy/caps.js`. `severity` and `class` decide behaviour:

- **`hard`** — the file is never opened.
- **`hard` + `class: secret_sink`** — *scan and refuse*: the structure is reported so the
  user learns what exists, and the bytes are never even retained.
- **`soft`** — the sweep reports it, but a surface that explicitly declares the path still
  reads it. This is what lets one plugin skill be scanned while the plugin cache as a whole
  stays out of scope.

A named deny-list sweep runs regardless of what any surface would have looked at, because
the cost of a miss is unbounded, and a rule that fires must be visible even where nothing
would have looked.

**No machine layout leaves the engine.** `origin.path` is tokenized (`${HOME}`,
`${CLAUDE_HOME}`, `${CODEX_HOME}`, `${PROJECT}`), `origin.display_path` is `~`-relative,
`origin.key_path` is tokenized too (some runtimes key a block by absolute project path), and
so are edge targets and exclusion labels. Payload content stays **verbatim** by contract —
the tokenization travels beside it as a *proposed* rewrite, resolved against the target
machine at import time, never applied on read.

---

## 8. Lints are declarative

A lint is data with a predicate drawn from a closed operator set: `has_key`, `missing_key`,
`matches`, `not_matches`, `path_is_absolute`, `references_missing_path`, `value_in`,
`value_not_in`, `count_gt`, `sibling_exists`, `edge_present`, `edge_absent`, `and`, `or`,
`not`. A lint needing a new operator gets the operator added to the engine, which is the
correct place for logic, rather than a callback smuggled into an adapter. A test walks every
shipped predicate and asserts its operator is in the set.

The v1 rules all fire on conditions that exist on real machines: frontmatter using an
undocumented key variant, a repo whose `AGENTS.md` is invisible to the other runtime, a hook
muted by a sentinel file, an absolute home path embedded in behaviour, a permission rule
pointing at a deleted directory, a remote MCP entry with no transport.

---

## 9. Compatibility is derived, never maintained

`core/compat/` answers "what survives a move to another runtime?" and it contains no table
of answers. `fidelity(kind, source, target, item?)` computes a verdict from the two
runtimes' capability declarations plus the transform descriptors the adapters carry:

| Verdict | Meaning |
|---|---|
| `NATIVE` | moves as-is |
| `CONVERT` | moves, with named losses |
| `ADVISE` | a proposal for a human; never applied silently |
| `UNSUPPORTED` | checked, and there is no equivalent |
| `UNKNOWN` | not built — a different claim from UNSUPPORTED, and never collapsed into it |

Four properties are the reason this is derived rather than written down:

1. **Kind-level and item-level verdicts are different questions.** MCP servers convert
   between the two runtimes as a kind, and a single entry declaring a websocket transport
   is UNSUPPORTED for that entry. Per-item exceptions are declared as data with a closed
   predicate vocabulary, and each carries its own reason and citation, so the report can
   name the one entry instead of degrading the whole kind.
2. **Some losses are computed.** A key in an item's `unrecognized` bag is checked against
   what the target *format* can physically hold — TOML has no null type, dotenv holds flat
   strings — so a loss appears without anyone having enumerated it. This is what keeps the
   list honest as the runtimes add keys.
3. **CONVERT always lists its losses.** The adapter registry refuses a transform declaring
   `fidelity: "convert"` with an empty `drops[]`, because a conversion that loses nothing
   is a relocation.
4. **A verdict cites its evidence.** Every transform carries a citation to the research
   that produced it, and the citation is printed next to the verdict.

`test/compat.test.js` holds the researched matrix transcribed by hand and compares it to
the computed one cell by cell. Where the two disagree the disagreement is named in the test
with its reasoning; the expectation is never edited to match the code.

The matrix is also derivable **offline from a bundle**: `capabilities[]` snapshots each
adapter's capability levels, its declared surfaces with their formats, and its transform
descriptors, so a report rendered from a year-old bundle derives that bundle's matrix
rather than today's.

---

## 10. The HTML report is a pure function of a bundle

`omegas-dev report --html <out> --bundle <in>` renders one self-contained page. Two
structural properties, both tested:

- **A raw scan cannot reach it.** The renderer takes a bundle path, reads it through the
  same verifying reader an importer uses, and refuses any input that is not a sealed
  manifest — including one carrying the right `schema_version` alongside engine-internal
  item fields. There is no argument you could pass to render live configuration, which
  matters because the screenshot of a raw scan is the leak.
- **It references nothing.** No script, stylesheet, font, image, `fetch`, or telemetry —
  and no JavaScript at all; collapsible sections are `<details>` elements. The page also
  declares `default-src 'none'`. Config values are escaped, `/` included, so a URL a user
  configured appears as characters rather than as something a browser would load.

---

## 11. Package layout

```
src/
├── cli/
│   ├── dispatch.js     subcommand routing, --json envelope, exit codes
│   ├── scan.js         the scan command and the shared envelope
│   ├── report.js       the multi-section human report
│   ├── compat.js       the derived matrix, its losses and per-item exceptions
│   ├── html.js         the self-contained local page, rendered from a bundle only
│   ├── export.js       the redacted bundle and the post-export gate
│   ├── diff.js         the write plan, rendered and never applied
│   └── import.js       consent, apply, quarantine, enable
├── core/                       ← no network, no spawn, no dependencies
│   ├── fsx/            safe-read, fingerprint, paths, walk, links, atomic
│   ├── formats/        json, jsonc, toml, md+frontmatter, dotenv, starlark, spans
│   ├── model/          kinds, identity, item, schema
│   ├── engine/         environment, scan, normalize, effective, lint, emit, apply, pipeline
│   ├── adapters/       claude, codex, hermes, registry   ← PURE DATA
│   ├── compat/         derive, transforms
│   ├── redact/         the five layers, placeholders, the secret map
│   ├── bundle/         write, read, digest, names
│   └── policy/         caps, never-export
├── hosted/
│   └── local-transfer-v1.js    the legacy-payload projection (see CUTOVER.md); not wired in
└── cli.js, api.js, discovery.js, env.js   ← the hosted transfer flow, unchanged
```

The hosted transfer flow is the only code that networks. It is reached by a bare
invocation and by its own flags; the read-only commands are reached only by an explicit
subcommand, so the two can never be confused for one another.

---

## 12. The CLI contract

```
omegas-dev scan   [--home <dir>] [--root <dir>…] [--json] [--max-file-bytes <n>]
omegas-dev report [--home <dir>] [--root <dir>…] [--json] [--max-file-bytes <n>]
omegas-dev report --html <out.html> --bundle <in.ocb.jsonl>
omegas-dev compat [--home <dir>] [--root <dir>…] [--from <runtime>] [--to <runtime>] [--json]
omegas-dev export [--home <dir>] [--root <dir>…] [--out <path>] [--payload-policy <p>] [--json]
omegas-dev diff   --bundle <path> [--home <dir>] [--json]
omegas-dev import --bundle <path> [--home <dir>] [--yes-inert]
omegas-dev enable <item_id> [--home <dir>]
```

Exit codes are part of the published contract and change only with a major version:

| Exit | Meaning |
|---|---|
| `0` | Success |
| `1` | Usage or argument error |
| `2` | No supported runtime detected |
| `3` | Completed with warnings |
| `5` | Redaction gate failed — a HIGH-tier hit in the serialized bundle; nothing written |
| `6` | Integrity failure — bundle digest mismatch |
| `7` | Import blocked — entry-name canonicalization or containment violation |
| `8` | Import aborted — the target drifted between preview and apply; rolled back |
| `9` | Import failed mid-apply; rolled back to the pre-apply snapshot |
| `10` | A detected runtime is below its adapter's supported floor |

`5`, `7`, `8` and `9` are the ones a programmatic consumer must handle distinctly: they are
the difference between "retry" and "stop and tell a human".

`--json` emits a self-describing envelope carrying the items, layers, effective table,
findings, exclusions and truncations. It is designed so a consumer needs the envelope and
the exit code and nothing else — no JS API, no state directory.

---

## 13. The open/closed boundary

Everything in this repository is MIT, account-free and network-free. The hosted Ωmegas
layer — encrypted sync, backup, sharing, team policy, billing, the control plane — is
closed, and it attaches to the open core through **exactly two things**:

1. **The bundle format at a pinned `schema_version`**, published in
   [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md). Self-describing, redacted, integrity-checked, read
   from a file path or stdin.
2. **CLI exit codes plus the `--json` result envelope on stdout.**

That is the whole seam. The hosted layer never imports an open-core module, never reads the
Continuity state directory, and never depends on a JS API — so the open core could be
rewritten in another language without breaking it, and a user who never signs in loses
nothing that lives here.

What this buys, stated plainly so it can be checked rather than trusted: the local core has
no account dependency to add later, and the no-network CI gate is the permanent proof. If
the hosted layer ever needed something the bundle format does not carry, the format changes
in the open, with a version, rather than the core growing a private channel.

[CUTOVER.md](CUTOVER.md) covers the one place the two currently meet — the legacy hosted
upload path — and how it moves onto this seam.

---

## 14. Running the fixtures

Every test runs against a committed fake home under `test/fixtures/homes/`. Nothing in the
suite reads a real `~/.claude`, `~/.codex` or `~/.claude.json`, and every credential-shaped
value in the fixtures is an obvious placeholder.

Fixtures are *materialized* into a temp directory before use, because both runtimes key some
state by absolute project path, which cannot be committed. To drive the real CLI against
them:

```sh
node test/fixtures/materialize.js          # prints the materialized home
node bin/omegas-dev.js report --home <that home> --root <that home>/projects --max-file-bytes 8192
```

The fixture home deliberately contains a symlink that escapes every declared root, a symlink
that crosses into another runtime's root, an over-cap file, undocumented frontmatter keys, an
untrusted project, a monorepo with nested markers, a repository with no Claude instructions,
and files that must never be opened at all.
