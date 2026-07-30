// Manifest §3.3/§3.4 — precedence as DATA. Seven algebras, each declared per surface,
// because a single "merge" abstraction is wrong for at least two of every three surfaces
// (COD §5.6).
//
// The viewer's "why is this the effective value" panel is a lookup on this table: one
// row, its winner, and its contributors, each with an `applied` flag and a reason. No
// source file is ever re-opened to answer the question.

const ALGEBRA_HANDLERS = {
  override: applyOverride,
  override_whole_entry: applyOverride,
  concatenate: applyConcatenate,
  first_non_empty: applyFirstNonEmpty,
  aggregate: applyAggregate,
  union_with_resolution: applyUnionWithResolution,
  coexist: applyCoexist,
};

export function computeEffective({ items, layers }) {
  const rankOf = new Map(layers.map((layer) => [layer.layer_id, layer.rank]));
  const suppressed = new Set(layers.filter((layer) => layer.suppressed_by).map((layer) => layer.layer_id));
  const groups = new Map();

  for (const item of items) {
    const merge = item._surface?.merge;
    if (!merge || item.kind === "unresolved_link" || item.kind === "opaque") continue;
    const key = effectiveKey(item, merge);
    if (key === null || key === undefined) continue;
    // Grouped by algebra as well as by surface group: a group whose surfaces declare
    // different algebras (Codex global instructions are `first_non_empty`, its project
    // chain is `concatenate` — COD §4.1) is two rows, because one row cannot be
    // resolved two ways.
    const groupId = JSON.stringify([item.runtime, merge.group ?? item.surface_id, merge.algebra, key]);
    const group = groups.get(groupId) ?? {
      runtime: item.runtime,
      surface_id: merge.group ?? item.surface_id,
      key,
      merge,
      members: [],
    };
    group.members.push(item);
    groups.set(groupId, group);
  }

  const rows = [];
  const rank = (item) => rankOf.get(item.layer_id) ?? 0;
  for (const group of groups.values()) {
    const handler = ALGEBRA_HANDLERS[group.merge.algebra];
    if (!handler) throw new Error(`unknown merge algebra "${group.merge.algebra}"`);
    // Precedence is resolved IN THE CONTEXT OF A PROJECT. A project-scoped item competes
    // with the user-scope items that also apply there, and two projects are two
    // independent resolutions — not one merged pile.
    const shared = group.members.filter((item) => item.project_id === null);
    const projectIds = [...new Set(group.members.filter((item) => item.project_id).map((item) => item.project_id))];
    const contexts = projectIds.length > 0 ? projectIds : [null];
    for (const projectId of contexts) {
      const members = projectId === null ? shared : [...shared, ...group.members.filter((item) => item.project_id === projectId)];
      if (members.length === 0) continue;
      rows.push(resolveRow({ group, members, projectId, handler, rank, suppressed }));
    }
  }

  return rows.sort(
    (a, b) =>
      a.runtime.localeCompare(b.runtime) ||
      a.surface_id.localeCompare(b.surface_id) ||
      String(a.project_id ?? "").localeCompare(String(b.project_id ?? "")) ||
      String(a.key).localeCompare(String(b.key)),
  );
}

function resolveRow({ group, members, projectId, handler, rank, suppressed }) {
  const row = {
    surface_id: group.surface_id,
    runtime: group.runtime,
    project_id: projectId,
    key: group.key,
    algebra: group.merge.algebra,
    value: null,
    winner: null,
    contributors: [],
    note: null,
  };
  // A suppressed layer does not participate at all: the runtime never loads it, so it
  // cannot win and it cannot shadow. Electing a winner from it and then crossing it out
  // would report a value the runtime does not actually use.
  const live = members.filter((item) => !suppressed.has(item.layer_id));
  if (live.length > 0) handler(row, { ...group, members: live }, rank);
  else row.note = "every contributing layer is suppressed; the runtime loads nothing for this key";
  for (const item of members) {
    if (!suppressed.has(item.layer_id)) continue;
    row.contributors.push({
      item_id: item.item_id,
      layer_id: item.layer_id,
      rank: rank(item),
      applied: false,
      reason: "layer suppressed: the runtime does not trust this project, so it loads none of its config",
    });
  }
  return row;
}

function baseContributors(group, rank) {
  return group.members.map((item) => ({
    item_id: item.item_id,
    layer_id: item.layer_id,
    rank: rank(item),
    applied: true,
    reason: null,
  }));
}

