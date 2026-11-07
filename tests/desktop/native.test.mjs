import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expect, _electron as electron } from "@playwright/test";
import { DATABASE_NAME } from "../../desktop/library.mjs";
import { parseLibraryBackup } from "../../web/library-backup.mjs";
import { graph } from "../fixtures/desktop.mjs";

const installed = process.env.MEMORY_GALAXY_INSTALLED_EXE;
async function start(profile, t) {
  await mkdir(profile, { recursive: true });
  const app = await electron.launch({
    ...(installed ? { executablePath: installed } : {}),
    args: [
      ...(installed ? [] : ["."]),
      "--user-data-dir=" + profile,
      "--disable-gpu",
    ],
    timeout: 25000,
  });
  t.after(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true", {
    timeout: 15000,
  });
  assert.equal(
    await app.evaluate(({ app }) => app.getPath("userData")),
    profile,
  );
  assert.equal(await app.evaluate(({ app }) => app.getVersion()), "0.6.0");
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(new URL(page.url()).protocol, "memory-galaxy:");
  return { app, page };
}

async function close(app) {
  const exited = once(app.process(), "exit");
  await app
    .evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].close();
    })
    .catch(() => {});
  const [code] = await exited;
  assert.equal(code, 0);
}

async function choose(app, { open, save }) {
  // Substitute the picker result while exercising real application IPC and local file I/O.
  await app.evaluate(
    ({ dialog }, { open, save }) => {
      if (open)
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [open],
        });
      if (save)
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: save,
        });
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    },
    { open, save },
  );
}

async function openTools(page) {
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

test(
  "native application runs offline and migrates committed data across profiles",
  { timeout: 180000 },
  async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "memory-galaxy-native-"));
    const profile = join(dir, "pc-a");
    const custom = join(dir, "资料库");
    const backup = join(dir, "migration.json");
    await mkdir(custom);
    let { app, page } = await start(profile, t);
    assert.ok((await stat(join(profile, "library", DATABASE_NAME))).size > 0);
    assert.deepEqual(
      await page.evaluate(async () => {
        const prompt = await fetch(
          new URL("../protocol/export-prompt-zh.txt", location.href),
        );
        const remote = await fetch("https://example.invalid/").then(
          () => true,
          () => false,
        );
        return [
          isSecureContext,
          prompt.ok,
          (await prompt.text()).length > 0,
          remote,
        ];
      }),
      [true, true, true, false],
    );

    await openTools(page);
    await page.locator("#input").fill(JSON.stringify(graph));
    await page.locator("#importBtn").click();
    await expect(page.locator("#applyImport")).toBeEnabled();
    await page.locator("#applyImport").click();
    await closeTools(page);
    await expect(page.locator("#saveStatus")).toHaveText("已保存到本机");

    await page.locator("#tab-review").click();
    const card = page.locator('.review-card[data-node-id="memory:original"]');
    await card.getByRole("button", { name: "收藏", exact: true }).click();
    await card.getByRole("button", { name: "取消收藏", exact: true }).waitFor();
    await card.getByRole("button", { name: "已回顾", exact: true }).click();
    await expect(page.locator("#reviewStatus")).toContainText(
      "已写入本地资料库",
    );

    await page.locator("#tab-packs").click();
    if (!(await page.locator("#packTitle").isVisible()))
      await page.locator("#packEditor summary").click();
    await page.locator("#packTitle").fill("原生主题包");
    await page.locator("#packPreview").click();
    await expect(page.locator("#packJson")).toBeEnabled();
    await page.locator("#packSave").click();
    await page.locator("#confirmAction").click();
    await expect(page.locator("#packStatus")).toContainText("已保存到本机");

    await choose(app, { open: custom });
    await openTools(page);
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopFolderBtn").click(),
    ]);
    await expect(page.locator("#desktopPath")).toContainText(custom);
    await expect(page.locator("#nodeCount")).toHaveText("2");
    assert.ok((await stat(join(custom, DATABASE_NAME))).size > 0);
    await close(app);

    ({ app, page } = await start(profile, t));
    await expect(page.locator("#desktopPath")).toContainText(custom);
    await expect(page.locator("#nodeCount")).toHaveText("2");
    const exit = once(app.process(), "exit");
    app.process().kill("SIGKILL");
    await exit;

    ({ app, page } = await start(profile, t));
    await expect(page.locator("#nodeCount")).toHaveText("2");
    await expect(page.locator("#edgeCount")).toHaveText("1");
    await choose(app, { save: backup });
    await openTools(page);
    await page.locator("#backupBtn").click();
    await expect(page.locator("#notice")).toContainText("完整资料备份已保存");
    const { state } = await parseLibraryBackup(await readFile(backup, "utf8"));
    assert.equal(
      state.workspace.graph.nodes[0].content,
      graph.nodes[0].content,
    );
    assert.equal(
      state.workspace.graph.nodes[0].source_ref,
      graph.nodes[0].source_ref,
    );
    assert.equal(state.workspace.graph.nodes[0].state, "confirmed");
    assert.equal(state.workspace.graph.edges[0].id, graph.edges[0].id);
    assert.equal(state.reviews[0].favorite, true);
    assert.ok(state.reviews[0].reviewed);
    assert.equal(state.packs[0].config.title, "原生主题包");
    assert.ok(state.packs[0].baseline.nodes.length);
    await close(app);

    ({ app, page } = await start(join(dir, "pc-b"), t));
    const before = await page.locator("#nodeCount").textContent();
    await choose(app, { open: backup });
    await openTools(page);
    await page.locator("#restoreBackupBtn").click();
    await expect(page.locator("#desktopRestoreChanges")).toContainText(
      "新增 2",
    );
    await page.locator("#desktopCancelRestore").click();
    await expect(page.locator("#nodeCount")).toHaveText(before);
    await page.locator("#restoreBackupBtn").click();
    await expect(page.locator("#desktopRestoreDialog")).toBeVisible();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopConfirmRestore").click(),
    ]);
    await expect(page.locator("#nodeCount")).toHaveText("2");
    const rows = await page.evaluate(async () => ({
      reviews: await window.memoryGalaxyDesktop.loadReviews(),
      packs: await window.memoryGalaxyDesktop.listPacks(),
      workspace: await window.memoryGalaxyDesktop.loadWorkspace(),
    }));
    assert.deepEqual(rows.reviews, state.reviews);
    assert.equal(rows.packs[0].title, state.packs[0].config.title);
    assert.deepEqual(rows.workspace.backup, state.workspace);
    assert.ok(
      (await readdir(join(dir, "pc-b", "library"))).some((name) =>
        name.includes("before-restore"),
      ),
    );
    await close(app);
    await rm(dir, { recursive: true, force: true });
  },
);
