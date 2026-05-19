process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require("dotenv").config();
const { Client } = require("@notionhq/client");

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

function normalizeStatusCategory(statusCategory = "") {
  const statusMap = {
    new: "To Do",
    indeterminate: "In Progress",
    done: "Done",
  };

  return statusMap[statusCategory] || "To Do";
}
// -------------------- Props --------------------
function jiraProps(issue) {
  const fields = issue.fields || {};

  const key = issue.key || issue.issueKey || "";
  const summary = issue.summary || fields.summary || "";
  const status = normalizeStatusCategory(
    issue.statusCategory || fields.status?.statusCategory?.key || "",
  );
  const updated = issue.updated || fields.updated || "";
  const created = issue.created || fields.created || "";
  const reporter =
    issue.reporter ||
    fields.reporter?.displayName ||
    fields.reporter?.name ||
    "";

  const worklogSeconds = Number(
    issue.__worklogSeconds ??
      issue.aggregatetimespent ??
      fields.aggregatetimespent ??
      0,
  );

  const logged = Math.round((worklogSeconds / 28800) * 1000) / 1000;
  const lastLoggedAt = issue.__lastLoggedAt || null;

  return {
    Title: { title: [{ text: { content: summary || key || "제목 없음" } }] },
    Key: { rich_text: [{ text: { content: key } }] },
    Status: status ? { status: { name: status } } : { status: null },
    Updated: updated ? { date: { start: updated } } : { date: null },
    Created: created ? { date: { start: created } } : { date: null },
    URL: { url: issue.url || `${env().JIRA_BASE_URL}/browse/${key}` },
    Logged: { number: logged },
    Reporter: { rich_text: [{ text: { content: reporter } }] },
    "Log Dates": {
      date: issue.logDate ? { start: issue.logDate } : null,
    },
    "Epic Key": {
      rich_text: [{ text: { content: issue.epicLink || "" } }],
    },
    "Epic Name": {
      rich_text: [{ text: { content: issue.epicName || "" } }],
    },
    "Target start": {
      date: issue.targetStart ? { start: issue.targetStart } : null,
    },
    "Target end": {
      date: issue.targetEnd ? { start: issue.targetEnd } : null,
    },
    "Expected Delivery Date": {
      date: issue.expectedDeliveryDate
        ? { start: issue.expectedDeliveryDate }
        : null,
    },
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
  const description =
    issue.description || issue.fields?.description || "내용 없음";

  const descriptionText =
    typeof description === "string" ? description : JSON.stringify(description);

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
                content: descriptionText.slice(0, 1900),
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

module.exports = {
  getAllNotionPagesMap,
  createPage,
  updatePage,
  deletePage,
  getAllGitPRMap,
  createPRPage,
  updatePRPage,
};
