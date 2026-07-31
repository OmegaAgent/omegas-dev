# Ωmegas Continuity bundle format

`schema_version: omegas.continuity.v1`

This is the published contract for the `.ocb.jsonl` artifact produced by `continuity export`.
It is written for someone implementing a reader or writer independently, in any language.
The reference implementation is `src/core/bundle/` and `src/core/redact/` in this package;
where this document and the code disagree, the document is the bug.

Related: [ARCHITECTURE.md](ARCHITECTURE.md) for how the engine that produces a bundle is
built and where the open/closed boundary sits, [IMPORT_MODEL.md](IMPORT_MODEL.md) for what a
reader is allowed to do with one, [CUTOVER.md](CUTOVER.md) for the legacy payload shape this
format replaces.

## 0. The invariant everything else rests on

**A bundle never carries a credential value. Not encrypted, not sealed, not opt-in.**

Values are replaced by placeholders that name a *class* and a *reference*; the reference is
re-bound to a real value on the target machine at import time. There is no flag that turns
this off, there is no second "complete" artifact, and the exporter re-scans its own
serialized output before writing it (§6). A reader who finds one of these files in a gist
can rely on that, and can verify it: the bytes are text.

What a bundle *does* carry, deliberately, is structure — that a value existed, the key name
it lived under, which server or hook or file owned it, what class of secret it was, and how
many places it appeared. Redaction hides values; it must never hide structure.

## 1. Physical format

A bundle is one UTF-8 text file of newline-delimited JSON, conventionally named
`omegas-continuity-<label>-<YYYYMMDD>.ocb.jsonl`.

```
line 0   the manifest (§2)
line 1…n entries: {"name": …, "sha256": …, "encoding": "utf-8", "content": …}
```

The file ends with a trailing newline. Lines are not indented; each is a complete JSON
value. Empty lines are ignored on read.

JSONL rather than tar or zip because it is zero-dependency to read and write, streamable,
line-diffable in git, and safe to paste into an issue — and because a package whose
zero-dependency posture is a trust asset should not ship an archive parser.

### Entries

Every entry is a *blob*: a content-addressed piece of text referenced from the manifest.

```json
{"name": "blobs/3f/3f786850e387550fdab836ed7e6dc881de23001b", "sha256": "sha256:3f78…", "encoding": "utf-8", "content": "…"}
```

- `name` — `blobs/<first two hex chars of sha256>/<full sha256>`.
- `sha256` — `sha256:` followed by 64 lowercase hex characters, over the UTF-8 bytes of
  `content`.
- `encoding` — `utf-8` in v1. No other value is defined; a reader must refuse what it does
  not know.

Identical content is stored once. Because names are derived from content, an entry name
carries no user path information and name collisions are impossible by construction.
Human-meaningful paths live in `items[].origin.display_path`, which is *data* — never a
filesystem target.

## 2. Manifest

```json
{
  "schema_version": "omegas.continuity.v1",
  "bundle":       { "id", "created_at", "generator", "generator_version",
                    "digest", "digest_algo", "entry_count", "byte_count",
                    "payload_policy", "complete" },
  "redaction":    { …§5 },
  "environment":  { "host": { "os", "arch", "home_label" }, "runtimes": [ … ] },
  "projects":     [ … ],
  "layers":       [ { "layer_id", "runtime", "scope", "rank", "source_label", "present", "suppressed_by" } ],
  "capabilities": [ { "runtime", "display_name", "adapter_version", "status",
                      "kinds":      { "<kind>": "native|convertible|advisory|unsupported" },
                      "surfaces":   [ { "surface_id", "kind", "format" } ],
                      "transforms": [ TransformDescriptor ] } ],
  "items":        [ Item ],
  "effective":    [ EffectiveEntry ],
  "redactions":   [ RedactionEntry ],
  "findings":     [ Finding ],
  "exclusions":   [ ExclusionMatch ],
  "truncations":  [ TruncationRecord ],
  "policy":       { "never_export": [ PolicyRule ], "caps": { … } },
  "entries":      [ { "name", "sha256", "bytes", "media_type" } ]
}
```

