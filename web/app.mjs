import {
  example,
  emptyGraph,
  graphSources,
  NODE_TYPES,
  NODE_STATES,
  edgeKey,
} from "./mgp.mjs";
import { loadExportPrompt } from "./prompt.mjs";
import { ImportUi } from "./import-ui.mjs";
import { Workspace } from "./workspace.mjs";
import {
  loadWorkspace,
  saveWorkspace,
  clearWorkspaceStorage,
  loadWorkspaceRevision,
  StorageConflictError,
} from "./storage.mjs";
import { BackupUi } from "./backup-ui.mjs";
import { Sky, PALETTE } from "./sky.mjs";
import { GROUP_NAMES } from "./layout.mjs";
const $ = (id) => document.getElementById(id);
const element = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const states = {
  confirmed: "已确认",
  inferred: "推测",
  deprecated: "已过时",
  disputed: "有争议",
  unknown: "未知",
};
const bases = { explicit: "明确", inferred: "推测", rule: "规则" };
const coverages = {
  full: "全量（导出方声明，未经验证）",
  partial: "部分",
  unknown: "未知",
};
const time = (value) =>
  value ? new Date(value).toLocaleString() : "未提供时间";
const short = (text = "", limit = 180) =>
  text.length > limit ? text.slice(0, limit) + "…" : text;
const PAGE_SIZE = 40,
  EDGE_PAGE = 12;
let workspace = new Workspace(example, { demo: true }),
  selected = null,
  typeFilter = "all",
  query = "",
  stateFilter = "all",
  view = "graph",
  listPage = 0,
  timelinePage = 0,
  edgePage = 0,
  timelineMode = "memory";
let graphReference = null,
  layoutUnavailable = false,
  nodeMap = new Map(),
  adjacency = new Map(),
  filtered = [],
  dirty = false,
  autosave = false,
  saveTimer = null,
  saveQueue = Promise.resolve(),
  saving = 0,
  viewVersion = 0,
  editingNode = null,
  editingEdge = null,
  confirmation = null,
  externalSave = false,
  unreadableStorage = false,
  storageRevision = null,
  hasSaved = false;
const media = matchMedia("(max-width:760px)"),
  motion = matchMedia("(prefers-reduced-motion: reduce)");
