process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require("dotenv").config();
const { Client } = require("@notionhq/client");
const { buildNotionBlocks } = require("./review");

// Client를 매번 생성해서 항상 최신 토큰 사용
const env = () => process.env;
const notion = new Proxy(
  {},
  {
    get(_, prop) {
      return new Client({ auth: env().NOTION_TOKEN })[prop];
    },
  },
);

// -------------------- Query --------------------
async function getAllNotionPagesMap() {
  const pageMap = new Map();
  let cursor = undefined;

  while (true) {
    const res = await notion.dataSources.query({
      data_source_id: env().NOTION_SOURCE_ID_JIRA,
      start_cursor: cursor,
      page_size: 100,
    });
    (res.results || []).forEach((page) => {
      const keyText = page.properties?.Key?.rich_text
        ?.map((t) => t.plain_text)
        .join("")
        .trim();

      if (keyText) {
        pageMap.set(keyText, page);
      }
    });
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return pageMap;
}

// -------------------- Props --------------------
function jiraProps(issue) {
  const key = issue.key;
  const fields = issue.fields || {};
  const summary = fields.summary || "";
  const status = fields.status?.name || "";
  const updated = fields.updated || "";
  const created = fields.created || "";
  const reporter = fields.reporter?.displayName || fields.reporter?.name || "";
  const worklogSeconds = Number(issue.__worklogSeconds || 0);
  const logged = Math.floor((worklogSeconds / 28800) * 100) / 100;
  const lastLoggedAt = issue.__lastLoggedAt || null;
  return {
    Title: { title: [{ text: { content: summary } }] },
    Key: { rich_text: [{ text: { content: key } }] },
    Status: status ? { status: { name: status } } : { status: null },
    Updated: updated ? { date: { start: updated } } : { date: null },
    Created: created ? { date: { start: created } } : { date: null },
    URL: { url: `${env().JIRA_BASE_URL}/browse/${key}` },
    Logged: { number: logged },
    Reporter: { rich_text: [{ text: { content: reporter } }] },
    LastLogDate: lastLoggedAt
      ? { date: { start: lastLoggedAt } }
      : { date: null },
  };
}

function checkNaming(files = []) {
  const issues = [];
  const pascalCase = /^[A-Z][a-zA-Z0-9]+$/;
  const snakeCase = /^[a-z0-9]+(_[a-z0-9]+)*$/;
  for (const file of files) {
    if (file.status === "renamed" || file.status === "removed") {
      continue;
    }
    const name = file.filename.split("/").pop();
    const base = name.replace(/\.[^/.]+$/, "");
    if (file.filename.includes("/components/")) {
      if (!pascalCase.test(base)) {
        issues.push(`Component : ${name}`);
      }
    }
    if (file.filename.includes("/pages/") || name.endsWith(".css")) {
      if (!snakeCase.test(base)) {
        issues.push(`Page/CSS : ${name}`);
      }
    }
  }
  return issues;
}

function buildFileBlocks(files = []) {
  const totalFiles = files.length;
  const namingIssues = checkNaming(files);
  const additions = files.reduce((sum, f) => sum + (f.additions || 0), 0);
  const deletions = files.reduce((sum, f) => sum + (f.deletions || 0), 0);
  const complexity = Math.round((additions + deletions) / totalFiles);
  const workspaceSet = new Set();
  for (const { filename } of files) {
    const match = filename.match(/^workspaces\/([^/]+)/);
    if (match) workspaceSet.add(match[1]);
  }
  const summaryLines = [
    "━━━━━━━━━━━━━━━━━━",
    "📊 PR Summary",
    "━━━━━━━━━━━━━━━━━━",
    `Files      : ${totalFiles}`,
    `Additions  : +${additions}`,
    `Deletions  : -${deletions}`,
    `Complexity : 🔥 ${complexity}`,
  ];
  if (workspaceSet.size) {
    summaryLines.push(
      "",
      "📦 Workspaces",
      ...[...workspaceSet].sort().map((w) => `• ${w}`),
    );
  }
  if (namingIssues.length) {
    summaryLines.push(
      "",
      "⚠ Naming Issues",
      ...namingIssues.slice(0, 10).map((i) => `• ${i}`),
    );
  }
  return [
    {
      object: "block",
      type: "code",
      code: {
        language: "plain text",
        rich_text: [
          {
            type: "text",
            text: { content: summaryLines.join("\n") },
          },
        ],
      },
    },
  ];
}
function buildCssBlocks(files = [], repo) {
  const links = new Set();
  const publishMatch = repo.match(/^Publish\.(IAC|GMKT)\.(Mobile|PC)$/);
  for (const file of files) {
    const path = file.filename || "";
    if (publishMatch) {
      if (!/\.(css|js)$/.test(path)) continue;
      const brandMap = { IAC: "auction", GMKT: "gmarket" };
      const deviceMap = { Mobile: "mobile", PC: "pc" };
      const brand = brandMap[publishMatch[1]];
      const device = deviceMap[publishMatch[2]];
      links.add(`https://script.${brand}.co.kr/${device}/${path}`);
      continue;
    }
    if (!path.endsWith(".css")) continue;
    const match = path.match(
      /^workspaces\/(gmarket|auction)-(desktop|mobile).*html\/([^/]+)/,
    );
    if (!match) continue;
    const [, brand, device, page] = match;
    links.add(
      `https://script.${brand}.co.kr/${repo}/${device}/css/${page}/${page}.css`,
    );
  }
  const cssLinks = [...links];
  if (!cssLinks.length) return [];

  return [
    {
      object: "block",
      type: "code",
      code: {
        language: "plain text",
        rich_text: [
          {
            type: "text",
            text: {
              content:
                "━━━━━━━━━━━━━━━━━━\n🔗 CSS/JS Patch\n━━━━━━━━━━━━━━━━━━\n",
            },
          },
          ...cssLinks.map((url, i) => ({
            type: "text",
            text: {
              content: `${url.replace(/^https:/, "")}${
                i < cssLinks.length - 1 ? "\n" : ""
              }`,
              link: { url },
            },
          })),
        ],
      },
    },
  ];
}
// -------------------- CRUD --------------------
async function createPage(issue) {
  return notion.pages.create({
    parent: {
      type: "data_source_id",
      data_source_id: env().NOTION_SOURCE_ID_JIRA,
    },
    properties: jiraProps(issue),
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
    properties: jiraProps(issue),
  });
}
async function deletePage(pageId) {
  return notion.pages.update({
    page_id: pageId,
    archived: true,
  });
}

async function getAllGitPRMap() {
  const pageMap = new Map();
  let cursor = undefined;
  while (true) {
    const res = await notion.dataSources.query({
      data_source_id: env().NOTION_SOURCE_ID_PR,
      start_cursor: cursor,
      page_size: 100,
    });
    (res.results || []).forEach((page) => {
      const url = page.properties?.Url?.url;

      if (url) {
        pageMap.set(url, page);
      }
    });
    if (!res.has_more) break;
    cursor = res.next_cursor;
  }
  return pageMap;
}

function getPRStatus(pr) {
  if (pr.merged_at) return "Merged";
  if (pr.state === "open") return "Open";
  return "Closed";
}

async function createPRPage(pr, files) {
  const repo = pr.base.repo.name;
  const prStatus = getPRStatus(pr);
  const page = await notion.pages.create({
    parent: {
      type: "data_source_id",
      data_source_id: env().NOTION_SOURCE_ID_PR,
    },
    properties: {
      Title: {
        title: [{ text: { content: pr.title } }],
      },
      Url: {
        url: pr.html_url,
      },
      Status: {
        status: { name: prStatus },
      },
      Created: {
        date: { start: pr.created_at },
      },
      LastUpdated: {
        date: { start: pr.updated_at },
      },
      Repository: {
        select: { name: pr.base.repo.name },
      },
      Target: {
        select: { name: pr.base.ref },
      },
    },
  });

  const blocks = buildFileBlocks(files);
  const cssBlocks = buildCssBlocks(files, repo);
  await notion.blocks.children.append({
    block_id: page.id,
    children: [...blocks, ...cssBlocks],
  });
  return page;
}

async function updatePRPage(page, pr) {
  const prStatus = getPRStatus(pr);

  await notion.pages.update({
    page_id: page.id,
    properties: {
      Title: {
        title: [{ text: { content: pr.title } }],
      },
      Status: {
        status: { name: prStatus },
      },
      Target: {
        select: { name: pr.base.ref },
      },
      Repository: {
        select: { name: pr.base.repo.name },
      },
      LastUpdated: {
        date: { start: pr.updated_at },
      },
    },
  });
  console.log(`~ updated PR: ${pr.title}`);
}

// -------------------- Code Review --------------------

/**
 * 코드리뷰 페이지 생성
 * @param {object} opts
 * @param {string} opts.repo
 * @param {string} opts.base
 * @param {string} opts.compare
 * @param {string|null} opts.prUrl
 * @param {string} opts.summary
 * @param {{ filename: string, review: string }[]} opts.fileReviews
 */
async function createReviewPage({
  repo,
  base,
  compare,
  prUrl,
  summary,
  fileReviews,
}) {
  const title = `[🐿️ ${repo}] ${compare} → ${base}`;
  const now = new Date().toISOString();

  // review.js의 블록 빌더로 Notion 템플릿 생성
  const { summaryBlocks, fileBlocks } = buildNotionBlocks(
    summary,
    fileReviews,
    repo,
    base,
    compare,
  );

  const properties = {
    Title: { title: [{ text: { content: title } }] },
    Repository: { select: { name: repo } },
    Base: { rich_text: [{ text: { content: base } }] },
    Compare: { rich_text: [{ text: { content: compare } }] },
    ReviewedAt: { date: { start: now } },
    Status: { status: { name: "Done" } },
  };
  if (prUrl) {
    properties.PRLink = { url: prUrl };
  }

  const page = await notion.pages.create({
    parent: {
      type: "data_source_id",
      data_source_id: env().NOTION_SOURCE_ID_REVIEW,
    },
    properties,
    children: summaryBlocks,
  });

  // 블록 100개 제한 — 분할 append
  const CHUNK = 90;
  for (let i = 0; i < fileBlocks.length; i += CHUNK) {
    await notion.blocks.children.append({
      block_id: page.id,
      children: fileBlocks.slice(i, i + CHUNK),
    });
  }

  return page;
}

// -------------------- Create Review DB --------------------

/**
 * 지정한 부모 페이지 안에 코드리뷰 Notion 데이터베이스를 생성하고 DB ID를 반환
 * @param {string} parentPageId - Notion 페이지 ID
 * @returns {Promise<string>} 생성된 DB ID
 */
async function createReviewDatabase(parentPageId) {
  const db = await notion.databases.create({
    parent: { type: "page_id", page_id: parentPageId },
    title: [{ type: "text", text: { content: "🔍 Code Reviews" } }],
    icon: { type: "emoji", emoji: "🔍" },
    properties: {
      // 제목 (필수 — Name 키는 title 타입이어야 함)
      Title: { title: {} },

      // 저장소 선택
      Repository: { select: {} },

      // 브랜치 정보
      Base: { rich_text: {} },
      Compare: { rich_text: {} },

      // PR 링크
      PRLink: { url: {} },

      // 리뷰 일시
      ReviewedAt: { date: {} },

      // 상태
      Status: {
        status: {
          options: [
            { name: "Done", color: "green" },
            { name: "In Progress", color: "yellow" },
            { name: "Failed", color: "red" },
          ],
        },
      },
    },
  });

  return db.id;
}

module.exports = {
  getAllNotionPagesMap,
  createPage,
  updatePage,
  deletePage,
  getAllGitPRMap,
  createPRPage,
  updatePRPage,
  createReviewPage,
  createReviewDatabase,
};
