import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
const batch = () => ({
  protocol: "mgp/1.1",
  source: { id: "test:topic", platform: "manual", completeness: "partial" },
  nodes: [
    {
      id: "topic:a",
      label: "同名记忆",
      type: "memory",
      content: "算法第一条原文",
      tags: ["算法"],
      state: "inferred",
      source_ref: "doc:a",
    },
    {
      id: "topic:b",
      label: "同名记忆",
      type: "memory",
      content: "另一条原文",
      tags: ["算法"],
      state: "confirmed",
      source_ref: "doc:b",
    },
    {
      id: "topic:c",
      label: "外围主题",
      type: "topic",
      content: "虚构私密邮箱 test@example.invalid",
      source_ref: "doc:c",
    },
    { id: "topic:d", label: "孤立记录", type: "person", content: "虚构人物" },
  ],
  edges: [
    {
      id: "topic:ab",
      from: "topic:a",
      to: "topic:b",
      type: "documented",
      basis: "inferred",
      evidence: "原文的推测关系",
      source_ref: "edge:ab",
    },
    {
      from: "topic:b",
      to: "topic:c",
      type: "link",
      basis: "explicit",
      evidence: "已提供关系",
    },
  ],
});
async function tools(page) {
  if (!(await page.locator("#sidebar").isVisible()))
    await page.locator("#menuBtn").click();
}
async function closeTools(page) {
  if (
    (await page.locator("#menuBtn").isVisible()) &&
    (await page.locator("#sidebar").isVisible())
  )
    await page.locator("#menuBtn").click();
}
async function apply(page, data = batch()) {
  await tools(page);
  await page.locator("#input").fill(JSON.stringify(data));
  await page.locator("#importBtn").click();
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  await closeTools(page);
  await page.locator("#quickSaveBtn").click();
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
}
async function open(page) {
  await closeTools(page);
  await page.locator("#tab-packs").click();
}
async function editor(page) {
  if (!(await page.locator("#packTitle").isVisible()))
    await page.locator("#packEditor summary").click();
}
async function preview(page) {
  await page.locator("#packPreview").click();
  await expect(page.locator("#packSummary")).toContainText("主题选中");
  await expect(page.locator("#packJson")).toBeEnabled();
}
async function configure(page, { keyword = "", tag = "", related = "0" } = {}) {
  await open(page);
  await editor(page);
  await page.locator("#packTitle").fill("虚构测试主题");
  await page.locator("#packKeyword").fill(keyword);
  await page.locator("#packTag").fill(tag);
  await page.locator("#packRelated").selectOption(related);
  await preview(page);
}
async function savePack(page) {
  await page.locator("#packSave").click();
  await expect(page.locator("#confirmText")).toContainText("差异随后归零");
  await page.locator("#confirmAction").click();
  await expect(page.locator("#packStatus")).toContainText("已保存到本机");
  await expect(page.locator("#packDraft")).toContainText("已载入本机配置");
}
async function documents(page) {
  return page.evaluate(async () => {
    const m = await import("./topic-pack-store.mjs"),
      rows = await m.listPacks();
    return Promise.all(rows.map((row) => m.loadPack(row.id)));
  });
}
async function disk(page) {
  return page.evaluate(async () =>
    (await import("./storage.mjs")).loadWorkspace(),
  );
}
async function download(page, format = "json") {
  await page.locator(format === "json" ? "#packJson" : "#packMarkdown").click();
  await expect(page.locator("#confirmText")).toContainText("不会上传");
  const pending = page.waitForEvent("download");
  await page.locator("#confirmAction").click();
  return readFile(await (await pending).path(), "utf8");
}
async function changeFixture(page, graph) {
  await page.evaluate(async (graph) => {
    const { Workspace } = await import("./workspace.mjs"),
      s = await import("./storage.mjs"),
      old = await s.loadWorkspace();
    await s.saveWorkspace(new Workspace(graph).backup(), false, old.revision);
  }, graph);
}
test.beforeEach(async ({ page }) => {
  await page.goto("web/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});
test("full JSON and Markdown preserve raw records and real relations without changing workspace or personal state", async ({
  page,
}) => {
  await apply(page);
  const before = await disk(page);
  await configure(page, { tag: "算法" });
  await expect(page.locator(".pack-node")).toHaveCount(2);
  await expect(page.locator("#packSummary")).toContainText("1 条跨包关系");
  const json = JSON.parse(await download(page));
  expect(json.format).toBe("memory-galaxy/topic-pack/1");
  expect(json.nodes).toEqual(before.backup.graph.nodes.slice(0, 2));
  expect(json.edges).toEqual([before.backup.graph.edges[0]]);
  const md = await download(page, "md");
  expect(md).toContain("算法第一条原文");
  expect(md).toContain('"state": "inferred"');
  expect(md).toContain('"source_ref": "edge:ab"');
  expect(await disk(page)).toEqual(before);
  expect(await documents(page)).toEqual([]);
});
test("manual title selection distinguishes duplicate IDs, removal blocks relation expansion, and readding is explicit", async ({
  page,
}) => {
  await apply(page);
  await configure(page, { keyword: "topic:a", related: "1" });
  await expect(page.locator(".pack-node")).toHaveCount(2);
  await page.locator('.pack-node[data-node-id="topic:b"] .pack-remove').click();
  await expect(page.locator(".pack-node")).toHaveCount(1);
  await editor(page);
  await page.locator("#packAddNode").fill("同名");
  await expect(page.locator("#packAddNodeResults button")).toHaveCount(2);
  await page
    .locator('#packAddNodeResults button[data-node-id="topic:b"]')
    .click();
  await page.locator("#packAdd").click();
  await expect(page.locator(".pack-node")).toHaveCount(3);
  const json = JSON.parse(await download(page));
  expect(new Set(json.nodes.map((n) => n.id)).size).toBe(3);
});
test("workspace filter capture uses shared search, type and state semantics", async ({
  page,
}) => {
  await apply(page);
  await tools(page);
  await page.locator("#search").fill("算法");
  await page.locator("#stateFilter").selectOption("inferred");
  await closeTools(page);
  await open(page);
  await page.locator("#packTitle").fill("当前筛选");
  await page.locator("#packCopyFilters").click();
  await expect(page.locator("#packKeyword")).toHaveValue("算法");
  await expect(page.locator("#packState")).toHaveValue("inferred");
  await preview(page);
  await expect(page.locator(".pack-node")).toHaveCount(1);
});
test("configuration and hashed baseline persist separately through refresh and do not enter backups", async ({
  page,
}) => {
  await apply(page);
  const before = await disk(page);
  await configure(page, { tag: "算法" });
  await savePack(page);
  const [saved] = await documents(page);
  expect(saved.baseline.nodes).toHaveLength(2);
  expect(JSON.stringify(saved.baseline)).not.toContain("第一条原文");
  await page.reload();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#packTitle")).toHaveValue("虚构测试主题");
  await expect(page.locator("#packTag")).toHaveValue("算法");
  await expect(page.locator("#packSaved")).toHaveValue(saved.id);
  await preview(page);
  await expect(page.locator("#packDiffSummary")).toContainText(
    "记忆 新增 0 / 修改 0 / 移出 0",
  );
  expect(await disk(page)).toEqual(before);
});
test("same-ID edits through the existing editor produce a delta and saving explicitly advances its baseline", async ({
  page,
}) => {
  await apply(page);
  await configure(page, { tag: "算法" });
  await savePack(page);
  await preview(page);
  await page
    .locator('.pack-node[data-node-id="topic:a"] .health-node button')
    .click();
  await page.locator("#editNodeBtn").click();
  await page.locator("#nodeLabel").fill("改名后记录");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await page.locator("#quickSaveBtn").click();
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
  await open(page);
  await preview(page);
  await expect(page.locator("#packDiffSummary")).toContainText(
    "记忆 新增 0 / 修改 1 / 移出 0",
  );
  await page.locator("#packOutputMode").selectOption("delta");
  await expect(page.locator(".pack-node")).toHaveCount(1);
  const p = JSON.parse(await download(page));
  expect(p.nodes.modified[0].id).toBe("topic:a");
  expect(p.nodes.modified[0].label).toBe("改名后记录");
  expect(p.nodes.added).toEqual([]);
  const old = (await documents(page))[0];
  expect(old.revision).toBe(1);
  await savePack(page);
  await preview(page);
  await expect(page.locator("#packDiffSummary")).toContainText(
    "记忆 新增 0 / 修改 0 / 移出 0",
  );
});
test("relation-only delta preview contains the exact unchanged endpoint contexts and no other memories", async ({
  page,
}) => {
  await apply(page);
  await configure(page);
  await savePack(page);
  const g = (await disk(page)).backup.graph;
  g.edges[0].evidence = "更新原有依据";
  await changeFixture(page, g);
  await page.reload();
  await expect(page.locator("#packTitle")).toHaveValue("虚构测试主题");
  await preview(page);
  await page.locator("#packOutputMode").selectOption("delta");
  await expect(page.locator(".pack-node")).toHaveCount(2);
  await expect(page.locator("#packSummary")).toContainText("端点上下文 2 条");
  const p = JSON.parse(await download(page));
  expect(p.nodes.modified).toEqual([]);
  expect(p.context_nodes.map((n) => n.id)).toEqual(["topic:a", "topic:b"]);
  expect(p.edges.modified[0].id).toBe("topic:ab");
});
test("source and sensitivity checks are visible and export always requires confirmation", async ({
  page,
}) => {
  const g = batch();
  g.source.platform = "test";
  delete g.nodes[0].source_ref;
  await apply(page, g);
  await configure(page);
  await page.locator("#packKind").selectOption("warnings");
  await expect(page.locator("#packResults")).toContainText("邮箱格式");
  await expect(page.locator("#packResults")).toContainText("没有可定位原文");
  await page.locator("#packJson").click();
  await expect(page.locator("#confirmText")).toContainText("敏感线索");
  await expect(page.locator("#confirmText")).toContainText("主题包以明文保存");
  await page.locator("#cancelAction").click();
  await expect(page.locator("#packStatus")).not.toContainText("已发起文件下载");
});
test("quota failure preserves draft, old baseline and workspace until explicit retry succeeds", async ({
  page,
}) => {
  await apply(page);
  await configure(page);
  await savePack(page);
  const [saved] = await documents(page),
    before = await disk(page);
  await editor(page);
  await page.locator("#packTitle").fill("未写入的新名称");
  await preview(page);
  await page.evaluate(() => {
    window.packOriginalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "packs")
        throw new DOMException("test quota", "QuotaExceededError");
      return window.packOriginalPut.apply(this, args);
    };
  });
  await page.locator("#packSave").click();
  await page.locator("#confirmAction").click();
  await expect(page.locator("#packStatus")).toContainText("保存失败");
  await expect(page.locator("#packDraft")).toContainText("未保存修改");
  expect((await documents(page))[0]).toEqual(saved);
  expect(await disk(page)).toEqual(before);
  await page.evaluate(
    () => (IDBObjectStore.prototype.put = window.packOriginalPut),
  );
  await savePack(page);
  expect((await documents(page))[0].config.title).toBe("未写入的新名称");
});
test("save feedback waits for transaction commit, prevents duplicates and guards refresh", async ({
  page,
}) => {
  await apply(page);
  await configure(page);
  await savePack(page);
  await preview(page);
  await page.evaluate(() => {
    window.holdPack = true;
    window.packPuts = 0;
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const r = original.apply(this, args);
      if (this.name === "packs") {
        window.packPuts++;
        const keep = () => {
          const read = this.get("hold");
          read.onsuccess = () => {
            if (window.holdPack) keep();
          };
        };
        keep();
      }
      return r;
    };
  });
  try {
    await page.locator("#packSave").click();
    await page.locator("#confirmAction").click();
    await expect(page.locator("#packStatus")).toContainText("正在写入");
    await expect(page.locator("#packSave")).toBeDisabled();
    expect(
      await page.evaluate(() => {
        const e = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      }),
    ).toBe(true);
    await expect.poll(() => page.evaluate(() => window.packPuts)).toBe(1);
  } finally {
    await page.evaluate(() => (window.holdPack = false));
  }
  await expect(page.locator("#packStatus")).toContainText("已保存到本机");
  expect(await documents(page)).toHaveLength(1);
});
test("two tabs cannot silently overwrite a newer saved configuration", async ({
  page,
  context,
}) => {
  await apply(page);
  await configure(page);
  await savePack(page);
  const [saved] = await documents(page),
    other = await context.newPage();
  try {
    await other.goto("web/");
    await expect(other.locator("body")).toHaveAttribute("data-ready", "true");
    await open(other);
    await other.locator("#packSaved").selectOption(saved.id);
    await other.locator("#packLoad").click();
    await expect(other.locator("#packTitle")).toHaveValue(saved.config.title);
    await editor(other);
    await other.locator("#packTitle").fill("另一标签页名称");
    await preview(other);
    await savePack(other);
    await editor(page);
    await page.locator("#packTitle").fill("旧标签页草稿");
    await preview(page);
    await page.locator("#packSave").click();
    await page.locator("#confirmAction").click();
    await expect(page.locator("#packStatus")).toContainText("未覆盖其修改");
    expect((await documents(page))[0].config.title).toBe("另一标签页名称");
  } finally {
    await other.close();
  }
});
test("discard and deletion require explicit choices and deleted configurations cannot be resurrected by stale revisions", async ({
  page,
}) => {
  await apply(page);
  await configure(page);
  await savePack(page);
  const [saved] = await documents(page);
  await editor(page);
  await page.locator("#packTitle").fill("未保存草稿");
  await page.locator("#packNew").click();
  await expect(page.locator("#confirmText")).toContainText("未保存修改");
  await page.locator("#cancelAction").click();
  await expect(page.locator("#packTitle")).toHaveValue("未保存草稿");
  await page.locator("#packDelete").click();
  await page.locator("#cancelAction").click();
  expect(await documents(page)).toHaveLength(1);
  await page.locator("#packDelete").click();
  await page.locator("#confirmAction").click();
  await expect(page.locator("#packStatus")).toContainText("配置已删除");
  expect(await documents(page)).toEqual([]);
  expect(
    await page.evaluate(async (old) => {
      try {
        await (
          await import("./topic-pack-store.mjs")
        ).writePack({
          id: old.id,
          config: old.config,
          baseline: old.baseline,
          expectedRevision: old.revision,
        });
        return "unexpected";
      } catch (e) {
        return e.message;
      }
    }, saved),
  ).toContain("未覆盖");
});
test("corrupt saved configurations fail closed and worker failure cannot enable stale export", async ({
  page,
}) => {
  await apply(page);
  await configure(page);
  await savePack(page);
  const [saved] = await documents(page);
  await page.evaluate(
    async (id) =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open("memory-galaxy-topic-packs", 1);
        req.onsuccess = () => {
          const db = req.result,
            tx = db.transaction("packs", "readwrite");
          tx.objectStore("packs").put({ schema: 9, id });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = reject;
        };
      }),
    saved.id,
  );
  await page.locator("#packSaved").selectOption(saved.id);
  await page.locator("#packLoad").click();
  await expect(page.locator("#packStatus")).toContainText("载入失败");
  await page.evaluate(() => {
    const Native = window.Worker;
    window.Worker = function (url, opts) {
      if (String(url).includes("topic-pack-worker"))
        throw new Error("test worker failure");
      return new Native(url, opts);
    };
  });
  await page.locator("#packPreview").click();
  await expect(page.locator("#packStatus")).toContainText("无法预览");
  await expect(page.locator("#packJson")).toBeDisabled();
  await expect(page.locator("#nodeCount")).toHaveText("4");
});
test("ten thousand local memories render bounded pages without requests leaving the project origin", async ({
  page,
  baseURL,
}) => {
  const escaped = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (
      ["http:", "https:"].includes(u.protocol) &&
      u.origin !== new URL(baseURL).origin
    )
      escaped.push(u.href);
  });
  const g = batch();
  g.edges = [];
  g.nodes = Array.from({ length: 10000 }, (_, i) => ({
    id: "bulk:" + i,
    label: "虚构同名",
    type: "memory",
    content: "测试 " + i,
    tags: ["批量"],
  }));
  await apply(page, g);
  await configure(page, { tag: "批量" });
  await expect(page.locator("#packSummary")).toContainText("10,000");
  await expect(page.locator(".pack-node")).toHaveCount(12);
  await page.locator("#packNext").click();
  await expect(
    page.locator('.pack-node[data-node-id="bulk:12"]'),
  ).toBeVisible();
  expect(escaped).toEqual([]);
});
for (const size of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 1365, height: 900 },
])
  test(`topic pack flow works at ${size.width}x${size.height} simulated viewport`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    const g = batch();
    g.nodes[0].content = '<img src=x onerror="alert(1)">\n```\n保留原文';
    await apply(page, g);
    await configure(page, { tag: "算法" });
    await expect(page.locator("#packResults img")).toHaveCount(0);
    await expect(page.locator("#packResults")).toContainText("<img");
    await download(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page.locator("#quickSaveBtn").evaluate((b) => {
        const r = b.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
      }),
    ).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("topic-pack.png") });
  });
test("a topic result delayed beyond a graph switch cannot restore stale export buttons", async ({
  page,
}) => {
  await apply(page);
  await configure(page);
  await page.evaluate(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(url, options) {
        super(url, options);
        if (!String(url).includes("topic-pack-worker")) return;
        let handler;
        Object.defineProperty(this, "onmessage", {
          set(value) {
            handler = value;
          },
        });
        this.addEventListener("message", (event) => {
          const captured = handler;
          window.deliverTopic = () => captured?.(event);
          window.topicReceived = true;
        });
      }
    };
  });
  await page.locator("#packPreview").click();
  await expect.poll(() => page.evaluate(() => window.topicReceived)).toBe(true);
  await tools(page);
  await page.locator("#newWorkspaceBtn").click();
  await page.locator("#confirmAction").click();
  await closeTools(page);
  await expect(page.locator("#nodeCount")).toHaveText("0");
  await open(page);
  await page.evaluate(() => window.deliverTopic());
  await expect(page.locator("#packJson")).toBeDisabled();
  await expect(page.locator(".pack-node")).toHaveCount(0);
  await expect(page.locator("#packSummary")).toContainText("工作区已变化");
});
