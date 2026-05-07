require("dotenv").config();

const { JIRA_BASE_URL, JIRA_PAT, JIRA_EMAIL } = process.env;

const JQL =
  "(assignee = currentUser() OR watcher = currentUser()) AND (statusCategory != Done OR (statusCategory = Done AND created >= -60d)) ORDER BY updated DESC";

const DEFAULT_WORKLOG_FETCH_CONCURRENCY = 5;

// -------------------- Common Helpers --------------------

function normalizeJiraBase(baseUrl = JIRA_BASE_URL) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

function getJiraHeaders(
  baseUrl = JIRA_BASE_URL,
  pat = JIRA_PAT,
  email = JIRA_EMAIL,
) {
  const jiraBase = normalizeJiraBase(baseUrl);
  const token = String(pat || "").trim();
  const userEmail = String(email || "").trim();

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };

  // Atlassian Cloud는 email + api token Basic 인증이 필요할 수 있고,
  // 사내 Jira PAT는 Bearer 인증을 쓰는 경우가 많아서 둘 다 지원한다.
  if (userEmail && token && /atlassian\.net/i.test(jiraBase)) {
    headers.Authorization = `Basic ${Buffer.from(`${userEmail}:${token}`).toString("base64")}`;
  } else if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function getMonthRange(monthOffset = 0) {
  const now = new Date();
  const start = new Date(
    now.getFullYear(),
    now.getMonth() + Number(monthOffset || 0),
    1,
    0,
    0,
    0,
    0,
  );
  const end = new Date(
    now.getFullYear(),
    now.getMonth() + Number(monthOffset || 0) + 1,
    1,
    0,
    0,
    0,
    0,
  );

  return { start, end };
}

function formatJiraDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function getSearchUrl(jiraBase, jql, fields, maxResults = 100, startAt = 0) {
  const params = new URLSearchParams({
    jql,
    fields,
    startAt: String(startAt),
    maxResults: String(maxResults),
  });

  return `${jiraBase}/rest/api/2/search?${params.toString()}`;
}

