# Independent verification — Ωmegas Continuity

Verifier: an Opus agent that did not build this. Nothing here is taken from the build
agents' own claims; every row cites a command that was run and what came back.

| | |
|---|---|
| Workspace | `/Users/noureddinbakir/omegas-dev` |
| Branch | `continuity/build` |
| Committed HEAD | `abfc47b` ("feat: derived compat engine … 0.2.0 (M4)") |
| Date | 2026-07-31 |
| Mode | read-only; this file is the only thing written |

Companion reading: [ARCHITECTURE.md](ARCHITECTURE.md) for the boundaries this checks,
[BUNDLE_FORMAT.md](BUNDLE_FORMAT.md) and [IMPORT_MODEL.md](IMPORT_MODEL.md) for the
guarantees reproduced in §2, [CUTOVER.md](CUTOVER.md) for the legacy projection, and
[RELEASE_CHECKLIST.md](RELEASE_CHECKLIST.md), whose item 0 is verified in §1.8.

> **This file's existence fails a shipped gate, deliberately left failing.**
> `test/release.test.js` asserts `docs/` contains **exactly** five markdown files, so
> adding a sixth turns `gate:release` red (10/11) no matter what it contains. That is a
> decision for the lead, not for the verifier: either add `VERIFICATION.md` to that
> assertion's list (the cross-links above are already in place for it), or move this
> report out of `docs/`. It is correctly **absent from the tarball** — `npm pack
> --dry-run` still ships 74 files and `package.json` names shipped docs individually — so
> nothing leaks either way.

## 0. Read this first: the tree moved during verification

The working tree is **not clean**, and the difference is load-bearing:

```
$ git status --porcelain
 M src/core/engine/emit.js
?? test/redteam-quarantine.test.js
```

`emit.js` was modified at 01:22 and `redteam-quarantine.test.js` created at 01:19 — during
this verification, by a concurrent agent. So there are **two artifacts**, and they do not
behave the same:

* **Committed `abfc47b`** — what a tag or `npm publish` would ship today.
* **Working tree** — `abfc47b` plus an uncommitted security fix (surface-claim re-derivation
  on import, plus `argv_positions` promoting an item to EXECUTABLE) and a 4-test red-team file.

Both were exercised. Where they differ, the row says so. The committed tree was obtained
without touching the working tree:

```
$ git archive abfc47b | tar -x -C <scratch>/head-tree
```

## 1. Requirement groups

| # | Requirement | Verdict |
|---|---|---|
| 1 | M0–M4 scope as a documented, versioned CLI | **PARTIAL** |
| 2 | Unknown fields round-trip safely | **VERIFIED** |
| 3 | Compatibility derived, not hand-maintained | **VERIFIED** |
| 4 | No runtime-name literals in the generic engine | **VERIFIED** |
| 5 | Test families exist and pass | **PARTIAL** |
| 6 | CI wiring, named gates, clean packaging | **PARTIAL** |
| 7 | Guardrails held (MIT, account-free, network-free, legacy intact) | **VERIFIED** |
| 8 | Credential exposures surfaced as a blocking checklist item | **VERIFIED** |
| 9 | No forbidden actions | **PARTIAL** |
| 10 | Honesty of claims | **PARTIAL** |

---

### 1. M0–M4 scope — PARTIAL

Everything on the list exists and runs. Driven against a materialized fixture home
(`node test/fixtures/materialize.js`), the seven subcommands produced substantive output:
`scan` (58 items, 8 layers, 16 kinds), `report` (247 lines across 8 sections), `compat`,
`export`, `report --html`, `diff`, `import`, `enable`.

