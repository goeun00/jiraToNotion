require("dotenv").config();
const { JIRA_BASE_URL, JIRA_PAT } = process.env;
const JQL =
  "(assignee = currentUser() OR watcher = currentUser()) AND (  statusCategory != Done  OR (statusCategory = Done AND created >= -60d)) ORDER BY updated DESC";

// -------------------- Jira Fetch --------------------

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

// -------------------- Issues --------------------

async function fetchIssues() {
  const fields =
    "summary,status,updated,created,reporter,aggregatetimespent,worklog,description";
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

module.exports = {
  fetchIssues,
};
