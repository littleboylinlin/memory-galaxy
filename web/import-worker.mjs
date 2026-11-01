import { parseMgp, planImport } from "./mgp.mjs";
self.onmessage = ({ data }) => {
  const { id, text, base, options } = data;
  try {
    const parsed = parseMgp(
      text,
      base.nodes.map((node) => node.id),
    );
    const plan = planImport(base, parsed.graph, options);
    plan.warnings = [...new Set([...parsed.warnings, ...plan.warnings])];
    self.postMessage({ id, ok: true, parsed, plan });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      message: error.message,
      issues: error.issues || [
        { path: "$", code: "import", message: error.message },
      ],
    });
  }
};
