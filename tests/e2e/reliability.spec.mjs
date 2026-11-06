import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const key = "memory-galaxy:tab-state:1";
const batch = (
  nodes = [
    {
      id: "stable:one",
      label: "原始记忆",
      type: "memory",
      content: "原始正文",
    },
  ],
) => ({
  protocol: "mgp/1.1",
  source: { id: "test:source", completeness: "partial" },
  nodes,
  edges: [],
});
async function tools(page) {
  if (
    (await page.locator("#menuBtn").isVisible()) &&
    !(await page.locator("#sidebar").isVisible())
  )
    await page.locator("#menuBtn").click();
}
async function closeTools(page) {
  if (
    (await page.locator("#menuBtn").isVisible()) &&
    (await page.locator("#sidebar").isVisible())
  )
    await page.locator("#menuBtn").click();
}
async function preview(page, value) {
  await tools(page);
  await page.locator("#input").fill(JSON.stringify(value));
  await page.locator("#importBtn").click();
  await expect(page.locator("#importDialog")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function apply(page, value = batch()) {
  await preview(page, value);
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  await closeTools(page);
}
async function save(page) {
  await closeTools(page);
  await page.locator("#quickSaveBtn").click();
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
}
async function disk(page) {
  return page.evaluate(async () =>
    (await import("./storage.mjs")).loadWorkspace(),
  );
}
async function exported(page) {
  await tools(page);
  const pending = page.waitForEvent("download");
  await page.locator("#exportBtn").click();
  const file = await pending;
  return JSON.parse(await readFile(await file.path(), "utf8"));
}
async function edit(page, text) {
  await closeTools(page);
  await page.locator("#tab-list").click();
  await page.locator("#nodeList button").first().click();
  await page.locator("#editNodeBtn").click();
  await page.locator("#nodeContent").fill(text);
}
async function unloadGuard(page) {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}
test.beforeEach(async ({ page }) => {
  await page.goto("web/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("applied edits stay explicitly unsaved until local storage commits and reload restores them", async ({
  page,
}) => {
  await tools(page);
  await page.locator("#addNodeBtn").click();
  await page.locator("#nodeLabel").fill("新建记忆");
  await page.locator("#nodeContent").fill("尚未落盘");
  await expect(page.locator("#saveStatus")).toHaveText("编辑中 · 尚未应用");
  expect(await unloadGuard(page)).toBe(true);
  await page.locator("#nodeForm button[type=submit]").click();
  await expect(page.locator("#saveStatus")).toBeVisible();
  await expect(page.locator("#saveStatus")).toHaveText("未保存到本机");
  expect((await disk(page))?.backup).toBeUndefined();
  expect(await unloadGuard(page)).toBe(true);
  await save(page);
  expect(await unloadGuard(page)).toBe(false);
  await page.reload();
  await expect(page.locator("#nodeCount")).toHaveText("1");
  expect((await disk(page)).backup.graph.nodes[0].content).toBe("尚未落盘");
});

test("quota failure retains the previous save and pending edits until a successful retry", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  const before = await disk(page);
  await edit(page, "新修改");
  await page.locator("#nodeForm button[type=submit]").click();
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    window.restoreWrites = () => {
      IDBObjectStore.prototype.put = original;
    };
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("test quota", "QuotaExceededError");
    };
  });
  await page.locator("#quickSaveBtn").click();
  await expect(page.locator("#notice")).toContainText("保存失败");
  await expect(page.locator("#saveStatus")).toHaveText("未保存到本机");
  expect((await disk(page)).revision).toBe(before.revision);
  expect((await disk(page)).backup.graph.nodes[0].content).toBe("原始正文");
  expect(await unloadGuard(page)).toBe(true);
  expect((await exported(page)).nodes[0].content).toBe("新修改");
  await page.evaluate(() => window.restoreWrites());
  await save(page);
  await page.reload();
  expect((await disk(page)).backup.graph.nodes[0].content).toBe("新修改");
});

