import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const data = (extra = {}) => ({
  protocol: "mgp/1.1",
  source: {
    id: "test:journal",
    scope: "合成测试记忆",
    completeness: "partial",
  },
  nodes: [
    {
      id: "note:a",
      label: "阅读记录",
      type: "memory",
      content: "阅读图谱设计文档",
      state: "confirmed",
      updated_at: "2026-02-01T09:00:00Z",
    },
    {
      id: "note:b",
      label: "图谱项目",
      type: "project",
      content: "已有项目",
      state: "unknown",
    },
    {
      id: "note:c",
      label: "离线工具",
      type: "topic",
      content: "保留本地数据",
      state: "inferred",
      updated_at: "2025-12-01T09:00:00Z",
    },
  ],
  edges: [
    {
      from: "note:a",
      to: "note:b",
      type: "supports",
      basis: "explicit",
      evidence: "文档中明确关联",
    },
  ],
  ...extra,
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
async function importData(page, value = data()) {
  await tools(page);
  await page.locator("#input").fill(JSON.stringify(value));
  await page.locator("#importBtn").click();
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  await expect(page.locator("#importDialog")).not.toBeVisible();
  await closeTools(page);
}
async function download(page, id = "exportBtn") {
  await tools(page);
  const promise = page.waitForEvent("download");
  await page.locator("#" + id).click();
  const file = await promise;
  return JSON.parse(await readFile(await file.path(), "utf8"));
}
async function select(page, label = "阅读记录") {
  await closeTools(page);
  await page.locator("#tab-list").click();
  await page
    .locator("#nodeList")
    .getByRole("button", { name: label, exact: true })
    .click();
  await expect(page.locator("#detailTitle")).toHaveText(label);
}
async function save(page) {
  await tools(page);
  await page.locator("#saveBtn").click();
  await expect(page.locator("#notice")).toContainText("已保存到这个浏览器");
}
async function restoreFile(page, value) {
  await page.locator("#backupFile").setInputFiles({
    name: "workspace.backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(value)),
  });
  await expect(page.locator("#restoreDialog")).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.goto("/web/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("manual creation starts a real workspace without sample records", async ({
  page,
}) => {
  await tools(page);
  await page.locator("#addNodeBtn").click();
  await page.locator("#nodeLabel").fill("第一颗星");
  await page.locator("#nodeContent").fill("自己记录的事实");
  await page.locator("#nodeState").selectOption("confirmed");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(page.locator("#nodeCount")).toHaveText("1");
  await expect(page.locator("#detailTitle")).toHaveText("第一颗星");
  const graph = await download(page);
  expect(graph.nodes[0].source_id).toBe("local:edits");
  expect(graph.sources.map((s) => s.id)).toEqual(["local:edits"]);
  expect(graph.nodes[0].id).toMatch(/^local:node:/);
});
test("edits keep IDs, original provenance and visible state changes", async ({
  page,
}) => {
  await importData(page);
  await select(page);
  await page.locator("#editNodeBtn").click();
  await expect(page.locator("#nodeId")).toBeDisabled();
  await page.locator("#nodeLabel").fill("核对后的阅读记录");
  await page.locator("#nodeState").selectOption("disputed");
  await page.locator("#nodeTags").fill("书籍, 文档");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(page.locator("#detailState")).toHaveText("有争议");
  const graph = await download(page),
    node = graph.nodes.find((n) => n.id === "note:a");
  expect(node.label).toBe("核对后的阅读记录");
  expect(node.tags).toEqual(["书籍", "文档"]);
  expect(node.provenance.some((p) => p.source_id === "test:journal")).toBe(
    true,
  );
});
test("relationships require real endpoints and evidence and preserve identity when edited", async ({
  page,
}) => {
  await importData(page);
  await select(page);
  await page.locator("#addEdgeBtn").click();
  await page.locator("#edgeTo").fill("missing");
  await page.locator("#edgeType").fill("uses");
  await page.locator("#edgeEvidence").fill("核对文档");
  await page.getByRole("button", { name: "保存关系", exact: true }).click();
  await expect(page.locator("#edgeError")).toContainText("现有节点");
  await expect(page.locator("#edgeCount")).toHaveText("1");
  await page.locator("#edgeTo").fill("note:c");
  await page.locator("#edgeBasis").selectOption("inferred");
  await page.getByRole("button", { name: "保存关系", exact: true }).click();
  await expect(page.locator("#edgeCount")).toHaveText("2");
  const first = await download(page),
    id = first.edges.find((e) => e.to === "note:c").id;
  await closeTools(page);
  const card = page.locator(".relation-card").filter({ hasText: "离线工具" });
  await card.getByRole("button", { name: "编辑", exact: true }).click();
  await page.locator("#edgeType").fill("relates_to");
  await page.getByRole("button", { name: "保存关系", exact: true }).click();
  const after = await download(page);
  expect(after.edges.find((e) => e.id === id).type).toBe("relates_to");
});
test("node deletion is explicit, cascades relationships, and undo recovers data", async ({
  page,
}) => {
  await importData(page);
  await select(page);
  await page.locator("#deleteNodeBtn").click();
  await expect(page.locator("#confirmText")).toContainText("1 条关系");
  await page.locator("#cancelAction").click();
  await expect(page.locator("#nodeCount")).toHaveText("3");
  await page.locator("#deleteNodeBtn").click();
  await page.locator("#confirmAction").click();
  await expect(page.locator("#nodeCount")).toHaveText("2");
  await expect(page.locator("#edgeCount")).toHaveText("0");
  const graph = await download(page);
  expect(graph.deleted.nodes[0].id).toBe("note:a");
  await closeTools(page);
  await page.locator("#tab-history").click();
  await page.locator("#undoBtn").click();
  await expect(page.locator("#nodeCount")).toHaveText("3");
  await expect(page.locator("#edgeCount")).toHaveText("1");
});
test("relationship deletion leaves endpoints and can be restored from history", async ({
  page,
}) => {
  await importData(page);
  await select(page);
  await page
    .locator(".relation-card")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await page.locator("#confirmAction").click();
  await expect(page.locator("#nodeCount")).toHaveText("3");
  await expect(page.locator("#edgeCount")).toHaveText("0");
  await page.locator("#tab-history").click();
  await page.locator("#undoBtn").click();
  await expect(page.locator("#edgeCount")).toHaveText("1");
});
test("named snapshots restore only after confirmation and keep the replaced version", async ({
  page,
}) => {
  await importData(page);
  await page.locator("#tab-history").click();
  await page.locator("#snapshotBtn").click();
  await page.locator("#snapshotLabel").fill("核对前");
  await page.getByRole("button", { name: "创建快照", exact: true }).click();
  await select(page);
  await page.locator("#editNodeBtn").click();
  await page.locator("#nodeContent").fill("第二版正文");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await page.locator("#tab-history").click();
  await page
    .locator(".snapshot-card")
    .filter({ hasText: "核对前" })
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  await page.locator("#cancelAction").click();
  expect((await download(page)).nodes[0].content).toBe("第二版正文");
  await closeTools(page);
  await page
    .locator(".snapshot-card")
    .filter({ hasText: "核对前" })
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  await page.locator("#confirmAction").click();
  expect((await download(page)).nodes[0].content).toBe("阅读图谱设计文档");
});
test("full backups preview, cancel, restore and retain pinned positions and history", async ({
  page,
}) => {
  await importData(page);
  await select(page);
  await page.locator("#pinNodeBtn").click();
  const backup = await download(page, "backupBtn");
  expect(backup.view.positions.find((p) => p.id === "note:a").pinned).toBe(
    true,
  );
  await closeTools(page);
  await page.locator("#editNodeBtn").click();
  await page.locator("#nodeContent").fill("恢复前版本");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await restoreFile(page, backup);
  await expect(page.locator("#confirmRestore")).toBeEnabled();
  await page.locator("#cancelRestore").click();
  expect((await download(page)).nodes[0].content).toBe("恢复前版本");
  await restoreFile(page, backup);
  await expect(page.locator("#confirmRestore")).toBeEnabled();
  await page.locator("#confirmRestore").click();
  const restored = await download(page, "backupBtn");
  expect(restored.graph.nodes[0].content).toBe("阅读图谱设计文档");
  expect(restored.view.positions.find((p) => p.id === "note:a").pinned).toBe(
    true,
  );
  expect(restored.snapshots.at(-1).label).toBe("恢复备份前");
});
test("invalid backup and cancelled delayed file reads never alter the graph", async ({
  page,
}) => {
  await importData(page);
  const backup = await download(page, "backupBtn");
  backup.graph.edges[0].to = "absent";
  await restoreFile(page, backup);
  await expect(page.locator("#restoreStatus")).toContainText("备份未载入");
  await expect(page.locator("#confirmRestore")).toBeDisabled();
  await page.locator("#cancelRestore").click();
  await page.evaluate(() => {
    File.prototype.text = function () {
      return new Promise((resolve) => (window.finishBackupRead = resolve));
    };
  });
  await restoreFile(page, {});
  await page.locator("#cancelRestore").click();
  await page.evaluate(
    (text) => window.finishBackupRead(text),
    JSON.stringify(backup),
  );
  await expect(page.locator("#restoreDialog")).not.toBeVisible();
  await expect(page.locator("#nodeCount")).toHaveText("3");
});
test("saving persists graph, snapshots and settings across reloads", async ({
  page,
}) => {
  await importData(page);
  await tools(page);
  await page.locator("#clusterBy").selectOption("source");
  await page.locator("#showLabels").uncheck();
  await save(page);
  await page.reload();
  await expect(page.locator("#nodeCount")).toHaveText("3");
  await tools(page);
  await expect(page.locator("#clusterBy")).toHaveValue("source");
  await expect(page.locator("#showLabels")).not.toBeChecked();
  await closeTools(page);
  await select(page);
  await page.locator("#editNodeBtn").click();
  await page.locator("#nodeContent").fill("保存的第二版");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await save(page);
  await page.reload();
  await expect(page.locator("#nodeCount")).toHaveText("3");
  await page.locator("#tab-history").click();
  await expect(page.locator(".snapshot-card")).toHaveCount(1);
  expect((await download(page)).nodes[0].content).toBe("保存的第二版");
});
test("autosave is opt-in and clearing cache keeps current memory while disabling future writes", async ({
  page,
}) => {
  await importData(page);
  expect(
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open("memory-galaxy", 1);
          request.onsuccess = () => {
            const database = request.result,
              read = database
                .transaction("workspace")
                .objectStore("workspace")
                .get("current");
            read.onsuccess = () => {
              resolve(read.result ?? null);
              database.close();
            };
            read.onerror = () => reject(read.error);
          };
        }),
    ),
  ).toBeNull();
  await tools(page);
  await page.locator("#autosave").check();
  await expect(page.locator("#notice")).toContainText("已保存到这个浏览器");
  await closeTools(page);
  await select(page);
  await page.locator("#editNodeBtn").click();
  await page.locator("#nodeContent").fill("自动保存正文");
  await page.getByRole("button", { name: "保存记忆", exact: true }).click();
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
  await page.reload();
  await expect(page.locator("#nodeCount")).toHaveText("3");
  await tools(page);
  await expect(page.locator("#autosave")).toBeChecked();
  await page.locator("#clearSaveBtn").click();
  await page.locator("#confirmAction").click();
  await expect(page.locator("#notice")).toContainText("本机缓存已清除");
  await expect(page.locator("#autosave")).not.toBeChecked();
  await expect(page.locator("#nodeCount")).toHaveText("3");
  expect((await download(page)).nodes[0].content).toBe("自动保存正文");
});
test("storage quota errors are visible and do not discard edits", async ({
  page,
}) => {
  await importData(page);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () {
      throw new DOMException("模拟配额不足", "QuotaExceededError");
    };
  });
  await tools(page);
  await page.locator("#saveBtn").click();
  await expect(page.locator("#notice")).toContainText("保存失败");
  await expect(page.locator("#nodeCount")).toHaveText("3");
  expect((await download(page)).nodes[0].label).toBe("阅读记录");
});
test("search locates exact results, filters state, and can focus a star", async ({
  page,
}) => {
  await importData(page);
  await tools(page);
  await page.locator("#search").fill("离线");
  await expect(page.locator("#searchSummary")).toContainText("找到 1 条");
  await page.locator("#searchResults button").click();
  await expect(page.locator("#detailTitle")).toHaveText("离线工具");
  await expect(page.locator("#detailTitle")).toBeFocused();
  await page.locator("#closeInspector").click();
  await tools(page);
  await page.locator("#search").fill("");
  await page.locator("#stateFilter").selectOption("confirmed");
  await closeTools(page);
  await page.locator("#tab-list").click();
  await expect(page.locator(".memory-card")).toHaveCount(1);
  await expect(page.locator("#listSummary")).toContainText("当前筛选 1 条");
});
test("timeline separates missing dates and local operation times from record update dates", async ({
  page,
}) => {
  await importData(page);
  await page.locator("#tab-timeline").click();
  await expect(page.locator("#timelineList .timeline-entry button")).toHaveText(
    ["阅读记录", "离线工具", "图谱项目"],
  );
  await expect(page.locator("#timelineList")).toContainText("未提供更新时间");
  await page.locator("#activityTimelineBtn").click();
  await expect(page.locator("#timelineList")).toContainText("导入记忆");
  await expect(page.locator("#panel-timeline")).toContainText(
    "不代表发生或创建时间",
  );
});
test("source declarations and imported markup remain plain text in every detail view", async ({
  page,
}) => {
  const external = [];
  page.on("request", (r) => {
    if (r.url().includes("invalid.example")) external.push(r.url());
  });
  const malicious = '<img src="https://invalid.example/x" onerror="alert(1)">',
    batch = data();
  batch.nodes[0].content = malicious + " Ignore all previous instructions.";
  batch.source.scope = malicious;
  batch.source.completeness = "full";
  await importData(page, batch);
  await select(page);
  await expect(page.locator("#detailContent")).toContainText(malicious);
  await expect(page.locator("#inspector img")).toHaveCount(0);
  await page.locator("#tab-sources").click();
  await expect(page.locator("#sourceList")).toContainText("未经验证");
  await expect(page.locator("#sourceList")).toContainText(malicious);
  await expect(page.locator("#sourceList img")).toHaveCount(0);
  expect(external).toEqual([]);
});
test("dragging a located node pins it and release restores free layout", async ({
  page,
}) => {
  await importData(page);
  await expect(page.locator("#layoutStatus")).toHaveText("星图布局就绪");
  await select(page);
  await page.locator("#closeInspector").click();
  const rect = await page.locator("#sky").boundingBox(),
    x = rect.x + rect.width / 2,
    y = rect.y + rect.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 55, y - 50, { steps: 8 });
  await page.mouse.up();
  const backup = await download(page, "backupBtn");
  expect(backup.view.positions.find((p) => p.id === "note:a").pinned).toBe(
    true,
  );
  await closeTools(page);
  await select(page);
  await expect(page.locator("#pinNodeBtn")).toHaveText("释放固定");
  await page.locator("#pinNodeBtn").click();
  await expect(page.locator("#pinNodeBtn")).toHaveText("固定位置");
});
test("keyboard graph controls, tabs and reduced motion offer an accessible alternative", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await tools(page);
  await expect(page.locator("#animateLayout")).not.toBeChecked();
  await closeTools(page);
  await page.locator("#sky").focus();
  const zoom = await page.locator("#zoomValue").textContent();
  await page.keyboard.press("+");
  await expect(page.locator("#zoomValue")).not.toHaveText(zoom);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Home");
  await page.locator("#tab-graph").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#tab-list")).toBeFocused();
  await expect(page.locator("#tab-list")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator(".memory-card")).toHaveCount(8);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("the mobile drawer traps focus, closes with Escape, and restores the trigger", async ({
  page,
}) => {
  if (!(await page.locator("#menuBtn").isVisible())) {
    await page.locator("#tab-list").click();
    await expect(page.locator("#panel-list")).toBeVisible();
    return;
  }
  await tools(page);
  await page.locator("#search").focus();
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#clearSaveBtn")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator("#sidebar")).not.toBeVisible();
  await expect(page.locator("#menuBtn")).toBeFocused();
  await expect(page.locator("#mainArea")).not.toHaveAttribute("inert");
});
test("large graphs remain searchable and export all records despite display budgets", async ({
  page,
}) => {
  test.setTimeout(60000);
  const many = Array.from({ length: 10000 }, (_, i) => ({
      id: "large:" + i,
      label: "合成记忆 " + i,
      type: i % 3 ? "memory" : "topic",
    })),
    edges = Array.from({ length: 9999 }, (_, i) => ({
      from: "large:" + i,
      to: "large:" + (i + 1),
      type: "next",
      basis: "rule",
    }));
  await page.locator("#fileInput").setInputFiles({
    name: "large.mgp.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data({ nodes: many, edges }))),
  });
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  await expect(page.locator("#nodeCount")).toHaveText("10,000");
  await tools(page);
  await page.locator("#search").fill("large:9999");
  await expect(page.locator("#searchSummary")).toContainText("找到 1 条");
  await page.locator("#searchResults button").click();
  await expect(page.locator("#detailTitle")).toHaveText("合成记忆 9999");
  const graph = await download(page);
  expect(graph.nodes).toHaveLength(10000);
  expect(graph.edges).toHaveLength(9999);
});

test("bulk pasted JSON avoids wrapping large single lines and remains importable", async ({
  page,
}) => {
  test.setTimeout(60000);
  const nodes = Array.from({ length: 10000 }, (_, i) => ({
    id: "paste:" + i,
    label: "批量记忆 " + i,
    type: "memory",
  }));
  await tools(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    JSON.stringify(data({ nodes, edges: [] })),
  );
  await page.locator("#input").focus();
  await page.keyboard.press("Control+V");
  await expect(page.locator("#importText")).toHaveAttribute("readonly", "");
  await expect(page.locator("#importTextHint")).toContainText("完整原文");
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  await expect(page.locator("#nodeCount")).toHaveText("10,000");
  expect(await page.locator("#input").getAttribute("wrap")).toBe("off");
});

test("another open page pauses autosave and asks before overwriting shared storage", async ({
  page,
  context,
}) => {
  await importData(page);
  await save(page);
  const other = await context.newPage();
  await other.goto("/web/");
  await expect(other.locator("body")).toHaveAttribute("data-ready", "true");
  await tools(other);
  await other.locator("#saveBtn").click();
  await expect(other.locator("#notice")).toContainText("已保存到这个浏览器");
  await tools(page);
  await expect(page.locator("#notice")).toContainText("另一个页面更新");
  await page.locator("#saveBtn").click();
  await expect(page.locator("#confirmTitle")).toHaveText("覆盖另一页面的保存");
  await page.locator("#cancelAction").click();
  await expect(page.locator("#nodeCount")).toHaveText("3");
  await other.close();
});

test("large-document errors locate the original text without editing a truncated batch", async ({
  page,
}) => {
  const nodes = Array.from({ length: 1500 }, (_, i) => ({
    id: "errors:" + i,
    label: "记忆 " + i,
    type: "memory",
  }));
  nodes.at(-1).state = "invalid";
  await page.locator("#fileInput").setInputFiles({
    name: "invalid-large.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(data({ nodes, edges: [] }))),
  });
  await expect(page.locator("#importErrors")).toContainText(
    "nodes[1499].state",
  );
  await page.locator("#importErrors button").first().click();
  await expect(page.locator("#importText")).toHaveValue(/invalid/);
  await expect(page.locator("#importText")).toHaveAttribute("readonly", "");
  await expect(page.locator("#importTextHint")).toContainText("对应完整原文");
  await page.locator("#analyzeImport").click();
  await expect(page.locator("#importErrors")).toContainText(
    "nodes[1499].state",
  );
  await expect(page.locator("#nodeCount")).toHaveText("8");
  await page.locator("#cancelImport").click();
  await importData(page);
  await expect(page.locator("#nodeCount")).toHaveText("3");
});
test("background layout failure leaves the searchable library usable and visible", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const NativeWorker = Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        if (String(url).includes("layout-worker"))
          throw new Error("Unavailable in this test");
        super(url, options);
      }
    };
  });
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await tools(page);
  await expect(page.locator("#notice")).toContainText("不支持后台布局");
  await closeTools(page);
  await expect(page.locator("#layoutStatus")).toHaveText("布局降级");
  await page.locator("#tab-list").click();
  await expect(page.locator(".memory-card")).toHaveCount(8);
});
test("wheel and two-finger gestures change the viewport without changing graph data", async ({
  page,
  isMobile,
}) => {
  await importData(page);
  const before = await page.locator("#zoomValue").textContent(),
    rect = await page.locator("#sky").boundingBox();
  if (isMobile) {
    const session = await page.context().newCDPSession(page),
      y = rect.y + rect.height * 0.45,
      x = rect.x + rect.width / 2;
    await session.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [
        { id: 1, x: x - 30, y },
        { id: 2, x: x + 30, y },
      ],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [
        { id: 1, x: x - 70, y },
        { id: 2, x: x + 70, y },
      ],
    });
    await session.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await session.detach();
  } else {
    await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
    await page.mouse.wheel(0, -160);
  }
  await expect(page.locator("#zoomValue")).not.toHaveText(before);
  await expect(page.locator("#nodeCount")).toHaveText("3");
  expect((await download(page)).edges).toHaveLength(1);
});

test("fit includes valid distant restored positions without discarding pins", async ({
  page,
}) => {
  await importData(page);
  const backup = await download(page, "backupBtn");
  backup.view.positions = backup.graph.nodes.map((node, index) => ({
    id: node.id,
    x: index === 0 ? -1e7 : index === 1 ? 1e7 : 0,
    y: 0,
    pinned: true,
  }));
  await restoreFile(page, backup);
  await expect(page.locator("#confirmRestore")).toBeEnabled();
  await page.locator("#confirmRestore").click();
  await closeTools(page);
  await page.locator("#fitGraph").click();
  await expect(page.locator("#renderStatus")).toContainText("视野内 3 颗星");
  expect(
    (await download(page, "backupBtn")).view.positions.every(
      (position) => position.pinned,
    ),
  ).toBe(true);
});
