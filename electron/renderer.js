/* ─────────────────────────────────────
   뷰 스택 기반 네비게이션
───────────────────────────────────── */
const VIEWS = ["menu-view"];
let viewStack = ["menu-view"];
let curIdx = 0;
let busy = false;
let autoOn = false;
let curTheme = "s";

// 잠금 화면 상태
let isLocked = false;
let lockClockInterval = null;
let lockBgImageUrl = "";
let lockBgPanX = 0;
let lockBgPanY = 0;
let lockBgZoom = 1;

// 설정창에서만 쓰는 임시 잠금 배경 상태
// SAVE 전에는 실제 잠금화면(lockBg*)에 반영하지 않는다.
let draftLockBgImageUrl = "";
let draftLockBgPanX = 0;
let draftLockBgPanY = 0;
let draftLockBgZoom = 1;

const state = {
  logworkOffset: 0,
  logwork: {},
};

function logworkKey(offset) {
  return String(offset);
}

function formatDecimal(num) {
  return Number(num || 0)
    .toFixed(3)
    .replace(/\.?0+$/, "");
}

function getTargetDays() {
  return Number(document.getElementById("targetLog")?.value || 7);
}

function getLogworkData(offset = 0) {
  return (
    state.logwork[logworkKey(offset)] || {
      month: "",
      label: "",
      totalSeconds: 0,
      loggedDays: 0,
      logs: [],
      target: getTargetDays(),
    }
  );
}

/* 메뉴 정의 */
const MAIN_ITEMS = [
  { label: "Export Excel", act: "export-work-report" },
  { label: "Sync Jira", act: "sync-jira" },
  { label: "Sync PR", act: "sync-pr" },
];

/* ─────────────────────────────────────
   뷰 전환
───────────────────────────────────── */

function currentViewId() {
  return viewStack[viewStack.length - 1];
}

/* ─────────────────────────────────────
   메뉴 렌더
───────────────────────────────────── */
function renderCurrentMenu() {
  const vid = currentViewId();
  if (vid === "menu-view") renderMenu("mlist", MAIN_ITEMS);
}

function renderMenu(elId, items) {
  document.getElementById(elId).innerHTML = items
    .map((it, i) => {
      return `<div class="mitem${i === curIdx ? " sel" : ""}" data-idx="${i}">
      <span>${it.label}</span>
      <div class="mchev"></div>
    </div>`;
    })
    .join("");
}

/* ─────────────────────────────────────
   아이템 실행
───────────────────────────────────── */
function execItem(idx) {
  if (busy) return;

  const vid = currentViewId();
  const items = vid === "menu-view" ? MAIN_ITEMS : null;
  if (!items) return;

  const it = items[idx];
  if (!it) return;

  if (it.act === "sync-jira") {
    startSync("jira");
    return;
  }

  if (it.act === "sync-pr") {
    startSync("pr");
    return;
  }

  if (it.act === "export-work-report") {
    exportWorkReport();
    return;
  }
}

/* ─────────────────────────────────────
   Sync 실행
───────────────────────────────────── */
let _ctx = null;
let _warmupIv = null;
let _subIv = null;

function startSync(type) {
  if (busy) return;

  busy = true;
  _ctx = {
    type,
    total: 0,
    created: 0,
    updated: 0,
    elapsed: null,
  };

  showMsgLoading({ type });
  startWarmup();
  startSubCycle(type);

  const fn = type === "jira" ? window.api?.syncJira : window.api?.syncPR;

  fn?.()
    .then(() => {
      stopWarmup();
      stopSubCycle();
      setProg(100);

      setTimeout(() => {
        showMsgResult();

        setTimeout(() => {
          hideMsgView();
          busy = false;
          _ctx = null;
        }, 2200);
      }, 300);
    })
    .catch((err) => {
      console.error(err);

      stopWarmup();
      stopSubCycle();
      setProg(100);

      if (_ctx) {
        _ctx.error = err?.message || "동기화 중 오류가 발생했어요";
      }

      setTimeout(() => {
        showMsgResult();

        setTimeout(() => {
          hideMsgView();
          busy = false;
          _ctx = null;
        }, 2600);
      }, 300);
    });
}

