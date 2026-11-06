import test from "node:test";
import assert from "node:assert/strict";
import {
  Workspace,
  validateBackup,
  parseBackup,
  HISTORY_LIMIT,
  makeId,
} from "../web/workspace.mjs";
import {
  emptyGraph,
  example,
  PROTOCOL,
  edgeKey,
  validateMgp,
} from "../web/mgp.mjs";
const node = (id, label = id) => ({
  id,
  label,
  type: "memory",
  source_id: "original",
  source_ref: "doc:1",
  provenance: [{ source_id: "original", ref: "doc:1" }],
});
const graph = () => ({
  protocol: PROTOCOL,
  source: { id: "original", completeness: "partial", scope: "测试记忆" },
  nodes: [node("a"), node("b"), node("c")],
  edges: [
    {
      from: "a",
      to: "b",
      type: "uses",
      basis: "explicit",
      evidence: "原始记载",
    },
  ],
});
function workspace(value = graph(), options = {}) {
  let sequence = 0;
  return new Workspace(value, {
    now: () => `2026-10-01T00:00:${String(sequence % 60).padStart(2, "0")}Z`,
    id: (kind) => kind + ":" + ++sequence,
    ...options,
  });
}
test("editing preserves stable identity, provenance and prior snapshots without mutating inputs", () => {
  const original = graph(),
    w = workspace(original);
  w.editNode("a", { label: "更新的记忆", state: "confirmed" });
  assert.equal(w.graph.nodes[0].id, "a");
  assert.equal(w.graph.nodes[0].source_id, "local:edits");
  assert.equal(w.graph.nodes[0].revision, 1);
  assert.ok(
    w.graph.nodes[0].provenance.some((item) => item.source_id === "original"),
  );
  assert.equal(original.nodes[0].label, "a");
  assert.equal(w.snapshots[0].graph.nodes[0].label, "a");
  w.editNode("a", { state: "deprecated" });
  assert.equal(w.graph.nodes[0].revision, 2);
  assert.throws(() => w.editNode("a", { id: "changed" }), /稳定 ID/);
  assert.equal(w.graph.nodes[0].id, "a");
});
test("rename snapshots identify the old content while activity identifies the applied edit", () => {
  const w = workspace();
  w.editNode("a", { label: "新标题" });
  assert.equal(w.snapshots.at(-1).label, "编辑前：a");
  assert.equal(w.snapshots.at(-1).graph.nodes[0].label, "a");
  assert.equal(w.events.at(-1).label, "编辑记忆：新标题");
  w.editNode("a", { label: "第三版" });
  assert.equal(w.snapshots.at(-1).label, "编辑前：新标题");
  w.restoreSnapshot(w.snapshots[0].id);
  assert.equal(w.graph.nodes[0].label, "a");
  const backup = w.backup();
  assert.deepEqual(parseBackup(JSON.stringify(backup)), backup);
});
test("automatic snapshots describe the preceding operation and respect title bounds", () => {
  const w = workspace();
  w.editEdge(edgeKey(w.graph.edges[0]), { type: "supports", evidence: "核对" });
  assert.equal(w.snapshots.at(-1).label, "编辑关系前：uses");
  assert.equal(w.snapshots.at(-1).graph.edges[0].type, "uses");
  w.editNode("a", { label: "长".repeat(200) });
  w.editNode("a", { label: "短标题" });
  assert.equal(
    w.snapshots.at(-1).label,
    ("编辑前：" + "长".repeat(200)).slice(0, 120),
  );
  w.deleteNode("b");
  assert.equal(w.snapshots.at(-1).label, "操作前：删除记忆：b");
});
test("invalid edits are atomic and cannot add dangling relationships", () => {
  const w = workspace(),
    before = w.backup();
  assert.throws(() => w.editNode("a", { type: "invalid" }));
  assert.throws(() =>
    w.addEdge({
      from: "a",
      to: "missing",
      type: "x",
      basis: "explicit",
      evidence: "记载",
    }),
  );
  assert.throws(
    () => w.addEdge({ from: "a", to: "c", type: "x", basis: "explicit" }),
    /依据/,
  );
  assert.deepEqual(w.graph, before.graph);
  assert.equal(w.snapshots.length, 0);
});
test("first manual memory excludes fictional example nodes and their source", () => {
  const w = workspace(example, { demo: true });
  const id = w.addNode({ label: "我的记忆", type: "memory" });
  assert.equal(w.demo, false);
  assert.equal(w.graph.nodes.length, 1);
  assert.equal(w.graph.nodes[0].id, id);
  assert.equal(w.graph.edges.length, 0);
  assert.deepEqual(
    w.graph.sources.map((source) => source.id),
    ["local:edits"],
  );
  assert.equal(w.snapshots.length, 0);
});
test("deletions create tombstones, cascade attached edges, and undo restores the exact graph", () => {
  const w = workspace(),
    before = structuredClone(w.graph);
  w.deleteNode("a");
  assert.equal(w.graph.nodes.length, 2);
  assert.equal(w.graph.edges.length, 0);
  assert.equal(w.graph.deleted.nodes[0].id, "a");
  assert.equal(w.graph.deleted.edges.length, 1);
  assert.throws(
    () => w.addNode({ id: "a", label: "replay", type: "memory" }),
    /已删除/,
  );
  w.undo();
  assert.deepEqual(w.graph, before);
  assert.equal(w.snapshots.length, 0);
});
test("edge edits give legacy triples a stable ID and keep old identity tombstones", () => {
  const w = workspace(),
    old = edgeKey(w.graph.edges[0]);
  w.editEdge(old, { to: "c", type: "supports", evidence: "用户核对文档" });
  assert.equal(w.graph.edges.length, 1);
  const edge = w.graph.edges[0];
  assert.ok(edge.id);
  assert.equal(edge.to, "c");
  assert.equal(w.graph.deleted.edges[0].from, "a");
  assert.equal(w.graph.deleted.edges[0].to, "b");
  assert.equal(validateMgp(w.graph).ok, true);
  const id = edge.id;
  w.editEdge(edgeKey(edge), { basis: "inferred", evidence: "明确标注推测" });
  assert.equal(w.graph.edges[0].id, id);
  assert.throws(
    () => w.editEdge(edgeKey(w.graph.edges[0]), { id: "replacement" }),
    /稳定 ID/,
  );
});
test("duplicate relationship triples and reused IDs fail rather than replace another edge", () => {
  const w = workspace();
  const id = w.addEdge({
    from: "a",
    to: "c",
    type: "supports",
    basis: "explicit",
    evidence: "文档证据",
  });
  assert.throws(
    () =>
      w.addEdge({
        from: "a",
        to: "c",
        type: "supports",
        basis: "explicit",
        evidence: "重复",
      }),
    /已存在/,
  );
  assert.throws(
    () =>
      w.addEdge({
        id,
        from: "b",
        to: "c",
        type: "other",
        basis: "explicit",
        evidence: "不同关系",
      }),
    /ID/,
  );
  assert.throws(
    () => w.editEdge("id:" + id, { to: "b", type: "uses" }),
    /已存在/,
  );
  w.deleteEdge("id:" + id);
  assert.throws(
    () =>
      w.addEdge({
        id,
        from: "b",
        to: "c",
        type: "other",
        basis: "explicit",
        evidence: "已删除的身份",
      }),
    /已删除/,
  );
});
test("named snapshots and restores are bounded and keep the version being replaced", () => {
  const w = workspace();
  w.snapshot("基线");
  w.editNode("a", { label: "修改" });
  const snapshot = w.snapshots[0];
  w.restoreSnapshot(snapshot.id);
  assert.equal(w.graph.nodes[0].label, "a");
  assert.equal(w.snapshots.at(-1).graph.nodes[0].label, "修改");
  for (let i = 0; i < 20; i++) w.snapshot("快照 " + i);
  assert.equal(w.snapshots.length, HISTORY_LIMIT);
  assert.ok(w.pruned > 0);
  assert.equal(w.snapshots.at(-1).label, "快照 19");
});
test("partial deletion objects do not break adding a memory", () => {
  const w = workspace({ ...emptyGraph(), deleted: { edges: [] } });
  w.addNode({ label: "新增", type: "memory" });
  assert.equal(w.graph.nodes.length, 1);
});
test("full backups round-trip graph, history, settings and pinned positions", () => {
  const w = workspace();
  w.snapshot("基线");
  w.editNode("a", { content: "更新内容" });
  w.view = {
    clusterBy: "source",
    showLabels: false,
    animate: false,
    positions: [{ id: "a", x: 12.5, y: -30, pinned: true }],
  };
  const backup = parseBackup(JSON.stringify(w.backup()));
  const target = workspace(emptyGraph());
  target.restoreBackup(backup);
  assert.deepEqual(target.graph, w.graph);
  assert.deepEqual(target.view, w.view);
  assert.equal(target.snapshots.at(-1).label, "恢复备份前");
  target.graph.nodes[0].content = "changed";
  assert.equal(backup.graph.nodes[0].content, "更新内容");
});
test("backup validation rejects unknown fields, fake demo markers, invalid dates and view data", () => {
  const original = workspace().backup();
  for (const mutate of [
    (b) => (b.format = "unknown/2"),
    (b) => (b.created_at = "2026-02-30T00:00:00Z"),
    (b) => (b.demo = true),
    (b) => (b.view.clusterBy = "fabricated"),
    (b) => (b.view.positions = [{ id: "missing", x: 0, y: 0, pinned: true }]),
    (b) => (b.view.positions = [{ id: "a", x: Infinity, y: 0, pinned: true }]),
    (b) => (b.chat = "unused"),
    (b) =>
      (b.events = [
        { id: "e", label: "x", created_at: "yesterday", nodes: 1, edges: 1 },
      ]),
    (b) => (b.graph.nodes[0].content = { command: "run" }),
  ]) {
    const backup = structuredClone(original);
    mutate(backup);
    assert.throws(() => validateBackup(backup));
  }
  assert.throws(() => parseBackup('{"__proto__":{"polluted":true}}'));
  assert.equal({}.polluted, undefined);
});
test("invalid backup restore leaves the entire current workspace untouched", () => {
  const w = workspace();
  w.snapshot("保留");
  const before = w.backup(),
    bad = structuredClone(before);
  bad.graph.edges[0].to = "absent";
  assert.throws(() => w.restoreBackup(bad));
  assert.deepEqual(w.graph, before.graph);
  assert.deepEqual(w.snapshots, before.snapshots);
  assert.deepEqual(w.events, before.events);
});
test("generated IDs are distinct and use cryptographic randomness", () => {
  const ids = new Set(Array.from({ length: 100 }, () => makeId("node")));
  assert.equal(ids.size, 100);
  assert.match([...ids][0], /^local:node:[a-f0-9]{32}$/);
});

