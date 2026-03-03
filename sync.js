process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require("dotenv").config();

const {
  JIRA_BASE_URL,
  JIRA_PAT,
  NOTION_TOKEN,
  NOTION_DATABASE_ID,
  JQL,
  POLL_MINUTES,
} = process.env;

// 배열을 청크로 나누는 헬퍼 함수
function chunkArray(array, chunkSize) {
  const chunks = [];
  for (let i = 0; i < array.length; i += chunkSize) {
    chunks.push(array.slice(i, i + chunkSize));
  }
  return chunks;
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

//  이슈 전체 가져오기
async function fetchIssues() {
  const fields = ["summary", "status", "updated", "reporter"].join(",");
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

//  Worklog 전체 가져오기
async function fetchAllWorklogs(issueKey) {
  let startAt = 0;
  const maxResults = 100;
  let all = [];

  while (true) {
    const data = await jiraFetch(
      `/rest/api/2/issue/${issueKey}/worklog?startAt=${startAt}&maxResults=${maxResults}`,
    );
    const worklogs = data.worklogs || [];
    all = all.concat(worklogs);
    startAt += worklogs.length;
    if (worklogs.length === 0 || startAt >= (data.total || 0)) break;
  }

  return all;
}

function sumWorklogSeconds(worklogs) {
  return worklogs.reduce((sum, w) => sum + (w.timeSpentSeconds || 0), 0);
}

function getLastWorklogDateISO(worklogs) {
  if (!worklogs || worklogs.length === 0) return null;

  // started(작업한 날짜) 우선, 없으면 updated/created로 fallback
  let latest = null;

  for (const w of worklogs) {
    const raw = w.started || w.updated || w.created;
    if (!raw) continue;

    const t = Date.parse(raw);
    if (Number.isNaN(t)) continue;

    if (!latest || t > latest) latest = t;
  }

  return latest ? new Date(latest).toISOString() : null;
}

// -------------------- Notion --------------------
async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`Notion API error ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function findExistingNotionPages(issueKeys) {
  if (issueKeys.length === 0) return new Map();

  const pageMap = new Map();
  const NOTION_FILTER_BATCH_SIZE = 100; // Notion의 'or' 필터는 최대 100개의 조건을 처리할 수 있음

  const keyChunks = chunkArray(issueKeys, NOTION_FILTER_BATCH_SIZE);

  const queryPromises = keyChunks.map(async (chunk) => {
    const filterConditions = chunk.map((key) => ({
      property: "Key",
      rich_text: {
        equals: key,
      },
    }));
    const body = {
      filter: {
        or: filterConditions,
      },
    };

    const data = await notionFetch(`/databases/${NOTION_DATABASE_ID}/query`, {
      method: "POST",
      body: JSON.stringify(body),
    });

    for (const page of data.results || []) {
      const keyProperty = page.properties?.Key?.rich_text
        ?.map((t) => t.plain_text)
        .join("")
        .trim();
      if (keyProperty) {
        pageMap.set(keyProperty, page);
      }
    }
  });

  await Promise.all(queryPromises); // 모든 청크 쿼리를 병렬로 실행

  return pageMap;
}

function issueToProps(issue) {
  const key = issue.key;
  const fields = issue.fields || {};
  const summary = fields.summary || "";
  const status = fields.status?.name || "";
  const updated = fields.updated || "";
  const url = `${JIRA_BASE_URL}/browse/${key}`;
  const reporter = fields.reporter?.displayName || fields.reporter?.name || "";
  const worklogSeconds = Number(issue.__worklogSeconds || 0);
  const Logged = Math.round((worklogSeconds / 28800) * 100) / 100;
  const lastLoggedAt = issue.__lastLoggedAt || null;
  return {
    Title: { title: [{ text: { content: summary } }] },
    Key: { rich_text: [{ text: { content: key } }] },
    Status: status ? { select: { name: status } } : { select: null },
    Updated: updated ? { date: { start: updated } } : { date: null },
    URL: { url },
    Logged: { number: Logged },
    Reporter: { rich_text: [{ text: { content: reporter } }] },
    LastLogDate: lastLoggedAt
      ? { date: { start: lastLoggedAt } }
      : { date: null },
  };
}

async function createPage(issue) {
  const props = issueToProps(issue);
  return notionFetch(`/pages`, {
    method: "POST",
    body: JSON.stringify({
      parent: { database_id: NOTION_DATABASE_ID },
      properties: props,
    }),
  });
}

async function updatePage(pageId, issue) {
  const props = issueToProps(issue);
  return notionFetch(`/pages/${pageId}`, {
    method: "PATCH",
    body: JSON.stringify({ properties: props }),
  });
}

// -------------------- Runner --------------------
async function syncOnce() {
  const pLimit = (await import("p-limit")).default;
  const jiraLimit = pLimit(5); // Jira 워크로그 가져오기 동시성 제한
  const notionLimit = pLimit(5); // Notion 작업 동시성 제한 (Notion 레이트 리밋에 따라 조정)

  const start = Date.now();
  const issues = await fetchIssues();
  console.log(`Fetched ${issues.length} issues`);

  // 1. 모든 워크로그를 병렬로 가져오기
  const worklogPromises = issues.map((issue) =>
    jiraLimit(async () => {
      const worklogs = await fetchAllWorklogs(issue.key);
      issue.__worklogSeconds = sumWorklogSeconds(worklogs);
      issue.__lastLoggedAt = getLastWorklogDateISO(worklogs);
      return issue;
    }),
  );
  const issuesWithWorklog = await Promise.all(worklogPromises);

  // 2. 가져온 모든 Jira 이슈에 대해 기존 Notion 페이지를 대량으로 조회
  const issueKeys = issuesWithWorklog.map((issue) => issue.key);
  const existingNotionPages = await findExistingNotionPages(issueKeys);
  console.log(`Found ${existingNotionPages.size} existing Notion pages.`);

  const notionResults = await Promise.all(
    issuesWithWorklog.map((issue) =>
      notionLimit(async () => {
        const key = issue.key;
        const page = existingNotionPages.get(key);

        if (!page) {
          await createPage(issue);
          console.log(
            `+ created ${key} (worklog: ${Math.round((issue.__worklogSeconds / 3600) * 100) / 100}h)`,
          );
          return "created";
        }

        await updatePage(page.id, issue);
        console.log(
          `~ updated ${key} (worklog: ${Math.round((issue.__worklogSeconds / 3600) * 100) / 100}h)`,
        );
        return "updated";
      }),
    ),
  );

  // ✅ 집계는 여기서 한 번에
  const created = notionResults.filter((r) => r === "created").length;
  const updated = notionResults.filter((r) => r === "updated").length;

  const end = Date.now();
  const elapsed = ((end - start) / 1000).toFixed(2);
  console.log(`Done. created=${created}, updated=${updated}`);
  console.log(`Elapsed time: ${elapsed}s`);
}

async function main() {
  const minutes = Number(POLL_MINUTES || 5);
  console.log(`Start sync every ${minutes} min`);
  await syncOnce().catch((e) => console.error(e));
  setInterval(
    () => {
      syncOnce().catch((e) => console.error(e));
    },
    minutes * 60 * 1000,
  );
}
main();