/* ─────────────────────────────────────
   메시지 UI
───────────────────────────────────── */
function showMsgLoading(options = {}) {
  const {
    type,
    title,
    sub = "준비 중...",
    progress = true,
    percent = 0,
  } = options;

  const msgView = document.getElementById("msg-view");
  const msgLoading = document.getElementById("msg-loading");
  const msgResult = document.getElementById("msg-result");
  const msgMain = document.getElementById("msg-main");
  const msgSub = document.getElementById("msg-sub");
  const progressWrap = document.getElementById("msg-prog-wrap");

  msgView?.classList.add("show");
  msgLoading?.classList.remove("hide");
  msgResult?.classList.remove("show");

  if (msgMain) {
    msgMain.textContent =
      title || (type === "jira" ? "Sync Jira" : type === "pr" ? "Sync PR" : "");
  }

  if (msgSub) {
    msgSub.textContent = sub;
  }

  if (progressWrap) {
    progressWrap.style.display = progress ? "" : "none";
  }

  if (progress) {
    setProg(percent);
  }
}

function showMsgResult() {
  document.getElementById("msg-loading")?.classList.add("hide");

  const res = document.getElementById("msg-result");
  res?.classList.add("show");

  const resultTitle = document.getElementById("result-title");
  if (resultTitle) {
    resultTitle.textContent = "완료";
  }

  const stats = document.getElementById("result-stats");
  if (stats) {
    stats.innerHTML = `
      <span class="stat-pill created">+${_ctx.created}</span>
      <span class="stat-pill updated">~${_ctx.updated}</span>
    `;
  }

  const elapsed = document.getElementById("result-elapsed");
  if (elapsed) {
    elapsed.textContent = _ctx.elapsed ? `${_ctx.elapsed}s` : "";
  }
}

function hideMsgView() {
  document.getElementById("msg-view")?.classList.remove("show");
}

function setProg(val) {
  const fill = document.getElementById("msg-prog-fill");
  if (fill) {
    fill.style.width = val + "%";
  }
}

function bumpProg() {
  if (!_ctx || _ctx.total === 0) return;

  const done = _ctx.created + _ctx.updated;
  const pct = Math.min(95, 50 + Math.floor((done / _ctx.total) * 45));

  setProg(pct);
}

function startWarmup() {
  let p = 0;

  _warmupIv = setInterval(() => {
    if (p < 25) {
      p += 1;
      setProg(p);
    }
  }, 80);
}

function stopWarmup() {
  if (_warmupIv) {
    clearInterval(_warmupIv);
    _warmupIv = null;
  }
}

/* ─────────────────────────────────────
   서브텍스트 순환
───────────────────────────────────── */
function startSubCycle(type) {
  const steps =
    type === "jira"
      ? [
          "이슈 불러오는 중",
          "Notion 페이지 조회 중",
          "변경사항 비교 중",
          "Notion 업데이트 중",
        ]
      : [
          "pull request 조회 중",
          "PR 파일 분석 중",
          "Notion 페이지 조회 중",
          "Notion 업데이트 중",
        ];

  let i = 0;

  _subIv = setInterval(() => {
    i = Math.min(i + 1, steps.length - 1);

    const el = document.getElementById("msg-sub");
    if (el) el.textContent = steps[i];
  }, 2200);
}

function stopSubCycle() {
  if (_subIv) {
    clearInterval(_subIv);
    _subIv = null;
  }
}

/* ─────────────────────────────────────
   로그 파싱 → 진행률
───────────────────────────────────── */
function parseLog(msg) {
  if (!_ctx) return;

  const mF = msg.match(/Fetched\s+(\d+)/i);
  if (mF) {
    stopWarmup();
    _ctx.total = parseInt(mF[1], 10);
    setProg(50);
    return;
  }

  if (/^\+\s/.test(msg)) {
    _ctx.created++;
    bumpProg();
    return;
  }

  if (/^~\s/.test(msg)) {
    _ctx.updated++;
    bumpProg();
    return;
  }

  const mS = msg.match(/created=(\d+),?\s*updated=(\d+)/i);
  if (mS) {
    _ctx.created = parseInt(mS[1], 10);
    _ctx.updated = parseInt(mS[2], 10);
    setProg(95);
  }

  const mE = msg.match(/Elapsed time:\s*([\d.]+)s/i);
  if (mE) _ctx.elapsed = mE[1];
}

window.api?.onLog((msg) => parseLog(msg));

