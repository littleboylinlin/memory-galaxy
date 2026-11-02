import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, extname } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { publicPath } from "./site-artifact.mjs";
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
export function normalizeBasePath(path = "/") {
  if (!/^\/(?:[\w-]+\/)*$/.test(path))
    throw new Error(
      "Base path must start and end with / and contain only safe directory names",
    );
  return path;
}
export async function createSiteServer({ root = ".", basePath = "/" } = {}) {
  root = await realpath(resolve(root));
  basePath = normalizeBasePath(basePath);
  return createServer(async (request, response) => {
    try {
      if (!["GET", "HEAD"].includes(request.method)) {
        response
          .writeHead(405, { Allow: "GET, HEAD" })
          .end("Method not allowed");
        return;
      }
      const url = new URL(request.url, "http://localhost"),
        pathname = decodeURIComponent(url.pathname);
      if (basePath !== "/" && pathname === basePath.slice(0, -1)) {
        response.writeHead(308, { Location: basePath }).end();
        return;
      }
      if (!pathname.startsWith(basePath)) {
        response.writeHead(404).end("Not found");
        return;
      }
      let relative = pathname.slice(basePath.length);
      if (!relative || relative.endsWith("/")) relative += "index.html";
      if (!publicPath(relative)) {
        response.writeHead(404).end("Not found");
        return;
      }
      const path = resolve(root, relative);
      if ((await realpath(path)) !== path || !(await stat(path)).isFile()) {
        response.writeHead(404).end("Not found");
        return;
      }
      const bytes = await readFile(path);
      response.writeHead(200, {
        "Content-Type": mime[extname(path)] || "text/plain; charset=utf-8",
        "Content-Length": bytes.length,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      });
      response.end(request.method === "HEAD" ? undefined : bytes);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const { values } = parseArgs({
    options: {
      root: { type: "string", default: process.env.STATIC_ROOT || "." },
      "base-path": {
        type: "string",
        default: process.env.SITE_BASE_PATH || "/",
      },
      port: { type: "string", default: process.env.PORT || "4173" },
      host: { type: "string", default: "0.0.0.0" },
    },
  });
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid server port");
  const server = await createSiteServer({
    root: values.root,
    basePath: values["base-path"],
  });
  server.listen(port, values.host, () =>
    console.log(
      `Memory Galaxy: http://localhost:${port}${values["base-path"]}web/`,
    ),
  );
}
