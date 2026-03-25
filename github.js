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

/**
 * 두 브랜치 간 raw diff 텍스트 조회
 * @param {string} owner - 조직명
 * @param {string} repo  - 저장소명
 * @param {string} base  - 기준 브랜치 (e.g. "main")
 * @param {string} compare - 비교 브랜치 (e.g. "dev")
 * @returns {Promise<{ diffText: string, prUrl: string | null }>}
 */
async function fetchBranchDiff(owner, repo, base, compare) {
  // raw diff 가져오기
  const diffRes = await fetch(
    `${GITHUB_URL}/api/v3/repos/${owner}/${repo}/compare/${base}...${compare}`,
    {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: "application/vnd.github.v3.diff",
      },
    },
  );
  if (!diffRes.ok) {
    const txt = await diffRes.text();
    throw new Error(`GitHub compare API error ${diffRes.status}: ${txt}`);
  }
  const diffText = await diffRes.text();

  // 관련 PR URL 조회 (있으면)
  let prUrl = null;
  try {
    const prRes = await fetch(
      `${GITHUB_URL}/api/v3/repos/${owner}/${repo}/pulls?head=${owner}:${compare}&base=${base}&state=all&per_page=1`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (prRes.ok) {
      const prs = await prRes.json();
      if (prs.length > 0) prUrl = prs[0].html_url;
    }
  } catch (_) {
    // PR 없어도 계속 진행
  }

  return { diffText, prUrl };
}

/**
 * 조직의 저장소 목록 조회
 * @param {string} org - 조직명
 * @returns {Promise<string[]>} 저장소명 배열
 */
async function fetchOrgRepos(org) {
  const repos = [];
  let page = 1;
  while (true) {
    const res = await fetch(
      `${GITHUB_URL}/api/v3/orgs/${org}/repos?per_page=100&page=${page}&sort=updated`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) break;
    const data = await res.json();
    repos.push(...data.map((r) => r.name));
    if (data.length < 100) break;
    page++;
  }
  return repos;
}

module.exports = { fetchPRs, fetchPRFiles, fetchBranchDiff, fetchOrgRepos };
