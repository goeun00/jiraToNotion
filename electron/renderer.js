/* ─────────────────────────────────────
   뷰 스택 기반 네비게이션
───────────────────────────────────── */
const VIEWS = [
  "menu-view",
  "set-view",
  "cfg-view",
  "theme-view",
  "review-view",
  "repo-cfg-view",
];
let viewStack = ["menu-view"];
let curIdx = 0;
let busy = false;
let autoOn = true;
let curTheme = "s";

// 저장소 설정: [{ name: string, branches: string[] }]
let repoConfigs = [];

/* 메뉴 정의 */
const MAIN_ITEMS = [
  { label: "Sync Jira", act: "sync-jira" },
  { label: "Sync PR", act: "sync-pr" },
  { label: "Code Review", act: "push-review" },
  { label: "Settings", act: "push-set" },
  { label: "About", act: "about" },
];
const SET_ITEMS = [
  { label: "Token 설정", act: "push-cfg" },
  { label: "Repo 설정", act: "push-repo-cfg" },
  { label: "Color Mode", act: "push-theme" },
];

const envMap = {
  notionToken: "NOTION_TOKEN",
  notionJiraDb: "NOTION_SOURCE_ID_JIRA",
  notionPrDb: "NOTION_SOURCE_ID_PR",
  notionReviewDb: "NOTION_SOURCE_ID_REVIEW",
  jiraUrl: "JIRA_BASE_URL",
  jiraPat: "JIRA_PAT",
  githubUrl: "GITHUB_URL",
  githubToken: "GITHUB_TOKEN",
  githubUser: "GITHUB_USERNAME",
  geminiKey: "GEMINI_API_KEY",
};

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

function pushView(id, title) {
  viewStack.push(id);
  curIdx = 0;
  applyView(id, title);
  renderCurrentMenu();
}

function popView() {
  if (viewStack.length <= 1) return;
  viewStack.pop();
  curIdx = 0;
  const id = viewStack[viewStack.length - 1];
  const titles = {
    "menu-view": "NotionFlow",
    "set-view": "Settings",
    "cfg-view": "Token 설정",
    "theme-view": "Color Mode",
    "review-view": "Code Review",
    "repo-cfg-view": "Repo 설정",
  };
  applyView(id, titles[id]);
  renderCurrentMenu();
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
  else if (vid === "set-view") renderMenu("set-mlist", SET_ITEMS);
  else if (vid === "theme-view") renderTheme();
  else if (vid === "review-view") renderReviewView();
  else if (vid === "repo-cfg-view") renderRepoCfgView();
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

function renderTheme() {
  document.querySelectorAll(".theme-item").forEach((el) => {
    const t = el.dataset.theme;
    el.classList.toggle("sel", t === curTheme);
  });
}

/* ─────────────────────────────────────
   저장소 설정 뷰 렌더
───────────────────────────────────── */
function renderRepoCfgView() {
  const list = document.getElementById("repo-cfg-list");
  list.innerHTML = repoConfigs
    .map(
      (cfg, ri) => `
    <div class="repo-entry" data-ri="${ri}">
      <div class="repo-entry-head">
        <input class="repo-entry-name cfg-input" value="${escHtml(cfg.name)}" placeholder="repo name" data-ri="${ri}" data-field="name" />
        <button class="repo-del-btn" data-ri="${ri}" data-action="del-repo">✕</button>
      </div>
      <div class="repo-branches">
        ${cfg.branches
          .map(
            (b, bi) => `
          <div class="repo-branch-row">
            <input class="repo-branch-input" value="${escHtml(b)}" placeholder="branch" data-ri="${ri}" data-bi="${bi}" />
            <button class="repo-branch-del" data-ri="${ri}" data-bi="${bi}" data-action="del-branch">✕</button>
          </div>
        `,
          )
          .join("")}
        <button class="repo-add-branch-btn" data-ri="${ri}" data-action="add-branch">+ branch</button>
      </div>
    </div>
  `,
    )
    .join("");
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
}

// repo-cfg 이벤트 위임
document.getElementById("repo-cfg-list").addEventListener("input", (e) => {
  const el = e.target;
  const ri = parseInt(el.dataset.ri, 10);
  const bi = el.dataset.bi !== undefined ? parseInt(el.dataset.bi, 10) : null;
  if (isNaN(ri)) return;
  if (el.dataset.field === "name") {
    repoConfigs[ri].name = el.value;
  } else if (bi !== null) {
    repoConfigs[ri].branches[bi] = el.value;
  }
});

document.getElementById("repo-cfg-list").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  const ri = parseInt(btn.dataset.ri, 10);
  const bi = btn.dataset.bi !== undefined ? parseInt(btn.dataset.bi, 10) : null;

  if (action === "del-repo") {
    repoConfigs.splice(ri, 1);
    renderRepoCfgView();
  } else if (action === "add-branch") {
    repoConfigs[ri].branches.push("");
    renderRepoCfgView();
  } else if (action === "del-branch") {
    repoConfigs[ri].branches.splice(bi, 1);
    renderRepoCfgView();
  }
});

