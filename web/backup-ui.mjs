import { BACKUP_BYTES } from "./workspace.mjs";
export class BackupUi {
  constructor({ onRestore, onNotice }) {
    this.onRestore = onRestore;
    this.onNotice = onNotice;
    this.dialog = document.getElementById("restoreDialog");
    this.input = document.getElementById("backupFile");
    this.status = document.getElementById("restoreStatus");
    this.summary = document.getElementById("restoreSummary");
    this.confirm = document.getElementById("confirmRestore");
    this.token = 0;
    document.getElementById("restoreBackupBtn").onclick = () => {
      this.input.value = "";
      this.input.click();
    };
    this.input.onchange = () => {
      if (this.input.files[0]) this.open(this.input.files[0]);
    };
    document.getElementById("cancelRestore").onclick = () => {
      this.cancel();
      this.dialog.close();
    };
    this.dialog.addEventListener("cancel", () => this.cancel());
    this.dialog.addEventListener("close", () => {
      if (!this.dialog.open) this.cancel();
    });
    this.confirm.onclick = () => {
      if (!this.backup) return;
      try {
        onRestore(this.backup);
        this.dialog.close();
        onNotice("完整备份已恢复。恢复前的当前图谱保留为一份撤销快照。");
      } catch (error) {
        this.status.textContent = "恢复失败：" + error.message;
        this.status.classList.add("error");
      }
    };
  }
  cancel() {
    this.token++;
    this.worker?.terminate();
    this.worker = null;
    clearTimeout(this.timeout);
    this.backup = null;
    this.confirm.disabled = true;
  }
  async open(file) {
    this.cancel();
    const token = this.token;
    this.summary.replaceChildren();
    this.status.classList.remove("error");
    this.status.textContent = "正在读取并校验完整备份…";
    document.getElementById("restoreErrorDetails").hidden = true;
    document.getElementById("restoreErrorDetails").open = false;
    this.dialog.showModal();
    try {
      if (file.size > BACKUP_BYTES) throw new Error("完整备份超过 48 MiB");
      const text = await file.text();
      if (token !== this.token) return;
      const backup = await new Promise((resolve, reject) => {
        const worker = new Worker(
          new URL("./backup-worker.mjs", import.meta.url),
          { type: "module" },
        );
        this.worker = worker;
        this.timeout = setTimeout(() => {
          worker.terminate();
          reject(new Error("备份校验超时，请缩小文件或在性能更好的设备重试"));
        }, 30000);
        worker.onmessage = ({ data }) => {
          clearTimeout(this.timeout);
          worker.terminate();
          this.worker = null;
          data.ok
            ? resolve(data.backup)
            : reject(
                Object.assign(new Error(data.error), { issues: data.issues }),
              );
        };
        worker.onerror = () => {
          clearTimeout(this.timeout);
          worker.terminate();
          this.worker = null;
          reject(new Error("无法启动备份校验，请使用支持 Worker 的浏览器"));
        };
        worker.postMessage(text);
      });
      if (token !== this.token) return;
      this.backup = backup;
      for (const [label, value] of [
        ["备份时间", new Date(backup.created_at).toLocaleString()],
        ["节点", backup.graph.nodes.length.toLocaleString()],
        ["关系", backup.graph.edges.length.toLocaleString()],
        ["历史快照", backup.snapshots.length.toLocaleString()],
        ["操作记录", backup.events.length.toLocaleString()],
      ]) {
        const item = document.createElement("li");
        item.textContent = label + "：" + value;
        this.summary.append(item);
      }
      this.status.textContent =
        "校验通过。确认后将替换当前图谱、视图和历史；取消不会改变数据。";
      this.confirm.disabled = false;
    } catch (error) {
      if (token !== this.token) return;
      this.status.textContent = "备份未载入：" + error.message;
      this.status.classList.add("error");
      const detail = error.issues
        ?.map((issue) => issue.detail)
        .filter(Boolean)
        .join("\n");
      if (detail) {
        document.getElementById("restoreErrorText").textContent = detail;
        document.getElementById("restoreErrorDetails").hidden = false;
      }
    }
  }
}