/* ─────────────────────────────────────
   Worklog 패널
───────────────────────────────────── */
async function fetchLogwork() {
  const refreshBtn = document.getElementById("refreshWorklog");
  const panel = document.querySelector(".work-panel");

  refreshBtn?.classList.add("is-spin");
  panel?.classList.add("is-refreshing");

  try {
    const data = await window.api?.fetchWorklogs(state.logworkOffset);
    if (!data) return;

    state.logwork[logworkKey(state.logworkOffset)] = {
      ...data,
      target: getTargetDays(),
    };

    renderLogwork();
  } catch (err) {
    console.warn(err);

    showMsgLoading({
      title: "Worklog",
      sub: "불러오기에 실패했어요",
      progress: false,
    });

    setTimeout(hideMsgView, 1400);
  } finally {
    refreshBtn?.classList.remove("is-spin");
    panel?.classList.remove("is-refreshing");
  }
}

function renderLogwork() {
  const data = getLogworkData(state.logworkOffset);
  const target = Number(data.target || 7);
  const logged = Number(data.loggedDays || 0);
  const rate =
    target > 0 ? Math.min(100, Math.round((logged / target) * 100)) : 0;

  document.getElementById("workMonth").textContent =
    data.label || (data.month ? data.month.replace("-", ".") : "-");

  document.getElementById("loggedDays").textContent =
    `${formatDecimal(logged)}D`;

  document.getElementById("targetDays").textContent =
    `/ ${formatDecimal(target)}D`;

  document.getElementById("workProgress").style.width = `${rate}%`;
}

function getWorkCategory(components = []) {
  const names = components.map((c) => c.name || "").join(" ");
  const hasG = /GMARKET|G마켓|G\b/i.test(names);
  const hasI = /AUCTION|옥션|IAC|I\b/i.test(names);

  if (hasG && hasI) return "G/I";
  if (hasG) return "G";
  if (hasI) return "I";
  return "";
}

function buildWorkReportRows() {
  const { logs = [] } = getLogworkData(state.logworkOffset);
  const group = new Map();

  logs.forEach((log) => {
    const key = log.issueKey;
    if (!key) return;

    if (!group.has(key)) {
      group.set(key, {
        issueKey: key,
        logs: [],
        seconds: 0,
      });
    }

    const item = group.get(key);
    item.logs.push(log);
    item.seconds += Number(log.timeSpentSeconds || 0);
  });

  return [...group.values()]
    .sort((a, b) => {
      const aLast = new Date(a.logs[0]?.started || 0).getTime();
      const bLast = new Date(b.logs[0]?.started || 0).getTime();
      return bLast - aLast;
    })
    .map(({ issueKey, logs, seconds }) => {
      const sorted = logs
        .slice()
        .sort((a, b) => new Date(a.started) - new Date(b.started));

      const firstLog = sorted[0] || {};

      return {
        "JIRA 번호": issueKey,
        업무내용: firstLog.summary || "",
        업무분류: getWorkCategory(firstLog.components),
        Type:
          firstLog.issueType || (/^(GPP|BCI)-/i.test(issueKey) ? "BC" : "DR"),
        요청구분: "JIRA",
        요청자: (firstLog.reporter || "")
          .replace(/\s*\([^)]*\)\s*$/, "")
          .trim(),
        담당자: (firstLog.assignee || "")
          .replace(/\s*\([^)]*\)\s*$/, "")
          .trim(),
        "업무 시작일": firstLog.targetStart || "",
        "업무 종료일": firstLog.targetEnd || "",
        "Mark up Delivery": firstLog.expectedDeliveryDate || "",
        "소요시간(D)": formatDecimal(seconds / 28800),
        Phase: firstLog.statusCategory || "",
        LTS: "",
        비고: firstLog.url || "",
      };
    });
}

window.buildWorkReportRows = buildWorkReportRows;

async function exportWorkReport() {
  if (busy) return;

  const btn = document.getElementById("exportWorkReport");

  try {
    busy = true;
    btn?.classList.add("is-exporting");

    const rows = buildWorkReportRows();
    const { month } = getLogworkData(state.logworkOffset);

    if (!rows.length) {
      showMsgLoading({
        title: "Excel Export",
        sub: "내보낼 로그워크가 없어요",
        progress: false,
      });

      setTimeout(hideMsgView, 1600);
      return;
    }

    const result = await window.api?.exportWorkReport(rows, month);

    if (!result?.canceled) {
      showMsgLoading({
        title: "Excel Export",
        sub: "엑셀 열었어요!",
        progress: false,
      });

      setTimeout(hideMsgView, 1600);
    }
  } catch (err) {
    console.warn(err);

    showMsgLoading({
      title: "Excel Export",
      sub: err?.message || "내보내기에 실패했어요",
      progress: false,
    });

    setTimeout(hideMsgView, 2200);
  } finally {
    btn?.classList.remove("is-exporting");
    busy = false;
  }
}

