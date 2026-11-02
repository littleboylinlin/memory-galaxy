import { createHash } from "node:crypto";
import {
  cp,
  readFile,
  readdir,
  lstat,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { resolve, join, extname } from "node:path";
import { execFileSync } from "node:child_process";
import { PROTOCOL } from "../web/mgp.mjs";
export const BUILD_FORMAT = "memory-galaxy/build/1";
export const MANIFEST = "build-info.json";
const extensions = new Set([
  ".html",
  ".mjs",
  ".js",
  ".css",
  ".json",
  ".jsonl",
  ".txt",
  ".svg",
  ".png",
  ".webp",
  ".jpg",
  ".jpeg",
  ".ico",
  ".woff2",
]);
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function publicPath(path) {
  if (
    typeof path !== "string" ||
    path.includes("\\") ||
    path.includes("%") ||
    path
      .split("/")
      .some((part) => !part || part.startsWith(".") || !/^[-\w.]+$/.test(part))
  )
    return false;
  return (
    ["index.html", "LICENSE", MANIFEST].includes(path) ||
    (/^(web|protocol)\//.test(path) && extensions.has(extname(path)))
  );
}
async function walk(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isSymbolicLink())
      throw new Error("Symbolic links are not allowed in the site: " + path);
    if (entry.isDirectory())
      files.push(...(await walk(join(directory, entry.name), path + "/")));
    else if (entry.isFile()) files.push(path);
    else throw new Error("Unsupported site entry: " + path);
  }
  return files.sort();
}
export function readRevision(root) {
  if (process.env.BUILD_REVISION) {
    if (!/^[a-f0-9]{40}$/.test(process.env.BUILD_REVISION))
      throw new Error("BUILD_REVISION must be a full commit SHA");
    return process.env.BUILD_REVISION;
  }
  try {
    const dirty = execFileSync(
      "git",
      [
        "status",
        "--porcelain",
        "--untracked-files=normal",
        "--",
        "index.html",
        "LICENSE",
        "web",
        "protocol",
        "package.json",
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    if (dirty.trim()) return null;
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
export function validateManifest(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "files,format,protocol,revision,version"
  )
    throw new Error("Invalid build manifest structure");
  if (
    value.format !== BUILD_FORMAT ||
    value.protocol !== PROTOCOL ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value.version) ||
    (value.revision !== null && !/^[a-f0-9]{40}$/.test(value.revision))
  )
    throw new Error("Invalid build metadata");
  if (
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > 256
  )
    throw new Error("Invalid build file list");
  const seen = new Set();
  let total = 0;
  for (const file of value.files) {
    if (
      !file ||
      Object.keys(file).sort().join(",") !== "bytes,path,sha256" ||
      !publicPath(file.path) ||
      file.path === MANIFEST ||
      seen.has(file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > 20 * 1024 * 1024 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw new Error("Invalid or unsafe build entry");
    seen.add(file.path);
    total += file.bytes;
  }
  if (total > 64 * 1024 * 1024) throw new Error("Site artifact exceeds 64 MiB");
  for (const required of [
    "index.html",
    "LICENSE",
    "web/index.html",
    "web/app.mjs",
    "web/mgp.mjs",
    "web/import-worker.mjs",
    "web/layout-worker.mjs",
    "web/backup-worker.mjs",
    "protocol/mgp.schema.json",
    "protocol/export-prompt-zh.txt",
  ])
    if (!seen.has(required))
      throw new Error("Missing required site file: " + required);
  return value;
}
export async function buildSite(
  root = process.cwd(),
  { revision = readRevision(root) } = {},
) {
  root = resolve(root);
  const output = join(root, "dist"),
    files = [];
  for (const directory of ["web", "protocol"])
    for (const path of await walk(join(root, directory), directory + "/")) {
      if (!publicPath(path))
        throw new Error("Unexpected source file in the public site: " + path);
      files.push(path);
    }
  for (const path of ["index.html", "LICENSE"]) {
    if (!(await lstat(join(root, path))).isFile())
      throw new Error("Invalid source file: " + path);
    files.push(path);
  }
  const { version } = JSON.parse(
    await readFile(join(root, "package.json"), "utf8"),
  );
  const manifest = {
    format: BUILD_FORMAT,
    version,
    protocol: PROTOCOL,
    revision,
    files: [],
  };
  for (const path of files.sort()) {
    const bytes = await readFile(join(root, path));
    manifest.files.push({ path, bytes: bytes.length, sha256: digest(bytes) });
  }
  validateManifest(manifest);
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for (const path of files)
    await cp(join(root, path), join(output, path), { recursive: false });
  await writeFile(join(output, ".nojekyll"), "");
  await writeFile(
    join(output, MANIFEST),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  await verifyBuild(output, { revision });
  return manifest;
}
export async function verifyBuild(directory = "dist", { revision } = {}) {
  directory = resolve(directory);
  const manifest = validateManifest(
    JSON.parse(await readFile(join(directory, MANIFEST), "utf8")),
  );
  if (revision !== undefined && manifest.revision !== revision)
    throw new Error("Build revision does not match the expected commit");
  const actual = await walk(directory),
    expected = [
      MANIFEST,
      ".nojekyll",
      ...manifest.files.map((file) => file.path),
    ].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error("The site artifact contains missing or unexpected files");
  if ((await readFile(join(directory, ".nojekyll"))).length)
    throw new Error("Invalid Pages control file");
  for (const file of manifest.files) {
    const bytes = await readFile(join(directory, file.path));
    if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
      throw new Error("Site file does not match its manifest: " + file.path);
  }
  return manifest;
}
