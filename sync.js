const path = require("path");
require("dotenv").config({
  path: path.resolve(__dirname, ".env"),
});

const { fetchIssues } = require("./jira");
const {
  getAllNotionPagesMap,
  createPage,
  updatePage,
  deletePage,
  getAllGitPRMap,
  createPRPage,
  updatePRPage,
} = require("./notion");
const { fetchPRs, fetchPRFiles } = require("./github");

const { JIRA_BASE_URL, JIRA_PAT, JIRA_EMAIL } = process.env;

// -------------------- Helper --------------------

function toMinuteEpoch(date) {
  if (!date) return null;
  return Math.floor(Date.parse(date) / 60000);
}

function toDay(date) {
  if (!date) return "";
  return String(date).slice(0, 10);
}

function toLoggedDays(seconds) {
  return Math.round((Number(seconds || 0) / 28800) * 1000) / 1000;
}

function getNotionDateStart(prop) {
  return prop?.date?.start ? String(prop.date.start).slice(0, 10) : "";
}

function getNotionNumber(prop) {
  return Number(prop?.number || 0);
}

function isDifferentNumber(a, b) {
  return Math.abs(Number(a || 0) - Number(b || 0)) > 0.0005;
}

function normalizeJiraBase(baseUrl = JIRA_BASE_URL) {
  return String(baseUrl || "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/rest\/api\/2$/, "")
    .replace(/\/rest\/api\/3$/, "");
}

function isJiraCloud(baseUrl = "") {
  return normalizeJiraBase(baseUrl).includes(".atlassian.net");
}

function apiVersion(jiraBase) {
  return isJiraCloud(jiraBase) ? "3" : "2";
}

function getJiraHeaders(
  baseUrl = JIRA_BASE_URL,
  pat = JIRA_PAT,
  email = JIRA_EMAIL,
) {
  const jiraBase = normalizeJiraBase(baseUrl);
  const token = String(pat || "").trim();
  const userEmail = String(email || "").trim();
  const isCloud = isJiraCloud(jiraBase);

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  if (isCloud && userEmail && token) {
    headers.Authorization = `Basic ${Buffer.from(`${userEmail}:${token}`).toString("base64")}`;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

async function fetchAllWorklogsForIssue(issueKey) {
  const jiraBase = normalizeJiraBase(JIRA_BASE_URL);
  const headers = getJiraHeaders(jiraBase, JIRA_PAT, JIRA_EMAIL);
  const v = apiVersion(jiraBase);
  const all = [];
  let startAt = 0;

  while (true) {
    const url =
      `${jiraBase}/rest/api/${v}/issue/${issueKey}/worklog` +
      `?startAt=${startAt}&maxResults=100`;

    const res = await fetch(url, { headers });

    if (!res.ok) {
      console.warn(
        `[Jira worklog] failed ${issueKey}: ${res.status} ${await res.text()}`,
      );
      return all;
    }

    const data = await res.json();
    const worklogs = data.worklogs || [];
    all.push(...worklogs);

    startAt += worklogs.length;

    if (!worklogs.length || startAt >= Number(data.total || 0)) break;
  }

  return all;
}

function getLastLogDateFromWorklogs(worklogs = []) {
  return worklogs
    .map((log) => log.started || log.updated || log.created)
    .filter(Boolean)
    .map(toDay)
    .sort()
    .at(-1) || "";
}

async function hydrateIssuesForNotion(issues = []) {
  const pLimit = (await import("p-limit")).default;
  const limit = pLimit(Number(process.env.WORKLOG_FETCH_CONCURRENCY || 5));

  return Promise.all(
    issues.map((issue) =>
      limit(async () => {
        const worklogSeconds = Number(issue.aggregatetimespent || 0);

        // 노션은 월 기준이 아니므로 startedAfter/startedBefore를 절대 넣지 않는다.
        // Jira search의 fields.worklog는 일부만 내려올 수 있어서, worklog API로 전체 페이지를 다시 읽는다.
        const allWorklogs = worklogSeconds > 0
          ? await fetchAllWorklogsForIssue(issue.key)
          : [];

        return {
          ...issue,
          __worklogSeconds: worklogSeconds,
          logDate: getLastLogDateFromWorklogs(allWorklogs),
        };
      }),
    ),
  );
}

function shouldUpdateJiraPage(page, issue) {
  const props = page.properties || {};
  const notionUpdated = props.Updated?.date?.start;
  const jiraUpdated = issue.updated || issue.fields?.updated;

  const nextLogged = toLoggedDays(issue.__worklogSeconds);
  const notionLogged = getNotionNumber(props.Logged);

  const nextLogDate = issue.logDate || "";
  const notionLogDate = getNotionDateStart(props["Log Dates"]);

  return (
    toMinuteEpoch(notionUpdated) !== toMinuteEpoch(jiraUpdated) ||
    isDifferentNumber(notionLogged, nextLogged) ||
    notionLogDate !== nextLogDate
  );
}

async function syncGitPRs() {
  const start = Date.now();
  console.log(`starting GitHub PR sync...`);
  const pLimit = (await import("p-limit")).default;
  const myPRs = await fetchPRs();
  const existingPRs = await getAllGitPRMap();
  const limit = pLimit(3);

  await Promise.all(
    myPRs.map((pr) =>
      limit(async () => {
        const page = existingPRs.get(pr.html_url);
        const owner = pr.base.repo.owner.login;
        const repo = pr.base.repo.name;

        if (!page) {
          const files = await fetchPRFiles(owner, repo, pr.number);
          const createdPage = await createPRPage(pr, files);
          existingPRs.set(pr.html_url, createdPage);
          console.log(`+ created PR: ${pr.title}`);
          return;
        }

        const props = page.properties;
        const notionUpdated = props.LastUpdated?.date?.start;

        if (toMinuteEpoch(notionUpdated) !== toMinuteEpoch(pr.updated_at)) {
          await updatePRPage(page, pr);
        }
      }),
    ),
  );

  const end = Date.now();
  const elapsed = ((end - start) / 1000).toFixed(2);
  console.log(`Fetched ${myPRs.length} PRs`);
  console.log(`Elapsed time: ${elapsed}s`);
}

async function syncJiraIssues() {
  const start = Date.now();
  const pLimit = (await import("p-limit")).default;
  const notionLimit = pLimit(3);

  const issues = await fetchIssues();
  console.log(`Fetched ${issues.length} Jira issues for Notion`);

  const issuesForNotion = await hydrateIssuesForNotion(issues);
  const jiraKeys = new Set(issuesForNotion.map((issue) => issue.key));
  const existingPages = await getAllNotionPagesMap();

  let created = 0;
  let updated = 0;
  let deleted = 0;

  await Promise.all([
    ...issuesForNotion.map((issue) =>
      notionLimit(async () => {
        const page = existingPages.get(issue.key);

        if (!page) {
          await createPage(issue);
          created++;
          console.log(
            `+ created ${issue.key} logged=${toLoggedDays(issue.__worklogSeconds)} logDate=${issue.logDate || "-"}`,
          );
          return;
        }

        if (shouldUpdateJiraPage(page, issue)) {
          await updatePage(page.id, issue);
          updated++;
          console.log(
            `~ updated ${issue.key} logged=${toLoggedDays(issue.__worklogSeconds)} logDate=${issue.logDate || "-"}`,
          );
        }
      }),
    ),

    // fetchIssues()의 기존 JQL 기준에서 빠진 페이지는 기존 로직대로 archive한다.
    ...[...existingPages.entries()].map(([key, page]) =>
      notionLimit(async () => {
        if (!jiraKeys.has(key)) {
          await deletePage(page.id);
          deleted++;
          console.log(`- deleted ${key}`);
        }
      }),
    ),
  ]);

  const end = Date.now();
  const elapsed = ((end - start) / 1000).toFixed(2);
  console.log(`created=${created}, updated=${updated}, deleted=${deleted}`);
  console.log(`Elapsed time: ${elapsed}s`);
}

async function syncOnce() {
  await syncJiraIssues();
  await syncGitPRs();
}

let running = false;

async function autoSync(minutes = 3) {
  running = true;
  await syncOnce();

  while (running) {
    await new Promise((r) => setTimeout(r, minutes * 60 * 1000));
    if (!running) break;
    await syncOnce().catch(console.error);
  }
}

function stopAutoSync() {
  running = false;
}

module.exports = {
  syncOnce,
  syncJiraIssues,
  syncGitPRs,
  autoSync,
  stopAutoSync,
};
