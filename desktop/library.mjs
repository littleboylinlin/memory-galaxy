import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  LIBRARY_BYTES,
  validateLibraryState,
  validateLibraryTab,
} from "../web/library-backup.mjs";
import { validateBackup } from "../web/workspace.mjs";
import { reviewAction, validateReviewRecord } from "../web/review-state.mjs";
import { validatePackDocument } from "../web/topic-pack-store.mjs";
import { validPackId } from "../web/topic-packs.mjs";

export const DATABASE_NAME = "memory-galaxy.sqlite3";
const APPLICATION_ID = 0x4d474c58;
const SINGLETON = "";
const sha = (text) => createHash("sha256").update(text).digest("hex");
const validators = {
  workspace: (value) => validateBackup(value.backup),
  tab: validateLibraryTab,
  review: validateReviewRecord,
  pack: validatePackDocument,
};

function decode(row) {
  const { kind, id, value, bytes, hash } = row;
  if (
    !Object.hasOwn(validators, kind) ||
    typeof value !== "string" ||
    bytes !== Buffer.byteLength(value) ||
    hash !== sha(value)
  )
    throw new Error("资料库的记录未通过完整性校验。");
  const record = JSON.parse(value);
  validators[kind](record);
  if (
    ((kind === "review" || kind === "pack") && record.id !== id) ||
    (kind === "workspace" &&
      (Object.keys(record).length !== 2 ||
        !/^[a-f0-9-]{36}$/.test(record.revision)))
  )
    throw new Error("资料库的记录 ID 或版本未通过校验。");
  return record;
}

export class LibraryConflict extends Error {
  constructor() {
    super("资料库在预览或编辑后发生变化，请重新载入并核对。");
  }
}

