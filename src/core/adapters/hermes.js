// adapter-architecture §4 — the honest state, and it is enforceable.
//
// An adapter EXISTS when it declares an identity. It CLAIMS SUPPORT only when it
// declares surfaces with evidence. Nothing about Hermes has been surveyed, so
// `surfaces: []` is the correct content of this file and `validateAdapters()`
// rejects any attempt to add one without flipping `status` first.
//
// Three mechanisms keep it honest:
//  1. status "supported" requires surfaces.length > 0 AND non-empty evidence on each;
//     "partial" requires the same plus a non-empty known_gaps[]; "declared" requires
//     surfaces.length === 0.
//  2. The compat engine returns UNKNOWN, not UNSUPPORTED, for a `declared` adapter.
//     UNSUPPORTED means "we checked and it cannot be done"; UNKNOWN means "we have not
//     built this." Collapsing them would let the matrix imply a verified negative.
//  3. The UI lists a `declared` adapter with a "detection not implemented" note rather
//     than hiding it — hiding it would leave the user unable to tell "we don't support
//     Hermes" from "you don't have Hermes."
//
// Adding Hermes later is: fill detect, add roots, append SurfaceDescriptors with
// evidence citations, set capabilities, flip status. No engine change.

export default {
  id: "hermes",
  display_name: "Hermes",
  status: "declared",
  adapter_version: "0.0.0",

  detect: {
    present_if: [],
    version: [],
    version_required: false,
    breaking_below: null,
    reason: "no installation surveyed; no configuration surface verified. Detection is not implemented, which is a different claim from 'not installed'.",
  },

  tokens: {},
  roots: [],
  layer_ranks: {},
  project_markers: [],
  secret_key_allowlist: [],
  sources: [],
  surfaces: [],
  capabilities: {},
  transforms: [],
  lints: [],
  never_export: [],
};
