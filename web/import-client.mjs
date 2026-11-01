import { MgpError } from "./mgp.mjs";
export class ImportClient {
  #worker;
  #pending;
  #sequence = 0;
  preview(text, base, options) {
    this.cancel();
    const id = ++this.#sequence;
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (callback) => {
        if (this.#sequence !== id) return;
        clearTimeout(timer);
        this.#worker?.terminate();
        this.#worker = undefined;
        this.#pending = undefined;
        callback();
      };
      try {
        this.#worker = new Worker(
          new URL("./import-worker.mjs", import.meta.url),
          { type: "module" },
        );
        this.#pending = () =>
          finish(() => reject(new DOMException("导入已取消", "AbortError")));
        this.#worker.onmessage = ({ data }) => {
          if (data.id !== id || this.#sequence !== id) return;
          finish(() =>
            data.ok ? resolve(data) : reject(new MgpError(data.issues)),
          );
        };
        this.#worker.onerror = () => {
          if (this.#sequence === id)
            finish(() =>
              reject(
                new Error(
                  "导入处理器未能启动，请刷新页面或检查浏览器是否允许本地模块。",
                ),
              ),
            );
        };
        timer = setTimeout(
          () =>
            finish(() => reject(new Error("导入处理超时，请缩小批次后重试。"))),
          30000,
        );
        this.#worker.postMessage({ id, text, base, options });
      } catch (error) {
        finish(() => reject(error));
      }
    });
  }
  cancel() {
    this.#pending?.();
    this.#sequence++;
  }
}
