// The redaction pass. Runs between normalize and effective (spike-corrections §4),
// because an effective row keyed by a permission-rule string would otherwise carry an
// unredacted value into the bundle even though the item itself was redacted.
//
// What this pass must NOT do is as load-bearing as what it does (THR §3.3, manifest §4.3):
// it hides VALUES and never STRUCTURE. The key name, the position, the owning item, the
// class and the site count all stay in the clear, and no file is ever dropped — a dropped
// file fails the contract twice, hiding the structure and saying nothing about it.

import { matchesPrefix } from "../fsx/paths.js";
import { splitRecognized } from "../model/item.js";
import { lastKeyName, redactText, redactUrl, setAtPath, stringLeavesOf } from "./deepwalk.js";
import { charsetClass, isStructuralSpan, shannonEntropy } from "./entropy.js";
import { classifyValue, nameLooksSecret, tierRank } from "./layers.js";
import {
  PLACEHOLDER_PATTERN,
  RefRegistry,
  containsPlaceholder,
  placeholder,
  replaceOutsidePlaceholders,
} from "./placeholder.js";

export const ENGINE_VERSION = "1.0.0";
export const PATTERN_SET = "omegas-continuity-patterns@2026-07";

export { PLACEHOLDER_PATTERN };

/**
 * @param items    the normalized item list, mutated in place
 * @param adapters the registry, read only for `secret_key_allowlist`
 * @param salt     optional fixed salt; tests pin it, exports randomize it
 */
