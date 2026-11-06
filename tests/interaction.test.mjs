import test from "node:test";
import assert from "node:assert/strict";
import {
  readTabState,
  writeTabState,
  TAB_STATE_KEY,
} from "../web/tab-state.mjs";
import { findNodes } from "../web/node-picker.mjs";
import { conflictDiff } from "../web/field-diff.mjs";
import { emptyGraph, planImport } from "../web/mgp.mjs";

const state = {
  version: 1,
  view: "list",
  query: "Alpha",
  typeFilter: "memory",
  stateFilter: "confirmed",
  listPage: 2,
  timelinePage: 1,
  edgePage: 3,
  selected: "stable:one",
  timelineMode: "activity",
  camera: { zoom: 1.5, x: 120, y: -40 },
};
const memoryStorage = () => {
  const items = new Map();
  return {
    getItem: (key) => items.get(key),
    setItem: (key, value) => items.set(key, value),
  };
};

test("tab state round-trips through the selected tab's storage without memory bodies", () => {
  const storage = memoryStorage();
  assert.equal(
    writeTabState(
      { ...state, graph: { secret: "private" }, snapshots: ["secret"] },
      storage,
    ),
    true,
  );
  assert.deepEqual(readTabState(storage), state);
  assert.ok(!storage.getItem(TAB_STATE_KEY).includes("secret"));
  assert.equal(readTabState(memoryStorage()), null);
});
test("malformed, oversized and unknown-version tab state safely falls back", () => {
  for (const value of [
    "{bad",
    "null",
    "[]",
    '{"version":2}',
    "x".repeat(17000),
  ])
    assert.equal(readTabState({ getItem: () => value }), null);
});
test("unavailable session storage never prevents reading or saving memories", () => {
  const storage = {
    getItem() {
      throw new Error("blocked");
    },
    setItem() {
      throw new Error("quota");
    },
  };
  assert.equal(readTabState(storage), null);
  assert.equal(writeTabState(state, storage), false);
});
test("tab state validates filters, page bounds, selection and camera coordinates", () => {
  const storage = memoryStorage();
  writeTabState(
    {
      ...state,
      view: "unexpected",
      typeFilter: "bad",
      stateFilter: "bad",
      selected: "x".repeat(257),
      query: "x".repeat(1000),
      listPage: -1,
      timelinePage: 1.5,
      edgePage: 1e12,
      camera: { zoom: 7, x: 0, y: 0 },
    },
    storage,
  );
  const restored = readTabState(storage);
  assert.equal(restored.view, "graph");
  assert.equal(restored.typeFilter, "all");
  assert.equal(restored.stateFilter, "all");
  assert.equal(restored.selected, null);
  assert.equal(restored.query.length, 500);
  assert.deepEqual(
    [restored.listPage, restored.timelinePage, restored.edgePage],
    [0, 0, 0],
  );
  assert.equal(restored.camera, null);
});
test("non-finite and out-of-range cameras are discarded", () => {
  for (const camera of [
    { zoom: 0, x: 0, y: 0 },
    { zoom: 1, x: Infinity, y: 0 },
    { zoom: 1, x: 0, y: 1e10 },
    { zoom: 1, x: "0", y: 0 },
  ]) {
    const storage = memoryStorage();
    writeTabState({ ...state, camera }, storage);
    assert.equal(readTabState(storage).camera, null);
  }
});
test("title lookup preserves the stable IDs of duplicate titles and types", () => {
  const nodes = [
    { id: "one", label: "重复标题", type: "memory" },
    { id: "two", label: "重复标题", type: "project" },
  ];
  const result = findNodes(nodes, "重复");
  assert.equal(result.total, 2);
  assert.deepEqual(
    result.nodes.map((n) => [n.id, n.type]),
    [
      ["one", "memory"],
      ["two", "project"],
    ],
  );
  assert.equal(findNodes(nodes, "tWo").nodes[0].id, "two");
});
test("short ID collisions expand to full distinct IDs instead of hiding identity", () => {
  const nodes = ["A", "B"].map((value) => ({
    id: "namespace:000000000" + value + "000000000suffix",
    label: "Same",
    type: "memory",
  }));
  const result = findNodes(nodes, "same");
  assert.deepEqual(
    result.nodes.map((n) => n.shortId),
    nodes.map((n) => n.id),
  );
});
test("large title searches are bounded while reporting the actual match count", () => {
  const nodes = Array.from({ length: 10000 }, (_, i) => ({
    id: "stable:" + i,
    label: "Alpha " + i,
    type: "memory",
  }));
  assert.equal(findNodes(nodes, "ALPHA").total, 10000);
  assert.equal(findNodes(nodes, "ALPHA").nodes.length, 35);
  assert.equal(findNodes(nodes, "absent").nodes.length, 0);
});
test("field review distinguishes additions, removals, empty values and nested differences", () => {
  const rows = conflictDiff({
    kind: "source",
    existing: { removed: 0, content: "old", nested: { count: 1 }, flag: true },
    incoming: { content: "", nested: { count: 2 }, flag: false, tags: [] },
  });
  assert.ok(
    rows.some((row) => row.kind === "removed" && row.field[0] === "removed"),
  );
  assert.ok(
    rows.some((row) => row.kind === "added" && row.field[0] === "tags"),
  );
  assert.ok(rows.some((row) => row.before === "old" && row.after === ""));
  assert.ok(rows.some((row) => row.before === true && row.after === false));
  assert.ok(
    rows.some(
      (row) => row.field.join(".") === "nested.count" && row.after === 2,
    ),
  );
});
test("field review uses import rules for omitted fields and cross-source provenance", () => {
  const base = planImport(emptyGraph(), {
    protocol: "mgp/1.1",
    source: { id: "source:a" },
    nodes: [
      {
        id: "stable",
        label: "Old",
        type: "memory",
        content: "retained",
        source_ref: "original",
        revision: 4,
      },
    ],
    edges: [],
  }).graph;
  const incoming = {
    protocol: "mgp/1.1",
    source: { id: "source:b" },
    nodes: [{ id: "stable", label: "New", type: "memory" }],
    edges: [],
  };
  const plan = planImport(base, incoming),
    conflict = plan.conflicts.find((c) => c.kind === "node");
  const rows = conflictDiff(conflict);
  assert.equal(plan.canApply, false);
  assert.ok(!rows.some((row) => row.field[0] === "content"));
  assert.ok(
    rows.some((row) => row.field[0] === "source_ref" && row.kind === "removed"),
  );
  assert.ok(
    rows.some((row) => row.field[0] === "revision" && row.kind === "removed"),
  );
  const accepted = planImport(base, incoming, {
    choices: { [conflict.key]: "incoming" },
  });
  for (const row of rows.filter((row) => row.field.length === 1))
    assert.deepEqual(accepted.graph.nodes[0][row.field[0]], row.after);
  assert.ok(
    accepted.graph.nodes[0].provenance.some(
      (p) => p.source_id === "source:a" && p.ref === "original",
    ),
  );
});
test("review ignores object key order without mutating imported extension data", () => {
  const conflict = {
    kind: "extension",
    existing: { "ns:data": { a: 1, b: [2, 3] } },
    incoming: { "ns:data": { b: [2, 3], a: 1 } },
  };
  const before = structuredClone(conflict);
  assert.deepEqual(conflictDiff(conflict), []);
  assert.deepEqual(conflict, before);
});