`capabilities[]` is a snapshot of the source adapters' own declarations, and it carries
everything the compatibility engine reads: the capability level per kind, the declared
surfaces with their formats, and the transform descriptors with their evidence citations.
So the matrix is derivable **from the bundle alone**, on a machine running a different
version of this tool, months later — and what it derives is *that bundle's* matrix rather
than today's. A `status` of `declared` means the runtime was never surveyed, and every cell
involving it derives `UNKNOWN` rather than `UNSUPPORTED`; the two are different claims and
a reader must not collapse them.

`policy.never_export[]` is the exclusion rule table as data — rule id, match pattern,
class, severity and reason — so a reader can see what the exporter refused to look at and
why.

`bundle.complete` is `false` when any cap was hit (§7). A partial bundle is valid; a silent
one would not be.

## 3. Digest

```
digest = "sha256:" + sha256( join("\n", sorted(records)) )

records = [ entry_name + NUL + entry_sha256  for each entry ]
        + [ "manifest" + NUL + "sha256:" + sha256(manifest_for_hashing) ]
```

- The separator is a literal NUL byte (`U+0000`). Entry names may contain any
  non-control character, so a printable separator would be ambiguous — and an ambiguous
  separator is a forgeable digest.
- `entry_sha256` includes the `sha256:` prefix.
- `sorted` is a plain lexicographic sort of the record strings.
- `manifest_for_hashing` is the manifest serialized as JSON with three fields blanked to
  the empty string: **`bundle.digest`, `bundle.id`, and `bundle.created_at`**.

Blanking `id` and `created_at` is what makes the digest content-addressed: two exports of
identical configuration must produce the same digest even though each run mints a fresh id
and timestamp. Without that, reconciliation and cross-implementation agreement are
impossible. Both fields remain *in* the manifest; they are simply outside digest scope.

A reader verifies by recomputing. A mismatch is tampering (or a writer bug) and must be
refused, not repaired.

## 4. Entry-name canonicalization

Applied on write **and re-applied on read**. A violation on read is a hard refusal. Never
normalize an offending name into an acceptable one: a repaired name is an attacker's name
that you decided to trust.

| Rule | Refuse |
|---|---|
| Unicode NFC; re-check after normalizing | NFD sequences that become `..` |
| POSIX `/` separators only | `\`, mixed separators |
| Relative only | leading `/`, `~`, `C:`, UNC `\\` |
| No `.` or `..` or empty segment | `a/../b`, `a//b` |
| No NUL, no C0/C1 control bytes | |
| Segment ≤ 255 bytes, whole path ≤ 1024 bytes, depth ≤ 16 | |
| No reserved Windows basename (`CON` `PRN` `AUX` `NUL` `COM1-9` `LPT1-9`), no trailing `.` or space | |
| No case-insensitive collision with another entry in the same bundle | `blobs/aa/abc` and `blobs/aa/ABC` |
| Name begins with one of the fixed prefixes `blobs/`, `items/`, `derived/` | anything else |

v1 writers emit only `blobs/`. The other two prefixes are reserved so a later version can
add exploded representations without changing the refusal rule.

Additionally, on read: every entry declared in `manifest.entries` must be present, and
every present entry must be declared. An undeclared entry is smuggled content; a declared
but absent one is a dangling pointer.

## 5. Redaction

### 5.1 Placeholder grammar

```
{{OMEGA_REDACTED:<class>:<ref>}}

<class> ::= [a-z][a-z0-9_]* ("." [a-z][a-z0-9_]*)+
<ref>   ::= "s" [0-9]+
```

A placeholder appears inline, in place of the value, wherever that value stood — inside a
JSON string, inside a Markdown line, inside a shell command. It replaces the *smallest*
span that is the credential: an `Authorization` value keeps its `Bearer ` scheme word, a
DSN keeps its host and database, a URL keeps its endpoint, a permission rule keeps its
command, and an env-prefix assignment keeps its key name.

**Placeholders never nest**, and an existing placeholder is never re-wrapped: running a
redaction pass over an already-redacted bundle is a no-op. That is also what makes the
output stable across runs, which is what makes a diff readable.

