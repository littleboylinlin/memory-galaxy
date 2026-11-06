import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { syntheticGraph } from "../fixtures/synthetic.mjs";
import { stringifyMgp } from "../../web/mgp.mjs";
const batch = () => ({
  protocol: "mgp/1.1",
  source: { id: "test:insights", completeness: "partial" },
  nodes: [
    {
      id: "review:a",
      label: "同名记忆",
      type: "memory",
      content: "第一条旧正文",
      updated_at: "2000-01-01T00:00:00Z",
      state: "confirmed",
      source_ref: "document:a",
    },
    {
      id: "review:b",
      label: "同名记忆",
      type: "memory",
      content: "第二条旧正文",
      updated_at: "2001-01-01T00:00:00Z",
      state: "inferred",
      source_ref: "document:b",
    },
    {
      id: "review:c",
      label: "独立记录",
      type: "topic",
      content: "无引用的旧记录",
      updated_at: "2002-01-01T00:00:00Z",
      state: "unknown",
    },
    {
      id: "review:undated",
      label: "没有提供时间",
      type: "memory",
      content: "不应假装是旧记忆",
      source_ref: "document:undated",
    },
    {
      id: "review:future",
      label: "未来时间",
      type: "memory",
      updated_at: "2099-01-01T00:00:00Z",
      source_ref: "document:future",
    },
  ],
  edges: [
    {
      id: "review:edge",
      from: "review:a",
      to: "review:c",
      type: "documented_link",
      basis: "inferred",
      evidence: "原文明确标注这是推测",
      source_ref: "relation:original",
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
async function apply(page, value = batch()) {
  await tools(page);
  await page
    .locator("#input")
    .fill(typeof value === "string" ? value : JSON.stringify(value));
  await page.locator("#importBtn").click();
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  await closeTools(page);
}
async function save(page) {
  await page.locator("#quickSaveBtn").click();
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
}
async function open(page, kind) {
  await closeTools(page);
  await page.locator("#tab-" + kind).click();
  await expect(page.locator("#panel-" + kind)).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function mode(page, value) {
  await page.locator("#reviewMode").selectOption(value);
  await expect(page.locator("#panel-review")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
const card = (page, id) => page.locator(`.review-card[data-node-id="${id}"]`);
async function rows(page) {
  return page.evaluate(async () =>
    (await import("./review-state.mjs")).loadReviewRecords(),
  );
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
  return JSON.parse(await readFile(await (await pending).path(), "utf8"));
}
test.beforeEach(async ({ page }) => {
  await page.goto("web/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("review reasons and health findings are traceable and read-only", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  const before = await disk(page);
  await open(page, "review");
  await expect(page.locator(".review-card")).toHaveCount(3);
  await expect(card(page, "review:a")).toContainText("2000-01-01T00:00:00Z");
  await expect(card(page, "review:a")).toContainText("不代表事情发生时间");
  await expect(card(page, "review:a")).toContainText("document:a");
  await card(page, "review:a").locator(".review-relations summary").click();
  await expect(
    card(page, "review:a").locator(".review-relations"),
  ).toContainText("review:c");
  await expect(
    card(page, "review:a").locator(".review-relations"),
  ).toContainText("推测（声明）");
  await expect(
    card(page, "review:a").locator(".review-relations"),
  ).toContainText("relation:original");
  expect(await rows(page)).toEqual([]);
  await open(page, "health");
  await expect(page.locator('[data-category="duplicates"]')).toContainText(
    "1 组线索",
  );
  await expect(page.locator('[data-category="isolated"]')).toContainText(
    "3 条",
  );
  await expect(page.locator('[data-category="sources"]')).toContainText("1 条");
  await expect(page.locator('[data-category="stale"]')).toContainText("2 条");
  await expect(page.locator("#healthSummary")).toContainText(
    "1 条缺少可用更新时间、1 条时间晚于本机时钟",
  );
  await page.locator(".duplicate-members summary").click();
  await expect(page.locator(".health-node")).toHaveCount(2);
  await expect(page.locator(".health-node")).toContainText([
    "review:a",
    "review:b",
  ]);
  expect(await disk(page)).toEqual(before);
  expect(await rows(page)).toEqual([]);
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
});
test("favorite, skip, review and reset persist independently by stable ID across refresh", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  const before = await disk(page);
  await open(page, "review");
  await card(page, "review:a")
    .getByRole("button", { name: "收藏", exact: true })
    .click();
  await expect(
    card(page, "review:a").getByRole("button", {
      name: "取消收藏",
      exact: true,
    }),
  ).toBeVisible();
  await card(page, "review:b")
    .getByRole("button", { name: "跳过7天", exact: true })
    .click();
  await expect(card(page, "review:b")).toHaveCount(0);
  await card(page, "review:a")
    .getByRole("button", { name: "已回顾", exact: true })
    .click();
  await expect(card(page, "review:a")).toHaveCount(0);
  await mode(page, "favorites");
  await expect(card(page, "review:a")).toBeVisible();
  await mode(page, "reviewed");
  await expect(card(page, "review:a")).toBeVisible();
  await mode(page, "skipped");
  await expect(card(page, "review:b")).toBeVisible();
  await page.reload();
  await expect(page.locator("#tab-review")).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.locator("#reviewMode")).toHaveValue("skipped");
  await expect(card(page, "review:b")).toBeVisible();
  const saved = await rows(page);
  expect(saved.find((row) => row.id === "review:a")).toMatchObject({
    favorite: true,
    reviewed: { fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/) },
  });
  expect(saved.find((row) => row.id === "review:b").skipped).toBeTruthy();
  await card(page, "review:b")
    .getByRole("button", { name: "重新待回顾", exact: true })
    .click();
  await mode(page, "due");
  await expect(card(page, "review:b")).toBeVisible();
  expect(await disk(page)).toEqual(before);
  expect((await exported(page)).nodes.map((n) => n.id)).toEqual(
    before.backup.graph.nodes.map((n) => n.id),
  );
});
test("status feedback waits for commit and a pending status write protects refresh", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  await open(page, "review");
  await page.evaluate(() => {
    window.holdReview = true;
    window.reviewPuts = 0;
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const request = put.apply(this, args);
      if (this.name === "records") {
        window.reviewPuts++;
        const keepAlive = () => {
          const read = this.get("test:hold");
          read.onsuccess = () => {
            if (window.holdReview) keepAlive();
          };
        };
        keepAlive();
      }
      return request;
    };
  });
  try {
    await card(page, "review:a")
      .getByRole("button", { name: "收藏", exact: true })
      .click();
    await expect(page.locator("#reviewStatus")).toHaveText("正在保存回顾状态…");
    await expect(
      card(page, "review:a").getByRole("button", { name: "收藏", exact: true }),
    ).toBeDisabled();
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(true);
    expect(await page.evaluate(() => window.reviewPuts)).toBe(1);
  } finally {
    await page.evaluate(() => (window.holdReview = false));
  }
  await expect(page.locator("#reviewStatus")).toContainText("已保存到此浏览器");
  expect((await rows(page))[0].favorite).toBe(true);
  await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");
});
test("quota failure retains prior status and memory until an explicit retry succeeds", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  const before = await disk(page);
  await open(page, "review");
  await card(page, "review:a")
    .getByRole("button", { name: "收藏", exact: true })
    .click();
  await expect(
    card(page, "review:a").getByRole("button", {
      name: "取消收藏",
      exact: true,
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.originalReviewPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.name === "records")
        throw new DOMException("test quota", "QuotaExceededError");
      return window.originalReviewPut.apply(this, args);
    };
  });
  await card(page, "review:a")
    .getByRole("button", { name: "取消收藏", exact: true })
    .click();
  await expect(page.locator("#reviewStatus")).toContainText(
    "保存失败，操作未应用",
  );
  await expect(
    card(page, "review:a").getByRole("button", {
      name: "取消收藏",
      exact: true,
    }),
  ).toBeVisible();
  expect((await rows(page))[0].favorite).toBe(true);
  expect(await disk(page)).toEqual(before);
  await page.evaluate(
    () => (IDBObjectStore.prototype.put = window.originalReviewPut),
  );
  await card(page, "review:a")
    .getByRole("button", { name: "取消收藏", exact: true })
    .click();
  await expect(
    card(page, "review:a").getByRole("button", { name: "收藏", exact: true }),
  ).toBeVisible();
  expect((await rows(page))[0].favorite).toBe(false);
});
test("two tabs merge unrelated status fields without replacing each other's changes", async ({
  page,
  context,
}) => {
  await apply(page);
  await save(page);
  await open(page, "review");
  const other = await context.newPage();
  await other.addInitScript(() => {
    window.BroadcastChannel = class {
      postMessage() {}
      close() {}
    };
  });
  await other.goto("web/");
  await expect(other.locator("body")).toHaveAttribute("data-ready", "true");
  await open(other, "review");
  await card(page, "review:a")
    .getByRole("button", { name: "收藏", exact: true })
    .click();
  await expect(
    card(page, "review:a").getByRole("button", {
      name: "取消收藏",
      exact: true,
    }),
  ).toBeVisible();
  await card(other, "review:a")
    .getByRole("button", { name: "已回顾", exact: true })
    .click();
  await expect(card(other, "review:a")).toHaveCount(0);
  const state = (await rows(page)).find((row) => row.id === "review:a");
  expect(state.favorite).toBe(true);
  expect(state.reviewed).toBeTruthy();
  await page.locator("#refreshReview").click();
  await expect(card(page, "review:a")).toHaveCount(0);
  await other.close();
});
test("new relationship data re-enables a reviewed version without changing any IDs", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  await open(page, "review");
  await card(page, "review:a")
    .getByRole("button", { name: "已回顾", exact: true })
    .click();
  await expect(card(page, "review:a")).toHaveCount(0);
  const delta = {
    protocol: "mgp/1.1",
    source: batch().source,
    nodes: [],
    edges: [
      {
        id: "review:new-edge",
        from: "review:b",
        to: "review:a",
        type: "documented",
        basis: "explicit",
        evidence: "新批次真实提供的依据",
      },
    ],
  };
  await apply(page, delta);
  await open(page, "review");
  await expect(card(page, "review:a")).toBeVisible();
  await expect(card(page, "review:a")).toContainText("上次回顾版本不同");
  const graph = await exported(page);
  expect(graph.nodes.map((n) => n.id)).toEqual(batch().nodes.map((n) => n.id));
  expect(graph.edges.map((e) => e.id)).toEqual([
    "review:edge",
    "review:new-edge",
  ]);
});
test("corrupt personal records fail closed, health still works, and clearing requires confirmation", async ({
  page,
}) => {
  await apply(page);
  await save(page);
  const before = await disk(page);
  await rows(page);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open("memory-galaxy-review", 1);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction("records", "readwrite");
          tx.objectStore("records").put({
            id: "review:a",
            schema: 9,
            favorite: true,
          });
          tx.oncomplete = () => {
            db.close();
            resolve();
          };
          tx.onerror = reject;
        };
      }),
  );
  await open(page, "review");
  await expect(page.locator("#reviewSummary")).toContainText(
    "无法读取回顾状态",
  );
  await expect(page.locator(".review-card")).toHaveCount(0);
  await open(page, "health");
  await expect(page.locator("#healthSummary")).toContainText("检查 5 条记忆");
  await open(page, "review");
  await page.locator("#clearReviews").click();
  await page.locator("#cancelAction").click();
  await expect(page.locator("#reviewSummary")).toContainText("无法读取");
  await page.locator("#clearReviews").click();
  await expect(page.locator("#confirmText")).toContainText("全部收藏");
  await page.locator("#confirmAction").click();
  await expect(page.locator("#reviewStatus")).toContainText("回顾状态已清除");
  await expect(page.locator(".review-card")).toHaveCount(3);
  expect(await rows(page)).toEqual([]);
  expect(await disk(page)).toEqual(before);
});
test("worker failure and results delayed past a workspace change never apply stale recommendations", async ({
  page,
}) => {
  await apply(page);
  await page.evaluate(() => {
    window.NativeInsightsWorker = Worker;
    window.Worker = class extends window.NativeInsightsWorker {
      constructor(url, options) {
        if (String(url).includes("insights-worker"))
          throw new Error("test worker blocked");
        super(url, options);
      }
    };
  });
  await open(page, "review");
  await expect(page.locator("#reviewSummary")).toContainText(
    "无法启动本地分析",
  );
  await page.evaluate(() => {
    window.Worker = class extends window.NativeInsightsWorker {
      constructor(url, options) {
        super(url, options);
        this.delayInsights = String(url).includes("insights-worker");
      }
      postMessage(data) {
        if (!this.delayInsights) return super.postMessage(data);
        window.pendingInsightsGraphSize = data.graph.nodes.length;
        window.deliverOldInsights = async () => {
          const { reviewPage } = await import("./memory-insights.mjs");
          this.onmessage?.({
            data: {
              id: data.id,
              ok: true,
              result: await reviewPage(data.graph, data.options),
            },
          });
        };
      }
    };
  });
  await page.locator("#refreshReview").click();
  await expect(page.locator("#panel-review")).toHaveAttribute(
    "aria-busy",
    "true",
  );
  await expect
    .poll(() => page.evaluate(() => typeof window.deliverOldInsights))
    .toBe("function");
  await page.evaluate(
    () => (window.savedOldInsights = window.deliverOldInsights),
  );
  await tools(page);
  await page.locator("#newWorkspaceBtn").click();
  await page.locator("#confirmAction").click();
  await closeTools(page);
  await expect(page.locator("#nodeCount")).toHaveText("0");
  await expect
    .poll(() => page.evaluate(() => window.pendingInsightsGraphSize))
    .toBe(0);
  await page.evaluate(() => window.savedOldInsights());
  await expect(page.locator(".review-card")).toHaveCount(0);
  await page.evaluate(() => window.deliverOldInsights());
  await expect(page.locator("#reviewSummary")).toContainText(
    "0 条符合当前筛选",
  );
});
test("large health groups paginate members and all analysis stays inside the project origin", async ({
  page,
  baseURL,
}) => {
  const escaped = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin !== new URL(baseURL).origin
    )
      escaped.push(url.href);
  });
  const value = batch();
  value.edges = [];
  value.nodes = Array.from({ length: 10000 }, (_, i) => ({
    id: "large:" + String(i).padStart(5, "0"),
    label: "重复标题",
    type: "memory",
    content: "正文 " + i,
    source_ref: "doc:" + i,
    updated_at: "2000-01-01T00:00:00Z",
  }));
  await apply(page, value);
  await open(page, "health");
  await expect(page.locator("#healthSummary")).toContainText("10,000 条记忆");
  await expect(page.locator('[data-category="duplicates"]')).toContainText(
    "1 组线索",
  );
  await page.locator(".duplicate-members summary").click();
  await expect(page.locator(".health-node")).toHaveCount(5);
  await expect(
    page.locator('.health-node[data-node-id="large:00000"]'),
  ).toBeVisible();
  await page.getByRole("button", { name: "下一组成员", exact: true }).click();
  await expect(
    page.locator('.health-node[data-node-id="large:00005"]'),
  ).toBeVisible();
  await open(page, "review");
  await expect(page.locator(".review-card")).toHaveCount(6);
  await expect(page.locator("#reviewSummary")).toContainText("10,000 条符合");
  expect(escaped).toEqual([]);
});
test("multi-source JSONL data retains every record and edge after a personal action", async ({
  page,
}) => {
  await apply(page, stringifyMgp(syntheticGraph(), "jsonl"));
  await save(page);
  const original = (await disk(page)).backup.graph;
  await open(page, "review");
  await expect(page.locator("#reviewSummary")).toContainText(
    "402 条无可用更新时间",
  );
  await expect(page.locator(".review-card")).toHaveCount(0);
  await mode(page, "undated");
  await expect(page.locator(".review-card")).toHaveCount(6);
  const first = page.locator(".review-card").first();
  await first.getByRole("button", { name: "收藏", exact: true }).click();
  await expect(
    first.getByRole("button", { name: "取消收藏", exact: true }),
  ).toBeVisible();
  expect(await exported(page)).toEqual(original);
});
for (const size of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 1365, height: 900 },
]) {
  test(`review and health remain usable at ${size.width}x${size.height} simulated viewport`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize(size);
    const data = batch();
    data.nodes[0].content = '<img src=x onerror="alert(1)">';
    await apply(page, data);
    await open(page, "review");
    await expect(card(page, "review:a")).toContainText("<img");
    await expect(page.locator("#reviewCards img")).toHaveCount(0);
    await card(page, "review:a")
      .getByRole("button", { name: "收藏", exact: true })
      .click();
    await expect(
      card(page, "review:a").getByRole("button", {
        name: "取消收藏",
        exact: true,
      }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("review.png") });
    await open(page, "health");
    await page.locator(".duplicate-members summary").click();
    await expect(page.locator(".health-node")).toHaveCount(2);
    await page.screenshot({ path: testInfo.outputPath("health.png") });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      await page.locator("#quickSaveBtn").evaluate((button) => {
        const r = button.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
      }),
    ).toBe(true);
    await page
      .locator('.health-node[data-node-id="review:b"]')
      .getByRole("button", { name: "查看并核对", exact: true })
      .click();
    await expect(page.locator("#detailMeta")).toContainText("review:b");
    await page.locator("#editNodeBtn").click();
    await expect(page.locator("#nodeId")).toHaveValue("review:b");
  });
}