test("in-flight saves disable duplicate writes and cannot label later edits as saved", async ({
  page,
}) => {
  await apply(page);
  await page.evaluate(() => {
    const originalOpen = IDBFactory.prototype.open,
      originalPut = IDBObjectStore.prototype.put;
    let hold = true;
    window.writeCount = 0;
    IDBObjectStore.prototype.put = function (...args) {
      window.writeCount++;
      return originalPut.apply(this, args);
    };
    IDBFactory.prototype.open = function (...args) {
      const request = originalOpen.apply(this, args);
      if (hold) {
        hold = false;
        Object.defineProperty(request, "onsuccess", {
          set(handler) {
            request.addEventListener(
              "success",
              (event) => {
                window.finishOpen = () => handler.call(request, event);
              },
              { once: true },
            );
          },
        });
      }
      return request;
    };
  });
  await page.locator("#quickSaveBtn").click();
  await expect(page.locator("#saveStatus")).toHaveText("正在保存");
  await expect(page.locator("#quickSaveBtn")).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => typeof window.finishOpen))
    .toBe("function");
  await edit(page, "保存过程中继续编辑");
  await page.locator("#nodeForm button[type=submit]").click();
  await page.evaluate(() => window.finishOpen());
  await expect(page.locator("#quickSaveBtn")).toBeEnabled();
  await expect(page.locator("#saveStatus")).toHaveText("未保存到本机");
  expect((await disk(page)).backup.graph.nodes[0].content).toBe("原始正文");
  expect(await page.evaluate(() => window.writeCount)).toBe(1);
  await save(page);
  expect((await disk(page)).backup.graph.nodes[0].content).toBe(
    "保存过程中继续编辑",
  );
  await save(page);
  expect(await page.evaluate(() => window.writeCount)).toBe(2);
});

test("form-only drafts warn on close and unload without changing a clean saved workspace", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  const before = await disk(page);
  await edit(page, "未应用草稿");
  expect(await unloadGuard(page)).toBe(true);
  await page
    .locator('#nodeDialog button[data-close="nodeDialog"]')
    .last()
    .click();
  await expect(page.locator("#confirmTitle")).toHaveText("放弃未应用的编辑");
  await page.locator("#cancelAction").click();
  await expect(page.locator("#nodeContent")).toHaveValue("未应用草稿");
  await page
    .locator('#nodeDialog button[data-close="nodeDialog"]')
    .last()
    .click();
  await page.locator("#confirmAction").click();
  await expect(page.locator("#nodeDialog")).not.toBeVisible();
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
  expect((await disk(page)).revision).toBe(before.revision);
  expect(await unloadGuard(page)).toBe(false);
});

test("title choices distinguish duplicate names and preserve stable relation identity", async ({
  page,
}) => {
  const ids = [
    "namespace:000000000A000000000suffix",
    "namespace:000000000B000000000suffix",
  ];
  await apply(
    page,
    batch(ids.map((id) => ({ id, label: "同名记忆", type: "memory" }))),
  );
  await page.locator("#tab-list").click();
  await page.locator("#nodeList button").first().click();
  await page.locator("#addEdgeBtn").click();
  await expect(page.locator("#edgeFrom")).toHaveValue("同名记忆");
  await page.locator("#edgeTo").fill("同名");
  await expect(page.locator("#edgeToResults button")).toHaveCount(2);
  for (const id of ids)
    await expect(page.locator("#edgeToResults")).toContainText(id);
  await expect(page.locator("#edgeToResults")).toContainText("记忆");
  await page.locator(`#edgeToResults button[data-node-id="${ids[1]}"]`).click();
  await page.locator("#edgeType").fill("supports");
  await page.locator("#edgeEvidence").fill("明确记录的关系");
  await page.locator("#edgeForm button[type=submit]").click();
  const graph = await exported(page),
    relation = graph.edges[0];
  expect([relation.from, relation.to]).toEqual(ids);
  await closeTools(page);
  await page
    .locator(".relation-card")
    .getByRole("button", { name: "编辑", exact: true })
    .click();
  await page.locator("#edgeTo").fill("同名");
  await page.locator("#edgeType").fill("relates_to");
  await page.locator("#edgeForm button[type=submit]").click();
  await expect(page.locator("#edgeError")).toContainText("从搜索结果中选择");
  await page.locator("#edgeTo").focus();
  await page.locator(`#edgeToResults button[data-node-id="${ids[1]}"]`).click();
  await page.locator("#edgeForm button[type=submit]").click();
  const after = await exported(page);
  expect(after.edges[0].id).toBe(relation.id);
  expect(after.edges[0].to).toBe(ids[1]);
});

