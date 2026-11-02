import { validateBackup } from "./workspace.mjs";
import { validateMgp, isExampleGraph } from "./mgp.mjs";
const DATABASE = "memory-galaxy",
  STORE = "workspace",
  KEY = "current";
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
  const saved = await transaction("readonly", (store) => store.get(KEY));
  if (saved) {
    validateBackup(saved.backup);
    return {
      backup: saved.backup,
      autosave: saved.autosave === true,
      source: "indexeddb",
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
export async function saveWorkspace(backup, autosave = false) {
  validateBackup(backup);
  await transaction("readwrite", (store) =>
    store.put({ backup, autosave }, KEY),
  );
}
export async function clearWorkspaceStorage() {
  await transaction("readwrite", (store) => store.delete(KEY));
  localStorage.removeItem("memory-galaxy-mgp-v1");
}
