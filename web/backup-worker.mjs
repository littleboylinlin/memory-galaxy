import { parseBackup } from "./workspace.mjs";
self.onmessage = ({ data }) => {
  try {
    self.postMessage({ ok: true, backup: parseBackup(data) });
  } catch (error) {
    self.postMessage({ ok: false, error: error.message });
  }
};
