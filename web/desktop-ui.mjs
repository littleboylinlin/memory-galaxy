const $ = (id) => document.getElementById(id);

export class DesktopUi {
  constructor({ api, flush, lock, notice }) {
    this.api = api;
    this.flush = flush;
    this.lock = lock;
    this.notice = notice;
    this.restoreDialog = $("desktopRestoreDialog");
    this.problemDialog = $("desktopProblemDialog");
    this.passwordDialog = $("desktopPasswordDialog");
    $("browserSaveControls").hidden = true;
    $("desktopControls").hidden = false;
    $("desktopWorkspaceBackup").hidden = false;
    $("desktopEncryptedBackup").hidden = false;
    $("clearSaveBtn").hidden = true;
    $("backupBtn").textContent = "导出完整资料备份";
    $("restoreBackupBtn").textContent = "恢复备份或迁移";
    $("desktopWelcomeImport").onclick = () => $("fileInput").click();
    $("desktopWelcomeRestore").onclick = () => $("restoreBackupBtn").click();
    $("desktopWelcomeDismiss").onclick = () =>
      ($("desktopWelcome").hidden = true);
    $("desktopRetryOpen").onclick = () => this.reload();
    $("desktopRecoveryUnlock").onclick = () => this.promptUnlock();
    for (const id of ["desktopFolderBtn", "desktopRecoveryFolder"])
      $(id).onclick = () =>
        this.run(async () => {
          const result = await api.changeFolder();
          if (result?.unlock) this.promptUnlock();
          else if (result?.changed) this.reload();
        });
    $("desktopEncryptCopy").onclick = () =>
      this.run(() =>
        this.promptPassword({
          title: "为加密资料库设置密码",
          help: "将在新文件夹创建完整副本。请自行保管密码和旧资料库。",
          confirm: true,
          action: async (password) => {
            if ((await api.changeFolder(password))?.changed) this.reload();
          },
        }),
      );
    $("backupBtn").onclick = () => this.run(() => this.exportBackup());
    $("desktopEncryptedBackup").onclick = () =>
      this.run(() =>
        this.promptPassword({
          title: "为这份备份设置密码",
          help: "恢复备份时需要此密码。请自行保管。",
          confirm: true,
          action: (password) => this.exportBackup(password),
        }),
      );
    $("restoreBackupBtn").onclick = () =>
      this.run(async () => {
        const preview = await api.previewRestore();
        if (preview?.encrypted)
          this.promptPassword({
            title: "解锁加密备份",
            help: "输入导出这份备份时使用的密码。",
            action: async (password) =>
              this.showPreview(await api.unlockBackup(password)),
          });
        else if (preview) this.showPreview(preview);
      });
    $("desktopCancelRestore").onclick = () => this.restoreDialog.close();
    $("desktopConfirmRestore").onclick = () => this.restore();
    this.restoreDialog.addEventListener("cancel", (event) => {
      if (this.restoring) event.preventDefault();
    });
    this.restoreDialog.addEventListener("close", () => {
      this.token = null;
      this.discardPreview();
      if (!this.reloading) this.lock(false);
    });
    this.problemDialog.addEventListener("cancel", (event) =>
      event.preventDefault(),
    );
    $("desktopPasswordForm").onsubmit = (event) => {
      event.preventDefault();
      void this.submitPassword();
    };
    $("desktopCancelPassword").onclick = () => this.dismissPassword();
    this.passwordDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.dismissPassword();
    });
  }

  async exportBackup(password) {
    const path = await this.api.exportBackup(password);
    if (path) this.notice("完整资料备份已保存：" + path);
  }

  setStatus({ folder, error, message, locked, encrypted, welcome }) {
    $("desktopPath").textContent =
      "数据文件夹：" + (folder || "尚未打开") + (encrypted ? " · 已加密" : "");
    $("desktopWelcome").hidden = !welcome || Boolean(error);
    $("backupBtn").textContent = encrypted
      ? "导出加密完整备份"
      : "导出完整资料备份";
    $("desktopWorkspaceBackup").textContent = "另存工作区备份（明文）";
    $("backupHelp").textContent = encrypted
      ? "资料库和默认完整备份已加密。手动导出的星盘、主题包和工作区备份仍是明文文件。"
      : "完整备份包含图谱、快照、操作记录、视图、主题包、回顾与收藏。默认资料库和备份为明文，也可以用指定密码备份。";
    if (message) this.notice(message);
    if (error) {
      $("desktopProblemTitle").textContent = locked
        ? "本地资料库已加密"
        : "无法打开本地资料库";
      $("desktopProblemText").textContent =
        (folder ? folder + " · " : "") + error;
      $("desktopProblemHelp").hidden = Boolean(locked);
      $("desktopRecoveryUnlock").hidden = !locked;
      $("desktopRetryOpen").hidden = Boolean(locked);
      if (!this.problemDialog.open) this.problemDialog.showModal();
      if (locked) this.promptUnlock();
    }
  }

  promptUnlock() {
    this.promptPassword({
      title: "解锁本地资料库",
      help: "输入创建加密资料库时使用的密码。",
      action: async (password) => {
        await this.api.unlockLibrary(password);
        this.reload();
      },
    });
  }

  promptPassword({ title, help, confirm = false, action }) {
    this.passwordAction = action;
    $("desktopPasswordTitle").textContent = title;
    $("desktopPasswordHelp").textContent = help;
    $("desktopConfirmPasswordRow").hidden = !confirm;
    $("desktopPasswordError").hidden = true;
    this.lock(true);
    this.passwordDialog.showModal();
  }

  discardPreview() {
    void this.api.cancelPreview().catch(() => {});
  }

  dismissPassword() {
    if (this.running) return;
    $("desktopPasswordForm").reset();
    this.passwordAction = null;
    this.passwordDialog.close();
    this.discardPreview();
    this.lock(false);
  }

  async submitPassword() {
    if (this.running || !this.passwordAction) return;
    const password = $("desktopPassword").value;
    const error = $("desktopPasswordError");
    if (
      !$("desktopConfirmPasswordRow").hidden &&
      password !== $("desktopConfirmPassword").value
    ) {
      error.textContent = "两次输入的密码不同。";
      error.hidden = false;
      return;
    }
    $("desktopPasswordForm").reset();
    error.hidden = true;
    await this.run(async () => {
      await this.passwordAction(password);
      this.passwordAction = null;
      this.passwordDialog.close();
    });
  }

  async run(operation) {
    if (this.running) return;
    this.running = true;
    this.lock(true);
    $("desktopRecoveryFolder").disabled = true;
    $("desktopSubmitPassword").disabled = $("desktopCancelPassword").disabled =
      true;
    try {
      await this.flush();
      await operation();
    } catch (error) {
      if (this.passwordDialog.open) {
        $("desktopPasswordError").textContent = error.message;
        $("desktopPasswordError").hidden = false;
        $("desktopPassword").focus();
      } else if (this.problemDialog.open)
        $("desktopProblemText").textContent =
          "无法切换数据文件夹：" + error.message;
      else this.notice(error.message, true);
    } finally {
      this.running = false;
      $("desktopRecoveryFolder").disabled = false;
      $("desktopSubmitPassword").disabled = $(
        "desktopCancelPassword",
      ).disabled = false;
      if (
        !this.restoreDialog.open &&
        !this.passwordDialog.open &&
        !this.reloading
      )
        this.lock(false);
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
