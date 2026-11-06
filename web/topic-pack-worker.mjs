import { preparePack } from "./topic-packs.mjs";
self.onmessage = async ({ data }) => {
  try {
    const result = await preparePack(data.graph, data.config, data.baseline);
    self.postMessage({ id: data.id, ok: true, result });
  } catch (error) {
    self.postMessage({ id: data.id, ok: false, message: error.message });
  }
};
