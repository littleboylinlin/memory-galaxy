import { test } from "node:test";
import assert from "node:assert/strict";
import { ImportClient } from "../web/import-client.mjs";
import { emptyGraph, MgpError } from "../web/mgp.mjs";
function workers(t) {
  const previous = globalThis.Worker,
    instances = [];
  globalThis.Worker = class {
    constructor() {
      instances.push(this);
      this.terminated = false;
    }
    postMessage(data) {
      this.request = data;
    }
    terminate() {
      this.terminated = true;
    }
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.Worker;
    else globalThis.Worker = previous;
  });
  return instances;
}
test("cancelled imports reject and a delayed old worker cannot complete a new preview", async (t) => {
  const instances = workers(t),
    client = new ImportClient();
  const first = client.preview("first", emptyGraph(), { policy: "review" }),
    cancelled = assert.rejects(first, { name: "AbortError" });
  const second = client.preview("second", emptyGraph(), { policy: "review" });
  await cancelled;
  assert.equal(instances[0].terminated, true);
  instances[0].onmessage({
    data: { id: instances[0].request.id, ok: true, plan: { graph: "stale" } },
  });
  instances[0].onerror();
  assert.equal(instances[1].terminated, false);
  instances[1].onmessage({
    data: { id: instances[1].request.id, ok: true, plan: { graph: "current" } },
  });
  assert.equal((await second).plan.graph, "current");
  assert.equal(instances[1].terminated, true);
});
test("validation errors preserve their locations across the worker boundary", async (t) => {
  const instances = workers(t),
    client = new ImportClient();
  const pending = client.preview("invalid", emptyGraph(), {});
  instances[0].onmessage({
    data: {
      id: instances[0].request.id,
      ok: false,
      issues: [
        {
          path: "nodes[0].state",
          line: 7,
          column: 8,
          code: "invalid",
          message: "无效状态",
        },
      ],
    },
  });
  await assert.rejects(
    pending,
    (error) =>
      error instanceof MgpError &&
      error.issues[0].line === 7 &&
      error.issues[0].column === 8,
  );
  assert.equal(instances[0].terminated, true);
});
test("worker startup errors fail without leaving the preview pending", async (t) => {
  const instances = workers(t),
    client = new ImportClient();
  const pending = client.preview("input", emptyGraph(), {});
  instances[0].onerror();
  await assert.rejects(pending, /未能启动/);
  assert.equal(instances[0].terminated, true);
  client.cancel();
});