/* ─────────────────────────────────────
   AUTO badge
───────────────────────────────────── */
function updateAutoBadge() {
  document.getElementById("auto-badge").classList.toggle("off", !autoOn);
}

/* ─────────────────────────────────────
   휠 네비게이션
───────────────────────────────────── */
function nav(dir) {
  if (busy) return;

  if (dir === "auto") {
    autoOn = !autoOn;
    updateAutoBadge();

    autoOn ? window.api?.autoSync() : window.api?.stopAutoSync();
    return;
  }

  const items = MAIN_ITEMS;

  if (dir === "up") {
    curIdx = (curIdx - 1 + items.length) % items.length;
    renderCurrentMenu();
  }

  if (dir === "down") {
    curIdx = (curIdx + 1) % items.length;
    renderCurrentMenu();
  }
}

function doSelect() {
  if (busy) return;
  execItem(curIdx);
}

/* ─────────────────────────────────────
   컨텍스트 메뉴
───────────────────────────────────── */
const ipod = document.getElementById("ipod");
const contextMenu = document.getElementById("contextMenu");

// 휠 버튼 클릭 이벤트
document.getElementById("btn-up").addEventListener("click", () => nav("up"));

document
  .getElementById("btn-down")
  .addEventListener("click", () => nav("down"));

document.getElementById("btn-settings").addEventListener("click", () => {
  openSettings();
});

document
  .getElementById("btn-auto")
  .addEventListener("click", () => nav("auto"));

document
  .getElementById("btn-center")
  .addEventListener("click", () => doSelect());

// 우클릭 메뉴
ipod.addEventListener("contextmenu", (e) => {
  e.preventDefault();

  contextMenu.style.left = e.clientX + "px";
  contextMenu.style.top = e.clientY + "px";
  contextMenu.classList.add("show");
});

document.addEventListener("click", () => {
  contextMenu.classList.remove("show");
});

document.getElementById("ctx-minimize").addEventListener("click", () => {
  window.api?.minimize();
});

document.getElementById("ctx-close").addEventListener("click", () => {
  window.api?.close();
});

/* ─────────────────────────────────────
   설정 팝오버
───────────────────────────────────── */
const settingsOverlay = document.getElementById("settingsOverlay");
const closeSettingsBtn = document.getElementById("closeSettings");
const cancelSettingsBtn = document.getElementById("cancelSettings");
const saveSettingsBtn = document.getElementById("saveSettings");

// 설정 열기
function openSettings() {
  loadSettingsData();
  settingsOverlay.classList.add("show");
}

// 설정 닫기
function closeSettingsPopover() {
  settingsOverlay.classList.remove("show");
}

function applyTheme(theme = "s") {
  curTheme = theme || "s";
  document.documentElement.dataset.theme = curTheme;
  localStorage.setItem("theme", curTheme);
}

function syncThemeButtons() {
  document.querySelectorAll(".mini-theme").forEach((item) => {
    item.classList.toggle("active", item.dataset.theme === curTheme);
  });
}

// 설정 로드
async function loadSettingsData() {
  const env = await window.api?.loadEnv();
  if (!env) return;

  document.getElementById("jiraUrl").value = env.JIRA_BASE_URL || "";
  document.getElementById("jiraPat").value = env.JIRA_PAT || "";
  document.getElementById("jiraEmail").value = env.JIRA_EMAIL || "";
  document.getElementById("notionToken").value = env.NOTION_TOKEN || "";
  document.getElementById("notionSourceJira").value =
    env.NOTION_SOURCE_ID_JIRA || "";
  document.getElementById("notionSourcePR").value =
    env.NOTION_SOURCE_ID_PR || "";
  document.getElementById("githubToken").value = env.GITHUB_TOKEN || "";
  document.getElementById("githubUsername").value = env.GITHUB_USERNAME || "";
  document.getElementById("githubUrl").value = env.GITHUB_URL || "";
  document.getElementById("targetLog").value = env.WORKLOG_TARGET_DAYS || "7";

  // 잠금 설정 로드
  const lockBgData = await window.api?.loadLockBg?.();
  lockBgImageUrl = lockBgData?.url || "";
  lockBgPanX = Number(env.LOCK_BG_POS_X ?? 0);
  lockBgPanY = Number(env.LOCK_BG_POS_Y ?? 0);
  lockBgZoom = Number(env.LOCK_BG_ZOOM ?? 1) || 1;

  // 설정창 프리뷰는 draft 상태로만 변경한다.
  draftLockBgImageUrl = lockBgImageUrl;
  draftLockBgPanX = lockBgPanX;
  draftLockBgPanY = lockBgPanY;
  draftLockBgZoom = lockBgZoom;

  const zoomSlider = document.getElementById("lockZoomSlider");
  const zoomVal = document.getElementById("lockZoomVal");
  if (zoomSlider) zoomSlider.value = draftLockBgZoom;
  if (zoomVal) zoomVal.textContent = `${draftLockBgZoom.toFixed(1)}×`;

  updateImagePreview(draftLockBgImageUrl);
  syncThemeButtons();
}

