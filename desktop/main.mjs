import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
} from "electron";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, mkdir, realpath, lstat } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DATABASE_NAME, Library } from "./library.mjs";
import {
  readFolderSetting,
  writeFolderSetting,
  readBackupFile,
  writeNewFile,
} from "./files.mjs";
import {
  makeLibraryBackup,
  parseLibraryBackup,
  describeLibraryRestore,
} from "../web/library-backup.mjs";

const scheme = "memory-galaxy";
const origin = scheme + "://app";
const entry = origin + "/web/index.html";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};
protocol.registerSchemesAsPrivileged([
  {
    scheme,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);
const profileDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (profileDirectory) app.setPath("userData", resolve(profileDirectory));
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");

let window, library, folder, settingFile, problem, startupMessage, preview;
let queue = Promise.resolve(),
  closeTimer,
  closePrompt = false,
  closeAllowed = false;

function trusted(event) {
  const frame = event.senderFrame;
  return (
    window &&
    event.sender === window.webContents &&
    frame === event.sender.mainFrame &&
    frame.url.split("#")[0] === entry
  );
}

function handle(method, run) {
  ipcMain.handle("library:" + method, (event, ...args) => {
    if (!trusted(event)) throw new Error("不允许此页面访问本地资料库。");
    const request = queue.then(() => run(...args));
    queue = request.catch(() => {});
    return request;
  });
}

function current() {
  if (!library) throw new Error("请先打开有效的本地资料库。");
  return library;
}

async function startup() {
  const directory = app.getPath("userData");
  settingFile = join(directory, "library-location.json");
  folder = join(directory, "library");
  let opened;
  try {
    const saved = await readFolderSetting(settingFile);
    if (saved) folder = saved;
    else await mkdir(folder, { recursive: true });
    opened = new Library(join(folder, DATABASE_NAME), { create: !saved });
    if (!saved) await writeFolderSetting(settingFile, folder);
    library = opened;
  } catch (error) {
    opened?.close();
    problem = error.message;
  }
}

async function changeFolder() {
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: "选择本地资料库文件夹",
    defaultPath: folder,
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled) return false;
  const selected = await realpath(filePaths[0]);
  if (library && !relative(folder, selected)) return false;
  const path = join(selected, DATABASE_NAME);
  const existing = await lstat(path).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    title: "确认切换数据文件夹",
    message: selected,
    detail: existing
      ? "将打开此文件夹中已有的资料库。当前文件夹中的资料会保留。"
      : library
        ? "将把当前完整资料复制到此文件夹并打开。原文件夹中的资料会保留。"
        : "将在此文件夹新建资料库。原资料文件会保留，之后可选择备份恢复。",
    buttons: ["返回", "确认切换"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return false;
  const copy = !existing && library ? library.snapshot().state : null;
  const candidate = new Library(path, { create: !existing });
  try {
    if (copy) candidate.replace(copy, 0);
    await writeFolderSetting(settingFile, selected);
  } catch (error) {
    candidate.close();
    throw error;
  }
  library?.close();
  library = candidate;
  folder = selected;
  problem = undefined;
  preview = undefined;
  startupMessage = "已打开资料库：" + folder;
  return true;
}

const backupName = (prefix) =>
  "memory-galaxy-" +
  prefix +
  "-" +
  new Date().toISOString().replace(/[:.]/g, "-") +
  ".json";

async function exportBackup() {
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: "保存完整资料备份",
    defaultPath: join(app.getPath("documents"), backupName("backup")),
    filters: [{ name: "JSON 备份", extensions: ["json"] }],
  });
  if (canceled) return null;
  try {
    await writeNewFile(
      filePath,
      await makeLibraryBackup(current().snapshot().state),
    );
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("该文件已存在，请选择新文件名。");
    throw error;
  }
  return filePath;
}

async function previewRestore() {
  preview = undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: "选择完整资料备份或网页迁移包",
    filters: [{ name: "JSON 备份", extensions: ["json"] }],
    properties: ["openFile"],
  });
  if (canceled) return null;
  const parsed = await parseLibraryBackup(await readBackupFile(filePaths[0]));
  const { generation, state } = current().snapshot();
  const next =
    parsed.kind === "library"
      ? parsed.state
      : { ...state, workspace: parsed.workspace };
  const token = randomUUID();
  const changes = describeLibraryRestore(state, next);
  preview = { token, generation, next };
  return {
    token,
    kind: parsed.kind,
    created_at: parsed.created_at,
    ...changes,
  };
}

