const { contextBridge, ipcRenderer } = require("electron");

const invoke =
  (method) =>
  (...args) =>
    ipcRenderer.invoke("library:" + method, ...args).catch((error) => {
      throw new Error(
        error.message.replace(
          /^Error invoking remote method '[^']+': Error: /,
          "",
        ),
      );
    });
contextBridge.exposeInMainWorld("memoryGalaxyDesktop", {
  status: invoke("status"),
  loadWorkspace: invoke("loadWorkspace"),
  saveWorkspace: invoke("saveWorkspace"),
  loadTab: invoke("loadTab"),
  saveTab: invoke("saveTab"),
  loadReviews: invoke("loadReviews"),
  saveReview: invoke("saveReview"),
  clearReviews: invoke("clearReviews"),
  listPacks: invoke("listPacks"),
  loadPack: invoke("loadPack"),
  savePack: invoke("savePack"),
  changeFolder: invoke("changeFolder"),
  unlockLibrary: invoke("unlockLibrary"),
  exportBackup: invoke("exportBackup"),
  previewRestore: invoke("previewRestore"),
  unlockBackup: invoke("unlockBackup"),
  cancelPreview: invoke("cancelPreview"),
  restore: invoke("restore"),
  onClosing: (callback) => ipcRenderer.on("library:closing", () => callback()),
  finishClose: invoke("finishClose"),
});
