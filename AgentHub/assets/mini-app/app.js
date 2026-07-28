const journal = document.querySelector("[data-journal]");
const updatedAt = document.querySelector("[data-updated-at]");
const connection = document.querySelector("[data-connection]");
const connectionLabel = document.querySelector("[data-connection-label]");
const refreshButton = document.querySelector("[data-refresh]");
const themeSelect = document.querySelector("[data-theme-select]");
const themeColor = document.querySelector("[data-theme-color]");
let currentVersion = "";
let loading = null;
const telegram = window.Telegram?.WebApp;
const telegramInitData = String(telegram?.initData ?? "");
const telegramMode = Boolean(telegramInitData);
const themes = {
  orbit: "#080b11",
  nebula: "#10091a",
  pulsar: "#041217",
};

function savedTheme() {
  try {
    const value = localStorage.getItem("agent-hub-theme");
    return Object.hasOwn(themes, value) ? value : "orbit";
  } catch {
    return "orbit";
  }
}

function applyTheme(theme, { persist = false } = {}) {
  const selected = Object.hasOwn(themes, theme) ? theme : "orbit";
  document.documentElement.dataset.theme = selected;
  themeSelect.value = selected;
  themeColor.content = themes[selected];
  if (persist) {
    try {
      localStorage.setItem("agent-hub-theme", selected);
    } catch {
      // Тема останется активной до закрытия WebView.
    }
  }
}

telegram?.ready();
telegram?.expand();
applyTheme(savedTheme());
themeSelect.addEventListener("change", () => applyTheme(themeSelect.value, { persist: true }));

function requestHeaders() {
  return telegramMode ? { Authorization: `tma ${telegramInitData}` } : {};
}

function setConnection(state, label) {
  connection.dataset.connection = state;
  connectionLabel.textContent = label;
}

function selectorValue(value) {
  return CSS.escape(String(value ?? ""));
}

function captureOpenState() {
  return {
    days: [...journal.querySelectorAll("details[data-work-log-day-section][open]")]
      .map((item) => item.querySelector("summary[data-work-log-day] strong")?.textContent.trim())
      .filter(Boolean),
    previous: [...journal.querySelectorAll("details[data-work-log-previous-turns][open]")]
      .map((item) => item.closest("[data-work-log-row]")?.dataset.workLogThreadId)
      .filter(Boolean),
    taskUsage: [...journal.querySelectorAll("details[data-task-usage-details][open]")]
      .map((item) => item.closest("[data-work-log-row]")?.dataset.workLogThreadId)
      .filter(Boolean),
    turns: [...journal.querySelectorAll("details[data-work-log-turn-details][open]")]
      .map((item) => item.closest("[data-work-log-turn-id]")?.dataset.workLogTurnId)
      .filter(Boolean),
  };
}

function restoreOpenState(state) {
  for (const day of state.days) {
    for (const details of journal.querySelectorAll("details[data-work-log-day-section]")) {
      if (details.querySelector("summary[data-work-log-day] strong")?.textContent.trim() === day) {
        details.open = true;
      }
    }
  }
  for (const threadId of state.previous) {
    journal.querySelector(
      `[data-work-log-thread-id="${selectorValue(threadId)}"] details[data-work-log-previous-turns]`,
    )?.setAttribute("open", "");
  }
  for (const threadId of state.taskUsage) {
    journal.querySelector(
      `[data-work-log-thread-id="${selectorValue(threadId)}"] details[data-task-usage-details]`,
    )?.setAttribute("open", "");
  }
  for (const turnId of state.turns) {
    journal.querySelector(
      `[data-work-log-turn-id="${selectorValue(turnId)}"] details[data-work-log-turn-details]`,
    )?.setAttribute("open", "");
  }
}

function disableLocalLinks() {
  for (const link of journal.querySelectorAll("a")) {
    link.removeAttribute("href");
    link.setAttribute("role", "link");
    link.setAttribute("aria-disabled", "true");
  }
}

async function loadJournal({ force = false } = {}) {
  if (loading) return loading;
  loading = (async () => {
    refreshButton.disabled = true;
    try {
      const response = await fetch(`/api/journal?now=${Date.now()}`, {
        cache: "no-store",
        headers: requestHeaders(),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (force || payload.version !== currentVersion) {
        const state = captureOpenState();
        journal.innerHTML = payload.html;
        disableLocalLinks();
        restoreOpenState(state);
        currentVersion = payload.version;
      }
      const date = new Date(payload.updatedAt);
      updatedAt.textContent = Number.isNaN(date.getTime())
        ? "Журнал обновлён"
        : `Обновлено ${date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      journal.setAttribute("aria-busy", "false");
    } catch (error) {
      updatedAt.textContent = error.message;
      journal.setAttribute("aria-busy", "false");
    } finally {
      refreshButton.disabled = false;
      loading = null;
    }
  })();
  return loading;
}

refreshButton.addEventListener("click", () => void loadJournal({ force: true }));

if (telegramMode) {
  setConnection("online", "Автообновление");
  const polling = setInterval(() => void loadJournal(), 5_000);
  window.addEventListener("pagehide", () => clearInterval(polling), { once: true });
} else {
  const events = new EventSource("/events");
  events.addEventListener("open", () => setConnection("online", "Автообновление"));
  events.addEventListener("ready", () => {
    setConnection("online", "Автообновление");
    void loadJournal();
  });
  events.addEventListener("journal", () => void loadJournal());
  events.addEventListener("error", () => setConnection("retrying", "Переподключение…"));
}

void loadJournal({ force: true });