function cleanName(name = "") {
  return String(name || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

function isSameUserWorklog(log, me) {
  const author = log.author || {};
  const meId = me.accountId || me.name || me.key || "";

  if (!meId) return true;

  return [author.accountId, author.name, author.key]
    .filter(Boolean)
    .some((id) => String(id) === String(meId));
}

function isStartedInRange(started, start, end) {
  if (!started) return false;

  const startedTime = Date.parse(started);
  if (Number.isNaN(startedTime)) return false;

  return startedTime >= start.getTime() && startedTime < end.getTime();
}

async function getPLimit() {
  const mod = await import("p-limit");
  return mod.default;
}

function getWorklogFetchConcurrency() {
  const value = Number(process.env.WORKLOG_FETCH_CONCURRENCY);
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_WORKLOG_FETCH_CONCURRENCY;
}

// -------------------- Jira Fetch --------------------

async function jiraFetch(path, options = {}) {
  const jiraBase = normalizeJiraBase(options.baseUrl || JIRA_BASE_URL);
  const headers =
    options.headers ||
    getJiraHeaders(
      jiraBase,
      options.pat || JIRA_PAT,
      options.email || JIRA_EMAIL,
    );

  const res = await fetch(`${jiraBase}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jira API error ${res.status}: ${txt}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// -------------------- Report Custom Fields --------------------

function includesAny(text, keywords) {
  const source = String(text || "").toLowerCase();
  return keywords.some((keyword) =>
    source.includes(String(keyword).toLowerCase()),
  );
}

function normalizeDateValue(value) {
  if (!value) return "";

  if (typeof value === "string") {
    return value.slice(0, 10);
  }

  if (value.start) {
    return String(value.start).slice(0, 10);
  }

  if (value.value) {
    return String(value.value).slice(0, 10);
  }

  if (value.name) {
    return String(value.name).slice(0, 10);
  }

  return "";
}

async function getReportFieldIds(jiraBase, headers) {
  const ids = {
    targetStart: process.env.JIRA_FIELD_TARGET_START || "",
    targetEnd: process.env.JIRA_FIELD_TARGET_END || "",
    expectedDeliveryDate: process.env.JIRA_FIELD_EXPECTED_DELIVERY || "",
  };

  // .env에 고정값이 있으면 그것을 최우선으로 사용한다.
  // 일부만 비어 있으면 아래 자동 탐색으로 빈 값만 채운다.
  const res = await fetch(`${jiraBase}/rest/api/2/field`, { headers });

  if (!res.ok) {
    return ids;
  }

  const fields = await res.json();

  // Target start가 계속 비면, 이 로그에서 customfield_xxxxx를 확인해서 .env에 고정하는 것이 가장 안전하다.
  const matchedFields = fields
    .filter((field) =>
      /target|start|시작|업무|delivery|mark|end|종료|납기|전달/i.test(
        field.name || "",
      ),
    )
    .map((field) => `${field.id} : ${field.name}`);

  if (matchedFields.length) {
    console.log("[Jira report fields candidates]\n" + matchedFields.join("\n"));
  }

  for (const field of fields) {
    const name = String(field.name || "");

    if (
      !ids.targetStart &&
      (includesAny(name, [
        "target start",
        "target_start",
        "targetstart",
        "start date",
        "target start date",
        "업무 시작",
        "업무시작",
        "업무 시작일",
        "시작일",
        "시작 예정일",
      ]) ||
        /target\s*start/i.test(name) ||
        /start\s*date/i.test(name))
    ) {
      ids.targetStart = field.id;
    }

    if (
      !ids.targetEnd &&
      (includesAny(name, [
        "target end",
        "target_end",
        "targetend",
        "end date",
        "target end date",
        "업무 종료",
        "업무종료",
        "업무 종료일",
        "종료일",
        "종료 예정일",
      ]) ||
        /target\s*end/i.test(name) ||
        /end\s*date/i.test(name))
    ) {
      ids.targetEnd = field.id;
    }

    if (
      !ids.expectedDeliveryDate &&
      (includesAny(name, [
        "mark up delivery",
        "markup delivery",
        "delivery",
        "expected delivery",
        "expected delivery date",
        "납기",
        "전달일",
        "마크업 전달",
        "마크업 딜리버리",
      ]) ||
        /mark\s*up\s*delivery/i.test(name))
    ) {
      ids.expectedDeliveryDate = field.id;
    }
  }

  console.log("[Jira selected report field ids]", ids);

  return ids;
}

function getReportFields(reportFieldIds = {}) {
  return [
    reportFieldIds.targetStart,
    reportFieldIds.targetEnd,
    reportFieldIds.expectedDeliveryDate,
  ]
    .filter(Boolean)
    .join(",");
}

function mapReportDates(fields = {}, reportFieldIds = {}) {
  return {
    targetStart: normalizeDateValue(fields[reportFieldIds.targetStart]),
    targetEnd: normalizeDateValue(fields[reportFieldIds.targetEnd]),
    expectedDeliveryDate: normalizeDateValue(
      fields[reportFieldIds.expectedDeliveryDate],
    ),
  };
}

// -------------------- Issues --------------------

async function fetchIssues() {
  const fields =
    "summary,status,updated,created,reporter,assignee,aggregatetimespent,worklog,description,issuetype,components";
  const pageSize = 1000;
  let startAt = 0;
  const all = [];

  while (true) {
    const url = `/rest/api/2/search?jql=${encodeURIComponent(JQL)}&fields=${fields}&startAt=${startAt}&maxResults=${pageSize}`;
    const data = await jiraFetch(url);
    const issues = data.issues || [];

    all.push(...issues);

    const total = Number(data.total || 0);
    startAt += issues.length;

    if (issues.length === 0 || startAt >= total) break;
  }

  return all;
}

// -------------------- Worklogs --------------------

async function fetchWorklogPages(
  jiraBase,
  headers,
  issueKey,
  startedAfter,
  startedBefore,
) {
  const all = [];
  let startAt = 0;

  while (true) {
    const worklogUrl =
      `${jiraBase}/rest/api/2/issue/${issueKey}/worklog` +
      `?startedAfter=${startedAfter}&startedBefore=${startedBefore}&startAt=${startAt}&maxResults=100`;

    const worklogRes = await fetch(worklogUrl, { headers });

    if (!worklogRes.ok) {
      return all;
    }

    const worklogData = await worklogRes.json();
    const worklogs = worklogData.worklogs || [];

    all.push(...worklogs);

    startAt += worklogs.length;

    if (worklogs.length === 0 || startAt >= Number(worklogData.total || 0)) {
      break;
    }
  }

  return all;
}

async function fetchWorklogIssues(jiraBase, headers, jql, searchFields) {
  const issues = [];
  let startAt = 0;
  const pageSize = 100;

  while (true) {
    const issueRes = await fetch(
      getSearchUrl(jiraBase, jql, searchFields, pageSize, startAt),
      { headers },
    );

    if (!issueRes.ok) {
      throw new Error(await issueRes.text());
    }

    const issueData = await issueRes.json();
    const pageIssues = issueData.issues || [];

    issues.push(...pageIssues);

    startAt += pageIssues.length;

    if (pageIssues.length === 0 || startAt >= Number(issueData.total || 0)) {
      break;
    }
  }

  return issues;
}

async function fetchMyWorklogs(
  baseUrl = JIRA_BASE_URL,
  pat = JIRA_PAT,
  monthOffset = 0,
  email = JIRA_EMAIL,
) {
  const jiraBase = normalizeJiraBase(baseUrl);
  const headers = getJiraHeaders(jiraBase, pat, email);

  const meRes = await fetch(`${jiraBase}/rest/api/2/myself`, { headers });

  if (!meRes.ok) {
    throw new Error(
      `Jira myself API error ${meRes.status}: ${await meRes.text()}`,
    );
  }

  const me = await meRes.json();
  const { start, end } = getMonthRange(monthOffset);

  // Jira worklog endpoint의 startedAfter/startedBefore는 Date Started 기준이다.
  // startedAfter는 exclusive처럼 동작할 수 있어서 시작 ms - 1로 준다.
  const startedAfter = start.getTime() - 1;
  const startedBefore = end.getTime();

  // 후보 이슈는 JQL worklogDate로 월 범위를 좁힌다.
  // 실제 포함 여부는 아래 isStartedInRange(log.started)에서 Date Started로 최종 판단한다.
  const jql =
    `worklogAuthor = currentUser() ` +
    `AND worklogDate >= "${formatJiraDate(start)}" ` +
    `AND worklogDate < "${formatJiraDate(end)}" ` +
    `ORDER BY updated DESC`;

  const reportFieldIds = await getReportFieldIds(jiraBase, headers);
  const reportFields = getReportFields(reportFieldIds);

  const searchFields = [
    "summary,status,updated,issuetype,reporter,assignee,components",
    reportFields,
  ]
    .filter(Boolean)
    .join(",");

  const issues = await fetchWorklogIssues(jiraBase, headers, jql, searchFields);
  const pLimit = await getPLimit();
  const limit = pLimit(getWorklogFetchConcurrency());

  let totalSeconds = 0;
  const logs = [];

  await Promise.all(
    issues.map((issue) =>
      limit(async () => {
        const worklogs = await fetchWorklogPages(
          jiraBase,
          headers,
          issue.key,
          startedAfter,
          startedBefore,
        );

        for (const log of worklogs) {
          if (!isSameUserWorklog(log, me)) continue;

          // 최종 필터는 오직 worklog의 Date Started(log.started) 기준이다.
          // log.updated / issue.updated는 포함 여부에 사용하지 않는다.
          if (!isStartedInRange(log.started, start, end)) continue;

          const seconds = Number(log.timeSpentSeconds || 0);

          if (seconds <= 0) continue;

          totalSeconds += seconds;

          logs.push({
            issueKey: issue.key,
            summary: issue.fields?.summary || "",
            reporter: cleanName(
              issue.fields?.reporter?.displayName ||
                issue.fields?.reporter?.name ||
                "",
            ),
            assignee: cleanName(
              issue.fields?.assignee?.displayName ||
                issue.fields?.assignee?.name ||
                "",
            ),
            issueType: issue.fields?.issuetype?.name || "",
            status: issue.fields?.status?.name || "",
            statusCategory: issue.fields?.status?.statusCategory?.name || "",
            components: issue.fields?.components || [],
            url: `${jiraBase}/browse/${issue.key}`,
            started: log.started,
            timeSpent: log.timeSpent,
            timeSpentSeconds: seconds,
            ...mapReportDates(issue.fields, reportFieldIds),
          });
        }
      }),
    ),
  );

  logs.sort((a, b) => new Date(b.started || 0) - new Date(a.started || 0));

  return {
    month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
    label: `${start.getFullYear()}.${String(start.getMonth() + 1).padStart(2, "0")}`,
    totalSeconds,
    loggedDays: totalSeconds / 28800,
    logs,
  };
}

module.exports = {
  fetchIssues,
  fetchMyWorklogs,
};
