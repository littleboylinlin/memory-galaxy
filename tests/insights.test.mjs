import test from "node:test";
import assert from "node:assert/strict";
import {
  reviewPage,
  healthCheck,
  memoryFingerprint,
} from "../web/memory-insights.mjs";
import {
  DAY,
  reviewAction,
  validateReviewRecord,
} from "../web/review-state.mjs";
import { emptyGraph, stringifyMgp } from "../web/mgp.mjs";
import { Workspace, validateBackup } from "../web/workspace.mjs";
import { tabState, insightTabState } from "../web/tab-state.mjs";

const now = Date.parse("2026-11-06T15:00:00Z");
const atAge = (days) => new Date(now - days * DAY).toISOString();
const node = (id, extra = {}) => ({
  id,
  label: "记忆 " + id,
  type: "memory",
  content: "正文 " + id,
  updated_at: atAge(100),
  source_ref: "document:" + id,
  ...extra,
});
const graph = (nodes = [node("a")], edges = []) => ({
  protocol: "mgp/1.1",
  source: { id: "test:origin", completeness: "partial" },
  nodes,
  edges,
});
const fp = "a".repeat(64);
const freeze = (value) => {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};

test("review only recommends old provided timestamps without inventing event dates", async () => {
  const data = graph([
    node("old"),
    node("recent", { updated_at: atAge(29) }),
    node("boundary", { updated_at: atAge(30) }),
    node("undated", { updated_at: undefined }),
    node("future", { updated_at: atAge(-1) }),
    node("obsolete", { state: "deprecated" }),
  ]);
  const result = await reviewPage(data, { now });
  assert.deepEqual(
    result.items.map((item) => item.id),
    ["old", "boundary"],
  );
  assert.equal(result.missingTime, 1);
  assert.equal(result.futureTime, 1);
  assert.match(
    result.items[0].reasons.join(" "),
    /更新时间.*不代表事情发生时间/,
  );
  assert.match(result.items[0].reasons.join(" "), /不代表你从未回顾过/);
});
test("invalid calendar values are not promoted into old memories", async () => {
  const data = graph([
    node("a", { updated_at: "2026-02-30T12:00:00Z" }),
    node("b", { updated_at: "yesterday" }),
  ]);
  const result = await reviewPage(data, { now });
  assert.equal(result.total, 0);
  assert.equal(result.missingTime, 2);
  assert.equal(healthCheck(data, { now }).stale.length, 0);
});
test("date threshold and local review cooldown have exact, separately explained boundaries", async () => {
  const data = graph(),
    version = await memoryFingerprint(data, "a");
  const recent = reviewAction(
    undefined,
    { id: "a", kind: "reviewed", version },
    now - 29 * DAY,
  );
  assert.equal((await reviewPage(data, { now, records: [recent] })).total, 0);
  const due = reviewAction(
    undefined,
    { id: "a", kind: "reviewed", version },
    now - 30 * DAY,
  );
  const result = await reviewPage(data, { now, records: [due] });
  assert.equal(result.total, 1);
  assert.match(
    result.items[0].reasons.join(" "),
    new RegExp(due.reviewed.at.replaceAll(".", "\\.")),
  );
  assert.equal((await reviewPage(data, { now, minAgeDays: 180 })).total, 0);
});
test("skip expires after seven days and explicit reset preserves the favorite", async () => {
  const data = graph(),
    version = await memoryFingerprint(data, "a");
  let state = reviewAction(
    undefined,
    { id: "a", kind: "favorite", value: true },
    now,
  );
  state = reviewAction(state, { id: "a", kind: "skip", version }, now);
  assert.equal((await reviewPage(data, { now, records: [state] })).total, 0);
  assert.equal(
    (await reviewPage(data, { now: now + 7 * DAY, records: [state] })).total,
    1,
  );
  const reset = reviewAction(state, { id: "a", kind: "reset" }, now);
  assert.equal(reset.favorite, true);
  assert.equal(reset.skipped, undefined);
  assert.ok(state.skipped); // No input mutation.
});
test("a changed memory version re-enters review while its stable-ID favorite remains", async () => {
  const data = graph(),
    version = await memoryFingerprint(data, "a");
  const reviewed = reviewAction(
    reviewAction(undefined, { id: "a", kind: "favorite", value: true }),
    { id: "a", kind: "reviewed", version },
    now,
  );
  const changed = structuredClone(data);
  changed.nodes[0].content = "新版正文";
  const result = await reviewPage(changed, { now, records: [reviewed] });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].favorite, true);
  assert.match(result.items[0].reasons.join(" "), /上次回顾版本不同/);
});
test("fingerprints include real relationships, their evidence, and declared provenance", async () => {
  const edge = {
    id: "edge:stable",
    from: "a",
    to: "b",
    type: "uses",
    basis: "inferred",
    evidence: "原文的推测依据",
  };
  const data = graph([node("a"), node("b"), node("unrelated")], [edge]);
  const version = await memoryFingerprint(data, "a");
  for (const update of [
    (g) => (g.edges[0].evidence = "不同依据"),
    (g) => (g.edges[0].basis = "explicit"),
    (g) => (g.nodes[0].source_ref = "other"),
    (g) => (g.source.scope = "不同来源声明"),
  ]) {
    const next = structuredClone(data);
    update(next);
    assert.notEqual(await memoryFingerprint(next, "a"), version);
  }
  const other = structuredClone(data);
  other.nodes[2].content = "其他节点的变化";
  assert.equal(await memoryFingerprint(other, "a"), version);
  assert.equal(
    await memoryFingerprint({ ...data, nodes: [...data.nodes].reverse() }, "a"),
    version,
  );
  const ordered = JSON.parse(JSON.stringify(data));
  ordered.nodes[0] = Object.fromEntries(
    Object.entries(ordered.nodes[0]).reverse(),
  );
  assert.equal(await memoryFingerprint(ordered, "a"), version);
});
test("a new or removed edge invalidates an old skip rather than inferring any edge", async () => {
  const data = graph([node("a"), node("b")]),
    version = await memoryFingerprint(data, "a");
  const state = reviewAction(
    undefined,
    { id: "a", kind: "skip", version },
    now,
  );
  const changed = structuredClone(data);
  changed.edges.push({
    from: "a",
    to: "b",
    type: "documented",
    basis: "explicit",
  });
  const result = await reviewPage(changed, {
    now,
    records: [state],
    filterIds: ["a"],
  });
  assert.equal(result.total, 1);
  assert.match(result.items[0].reasons.join(" "), /1 条关联记录/);
  assert.equal(changed.edges.length, 1);
});
test("all, favorites and undated views explain active choice instead of inventing age", async () => {
  const data = graph([
    node("a", { updated_at: undefined }),
    node("b", { updated_at: atAge(-2) }),
    node("c", { state: "deprecated" }),
  ]);
  const state = reviewAction(undefined, {
    id: "a",
    kind: "favorite",
    value: true,
  });
  const favorite = await reviewPage(data, {
    now,
    records: [state],
    mode: "favorites",
  });
  assert.equal(favorite.total, 1);
  assert.match(favorite.items[0].reasons.join(" "), /无法判断新旧/);
  assert.equal((await reviewPage(data, { now, mode: "undated" })).total, 1);
  const all = await reviewPage(data, { now, mode: "all" });
  assert.equal(all.total, 3);
  assert.ok(
    all.items.some((item) =>
      item.reasons.join(" ").includes("晚于本机当前时间"),
    ),
  );
});
test("duplicate titles remain separate IDs and existing filters and paging apply to review", async () => {
  const data = graph(
    Array.from({ length: 15 }, (_, i) =>
      node("id:" + String(i).padStart(2, "0"), { label: "同名记忆" }),
    ),
  );
  const result = await reviewPage(data, { now, page: 1 });
  assert.equal(result.pages, 3);
  assert.equal(result.items.length, 6);
  assert.equal(result.items[0].id, "id:06");
  assert.deepEqual(
    (await reviewPage(data, { now, filterIds: ["id:07"] })).items.map(
      (item) => item.id,
    ),
    ["id:07"],
  );
  assert.equal((await reviewPage(data, { now, filterIds: [] })).total, 0);
  assert.equal((await reviewPage(data, { now, page: 100 })).page, 2);
});
test("future local markers never silently defer an old record", async () => {
  const data = graph(),
    version = await memoryFingerprint(data, "a");
  for (const kind of ["reviewed", "skip"]) {
    const state = reviewAction(
      undefined,
      { id: "a", kind, version },
      now + DAY,
    );
    assert.equal((await reviewPage(data, { now, records: [state] })).total, 1);
  }
});
test("viewing and checking never mutates records, relationships, snapshots or exports", async () => {
  const data = freeze(graph()),
    before = stringifyMgp(data),
    workspace = new Workspace(data),
    backup = workspace.backup();
  const result = await reviewPage(data, { now });
  healthCheck(data, { now });
  reviewAction(
    undefined,
    { id: "a", kind: "reviewed", version: result.items[0].version },
    now,
  );
  assert.equal(stringifyMgp(data), before);
  assert.equal(workspace.version, 0);
  assert.deepEqual(workspace.graph, backup.graph);
  assert.deepEqual(workspace.events, backup.events);
  assert.equal(Object.hasOwn(backup, "reviews"), false);
  validateBackup(backup);
});
test("personal actions merge unrelated status fields, preserve actual action time, and reject malformed data", () => {
  const old = freeze(
    reviewAction(undefined, { id: "a", kind: "reviewed", version: fp }, now),
  );
  const favorite = reviewAction(
    old,
    { id: "a", kind: "favorite", value: true },
    now + DAY,
  );
  assert.deepEqual(favorite.reviewed, old.reviewed);
  assert.equal(favorite.reviewed.at, new Date(now).toISOString());
  const skipped = reviewAction(
    favorite,
    { id: "a", kind: "skip", version: fp },
    now + DAY,
  );
  assert.equal(skipped.reviewed, undefined);
  assert.equal(skipped.favorite, true);
  assert.throws(
    () => reviewAction(old, { id: "other", kind: "reset" }),
    /ID 不一致/,
  );
  assert.throws(
    () => reviewAction(old, { id: "a", kind: "reviewed", version: "bad" }),
    /版本不可用/,
  );
  assert.throws(() => reviewAction(old, { id: "a", kind: "merge" }), /不支持/);
  for (const change of [
    (v) => (v.schema = 2),
    (v) => (v.favorite = 1),
    (v) => (v.secret = "raw body"),
    (v) => (v.reviewed.at = "yesterday"),
    (v) => (v.reviewed.fingerprint = "x"),
    (v) =>
      (v.skipped = { ...v.reviewed, until: new Date(now + DAY).toISOString() }),
    (v) => (v.id = "\n"),
  ]) {
    const invalid = structuredClone(old);
    change(invalid);
    assert.throws(() => validateReviewRecord(invalid), /未通过校验/);
  }
});
test("literal duplicate clues preserve full membership and never equate same names with identity", () => {
  const data = graph([
    node("a", { label: " Ａlpha ", content: "不同正文" }),
    node("b", { label: "alpha", content: "a  b" }),
    node("c", { label: "其他标题", type: "topic", content: "A\nb" }),
    node("d", { content: "" }),
    node("e", { content: "" }),
  ]);
  const result = healthCheck(freeze(data), { now });
  assert.deepEqual(
    result.duplicates.map((item) => [item.kind, item.ids]),
    [
      ["title", ["a", "b"]],
      ["content", ["b", "c"]],
    ],
  );
  assert.match(result.duplicates[0].reason, /同名不等于同一记忆/);
  assert.equal(data.nodes.length, 5);
});
test("isolation uses only existing other-node edges and explains self-only links", () => {
  const data = graph(
    [node("a"), node("b"), node("c"), node("d")],
    [
      { from: "a", to: "b", type: "uses", basis: "explicit" },
      { from: "c", to: "c", type: "self", basis: "explicit" },
    ],
  );
  const result = healthCheck(data, { now });
  assert.deepEqual(
    result.isolated.map((item) => item.id),
    ["c", "d"],
  );
  assert.match(result.isolated[0].reason, /仅有自关联/);
  assert.equal(data.edges.length, 2);
});
test("source checks distinguish declarations from references and accept real manual provenance", () => {
  const data = graph([
    node("a", { source_ref: undefined }),
    node("b", { source_id: "manual", source_ref: undefined }),
    node("c", {
      source_ref: undefined,
      provenance: [{ source_id: "test:origin", ref: "original:c" }],
    }),
    node("d"),
  ]);
  data.sources = [
    { id: "manual", platform: "manual", completeness: "partial" },
  ];
  const result = healthCheck(data, { now });
  assert.deepEqual(
    result.sources.map((item) => item.id),
    ["a"],
  );
  assert.match(result.sources[0].reason, /有来源声明/);
  const missing = {
    ...emptyGraph(),
    nodes: [node("x", { source_ref: undefined })],
  };
  assert.match(healthCheck(missing, { now }).sources[0].reason, /占位来源/);
  const declared = {
    ...missing,
    source: { ...missing.source, id: "actual:local" },
  };
  assert.match(healthCheck(declared, { now }).sources[0].reason, /有来源声明/);
});
test("old unconfirmed checks never claim a missing confirmation date or invent a timestamp", () => {
  const nodes = [
    "unknown",
    "inferred",
    "disputed",
    "confirmed",
    "deprecated",
  ].map((state) => node(state, { state }));
  nodes.push(
    node("no-time", { updated_at: undefined }),
    node("future", { updated_at: atAge(-1) }),
    node("boundary", { updated_at: atAge(90) }),
    node("recent", { updated_at: atAge(89) }),
  );
  const result = healthCheck(graph(nodes), { now });
  assert.deepEqual(
    result.stale.map((item) => item.id),
    ["unknown", "inferred", "disputed", "boundary"],
  );
  assert.match(result.stale[0].reason, /不代表最后确认时间/);
  assert.equal(result.missingTime, 1);
  assert.equal(result.futureTime, 1);
});
test("health groups scale linearly in membership instead of producing every duplicate pair", () => {
  const data = graph(
    Array.from({ length: 10000 }, (_, i) =>
      node("large:" + i, { label: "相同标题", content: "相同正文" }),
    ),
  );
  const result = healthCheck(data, { now });
  assert.equal(result.duplicates.length, 2);
  assert.equal(result.duplicates[0].ids.length, 10000);
  assert.equal(result.isolated.length, 10000);
});
test("new tab settings round-trip without adding personal status or bodies to temporary state", () => {
  const value = {
    version: 1,
    view: "review",
    insights: {
      reviewMode: "favorites",
      reviewAge: 90,
      reviewPage: 2,
      healthKind: "sources",
      healthAge: 180,
      healthPage: 3,
      records: ["private"],
    },
  };
  const result = tabState(value);
  assert.equal(result.view, "review");
  assert.deepEqual(result.insights, {
    reviewMode: "favorites",
    reviewAge: 90,
    reviewPage: 2,
    healthKind: "sources",
    healthAge: 180,
    healthPage: 3,
  });
  assert.ok(!JSON.stringify(result).includes("private"));
  const invalid = insightTabState({
    reviewMode: "bad",
    reviewAge: -1,
    reviewPage: -1,
    healthKind: "bad",
    healthAge: 1,
    healthPage: Infinity,
  });
  assert.deepEqual(invalid, insightTabState({}));
});
test("unknown modes and non-finite analysis dates fail safely", async () => {
  await assert.rejects(reviewPage(graph(), { mode: "magical" }), /筛选条件/);
  await assert.rejects(reviewPage(graph(), { now: Infinity }), /筛选条件/);
  assert.throws(() => healthCheck(graph(), { staleDays: 1 }), /筛选条件/);
});