export function redact({ items, adapters = [], salt = undefined, assetTexts = new Map() }) {
  const registry = new RefRegistry(salt);
  const records = new Map();
  const secretValues = new Set();
  const shapes = new Map();
  // Ref -> the concrete values behind it. Local only: `redactions[]` is bundle content and
  // must never carry a value, not even to make this bookkeeping easier.
  const valuesByRef = new Map();
  const allowlist = new Set(adapters.flatMap((adapter) => adapter.secret_key_allowlist ?? []));

  const note = ({ item, value, class: className, tier, detectors, key_name: keyName, key_path: keyPath, span }) => {
    const ref = registry.refFor(value);
    const record = records.get(ref) ?? {
      ref,
      class: className,
      tier,
      detector: [],
      confidence: "structural",
      key_names: [],
      sites: [],
    };
    // The most specific class wins when one value is seen two ways: a positional hit that
    // is ALSO a known provider shape should read as that provider in the placeholder.
    if (tierRank(tier) < tierRank(record.tier) || (record.class === "env.kv" && className !== "env.kv")) {
      record.class = className;
      record.tier = tier;
    }
    for (const detector of detectors) if (!record.detector.includes(detector)) record.detector.push(detector);
    // spike-corrections, modelling note 4 — a positional-only hit is reported as
    // structural, not "high confidence". `OMEGA_FEATURE_FLAGS=teams` redacted with high
    // confidence overstates certainty and erodes trust in the whole report.
    if (record.detector.some((detector) => detector !== "positional" && detector !== "keyname")) {
      record.confidence = "high";
    }
    if (keyName && !record.key_names.includes(keyName)) record.key_names.push(keyName);
    const site = { item_id: item.item_id, ...(keyPath ? { key_path: keyPath } : {}), ...(span ? { span } : {}) };
    if (!record.sites.some((existing) => sameSite(existing, site))) record.sites.push(site);
    records.set(ref, record);
    if (!item.redaction_refs.includes(ref)) item.redaction_refs.push(ref);
    if (!item.related.some((edge) => edge.rel === "requires_secret" && edge.ref === ref)) {
      item.related.push({ rel: "requires_secret", ref, class: record.class, key_names: record.key_names });
    }
    secretValues.add(value);
    if (!valuesByRef.has(ref)) valuesByRef.set(ref, new Set());
    valuesByRef.get(ref).add(value);
    if (!shapes.has(ref)) {
      shapes.set(ref, {
        length: value.length,
        charset: charsetClass(value),
        entropy: Number(shannonEntropy(value).toFixed(2)),
      });
    }
    return ref;
  };

  for (const item of items) {
    const surface = item._surface;
    if (!item.payload && typeof item._raw_text !== "string") continue;
    const positions = {
      secret: (surface?.secret_positions ?? []).filter((pattern) => pattern !== "$"),
      deep: surface?.deep_scan_positions ?? [],
      argv: surface?.argv_positions ?? [],
    };
    const itemKeyPath = item.origin?.key_path ?? "";

    if (item.payload?.parsed) {
      redactTree({ item, container: item.payload.parsed, field: "value", positions, itemKeyPath, allowlist, note, registry });
      redactTree({
        item,
        container: item.payload.parsed,
        field: "frontmatter",
        positions,
        itemKeyPath,
        allowlist,
        note,
        registry,
      });
      resplit(item, surface);
    }

    // Prose (THR B3) and any file whose bytes travel as a blob. This is the pass that
    // matters most for the bundle: `payload.raw` points at these exact bytes.
    for (const field of ["_raw_text", "_body_text"]) {
      if (typeof item[field] !== "string" || item[field].length === 0) continue;
      const { text, findings } = redactText(item[field], {
        context: `${item.name} ${item.surface_id}`,
        generic: positions.deep.length > 0,
        argv: positions.argv.length > 0,
        refFor: (value) => registry.refFor(value),
      });
      if (findings.length === 0) continue;
      item[field] = text;
      // Only the whole-file view records sites; the body is the same bytes seen twice, and
      // two sites for one line would inflate the count a user is asked to check.
      if (field === "_raw_text") {
        for (const finding of findings) {
          note({
            item,
            value: finding.value,
            class: finding.class,
            tier: finding.tier,
            detectors: finding.detectors,
            key_name: finding.key_name,
            span: { line_start: finding.line_start },
          });
        }
      }
    }
  }

  // Carried asset bodies — a skill's `scripts/`, `lib/`, `bin/` — are bundle content just
  // as much as the definition file is, and a script is a place people paste tokens.
  const byId = new Map(items.map((item) => [item.item_id, item]));
  for (const [itemId, perItem] of assetTexts) {
    const item = byId.get(itemId);
    if (!item) continue;
    for (const [displayPath, text] of perItem) {
      const { text: rewritten, findings } = redactText(text, {
        context: `${item.name} ${displayPath}`,
        generic: false,
        argv: true,
        refFor: (value) => registry.refFor(value),
      });
      if (findings.length === 0) continue;
      perItem.set(displayPath, rewritten);
      for (const finding of findings) {
        note({
          item,
          value: finding.value,
          class: finding.class,
          tier: finding.tier,
          detectors: finding.detectors,
          key_name: finding.key_name,
          key_path: `assets.${displayPath}`,
          span: { line_start: finding.line_start },
        });
      }
    }
  }

  // T-R5, as a mechanical pass rather than a hope. Every value ANY layer recognized
  // anywhere is now a known secret, so one sweep replaces it everywhere else it appears —
  // in a second file, in the raw bytes of a file whose parsed tree was redacted but whose
  // text was not, in a sibling item that never matched a pattern on its own. Partial
  // redaction is the failure this closes, and it is the one that leaks.
  sweepKnownValues({ items, assetTexts, records, valuesByRef, note });

  const redactions = [...records.values()].sort((a, b) => refIndex(a.ref) - refIndex(b.ref));
  return {
    redactions,
    secret_values: secretValues,
    // Value SHAPE — length, charset, entropy — is local-report-only data. It is returned
    // beside the redactions rather than inside them precisely so it cannot be serialized
    // into the bundle by accident: length is the one thing an `unknown.high_entropy`
    // placeholder would otherwise leak (T-R6).
    shapes,
    secret_map: secretMapFor({ salt: registry.salt, redactions }),
    header: headerFor({ redactions, allowlist }),
  };
}

