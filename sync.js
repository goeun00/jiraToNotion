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

async function findPageByKey(issueKey) {
  const body = {
    filter: {
      property: "Key",
      title: {
        equals: issueKey,
      },
    },
  };

  const data = await notionFetch(`/databases/${NOTION_DATABASE_ID}/query`, {
    method: "POST",
    body: JSON.stringify(body),
  });

  return data.results?.[0] || null;
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

  return {
    Title: { title: [{ text: { content: summary } }] },
    Key: { rich_text: [{ text: { content: key } }] },
    Status: status ? { select: { name: status } } : { select: null },
    Updated: updated ? { date: { start: updated } } : { date: null },
    URL: { url },
    Logged: { number: Logged },
    Reporter: { rich_text: [{ text: { content: reporter } }] },
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
  const limit = pLimit(5); // 동시에 5개만 처리
  const start = Date.now();
  const issues = await fetchIssues();
  console.log(`Fetched ${issues.length} issues`);

  const worklogPromises = issues.map((issue) =>
    limit(async () => {
      const worklogs = await fetchAllWorklogs(issue.key);
      issue.__worklogSeconds = sumWorklogSeconds(worklogs);
      return issue;
    }),
  );
  const issuesWithWorklog = await Promise.all(worklogPromises);

  let created = 0;
  let updated = 0;

  // Notion 처리도 병렬화 가능 (rate limit 주의)
  for (const issue of issuesWithWorklog) {
    const key = issue.key;
    const page = await findPageByKey(key);

    if (!page) {
      await createPage(issue);
      created++;
      console.log(
        `+ created ${key} (worklog: ${Math.round((issue.__worklogSeconds / 3600) * 100) / 100}h)`,
      );
    } else {
      await updatePage(page.id, issue);
      updated++;
      console.log(
        `~ updated ${key} (worklog: ${Math.round((issue.__worklogSeconds / 3600) * 100) / 100}h)`,
      );
    }
  }
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
