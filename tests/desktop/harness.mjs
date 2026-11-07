import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { expect, _electron as electron } from "@playwright/test";

export const releaseVersion = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
).version;

export async function start(t, { profile, version = releaseVersion } = {}) {
  if (profile) await mkdir(profile, { recursive: true });
  const executablePath = process.env.MEMORY_GALAXY_INSTALLED_EXE;
  const app = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    chromiumSandbox: true,
    args: [
      ...(executablePath ? [] : ["."]),
      ...(profile ? ["--user-data-dir=" + profile] : []),
      "--disable-gpu",
    ],
    timeout: 30000,
  });
  t.after(() => app.close().catch(() => {}));
  const page = await app.firstWindow();
  await expect(page.locator("body")).toHaveAttribute("data-ready", "true", {
    timeout: 20000,
  });
  const runtime = await app.evaluate(({ app }) => ({
    userData: app.getPath("userData"),
    appData: app.getPath("appData"),
    arch: process.arch,
    platform: process.platform,
    version: app.getVersion(),
    packaged: app.isPackaged,
    sandboxDisabled: app.commandLine.hasSwitch("no-sandbox"),
  }));
  assert.equal(
    await realpath(runtime.userData),
    await realpath(profile ?? join(runtime.appData, "Memory Galaxy")),
  );
  assert.equal(runtime.version, version);
  assert.equal(runtime.platform, process.platform);
  assert.equal(
    runtime.arch,
    process.env.MEMORY_GALAXY_EXPECTED_ARCH ?? process.arch,
  );
  if (executablePath) {
    assert.equal(runtime.packaged, true);
    assert.equal(runtime.sandboxDisabled, false);
  }
  assert.equal(await page.evaluate(() => typeof window.require), "undefined");
  assert.equal(new URL(page.url()).protocol, "memory-galaxy:");
  return { app, page, userData: runtime.userData };
}

export async function close(app) {
  const exited = once(app.process(), "exit");
  await app
    .evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close())
    .catch(() => {});
  const [code] = await exited;
  assert.equal(code, 0);
}

export async function choose(
  app,
  { open, save, directory = false, extension = "json" },
) {
  // Substitute the platform dialog result while checking the actual IPC arguments and file I/O.
  await app.evaluate(
    ({ dialog, BrowserWindow }, { open, save, directory, extension }) => {
      if (open)
        dialog.showOpenDialog = async (parent, options) => {
          if (
            !(parent instanceof BrowserWindow) ||
            !options.properties.includes(
              directory ? "openDirectory" : "openFile",
            ) ||
            (!directory &&
              !options.filters.some((filter) =>
                filter.extensions.includes(extension),
              ))
          )
            throw new Error("Incorrect native open-dialog options");
          return { canceled: false, filePaths: [open] };
        };
      if (save)
        dialog.showSaveDialog = async (parent, options) => {
          if (
            !(parent instanceof BrowserWindow) ||
            !options.defaultPath.endsWith("." + extension) ||
            !options.filters.some((filter) =>
              filter.extensions.includes(extension),
            )
          )
            throw new Error("Incorrect native save-dialog options");
          return { canceled: false, filePath: save };
        };
      dialog.showMessageBox = async () => ({
        response: 1,
        checkboxChecked: false,
      });
    },
    { open, save, directory, extension },
  );
}
