require("dotenv").config();
const twoMonthsAgo = new Date();
twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 6);
const since = twoMonthsAgo.toISOString().split("T")[0];
const { GITHUB_TOKEN, GITHUB_USERNAME, GITHUB_URL } = process.env;

async function fetchPRs() {
  const query = `is:pr org:org-publisher author:${GITHUB_USERNAME} created:>=${since}`;
  const res = await fetch(
    `${GITHUB_URL}/api/v3/search/issues?q=${encodeURIComponent(query)}&sort=created&order=desc&per_page=100`,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
      },
    },
  );

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GitHub API error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  const prs = [];
  for (const item of data.items) {
    const repoName = item.repository_url.split("/").pop();
    const prNumber = item.number;
    const prRes = await fetch(
      `${GITHUB_URL}/api/v3/repos/org-publisher/${repoName}/pulls/${prNumber}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    const pr = await prRes.json();
    prs.push(pr);
  }

  return prs;
}

async function fetchPRFiles(owner, repo, prNumber) {
  let page = 1;
  const allFiles = [];

  while (true) {
    const res = await fetch(
      `${GITHUB_URL}/api/v3/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status}`);
    }
    const files = await res.json();
    allFiles.push(...files);
    if (files.length < 100) break;
    page++;
  }
  return allFiles;
}
module.exports = { fetchPRs, fetchPRFiles };
