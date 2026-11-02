import test from "node:test";
import assert from "node:assert/strict";
import {
  clusterGraph,
  createLayout,
  stepLayout,
  pinNode,
  layoutPositions,
} from "../web/layout.mjs";
const nodes = [
  { id: "a", type: "memory", source_id: "one" },
  { id: "b", type: "topic", source_id: "one" },
  { id: "c", type: "memory", source_id: "two" },
  { id: "d", type: "goal", source_id: "two" },
];
const edges = [
  { from: "a", to: "b" },
  { from: "b", to: "c" },
];
test("component clusters use supplied relationships and preserve isolated nodes", () => {
  const result = clusterGraph(nodes, edges, "component");
  assert.equal(result.groups.length, 2);
  assert.equal(result.assignments[0], result.assignments[2]);
  assert.notEqual(result.assignments[0], result.assignments[3]);
  assert.equal(
    result.groups.reduce((n, g) => n + g.count, 0),
    4,
  );
  assert.equal(edges.length, 2);
});
test("type and source grouping do not fabricate edges", () => {
  const type = clusterGraph(nodes, edges, "type"),
    source = clusterGraph(nodes, edges, "source");
  assert.equal(type.groups.length, 3);
  assert.equal(source.groups.length, 2);
  assert.equal(type.assignments[0], type.assignments[2]);
  assert.equal(source.assignments[0], source.assignments[1]);
  assert.equal(clusterGraph(nodes, edges, "none").groups.length, 1);
});
test("initial layouts are deterministic and retain restored coordinates and pins", () => {
  assert.deepEqual(
    layoutPositions(createLayout(nodes, edges)),
    layoutPositions(createLayout(nodes, edges)),
  );
  const layout = createLayout(nodes, edges, {
    positions: [{ id: "a", x: 11, y: -5, pinned: true }],
  });
  stepLayout(layout, 50);
  assert.equal(layout.x[0], 11);
  assert.equal(layout.y[0], -5);
  assert.ok([...layoutPositions(layout)].every(Number.isFinite));
});
test("dragging pins a stable ID and releasing allows forces to move it", () => {
  const layout = createLayout(nodes, edges);
  assert.equal(pinNode(layout, "a", 120, 200), true);
  stepLayout(layout, 8);
  assert.equal(layout.x[0], 120);
  assert.equal(layout.y[0], 200);
  pinNode(layout, "a", 120, 200, false);
  stepLayout(layout, 20);
  assert.notEqual(layout.x[0], 120);
  assert.equal(pinNode(layout, "missing", 0, 0), false);
  assert.equal(pinNode(layout, "a", NaN, 0), false);
});
test("dense and coincident inputs remain finite without pairwise neighbor expansion", () => {
  const many = Array.from({ length: 10000 }, (_, i) => ({
      id: "n:" + i,
      type: "memory",
    })),
    positions = many.map((node) => ({
      id: node.id,
      x: 0,
      y: 0,
      pinned: false,
    })),
    layout = createLayout(many, [], { positions });
  stepLayout(layout, 3);
  assert.ok([...layoutPositions(layout)].every(Number.isFinite));
  assert.ok(layout.x.some((value) => value !== 0));
  assert.equal(layout.nodes.length, 10000);
});
test("empty graphs and dangling layout-only references are safe", () => {
  const empty = createLayout([], []);
  stepLayout(empty, 3);
  assert.equal(empty.energy, 0);
  assert.equal(layoutPositions(empty).length, 0);
  const layout = createLayout(nodes, [...edges, { from: "a", to: "missing" }]);
  assert.equal(layout.pairs.length, 4);
  stepLayout(layout, 10);
  assert.ok(Number.isFinite(layout.energy));
});