document.getElementById("addRepo").addEventListener("click", () => {
  repoConfigs.push({ name: "", branches: ["main", "dev"] });
  renderRepoCfgView();
  // 스크롤 하단으로
  const scroll = document.getElementById("repo-cfg-scroll");
  setTimeout(() => {
    scroll.scrollTop = scroll.scrollHeight;
  }, 50);
});

document.getElementById("saveRepos").addEventListener("click", async () => {
  // 빈 name 정리
  const cleaned = repoConfigs
    .map((cfg) => ({
      name: cfg.name.trim(),
      branches: cfg.branches.map((b) => b.trim()).filter(Boolean),
    }))
    .filter((cfg) => cfg.name);
  repoConfigs = cleaned;
  await window.api?.saveRepoConfigs(repoConfigs);
  populateReviewSelects();
  showMsgPlain("✔ 저장 완료", "repo 설정이 저장되었습니다");
  setTimeout(() => {
    hideMsgView();
  }, 1400);
});

/* ─────────────────────────────────────
   코드 리뷰 뷰 렌더
───────────────────────────────────── */
function renderReviewView() {
  populateReviewSelects();
}

function populateReviewSelects() {
  const repoSel = document.getElementById("reviewRepo");
  const baseSel = document.getElementById("reviewBase");

  // 저장소 목록
  repoSel.innerHTML =
    repoConfigs.length === 0
      ? '<option value="">— 저장소 없음 (Repo 설정 필요) —</option>'
      : repoConfigs
          .map(
            (cfg) =>
              `<option value="${escHtml(cfg.name)}">${escHtml(cfg.name)}</option>`,
          )
          .join("");

  // base 브랜치 목록 (저장소 변경 시 업데이트)
  function updateBranches() {
    const cfg = repoConfigs.find((c) => c.name === repoSel.value);
    const branches = cfg ? cfg.branches : [];
    const opts = branches
      .map((b) => `<option value="${escHtml(b)}">${escHtml(b)}</option>`)
      .join("");
    baseSel.innerHTML = opts || '<option value="">— 없음 —</option>';
  }

  repoSel.addEventListener("change", updateBranches);
  updateBranches();
}

document.getElementById("runReview").addEventListener("click", () => {
  const repo = document.getElementById("reviewRepo").value;
  const base = document.getElementById("reviewBase").value;
  const compare = document.getElementById("reviewCompare").value;

  if (!repo || !base || !compare) {
    showMsgPlain("입력 오류", "저장소, base, compare 브랜치를 입력하세요");
    setTimeout(() => hideMsgView(), 1600);
    return;
  }
  if (base === compare) {
    showMsgPlain("브랜치 오류", "base와 compare가 같습니다");
    setTimeout(() => hideMsgView(), 1600);
    return;
  }

  startReview(repo, base, compare);
});

