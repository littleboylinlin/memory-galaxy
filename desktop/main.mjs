import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  protocol,
  session,
} from "electron";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readFile, mkdir, realpath, lstat } from "node:fs/promises";
import { join, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DATABASE_NAME,
  LibraryLocked,
  createLibrary,
  openLibrary,
} from "./library.mjs";
import {
  readFolderSetting,
  writeFolderSetting,
  readBackupBytes,
  writeNewFile,
} from "./files.mjs";
import {
  deriveEncryption,
  decryptBackup,
  ENCRYPTED_BACKUP_OVERHEAD,
  isEncryptedBackup,
  validateEncryptionPassword,
} from "./encryption.mjs";
import {
  LIBRARY_FILE_BYTES,
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
// Keep newly created private data and the SQLite journal owner-only on POSIX.
if (process.platform !== "win32") process.umask(0o077);
const profileDirectory = app.commandLine.getSwitchValue("user-data-dir");
if (profileDirectory) app.setPath("userData", resolve(profileDirectory));
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");

let window, library, folder, settingFile, problem, startupMessage, preview;
let locked = false,
  pendingFolder,
  pendingBackup;
let queue = Promise.resolve(),
  closeTimer,
  closePrompt = false,
  closeAllowed = false;

function trusted(event) {
  const frame = event.senderFrame;
  return (
    window &&
    event.sender === window.webContents &&
    frame &&
    frame === event.sender.mainFrame &&
    frame.url.split("#")[0] === entry
  );
}

function storageMessage(error) {
  const sqlite = (error.errcode ?? 0) & 255;
  if (error.code === "ENOENT")
    return "找不到选中的文件或数据文件夹。请重新选择或检查磁盘连接。";
  if (["ENOSPC", "EDQUOT"].includes(error.code) || sqlite === 13)
    return "磁盘空间或配额不足。请释放空间后重试。";
  if (
    ["EACCES", "EPERM", "EROFS"].includes(error.code) ||
    sqlite === 8 ||
    sqlite === 14
  )
    return "无法访问或写入该文件。请检查文件夹权限、磁盘连接及只读设置。";
  if (sqlite === 5 || sqlite === 6)
    return "资料库正在被另一进程使用，请稍后重试。";
  if (sqlite === 11 || sqlite === 26)
    return "SQLite 文件损坏或格式无法识别。请保留原文件，再选择有效资料库或备份。";
  if (error.code === "EIO" || sqlite === 10)
    return "磁盘读写失败。请检查磁盘连接，保留原资料后重试。";
  return error.message;
}

function handle(method, run) {
  ipcMain.handle("library:" + method, (event, ...args) => {
    if (!trusted(event)) throw new Error("不允许此页面访问本地资料库。");
    const request = queue.then(() => run(...args));
    queue = request.catch(() => {});
    return request.catch((error) => {
      throw new Error(storageMessage(error));
    });
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
    const path = join(folder, DATABASE_NAME);
    opened =
      saved || (await exists(path))
        ? await openLibrary(path)
        : await createLibrary(path);
    if (!saved && !(await writeFolderSetting(settingFile, folder)))
      startupMessage = "已打开资料库，但系统未确认数据文件夹设置已同步到磁盘。";
    library = opened;
  } catch (error) {
    opened?.close();
    locked = error instanceof LibraryLocked;
    problem = storageMessage(error);
  }
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function activateLibrary(selected, candidate) {
  let durable;
  try {
    durable = await writeFolderSetting(settingFile, selected);
  } catch (error) {
    candidate.close();
    throw error;
  }
  library?.close();
  library = candidate;
  folder = selected;
  locked = false;
  problem = undefined;
  preview = pendingFolder = pendingBackup = undefined;
  startupMessage =
    "已打开资料库：" +
    folder +
    (durable ? "" : "。系统未确认文件夹设置已同步到磁盘。");
  return { changed: true };
}

async function changeFolder(password) {
  pendingFolder = undefined;
  const encryptCopy = password !== undefined;
  if (encryptCopy) {
    current();
    validateEncryptionPassword(password);
  }
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: encryptCopy ? "为加密副本选择新的文件夹" : "选择本地资料库文件夹",
    defaultPath: folder,
    properties: ["openDirectory", "createDirectory"],
  });
  if (canceled) return null;
  const selected = await realpath(filePaths[0]);
  const path = join(selected, DATABASE_NAME);
  const existing = await exists(path);
  if (encryptCopy && existing)
    throw new Error("此文件夹已有资料库。请选择新的文件夹创建加密副本。");
  if (library && !relative(folder, selected)) return null;
  const { response } = await dialog.showMessageBox(window, {
    type: "question",
    title: "确认切换数据文件夹",
    message: selected,
    detail: encryptCopy
      ? "新目录中的副本将加密。原资料库仍保留在原目录，原有明文库及导出文件仍为明文。"
      : existing
        ? "将按已有资料库原来的加密状态打开。当前文件夹中的资料会保留。"
        : library
          ? "将把当前完整资料复制到此文件夹并打开。原文件夹中的资料会保留。"
          : "将在此文件夹新建资料库。原资料文件会保留，之后可选择备份恢复。",
    buttons: ["返回", "确认切换"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  if (response !== 1) return null;
  if (existing) {
    let candidate;
    try {
      candidate = await openLibrary(path);
    } catch (error) {
      if (!(error instanceof LibraryLocked)) throw error;
      pendingFolder = selected;
      return { unlock: true };
    }
    return activateLibrary(selected, candidate);
  }
  const encryption = encryptCopy ? await deriveEncryption(password) : undefined;
  try {
    const candidate = await createLibrary(
      path,
      library?.snapshot().state,
      encryption ?? library?.encryption,
    );
    return await activateLibrary(selected, candidate);
  } finally {
    encryption?.dispose();
  }
}

async function unlockLibrary(password) {
  const selected = pendingFolder ?? (locked ? folder : null);
  if (!selected) throw new Error("没有等待解锁的资料库。");
  const candidate = await openLibrary(join(selected, DATABASE_NAME), password);
  if (!candidate.encryption) {
    candidate.close();
    throw new Error("资料库文件在解锁前发生变化，请重新选择。");
  }
  return activateLibrary(selected, candidate);
}

const backupName = (prefix, encrypted) =>
  "memory-galaxy-" +
  prefix +
  "-" +
  new Date().toISOString().replace(/[:.]/g, "-") +
  (encrypted ? ".mgbackup" : ".json");

async function saveBackup(path, state, encryption) {
  const text = await makeLibraryBackup(state);
  await writeNewFile(path, encryption ? encryption.sealBackup(text) : text);
}

async function exportBackup(password) {
  const store = current();
  if (password !== undefined) validateEncryptionPassword(password);
  const encrypted = Boolean(store.encryption) || password !== undefined;
  const extension = encrypted ? "mgbackup" : "json";
  const { canceled, filePath } = await dialog.showSaveDialog(window, {
    title: encrypted ? "保存加密的完整资料备份" : "保存明文完整资料备份",
    defaultPath: join(
      app.getPath("documents"),
      backupName("backup", encrypted),
    ),
    filters: [
      { name: encrypted ? "加密备份" : "JSON 备份", extensions: [extension] },
    ],
  });
  if (canceled) return null;
  const encryption =
    password === undefined ? undefined : await deriveEncryption(password);
  try {
    await saveBackup(
      filePath,
      store.snapshot().state,
      encryption ?? store.encryption,
    );
  } catch (error) {
    if (error.code === "EEXIST")
      throw new Error("该文件已存在，请选择新文件名。");
    throw error;
  } finally {
    encryption?.dispose();
  }
  return filePath;
}

const backupDigest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

async function previewRestore() {
  preview = pendingBackup = undefined;
  const { canceled, filePaths } = await dialog.showOpenDialog(window, {
    title: "选择完整资料备份或网页迁移包",
    filters: [{ name: "资料备份", extensions: ["json", "mgbackup"] }],
    properties: ["openFile"],
  });
  if (canceled) return null;
  const path = filePaths[0];
  const bytes = await readBackupBytes(
    path,
    LIBRARY_FILE_BYTES + ENCRYPTED_BACKUP_OVERHEAD,
  );
  if (isEncryptedBackup(bytes)) {
    if (bytes.length <= ENCRYPTED_BACKUP_OVERHEAD)
      throw new Error("加密备份文件不完整。请选择另一份完整备份。");
    pendingBackup = { path, digest: backupDigest(bytes) };
    return { encrypted: true };
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("备份文件格式无法识别或已损坏。请重新选择备份。");
  }
  return previewBackup(text, false);
}

async function unlockBackup(password) {
  if (!pendingBackup) throw new Error("请重新选择加密备份。");
  validateEncryptionPassword(password);
  const bytes = await readBackupBytes(
    pendingBackup.path,
    LIBRARY_FILE_BYTES + ENCRYPTED_BACKUP_OVERHEAD,
  );
  if (backupDigest(bytes) !== pendingBackup.digest) {
    pendingBackup = undefined;
    throw new Error("备份文件在选择后发生变化。请取消并重新选择要恢复的备份。");
  }
  const result = await previewBackup(
    await decryptBackup(bytes, password),
    true,
  );
  pendingBackup = undefined;
  return result;
}

async function previewBackup(text, sourceEncrypted) {
  let parsed;
  try {
    parsed = await parseLibraryBackup(text);
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("备份内容无法解析。请核对文件格式或使用另一份完整备份。");
    throw error;
  }
  const store = current();
  const { generation, state } = store.snapshot();
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
    sourceEncrypted,
    targetEncrypted: Boolean(store.encryption),
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
    safetyPath = join(
      folder,
      backupName("before-restore-" + randomUUID(), store.encryption),
    );
    await saveBackup(safetyPath, state, store.encryption);
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
    const result = {
      folder,
      error: problem,
      message: startupMessage,
      locked,
      encrypted: Boolean(library?.encryption),
    };
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
  handle("unlockLibrary", unlockLibrary);
  handle("exportBackup", exportBackup);
  handle("previewRestore", previewRestore);
  handle("unlockBackup", unlockBackup);
  handle("cancelPreview", () => {
    preview = pendingFolder = pendingBackup = undefined;
  });
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
    ...(process.platform === "linux"
      ? { icon: join(root, "desktop", "icon.png") }
      : {}),
    webPreferences: {
      preload: fileURLToPath(new URL("./preload.cjs", import.meta.url)),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: false,
    },
  });
  if (process.platform !== "darwin") window.removeMenu();
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
  // Some AppImage launchers automatically add this switch on restricted systems.
  if (
    process.platform === "linux" &&
    app.isPackaged &&
    app.commandLine.hasSwitch("no-sandbox")
  )
    throw new Error(
      "系统无法启用 Chromium 沙盒。请使用支持用户命名空间的环境，或改用 deb 安装包。",
    );
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