async function restore(token) {
  if (!preview || preview.token !== token)
    throw new Error("恢复预览已失效，请重新选择备份。");
  const { generation, next } = preview;
  preview = undefined;
  const store = current();
  const { generation: liveGeneration, state } = store.snapshot();
  if (liveGeneration !== generation)
    throw new Error("资料在预览后变化，请重新选择备份。");
  let safetyPath;
  if (
    state.workspace ||
    state.reviews.length ||
    state.packs.length ||
    state.tab
  ) {
    safetyPath = join(folder, backupName("before-restore-" + randomUUID()));
    await writeNewFile(safetyPath, await makeLibraryBackup(state));
  }
  store.replace(next, generation);
  startupMessage = safetyPath
    ? "已恢复资料。恢复前的完整备份：" + safetyPath
    : "已恢复资料。";
  return true;
}

async function finishClose(reason) {
  if (!closeTimer || closePrompt) return;
  if (typeof reason === "string" && reason) {
    closePrompt = true;
    try {
      const { response } = await dialog.showMessageBox(window, {
        type: "warning",
        title: "关闭 Memory Galaxy",
        message: "仍有内容未写入资料库",
        detail: reason.slice(0, 1000),
        buttons: ["返回应用", "关闭并放弃未保存内容"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response !== 1) return;
    } finally {
      closePrompt = false;
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
  }
  clearTimeout(closeTimer);
  closeTimer = undefined;
  closeAllowed = true;
  window.close();
}

function wire() {
  handle("status", () => {
    const result = { folder, error: problem, message: startupMessage };
    startupMessage = undefined;
    return result;
  });
  handle("loadWorkspace", () => current().get("workspace"));
  handle("saveWorkspace", (backup, revision) =>
    current().saveWorkspace(backup, revision),
  );
  handle("loadTab", () => current().get("tab"));
  handle("saveTab", (value) => current().saveTab(value));
  handle("loadReviews", (ids) => current().reviews(ids));
  handle("saveReview", (action) => current().saveReview(action));
  handle("clearReviews", () => current().clearReviews());
  handle("listPacks", () => current().packs());
  handle("loadPack", (id) => current().pack(id));
  handle("savePack", (value) => current().savePack(value));
  handle("changeFolder", changeFolder);
  handle("exportBackup", exportBackup);
  handle("previewRestore", previewRestore);
  handle("restore", restore);
  ipcMain.handle("library:finishClose", (event, reason) => {
    if (!trusted(event)) throw new Error("关闭请求来自未知页面。");
    return finishClose(reason);
  });
}

function createWindow() {
  const root = app.getAppPath();
  protocol.handle(scheme, async ({ url, method }) => {
    const parsed = new URL(url);
    if (
      parsed.host !== "app" ||
      method !== "GET" ||
      !/^\/(web|protocol)\/[\w.-]+\.(html|mjs|css|svg|txt)$/.test(
        parsed.pathname,
      )
    )
      return new Response(null, { status: 404 });
    try {
      const bytes = await readFile(join(root, parsed.pathname.slice(1)));
      return new Response(bytes, {
        headers: {
          "Content-Type": mime[extname(parsed.pathname)],
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  });
  const profile = session.defaultSession;
  profile.webRequest.onBeforeRequest(
    {
      urls: [
        "http://*/*",
        "https://*/*",
        "ws://*/*",
        "wss://*/*",
        "file://*/*",
      ],
    },
    (_details, callback) => callback({ cancel: true }),
  );
  profile.setPermissionRequestHandler((_contents, permission, reply) =>
    reply(permission === "clipboard-sanitized-write"),
  );
  profile.setPermissionCheckHandler(
    (_contents, permission, requestingOrigin) =>
      requestingOrigin === origin && permission === "clipboard-sanitized-write",
  );
  window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 570,
    backgroundColor: "#080b17",
    title: "Memory Galaxy",
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  window.removeMenu();
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => {
    if (event.url !== entry) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => event.preventDefault());
  window.on("close", (event) => {
    if (closeAllowed) return;
    event.preventDefault();
    if (closeTimer) return;
    closeTimer = setTimeout(() => {
      void finishClose("应用没有及时回应。继续关闭可能丢失尚未保存的修改。");
    }, 15000);
    window.webContents.send("library:closing");
  });
  void window.loadURL(entry);
}

app.on("second-instance", () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});
app.on("window-all-closed", () => app.quit());
app.on("will-quit", () => library?.close());

async function start() {
  let locked = app.requestSingleInstanceLock();
  if (!locked && process.platform === "win32") {
    // A terminated Windows process can briefly leave the profile lock busy.
    await delay(500);
    locked = app.requestSingleInstanceLock();
  }
  if (!locked) {
    console.warn("Memory Galaxy profile is in use.");
    app.quit();
    return;
  }
  await app.whenReady();
  await startup();
  wire();
  createWindow();
}

start().catch((error) => {
  dialog.showErrorBox("Memory Galaxy 无法启动", error.message);
  app.exit(1);
});
