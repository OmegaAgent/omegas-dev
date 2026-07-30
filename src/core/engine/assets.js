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
import { safeReadText } from "../fsx/safe-read.js";
import { allRootPaths } from "./environment.js";

const CARRIED_ROLES = {
  definition: new Set(),
  "definition+scripts": new Set(["script", "lib", "bin", "reference"]),
  full: null,
};

/**
 * Fills in `sha256` and `bytes` on every asset record and returns the text of the assets
 * the policy carries, keyed by item and relative path. The text is returned SEPARATELY
 * rather than attached to the asset record, because item records are serialized into the
 * `scan --json` envelope and an attached body would leak straight into it.
 */
export async function readAssets({ items, env, adapters, policy }) {
  const texts = new Map();
  if (!policy) return texts;
  const roles = CARRIED_ROLES[policy] ?? new Set();
  const roots = allRootPaths(env, adapters);

  for (const item of items) {
    if (!Array.isArray(item.assets) || item.assets.length === 0) continue;
    if (typeof item._abs_path !== "string") continue;
    if (item.export_refused) continue;
    const directory = path.dirname(item._abs_path);
    for (const asset of item.assets) {
      const full = path.join(directory, asset.display_path);
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
  return texts;
}
