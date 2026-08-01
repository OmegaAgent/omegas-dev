# Migrating from `omegas-dev` to `@omegas/continuity`

The tool is called **Continuity**. It ships as **`@omegas/continuity`** and installs a
binary named **`continuity`**. The older unscoped `omegas-dev` name is retired.

This document is the plan for that retirement. **Nothing described under "The deprecation
wrapper" has been published yet** — it is written down first so the rename cannot quietly
strand anyone.

## What changed for you

| Before | Now |
|---|---|
| `npx omegas-dev report --root ~/Code` | `npx @omegas/continuity report --root ~/Code` |
| `omegas-dev <command>` | `continuity <command>` |
| package `omegas-dev` | package `@omegas/continuity` |

That is the whole list. The rename is an identity change and nothing else:

- No source file, module path or export was renamed.
- The bundle format is untouched — still `omegas.continuity.v1`, same fields, same digest
  rules. A bundle exported before the rename imports afterwards with no conversion, and
  [BUNDLE_FORMAT.md](BUNDLE_FORMAT.md) still describes it exactly.
- Exit codes, flags and the `--json` envelope are unchanged, so anything scripted against
  [ARCHITECTURE.md](ARCHITECTURE.md) keeps working once the command name is updated.

The one cosmetic difference: bundles written by this version record `@omegas/continuity` in
the manifest's `generator` field, and the HTML report footer prints that. The field has
always been a free-form producer label — no reader matches on its value, and older bundles
keep whatever they recorded.

## The deprecation wrapper (planned, not yet published)

Leaving `omegas-dev` installable but frozen at 0.1.x would let someone install it, read a
README describing commands their binary does not have, and conclude the tool is broken. The
plan is a stub release under the old name whose only job is to redirect.

Shape of the stub:

- A final `omegas-dev` version, published from a `deprecation/omegas-dev-stub` directory
  that is **not** this package. It carries no `src/`, no `bin/` and no dependencies.
- `npm deprecate omegas-dev "renamed to @omegas/continuity"`, so the notice reaches anyone
  installing any version, including the older working ones.
- A `postinstall` script that prints the new install command and exits `0`:

  ```text
  omegas-dev is now @omegas/continuity.

    npx @omegas/continuity --help

  Nothing was installed. See https://github.com/OmegaAgent/continuity/blob/main/docs/MIGRATION.md
  ```

Constraints the stub has to respect, because a redirect package is an easy place to do
something users would not accept:

- **Exit `0`, always.** A non-zero postinstall fails the whole `npm install` of whatever
  pulled it in, which punishes the wrong person.
- **Print, never act.** It does not install the new package, write to the filesystem, or
  read anything on the machine. A postinstall that runs on every install of a transitive
  dependency is the last place that should touch a home directory.
- **No network, no telemetry.** Counting the redirect is not worth a beacon in a
  postinstall, and it would contradict what the real package promises.
- **Do not reuse a version number.** The stub takes the next patch above the last real
  `omegas-dev` release, so no already-installed version is retroactively replaced.

Nothing about the stub is required for `@omegas/continuity` to work. It exists only so the
old name resolves to an answer instead of a dead end.

## If you have the old package installed

```sh
npm uninstall -g omegas-dev        # if it was installed globally
npx @omegas/continuity --help      # no install needed for a one-off run
```

Local state carries over untouched. Nothing is keyed to the package name: the preview
directory is still `~/.omegas/state/previews`, and any `.ocb.jsonl` bundle you already
exported stays readable — see [IMPORT_MODEL.md](IMPORT_MODEL.md) for what importing one
will and will not do to a machine.