// 설정 저장
async function saveSettingsData() {
  const nextTarget = Number(document.getElementById("targetLog").value || 7);
  const nextTheme = curTheme;
  const nextLockBgImageUrl = draftLockBgImageUrl;
  const nextLockBgPanX = draftLockBgPanX;
  const nextLockBgPanY = draftLockBgPanY;
  const nextLockBgZoom = draftLockBgZoom;

  // 저장/리로드 직후 첫 페인트용 캐시
  localStorage.setItem("theme", nextTheme || "s");

  const data = {
    JIRA_BASE_URL: document.getElementById("jiraUrl").value,
    JIRA_PAT: document.getElementById("jiraPat").value,
    JIRA_EMAIL: document.getElementById("jiraEmail").value,
    NOTION_TOKEN: document.getElementById("notionToken").value,
    NOTION_SOURCE_ID_JIRA: document.getElementById("notionSourceJira").value,
    NOTION_SOURCE_ID_PR: document.getElementById("notionSourcePR").value,
    GITHUB_TOKEN: document.getElementById("githubToken").value,
    GITHUB_USERNAME: document.getElementById("githubUsername").value,
    GITHUB_URL: document.getElementById("githubUrl").value,
    WORKLOG_TARGET_DAYS: String(nextTarget || 7),
    LOCK_BG_POS_X: nextLockBgPanX,
    LOCK_BG_POS_Y: nextLockBgPanY,
    LOCK_BG_ZOOM: nextLockBgZoom,
  };

  closeSettingsPopover();

  requestAnimationFrame(async () => {
    try {
      await Promise.all([
        window.api?.saveEnv(data),
        nextTheme ? window.api?.setTheme?.(nextTheme) : Promise.resolve(),
        window.api?.saveLockBg?.({ url: nextLockBgImageUrl }),
      ]);

      // SAVE 성공 후에만 실제 잠금화면 상태에 반영한다.
      lockBgImageUrl = nextLockBgImageUrl;
      lockBgPanX = nextLockBgPanX;
      lockBgPanY = nextLockBgPanY;
      lockBgZoom = nextLockBgZoom;

      const cur = state.logwork[logworkKey(state.logworkOffset)];

      if (cur) {
        cur.target = nextTarget;
        renderLogwork();
      }
    } catch (err) {
      console.warn(err);

      showMsgLoading({
        title: "Settings",
        sub: "저장에 실패했어요",
        progress: false,
      });

      setTimeout(hideMsgView, 1600);
    }
  });
}
// 이벤트 리스너
closeSettingsBtn.addEventListener("click", closeSettingsPopover);
cancelSettingsBtn.addEventListener("click", closeSettingsPopover);
saveSettingsBtn.addEventListener("click", saveSettingsData);

// 오버레이 클릭시 닫기
settingsOverlay.addEventListener("click", (e) => {
  if (e.target === settingsOverlay) {
    closeSettingsPopover();
  }
});

// 테마 선택
document.querySelectorAll(".mini-theme").forEach((item) => {
  item.addEventListener("click", () => {
    const selectedTheme = item.dataset.theme;
    if (!selectedTheme || selectedTheme === curTheme) return;

    applyTheme(selectedTheme);
    syncThemeButtons();
  });
});
document.getElementById("refreshWorklog")?.addEventListener("click", () => {
  fetchLogwork();
});

document.getElementById("prevMonth")?.addEventListener("click", () => {
  state.logworkOffset -= 1;
  fetchLogwork();
});

