import { test, expect } from "@playwright/test";
const batch = {
  protocol: "mgp/1.1",
  source: {
    id: "validation:synthetic",
    scope: "虚构的部署检查数据",
    completeness: "partial",
  },
  nodes: [
    {
      id: "validation:node",
      label: "部署检查记忆",
      type: "memory",
      content: "此记录仅用于隔离的浏览器检查。",
    },
  ],
  edges: [],
};
async function tools(page) {
  if (
    (await page.locator("#menuBtn").isVisible()) &&
    !(await page.locator("#sidebar").isVisible())
  )
    await page.locator("#menuBtn").click();
}
test("@deployment project entry, styles and background layout load within the project path", async ({
  page,
  baseURL,
}) => {
  const errors = [],
    failed = [],
    escaped = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("response", (response) => {
    if (response.status() >= 400) failed.push(response.url());
  });
  const base = new URL(baseURL);
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      ["http:", "https:"].includes(url.protocol) &&
      (url.origin !== base.origin || !url.pathname.startsWith(base.pathname))
    )
      escaped.push(url.href);
  });
  await page.goto("./");
  await expect(page).toHaveURL(new URL("web/", baseURL).href);
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await expect(page.locator("#nodeCount")).toHaveText("8");
  await expect(page.locator("#layoutStatus")).toHaveText("星图布局就绪");
  await expect(
    page.locator('meta[http-equiv="Content-Security-Policy"]'),
  ).toHaveAttribute("content", /connect-src 'self'/);
  expect(
    await page
      .locator(".app")
      .evaluate((node) => getComputedStyle(node).display),
  ).toBe("grid");
  const response = await page.request.get(
    new URL("build-info.json", baseURL).href,
  );
  expect(response.ok()).toBe(true);
  const manifest = await response.json();
  expect(manifest.format).toBe("memory-galaxy/build/1");
  if (process.env.EXPECTED_REVISION)
    expect(manifest.revision).toBe(process.env.EXPECTED_REVISION);
  expect(errors).toEqual([]);
  expect(failed).toEqual([]);
  expect(escaped).toEqual([]);
});
test("@deployment import worker validates data and the protocol prompt is available", async ({
  page,
  baseURL,
}) => {
  await page.goto("web/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  await tools(page);
  await page.locator("#fileInput").setInputFiles({
    name: "deployment.mgp.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(batch)),
  });
  await expect(page.locator("#applyImport")).toBeEnabled();
  await expect(page.locator("#previewTotals")).toContainText("1 个节点");
  await page.locator("#applyImport").click();
  await expect(page.locator("#nodeCount")).toHaveText("1");
  const prompt = await page.request.get(
    new URL("protocol/export-prompt-zh.txt", baseURL).href,
  );
  expect(prompt.ok()).toBe(true);
  expect(await prompt.text()).toContain("MGP 1.1");
});
test("@deployment backup worker loads from the project path and cancellation preserves data", async ({
  page,
}) => {
  await page.goto("web/");
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true");
  const backup = {
    format: "memory-galaxy/backup/1",
    created_at: new Date().toISOString(),
    graph: batch,
    demo: false,
    snapshots: [],
    events: [],
    view: {
      clusterBy: "type",
      showLabels: true,
      animate: false,
      positions: [],
    },
  };
  await page.locator("#backupFile").setInputFiles({
    name: "deployment.backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator("#confirmRestore")).toBeEnabled();
  await page.locator("#cancelRestore").click();
  await expect(page.locator("#nodeCount")).toHaveText("8");
});