workspace.view.animate = !motion.matches;
const notice = (message, error = false) => {
  $("notice").textContent = message;
  $("notice").classList.toggle("error", error);
};
function saveLabel() {
  $("saveStatus").textContent = saving
    ? "正在保存"
    : externalSave
      ? "本机存储有变化"
      : dirty
        ? "未保存到本机"
        : hasSaved
          ? "已保存到本机"
          : "示例 · 未保存";
}
function markDirty() {
  dirty = true;
  viewVersion++;
  saveLabel();
  if (autosave) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => persist(false), 650);
  }
}
const sky = new Sky($("sky"), {
  onSelect: (id) => selectNode(id),
  onMove: () => {
    markDirty();
    renderInspector();
  },
  onZoom: (value) =>
    ($("zoomValue").textContent =
      (value < 0.01 ? (value * 100).toFixed(3) : Math.round(value * 100)) +
      "%"),
  onStatus: (status) => {
    if (status.error) {
      layoutUnavailable = true;
      $("layoutStatus").textContent = "布局降级";
      notice(status.error, true);
      return;
    }
    if (status.drawn !== undefined) {
      $("renderStatus").textContent =
        `视野内 ${status.inViewport.toLocaleString()} 颗星 · 绘制 ${status.drawn.toLocaleString()} 颗 · ${status.edgesDrawn.toLocaleString()} 条连线` +
        (status.aggregated ? " · 部分细节已省略，放大或使用列表查看" : "");
    }
    const label = status.active ? "星图正在布局" : "星图布局就绪";
    if (!layoutUnavailable && $("layoutStatus").textContent !== label)
      $("layoutStatus").textContent = label;
  },
});
function currentView() {
  return { ...workspace.view, positions: sky.getPositions() };
}
function syncGraph({ restoredView = false } = {}) {
  const changed = graphReference !== workspace.graph;
  if (changed) {
    if (graphReference && !restoredView && !workspace.demo) {
      const ids = new Set(workspace.graph.nodes.map((node) => node.id));
      workspace.view.positions = sky
        .getPositions()
        .filter((position) => ids.has(position.id));
    }
    graphReference = workspace.graph;
    nodeMap = new Map(workspace.graph.nodes.map((node) => [node.id, node]));
    adjacency = new Map(workspace.graph.nodes.map((node) => [node.id, []]));
    for (const edge of workspace.graph.edges) {
      adjacency.get(edge.from)?.push(edge);
      if (edge.to !== edge.from) adjacency.get(edge.to)?.push(edge);
    }
    if (!nodeMap.has(selected)) selected = null;
    sky.setGraph(workspace.graph, workspace.view);
    sky.setSelection(selected);
    listPage = timelinePage = edgePage = 0;
  }
  $("nodeCount").textContent = workspace.graph.nodes.length.toLocaleString();
  $("edgeCount").textContent = workspace.graph.edges.length.toLocaleString();
  $("sourceCount").textContent = graphSources(
    workspace.graph,
  ).length.toLocaleString();
  $("coverage").textContent = workspace.demo
    ? "覆盖范围：仅示例数据"
    : `覆盖范围：${graphSources(workspace.graph).length} 个来源 · 声明未经独立验证`;
  $("demoLabel").hidden = !workspace.demo;
  $("graphEmpty").hidden = workspace.graph.nodes.length !== 0;
  $("clusterBy").value = workspace.view.clusterBy;
  $("showLabels").checked = workspace.view.showLabels;
  $("animateLayout").checked = workspace.view.animate;
  renderFilters();
  applyFilters();
  renderInspector();
  renderHistory();
  renderSources();
}
workspace.addEventListener("change", workspaceChanged);
function workspaceChanged(event) {
  syncGraph({ restoredView: event.detail.label === "恢复完整备份" });
  markDirty();
  notice(
    event.detail.label +
      (workspace.pruned
        ? `。已移除最早的 ${workspace.pruned} 份快照；长期保留请下载完整备份。`
        : "。"),
  );
}
function renderFilters() {
  const counts = new Map();
  for (const node of workspace.graph.nodes)
    counts.set(node.type, (counts.get(node.type) || 0) + 1);
  if (typeFilter !== "all" && !counts.has(typeFilter)) typeFilter = "all";
  const wrap = $("filters");
  wrap.replaceChildren();
  for (const [key, label] of [
    ["all", "全部"],
    ...NODE_TYPES.filter((type) => counts.has(type)).map((type) => [
      type,
      GROUP_NAMES[type],
    ]),
  ]) {
    const button = element(
      "button",
      label + (key === "all" ? "" : " " + counts.get(key)),
      "chip" + (key === typeFilter ? " active" : ""),
    );
    button.setAttribute("aria-pressed", String(key === typeFilter));
    if (key !== "all") {
      const dot = element("span", undefined, "legend-dot");
      dot.style.background = PALETTE[key];
      dot.setAttribute("aria-hidden", "true");
      button.prepend(dot);
    }
    button.onclick = () => {
      typeFilter = key;
      listPage = timelinePage = 0;
      renderFilters();
      applyFilters();
    };
    wrap.append(button);
  }
}
function applyFilters() {
  filtered = workspace.graph.nodes.filter(
    (node) =>
      (typeFilter === "all" || node.type === typeFilter) &&
      (stateFilter === "all" || (node.state || "unknown") === stateFilter) &&
      (!query ||
        [node.id, node.label, node.content || "", ...(node.tags || [])]
          .join(" ")
          .toLocaleLowerCase()
          .includes(query)),
  );
  sky.setFilter(new Set(filtered.map((node) => node.id)));
  const results = $("searchResults");
  results.replaceChildren();
  $("searchSummary").textContent = query
    ? `找到 ${filtered.length.toLocaleString()} 条记忆；以下显示前 ${Math.min(6, filtered.length)} 条`
    : "";
  if (query)
    for (const node of filtered.slice(0, 6)) {
      const item = element("li"),
        button = element("button", node.label);
      button.title = node.id;
      button.onclick = () => locate(node.id, true);
      item.append(button);
      results.append(item);
    }
  $("listSummary").textContent =
    `当前筛选 ${filtered.length.toLocaleString()} 条 / 共 ${workspace.graph.nodes.length.toLocaleString()} 条。选择标题可定位到星盘并查看详情。`;
  if (view === "list") renderList();
  if (view === "timeline") renderTimeline();
}
function stateBadge(node) {
  const badge = element("span", states[node.state || "unknown"], "state-badge");
  badge.dataset.state = node.state || "unknown";
  return badge;
}
function pageControls(prefix, page, total, limit) {
  const pages = Math.max(1, Math.ceil(total / limit));
  $(prefix + "Page").textContent = `${page + 1} / ${pages}`;
  $(prefix + "Previous").disabled = page === 0;
  $(prefix + "Next").disabled = page >= pages - 1;
}
function renderList() {
  listPage = Math.min(
    listPage,
    Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1),
  );
  const wrap = $("nodeList");
  wrap.replaceChildren();
  if (!filtered.length)
    wrap.append(
      element(
        "p",
        "没有符合筛选的记忆。可以清除筛选或导入数据。",
        "empty-state",
      ),
    );
  for (const node of filtered.slice(
    listPage * PAGE_SIZE,
    (listPage + 1) * PAGE_SIZE,
  )) {
    const card = element("article", undefined, "memory-card"),
      heading = element("div", undefined, "card-title"),
      dot = element("span", undefined, "type-dot"),
      title = element("h3"),
      button = element("button", node.label);
    dot.style.setProperty("--dot", PALETTE[node.type] || PALETTE.other);
    dot.setAttribute("aria-hidden", "true");
    button.onclick = () => locate(node.id, true);
    title.append(button);
    heading.append(dot, title);
    const meta = element("div", undefined, "card-meta");
    meta.append(
      stateBadge(node),
      element("span", GROUP_NAMES[node.type] || node.type),
      element("span", node.updated_at ? time(node.updated_at) : "时间未知"),
    );
    card.append(heading, element("p", short(node.content || "暂无正文")), meta);
    wrap.append(card);
  }
  pageControls("list", listPage, filtered.length, PAGE_SIZE);
}
function showView(next, focus = false) {
  view = next;
  for (const button of document.querySelectorAll("[data-view]")) {
    const active = button.dataset.view === next;
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  }
  for (const panel of document.querySelectorAll(".view-panel"))
    panel.hidden = panel.id !== "panel-" + next;
  if (next === "list") renderList();
  if (next === "timeline") renderTimeline();
  if (next === "history") renderHistory();
  if (next === "sources") renderSources();
  if (next === "graph") sky.resize();
  $("inspector").hidden = next !== "graph" || !selected;
  if (focus) $("tab-" + next).focus();
}
function locate(id, focus = false) {
  if (!nodeMap.has(id)) return;
  if (!filtered.some((node) => node.id === id)) {
    query = "";
    typeFilter = "all";
    stateFilter = "all";
    $("search").value = "";
    $("stateFilter").value = "all";
    renderFilters();
    applyFilters();
  }
  closeDrawer();
  showView("graph");
  selectNode(id);
  sky.focus(id);
  if (focus) $("detailTitle").focus({ preventScroll: true });
}
function selectNode(id) {
  selected = id;
  edgePage = 0;
  sky.setSelection(id);
  renderInspector();
}
function metaItem(wrap, key, value) {
  if (!value) return;
  wrap.append(element("dt", key), element("dd", value));
}
function renderInspector() {
  const node = nodeMap.get(selected);
  $("inspector").hidden = !node || view !== "graph";
  if (!node) return;
  $("detailTitle").textContent = node.label;
  $("detailType").textContent = GROUP_NAMES[node.type] || node.type;
  $("detailState").textContent = states[node.state || "unknown"];
  $("detailState").dataset.state = node.state || "unknown";
  $("detailContent").textContent = node.content || "暂无正文";
  $("detailTags").replaceChildren(
    ...(node.tags || []).map((tag) => element("span", tag)),
  );
  const meta = $("detailMeta");
  meta.replaceChildren();
  metaItem(meta, "稳定 ID", node.id);
  metaItem(
    meta,
    "最近更新时间",
    node.updated_at ? time(node.updated_at) : "未提供",
  );
  metaItem(meta, "记录来源", node.source_id || workspace.graph.source.id);
  metaItem(meta, "出处引用", node.source_ref);
  metaItem(
    meta,
    "来源追溯",
    (node.provenance || [])
      .map(
        (source) => source.source_id + (source.ref ? " · " + source.ref : ""),
      )
      .join("\n"),
  );
  if (node.sensitive) metaItem(meta, "敏感标记", "是 · 内容未加密");
  for (const id of ["editNodeBtn", "deleteNodeBtn", "addEdgeBtn"])
    $(id).disabled = workspace.demo;
  $("pinNodeBtn").textContent = sky.pins.has(node.id) ? "释放固定" : "固定位置";
  const links = adjacency.get(node.id) || [];
  edgePage = Math.min(
    edgePage,
    Math.max(0, Math.ceil(links.length / EDGE_PAGE) - 1),
  );
  $("detailLinkCount").textContent = "关联关系 · " + links.length;
  const wrap = $("detailLinks");
  wrap.replaceChildren();
  if (!links.length)
    wrap.append(
      element("p", "暂无关联。可以根据已知依据手动添加。", "small muted"),
    );
  for (const edge of links.slice(
    edgePage * EDGE_PAGE,
    (edgePage + 1) * EDGE_PAGE,
  )) {
    const key = edgeKey(edge),
      other = nodeMap.get(edge.from === node.id ? edge.to : edge.from),
      card = element("article", undefined, "relation-card"),
      button = element(
        "button",
        (edge.from === node.id ? "→ " : "← ") + (other?.label || "未知节点"),
        "relation-target",
      );
    button.onclick = () => locate(other.id, true);
    card.append(
      button,
      element("p", `${edge.type} · ${bases[edge.basis] || edge.basis}`),
    );
    if (edge.evidence)
      card.append(element("p", "依据：" + short(edge.evidence, 300)));
    if (edge.source_ref)
      card.append(element("p", "出处：" + short(edge.source_ref, 150)));
    card.append(
      element("p", "来源：" + (edge.source_id || workspace.graph.source.id)),
    );
    const actions = element("div", undefined, "relation-actions"),
      highlight = element("button", "高亮", "text-button"),
      edit = element("button", "编辑", "text-button"),
      remove = element("button", "删除", "text-button danger-text");
    highlight.onclick = () => sky.setSelection(node.id, key);
    edit.disabled = remove.disabled = workspace.demo;
    edit.onclick = () => openEdge(edge);
    remove.onclick = () =>
      ask("删除关系", "仅删除此关系，两个节点仍保留。可从快照恢复。", () =>
        workspace.deleteEdge(key),
      );
    actions.append(highlight, edit, remove);
    card.append(actions);
    wrap.append(card);
  }
  pageControls("edge", edgePage, links.length, EDGE_PAGE);
}
function renderTimeline() {
  const items =
    timelineMode === "memory"
      ? [...filtered].sort((a, b) =>
          a.updated_at && b.updated_at
            ? Date.parse(b.updated_at) - Date.parse(a.updated_at) ||
              a.id.localeCompare(b.id)
            : a.updated_at
              ? -1
              : b.updated_at
                ? 1
                : a.id.localeCompare(b.id),
        )
      : [...workspace.events].reverse();
  timelinePage = Math.min(
    timelinePage,
    Math.max(0, Math.ceil(items.length / PAGE_SIZE) - 1),
  );
  const wrap = $("timelineList");
  wrap.replaceChildren();
  if (!items.length)
    wrap.append(
      element(
        "p",
        timelineMode === "memory"
          ? "暂无符合筛选的记忆。"
          : "本次工作区尚无操作记录。",
        "empty-state",
      ),
    );
  let unknownHeading = false;
  for (const item of items.slice(
    timelinePage * PAGE_SIZE,
    (timelinePage + 1) * PAGE_SIZE,
  )) {
    if (timelineMode === "memory" && !item.updated_at && !unknownHeading) {
      wrap.append(element("h3", "未提供更新时间", "small muted"));
      unknownHeading = true;
    }
    const entry = element("article", undefined, "timeline-entry"),
      date = timelineMode === "memory" ? item.updated_at : item.created_at,
      stamp = element("time", date ? time(date) : "更新时间未知");
    if (date) stamp.dateTime = date;
    entry.append(stamp);
    if (timelineMode === "memory") {
      const button = element("button", item.label);
      button.onclick = () => locate(item.id, true);
      entry.append(
        button,
        element("p", short(item.content || "暂无正文", 120)),
      );
    } else
      entry.append(
        element("p", item.label),
        element("p", `${item.nodes} 个节点 · ${item.edges} 条关系`),
      );
    wrap.append(entry);
  }
  pageControls("timeline", timelinePage, items.length, PAGE_SIZE);
}
function renderHistory() {
  const wrap = $("snapshotList");
  wrap.replaceChildren();
  $("snapshotBtn").disabled = workspace.demo;
  $("undoBtn").disabled = !workspace.snapshots.some(
    (snapshot) => snapshot.kind === "before",
  );
  if (!workspace.snapshots.length)
    wrap.append(
      element(
        "p",
        "还没有快照。导入自己的记忆后，修改前会自动保留图谱，也可以手动创建命名快照。",
        "empty-state",
      ),
    );
  for (const snapshot of [...workspace.snapshots].reverse()) {
    const card = element("article", undefined, "snapshot-card"),
      text = element("div");
    text.append(
      element("h3", snapshot.label),
      element("p", time(snapshot.created_at)),
      element(
        "p",
        `${snapshot.graph.nodes.length} 个节点 · ${snapshot.graph.edges.length} 条关系 · ${snapshot.kind === "manual" ? "命名快照" : "修改前快照"}`,
      ),
    );
    const button = element("button", "恢复", "btn");
    button.onclick = () =>
      ask(
        "恢复快照",
        `恢复「${snapshot.label}」将替换当前图谱。当前版本会保留为修改前快照。`,
        () => workspace.restoreSnapshot(snapshot.id),
      );
    card.append(text, button);
    wrap.append(card);
  }
}
function renderSources() {
  const wrap = $("sourceList");
  wrap.replaceChildren();
  for (const source of graphSources(workspace.graph)) {
    const card = element("article", undefined, "source-card"),
      meta = element("dl", undefined, "metadata");
    card.append(element("h3", source.id));
    metaItem(meta, "平台", source.platform || "未提供");
    metaItem(meta, "覆盖范围声明", source.scope || "未提供");
    metaItem(meta, "完整性声明", coverages[source.completeness || "unknown"]);
    metaItem(
      meta,
      "导出时间",
      source.exported_at ? time(source.exported_at) : "未提供",
    );
    metaItem(meta, "核验状态", "未经独立验证");
    card.append(meta);
    wrap.append(card);
  }
  if (!wrap.children.length)
    wrap.append(
      element(
        "p",
        "当前没有来源声明。添加记忆或导入数据后会在这里展示。",
        "empty-state",
      ),
    );
}
function ask(title, text, action) {
  confirmation = action;
  $("confirmTitle").textContent = title;
  $("confirmText").textContent = text;
  $("confirmDialog").showModal();
}
$("confirmAction").onclick = () => {
  const action = confirmation;
  confirmation = null;
  $("confirmDialog").close();
  try {
    action?.();
  } catch (error) {
    notice(error.message, true);
  }
};
$("cancelAction").onclick = () => {
  $("confirmDialog").close();
  confirmation = null;
};
$("confirmDialog").addEventListener("cancel", () => (confirmation = null));
for (const button of document.querySelectorAll("[data-close]"))
  button.onclick = () => $(button.dataset.close).close();
