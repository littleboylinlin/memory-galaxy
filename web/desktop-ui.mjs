const $ = (id) => document.getElementById(id);

export class DesktopUi {
  constructor({ api, flush, lock, notice }) {
    this.api = api;
    this.flush = flush;
    this.lock = lock;
    this.notice = notice;
    this.restoreDialog = $("desktopRestoreDialog");
    this.problemDialog = $("desktopProblemDialog");
    $("browserSaveControls").hidden = true;
    $("desktopControls").hidden = false;
    $("desktopWorkspaceBackup").hidden = false;
    $("clearSaveBtn").hidden = true;
    $("backupBtn").textContent = "导出完整资料备份";
    $("restoreBackupBtn").textContent = "恢复备份或迁移";
    $("backupHelp").textContent =
      "完整备份包含图谱、快照、操作记录、视图、主题包、回顾与收藏。资料库与备份均未加密。";
    for (const id of ["desktopFolderBtn", "desktopRecoveryFolder"])
      $(id).onclick = () =>
        this.run(async () => {
          if (await api.changeFolder()) this.reload();
        });
    $("backupBtn").onclick = () =>
      this.run(async () => {
        const path = await api.exportBackup();
        if (path) notice("完整资料备份已保存：" + path);
      });
    $("restoreBackupBtn").onclick = () =>
      this.run(async () => {
        const preview = await api.previewRestore();
        if (preview) this.showPreview(preview);
      });
    $("desktopCancelRestore").onclick = () => this.restoreDialog.close();
    $("desktopConfirmRestore").onclick = () => this.restore();
    this.restoreDialog.addEventListener("cancel", (event) => {
      if (this.restoring) event.preventDefault();
    });
    this.restoreDialog.addEventListener("close", () => {
      this.token = null;
      if (!this.reloading) this.lock(false);
    });
    this.problemDialog.addEventListener("cancel", (event) =>
      event.preventDefault(),
    );
  }

  setStatus({ folder, error, message }) {
    $("desktopPath").textContent = "数据文件夹：" + (folder || "尚未打开");
    if (message) this.notice(message);
    if (error) {
      $("desktopProblemText").textContent = folder + " · " + error;
      if (!this.problemDialog.open) this.problemDialog.showModal();
    }
  }

  async run(operation) {
    if (this.running) return;
    this.running = true;
    this.lock(true);
    $("desktopRecoveryFolder").disabled = true;
    try {
      await this.flush();
      await operation();
    } catch (error) {
      if (this.problemDialog.open)
        $("desktopProblemText").textContent =
          "无法切换数据文件夹：" + error.message;
      else this.notice(error.message, true);
    } finally {
      this.running = false;
      $("desktopRecoveryFolder").disabled = false;
      if (!this.restoreDialog.open && !this.reloading) this.lock(false);
    }
  }

  showPreview(preview) {
    this.token = preview.token;
    $("desktopConfirmRestore").disabled = false;
    $("desktopRestoreError").hidden = true;
    $("desktopRestoreSummary").textContent =
      new Date(preview.created_at).toLocaleString() +
      " · " +
      (preview.kind === "library"
        ? "确认后将替换当前资料库中的全部资料。"
        : "这是旧版工作区备份。确认后将替换图谱、快照、历史和星图视图，现有主题包、回顾及收藏会保留。") +
      " 有现有资料时会先在当前数据文件夹写入一份完整备份。";
    $("desktopRestoreChanges").replaceChildren();
    for (const [label, counts] of preview.changes) {
      const item = document.createElement("li");
      item.textContent =
        `${label}：导入后 ${counts.incoming} 条，新增 ${counts.added}，同 ID 内容不同 ${counts.changed}，移除 ${counts.removed}` +
        (counts.conflicts.length
          ? "。冲突示例：" + counts.conflicts.join("、")
          : "");
      item.style.overflowWrap = "anywhere";
      $("desktopRestoreChanges").append(item);
    }
    $("desktopRestoreHistory").textContent =
      `快照 ${preview.snapshots.join(" → ")}，操作记录 ${preview.events.join(" → ")}，恢复后收藏 ${preview.favorites} 条。视图设置将随工作区恢复。`;
    this.restoreDialog.showModal();
  }

  async restore() {
    if (!this.token || this.restoring) return;
    this.restoring = true;
    $("desktopConfirmRestore").disabled = $("desktopCancelRestore").disabled =
      true;
    try {
      await this.api.restore(this.token);
      this.reload();
    } catch (error) {
      $("desktopRestoreError").hidden = false;
      $("desktopRestoreError").textContent = "未恢复备份：" + error.message;
      this.token = null;
    } finally {
      this.restoring = false;
      $("desktopCancelRestore").disabled = false;
      $("desktopConfirmRestore").disabled = !this.token;
    }
  }

  reload() {
    this.reloading = true;
    location.reload();
  }
}
