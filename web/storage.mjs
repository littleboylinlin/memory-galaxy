import { validateBackup, makeId } from "./workspace.mjs";
import { validateMgp, isExampleGraph } from "./mgp.mjs";
const DATABASE = "memory-galaxy",
  STORE = "workspace",
  KEY = "current";
const revisionOf = (saved) =>
  saved === undefined
    ? null
    : typeof saved?.revision === "string" && saved.revision
      ? saved.revision
      : "legacy";
export class StorageConflictError extends Error {
  constructor() {
    super("本机存储已被其他页面更新，请先备份当前数据，再确认是否覆盖。");
    this.name = "StorageConflictError";
  }
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => {
      if (blocked) {
        request.result.close();
        return;
      }
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("另一个页面正在占用存储，请关闭旧页面后重试。"));
    };
  });
}
async function transaction(mode, operation) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("本机存储事务被取消"));
    });
  } finally {
    database.close();
  }
}
export async function loadWorkspace() {
  const desktop = globalThis.memoryGalaxyDesktop;
  if (desktop) return desktop.loadWorkspace();
  const saved = await transaction("readonly", (store) => store.get(KEY));
  if (saved !== undefined) {
    if (saved?.backup === null)
      return { revision: revisionOf(saved), autosave: false };
    validateBackup(saved.backup);
    return {
      backup: saved.backup,
      autosave: saved.autosave === true,
      source: "indexeddb",
      revision: revisionOf(saved),
    };
  }
  const legacy = localStorage.getItem("memory-galaxy-mgp-v1");
  if (legacy) {
    const graph = JSON.parse(legacy);
    if (validateMgp(graph).ok)
      return {
        legacy: graph,
        demo: isExampleGraph(graph),
        autosave: false,
        source: "legacy",
      };
    throw new Error("旧缓存未通过校验，原数据仍保留。");
  }
  return null;
}
export async function loadWorkspaceRevision() {
  return revisionOf(await transaction("readonly", (store) => store.get(KEY)));
}
async function writeWorkspace(value, expectedRevision) {
  const database = await openDatabase();
  const revision = makeId("save");
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(STORE, "readwrite"),
        store = tx.objectStore(STORE),
        read = store.get(KEY);
      let failure;
      read.onsuccess = () => {
        try {
          if (revisionOf(read.result) !== expectedRevision)
            throw new StorageConflictError();
          store.put({ ...value, revision }, KEY);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(revision);
      tx.onerror = tx.onabort = () =>
        reject(failure || tx.error || new Error("本机存储事务被取消"));
    });
  } finally {
    database.close();
  }
}
export async function saveWorkspace(
  backup,
  autosave = false,
  expectedRevision = null,
) {
  const desktop = globalThis.memoryGalaxyDesktop;
  if (desktop) return desktop.saveWorkspace(backup, expectedRevision);
  validateBackup(backup);
  return writeWorkspace({ backup, autosave }, expectedRevision);
}
export async function clearWorkspaceStorage(expectedRevision = null) {
  // Keep a content-free generation marker so stale pages cannot undo a clear.
  const revision = await writeWorkspace(
    { backup: null, autosave: false },
    expectedRevision,
  );
  localStorage.removeItem("memory-galaxy-mgp-v1");
  return revision;
}
