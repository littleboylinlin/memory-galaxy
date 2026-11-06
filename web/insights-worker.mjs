import { healthCheck, reviewPage } from "./memory-insights.mjs";
self.onmessage = async ({ data }) => {
  try {
    const result =
      data.kind === "review"
        ? await reviewPage(data.graph, data.options)
        : healthCheck(data.graph, data.options);
    self.postMessage({ id: data.id, ok: true, result });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, message: error.message });
  }
};
