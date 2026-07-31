// Bundle construction for tests, including hostile ones.
//
// The adversarial corpus needs bundles that are STRUCTURALLY valid — correct digests,
// correct entry list — and hostile in their content, because that is the interesting case:
// a bundle that fails its own integrity check never reaches the planner, so it proves
// nothing about the planner. `craft()` therefore always seals correctly, and the malformed
// cases mutate the sealed bytes afterwards, on purpose, one property at a time.

import { computeDigest, sha256 } from "../../src/core/bundle/digest.js";
import { blobName } from "../../src/core/bundle/names.js";
import { SCHEMA_VERSION, serialize } from "../../src/core/bundle/write.js";

export function blob(text) {
  const digest = sha256(text);
  return {
    name: blobName(digest),
    sha256: `sha256:${digest}`,
    bytes: Buffer.byteLength(text),
    media_type: "text/plain",
    encoding: "utf-8",
    content: text,
  };
}

/** A minimal but complete Item, with only the fields the import planner reads. */
export function item(fields) {
  const raw = fields.raw_text === undefined ? null : blob(fields.raw_text);
  return {
    entry: raw,
    item: {
      item_id: fields.item_id,
      kind: fields.kind,
      runtime: fields.runtime ?? "claude",
      surface_id: fields.surface_id,
      scope: fields.scope ?? "user",
      layer_id: `${fields.runtime ?? "claude"}/${fields.scope ?? "user"}`,
      project_id: null,
      name: fields.name ?? fields.item_id,
      identity: { from: fields.identity_from ?? "map_key", value: fields.identity, stable_across_runs: true },
      origin: {
        path: fields.origin_path ?? "${CLAUDE_HOME}/settings.json",
        display_path: fields.display_path ?? "~/.claude/settings.json",
        key_path: fields.key_path ?? null,
        span: null,
        link: null,
      },
      payload: {
        format: fields.format ?? "json",
        raw: raw ? { entry: raw.name, sha256: raw.sha256, bytes: raw.bytes, encoding: "utf-8", eol: "lf" } : null,
        parsed: fields.value === undefined ? null : { value: fields.value, key_order: [] },
        recognized: {},
        unrecognized: {},
      },
      assets: fields.assets ?? [],
      portability: { verdict: "PORTABLE", reasons: [], rewrites: [] },
      trust_tier: fields.trust_tier ?? "INERT",
      ...(fields.authority ? { authority: true } : {}),
      applied: true,
      ...(fields.export_refused ? { export_refused: true, export_refused_by: "test" } : {}),
      content_id: raw ? raw.sha256 : null,
      redaction_refs: fields.redaction_refs ?? [],
      related: fields.related ?? [],
    },
  };
}

export function craft({ items = [], extraBlobs = [], bundleId = "ocb_test_0001", createdAt = "2026-07-30T00:00:00.000Z" }) {
  const entries = new Map();
  const publicItems = [];
  for (const record of items) {
    if (record.entry) entries.set(record.entry.name, record.entry);
    for (const asset of record.item.assets ?? []) {
      if (asset._blob) {
        entries.set(asset._blob.name, asset._blob);
        delete asset._blob;
      }
    }
    publicItems.push(record.item);
  }
  for (const extra of extraBlobs) entries.set(extra.name, extra);

  const entryList = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  const manifest = {
    schema_version: SCHEMA_VERSION,
    bundle: {
      id: bundleId,
      created_at: createdAt,
      // Deliberately NOT the current production values. These bundles arrive from
      // elsewhere and are read as hostile input, so a foreign generator — here, the
      // pre-rename name — keeps proving the reader never branches on the field.
      generator: "omegas-dev",
      generator_version: "0.2.0-test",
      digest: "",
      digest_algo: "sha256",
      entry_count: entryList.length,
      byte_count: entryList.reduce((total, entry) => total + entry.bytes, 0),
      payload_policy: "definition+scripts",
      complete: true,
    },
    redaction: { detector_version: "test", placeholders: 0, post_export_scan: { status: "passed", high_tier_hits: 0 } },
    environment: { host: { os: "darwin", arch: "arm64", home_label: "~" }, runtimes: [] },
    projects: [],
    layers: [],
    capabilities: [],
    items: publicItems,
    effective: [],
    redactions: [],
    findings: [],
    exclusions: [],
    truncations: [],
    policy: { never_export: [], caps: {} },
    entries: entryList.map(({ name, sha256: digest, bytes, media_type: mediaType }) => ({
      name,
      sha256: digest,
      bytes,
      media_type: mediaType,
    })),
  };
  manifest.bundle.digest = computeDigest(manifest, entryList);
  return { manifest, entries: entryList, serialized: serialize(manifest, entryList) };
}

/** Re-seal after a hostile edit, so the bundle is VALID and its content is the attack. */
export function reseal(manifest, entries) {
  const sealed = JSON.parse(JSON.stringify(manifest));
  sealed.bundle.digest = "";
  sealed.entry_count = entries.length;
  sealed.entries = entries.map(({ name, sha256: digest, bytes, media_type: mediaType }) => ({
    name,
    sha256: digest,
    bytes,
    media_type: mediaType,
  }));
  sealed.bundle.entry_count = entries.length;
  sealed.bundle.byte_count = entries.reduce((total, entry) => total + entry.bytes, 0);
  sealed.bundle.digest = computeDigest(sealed, entries);
  return { manifest: sealed, entries, serialized: serialize(sealed, entries) };
}

/** Replace the first line of a serialized bundle — used by the tamper cases. */
export function withManifestLine(serialized, transform) {
  const lines = serialized.split("\n");
  lines[0] = transform(lines[0]);
  return lines.join("\n");
}
