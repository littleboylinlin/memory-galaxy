import { readdir, readFile, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { parseDocument } from "yaml";
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
const page = await readFile("web/index.html", "utf8");
const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
if (new Set(ids).size !== ids.length)
  throw new Error("Page contains duplicate IDs");
const knownIds = new Set(ids);
for (const match of page.matchAll(
  /(?:aria-labelledby|aria-describedby|aria-controls|for)="([^"]+)"/g,
))
  for (const id of match[1].split(/\s+/))
    if (!knownIds.has(id))
      throw new Error("Missing labelled or controlled element: " + id);
for (const file of ["app.mjs", "import-ui.mjs", "backup-ui.mjs"]) {
  const source = await readFile("web/" + file, "utf8");
  for (const match of source.matchAll(
    /(?:\$|document\.getElementById)\("([^"]+)"\)/g,
  ))
    if (!knownIds.has(match[1]))
      throw new Error(file + " references missing element " + match[1]);
}
console.log("Page IDs, labels, controls, and script bindings checked.");

for (const entry of await readdir(".github/workflows")) {
  if (!/\.ya?ml$/.test(entry)) continue;
  const document = parseDocument(
    await readFile(".github/workflows/" + entry, "utf8"),
    { uniqueKeys: true },
  );
  if (document.errors.length)
    throw new Error(document.errors.map((error) => error.message).join("\n"));
  document.toJS({ maxAliasCount: 0 });
}
console.log("Workflow YAML checked.");
