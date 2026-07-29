const journal = document.querySelector("[data-journal]");
const updatedAt = document.querySelector("[data-updated-at]");
const refreshButton = document.querySelector("[data-refresh]");
const collapseAllButton = document.querySelector("[data-collapse-all]");
const OPEN_STATE_KEY = "agent-hub:journal-open-state:v1";
const rateLimitsSlot = document.querySelector("[data-rate-limits-slot]");
const themeSelect = document.querySelector("[data-theme-select]");
const themeColor = document.querySelector("[data-theme-color]");
let currentVersion = "";
let loading = null;
const loadingDays = new Map();
const loadingTurns = new Map();
let journalRendered = false;
let desiredOpenState = null;
const telegram = window.Telegram?.WebApp;
const telegramInitData = String(telegram?.initData ?? "");
const telegramMode = Boolean(telegramInitData);
const telegramPlatform = String(telegram?.platform ?? "").toLowerCase();
const mobileTelegramPlatforms = new Set(["android", "ios"]);
const compactSurfaceWidth = 720;

function resolveSurface() {
  if (telegramMode && mobileTelegramPlatforms.has(telegramPlatform)) return "mobile";
  return window.innerWidth < compactSurfaceWidth ? "mobile" : "desktop";
}

let surface = resolveSurface();
document.documentElement.dataset.surface = surface;
const themes = {
  orbit: "#080b11",
  nebula: "#0f0819",
  pulsar: "#03151a",
  gothic: "#060708",
  blackhole: "#000000",
  taiga: "#070c12",
  magma: "#0a0605",
  storm: "#070b12",
  meadow: "#070d08",
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
    mobileDays: [...journal.querySelectorAll("[data-day-usage-table][data-mobile-expanded]")]
      .map((item) => item.closest("details[data-work-log-day-section]")
        ?.querySelector("summary[data-work-log-day] strong")?.textContent.trim())
      .filter(Boolean),
    mobileTasks: [...journal.querySelectorAll("[data-work-log-row][data-mobile-open]")]
      .map((item) => ({
        provider: item.dataset.workLogProvider,
        threadId: item.dataset.workLogThreadId,
      }))
      .filter((item) => item.provider && item.threadId),
  };
}

function storedOpenState() {
  try {
    const state = JSON.parse(localStorage.getItem(OPEN_STATE_KEY) || "null");
    return state && state.version === 1 ? state.value : null;
  } catch {
    return null;
  }
}

function persistOpenState() {
  if (!journalRendered) return;
  try {
    localStorage.setItem(OPEN_STATE_KEY, JSON.stringify({
      version: 1,
      value: captureOpenState(),
    }));
  } catch {
    // Приватный режим Telegram может запрещать localStorage; состояние DOM
    // всё равно сохраняется между обычными автообновлениями.
  }
}

function setMobileTaskOpen(row, open) {
  row.toggleAttribute("data-mobile-open", open);
  row.querySelector("[data-work-log-task-content]")?.setAttribute("aria-expanded", String(open));
  const previous = row.querySelector("details[data-work-log-previous-turns]");
  if (previous) previous.open = open;
}

function syncCollapseTurnButtons(root = journal) {
  const hidden = surface === "mobile";
  for (const button of root.querySelectorAll("[data-work-log-collapse-turns]")) {
    button.hidden = hidden;
  }
}

function prepareMobileControls(root = journal) {
  if (surface !== "mobile") return;
  const openDays = [...root.querySelectorAll("details[data-work-log-day-section][open]")];
  for (const details of openDays.slice(1)) details.open = false;
  for (const total of root.querySelectorAll("[data-day-usage]")) {
    total.setAttribute("role", "button");
    total.setAttribute("tabindex", "0");
    total.setAttribute("aria-expanded", "false");
  }
  for (const title of root.querySelectorAll("[data-work-log-task-content]")) {
    title.setAttribute("role", "button");
    title.setAttribute("tabindex", "0");
    title.setAttribute("aria-expanded", "false");
  }
}

function syncSurface() {
  const nextSurface = resolveSurface();
  if (nextSurface === surface) return;
  surface = nextSurface;
  document.documentElement.dataset.surface = surface;
  syncCollapseTurnButtons();
  if (journalRendered) prepareMobileControls();
}

window.addEventListener("resize", syncSurface);
telegram?.onEvent?.("viewportChanged", syncSurface);
telegram?.onEvent?.("fullscreenChanged", syncSurface);

