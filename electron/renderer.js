/* ─────────────────────────────────────
   뷰 스택 기반 네비게이션
───────────────────────────────────── */
const VIEWS = ["menu-view"];
let viewStack = ["menu-view"];
let curIdx = 0;
let busy = false;
let autoOn = true;
let curTheme = "s";

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
  { label: "Sync Jira", act: "sync-jira" },
  { label: "Sync PR", act: "sync-pr" },
];

/* ─────────────────────────────────────
   뷰 전환
───────────────────────────────────── */
function applyView(id, title) {
  VIEWS.forEach((v) => {
    const el = document.getElementById(v);
    if (el) el.classList.toggle("show", v === id);
  });
  document.getElementById("msg-view").classList.remove("show");
  document.getElementById("scr-title").textContent = title || "NotionFlow";
}

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
  _ctx = { type, total: 0, created: 0, updated: 0, deleted: 0, elapsed: null };

  showMsgLoading(type);
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
      hideMsgView();
      busy = false;
      _ctx = null;
    });
}

function showMsgLoading(type) {
  document.getElementById("msg-view").classList.add("show");
  document.getElementById("msg-loading").classList.remove("hide");
  document.getElementById("msg-result").classList.remove("show");
  document.getElementById("msg-main").textContent =
    type === "jira" ? "Sync Jira" : "Sync PR";
  document.getElementById("msg-sub").textContent = "준비 중...";
  setProg(0);
}

function showMsgResult() {
  document.getElementById("msg-loading").classList.add("hide");
  const res = document.getElementById("msg-result");
  res.classList.add("show");
  document.getElementById("result-title").textContent = "완료";
  const stats = document.getElementById("result-stats");
  stats.innerHTML = "";
  if (_ctx.created > 0) {
    stats.innerHTML += `<span class="stat-pill created">+${_ctx.created}</span>`;
  }
  if (_ctx.updated > 0) {
    stats.innerHTML += `<span class="stat-pill updated">~${_ctx.updated}</span>`;
  }
  if (_ctx.deleted > 0) {
    stats.innerHTML += `<span class="stat-pill deleted">-${_ctx.deleted}</span>`;
  }
  if (_ctx.elapsed) {
    document.getElementById("result-elapsed").textContent = `${_ctx.elapsed}s`;
  }
}

function hideMsgView() {
  document.getElementById("msg-view").classList.remove("show");
}

function showMsgPlain(title, sub) {
  document.getElementById("msg-view").classList.add("show");
  document.getElementById("msg-loading").classList.remove("hide");
  document.getElementById("msg-result").classList.remove("show");
  document.getElementById("msg-main").textContent = title;
  document.getElementById("msg-sub").textContent = sub;
  document.getElementById("msg-prog-wrap").style.display = "none";
}

function setProg(val) {
  document.getElementById("msg-prog-fill").style.width = val + "%";
}

function bumpProg() {
  if (!_ctx || _ctx.total === 0) return;
  const done = _ctx.created + _ctx.updated + _ctx.deleted;
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
  if (/^-\s/.test(msg)) {
    _ctx.deleted++;
    bumpProg();
    return;
  }
  const mS = msg.match(/created=(\d+),?\s*updated=(\d+),?\s*deleted=(\d+)/i);
  if (mS) {
    _ctx.created = parseInt(mS[1], 10);
    _ctx.updated = parseInt(mS[2], 10);
    _ctx.deleted = parseInt(mS[3], 10);
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
    showMsgPlain("Worklog", "불러오기에 실패했어요");
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
  document.getElementById("workRate").textContent = `${rate}%`;
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
      group.set(key, { issueKey: key, logs: [], seconds: 0 });
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

//
document
  .getElementById("exportWorkReport")
  ?.addEventListener("click", async () => {
    const btn = document.getElementById("exportWorkReport");

    try {
      btn?.classList.add("is-exporting");

      const rows = buildWorkReportRows();
      const { month } = getLogworkData(state.logworkOffset);

      if (!rows.length) {
        showMsgPlain("Excel Export", "내보낼 로그워크가 없어요");
        setTimeout(hideMsgView, 1600);
        return;
      }

      const result = await window.api.exportWorkReport(rows, month);

      if (!result?.canceled) {
        showMsgPlain("Excel Export", "엑셀 열었어요!");
        setTimeout(hideMsgView, 1600);
      }
    } catch (err) {
      console.warn(err);

      showMsgPlain("Excel Export", err?.message || "내보내기에 실패했어요");

      setTimeout(hideMsgView, 2200);
    } finally {
      btn?.classList.remove("is-exporting");
    }
  });

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

// 설정 로드
async function loadSettingsData() {
  const env = await window.api?.loadEnv();
  if (!env) return;

  document.getElementById("jiraUrl").value = env.JIRA_BASE_URL || "";
  document.getElementById("jiraPat").value = env.JIRA_PAT || "";
  document.getElementById("notionToken").value = env.NOTION_TOKEN || "";
  document.getElementById("notionSourceJira").value =
    env.NOTION_SOURCE_ID_JIRA || "";
  document.getElementById("notionSourcePR").value =
    env.NOTION_SOURCE_ID_PR || "";
  document.getElementById("githubToken").value = env.GITHUB_TOKEN || "";
  document.getElementById("githubUsername").value = env.GITHUB_USERNAME || "";
  document.getElementById("githubUrl").value = env.GITHUB_URL || "";
  document.getElementById("targetLog").value = env.WORKLOG_TARGET_DAYS || "7";

  // 현재 테마 로드
  const theme = await window.api?.getTheme();
  if (theme) {
    document
      .querySelectorAll(".mini-theme")
      .forEach((i) => i.classList.remove("active"));
    document
      .querySelector(`.mini-theme[data-theme="${theme}"]`)
      ?.classList.add("active");
  }
}

// 설정 저장
async function saveSettingsData() {
  const data = {
    JIRA_BASE_URL: document.getElementById("jiraUrl").value,
    JIRA_PAT: document.getElementById("jiraPat").value,
    NOTION_TOKEN: document.getElementById("notionToken").value,
    NOTION_SOURCE_ID_JIRA: document.getElementById("notionSourceJira").value,
    NOTION_SOURCE_ID_PR: document.getElementById("notionSourcePR").value,
    NOTION_SOURCE_ID_REVIEW: "",
    GITHUB_TOKEN: document.getElementById("githubToken").value,
    GITHUB_USERNAME: document.getElementById("githubUsername").value,
    GITHUB_URL: document.getElementById("githubUrl").value,
    WORKLOG_TARGET_DAYS: document.getElementById("targetLog").value || "7",
  };

  await window.api?.saveEnv(data);

  const selectedTheme =
    document.querySelector(".mini-theme.active")?.dataset.theme;
  if (selectedTheme) {
    await window.api?.setTheme(selectedTheme);
  }

  const cur = state.logwork[logworkKey(state.logworkOffset)];
  if (cur) {
    cur.target = getTargetDays();
    renderLogwork();
  }

  closeSettingsPopover();
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
    document
      .querySelectorAll(".mini-theme")
      .forEach((i) => i.classList.remove("active"));
    item.classList.add("active");
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
  applyView("menu-view", "NotionFlow");
  document.getElementById("menu-view").classList.add("show");
  renderCurrentMenu();
  updateAutoBadge();
  await loadSettingsData();
  await fetchLogwork();

  if (autoOn) window.api?.autoSync();
});
