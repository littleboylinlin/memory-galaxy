import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";

const batch = (content = "编辑前正文", label = "原始标题") => ({
  protocol: "mgp/1.1",
  source: { id: "test:mobile-review", completeness: "partial" },
  nodes: [{ id: "stable:review", label, type: "memory", content }],
  edges: [],
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
async function preview(page, value) {
  await tools(page);
  await page
    .locator("#input")
    .fill(typeof value === "string" ? value : JSON.stringify(value));
  await page.locator("#importBtn").click();
  await expect(page.locator("#importDialog")).toHaveAttribute(
    "aria-busy",
    "false",
  );
}
async function apply(page, value = batch()) {
  await preview(page, value);
  await page.locator("#applyImport").click();
  await expect(page.locator("#importDialog")).not.toBeVisible();
  await closeTools(page);
}
async function select(page) {
  await page.locator("#tab-list").click();
  await page
    .locator("#nodeList")
    .getByRole("button", { name: "原始标题", exact: true })
    .click();
  await expect(page.locator("#inspector")).toBeVisible();
}
async function inViewport(page, selector) {
  const box = await page.locator(selector).boundingBox(),
    size = page.viewportSize();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
}
async function screenshot(page, testInfo, name) {
  await page.screenshot({ path: testInfo.outputPath(name + ".png") });
}

test.beforeEach(async ({ page }) => {
  await page.goto("web/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
});

test("rotation keeps compact tools, graph space, edit entry and saved data", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await apply(page, batch("较长的正文。".repeat(500)));
  await expect(page.locator("#menuBtn")).toBeVisible();
  await screenshot(page, testInfo, "portrait-graph");
  for (const size of [
    { width: 844, height: 390 },
    { width: 932, height: 430 },
  ]) {
    await page.setViewportSize(size);
    await expect(page.locator("#menuBtn")).toBeVisible();
    await expect(page.locator("#sidebar")).not.toBeVisible();
    await inViewport(page, "#quickSaveBtn");
    await inViewport(page, ".graph-controls");
    const stage = await page.locator("#panel-graph").boundingBox();
    expect(stage.width).toBeGreaterThan(size.width - 40);
    expect(stage.height).toBeGreaterThan(size.height - 130);
    await tools(page);
    await expect(page.locator("#sidebar")).toBeVisible();
    await closeTools(page);
  }
  await select(page);
  await inViewport(page, "#editNodeBtn");
  await screenshot(page, testInfo, "landscape-edit-entry");
  await page.locator("#editNodeBtn").click();
  await page.locator("#nodeLabel").fill("横屏修改后的标题");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await page.locator("#quickSaveBtn").click();
  await expect(page.locator("#saveStatus")).toContainText("已保存");
  await page.reload();
  await expect(page.locator("#detailTitle")).toHaveText("横屏修改后的标题");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#menuBtn")).toBeVisible();
  await expect(page.locator("#sidebar")).not.toBeVisible();
  await inViewport(page, "#editNodeBtn");
  await page.setViewportSize({ width: 1365, height: 900 });
  await expect(page.locator("#menuBtn")).not.toBeVisible();
  await expect(page.locator("#sidebar")).toBeVisible();
});

for (const size of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
]) {
  const orientation = size.width > size.height ? "landscape" : "portrait";
  test(
    orientation +
      " conflict review prioritizes differences and explicit choices",
    async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      await apply(page);
      await preview(page, batch("来源中的新正文"));
      await expect(page.locator("#importEditor")).not.toHaveAttribute(
        "open",
        "",
      );
      await expect(page.locator(".field-diff")).toBeVisible();
      await expect(page.locator(".field-diff")).toContainText("编辑前正文");
      await expect(page.locator(".field-diff")).toContainText("来源中的新正文");
      await expect(page.locator(".conflict-json")).not.toHaveAttribute(
        "open",
        "",
      );
      await expect(page.locator("#conflictCount")).toContainText("待处理 1 项");
      await expect(page.locator("#applyImport")).toBeDisabled();
      await inViewport(page, "#conflictCount");
      await inViewport(page, "#cancelImport");
      await inViewport(page, "#applyImport");
      await page.locator("#previewConflicts select").selectOption("incoming");
      await expect(page.locator("#conflictCount")).toContainText(
        "待处理 0 项 · 已处理 1 项",
      );
      await screenshot(page, testInfo, orientation + "-conflict");
      await page.locator("#applyImport").click();
      await closeTools(page);
      await select(page);
      await expect(page.locator("#detailContent")).toHaveText("来源中的新正文");
    },
  );
  test(
    orientation +
      " JSON errors show Chinese, exact caret and expandable technical details",
    async ({ page }, testInfo) => {
      await page.setViewportSize(size);
      const invalid = '{\n "protocol": }';
      await preview(page, invalid);
      const issue = page.locator("#importErrors button").first();
      await expect(issue).toContainText("第 2 行，第 14 列");
      await expect(issue).toContainText("此处需要合法的 JSON 值");
      await expect(issue).not.toContainText(/Unexpected|Expected|JSON\.parse/);
      const details = page.locator("#importErrors .issue-details");
      await expect(details).not.toHaveAttribute("open", "");
      await details.locator("summary").click();
      await expect(details.locator("pre")).not.toHaveText("");
      await screenshot(page, testInfo, orientation + "-json-error");
      await issue.click();
      await expect(page.locator("#importEditor")).toHaveAttribute("open", "");
      await expect(page.locator("#importText")).toBeFocused();
      expect(
        await page
          .locator("#importText")
          .evaluate((input) =>
            input.value.slice(input.selectionStart, input.selectionEnd),
          ),
      ).toBe("}");
      await expect(page.locator("#applyImport")).toBeDisabled();
      await page.locator("#cancelImport").click();
      await page.locator("#backupFile").setInputFiles({
        name: "invalid.backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(invalid),
      });
      await expect(page.locator("#restoreStatus")).toContainText(
        "第 2 行，第 14 列",
      );
      await expect(page.locator("#restoreStatus")).toContainText(
        "此处需要合法的 JSON 值",
      );
      await expect(page.locator("#restoreErrorDetails")).not.toHaveAttribute(
        "open",
        "",
      );
      await page.locator("#restoreErrorDetails summary").click();
      await expect(page.locator("#restoreErrorText")).not.toHaveText("");
      await expect(page.locator("#confirmRestore")).toBeDisabled();
    },
  );
}

