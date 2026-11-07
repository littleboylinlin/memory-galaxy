import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  Library,
  LibraryConflict,
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