function openNode(node = null) {
  editingNode = node?.id || null;
  $("nodeDialogTitle").textContent = node ? "编辑记忆" : "添加记忆";
  $("nodeId").value = node?.id || "";
  $("nodeId").disabled = Boolean(node);
  $("nodeLabel").value = node?.label || "";
  $("nodeType").value = node?.type || "memory";
  $("nodeState").value = node?.state || "unknown";
  $("nodeContent").value = node?.content || "";
  $("nodeTags").value = (node?.tags || []).join(", ");
  $("nodeRef").value = node ? workspace.editableReference(node) : "";
  $("nodeSensitive").checked = Boolean(node?.sensitive);
  $("nodeError").hidden = true;
  $("nodeDialog").showModal();
  $("nodeLabel").focus();
}
for (const type of NODE_TYPES) {
  const option = element("option", GROUP_NAMES[type]);
  option.value = type;
  $("nodeType").append(option);
}
for (const state of NODE_STATES) {
  const option = element("option", states[state]);
  option.value = state;
  $("nodeState").append(option);
}
$("nodeForm").onsubmit = (event) => {
  event.preventDefault();
  const fields = {
    label: $("nodeLabel").value.trim(),
    type: $("nodeType").value,
    state: $("nodeState").value,
    content: $("nodeContent").value,
    tags: [
      ...new Set(
        $("nodeTags")
          .value.split(/[,，\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
      ),
    ],
    source_ref: $("nodeRef").value.trim(),
    sensitive: $("nodeSensitive").checked,
  };
  if (!fields.source_ref) delete fields.source_ref;
  try {
    let id = editingNode;
    if (id) {
      if (!$("nodeRef").value.trim()) fields.source_ref = "";
      workspace.editNode(id, fields);
    } else {
      const custom = $("nodeId").value.trim();
      if (custom) fields.id = custom;
      id = workspace.addNode(fields);
    }
    $("nodeDialog").close();
    locate(id, true);
  } catch (error) {
    $("nodeError").textContent = error.message;
    $("nodeError").hidden = false;
  }
};
function endpointChoices(text = "") {
  const query = text.toLocaleLowerCase(),
    choices = workspace.graph.nodes
      .filter(
        (node) =>
          !query ||
          node.id.toLocaleLowerCase().includes(query) ||
          node.label.toLocaleLowerCase().includes(query),
      )
      .slice(0, 35);
  $("nodeChoices").replaceChildren(
    ...choices.map((node) => {
      const option = element("option");
      option.value = node.id;
      option.label = short(node.label, 80);
      return option;
    }),
  );
}
function openEdge(edge = null) {
  if (workspace.demo) {
    notice("请先导入自己的记忆或新建工作区。", true);
    return;
  }
  editingEdge = edge ? edgeKey(edge) : null;
  $("edgeDialogTitle").textContent = edge ? "编辑关系" : "添加关系";
  $("edgeFrom").value = edge?.from || selected || "";
  $("edgeTo").value = edge?.to || "";
  $("edgeType").value = edge?.type || "";
  $("edgeBasis").value = edge?.basis || "explicit";
  $("edgeEvidence").value = edge?.evidence || "";
  $("edgeError").hidden = true;
  endpointChoices();
  $("edgeDialog").showModal();
}
for (const id of ["edgeFrom", "edgeTo"])
  $(id).oninput = (event) => endpointChoices(event.target.value);
$("edgeForm").onsubmit = (event) => {
  event.preventDefault();
  const fields = {
    from: $("edgeFrom").value.trim(),
    to: $("edgeTo").value.trim(),
    type: $("edgeType").value.trim(),
    basis: $("edgeBasis").value,
    evidence: $("edgeEvidence").value.trim(),
  };
  try {
    if (!nodeMap.has(fields.from) || !nodeMap.has(fields.to))
      throw new Error("起点和终点必须填写现有节点的稳定 ID");
    if (!fields.evidence) throw new Error("请填写关系依据");
    if (editingEdge) workspace.editEdge(editingEdge, fields);
    else workspace.addEdge(fields);
    $("edgeDialog").close();
    renderInspector();
  } catch (error) {
    $("edgeError").textContent = error.message;
    $("edgeError").hidden = false;
  }
};
function download(value, name) {
  const blob = new Blob([JSON.stringify(value)], {
      type: "application/json",
    }),
    url = URL.createObjectURL(blob),
    anchor = element("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
let channel = null;
function pauseAutosave() {
  externalSave = true;
  autosave = false;
  $("autosave").checked = false;
  clearTimeout(saveTimer);
  saveLabel();
}
try {
  channel = new BroadcastChannel("memory-galaxy-workspace");
  channel.onmessage = () => {
    pauseAutosave();
    notice(
      "另一个页面更新了本机存储。已暂停本页自动保存；请先备份当前数据，再决定是否覆盖。",
      true,
    );
  };
} catch {}
async function persist(manual = true) {
  clearTimeout(saveTimer);
  if (externalSave) {
    if (manual)
      ask(
        unreadableStorage ? "覆盖未能读取的本机工作区" : "覆盖另一页面的保存",
        unreadableStorage
          ? "此前未能读取本机工作区。继续将覆盖原保存，请先保留需要的数据和备份。"
          : "另一页面更新过本机存储。确认将使用当前页面的完整工作区覆盖，请先下载需要保留的备份。",
        async () => {
          try {
            storageRevision = await loadWorkspaceRevision();
            externalSave = false;
            await persist(true);
          } catch (error) {
            notice("无法读取保存版本：" + error.message, true);
          }
        },
      );
    return;
  }
  let backup;
  try {
    workspace.view = currentView();
    backup = workspace.backup();
  } catch (error) {
    notice("无法准备保存：" + error.message, true);
    return;
  }
  const version = workspace.version,
    viewStamp = viewVersion,
    enabled = autosave;
  saving++;
  saveLabel();
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      if (externalSave) throw new StorageConflictError();
      storageRevision = await saveWorkspace(backup, enabled, storageRevision);
    });
  try {
    await saveQueue;
    if (version === workspace.version && viewStamp === viewVersion)
      dirty = false;
    hasSaved = true;
    unreadableStorage = false;
    channel?.postMessage({ saved: true });
    if (manual)
      notice("图谱、快照和视图已保存到这个浏览器。IndexedDB 存储未加密。");
  } catch (error) {
    if (error instanceof StorageConflictError) pauseAutosave();
    notice("保存失败，页面中的数据仍保留：" + error.message, true);
  } finally {
    saving--;
    saveLabel();
  }
}
function openDrawer() {
  if (!media.matches) return;
  $("sidebar").classList.add("open");
  $("sidebar").inert = false;
  $("sidebar").removeAttribute("aria-hidden");
  $("sidebar").setAttribute("role", "dialog");
  $("sidebar").setAttribute("aria-modal", "true");
  $("drawerBackdrop").hidden = false;
  $("mainArea").inert = true;
  $("menuBtn").setAttribute("aria-expanded", "true");
  $("menuBtn").setAttribute("aria-label", "关闭工具栏");
  $("search").focus();
}
function closeDrawer() {
  if (!media.matches) return;
  const hadFocus = $("sidebar").contains(document.activeElement);
  $("sidebar").classList.remove("open");
  $("sidebar").inert = true;
  $("sidebar").setAttribute("aria-hidden", "true");
  $("sidebar").removeAttribute("aria-modal");
  $("drawerBackdrop").hidden = true;
  $("mainArea").inert = false;
  $("menuBtn").setAttribute("aria-expanded", "false");
  $("menuBtn").setAttribute("aria-label", "打开工具栏");
  if (hadFocus) $("menuBtn").focus();
}
function updateDrawer() {
  if (media.matches) closeDrawer();
  else {
    $("sidebar").classList.remove("open");
    $("sidebar").inert = false;
    $("sidebar").removeAttribute("aria-hidden");
    $("sidebar").removeAttribute("role");
    $("sidebar").removeAttribute("aria-modal");
    $("mainArea").inert = false;
    $("drawerBackdrop").hidden = true;
    $("menuBtn").setAttribute("aria-expanded", "false");
  }
  sky.resize();
}
$("menuBtn").onclick = () =>
  $("sidebar").classList.contains("open") ? closeDrawer() : openDrawer();
$("drawerBackdrop").onclick = closeDrawer;
media.addEventListener("change", updateDrawer);
$("sidebar").addEventListener("keydown", (event) => {
  if (
    !media.matches ||
    !$("sidebar").classList.contains("open") ||
    document.querySelector("dialog[open]")
  )
    return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (event.key === "Tab") {
    const controls = [
        ...$("sidebar").querySelectorAll(
          "button:not(:disabled),input:not([hidden]),select,textarea",
        ),
      ].filter((control) => control.getClientRects().length),
      first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }
});
$("emptyImport").onclick = () => {
  openDrawer();
  $("input").focus();
};
for (const button of document.querySelectorAll("[data-view]")) {
  button.onclick = () => showView(button.dataset.view);
  button.onkeydown = (event) => {
    const tabs = [...document.querySelectorAll("[data-view]")],
      index = tabs.indexOf(button);
    let next;
    if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft")
      next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    showView(tabs[next].dataset.view, true);
  };
}
let searchTimer;
$("search").oninput = (event) => {
  query = event.target.value.trim().toLocaleLowerCase();
  listPage = timelinePage = 0;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(applyFilters, 100);
};
$("search").onkeydown = (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    clearTimeout(searchTimer);
    applyFilters();
    if (filtered.length) locate(filtered[0].id, true);
  }
};
$("stateFilter").onchange = (event) => {
  stateFilter = event.target.value;
  listPage = timelinePage = 0;
  applyFilters();
};
$("clearFilters").onclick = () => {
  query = "";
  typeFilter = "all";
  stateFilter = "all";
  $("search").value = "";
  $("stateFilter").value = "all";
  listPage = timelinePage = 0;
  renderFilters();
  applyFilters();
};
$("clusterBy").onchange = (event) => {
  const settings = currentView();
  workspace.view = {
    ...settings,
    positions: settings.positions.filter((position) => position.pinned),
    clusterBy: event.target.value,
  };
  sky.setGraph(workspace.graph, workspace.view);
  applyFilters();
  sky.setSelection(selected);
  markDirty();
};
$("showLabels").onchange = (event) => {
  workspace.view.showLabels = event.target.checked;
  sky.setLabels(event.target.checked);
  markDirty();
};
$("animateLayout").onchange = (event) => {
  workspace.view.animate = event.target.checked;
  sky.setAnimate(event.target.checked);
  markDirty();
};
motion.addEventListener("change", (event) => {
  if (event.matches) {
    workspace.view.animate = false;
    $("animateLayout").checked = false;
    sky.setAnimate(false);
  }
});
$("zoomIn").onclick = () => sky.scale(1.3);
$("zoomOut").onclick = () => sky.scale(1 / 1.3);
$("fitGraph").onclick = () => sky.fit();
$("closeInspector").onclick = () => {
  selectNode(null);
  $("sky").focus();
};
$("inspector").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    selectNode(null);
    $("sky").focus();
  }
});
$("addNodeBtn").onclick = () => openNode();
$("editNodeBtn").onclick = () => openNode(nodeMap.get(selected));
$("pinNodeBtn").onclick = () =>
  sky.setPinned(selected, !sky.pins.has(selected));
