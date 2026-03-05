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

function toMinuteEpoch(date) {
  if (!date) return null;
  return Math.floor(Date.parse(date) / 60000);
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
  const fields =
    "summary,status,updated,reporter,aggregatetimespent,worklog,description";

  const pageSize = 1000;
  let startAt = 0;
  const all = [];

  while (true) {
    const url = `/rest/api/2/search?jql=${encodeURIComponent(JQL)}&fields=${fields}&expand=&startAt=${startAt}&maxResults=${pageSize}`;
    const data = await jiraFetch(url);
    const issues = data.issues || [];
    all.push(...issues);
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

async function getAllNotionPagesMap(NOTION_SOURCE_ID) {
  const pageMap = new Map();
  let cursor = undefined;

  while (true) {
    const res = await notion.dataSources.query({
      data_source_id: NOTION_SOURCE_ID,
      start_cursor: cursor,
      page_size: 100,
    });

    await Promise.all(
      (res.results || []).map(async (page) => {
        const keyText = page.properties?.Key?.rich_text
          ?.map((t) => t.plain_text)
          .join("")
          .trim();
        if (keyText) {
          pageMap.set(keyText, page);
        }
      }),
    );

    if (!res.has_more) break;
    cursor = res.next_cursor;
  }

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
    children: [
      {
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: {
                content: issue.fields.description || "내용 없음",
              },
            },
          ],
        },
      },
    ],
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
  const notionLimit = pLimit(3);

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

  // ✅ 기존 페이지 일괄 조회
  const existingPages = await getAllNotionPagesMap(NOTION_SOURCE_ID);

  // ✅ create/update 실행
  let created = 0,
    updated = 0;
  await Promise.all(
    issuesWithWorklog.map((issue) =>
      notionLimit(async () => {
        const page = existingPages.get(issue.key);
        if (!page) {
          await createPage(NOTION_SOURCE_ID, issue);
          created++;
          console.log(`+ created ${issue.key}`);
          return;
        }
        const notionUpdated = page.properties?.Updated?.date?.start;
        const jiraUpdated = issue.fields?.updated;
        if (toMinuteEpoch(notionUpdated) !== toMinuteEpoch(jiraUpdated)) {
          await updatePage(page.id, issue);
          updated++;
          console.log(`~ updated ${issue.key}`);
        } else {
        }
      }),
    ),
  );
  const end = Date.now();
  const elapsed = ((end - start) / 1000).toFixed(2);
  if (updated || created) {
    console.log(`Done. created=${created}, updated=${updated}`);
  }
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