/* ─────────────────────────────────────
   아이템 실행
───────────────────────────────────── */
function execItem(idx) {
  if (busy) return;
  const vid = currentViewId();
  const items =
    vid === "menu-view" ? MAIN_ITEMS : vid === "set-view" ? SET_ITEMS : null;
  if (!items) return;
  const it = items[idx];
  if (!it) return;

  if (it.act === "push-set") {
    pushView("set-view", "Settings");
    return;
  }
  if (it.act === "push-cfg") {
    pushView("cfg-view", "Token 설정");
    return;
  }
  if (it.act === "push-theme") {
    pushView("theme-view", "Color Mode");
    return;
  }
  if (it.act === "push-review") {
    pushView("review-view", "Code Review");
    return;
  }
  if (it.act === "push-repo-cfg") {
    pushView("repo-cfg-view", "Repo 설정");
    return;
  }

  if (it.act === "about") {
    showMsgPlain("NotionFlow v1.1", "jira + github + ai review → notion");
    setTimeout(() => hideMsgView(), 1800);
    return;
  }

  if (it.act === "sync-jira") {
    startSync("jira");
    return;
  }
  if (it.act === "sync-pr") {
    startSync("pr");
    return;
  }
}

/* 테마 아이템 클릭 */
function execThemeItem(theme) {
  curTheme = theme;
  document.documentElement.setAttribute("data-theme", theme);
  renderTheme();
}

/* ─────────────────────────────────────
   Sync 실행
───────────────────────────────────── */
let _ctx = null;
let _subIv = null;
let _warmIv = null;

function startSync(type) {
  busy = true;
  _ctx = { total: 0, created: 0, updated: 0, deleted: 0, elapsed: null };

  const isJira = type === "jira";
  showMsgLoading(
    isJira ? "Jira 싱크 중..." : "PR 싱크 중...",
    isJira ? "이슈 불러오는 중" : "pull request 조회 중",
  );
  startWarmup();
  startSubCycle(type);

  const api = isJira ? window.api?.syncJira() : window.api?.syncPR();
  api
    ?.then(() => {
      stopSubCycle();
      finishProg();
      showMsgResult(isJira ? "Jira 완료" : "PR 완료");
      setTimeout(() => {
        hideMsgView();
        busy = false;
      }, 2400);
    })
    .catch((e) => {
      stopSubCycle();
      stopWarmup();
      showMsgPlain("오류 발생", e?.message || String(e));
      setTimeout(() => {
        hideMsgView();
        busy = false;
      }, 2200);
    });
}

/* ─────────────────────────────────────
   코드 리뷰 실행
───────────────────────────────────── */
function startReview(repo, base, compare) {
  busy = true;
  _ctx = { total: 0, created: 0, updated: 0, deleted: 0, elapsed: null };

  showMsgLoading("AI 코드 리뷰 중...", `${compare} → ${base}`);
  startWarmup();

  // 서브텍스트 순환
  const steps = ["diff 분석 중", "Gemini 리뷰 중", "Notion 페이지 생성 중"];
  let si = 0;
  _subIv = setInterval(() => {
    si = Math.min(si + 1, steps.length - 1);
    const el = document.getElementById("msg-sub");
    if (el) el.textContent = steps[si];
    setProg(20 + si * 25);
  }, 4000);

  const org = "org-publisher";

  window.api
    ?.runCodeReview(org, repo, base, compare)
    .then(() => {
      stopSubCycle();
      finishProg();
      _ctx.created = 1;
      showMsgResult(`리뷰 완료`);
      setTimeout(() => {
        hideMsgView();
        busy = false;
      }, 2400);
    })
    .catch((e) => {
      stopSubCycle();
      stopWarmup();
      const msg = e?.message || String(e);
      showMsgPlain("리뷰 실패", msg.slice(0, 60));
      setTimeout(() => {
        hideMsgView();
        busy = false;
      }, 8000);
    });
}

/* ─────────────────────────────────────
   msg 오버레이
───────────────────────────────────── */
function showMsgLoading(main, sub) {
  document.getElementById("msg-loading").classList.remove("hide");
  document.getElementById("msg-result").classList.remove("show");
  document.getElementById("msg-main").textContent = main;
  document.getElementById("msg-sub").textContent = sub;
  const wrap = document.querySelector(".msg-prog-wrap");
  if (wrap) wrap.style.visibility = "";
  document.getElementById("msg-view").classList.add("show");
}

