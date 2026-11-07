import { createHash, randomUUID } from "node:crypto";
import { lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { deriveEncryption, ENCRYPTED_RECORD_OVERHEAD } from "./encryption.mjs";
import { publishNewFile, stageFile } from "./files.mjs";
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
const KEY_PROOF = Buffer.from("memory-galaxy/key/2");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const validators = {
  workspace: (value) => validateBackup(value.backup),
  tab: validateLibraryTab,
  review: validateReviewRecord,
  pack: validatePackDocument,
};

function verifyRecord({ kind, value, bytes, hash }, encryption) {
  if (
    !Object.hasOwn(validators, kind) ||
    (encryption
      ? !(value instanceof Uint8Array) ||
        value.byteLength !== bytes + ENCRYPTED_RECORD_OVERHEAD
      : typeof value !== "string" || bytes !== Buffer.byteLength(value)) ||
    hash !== sha(value)
  )
    throw new Error("资料库的记录未通过完整性校验。");
}

function decode(row, encryption, validate = true) {
  const { kind, id, value } = row;
  verifyRecord(row, encryption);
  const plaintext = encryption?.openRecord(kind, id, value);
  let record;
  try {
    record = JSON.parse(plaintext ? plaintext.toString("utf8") : value);
  } finally {
    plaintext?.fill(0);
  }
  if (
    ((kind === "review" || kind === "pack") &&
      (typeof record?.id !== "string" ||
        (encryption ? encryption.recordId(kind, record.id) : record.id) !==
          id)) ||
    (kind === "workspace" &&
      (!record?.backup ||
        Object.keys(record).length !== 2 ||
        !/^[a-f0-9-]{36}$/.test(record.revision)))
  )
    throw new Error("资料库的记录 ID 或版本未通过校验。");
  if (validate) validators[kind](record);
  return record;
}

export class LibraryConflict extends Error {
  constructor() {
    super("资料库在预览或编辑后发生变化，请重新载入并核对。");
  }
}

export class LibraryLocked extends Error {
  constructor(salt) {
    super("请输入密码解锁本地资料库。");
    this.salt = salt;
  }
}

export async function openLibrary(path, password) {
  try {
    return new Library(path);
  } catch (error) {
    if (!(error instanceof LibraryLocked) || password === undefined)
      throw error;
    const encryption = await deriveEncryption(password, error.salt);
    try {
      return new Library(path, { encryption });
    } finally {
      encryption.dispose();
    }
  }
}

export async function createLibrary(path, state, encryption) {
  for (const suffix of ["-journal", "-wal", "-shm"]) {
    const sidecar = await lstat(path + suffix).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (sidecar)
      throw new Error(
        "发现未配对的 SQLite 日志，请保留原文件并选择其他文件夹。",
      );
  }
  await stageFile(
    path,
    (staged) => {
      const candidate = new Library(staged, { create: true, encryption });
      try {
        if (state) candidate.replace(state, 0);
      } finally {
        candidate.close();
      }
    },
    publishNewFile,
  );
  return new Library(path, { encryption });
}

export class Library {
  #workspaceIdentity;

  constructor(path, { create = false, encryption } = {}) {
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
      this.db.exec(
        "PRAGMA busy_timeout=3000; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA;",
      );
      if (process.platform === "darwin") this.db.exec("PRAGMA fullfsync=ON;");
      const applicationId = this.db
        .prepare("PRAGMA application_id")
        .get().application_id;
      if (!existing && applicationId === 0)
        this.transaction(() => {
          this.db.exec(`
          PRAGMA application_id=${APPLICATION_ID};
          PRAGMA user_version=${encryption ? 2 : 1};
          CREATE TABLE records (
            kind TEXT NOT NULL CHECK (kind IN ('workspace', 'tab', 'review', 'pack')),
            id TEXT NOT NULL,
            value ${encryption ? "BLOB" : "TEXT"} NOT NULL,
            bytes INTEGER NOT NULL CHECK (bytes > 0),
            hash TEXT NOT NULL,
            PRIMARY KEY (kind, id),
            CHECK ((kind IN ('workspace', 'tab') AND id = '') OR
                   (kind IN ('review', 'pack') AND id <> ''))
          ) STRICT;
          CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK (id = 1), generation INTEGER NOT NULL CHECK (generation >= 0)) STRICT;
          INSERT INTO meta VALUES (1, 0);
        `);
          if (encryption) {
            this.db.exec(
              "CREATE TABLE protection (id INTEGER PRIMARY KEY CHECK (id=1), salt TEXT NOT NULL, proof BLOB NOT NULL) STRICT",
            );
            this.db
              .prepare("INSERT INTO protection VALUES (1, ?, ?)")
              .run(
                encryption.salt,
                encryption.sealRecord("proof", "", KEY_PROOF),
              );
          }
        });
      const version = this.db.prepare("PRAGMA user_version").get().user_version;
      if (
        this.db.prepare("PRAGMA application_id").get().application_id !==
          APPLICATION_ID ||
        ![1, 2].includes(version)
      )
        throw new Error("资料库版本不兼容或文件未通过 SQLite 完整性检查。");
      if (version === 2) {
        const row = this.db
          .prepare("SELECT salt, proof FROM protection WHERE id=1")
          .get();
        if (
          !row ||
          !/^[a-f0-9]{32}$/.test(row.salt) ||
          !(row.proof instanceof Uint8Array)
        )
          throw new Error("加密资料库的头部损坏。");
        if (!encryption) throw new LibraryLocked(row.salt);
        if (
          row.salt !== encryption.salt ||
          !encryption.openRecord("proof", "", row.proof).equals(KEY_PROOF)
        )
          throw new Error("密码不正确，或加密资料库已损坏。");
        this.encryption = encryption.copy();
      } else if (encryption)
        throw new Error("资料库在解锁时发生变化，请重试。");
      if (this.db.prepare("PRAGMA quick_check(1)").get().quick_check !== "ok")
        throw new Error("文件未通过 SQLite 完整性检查。");
      this.db.exec("PRAGMA journal_mode=DELETE;");
      this.snapshot();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  close() {
    try {
      this.db.close();
    } finally {
      this.encryption?.dispose();
    }
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

  row(kind, id) {
    return this.db
      .prepare("SELECT * FROM records WHERE kind = ? AND id = ?")
      .get(kind, this.encryption ? this.encryption.recordId(kind, id) : id);
  }

  get(kind, id = SINGLETON) {
    const row = this.row(kind, id);
    if (!row) return null;
    const record = decode(row, this.encryption);
    if (kind === "workspace")
      this.#workspaceIdentity = { hash: row.hash, revision: record.revision };
    return record;
  }

  workspaceRevision() {
    const row = this.row("workspace", SINGLETON);
    if (!row) return null;
    if (row.hash === this.#workspaceIdentity?.hash) {
      verifyRecord(row, this.encryption);
      return this.#workspaceIdentity.revision;
    }
    const { revision } = decode(row, this.encryption);
    return revision;
  }

  rows(kind) {
    return this.db
      .prepare("SELECT * FROM records WHERE kind = ? ORDER BY id")
      .all(kind);
  }

  decodedRows(kind, validate = true) {
    const records = this.rows(kind).map((row) =>
      decode(row, this.encryption, validate),
    );
    if (this.encryption)
      records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return records;
  }

  put(kind, id, record) {
    const text = JSON.stringify(record);
    const bytes = Buffer.byteLength(text);
    if (bytes > LIBRARY_BYTES) throw new Error("记录超过本地资料库大小上限。");
    const key = this.encryption ? this.encryption.recordId(kind, id) : id;
    const value = this.encryption
      ? this.encryption.sealRecord(kind, key, text)
      : text;
    const hash = sha(value);
    this.db
      .prepare(
        "INSERT OR REPLACE INTO records (kind,id,value,bytes,hash) VALUES (?,?,?,?,?)",
      )
      .run(kind, key, value, bytes, hash);
    return hash;
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
      const workspace = this.row("workspace", SINGLETON);
      const record = workspace
        ? decode(workspace, this.encryption, false)
        : null;
      const tab = this.row("tab", SINGLETON);
      const state = {
        workspace: record ? record.backup : null,
        reviews: this.decodedRows("review", false),
        packs: this.decodedRows("pack", false),
        tab: tab ? decode(tab, this.encryption, false) : null,
      };
      validateLibraryState(state);
      if (record)
        this.#workspaceIdentity = {
          hash: workspace.hash,
          revision: record.revision,
        };
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
    const revision = randomUUID();
    const hash = this.mutate(() => {
      if (this.workspaceRevision() !== expectedRevision)
        throw new LibraryConflict();
      return this.put("workspace", SINGLETON, { backup, revision });
    });
    this.#workspaceIdentity = { hash, revision };
    return revision;
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
    return this.decodedRows("review").filter(
      (row) => !selected || selected.has(row.id),
    );
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
    return this.decodedRows("pack")
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