Confirmed individually: hardened legacy import; data-driven Claude/Codex adapters with a
declared-empty Hermes; manifests with provenance; scan; normalize; effective-value
explanation (section 4 of `report` shows 10 contested rows with the winning layer, the
shadowed layer, and the algebra name — `override`, `concatenate`, `aggregate`,
`first_non_empty`, `union_with_resolution`); derived compatibility; redaction with local
re-binding (`diff` prints "Credentials this bundle needs (the bundle carries none of them)"
with per-ref key names and site counts); content-addressed zero-secret bundles; export;
exact diff; same-runtime apply; cross-runtime preview-and-block; rollback (`apply.js`
`rollback()` + `APPLY_EXIT.ROLLED_BACK`, with a deliberate injected-failure path so the
rollback is exercised by the real writer); self-contained HTML.

Three deductions:

**(a) Quarantine is not held for a bulk-consented item — the tool says DISABLED and writes
it LIVE.** This reproduces on the committed tree *and* on the fixed working tree.

```
$ node bin/omegas-dev.js import --bundle verify.ocb.jsonl --home <target> --yes-inert
…
Applied 25 operation(s).

Written DISABLED — read them, then turn each on deliberately:
  omegas-dev enable claude:user:skill:seeded-skill
```

Run exactly the command it prints:

```
$ node bin/omegas-dev.js enable claude:user:skill:seeded-skill --home <target>
claude:user:skill:seeded-skill has nothing to enable.
$ echo $?
0
```

The cause is visible in the plan the tool itself rendered. A quarantine is two operations,
and they carry **different consent classes**:

```
merge_key ~/.claude/settings.json § skillOverrides.seeded-skill   [lands DISABLED]
  consent: individual — records the imported item as disabled; it rides the same
           decision as the item it quarantines
create_file ~/.claude/skills/seeded-skill/SKILL.md   [lands DISABLED]
  consent: bulk — inert or declarative addition
```

`--yes-inert` accepts the bulk half and refuses the individual half. The skill body is
written; the switch that turns it off is not. Confirmed on disk: `SKILL.md` present at
`~/.claude/skills/seeded-skill/SKILL.md` (0600), `skillOverrides` **absent** from the target
`settings.json`, and the ledger records `"disabled_form_mode":null`. The comment on the
companion operation asserts it "rides the same decision as the item it quarantines"; in the
`--yes-inert` path it demonstrably does not.

**(b) The top-level `--help` never mentions Continuity.** `node bin/omegas-dev.js --help`
prints only the legacy hosted-transfer flags. A user has to already know that `scan`,
`report`, `compat`, `export`, `diff`, `import` and `enable` exist to reach
`commandHelp()`. The README documents them well; the binary does not.

**(c) "Content-addressed" is not "byte-reproducible".** Two exports of the same unchanged
home produce the **same content digest**
(`sha256:9e7b7ba1…` both runs, 174,948 bytes both runs) but **different files**, because the
envelope carries a fresh `bundle.id` and `created_at`. That is a defensible design; it is
worth stating so nobody reads "content-addressed" as "diffable across runs".

### 2. Unknown fields round-trip — VERIFIED

I injected seven markers no adapter can declare — a JSON scalar, a nested object, an array
with mixed types, an explicit `null`, a TOML key plus a TOML table, a markdown frontmatter
key, and a unicode value (`ZZ_VENDOR_UNICODE_é中🚀_7f3a`) — into `settings.json`,
`config.toml` and `SKILL.md`, then ran the real `export` and `import`:

```
markers_present_in_bundle:      all 7 true
markers_present_after_import:   all 7 true
```

Each unknown key becomes its own addressable item rather than being folded away — e.g.
`claude:user:setting:zzVendorScalar` with `origin.key_path`, a byte span
(`byte_start:1006, byte_end:1029`), a portability verdict and a content id.

Format round-trip: parse-then-emit with **zero edits** is byte-identical for all ten
fixtures — `json`, `jsonc`, `toml`, `md+frontmatter`, `dotenv`, the three unicode variants,
an edge-case `.env`, and a markdown file with no frontmatter at all.

### 3. Compatibility is derived — VERIFIED

`src/core/compat/derive.js` contains no matrix. Every cell comes out of `fidelity()`, a pure
function of the two runtime profiles plus the transform table. `grep -rn` for a static
verdict table in `src/core/compat/` returns nothing but the derivation.

