import { parseArgs } from "node:util";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { validateManifest, digest, MANIFEST } from "./site-artifact.mjs";
const MIME = {
  ".mjs": /^(text|application)\/javascript\b/i,
  ".css": /^text\/css\b/i,
  ".html": /^text\/html\b/i,
  ".json": /^application\/json\b/i,
};
export function siteBase(input) {
  const url = new URL(input);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !["http:", "https:"].includes(url.protocol)
  )
    throw new Error(
      "Use a site URL without credentials, a query, or a fragment",
    );
  if (
    url.protocol === "http:" &&
    !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  )
    throw new Error("Remote site checks require HTTPS");
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}
async function fetchBytes(url, limit, fetcher) {
  const response = await fetcher(url, {
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error(`${url.pathname}: HTTP ${response.status}`);
  if (Number(response.headers.get("content-length")) > limit)
    throw new Error(
      "Remote response exceeds the expected size: " + url.pathname,
    );
  const reader = response.body.getReader(),
    chunks = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      throw new Error(
        "Remote response exceeds the expected size: " + url.pathname,
      );
    }
    chunks.push(value);
  }
  return {
    bytes: Buffer.concat(chunks),
    type: response.headers.get("content-type") || "",
  };
}
export async function verifySite(
  input,
  { revision, expected, fetcher = fetch } = {},
) {
  const base = siteBase(input),
    metadata = await fetchBytes(new URL(MANIFEST, base), 512 * 1024, fetcher),
    manifest = validateManifest(JSON.parse(metadata.bytes.toString("utf8")));
  if (
    expected &&
    JSON.stringify(manifest) !== JSON.stringify(validateManifest(expected))
  )
    throw new Error(
      "The deployed manifest differs from the trusted local artifact",
    );
  if (revision !== undefined && manifest.revision !== revision)
    throw new Error("The deployed commit does not match the expected revision");
  let cursor = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (cursor < manifest.files.length) {
        const file = manifest.files[cursor++],
          url = new URL(file.path, base);
        if (
          url.origin !== base.origin ||
          !url.pathname.startsWith(base.pathname)
        )
          throw new Error("Build entry escapes the site");
        const { bytes, type } = await fetchBytes(url, file.bytes, fetcher);
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
          throw new Error(
            "Deployed file does not match the build manifest: " + file.path,
          );
        const extension = file.path.slice(file.path.lastIndexOf("."));
        if (MIME[extension] && !MIME[extension].test(type))
          throw new Error(
            "Incorrect Content-Type for " + file.path + ": " + type,
          );
      }
    }),
  );
  return manifest;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      url: { type: "string" },
      revision: { type: "string" },
      manifest: { type: "string" },
      attempts: { type: "string", default: "1" },
      delay: { type: "string", default: "5000" },
    },
  });
  const attempts = Number(values.attempts),
    delay = Number(values.delay);
  if (
    !values.url ||
    !Number.isInteger(attempts) ||
    attempts < 1 ||
    attempts > 12 ||
    !Number.isInteger(delay) ||
    delay < 0 ||
    delay > 10000
  )
    throw new Error(
      "Usage: npm run verify:site -- --url https://host/project/ [--revision SHA] [--attempts 6]",
    );
  const expected = values.manifest
    ? JSON.parse(await readFile(values.manifest, "utf8"))
    : undefined;
  let verified;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      verified = await verifySite(values.url, {
        revision: values.revision,
        expected,
      });
      break;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.warn(`Site check ${attempt}/${attempts}: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  console.log(
    `Verified ${verified.files.length} deployed files for ${verified.revision} at ${siteBase(values.url)}`,
  );
}
