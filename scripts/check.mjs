import { readdir, readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
async function checkDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = directory + "/" + entry.name;
    if (entry.isDirectory()) await checkDirectory(path);
    else if (entry.name.endsWith(".mjs"))
      execFileSync(process.execPath, ["--check", path], { stdio: "inherit" });
    else if (entry.name.endsWith(".json"))
      JSON.parse(await readFile(path, "utf8"));
  }
}
for (const directory of ["web", "protocol", "scripts", "tests"])
  await checkDirectory(directory);
for (const path of ["index.html", "web/index.html"]) {
  const html = await readFile(path, "utf8");
  for (const [, asset] of html.matchAll(/(?:src|href)=["'](\.\/[^"']+)["']/g))
    await access(resolve(dirname(path), asset));
}
console.log("Source syntax, JSON files, and page asset references checked.");