Hermes: **95 of 95 cells are `UNKNOWN`**, never `UNSUPPORTED`, with the note
`"hermes is declared, not surveyed: no surface has been verified, so nothing has been
checked either way"`. Full verdict distribution over 19 kinds × 9 ordered pairs:
`NATIVE 31, CONVERT 10, UNKNOWN 95, UNSUPPORTED 27, ADVISE 8`.

One rendering note: the human-readable `compat` table shows only the claude/codex columns.
Hermes is disclosed in the runtimes header above it and in `--json`, but it has no column.

### 4. No runtime names in the generic engine — VERIFIED

```
$ grep -rniE 'claude|codex|hermes' src/core/engine/ | grep -vE ':\s*(//|\*|/\*)'
NONE (all hits are full-line comments)
```

I also checked the obvious way to defeat the purity test's comment stripper — a trailing
`// claude` on a line of real code — across `engine/`, `compat/`, `fsx/`, `redact/`,
`bundle/`, `model/`, `policy/` and `formats/`: none.

The gate is real and runs: `test/purity.test.js` strips comment lines, then asserts an empty
match array for `/claude|codex|hermes/gi` in `engine/` and in six sibling directories,
including `compat/` — the interesting case, since the matrix is *about* runtimes and still
must not name one. It also forbids `switch` on a runtime id, forbids network and subprocess
imports anywhere in `core/`, forbids `core/` importing outside `core/`, and asserts adapters
hold zero function values at any depth. `npm run gate:purity` → 54/54.

### 5. Test families — PARTIAL

`npm test` on the working tree: **396 tests, 396 pass, 0 fail, ~11.4s.**
On committed `abfc47b`: **392 tests** (the 4 red-team tests are the uncommitted delta).

| Family | Files | Tests | State |
|---|---|---|---|
| unit | `formats` 38, `redact` 37, `fsx` 13, `engine` 21, `emit` 21, `adapters` 40, `bundle` 9, `env` 2 | 181 | strong |
| fixture / integration | `import` 21, `cli-continuity` 11, `export-cli` 10, `compat-cli` 7, `html-report` 9, `discovery-integration` 4 | 62 | strong |
| property-based | — | 0 | **MISSING** |
| adversarial | `adversarial` 9, `redteam-quarantine` 4 (uncommitted) | 13 | thin but sharp |
| symlink containment | `fsx` (16 refs), `adversarial` (21 refs), `discovery-warnings` (17 refs) | — | strong |
| no-network | `purity`, `export-cli`, `html-report` | — | strong |
| secret recall | `redact-recall` 3, `redaction-corpus` 52 | 55 | strong |
| zero-secret bundle | `redact-recall` Gate 2, `export-cli` | — | strong |
| byte-identical no-op | `import`, `preview` | — | strong |

**Property-based testing does not exist.** `grep -rniE 'fuzz|randomi|fast-check|arbitrary|
shrink|Math\.random|randomBytes'` over `test/` returns nothing. What is there instead is
*generated table-driven* testing: `seeded.js` deterministically synthesizes 215 credential
placements across every surface, and `redaction-corpus.test.js` runs 52 paired
recall/precision rows. That is good coverage of the input space someone thought of; it will
not find the input nobody thought of. Calling it a property family would be a stretch.

Adversarial is 9 tests (13 with the uncommitted red team) for the whole hostile-bundle
surface. Every one passes and each is well aimed — hostile entry names, case-fold
collisions, structural tampering, undeclared entries, entry-count and size bombs, planted
symlinks at write time, a target inside a symlinked directory — but 13 tests is a thin wall
for the component whose whole job is to be attacked.

Secret recall is measured, not asserted: Gate 2 computes per-tier recall over ≥200
placements and fails below 99% HIGH / 95% overall, then separately asserts that **no**
seeded value reaches the serialized bytes — including from surfaces the detector never saw.

### 6. CI wiring and packaging — PARTIAL