document.getElementById("nextMonth")?.addEventListener("click", () => {
  state.logworkOffset += 1;
  fetchLogwork();
});

// ESC로 닫기
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && settingsOverlay.classList.contains("show")) {
    closeSettingsPopover();
  }
});

/* ─────────────────────────────────────
   초기화
───────────────────────────────────── */
window.addEventListener("DOMContentLoaded", async () => {
  const cachedTheme = localStorage.getItem("theme");
  applyTheme(cachedTheme || "s");

  const savedTheme = await window.api?.getTheme?.();
  if (savedTheme && savedTheme !== curTheme) {
    applyTheme(savedTheme);
  }
  syncThemeButtons();

  document.getElementById("menu-view").classList.add("show");

  renderCurrentMenu();
  updateAutoBadge();

  await loadSettingsData();
  await fetchLogwork();

  if (autoOn) window.api?.autoSync();
});

// ===== 잠금 화면 기능 =====
function updateLockClock() {
  const now = new Date();

  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const timeEl = document.getElementById("lock-time");
  if (timeEl) {
    timeEl.textContent = `${hours}:${minutes}`;
  }

  const days = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
  const months = [
    "JAN",
    "FEB",
    "MAR",
    "APR",
    "MAY",
    "JUN",
    "JUL",
    "AUG",
    "SEP",
    "OCT",
    "NOV",
    "DEC",
  ];
  const dayName = days[now.getDay()];
  const monthName = months[now.getMonth()];
  const date = now.getDate();

  const dateEl = document.getElementById("lock-date");
  if (dateEl) {
    dateEl.textContent = `${dayName}, ${monthName} ${date}`;
  }
}

function showLockScreen() {
  isLocked = true;
  updateLockClock();
  lockClockInterval = setInterval(updateLockClock, 1000);

  document.getElementById("lock-led-icon")?.classList.add("locked");

  const lockScreen = document.getElementById("lock-screen");
  const lockBgImg = document.getElementById("lock-bg-img");
  if (lockScreen) {
    if (lockBgImageUrl && lockBgImg) {
      lockScreen.setAttribute("data-bg", "image");
      lockBgImg.src = lockBgImageUrl;
      lockBgImg.style.transform = `translate(${lockBgPanX}%, ${lockBgPanY}%) scale(${lockBgZoom})`;
    } else {
      lockScreen.setAttribute("data-bg", "theme");
      if (lockBgImg) lockBgImg.src = "";
    }
    lockScreen.classList.add("show");
  }
}

function hideLockScreen() {
  isLocked = false;

  if (lockClockInterval) {
    clearInterval(lockClockInterval);
    lockClockInterval = null;
  }

  document.getElementById("lock-led-icon")?.classList.remove("locked");
  document.getElementById("lock-screen")?.classList.remove("show");
}

function updateImagePreview(url) {
  const placeholder = document.getElementById("lockPreviewPlaceholder");
  const previewImg = document.getElementById("lockPreviewImg");
  const removeBtn = document.getElementById("imageRemove");
  const zoomRow = document.getElementById("lockZoomRow");
  const lockPreview = document.getElementById("lockPreview");

  if (url) {
    placeholder.style.display = "none";
    previewImg.src = url;
    previewImg.style.display = "block";
    previewImg.style.transform = `translate(${draftLockBgPanX}%, ${draftLockBgPanY}%) scale(${draftLockBgZoom})`;
    removeBtn.style.display = "flex";
    zoomRow.style.display = "flex";
    lockPreview?.classList.add("has-image");
  } else {
    placeholder.style.display = "flex";
    previewImg.src = "";
    previewImg.style.display = "none";
    removeBtn.style.display = "none";
    zoomRow.style.display = "none";
    lockPreview?.classList.remove("has-image");
  }
}

// ===== 이벤트 리스너 =====

// 잠금 상태에서 휠 버튼 클릭시 잠금 해제 (capture phase)
document.getElementById("wheel")?.addEventListener(
  "click",
  (e) => {
    if (isLocked) {
      e.stopPropagation();
      hideLockScreen();
    }
  },
  true,
);

document.getElementById("lock-led-icon")?.addEventListener("click", () => {
  if (isLocked) {
    hideLockScreen();
  } else {
    showLockScreen();
  }
});

document.getElementById("lock-screen")?.addEventListener("click", () => {
  if (isLocked) hideLockScreen();
});