function redactTree({ item, container, field, positions, itemKeyPath, allowlist, note, registry }) {
  const root = container?.[field];
  if (root === undefined || root === null) return;
  for (const [innerPath, leaf] of [...stringLeavesOf(root, "")]) {
    if (typeof leaf !== "string" || leaf.length === 0) continue;
    if (containsPlaceholder(leaf)) continue;
    const fullPath = joinPath(itemKeyPath, innerPath);
    const keyName = lastKeyName(innerPath) ?? lastKeyName(itemKeyPath);
    const write = (value) => {
      if (innerPath === "") container[field] = value;
      else setAtPath(root, innerPath, value);
    };
    const site = { key_path: fullPath || null };
    const positional = positions.secret.some(
      (pattern) => matchesPrefix(pattern, innerPath) || matchesPrefix(pattern, fullPath),
    );
    const allowlisted = Boolean(keyName && allowlist.has(keyName));

    // Layer 1. Unconditional in the sense that matters — a value here is redacted whatever
    // it looks like — but it still redacts the smallest thing that works. A URL keeps its
    // endpoint (THR A4) and an `Authorization` value keeps its scheme word, because the
    // erasure that destroys portable content is the same defect as dropping a whole file.
    if (positional && !allowlisted) {
      const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(leaf);
      if (isUrl) {
        const rewritten = redactUrl(leaf, {
          refFor: (value) => registry.refFor(value),
          note: (finding) => note({ item, ...finding, ...site }),
        });
        if (rewritten !== null) {
          write(rewritten);
          continue;
        }
        // Userinfo and query carried nothing, but the PATH still can — a webhook URL is a
        // credential that looks like a route (THR A4, "scan path segments"). Fall through
        // to the shape layers; an endpoint that matches nothing stays verbatim, because
        // the endpoint is the portable part.
      }
      const shaped = redactText(leaf, {
        context: `${keyName ?? ""} ${fullPath}`,
        generic: true,
        argv: true,
        refFor: (value) => registry.refFor(value),
      });
      if (shaped.findings.length > 0) {
        for (const finding of shaped.findings) {
          note({
            item,
            value: finding.value,
            class: finding.class,
            tier: finding.tier,
            detectors: [...finding.detectors, "positional"],
            key_name: finding.key_name ?? keyName,
            ...site,
          });
        }
        write(shaped.text);
        continue;
      }
      if (!isStructuralSpan(leaf) && !isUrl) {
        const ref = note({
          item,
          value: leaf,
          class: "env.kv",
          tier: "HIGH",
          detectors: ["positional"],
          key_name: keyName,
          ...site,
        });
        write(placeholder("env.kv", ref));
      }
      continue;
    }

    // Layer 2 on a structured leaf: the key name is the map key, not an assignment.
    if (!allowlisted && keyName && nameLooksSecret(keyName) && wholeValueIsSecret(leaf)) {
      const classified = classifyValue(leaf, keyName);
      const className = classified ? classified.class : "unknown.named_key";
      const ref = note({
        item,
        value: leaf,
        class: className,
        tier: classified ? classified.tier : "MEDIUM",
        detectors: classified ? ["keyname", "regex"] : ["keyname"],
        key_name: keyName,
        ...site,
      });
      write(placeholder(className, ref));
      continue;
    }

    // Layers 3-5 over the leaf text, splicing spans rather than replacing the value, so a
    // permission rule keeps its command and a hook keeps its script path.
    const argv = positions.argv.some((pattern) => pattern === "$" || matchesPrefix(pattern, innerPath));
    const generic = positions.deep.some((pattern) => pattern === "$" || matchesPrefix(pattern, innerPath));
    const { text, findings } = redactText(leaf, {
      context: `${keyName ?? ""} ${fullPath}`,
      generic,
      argv,
      refFor: (value) => registry.refFor(value),
    });
    if (findings.length === 0) continue;
    for (const finding of findings) {
      note({
        item,
        value: finding.value,
        class: finding.class,
        tier: finding.tier,
        detectors: finding.detectors,
        key_name: finding.key_name ?? keyName,
        ...site,
      });
    }
    write(text);
  }
}

