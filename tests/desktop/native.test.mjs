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
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { start, close, choose } from "./harness.mjs";
import { DATABASE_NAME } from "../../desktop/library.mjs";
import {
  decryptBackup,
  deriveEncryption,
  ENCRYPTED_BACKUP_OVERHEAD,
  isEncryptedBackup,
} from "../../desktop/encryption.mjs";
import {
  makeLibraryBackup,
  parseLibraryBackup,
} from "../../web/library-backup.mjs";
import { graph, libraryFixture } from "../fixtures/desktop.mjs";

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

test(
  "installed app protects encryption, wrong passwords, and legacy backup recovery",
  { timeout: 180000 },
  async (t) => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "memory-galaxy-protected-")),
    );
    const profile = join(dir, "profile");
    const encrypted = join(dir, "加密资料");
    const legacy =
      process.env.MEMORY_GALAXY_V070_BACKUP ??
      fileURLToPath(new URL("../fixtures/v070-library.json", import.meta.url));
    const backup = join(dir, "protected.mgbackup");
    const password = "synthetic package password";
    const fixture = await libraryFixture();
    await mkdir(encrypted);
    let { app, page } = await start(t, { profile });
    await openTools(page);
    await expect(page.locator("#desktopWelcome")).toBeVisible();
    await page.evaluate(
      (workspace) => window.memoryGalaxyDesktop.saveWorkspace(workspace, null),
      fixture.workspace,
    );
    await page.reload();
    await expect(page.locator("#nodeCount")).toHaveText("2");
    await openTools(page);
    const plainPath = join(profile, "library", DATABASE_NAME);
    await page.locator("#desktopEncryptCopy").click();
    await expect(page.locator("#desktopPasswordHelp")).toContainText(
      "原明文库和已有导出仍为明文",
    );
    await page.locator("#desktopPassword").fill("short");
    await page.locator("#desktopConfirmPassword").fill("different");
    await page.locator("#desktopSubmitPassword").click();
    await expect(page.locator("#desktopPasswordError")).toContainText(
      "两次输入的密码不同",
    );
    await app.evaluate(({ dialog }) => {
      dialog.showOpenDialog = async () => {
        throw new Error("Unexpected file picker for an invalid password");
      };
    });
    await page.locator("#desktopConfirmPassword").fill("short");
    await page.locator("#desktopSubmitPassword").click();
    await expect(page.locator("#desktopPasswordError")).toContainText(
      "至少 12 个字符",
    );
    await choose(app, { open: encrypted, directory: true });
    await page.locator("#desktopPassword").fill(password);
    await page.locator("#desktopConfirmPassword").fill(password);
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopSubmitPassword").click(),
    ]);
    await expect(page.locator("#desktopPath")).toContainText("已加密");
    assert.ok((await readFile(plainPath)).includes(Buffer.from("测试原文")));
    const database = join(encrypted, DATABASE_NAME);
    assert.ok(!(await readFile(database)).includes(Buffer.from("测试原文")));

    await close(app);
    ({ app, page } = await start(t, { profile }));
    await expect(page.locator("#desktopPasswordDialog")).toBeVisible();
    await page.locator("#desktopPassword").fill("wrong synthetic password");
    await page.locator("#desktopSubmitPassword").click();
    await expect(page.locator("#desktopPasswordError")).toContainText(
      "密码不正确",
    );
    await page.locator("#desktopPassword").fill(password);
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopSubmitPassword").click(),
    ]);
    await expect(page.locator("#nodeCount")).toHaveText("2");

    await openTools(page);
    await page.locator("#exportBtn").click();
    await expect(page.locator("#confirmText")).toContainText("以明文保存");
    await page.locator("#cancelAction").click();

    await choose(app, { save: backup, extension: "mgbackup" });
    await page.locator("#backupBtn").click();
    await expect(page.locator("#notice")).toContainText("完整资料备份已保存");
    const bytes = await readFile(backup);
    assert.ok(isEncryptedBackup(bytes));
    assert.deepEqual(
      (await parseLibraryBackup(await decryptBackup(bytes, password))).state
        .workspace,
      fixture.workspace,
    );
    await choose(app, { open: backup, extension: "mgbackup" });
    await page.locator("#restoreBackupBtn").click();
    await page.locator("#desktopPassword").fill("wrong synthetic password");
    await page.locator("#desktopSubmitPassword").click();
    await expect(page.locator("#desktopPasswordError")).toContainText(
      "密码不正确",
    );
    await page.locator("#desktopPassword").fill(password);
    await page.locator("#desktopSubmitPassword").click();
    await expect(page.locator("#desktopRestoreDialog")).toBeVisible();
    await expect(page.locator("#desktopRestoreProtection")).toContainText(
      "加密保存",
    );
    await page.locator("#desktopCancelRestore").click();
    await expect(page.locator("#nodeCount")).toHaveText("2");

    await page.locator("#restoreBackupBtn").click();
    await expect(page.locator("#desktopPasswordDialog")).toBeVisible();
    const altered = structuredClone(fixture);
    altered.workspace.graph.nodes[0].content = "替换文件中的不同合成记忆";
    const replacement = await deriveEncryption(password);
    try {
      await writeFile(
        backup,
        replacement.sealBackup(await makeLibraryBackup(altered)),
      );
    } finally {
      replacement.dispose();
    }
    await page.locator("#desktopPassword").fill(password);
    await page.locator("#desktopSubmitPassword").click();
    await expect(page.locator("#desktopPasswordError")).toContainText(
      "选择后发生变化",
    );
    await expect(page.locator("#desktopRestoreDialog")).not.toBeVisible();
    await page.locator("#desktopCancelPassword").click();
    assert.deepEqual(
      (await page.evaluate(() => window.memoryGalaxyDesktop.loadWorkspace()))
        .backup,
      fixture.workspace,
    );
    await writeFile(backup, bytes);

    const truncated = join(dir, "truncated.mgbackup");
    await writeFile(truncated, bytes.subarray(0, ENCRYPTED_BACKUP_OVERHEAD));
    await choose(app, { open: truncated, extension: "mgbackup" });
    await page.locator("#restoreBackupBtn").click();
    await expect(page.locator("#notice")).toContainText("加密备份文件不完整");
    await expect(page.locator("#desktopPasswordDialog")).not.toBeVisible();

    const broken = join(dir, "damaged.json");
    await writeFile(broken, '{"format":"memory-galaxy/library-backup/1"}');
    await choose(app, { open: broken });
    await page.locator("#restoreBackupBtn").click();
    await expect(page.locator("#notice")).toContainText("请选择完整资料备份");
    assert.equal(
      (await readdir(encrypted)).filter((name) =>
        name.includes("before-restore"),
      ).length,
      0,
    );

    await choose(app, { open: legacy });
    await page.locator("#restoreBackupBtn").click();
    await expect(page.locator("#desktopRestoreDialog")).toBeVisible();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopConfirmRestore").click(),
    ]);
    await expect(page.locator("#nodeCount")).toHaveText("2");
    const safety = (await readdir(encrypted)).filter((name) =>
      name.includes("before-restore"),
    );
    assert.equal(safety.length, 1);
    assert.ok(safety[0].endsWith(".mgbackup"));
    const rollback = await decryptBackup(
      await readFile(join(encrypted, safety[0])),
      password,
    );
    assert.deepEqual(
      (await parseLibraryBackup(rollback)).state.workspace,
      fixture.workspace,
    );
    const expected = (await parseLibraryBackup(await readFile(legacy, "utf8")))
      .state;
    const actual = await page.evaluate(() =>
      window.memoryGalaxyDesktop.loadWorkspace(),
    );
    assert.deepEqual(actual.backup, expected.workspace);
    await close(app);

    // Recover from a corrupted selected database without rewriting it.
    await writeFile(database, "damaged fixture database");
    ({ app, page } = await start(t, { profile }));
    await expect(page.locator("#desktopProblemDialog")).toBeVisible();
    await choose(app, { open: join(profile, "library"), directory: true });
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopRecoveryFolder").click(),
    ]);
    await expect(page.locator("#nodeCount")).toHaveText("2");
    assert.equal(await readFile(database, "utf8"), "damaged fixture database");
    await close(app);
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  },
);