export class Library {
  constructor(path, { create = false } = {}) {
    let existing;
    try {
      existing = lstatSync(path);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (existing ? !existing.isFile() || !existing.size : !create)
      throw new Error("资料库文件缺失、为空或不是普通文件。");
    this.db = new DatabaseSync(path, { timeout: 3000 });
    try {
      this.db.exec("PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF;");
      const applicationId = this.db
        .prepare("PRAGMA application_id")
        .get().application_id;
      if (!existing && applicationId === 0)
        this.transaction(() =>
          this.db.exec(`
          PRAGMA application_id=${APPLICATION_ID};
          PRAGMA user_version=1;
          CREATE TABLE records (
            kind TEXT NOT NULL CHECK (kind IN ('workspace', 'tab', 'review', 'pack')),
            id TEXT NOT NULL,
            value TEXT NOT NULL,
            bytes INTEGER NOT NULL CHECK (bytes > 0),
            hash TEXT NOT NULL,
            PRIMARY KEY (kind, id),
            CHECK ((kind IN ('workspace', 'tab') AND id = '') OR
                   (kind IN ('review', 'pack') AND id <> ''))
          ) STRICT;
          CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL CHECK (generation >= 0)) STRICT;
          INSERT INTO meta VALUES (1, 0);
        `),
        );
      if (
        this.db.prepare("PRAGMA application_id").get().application_id !==
          APPLICATION_ID ||
        this.db.prepare("PRAGMA user_version").get().user_version !== 1 ||
        this.db.prepare("PRAGMA quick_check(1)").get().quick_check !== "ok"
      )
        throw new Error("资料库版本不兼容或文件未通过 SQLite 完整性检查。");
      this.db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA;");
      this.snapshot();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  transaction(work, begin = "BEGIN IMMEDIATE") {
    this.db.exec(begin);
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // SQLite can already have rolled back after a disk or I/O failure.
      }
      throw error;
    }
  }

  generation() {
    const value = this.db
      .prepare("SELECT generation FROM meta WHERE id = 1")
      .get()?.generation;
    if (!Number.isSafeInteger(value) || value < 0)
      throw new Error("资料库的保存版本损坏。");
    return value;
  }

  get(kind, id = SINGLETON) {
    const row = this.db
      .prepare("SELECT * FROM records WHERE kind = ? AND id = ?")
      .get(kind, id);
    return row ? decode(row) : null;
  }

  rows(kind) {
    return this.db
      .prepare("SELECT * FROM records WHERE kind = ? ORDER BY id")
      .all(kind);
  }

  put(kind, id, record) {
    const value = JSON.stringify(record);
    const bytes = Buffer.byteLength(value);
    if (bytes > LIBRARY_BYTES) throw new Error("记录超过本地资料库大小上限。");
    this.db
      .prepare(
        "INSERT OR REPLACE INTO records (kind,id,value,bytes,hash) VALUES (?,?,?,?,?)",
      )
      .run(kind, id, value, bytes, sha(value));
  }

  checkSize() {
    const { total } = this.db
      .prepare("SELECT coalesce(sum(bytes), 0) AS total FROM records")
      .get();
    if (total > LIBRARY_BYTES)
      throw new Error("资料库达到 128 MiB 上限，请先导出并整理资料。");
  }

  mutate(work, expectedGeneration) {
    return this.transaction(() => {
      const generation = this.generation();
      if (expectedGeneration !== undefined && generation !== expectedGeneration)
        throw new LibraryConflict();
      const result = work();
      this.checkSize();
      this.db
        .prepare("UPDATE meta SET generation = ? WHERE id = 1")
        .run(generation + 1);
      return result;
    });
  }

  snapshot() {
    return this.transaction(() => {
      this.checkSize();
      const state = {
        workspace: this.get("workspace")?.backup ?? null,
        reviews: this.rows("review").map(decode),
        packs: this.rows("pack").map(decode),
        tab: this.get("tab"),
      };
      validateLibraryState(state);
      return { generation: this.generation(), state };
    }, "BEGIN");
  }

  replace(state, expectedGeneration) {
    validateLibraryState(state);
    this.mutate(() => {
      this.db.exec("DELETE FROM records");
      if (state.workspace !== null)
        this.put("workspace", SINGLETON, {
          backup: state.workspace,
          revision: randomUUID(),
        });
      for (const row of state.reviews) this.put("review", row.id, row);
      for (const row of state.packs) this.put("pack", row.id, row);
      if (state.tab !== null) this.put("tab", SINGLETON, state.tab);
    }, expectedGeneration);
  }

  saveWorkspace(backup, expectedRevision) {
    validateBackup(backup);
    return this.mutate(() => {
      if ((this.get("workspace")?.revision ?? null) !== expectedRevision)
        throw new LibraryConflict();
      const revision = randomUUID();
      this.put("workspace", SINGLETON, { backup, revision });
      return revision;
    });
  }

  saveTab(value) {
    validateLibraryTab(value);
    if (value === null) throw new Error("缺少要保存的界面状态。");
    this.mutate(() => this.put("tab", SINGLETON, value));
  }

  reviews(ids) {
    if (ids !== undefined && !Array.isArray(ids))
      throw new Error("回顾查询无效。");
    const selected = ids ? new Set(ids) : null;
    return this.rows("review")
      .filter((row) => !selected || selected.has(row.id))
      .map(decode);
  }

  saveReview(action) {
    if (!validPackId(action?.id)) throw new Error("回顾记录 ID 不合法。");
    return this.mutate(() => {
      const record = reviewAction(
        this.get("review", action.id) ?? undefined,
        action,
      );
      this.put("review", record.id, record);
      return record;
    });
  }

  clearReviews() {
    this.mutate(() =>
      this.db.exec("DELETE FROM records WHERE kind = 'review'"),
    );
  }

  packs() {
    return this.rows("pack")
      .map(decode)
      .filter((row) => !row.deleted)
      .map(({ id, config, revision, saved_at }) => ({
        id,
        title: config.title,
        revision,
        saved_at,
      }))
      .sort(
        (a, b) =>
          b.saved_at.localeCompare(a.saved_at) || a.id.localeCompare(b.id),
      );
  }

  pack(id) {
    const row = this.get("pack", id);
    return row?.deleted ? null : row;
  }

  savePack({ id, config, baseline, expectedRevision = 0, remove = false }) {
    if (
      !validPackId(id) ||
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0
    )
      throw new Error("主题包保存条件不正确。");
    return this.mutate(() => {
      const previous = this.get("pack", id);
      if ((previous?.revision ?? 0) !== expectedRevision || previous?.deleted)
        throw new LibraryConflict();
      if (remove && !previous) throw new Error("主题包已不存在。");
      if (!previous && this.packs().length >= 100)
        throw new Error("本机最多保留 100 个主题包配置。");
      const next = validatePackDocument({
        schema: 1,
        id,
        revision: expectedRevision + 1,
        saved_at: new Date().toISOString(),
        ...(remove ? { deleted: true } : { config, baseline }),
      });
      this.put("pack", id, next);
      return next;
    });
  }
}
