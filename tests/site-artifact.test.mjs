import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  cp,
  writeFile,
  readFile,
  mkdir,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  buildSite,
  verifyBuild,
  validateManifest,
  publicPath,
  MANIFEST,
} from "../scripts/site-artifact.mjs";
import { siteBase, verifySite } from "../scripts/verify-site.mjs";
const revision = "a".repeat(40);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "galaxy-build-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of [
    "web",
    "protocol",
    "index.html",
    "LICENSE",
    "package.json",
  ])
    await cp(resolve(path), join(root, path), { recursive: true });
  return root;
}
async function built(t) {
  const root = await fixture(t),
    manifest = await buildSite(root, { revision });
  return { root, output: join(root, "dist"), manifest };
}
function responseFrom(output, manifest, { tamper, wrongType = false } = {}) {
  return async (input) => {
    const url = new URL(input);
    assert.equal(url.origin, "https://example.test");
    assert.ok(url.pathname.startsWith("/memory-galaxy/"));
    const path = url.pathname.slice("/memory-galaxy/".length);
    let bytes =
      path === MANIFEST
        ? Buffer.from(JSON.stringify(manifest))
        : await readFile(join(output, path));
    if (path === tamper) bytes = Buffer.from("changed");
    const type = path.endsWith(".mjs")
      ? "text/javascript"
      : path.endsWith(".css")
        ? "text/css"
        : path.endsWith(".html")
          ? "text/html"
          : path.endsWith(".json")
            ? "application/json"
            : "text/plain";
    return new Response(bytes, {
      headers: { "Content-Type": wrongType ? "text/plain" : type },
    });
  };
}

test("builds include the license, protocol and workers but exclude private root and development files", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, ".env"), "PRIVATE_NOTE=fixture");
  await mkdir(join(root, "tests"));
  await writeFile(
    join(root, "tests", "unused.mjs"),
    'throw new Error("not shipped")',
  );
  const manifest = await buildSite(root, { revision });
  assert.equal(manifest.revision, revision);
  assert.ok(manifest.files.some((file) => file.path === "LICENSE"));
  assert.ok(
    manifest.files.some((file) => file.path === "web/backup-worker.mjs"),
  );
  assert.ok(
    !manifest.files.some(
      (file) => file.path.includes("tests") || file.path.startsWith("."),
    ),
  );
  assert.equal(
    (await verifyBuild(join(root, "dist"), { revision })).version,
    JSON.parse(await readFile(join(root, "package.json"), "utf8")).version,
  );
});
test("unsupported source files fail before replacing a previous valid build", async (t) => {
  const { root, output } = await built(t),
    before = await readFile(join(output, MANIFEST), "utf8");
  await writeFile(join(root, "web", "private.env"), "fixture");
  await assert.rejects(buildSite(root, { revision }), /Unexpected source file/);
  assert.equal(await readFile(join(output, MANIFEST), "utf8"), before);
});
test("symlinks cannot pull arbitrary files into a site artifact", async (t) => {
  const root = await fixture(t);
  await writeFile(join(root, "private.json"), "{}");
  await symlink(join(root, "private.json"), join(root, "web", "linked.json"));
  await assert.rejects(buildSite(root, { revision }), /Symbolic links/);
});
test("missing, extra and modified files fail artifact verification", async (t) => {
  const { output } = await built(t),
    path = join(output, "web", "app.mjs"),
    original = await readFile(path);
  await writeFile(path, Buffer.alloc(original.length, 32));
  await assert.rejects(verifyBuild(output), /does not match/);
  await writeFile(path, original);
  await writeFile(join(output, "trace.log"), "fixture");
  await assert.rejects(verifyBuild(output), /unexpected files/);
  await rm(join(output, "trace.log"));
  await rm(path);
  await assert.rejects(verifyBuild(output), /missing or unexpected/);
});
test("revision mismatches and unsafe or duplicate manifest paths are rejected", async (t) => {
  const { output, manifest } = await built(t);
  await assert.rejects(
    verifyBuild(output, { revision: "b".repeat(40) }),
    /revision/,
  );
  for (const change of [
    (value) => (value.files[0].path = "../private.json"),
    (value) => (value.files[0].path = "web/%2e%2e/private.json"),
    (value) => value.files.push(value.files[0]),
    (value) => (value.revision = "main"),
    (value) => (value.format = "unknown/2"),
    (value) => (value.files[0].bytes = Infinity),
  ]) {
    const value = structuredClone(manifest);
    change(value);
    assert.throws(() => validateManifest(value));
  }
  for (const path of [
    ".env",
    "web/.config.json",
    "web/../../LICENSE",
    "web/x\\y.mjs",
    "https://other.test/x",
    "node_modules/package.json",
  ])
    assert.equal(publicPath(path), false);
});
test("remote checks bind the project URL, expected commit and trusted artifact", async (t) => {
  const { output, manifest } = await built(t);
  const result = await verifySite("https://example.test/memory-galaxy", {
    revision,
    expected: manifest,
    fetcher: responseFrom(output, manifest),
  });
  assert.equal(result.revision, revision);
  assert.equal(
    siteBase("https://example.test/memory-galaxy").pathname,
    "/memory-galaxy/",
  );
  await assert.rejects(
    verifySite("https://example.test/memory-galaxy/", {
      revision: "b".repeat(40),
      fetcher: responseFrom(output, manifest),
    }),
    /revision/,
  );
  const altered = structuredClone(manifest);
  altered.version = "9.0.0";
  await assert.rejects(
    verifySite("https://example.test/memory-galaxy/", {
      expected: manifest,
      fetcher: responseFrom(output, altered),
    }),
    /trusted local artifact/,
  );
});
test("remote asset corruption, oversized responses and wrong script MIME fail closed", async (t) => {
  const { output, manifest } = await built(t);
  await assert.rejects(
    verifySite("https://example.test/memory-galaxy/", {
      fetcher: responseFrom(output, manifest, { tamper: "web/app.mjs" }),
    }),
    /expected size|manifest/,
  );
  await assert.rejects(
    verifySite("https://example.test/memory-galaxy/", {
      fetcher: responseFrom(output, manifest, { wrongType: true }),
    }),
    /Content-Type/,
  );
  await assert.rejects(
    verifySite("https://example.test/memory-galaxy/", {
      fetcher: async () =>
        new Response("x", { headers: { "Content-Length": "999999999" } }),
    }),
    /expected size/,
  );
});
test("site checks reject credential-bearing and ambiguous URLs before any request", async () => {
  for (const url of [
    "https://user:pass@example.test/project/",
    "https://example.test/project/?token=fixture",
    "https://example.test/project/#view",
    "http://example.test/project/",
    "file:///tmp/site/",
  ])
    assert.throws(() => siteBase(url));
  assert.equal(
    siteBase("http://127.0.0.1:4173/memory-galaxy/").protocol,
    "http:",
  );
});
