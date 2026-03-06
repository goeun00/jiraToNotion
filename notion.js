process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";
require("dotenv").config();

const { Client } = require("@notionhq/client");

const {
  NOTION_TOKEN,
  NOTION_SOURCE_ID_JIRA,
  JIRA_BASE_URL,
  NOTION_SOURCE_ID_GIT,
} = process.env;

const notion = new Client({
  auth: NOTION_TOKEN,
});

// -------------------- Query --------------------
async function getAllNotionPagesMap() {
  const pageMap = new Map();
  let cursor = undefined;

  while (true) {
    const res = await notion.dataSources.query({
      data_source_id: NOTION_SOURCE_ID_JIRA,
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
    URL: { url: `${JIRA_BASE_URL}/browse/${key}` },
    Logged: { number: logged },
    Reporter: { rich_text: [{ text: { content: reporter } }] },
    LastLogDate: lastLoggedAt
      ? { date: { start: lastLoggedAt } }
      : { date: null },
  };
}

// -------------------- CRUD --------------------
async function createPage(issue) {
  return notion.pages.create({
    parent: {
      type: "data_source_id",
      data_source_id: NOTION_SOURCE_ID_JIRA,
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
      data_source_id: NOTION_SOURCE_ID_GIT,
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

async function createPRPage(pr) {
  let prStatus;
  if (pr.merged_at) {
    prStatus = "Merged";
  } else if (pr.state === "open") {
    prStatus = "Open";
  } else {
    prStatus = "Closed";
  }
  return notion.pages.create({
    parent: {
      type: "data_source_id",
      data_source_id: NOTION_SOURCE_ID_GIT,
    },
    properties: {
      Title: {
        title: [
          {
            text: {
              content: pr.title,
            },
          },
        ],
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
      Repository: {
        select: { name: pr.base.repo.name },
      },
      Target: {
        select: { name: pr.base.ref },
      },
    },
  });
}
module.exports = {
  getAllNotionPagesMap,
  createPage,
  updatePage,
  deletePage,
  getAllGitPRMap,
  createPRPage,
};
