# Release checklist

Work top to bottom. Item 0 blocks everything below it, including a dry run of the publish.

> **This file is repository-only and must never be published.** It names the files on a
> real machine that hold un-rotated credentials, which is exactly the kind of thing that
> should not be in a tarball on a public registry. `package.json` lists shipped docs
> individually rather than shipping `docs/`, and `test/release.test.js` asserts this file
> stays out of the package.

> **Do not publish until the founder approves.** This checklist getting to the bottom is a
> statement that the release is *ready*, not that it should go out. `npm publish` happens
> when a human says so.

---

## 0. BLOCKING — rotate the two pre-existing local credential exposures

Discovery found live-shaped credentials sitting in configuration that predates Continuity,
on the machine the research was run on. They are not caused by this tool and were never
printed, exported or committed by it — the scanner found them, which is the product thesis
working, and that is exactly why they must be dealt with before anything ships.

They are identified here **by file and by rule location only**. Do not print, paste, log,
screenshot or copy the values anywhere, including into a ticket.

| # | Location | What is there |
|---|---|---|
| 1 | `~/.claude/settings.local.json`, inside a `permissions.allow[]` entry | a `Bash(...)` allow rule with two provider keys embedded inline in the command line |
| 2 | `~/.codex/rules/default.rules` | a recorded `curl -H` argv line written by Codex's TUI allow-listing, carrying a key in the header argument |

Required, in order:

1. Rotate both key sets at the provider. Rotation first — editing the file does not
   un-leak a value that has been sitting in a world-readable-adjacent config.
2. Rewrite both rules to reference environment variable names instead of literals.
3. Re-run `omegas-dev scan --json` on that machine and confirm the two `critical` findings
   (`secret.in_permission_rule`, `codex.rules.secret_sink`) no longer fire.
4. Record in the release PR that step 1 happened, with no value and no partial value in
   the text.

This is `founder-decisions.md` §1, and it is first here for the reason stated there: these
are the strongest possible internal proof that real secrets hide in permission rules where
no field-based tool looks — which is a good reason to fix them, not to leave them as a demo.

---

## 1. Gates

Every one of these is a named npm script and a named CI step. Run them locally on the
release commit; do not read them from a stale CI run.

```sh
npm test                # the whole suite
npm run check           # every source file parses
npm run gates           # the ten gates below, in order
```

| Gate | What it proves | Status |
|---|---|---|
| `gate:purity` | adapters carry no functions, `core/` imports no network or subprocess module and nothing outside `core/`, the engine names no runtime | |
| `gate:secrets` | redaction recall against the seeded corpus, precision against the placeholder corpus, and a zero-secret bundle | |
| `gate:network` | no net imports, a full scan → export cycle with the network stubbed to throw, and no remote reference in the HTML report | |
| `gate:adversarial` | the hostile bundle corpus is blocked or quarantined, with zero writes outside staging | |
| `gate:noop` | nothing is applied without consent; a re-import is byte-identical | |
| `gate:compat` | the derived matrix still matches the researched verdicts, cell by cell | |
| `gate:cutover` | the legacy-payload projection is still at parity with the legacy scanner | |
| `gate:redteam` | a bundle cannot relabel a key onto a weaker surface, smuggle a never-export sink through a hard link or a skill asset, escape the home, or grant its own consent | |
| `gate:property` | generated inputs from a seeded in-repo PRNG hold the invariants: patching is byte-exact, canonicalized names never traverse, redaction is idempotent, the digest moves only with content | |
| `gate:release` | package contents, version agreement across four files, docs cross-links, and that this checklist stays out of the tarball | |

Fill in the status column in the release PR. "CI was green" is not the same claim as "I ran
the gate on this commit".

Also confirm:

- [ ] Node 20, 22 and 24 all green in CI (the matrix, not just the default).
- [ ] `npm ls --prod` is empty. Zero runtime dependencies is a trust asset, and it is one
      `npm install` away from being gone.

## 2. Package contents

```sh
npm pack --dry-run
```

- [ ] `bin/`, `src/`, the four shipped `docs/*.md`, `README.md`, `SECURITY.md`, `LICENSE` —
      and nothing else. `docs/RELEASE_CHECKLIST.md` (this file) must NOT be in the list.
- [ ] No `test/` path, no file matching `fixture`, no `*.test.js`.
- [ ] No fixture home, no `.ocb.jsonl`, no `.env`, no scratch file.
- [ ] The tarball is the size you expect. A jump means something got included.

CI enforces the first two in the `package contents` job; check the output rather than
trusting the job name.

## 3. Version and documentation

- [ ] `package.json` version bumped, and `package-lock.json` and the CHANGELOG heading match it.
- [ ] `CHANGELOG.md` has an entry for this version that itemizes what changed **and**
      carries the *Known limits* section forward. A release note that lists only
      improvements is advertising.
- [ ] `README.md` states what the tool does today, and its "What this does not do yet"
      section is still true.
- [ ] `SECURITY.md` threat model and out-of-scope list match what the code actually does.
- [ ] `docs/` cross-links resolve: ARCHITECTURE, BUNDLE_FORMAT, IMPORT_MODEL, CUTOVER,
      RELEASE_CHECKLIST.
- [ ] Any claim of the form "never", "always" or "cannot" in the README maps to a test that
      would fail if it stopped being true. If it does not, soften the wording or write the
      test.

## 4. Behaviour, checked by hand once

Automated tests run against fixtures. Run the real binary once against a materialized
fixture home before shipping, because a CLI can pass every unit test and still print
something incoherent.

```sh
node test/fixtures/materialize.js                       # prints a temp home
node bin/omegas-dev.js report  --home <home> --root <home>/projects
node bin/omegas-dev.js compat  --home <home> --root <home>/projects
node bin/omegas-dev.js export  --home <home> --root <home>/projects --out /tmp/r.ocb.jsonl
node bin/omegas-dev.js report  --html /tmp/r.html --bundle /tmp/r.ocb.jsonl
node bin/omegas-dev.js diff    --bundle /tmp/r.ocb.jsonl --home <a second fixture home>
```

- [ ] The HTML page opens, reads cleanly in both light and dark, and shows no broken layout.
- [ ] Open it with the network disconnected. It should look identical, because it loads
      nothing.
- [ ] `grep -c '//' /tmp/r.html` returns 0.
- [ ] No real `~/.claude`, `~/.codex` or `~/.omegas` was touched during any of the above.
- [ ] Delete the temp artifacts afterwards. They contain a full configuration.

## 5. Publish (only after approval)

- [ ] The founder has approved this specific version.
- [ ] Item 0 is done, with the rotation confirmed rather than assumed.
- [ ] Publishing from the canonical repository, not a monorepo copy
      (`founder-decisions.md` §2).
- [ ] `npm publish` with 2FA, then install the published tarball into a clean directory and
      run `npx omegas-dev@<version> --help` to confirm what users actually receive.
- [ ] Tag the commit and attach the CHANGELOG entry to the release.
