import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const { version } = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const names = {
  "windows-x64": [`MemoryGalaxy-Setup-${version}-x64.exe`],
  "macos-arm64": [`MemoryGalaxy-${version}-macos-arm64.dmg`],
  "macos-x64": [`MemoryGalaxy-${version}-macos-x64.dmg`],
  "linux-x64": [
    `MemoryGalaxy-${version}-linux-x86_64.AppImage`,
    `MemoryGalaxy-${version}-linux-amd64.deb`,
  ],
};
const revision = process.env.GITHUB_SHA;
if (!/^[a-f0-9]{40}$/.test(revision))
  throw new Error("Expected a full GITHUB_SHA");

async function checksums(directory, files) {
  const lines = [];
  for (const name of files) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(join(directory, name)))
      hash.update(chunk);
    lines.push(hash.digest("hex") + "  " + name);
  }
  return lines.join("\n") + "\n";
}

const [action, argument] = process.argv.slice(2);
if (action === "stage" && Object.hasOwn(names, argument)) {
  const directory = join("release", "verified");
  await mkdir(directory);
  for (const name of names[argument])
    await rename(join("release", name), join(directory, name));
  await writeFile(
    join(directory, "SHA256SUMS.txt"),
    await checksums(directory, names[argument]),
  );
  await writeFile(join(directory, "desktop-revision.txt"), revision + "\n");
} else if (action === "verify" && argument) {
  let combined = "";
  for (const [target, files] of Object.entries(names)) {
    const directory = join(argument, target);
    const sha = (
      await readFile(join(directory, "desktop-revision.txt"), "utf8")
    ).trim();
    const expected = await readFile(join(directory, "SHA256SUMS.txt"), "utf8");
    if (sha !== revision || expected !== (await checksums(directory, files)))
      throw new Error(
        "Desktop artifact checksum or revision mismatch: " + target,
      );
    for (const name of files)
      await rename(join(directory, name), join(argument, name));
    combined += expected;
  }
  await writeFile(join(argument, "SHA256SUMS.txt"), combined);
} else {
  throw new Error("Use stage <desktop target> or verify <artifact directory>");
}
