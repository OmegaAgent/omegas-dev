// Manifest §5.5 — `payload_policy` handles the "1.1 GB of skills" problem as a DECLARED
// choice, not a silent cap. A skill is a definition file plus a directory of assets; the
// definition always travels, the assets travel only when the policy says so, and an asset
// left behind is still LISTED with its size and digest so the bundle states exactly what
// it did not carry.
//
// Asset bytes are read here, before redaction, for one reason: anything that can reach a
// bundle must pass through the same redaction pass as everything else. Reading them later
// — in the exporter, after the pass has run — is how a script with a token in it ships
// unredacted.
//
// Nothing happens at all unless a policy is supplied, so a plain `scan` never pays the
// cost of hashing every file in every skill directory (THR T-S4: perf is a security
// property here).

import path from "node:path";
import { contentId } from "../model/identity.js";
import { displayPath, tokenizeWithin } from "../fsx/paths.js";
import { safeReadText } from "../fsx/safe-read.js";
import { ExclusionLedger, fileRules, matchFileRule, rulesFor } from "../policy/never-export.js";
import { allRootPaths } from "./environment.js";

// `null` means "every role", and it has to be distinguished from "no policy supplied" by
// key presence rather than by nullishness: `CARRIED_ROLES[policy] ?? new Set()` reads
// `full` as the empty set, which made the most permissive policy carry the least.
const CARRIED_ROLES = new Map([
  ["definition", new Set()],
  ["definition+scripts", new Set(["script", "lib", "bin", "reference"])],
  ["full", null],
]);

/**
 * Fills in `sha256` and `bytes` on every asset record and returns the text of the assets
 * the policy carries, keyed by item and relative path. The text is returned SEPARATELY
 * rather than attached to the asset record, because item records are serialized into the
 * `scan --json` envelope and an attached body would leak straight into it.
 */
export async function readAssets({ items, env, adapters, policy }) {
  const texts = new Map();
  const exclusions = new ExclusionLedger();
  if (!policy) return { texts, exclusions };
  const roles = CARRIED_ROLES.has(policy) ? CARRIED_ROLES.get(policy) : new Set();
  const roots = allRootPaths(env, adapters);
  // The never-export table is a rule about PATHS, and an asset has a path like anything
  // else. Reading assets through `safeReadText` alone skipped the table entirely, so a
  // `deploy.pem` or an `id_rsa` sitting in a skill directory was carried by name-blind
  // policy while the same file one directory up was a hard refusal.
  const rulesByRuntime = new Map(
    (adapters ?? []).map((adapter) => [adapter.id, fileRules(rulesFor(adapter, env.tokens))]),
  );

  for (const item of items) {
    if (!Array.isArray(item.assets) || item.assets.length === 0) continue;
    if (typeof item._abs_path !== "string") continue;
    if (item.export_refused) continue;
    const rules = rulesByRuntime.get(item.runtime) ?? [];
    const directory = path.dirname(item._abs_path);
    for (const asset of item.assets) {
      const full = path.join(directory, asset.display_path);
      const denied = matchFileRule(rules, full);
      if (denied) {
        asset.included = false;
        asset.reason = `never-exported: ${denied.rule.rule_id}`;
        exclusions.record(denied.rule, {
          label: tokenizeWithin(displayPath(full, env.homeDir), env),
          bytes: asset.bytes ?? 0,
          unit: "files",
        });
        continue;
      }
      const read = await safeReadText(full, roots, env.caps.file_bytes);
      if (!read.ok) {
        asset.sha256 = null;
        asset.included = false;
        asset.reason = `not carried: ${read.reason}`;
        continue;
      }
      asset.sha256 = contentId(read.text);
      asset.bytes = read.bytes;
      if (read.truncated) asset.truncated = true;
      const carry = roles === null || (asset.role && roles.has(asset.role));
      if (!carry) {
        asset.included = false;
        asset.reason = `payload_policy=${policy}`;
        continue;
      }
      const perItem = texts.get(item.item_id) ?? new Map();
      perItem.set(asset.display_path, read.text);
      texts.set(item.item_id, perItem);
    }
  }
  return { texts, exclusions };
}
