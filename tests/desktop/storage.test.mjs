import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  Library,
  LibraryConflict,
  LibraryLocked,
  createLibrary,
  openLibrary,
  DATABASE_NAME,
} from "../../desktop/library.mjs";
import {
  makeLibraryBackup,
  parseLibraryBackup,
  describeLibraryRestore,
} from "../../web/library-backup.mjs";
import {
  readBackupFile,
  readFolderSetting,
  writeFolderSetting,
  writeNewFile,
} from "../../desktop/files.mjs";
import {
  decryptBackup,
  deriveEncryption,
  isEncryptedBackup,
  validateEncryptionPassword,
} from "../../desktop/encryption.mjs";
import { graph, libraryFixture } from "../fixtures/desktop.mjs";
import { Workspace } from "../../web/workspace.mjs";

async function directory(t) {
  const dir = await mkdtemp(join(tmpdir(), "memory-galaxy-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("complete backup preserves records, scopes legacy files, and rejects corruption", async () => {
  const state = await libraryFixture();
  const text = await makeLibraryBackup(state);
  assert.deepEqual((await parseLibraryBackup(text)).state, state);
  await assert.rejects(
    () => parseLibraryBackup(text.replace("测试原文", "修改原文")),
    /完整性/,
  );
  await assert.rejects(
    () => parseLibraryBackup('{"format":"memory-galaxy/topic-pack/1"}'),
    /完整资料备份/,
  );
  await assert.rejects(
    () =>
      makeLibraryBackup({
        ...state,
        reviews: [...state.reviews, ...state.reviews],
      }),
    /重复/,
  );
  assert.deepEqual(await parseLibraryBackup(JSON.stringify(state.workspace)), {
    kind: "workspace",
    created_at: state.workspace.created_at,
    workspace: state.workspace,
  });
  const changed = structuredClone(state);
  changed.workspace.graph.nodes[0].content += "不同内容";
  changed.workspace.graph.nodes.push({
    id: "new",
    label: "新记录",
    type: "memory",
  });
  changed.workspace.graph.edges = [];
  const { changes, favorites } = describeLibraryRestore(state, changed);
  assert.deepEqual(changes[0], [
    "记忆",
    {
      incoming: 3,
      added: 1,
      changed: 1,
      removed: 0,
      conflicts: ["memory:original"],
    },
  ]);
  assert.equal(changes[1][1].removed, 1);
  assert.equal(favorites, 1);
});

test("SQLite reopen and migration preserve independent state; stale writes are rejected", async (t) => {
  const dir = await directory(t);
  const path = join(dir, DATABASE_NAME);
  const state = await libraryFixture();
  const first = new Library(path, { create: true });
  first.replace(state, 0);
  first.close();
  const local = new Library(path);
  const concurrent = new Library(path);
  try {
    const { generation, state: restored } = local.snapshot();
    assert.deepEqual(
      {
        ...restored,
        packs: restored.packs.toSorted((a, b) => b.id.localeCompare(a.id)),
      },
      state,
    );
    const revision = local.get("workspace").revision;
    local.saveWorkspace(state.workspace, revision);
    assert.throws(
      () => concurrent.saveWorkspace(state.workspace, revision),
      LibraryConflict,
    );
    concurrent.saveReview({
      id: graph.nodes[0].id,
      kind: "favorite",
      value: false,
    });
    assert.throws(() => local.replace(state, generation), LibraryConflict);
    assert.equal(local.reviews()[0].favorite, false);
    assert.deepEqual(local.reviews()[0].reviewed, state.reviews[0].reviewed);
    assert.equal(local.pack("pack:removed"), null);
    assert.deepEqual(local.pack("pack:test"), state.packs[0]);
    assert.throws(
      () => local.savePack({ id: "pack:test", expectedRevision: 0 }),
      LibraryConflict,
    );
    assert.throws(
      () => local.savePack({ id: "pack:removed", expectedRevision: 2 }),
      LibraryConflict,
    );
  } finally {
    concurrent.close();
    local.close();
  }
});

test("a SQLite capacity failure rolls back the complete replacement", async (t) => {
  const store = new Library(join(await directory(t), DATABASE_NAME), {
    create: true,
  });
  try {
    const state = await libraryFixture();
    store.replace(state, 0);
    const before = store.snapshot();
    const count = store.db.prepare("PRAGMA page_count").get().page_count;
    store.db.exec("PRAGMA max_page_count=" + count);
    const large = structuredClone(graph);
    large.nodes[0].content = "测试".repeat(30000);
    const incoming = {
      ...state,
      workspace: new Workspace(large).backup(),
      packs: [],
    };
    assert.throws(() => store.replace(incoming, before.generation), /full/i);
    assert.deepEqual(store.snapshot(), before);
  } finally {
    store.close();
  }
});

test(
  "killing a writer with an open journal recovers the last committed generation",
  { timeout: 15000 },
  async (t) => {
    const path = join(await directory(t), DATABASE_NAME);
    const store = new Library(path, { create: true });
    store.replace(await libraryFixture(), 0);
    const before = store.snapshot();
    store.close();
    const writer = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--input-type=module",
        "-e",
        `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(process.argv[1]);
    db.exec("PRAGMA cache_size=2; PRAGMA journal_mode=DELETE; BEGIN IMMEDIATE");
    db.exec("UPDATE records SET value=printf('%1000000s', 'interrupted') WHERE kind='workspace'");
    console.log("transaction open");
    setInterval(() => {}, 1000);
  `,
        path,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exit = once(writer, "exit");
    t.after(() => writer.kill());
    const ready = await Promise.race([
      once(writer.stdout, "data").then(([data]) => data.toString()),
      exit.then(() => {
        throw new Error("writer exited before its transaction opened");
      }),
    ]);
    assert.match(ready, /transaction open/);
    assert.ok((await stat(path + "-journal")).size > 0);
    writer.kill("SIGKILL");
    await exit;
    const recovered = new Library(path);
    try {
      assert.deepEqual(recovered.snapshot(), before);
    } finally {
      recovered.close();
    }
  },
);

test("damaged and missing databases fail closed; files and backup targets are preserved", async (t) => {
  const dir = await directory(t);
  const path = join(dir, DATABASE_NAME);
  assert.throws(() => new Library(path), /缺失/);
  const store = new Library(path, { create: true });
  store.replace(await libraryFixture(), 0);
  store.close();
  const db = new DatabaseSync(path);
  db.exec("UPDATE records SET hash='broken' WHERE kind='workspace'");
  db.close();
  const damaged = await readFile(path);
  assert.throws(() => new Library(path, { create: true }), /完整性/);
  assert.deepEqual(await readFile(path), damaged);
  await writeFile(path, "corrupt SQLite file");
  assert.throws(() => new Library(path), /database/i);
  assert.equal(await readFile(path, "utf8"), "corrupt SQLite file");
  const settings = join(dir, "location.json");
  await writeFolderSetting(settings, dir);
  await writeFolderSetting(settings, join(dir, "new"));
  assert.equal(await readFolderSetting(settings), join(dir, "new"));
  const backup = join(dir, "backup.json");
  await writeNewFile(backup, "original");
  await assert.rejects(() => writeNewFile(backup, "replacement"), {
    code: "EEXIST",
  });
  assert.equal(await readBackupFile(backup), "original");
});

test("failed and competing migrations never publish a partial or replacement database", async (t) => {
  const dir = await directory(t);
  const path = join(dir, DATABASE_NAME);
  const state = await libraryFixture();
  await assert.rejects(
    () => createLibrary(path, { ...state, packs: null }),
    /数组/,
  );
  assert.deepEqual(await readdir(dir), []);
  const [first, second] = await Promise.allSettled([
    createLibrary(path, state),
    createLibrary(path),
  ]);
  const results = [first, second];
  assert.equal(
    results.filter(({ status }) => status === "fulfilled").length,
    1,
  );
  for (const result of results) {
    if (result.status === "fulfilled") result.value.close();
    else assert.equal(result.reason.code, "EEXIST");
  }
  const bytes = await readFile(path);
  await assert.rejects(() => createLibrary(path, state), { code: "EEXIST" });
  assert.deepEqual(await readFile(path), bytes);
  const missing = join(dir, "missing.sqlite3");
  await writeFile(missing + "-journal", "orphan");
  await assert.rejects(() => createLibrary(missing), /SQLite 日志/);
  assert.equal(await readFile(missing + "-journal", "utf8"), "orphan");
  await assert.rejects(() => stat(missing), { code: "ENOENT" });
});

test(
  "a killed staging writer never exposes incomplete backup bytes at the destination",
  { timeout: 15000 },
  async (t) => {
    const dir = await directory(t);
    const path = join(dir, "backup.json");
    const filesModule = new URL("../../desktop/files.mjs", import.meta.url)
      .href;
    const writer = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
    import { writeFile } from "node:fs/promises";
    import { stageFile, publishNewFile } from ${JSON.stringify(filesModule)};
    await stageFile(process.argv[1], async (temporary) => {
      await writeFile(temporary, "partial");
      console.log("staged");
      await new Promise(() => setInterval(() => {}, 1000));
    }, publishNewFile);
  `,
        path,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exit = once(writer, "exit");
    t.after(() => writer.kill());
    const [signal] = await Promise.race([
      once(writer.stdout, "data"),
      exit.then(() => assert.fail("Writer exited early")),
    ]);
    assert.match(signal.toString(), /staged/);
    writer.kill("SIGKILL");
    await exit;
    await assert.rejects(() => stat(path), { code: "ENOENT" });
    await writeNewFile(path, "complete");
    assert.equal(await readBackupFile(path), "complete");
  },
);

test(
  "permission errors leave the last backup and SQLite database intact",
  {
    skip:
      process.platform === "win32" || process.getuid?.() === 0
        ? "requires unprivileged POSIX file permissions"
        : false,
  },
  async (t) => {
    const dir = await directory(t);
    const readOnly = join(dir, "read-only");
    await mkdir(readOnly);
    const path = join(readOnly, DATABASE_NAME);
    const library = await createLibrary(path, await libraryFixture());
    const prior = library.snapshot();
    const backup = join(readOnly, "complete.json");
    await writeNewFile(backup, await makeLibraryBackup(prior.state));
    const bytes = await readFile(backup);
    try {
      await chmod(readOnly, 0o500);
      await assert.rejects(() => writeNewFile(backup, "replacement"), {
        code: "EACCES",
      });
      assert.throws(
        () => library.replace(prior.state, prior.generation),
        /readonly|disk|open/i,
      );
      assert.deepEqual(library.snapshot(), prior);
      assert.deepEqual(await readFile(backup), bytes);
    } finally {
      await chmod(readOnly, 0o700);
      library.close();
    }
  },
);

test("encrypted copy retains the old plaintext library and requires authentication on reopen", async (t) => {
  const dir = await directory(t);
  const originalPath = join(dir, "original.sqlite3");
  const path = join(dir, "encrypted.sqlite3");
  const original = await createLibrary(originalPath, await libraryFixture());
  const { state } = original.snapshot();
  original.close();
  const before = await readFile(originalPath);
  const password = "example test password only";
  const key = await deriveEncryption(password);
  try {
    const encrypted = await createLibrary(path, state, key);
    assert.deepEqual(encrypted.snapshot().state, state);
    assert.deepEqual(encrypted.reviews(["memory:original"]), state.reviews);
    assert.deepEqual(
      encrypted.pack("pack:test"),
      state.packs.find((row) => row.id === "pack:test"),
    );
    encrypted.close();
  } finally {
    key.dispose();
  }
  const bytes = await readFile(path);
  for (const text of [
    password,
    "测试原文",
    "memory:original",
    "fixture:page-1",
    "pack:test",
  ])
    assert.ok(!bytes.includes(Buffer.from(text)), text);
  await assert.rejects(() => openLibrary(path), LibraryLocked);
  await assert.rejects(
    () => openLibrary(path, "incorrect test password"),
    /密码不正确/,
  );
  assert.deepEqual(await readFile(path), bytes);
  assert.deepEqual(await readFile(originalPath), before);
  const reopened = await openLibrary(path, password);
  try {
    assert.deepEqual(reopened.snapshot().state, state);
    const revision = reopened.get("workspace").revision;
    const next = reopened.saveWorkspace(state.workspace, revision);
    assert.notEqual(next, revision);
    assert.throws(
      () => reopened.saveWorkspace(state.workspace, revision),
      LibraryConflict,
    );
  } finally {
    reopened.close();
  }
});

test("encrypted backups authenticate bytes and restore the existing JSON payload", async () => {
  const password = "another test password only";
  const key = await deriveEncryption(password);
  const state = await libraryFixture();
  const json = await makeLibraryBackup(state);
  let bytes;
  try {
    bytes = key.sealBackup(json);
    assert.notDeepEqual(key.sealBackup(json), bytes);
  } finally {
    key.dispose();
  }
  assert.ok(isEncryptedBackup(bytes));
  assert.ok(!bytes.includes(Buffer.from("测试原文")));
  assert.equal(await decryptBackup(bytes, password), json);
  assert.deepEqual(
    (await parseLibraryBackup(await decryptBackup(bytes, password))).state,
    state,
  );
  await assert.rejects(
    () => decryptBackup(bytes, "incorrect test password"),
    /密码不正确/,
  );
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(() => decryptBackup(bytes, password), /加密数据已损坏/);
});

test("encryption password limits count characters and cap encoded bytes", () => {
  assert.doesNotThrow(() => validateEncryptionPassword("密".repeat(12)));
  assert.doesNotThrow(() => validateEncryptionPassword("😀".repeat(256)));
  assert.throws(() => validateEncryptionPassword("😀".repeat(11)), /至少 12/);
  assert.throws(
    () => validateEncryptionPassword("😀".repeat(257)),
    /1024 字节/,
  );
});

test("encrypted SQLite records authenticate both kind and stable ID", async () => {
  const key = await deriveEncryption("synthetic record test password");
  const id = key.recordId("review", "memory:synthetic");
  const content = Buffer.from("synthetic record");
  try {
    const ciphertext = key.sealRecord("review", id, content);
    assert.deepEqual(key.openRecord("review", id, ciphertext), content);
    assert.notDeepEqual(key.sealRecord("review", id, content), ciphertext);
    assert.throws(
      () => key.openRecord("review", "different", ciphertext),
      /加密数据已损坏/,
    );
    assert.throws(
      () => key.openRecord("pack", id, ciphertext),
      /加密数据已损坏/,
    );
  } finally {
    key.dispose();
  }
});

const fullDisk = process.env.MEMORY_GALAXY_FULL_DISK_DIRECTORY;
if (fullDisk)
  test("bounded disk mount returns ENOSPC without replacing committed data", async () => {
    const path = join(fullDisk, DATABASE_NAME);
    const password = "synthetic full disk password";
    const key = await deriveEncryption(password);
    let library;
    try {
      library = await createLibrary(path, await libraryFixture(), key);
      const before = library.snapshot();
      const previous = join(fullDisk, "previous.mgbackup");
      const text = await makeLibraryBackup(before.state);
      const encrypted = key.sealBackup(text);
      await writeNewFile(previous, encrypted);
      const next = join(fullDisk, "next.mgbackup");
      await assert.rejects(
        () => writeNewFile(next, Buffer.alloc(4 * 1024 ** 2)),
        { code: "ENOSPC" },
      );
      await assert.rejects(() => stat(next), { code: "ENOENT" });
      const filler = join(fullDisk, "fill");
      await assert.rejects(
        () => writeFile(filler, Buffer.alloc(4 * 1024 ** 2), { flag: "wx" }),
        { code: "ENOSPC" },
      );
      assert.throws(
        () => library.replace(before.state, before.generation),
        /full|disk|open/i,
      );
      await rm(filler);
      assert.deepEqual(library.snapshot(), before);
      assert.deepEqual(await readFile(previous), encrypted);
      assert.equal(await decryptBackup(encrypted, password), text);
    } finally {
      library?.close();
      key.dispose();
    }
  });