function restoreOpenState(state) {
  desiredOpenState = state;
  for (const details of journal.querySelectorAll("details[data-work-log-day-section]")) {
    details.open = false;
  }
  const days = surface === "mobile" ? state.days.slice(0, 1) : state.days;
  for (const day of days) {
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
  for (const day of state.mobileDays ?? []) {
    for (const details of journal.querySelectorAll("details[data-work-log-day-section]")) {
      if (details.querySelector("summary[data-work-log-day] strong")?.textContent.trim() !== day) {
        continue;
      }
      const table = details.querySelector("[data-day-usage-table]");
      table?.setAttribute("data-mobile-expanded", "");
      table?.querySelector("[data-day-usage]")?.setAttribute("aria-expanded", "true");
    }
  }
  for (const task of state.mobileTasks ?? []) {
    const row = journal.querySelector(
      `[data-work-log-provider="${selectorValue(task.provider)}"]`
      + `[data-work-log-thread-id="${selectorValue(task.threadId)}"]`,
    );
    if (row) setMobileTaskOpen(row, true);
  }
  void hydrateOpenLazyNodes();
}

/* Лимиты приходят первым блоком журнала, но место им — в шапке: над днями
   они занимали целую строку ради одной строки цифр. */
function hoistRateLimits() {
  if (!rateLimitsSlot) return;
  const block = journal.querySelector("[data-work-log-rate-limits]");
  if (!block) {
    rateLimitsSlot.replaceChildren();
    rateLimitsSlot.hidden = true;
    return;
  }
  const sampledAt = block.getAttribute("data-sampled-at") ?? "";
  const sampled = new Date(sampledAt);
  rateLimitsSlot.title = Number.isNaN(sampled.getTime())
    ? ""
    : `Лимиты на ${sampled.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`;
  rateLimitsSlot.replaceChildren(...block.childNodes);
  rateLimitsSlot.hidden = false;
  block.remove();
}

function disableLocalLinks(root = journal) {
  for (const link of root.querySelectorAll("a")) {
    link.removeAttribute("href");
    link.setAttribute("role", "link");
    link.setAttribute("aria-disabled", "true");
  }
}

async function fetchJournalFragment(pathname, params) {
  const query = new URLSearchParams({ ...params, version: currentVersion });
  const response = await fetch(`${pathname}?${query}`, {
    cache: "no-store",
    headers: requestHeaders(),
  });
  const payload = await response.json();
  if (response.status === 409 || payload.version && payload.version !== currentVersion) {
    void loadJournal({ force: true });
    throw new Error("Журнал обновился.");
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
}

async function loadLazyDay(details) {
  const date = details?.dataset.lazyDay;
  if (!date || !details.isConnected) return;
  if (loadingDays.has(date)) return loadingDays.get(date);
  desiredOpenState = captureOpenState();
  details.setAttribute("aria-busy", "true");
  const promise = (async () => {
    const payload = await fetchJournalFragment("/api/journal/day", { date });
    if (!details.isConnected) return;
    const template = document.createElement("template");
    template.innerHTML = payload.html.trim();
    const replacement = template.content.firstElementChild;
    if (!replacement?.matches("details[data-work-log-day-section]")) {
      throw new Error("Некорректный фрагмент дня.");
    }
    replacement.open = true;
    details.replaceWith(replacement);
    disableLocalLinks(replacement);
    syncCollapseTurnButtons(replacement);
    prepareMobileControls(journal);
    if (desiredOpenState) restoreOpenState(desiredOpenState);
  })().catch((error) => {
    if (details.isConnected) {
      details.removeAttribute("aria-busy");
      details.title = error.message;
    }
  }).finally(() => loadingDays.delete(date));
  loadingDays.set(date, promise);
  return promise;
}

async function loadLazyTurn(details) {
  const turnId = details?.dataset.lazyTurnId;
  if (!turnId || !details.isConnected) return;
  if (loadingTurns.has(turnId)) return loadingTurns.get(turnId);
  desiredOpenState = captureOpenState();
  details.setAttribute("aria-busy", "true");
  const promise = (async () => {
    const payload = await fetchJournalFragment("/api/journal/turn", { id: turnId });
    if (!details.isConnected) return;
    const slot = details.querySelector("[data-lazy-turn-content]");
    if (!slot) throw new Error("Место для деталей хода не найдено.");
    const template = document.createElement("template");
    template.innerHTML = payload.html.trim();
    slot.replaceWith(template.content);
    details.removeAttribute("data-lazy-turn-id");
    details.removeAttribute("aria-busy");
    disableLocalLinks(details);
  })().catch((error) => {
    if (details.isConnected) {
      details.removeAttribute("aria-busy");
      details.title = error.message;
    }
  }).finally(() => loadingTurns.delete(turnId));
  loadingTurns.set(turnId, promise);
  return promise;
}

async function hydrateOpenLazyNodes() {
  const days = [...journal.querySelectorAll(
    "details[data-work-log-day-section][data-lazy-day][open]",
  )];
  await Promise.all(days.map(loadLazyDay));
  const turns = [...journal.querySelectorAll(
    "details[data-work-log-turn-details][data-lazy-turn-id][open]",
  )];
  await Promise.all(turns.map(loadLazyTurn));
}

async function loadJournal({ force = false } = {}) {
  if (loading) return loading;
  loading = (async () => {
    refreshButton.disabled = true;
    try {
      const headers = requestHeaders();
      if (!force && currentVersion) headers["If-None-Match"] = `"${currentVersion}"`;
      const response = await fetch(`/api/journal?now=${Date.now()}`, {
        cache: "no-store",
        headers,
      });
      if (response.status === 304) return;
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (force || payload.version !== currentVersion) {
        const state = journalRendered ? captureOpenState() : storedOpenState();
        journal.innerHTML = payload.html;
        hoistRateLimits();
        disableLocalLinks();
        syncCollapseTurnButtons();
        prepareMobileControls();
        if (state) restoreOpenState(state);
        journalRendered = true;
        persistOpenState();
        currentVersion = payload.version;
      }
      const date = new Date(payload.updatedAt);
      const stamp = Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      updatedAt.textContent = stamp || "Обновить";
      refreshButton.title = stamp ? `Журнал обновлён в ${stamp}` : "Обновить журнал";
      journal.setAttribute("aria-busy", "false");
    } catch (error) {
      // в кнопку помещается только пометка, полный текст ошибки уходит в подсказку
      updatedAt.textContent = "Ошибка";
      refreshButton.title = error.message;
      journal.setAttribute("aria-busy", "false");
    } finally {
      refreshButton.disabled = false;
      loading = null;
    }
  })();
  return loading;
}

refreshButton.addEventListener("click", () => void loadJournal({ force: true }));
collapseAllButton.addEventListener("click", () => {
  for (const details of journal.querySelectorAll("details[open]")) details.open = false;
  for (const item of journal.querySelectorAll("[data-mobile-expanded], [data-mobile-open]")) {
    item.removeAttribute("data-mobile-expanded");
    item.removeAttribute("data-mobile-open");
  }
  for (const item of journal.querySelectorAll('[aria-expanded="true"]')) {
    item.setAttribute("aria-expanded", "false");
  }
  persistOpenState();
});

function toggleMobileDayUsage(total) {
  const table = total.closest("[data-day-usage-table]");
  if (!table) return;
  const open = !table.hasAttribute("data-mobile-expanded");
  table.toggleAttribute("data-mobile-expanded", open);
  total.setAttribute("aria-expanded", String(open));
  persistOpenState();
}

function toggleMobileTask(cell) {
  const row = cell.closest("[data-work-log-row]");
  if (!row) return;
  setMobileTaskOpen(row, !row.hasAttribute("data-mobile-open"));
  persistOpenState();
}

journal.addEventListener("click", (event) => {
  const collapse = event.target.closest("[data-work-log-collapse-turns]");
  if (collapse && surface !== "mobile") {
    event.preventDefault();
    event.stopPropagation();
    const row = collapse.closest("[data-work-log-row]");
    const previous = row?.querySelector("details[data-work-log-previous-turns]");
    if (previous) previous.open = false;
    persistOpenState();
    return;
  }
  if (surface !== "mobile") return;
  const total = event.target.closest("[data-day-usage]");
  if (total) {
    event.preventDefault();
    event.stopPropagation();
    toggleMobileDayUsage(total);
    return;
  }
  if (event.target.closest("[data-day-usage-breakdown]")) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (event.target.closest("[data-task-usage-details]")) return;
  const cell = event.target.closest("[data-work-log-task-cell]");
  if (!cell) return;
  event.preventDefault();
  toggleMobileTask(cell);
});

journal.addEventListener("toggle", (event) => {
  const opened = event.target;
  if (surface === "mobile" && opened.matches?.("details[data-work-log-day-section][open]")) {
    for (const details of journal.querySelectorAll("details[data-work-log-day-section][open]")) {
      if (details !== opened) details.open = false;
    }
  }
  if (opened.matches?.("details[data-work-log-day-section][data-lazy-day][open]")) {
    void loadLazyDay(opened);
  }
  if (opened.matches?.("details[data-work-log-turn-details][data-lazy-turn-id][open]")) {
    void loadLazyTurn(opened);
  }
  setTimeout(persistOpenState, 0);
}, true);

journal.addEventListener("keydown", (event) => {
  if (surface !== "mobile" || !["Enter", " "].includes(event.key)) return;
  const total = event.target.closest("[data-day-usage]");
  if (total) {
    event.preventDefault();
    event.stopPropagation();
    toggleMobileDayUsage(total);
    return;
  }
  const title = event.target.closest("[data-work-log-task-content]");
  if (!title) return;
  event.preventDefault();
  toggleMobileTask(title);
});

if (telegramMode) {
  const polling = setInterval(() => void loadJournal(), 5_000);
  window.addEventListener("pagehide", () => clearInterval(polling), { once: true });
} else {
  const events = new EventSource("/events");
  events.addEventListener("ready", () => {
    void loadJournal();
  });
  events.addEventListener("journal", () => void loadJournal());
}

void loadJournal({ force: true });