$("addEdgeBtn").onclick = () => openEdge();
$("deleteNodeBtn").onclick = () => {
  const node = nodeMap.get(selected);
  if (node)
    ask(
      "删除记忆",
      `删除「${short(node.label, 100)}」及其 ${adjacency.get(node.id).length} 条关系。删除记录会保留，可通过快照恢复。`,
      () => workspace.deleteNode(node.id),
    );
};
for (const [prefix, previous, next] of [
  [
    "list",
    () => {
      listPage--;
      renderList();
    },
    () => {
      listPage++;
      renderList();
    },
  ],
  [
    "timeline",
    () => {
      timelinePage--;
      renderTimeline();
    },
    () => {
      timelinePage++;
      renderTimeline();
    },
  ],
  [
    "edge",
    () => {
      edgePage--;
      renderInspector();
    },
    () => {
      edgePage++;
      renderInspector();
    },
  ],
]) {
  $(prefix + "Previous").onclick = previous;
  $(prefix + "Next").onclick = next;
}
function timelineModeChanged(mode) {
  timelineMode = mode;
  timelinePage = 0;
  for (const [id, value] of [
    ["memoryTimelineBtn", "memory"],
    ["activityTimelineBtn", "activity"],
  ]) {
    $(id).classList.toggle("active", mode === value);
    $(id).setAttribute("aria-pressed", String(mode === value));
  }
  renderTimeline();
}
$("memoryTimelineBtn").onclick = () => timelineModeChanged("memory");
$("activityTimelineBtn").onclick = () => timelineModeChanged("activity");
$("snapshotBtn").onclick = () => {
  $("snapshotLabel").value = "";
  $("snapshotDialog").showModal();
};
$("snapshotForm").onsubmit = (event) => {
  event.preventDefault();
  try {
    workspace.snapshot($("snapshotLabel").value.trim() || "命名快照");
    $("snapshotDialog").close();
  } catch (error) {
    notice(error.message, true);
  }
};
$("undoBtn").onclick = () => {
  try {
    workspace.undo();
  } catch (error) {
    notice(error.message, true);
  }
};
$("newWorkspaceBtn").onclick = () =>
  ask(
    "新建空白工作区",
    "当前图谱会保留为修改前快照。本机缓存不会立即清除。",
    () => {
      workspace.view.positions = [];
      workspace.replace(emptyGraph(), "新建空白工作区");
      selectNode(null);
    },
  );
