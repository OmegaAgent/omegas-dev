// Security Gate 2 (THR §5) — secret-injection recall, measured on a seeded corpus, plus
// its paired precision half. Recall is a NUMBER this suite computes, not a claim: if the
// pattern table regresses, the percentage moves and the build fails.
//
// Pass conditions, straight from the gate:
//   recall ≥ 99% on HIGH-tier classes, ≥ 95% overall
//   ZERO seeded values present in the serialized bundle
//   false positives may be flagged but must NOT remove or truncate a file

import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { ADAPTERS } from "../src/core/adapters/registry.js";
import { buildEnvironment } from "../src/core/engine/environment.js";
import { runScan } from "../src/core/engine/pipeline.js";
import { assembleBundle } from "../src/cli/export.js";
import { seededHome } from "./fixtures/seeded.js";

const NOW = new Date("2026-07-30T12:00:00.000Z");

async function exportSeeded(fixture) {
  const env = await buildEnvironment({
    homeDir: fixture.home,
    roots: [path.join(fixture.home, "projects")],
    os: process.platform,
    envVars: {},
    adapters: ADAPTERS,
  });
  const result = await runScan({ adapters: ADAPTERS, env, salt: "corpus-salt", payloadPolicy: "definition" });
  const built = assembleBundle({
    result,
    env,
    adapters: ADAPTERS,
    payloadPolicy: "definition",
    now: NOW,
    id: "ocb_corpus_0001",
  });
  return { env, result, built };
}

function present(text, value) {
  if (text.includes(value)) return true;
  const escaped = JSON.stringify(value).slice(1, -1);
  return escaped !== value && text.includes(escaped);
}

test("Gate 2 — recall on a seeded corpus, and zero seeded values in the bundle", async (t) => {
  const fixture = await seededHome();
  try {
    const { result, built } = await exportSeeded(fixture);
    const placements = fixture.placements;
    assert.ok(placements.length >= 200, `corpus is ${placements.length} placements; the gate wants at least 200`);

    const redactedValues = result.secret_values;
    const byTier = new Map();
    const misses = [];
    for (const placement of placements) {
      // A scan-and-refuse surface never hands its bytes to the detector at all, so it is
      // measured by the leak assertion below, not by detector recall.
      if (!placement.detectable) continue;
      const tier = byTier.get(placement.tier) ?? { total: 0, found: 0 };
      tier.total += 1;
      if (redactedValues.has(placement.detect)) tier.found += 1;
      else misses.push(placement);
      byTier.set(placement.tier, tier);
    }

    const totals = [...byTier.values()].reduce(
      (acc, entry) => ({ total: acc.total + entry.total, found: acc.found + entry.found }),
      { total: 0, found: 0 },
    );
    const high = byTier.get("HIGH") ?? { total: 0, found: 0 };
    const rate = (entry) => (entry.total === 0 ? 1 : entry.found / entry.total);

    const report = [...byTier.entries()]
      .map(([tier, entry]) => `${tier} ${entry.found}/${entry.total} (${(rate(entry) * 100).toFixed(1)}%)`)
      .join("  ");
    t.diagnostic(`recall: ${report}  overall ${totals.found}/${totals.total}`);
    if (misses.length > 0) {
      const bySurface = new Map();
      for (const miss of misses) {
        bySurface.set(`${miss.surface}/${miss.class}`, (bySurface.get(`${miss.surface}/${miss.class}`) ?? 0) + 1);
      }
      t.diagnostic(`misses: ${[...bySurface.entries()].map(([key, count]) => `${key}=${count}`).join(", ")}`);
    }

    assert.ok(rate(high) >= 0.99, `HIGH-tier recall is ${(rate(high) * 100).toFixed(1)}%, below the 99% gate`);
    assert.ok(rate(totals) >= 0.95, `overall recall is ${(rate(totals) * 100).toFixed(1)}%, below the 95% gate`);

    // The property that actually matters: not one seeded value, from any surface —
    // including the ones the detector never saw — appears in the bytes.
    const leaked = placements.filter((placement) => present(built.serialized, placement.secret));
    assert.deepEqual(
      leaked.map((placement) => `${placement.surface}:${placement.class}`),
      [],
      "seeded values reached the serialized bundle",
    );
    assert.equal(built.manifest.redaction.post_export_scan.status, "passed");
  } finally {
    await fixture.cleanup();
  }
});

test("the same value in two surfaces gets one ref and two sites", async () => {
  const fixture = await seededHome({ perSurface: 2 });
  try {
    const { result } = await exportSeeded(fixture);
    const record = result.redactions.find((entry) =>
      entry.sites.length > 1 && entry.class === "github.token" && entry.key_names.includes("SHARED_GITHUB_TOKEN"),
    );
    assert.ok(record, "the value pasted into settings.env and into prose did not resolve to one ref");
    const items = new Set(record.sites.map((site) => site.item_id));
    assert.ok(items.size >= 2, `one ref should span two items, got ${[...items].join(", ")}`);
  } finally {
    await fixture.cleanup();
  }
});

test("a scan-and-refuse surface keeps its structure and loses its bytes", async () => {
  const fixture = await seededHome({ perSurface: 2 });
  try {
    const { result, built } = await exportSeeded(fixture);
    const refused = fixture.placements.filter((placement) => placement.refused);
    assert.ok(refused.length > 0);
    for (const placement of refused) {
      assert.ok(!present(built.serialized, placement.secret), `${placement.surface} leaked bytes into the bundle`);
    }
    // Structure survives: the rule item is still there, and the refusal is named.
    const rules = built.manifest.items.filter((item) => item.kind === "rule_script");
    assert.ok(rules.length > 0, "refusing the bytes must not delete the item");
    assert.ok(
      result.exclusions.some((record) => record.note?.includes("refused for export")),
      "a refusal must produce a visible exclusion record",
    );
  } finally {
    await fixture.cleanup();
  }
});
