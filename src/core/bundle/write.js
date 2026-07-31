// Manifest §5 — the single-file JSONL bundle. Line 0 is the manifest; lines 1..n are
// entries. JSONL because it is zero-dependency to read and write, streamable,
// line-diffable in git, and safe to paste — no tar parser and no new binary format in a
// package whose zero-dependency posture is itself a trust asset.
//
// There is exactly ONE artifact and it is the redacted one (THR §3.5). No `--include-secrets`,
// no second "complete" file next to it. The local human-readable report is a separate 0600
// file with a different basename stem, written by the CLI, never by this module.

import { publicItem } from "../model/item.js";
import { CAPS } from "../policy/caps.js";
import { computeDigest, DIGEST_ALGO, sha256 } from "./digest.js";
import { assertEntryName, blobName } from "./names.js";

export const SCHEMA_VERSION = "omegas.continuity.v1";
export const GENERATOR = "@omegas/continuity";

export const PAYLOAD_POLICIES = ["definition", "definition+scripts", "full"];

export function buildBundle({
  bundleId,
  createdAt,
  generatorVersion,
  items,
  layers,
  effective,
  redactions,
  redactionHeader,
  findings,
  exclusions = [],
  truncations = [],
  runtimes = [],
  projects = [],
  capabilities = [],
  neverExport = [],
  environment = {},
  payloadPolicy = "definition",
  assetTexts = new Map(),
  caps = CAPS,
  complete = true,
}) {
  if (!PAYLOAD_POLICIES.includes(payloadPolicy)) {
    throw new TypeError(`unknown payload_policy "${payloadPolicy}"`);
  }
  const entries = new Map();
  const seenFold = new Map();
  const capRecords = [...truncations];

  const addBlob = (text, mediaType) => {
    const bytes = Buffer.byteLength(text);
    if (bytes > caps.entry_blob_bytes) return { refused: "entry_blob_bytes", bytes };
    if (entries.size >= caps.entries) return { refused: "entries", bytes };
    const digest = sha256(text);
    const name = blobName(digest);
    assertEntryName(name, seenFold);
    if (!entries.has(name)) {
      entries.set(name, { name, sha256: `sha256:${digest}`, bytes, media_type: mediaType, encoding: "utf-8", content: text });
    }
    return { entry: name, sha256: `sha256:${digest}`, bytes };
  };

  const publicItems = [];
  for (const item of items) {
    if (publicItems.length >= caps.items) {
      capRecords.push({
        path: "-",
        display_path: "-",
        surface_id: "-",
        bytes: 0,
        kept_bytes: 0,
        cap: caps.items,
        reason: "item cap reached; the bundle is partial and complete=false",
      });
      complete = false;
      break;
    }
    const copy = publicItem(item);
    copy.payload = copy.payload ? JSON.parse(JSON.stringify(copy.payload)) : null;
    copy.assets = (copy.assets ?? []).map((asset) => ({ ...asset }));

    // "Its structure is still reported; its bytes never leave" has to be true of the
    // PARSED tree as well as the raw text. Nulling `_raw_text` at normalize is not enough
    // on its own: for a text surface the body IS the bytes and it lands inside
    // `payload.parsed`, so a refused file travelled with its content in a second field.
    // Reducing the tree to its shape happens here, at the one boundary where the claim
    // has to hold, so the local report keeps the fidelity a reader needs.
    if (item.export_refused && copy.payload) {
      copy.payload.parsed = structureOnly(copy.payload.parsed);
      copy.payload.recognized = structureOnly(copy.payload.recognized);
      copy.payload.unrecognized = structureOnly(copy.payload.unrecognized);
    }

    if (typeof item._raw_text === "string" && copy.payload) {
      const blob = addBlob(item._raw_text, mediaTypeFor(item.payload.format));
      if (blob.refused) {
        copy.payload.raw = { entry: null, sha256: null, bytes: blob.bytes, encoding: "utf-8", included: false };
        capRecords.push({
          path: item.origin.path,
          display_path: item.origin.display_path,
          surface_id: item.surface_id,
          bytes: blob.bytes,
          kept_bytes: 0,
          cap: blob.refused === "entries" ? caps.entries : caps.entry_blob_bytes,
          reason: `blob refused at the ${blob.refused} cap; the item and its structure are still carried`,
        });
        complete = false;
      } else {
        copy.payload.raw = {
          entry: blob.entry,
          sha256: blob.sha256,
          bytes: blob.bytes,
          encoding: "utf-8",
          eol: item._eol,
          ...(item._truncated ? { truncated: true } : {}),
        };
        copy.content_id = blob.sha256;
        if (copy.payload.parsed?.frontmatter && typeof item._body_text === "string") {
          const body = addBlob(item._body_text, "text/markdown");
          copy.payload.parsed.body_entry = body.refused ? null : body.entry;
        }
      }
    }

    // manifest §5.5 — the bundle states exactly what it did NOT carry. An asset left
    // behind keeps its size and digest, so a reader can tell whether the copy on their
    // machine is the same file. Which assets are carried was decided by the policy at
    // read time (engine/assets.js); this loop only places what it was given.
    const carried = assetTexts.get(item.item_id) ?? new Map();
    for (const asset of copy.assets) {
      const text = carried.get(asset.display_path);
      if (typeof text !== "string") {
        asset.included = false;
        asset.reason = asset.reason ?? `payload_policy=${payloadPolicy}`;
        continue;
      }
      const blob = addBlob(text, "text/plain");
      if (blob.refused) {
        asset.included = false;
        asset.reason = `blob refused at the ${blob.refused} cap`;
        continue;
      }
      asset.included = true;
      asset.entry = blob.entry;
      // The digest recorded here is of the REDACTED bytes, which is what the entry holds.
      asset.sha256 = blob.sha256;
      asset.reason = `payload_policy=${payloadPolicy}`;
    }
    publicItems.push(copy);
  }

  const entryList = [...entries.values()].sort((a, b) => a.name.localeCompare(b.name));
  const byteCount = entryList.reduce((total, entry) => total + entry.bytes, 0);
  if (byteCount > caps.bundle_bytes) {
    throw new TypeError(`bundle exceeds the ${caps.bundle_bytes}-byte cap at ${byteCount} bytes`);
  }

  const manifest = {
    schema_version: SCHEMA_VERSION,
    bundle: {
      id: bundleId,
      created_at: createdAt,
      generator: GENERATOR,
      generator_version: generatorVersion,
      digest: "",
      digest_algo: DIGEST_ALGO,
      entry_count: entryList.length,
      byte_count: byteCount,
      payload_policy: payloadPolicy,
      complete,
    },
    redaction: redactionHeader,
    environment: { host: environment.host ?? { os: "unknown", arch: "unknown", home_label: "~" }, runtimes },
    projects,
    layers,
    capabilities,
    items: publicItems,
    effective,
    redactions,
    findings,
    exclusions,
    truncations: capRecords,
    policy: { never_export: neverExport, caps },
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

export function serialize(manifest, entries) {
  const lines = [JSON.stringify(manifest)];
  for (const entry of entries) {
    lines.push(JSON.stringify({ name: entry.name, sha256: entry.sha256, encoding: entry.encoding, content: entry.content }));
  }
  return `${lines.join("\n")}\n`;
}

/** Key names, array lengths and value types survive; no string content does. */
export const REFUSED_LEAF = "{{OMEGA_REFUSED}}";

function structureOnly(value) {
  if (typeof value === "string") return REFUSED_LEAF;
  if (Array.isArray(value)) return value.map(structureOnly);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, structureOnly(child)]));
  }
  return value;
}

function mediaTypeFor(format) {
  const known = {
    json: "application/json",
    jsonc: "application/json",
    toml: "application/toml",
    md: "text/markdown",
    dotenv: "text/plain",
    starlark: "text/x-starlark",
    text: "text/plain",
  };
  return known[format] ?? "text/plain";
}