const SWEEP_MIN_LENGTH = 8;

function sweepKnownValues({ items, assetTexts, records, valuesByRef, note }) {
  const known = [];
  for (const [ref, values] of valuesByRef) {
    const record = records.get(ref);
    if (!record) continue;
    for (const value of values) {
      if (value.length >= SWEEP_MIN_LENGTH) known.push({ value, ref, class: record.class, record });
    }
  }
  if (known.length === 0) return;
  // Longest first: a value that contains another value must be replaced before its
  // substring, or the outer occurrence is left half-rewritten.
  known.sort((a, b) => b.value.length - a.value.length);

  const sweep = (text, onHit) => {
    let out = String(text);
    for (const entry of known) {
      if (!out.includes(entry.value)) continue;
      const before = out;
      out = replaceOutsidePlaceholders(out, entry.value, placeholder(entry.class, entry.ref));
      if (out !== before) onHit(entry, lineOfValue(before, entry.value));
    }
    return out;
  };

  for (const item of items) {
    for (const field of ["_raw_text", "_body_text"]) {
      if (typeof item[field] !== "string" || item[field].length === 0) continue;
      item[field] = sweep(item[field], (entry, line) => {
        if (field !== "_raw_text") return;
        note({
          item,
          value: entry.value,
          class: entry.class,
          tier: entry.record.tier,
          detectors: ["value_link"],
          key_name: null,
          span: { line_start: line },
        });
      });
    }
    if (!item.payload?.parsed) continue;
    for (const field of ["value", "frontmatter"]) {
      const root = item.payload.parsed[field];
      if (root === undefined || root === null) continue;
      for (const [innerPath, leaf] of [...stringLeavesOf(root, "")]) {
        if (typeof leaf !== "string") continue;
        const rewritten = sweep(leaf, (entry) => {
          note({
            item,
            value: entry.value,
            class: entry.class,
            tier: entry.record.tier,
            detectors: ["value_link"],
            key_name: lastKeyName(innerPath),
            key_path: joinPath(item.origin?.key_path ?? "", innerPath),
          });
        });
        if (rewritten === leaf) continue;
        if (innerPath === "") item.payload.parsed[field] = rewritten;
        else setAtPath(root, innerPath, rewritten);
        resplit(item, item._surface);
      }
    }
  }

  for (const perItem of assetTexts.values()) {
    for (const [displayPath, text] of perItem) {
      const rewritten = sweep(text, () => {});
      if (rewritten !== text) perItem.set(displayPath, rewritten);
    }
  }
}

