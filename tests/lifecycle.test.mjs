import test from "node:test";
import assert from "node:assert/strict";
import { syntheticGraph } from "./fixtures/synthetic.mjs";
import {
  parseMgp,
  stringifyMgp,
  planImport,
  graphSources,
  emptyGraph,
} from "../web/mgp.mjs";
import { Workspace, parseBackup } from "../web/workspace.mjs";

test("multi-source records and relations survive import, edits, deletion, replay and backup recovery", () => {
  const incoming = parseMgp(stringifyMgp(syntheticGraph(), "jsonl")).graph;
  const initial = planImport(emptyGraph(), incoming);
  assert.equal(initial.canApply, true);
  assert.equal(initial.graph.nodes.length, 402);
  assert.equal(initial.graph.edges.length, 2028);
  assert.equal(graphSources(initial.graph).length, 3);
  const w = new Workspace(initial.graph);
  const id = incoming.nodes[0].id;
  w.editNode(id, { label: "手动核实的合成记忆" });
  const edited = structuredClone(w.graph);
  w.deleteNode(id);
  assert.ok(w.graph.edges.every((e) => e.from !== id && e.to !== id));
  const replay = planImport(w.graph, initial.graph);
  assert.equal(replay.canApply, false);
  assert.ok(replay.conflicts.some((c) => c.kind === "restore-node"));
  const keep = planImport(w.graph, initial.graph, { policy: "keep" });
  assert.equal(keep.canApply, true);
  assert.deepEqual(keep.graph.nodes, w.graph.nodes);
  assert.deepEqual(keep.graph.edges, w.graph.edges);
  w.undo();
  assert.deepEqual(w.graph, edited);
  const backup = parseBackup(JSON.stringify(w.backup()));
  const restored = new Workspace(emptyGraph());
  restored.restoreBackup(backup, { record: false, preserveCurrent: false });
  assert.deepEqual(restored.graph, edited);
  assert.deepEqual(restored.snapshots, w.snapshots);
  assert.deepEqual(restored.events, w.events);
  assert.deepEqual(
    parseMgp(stringifyMgp(restored.graph, "jsonl")).graph,
    edited,
  );
});
