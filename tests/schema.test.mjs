import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  example,
  validateMgp,
  emptyGraph,
  mergeMgp,
  parseMgp,
  stringifyMgp,
} from "../web/mgp.mjs";
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv, { mode: "full" });
const schema = JSON.parse(
  readFileSync(new URL("../protocol/mgp.schema.json", import.meta.url), "utf8"),
);
const check = ajv.compile(schema);
const clone = structuredClone;
function both(graph, expected) {
  assert.equal(check(graph), expected, JSON.stringify(check.errors));
  assert.equal(validateMgp(graph).ok, expected);
}

test("Schema and runtime accept the canonical JSON and JSONL examples", () => {
  both(example, true);
  const json = parseMgp(
    readFileSync(
      new URL("../protocol/sample.mgp.json", import.meta.url),
      "utf8",
    ),
  ).graph;
  const jsonl = parseMgp(
    readFileSync(
      new URL("../protocol/sample.mgp.jsonl", import.meta.url),
      "utf8",
    ),
  ).graph;
  assert.deepEqual(json, example);
  assert.deepEqual(jsonl.nodes, example.nodes);
  assert.deepEqual(jsonl.edges, example.edges);
  both(jsonl, true);
});
test("Schema and runtime accept legacy snapshots and migrated workspaces", () => {
  const legacy = clone(example);
  legacy.protocol = "mgp/1.0";
  both(legacy, true);
  both(mergeMgp(null, legacy), true);
  both(emptyGraph(), true);
});
test("Schema and runtime reject unknown fields and protocol versions", () => {
  for (const mutate of [
    (g) => (g.protocol = "mgp/9.0"),
    (g) => (g.nodes[0].lable = "typo"),
    (g) => (g.unknown = true),
    (g) => (g.source.completeness = "complete"),
  ]) {
    const graph = clone(example);
    mutate(graph);
    both(graph, false);
  }
});
test("Schema and runtime reject invalid timestamps and revisions", () => {
  for (const updated_at of [
    "2026-02-30T00:00:00Z",
    "2026-01-01T24:00:00Z",
    "2026-01-01T00:00:00",
    "2026-01-01T00:00:00+25:00",
  ]) {
    const graph = clone(example);
    graph.nodes[0].updated_at = updated_at;
    both(graph, false);
  }
  for (const revision of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const graph = clone(example);
    graph.nodes[0].revision = revision;
    both(graph, false);
  }
});
test("Schema and runtime support explicit deletion identities and provenance", () => {
  const graph = emptyGraph();
  graph.deleted = {
    nodes: [{ id: "gone:node", deleted_at: "2026-01-01T00:00:00Z" }],
    edges: [{ id: "gone:edge", deleted_at: "2026-01-01T00:00:00Z" }],
  };
  both(graph, true);
  graph.deleted.edges[0].from = 42;
  both(graph, false);
});
test("Schema and runtime reject legacy delta operations", () => {
  const graph = clone(example);
  graph.protocol = "mgp/1.0";
  graph.mode = "delta";
  both(graph, false);
  delete graph.mode;
  graph.deleted = { nodes: [] };
  both(graph, false);
});
test("Schema and runtime reject dangerous extension keys and invalid JSON numbers", () => {
  const graph = clone(example);
  graph.extensions = JSON.parse('{"nested":{"__proto__":{}}}');
  both(graph, false);
  graph.extensions = { a: Infinity };
  both(graph, false);
});
test("the product export prompt contains a valid protocol example", () => {
  const prompt = readFileSync(
    new URL("../protocol/export-prompt-zh.txt", import.meta.url),
    "utf8",
  );
  const data = JSON.parse(
    prompt.slice(prompt.indexOf("\n{") + 1, prompt.lastIndexOf("\n}") + 2),
  );
  both(data, true);
  assert.equal(
    parseMgp(stringifyMgp(data)).graph.source.completeness,
    "partial",
  );
});

test("Schema and runtime accept legacy custom fields for lossless migration", () => {
  const graph = clone(example);
  graph.protocol = "mgp/1.0";
  graph.nodes[0].importance = 0.9;
  graph.customMetadata = { original: true };
  both(graph, true);
  both(mergeMgp(null, graph), true);
});
