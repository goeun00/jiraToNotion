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

  fetchWorklogs: (monthOffset) =>
    ipcRenderer.invoke("fetch-worklogs", monthOffset),

  // 테마 설정
  getTheme: () => ipcRenderer.invoke("get-theme"),
  setTheme: (theme) => ipcRenderer.invoke("set-theme", theme),

  // 로드워크 저장
  exportWorkReport: (rows, month) =>
    ipcRenderer.invoke("export-work-report", rows, month),
});
