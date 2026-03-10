require("electron-reload")(__dirname);
const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const {
  syncJiraIssues,
  syncGitPRs,
  syncOnce,
  autoSync,
  stopAutoSync,
} = require("../sync");
let win;

function createWindow() {
  win = new BrowserWindow({
    width: 620,
    height: 600,
    frame: false,
    titleBarStyle: "hidden",
    transparent: true,
    titleBarStyle: "hidden",
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile("index.html");
}

app.whenReady().then(createWindow);

ipcMain.on("window-minimize", () => {
  BrowserWindow.getFocusedWindow().minimize();
});

ipcMain.on("window-maximize", () => {
  const win = BrowserWindow.getFocusedWindow();

  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});

ipcMain.on("window-close", () => {
  BrowserWindow.getFocusedWindow().close();
});
// -----------------------------
// console.log → renderer 로그 전달
// -----------------------------
const originalLog = console.log;
console.log = (...args) => {
  originalLog(...args);
  if (win) {
    win.webContents.send("log", args.join(" "));
  }
};
// -----------------------------
// ENV 로드
// -----------------------------
ipcMain.handle("load-env", async () => {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return null;
  const env = dotenv.parse(fs.readFileSync(envPath));
  return env;
});

// -----------------------------
// ENV 저장
// -----------------------------
ipcMain.handle("save-env", async (_, data) => {
  const envPath = path.join(__dirname, ".env");

  const content = `
JIRA_BASE_URL=${data.JIRA_BASE_URL}
JIRA_PAT=${data.JIRA_PAT}

NOTION_TOKEN=${data.NOTION_TOKEN}
NOTION_SOURCE_ID_JIRA=${data.NOTION_SOURCE_ID_JIRA}
NOTION_SOURCE_ID_PR=${data.NOTION_SOURCE_ID_PR}

GITHUB_TOKEN=${data.GITHUB_TOKEN}
GITHUB_USERNAME=${data.GITHUB_USERNAME}
GITHUB_URL=${data.GITHUB_URL}
`.trim();

  fs.writeFileSync(envPath, content);
  Object.assign(process.env, data);
  console.log("✔ Config saved");
  return true;
});

// -----------------------------
// Sync 실행
// -----------------------------
ipcMain.handle("sync-jira", async () => {
  await syncJiraIssues();
});

ipcMain.handle("sync-pr", async () => {
  await syncGitPRs();
});
ipcMain.handle("sync-once", () => syncOnce());
ipcMain.handle("auto-sync", () => autoSync());
ipcMain.handle("stop-auto-sync", () => stopAutoSync());
