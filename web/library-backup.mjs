import { graphSources, edgeKey } from "./mgp.mjs";
import { canonical } from "./memory-insights.mjs";
import { BACKUP_FORMAT, validateBackup } from "./workspace.mjs";
import { validateReviewRecord } from "./review-state.mjs";
import { validatePackDocument } from "./topic-pack-store.mjs";
import { tabState } from "./tab-state.mjs";

export const LIBRARY_FORMAT = "memory-galaxy/library-backup/1";
export const LIBRARY_BYTES = 128 * 1024 * 1024;
export const LIBRARY_FILE_BYTES = LIBRARY_BYTES + 4 * 1024 * 1024;
const encoder = new TextEncoder();
const serialized = (value) => JSON.stringify(canonical(value));
const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

export function validateLibraryTab(value) {
  if (value === null) return;
  const normalized = tabState(value);
  if (
    !normalized ||
    JSON.stringify(value).length > 16384 ||
    serialized(value) !== serialized(normalized)
  )
    throw new Error("工作区界面状态未通过校验。");
}

function validateRows(rows, validate) {
  if (!Array.isArray(rows)) throw new Error("备份记录需要数组。");
  const seen = new Set();
  for (const row of rows) {
    validate(row);
    if (seen.has(row.id)) throw new Error("备份包含重复的稳定 ID。");
    seen.add(row.id);
  }
}

export function validateLibraryState(state) {
  if (!exact(state, ["workspace", "reviews", "packs", "tab"]))
    throw new Error("完整资料的结构不正确。");
  if (state.workspace !== null) validateBackup(state.workspace);
  validateRows(state.reviews, validateReviewRecord);
  validateRows(state.packs, validatePackDocument);
  if (state.packs.filter((record) => !record.deleted).length > 100)
    throw new Error("备份超过 100 个有效主题包配置。");
  validateLibraryTab(state.tab);
}

async function checksum(text) {
  const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function makeLibraryBackup(state, now = new Date()) {
  validateLibraryState(state);
  const payload = JSON.stringify({ created_at: now.toISOString(), state });
  if (encoder.encode(payload).length > LIBRARY_FILE_BYTES - 1024)
    throw new Error("完整资料超出备份大小上限。");
  const header = JSON.stringify({
    format: LIBRARY_FORMAT,
    sha256: await checksum(payload),
  });
  return header.slice(0, -1) + ',"payload":' + payload + "}\n";
}

export async function parseLibraryBackup(text) {
  if (
    typeof text !== "string" ||
    text.length > LIBRARY_FILE_BYTES ||
    encoder.encode(text).length > LIBRARY_FILE_BYTES
  )
    throw new Error("备份超过文件大小上限。");
  const value = JSON.parse(text.replace(/^\uFEFF/, ""));
  if (value?.format === BACKUP_FORMAT) {
    validateBackup(value);
    return {
      kind: "workspace",
      created_at: value.created_at,
      workspace: value,
    };
  }
  if (
    !exact(value, ["format", "sha256", "payload"]) ||
    value.format !== LIBRARY_FORMAT ||
    typeof value.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.sha256) ||
    !exact(value.payload, ["created_at", "state"])
  )
    throw new Error("请选择完整资料备份、网页迁移包或旧版工作区备份。");
  const { created_at, state } = value.payload;
  if (
    typeof created_at !== "string" ||
    !Number.isFinite(Date.parse(created_at)) ||
    new Date(created_at).toISOString() !== created_at ||
    (await checksum(JSON.stringify(value.payload))) !== value.sha256
  )
    throw new Error("备份完整性校验失败，可能已损坏。");
  validateLibraryState(state);
  return { kind: "library", created_at, state };
}

function difference(current, incoming, key) {
  const old = new Map(current.map((row) => [key(row), row]));
  const result = {
    incoming: incoming.length,
    added: 0,
    changed: 0,
    removed: 0,
    conflicts: [],
  };
  for (const row of incoming) {
    const id = key(row);
    if (!old.has(id)) result.added++;
    else if (serialized(old.get(id)) !== serialized(row)) {
      result.changed++;
      if (result.conflicts.length < 5) result.conflicts.push(id);
    }
    old.delete(id);
  }
  result.removed = old.size;
  return result;
}

export function describeLibraryRestore(current, next) {
  const graph = current.workspace?.graph;
  const incoming = next.workspace?.graph;
  const byId = (row) => row.id;
  return {
    changes: [
      ["记忆", difference(graph?.nodes ?? [], incoming?.nodes ?? [], byId)],
      ["关系", difference(graph?.edges ?? [], incoming?.edges ?? [], edgeKey)],
      [
        "来源",
        difference(
          graph ? graphSources(graph) : [],
          incoming ? graphSources(incoming) : [],
          byId,
        ),
      ],
      [
        "已删除记忆标记",
        difference(
          graph?.deleted?.nodes ?? [],
          incoming?.deleted?.nodes ?? [],
          byId,
        ),
      ],
      [
        "已删除关系标记",
        difference(
          graph?.deleted?.edges ?? [],
          incoming?.deleted?.edges ?? [],
          edgeKey,
        ),
      ],
      ["回顾及收藏", difference(current.reviews, next.reviews, byId)],
      ["主题包配置及删除标记", difference(current.packs, next.packs, byId)],
    ],
    snapshots: [
      current.workspace?.snapshots.length ?? 0,
      next.workspace?.snapshots.length ?? 0,
    ],
    events: [
      current.workspace?.events.length ?? 0,
      next.workspace?.events.length ?? 0,
    ],
    favorites: next.reviews.filter((row) => row.favorite).length,
  };
}