All eight gates are named npm scripts, all eight are named CI steps, and the matrix is
Node 20/22/24. Run individually on the working tree:

| Gate | Tests | Result |
|---|---|---|
| `gate:purity` | 54 | pass |
| `gate:secrets` | 92 | pass |
| `gate:network` | 33 | pass |
| `gate:adversarial` | 9 | pass |
| `gate:noop` | 29 | pass |
| `gate:compat` | 30 | pass |
| `gate:cutover` | 13 | pass |
| `gate:release` | 11 | pass |

`npm run gates` → 0. `npm run check` → 0.

Packaging, `npm pack --dry-run --json`: **74 files, 841 KB unpacked, 239 KB tarball.**
Forbidden matches (`^test/`, `/fixture/i`, `*.test.js`, `RELEASE_CHECKLIST`, `.env`,
`*.ocb.jsonl`): **none**. Required present: `README.md`, `SECURITY.md`, `LICENSE`,
`bin/omegas-dev.js`, and exactly the four shipped docs. Top-level entries are
`bin`, `src`, `docs`, `package.json`, `README.md`, `SECURITY.md`, `LICENSE`.

**The deduction: CI would be red on the first push, and three tests would be missing, not
failing loudly for a good reason.** Three fixture files exist on this machine but are not in
the repository:

```
$ git archive abfc47b | tar -x -C <scratch>/head-tree && cd <scratch>/head-tree && npm test
ℹ tests 392   ℹ pass 389   ℹ fail 3
✖ report renders every section a reader needs, and nothing was written
✖ project identity uses the git remote, and a monorepo collapses onto one repository
✖ all seven merge algebras resolve, and severity beats layer rank
```

The three untracked files:

```
test/fixtures/homes/source/projects/app/.claude/settings.local.json
test/fixtures/homes/source/projects/app/.git/config
test/fixtures/homes/source/projects/monorepo/.git/config
```

Causation proven — copying exactly those three back into the archived tree takes it to
**392/392, exit 0**. The reasons differ and both need fixing:

* `settings.local.json` is swallowed by the founder's **personal global gitignore**:
  `git check-ignore -v` → `/Users/noureddinbakir/.config/git/ignore:1:**/.claude/settings.local.json`.
  It works here because the file exists locally; it will not exist for CI or any other clone.
* The two `.git/config` fixtures **cannot be tracked by git at all** — git refuses paths
  inside a `.git` directory (`git ls-files | grep -c '\.git/'` → 0). Project identity by git
  remote is currently untestable in a fresh clone under this fixture layout.

Also observed: one run of the loop over the eight gates reported `gate:adversarial` 4 fail
and `gate:noop` 17 fail. It did not reproduce in six subsequent runs (3× each) or in
individual re-runs. The most likely cause is that it landed while `emit.js` was being
rewritten underneath by the concurrent agent. I could not prove that, so it is recorded as
an unexplained one-off rather than dismissed. Separately, `npm test` leaks one temp fixture
directory per run (15 accumulated during this session, 411 MB in `$TMPDIR`) on a volume that
is at **99% capacity, 2.7 GiB free**.

### 7. Guardrails — VERIFIED

* **MIT.** `LICENSE` is the MIT text, `package.json` says `"license": "MIT"`.
* **Network-free.** Independent grep for `node:http|https|net|dns|tls|dgram|child_process|
  worker_threads` imports across `src/core/` → none. `purity.test.js` additionally blocks
  bare `fetch(`, `spawn(`, `exec(`. Zero production dependencies (`dependencies`,
  `peerDependencies`, `optionalDependencies` all `undefined`, asserted by a test and again
  by a CI step).
* **Account-free.** No auth, login, token or account code in `src/core/`.
* **HTML report has no remote reference.** Counted on the generated 148,517-byte page:
  `http://` 0, `https://` 0, `//` 0, `src=` 0, `href=` 0, `<script` 0, `fetch(` 0,
  `@import` 0, `url(` 0, `integrity=` 0, `crossorigin` 0, `ws://` 0, `wss://` 0, `data:` 0.
  Written 0600.