test("manual edits do not replace an imported source with a colliding local ID", () => {
  const original = graph();
  original.source = {
    id: "local:edits",
    platform: "external",
    scope: "外部导出方",
    completeness: "full",
  };
  original.nodes = original.nodes.map((n) => ({
    ...n,
    source_id: "local:edits",
    provenance: [{ source_id: "local:edits" }],
  }));
  const w = workspace(original);
  w.editNode("a", { label: "手动修改" });
  assert.equal(
    w.graph.sources.find((s) => s.id === "local:edits").scope,
    "外部导出方",
  );
  assert.equal(w.graph.nodes[0].source_id, "local:edits:1");
  w.editNode("b", { label: "再次修改" });
  assert.equal(w.graph.nodes[1].source_id, "local:edits:1");
});
test("editing a legacy relationship preserves its original source and reference", () => {
  const original = { ...graph(), protocol: "mgp/1.0" };
  original.edges[0].source_ref = "old:relation";
  const w = workspace(original);
  w.editEdge(edgeKey(w.graph.edges[0]), { type: "revised" });
  assert.ok(
    w.graph.edges[0].provenance.some(
      (p) => p.source_id === "original" && p.ref === "old:relation",
    ),
  );
  assert.equal(validateMgp(w.graph).ok, true);
});

