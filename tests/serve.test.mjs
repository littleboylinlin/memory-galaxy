import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, cp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request } from "node:http";
import { createSiteServer, normalizeBasePath } from "../scripts/serve.mjs";
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "galaxy-serve-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["web", "protocol", "index.html", "LICENSE"])
    await cp(resolve(path), join(root, path), { recursive: true });
  await writeFile(join(root, "package.json"), "private fixture");
  const server = await createSiteServer({ root, basePath: "/memory-galaxy/" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { root, origin: "http://127.0.0.1:" + server.address().port };
}
function raw(origin, path) {
  return new Promise((resolve, reject) => {
    const req = request(origin + path, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    req.on("error", reject);
    req.end();
  });
}
test("serves the built project prefix, redirect, script MIME and HEAD without escaping the mount", async (t) => {
  const { origin } = await fixture(t),
    response = await fetch(origin + "/memory-galaxy/web/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Memory Galaxy/);
  const redirect = await fetch(origin + "/memory-galaxy", {
    redirect: "manual",
  });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get("location"), "/memory-galaxy/");
  const module = await fetch(origin + "/memory-galaxy/web/app.mjs");
  assert.match(module.headers.get("content-type"), /^text\/javascript/);
  assert.equal(module.headers.get("x-content-type-options"), "nosniff");
  const head = await fetch(origin + "/memory-galaxy/web/app.mjs", {
    method: "HEAD",
  });
  assert.equal(await head.text(), "");
  assert.ok(Number(head.headers.get("content-length")) > 0);
  assert.equal(
    (await fetch(origin + "/memory-galaxy/", { method: "POST" })).status,
    405,
  );
});
test("private files, dot paths, malformed encodings and prefix bypasses are not served", async (t) => {
  const { origin } = await fixture(t);
  for (const path of [
    "/web/app.mjs",
    "/memory-galaxy-extra/web/app.mjs",
    "/memory-galaxy/package.json",
    "/memory-galaxy/.git/config",
    "/memory-galaxy/web/%2e%2e/%2e%2e/package.json",
    "/memory-galaxy/web/%2f..%2fpackage.json",
    "/memory-galaxy/%ZZ",
  ])
    assert.equal(await raw(origin, path), 404, path);
});
test("serving a symbolic link cannot expose private files", async (t) => {
  const { root, origin } = await fixture(t);
  await symlink(join(root, "package.json"), join(root, "web", "private.json"));
  assert.equal(
    (await fetch(origin + "/memory-galaxy/web/private.json")).status,
    404,
  );
});
test("base paths are explicit safe directory prefixes", () => {
  for (const path of [
    "memory-galaxy/",
    "/memory-galaxy",
    "/../",
    "//",
    "/project?x/",
    "/project/%2e/",
  ])
    assert.throws(() => normalizeBasePath(path));
  assert.equal(normalizeBasePath("/memory-galaxy/"), "/memory-galaxy/");
  assert.equal(normalizeBasePath("/"), "/");
});