* **Legacy flow unchanged.** `node bin/omegas-dev.js --help` prints the original hosted
  help. `src/cli.js` imports only `./discovery.js` and `./env.js` — never `core/`.
  Its tests pass: `api` 5, `discovery` 3, `discovery-warnings` 4,
  `discovery-integration` 4, `env` 2, `preview` 8.
* **Cutover is a separate projection, not wired in.** `src/hosted/local-transfer-v1.js` is
  imported by nothing in `bin/` or `src/cli.js`; its only consumer is
  `test/cutover.test.js` (13 parity tests, all pass).
* **Seam documented as bundle format + exit codes only.** `docs/ARCHITECTURE.md` §13 and
  `SECURITY.md` line 126: "attaches to the open core through exactly two things … never
  imports an open-core module and never reads the state directory."

### 8. Credentials guardrail — VERIFIED

`docs/RELEASE_CHECKLIST.md` opens with **"0. BLOCKING — rotate the two pre-existing local
credential exposures"**, above the gates, above packaging, above publish, and states that
item 0 blocks everything below it including a publish dry run.

Both exposures are named **by location only** — `~/.claude/settings.local.json` inside a
`permissions.allow[]` entry, and `~/.codex/rules/default.rules` — with no value, no partial
value and an explicit instruction not to paste one anywhere.

Two tests enforce this, both passing:

* `test/release.test.js:39` — asserts `docs/RELEASE_CHECKLIST.md` is **not** in
  `npm pack --dry-run`. Confirmed independently: it is absent from the 74 shipped files,
  and `package.json` lists the four shipped docs individually rather than shipping `docs/`.
* `test/release.test.js:44` — asserts the checklist contains no credential-shaped string.

Repo-wide sweep for a real credential across 18 vendor shapes plus PEM headers: every hit is
either literally `FAKE`-shaped (`sk-proj-FAKE0000FAKE0000FAKE0000`,
`xoxb-000000000000-FAKEFAKEFAKEFAKEFAKE`), an obvious keyboard-walk
(`ghp_aB3dE5gH7jK9lM1nO3pQ5rS7tU9vW1xY3zA5`), or AWS's own published example
(`AKIAIOSFODNN7EXAMPLE`, which `src/core/redact/entropy.js:58` explicitly handles). No real
value anywhere in source, tests, fixtures or docs.

The tool does not touch those credentials: no rotation code, no write path to
`~/.claude/settings.local.json` or `~/.codex/rules/`, and every write resolves against the
target home rather than `os.homedir()` (`src/core/fsx/paths.js:436`).

### 9. No forbidden actions — PARTIAL

Verified clean: `git remote -v` unchanged (`https://github.com/OmegaAgent/omegas-dev.git`);
`continuity/build` has **no upstream** and `git ls-remote origin continuity/build` returns
nothing — the branch is local and was never pushed; 5 commits ahead of `origin/main`, all
local; nothing published, merged or deployed. Legacy `src/cli.js` intact; cutover adapter
separate and unwired; no production config replaced.

Real config was not touched by the tool. Every CLI invocation used `--home <fixture>`;
`~/.omegas` still has an mtime of 2026-07-30 22:48 (before this session) and no
`~/.omegas/continuity` directory exists, which is where the tool would have written.
`~/.claude.json` and `~/.codex` show session-time mtimes, which is the running Claude Code
and Codex processes, not this tool.

The deduction is only this: **the working tree is not clean.** The task described it as
clean after the lead's commits; it is not, and the delta is a security fix (see §0 and
below), not noise.

### 10. Honesty of claims — PARTIAL

Good:

* **No CONVERT ships without losses.** Driving `matrix()` directly over all 19 kinds and 9
  pairs: CONVERT cells with an empty `losses` array → **0**. Every one names what it drops,
  and the loss list is half declared and half *computed* from the item's own unrecognized
  keys against the target format — e.g. `experimentalRetry (null -> toml): TOML v1.0.0
  defines no null type, so a null-valued key has no representation and is dropped`.