test(
  "installed app opens Linux v0.8 encrypted files and confirms plaintext recovery",
  { timeout: 120000 },
  async (t) => {
    const dir = await realpath(
      await mkdtemp(join(tmpdir(), "memory-galaxy-portable-")),
    );
    const files = JSON.parse(
      await readFile(
        new URL("../fixtures/v080-encrypted.json", import.meta.url),
        "utf8",
      ),
    );
    const password = "synthetic v0.8 portable password";
    const existing = join(dir, "旧加密资料");
    const backup = join(dir, "旧加密备份.mgbackup");
    await mkdir(existing);
    await writeFile(
      join(existing, DATABASE_NAME),
      Buffer.from(files.database, "base64"),
    );
    const encryptedBytes = Buffer.from(files.backup, "base64");
    await writeFile(backup, encryptedBytes);
    const { state } = await parseLibraryBackup(
      await decryptBackup(encryptedBytes, password),
    );

    let { app, page } = await start(t, {
      profile: join(dir, "previous-library"),
    });
    await openTools(page);
    await choose(app, { open: existing, directory: true });
    await page.locator("#desktopFolderBtn").click();
    await expect(page.locator("#desktopPasswordDialog")).toBeVisible();
    await page.locator("#desktopPassword").fill(password);
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopSubmitPassword").click(),
    ]);
    await expect(page.locator("#desktopPath")).toContainText("已加密");
    assert.deepEqual(
      (await page.evaluate(() => window.memoryGalaxyDesktop.loadWorkspace()))
        .backup,
      state.workspace,
    );
    assert.deepEqual(
      await page.evaluate(() => window.memoryGalaxyDesktop.loadReviews()),
      state.reviews,
    );
    const savedPack = state.packs.find((row) => !row.deleted);
    assert.deepEqual(
      await page.evaluate(
        (id) => window.memoryGalaxyDesktop.loadPack(id),
        savedPack.id,
      ),
      savedPack,
    );
    await close(app);

    const profile = join(dir, "new-library");
    ({ app, page } = await start(t, { profile }));
    await openTools(page);
    await choose(app, { open: backup, extension: "mgbackup" });
    async function previewPlaintext() {
      await page.locator("#restoreBackupBtn").click();
      await page.locator("#desktopPassword").fill(password);
      await page.locator("#desktopSubmitPassword").click();
      await expect(page.locator("#desktopRestoreProtection")).toContainText(
        "当前是明文资料库",
      );
      await expect(page.locator("#desktopConfirmRestore")).toHaveText(
        "确认以明文恢复",
      );
    }
    await previewPlaintext();
    await page.locator("#desktopCancelRestore").click();
    assert.equal(
      await page.evaluate(() => window.memoryGalaxyDesktop.loadWorkspace()),
      null,
    );
    await previewPlaintext();
    await Promise.all([
      page.waitForEvent("load"),
      page.locator("#desktopConfirmRestore").click(),
    ]);
    await expect(page.locator("#desktopPath")).toContainText("明文");
    assert.deepEqual(
      (await page.evaluate(() => window.memoryGalaxyDesktop.loadWorkspace()))
        .backup,
      state.workspace,
    );
    await close(app);
    assert.deepEqual(await readFile(backup), encryptedBytes);
    assert.ok(
      (await readFile(join(profile, "library", DATABASE_NAME))).includes(
        Buffer.from("测试原文"),
      ),
    );
    t.diagnostic(
      "Linux v0.8.0 encrypted SQLite and backup fixtures were read by the installed application.",
    );
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  },
);
