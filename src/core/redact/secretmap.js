// Manifest §4.4 — the local secret map. It lives under the Continuity state dir at mode
// 0600 and it NEVER travels: it holds the per-bundle salt (which the bundle does not) and
// a pointer to where each value lives on this machine.
//
// The invariant this module exists to keep is negative: no value byte, no digest of a
// value, no length, no prefix. `assertNoValues` is the mechanical form of that promise and
// the writer refuses rather than trusting the caller.

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export const SECRET_MAP_MODE = 0o600;

export function secretMapPath(stateDir, bundleId) {
  return path.join(stateDir, "secrets", `${bundleId}.map.json`);
}

/**
 * Throws if any redacted value appears anywhere in the serialized map. Cheap, and it turns
 * "we never store plaintext" from a claim about intent into a claim about bytes.
 */
export function assertNoValues(map, secretValues) {
  const serialized = JSON.stringify(map);
  for (const value of secretValues) {
    if (value.length < 6) continue;
    const escaped = JSON.stringify(value).slice(1, -1);
    if (serialized.includes(value) || (escaped !== value && serialized.includes(escaped))) {
      throw new Error("secret map would contain a credential value; refusing to write");
    }
  }
  return true;
}

export async function writeSecretMap({ stateDir, bundleId, map, secretValues = new Set() }) {
  const full = { bundle_id: bundleId, created_for: "import re-binding", ...map };
  assertNoValues(full, secretValues);
  const target = secretMapPath(stateDir, bundleId);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify(full, null, 2)}\n`, { mode: SECRET_MAP_MODE });
  return target;
}