* **UNKNOWN is kept distinct from UNSUPPORTED** in the vocabulary, the code, the legend and
  the Hermes rows.
* **No "lossless conversion" claim anywhere.** The word appears only in scoped, accurate
  places: `docs/ARCHITECTURE.md:122` about payloads carrying `raw` as authoritative,
  `CHANGELOG.md:151` about undocumented keys surviving verbatim, and two adapter notes about
  a specific same-frontmatter file move.
* **`--include-secrets` and blanket `--yes` are refused with a sentence**, not an "unknown
  argument" error.
* The report ends "Read-only: nothing was written, nothing was uploaded, no network or
  subprocess was used" — true as run.

The deduction: **the "Written DISABLED" message is false for a `--yes-inert` skill import**
(§1a). The tool tells the user an item is off, names the command to turn it on, and that
command reports there is nothing to turn on — while the item sits live on disk. That is the
one place where output and behaviour disagree, and it is in the consent path, which is the
worst place for it.

Related, on the committed tree only: `commandHelp()` promises `--yes-inert` "never covers an
authority item, an executable item, or a replacement." At `abfc47b` that promise fails — see
below.

---

## 2. Guarantees reproduced independently

Each of these was driven through the real binary as a child process, on materialized fixture
homes, with the checking done by my own code rather than the project's.

**(a) Zero secrets in an exported bundle.** Seeded a fixture home with 215 placements /
**209 distinct fake credentials** across every surface (MCP env, MCP headers, MCP URL
userinfo, settings env, permission rules, hook argv, statusline argv, Codex TOML env and
http_headers, shell env policy, seven prose files, auto-memory, skill frontmatter and body,
subagent, base64-wrapped, and a scan-and-refuse `.rules` sink), exported, then grepped the
**bundle bytes** (UTF-8 and latin1) for every secret substring:

```
bundle_bytes 334863   distinct_seeded_secrets 209   redaction_placeholders 416
LEAKS: []
WRAPPED_OR_FULL_VALUE_LEAKS: []
shared_value_leaked: false
```

Zero. The CLI's own post-export scan reported `passed` and 211 distinct secrets across 309
sites. The same-value-in-two-surfaces case collapsed to one ref with two sites, as designed.

**(b) No consent, no write.** Snapshotted two target homes recursively (path, sha256, size,
mode, symlink target) before and after `diff`, after `import` with every prompt answered
`n`, and after `import` with stdin closed immediately:

```
target home (8 paths):   diff [] · import-all-no [] · import-eof []
source home (84 paths):  diff [] · import-all-no [] · import-eof []
```

Zero changes in all six runs. The non-interactive path refuses explicitly: "This run is not
interactive and no consent flag was given, so nothing was applied."