function showMsgPlain(main, sub) {
  document.getElementById("msg-loading").classList.remove("hide");
  document.getElementById("msg-result").classList.remove("show");
  document.getElementById("msg-main").textContent = main;
  document.getElementById("msg-sub").textContent = sub;
  const pw = document.getElementById("msg-prog-fill");
  if (pw) {
    pw.style.transition = "none";
    pw.style.width = "0%";
  }
  const wrap = document.querySelector(".msg-prog-wrap");
  if (wrap) wrap.style.visibility = "hidden";
  document.getElementById("msg-view").classList.add("show");
}

function showMsgResult(title) {
  document.getElementById("msg-loading").classList.add("hide");
  const res = document.getElementById("msg-result");
  res.classList.add("show");
  document.getElementById("result-title").textContent = title;
  const c = _ctx?.created || 0,
    u = _ctx?.updated || 0,
    d = _ctx?.deleted || 0;
  document.getElementById("result-stats").innerHTML = [
    c > 0 ? `<span class="stat-pill created">+${c} new</span>` : "",
    u > 0 ? `<span class="stat-pill updated">~${u} updated</span>` : "",
    d > 0 ? `<span class="stat-pill deleted">-${d} deleted</span>` : "",
    c === 0 && u === 0 && d === 0
      ? `<span class="stat-pill updated">변경 없음</span>`
      : "",
  ].join("");
  document.getElementById("result-elapsed").textContent = _ctx?.elapsed
    ? `${_ctx.elapsed}s`
    : "";
}

function hideMsgView() {
  document.getElementById("msg-view").classList.remove("show");
  document.getElementById("msg-result").classList.remove("show");
  document.getElementById("msg-loading").classList.remove("hide");
  const wrap = document.querySelector(".msg-prog-wrap");
  if (wrap) wrap.style.visibility = "";
  setProg(0, false);
  _ctx = null;
}

/* ─────────────────────────────────────
   프로그레스바
───────────────────────────────────── */
function setProg(pct, animate) {
  const f = document.getElementById("msg-prog-fill");
  if (!f) return;
  f.style.transition = animate === false ? "none" : "width .35s ease";
  f.style.width = Math.min(100, Math.max(0, Math.round(pct))) + "%";
}
function startWarmup() {
  setProg(0, false);
  let p = 0;
  _warmIv = setInterval(() => {
    p += 1.2;
    if (p >= 15) {
      clearInterval(_warmIv);
      _warmIv = null;
      return;
    }
    setProg(p);
  }, 80);
}
function stopWarmup() {
  if (_warmIv) {
    clearInterval(_warmIv);
    _warmIv = null;
  }
}
function finishProg() {
  stopWarmup();
  setProg(100);
}
function bumpProg() {
  if (!_ctx || _ctx.total <= 0) return;
  const ratio = Math.min(
    1,
    (_ctx.created + _ctx.updated + _ctx.deleted) / _ctx.total,
  );
  setProg(50 + ratio * 45);
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
  const vid = currentViewId();

  if (dir === "back") {
    popView();
    return;
  }

  if (dir === "auto") {
    autoOn = !autoOn;
    updateAutoBadge();
    autoOn ? window.api?.autoSync() : window.api?.stopAutoSync();
    return;
  }

  if (vid === "cfg-view") {
    document.getElementById("cfg-scroll").scrollTop +=
      dir === "down" ? 44 : -44;
    return;
  }
  if (vid === "repo-cfg-view") {
    document.getElementById("repo-cfg-scroll").scrollTop +=
      dir === "down" ? 44 : -44;
    return;
  }
  if (vid === "review-view") {
    document.getElementById("review-scroll").scrollTop +=
      dir === "down" ? 44 : -44;
    return;
  }
  if (vid === "theme-view") {
    const themes = ["s", "bk", "pk", "bl", "gn"];
    const ci = themes.indexOf(curTheme);
    const ni =
      dir === "down"
        ? Math.min(ci + 1, themes.length - 1)
        : Math.max(ci - 1, 0);
    execThemeItem(themes[ni]);
    return;
  }

  const items =
    vid === "menu-view" ? MAIN_ITEMS : vid === "set-view" ? SET_ITEMS : null;
  if (!items) return;
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
  const vid = currentViewId();
  if (vid === "cfg-view") {
    saveEnv();
    return;
  }
  if (vid === "theme-view") {
    /* 클릭으로 적용 */ return;
  }
  if (vid === "review-view") {
    document.getElementById("runReview").click();
    return;
  }
  if (vid === "repo-cfg-view") {
    document.getElementById("saveRepos").click();
    return;
  }
  execItem(curIdx);
}

