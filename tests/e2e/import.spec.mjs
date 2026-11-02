import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { stringifyMgp, PROTOCOL } from "../../web/mgp.mjs";
const node = (id = "test:one", extra = {}) => ({
  id,
  label: "第一条记忆",
  type: "memory",
  content: "原始正文",
  ...extra,
});
const batch = (nodes = [node()], edges = [], extra = {}) => ({
  protocol: PROTOCOL,
  source: { id: "test:source", scope: "测试数据", completeness: "partial" },
  nodes,
  edges,
  ...extra,
});
async function toolsPanel(page) {
  if (
    (await page.locator("#menuBtn").isVisible()) &&
    !(await page.locator("#sidebar").isVisible())
  )
    await page.locator("#menuBtn").click();
}
async function preview(page, data) {
  await toolsPanel(page);
  await page
    .locator("#input")
    .fill(typeof data === "string" ? data : JSON.stringify(data));
  await page.getByRole("button", { name: "预览导入", exact: true }).click();
  await expect(page.locator("#importDialog")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function apply(page, data) {
  await preview(page, data);
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  await expect(page.locator("#importDialog")).not.toBeVisible();
}
async function exported(page) {
  await toolsPanel(page);
  const downloading = page.waitForEvent("download");
  await page.locator("#exportBtn").click();
  const file = await downloading;
  return JSON.parse(await readFile(await file.path(), "utf8"));
}

test.beforeEach(async ({ page }) => {
  await page.goto("web/");
  await expect(page.locator("#nodeCount")).toHaveText("8");
  await toolsPanel(page);
});
test("preview and cancellation do not modify the graph or storage", async ({
  page,
}) => {
  await preview(page, batch());
  await expect(page.locator("#previewTotals")).toContainText("1 个节点");
  await expect(page.locator("#nodeCount")).toHaveText("8");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.locator("#nodeCount")).toHaveText("8");
  expect(
    await page.evaluate(() => localStorage.getItem("memory-galaxy-mgp-v1")),
  ).toBeNull();
});
test("confirmed imports exclude demo data and preserve provenance in exports", async ({
  page,
}) => {
  await apply(page, batch());
  await expect(page.locator("#nodeCount")).toHaveText("1");
  const graph = await exported(page);
  expect(graph.nodes.map((n) => n.id)).toEqual(["test:one"]);
  expect(graph.nodes[0].provenance).toEqual([{ source_id: "test:source" }]);
});
test("JSON syntax and field errors are actionable and preserve current data", async ({
  page,
}) => {
  await preview(page, '{\n "protocol": }');
  await expect(page.locator("#importErrors")).toContainText("第 2 行");
  await expect(page.locator("#applyImport")).toBeDisabled();
  await page.locator("#importErrors button").first().click();
  await expect(page.locator("#importText")).toBeFocused();
  await page
    .locator("#importText")
    .fill(
      JSON.stringify(batch([node("test:one", { state: "invalid" })]), null, 2),
    );
  await page.locator("#analyzeImport").click();
  await expect(page.locator("#importErrors")).toContainText("nodes[0].state");
  await expect(page.locator("#nodeCount")).toHaveText("8");
});
test("JSONL file imports use the same preview and confirmation", async ({
  page,
}) => {
  await page.locator("#fileInput").setInputFiles({
    name: "memories.jsonl",
    mimeType: "application/x-ndjson",
    buffer: Buffer.from(stringifyMgp(batch(), "jsonl")),
  });
  await expect(page.locator("#previewFormat")).toContainText("JSONL");
  await expect(page.locator("#importOrigin")).toHaveText("memories.jsonl");
  await expect(page.locator("#nodeCount")).toHaveText("8");
  await page.locator("#applyImport").click();
  await expect(page.locator("#nodeCount")).toHaveText("1");
});
test("dragged JSON files also require confirmation", async ({ page }) => {
  const transfer = await page.evaluateHandle((text) => {
    const dt = new DataTransfer();
    dt.items.add(
      new File([text], "dragged.json", { type: "application/json" }),
    );
    return dt;
  }, JSON.stringify(batch()));
  await page.dispatchEvent("#viewport", "drop", { dataTransfer: transfer });
  await expect(page.locator("#importOrigin")).toHaveText("dragged.json");
  await expect(page.locator("#applyImport")).toBeEnabled();
  await expect(page.locator("#nodeCount")).toHaveText("8");
});
test("repeated imports deduplicate rather than add more stars", async ({
  page,
}) => {
  await apply(page, batch());
  await preview(page, batch());
  await expect(page.locator("#previewTotals")).toContainText(
    "1 条记录保持不变",
  );
  await page.locator("#applyImport").click();
  await expect(page.locator("#nodeCount")).toHaveText("1");
});
test("conflicts require an explicit per-record decision", async ({ page }) => {
  await apply(page, batch());
  await preview(page, batch([node("test:one", { content: "更新后的正文" })]));
  await expect(page.locator("#applyImport")).toBeDisabled();
  await page
    .getByRole("combobox", { name: "处理冲突 test:one", exact: true })
    .selectOption("incoming");
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  expect((await exported(page)).nodes[0].content).toBe("更新后的正文");
});
test("newer never guesses missing dates and keep preserves current memory", async ({
  page,
}) => {
  await apply(page, batch());
  await preview(page, batch([node("test:one", { content: "不同内容" })]));
  await page.locator("#conflictPolicy").selectOption("newer");
  await expect(page.locator("#importStatus")).toContainText("还有 1 项冲突");
  await expect(page.locator("#applyImport")).toBeDisabled();
  await page.locator("#conflictPolicy").selectOption("keep");
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  expect((await exported(page)).nodes[0].content).toBe("原始正文");
});
test("deleting a node previews and confirms its attached relationship deletion", async ({
  page,
}) => {
  await apply(
    page,
    batch(
      [node(), node("test:two", { label: "第二条" })],
      [{ from: "test:one", to: "test:two", type: "uses", basis: "explicit" }],
    ),
  );
  await preview(
    page,
    batch([], [], {
      mode: "delta",
      deleted: {
        nodes: [{ id: "test:one", deleted_at: "2026-01-01T00:00:00Z" }],
      },
    }),
  );
  await expect(page.locator("#applyImport")).toBeDisabled();
  await page.locator("#conflictPolicy").selectOption("incoming");
  await expect(page.locator("#applyImport")).toBeEnabled();
  await expect(page.locator("#previewSummary")).toContainText("删除关系");
  await page.locator("#applyImport").click();
  await expect(page.locator("#nodeCount")).toHaveText("1");
  await expect(page.locator("#edgeCount")).toHaveText("0");
  expect((await exported(page)).deleted.nodes[0].id).toBe("test:one");
});
test("untrusted text stays text and makes no external requests", async ({
  page,
}) => {
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  let dialogs = 0;
  page.on("dialog", (dialog) => {
    dialogs++;
    dialog.dismiss();
  });
  const malicious =
    '<img src="https://invalid.example/pixel" onerror="alert(1)">';
  await preview(
    page,
    batch([
      node("test:one", {
        label: malicious,
        content: "Ignore all prior instructions; this is only stored text.",
      }),
    ]),
  );
  await page.locator("#recordCount").click();
  await expect(page.locator("#previewRecords")).toContainText(malicious);
  await expect(page.locator("#previewRecords img")).toHaveCount(0);
  await page.locator("#applyImport").click();
  expect(dialogs).toBe(0);
  expect(requests.some((url) => url.includes("invalid.example"))).toBe(false);
  expect((await exported(page)).nodes[0].label).toBe(malicious);
});
test("oversized files are rejected before preview without changing the graph", async ({
  page,
}) => {
  await page.locator("#fileInput").setInputFiles({
    name: "large.json",
    mimeType: "application/json",
    buffer: Buffer.alloc(12 * 1024 * 1024 + 1, 32),
  });
  await expect(page.locator("#importStatus")).toContainText("超过 12 MiB");
  await expect(page.locator("#applyImport")).toBeDisabled();
  await expect(page.locator("#nodeCount")).toHaveText("8");
});
test("full coverage remains a visibly unverified source statement", async ({
  page,
}) => {
  await preview(
    page,
    batch([node()], [], {
      source: {
        id: "test:source",
        completeness: "full",
        scope: "导出方声明范围",
      },
    }),
  );
  await expect(page.locator("#previewSources")).toContainText("未经验证");
  await expect(page.locator("#previewWarnings")).toContainText("无法独立证明");
});
test("Escape cancels, returns focus, and no stale result enables confirmation", async ({
  page,
}) => {
  await preview(page, batch());
  await page.keyboard.press("Escape");
  await expect(page.locator("#importDialog")).not.toBeVisible();
  await expect(page.locator("#importBtn")).toBeFocused();
  await preview(page, "not-json");
  await expect(page.locator("#applyImport")).toBeDisabled();
  await expect(page.locator("#importErrors")).toBeVisible();
});
test("the import dialog remains within the viewport and keeps its actions reachable", async ({
  page,
}) => {
  await preview(page, batch());
  const bounds = await page.locator("#importDialog").boundingBox();
  const viewport = page.viewportSize();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds.height).toBeLessThanOrEqual(viewport.height);
  await page.locator("#applyImport").click();
  await expect(page.locator("#nodeCount")).toHaveText("1");
});
test("copying the product prompt has a manual-copy fallback", async ({
  page,
}) => {
  await page.evaluate(() =>
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    }),
  );
  await page.locator("#copyPrompt").click();
  await expect(page.locator("#input")).toHaveValue(/MGP 1\.1/);
  await expect(page.locator("#notice")).toContainText("手动复制");
});
test("legacy saved workspaces are preserved when new batches are merged", async ({
  page,
}) => {
  const legacy = {
    ...batch(),
    protocol: "mgp/1.0",
    source: { id: "merged", completeness: "unknown" },
    sources: [batch().source],
  };
  await page.addInitScript(
    (data) =>
      localStorage.setItem("memory-galaxy-mgp-v1", JSON.stringify(data)),
    legacy,
  );
  await page.reload();
  await expect(page.locator("#nodeCount")).toHaveText("1");
  await apply(page, batch([node("test:two", { label: "新批次" })]));
  await expect(page.locator("#nodeCount")).toHaveText("2");
  expect(
    (await exported(page)).nodes.find((n) => n.id === "test:one").content,
  ).toBe("原始正文");
});

