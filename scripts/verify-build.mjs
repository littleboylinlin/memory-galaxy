import { parseArgs } from "node:util";
import { verifyBuild } from "./site-artifact.mjs";
const { values } = parseArgs({
  options: {
    root: { type: "string", default: "dist" },
    revision: { type: "string" },
  },
});
const manifest = await verifyBuild(values.root, { revision: values.revision });
console.log(
  `Verified ${manifest.files.length} site files for ${manifest.revision || "unversioned source"}.`,
);
