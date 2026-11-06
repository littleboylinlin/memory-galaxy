export const REVIEW_DATABASE = "memory-galaxy-review";
export const REVIEW_STORE = "records";
export const DAY = 86400000;
export const REVIEW_INTERVAL = 30;
export const SKIP_INTERVAL = 7;
const keys = (value, names) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => names.includes(key));
const date = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
const fingerprint = (value) =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const marker = (value, skipped = false) =>
  keys(
    value,
    skipped ? ["at", "until", "fingerprint"] : ["at", "fingerprint"],
  ) &&
  date(value.at) &&
  fingerprint(value.fingerprint) &&
  (!skipped ||
    (date(value.until) && Date.parse(value.until) > Date.parse(value.at)));
export function validateReviewRecord(value) {
  if (
    !keys(value, ["schema", "id", "favorite", "reviewed", "skipped"]) ||
    value.schema !== 1 ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id.length > 256 ||
    /[\u0000-\u001f]/.test(value.id) ||
    typeof value.favorite !== "boolean" ||
    (value.reviewed !== undefined && value.skipped !== undefined) ||
    (value.reviewed !== undefined && !marker(value.reviewed)) ||
    (value.skipped !== undefined && !marker(value.skipped, true))
  )
    throw new Error(
      "回顾记录未通过校验，原记录已保留，未覆盖。请先核对浏览器中的数据。",
    );
  return structuredClone(value);
}
export function reviewAction(
  previous,
  { id, kind, value, version },
  now = Date.now(),
) {
  const next =
    previous === undefined
      ? { schema: 1, id, favorite: false }
      : validateReviewRecord(previous);
  if (next.id !== id) throw new Error("回顾记录的稳定 ID 不一致");
  if (kind === "favorite") {
    if (typeof value !== "boolean") throw new Error("收藏状态不正确");
    next.favorite = value;
  } else if (kind === "reset") {
    delete next.reviewed;
    delete next.skipped;
  } else if (kind === "reviewed" || kind === "skip") {
    if (!fingerprint(version))
      throw new Error("当前内容版本不可用，请刷新回顾后重试");
    const at = new Date(now).toISOString();
    delete next.reviewed;
    delete next.skipped;
    if (kind === "reviewed") next.reviewed = { at, fingerprint: version };
    else
      next.skipped = {
        at,
        until: new Date(now + SKIP_INTERVAL * DAY).toISOString(),
        fingerprint: version,
      };
  } else throw new Error("不支持的回顾操作");
  return validateReviewRecord(next);
}
function openDatabase() {
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = indexedDB.open(REVIEW_DATABASE, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(REVIEW_STORE, { keyPath: "id" });
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      blocked = true;
      reject(new Error("回顾存储被旧页面占用，请关闭旧页面后重试。"));
    };
    request.onsuccess = () => {
      if (blocked) return request.result.close();
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
  });
}
export async function loadReviewRecords(ids) {
  const database = await openDatabase(),
    selected = ids ? new Set(ids) : null;
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(REVIEW_STORE, "readonly"),
        request = tx.objectStore(REVIEW_STORE).getAll();
      tx.oncomplete = () => {
        try {
          resolve(
            request.result
              .filter((row) => !selected || selected.has(row?.id))
              .map(validateReviewRecord),
          );
        } catch (error) {
          reject(error);
        }
      };
      tx.onerror = tx.onabort = () =>
        reject(tx.error || new Error("回顾记录读取被取消"));
    });
  } finally {
    database.close();
  }
}
export async function saveReviewAction(action) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const tx = database.transaction(REVIEW_STORE, "readwrite"),
        store = tx.objectStore(REVIEW_STORE),
        read = store.get(action.id);
      let next, failure;
      read.onsuccess = () => {
        try {
          // Read the latest row inside this transaction; never overwrite another tab's unrelated fields.
          next = reviewAction(read.result, action);
          store.put(next);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(next);
      tx.onerror = tx.onabort = () =>
        reject(failure || tx.error || new Error("回顾状态保存被取消"));
    });
  } finally {
    database.close();
  }
}
export async function clearReviewRecords() {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const tx = database.transaction(REVIEW_STORE, "readwrite");
      tx.objectStore(REVIEW_STORE).clear();
      tx.oncomplete = resolve;
      tx.onerror = tx.onabort = () =>
        reject(tx.error || new Error("清除回顾状态失败"));
    });
  } finally {
    database.close();
  }
}