test("renaming uses the old title in snapshots and restores old content with identity intact", async ({
  page,
}) => {
  await apply(page);
  await select(page);
  await page.locator("#editNodeBtn").click();
  await page.locator("#nodeLabel").fill("新的标题");
  await page.locator("#nodeContent").fill("编辑后正文");
  await page.getByRole("button", { name: "应用更改", exact: true }).click();
  await page.locator("#tab-history").click();
  const snapshot = page
    .locator(".snapshot-card")
    .filter({ hasText: "编辑前：原始标题" });
  await expect(snapshot).toHaveCount(1);
  await expect(page.locator(".snapshot-card")).not.toContainText([
    "编辑前：新的标题",
  ]);
  await snapshot.getByRole("button", { name: "恢复", exact: true }).click();
  await expect(page.locator("#confirmText")).toContainText("编辑前：原始标题");
  await page.locator("#confirmAction").click();
  await tools(page);
  const downloading = page.waitForEvent("download");
  await page.locator("#exportBtn").click();
  const graph = JSON.parse(
    await readFile(await (await downloading).path(), "utf8"),
  );
  expect(graph.nodes[0]).toMatchObject({
    id: "stable:review",
    label: "原始标题",
    content: "编辑前正文",
  });
  expect(graph.nodes[0].provenance).toContainEqual({
    source_id: "test:mobile-review",
  });
});
