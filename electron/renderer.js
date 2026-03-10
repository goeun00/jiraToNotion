const logBox = document.getElementById("log");

function write(msg) {
  logBox.textContent += msg + "\n";
  logBox.scrollTop = logBox.scrollHeight;
}

const envMap = {
  jiraUrl: "JIRA_BASE_URL",
  jiraPat: "JIRA_PAT",
  notionToken: "NOTION_TOKEN",
  notionJiraDb: "NOTION_SOURCE_ID_JIRA",
  notionPrDb: "NOTION_SOURCE_ID_PR",
  githubToken: "GITHUB_TOKEN",
  githubUser: "GITHUB_USERNAME",
  githubUrl: "GITHUB_URL",
};

function bindEvents() {
  document.getElementById("syncJira")?.addEventListener("click", () => {
    logBox.textContent = "";
    window.api.syncJira();
  });
  document.getElementById("syncPR")?.addEventListener("click", () => {
    window.api.syncPR();
  });
  document.getElementById("clearLog")?.addEventListener("click", () => {
    logBox.textContent = "";
  });
  document.getElementById("saveEnv")?.addEventListener("click", saveEnv);
}

async function saveEnv() {
  const data = {};
  Object.keys(envMap).forEach((id) => {
    const el = document.getElementById(id);
    data[envMap[id]] = el?.value || "";
  });
  const errors = validateConfig(data);
  if (errors.length) {
    console.log("⚠ Config Error");
    errors.forEach((e) => console.log("❌ " + e));
    return;
  }
  await window.api.saveEnv(data);
}

function validateConfig(data) {
  const errors = [];
  if (!data.JIRA_BASE_URL) errors.push("Jira URL 없음");
  if (!data.JIRA_PAT) errors.push("Jira PAT 없음");
  if (!data.NOTION_TOKEN) errors.push("Notion Token 없음");
  if (!data.NOTION_SOURCE_ID_JIRA) errors.push("Notion Jira DB 없음");
  if (!data.NOTION_SOURCE_ID_PR) errors.push("Notion Git DB 없음");
  if (!data.GITHUB_TOKEN) errors.push("Github Token 없음");
  return errors;
}

async function loadEnvToInputs() {
  const env = await window.api.loadEnv();
  if (!env) return;
  Object.entries(envMap).forEach(([inputId, envKey]) => {
    const el = document.getElementById(inputId);

    if (el && env[envKey]) {
      el.value = env[envKey];
    }
  });
}

window.api.onLog((msg) => {
  write(msg);
});

window.addEventListener("DOMContentLoaded", async () => {
  document.getElementById("min").onclick = () => {
    window.api.minimize();
  };
  document.getElementById("close").onclick = () => {
    window.api.close();
  };
  bindEvents();

  await loadEnvToInputs();

  const autoCheckbox = document.getElementById("autoSync");

  if (autoCheckbox) {
    autoCheckbox.addEventListener("change", () => {
      if (autoCheckbox.checked) {
        window.api.autoSync();
      } else {
        window.api.stopAutoSync();
      }
    });
  }
});