/* ─────────────────────────────────────
   휠 드래그
───────────────────────────────────── */
(function () {
  const w = document.getElementById("wheel");
  let startA = null;
  const angle = (e) => {
    const r = w.getBoundingClientRect(),
      t = e.touches ? e.touches[0] : e;
    return (
      Math.atan2(
        t.clientY - (r.top + r.height / 2),
        t.clientX - (r.left + r.width / 2),
      ) *
      (180 / Math.PI)
    );
  };
  const onStart = (e) => {
    if (!e.target.closest(".wsec,.center-btn")) {
      startA = angle(e);
      e.preventDefault();
    }
  };
  const onMove = (e) => {
    if (startA === null) return;
    e.preventDefault();
    const a = angle(e);
    let d = a - startA;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    if (Math.abs(d) > 22) {
      nav(d > 0 ? "down" : "up");
      startA = a;
    }
  };
  const onEnd = () => {
    startA = null;
  };
  w.addEventListener("mousedown", onStart);
  w.addEventListener("mousemove", onMove);
  w.addEventListener("mouseup", onEnd);
  w.addEventListener("touchstart", onStart, { passive: false });
  w.addEventListener("touchmove", onMove, { passive: false });
  w.addEventListener("touchend", onEnd);
})();

/* ─────────────────────────────────────
   클릭 이벤트
───────────────────────────────────── */
document.getElementById("mlist").addEventListener("click", (e) => {
  const item = e.target.closest(".mitem");
  if (!item) return;
  const idx = parseInt(item.dataset.idx, 10);
  curIdx = idx;
  renderCurrentMenu();
  execItem(idx);
});
document.getElementById("set-mlist").addEventListener("click", (e) => {
  const item = e.target.closest(".mitem");
  if (!item) return;
  const idx = parseInt(item.dataset.idx, 10);
  curIdx = idx;
  renderCurrentMenu();
  execItem(idx);
});
document.getElementById("theme-list").addEventListener("click", (e) => {
  const item = e.target.closest(".theme-item");
  if (!item) return;
  execThemeItem(item.dataset.theme);
});

document.getElementById("btn-up").addEventListener("click", () => nav("up"));
document
  .getElementById("btn-down")
  .addEventListener("click", () => nav("down"));
document
  .getElementById("btn-back")
  .addEventListener("click", () => nav("back"));
document
  .getElementById("btn-auto")
  .addEventListener("click", () => nav("auto"));
document
  .getElementById("btn-center")
  .addEventListener("click", () => doSelect());
document
  .getElementById("min")
  .addEventListener("click", () => window.api?.minimize());
document
  .getElementById("close")
  .addEventListener("click", () => window.api?.close());

/* ─────────────────────────────────────
   ENV 저장 / 로드
───────────────────────────────────── */
async function saveEnv() {
  const data = {};
  Object.entries(envMap).forEach(([id, key]) => {
    const el = document.getElementById(id);
    data[key] = el?.value || "";
  });
  await window.api?.saveEnv(data);
  popView();
}
document.getElementById("saveEnv").addEventListener("click", saveEnv);

async function loadEnv() {
  const env = await window.api?.loadEnv();
  if (!env) return;
  Object.entries(envMap).forEach(([id, key]) => {
    const el = document.getElementById(id);
    if (el && env[key]) el.value = env[key];
  });
}

/* ─────────────────────────────────────
   초기화
───────────────────────────────────── */
window.addEventListener("DOMContentLoaded", async () => {
  applyView("menu-view", "NotionFlow");
  document.getElementById("menu-view").classList.add("show");
  renderCurrentMenu();
  updateAutoBadge();
  await loadEnv();

  // 저장소 설정 로드
  repoConfigs = (await window.api?.loadRepoConfigs()) || [];

  if (autoOn) window.api?.autoSync();
});