function applyOverride(row, group, rank) {
  const contributors = baseContributors(group, rank).sort((a, b) => b.rank - a.rank);
  row.contributors = contributors;
  row.winner = contributors[0].item_id;
  row.value = valueOf(byId(group.members, contributors[0].item_id));
  contributors[0].reason = "highest present rank";
  for (const contributor of contributors.slice(1)) {
    contributor.applied = false;
    contributor.reason = `outranked by ${contributors[0].layer_id} (rank ${contributors[0].rank})`;
  }
  if (group.merge.algebra === "override_whole_entry") {
    row.note = "the highest-rank source supplies the ENTIRE entry; fields never merge across scopes";
  }
}

function applyConcatenate(row, group, rank) {
  const contributors = baseContributors(group, rank).sort(
    (a, b) => a.rank - b.rank || a.item_id.localeCompare(b.item_id),
  );
  contributors.forEach((contributor, index) => {
    const item = byId(group.members, contributor.item_id);
    contributor.order_index = index;
    contributor.applied = item.applied !== false;
    contributor.reason = contributor.applied
      ? "all applied, ascending rank; later text has more influence"
      : (item.applied_reason ?? "not loaded at launch");
  });
  row.contributors = contributors;
  row.value = null;
  row.note = "concatenated chain — there is no single winner";
}

function applyFirstNonEmpty(row, group, rank) {
  const ordered = [...group.members].sort(
    (a, b) => rank(b) - rank(a) || (a._order_index ?? 0) - (b._order_index ?? 0),
  );
  let chosen = null;
  row.contributors = ordered.map((item) => {
    const nonEmpty = String(item._raw_text ?? "").trim().length > 0;
    const applied = chosen === null && nonEmpty;
    if (applied) chosen = item;
    return {
      item_id: item.item_id,
      layer_id: item.layer_id,
      rank: rank(item),
      applied,
      reason: applied
        ? "first non-empty file at this level"
        : nonEmpty
          ? "a higher-preference file at this level is non-empty; this file is never read"
          : "empty",
    };
  });
  row.winner = chosen?.item_id ?? null;
  row.value = chosen ? "<file contents>" : null;
  row.note = "REPLACE semantics, not append — the losing file is not merged in";
}

function applyAggregate(row, group, rank) {
  row.contributors = baseContributors(group, rank);
  for (const contributor of row.contributors) {
    contributor.reason = "aggregate: every matching entry from every layer runs";
  }
  row.note = "all applied simultaneously; no layer suppresses another";
}

function applyUnionWithResolution(row, group, rank) {
  const order = group.merge.severity_order ?? [];
  const severityIndex = (item) => {
    const index = order.indexOf(severityFrom(item, group.merge));
    return index === -1 ? order.length : index;
  };
  const ordered = [...group.members].sort((a, b) => severityIndex(a) - severityIndex(b) || rank(b) - rank(a));
  const winner = ordered[0];
  row.winner = winner.item_id;
  row.value = severityFrom(winner, group.merge);
  row.contributors = ordered.map((item) => ({
    item_id: item.item_id,
    layer_id: item.layer_id,
    rank: rank(item),
    applied: item === winner,
    reason:
      item === winner
        ? `severity "${severityFrom(item, group.merge)}" wins`
        : `severity: ${severityFrom(winner, group.merge)} outranks ${severityFrom(item, group.merge)} regardless of layer`,
  }));
  if (row.contributors.length > 1) {
    row.note =
      "severity beats layer rank — a broad deny outranks a narrow allow from a higher layer, so deny rules cannot carry allowlist exceptions";
  }
}

function applyCoexist(row, group, rank) {
  row.contributors = baseContributors(group, rank);
  for (const contributor of row.contributors) {
    contributor.reason = "coexist: every duplicate stays addressable in the runtime's selectors";
  }
  row.note = "duplicates all remain addressable; no resolution (precedence is UNKNOWN, not assumed)";
}

function byId(items, id) {
  return items.find((item) => item.item_id === id);
}

function valueOf(item) {
  const value = item?.payload?.parsed?.value;
  if (value === undefined || value === null) return item?.name ?? null;
  if (typeof value === "object") return "<structured entry>";
  return value;
}

function severityFrom(item, merge) {
  const source = merge.severity_from ?? "";
  if (source.startsWith("capture:")) return item._captures?.[Number(source.slice(8))] ?? "unknown";
  if (source.startsWith("field:")) return item.payload?.parsed?.value?.[source.slice(6)] ?? "unknown";
  return "unknown";
}

function effectiveKey(item, merge) {
  const key = merge.effective_key;
  if (key === "chain") return "@chain";
  if (key === "identity") return item.name;
  if (key === "key_path") return item.origin.key_path;
  if (key === "value") {
    const value = item.payload?.parsed?.value;
    return typeof value === "string" ? value : JSON.stringify(value ?? null);
  }
  if (typeof key === "string" && key.startsWith("capture:")) {
    return item._captures?.[Number(key.slice(8))] ?? null;
  }
  return item.name;
}