$("resetBtn").onclick = () => {
  const apply = () => {
    workspace.view.positions = [];
    workspace.replace(example, "查看示例星图", { demo: true });
    selectNode(null);
  };
  if (workspace.demo) apply();
  else
    ask(
      "查看示例星图",
      "当前图谱会保留为修改前快照。示例不会混入之后导入的数据。",
      apply,
    );
};
$("copyPrompt").onclick = async () => {
  try {
    const text = await loadExportPrompt();
    try {
      await navigator.clipboard.writeText(text);
      notice("导出提示词已复制。发送给 AI 后，将输出的 JSON 粘贴到这里预览。");
    } catch {
      $("input").value = text;
      $("input").focus();
      $("input").select();
      notice("浏览器未允许写入剪贴板，已将提示词放入文本框，请手动复制。");
    }
  } catch {
    notice("导出提示词加载失败，请刷新页面后重试。", true);
  }
};
new ImportUi({
  getGraph: () => workspace.graph,
  getRevision: () => workspace.version,
  isExample: () => workspace.demo,
  onApply: (graph) => {
    workspace.view = currentView();
    workspace.replace(graph, "导入记忆");
  },
  onNotice: notice,
});
new BackupUi({
  onRestore: (backup) => {
    workspace.restoreBackup(backup);
  },
  onNotice: notice,
});
$("exportBtn").onclick = () =>
  download(workspace.graph, "memory-galaxy.mgp.json");