function lineOfValue(text, value) {
  const at = text.indexOf(value);
  if (at === -1) return 1;
  let line = 1;
  for (let index = 0; index < at; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function wholeValueIsSecret(value) {
  const text = String(value);
  if (isStructuralSpan(text)) return false;
  if (/\s/.test(text)) return false;
  if (text.length < 12) return false;
  return classifyValue(text) !== null || /^(?:[A-Za-z0-9+/_=-]|\.){12,}$/.test(text);
}

/**
 * `recognized ∪ unrecognized` are DERIVED views of the same tree (manifest §2.1), so they
 * have to be rebuilt from the redacted tree or they keep serving the original values. That
 * is not a cosmetic drift: they are serialized into the bundle, and a stale view is a leak
 * that no amount of care in the tree walk would catch.
 *
 * Which tree they derive from mirrors the normalizer exactly — frontmatter for a file item
 * that has one, the value for an embedded item — so re-splitting never invents a key the
 * normalizer would not have produced.
 */
function resplit(item, surface) {
  const parsed = item.payload?.parsed;
  if (!parsed) return;
  const hasFrontmatter = parsed.frontmatter !== undefined && parsed.frontmatter !== null;
  const source = hasFrontmatter ? parsed.frontmatter : item.payload.raw === null ? parsed.value : null;
  if (!source || typeof source !== "object" || Array.isArray(source)) return;
  const { recognized, unrecognized } = splitRecognized(source, surface?.recognized_keys ?? []);
  item.payload.recognized = recognized;
  item.payload.unrecognized = unrecognized;
}

/**
 * Manifest §4.4 — pointers to where each value lives, never a value. Open-core Continuity
 * has no reason to ever hold plaintext, so the map holds the salt (which the bundle does
 * not) and the sites, and that is all.
 */
function secretMapFor({ salt, redactions }) {
  return {
    note: "pointers only: open-core Continuity never stores a credential value, not even hashed",
    salt,
    refs: Object.fromEntries(
      redactions.map((record) => [
        record.ref,
        {
          class: record.class,
          confidence: record.confidence,
          key_names: record.key_names,
          sites: record.sites.map((site) => ({
            item_id: site.item_id,
            key_path: site.key_path ?? null,
            line_start: site.span?.line_start ?? null,
          })),
        },
      ]),
    ),
  };
}

/** Manifest §4.5 — the self-describing header a reader who finds a bundle in a gist sees. */
function headerFor({ redactions, allowlist }) {
  return {
    engine_version: ENGINE_VERSION,
    pattern_set: PATTERN_SET,
    placeholder_format: "{{OMEGA_REDACTED:<class>:<ref>}}",
    distinct_secrets: redactions.length,
    placeholder_sites: redactions.reduce((total, record) => total + record.sites.length, 0),
    shape_confirmed: redactions.filter((record) => record.confidence === "high").length,
    positional_only: redactions.filter((record) => record.confidence !== "high").length,
    classes: [...new Set(redactions.map((record) => record.class))].sort(),
    allowlisted_keys: [...allowlist].sort(),
    post_export_scan: { status: "pending", high_tier_hits: 0 },
  };
}

/**
 * THR §3.5 — the runtime twin of security Gate 5, and the last thing that runs before any
 * bytes reach the disk. The SERIALIZED bundle is re-scanned with the same detector; a
 * HIGH-tier hit means a plumbing bug, so the export aborts and no file is written.
 *
 * Two independent checks, because they fail differently: the detector catches a class we
 * know, and the seeded-value check catches a value we already redacted somewhere else and
 * missed here — which is the partial-redaction failure (T-R5) showing up as bytes.
 */
export function postExportScan(serialized, secretValues = new Set()) {
  const text = String(serialized);
  const hits = [];
  for (const value of secretValues) {
    if (value.length < 6) continue;
    const escaped = JSON.stringify(value).slice(1, -1);
    if (text.includes(value) || (escaped !== value && text.includes(escaped))) {
      hits.push({ kind: "redacted_value_present", class: "unknown", tier: "HIGH", length: value.length });
    }
  }
  const { findings } = redactText(text, { context: "", generic: false, argv: true });
  for (const finding of findings) {
    if (tierRank(finding.tier) === 0) {
      hits.push({ kind: "detector", class: finding.class, tier: finding.tier, line_start: finding.line_start });
    }
  }
  return { status: hits.length === 0 ? "passed" : "failed", high_tier_hits: hits.length, hits };
}

function sameSite(a, b) {
  return (
    a.item_id === b.item_id &&
    (a.key_path ?? null) === (b.key_path ?? null) &&
    (a.span?.line_start ?? null) === (b.span?.line_start ?? null)
  );
}

function joinPath(a, b) {
  if (!a) return b;
  if (!b) return a;
  return b.startsWith("[") ? `${a}${b}` : `${a}.${b}`;
}

function refIndex(ref) {
  return Number(String(ref).slice(1));
}
