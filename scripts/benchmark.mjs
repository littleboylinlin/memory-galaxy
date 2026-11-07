import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

const root = resolve(process.argv[2] || ".");
const load = (path) => import(pathToFileURL(join(root, path)).href);
const [
  { Library },
  { Workspace },
  { parseMgp, planImport, emptyGraph },
  filter,
  layout,
  backup,
] = await Promise.all([
  load("desktop/library.mjs"),
  load("web/workspace.mjs"),
  load("web/mgp.mjs"),
  load("web/memory-filter.mjs"),
  load("web/layout.mjs"),
  load("web/library-backup.mjs"),
]);

function fixture(count, links) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: "n:" + i,
    label: "m" + i,
    type: i % 3 ? "memory" : "topic",
    content: i % 47 ? "body" : "zephyr",
    tags: ["g" + (i % 7)],
  }));
  const edges = Array.from({ length: count * links }, (_, i) => {
    const from = Math.floor(i / links);
    return {
      from: nodes[from].id,
      to: nodes[(from + (i % links) + 1) % count].id,
      type: "link",
      basis: "explicit",
    };
  });
  return {
    protocol: "mgp/1.1",
    source: { id: "s", platform: "manual", completeness: "partial" },
    nodes,
    edges,
  };
}

const rounded = (value) => Number(value.toFixed(2));
const median = (values) =>
  rounded(values.toSorted((a, b) => a - b)[values.length >> 1]);
const mib = (bytes) => rounded(bytes / 2 ** 20);
async function measure(operation) {
  const start = performance.now();
  const value = await operation();
  return [rounded(performance.now() - start), value];
}

async function browserMetrics(site, graph, query) {
  const page = await site.browser.newPage({
    viewport: { width: 1365, height: 900 },
  });
  try {
    await page.goto(site.url);
    const ready = page.locator("body[data-ready=true]");
    await ready.waitFor();
    const importing = performance.now();
    await page.locator("#fileInput").setInputFiles({
      name: "synthetic.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(graph)),
    });
    await page.waitForFunction(
      () =>
        !document.getElementById("applyImport").disabled ||
        !document.getElementById("importErrors").hidden,
    );
    const errors = page.locator("#importErrors");
    if (await errors.isVisible()) throw new Error(await errors.innerText());
    await page.locator("#applyImport").click();
    const count = new Intl.NumberFormat("zh-CN").format(graph.nodes.length);
    await page.waitForFunction(
      (value) => document.getElementById("nodeCount").textContent === value,
      count,
    );
    const importMs = rounded(performance.now() - importing);
    const frames = page.evaluate(async () => {
      const started = performance.now();
      const canvas = document.getElementById("sky");
      const bounds = canvas.getBoundingClientRect();
      let count = 0;
      return new Promise((resolve) => {
        function tick() {
          count++;
          const elapsed = performance.now() - started;
          if (elapsed >= 1800)
            resolve({ fps: (count * 1000) / elapsed, elapsed });
          else {
            canvas.dispatchEvent(
              new WheelEvent("wheel", {
                deltaY: count % 2 ? -12 : 12,
                clientX: bounds.left + bounds.width / 2,
                clientY: bounds.top + bounds.height / 2,
                cancelable: true,
              }),
            );
            requestAnimationFrame(tick);
          }
        }
        requestAnimationFrame(tick);
      });
    });
    const layoutStart = performance.now();
    await page.waitForFunction(
      () =>
        document.getElementById("layoutStatus").textContent === "星图布局就绪",
      null,
      { timeout: 120000 },
    );
    const layoutMs = rounded(performance.now() - layoutStart);
    const { fps, elapsed } = await frames;
    const beforeSearch = performance.now();
    await page.locator("#search").fill(query);
    await page.locator("#searchResults li").first().waitFor();
    const searchMs = rounded(performance.now() - beforeSearch);
    const exportStart = performance.now();
    const download = page.waitForEvent("download");
    await page.locator("#exportBtn").click();
    const path = await (await download).path();
    const exported = JSON.parse(await readFile(path, "utf8"));
    assert.equal(exported.nodes.length, graph.nodes.length);
    assert.equal(exported.edges.length, graph.edges.length);
    const exportMs = rounded(performance.now() - exportStart);
    await page.locator("#saveBtn").click();
    await page.waitForFunction(
      () =>
        document.getElementById("saveStatus").textContent === "已保存到本机",
      null,
      { timeout: 60000 },
    );
    const reload = performance.now();
    await page.reload();
    await ready.waitFor();
    const reopenMs = rounded(performance.now() - reload);
    const heap = await page.evaluate(() => performance.memory?.usedJSHeapSize);
    return {
      importMs,
      layoutMs,
      sampleMs: rounded(elapsed),
      animationFps: rounded(fps),
      searchMs,
      exportMs,
      reopenMs,
      jsHeapMiB: heap ? mib(heap) : null,
    };
  } finally {
    await page.context().close();
  }
}

