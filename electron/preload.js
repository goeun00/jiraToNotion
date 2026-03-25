const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  minimize: () => ipcRenderer.send("window-minimize"),
  maximize: () => ipcRenderer.send("window-maximize"),
  close: () => ipcRenderer.send("window-close"),

  syncJira: () => ipcRenderer.invoke("sync-jira"),
  syncPR: () => ipcRenderer.invoke("sync-pr"),

  loadEnv: () => ipcRenderer.invoke("load-env"),
  saveEnv: (data) => ipcRenderer.invoke("save-env", data),

  onLog: (callback) => ipcRenderer.on("log", (_, msg) => callback(msg)),

  syncOnce: () => ipcRenderer.invoke("sync-once"),
  autoSync: () => ipcRenderer.invoke("auto-sync"),
  stopAutoSync: () => ipcRenderer.invoke("stop-auto-sync"),

  // 코드 리뷰
  runCodeReview: (owner, repo, base, compare) =>
    ipcRenderer.invoke("run-code-review", owner, repo, base, compare),

  // 저장소 설정 관리 (repo configs: [{ name, branches }])
  loadRepoConfigs: () => ipcRenderer.invoke("load-repo-configs"),
  saveRepoConfigs: (configs) => ipcRenderer.invoke("save-repo-configs", configs),
});