The placeholder carries **no length, no prefix, no suffix, and no digest of the value**.
For a known class the length is implied by the class and adds nothing; for
`unknown.high_entropy` it would be the only thing that leaks.

### 5.2 `ref` semantics

`<ref>` is a bundle-local sequential label assigned **by value identity**: the same secret
appearing in five places gets the same `ref` five times, in every surface it appears in.
This is the property that defeats partial redaction — the failure where a key pasted into
both an MCP `env` block and a `CLAUDE.md` sentence is caught in one place and missed in the
other.

Identity is computed as `HMAC-SHA256(bundle_salt, normalized_value)` where `normalized_value`
is the value trimmed of surrounding whitespace and quotes. The salt is 32 random bytes per
bundle and lives **only in the local secret map**, never in the bundle. Only the sequential
label is emitted, so the bundle contains no value-derived bytes at all.

Labels are handed out in first-encounter order during a deterministic traversal, so two
exports of identical content produce identical labels even though the salts differ — which
is what keeps the digest stable.

### 5.3 Side table

```json
"redactions": [
  { "ref": "s1", "class": "slack.token", "tier": "HIGH",
    "detector": ["positional", "regex"], "confidence": "high",
    "key_names": ["SLACK_BOT_TOKEN"],
    "sites": [
      { "item_id": "…:mcp_server:slack", "key_path": "env.SLACK_BOT_TOKEN" },
      { "item_id": "…:instructions:CLAUDE.md", "span": { "line_start": 42 } }
    ] }
]
```

Sites are **item-anchored**, not path-anchored, so linkage survives a rename.

`confidence` has exactly two values and the distinction is load-bearing:

- `high` — a detector recognized the **value**: a provider prefix, a DSN password, a JWT,
  a high-entropy blob at a declared sink.
- `structural` — the value was redacted for **where it sat** (an env block, a header map, a
  URL credential position) and nothing further is claimed about it. A harmless feature flag
  in an `env` block lands here. Reporting it as high confidence would overstate the finding
  and erode trust in the rest of the table.

`detector` is the union of the layers that fired: `positional`, `keyname`, `regex`,
`entropy`, `argv`, `decoded`, `value_link`.

### 5.4 Header

```json
"redaction": {
  "engine_version": "1.0.0",
  "pattern_set": "omegas-continuity-patterns@2026-07",
  "placeholder_format": "{{OMEGA_REDACTED:<class>:<ref>}}",
  "distinct_secrets": 12, "placeholder_sites": 19,
  "shape_confirmed": 10, "positional_only": 2,
  "classes": ["slack.token", "env.kv"],
  "allowlisted_keys": ["NODE_REPL_TRUSTED_CODE_PATHS"],
  "post_export_scan": { "status": "passed", "high_tier_hits": 0 }
}
```

The header is the first thing a reader who finds this file out of context sees. It says
that the artifact is redacted, by which detector version, how many placeholders it carries,
which key names were deliberately **not** redacted (the curated allowlist), and that the
post-export gate ran.

### 5.5 Detector classes

Class ids are stable dotted strings and are contract: they appear inside every placeholder,
and a reader on another machine has to be able to look one up. v1 ships roughly thirty,
including `anthropic.api_key`, `openai.api_key`, `aws.access_key_id`, `aws.secret_key`,
`github.token`, `github.fine_grained_pat`, `gitlab.token`, `slack.token`,
`slack.app_token`, `slack.webhook`, `stripe.secret_key`, `stripe.webhook_secret`,
`google.api_key`, `google.oauth_client_secret`, `groq.api_key`, `npm.token`,
`huggingface.token`, `sendgrid.api_key`, `pypi.token`, `twilio.api_key`,
`twilio.account_sid`, `jwt.token`, `pem.private_key`, `db.dsn_credential`,
`url.credential`, `http.authorization`, `figma.token`, `linear.api_key`,
`provider.sk_opaque`, `card.number`, `env.kv`, `unknown.named_key`,
`unknown.high_entropy`, `argv.flag_value`.

