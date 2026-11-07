import { packConfig, validateBaseline, validPackId } from "./topic-packs.mjs";
export const PACK_DATABASE = "memory-galaxy-topic-packs";
const dataStore = "packs",
  summaryStore = "summaries";
const keys = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...names].sort().join(",");
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const revision = (value) => Number.isSafeInteger(value) && value > 0;
export function validatePackDocument(value) {
  if (
    !keys(
      value,
      value?.deleted === true
        ? ["schema", "id", "revision", "saved_at", "deleted"]
        : ["schema", "id", "revision", "saved_at", "config", "baseline"],
    ) ||
    value.schema !== 1 ||
    !validPackId(value.id) ||
    !revision(value.revision) ||
    !date(value.saved_at)
  )
    throw new Error("主题包本机记录损坏，未覆盖原记录。");
  if (!value.deleted) {
    packConfig(value.config);
    if (!value.config.title.trim()) throw new Error("主题包名称不能为空");
    validateBaseline(value.baseline);
  }
  return structuredClone(value);
}
function summary(value) {
  if (
    !keys(value, ["id", "title", "revision", "saved_at"]) ||
    !validPackId(value.id) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    value.title.length > 200 ||
    !revision(value.revision) ||
    !date(value.saved_at)
  )
    throw new Error("主题包目录损坏，原记录已保留。");
  return value;
}
function open() {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(PACK_DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(dataStore, { keyPath: "id" });
      request.result.createObjectStore(summaryStore, { keyPath: "id" });
    };
    request.onblocked = () => {
      blocked = true;
      reject(new Error("主题包存储被旧页面占用，请关闭旧页面后重试。"));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const database = request.result;
      if (blocked) return database.close();
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}
async function read(storeName, operation) {
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(storeName, "readonly"),
        request = operation(tx.objectStore(storeName));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () =>
        reject(tx.error || new Error("主题包读取失败"));
    });
  } finally {
    database.close();
  }
}
export async function loadPackDocuments() {
  return (await read(dataStore, (store) => store.getAll())).map(
    validatePackDocument,
  );
}
export async function listPacks() {
  const desktop = globalThis.memoryGalaxyDesktop;
  if (desktop) return desktop.listPacks();
  return (await read(summaryStore, (store) => store.getAll()))
    .map(summary)
    .sort(
      (a, b) =>
        b.saved_at.localeCompare(a.saved_at) || a.id.localeCompare(b.id),
    );
}
export async function loadPack(id) {
  const desktop = globalThis.memoryGalaxyDesktop;
  if (desktop) return desktop.loadPack(id);
  const value = await read(dataStore, (store) => store.get(id));
  if (value === undefined) return null;
  const record = validatePackDocument(value);
  return record.deleted ? null : record;
}
export async function writePack({
  id,
  config,
  baseline,
  expectedRevision = 0,
  remove = false,
}) {
  const desktop = globalThis.memoryGalaxyDesktop;
  if (desktop)
    return desktop.savePack({ id, config, baseline, expectedRevision, remove });
  if (
    !validPackId(id) ||
    !Number.isSafeInteger(expectedRevision) ||
    expectedRevision < 0
  )
    throw new Error("主题包保存条件不正确");
  if (!remove) {
    packConfig(config);
    validateBaseline(baseline);
    if (!config.title.trim()) throw new Error("请填写主题包名称");
  }
  const database = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction([dataStore, summaryStore], "readwrite"),
        store = tx.objectStore(dataStore),
        summaries = tx.objectStore(summaryStore),
        request = store.get(id);
      let failure, next;
      const fail = (error) => {
        failure = error;
        tx.abort();
      };
      request.onsuccess = () => {
        try {
          const old =
            request.result === undefined
              ? null
              : validatePackDocument(request.result);
          if ((old?.revision || 0) !== expectedRevision || old?.deleted)
            throw new Error(
              "主题包已被其他页面更新或删除，请重新载入后核对；未覆盖其修改。",
            );
          if (remove && !old) throw new Error("主题包已不存在");
          next = validatePackDocument({
            schema: 1,
            id,
            revision: expectedRevision + 1,
            saved_at: new Date().toISOString(),
            ...(remove ? { deleted: true } : { config, baseline }),
          });
          const put = () => {
            store.put(next);
            if (remove) summaries.delete(id);
            else
              summaries.put({
                id,
                title: config.title,
                revision: next.revision,
                saved_at: next.saved_at,
              });
          };
          if (!old && !remove) {
            const count = summaries.count();
            count.onsuccess = () => {
              if (count.result >= 100)
                fail(
                  new Error(
                    "本浏览器最多保留 100 个主题包配置，请先整理已有配置。",
                  ),
                );
              else put();
            };
          } else put();
        } catch (error) {
          fail(error);
        }
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = tx.onabort = () =>
        reject(failure || tx.error || new Error("主题包保存被取消"));
    });
  } finally {
    database.close();
  }
}
