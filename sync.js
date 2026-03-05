process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require("dotenv").config();

const { Client } = require("@notionhq/client");

const {
  JIRA_BASE_URL,
  JIRA_PAT,
  NOTION_TOKEN,
  NOTION_SOURCE_ID,
  JQL,
  POLL_MINUTES,
} = process.env;

// -------------------- Helper --------------------

function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
}

function toMinuteEpoch(date) {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return Math.floor(t / 60000); // 분 단위(UTC 기준)
}

// -------------------- Jira --------------------
async function jiraFetch(path, options = {}) {
  const res = await fetch(`${JIRA_BASE_URL}${path}`, {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${JIRA_PAT}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: options.body,
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Jira API error ${res.status}: ${txt}`);
  }

  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function fetchIssues() {
  const fields = [
    "summary",
    "status",
    "updated",
    "reporter",
    "aggregatetimespent",
    "worklog",
  ].join(",");
  const pageSize = 100;
  let startAt = 0;
  let all = [];

  while (true) {
    const url =
      `/rest/api/2/search?jql=${encodeURIComponent(JQL)}` +
      `&fields=${fields}&startAt=${startAt}&maxResults=${pageSize}`;

    const data = await jiraFetch(url);
    const issues = data.issues || [];
    all = all.concat(issues);

    const total = Number(data.total || 0);
    startAt += issues.length;

    if (issues.length === 0 || startAt >= total) break;
  }

  return all;
}

// -------------------- Notion --------------------
const notion = new Client({
  auth: NOTION_TOKEN,
});

async function findExistingNotionPages(NOTION_SOURCE_ID, issueKeys) {
  if (!issueKeys.length) return new Map();

  const pageMap = new Map();
  const chunks = chunkArray(issueKeys, 100);

  await Promise.all(
    chunks.map(async (chunk) => {
      const filter = {
        or: chunk.map((key) => ({
          property: "Key",
          rich_text: { equals: key },
        })),
      };

      const res = await notion.dataSources.query({
        data_source_id: NOTION_SOURCE_ID,
        filter,
      });

      for (const page of res.results || []) {
        const keyText = page.properties?.Key?.rich_text
          ?.map((t) => t.plain_text)
          .join("")
          .trim();

        if (keyText) pageMap.set(keyText, page);
      }
    }),
  );

  return pageMap;
}

function issueToProps(issue) {
  const key = issue.key;
  const fields = issue.fields || {};
  const summary = fields.summary || "";
  const status = fields.status?.name || "";
  const updated = fields.updated || "";
  const reporter = fields.reporter?.displayName || fields.reporter?.name || "";

  const worklogSeconds = Number(issue.__worklogSeconds || 0);
  const logged = Math.floor((worklogSeconds / 28800) * 100) / 100;
  const lastLoggedAt = issue.__lastLoggedAt || null;

  return {
    Title: { title: [{ text: { content: summary } }] },
    Key: { rich_text: [{ text: { content: key } }] },
    Status: status ? { select: { name: status } } : { select: null },
    Updated: updated ? { date: { start: updated } } : { date: null },
    URL: { url: `${JIRA_BASE_URL}/browse/${key}` },
    Logged: { number: logged },
    Reporter: { rich_text: [{ text: { content: reporter } }] },
    LastLogDate: lastLoggedAt
      ? { date: { start: lastLoggedAt } }
      : { date: null },
  };
}

async function createPage(NOTION_SOURCE_ID, issue) {
  return notion.pages.create({
    parent: {
      type: "data_source_id",
      data_source_id: NOTION_SOURCE_ID,
    },
    properties: issueToProps(issue),
  });
}

async function updatePage(pageId, issue) {
  return notion.pages.update({
    page_id: pageId,
    properties: issueToProps(issue),
  });
}

// -------------------- Runner --------------------
async function syncOnce() {
  const pLimit = (await import("p-limit")).default;
  const notionLimit = pLimit(5);

  const start = Date.now();

  const issues = await fetchIssues();
  console.log(`Fetched ${issues.length} issues`);

  const issuesWithWorklog = issues.map((issue) => {
    issue.__worklogSeconds = Number(issue.fields?.aggregatetimespent || 0);
    const worklogs = issue.fields?.worklog?.worklogs || [];
    let latest = null;
    for (const w of worklogs) {
      const raw = w.started || w.updated || w.created;
      if (!raw) continue;
      const t = Date.parse(raw);
      if (Number.isNaN(t)) continue;
      if (!latest || t > latest) latest = t;
    }
    issue.__lastLoggedAt = latest ? new Date(latest).toISOString() : null;
    return issue;
  });

  const issueKeys = issuesWithWorklog.map((i) => i.key);

  // ✅ 기존 페이지 일괄 조회
  const existingPages = await findExistingNotionPages(
    NOTION_SOURCE_ID,
    issueKeys,
  );

  // ✅ create/update 실행
  const notionResults = await Promise.all(
    issuesWithWorklog.map((issue) =>
      notionLimit(async () => {
        const page = existingPages.get(issue.key);
        if (!page) {
          await createPage(NOTION_SOURCE_ID, issue);
          console.log(`+ created ${issue.key}`);
          return "created";
        }
        const notionUpdated = page.properties?.Updated?.date?.start;
        const jiraUpdated = issue.fields?.updated;
        if (toMinuteEpoch(notionUpdated) !== toMinuteEpoch(jiraUpdated)) {
          await updatePage(page.id, issue);
          console.log(`~ updated ${issue.key}`);
          return "updated";
        } else {
          return "skipped";
        }
      }),
    ),
  );

  // ✅ 집계
  const created = notionResults.filter((r) => r === "created").length;
  const updated = notionResults.filter((r) => r === "updated").length;

  const end = Date.now();
  const elapsed = ((end - start) / 1000).toFixed(2);

  console.log(`Done. created=${created}, updated=${updated}`);
  console.log(`Elapsed time: ${elapsed}s`);
}

async function main() {
  const minutes = Number(POLL_MINUTES || 5);
  await syncOnce().catch(console.error);
  setInterval(
    () => {
      syncOnce().catch(console.error);
    },
    minutes * 60 * 1000,
  );
}
main();