Each has a tier — `HIGH`, `MEDIUM`, `LOW` — which drives the export gate (§6) and the recall
budget. Classes are additive across minor versions: a reader must tolerate a class it has
never seen, because the placeholder grammar tells it everything it needs to re-bind.

## 6. The post-export gate

Before any bytes reach the disk, the exporter serializes the bundle and re-scans **those
exact bytes** with the full detector, plus the set of values it redacted during this run.
Any HIGH-tier hit aborts: no file is written, and the CLI exits **5**.

This is deliberately redundant with the redaction pass. It cannot catch a class the
detector does not know — nothing can — but it does catch the plumbing failures that
otherwise ship silently: a derived view rebuilt from a stale tree, a text field redacted in
one representation and not another, a value carried in a field nobody thought about.

Exit codes: `0` clean, `1` usage, `2` no runtime found, `3` completed with warnings,
`5` post-export gate failed, `10` a runtime is below its adapter's supported floor.

## 7. Caps, truncations and `payload_policy`

Every cap breach is a **reported condition**, never a silent truncation.

| Cap | Default | On breach |
|---|---|---|
| Per-file bytes | 1 MiB | `truncations[]` record; item kept, `payload.raw.truncated: true` |
| Per-entry blob | 4 MiB | entry refused, recorded; item kept with `payload.raw.included: false` |
| Entries | 5,000 | stop, record, `complete: false` |
| Items | 20,000 | stop, record, `complete: false` |
| Total bundle bytes | 64 MiB | refuse to build |
| Walk depth | 16 | stop, record |
| Symlink hops | 4 | `unresolved_link` node |

`payload_policy` is a declared choice, not a hidden limit:

| Policy | Carries |
|---|---|
| `definition` (default) | the definition file of each item |
| `definition+scripts` | plus assets whose role is `script`, `lib`, `bin` or `reference` |
| `full` | every asset, under the caps above |

Assets that are **not** carried still appear in `items[].assets[]` with `included: false`, a
`reason`, a `bytes` count and a `sha256` — so the bundle states exactly what it left behind,
and a reader can tell whether the copy on their own machine is the same file. Carried assets
gain an `entry` pointer, and their bytes go through the same redaction pass as everything
else.

## 8. What is deliberately not in a bundle

Session transcripts, shell history, log databases, OS keychain material, OAuth token
stores, machine identifiers, trust state, and derived caches are never scanned and never
exported. When one of those rules fires it produces a visible `exclusions[]` record with a
count and a unit (`files` or `keys`) — deliberate absence is data, and silence is the bug.

One class is scan-and-refuse rather than skip: a surface known to be a general-purpose
secret sink is read for **structure** (how many rules, which commands are allow-listed) and
its bytes are dropped before they are ever retained. The exclusion record says so.

## 9. Local artifacts, which are not part of the format

Two files are written next to the bundle and must never be shared. Both are mode `0600` and
both live in the Continuity state directory (`~/.omegas/continuity/`), deliberately not in
`~/Downloads`:

- **`redaction-review-<label>-<date>.md`** — the local report. It carries the value *shape*
  (length, charset, entropy) that the bundle deliberately omits, split into
  shape-confirmed and positional-only findings. Its basename stem differs from the
  bundle's so the two can never be confused in a listing or a tab-completion.
- **`secrets/<bundle_id>.map.json`** — the per-bundle salt and, for each `ref`, a **pointer**
  to where the value lives on this machine (item, key path, line). It holds no value, no
  digest of a value, and no fragment of one; the writer asserts that mechanically and
  refuses to write if the assertion fails.

## 10. Versioning

`schema_version` is matched exactly. A reader must refuse a major it does not know rather
than guessing. Within `omegas.continuity.v1`, these changes are permitted and a reader must
tolerate them: new detector classes, new `detector` layer names, new item kinds, new finding
rules, new fields on existing objects. These are breaking and require a new
`schema_version`: a change to the digest algorithm or its scope, a change to the placeholder
grammar, a new entry-name prefix, or a change to the meaning of an existing field.
