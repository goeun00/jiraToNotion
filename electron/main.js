require("electron-reload")(__dirname);
const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  shell,
} = require("electron");

app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-software-rasterizer");

const path = require("path");
const fs = require("fs");
const XLSX = require("xlsx");
const dotenv = require("dotenv");

// sync/notion보다 먼저 .env 로드
dotenv.config({ path: path.join(__dirname, ".env") });

const {
  syncJiraIssues,
  syncGitPRs,
  syncOnce,
  autoSync,
  stopAutoSync,
} = require("../sync");
const { fetchMyWorklogs } = require("../jira");
let win;
let settingsWin;

function createWindow() {
  win = new BrowserWindow({
    width: 250,
    height: 373,
    frame: false,
    titleBarStyle: "hidden",
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: false,
    roundedCorners: false,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile("index.html");

  // 테마 로드
  win.webContents.on("did-finish-load", () => {
    const themeConfigPath = path.join(__dirname, "theme-config.json");
    let theme = "s";
    if (fs.existsSync(themeConfigPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(themeConfigPath, "utf-8"));
        theme = data.theme || "s";
      } catch {}
    }
    win.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', '${theme}')`,
    );
  });
}

app.whenReady().then(() => {
  createWindow();

  globalShortcut.register("CommandOrControl+Shift+I", () => {
    const focusedWindow = BrowserWindow.getFocusedWindow();
    if (focusedWindow) {
      focusedWindow.webContents.openDevTools({ mode: "detach" });
    }
  });
});

app.on("will-quit", () => {
  globalShortcut.unregisterAll();
});

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
const originalError = console.error;

console.log = (...args) => {
  originalLog(...args);
  if (win) win.webContents.send("log", args.join(" "));
};

console.error = (...args) => {
  originalError(...args);
  if (win) win.webContents.send("log", "❌ " + args.join(" "));
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
JIRA_EMAIL=${data.JIRA_EMAIL || ""}
WORKLOG_TARGET_DAYS=${data.WORKLOG_TARGET_DAYS || "7"}

NOTION_TOKEN=${data.NOTION_TOKEN}
NOTION_SOURCE_ID_JIRA=${data.NOTION_SOURCE_ID_JIRA}
NOTION_SOURCE_ID_PR=${data.NOTION_SOURCE_ID_PR}
NOTION_SOURCE_ID_REVIEW=${data.NOTION_SOURCE_ID_REVIEW}

GITHUB_TOKEN=${data.GITHUB_TOKEN}
GITHUB_USERNAME=${data.GITHUB_USERNAME}
GITHUB_URL=${data.GITHUB_URL}

LOCK_BG_POS_X=${data.LOCK_BG_POS_X ?? 0}
LOCK_BG_POS_Y=${data.LOCK_BG_POS_Y ?? 0}
LOCK_BG_ZOOM=${data.LOCK_BG_ZOOM ?? 1}
`.trim();

  fs.writeFileSync(envPath, content);
  Object.assign(process.env, data);
  console.log("✔ Config saved");
  return true;
});

// -----------------------------
// 저장소 설정 (repo-configs.json)
// configs: [{ name: string, branches: string[] }]
// -----------------------------
const repoConfigPath = path.join(__dirname, "repo-configs.json");

ipcMain.handle("load-repo-configs", async () => {
  if (!fs.existsSync(repoConfigPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(repoConfigPath, "utf-8"));
  } catch {
    return [];
  }
});

ipcMain.handle("save-repo-configs", async (_, configs) => {
  fs.writeFileSync(repoConfigPath, JSON.stringify(configs, null, 2));
  console.log("✔ Repo configs saved");
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

// -----------------------------
// Worklog 조회
// -----------------------------
ipcMain.handle("fetch-worklogs", async (_, monthOffset = 0) => {
  return await fetchMyWorklogs(
    process.env.JIRA_BASE_URL,
    process.env.JIRA_PAT,
    Number(monthOffset || 0),
    process.env.JIRA_EMAIL || "",
  );
});

// 엑셀로 내보내기
ipcMain.handle("export-work-report", async (_, rows = [], month = "") => {
  if (!rows.length) {
    throw new Error("내보낼 업무보고 데이터가 없어요.");
  }
  const os = require("os");
  const XLSX = require("xlsx");
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(workbook, worksheet, "업무보고");
  const safeMonth = month || "worklog";
  const filePath = path.join(
    os.tmpdir(),
    `업무보고_${safeMonth}_${Date.now()}.xlsx`,
  );
  XLSX.writeFile(workbook, filePath);
  const openError = await shell.openPath(filePath);
  if (openError) {
    throw new Error(openError);
  }
  return {
    opened: true,
    filePath,
  };
});
// -----------------------------
// 잠금 배경 이미지 저장
// -----------------------------
const lockBgStorePath = path.join(__dirname, "lock-bg-store.json");

ipcMain.handle("load-lock-bg", async () => {
  if (!fs.existsSync(lockBgStorePath)) return { url: "" };
  try {
    return JSON.parse(fs.readFileSync(lockBgStorePath, "utf-8"));
  } catch {
    return { url: "" };
  }
});

ipcMain.handle("save-lock-bg", async (_, data) => {
  fs.writeFileSync(lockBgStorePath, JSON.stringify(data, null, 2));
  return true;
});

// -----------------------------
// 테마 설정
// -----------------------------
const themeConfigPath = path.join(__dirname, "theme-config.json");

ipcMain.handle("get-theme", () => {
  if (!fs.existsSync(themeConfigPath)) return "s";
  try {
    const data = JSON.parse(fs.readFileSync(themeConfigPath, "utf-8"));
    return data.theme || "s";
  } catch {
    return "s";
  }
});

ipcMain.handle("set-theme", (_, theme) => {
  fs.writeFileSync(themeConfigPath, JSON.stringify({ theme }, null, 2));
  if (win) {
    win.webContents.executeJavaScript(
      `document.documentElement.setAttribute('data-theme', '${theme}')`,
    );
  }
  console.log(`✔ Theme changed to: ${theme}`);
  return true;
});
