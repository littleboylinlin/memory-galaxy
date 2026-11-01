import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";

const root = resolve(process.env.STATIC_ROOT || ".");
const port = Number(process.env.PORT || 4173);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
};
createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(
      new URL(request.url, "http://localhost").pathname,
    );
    if (
      pathname.split("/").some((part) => part.startsWith(".")) ||
      !["GET", "HEAD"].includes(request.method)
    ) {
      response.writeHead(404).end("Not found");
      return;
    }
    let path = resolve(root, "." + pathname);
    if (path !== root && !path.startsWith(root + sep)) {
      response.writeHead(404).end("Not found");
      return;
    }
    if ((await stat(path)).isDirectory()) path = resolve(path, "index.html");
    const bytes = await readFile(path);
    response.writeHead(200, {
      "Content-Type": mime[extname(path)] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "0.0.0.0", () =>
  console.log(`Memory Galaxy: http://localhost:${port}/web/`),
);