**Re-import is byte-identical.** A consented `--yes-inert` import wrote 18 paths; a second
identical import changed nothing (`BYTE_IDENTICAL_ON_REIMPORT: true`, "Nothing consented to;
nothing was written", exit 0). The applied files carry `{{OMEGA_REDACTED:class:ref}}`
placeholders — 17 in `settings.json` — and a sweep of every applied file for the seven
vendor credential shapes found nothing.

**(c) The HTML report loads nothing.** 148,517 bytes, zero hits across thirteen remote-
reference patterns (§7), zero vendor-shaped secrets, mode 0600. It is rendered only from a
bundle — `report --html` without `--bundle` is refused with an instruction to export first.

**(d) Derived matrix, Hermes UNKNOWN.** §3. 95/95 Hermes cells UNKNOWN with the
not-surveyed note; distribution `NATIVE 31, CONVERT 10, UNKNOWN 95, UNSUPPORTED 27,
ADVISE 8`.

**(e) Refusals are visible, with units.** `report` section 8 ("REFUSALS AND LIMITS", headed
"Deliberate absence is data. Every rule that fired is listed; silence would be the bug")
prints 18 exclusion rules with `matched`, `unit` (keys / files) and `bytes` — e.g.
`codex.rules_secret_sink 2 files 394`, `claude.transcripts 1 files 37`. The `unresolved_link`
node is a first-class item in the kind census, and section 8 names it:
`escaping-skill -> ../../../outside/skills/escaping — refusal: target outside every declared
root`.

---

## 3. Gaps and risks, ranked

**1 — `abfc47b` has a live `--yes-inert` quarantine bypass; the fix is uncommitted.**
The uncommitted red-team file, run against the archived committed tree, fails **4 of 4**:

```
✖ red team: a key another surface claims cannot be imported under the catch-all settings surface
✖ red team: a settings key the surface declares as an argv position is executable
✖ red team: --yes-inert never writes a live hook, statusline or permission rule
✖ red team: the same relabelling cannot be applied even with consent forced on every operation
```

Against the working tree, 4/4 pass. So the thing currently labelled v0.2.0 will, given a
hostile bundle that relabels a hook or statusline as a plain `setting`, write it live under
`--yes-inert` — exactly what the CLI's own help says can never happen. Do not tag, publish
or share `abfc47b`. Commit the `emit.js` fix and the red-team test, then re-verify.

**2 — Quarantine's two halves are consented separately, so "Written DISABLED" can be false.**
Independent of the red team above and **not fixed in either tree**. `--yes-inert` accepts the
bulk `create_file` and refuses the individual `merge_key` that disables it; the skill lands
live, `enable` says "nothing to enable", exit 0. Either both operations must share one
consent decision (which the code comment already claims), or the item must not be written at
all when its disabling companion is not consented to. This is a correctness bug in the
consent model, and it prints a false statement to the user.

**3 — CI will be red on the first push, for a reason that is invisible locally.**
`abfc47b` scores 389/392 from a clean checkout. Two of the three missing fixtures are a
personal-gitignore accident (`**/.claude/settings.local.json`); the third and fourth
(`.git/config` under two fixture projects) can never be tracked by git at all, so
git-remote project identity and monorepo collapse have no fresh-clone coverage. Fix by
force-adding the settings fixture and renaming the fixture `.git` directories to something
git will track (e.g. `dotgit/`) with materialize.js renaming them on the way out.

**4 — No property-based testing, and adversarial is 13 tests.** The generated corpora are
good and the adversarial cases are well chosen, but every input is one a human enumerated.
For a tool whose core promise is "no secret ever reaches the bundle" and whose input is an
attacker-authored file, a fuzz/property layer over the bundle reader and the redactor is the
highest-value test still missing.

**5 — Continuity is invisible from `--help`.** The binary's top-level help documents only
the hosted flow. Everything built over these five commits is undiscoverable to anyone who
does not read the README first.

**6 — Hermes has no column in the rendered matrix.** Correct in `--json` and disclosed in
prose above the table, but a reader scanning the table sees a two-runtime tool.

**7 — Operational hygiene.** `npm test` leaks one temp fixture home per run (15 leaked,
411 MB) on a volume at 99% / 2.7 GiB free. One unreproduced gate failure was observed under
those conditions and is unexplained.

---

## 4. What I could not verify

* **Node 20 and 24.** Everything here ran on the local Node 25.6.1. The CI matrix declares
  20/22/24; I did not install other runtimes, and CI has not run because the branch was
  never pushed. Given finding 3, the first CI run is expected to be red regardless.
* **`npm publish` output.** Verified via `npm pack --dry-run`, not by publishing.
* **The two real credential exposures.** Confirmed only that the checklist names them by
  location, prints no value, is excluded from the tarball, and that the tool cannot modify
  them. Whether the founder has rotated them is not observable from here.
* **A stable single-artifact verdict.** Two agents were editing while I measured. Every
  number above is stamped to either `abfc47b` or the working tree as it stood between
  01:15 and 01:30 on 2026-07-31.