test("field differences are visible by default and decisions remain explicit with original provenance", async ({
  page,
}) => {
  const original = batch([
    {
      id: "stable:one",
      label: "原始记忆",
      type: "memory",
      content: "旧内容",
      tags: ["旧标签"],
      source_ref: "original:ref",
      revision: 2,
    },
  ]);
  await apply(page, original);
  const incoming = batch([
    {
      id: "stable:one",
      label: "原始记忆",
      type: "memory",
      content: '<img src="x" onerror="alert(1)">',
      tags: [],
      sensitive: false,
    },
  ]);
  incoming.source.id = "test:other-source";
  await preview(page, incoming);
  await expect(page.locator("#applyImport")).toBeDisabled();
  await expect(page.locator("#conflictCount")).toContainText("待处理 1 项");
  await expect(page.locator(".field-diff")).toBeVisible();
  await expect(page.locator(".field-diff")).toContainText("旧内容");
  await expect(page.locator(".field-diff")).toContainText("值不同");
  await expect(page.locator(".field-diff")).toContainText("新增字段");
  await expect(page.locator(".field-diff")).toContainText("移除字段");
  await expect(page.locator(".field-diff img")).toHaveCount(0);
  await expect(page.locator(".conflict-json")).not.toHaveAttribute("open", "");
  await page.locator(".conflict-json > summary").click();
  await expect(page.locator(".conflict-json pre")).toContainText([
    "original:ref",
    "other-source",
  ]);
  await page.locator("#previewConflicts select").selectOption("incoming");
  await expect(page.locator("#conflictCount")).toContainText(
    "待处理 0 项 · 已处理 1 项",
  );
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#cancelImport").click();
  expect((await exported(page)).nodes[0].content).toBe("旧内容");
  await preview(page, incoming);
  await expect(page.locator("#applyImport")).toBeDisabled();
  await page.locator("#previewConflicts select").selectOption("incoming");
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  const graph = await exported(page);
  expect(graph.nodes[0].id).toBe("stable:one");
  expect(graph.nodes[0].source_ref).toBeUndefined();
  expect(graph.nodes[0].provenance).toContainEqual({
    source_id: "test:source",
    ref: "original:ref",
  });
  expect(graph.nodes[0].tags).toEqual([]);
});

test("refresh restores tab, raw search, filters and page without writing them into the workspace", async ({
  page,
  context,
}) => {
  const nodes = Array.from({ length: 95 }, (_, i) => ({
    id: "stable:" + i,
    label: "Alpha " + i,
    type: "memory",
    state: "confirmed",
  }));
  await apply(page, batch(nodes));
  await save(page);
  const before = await disk(page);
  await tools(page);
  await page.locator("#search").fill("Alpha");
  await page.locator("#stateFilter").selectOption("confirmed");
  await page.locator("#filters button").filter({ hasText: "记忆" }).click();
  await closeTools(page);
  await page.locator("#tab-list").click();
  await page.locator("#listNext").click();
  await page.locator("#listNext").click();
  await expect(page.locator("#listPage")).toHaveText("3 / 3");
  await page.reload();
  await expect(page.locator("#tab-list")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#listPage")).toHaveText("3 / 3");
  await tools(page);
  await expect(page.locator("#search")).toHaveValue("Alpha");
  await expect(page.locator("#stateFilter")).toHaveValue("confirmed");
  await expect(
    page.locator('#filters button[aria-pressed="true"]'),
  ).toContainText("记忆");
  expect((await disk(page)).revision).toBe(before.revision);
  expect((await disk(page)).backup).toEqual(before.backup);
  const other = await context.newPage();
  await other.goto("web/");
  await expect(other.locator("#tab-graph")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(other.locator("#search")).toHaveValue("");
  await other.close();
});

test("refresh restores zoom and pan and further camera movement remains transient", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  await expect(page.locator("#layoutStatus")).toHaveText("星图布局就绪");
  await page.locator("#zoomIn").click();
  await page.locator("#sky").focus();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  const zoom = await page.locator("#zoomValue").textContent();
  await unloadGuard(page);
  const before = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)).camera,
    key,
  );
  const revision = (await disk(page)).revision;
  await page.reload();
  await expect(page.locator("#zoomValue")).toHaveText(zoom);
  expect(
    await page.evaluate(
      (key) => JSON.parse(sessionStorage.getItem(key)).camera,
      key,
    ),
  ).toEqual(before);
  await page.locator("#sky").focus();
  await page.keyboard.press("ArrowDown");
  await unloadGuard(page);
  const after = await page.evaluate(
    (key) => JSON.parse(sessionStorage.getItem(key)).camera,
    key,
  );
  expect(after.x).toBeCloseTo(before.x, 6);
  expect(after.y).toBeCloseTo(before.y + 60 / before.zoom, 6);
  expect((await disk(page)).revision).toBe(revision);
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
});

test("corrupt or denied tab storage falls back without affecting durable data", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  const before = await disk(page);
  await page.evaluate((key) => sessionStorage.setItem(key, "{broken"), key);
  // This reload intentionally preserves the corrupt entry until initialization reads it.
  await page.addInitScript(
    (key) => sessionStorage.setItem(key, "{broken"),
    key,
  );
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#tab-graph")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.addInitScript(() =>
    Object.defineProperty(window, "sessionStorage", {
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    }),
  );
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  expect((await disk(page)).backup).toEqual(before.backup);
});
