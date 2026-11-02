import { buildSite } from "./site-artifact.mjs";
const manifest = await buildSite();
console.log(
  `Built and verified ${manifest.files.length} site files in dist/ (${manifest.revision || "unversioned source"}).`,
);