test("snapshot byte retention is enforced before the count limit", () => {
  const value = graph();
  value.nodes = Array.from({ length: 18 }, (_, index) => ({
    id: "large:" + index,
    label: "Long memory",
    type: "memory",
    content: "x".repeat(95000),
  }));
  value.edges = [];
  const w = workspace(value);
  for (let i = 0; i < 12; i++) w.snapshot("版本 " + i);
  assert.ok(w.snapshots.length < 12);
  assert.ok(w.pruned > 0);
  assert.equal(validateBackup(w.backup()), true);
});
test("loading saved workspaces preserves their operation timeline without adding restore events", () => {
  const w = workspace();
  w.editNode("a", { label: "一次编辑" });
  const backup = w.backup(),
    loaded = workspace(emptyGraph());
  loaded.restoreBackup(backup, { record: false, preserveCurrent: false });
  assert.deepEqual(loaded.events, backup.events);
  assert.deepEqual(loaded.snapshots, backup.snapshots);
  assert.equal(validateBackup(loaded.backup()), true);
});

test("manual edits do not relabel original node and edge references as local references", () => {
  const value = graph();
  delete value.nodes[0].provenance;
  value.edges[0].source_ref = "original:edge";
  const w = workspace(value);
  w.editNode("a", { content: "手动修改" });
  const edited = w.graph.nodes[0];
  assert.equal(edited.source_ref || "", "");
  assert.ok(
    edited.provenance.some(
      (p) => p.source_id === "original" && p.ref === "doc:1",
    ),
  );
  assert.ok(
    !edited.provenance.some(
      (p) => p.source_id === "local:edits" && p.ref === "doc:1",
    ),
  );
  w.editEdge(edgeKey(w.graph.edges[0]), { evidence: "重新核实" });
  assert.equal(w.graph.edges[0].source_ref || "", "");
  assert.ok(
    w.graph.edges[0].provenance.some(
      (p) => p.source_id === "original" && p.ref === "original:edge",
    ),
  );
});
