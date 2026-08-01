// The Item record (manifest §1.3). One shape for every kind, so a viewer, a diff and an
// importer all read the same fields regardless of which runtime produced it.
//
// Fields prefixed `_` are engine-internal working state (raw text, the owning surface,
// captures). They never reach a bundle: `publicItem()` is the projection that strips
// them, and it is what any serializer must call.

export function makeItem(fields) {
  return {
    item_id: fields.item_id,
    kind: fields.kind,
    runtime: fields.runtime,
    surface_id: fields.surface_id,
    scope: fields.scope,
    layer_id: fields.layer_id,
    project_id: fields.project_id ?? null,
    name: fields.name,
    identity: fields.identity,
    origin: fields.origin,
    payload: fields.payload ?? null,
    assets: fields.assets ?? [],
    portability: fields.portability ?? { verdict: "PORTABLE", reasons: [], rewrites: [] },
    trust_tier: fields.trust_tier,
    ...(fields.authority ? { authority: true } : {}),
    applied: fields.applied ?? true,
    ...(fields.applied_reason ? { applied_reason: fields.applied_reason } : {}),
    ...(fields.export_refused ? { export_refused: true, export_refused_by: fields.export_refused_by } : {}),
    content_id: fields.content_id ?? null,
    redaction_refs: fields.redaction_refs ?? [],
    related: fields.related ?? [],
    _raw_text: fields._raw_text ?? null,
    _body_text: fields._body_text ?? null,
    _truncated: fields._truncated ?? false,
    _eol: fields._eol ?? "lf",
    _captures: fields._captures ?? [],
    _surface: fields._surface ?? null,
    _order_index: fields._order_index ?? null,
    _fingerprint: fields._fingerprint ?? null,
    _abs_path: fields._abs_path ?? null,
  };
}

export function makeOrigin({ path: tokenized, display_path, key_path = null, span = null, link = null }) {
  return { path: tokenized, display_path, key_path, span, link };
}

export function makePayload({ format, raw = null, parsed = null, recognized = {}, unrecognized = {}, extra = {} }) {
  return { format, raw, parsed, recognized, unrecognized, ...extra };
}

export function isInternalKey(key) {
  return key.startsWith("_");
}

/** The bundle-facing projection. Anything an exporter serializes goes through here. */
export function publicItem(item) {
  const out = {};
  for (const [key, value] of Object.entries(item)) {
    if (isInternalKey(key)) continue;
    out[key] = value;
  }
  return out;
}

/** `recognized ∪ unrecognized = parsed`, always, with no key lost (manifest §2.1). */
export function splitRecognized(object, recognizedKeys) {
  const recognized = {};
  const unrecognized = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if ((recognizedKeys ?? []).includes(key)) recognized[key] = value;
    else unrecognized[key] = value;
  }
  return { recognized, unrecognized };
}
