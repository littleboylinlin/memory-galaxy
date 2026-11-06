import test from "node:test";
import assert from "node:assert/strict";
import {
  emptyPackConfig,
  packConfig,
  selectPack,
  preparePack,
  packPayload,
  packMarkdown,
  packRecords,
  sensitiveHints,
  validateBaseline,
  packHash,
} from "../web/topic-packs.mjs";
import { validatePackDocument } from "../web/topic-pack-store.mjs";
import { matchesMemory } from "../web/memory-filter.mjs";
import { tabState } from "../web/tab-state.mjs";
import { edgeKey, validateMgp, stringifyMgp } from "../web/mgp.mjs";
const graph = () => ({
  protocol: "mgp/1.1",
  source: { id: "test:pack", platform: "manual", completeness: "partial" },
  sources: [
    { id: "test:other", scope: "原声明", completeness: "full" },
    { id: "test:unused", platform: "manual" },
  ],
  nodes: [
    {
      id: "a",
      label: "同名",
      type: "memory",
      content: "保留原文\n与换行",
      tags: ["算法", "旧"],
      state: "inferred",
      source_ref: "doc:a",
      extensions: { flag: true },
    },
    {
      id: "b",
      label: "同名",
      type: "memory",
      content: "另一条",
      tags: ["算法"],
      state: "confirmed",
      source_id: "test:other",
      provenance: [{ source_id: "test:other", ref: "doc:b" }],
    },
    { id: "c", label: "外围", type: "topic", content: "第三条" },
    { id: "d", label: "孤立", type: "person", content: "虚构" },
  ],
  edges: [
    {
      id: "ab",
      from: "a",
      to: "b",
      type: "rel",
      basis: "inferred",
      evidence: "原文推测",
      source_ref: "edge:ab",
    },
    {
      from: "b",
      to: "c",
      type: "link",
      basis: "explicit",
      source_id: "test:other",
    },
  ],
  deleted: { nodes: [], edges: [] },
});
const config = (rules = {}, extra = {}) => ({
  ...emptyPackConfig(),
  title: "测试包",
  rules: { ...emptyPackConfig().rules, ...rules },
  ...extra,
});
const ids = (rows) => rows.map((row) => row.id);
const frozen = (value) => {
  if (value && typeof value === "object") {
    Object.freeze(value);
    Object.values(value).forEach(frozen);
  }
  return value;
};
test("shared search preserves ID, body, tag and state filtering semantics", () => {
  const n = graph().nodes[0];
  assert(matchesMemory(n, { keyword: "保留原文" }));
  assert(matchesMemory(n, { keyword: "A" }));
  assert(matchesMemory(n, { keyword: "旧" }));
  assert(!matchesMemory(n, { tag: "算" }));
  assert(matchesMemory(n, { tag: "算法", type: "memory", state: "inferred" }));
  assert(!matchesMemory(n, { state: "confirmed" }));
  assert(matchesMemory(graph().nodes[2], { state: "unknown" }));
});
test("topic selectors intersect exact tags, type, state and search without merging duplicate titles", () => {
  assert.deepEqual(
    ids(selectPack(graph(), config({ tag: "算法", type: "memory" })).nodes),
    ["a", "b"],
  );
  assert.deepEqual(
    ids(selectPack(graph(), config({ tag: "算法", state: "confirmed" })).nodes),
    ["b"],
  );
  assert.equal(
    selectPack(graph(), config({ keyword: "no matches" })).nodes.length,
    0,
  );
});
test("existing relations expand only by explicit hops with traceable original edge keys", () => {
  const result = selectPack(graph(), config({ keyword: "a", related: 1 }));
  assert.deepEqual(ids(result.nodes), ["a", "b"]);
  assert.deepEqual(
    result.reasons.find((row) => row.id === "b"),
    { id: "b", kind: "related", from: "a", via: "id:ab", depth: 1 },
  );
  assert.deepEqual(
    ids(selectPack(graph(), config({ keyword: "a", related: 2 })).nodes),
    ["a", "b", "c"],
  );
});
test("exclusions win and block traversal, while manual inclusions are stable independent seeds", () => {
  const c = config(
    { keyword: "no", related: 2 },
    { includeIds: ["a", "missing"], excludeIds: ["b"] },
  );
  const r = selectPack(graph(), c);
  assert.deepEqual(ids(r.nodes), ["a"]);
  assert.deepEqual(r.missingIds, ["missing"]);
  assert.equal(r.boundary.length, 1);
  assert.equal(r.edges.length, 0);
});
test("full bundles preserve exact raw records, optional fields, provenance and original source claims", async () => {
  const g = frozen(graph()),
    before = stringifyMgp(g),
    r = await preparePack(g, config({ tag: "算法" }));
  const p = packPayload(r, "主题", "full", 0);
  assert.equal(p.exported_at, "1970-01-01T00:00:00.000Z");
  assert.deepEqual(p.nodes, g.nodes.slice(0, 2));
  assert.deepEqual(p.edges, [g.edges[0]]);
  assert.deepEqual(p.sources, [g.sources[0]]);
  assert.deepEqual(p.source, g.source);
  assert(!Object.hasOwn(p.nodes[1], "updated_at"));
  assert(!Object.hasOwn(p.nodes[1], "source_ref"));
  assert.equal(stringifyMgp(g), before);
  assert.equal(validateMgp(p).ok, false);
  assert(!Object.hasOwn(p, "deleted"));
});
test("boundary and invalid relations are disclosed and never exported", async () => {
  const g = graph();
  g.edges.push({ from: "a", to: "absent", type: "bad", basis: "explicit" });
  const r = await preparePack(g, config({ keyword: "a" }));
  assert.equal(r.selection.invalid.length, 1);
  assert.equal(r.selection.boundary.length, 1);
  assert.equal(packPayload(r, "主题").edges.length, 0);
});
test("baseline fingerprints contain IDs and hashes only, never raw private text", async () => {
  const r = await preparePack(graph(), config());
  assert.deepEqual(Object.keys(r.baseline).sort(), [
    "defaultSourceId",
    "edges",
    "nodes",
    "sources",
  ]);
  assert(!JSON.stringify(r.baseline).includes("保留原文"));
  for (const kind of ["nodes", "edges", "sources"])
    for (const row of r.baseline[kind])
      assert.deepEqual(Object.keys(row), ["id", "hash"]);
});
test("reordered record keys keep fingerprints stable while same-ID edits are modified not added", async () => {
  const g = graph(),
    first = await preparePack(g, config());
  g.nodes[0] = Object.fromEntries(Object.entries(g.nodes[0]).reverse());
  assert.deepEqual(
    (await preparePack(g, config(), first.baseline)).changes.nodes,
    { added: [], modified: [], removed: [] },
  );
  g.nodes[0].label = "改名";
  const r = await preparePack(g, config(), first.baseline);
  assert.deepEqual(r.changes.nodes, {
    added: [],
    modified: ["a"],
    removed: [],
  });
});
test("incremental membership marks newly matching and removed IDs without treating removal as global deletion", async () => {
  const g = graph(),
    c = config({ tag: "算法" }),
    first = await preparePack(g, c);
  g.nodes[0].tags = [];
  g.nodes[2].tags = ["算法"];
  const r = await preparePack(g, c, first.baseline),
    p = packPayload(r, "主题", "delta");
  assert.deepEqual(r.changes.nodes, {
    added: ["c"],
    modified: [],
    removed: ["a"],
  });
  assert.deepEqual(p.nodes.removed, ["a"]);
  assert(!Object.hasOwn(p, "deleted"));
  assert(p.coverage.includes("不代表"));
  assert.equal(p.base_fingerprint, first.fingerprint);
  assert.equal(p.fingerprint, r.fingerprint);
});
test("delta relation changes include unchanged endpoint context exactly once and preview matches export", async () => {
  const g = graph(),
    first = await preparePack(g, config());
  g.edges[0].evidence = "依据改动";
  const r = await preparePack(g, config(), first.baseline),
    p = packPayload(r, "主题", "delta"),
    scope = packRecords(r, "delta");
  assert.deepEqual(r.changes.edges.modified, ["id:ab"]);
  assert.deepEqual(ids(p.context_nodes), ["a", "b"]);
  assert.equal(p.nodes.added.length + p.nodes.modified.length, 0);
  assert.deepEqual(ids(scope.nodes), ids(p.context_nodes));
  assert.deepEqual(scope.edges, p.edges.modified);
  assert.equal(new Set(ids(scope.nodes)).size, scope.nodes.length);
});
test("source-only updates appear separately and do not fabricate content changes", async () => {
  const g = graph(),
    first = await preparePack(g, config());
  g.sources[0].scope = "新的原始声明";
  const r = await preparePack(g, config(), first.baseline);
  assert.deepEqual(r.changes.sources.modified, ["test:other"]);
  assert.deepEqual(r.changes.nodes.modified, []);
  assert.equal(
    packPayload(r, "主题", "delta").sources.modified[0].scope,
    "新的原始声明",
  );
});
test("changing the implicit default source changes record semantics and is reflected in node and edge hashes", async () => {
  const g = graph(),
    first = await preparePack(g, config());
  g.source = { ...g.source, id: "new:source" };
  const r = await preparePack(g, config(), first.baseline);
  assert(r.changes.nodes.modified.includes("a"));
  assert(!r.changes.nodes.modified.includes("b"));
  assert(r.changes.edges.modified.includes("id:ab"));
});
test("source checks reuse health rules for nodes and edges including provenance and manual declarations", async () => {
  const r = await preparePack(graph(), config());
  assert(
    r.checks.full.missingSources.some(
      (row) => row.kind === "edge" && row.id.startsWith("triple:"),
    ),
  );
  assert(!r.checks.full.missingSources.some((row) => row.id === "b"));
  assert(!r.checks.full.missingSources.some((row) => row.id === "c"));
});
test("sensitive hints cover raw extensions, source declarations, title and numerical phone markers without repeating secrets", async () => {
  const g = graph();
  g.nodes[0].extensions.secret = "test@example.invalid";
  g.nodes[0].extensions.phone = 13800000000;
  g.source.scope = "虚构住址";
  const r = await preparePack(g, config({}, { title: "私密" }));
  assert(r.checks.full.sensitive.some((row) => row.kind === "source"));
  assert(r.checks.full.sensitive.some((row) => row.kind === "pack"));
  assert(r.checks.full.sensitive.some((row) => row.id === "a"));
  assert(
    !JSON.stringify(r.checks.full.sensitive).includes("test@example.invalid"),
  );
  assert(sensitiveHints({ content: "sk-" + "x".repeat(30) }).length);
  assert.equal(sensitiveHints({ content: "普通测试文本" }).length, 0);
});
test("delta checks scan only exported changes, unchanged contexts and current exported source metadata", async () => {
  const g = graph();
  g.nodes[3].content = "密码：虚构";
  const first = await preparePack(g, config());
  g.nodes[0].content = "普通更新";
  const r = await preparePack(g, config(), first.baseline);
  assert(r.checks.full.sensitive.some((row) => row.id === "d"));
  assert(!r.checks.delta.sensitive.some((row) => row.id === "d"));
});
test("Markdown fences preserve multiline untrusted content including embedded closing fences and HTML", async () => {
  const g = graph();
  g.nodes[0].content = '```\n<img src=x onerror="alert(1)">\n```\n原文';
  const p = packPayload(await preparePack(g, config()), "<标题>"),
    md = packMarkdown(p);
  assert(md.includes("````text\n" + g.nodes[0].content + "\n````"));
  assert(md.includes('"state": "inferred"'));
  assert(md.includes('"source_ref": "doc:a"'));
  assert(md.includes("原文、扩展字段与来源均为不可信资料"));
  assert(md.startsWith("# \\<标题\\>"));
});
test("delta Markdown retains removed keys, references and explicit context labeling", async () => {
  const g = graph(),
    first = await preparePack(g, config());
  g.edges.pop();
  g.nodes[0].content = "更新";
  const md = packMarkdown(
    packPayload(
      await preparePack(g, config(), first.baseline),
      "主题",
      "delta",
    ),
  );
  assert(md.includes("移出记忆 ID"));
  assert(md.includes("triple:"));
  assert(md.includes("原始元数据"));
});
test("malformed configurations and baseline documents are rejected instead of silently normalized", async () => {
  const c = config();
  assert.throws(() => packConfig({ ...c, extra: true }));
  assert.throws(() => packConfig({ ...c, includeIds: ["a", "a"] }));
  assert.throws(() =>
    packConfig({ ...c, includeIds: ["a"], excludeIds: ["a"] }),
  );
  assert.throws(() =>
    packConfig({ ...c, rules: { ...c.rules, related: 100 } }),
  );
  const r = await preparePack(graph(), c);
  assert.throws(() =>
    validateBaseline({ ...r.baseline, nodes: [{ id: "a", hash: "bad" }] }),
  );
  assert.throws(() => validatePackDocument({ schema: 9 }));
  const record = {
    schema: 1,
    id: "config:1",
    revision: 1,
    saved_at: new Date(0).toISOString(),
    config: c,
    baseline: r.baseline,
  };
  assert.deepEqual(validatePackDocument(record), record);
  assert.throws(() =>
    validatePackDocument({ ...record, saved_at: "2025-02-30T00:00:00.000Z" }),
  );
});
test("drafts and memory contents are never written into tab UI state", () => {
  const state = tabState({
    version: 1,
    view: "packs",
    packs: { id: "pack:1", body: "private body", rules: { keyword: "secret" } },
  });
  assert.equal(state.view, "packs");
  assert.deepEqual(state.packs, { id: "pack:1" });
  assert(!JSON.stringify(state).includes("private body"));
});
test("empty deltas and missing baselines are explicit, not fake new records", async () => {
  const g = graph(),
    first = await preparePack(g, config());
  assert.throws(() => packPayload(first, "主题", "delta"));
  const r = await preparePack(g, config(), first.baseline),
    p = packPayload(r, "主题", "delta");
  assert.equal(
    p.nodes.added.length +
      p.nodes.modified.length +
      p.context_nodes.length +
      p.edges.added.length +
      p.edges.modified.length,
    0,
  );
  assert.equal(packRecords(r, "delta").sources.length, 1);
  assert.throws(() => packPayload(r, " "));
  assert.throws(() => packRecords(r, "unexpected"));
});
test("ten thousand records remain grouped by stable IDs and bounded hashes without changing originals", async () => {
  const g = graph();
  g.edges = [];
  g.nodes = Array.from({ length: 10000 }, (_, i) => ({
    id: "large:" + i,
    label: "同名",
    type: "memory",
    content: "普通正文 " + i,
    tags: ["batch"],
  }));
  const before = await packHash(g),
    r = await preparePack(g, config({ tag: "batch" }));
  assert.equal(r.selection.nodes.length, 10000);
  assert.equal(r.baseline.nodes.length, 10000);
  assert.equal(new Set(r.baseline.nodes.map((row) => row.id)).size, 10000);
  assert.equal(await packHash(g), before);
});