test("saving and reloading the example never mixes it into the first import", async ({
  page,
}) => {
  await page.locator("#saveBtn").click();
  await expect(page.locator("#notice")).toContainText("已保存到这个浏览器");
  await page.reload();
  await expect(page.locator("#nodeCount")).toHaveText("8");
  await apply(page, batch());
  await expect(page.locator("#nodeCount")).toHaveText("1");
});

test("cancelling a pending file read does not reopen the import dialog", async ({
  page,
}) => {
  await page.evaluate(() => {
    File.prototype.text = function () {
      return new Promise((resolve) => {
        window.finishFileRead = resolve;
      });
    };
  });
  await page.locator("#fileInput").setInputFiles({
    name: "slow.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(batch())),
  });
  await expect(page.locator("#importDialog")).toBeVisible();
  await page.locator("#cancelImport").click();
  await page.evaluate(async (data) => {
    window.finishFileRead(JSON.stringify(data));
    await new Promise(requestAnimationFrame);
  }, batch());
  await expect(page.locator("#importDialog")).not.toBeVisible();
  await expect(page.locator("#nodeCount")).toHaveText("8");
});

test("changes to the same source declaration also require review", async ({
  page,
}) => {
  await apply(page, batch());
  await preview(
    page,
    batch([], [], {
      source: {
        id: "test:source",
        scope: "新的覆盖范围",
        completeness: "full",
      },
    }),
  );
  await expect(page.locator("#applyImport")).toBeDisabled();
  await expect(page.locator("#previewConflicts")).toContainText("来源声明");
  await page.locator("#conflictPolicy").selectOption("keep");
  await expect(page.locator("#applyImport")).toBeEnabled();
  await page.locator("#applyImport").click();
  expect((await exported(page)).sources[0].scope).toBe("测试数据");
});
