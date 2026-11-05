import {
  PROTOCOL,
  validateMgp,
  mergeMgp,
  graphSources,
  isExampleGraph,
  LIMITS,
  emptyGraph,
  edgeKey,
} from "./mgp.mjs";
export const BACKUP_FORMAT = "memory-galaxy/backup/1";
export const HISTORY_LIMIT = 12;
export const HISTORY_BYTES = 16 * 1024 * 1024;
export const BACKUP_BYTES = 48 * 1024 * 1024;
const clone = structuredClone;
const size = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
const manualTemplate = {
  id: "local:edits",
  platform: "manual",
  scope: "用户手动编辑",
  completeness: "partial",
};
export function makeId(kind = "node") {
  const values = new Uint32Array(4);
  crypto.getRandomValues(values);
  return (
    "local:" +
    kind +
    ":" +
    [...values].map((value) => value.toString(16).padStart(8, "0")).join("")
  );
}
function editSource(graph) {
  const sources = graphSources(graph),
    existing = sources.find(
      (source) =>
        /^local:edits(?::\d+)?$/.test(source.id) &&
        source.platform === manualTemplate.platform &&
        source.scope === manualTemplate.scope &&
        source.completeness === manualTemplate.completeness &&
        Object.keys(source).every((key) => Object.hasOwn(manualTemplate, key)),
    );
  if (existing) return existing;
  const ids = new Set(sources.map((source) => source.id));
  let id = manualTemplate.id,
    suffix = 0;
  while (ids.has(id)) id = manualTemplate.id + ":" + ++suffix;
  return { ...manualTemplate, id };
}
function editFields(current, patch, graph, source) {
  return {
    ...current,
    ...patch,
    source_ref: Object.hasOwn(patch, "source_ref")
      ? patch.source_ref
      : (current.source_id || graph.source.id) === source.id
        ? current.source_ref || ""
        : "",
    provenance: [
      ...(current.provenance || []),
      {
        source_id: current.source_id || graph.source.id,
        ...(current.source_ref ? { ref: current.source_ref } : {}),
      },
    ],
    source_id: source.id,
  };
}
function assertGraph(graph) {
  const result = validateMgp(graph);
  if (!result.ok) throw new Error(result.errors.join("\n"));
  if (size(graph) > LIMITS.bytes) throw new Error("图谱超过 12 MiB");
}
const validDate = (value) => {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  )
    return false;
  const year = Number(value.slice(0, 4)),
    month = Number(value.slice(5, 7)),
    day = Number(value.slice(8, 10));
  return (
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= new Date(Date.UTC(year === 0 ? 400 : year, month, 0)).getUTCDate() &&
    Number(value.slice(11, 13)) < 24 &&
    Number(value.slice(14, 16)) < 60 &&
    Number(value.slice(17, 19)) < 60 &&
    (value.endsWith("Z") ||
      (Number(value.slice(-5, -3)) < 24 && Number(value.slice(-2)) < 60))
  );
};
function exact(object, allowed) {
  if (
    !object ||
    typeof object !== "object" ||
    Array.isArray(object) ||
    Object.keys(object).some((key) => !allowed.includes(key))
  )
    throw new Error("备份结构不正确或包含未知字段");
}
export function validateBackup(value) {
  exact(value, [
    "format",
    "created_at",
    "graph",
    "demo",
    "snapshots",
    "events",
    "view",
  ]);
  if (value.format !== BACKUP_FORMAT || !validDate(value.created_at))
    throw new Error("不支持的备份版本或时间");
  if (
    typeof value.demo !== "boolean" ||
    !Array.isArray(value.snapshots) ||
    value.snapshots.length > HISTORY_LIMIT ||
    !Array.isArray(value.events) ||
    value.events.length > 200
  )
    throw new Error("备份的历史记录不合法");
  assertGraph(value.graph);
  if (value.demo && !isExampleGraph(value.graph))
    throw new Error("示例标记与图谱内容不匹配");
  const snapshotIds = new Set();
  let historyBytes = 0;
  for (const snapshot of value.snapshots) {
    exact(snapshot, ["id", "label", "created_at", "kind", "graph"]);
    if (
      typeof snapshot.id !== "string" ||
      !snapshot.id ||
      snapshot.id.length > 256 ||
      snapshotIds.has(snapshot.id) ||
      typeof snapshot.label !== "string" ||
      !snapshot.label.trim() ||
      snapshot.label.length > 120 ||
      !validDate(snapshot.created_at) ||
      !["manual", "before"].includes(snapshot.kind)
    )
      throw new Error("快照信息不合法");
    snapshotIds.add(snapshot.id);
    assertGraph(snapshot.graph);
    historyBytes += size(snapshot.graph);
  }
  if (historyBytes > HISTORY_BYTES) throw new Error("快照总量超过 16 MiB");
  for (const event of value.events) {
    exact(event, ["id", "label", "created_at", "nodes", "edges"]);
    if (
      typeof event.id !== "string" ||
      !event.id ||
      event.id.length > 256 ||
      typeof event.label !== "string" ||
      event.label.length > 120 ||
      !validDate(event.created_at) ||
      !Number.isSafeInteger(event.nodes) ||
      event.nodes < 0 ||
      !Number.isSafeInteger(event.edges) ||
      event.edges < 0
    )
      throw new Error("操作时间线不合法");
  }
  exact(value.view, ["clusterBy", "showLabels", "animate", "positions"]);
  if (
    !["type", "component", "source", "none"].includes(value.view.clusterBy) ||
    typeof value.view.showLabels !== "boolean" ||
    typeof value.view.animate !== "boolean" ||
    !Array.isArray(value.view.positions) ||
    value.view.positions.length > value.graph.nodes.length
  )
    throw new Error("备份视图设置不合法");
  const ids = new Set(value.graph.nodes.map((node) => node.id)),
    seen = new Set();
  for (const position of value.view.positions) {
    exact(position, ["id", "x", "y", "pinned"]);
    if (
      !ids.has(position.id) ||
      seen.has(position.id) ||
      ![position.x, position.y].every(
        (n) => Number.isFinite(n) && Math.abs(n) <= 1e7,
      ) ||
      typeof position.pinned !== "boolean"
    )
      throw new Error("备份中的节点位置不合法");
    seen.add(position.id);
  }
  if (size(value) > BACKUP_BYTES) throw new Error("备份超过 48 MiB");
  return true;
}
export function parseBackup(text) {
  if (new TextEncoder().encode(text).length > BACKUP_BYTES)
    throw new Error("备份超过 48 MiB");
  const value = JSON.parse(text);
  validateBackup(value);
  return value;
}
export class Workspace extends EventTarget {
  constructor(
    graph,
    { demo = false, now = () => new Date().toISOString(), id = makeId } = {},
  ) {
    super();
    assertGraph(graph);
    this.graph = clone(graph);
    this.demo = demo && isExampleGraph(graph);
    this.snapshots = [];
    this.events = [];
    this.version = 0;
    this.now = now;
    this.id = id;
    this.view = {
      clusterBy: "type",
      showLabels: true,
      animate: true,
      positions: [],
    };
    this.pruned = 0;
  }
  changed(label) {
    this.version++;
    this.dispatchEvent(
      new CustomEvent("change", { detail: { label, version: this.version } }),
    );
  }
  editableReference(record) {
    return (record.source_id || this.graph.source.id) ===
      editSource(this.graph).id
      ? record.source_ref || ""
      : "";
  }
  capture(label, kind = "before") {
    this.pruned = 0;
    if (this.demo) return;
    this.snapshots.push({
      id: this.id("snapshot"),
      label: label.slice(0, 120) || "快照",
      created_at: this.now(),
      kind,
      graph: clone(this.graph),
    });
    let bytes = this.snapshots.reduce(
      (sum, snapshot) => sum + size(snapshot.graph),
      0,
    );
    this.pruned = 0;
    while (this.snapshots.length > HISTORY_LIMIT || bytes > HISTORY_BYTES) {
      bytes -= size(this.snapshots.shift().graph);
      this.pruned++;
    }
  }
  replace(graph, label = "导入记忆", { demo = false, capture = true } = {}) {
    assertGraph(graph);
    if (capture) this.capture(label);
    this.graph = clone(graph);
    this.demo = demo && isExampleGraph(graph);
    const ids = new Set(graph.nodes.map((node) => node.id));
    this.view.positions = this.view.positions.filter((p) => ids.has(p.id));
    this.events.push({
      id: this.id("event"),
      label: label.slice(0, 120),
      created_at: this.now(),
      nodes: graph.nodes.length,
      edges: graph.edges.length,
    });
    this.events = this.events.slice(-200);
    this.changed(label);
  }
  delta(nodes = [], edges = [], deleted, base = this.graph) {
    const source = editSource(base);
    return {
      protocol: PROTOCOL,
      mode: "delta",
      source,
      sources: graphSources(base).filter((item) => item.id !== source.id),
      nodes,
      edges,
      ...(deleted ? { deleted } : {}),
    };
  }
  apply(delta, label) {
    this.replace(mergeMgp(this.graph, delta, { policy: "incoming" }), label);
  }
  addNode(fields) {
    const base = this.demo ? emptyGraph() : this.graph;
    const id = fields.id || this.id("node");
    if (base.nodes.some((node) => node.id === id))
      throw new Error("节点 ID 已存在");
    if (base.deleted?.nodes?.some((node) => node.id === id))
      throw new Error("此 ID 已删除，请通过导入或快照恢复");
    const source = editSource(base);
    const next = {
      ...fields,
      id,
      updated_at: this.now(),
      revision: 1,
      source_id: source.id,
    };
    this.replace(
      mergeMgp(base, this.delta([next], [], undefined, base), {
        policy: "incoming",
      }),
      "添加记忆：" + fields.label,
    );
    return id;
  }
  editNode(id, patch) {
    if (this.demo)
      throw new Error("请先导入记忆或新建工作区，再编辑自己的数据");
    const current = this.graph.nodes.find((node) => node.id === id);
    if (!current) throw new Error("记忆已不存在");
    if (patch.id && patch.id !== id) throw new Error("不能修改现有稳定 ID");
    const source = editSource(this.graph);
    const next = {
      ...editFields(current, patch, this.graph, source),
      id,
      updated_at: this.now(),
      revision:
        current.source_id === source.id ? (current.revision || 0) + 1 : 1,
    };
    this.apply(this.delta([next]), "编辑记忆：" + next.label);
  }
  deleteNode(id) {
    if (this.demo) throw new Error("示例不能删除，请先新建工作区");
    const node = this.graph.nodes.find((node) => node.id === id);
    if (!node) throw new Error("记忆已不存在");
    this.apply(
      this.delta([], [], { nodes: [{ id, deleted_at: this.now() }] }),
      "删除记忆：" + node.label,
    );
  }
  addEdge(fields) {
    if (this.demo) throw new Error("请先导入记忆或新建工作区，再添加关系");
    if (!fields.evidence?.trim()) throw new Error("请填写关系依据");
    if (
      this.graph.edges.some(
        (edge) =>
          edge.from === fields.from &&
          edge.to === fields.to &&
          edge.type === fields.type,
      )
    )
      throw new Error("相同关系已存在，可在详情中编辑");
    const source = editSource(this.graph);
    const next = {
      ...fields,
      id: fields.id || this.id("edge"),
      source_id: source.id,
      updated_at: this.now(),
      revision: 1,
    };
    if (
      this.graph.edges.some((edge) => edgeKey(edge) === edgeKey(next)) ||
      this.graph.deleted?.edges?.some((edge) => edgeKey(edge) === edgeKey(next))
    )
      throw new Error("关系 ID 已存在或已删除，请使用编辑或恢复");
    this.apply(this.delta([], [next]), "添加关系");
    return next.id;
  }
  editEdge(key, patch) {
    if (this.demo) throw new Error("示例不能编辑，请先新建工作区");
    const current = this.graph.edges.find((edge) => edgeIdentity(edge) === key);
    if (!current) throw new Error("关系已不存在");
    if (patch.id && patch.id !== current.id)
      throw new Error("不能修改现有稳定 ID");
    const candidate = { ...current, ...patch };
    if (!candidate.evidence?.trim()) throw new Error("请填写关系依据");
    if (
      this.graph.edges.some(
        (edge) =>
          edgeIdentity(edge) !== key &&
          edge.from === candidate.from &&
          edge.to === candidate.to &&
          edge.type === candidate.type,
      )
    )
      throw new Error("相同关系已存在");
    const source = editSource(this.graph);
    const next = {
      ...editFields(current, patch, this.graph, source),
      id: current.id || this.id("edge"),
      updated_at: this.now(),
      revision:
        current.source_id === source.id ? (current.revision || 0) + 1 : 1,
    };
    const deleted = current.id
      ? undefined
      : {
          edges: [
            {
              from: current.from,
              to: current.to,
              type: current.type,
              deleted_at: this.now(),
            },
          ],
        };
    this.apply(this.delta([], [next], deleted), "编辑关系");
  }
  deleteEdge(key) {
    if (this.demo) throw new Error("示例不能删除，请先新建工作区");
    const edge = this.graph.edges.find((value) => edgeIdentity(value) === key);
    if (!edge) throw new Error("关系已不存在");
    this.apply(
      this.delta([], [], {
        edges: [
          {
            ...(edge.id
              ? { id: edge.id }
              : { from: edge.from, to: edge.to, type: edge.type }),
            deleted_at: this.now(),
          },
        ],
      }),
      "删除关系",
    );
  }
  snapshot(label) {
    if (this.demo) throw new Error("请先导入自己的记忆，再创建快照");
    this.capture(label, "manual");
    this.changed("创建快照");
  }
  restoreSnapshot(id) {
    const snapshot = this.snapshots.find((value) => value.id === id);
    if (!snapshot) throw new Error("快照已不存在");
    this.replace(snapshot.graph, "恢复快照：" + snapshot.label);
  }
  undo() {
    const index = this.snapshots.findLastIndex(
      (snapshot) => snapshot.kind === "before",
    );
    if (index < 0) throw new Error("没有可撤销的修改");
    const [snapshot] = this.snapshots.splice(index, 1);
    this.replace(snapshot.graph, "撤销上次修改", { capture: false });
  }
  backup() {
    const backup = {
      format: BACKUP_FORMAT,
      created_at: this.now(),
      graph: clone(this.graph),
      demo: this.demo,
      snapshots: clone(this.snapshots),
      events: clone(this.events),
      view: clone(this.view),
    };
    validateBackup(backup);
    return backup;
  }
  restoreBackup(backup, { record = true, preserveCurrent = true } = {}) {
    validateBackup(backup);
    this.pruned = 0;
    const previous =
      this.demo || !preserveCurrent
        ? null
        : {
            id: this.id("snapshot"),
            label: "恢复备份前",
            created_at: this.now(),
            kind: "before",
            graph: clone(this.graph),
          };
    this.graph = clone(backup.graph);
    this.demo = backup.demo;
    this.snapshots = clone(backup.snapshots);
    this.events = clone(backup.events);
    this.view = clone(backup.view);
    if (previous) {
      const used = new Set(this.snapshots.map((snapshot) => snapshot.id));
      while (used.has(previous.id)) previous.id = this.id("snapshot");
      this.snapshots.push(previous);
      let bytes = this.snapshots.reduce((n, s) => n + size(s.graph), 0);
      while (this.snapshots.length > HISTORY_LIMIT || bytes > HISTORY_BYTES) {
        bytes -= size(this.snapshots.shift().graph);
        this.pruned++;
      }
    }
    if (record) {
      this.events.push({
        id: this.id("event"),
        label: "恢复完整备份",
        created_at: this.now(),
        nodes: this.graph.nodes.length,
        edges: this.graph.edges.length,
      });
      this.events = this.events.slice(-200);
    }
    this.changed("恢复完整备份");
  }
}
export const edgeIdentity = edgeKey;
