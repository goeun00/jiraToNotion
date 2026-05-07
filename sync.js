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
const { fetchPRs, fetchPRFiles, fetchBranchDiff } = require("./github");

// -------------------- Helper --------------------

function toMinuteEpoch(date) {
  if (!date) return null;
  return Math.floor(Date.parse(date) / 60000);
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
        let page = existingPRs.get(pr.html_url);
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

  const jiraKeys = new Set(issues.map((i) => i.key));
  const existingPages = await getAllNotionPagesMap();

  let created = 0;
  let updated = 0;
  let deleted = 0;

  await Promise.all([
    ...issuesWithWorklog.map((issue) =>
      notionLimit(async () => {
        const page = existingPages.get(issue.key);

        if (!page) {
          await createPage(issue);
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
        }
      }),
    ),
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
