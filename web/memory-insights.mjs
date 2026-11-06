import { graphSources, edgeKey, emptyGraph, isMgpTimestamp } from "./mgp.mjs";
import { DAY, REVIEW_INTERVAL, validateReviewRecord } from "./review-state.mjs";
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
const normalized = (value = "") =>
  value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
const timestamp = (value) => (isMgpTimestamp(value) ? Date.parse(value) : null);
const identifierOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function memoryIndex(graph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = new Map(graph.nodes.map((node) => [node.id, []]));
  for (const edge of graph.edges)
    if (nodes.has(edge.from) && nodes.has(edge.to)) {
      edges.get(edge.from).push(edge);
      if (edge.to !== edge.from) edges.get(edge.to).push(edge);
    }
  return {
    nodes,
    edges,
    sources: new Map(graphSources(graph).map((source) => [source.id, source])),
  };
}
export async function memoryFingerprint(graph, id, index = memoryIndex(graph)) {
  const node = index.nodes.get(id);
  if (!node) throw new Error("记忆已不在当前图谱，请刷新回顾。");
  const edges = [...index.edges.get(id)].sort((a, b) =>
    identifierOrder(edgeKey(a), edgeKey(b)),
  );
  const sourceIds = new Set();
  for (const record of [node, ...edges]) {
    sourceIds.add(record.source_id || graph.source.id);
    for (const item of record.provenance || []) sourceIds.add(item.source_id);
  }
  const sources = [...sourceIds]
    .sort(identifierOrder)
    .map((key) => index.sources.get(key) || { id: key });
  const bytes = new TextEncoder().encode(
    JSON.stringify(canonical({ node, edges, sources })),
  );
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}
export async function reviewPage(
  graph,
  {
    records = [],
    now = Date.now(),
    minAgeDays = 30,
    mode = "due",
    page = 0,
    pageSize = 6,
    filterIds,
  } = {},
) {
  if (
    !Number.isFinite(now) ||
    ![30, 90, 180].includes(minAgeDays) ||
    !["due", "favorites", "reviewed", "skipped", "undated", "all"].includes(
      mode,
    )
  )
    throw new Error("回顾筛选条件不正确");
  const index = memoryIndex(graph),
    states = new Map(
      records.map((row) => {
        const state = validateReviewRecord(row);
        return [state.id, state];
      }),
    );
  const allowed = filterIds ? new Set(filterIds) : null,
    versions = new Map(),
    candidates = [];
  const versionFor = async (id) => {
    if (!versions.has(id))
      versions.set(id, await memoryFingerprint(graph, id, index));
    return versions.get(id);
  };
  let missingTime = 0,
    futureTime = 0;
  for (const node of graph.nodes) {
    const updated = timestamp(node.updated_at);
    if (updated === null) missingTime++;
    else if (updated > now) futureTime++;
    if (allowed && !allowed.has(node.id)) continue;
    const state = states.get(node.id),
      old = updated !== null && updated <= now - minAgeDays * DAY;
    if (mode === "due" && (!old || node.state === "deprecated")) continue;
    if (mode === "favorites" && !state?.favorite) continue;
    if (mode === "reviewed" && !state?.reviewed) continue;
    if (mode === "skipped" && !state?.skipped) continue;
    if (mode === "undated" && updated !== null) continue;
    let reviewedCurrent = false,
      skippedCurrent = false,
      version;
    if (state?.reviewed || state?.skipped) {
      version = await versionFor(node.id);
      reviewedCurrent =
        state.reviewed?.fingerprint === version &&
        Date.parse(state.reviewed.at) <= now;
      skippedCurrent =
        state.skipped?.fingerprint === version &&
        Date.parse(state.skipped.at) <= now;
    }
    if (
      mode === "due" &&
      ((reviewedCurrent &&
        now - Date.parse(state.reviewed.at) < REVIEW_INTERVAL * DAY) ||
        (skippedCurrent && Date.parse(state.skipped.until) > now))
    )
      continue;
    candidates.push({
      id: node.id,
      updated,
      state,
      reviewedCurrent,
      skippedCurrent,
      version,
    });
  }
  candidates.sort(
    (a, b) =>
      (a.updated ?? Infinity) - (b.updated ?? Infinity) ||
      identifierOrder(a.id, b.id),
  );
  pageSize = Math.max(1, Math.min(12, Math.trunc(pageSize) || 6));
  const pages = Math.max(1, Math.ceil(candidates.length / pageSize));
  page = Math.max(0, Math.min(pages - 1, Math.trunc(page) || 0));
  const items = [];
  for (const item of candidates.slice(page * pageSize, (page + 1) * pageSize)) {
    const { id, updated, state, reviewedCurrent, skippedCurrent } = item,
      reasons = [];
    if (updated === null)
      reasons.push(
        "记录未提供可用更新时间，无法判断新旧；此项按你选择的筛选显示。",
      );
    else if (updated > now)
      reasons.push("提供的更新时间晚于本机当前时间，未按旧记忆推荐。");
    else
      reasons.push(
        `记录提供的更新时间为 ${index.nodes.get(id).updated_at}，距今 ${Math.floor((now - updated) / DAY)} 天；它不代表事情发生时间。`,
      );
    if (mode === "due")
      reasons.push(
        `符合至少 ${minAgeDays} 天未更新的筛选，且未被本机当前版本的近期回顾或跳过记录暂缓。`,
      );
    else
      reasons.push(
        {
          favorites: "你选择了此浏览器的收藏记录。",
          reviewed: "你选择了此浏览器标记过已回顾的记录。",
          skipped: "你选择了此浏览器标记过跳过的记录。",
          all: "你选择了全部记忆，此项不依赖时间推荐。",
          undated: "你选择了未提供可用更新时间的记录。",
        }[mode],
      );
    if (state?.reviewed)
      reasons.push(
        reviewedCurrent
          ? `本机上次标记已回顾：${state.reviewed.at}。`
          : "当前记忆、来源或已有关系与上次回顾版本不同，或本机回顾时间晚于当前时钟；未据此延后推荐。",
      );
    else
      reasons.push("此浏览器没有此稳定 ID 的已回顾记录；不代表你从未回顾过。");
    if (state?.skipped)
      reasons.push(
        skippedCurrent
          ? `本机跳过至 ${state.skipped.until}${Date.parse(state.skipped.until) <= now ? "（已到期）" : ""}。`
          : "跳过记录属于其他内容版本，或时间晚于当前时钟，当前版本不受其暂缓。",
      );
    const edges = index.edges.get(id);
    reasons.push(
      `当前图谱提供了 ${edges.length} 条关联记录；仅展示原有关系及其依据，不生成新关系。`,
    );
    items.push({
      id,
      version: item.version || (await versionFor(id)),
      favorite: state?.favorite === true,
      reviewedAt: state?.reviewed?.at,
      skippedUntil: state?.skipped?.until,
      reasons,
    });
  }
  return {
    items,
    total: candidates.length,
    page,
    pages,
    missingTime,
    futureTime,
    computedAt: new Date(now).toISOString(),
  };
}
export function healthCheck(graph, { now = Date.now(), staleDays = 90 } = {}) {
  if (!Number.isFinite(now) || ![30, 90, 180].includes(staleDays))
    throw new Error("体检筛选条件不正确");
  const index = memoryIndex(graph),
    titles = new Map(),
    bodies = new Map();
  const result = {
    duplicates: [],
    isolated: [],
    sources: [],
    stale: [],
    missingTime: 0,
    futureTime: 0,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    computedAt: new Date(now).toISOString(),
  };
  const add = (map, key, id) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(id);
  };
  const aggregate = JSON.stringify(canonical(emptyGraph().source));
  for (const node of graph.nodes) {
    add(titles, JSON.stringify([node.type, normalized(node.label)]), node.id);
    add(bodies, normalized(node.content), node.id);
    const edges = index.edges.get(node.id);
    if (!edges.some((edge) => edge.from !== edge.to))
      result.isolated.push({
        id: node.id,
        reason: edges.length
          ? "仅有自关联，尚未关联到其他记忆。"
          : "当前图谱没有此记忆的关联记录。",
      });
    const references = [
      { source_id: node.source_id || graph.source.id, ref: node.source_ref },
      ...(node.provenance || []),
    ];
    const declared = references.filter((item) => {
      const source = index.sources.get(item.source_id);
      return (
        source &&
        !(
          /^workspace:local(?::[1-9]\d*)?$/.test(source.id) &&
          JSON.stringify(canonical({ ...source, id: "workspace:local" })) ===
            aggregate
        )
      );
    });
    if (!declared.length)
      result.sources.push({
        id: node.id,
        reason: "未找到可追溯的来源声明，或只有工作区占位来源。",
      });
    else if (
      !declared.some(
        (item) => typeof item.ref === "string" && item.ref.trim(),
      ) &&
      !declared.some(
        (item) => index.sources.get(item.source_id)?.platform === "manual",
      )
    )
      result.sources.push({
        id: node.id,
        reason:
          "有来源声明，但没有可定位原文的 source_ref 或 provenance.ref；来源声明本身未经独立核实。",
      });
    const updated = timestamp(node.updated_at);
    if (updated === null) result.missingTime++;
    else if (updated > now) result.futureTime++;
    else if (
      ["unknown", "inferred", "disputed"].includes(node.state || "unknown") &&
      updated <= now - staleDays * DAY
    )
      result.stale.push({
        id: node.id,
        reason: `当前状态为 ${node.state || "unknown"}，记录提供的更新时间 ${node.updated_at} 距今至少 ${staleDays} 天；这不代表最后确认时间。`,
      });
  }
  for (const [kind, groups] of [
    ["title", titles],
    ["content", bodies],
  ])
    for (const ids of groups.values())
      if (ids.length > 1) {
        result.duplicates.push({
          kind,
          ids: ids.sort(identifierOrder),
          reason:
            kind === "title"
              ? "类型与标题在忽略大小写、全角和连续空白后相同；同名不等于同一记忆。"
              : "非空正文在忽略大小写、全角和连续空白后相同；这里只检查字面线索，不判断事实是否重复。",
        });
      }
  return result;
}