$("backupBtn").onclick = () => {
  try {
    workspace.view = currentView();
    download(workspace.backup(), "memory-galaxy.backup.json");
    notice("完整备份已下载，包含图谱、快照、操作记录和视图设置。");
  } catch (error) {
    notice("无法导出完整备份：" + error.message, true);
  }
};
$("saveBtn").onclick = () => persist(true);
$("autosave").onchange = (event) => {
  autosave = event.target.checked;
  clearTimeout(saveTimer);
  persist(true);
};
$("clearSaveBtn").onclick = () => {
  const allowExternal = externalSave;
  ask(
    "清除本机缓存",
    (externalSave ? "其他页面已更新保存，继续会清除其保存内容。" : "") +
      "删除这个浏览器保存的图谱、快照和视图，并关闭自动保存。当前页面的数据仍保留，请按需先下载完整备份。",
    async () => {
      autosave = false;
      $("autosave").checked = false;
      clearTimeout(saveTimer);
      saveQueue = saveQueue
        .catch(() => {})
        .then(async () => {
          if (allowExternal) storageRevision = await loadWorkspaceRevision();
          storageRevision = await clearWorkspaceStorage(storageRevision);
          externalSave = false;
          unreadableStorage = false;
        });
      try {
        await saveQueue;
        dirty = true;
        hasSaved = false;
        saveLabel();
        channel?.postMessage({ cleared: true });
        notice("本机缓存已清除，自动保存已关闭。当前页面里的数据仍保留。");
      } catch (error) {
        if (error instanceof StorageConflictError) pauseAutosave();
        notice("清除缓存失败：" + error.message, true);
      }
    },
  );
};
window.addEventListener("beforeunload", (event) => {
  if (dirty && !workspace.demo) {
    event.preventDefault();
    event.returnValue = "";
  }
});
async function initialize() {
  $("sidebar").inert = true;
  $("mainArea").inert = true;
  try {
    const saved = await loadWorkspace();
    storageRevision = saved?.revision ?? null;
    if (saved?.backup) {
      workspace.restoreBackup(saved.backup, {
        record: false,
        preserveCurrent: false,
      });
      hasSaved = true;
      autosave = saved.autosave;
      $("autosave").checked = autosave;
      notice("已载入此前保存的图谱、快照与视图。");
    } else if (saved?.legacy) {
      workspace = new Workspace(saved.legacy, { demo: saved.demo });
      hasSaved = true;
      workspace.view.animate = !motion.matches;
      workspace.addEventListener("change", workspaceChanged);
      notice(
        "已载入旧版本机图谱。下次主动保存时会迁移到 IndexedDB，原缓存暂时保留。",
      );
    }
  } catch (error) {
    unreadableStorage = true;
    pauseAutosave();
    notice("无法读取本机工作区，原数据仍保留：" + error.message, true);
  }
  if (motion.matches) workspace.view.animate = false;
  syncGraph();
  dirty = false;
  viewVersion = 0;
  saveLabel();
  $("app").setAttribute("aria-busy", "false");
  document.body.dataset.ready = "true";
  updateDrawer();
}
initialize();
