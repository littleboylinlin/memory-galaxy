import assert from "node:assert/strict";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { expect } from "@playwright/test";
import { start, close, choose } from "./harness.mjs";
import { DATABASE_NAME } from "../../desktop/library.mjs";
import { parseLibraryBackup } from "../../web/library-backup.mjs";
import { graph } from "../fixtures/desktop.mjs";

async function terminate(app) {
  const child = app.process();
  const exited = once(child, "exit");
  if (process.platform === "win32")
    await promisify(execFile)("taskkill.exe", [
      "/PID",
      String(child.pid),
      "/T",
      "/F",
    ]);
  else process.kill(-child.pid, "SIGKILL");
  await exited;
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
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "memory-galaxy-native-")),
    );
    const profile = join(dir, "pc-a");
    const custom = join(dir, "资料库");
    const backup = join(dir, "migration.json");
    await mkdir(custom);
    let { app, page } = await start(t, { profile });
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

    await choose(app, { open: custom, directory: true });
    await openTools(page);
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopFolderBtn").click(),
    ]);
    await expect(page.locator("#desktopPath")).toContainText(custom);
    await expect(page.locator("#nodeCount")).toHaveText("2");
    assert.ok((await stat(join(custom, DATABASE_NAME))).size > 0);
    await close(app);

    ({ app, page } = await start(t, { profile }));
    await expect(page.locator("#desktopPath")).toContainText(custom);
    await expect(page.locator("#nodeCount")).toHaveText("2");
    t.diagnostic(
      "Installed launch, offline core operations, folder change, and normal relaunch verified.",
    );
    await terminate(app);

    ({ app, page } = await start(t, { profile }));
    await expect(page.locator("#nodeCount")).toHaveText("2");
    await expect(page.locator("#edgeCount")).toHaveText("1");
    t.diagnostic(
      "Full process tree was terminated and the installed app reopened its committed state.",
    );
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

    ({ app, page } = await start(t, { profile: join(dir, "pc-b") }));
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
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
    t.diagnostic(
      "Complete backup, cancellation, restore, and pre-restore backup verified.",
    );
  },
);
