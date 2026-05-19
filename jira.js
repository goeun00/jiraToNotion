require("dotenv").config();

const { JIRA_BASE_URL, JIRA_PAT, JIRA_EMAIL } = process.env;

const SYNC_JQL =
  "(assignee = currentUser() OR watcher = currentUser()) AND " +
  "(statusCategory != Done OR (statusCategory = Done AND created >= -60d)) " +
  "ORDER BY updated DESC";

const DEFAULT_WORKLOG_FETCH_CONCURRENCY = 5;

const REPORT_FIELD_NAMES = {
  targetStart: "Target start",
  targetEnd: "Target end",
  expectedDeliveryDate: "Expected Delivery Date",
  epicLink: "Epic Link",
};

let cachedReportFieldIds = null;

/* --------------------
   Base Helpers
-------------------- */
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

function getSearchUrl(jiraBase, jql, fields, maxResults = 100, startAt = 0) {
  const v = apiVersion(jiraBase);

  if (isJiraCloud(jiraBase)) {
    const params = new URLSearchParams({
      jql,
      fields,
      maxResults: String(maxResults),
    });

    return `${jiraBase}/rest/api/${v}/search/jql?${params.toString()}`;
  }

  const params = new URLSearchParams({
    jql,
    fields,
    startAt: String(startAt),
    maxResults: String(maxResults),
  });

  return `${jiraBase}/rest/api/${v}/search?${params.toString()}`;
}

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
    const text = await res.text();
    throw new Error(`Jira API error ${res.status}: ${text}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function fetchAllIssues(
  jiraBase,
  headers,
  jql,
  fields,
  maxResults = 100,
) {
  const issues = [];

  if (isJiraCloud(jiraBase)) {
    let nextPageToken = "";

    while (true) {
      const baseUrl = getSearchUrl(jiraBase, jql, fields, maxResults);
      const url = nextPageToken
        ? `${baseUrl}&nextPageToken=${encodeURIComponent(nextPageToken)}`
        : baseUrl;

      const res = await fetch(url, { headers });

      if (!res.ok) {
        throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
      }

      const data = await res.json();
      const pageIssues = data.issues || [];

      issues.push(...pageIssues);

      if (!pageIssues.length || !data.nextPageToken) break;

      nextPageToken = data.nextPageToken;
    }

    return issues;
  }

  let startAt = 0;

  while (true) {
    const url = getSearchUrl(jiraBase, jql, fields, maxResults, startAt);
    const res = await fetch(url, { headers });

    if (!res.ok) {
      throw new Error(`Jira API error ${res.status}: ${await res.text()}`);
    }

    const data = await res.json();
    const pageIssues = data.issues || [];

    issues.push(...pageIssues);

    startAt += pageIssues.length;

    if (!pageIssues.length || startAt >= Number(data.total || 0)) break;
  }

  return issues;
}

/* --------------------
   Small Helpers
-------------------- */

function cleanName(name = "") {
  return String(name || "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim();
}

function getMonthRange(monthOffset = 0) {
  const now = new Date();
  const offset = Number(monthOffset || 0);

  const start = new Date(
    now.getFullYear(),
    now.getMonth() + offset,
    1,
    0,
    0,
    0,
    0,
  );

  const end = new Date(
    now.getFullYear(),
    now.getMonth() + offset + 1,
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

function getWorklogFetchConcurrency() {
  const value = Number(process.env.WORKLOG_FETCH_CONCURRENCY);
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_WORKLOG_FETCH_CONCURRENCY;
}

/* --------------------
   p-limit
-------------------- */

async function getPLimit() {
  const mod = await import("p-limit");
  return mod.default || mod;
}

/* --------------------
   Report Custom Fields
-------------------- */

function normalizeFieldName(name = "") {
  return String(name || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function findFieldIdByNames(fields = [], names = []) {
  const normalizedNames = names.map(normalizeFieldName);

  const matched = fields.find((field) =>
    normalizedNames.includes(normalizeFieldName(field.name)),
  );

  return matched?.id || "";
}

function normalizeDateValue(value) {
  if (!value) return "";

  if (typeof value === "string") {
    return value.slice(0, 10);
  }

  if (value.start) {
    return String(value.start).slice(0, 10);
  }

  if (value.startDate) {
    return String(value.startDate).slice(0, 10);
  }

  if (value.date) {
    return String(value.date).slice(0, 10);
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
  if (cachedReportFieldIds) return cachedReportFieldIds;

  const envIds = {
    targetStart: process.env.JIRA_FIELD_TARGET_START || "",
    targetEnd: process.env.JIRA_FIELD_TARGET_END || "",
    expectedDeliveryDate: process.env.JIRA_FIELD_EXPECTED_DELIVERY || "",
    epicLink: process.env.JIRA_FIELD_EPIC_LINK || "",
  };

  const ids = {
    targetStart: "",
    targetEnd: "",
    expectedDeliveryDate: "",
    epicLink: "",
  };

  const v = apiVersion(jiraBase);

  try {
    const res = await fetch(`${jiraBase}/rest/api/${v}/field`, { headers });

    if (!res.ok) {
      cachedReportFieldIds = envIds;
      return cachedReportFieldIds;
    }

    const fields = await res.json();
    const epicCandidates = (fields || [])
      .filter((field) =>
        /epic|상위|상위 항목|상위 이슈/i.test(field.name || ""),
      )
      .map((field) => `${field.id} : ${field.name}`);

    console.log(
      "[Jira epic field candidates]\n" +
        (epicCandidates.length ? epicCandidates.join("\n") : "(none)"),
    );
    const fieldIdSet = new Set((fields || []).map((field) => field.id));

    const candidates = (fields || [])
      .filter((field) =>
        /target|start|delivery|expected|end|epic/i.test(field.name || ""),
      )
      .map((field) => `${field.id} : ${field.name}`);

    if (candidates.length) {
      console.log("[Jira report field candidates]\n" + candidates.join("\n"));
    }

    for (const key of Object.keys(ids)) {
      const envId = envIds[key];
      if (envId && fieldIdSet.has(envId)) {
        ids[key] = envId;
        continue;
      }
      ids[key] = findFieldIdByNames(fields, [REPORT_FIELD_NAMES[key]]);

      if (envId && !fieldIdSet.has(envId)) {
        console.warn(
          `[Jira report fields] ignored invalid env field id: ${key}=${envId}`,
        );
      }
    }
    console.log("[Jira selected report field ids]", ids);
  } catch (error) {
    console.warn("[Jira report fields] failed to detect fields", error);
    cachedReportFieldIds = envIds;
    return cachedReportFieldIds;
  }
  cachedReportFieldIds = ids;
  return ids;
}

function getReportFields(reportFieldIds = {}) {
  return [
    reportFieldIds.targetStart,
    reportFieldIds.targetEnd,
    reportFieldIds.expectedDeliveryDate,
    reportFieldIds.epicLink,
  ]
    .filter(Boolean)
    .join(",");
}

function mapReportDates(fields = {}, reportFieldIds = {}) {
  return {
    targetStart: normalizeDateValue(fields?.[reportFieldIds.targetStart]),
    targetEnd: normalizeDateValue(fields?.[reportFieldIds.targetEnd]),
    expectedDeliveryDate: normalizeDateValue(
      fields?.[reportFieldIds.expectedDeliveryDate],
    ),
  };
}

/* --------------------
   Issue Mapper
-------------------- */

function mapIssue(jiraBase, issue, reportFieldIds = {}) {
  const fields = issue.fields || {};

  const epicLink = reportFieldIds.epicLink
    ? fields[reportFieldIds.epicLink] || ""
    : "";

  return {
    key: issue.key,
    issueKey: issue.key,
    summary: fields.summary || "",
    description: fields.description || "",
    status: fields.status?.name || "",
    statusCategory:
      fields.status?.statusCategory?.key ||
      fields.status?.statusCategory?.name ||
      "new",
    issueType: fields.issuetype?.name || "Task",
    updated: fields.updated || "",
    created: fields.created || "",
    reporter: cleanName(
      fields.reporter?.displayName || fields.reporter?.name || "",
    ),
    assignee: cleanName(
      fields.assignee?.displayName || fields.assignee?.name || "",
    ),
    components: fields.components || [],
    epicLink,

    aggregatetimespent: Number(fields.aggregatetimespent || 0),
    aggregateTimeOriginalEstimate: Number(
      fields.aggregatetimeoriginalestimate || fields.timeoriginalestimate || 0,
    ),
    worklogs: fields.worklog?.worklogs || [],

    url: `${jiraBase}/browse/${issue.key}`,
    ...mapReportDates(fields, reportFieldIds),
  };
}

/* --------------------
   Issues
-------------------- */
async function fetchIssues() {
  const jiraBase = normalizeJiraBase(JIRA_BASE_URL);
  const headers = getJiraHeaders(jiraBase, JIRA_PAT, JIRA_EMAIL);

  const reportFieldIds = await getReportFieldIds(jiraBase, headers);
  const reportFields = getReportFields(reportFieldIds);

  const fields = [
    "summary,status,updated,created,reporter,assignee,aggregatetimespent,aggregatetimeoriginalestimate,timeoriginalestimate,worklog,description,issuetype,components",
    reportFields,
  ]
    .filter(Boolean)
    .join(",");

  const issues = await fetchAllIssues(jiraBase, headers, SYNC_JQL, fields, 100);

  const mappedIssues = issues.map((issue) =>
    mapIssue(jiraBase, issue, reportFieldIds),
  );

  const epicKeys = [
    ...new Set(mappedIssues.map((issue) => issue.epicLink).filter(Boolean)),
  ];

  const epicSummaryMap = await fetchEpicSummaryMap(jiraBase, headers, epicKeys);

  return mappedIssues.map((issue) => ({
    ...issue,
    epicName: epicSummaryMap.get(issue.epicLink) || "",
  }));
}

async function fetchMyIssues(baseUrl, pat, doneDays = 60, email = "") {
  const jiraBase = normalizeJiraBase(baseUrl);
  const headers = getJiraHeaders(jiraBase, pat, email);
  const v = apiVersion(jiraBase);

  let login = "";
  let initials = "JR";

  try {
    const meRes = await fetch(`${jiraBase}/rest/api/${v}/myself`, { headers });

    if (meRes.ok) {
      const me = await meRes.json();

      login = me.displayName || me.name || "";
      initials = login
        ? login
            .split(" ")
            .map((word) => word[0])
            .join("")
            .slice(0, 2)
            .toUpperCase()
        : "JR";
    }
  } catch {}

  const jql =
    `(assignee = currentUser() OR watcher = currentUser()) AND ` +
    `(statusCategory != Done OR (statusCategory = Done AND updated >= -${doneDays}d)) ` +
    `ORDER BY updated DESC`;

  const reportFieldIds = await getReportFieldIds(jiraBase, headers);
  const reportFields = getReportFields(reportFieldIds);

  const fields = [
    "summary,status,updated,created,issuetype,reporter,assignee,components",
    reportFields,
  ]
    .filter(Boolean)
    .join(",");

  const issues = await fetchAllIssues(jiraBase, headers, jql, fields, 100);

  return {
    login,
    initials,
    issues: issues.map((issue) => mapIssue(jiraBase, issue, reportFieldIds)),
  };
}

async function fetchIssuesByKeys(baseUrl, pat, keys, email = "") {
  const jiraBase = normalizeJiraBase(baseUrl);
  const headers = getJiraHeaders(jiraBase, pat, email);

  if (!Array.isArray(keys) || !keys.length) {
    return { issues: [] };
  }

  const safeKeys = keys.map((key) => String(key || "").trim()).filter(Boolean);

  if (!safeKeys.length) {
    return { issues: [] };
  }

  const jql = `key in (${safeKeys.join(",")}) ORDER BY updated DESC`;

  const reportFieldIds = await getReportFieldIds(jiraBase, headers);
  const reportFields = getReportFields(reportFieldIds);

  const fields = [
    "summary,status,updated,created,issuetype,reporter,assignee,components",
    reportFields,
  ]
    .filter(Boolean)
    .join(",");

  const issues = await fetchAllIssues(jiraBase, headers, jql, fields, 50);

  return {
    issues: issues.map((issue) => mapIssue(jiraBase, issue, reportFieldIds)),
  };
}

async function fetchEpicSummaryMap(jiraBase, headers, epicKeys = []) {
  if (!epicKeys.length) return new Map();

  const quotedKeys = epicKeys.map((key) => `"${key}"`).join(",");
  const jql = `key in (${quotedKeys})`;

  const epics = await fetchAllIssues(jiraBase, headers, jql, "summary", 100);

  return new Map(epics.map((epic) => [epic.key, epic.fields?.summary || ""]));
}
/* --------------------
   Worklogs
-------------------- */

async function fetchWorklogPages(
  jiraBase,
  headers,
  issueKey,
  startedAfter,
  startedBefore,
) {
  const v = apiVersion(jiraBase);
  const all = [];
  let startAt = 0;

  while (true) {
    const worklogUrl =
      `${jiraBase}/rest/api/${v}/issue/${issueKey}/worklog` +
      `?startedAfter=${startedAfter}` +
      `&startedBefore=${startedBefore}` +
      `&startAt=${startAt}` +
      `&maxResults=100`;

    const worklogRes = await fetch(worklogUrl, { headers });

    if (!worklogRes.ok) {
      console.warn(
        `[Jira worklog] failed ${issueKey}: ${worklogRes.status} ${await worklogRes.text()}`,
      );
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
  return fetchAllIssues(jiraBase, headers, jql, searchFields, 100);
}

async function fetchMyWorklogs(
  baseUrl = JIRA_BASE_URL,
  pat = JIRA_PAT,
  monthOffset = 0,
  email = JIRA_EMAIL,
) {
  const jiraBase = normalizeJiraBase(baseUrl);
  const headers = getJiraHeaders(jiraBase, pat, email);
  const v = apiVersion(jiraBase);

  const meRes = await fetch(`${jiraBase}/rest/api/${v}/myself`, { headers });

  if (!meRes.ok) {
    throw new Error(
      `Jira myself API error ${meRes.status}: ${await meRes.text()}`,
    );
  }

  const me = await meRes.json();
  const { start, end } = getMonthRange(monthOffset);

  const startedAfter = start.getTime() - 1;
  const startedBefore = end.getTime();

  const jql =
    `worklogAuthor = currentUser() ` +
    `AND worklogDate >= "${formatJiraDate(start)}" ` +
    `AND worklogDate < "${formatJiraDate(end)}" ` +
    `ORDER BY updated DESC`;

  const reportFieldIds = await getReportFieldIds(jiraBase, headers);
  const reportFields = getReportFields(reportFieldIds);

  const searchFields = [
    "summary,status,updated,created,issuetype,reporter,assignee,components",
    reportFields,
  ]
    .filter(Boolean)
    .join(",");

  const issues = await fetchWorklogIssues(jiraBase, headers, jql, searchFields);

  const pLimit = await getPLimit();
  const limit = pLimit(getWorklogFetchConcurrency());

  const logGroups = await Promise.all(
    issues.map((issue) =>
      limit(async () => {
        const issueInfo = mapIssue(jiraBase, issue, reportFieldIds);

        const worklogs = await fetchWorklogPages(
          jiraBase,
          headers,
          issue.key,
          startedAfter,
          startedBefore,
        );

        const issueLogs = [];

        for (const log of worklogs) {
          if (!isSameUserWorklog(log, me)) continue;
          if (!isStartedInRange(log.started, start, end)) continue;

          const seconds = Number(log.timeSpentSeconds || 0);

          if (seconds <= 0) continue;

          issueLogs.push({
            ...issueInfo,
            started: log.started,
            timeSpent: log.timeSpent,
            timeSpentSeconds: seconds,
            worklogId: log.id || "",
          });
        }

        return issueLogs;
      }),
    ),
  );

  const logs = logGroups.flat();

  logs.sort((a, b) => new Date(b.started || 0) - new Date(a.started || 0));

  const totalSeconds = logs.reduce(
    (sum, log) => sum + Number(log.timeSpentSeconds || 0),
    0,
  );

  const issueMap = new Map();

  for (const log of logs) {
    if (!issueMap.has(log.issueKey)) {
      const { started, timeSpent, timeSpentSeconds, worklogId, ...issueInfo } =
        log;

      issueMap.set(log.issueKey, issueInfo);
    }
  }

  const issuesFromLogs = [...issueMap.values()];

  return {
    month: `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}`,
    label: `${start.getFullYear()}.${String(start.getMonth() + 1).padStart(2, "0")}`,
    range: {
      start: formatJiraDate(start),
      end: formatJiraDate(end),
    },
    totalSeconds,
    loggedDays: totalSeconds / 28800,
    logs,
    issues: issuesFromLogs,
  };
}

module.exports = {
  fetchIssues,
  fetchMyIssues,
  fetchIssuesByKeys,
  fetchMyWorklogs,
};