let site;
const temp = await mkdtemp(join(tmpdir(), "memory-galaxy-bench-"));
const query = "zephyr";
try {
  if (process.env.MEMORY_GALAXY_BENCH_BROWSER === "1") {
    const { chromium } = await import("@playwright/test");
    const { createSiteServer } = await import("./serve.mjs");
    const server = await createSiteServer({ root });
    site = { server };
    await new Promise((done, reject) =>
      server.listen(0, "127.0.0.1", done).once("error", reject),
    );
    site.url = "http://127.0.0.1:" + server.address().port + "/web/";
    site.browser = await chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
      args: ["--enable-precise-memory-info"],
    });
  }
  console.log(
    JSON.stringify({
      revision: execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
      }).trim(),
      node: process.version,
      platform: process.platform + "-" + process.arch,
      cpu: cpus()[0].model,
      browser: site?.browser.version() ?? null,
    }),
  );
  for (const [count, links] of [
    [1000, 1],
    [10000, 1],
    [50000, 1],
    [10000, 8],
  ]) {
    const graph = fixture(count, links);
    const input = JSON.stringify(graph);
    const [parseMs, { graph: parsed }] = await measure(() => parseMgp(input));
    assert.equal(parsed.nodes.length, count);
    assert.equal(parsed.edges.length, graph.edges.length);
    const [planMs, { graph: merged }] = await measure(() =>
      planImport(emptyGraph(), parsed),
    );
    assert.equal(merged.nodes.length, count);
    assert.equal(merged.edges.length, graph.edges.length);
    const [layoutMs, state] = await measure(() =>
      layout.createLayout(graph.nodes, graph.edges),
    );
    const [twentyStepsMs] = await measure(() => layout.stepLayout(state, 20));
    const search = filter.createMemorySearch?.();
    const searches = [];
    for (let i = 0; i < 9; i++) {
      const options = { keyword: i % 2 ? "m" : query };
      const [ms, rows] = await measure(() =>
        search
          ? search(graph.nodes, options)
          : graph.nodes.filter((node) => filter.matchesMemory(node, options)),
      );
      assert.equal(rows.length, i % 2 ? count : Math.ceil(count / 47));
      searches.push(ms);
    }
    const data = {
      workspace: new Workspace(merged).backup(),
      reviews: [],
      packs: [],
      tab: null,
    };
    const [backupMs, exported] = await measure(() =>
      backup.makeLibraryBackup(data),
    );
    const [restoreMs, restored] = await measure(() =>
      backup.parseLibraryBackup(exported),
    );
    assert.deepEqual(restored.state, data);
    const path = join(temp, count + "-" + links + ".sqlite3");
    const library = new Library(path, { create: true });
    const [writeMs] = await measure(() => library.replace(data, 0));
    const revision = library.get("workspace").revision;
    const [saveMs] = await measure(() =>
      library.saveWorkspace(data.workspace, revision),
    );
    library.close();
    const [reopenMs, reopened] = await measure(() => new Library(path));
    assert.deepEqual(reopened.snapshot().state, data);
    reopened.close();
    console.log(
      JSON.stringify({
        nodes: count,
        edges: graph.edges.length,
        inputMiB: mib(Buffer.byteLength(input)),
        mergedMiB: mib(Buffer.byteLength(JSON.stringify(merged))),
        rssMiB: mib(process.memoryUsage.rss()),
        parseMs,
        planMs,
        layoutMs,
        twentyStepsMs,
        coldSearchMs: searches[0],
        searchMs: median(searches.slice(1)),
        backupMs,
        restoreMs,
        writeMs,
        saveMs,
        reopenMs,
        ...(site ? { browser: await browserMetrics(site, graph, query) } : {}),
      }),
    );
  }
} finally {
  await site?.browser?.close();
  site?.server.close();
  await rm(temp, { recursive: true, force: true });
}
