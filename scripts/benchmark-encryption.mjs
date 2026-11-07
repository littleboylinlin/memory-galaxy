import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { cpus, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { benchmarkGraph } from "../tests/fixtures/benchmark.mjs";

const sizes = [
  [1000, 1],
  [10000, 1],
  [50000, 1],
  [10000, 8],
];
const root = resolve(process.argv[2] || ".");
const [nodes, links] = sizes[Number(process.argv[3])] ?? [];
const moduleUrl = (path) => pathToFileURL(join(root, path)).href;
const load = (path) => import(moduleUrl(path));
const password = "synthetic benchmark password";
const fixedDate = "2026-01-01T00:00:00.000Z";
const rounded = (value) => Number(value.toFixed(2));

async function measure(operation) {
  const start = performance.now();
  const result = await operation();
  return [rounded(performance.now() - start), result];
}

async function interrupt(source, args, beforeKill) {
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", source, ...args],
    {
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  const exit = once(child, "exit");
  try {
    const message = await Promise.race([
      once(child.stdout, "data").then(([chunk]) => chunk.toString()),
      exit.then(() => {
        throw new Error("Writer exited before interruption");
      }),
      delay(20000, null, { ref: false }).then(() => {
        throw new Error("Writer did not reach interruption point");
      }),
    ]);
    assert.match(message, /ready/);
    await beforeKill?.();
  } finally {
    child.kill("SIGKILL");
    await exit;
  }
}

async function run() {
  const [
    { createLibrary, openLibrary, DATABASE_NAME },
    { deriveEncryption, decryptBackup },
    { readBackupBytes, writeNewFile },
    { Workspace },
    { emptyGraph, planImport },
    { describeLibraryRestore, makeLibraryBackup, parseLibraryBackup },
  ] = await Promise.all([
    load("desktop/library.mjs"),
    load("desktop/encryption.mjs"),
    load("desktop/files.mjs"),
    load("web/workspace.mjs"),
    load("web/mgp.mjs"),
    load("web/library-backup.mjs"),
  ]);
  const dir = await mkdtemp(join(tmpdir(), "memory-galaxy-bench-encryption-"));
  const db = join(dir, DATABASE_NAME);
  const backup = join(dir, "synthetic.mgbackup");
  const interrupted = join(dir, "interrupted.mgbackup");
  let key, library, restored, recovered;
  try {
    const graph = planImport(emptyGraph(), benchmarkGraph(nodes, links)).graph;
    const workspace = new Workspace(graph, { now: () => fixedDate });
    workspace.snapshot("synthetic retained snapshot");
    const state = {
      workspace: workspace.backup(),
      reviews: [],
      packs: [],
      tab: null,
    };
    const [deriveMs, derived] = await measure(() => deriveEncryption(password));
    key = derived;
    const [createMs, opened] = await measure(() =>
      createLibrary(db, state, key),
    );
    library = opened;
    let revision = library.get("workspace").revision;
    const writes = [];
    for (let i = 0; i < 8; i++) {
      state.workspace.graph.nodes.at(-1).content = "committed " + i;
      const [ms, next] = await measure(() =>
        library.saveWorkspace(state.workspace, revision),
      );
      revision = next;
      writes.push(ms);
    }
    const before = library.snapshot();
    assert.deepEqual(before.state, state);
    library.close();
    library = undefined;

    const [encryptWriteMs] = await measure(async () => {
      const text = await makeLibraryBackup(before.state, new Date(fixedDate));
      await writeNewFile(backup, key.sealBackup(text));
    });
    key.dispose();
    key = undefined;
    const [readDecryptMs, imported] = await measure(async () =>
      parseLibraryBackup(
        await decryptBackup(await readBackupBytes(backup), password),
      ),
    );
    assert.deepEqual(imported.state, state);

    const target = join(dir, "restored");
    await mkdir(target);
    key = await deriveEncryption("different synthetic destination password");
    restored = await createLibrary(join(target, DATABASE_NAME), undefined, key);
    const [previewMs, preview] = await measure(() =>
      describeLibraryRestore(restored.snapshot().state, imported.state),
    );
    assert.equal(preview.changes[0][1].added, nodes);
    assert.equal(preview.changes[1][1].added, nodes * links);
    const [restoreMs] = await measure(() =>
      restored.replace(imported.state, 0),
    );
    assert.deepEqual(restored.snapshot().state, state);
    restored.close();
    restored = undefined;
    key.dispose();
    key = undefined;

    await interrupt(
      `
      import { openLibrary } from ${JSON.stringify(moduleUrl("desktop/library.mjs"))};
      import { writeSync } from "node:fs";
      import { randomUUID } from "node:crypto";
      const library = await openLibrary(process.argv[1], process.argv[2]);
      library.db.exec("PRAGMA cache_size=2;");
      library.mutate(() => {
        const { backup } = library.get("workspace");
        backup.graph.nodes.at(-1).content = "uncommitted interruption";
        library.put("workspace", "", { backup, revision: randomUUID() });
        writeSync(1, "ready\\n");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      });
    `,
      [db, password],
      async () => {
        assert.ok((await stat(db + "-journal")).size > 0);
      },
    );
    const [reopenMs, reopened] = await measure(() => openLibrary(db, password));
    recovered = reopened;
    assert.deepEqual(recovered.snapshot(), before);
    assert.equal(recovered.get("workspace").revision, revision);

    await interrupt(
      `
      import { stageFile, publishNewFile } from ${JSON.stringify(moduleUrl("desktop/files.mjs"))};
      import { open } from "node:fs/promises";
      import { writeSync } from "node:fs";
      const original = await open(process.argv[1], "r");
      const part = Buffer.alloc(4096);
      const { bytesRead } = await original.read(part);
      await original.close();
      await stageFile(process.argv[2], async (path) => {
        const output = await open(path, "wx", 0o600);
        await output.writeFile(part.subarray(0, bytesRead));
        await output.close();
        writeSync(1, "ready\\n");
        await new Promise(() => setInterval(() => {}, 1000));
      }, publishNewFile);
    `,
      [backup, interrupted],
    );
    await assert.rejects(() => stat(interrupted), { code: "ENOENT" });
    assert.deepEqual(
      (
        await parseLibraryBackup(
          await decryptBackup(await readBackupBytes(backup), password),
        )
      ).state,
      state,
    );

    const ordered = writes.toSorted((a, b) => a - b);
    console.log(
      JSON.stringify({
        nodes,
        edges: nodes * links,
        backupMiB: rounded((await stat(backup)).size / 2 ** 20),
        deriveMs,
        createMs,
        writeMedianMs: rounded((ordered[3] + ordered[4]) / 2),
        writes: writes.length,
        encryptWriteMs,
        readDecryptMs,
        previewMs,
        restoreMs,
        reopenMs,
        peakRssMiB: rounded(process.resourceUsage().maxRSS / 1024),
        recoveredCommit: true,
        rejectedPartialBackup: true,
      }),
    );
  } finally {
    for (const opened of [library, restored, recovered]) opened?.close();
    key?.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

if (nodes) await run();
else {
  console.log(
    JSON.stringify({
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      platform: process.platform + "-" + process.arch,
      kernel: release(),
      node: process.version,
      cpu: cpus()[0].model,
    }),
  );
  for (let i = 0; i < sizes.length; i++)
    process.stdout.write(
      execFileSync(process.execPath, [import.meta.filename, root, String(i)], {
        encoding: "utf8",
        timeout: 120000,
      }),
    );
}