// ===== 이미지 드래그 (위치 조정) =====
let _dragActive = false;
let _dragStartX = 0,
  _dragStartY = 0;
let _dragStartPosX = 50,
  _dragStartPosY = 50;

document.getElementById("lockPreview")?.addEventListener("mousedown", (e) => {
  if (!draftLockBgImageUrl) return;
  _dragActive = true;
  _dragStartX = e.clientX;
  _dragStartY = e.clientY;
  _dragStartPosX = draftLockBgPanX;
  _dragStartPosY = draftLockBgPanY;
  e.preventDefault();
});

document.addEventListener("mousemove", (e) => {
  if (!_dragActive) return;
  const preview = document.getElementById("lockPreview");
  if (!preview) return;
  const rect = preview.getBoundingClientRect();
  const dx = ((e.clientX - _dragStartX) / rect.width) * 100;
  const dy = ((e.clientY - _dragStartY) / rect.height) * 100;
  const maxPan = ((lockBgZoom - 1) / 2) * 100;
  lockBgPanX = Math.max(-maxPan, Math.min(maxPan, _dragStartPosX + dx));
  lockBgPanY = Math.max(-maxPan, Math.min(maxPan, _dragStartPosY + dy));
  const previewImg = document.getElementById("lockPreviewImg");
  if (previewImg)
    previewImg.style.transform = `translate(${draftLockBgPanX}%, ${draftLockBgPanY}%) scale(${draftLockBgZoom})`;
});

document.addEventListener("mouseup", () => {
  _dragActive = false;
});

// ===== 줌 슬라이더 =====
document.getElementById("lockZoomSlider")?.addEventListener("input", (e) => {
  lockBgZoom = Number(e.target.value);
  const zoomVal = document.getElementById("lockZoomVal");
  if (zoomVal) zoomVal.textContent = `${lockBgZoom.toFixed(1)}×`;
  const maxPan = ((lockBgZoom - 1) / 2) * 100;
  lockBgPanX = Math.max(-maxPan, Math.min(maxPan, lockBgPanX));
  lockBgPanY = Math.max(-maxPan, Math.min(maxPan, lockBgPanY));
  const previewImg = document.getElementById("lockPreviewImg");
  if (previewImg)
    previewImg.style.transform = `translate(${draftLockBgPanX}%, ${draftLockBgPanY}%) scale(${draftLockBgZoom})`;
});

document.querySelectorAll(".mini-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const targetTab = tab.dataset.tab;
    document
      .querySelectorAll(".mini-tab")
      .forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document
      .querySelectorAll(".mini-tab-content")
      .forEach((c) => c.classList.remove("active"));
    document
      .querySelector(`[data-content="${targetTab}"]`)
      ?.classList.add("active");
  });
});

document.getElementById("urlBtn")?.addEventListener("click", () => {
  const urlInput = document.getElementById("urlInput");
  urlInput.style.display =
    urlInput.style.display === "none" || !urlInput.style.display
      ? "flex"
      : "none";
});

document.getElementById("urlApply")?.addEventListener("click", () => {
  const url = document.getElementById("lockBgImageInput").value;
  if (url) {
    draftLockBgImageUrl = url;
    draftLockBgPanX = 0;
    draftLockBgPanY = 0;
    draftLockBgZoom = 1;
    _resetZoomUI();
    updateImagePreview(draftLockBgImageUrl);
    document.getElementById("urlInput").style.display = "none";
  }
});

document.getElementById("imageRemove")?.addEventListener("click", () => {
  draftLockBgImageUrl = "";
  draftLockBgPanX = 0;
  draftLockBgPanY = 0;
  draftLockBgZoom = 1;
  document.getElementById("lockBgImageInput").value = "";
  _resetZoomUI();
  updateImagePreview("");
});

document.getElementById("lockBgImageFile")?.addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      draftLockBgImageUrl = event.target.result;
      draftLockBgPanX = 0;
      draftLockBgPanY = 0;
      draftLockBgZoom = 1;
      _resetZoomUI();
      updateImagePreview(draftLockBgImageUrl);
    };
    reader.readAsDataURL(file);
  }
});

function _resetZoomUI() {
  draftLockBgZoom = 1;
  const slider = document.getElementById("lockZoomSlider");
  const val = document.getElementById("lockZoomVal");
  if (slider) slider.value = 1;
  if (val) val.textContent = "1.0×";
}
