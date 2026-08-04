/* Agent Hub — общий frontend.
 *
 * Оболочка объединяет четыре представления над одними данными и темами:
 *   • «Диалоги» — слева компактный список задач, справа чат выбранной задачи;
 *   • «Журнал» — SQLite-представление журнала с ленивой подгрузкой;
 *   • «Статистика» — локальный расход журнала и история лимитов API.
 *   • «Сервер» — состояние и безопасное управление локальным Agent Hub.
 *
 * Frontend не хранит собственных задач и сообщений: до подключения backend
 * списки пусты и показывают понятные пустые состояния. Данные приходят через
 * контракт `window.AgentHub.*` (render-функции), а действия пользователя
 * уходят наружу событием `agenthub:intent` и через `AgentHub.on(type, fn)`.
 * Разметка связана с кодом через атрибуты data-* — см. index.html. */

"use strict";

/* ------------------------------------------------------------- ссылки DOM */

const root = document.documentElement;
const { USER_MESSAGE_COLLAPSE_HEIGHT_PX, hasCollapsedOverflow } = window.AgentHubMessageDisclosure;
const expandedUserMessageIds = new Set();
let messageDisclosureFrame = 0;
const journal = document.querySelector("[data-journal]");
const journalView = document.querySelector("[data-journal-view]");
const statisticsView = document.querySelector("[data-statistics-view]");
const serverView = document.querySelector("[data-server-view]");
const updatedAt = document.querySelector("[data-updated-at]");
const refreshButton = document.querySelector("[data-refresh]");
const collapseAllButton = document.querySelector("[data-collapse-all]");
const themeSelect = document.querySelector("[data-theme-select]");
const backgroundSelect = document.querySelector("[data-background-select]");
const groupSelect = document.querySelector("[data-group-select]");
const themeColor = document.querySelector("[data-theme-color]");

const taskList = document.querySelector("[data-task-list]");
const taskEmpty = document.querySelector("[data-task-empty]");
const taskCount = document.querySelector("[data-task-count]");
const taskFilter = document.querySelector("[data-task-filter]");
const taskNewPicker = document.querySelector("[data-task-new-picker]");

const chatPane = document.querySelector("[data-chat-pane]");
const chatEmpty = document.querySelector("[data-chat-empty]");
const chatScroll = document.querySelector("[data-chat-scroll]");
const historyLoader = document.querySelector("[data-history-loader]");
const historyLoadButton = document.querySelector("[data-history-load]");
const historyLoadLabel = document.querySelector("[data-history-load-label]");
const chatLog = document.querySelector("[data-chat-log]");
const chatLive = document.querySelector("[data-chat-live]");
const chatTitle = document.querySelector("[data-chat-title]");
const chatSubtitle = document.querySelector("[data-chat-subtitle]");
const chatProviderDot = document.querySelector("[data-chat-provider-dot]");
const chatRunning = document.querySelector("[data-chat-running]");
const chatStops = [...document.querySelectorAll("[data-chat-stop]")];
const dialogSettings = document.querySelector("[data-dialog-settings]");
const dialogSettingsToggle = document.querySelector("[data-dialog-settings-toggle]");
const dialogAgent = document.querySelector("[data-dialog-agent]");

const composer = document.querySelector("[data-composer]");
const composerGrow = document.querySelector("[data-composer-grow]");
const composerInput = document.querySelector("[data-composer-input]");
const composerSend = document.querySelector("[data-composer-send]");
const annotationsBox = document.querySelector("[data-annotations]");
const attachmentsBox = document.querySelector("[data-attachments]");
const annotationContextMenu = document.querySelector("[data-annotation-context-menu]");
const fileInput = document.querySelector("[data-file-input]");
const slashMenu = document.querySelector("[data-slash-menu]");
const slashButton = document.querySelector("[data-action='slash-menu']");
const contextUsageButton = document.querySelector("[data-context-usage]");
const contextRing = document.querySelector("[data-context-ring]");
const contextLabel = document.querySelector("[data-context-label]");

const approvalsBox = document.querySelector("[data-approvals]");
const queueBox = document.querySelector("[data-queue]");

const settingsPanel = document.querySelector("[data-settings-panel]");
const telegramFullscreenButton = document.querySelector("[data-telegram-fullscreen]");
const breakdownToggle = document.querySelector("[data-token-breakdown-toggle]");
const claudeGroupToggle = document.querySelector("[data-claude-group-toggle]");
const usageUnitButtons = [...document.querySelectorAll("[data-usage-unit]")];
const exchangeRateHint = document.querySelector("[data-exchange-rate-hint]");
const panelScrim = document.querySelector("[data-panel-scrim]");
const statusSlot = document.querySelector("[data-status-slot]");
const trustedDeviceList = document.querySelector("[data-trusted-device-list]");
const trustedDevicePairing = document.querySelector("[data-trusted-device-pairing]");
const trustedDeviceCreate = document.querySelector("[data-device-create]");
const serverState = document.querySelector("[data-server-state]");
const serverStateNote = document.querySelector("[data-server-state-note]");
const serverStateDot = document.querySelector("[data-server-state-dot]");
const serverFacts = document.querySelector("[data-server-facts]");
const serverComponents = document.querySelector("[data-server-components]");
const serverConfig = document.querySelector("[data-server-config]");

const dialog = document.querySelector("[data-text-dialog]");
const dialogScrim = document.querySelector("[data-dialog-scrim]");
const dialogForm = document.querySelector("[data-text-dialog-form]");
const dialogTitle = document.querySelector("[data-text-dialog-title]");
const dialogInput = document.querySelector("[data-text-dialog-input]");
const dialogTextarea = document.querySelector("[data-text-dialog-textarea]");
const toast = document.querySelector("[data-toast]");
const connectionBanner = document.querySelector("[data-restart-banner]");
const attachmentViewer = document.querySelector("[data-attachment-viewer]");
const attachmentViewerImage = document.querySelector("[data-attachment-viewer-image]");
const attachmentViewerLoading = document.querySelector("[data-attachment-viewer-loading]");
const attachmentViewerClose = document.querySelector("[data-attachment-viewer-close]");

const limitsRanges = document.querySelector("[data-limits-ranges]");
const limitsSubtitle = document.querySelector("[data-limits-subtitle]");
const limitsLoading = document.querySelector("[data-limits-loading]");
const limitsError = document.querySelector("[data-limits-error]");
const limitsErrorText = document.querySelector("[data-limits-error-text]");
const limitsEmpty = document.querySelector("[data-limits-empty]");
const limitsChartWrap = document.querySelector("[data-limits-chart-wrap]");
const limitsChart = document.querySelector("[data-limits-chart]");
const limitsTooltip = document.querySelector("[data-limits-tooltip]");
const limitsLegend = document.querySelector("[data-limits-legend]");
const limitsCredits = document.querySelector("[data-limits-credits]");
const currentLimitsSlots = [...document.querySelectorAll("[data-current-limits]")];
const usageRanges = document.querySelector("[data-usage-ranges]");
const usageSubtitle = document.querySelector("[data-usage-subtitle]");
const usageTitle = document.querySelector("[data-usage-title]");
const usageModes = document.querySelector("[data-usage-modes]");
const usageTotal = document.querySelector("[data-usage-total]");
const usageLoading = document.querySelector("[data-usage-loading]");
const usageError = document.querySelector("[data-usage-error]");
const usageErrorText = document.querySelector("[data-usage-error-text]");
const usageEmpty = document.querySelector("[data-usage-empty]");
const usageChartWrap = document.querySelector("[data-usage-chart-wrap]");
const usageChart = document.querySelector("[data-usage-chart]");
const usageTooltip = document.querySelector("[data-usage-tooltip]");
const usageNote = document.querySelector("[data-usage-note]");

/* --------------------------------------------------------- Telegram / темы */

let journalHtml = "";
let grouping = "date";
let usageUnit = "cr";
let usdRubRate = null;
let usdRubEffectiveDate = "";
let exchangeRatesInitialized = false;
let groupClaudeTasks = false;
const groupingStates = { date: null, week: null, month: null, task: null };
const TASK_GROUP_TURN_PAGE_SIZE = 30;
const taskGroupTurns = new WeakMap();
const telegram = window.Telegram?.WebApp;
const telegramInitData = String(telegram?.initData ?? "");
const telegramMode = Boolean(telegramInitData);
const localAccessMatch = /^#access=([A-Za-z0-9_-]{43,128})$/u.exec(window.location.hash);
const protectedLocalSessionReady = !telegramMode && localAccessMatch
  ? fetch("/api/local-session", {
      method: "POST",
      headers: {
        Authorization: `local ${localAccessMatch[1]}`,
        "Content-Type": "application/json",
      },
      body: "{}",
      cache: "no-store",
    }).then(async (response) => {
      if (!response.ok) throw new Error("Не удалось открыть защищённую локальную сессию Agent Hub.");
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    })
  : Promise.resolve();
const localSessionReady = Promise.all([
  protectedLocalSessionReady,
  window.AgentHubBrowserDeviceReady ?? Promise.resolve(),
]).then(() => undefined);
window.AgentHubLocalSessionReady = localSessionReady;
const vscodeMode = Boolean(window.__agentHubVscode);
const telegramPlatform = String(telegram?.platform ?? "").toLowerCase();
const mobileTelegramPlatforms = new Set(["android", "ios"]);
const compactSurfaceWidth = 860;

/* В embedded WebView window.innerWidth иногда описывает host-окно, а не
 * фактическую ширину раскладки документа. Например, Edge Web App на 390 px
 * сообщал 545 px, поэтому оставался в двухколоночном профиле и прокручивался
 * по горизонтали. clientWidth — CSS-ширина именно отрисовываемого документа. */
function layoutViewportWidth() {
  const documentWidth = Number(document.documentElement?.clientWidth ?? 0);
  return documentWidth > 0 ? documentWidth : window.innerWidth;
}

function resolveSurface() {
  if (telegramMode && mobileTelegramPlatforms.has(telegramPlatform)) return "mobile";
  return layoutViewportWidth() < compactSurfaceWidth ? "mobile" : "desktop";
}

function syncTelegramFullscreenButton() {
  if (!telegramFullscreenButton) return;
  const supported = telegramMode && typeof telegram?.requestFullscreen === "function";
  telegramFullscreenButton.hidden = !supported;
  if (!supported) return;
  const fullscreen = telegram?.isFullscreen === true;
  telegramFullscreenButton.setAttribute("aria-pressed", fullscreen ? "true" : "false");
  telegramFullscreenButton.title = fullscreen ? "Выйти из полного режима" : "Развернуть Mini App";
  telegramFullscreenButton.setAttribute("aria-label", telegramFullscreenButton.title);
}

let surface = resolveSurface();
document.documentElement.dataset.surface = surface;

function phoneComposerMode() {
  if (telegramMode && mobileTelegramPlatforms.has(telegramPlatform)) return true;
  return surface === "mobile"
    && globalThis.matchMedia?.("(pointer: coarse)")?.matches === true;
}

function syncComposerInputMode() {
  composerInput.placeholder = "Сообщение агенту…";
  composerInput.removeAttribute("title");
  composerSend.title = "Отправить";
}

syncComposerInputMode();

function readThemeCatalog() {
  const source = document.querySelector("[data-theme-catalog]")?.textContent ?? "";
  const catalog = JSON.parse(source);
  if (!Array.isArray(catalog) || !catalog.some((theme) => theme?.id === "orbit")) {
    throw new Error("Каталог тем Agent Hub повреждён");
  }
  return catalog;
}

const themeCatalog = readThemeCatalog();
const themes = Object.freeze(Object.fromEntries(themeCatalog.map((theme) => [theme.id, theme.color])));
const backgroundNames = Object.freeze(Object.fromEntries(themeCatalog.flatMap((theme) => (
  theme.backgrounds.map((background) => [background.id, background.name])
))));
const themeBackgrounds = Object.freeze(Object.fromEntries(themeCatalog.map((theme) => (
  [theme.id, theme.backgrounds.map((background) => background.id)]
))));
const backgroundAssets = Object.freeze(Object.fromEntries(themeCatalog.flatMap((theme) => (
  theme.backgrounds.filter((background) => background.assetUrl).map((background) => (
    [background.id, background.assetUrl]
  ))
))));
function cssBackgroundUrl(value) {
  return `url(${JSON.stringify(String(value ?? ""))})`;
}
/* CSS custom properties are consumed from backgrounds.css. Chromium resolves
   relative url() tokens there against that shared stylesheet, not against the
   theme stylesheet that declared the property. Catalog URLs are already exact
   HTTP or VS Code WebView URLs, so install them as canonical root overrides. */
for (const [background, url] of Object.entries(backgroundAssets)) {
  root.style.setProperty(`--${background}-image`, cssBackgroundUrl(url));
}
const deferredBackgroundAssets = new Set(themeCatalog.flatMap((theme) => (
  theme.backgrounds.filter((background) => background.preload).map((background) => background.id)
)));
const backgroundAssetLoads = new Map();
let backgroundRequestId = 0;
const themeAliases = Object.freeze(Object.fromEntries(themeCatalog.flatMap((theme) => (
  theme.aliases.map((alias) => [alias, theme.id])
))));
if (themeSelect) {
  themeSelect.replaceChildren(...themeCatalog.map((theme) => {
    const option = document.createElement("option");
    option.value = theme.id;
    option.textContent = theme.name;
    return option;
  }));
}
const groupings = new Set(["date", "week", "month", "task"]);
const usageUnits = new Set(["$", "rub", "cr", "pte"]);
const CREDITS_PER_USD = 25;
const PTE_PER_CREDIT = 8_000;
const USAGE_RANGE_KEY = "agent-hub:usage-range:v1";
const RANGE_SEQUENCE = ["6h", "24h", "7d", "30d", "all"];

function savedUsageRange() {
  try {
    return normalizeRange(localStorage.getItem(USAGE_RANGE_KEY));
  } catch {
    return "24h";
  }
}

const USAGE_MODE_KEY = "agent-hub:usage-mode:v1";

function savedUsageMode() {
  try {
    return localStorage.getItem(USAGE_MODE_KEY) === "rate" ? "rate" : "total";
  } catch {
    return "total";
  }
}

const usageState = {
  range: savedUsageRange(),
  mode: savedUsageMode(),
  status: "idle",
  payload: null,
  error: "",
};
const RANGE_LABELS = { "6h": "6 ч", "24h": "24 ч", "7d": "7 д", "30d": "30 д", all: "Всё время" };

function savedTheme() {
  try {
    const value = localStorage.getItem("agent-hub-theme");
    const selected = themeAliases[value] ?? value;
    return Object.hasOwn(themes, selected) ? selected : "orbit";
  } catch {
    return "orbit";
  }
}

/* Живые частицы тем.
 *
 * Плиткой это сделать нельзя: `background-repeat` повторяет один рисунок, и
 * глаз читает его как мелкую текстуру, а не как погоду — сколько планов ни
 * добавляй, регулярность остаётся. Поэтому каждая капля и каждая пылинка
 * здесь отдельный элемент со своими размерами, прозрачностью и скоростью:
 * непредсказуемость берётся из настоящего случайного распределения.
 *
 * Цена измерена: анимируется только transform, поэтому за пять секунд работы
 * дождя из 280 капель браузер не выполняет ни одного пересчёта стиля или
 * раскладки — всё уходит в композитор. На узком экране частиц вдвое меньше,
 * а при prefers-reduced-motion слой не создаётся вообще. */
/* Часовня получает ту же пыль, что склеп, а над гаванью идёт дождь: мокрая
   мостовая и блики на камне в кадре без него выглядят необъяснимо. */
const PARTICLE_BACKGROUNDS = Object.freeze(Object.fromEntries(themeCatalog.flatMap((theme) => (
  theme.backgrounds.filter((background) => background.particles).map((background) => (
    [background.id, background.particles]
  ))
))));
let particleLayer = null;

function particleCount(kind) {
  // ливень «Storm» заметно плотнее дождя «Тайги»
  if (kind === "downpour") return surface === "mobile" ? 220 : 460;
  if (kind === "rain") return surface === "mobile" ? 130 : 280;
  return surface === "mobile" ? 40 : 80;
}

function buildRainDrop(heavy = false) {
  const drop = document.createElement("span");
  const near = Math.random();
  if (heavy) {
    /* Ливень: струи длиннее и плотнее, падают вдвое быстрее и почти не
       различаются по глубине — стена воды, а не отдельные капли. */
    drop.style.setProperty("--x", `${Math.random() * 108 - 4}%`);
    drop.style.setProperty("--len", `${(34 + near * 58).toFixed(1)}px`);
    drop.style.setProperty("--thickness", `${(1.1 + near * 1.2).toFixed(2)}px`);
    drop.style.setProperty("--alpha", (0.3 + near * 0.34).toFixed(2));
    drop.style.setProperty("--dur", `${(0.62 - near * 0.3).toFixed(2)}s`);
    drop.style.setProperty("--delay", `-${(Math.random() * 2).toFixed(2)}s`);
    return drop;
  }
  // ближние капли длиннее, ярче и падают быстрее — этим читается глубина
  drop.style.setProperty("--x", `${Math.random() * 104 - 2}%`);
  drop.style.setProperty("--len", `${(8 + near * 14).toFixed(1)}px`);
  drop.style.setProperty("--thickness", `${(0.8 + near * 0.8).toFixed(2)}px`);
  drop.style.setProperty("--alpha", (0.2 + near * 0.3).toFixed(2));
  drop.style.setProperty("--dur", `${(1.45 - near * 0.7).toFixed(2)}s`);
  drop.style.setProperty("--delay", `-${(Math.random() * 2).toFixed(2)}s`);
  return drop;
}

function buildMote() {
  const mote = document.createElement("span");
  const near = Math.random();
  /* Пыль в свете факела: ближние пылинки крупнее и бледнее, дальние мельче и
     ярче, поднимаются медленно и слегка виляют вбок. */
  mote.style.setProperty("--x", `${8 + Math.random() * 94}%`);
  mote.style.setProperty("--size", `${(1.6 + near * 5).toFixed(1)}px`);
  mote.style.setProperty("--alpha", (0.7 - near * 0.4).toFixed(2));
  mote.style.setProperty("--drift", `${(Math.random() * 46 - 23).toFixed(0)}px`);
  mote.style.setProperty("--dur", `${(9 + Math.random() * 12).toFixed(1)}s`);
  mote.style.setProperty("--delay", `-${(Math.random() * 20).toFixed(1)}s`);
  return mote;
}

function buildParticleLayer(kind) {
  const layer = document.createElement("div");
  layer.className = kind === "motes" ? "motes" : `rain${kind === "downpour" ? " downpour" : ""}`;
  layer.setAttribute("aria-hidden", "true");
  const build = kind === "motes"
    ? buildMote
    : () => buildRainDrop(kind === "downpour");
  for (let index = 0; index < particleCount(kind); index += 1) layer.append(build());
  return layer;
}

function syncParticleLayer(background) {
  const kind = PARTICLE_BACKGROUNDS[background] ?? null;
  const allowed = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches !== true;
  if (!kind || !allowed) {
    particleLayer?.remove();
    particleLayer = null;
    return;
  }
  if (particleLayer?.isConnected && particleLayer.dataset.kind === kind) return;
  particleLayer?.remove();
  particleLayer = buildParticleLayer(kind);
  particleLayer.dataset.kind = kind;
  document.body.append(particleLayer);
}

function applyTheme(theme, { persist = false } = {}) {
  const candidate = themeAliases[theme] ?? theme;
  const selected = Object.hasOwn(themes, candidate) ? candidate : "orbit";
  document.documentElement.dataset.theme = selected;
  if (selected === "gothic") {
    for (const background of Object.keys(deferredBackgroundAssets)) {
      void preloadBackgroundAsset(background);
    }
  }
  const previousBackground = document.documentElement.dataset.background;
  populateBackgroundOptions(selected);
  if (previousBackground) {
    const nextBackground = normalizeBackground(selected, previousBackground);
    applyBackground(nextBackground, { persist: persist && nextBackground !== previousBackground });
  }
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

/* Разбивка по видам токенов занимала всю правую половину шапки дня и почти
   всегда была не нужна, поэтому по умолчанию она скрыта, а включается
   переключателем в панели «Вид». */
function savedBreakdown() {
  try {
    return localStorage.getItem("agent-hub-token-breakdown") === "on" ? "on" : "off";
  } catch {
    return "off";
  }
}

function applyBreakdown(value, { persist = false } = {}) {
  const state = value === "on" ? "on" : "off";
  root.dataset.tokenBreakdown = state;
  if (breakdownToggle) breakdownToggle.checked = state === "on";
  if (persist) {
    try {
      localStorage.setItem("agent-hub-token-breakdown", state);
    } catch {
      // Настройка останется активной до закрытия WebView.
    }
  }
}

function savedGrouping() {
  try {
    const value = localStorage.getItem("agent-hub-grouping");
    return groupings.has(value) ? value : "date";
  } catch {
    return "date";
  }
}

function selectGrouping(value, { persist = false } = {}) {
  grouping = groupings.has(value) ? value : "date";
  document.documentElement.dataset.grouping = grouping;
  groupSelect.value = grouping;
  if (persist) {
    try {
      localStorage.setItem("agent-hub-grouping", grouping);
    } catch {
      // Группировка останется активной до закрытия WebView.
    }
  }
}

function savedUsageUnit() {
  try {
    const value = localStorage.getItem("agent-hub-usage-unit");
    return usageUnits.has(value) ? value : "cr";
  } catch {
    return "cr";
  }
}

function selectUsageUnit(value, { persist = false } = {}) {
  usageUnit = usageUnits.has(value) ? value : "cr";
  root.dataset.usageUnit = usageUnit;
  for (const button of usageUnitButtons) {
    const active = button.dataset.usageUnit === usageUnit;
    button.setAttribute("aria-pressed", String(active));
    button.toggleAttribute("data-active", active);
  }
  if (persist) {
    try {
      localStorage.setItem("agent-hub-usage-unit", usageUnit);
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
  }
  refreshUsageUnits();
  renderUsageHistory();
  if (journalHtml) renderJournal();
}

function savedClaudeGrouping() {
  try {
    return localStorage.getItem("agent-hub-group-claude") === "on";
  } catch {
    return false;
  }
}

function selectClaudeGrouping(value, { persist = false } = {}) {
  groupClaudeTasks = value === true;
  if (claudeGroupToggle) claudeGroupToggle.checked = groupClaudeTasks;
  if (persist) {
    try {
      localStorage.setItem("agent-hub-group-claude", groupClaudeTasks ? "on" : "off");
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
  }
}

telegram?.ready();
telegram?.expand();
telegram?.disableVerticalSwipes?.();
syncTelegramFullscreenButton();
telegramFullscreenButton?.addEventListener("click", () => {
  if (telegram?.isFullscreen === true) telegram?.exitFullscreen?.();
  else telegram?.requestFullscreen?.();
});
applyTheme(savedTheme());
applyBackground(savedBackground(root.dataset.theme));
applyBreakdown(savedBreakdown());
selectUsageUnit(savedUsageUnit());
selectClaudeGrouping(savedClaudeGrouping());
breakdownToggle?.addEventListener("change", () => {
  applyBreakdown(breakdownToggle.checked ? "on" : "off", { persist: true });
});
claudeGroupToggle?.addEventListener("change", () => {
  selectClaudeGrouping(claudeGroupToggle.checked, { persist: true });
  if (journalHtml) renderJournal();
});
for (const button of usageUnitButtons) {
  button.addEventListener("click", () => selectUsageUnit(button.dataset.usageUnit, { persist: true }));
}
selectGrouping(savedGrouping());
themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value, { persist: true });
  window.__agentHubVscode?.postMessage({ type: "theme", theme: themeSelect.value });
});
backgroundSelect?.addEventListener("change", () => {
  applyBackground(backgroundSelect.value, { persist: true });
});
groupSelect.addEventListener("change", () => {
  if (journalRendered) groupingStates[grouping] = captureOpenState();
  selectGrouping(groupSelect.value, { persist: true });
  if (journalHtml) renderJournal();
});

/* Нативное раскрытое меню select рисует операционная система, поэтому его
   выделение не следует токенам темы. Обёртка сохраняет исходный select как
   источник значения и событий, но показывает единый доступный listbox. */
let themedSelectSequence = 0;
let openThemedSelect = null;

function themedSelectOptions(select) {
  return [...select.options].map((option, index) => ({
    disabled: option.disabled,
    index,
    label: option.label || option.textContent || option.value,
    selected: option.selected,
    value: option.value,
  }));
}

function enhanceThemedSelect(select) {
  if (!(select instanceof HTMLSelectElement) || select.multiple || select.dataset.themedSelectReady) return;
  select.dataset.themedSelectReady = "true";
  select.classList.add("themed-select-native");
  select.setAttribute("aria-hidden", "true");
  select.tabIndex = -1;

  const shell = document.createElement("div");
  shell.className = "themed-select";
  const button = document.createElement("button");
  button.className = "themed-select-button";
  button.type = "button";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-label", select.getAttribute("aria-label") || "Выбор значения");
  const value = document.createElement("span");
  value.className = "themed-select-value";
  const chevron = document.createElement("span");
  chevron.className = "themed-select-chevron";
  chevron.setAttribute("aria-hidden", "true");
  button.append(value, chevron);
  select.before(shell);
  shell.append(select, button);

  const menu = document.createElement("div");
  menu.className = "themed-select-menu";
  menu.id = `themed-select-${++themedSelectSequence}`;
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", button.getAttribute("aria-label"));
  button.setAttribute("aria-controls", menu.id);
  document.body.append(menu);

  const state = { button, menu, select, shell, value };
  select.__themedSelect = state;

  const options = () => themedSelectOptions(select);
  const enabledFrom = (start, direction) => {
    const items = options();
    if (!items.length) return -1;
    let index = start;
    for (let count = 0; count < items.length; count += 1) {
      index = (index + direction + items.length) % items.length;
      if (!items[index].disabled) return index;
    }
    return -1;
  };
  const focusOption = (index) => {
    const option = menu.querySelector(`[data-option-index="${index}"]`);
    option?.focus({ preventScroll: true });
    if (!option) return;
    menu.setAttribute("aria-activedescendant", option.id);
    const optionTop = option.offsetTop;
    const optionBottom = optionTop + option.offsetHeight;
    if (optionTop < menu.scrollTop) menu.scrollTop = optionTop;
    else if (optionBottom > menu.scrollTop + menu.clientHeight) {
      menu.scrollTop = optionBottom - menu.clientHeight;
    }
  };
  const positionMenu = () => {
    if (menu.hidden) return;
    const rect = button.getBoundingClientRect();
    const margin = 8;
    const below = window.innerHeight - rect.bottom - margin;
    const above = rect.top - margin;
    const maxHeight = Math.max(128, Math.min(320, Math.max(below, above)));
    menu.style.left = `${Math.max(margin, Math.min(rect.left, window.innerWidth - rect.width - margin))}px`;
    menu.style.width = `${rect.width}px`;
    menu.style.maxHeight = `${maxHeight}px`;
    menu.style.top = below >= Math.min(menu.scrollHeight, maxHeight) || below >= above
      ? `${rect.bottom + 5}px`
      : `${Math.max(margin, rect.top - Math.min(menu.scrollHeight, maxHeight) - 5)}px`;
  };
  const close = ({ restoreFocus = false } = {}) => {
    if (menu.hidden) return;
    menu.hidden = true;
    menu.removeAttribute("aria-activedescendant");
    shell.removeAttribute("data-open");
    button.setAttribute("aria-expanded", "false");
    if (openThemedSelect === state) openThemedSelect = null;
    if (restoreFocus) button.focus();
  };
  const choose = (index) => {
    const option = select.options[index];
    if (!option || option.disabled) return;
    select.selectedIndex = index;
    select.dispatchEvent(new Event("input", { bubbles: true }));
    select.dispatchEvent(new Event("change", { bubbles: true }));
    close({ restoreFocus: true });
  };
  const render = () => {
    const items = options();
    menu.replaceChildren(...items.map((option) => {
      const item = document.createElement("div");
      item.className = "themed-select-option";
      item.dataset.optionIndex = String(option.index);
      item.dataset.value = option.value;
      item.id = `${menu.id}-option-${option.index}`;
      item.tabIndex = -1;
      item.textContent = option.label;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(option.selected));
      item.setAttribute("aria-disabled", String(option.disabled));
      if (option.disabled) item.dataset.disabled = "true";
      return item;
    }));
    const selected = items.find((option) => option.selected) ?? items[0];
    value.textContent = selected?.label ?? "";
    button.disabled = select.disabled;
    if (!menu.hidden) positionMenu();
  };
  const open = () => {
    if (button.disabled) return;
    if (openThemedSelect && openThemedSelect !== state) {
      openThemedSelect.menu.hidden = true;
      openThemedSelect.shell.removeAttribute("data-open");
      openThemedSelect.button.setAttribute("aria-expanded", "false");
    }
    render();
    menu.hidden = false;
    shell.dataset.open = "true";
    button.setAttribute("aria-expanded", "true");
    openThemedSelect = state;
    positionMenu();
    requestAnimationFrame(() => focusOption(Math.max(0, select.selectedIndex)));
  };

  button.addEventListener("click", () => (menu.hidden ? open() : close()));
  button.addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End", "Enter", " "].includes(event.key)) return;
    event.preventDefault();
    open();
    const last = Math.max(0, select.options.length - 1);
    const target = ["Enter", " "].includes(event.key) ? select.selectedIndex
      : event.key === "Home" ? enabledFrom(last, 1)
      : event.key === "End" ? enabledFrom(0, -1)
        : enabledFrom(select.selectedIndex, event.key === "ArrowUp" ? -1 : 1);
    requestAnimationFrame(() => focusOption(target));
  });
  menu.addEventListener("click", (event) => {
    const option = event.target.closest("[data-option-index]");
    if (option) choose(Number(option.dataset.optionIndex));
  });
  menu.addEventListener("keydown", (event) => {
    const current = Number(document.activeElement?.dataset?.optionIndex ?? select.selectedIndex);
    if (event.key === "Escape" || event.key === "Tab") {
      close({ restoreFocus: event.key === "Escape" });
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      choose(current);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const last = Math.max(0, select.options.length - 1);
    const target = event.key === "Home" ? enabledFrom(last, 1)
      : event.key === "End" ? enabledFrom(0, -1)
        : enabledFrom(current, event.key === "ArrowUp" ? -1 : 1);
    focusOption(target);
  });
  select.addEventListener("change", render);
  const selectObserver = new MutationObserver(render);
  selectObserver.observe(select, { attributes: true, childList: true, subtree: true });
  state.close = close;
  state.destroy = () => {
    close();
    selectObserver.disconnect();
    menu.remove();
    delete select.__themedSelect;
  };
  state.position = positionMenu;
  state.render = render;
  render();
}

function enhanceThemedSelects(rootNode = document) {
  if (rootNode instanceof HTMLSelectElement) enhanceThemedSelect(rootNode);
  rootNode.querySelectorAll?.("select").forEach(enhanceThemedSelect);
}

function cleanupThemedSelects(rootNode) {
  const selects = rootNode instanceof HTMLSelectElement
    ? [rootNode]
    : [...(rootNode.querySelectorAll?.("select[data-themed-select-ready]") ?? [])];
  for (const select of selects) {
    if (!select.isConnected) select.__themedSelect?.destroy();
  }
}

enhanceThemedSelects();
new MutationObserver((records) => {
  for (const record of records) {
    for (const node of record.removedNodes) {
      if (node instanceof Element) cleanupThemedSelects(node);
    }
    for (const node of record.addedNodes) {
      if (node instanceof Element) enhanceThemedSelects(node);
    }
  }
}).observe(document.body, { childList: true, subtree: true });
new MutationObserver(() => {
  document.querySelectorAll("select[data-themed-select-ready]").forEach((select) => select.__themedSelect?.render());
}).observe(root, { attributes: true, attributeFilter: ["data-theme", "data-background", "data-grouping"] });
document.addEventListener("pointerdown", (event) => {
  if (!openThemedSelect || openThemedSelect.shell.contains(event.target) || openThemedSelect.menu.contains(event.target)) return;
  openThemedSelect.close();
});
window.addEventListener("resize", () => openThemedSelect?.position());
window.addEventListener("scroll", (event) => {
  if (event.target !== openThemedSelect?.menu) openThemedSelect?.position();
}, true);

/* --------------------------------------------------------- маленькие утилиты */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("data-") || key === "role" || key === "type" || key === "title"
      || key === "aria-label" || key === "aria-pressed" || key === "aria-expanded"
      || key === "placeholder" || key === "value") {
      node.setAttribute(key, value === true ? "" : String(value));
    } else if (key in node) {
      node[key] = value;
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function sameData(left, right) {
  if (left === right) return true;
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

/* Компактное «сколько прошло» для последней активности задачи. */
function formatRelativeTime(input) {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "только что";
  if (diff < hour) return `${Math.floor(diff / minute)} мин`;
  if (diff < day) return `${Math.floor(diff / hour)} ч`;
  if (diff < 7 * day) return `${Math.floor(diff / day)} дн`;
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

/* Живое время выполнения: секунды видны сразу, длинные ходы не распухают. */
function formatRunningDuration(input, now = Date.now()) {
  const startedAt = input instanceof Date ? input.getTime() : Date.parse(String(input ?? ""));
  if (!Number.isFinite(startedAt)) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1_000));
  if (seconds < 60) return `${seconds}с`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}м ${String(seconds % 60).padStart(2, "0")}с`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}ч ${String(minutes % 60).padStart(2, "0")}м`;
  const days = Math.floor(hours / 24);
  return `${days}д ${String(hours % 24).padStart(2, "0")}ч`;
}

function refreshTaskDurations() {
  const now = Date.now();
  for (const node of taskList.querySelectorAll(".task-time[data-task-started-at]")) {
    node.textContent = formatRunningDuration(node.dataset.taskStartedAt, now);
  }
}

let toastTimer = 0;
function showToast(message) {
  if (!message) return;
  toast.textContent = message;
  toast.hidden = false;
  toast.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toast.classList.remove("visible");
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 220);
  }, 2600);
}

/* ------------------------------------------------------------ шина событий */

const listeners = new Map();

/* Действие пользователя во внешний мир. Backend подключается двумя способами:
 *   document.addEventListener("agenthub:intent", (e) => …e.detail…)
 *   AgentHub.on("message:send", (detail) => …)  */
function emit(type, detail = {}) {
  const payload = { type, ...detail };
  document.dispatchEvent(new CustomEvent("agenthub:intent", { detail: payload }));
  for (const handler of listeners.get(type) ?? []) {
    try {
      handler(detail, type);
    } catch (error) {
      console.error("agenthub intent handler failed", type, error);
    }
  }
}

/* ------------------------------------------------------------- состояние UI */

const state = {
  tasks: [],
  selectedId: null,
  messages: new Map(),   // taskId -> message[]
  taskDiffs: new Map(),  // taskId -> { text, open }
  historyPagination: new Map(), // taskId -> { hasOlder, loading }
  live: new Map(),       // taskId -> live | null
  approvals: new Map(),  // taskId -> approval[]
  queue: new Map(),      // taskId -> queued[]
  options: { model: [], reasoning: [], mode: [], project: [] },
  selection: {},
  status: null,
  connection: "",
  connectionBlockingCount: 0,
  searchQuery: "",
  searchResults: new Map(),
  searchLoading: false,
};

/* Черновики принадлежат конкретному клиенту и задаче. Вложение остаётся в
 * памяти страницы: data:-URL скриншотов может превысить лимит localStorage.
 * Набранный текст и аннотации сохраняем синхронно, чтобы жест «назад»,
 * пересоздание WebView или краткая потеря связи не стирали сообщение. */
const drafts = new Map();
const DRAFT_STORAGE_VERSION = "agent-hub:composer-drafts:v1";
const DRAFT_STORAGE_MAX_TASKS = 100;
const DRAFT_STORAGE_MAX_TEXT = 100_000;
let pendingComposerRequest = null;
const retryComposerRequests = new Map();

function draftStorageSurface() {
  if (vscodeMode) return "vscode";
  if (window.AgentHubAndroid) return "android";
  if (telegramMode) return `telegram:${telegramPlatform || "unknown"}`;
  return "web";
}

function draftStorageKey() {
  return `${DRAFT_STORAGE_VERSION}:${draftStorageSurface()}`;
}

function normalizedDraftText(value) {
  return String(value ?? "").slice(0, DRAFT_STORAGE_MAX_TEXT);
}

function normalizedDraftAnnotations(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((annotation) => ({
    quote: String(annotation?.quote ?? "").slice(0, 400),
    annotation: String(annotation?.annotation ?? annotation?.comment ?? "").slice(0, 20_000),
  })).filter((annotation) => annotation.quote);
}

function restorePersistedDrafts() {
  let persisted;
  try {
    persisted = JSON.parse(localStorage.getItem(draftStorageKey()) ?? "[]");
  } catch {
    return;
  }
  if (!Array.isArray(persisted)) return;
  for (const entry of persisted.slice(0, DRAFT_STORAGE_MAX_TASKS)) {
    const taskId = String(entry?.taskId ?? "").trim();
    if (!taskId) continue;
    const text = normalizedDraftText(entry.text);
    const annotations = normalizedDraftAnnotations(entry.annotations);
    if (!text && annotations.length === 0) continue;
    drafts.set(taskId, { text, attachments: [], annotations });
  }
}

function persistDrafts() {
  const persisted = [...drafts.entries()]
    .filter(([taskId, draft]) => String(taskId).trim() && (draft?.text || draft?.annotations?.length))
    .slice(-DRAFT_STORAGE_MAX_TASKS)
    .map(([taskId, draft]) => ({
      taskId,
      text: normalizedDraftText(draft.text),
      annotations: normalizedDraftAnnotations(draft.annotations),
    }));
  try {
    if (persisted.length) localStorage.setItem(draftStorageKey(), JSON.stringify(persisted));
    else localStorage.removeItem(draftStorageKey());
    return true;
  } catch {
    // Privacy-mode WebView or a full storage quota: the in-memory draft still survives navigation.
    return persisted.length === 0;
  }
}

function currentTask() {
  return state.tasks.find((task) => task.id === state.selectedId) ?? null;
}

/* =========================================================== роутер видов */

const NAVIGATION_TAB_KEY = "agent-hub-navigation-tab-v1";
const navigationTabs = new Set(["tasks", "chat", "journal", "statistics", "server"]);

function currentNavigationTab() {
  return ["journal", "statistics", "server"].includes(root.dataset.view)
    ? root.dataset.view
    : (root.dataset.pane === "chat" ? "chat" : "tasks");
}

function storedNavigationTab() {
  try {
    const stored = localStorage.getItem(NAVIGATION_TAB_KEY);
    return navigationTabs.has(stored) ? stored : "tasks";
  } catch {
    // Приватный WebView может запрещать localStorage.
    return "tasks";
  }
}

function persistNavigationTab() {
  try {
    localStorage.setItem(NAVIGATION_TAB_KEY, currentNavigationTab());
  } catch {
    // Состояние текущей вкладки остаётся в DOM до закрытия страницы.
  }
}

function activateView(view) {
  if (view === "journal") ensureJournalLoaded();
  if (view === "statistics") {
    requestUsageHistory(usageState.range);
    requestLimits(limitsState.range);
  }
  if (view === "server") emit("devices:refresh");
}

function savedBackground(fallback) {
  try {
    const value = localStorage.getItem("agent-hub-background");
    return normalizeBackground(fallback, value);
  } catch {
    return fallback;
  }
}

function backgroundAssetUrl(background) {
  return backgroundAssets[background] ?? "";
}

function preloadBackgroundAsset(background) {
  const url = backgroundAssetUrl(background);
  if (!url || typeof Image !== "function") return Promise.resolve(true);
  if (backgroundAssetLoads.has(url)) return backgroundAssetLoads.get(url);
  const loading = new Promise((resolve) => {
    const image = document.createElement("img");
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      resolve(loaded);
    };
    image.onload = () => {
      if (typeof image.decode !== "function") { finish(true); return; }
      void image.decode().then(() => finish(true), () => finish(true));
    };
    image.onerror = () => finish(false);
    image.src = url;
    if (image.complete && image.naturalWidth > 0) image.onload();
  });
  backgroundAssetLoads.set(url, loading);
  return loading;
}

function commitBackground(selected, persist) {
  root.dataset.background = selected;
  root.dataset.backgroundOverride = String(selected !== root.dataset.theme);
  delete root.dataset.backgroundLoading;
  if (backgroundSelect) backgroundSelect.value = selected;
  syncParticleLayer(selected);
  if (persist) {
    try {
      localStorage.setItem("agent-hub-background", selected);
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
  }
}

function applyBackground(background, { persist = false } = {}) {
  const selected = normalizeBackground(root.dataset.theme, background);
  const requestId = ++backgroundRequestId;
  if (backgroundSelect) backgroundSelect.value = selected;
  if (!deferredBackgroundAssets.has(selected) || typeof Image !== "function") {
    commitBackground(selected, persist);
    return;
  }
  root.dataset.backgroundLoading = "true";
  void preloadBackgroundAsset(selected).then((loaded) => {
    if (requestId !== backgroundRequestId) return;
    if (loaded) { commitBackground(selected, persist); return; }
    delete root.dataset.backgroundLoading;
    if (backgroundSelect) backgroundSelect.value = root.dataset.background;
  });
}

function backgroundsForTheme(theme) {
  return themeBackgrounds[theme] ?? ["orbit"];
}

function normalizeBackground(theme, candidate) {
  const allowed = backgroundsForTheme(theme);
  return allowed.includes(candidate) ? candidate : allowed[0];
}

function populateBackgroundOptions(theme = root.dataset.theme) {
  if (!backgroundSelect) return;
  backgroundSelect.replaceChildren();
  for (const value of backgroundsForTheme(theme)) {
    const label = backgroundNames[value] ?? value;
    backgroundSelect.append(el("option", { value, text: label }));
  }
}

function setView(view, { persist = true, activate = true } = {}) {
  const next = ["journal", "statistics", "server"].includes(view) ? view : "chat";
  root.dataset.view = next;
  for (const button of document.querySelectorAll("[data-view-button]")) {
    button.setAttribute("aria-pressed", String(button.dataset.viewButton === next));
  }
  const title = document.querySelector("[data-view-title]");
  if (title) {
    /* Заголовок раздела короче и одинаковой длины на латинице; вкладки
       переключателя остаются русскими. */
    title.textContent = next === "journal"
      ? "Log"
      : next === "statistics"
        ? "Stats"
        : next === "server"
          ? "Server"
          : "Chat";
  }
  syncMobileNav();
  if (activate) activateView(next);
  if (persist) persistNavigationTab();
}

function setPane(pane, { persist = true } = {}) {
  root.dataset.pane = pane === "chat" ? "chat" : "tasks";
  syncMobileNav();
  if (persist) persistNavigationTab();
}

function syncMobileNav() {
  const active = ["journal", "statistics", "server"].includes(root.dataset.view)
    ? root.dataset.view
    : (root.dataset.pane === "chat" ? "chat" : "tasks");
  for (const button of document.querySelectorAll("[data-mobile-button]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mobileButton === active));
  }
}

for (const button of document.querySelectorAll("[data-view-button]")) {
  button.addEventListener("click", () => setView(button.dataset.viewButton));
}
for (const button of document.querySelectorAll("[data-mobile-button]")) {
  button.addEventListener("click", () => {
    const target = button.dataset.mobileButton;
    if (["journal", "statistics", "server"].includes(target)) { setView(target); return; }
    setView("chat");
    setPane(target === "chat" ? "chat" : "tasks");
  });
}

function syncSurface() {
  const nextSurface = resolveSurface();
  if (nextSurface !== surface) {
    surface = nextSurface;
    document.documentElement.dataset.surface = surface;
    syncComposerInputMode();
    syncCollapseTurnButtons();
    // частиц на телефоне вдвое меньше, поэтому слой пересобирается
    particleLayer?.remove();
    particleLayer = null;
    syncParticleLayer(document.documentElement.dataset.background);
    if (journalRendered) prepareMobileControls();
  }
}

window.addEventListener("resize", syncSurface);
telegram?.onEvent?.("viewportChanged", syncSurface);
telegram?.onEvent?.("fullscreenChanged", () => {
  syncSurface();
  syncTelegramFullscreenButton();
});
telegram?.onEvent?.("fullscreenFailed", (event) => {
  syncTelegramFullscreenButton();
  const reason = String(event?.error ?? "UNSUPPORTED");
  telegram?.showAlert?.(`Telegram не развернул Mini App: ${reason}`);
});

/* ============================================================ список задач */

const providerLabels = { codex: "Codex", claude: "Claude" };

function shortModelLabel(value) {
  const source = String(value ?? "").trim();
  if (!source) return "";
  const normalized = source.toLowerCase();
  const named = [
    ["terra", "Terra"],
    ["luna", "Luna"],
    ["sol", "Sol"],
    ["opus", "Opus"],
    ["sonnet", "Sonnet"],
    ["haiku", "Haiku"],
    ["spark", "Spark"],
  ].find(([needle]) => normalized.includes(needle));
  if (named) return named[1];
  const version = normalized.match(/(?:gpt|codex)[- ]?(\d+(?:\.\d+)?)/u)?.[1];
  if (version) return normalized.includes("mini") ? `${version} Mini` : version;
  return source.replace(/^claude[- ]*/iu, "").slice(0, 12);
}

/* Ранг модели виден по насыщенности плашки. Цвета берутся из токенов темы,
   поэтому «Магма» подсветит флагман оранжевым, а «Озеро» — зелёным, и ни одна
   тема не получает чужой палитры. */
function modelTier(value) {
  const normalized = String(value ?? "").toLowerCase();
  if (!normalized) return null;
  /* Sol, Terra и Luna — варианты одного поколения, поэтому решает суффикс, а не
     номер: «GPT-5.6-Terra» обычная, хотя версия старше флагманской 5.5. Номер
     смотрим только тогда, когда варианта в названии нет. */
  if (/\bsol\b|opus|pro\b|ultra|max\b/u.test(normalized)) return "flagship";
  if (/terra|sonnet/u.test(normalized)) return "balanced";
  if (/luna|haiku|spark|nano|flash|lite|mini/u.test(normalized)) return "light";
  const version = Number(normalized.match(/(\d+(?:\.\d+)?)/u)?.[1]);
  if (!Number.isFinite(version)) return "balanced";
  if (version >= 5.5) return "flagship";
  if (version >= 5.4) return "balanced";
  return "light";
}

function renderTasks() {
  const filter = (taskFilter.value ?? "").trim().toLowerCase();
  const visible = state.tasks.filter((task) => {
    if (!filter) return true;
    const local = `${task.title ?? ""} ${task.project ?? ""} ${task.agentLabel ?? ""}`
      .toLowerCase().includes(filter);
    return local || state.searchResults.has(task.id);
  });
  taskList.replaceChildren();
  for (const task of visible) taskList.append(renderTaskItem(task));

  const hasTasks = state.tasks.length > 0;
  taskEmpty.hidden = hasTasks;
  if (hasTasks && visible.length === 0) {
    taskEmpty.hidden = false;
    taskEmpty.textContent = "Ничего не найдено по запросу.";
  } else {
    taskEmpty.textContent = "Пока нет задач. Создайте новую задачу кнопкой «+».";
  }
  taskCount.hidden = !hasTasks;
  taskCount.textContent = String(state.tasks.length);
}

function renderTaskItem(task) {
  const provider = String(task.provider ?? "none");
  const selected = task.id === state.selectedId;

  const item = el("li", {
    class: "task-item",
    "data-task-id": task.id,
    "data-provider": provider,
    "data-selected": selected ? "" : null,
    "data-running": task.running ? "" : null,
    "data-unread": task.unread ? "" : null,
    role: "button",
    tabindex: "0",
    "aria-pressed": String(selected),
  });

  const dot = el("span", { class: "provider-dot", "aria-hidden": "true" });

  const agentLabel = task.agentLabel || providerLabels[provider] || "Агент";
  const meta = el("div", { class: "task-meta" }, [
    el("span", { class: "task-agent", text: agentLabel }),
    task.modelLabel
      ? el("span", {
        class: "task-agent task-model",
        "data-model-tier": modelTier(task.modelLabel),
        text: shortModelLabel(task.modelLabel),
        title: task.modelLabel,
      })
      : null,
    task.statusLabel
      ? el("span", { class: "task-status", "data-status": task.status || "", text: task.statusLabel })
      : null,
    task.runtimeLabel
      ? el("span", {
        class: "task-runtime",
        text: task.runtimeLabel,
        title: task.runtimeTitle || task.runtimeLabel,
      })
      : null,
  ]);

  const time = el("span", {
    class: "task-time",
    text: task.running && task.startedAt
      ? formatRunningDuration(task.startedAt)
      : formatRelativeTime(task.lastActivity),
    title: task.running && task.startedAt
      ? `Выполняется с ${new Date(task.startedAt).toLocaleString("ru-RU")}`
      : task.lastActivity ? new Date(task.lastActivity).toLocaleString("ru-RU") : "",
    "data-task-started-at": task.running && task.startedAt ? task.startedAt : null,
  });

  const titleRow = el("div", { class: "task-title-row" }, [
    el("span", { class: "task-title", text: task.title || "Без названия" }),
    time,
  ]);

  const footer = el("div", { class: "task-footer" }, [
    meta,
    task.unread ? el("span", { class: "task-unread", title: "Есть непрочитанный ответ" }) : null,
  ]);

  const searchResult = state.searchResults.get(task.id);
  const searchMatches = searchResult?.matches ?? [];
  const body = el("div", { class: "task-body" }, [
    titleRow,
    footer,
    searchMatches.length
      ? el("div", { class: "task-search-hits" }, searchMatches.map((match) => el("button", {
        type: "button",
        class: "task-search-hit",
        "data-search-turn": match.turnId,
        "data-search-turn-thread": match.turnThreadId ?? task.threadId,
        "data-search-provider": searchResult.provider ?? task.provider,
        "data-search-task-thread": searchResult.threadId ?? task.threadId,
        text: `${match.field}: ${match.snippet}`,
        title: `Открыть ход: ${match.field}: ${match.snippet}`,
      })))
      : null,
  ]);
  item.append(dot, body);
  return item;
}

taskList.addEventListener("click", (event) => {
  const searchTurn = event.target.closest("[data-search-turn]");
  if (searchTurn) {
    event.preventDefault();
    event.stopPropagation();
    emit("turn:open", {
      provider: searchTurn.dataset.searchProvider,
      taskThreadId: searchTurn.dataset.searchTaskThread,
      turnThreadId: searchTurn.dataset.searchTurnThread,
      turnId: searchTurn.dataset.searchTurn,
    });
    return;
  }
  const item = event.target.closest("[data-task-id]");
  if (item) selectTaskFromUi(item.dataset.taskId);
});
taskList.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const item = event.target.closest("[data-task-id]");
  if (!item) return;
  event.preventDefault();
  selectTaskFromUi(item.dataset.taskId);
});
let taskSearchTimer = null;
taskFilter.addEventListener("input", () => {
  const query = String(taskFilter.value ?? "").trim();
  state.searchQuery = query;
  if (query.length < 2) {
    state.searchResults.clear();
    state.searchLoading = false;
    clearTimeout(taskSearchTimer);
    renderTasks();
    return;
  }
  renderTasks();
  clearTimeout(taskSearchTimer);
  taskSearchTimer = window.setTimeout(() => {
    state.searchLoading = true;
    emit("search:query", { query });
  }, 250);
});

function selectTaskFromUi(id) {
  if (!id) return;
  saveDraft();
  state.selectedId = id;
  for (const task of state.tasks) task.selected = task.id === id;
  renderTasks();
  renderChat();
  setPane("chat");
  emit("task:select", { id });
}

/* ================================================================== чат */

let activeChatId = null;

function renderChat() {
  const task = currentTask();
  const hasTask = Boolean(task);
  chatEmpty.hidden = hasTask;
  chatPane.hidden = !hasTask;
  if (!hasTask) {
    activeChatId = null;
    setDialogSettingsOpen(false);
    return;
  }
  const taskChanged = activeChatId !== task.id;

  chatTitle.textContent = task.title || "Без названия";
  chatProviderDot.dataset.provider = String(task.provider ?? "none");
  chatProviderDot.setAttribute("data-provider", String(task.provider ?? "none"));
  chatSubtitle.replaceChildren(...buildSubtitleChips(task));
  renderDialogSettings();
  chatRunning.hidden = !task.running;
  for (const stop of chatStops) stop.hidden = !task.running;
  renderContextUsage(task);

  if (taskChanged) {
    activeChatId = task.id;
    renderMessages({ forceBottom: true });
  }
  renderLive();
  renderApprovals();
  renderQueue();
  // Композер восстанавливаем только при реальной смене задачи, чтобы фоновые
  // обновления статуса не сбрасывали курсор и набранный текст.
  if (taskChanged) restoreDraft();
}

function renderContextUsage(task) {
  if (!contextUsageButton) return;
  const context = task?.context;
  const available = task?.provider === "codex" && Number(context?.modelContextWindow) > 0;
  contextUsageButton.hidden = !available;
  if (!available) return;
  const percent = Math.max(0, Math.min(100, Number(context.percent) || 0));
  const used = Math.max(0, Number(context.usedTokens) || 0);
  const total = Math.max(0, Number(context.modelContextWindow) || 0);
  const cleaningImages = context.compaction?.stage === "cleaning-images";
  contextLabel.textContent = context.compacting ? "↻" : context.usagePending ? "…" : `${Math.round(percent)}%`;
  contextRing.style.setProperty("--context-percent", `${percent}%`);
  contextUsageButton.title = context.compacting
    ? cleaningImages
      ? "Свёртка создана. Удаляются дубликаты изображений…"
      : "Контекст сворачивается…"
    : context.usagePending
      ? "Контекст свёрнут. Ожидается обновлённый объём…"
    : `Контекст: ${used.toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")}. Нажмите, чтобы свернуть.`;
  contextUsageButton.disabled = Boolean(task.running || context.compacting || context.usagePending);
  contextUsageButton.toggleAttribute("data-compacting", Boolean(context.compacting));
}

function buildSubtitleChips(task) {
  const parts = [
    [task.agentLabel || providerLabels[task.provider] || null, null],
    [task.modelLabel || null, modelTier(task.modelLabel)],
    [task.reasoningLabel || null, null],
    [task.modeLabel || null, null],
    [task.runtimeLabel || null, null],
    [task.project || null, null],
  ].filter(([part]) => part);
  return parts.map(([part, tier], index) => el("span", {
    class: "chat-chip",
    "data-order": index,
    "data-model-tier": tier,
    text: part,
  }));
}

function chatIsNearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 120;
}

function pinChatToBottom() {
  const apply = () => { chatScroll.scrollTop = chatScroll.scrollHeight; };
  apply();
  // Финальная карточка нередко приходит одновременно с удалением live-блока.
  // Два кадра дают браузеру завершить оба reflow, прежде чем фиксировать низ.
  window.requestAnimationFrame(() => {
    apply();
    window.requestAnimationFrame(apply);
  });
}

let attachmentViewerOpen = false;

function openAttachmentViewer({ dataUrl = "", name = "Изображение" } = {}) {
  attachmentViewerOpen = true;
  attachmentViewer.hidden = false;
  attachmentViewerImage.hidden = !dataUrl;
  attachmentViewerLoading.hidden = Boolean(dataUrl);
  attachmentViewerImage.alt = name;
  attachmentViewerImage.src = dataUrl;
  root.dataset.overlay = "attachment";
}

function showAttachmentViewer({ dataUrl, name = "Изображение" } = {}) {
  if (!attachmentViewerOpen) openAttachmentViewer();
  attachmentViewerImage.alt = name;
  attachmentViewerImage.src = String(dataUrl ?? "");
  attachmentViewerImage.hidden = !dataUrl;
  attachmentViewerLoading.hidden = Boolean(dataUrl);
}

function closeAttachmentViewer() {
  if (!attachmentViewerOpen) return false;
  attachmentViewerOpen = false;
  attachmentViewer.hidden = true;
  attachmentViewerImage.removeAttribute("src");
  attachmentViewerImage.hidden = true;
  attachmentViewerLoading.hidden = false;
  delete root.dataset.overlay;
  return true;
}

function navigateBack() {
  saveDraft();
  if (closeAttachmentViewer()) return true;
  if (settingsPanel?.classList.contains("open")) {
    closePanel();
    return true;
  }
  if (root.dataset.view !== "chat") {
    setView("chat");
    setPane("tasks");
    return true;
  }
  if (root.dataset.view === "chat" && root.dataset.pane === "chat") {
    setPane("tasks");
    return true;
  }
  return false;
}

attachmentViewerClose.addEventListener("click", closeAttachmentViewer);
attachmentViewer.addEventListener("click", (event) => {
  if (event.target === attachmentViewer) closeAttachmentViewer();
});

const EDGE_SWIPE_ZONE = 32;
const EDGE_SWIPE_DISTANCE = 52;
let swipeStart = null;

function swipeIgnoredTarget(target) {
  return Boolean(target?.closest?.("input, textarea, select, button, a, [contenteditable='true']"));
}

document.addEventListener("touchstart", (event) => {
  if (event.touches.length !== 1 || swipeIgnoredTarget(event.target)) return;
  const touch = event.touches[0];
  swipeStart = {
    x: touch.clientX,
    y: touch.clientY,
    fromLeftEdge: touch.clientX <= EDGE_SWIPE_ZONE,
  };
}, { passive: true });

/* Android WebView normally routes a left-edge gesture to the system Back
 * dispatcher. On browsers that expose the gesture to the page, claim it once
 * it is clearly horizontal, so browser-history navigation cannot discard the
 * active composer. Native Android Back calls this same navigateBack(). */
document.addEventListener("touchmove", (event) => {
  if (!swipeStart?.fromLeftEdge || event.touches.length !== 1) return;
  const touch = event.touches[0];
  const dx = touch.clientX - swipeStart.x;
  const dy = touch.clientY - swipeStart.y;
  if (dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.4) event.preventDefault();
}, { passive: false });

document.addEventListener("touchend", (event) => {
  if (!swipeStart || event.changedTouches.length !== 1) {
    swipeStart = null;
    return;
  }
  const touch = event.changedTouches[0];
  const dx = touch.clientX - swipeStart.x;
  const dy = touch.clientY - swipeStart.y;
  swipeStart = null;
  if (dx < EDGE_SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.4) return;
  navigateBack();
}, { passive: true });

function captureChatAnchor() {
  const viewportTop = chatScroll.getBoundingClientRect().top;
  const message = [...chatLog.querySelectorAll("[data-message-id]")].find(
    (node) => node.getBoundingClientRect().bottom >= viewportTop,
  );
  return {
    // Keep an absolute fallback too.  A history page may legitimately contain
    // only hidden/system items, in which case its former visual anchor is not
    // rendered after reconciliation.  Replacing the list must not then reset
    // the reader to the beginning of the chat.
    scrollTop: chatScroll.scrollTop,
    scrollHeight: chatScroll.scrollHeight,
    ...(message ? {
      id: message.dataset.messageId,
      offset: message.getBoundingClientRect().top - viewportTop,
    } : {}),
  };
}

function restoreChatAnchor(anchor) {
  if (!anchor) return;
  const message = [...chatLog.querySelectorAll("[data-message-id]")]
    .find((node) => node.dataset.messageId === anchor.id);
  if (!message) {
    const applyFallback = () => {
      const addedHeight = Math.max(0, chatScroll.scrollHeight - anchor.scrollHeight);
      chatScroll.scrollTop = anchor.scrollTop + addedHeight;
    };
    applyFallback();
    window.requestAnimationFrame(applyFallback);
    return;
  }
  const apply = () => {
    const scrollTop = chatScroll.getBoundingClientRect().top;
    chatScroll.scrollTop += message.getBoundingClientRect().top - scrollTop - anchor.offset;
  };
  apply();
  window.requestAnimationFrame(apply);
}

function currentHistoryPagination() {
  return state.historyPagination.get(state.selectedId) ?? { hasOlder: false, loading: false };
}

function renderHistoryLoader() {
  const pagination = currentHistoryPagination();
  historyLoader.hidden = !pagination.hasOlder && !pagination.loading;
  historyLoader.toggleAttribute("data-loading", pagination.loading);
  historyLoadButton.disabled = pagination.loading;
  if (!historyLoader.hasAttribute("data-pulling")) {
    historyLoadLabel.textContent = pagination.loading ? "Загрузка…" : "Загрузить ещё";
  }
}

function messageDisclosureId(article) {
  return String(article.dataset.messageId ?? "").trim();
}

function updateUserMessageDisclosure(article) {
  const body = article.querySelector(".msg-body[data-user-message-disclosure]");
  if (!body) return;
  const id = messageDisclosureId(article);
  const overflows = hasCollapsedOverflow(body.scrollHeight, USER_MESSAGE_COLLAPSE_HEIGHT_PX);
  const existing = article.querySelector("[data-message-disclosure]");
  if (!overflows) {
    body.classList.remove("is-collapsed");
    existing?.remove();
    if (id) expandedUserMessageIds.delete(id);
    return;
  }

  const expanded = id && expandedUserMessageIds.has(id);
  body.classList.toggle("is-collapsed", !expanded);
  const button = existing ?? el("button", {
    type: "button",
    class: "msg-disclosure",
    "data-message-disclosure": "",
  });
  button.textContent = expanded ? "Свернуть" : "Показать ещё";
  button.setAttribute("aria-expanded", String(expanded));
  button.onclick = () => {
    const nextExpanded = body.classList.contains("is-collapsed");
    body.classList.toggle("is-collapsed", !nextExpanded);
    if (id) {
      if (nextExpanded) expandedUserMessageIds.add(id);
      else expandedUserMessageIds.delete(id);
    }
    button.textContent = nextExpanded ? "Свернуть" : "Показать ещё";
    button.setAttribute("aria-expanded", String(nextExpanded));
  };
  if (!existing) article.append(button);
}

function scheduleUserMessageDisclosureSync() {
  if (messageDisclosureFrame) return;
  messageDisclosureFrame = window.requestAnimationFrame(() => {
    messageDisclosureFrame = 0;
    for (const article of chatLog.querySelectorAll(".msg-user[data-message-id]")) {
      updateUserMessageDisclosure(article);
    }
  });
}

window.addEventListener("resize", scheduleUserMessageDisclosureSync, { passive: true });

function renderMessages({ forceBottom = false, preserveTop = false } = {}) {
  const stickToBottom = forceBottom || chatIsNearBottom();
  // Обновление истории после финального ответа использует preserveTop. У низа
  // якорь первого видимого сообщения оставлял зазор после новой карточки.
  // Якорь нужен только читателю, который уже ушёл выше по истории.
  const anchor = preserveTop && !stickToBottom ? captureChatAnchor() : null;
  const historyLoaded = state.messages.has(state.selectedId);
  const messages = state.messages.get(state.selectedId) ?? [];
  renderHistoryLoader();
  chatLog.replaceChildren();
  if (messages.length === 0) {
    chatLog.append(el("p", {
      class: "chat-log-empty",
      text: historyLoaded
        ? "История пуста. Отправьте первое сообщение агенту."
        : "Загрузка истории…",
    }));
    if (anchor) restoreChatAnchor(anchor);
    else if (stickToBottom) pinChatToBottom();
    return;
  }
  let lastAgentIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!["user", "system"].includes(messages[index]?.role)) {
      lastAgentIndex = index;
      break;
    }
  }
  const taskDiff = state.taskDiffs.get(state.selectedId);
  messages.forEach((message, index) => {
    const rendered = renderMessage(message);
    if (index !== lastAgentIndex || !taskDiff) {
      chatLog.append(rendered);
      return;
    }
    chatLog.append(el("div", { class: "message-with-diff" }, [
      rendered,
      renderTaskDiff(state.selectedId, taskDiff),
    ]));
  });
  scheduleUserMessageDisclosureSync();
  if (anchor) restoreChatAnchor(anchor);
  else if (stickToBottom) pinChatToBottom();
}

function taskDiffSummary(text) {
  const lines = String(text ?? "").split(/\r?\n/u);
  const files = lines.filter((line) => line.startsWith("diff --git ")).length;
  const additions = lines.filter((line) => /^\+(?!\+\+)/u.test(line)).length;
  const deletions = lines.filter((line) => /^-(?!--)/u.test(line)).length;
  if (files > 0) return `${files} файл${files === 1 ? "" : files < 5 ? "а" : "ов"} · +${additions} −${deletions}`;
  return `${lines.filter(Boolean).length} строк`;
}

function renderTaskDiff(taskId, diff) {
  const text = String(diff?.text ?? "").trim() || "В выбранной задаче изменений файлов нет.";
  const details = el("details", { class: "task-diff", "data-task-diff": taskId });
  details.open = diff?.open !== false;
  details.append(
    el("summary", {}, [
      el("span", { class: "task-diff-title", text: "Изменения задачи" }),
      el("span", { class: "task-diff-summary", text: taskDiffSummary(text) }),
    ]),
    el("div", { class: "task-diff-page", tabIndex: 0 }, [
      el("pre", { class: "task-diff-code", text }),
    ]),
  );
  details.addEventListener("toggle", () => {
    const current = state.taskDiffs.get(taskId);
    if (current) current.open = details.open;
  });
  return details;
}

const HISTORY_PULL_THRESHOLD = 84;
const HISTORY_PULL_MAX = 132;
let historyPull = null;

function resetHistoryPull() {
  historyPull = null;
  historyLoader.removeAttribute("data-pulling");
  historyLoader.removeAttribute("data-armed");
  historyLoader.style.removeProperty("--history-pull-height");
  historyLoader.style.removeProperty("--history-pull-progress");
  renderHistoryLoader();
}

function requestOlderHistory() {
  const pagination = currentHistoryPagination();
  if (!state.selectedId || !pagination.hasOlder || pagination.loading) return;
  emit("history:load-older", { taskId: state.selectedId });
}

historyLoadButton.addEventListener("click", requestOlderHistory);

chatScroll.addEventListener("touchstart", (event) => {
  const pagination = currentHistoryPagination();
  if (
    !phoneComposerMode()
    || event.touches.length !== 1
    || chatScroll.scrollTop > 1
    || !pagination.hasOlder
    || pagination.loading
  ) return;
  historyPull = {
    startY: event.touches[0].clientY,
    distance: 0,
    armed: false,
  };
}, { passive: true });

chatScroll.addEventListener("touchmove", (event) => {
  if (!historyPull || event.touches.length !== 1) return;
  const distance = Math.max(0, event.touches[0].clientY - historyPull.startY);
  if (distance <= 0) {
    resetHistoryPull();
    return;
  }
  event.preventDefault();
  const damped = Math.min(HISTORY_PULL_MAX, distance * 0.58);
  historyPull.distance = damped;
  historyPull.armed = damped >= HISTORY_PULL_THRESHOLD;
  historyLoader.hidden = false;
  historyLoader.toggleAttribute("data-pulling", true);
  historyLoader.toggleAttribute("data-armed", historyPull.armed);
  historyLoader.style.setProperty("--history-pull-height", `${damped}px`);
  historyLoader.style.setProperty(
    "--history-pull-progress",
    `${Math.min(100, damped / HISTORY_PULL_THRESHOLD * 100)}%`,
  );
  historyLoadLabel.textContent = historyPull.armed
    ? "Отпустите — загрузить ещё"
    : "Потяните ещё";
}, { passive: false });

chatScroll.addEventListener("touchend", () => {
  const shouldLoad = historyPull?.armed === true;
  resetHistoryPull();
  if (shouldLoad) requestOlderHistory();
});

chatScroll.addEventListener("touchcancel", resetHistoryPull);

function markdownLink(raw) {
  const source = String(raw ?? "").trim();
  const value = source.startsWith("<") && source.endsWith(">")
    ? source.slice(1, -1).trim()
    : source;
  const localPath = value.replace(/^\/(?=[A-Za-z]:[\\/])/u, "");
  if (/^[A-Za-z]:[\\/]/u.test(localPath) && (vscodeMode || surface === "desktop")) {
    const editorPath = localPath.replaceAll("\\", "/");
    return {
      href: vscodeMode ? "#" : `vscode://file/${encodeURI(editorPath)}`,
      localPath,
    };
  }
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? { href: url.href } : null;
  } catch {
    return null;
  }
}

function appendInlineMarkdown(target, source) {
  const text = String(source ?? "");
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      target.append(el("code", { text: token.slice(1, -1) }));
    } else if (token.startsWith("**")) {
      const strong = el("strong");
      appendInlineMarkdown(strong, token.slice(2, -2));
      target.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = el("em");
      appendInlineMarkdown(emphasis, token.slice(1, -1));
      target.append(emphasis);
    } else {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      const targetLink = markdownLink(parts?.[2]);
      if (targetLink) {
        const link = el("a", {
          href: targetLink.href,
          target: "_blank",
          rel: "noopener noreferrer",
          text: parts[1],
        });
        if (targetLink.localPath) link.dataset.agentHubLocalLink = targetLink.localPath;
        target.append(link);
      } else {
        target.append(document.createTextNode(token));
      }
    }
    cursor = match.index + token.length;
  }
  target.append(document.createTextNode(text.slice(cursor)));
}

function markdownTableCells(line) {
  const source = String(line ?? "").trim();
  if (!source.includes("|")) return null;
  const cells = [];
  let cell = "";
  let code = false;
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index];
    if (character === "\\" && source[index + 1] === "|") {
      cell += "|";
      index += 1;
      continue;
    }
    if (character === "`") code = !code;
    if (character === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += character;
    }
  }
  cells.push(cell.trim());
  if (source.startsWith("|")) cells.shift();
  if (source.endsWith("|")) cells.pop();
  return cells.length >= 2 ? cells : null;
}

function markdownTableAt(lines, index) {
  const headers = markdownTableCells(lines[index]);
  const delimiters = markdownTableCells(lines[index + 1]);
  if (!headers || !delimiters || headers.length !== delimiters.length) return null;
  if (!delimiters.every((cell) => /^:?-{3,}:?$/u.test(cell.replace(/\s/gu, "")))) return null;
  const alignments = delimiters.map((cell) => {
    const value = cell.replace(/\s/gu, "");
    if (value.startsWith(":") && value.endsWith(":")) return "center";
    if (value.endsWith(":")) return "right";
    return "left";
  });
  const rows = [];
  let nextIndex = index + 2;
  while (nextIndex < lines.length && lines[nextIndex].trim()) {
    const row = markdownTableCells(lines[nextIndex]);
    if (!row) break;
    rows.push(headers.map((_, cellIndex) => row[cellIndex] ?? ""));
    nextIndex += 1;
  }
  return { headers, alignments, rows, nextIndex };
}

function renderMarkdownTable(table) {
  const head = el("tr");
  table.headers.forEach((value, index) => {
    const cell = el("th", { scope: "col" });
    cell.style.textAlign = table.alignments[index];
    appendInlineMarkdown(cell, value);
    head.append(cell);
  });
  const body = el("tbody");
  table.rows.forEach((values) => {
    const row = el("tr");
    values.forEach((value, index) => {
      const cell = el("td");
      cell.style.textAlign = table.alignments[index];
      appendInlineMarkdown(cell, value);
      row.append(cell);
    });
    body.append(row);
  });
  return el("div", { class: "markdown-table-scroll", tabindex: "0" }, [
    el("table", { class: "markdown-table" }, [el("thead", {}, [head]), body]),
  ]);
}

function renderMarkdown(target, source) {
  target.replaceChildren();
  const lines = String(source ?? "").replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*```([\w+-]*)\s*$/u);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/u.test(lines[index])) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      target.append(el("pre", {}, [
        el("code", { class: fence[1] ? `language-${fence[1]}` : "", text: code.join("\n") }),
      ]));
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/u);
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(node, heading[2]);
      target.append(node);
      index += 1;
      continue;
    }
    const table = markdownTableAt(lines, index);
    if (table) {
      target.append(renderMarkdownTable(table));
      index = table.nextIndex;
      continue;
    }
    const list = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/u);
    if (list) {
      const ordered = Boolean(list[2]);
      const node = document.createElement(ordered ? "ol" : "ul");
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/u);
        if (!item || Boolean(item[2]) !== ordered) break;
        const entry = el("li");
        appendInlineMarkdown(entry, item[3]);
        node.append(entry);
        index += 1;
      }
      target.append(node);
      continue;
    }
    if (/^\s*>\s?/u.test(line)) {
      const quote = el("blockquote");
      while (index < lines.length && /^\s*>\s?/u.test(lines[index])) {
        if (quote.childNodes.length) quote.append(document.createElement("br"));
        appendInlineMarkdown(quote, lines[index].replace(/^\s*>\s?/u, ""));
        index += 1;
      }
      target.append(quote);
      continue;
    }
    const paragraph = [];
    while (index < lines.length
      && lines[index].trim()
      && !/^\s*(?:```|#{1,6}\s|[-+*]\s+|\d+\.\s+|>\s?)/u.test(lines[index])
      && !markdownTableAt(lines, index)) {
      paragraph.push(lines[index++]);
    }
    const node = el("p");
    paragraph.forEach((part, lineIndex) => {
      if (lineIndex) node.append(document.createElement("br"));
      appendInlineMarkdown(node, part);
    });
    target.append(node);
  }
}

function activityFeedNode(activities) {
  const values = Array.isArray(activities) ? activities : [];
  if (!values.length) return null;
  return el("details", { class: "activity-feed" }, [
    el("summary", { text: `Действия хода (${values.length})` }),
    el("div", { class: "activity-list" }, values.map((activity) => el("div", {
      class: "activity-item",
      "data-type": activity.type ?? "stage",
      "data-status": activity.status ?? "",
    }, [
      el("span", { class: "activity-marker", "aria-hidden": "true" }),
      el("span", { class: "activity-time", text: activity.time
        ? new Date(activity.time).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "" }),
      el("span", { class: "activity-label", text: activity.label ?? "Действие" }),
      activity.detail ? el("span", { class: "activity-detail", text: activity.detail }) : null,
    ]))),
  ]);
}

function renderMessage(message) {
  const role = message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
  const article = el("article", {
    class: `msg msg-${role}`,
    "data-role": role,
    "data-message-id": message.id ?? "",
    "data-delivery-state": message.deliveryState ?? "",
  });

  const author = message.author
    || (role === "user" ? "Вы" : role === "system" ? "Система" : "Агент");
  const head = el("div", { class: "msg-head" }, [
    el("span", { class: "msg-author", text: author }),
    message.time
      ? el("span", {
          class: "msg-time",
          text: new Date(message.time).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }),
        })
      : null,
    message.delivery
      ? el("span", {
          class: `msg-delivery${message.failed ? " is-failed" : ""}`,
          text: message.delivery,
        })
      : null,
  ]);

  const body = el("div", {
    class: "msg-body",
    ...(role === "user" ? { "data-user-message-disclosure": "" } : {}),
  });
  // Markdown собирается только безопасными DOM-узлами; сырой HTML не исполняется.
  if (!renderResponseAnnotations(body, message)) renderMarkdown(body, message.text ?? "");

  article.append(head, body);
  const activity = activityFeedNode(message.activities);
  if (activity) article.append(activity);

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    article.append(renderAttachmentStrip(message.attachments, { readOnly: true }));
  }

  if (role === "agent") {
    const actions = el("div", { class: "msg-actions" }, [
      el("button", {
        type: "button", class: "msg-action", "data-action": "tts", "data-message-id": message.id ?? "",
        title: "Озвучить ответ", "aria-label": "Озвучить ответ",
        html: '<svg data-phosphor-icon="speaker-high" viewBox="0 0 256 256" aria-hidden="true">'
          + '<path d="M80,168H32a8,8,0,0,1-8-8V96a8,8,0,0,1,8-8H80l72-56V224Z"'
          + ' fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"'
          + ' stroke-width="16"></path>'
          + '<line x1="80" y1="88" x2="80" y2="168" fill="none" stroke="currentColor"'
          + ' stroke-linecap="round" stroke-linejoin="round" stroke-width="16"></line>'
          + '<path d="M192,106.85a32,32,0,0,1,0,42.3" fill="none" stroke="currentColor"'
          + ' stroke-linecap="round" stroke-linejoin="round" stroke-width="16"></path>'
          + '<path d="M221.67,80a72,72,0,0,1,0,96" fill="none" stroke="currentColor"'
          + ' stroke-linecap="round" stroke-linejoin="round" stroke-width="16"></path></svg>',
      }),
    ]);
    article.append(actions);
  }
  return article;
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-agent-hub-local-link]");
  if (!link || !vscodeMode) return;
  event.preventDefault();
  window.__agentHubVscode.postMessage({ type: "open-link", href: link.dataset.agentHubLocalLink });
});

function renderResponseAnnotations(body, message) {
  if (message?.role !== "user" || !Array.isArray(message.responseAnnotations)
    || message.responseAnnotations.length === 0) return false;
  const annotations = el("div", { class: "msg-annotations" });
  message.responseAnnotations.forEach((item, index) => {
    const text = String(item?.text ?? "").trim();
    const comment = String(item?.annotation ?? "").trim();
    if (!text && !comment) return;
    const content = el("div", { class: "msg-annotation-content" }, [
      el("div", { class: "msg-annotation-label", text: `Цитата ${index + 1}` }),
      text ? el("div", { class: "msg-annotation-quote", text }) : null,
    ]);
    if (comment) {
      const commentNode = el("div", { class: "msg-annotation-comment" });
      renderMarkdown(commentNode, comment);
      content.append(commentNode);
    }
    annotations.append(content);
  });
  if (!annotations.childElementCount) return false;
  body.append(annotations);
  const request = String(message.responseAnnotationRequest ?? message.text ?? "").trim();
  if (request) {
    const requestNode = el("div", { class: "msg-annotation-request" });
    renderMarkdown(requestNode, request);
    body.append(requestNode);
  }
  return true;
}

function normalizedMessageText(value) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

function liveTextAfterMessages(live) {
  return normalizedMessageText(live?.text);
}

function renderLive() {
  // Решение о прилипающей прокрутке принимаем до изменения высоты live-блока.
  // Иначе большой очередной фрагмент уже отодвинет низ дальше порога.
  const stickToBottom = chatIsNearBottom();
  const live = state.live.get(state.selectedId);
  const visibleText = liveTextAfterMessages(live);
  if (!live || (
    !visibleText
    && !normalizedMessageText(live.reasoning)
    && !normalizedMessageText(live.stage)
  )) {
    chatLive.hidden = true;
    if (stickToBottom) pinChatToBottom();
    return;
  }
  chatLive.hidden = false;
  chatLive.querySelector("[data-live-author]").textContent = live.author || "Агент";
  chatLive.querySelector("[data-live-stage]").textContent = live.stage || "";
  const reasoning = chatLive.querySelector("[data-live-reasoning]");
  renderMarkdown(reasoning, live.reasoning || "");
  reasoning.hidden = !live.reasoning;
  const body = chatLive.querySelector("[data-live-body]");
  renderMarkdown(body, visibleText);
  body.hidden = !visibleText;
  const activityFeed = chatLive.querySelector("[data-activity-feed]");
  const activities = Array.isArray(live.activities) ? live.activities : [];
  activityFeed.hidden = activities.length === 0;
  if (activities.length) {
    chatLive.querySelector("[data-activity-summary]").textContent = `Действия хода (${activities.length})`;
    const list = chatLive.querySelector("[data-activity-list]");
    list.replaceChildren(...activities.map((activity) => el("div", {
      class: "activity-item",
      "data-type": activity.type ?? "stage",
      "data-status": activity.status ?? "",
    }, [
      el("span", { class: "activity-marker", "aria-hidden": "true" }),
      el("span", { class: "activity-time", text: activity.time
        ? new Date(activity.time).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
        : "" }),
      el("span", { class: "activity-label", text: activity.label ?? "Действие" }),
      activity.detail ? el("span", { class: "activity-detail", text: activity.detail }) : null,
    ])));
  }
  if (stickToBottom) pinChatToBottom();
}

function scrollChatToBottom() {
  // Не перематываем, если пользователь листает историю вверх.
  const nearBottom = chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 120;
  if (nearBottom) chatScroll.scrollTop = chatScroll.scrollHeight;
}

/* =================================================== подтверждения / очередь */

function renderApprovals() {
  const approvals = state.approvals.get(state.selectedId) ?? [];
  approvalsBox.replaceChildren();
  approvalsBox.hidden = approvals.length === 0;
  for (const approval of approvals) {
    const options = Array.isArray(approval.options) && approval.options.length > 0
      ? approval.options
      : [{ id: "approve", label: "Разрешить", kind: "primary" }, { id: "deny", label: "Отклонить" }];
    approvalsBox.append(el("div", { class: "approval", "data-approval-id": approval.id }, [
      el("div", { class: "approval-head" }, [
        el("span", { class: "approval-kind", text: approval.kind || "Подтверждение" }),
      ]),
      el("div", { class: "approval-text", text: approval.text || "" }),
      el("div", { class: "approval-actions" }, options.map((option) =>
        el("button", {
          type: "button",
          class: `chip-button ${option.kind === "primary" ? "primary" : option.kind === "danger" ? "danger" : ""}`,
          "data-action": "approval-respond",
          "data-approval-id": approval.id,
          "data-decision": option.id,
          text: option.label,
        }))),
    ]));
  }
}

function renderQueue() {
  const queued = (state.queue.get(state.selectedId) ?? [])
    .filter((entry) => entry.state !== "dispatching" && entry.state !== "steering")
    .slice()
    .sort((left, right) => {
      const leftAt = Date.parse(left.createdAt || 0);
      const rightAt = Date.parse(right.createdAt || 0);
      return (Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY)
        - (Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY);
    });
  queueBox.replaceChildren();
  queueBox.hidden = queued.length === 0;
  if (queued.length === 0) return;
  const pendingCount = queued.filter((entry) => entry.state === "pending").length;
  const queuedCount = queued.length - pendingCount;
  const counts = [
    pendingCount ? `Требуют решения: ${pendingCount}` : "",
    queuedCount ? `В очереди: ${queuedCount}` : "",
  ].filter(Boolean).join(" · ");
  queueBox.append(el("div", { class: "queue-head", text: counts }));
  for (const entry of queued) {
    const actions = [];
    const steerAvailable = Boolean(currentTask()?.running && currentTask()?.provider === "codex");
    actions.push(el("button", {
      type: "button",
      class: "queue-steer",
      "data-action": "queue-steer",
      "data-queue-id": entry.id,
      title: steerAvailable
        ? "Добавить это сообщение в текущий ход"
        : "Доступно, пока эта задача выполняет ход Codex",
      disabled: !steerAvailable,
      text: "В текущий ход",
    }));
    actions.push(el("button", {
      type: "button",
      class: "queue-edit",
      "data-action": "queue-edit",
      "data-queue-id": entry.id,
      title: "Изменить текст сообщения, не затрагивая изображения и аннотации",
      text: "Изменить",
    }));
    if (entry.state === "pending") {
      actions.push(el("button", {
        type: "button",
        class: "queue-accept",
        "data-action": "queue-accept",
        "data-queue-id": entry.id,
        title: "Отправить после завершения текущего хода",
        text: "После хода",
      }));
    }
    actions.push(el("button", {
      type: "button", class: "queue-remove", "data-action": "queue-remove", "data-queue-id": entry.id,
      title: "Убрать отложенное сообщение", "aria-label": "Убрать отложенное сообщение", text: "×",
    }));
    queueBox.append(el("div", { class: "queue-item", "data-queue-id": entry.id }, [
      el("span", { class: "queue-text", text: entry.text || entry.preview || entry.summary || "Сообщение" }),
      Array.isArray(entry.annotations) && entry.annotations.length
        ? el("span", { class: "queue-annotations", text: `Аннотации: ${entry.annotations.length}` })
        : null,
      Array.isArray(entry.attachments) && entry.attachments.length
        ? renderAttachmentStrip(entry.attachments, { readOnly: true })
        : null,
      el("span", { class: "queue-actions" }, actions),
    ]));
  }
}

/* ============================================================== композер */

const slashCommands = [
  { command: "/new", label: "Новая задача", action: "task-new" },
  { command: "/tasks", label: "Открыть список задач", run: () => setPane("tasks") },
  { command: "/search", label: "Поиск по истории", run: () => {
    setPane("tasks");
    taskFilter.focus();
  } },
  { command: "/model", label: "Выбрать модель", run: openDialogSettings },
  { command: "/reasoning", label: "Настроить reasoning", run: openDialogSettings },
  { command: "/mode", label: "Выбрать режим", run: openDialogSettings },
  { command: "/projects", label: "Выбрать проект", run: openDialogSettings },
  { command: "/rename", label: "Переименовать задачу", action: "task-rename" },
  { command: "/status", label: "Статус и лимиты", action: "task-status" },
  { command: "/diff", label: "Изменения задачи", action: "task-diff" },
  { command: "/cancel", label: "Остановить ход", action: "task-stop" },
  { command: "/compact", label: "Свернуть контекст", action: "context-compact" },
  { command: "/archive", label: "Архивировать задачу", action: "task-archive" },
];
let slashSelection = 0;

function visibleSlashCommands() {
  const query = composerInput.value.trim().toLowerCase();
  return slashCommands.filter((entry) => entry.command.startsWith(query === "/" ? "/" : query));
}

function closeSlashMenu() {
  slashMenu.hidden = true;
  slashButton?.setAttribute("aria-expanded", "false");
}

function renderSlashMenu({ force = false } = {}) {
  const value = composerInput.value.trim();
  if (!force && !/^\/\S*$/u.test(value)) {
    closeSlashMenu();
    return;
  }
  const commands = visibleSlashCommands();
  if (!commands.length) {
    closeSlashMenu();
    return;
  }
  slashSelection = Math.max(0, Math.min(slashSelection, commands.length - 1));
  slashMenu.replaceChildren(...commands.map((entry, index) => el("button", {
    type: "button",
    class: "slash-command",
    role: "option",
    "data-slash-command": entry.command,
    "aria-selected": String(index === slashSelection),
  }, [
    el("strong", { text: entry.command }),
    el("span", { text: entry.label }),
  ])));
  slashMenu.hidden = false;
  slashButton?.setAttribute("aria-expanded", "true");
}

function runSlashCommand(command) {
  const entry = slashCommands.find((candidate) => candidate.command === command);
  if (!entry) return;
  composerInput.value = "";
  autosizeComposer();
  updateSendState();
  closeSlashMenu();
  if (entry.run) entry.run();
  else if (entry.action) handleAction(entry.action, slashButton);
}

function autosizeComposer() {
  composerGrow.dataset.clone = `${composerInput.value} `;
}

function updateSendState() {
  const draftFilled = composerInput.value.trim().length > 0
    || currentAttachments().length > 0
    || currentAnnotations().length > 0;
  composerSend.disabled = !draftFilled || !state.selectedId || Boolean(pendingComposerRequest);
}

composerInput.addEventListener("input", () => {
  autosizeComposer();
  updateSendState();
  saveDraft();
  slashSelection = 0;
  renderSlashMenu();
});

composerInput.addEventListener("keydown", (event) => {
  if (!slashMenu.hidden) {
    const commands = visibleSlashCommands();
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      slashSelection = (slashSelection + (event.key === "ArrowDown" ? 1 : -1) + commands.length) % commands.length;
      renderSlashMenu({ force: true });
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeSlashMenu();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      runSlashCommand(commands[slashSelection]?.command);
      return;
    }
  }
  if (event.key !== "Enter" || event.shiftKey || event.isComposing || phoneComposerMode()) return;
  event.preventDefault();
  submitComposer();
});

slashMenu.addEventListener("click", (event) => {
  const command = event.target.closest("[data-slash-command]")?.dataset.slashCommand;
  if (command) runSlashCommand(command);
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitComposer();
});

function submitComposer() {
  if (!state.selectedId || pendingComposerRequest) return;
  const rawText = composerInput.value;
  const text = rawText.trim();
  const attachments = currentAttachments().slice();
  const annotations = currentAnnotations().slice();
  if (!text && attachments.length === 0 && annotations.length === 0) return;
  const fingerprint = JSON.stringify({
    taskId: state.selectedId,
    rawText,
    attachments,
    annotations,
  });
  const retry = retryComposerRequests.get(state.selectedId);
  const requestId = retry?.fingerprint === fingerprint
    ? retry.requestId
    : globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  if (retry && retry.fingerprint !== fingerprint) retryComposerRequests.delete(state.selectedId);
  pendingComposerRequest = {
    requestId,
    fingerprint,
    taskId: state.selectedId,
    rawText,
    attachments,
    annotations,
  };
  drafts.set(state.selectedId, { text: "", attachments: [], annotations: [] });
  composerInput.value = "";
  setAttachments([]);
  setAnnotations([]);
  autosizeComposer();
  emit("message:send", {
    requestId,
    taskId: state.selectedId,
    text,
    annotations,
    attachments,
    followUpMode: currentTask()?.running ? "queue" : null,
  });
  updateSendState();
  saveDraft();
}

function completeComposerSend(requestId, accepted) {
  const pending = pendingComposerRequest;
  if (!pending || pending.requestId !== requestId) return;
  pendingComposerRequest = null;
  if (accepted) {
    retryComposerRequests.delete(pending.taskId);
  } else {
    retryComposerRequests.set(pending.taskId, {
      requestId: pending.requestId,
      fingerprint: pending.fingerprint,
    });
    const draft = drafts.get(pending.taskId);
    const untouched = draft
      && !draft.text
      && (draft.attachments ?? []).length === 0
      && (draft.annotations ?? []).length === 0;
    if (untouched) {
      drafts.set(pending.taskId, {
        text: pending.rawText,
        attachments: pending.attachments,
        annotations: pending.annotations,
      });
      if (state.selectedId === pending.taskId) restoreDraft();
    }
  }
  updateSendState();
  saveDraft();
}

/* ---- вложения (превью через data:-URL, blob: закрыт CSP) ---- */

let attachments = [];

function currentAttachments() {
  return attachments;
}

function setAttachments(next) {
  attachments = next;
  renderAttachments();
  updateSendState();
}

function renderAttachments() {
  attachmentsBox.replaceChildren();
  attachmentsBox.hidden = attachments.length === 0;
  if (attachments.length === 0) return;
  attachmentsBox.append(renderAttachmentStrip(attachments, { readOnly: false }));
}

function renderAttachmentStrip(items, { readOnly }) {
  const strip = el("div", { class: "attachment-strip" });
  items.forEach((item, index) => {
    const source = item.dataUrl || item.url || "";
    const missing = readOnly && (item.missing || (!source && !item.id));
    const thumb = el(readOnly ? "button" : "div", {
      class: `attachment${readOnly && !missing ? " attachment-open" : ""}${missing ? " attachment-missing" : ""}`,
      title: readOnly
        ? (missing ? "Файл изображения недоступен" : "Открыть изображение")
        : item.name || "",
      ...(readOnly ? {
        type: "button",
        disabled: missing,
        "aria-label": missing
          ? `${item.name || "Изображение"} недоступно`
          : `Открыть ${item.name || "изображение"}`,
      } : {}),
    }, missing
      ? [el("span", { class: "attachment-missing-label", text: "Файл недоступен" })]
      : source
        ? [el("img", { src: source, alt: item.name || "вложение", loading: "lazy" })]
        : [el("span", { class: "attachment-load-label", text: "Открыть" })]);
    if (readOnly && !missing) {
      thumb.addEventListener("click", () => emit("attachment:open", { attachment: item }));
    }
    if (!readOnly) {
      thumb.append(el("button", {
        type: "button", class: "attachment-remove", "data-attachment-index": index,
        title: "Удалить вложение", "aria-label": "Удалить вложение", text: "×",
      }));
    }
    strip.append(thumb);
  });
  return strip;
}

attachmentsBox.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-attachment-index]");
  if (!remove) return;
  const index = Number(remove.dataset.attachmentIndex);
  setAttachments(attachments.filter((_, i) => i !== index));
  saveDraft();
});

function readImageFiles(files) {
  const images = [...files].filter((file) => file.type.startsWith("image/"));
  if (images.length === 0) return;
  const limit = 8;
  const room = Math.max(0, limit - attachments.length);
  for (const file of images.slice(0, room)) {
    const reader = new FileReader();
    reader.onload = () => {
      setAttachments([...attachments, { name: file.name, type: file.type, dataUrl: String(reader.result) }]);
      saveDraft();
    };
    reader.readAsDataURL(file);
  }
  if (images.length > room) showToast(`Можно приложить не больше ${limit} изображений.`);
}

document.querySelector("[data-action='attach']").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  readImageFiles(fileInput.files);
  fileInput.value = "";
});

composerInput.addEventListener("paste", (event) => {
  const items = [...(event.clipboardData?.items ?? [])].filter((item) => item.type.startsWith("image/"));
  if (items.length === 0) return;
  event.preventDefault();
  readImageFiles(items.map((item) => item.getAsFile()).filter(Boolean));
});

for (const dropTarget of [composer, chatScroll]) {
  dropTarget.addEventListener("dragover", (event) => {
    if (![...(event.dataTransfer?.types ?? [])].includes("Files")) return;
    event.preventDefault();
    composer.classList.add("dropping");
  });
  dropTarget.addEventListener("dragleave", () => composer.classList.remove("dropping"));
  dropTarget.addEventListener("drop", (event) => {
    if (!event.dataTransfer?.files?.length) return;
    event.preventDefault();
    composer.classList.remove("dropping");
    readImageFiles(event.dataTransfer.files);
  });
}

/* ---- аннотации к выделенному фрагменту ответа ---- */

let annotations = [];
let pendingAnnotationQuote = "";
let lastAnnotationSelection = "";

function currentAnnotations() {
  return annotations;
}

function setAnnotations(next) {
  annotations = next;
  renderAnnotations();
  updateSendState();
}

function renderAnnotations() {
  annotationsBox.replaceChildren();
  annotationsBox.hidden = annotations.length === 0;
  annotations.forEach((annotation, index) => {
    annotationsBox.append(el("div", { class: "annotation" }, [
      el("div", { class: "annotation-content" }, [
        el("span", { class: "annotation-quote", text: annotation.quote }),
        el("textarea", {
          class: "annotation-comment",
          "data-annotation-comment-index": index,
          rows: 1,
          placeholder: "Комментарий к этой цитате…",
          "aria-label": `Комментарий к цитате ${index + 1}`,
          text: annotation.annotation ?? "",
        }),
      ]),
      el("button", {
        type: "button", class: "annotation-remove", "data-annotation-index": index,
        title: "Убрать аннотацию", "aria-label": "Убрать аннотацию", text: "×",
      }),
    ]));
  });
}

annotationsBox.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-annotation-index]");
  if (!remove) return;
  setAnnotations(annotations.filter((_, i) => Number(remove.dataset.annotationIndex) !== i));
  saveDraft();
});

annotationsBox.addEventListener("input", (event) => {
  const input = event.target.closest("[data-annotation-comment-index]");
  if (!input) return;
  const index = Number(input.dataset.annotationCommentIndex);
  if (!Number.isSafeInteger(index) || !annotations[index]) return;
  annotations[index] = {
    ...annotations[index],
    annotation: String(input.value ?? "").slice(0, 20_000),
  };
  saveDraft();
});

/* Кнопка «Комментировать» активна, только когда выделен текст внутри ответа
 * агента — так фрагмент однозначно относится к конкретному ответу. */
function selectedAgentText() {
  const selection = window.getSelection();
  const text = selection?.toString().trim();
  if (!text || selection.rangeCount === 0) return "";
  const container = selection.getRangeAt(0).commonAncestorContainer;
  const host = (container.nodeType === 1 ? container : container.parentElement)
    ?.closest?.("[data-role='agent'] .msg-body");
  return host ? text : "";
}

function normalizedAnnotationQuote(value) {
  const quote = String(value ?? "").trim();
  return quote.length > 400 ? `${quote.slice(0, 400)}…` : quote;
}

function meaningfulAnnotationSelection(value) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!text) return false;
  const words = text.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.length > 1 || text.length >= 12 || /[^\p{L}\p{N}_\s-]/u.test(text);
}

document.addEventListener("selectionchange", () => {
  const rawSelection = window.getSelection()?.toString().trim() ?? "";
  const agentSelection = selectedAgentText();
  if (meaningfulAnnotationSelection(agentSelection)) {
    lastAnnotationSelection = agentSelection;
  } else if (rawSelection) {
    // A new selection outside an agent answer must not reuse an older quote.
    lastAnnotationSelection = "";
  }
});

function addAnnotation(value) {
  const quote = normalizedAnnotationQuote(value);
  if (!quote) {
    showToast("Выделите фрагмент ответа агента.");
    return false;
  }
  if (!meaningfulAnnotationSelection(quote)) {
    showToast("Выделите фразу, а не одно короткое слово.");
    return false;
  }
  if (annotations.some((annotation) => annotation.quote === quote)) {
    showToast("Этот фрагмент уже добавлен.");
    return false;
  }
  setAnnotations([...annotations, { quote, annotation: "" }]);
  lastAnnotationSelection = "";
  window.getSelection()?.removeAllRanges();
  annotationsBox.querySelector(`[data-annotation-comment-index="${annotations.length - 1}"]`)?.focus();
  saveDraft();
  return true;
}

function closeAnnotationContextMenu() {
  pendingAnnotationQuote = "";
  annotationContextMenu.hidden = true;
}

function openAnnotationContextMenu(event, quote) {
  pendingAnnotationQuote = quote;
  annotationContextMenu.hidden = false;
  const menuRect = annotationContextMenu.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - menuRect.width - 8);
  const maxTop = Math.max(8, window.innerHeight - menuRect.height - 8);
  annotationContextMenu.style.left = `${Math.min(Math.max(8, event.clientX), maxLeft)}px`;
  annotationContextMenu.style.top = `${Math.min(Math.max(8, event.clientY), maxTop)}px`;
}

document.addEventListener("contextmenu", (event) => {
  const quote = selectedAgentText();
  if (!meaningfulAnnotationSelection(quote)) {
    closeAnnotationContextMenu();
    return;
  }
  // Android WebView adds “Цитировать” to the native selection menu. Keeping
  // this event untouched on coarse pointers preserves Copy/Share/Search.
  if (window.matchMedia("(pointer: coarse)").matches) return;
  event.preventDefault();
  openAnnotationContextMenu(event, quote);
});

annotationContextMenu.addEventListener("click", (event) => {
  if (!event.target.closest("[data-action='annotate-selection']")) return;
  const quote = pendingAnnotationQuote;
  closeAnnotationContextMenu();
  addAnnotation(quote);
});

document.addEventListener("pointerdown", (event) => {
  if (!annotationContextMenu.hidden && !annotationContextMenu.contains(event.target)) {
    closeAnnotationContextMenu();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeAnnotationContextMenu();
});

window.addEventListener("scroll", closeAnnotationContextMenu, true);

/* ---- черновики ---- */

function saveDraft() {
  if (!state.selectedId) return;
  drafts.set(state.selectedId, {
    text: composerInput.value,
    attachments: attachments.slice(),
    annotations: annotations.slice(),
  });
  persistDrafts();
}

function prepareForRuntimeReload() {
  saveDraft();
  if ([...drafts.values()].some((draft) => (draft.attachments ?? []).length > 0)) return false;
  return persistDrafts();
}

function restoreDraft() {
  const draft = drafts.get(state.selectedId) ?? { text: "", attachments: [], annotations: [] };
  composerInput.value = draft.text ?? "";
  attachments = draft.attachments ?? [];
  annotations = draft.annotations ?? [];
  renderAttachments();
  renderAnnotations();
  autosizeComposer();
  updateSendState();
}

/* ============================================= панель настроек и селекторы */

function setDialogSettingsOpen(open) {
  const visible = Boolean(open && currentTask());
  dialogSettings.hidden = !visible;
  chatPane.toggleAttribute("data-dialog-settings-open", visible);
  dialogSettingsToggle.setAttribute("aria-pressed", String(visible));
}

function openDialogSettings() {
  setDialogSettingsOpen(true);
}

function toggleDialogSettings() {
  setDialogSettingsOpen(dialogSettings.hidden);
}

function openPanel() {
  settingsPanel.hidden = false;
  panelScrim.hidden = false;
  if (limitsState.status === "idle") requestLimits("24h");
  emit("devices:refresh");
  requestAnimationFrame(() => {
    settingsPanel.classList.add("open");
    panelScrim.classList.add("open");
  });
}

trustedDeviceCreate?.addEventListener("click", () => emit("devices:create"));
trustedDeviceList?.addEventListener("click", (event) => {
  const revoke = event.target.closest("[data-device-revoke]");
  if (revoke) emit("devices:revoke", { deviceId: revoke.dataset.deviceRevoke });
});
trustedDevicePairing?.addEventListener("click", (event) => {
  const copy = event.target.closest("[data-device-code-copy]");
  if (!copy) return;
  const code = String(copy.dataset.deviceCodeCopy ?? "");
  void navigator.clipboard?.writeText(code).then(
    () => showToast("Код скопирован"),
    () => showToast("Не удалось скопировать код"),
  );
});

function renderTrustedDevices(payload = {}) {
  if (!trustedDeviceList || !trustedDevicePairing) return;
  const devices = Array.isArray(payload.devices) ? payload.devices : [];
  trustedDevicePairing.hidden = !payload.pairing?.code;
  trustedDevicePairing.replaceChildren();
  if (payload.pairing?.code) {
    const expiresAt = Number(payload.pairing.expiresAt) || 0;
    trustedDevicePairing.append(
      el("div", { class: "trusted-device-pairing" }, [
        el("span", { class: "setting-name", text: "Код сопряжения" }),
        el("button", {
          type: "button",
          class: "trusted-device-code",
          "data-device-code-copy": payload.pairing.code,
          text: payload.pairing.code,
          title: "Скопировать код",
        }),
        el("span", {
          class: "setting-hint",
          text: expiresAt ? `Действует до ${new Date(expiresAt).toLocaleTimeString("ru-RU")}` : "",
        }),
      ]),
    );
  }
  if (payload.loading) {
    trustedDeviceList.replaceChildren(el("span", { class: "setting-empty", text: "Загрузка…" }));
    return;
  }
  if (payload.error) {
    trustedDeviceList.replaceChildren(el("span", { class: "setting-error", text: payload.error }));
    return;
  }
  if (!devices.length) {
    trustedDeviceList.replaceChildren(el("span", { class: "setting-empty", text: "Устройств пока нет" }));
    return;
  }
  const active = devices.filter((device) => !device.revokedAt);
  const revoked = devices.filter((device) => device.revokedAt);
  const rows = active.length
    ? active.map((device) => trustedDeviceRow(device, false))
    : [el("span", { class: "setting-empty", text: "Активных устройств нет" })];
  /* Отозванные накапливаются и одинаковы на вид, поэтому лежат свёрнутой
     группой: активные устройства не должны тонуть в их списке. */
  if (revoked.length) {
    rows.push(el("details", { class: "trusted-device-archive" }, [
      el("summary", { text: `Отозванные · ${revoked.length}` }),
      el("div", { class: "trusted-device-list" }, revoked.map((device) => trustedDeviceRow(device, true))),
    ]));
  }
  trustedDeviceList.replaceChildren(...rows);
}

function trustedDeviceRow(device, revoked) {
  const lastSeen = Number(device.lastSeenAt) || Number(device.createdAt) || 0;
  return el("div", { class: "trusted-device-row", "data-revoked": revoked ? "" : null }, [
    el("span", { class: "trusted-device-info" }, [
      el("strong", { text: device.name || "Android" }),
      el("small", {
        text: revoked
          ? `Доступ отозван${lastSeen ? ` · последний доступ ${new Date(lastSeen).toLocaleString("ru-RU")}` : ""}`
          : `Последний доступ: ${lastSeen ? new Date(lastSeen).toLocaleString("ru-RU") : "—"}`,
      }),
    ]),
    revoked ? null : el("button", {
      type: "button",
      class: "chip-button compact danger",
      "data-device-revoke": device.id,
      text: "Отозвать",
    }),
  ].filter(Boolean));
}

function closePanel() {
  settingsPanel.classList.remove("open");
  panelScrim.classList.remove("open");
  window.setTimeout(() => {
    settingsPanel.hidden = true;
    panelScrim.hidden = true;
  }, 220);
}

for (const opener of document.querySelectorAll("[data-panel-open='settings']")) {
  opener.addEventListener("click", openPanel);
}
for (const closer of document.querySelectorAll("[data-panel-close]")) {
  closer.addEventListener("click", closePanel);
}
panelScrim.addEventListener("click", closePanel);

function renderOptions() {
  renderDialogSettings();
  for (const toggle of settingsPanel.querySelectorAll("[data-toggle]")) {
    toggle.checked = Boolean(state.selection[toggle.dataset.toggle]);
  }
}

function renderDialogSettings() {
  const task = currentTask();
  dialogAgent.textContent = task?.agentLabel || providerLabels[task?.provider] || "—";
  for (const [group, values] of Object.entries(state.options)) {
    const container = dialogSettings.querySelector(`[data-dialog-options='${group}']`);
    if (!container) continue;
    container.replaceChildren();
    if (!Array.isArray(values) || values.length === 0) {
      container.append(el("span", { class: "setting-empty", text: "—" }));
      continue;
    }
    for (const option of values) {
      const value = typeof option === "string" ? option : option.value;
      const label = typeof option === "string" ? option : (option.label ?? option.value);
      const active = state.selection[group] === value;
      container.append(el("button", {
        type: "button",
        class: "option-chip",
        "data-select-group": group,
        "data-select-value": value,
        "aria-pressed": String(active),
        "data-active": active ? "" : null,
        text: label,
      }));
    }
  }
  for (const toggle of dialogSettings.querySelectorAll("[data-dialog-toggle]")) {
    const key = toggle.dataset.dialogToggle;
    toggle.checked = Boolean(state.selection[key]);
  }
}

dialogSettings.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-select-group]");
  if (!chip) return;
  const group = chip.dataset.selectGroup;
  const value = chip.dataset.selectValue;
  state.selection[group] = value;
  renderOptions();
  emit("selection:set", { key: group, value });
});

dialogSettings.addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-dialog-toggle]");
  if (!toggle) return;
  const key = toggle.dataset.dialogToggle;
  state.selection[key] = toggle.checked;
  emit("selection:set", { key, value: toggle.checked });
});

settingsPanel.addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-toggle]");
  if (!toggle) return;
  const key = toggle.dataset.toggle;
  state.selection[key] = toggle.checked;
  emit("selection:set", { key, value: toggle.checked });
});

function renderStatus() {
  if (!state.status) {
    statusSlot.hidden = true;
    statusSlot.replaceChildren();
    return;
  }
  statusSlot.hidden = false;
  const rows = Array.isArray(state.status.rows) ? state.status.rows : [];
  statusSlot.replaceChildren(
    el("span", { class: "setting-label", text: "Статус" }),
    ...rows.map((row) => el("div", { class: "status-row" }, [
      el("span", { class: "status-name", text: row.name ?? "" }),
      el("span", { class: "status-value", text: row.value ?? "" }),
    ])),
  );
}

function formatServerStartedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("ru-RU");
}

function serverFact(name, value) {
  return el("div", { class: "server-fact" }, [
    el("dt", { text: name }),
    el("dd", { text: value || "—" }),
  ]);
}

let lastServerPayload = null;

function renderServerStatus(payload = {}) {
  if (!serverState || !serverFacts || !serverComponents || !serverConfig) return;
  lastServerPayload = payload;
  const processInfo = payload.process ?? {};
  const restart = payload.restart ?? {};
  const autostart = payload.autostart ?? {};
  const active = processInfo.status === "running";
  serverState.textContent = active ? "Работает" : "Нет соединения";
  serverStateNote.textContent = restart.pending
    ? (restart.waiting ? `Перезапуск ожидает: ${restart.blockingCount || 0}` : "Перезапуск запрошен")
    : active
      ? "Локальный процесс Agent Hub отвечает."
      : "Состояние процесса пока недоступно.";
  serverStateDot?.toggleAttribute("data-online", active);
  serverFacts.replaceChildren(
    serverFact("PID", processInfo.pid ? String(processInfo.pid) : "—"),
    serverFact("Запущен", formatServerStartedAt(processInfo.startedAt)),
    serverFact("Работает", formatRunningDuration(processInfo.startedAt)),
    serverFact("Активные ходы", String(Math.max(0, Number(processInfo.activeCount) || 0))),
  );
  serverAutostartState = autostart;
  const components = Array.isArray(payload.components) ? payload.components : [];
  serverComponents.replaceChildren(...(components.length ? components.map((component) => el("div", {
    class: "server-component",
    "data-enabled": component.enabled ? "" : null,
  }, [
    el("span", { class: "server-component-name", text: component.name ?? "Компонент" }),
    el("span", {
      class: "server-component-status",
      text: component.enabled ? "Включён" : "Выключен",
    }),
    component.note ? el("small", { text: component.note }) : null,
  ].filter(Boolean))) : [el("span", { class: "setting-empty", text: "Компоненты не определены" })]));
  /* Одно название вроде «Очередь входящих» ничего не объясняет, поэтому у
     плитки есть пояснение под значением и та же строка в подсказке. */
  const entries = Array.isArray(payload.configuration) ? payload.configuration : [];
  /* Пока правки не сохранены, снапшот не должен затирать введённые значения. */
  if (serverConfigDrafts.size && serverConfig.childElementCount) return;
  serverConfig.replaceChildren(...[
    renderAutostartEntry(autostart),
    ...(entries.length ? entries.map(renderServerConfigEntry)
      : [el("span", { class: "setting-empty", text: "Конфигурация недоступна" })]),
  ]);
  syncServerConfigActions();
}

/* Автозапуск — такая же настройка Hub, поэтому лежит первой плиткой сетки. В
   отличие от остальных он применяется сразу: это состояние службы Windows, а
   не значение конфигурации, которое ждёт кнопку «Сохранить». */
let serverAutostartState = {};

function renderAutostartEntry(autostart = {}) {
  const supported = autostart.supported !== false;
  const hint = supported
    ? "Hub стартует вместе с входом в Windows."
    : "Управление автозапуском доступно только в Windows.";
  const input = el("input", {
    type: "checkbox",
    checked: autostart.enabled === true,
    disabled: !supported,
    "data-server-autostart": "",
  });
  input.addEventListener("change", () => noteServerConfigDraft(AUTOSTART_KEY, input.checked));
  return el("label", {
    class: "server-config-row server-config-toggle",
    title: hint,
  }, [
    el("span", { class: "switch-text", text: "Автозапуск Agent Hub" }),
    input,
    el("span", { class: "switch-track", "aria-hidden": true }),
    el("small", { class: "server-config-hint", text: hint }),
  ]);
}

/* Настройки применяются одной кнопкой: у каждой плитки своя кнопка «Сохранить»
   занимала больше места, чем само поле, и позволяла уехать из карточки с
   половиной применённых изменений. */
const serverConfigDrafts = new Map();
/* Автозапуск управляется отдельной командой Hub, но в интерфейсе ведёт себя как
   остальные настройки: правка ждёт кнопку «Сохранить» вместе со всеми. */
const AUTOSTART_KEY = "agentHub:autostart";

function syncServerConfigActions() {
  const actions = document.querySelector("[data-server-config-actions]");
  if (!actions) return;
  /* Панель видна всегда: скрытая кнопка не давала понять, что настройки вообще
     где-то сохраняются. Без правок она просто неактивна. */
  const count = serverConfigDrafts.size;
  actions.hidden = false;
  const save = actions.querySelector("[data-server-config-save]");
  if (save) {
    save.textContent = count > 1 ? `Сохранить · ${count}` : "Сохранить";
    save.disabled = count === 0;
  }
  const discard = actions.querySelector("[data-server-config-discard]");
  if (discard) discard.hidden = count === 0;
  const note = actions.querySelector(".server-config-actions-note");
  if (note) {
    note.textContent = count
      ? "Изменения применяются только по кнопке."
      : "Настройки применяются кнопкой «Сохранить».";
  }
}

function noteServerConfigDraft(key, value) {
  serverConfigDrafts.set(key, value);
  syncServerConfigActions();
}

function saveServerConfigDrafts() {
  if (!serverConfigDrafts.size) return;
  const changes = Object.fromEntries(serverConfigDrafts);
  const autostart = changes[AUTOSTART_KEY];
  delete changes[AUTOSTART_KEY];
  serverConfigDrafts.clear();
  syncServerConfigActions();
  if (autostart !== undefined) emit("server:autostart", { enabled: autostart === true });
  if (Object.keys(changes).length) emit("server:config-update", { changes });
}

function discardServerConfigDrafts() {
  serverConfigDrafts.clear();
  /* Возвращаем поля к последнему снимку: иначе отменённые правки остаются
     набранными в полях и вводят в заблуждение. */
  if (lastServerPayload) renderServerStatus(lastServerPayload);
  syncServerConfigActions();
}

function renderServerConfigEntry(entry = {}) {
  const pendingNote = entry.pending ? el("small", {
    class: "server-config-pending",
    text: "Применится после перезапуска",
  }) : null;
  const hint = entry.hint ? el("small", { class: "server-config-hint", text: entry.hint }) : null;
  if (entry.type === "boolean") {
    const input = el("input", { type: "checkbox", checked: entry.value === true });
    input.addEventListener("change", () => noteServerConfigDraft(entry.key, input.checked));
    return el("label", {
      class: "server-config-row server-config-toggle",
      title: entry.hint || entry.name || "",
    }, [
      el("span", { class: "switch-text", text: entry.name ?? "" }),
      input,
      el("span", { class: "switch-track", "aria-hidden": true }),
      hint,
      pendingNote,
    ].filter(Boolean));
  }
  if (entry.type === "choice") {
    const input = el("select", {
      class: "server-config-number",
      "aria-label": entry.name ?? "Параметр конфигурации",
    }, (Array.isArray(entry.choices) ? entry.choices : []).map((choice) => el("option", {
      value: choice.value ?? "",
      text: choice.label ?? choice.value ?? "",
      selected: choice.value === entry.value,
    })));
    input.addEventListener("change", () => noteServerConfigDraft(entry.key, input.value));
    return el("div", { class: "server-config-row", title: entry.hint || entry.name || "" }, [
      el("span", { text: entry.name ?? "" }),
      input,
      hint,
      pendingNote,
    ].filter(Boolean));
  }
  const input = el("input", {
    class: "server-config-number",
    type: "number",
    value: entry.value ?? "",
    min: entry.min,
    max: entry.max,
    step: 1,
    "aria-label": entry.name ?? "Параметр конфигурации",
  });
  input.addEventListener("input", () => noteServerConfigDraft(entry.key, input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveServerConfigDrafts();
  });
  return el("div", { class: "server-config-row", title: entry.hint || entry.name || "" }, [
    el("span", { text: entry.name ?? "" }),
    el("div", { class: "server-config-number-row" }, [
      input,
      entry.unit ? el("small", { class: "server-config-unit", text: entry.unit }) : null,
    ].filter(Boolean)),
    hint,
    pendingNote,
  ].filter(Boolean));
}

document.querySelector("[data-server-config-save]")
  ?.addEventListener("click", saveServerConfigDrafts);
document.querySelector("[data-server-config-discard]")
  ?.addEventListener("click", discardServerConfigDrafts);



/* ================================================= диалог ввода текста */

let dialogResolve = null;
let dialogActiveInput = dialogInput;

function askText({ title, value = "", multiline = false }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogTitle.textContent = title;
    dialogActiveInput = multiline ? dialogTextarea : dialogInput;
    dialogInput.hidden = multiline;
    dialogTextarea.hidden = !multiline;
    dialogActiveInput.value = value;
    dialog.hidden = false;
    dialogScrim.hidden = false;
    requestAnimationFrame(() => dialogActiveInput.focus());
  });
}

function closeDialog(result) {
  dialog.hidden = true;
  dialogScrim.hidden = true;
  const resolve = dialogResolve;
  dialogResolve = null;
  resolve?.(result);
}

dialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  closeDialog(dialogActiveInput.value.trim());
});
document.querySelector("[data-text-dialog-cancel]").addEventListener("click", () => closeDialog(null));
dialogScrim.addEventListener("click", () => closeDialog(null));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !dialog.hidden) closeDialog(null);
  if (event.key === "Escape" && !settingsPanel.hidden) closePanel();
});

/* ================================================= общие действия (intents) */

document.addEventListener("click", (event) => {
  if (taskNewPicker?.open && !taskNewPicker.contains(event.target)) {
    taskNewPicker.open = false;
  }
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;
  handleAction(action, trigger, event);
});

async function handleAction(action, trigger) {
  const taskId = state.selectedId;
  switch (action) {
    case "task-new": {
      const provider = ["codex", "claude"].includes(trigger?.dataset?.provider)
        ? trigger.dataset.provider
        : (currentTask()?.provider ?? "codex");
      if (taskNewPicker) taskNewPicker.open = false;
      const title = await askText({ title: "Название новой задачи" });
      if (title != null) emit("task:new", { title, provider });
      break;
    }
    case "task-settings":
      toggleDialogSettings();
      break;
    case "task-rename": {
      const task = currentTask();
      const title = await askText({ title: "Новое название задачи", value: task?.title ?? "" });
      if (title != null && task) emit("task:rename", { id: task.id, title });
      break;
    }
    case "task-archive":
      if (taskId) emit("task:archive", { id: taskId });
      break;
    case "task-stop":
      if (taskId) emit("task:stop", { id: taskId });
      break;
    case "task-diff":
      if (taskId) emit("task:diff", { id: taskId });
      break;
    case "task-status":
      if (taskId) emit("status:open", { id: taskId });
      openPanel();
      break;
    case "approval-respond":
      emit("approval:respond", {
        taskId,
        id: trigger.dataset.approvalId,
        decision: trigger.dataset.decision,
      });
      break;
    case "queue-remove":
      emit("queue:remove", { taskId, id: trigger.dataset.queueId });
      break;
    case "queue-accept":
      emit("queue:accept", { taskId, id: trigger.dataset.queueId });
      break;
    case "queue-steer":
      emit("queue:steer", { taskId, id: trigger.dataset.queueId });
      break;
    case "queue-edit": {
      const entry = (state.queue.get(taskId) ?? []).find((item) => item.id === trigger.dataset.queueId);
      if (!entry) break;
      const text = await askText({
        title: "Изменить сообщение в очереди",
        value: entry.text ?? entry.preview ?? "",
        multiline: true,
      });
      if (text != null) emit("queue:edit", { taskId, id: entry.id, text });
      break;
    }
    case "tts":
      emit("tts:play", { taskId, messageId: trigger.dataset.messageId });
      break;
    case "hub-restart":
      emit("hub:restart", {});
      break;
    case "slash-menu":
      if (slashMenu.hidden) {
        if (!composerInput.value.trim()) composerInput.value = "/";
        composerInput.focus();
        renderSlashMenu({ force: true });
      } else {
        closeSlashMenu();
      }
      break;
    case "context-compact":
      if (taskId) emit("context:compact", { taskId });
      break;
    case "pane-tasks":
      setPane("tasks");
      break;
    default:
      break;
  }
  // Закрываем всплывающее меню «⋯» после выбора.
  const overflow = trigger.closest("details[data-overflow]");
  if (overflow) overflow.open = false;
}

// Закрытие меню «⋯» по клику вне его.
document.addEventListener("click", (event) => {
  for (const overflow of document.querySelectorAll("details[data-overflow][open]")) {
    if (!overflow.contains(event.target)) overflow.open = false;
  }
});

/* ============================================ контракт для backend (render) */

const AgentHub = {
  /** Подписка на действия пользователя. */
  on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type)?.delete(handler);
  },
  off(type, handler) {
    listeners.get(type)?.delete(handler);
  },
  prepareForRuntimeReload,
  /** Состояние соединения и отложенного перезапуска Agent Hub. */
  setConnection(status, details = {}) {
    const value = ["online", "connecting", "restart-waiting", "restarting", "offline"].includes(status)
      ? status
      : "offline";
    const blockingCount = Math.max(0, Number(details.blockingCount) || 0);
    if (state.connection === value && state.connectionBlockingCount === blockingCount) return;
    state.connection = value;
    state.connectionBlockingCount = blockingCount;
    root.dataset.connection = value;
    const messages = {
      connecting: "Подключение к Agent Hub…",
      "restart-waiting": blockingCount
        ? `Agent Hub ожидает завершения активных задач: ${blockingCount}.`
        : "Agent Hub ожидает завершения активных задач.",
      restarting: "Agent Hub перезапускается…",
      offline: "Нет связи с Agent Hub.",
    };
    connectionBanner.textContent = messages[value] ?? "";
    connectionBanner.hidden = value === "online";
  },
  /** Полный список задач. Каждая задача: { id, title, provider, agentLabel,
   *  modelLabel, reasoningLabel, modeLabel, runtimeLabel, project, status, statusLabel,
   *  lastActivity, unread, running, selected }. */
  setTasks(tasks) {
    const nextTasks = Array.isArray(tasks) ? tasks.slice() : [];
    const selected = nextTasks.find((task) => task.selected);
    const nextSelectedId = selected?.id
      ?? (nextTasks.some((task) => task.id === state.selectedId) ? state.selectedId : null);
    const previousSelectedTask = state.tasks.find((task) => task.id === state.selectedId) ?? null;
    const nextSelectedTask = nextTasks.find((task) => task.id === nextSelectedId) ?? null;
    const selectionChanged = nextSelectedId !== state.selectedId;
    const tasksChanged = !sameData(state.tasks, nextTasks);
    const selectedTaskChanged = !sameData(previousSelectedTask, nextSelectedTask);
    if (!tasksChanged && !selectionChanged) return;
    if (selectionChanged && state.selectedId) saveDraft();
    state.tasks = nextTasks;
    state.selectedId = nextSelectedId;
    renderTasks();
    if (selectionChanged || selectedTaskChanged) renderChat();
  },
  /** Точечное обновление задачи (статус, время, непрочитанное). */
  patchTask(id, patch) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    const changed = Object.entries(patch ?? {}).some(([key, value]) => !Object.is(task[key], value));
    if (!changed) return;
    Object.assign(task, patch);
    renderTasks();
    if (id === state.selectedId) renderChat();
  },
  /** Выбор задачи со стороны backend (например, смена из Telegram). */
  selectTask(id) {
    if (state.selectedId === id) return;
    saveDraft();
    state.selectedId = id;
    for (const task of state.tasks) task.selected = task.id === id;
    renderTasks();
    renderChat();
  },
  /** История сообщений задачи. message: { id, role, author, text, time,
   *  attachments }. role: "user" | "agent" | "system". */
  setMessages(taskId, messages) {
    const next = Array.isArray(messages) ? messages.slice() : [];
    if (sameData(state.messages.get(taskId) ?? [], next)) return;
    state.messages.set(taskId, next);
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true });
      renderLive();
    }
  },
  /** Раскрываемый diff выбранной задачи под её последним ответом. */
  setTaskDiff(taskId, text) {
    if (!taskId) return;
    const nextText = String(text ?? "");
    const previous = state.taskDiffs.get(taskId);
    if (previous?.text === nextText) return;
    state.taskDiffs.set(taskId, {
      text: nextText,
      open: true,
    });
    if (taskId === state.selectedId) renderMessages({ preserveTop: true });
  },
  setMessagesPreservingScroll(taskId, messages) {
    const next = Array.isArray(messages) ? messages.slice() : [];
    if (sameData(state.messages.get(taskId) ?? [], next)) return;
    state.messages.set(taskId, next);
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true });
      renderLive();
    }
  },
  setHistoryPagination(taskId, pagination) {
    const next = {
      hasOlder: pagination?.hasOlder === true,
      loading: pagination?.loading === true,
    };
    if (sameData(state.historyPagination.get(taskId) ?? {}, next)) return;
    state.historyPagination.set(taskId, next);
    if (taskId === state.selectedId) renderHistoryLoader();
  },
  appendMessage(taskId, message) {
    const list = state.messages.get(taskId) ?? [];
    list.push(message);
    state.messages.set(taskId, list);
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true });
      renderLive();
    }
  },
  patchMessage(taskId, messageId, patch) {
    const list = state.messages.get(taskId) ?? [];
    const message = list.find((item) => item.id === messageId);
    if (!message) return;
    Object.assign(message, patch);
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true });
      renderLive();
    }
  },
  completeSend(requestId, { accepted = false } = {}) {
    completeComposerSend(requestId, accepted);
  },
  /** Живой ход: { author, stage, reasoning, text } или null, чтобы скрыть. */
  setLive(taskId, live) {
    const next = live ?? null;
    if (sameData(state.live.get(taskId) ?? null, next)) return;
    state.live.set(taskId, next);
    if (taskId === state.selectedId) renderLive();
  },
  setSearchResults(query, results) {
    if (String(query ?? "").trim() !== state.searchQuery) return;
    state.searchResults = new Map((Array.isArray(results) ? results : [])
      .map((result) => [result.id, result]));
    state.searchLoading = false;
    renderTasks();
  },
  /** running=true подсвечивает индикатор и показывает «Стоп». */
  setRunning(taskId, running) {
    this.patchTask(taskId, { running: Boolean(running) });
  },
  setApprovals(taskId, approvals) {
    const next = Array.isArray(approvals) ? approvals : [];
    if (sameData(state.approvals.get(taskId) ?? [], next)) return;
    state.approvals.set(taskId, next);
    if (taskId === state.selectedId) renderApprovals();
  },
  setQueue(taskId, queued) {
    const next = Array.isArray(queued) ? queued : [];
    if (sameData(state.queue.get(taskId) ?? [], next)) return;
    state.queue.set(taskId, next);
    if (taskId === state.selectedId) renderQueue();
  },
  /** Списки вариантов для селекторов: { model, reasoning, mode, project }.
   *  Значение — строка или { value, label }. */
  setOptions(options) {
    const next = { ...state.options, ...options };
    if (sameData(state.options, next)) return;
    state.options = next;
    renderOptions();
  },
  /** Текущий выбор: { model, reasoning, mode, project, autoApprove,
   *  includeClaudeUsage }. */
  setSelection(selection) {
    const claudeUsageChanged = Object.hasOwn(selection ?? {}, "includeClaudeUsage")
      && state.selection.includeClaudeUsage !== selection.includeClaudeUsage;
    const next = { ...state.selection, ...selection };
    if (sameData(state.selection, next)) return;
    state.selection = next;
    renderOptions();
    if (state.selectedId) renderChat();
    if (claudeUsageChanged && journalHtml) renderJournal();
  },
  /** Сводка статуса/лимитов для панели: { rows: [{ name, value }] }. */
  setStatus(status) {
    state.status = status ?? null;
    renderStatus();
  },
  /** История лимитов для диалога графика. payload:
   *  { range, from, to, series: [{ id, name, window, points:
   *  [{ at, usedPercent, remainingPercent }] }], resetCredits:
   *  { availableCount, nearestExpiresAt } }. null/`{ error }` — ошибка. */
  setRateLimitHistory(payload) {
    applyRateLimitHistory(payload);
  },
  /** Локальный расход завершённых ходов из ledger Agent Hub. */
  setUsageHistory(payload) {
    applyUsageHistory(payload);
  },
  /** Официальные валютные курсы, полученные Agent Hub при запуске. */
  setExchangeRates(payload) {
    const rate = Number(payload?.usdRub);
    const nextRate = Number.isFinite(rate) && rate > 0 ? rate : null;
    const nextEffectiveDate = String(payload?.effectiveDate ?? "");
    if (
      exchangeRatesInitialized
      && nextRate === usdRubRate
      && nextEffectiveDate === usdRubEffectiveDate
    ) return;
    exchangeRatesInitialized = true;
    usdRubRate = nextRate;
    usdRubEffectiveDate = nextEffectiveDate;
    if (exchangeRateHint) {
      const date = usdRubEffectiveDate
        ? new Date(`${usdRubEffectiveDate}T00:00:00`).toLocaleDateString("ru-RU")
        : "";
      exchangeRateHint.textContent = usdRubRate
        ? `₽ — курс ЦБ РФ ${spacedNumber(usdRubRate, 4)} за $1${date ? ` на ${date}` : ""}; `
          + "ПТЭ — приведённые токен-эквиваленты с учётом модели и Fast."
        : "Курс ₽ пока недоступен; ПТЭ — приведённые токен-эквиваленты с учётом модели и Fast.";
    }
    refreshUsageUnits();
    renderUsageHistory();
    if (journalHtml) renderJournal();
  },
  setTrustedDevices(payload) {
    renderTrustedDevices(payload);
  },
  /** Безопасная сводка и управление локальным Agent Hub Server. */
  setServerStatus(payload) {
    renderServerStatus(payload);
  },
  openAttachmentViewer,
  showAttachmentViewer,
  closeAttachmentViewer,
  addSelectedAnnotation() {
    return addAnnotation(selectedAgentText() || lastAnnotationSelection);
  },
  navigateBack,
  toast: showToast,
};

window.AgentHub = AgentHub;

/* ============================================= статистика и история лимитов */
/* Страница открывается отдельной вкладкой или по сводке лимитов в шапке и
 * показывает локальный расход вместе с SVG-графиком лимитов. Данные о
 * периодах запрашиваются событием `limits:open`, а приходят обратно через
 * `AgentHub.setRateLimitHistory(payload)`. Ничего внешнего: график рисуется
 * встроенным SVG на переменных темы, без canvas, шрифтов и CDN. */

const SVG_NS = "http://www.w3.org/2000/svg";
/* Палитра серий на переменных темы: провайдеры — своими цветами, остальные
 * по кругу из акцентов, чтобы линии различались в любой теме. */
const SERIES_PALETTE = [
  "var(--dot-think)",
  "var(--dot-cache)",
  "var(--dot-output)",
  "var(--accent)",
  "var(--ok)",
  "var(--pending)",
];

/* Стабильный versioned-ключ для скрытых серий графика. Меняется только при
 * несовместимом изменении формата, чтобы восстановление пережило перезапуск. */
const LIMITS_HIDDEN_KEY = "agent-hub-limits-hidden-v1";

/* Читаем набор скрытых серий из localStorage. Неизвестные (новые) серии в набор
 * не попадают, поэтому по умолчанию видимы. */
function loadHiddenSeries() {
  try {
    const stored = JSON.parse(localStorage.getItem(LIMITS_HIDDEN_KEY) || "null");
    if (stored && stored.version === 1 && Array.isArray(stored.ids)) {
      return new Set(stored.ids.map(String));
    }
  } catch {
    // Приватный режим Telegram может запрещать localStorage — считаем все серии видимыми.
  }
  return new Set();
}

function persistHiddenSeries() {
  try {
    localStorage.setItem(LIMITS_HIDDEN_KEY, JSON.stringify({
      version: 1,
      ids: [...limitsState.hidden],
    }));
  } catch {
    // Скрытие останется применённым в текущей сессии, даже если запись недоступна.
  }
}

/* Стабильный идентификатор серии: приоритет за series.id, имя — запасной вариант,
 * чтобы переключение работало и для серий без явного id. */
function seriesId(series) {
  const id = series?.id ?? series?.name;
  return id == null ? "" : String(id);
}

const limitsState = {
  range: "24h",
  status: "idle", // idle | loading | ready | empty | error
  payload: null,
  error: "",
  hidden: loadHiddenSeries(),
};

/* Переключает видимость серии по её id. Работает только по кэшу: без запроса к
 * backend и без смены выбранного диапазона. Фокус возвращается на ту же кнопку
 * легенды после перерисовки. */
function toggleSeriesVisibility(id) {
  if (!id) return;
  if (limitsState.hidden.has(id)) limitsState.hidden.delete(id);
  else limitsState.hidden.add(id);
  persistHiddenSeries();
  renderLimits();
  const buttons = limitsLegend ? [...limitsLegend.querySelectorAll("[data-series-id]")] : [];
  buttons.find((button) => button.dataset.seriesId === id)?.focus();
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeRange(range) {
  return RANGE_SEQUENCE.includes(range) ? range : "24h";
}

function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of [].concat(children)) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function seriesColor(series, index) {
  const key = `${series?.id ?? ""} ${series?.name ?? ""}`.toLowerCase();
  if (key.includes("codex")) return "var(--provider-codex)";
  if (key.includes("claude")) return "var(--provider-claude)";
  return SERIES_PALETTE[index % SERIES_PALETTE.length];
}

function formatLimitsDateTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/* Подпись оси X: внутри суток — время, на длинных диапазонах — дата. */
function formatAxisTime(ms, spanMs) {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "";
  if (spanMs <= 36 * 60 * 60 * 1000) {
    return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

/* Линия сохраняет все замеры, но маркеры прореживаются по экранному расстоянию.
 * Иначе пяти минутные точки на диапазонах 24 ч и больше сливаются в толстую
 * зубчатую полосу. Последний замер всегда остаётся видимым и доступным с клавиатуры. */
function limitsMarkerPoints(points, minimumSpacing = 11) {
  if (points.length <= 1) return points;
  const markers = [points[0]];
  for (const point of points.slice(1, -1)) {
    const previous = markers.at(-1);
    if (Math.hypot(point.x - previous.x, point.y - previous.y) >= minimumSpacing) {
      markers.push(point);
    }
  }
  const current = points.at(-1);
  const previous = markers.at(-1);
  if (Math.hypot(current.x - previous.x, current.y - previous.y) < minimumSpacing * 0.7) {
    markers[markers.length - 1] = current;
  } else {
    markers.push(current);
  }
  return markers;
}

function statusFromPayload(payload) {
  if (!payload || payload.error) return payload?.error ? "error" : "empty";
  const hasPoints = Array.isArray(payload.series)
    && payload.series.some((series) => Array.isArray(series.points) && series.points.length > 0);
  return hasPoints ? "ready" : "empty";
}

/* Приём данных из backend. Хранит payload и, если диалог открыт, обновляет
 * график сразу. */
function applyRateLimitHistory(payload) {
  const data = payload && typeof payload === "object" ? payload : null;
  limitsState.payload = data;
  limitsState.error = data?.error ? String(data.error) : "";
  if (data?.range) limitsState.range = normalizeRange(data.range);
  limitsState.status = statusFromPayload(data);
  renderCurrentLimits();
  if (root.dataset.view === "statistics") {
    renderLimitsRanges();
    renderLimits();
  }
}

function parseClaudeResetAt(value, nowMs = Date.now()) {
  /* Claude печатает срок текстом и минуты опускает, когда их нет:
     «Aug 7, 2am». Из-за обязательных минут недельное окно оставалось без
     срока вообще. */
  const match = String(value ?? "").match(
    /^([A-Za-z]{3}) (\d{1,2}), (\d{1,2})(?::(\d{2}))?\s*(am|pm)/iu,
  );
  if (!match) return null;
  const month = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ].indexOf(match[1].slice(0, 1).toUpperCase() + match[1].slice(1).toLowerCase());
  if (month < 0) return null;
  let hour = Number(match[3]) % 12;
  if (String(match[5]).toLowerCase() === "pm") hour += 12;
  const minutes = Number(match[4] ?? 0);
  const now = new Date(nowMs);
  let reset = new Date(now.getFullYear(), month, Number(match[2]), hour, minutes);
  if (reset.getTime() < nowMs - 24 * 60 * 60_000) {
    reset = new Date(now.getFullYear() + 1, month, Number(match[2]), hour, minutes);
  }
  return reset.getTime();
}

function formatResetCountdown(point) {
  const isoReset = Date.parse(point?.resetsAt ?? "");
  const resetMs = Number.isFinite(isoReset)
    ? isoReset
    : parseClaudeResetAt(point?.resetsText);
  if (!Number.isFinite(resetMs)) return "";
  const minutes = Math.max(0, Math.ceil((resetMs - Date.now()) / 60_000));
  if (minutes <= 0) return "сейчас";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainder = minutes % 60;
  const parts = [];
  if (days) parts.push(`${days} д.`);
  if (hours) parts.push(`${hours} ч.`);
  if (!days && remainder) parts.push(`${remainder} мин.`);
  return parts.join(" ") || "< 1 мин.";
}

function currentLimitSeries(payload) {
  const available = (Array.isArray(payload?.series) ? payload.series : [])
    .filter((series) => Array.isArray(series.points) && series.points.length)
    .map((series) => ({ ...series, point: series.points.at(-1) }));
  const pickCodex = (name) => {
    const matches = available.filter((series) => String(series.name).toLowerCase() === name);
    return matches.find((series) => series.window === "primary");
  };
  const claudeWeek = available.find((series) => series.id === "claude:week");
  return [
    pickCodex("codex"),
    pickCodex("spark"),
    ...available
      .filter((series) => String(series.name).toLowerCase() === "claude")
      .sort((left, right) => {
        const order = (series) => (
          series.window === "week" ? 0 : series.window === "session" ? 1 : 2
        );
        return order(left) - order(right)
          || String(left.window).localeCompare(String(right.window), "ru");
      }),
  ].filter(Boolean).map((series) => {
    const id = String(series.id ?? "");
    const label = id.startsWith("claude:model:")
      ? String(series.window || "Claude")
      : id === "claude:session"
        ? "Claude session"
        : id === "claude:week"
          ? "Claude"
          : String(series.name || series.id || "");
    const point = id.startsWith("claude:model:") && !series.point?.resetsText
      ? { ...series.point, resetsText: claudeWeek?.point?.resetsText ?? "" }
      : series.point;
    return { ...series, label, point };
  });
}

function renderCurrentLimits() {
  if (!currentLimitsSlots.length) return;
  const series = currentLimitSeries(limitsState.payload);
  for (const slot of currentLimitsSlots) {
    if (limitsState.status === "loading" || limitsState.status === "idle") {
      slot.replaceChildren(el("span", { class: "current-limits-empty", text: "Загрузка…" }));
      continue;
    }
    if (!series.length) {
      slot.replaceChildren(el("span", {
        class: "current-limits-empty",
        text: limitsState.status === "error" ? "Лимиты недоступны" : "Нет данных",
      }));
      continue;
    }
    slot.replaceChildren(...series.map((item) => {
      const remaining = Number(item.point?.remainingPercent);
      const countdown = formatResetCountdown(item.point);
      return el("span", { class: "current-limit" }, [
        el("span", { class: "current-limit-name", text: item.label }),
        el("strong", {
          class: "current-limit-value",
          text: Number.isFinite(remaining) ? `${remaining.toFixed(1)}%` : "—",
        }),
        countdown
          ? el("span", { class: "current-limit-reset", text: countdown })
          : null,
      ]);
    }));
  }
}

/* Запрос данных за период: показываем загрузку (если нет свежих данных за этот
 * период) и просим backend прислать историю. */
function requestLimits(range, { force = false } = {}) {
  limitsState.range = normalizeRange(range);
  const cached = limitsState.payload
    && !limitsState.payload.error
    && normalizeRange(limitsState.payload.range) === limitsState.range;
  limitsState.status = cached && !force ? statusFromPayload(limitsState.payload) : "loading";
  limitsState.error = "";
  renderLimitsRanges();
  renderLimits();
  emit("limits:open", { range: limitsState.range });
}

/* Шаг по последовательности периодов: −1 сужает (к 6 ч), +1 расширяет (к «всё»). */
function stepLimitsRange(direction) {
  const index = RANGE_SEQUENCE.indexOf(limitsState.range);
  const next = clampNumber((index < 0 ? 1 : index) + direction, 0, RANGE_SEQUENCE.length - 1);
  const range = RANGE_SEQUENCE[next];
  if (range !== limitsState.range) requestLimits(range);
}

function renderLimitsRanges() {
  if (!limitsRanges) return;
  for (const button of limitsRanges.querySelectorAll("[data-range]")) {
    const active = button.dataset.range === limitsState.range;
    button.setAttribute("aria-pressed", String(active));
    if (active) button.setAttribute("data-active", "");
    else button.removeAttribute("data-active");
  }
}

function renderLimitsSubtitle() {
  if (!limitsSubtitle) return;
  const label = RANGE_LABELS[limitsState.range] ?? "";
  const payload = limitsState.payload;
  let period = "";
  if (payload && !payload.error) {
    const from = payload.from ? formatLimitsDateTime(payload.from) : "";
    const to = payload.to ? formatLimitsDateTime(payload.to) : "";
    if (from && to) period = `${from} — ${to}`;
    else if (to) period = `по ${to}`;
  }
  limitsSubtitle.textContent = period ? `${label} · ${period}` : label;
}

function renderLimits() {
  const status = limitsState.status;
  if (limitsLoading) limitsLoading.hidden = status !== "loading";
  if (limitsError) limitsError.hidden = status !== "error";
  if (limitsEmpty) limitsEmpty.hidden = status !== "empty";
  if (limitsChartWrap) limitsChartWrap.hidden = status !== "ready";
  hideLimitsTooltip();
  if (status === "error" && limitsErrorText) {
    limitsErrorText.textContent = limitsState.error || "Не удалось загрузить историю лимитов.";
  }
  if (status === "ready") {
    const series = buildLimitsChart(limitsState.payload);
    renderLimitsLegend(series);
    renderLimitsCredits(limitsState.payload);
  }
  renderLimitsSubtitle();
}

/* Собирает SVG-график и возвращает нормализованные серии (с цветом и текущим
 * значением) для легенды. */
function buildLimitsChart(payload) {
  const rawSeries = Array.isArray(payload?.series) ? payload.series : [];
  /* Полный список доступных серий — с стабильным цветом (по индексу в полном
   * списке, поэтому скрытие серии не перекрашивает остальные). */
  const allSeries = rawSeries
    .filter((item) => Array.isArray(item.points) && item.points.length > 0)
    .map((item, index) => {
      const id = seriesId(item);
      return { ...item, id, color: seriesColor(item, index), hidden: limitsState.hidden.has(id) };
    });
  /* График, шкалы и tooltip строятся только по видимым сериям. */
  const series = allSeries.filter((item) => !item.hidden);

  const times = [];
  for (const item of series) {
    for (const point of item.points) {
      const at = Date.parse(point.at);
      if (Number.isFinite(at)) times.push(at);
    }
  }
  let tMin = payload?.from ? Date.parse(payload.from) : Number.NaN;
  let tMax = payload?.to ? Date.parse(payload.to) : Number.NaN;
  if (!Number.isFinite(tMin)) tMin = times.length ? Math.min(...times) : 0;
  if (!Number.isFinite(tMax)) tMax = times.length ? Math.max(...times) : tMin + 1;
  if (tMax <= tMin) tMax = tMin + 1;

  const W = chartWidth(limitsChart);
  const H = 260;
  const padL = 40;
  const padR = 14;
  const padT = 14;
  // под датой идёт день недели, поэтому нижнее поле выше
  const padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xOf = (t) => padL + ((t - tMin) / (tMax - tMin)) * plotW;
  const yOf = (v) => padT + (1 - clampNumber(Number(v) || 0, 0, 100) / 100) * plotH;

  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "limits-chart-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });

  for (const value of [0, 25, 50, 75, 100]) {
    const y = yOf(value);
    svg.append(svgEl("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "limits-grid-line" }));
    svg.append(svgEl("text", {
      x: padL - 6,
      y: y + 3,
      class: "limits-axis-label limits-axis-y",
      "text-anchor": "end",
    }, [`${value}`]));
  }

  const span = tMax - tMin;
  /* Пока подписей было три, по графику нельзя было сказать, на какой день
     пришёлся скачок. Теперь ось размечена по календарным дням: дата и две
     буквы дня недели, с прореживанием, чтобы подписи не слипались. */
  const dayMs = 24 * 60 * 60_000;
  if (span > dayMs * 1.5) {
    const first = new Date(tMin);
    first.setHours(0, 0, 0, 0);
    const days = [];
    for (let t = first.getTime(); t <= tMax; t += dayMs) {
      if (t >= tMin) days.push(t);
    }
    const step = Math.max(1, Math.ceil(days.length / Math.floor(plotW / 46)));
    days.forEach((t, index) => {
      if (index % step) return;
      const x = xOf(t);
      svg.append(svgEl("line", {
        x1: x, y1: padT, x2: x, y2: padT + plotH, class: "limits-grid-line limits-grid-day",
      }));
      svg.append(svgEl("text", {
        x,
        y: H - 20,
        class: "limits-axis-label limits-axis-x",
        "text-anchor": "middle",
      }, [new Date(t).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })]));
      svg.append(svgEl("text", {
        x,
        y: H - 7,
        class: "limits-axis-label limits-axis-x usage-axis-weekday",
        "text-anchor": "middle",
      }, [weekdayLabel(t)]));
    });
  } else {
    for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
      const t = tMin + span * frac;
      svg.append(svgEl("text", {
        x: xOf(t),
        y: H - 8,
        class: "limits-axis-label limits-axis-x",
        "text-anchor": frac === 0 ? "start" : frac === 1 ? "end" : "middle",
      }, [formatAxisTime(t, span)]));
    }
  }

  for (const item of series) {
    const points = item.points
      .map((point) => ({
        x: xOf(Date.parse(point.at)),
        y: yOf(point.usedPercent),
        raw: point,
      }))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
    if (!points.length) continue;

    const d = points
      .map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
      .join(" ");
    svg.append(svgEl("path", {
      d,
      class: "limits-series-line",
      fill: "none",
      stroke: item.color,
    }));

    const markerPoints = limitsMarkerPoints(points);
    markerPoints.forEach((point) => {
      const isLast = point === points.at(-1);
      const circle = svgEl("circle", {
        cx: point.x,
        cy: point.y,
        r: isLast ? 4 : 2.8,
        class: isLast ? "limits-point limits-point-current" : "limits-point",
        fill: item.color,
      });
      const info = {
        name: item.name || item.id || "",
        window: item.window || "",
        at: point.raw.at,
        used: point.raw.usedPercent,
        remaining: point.raw.remainingPercent,
      };
      const fx = point.x / W;
      const fy = point.y / H;
      circle.addEventListener("pointerenter", () => showLimitsTooltip(info, fx, fy));
      circle.addEventListener("pointerleave", hideLimitsTooltip);
      if (isLast) {
        circle.setAttribute("tabindex", "0");
        circle.setAttribute("role", "img");
        circle.setAttribute("aria-label", limitsTooltipText(info));
        circle.addEventListener("focus", () => showLimitsTooltip(info, fx, fy));
        circle.addEventListener("blur", hideLimitsTooltip);
      }
      svg.append(circle);
    });
  }

  /* Все серии скрыты — оставляем оси и спокойную подсказку вместо ошибки. */
  if (!series.length) {
    svg.append(svgEl("text", {
      x: padL + plotW / 2,
      y: padT + plotH / 2,
      class: "limits-empty-plot",
      "text-anchor": "middle",
    }, ["Все серии скрыты"]));
  }

  const summary = series.length
    ? series
      .map((item) => {
        const last = item.points[item.points.length - 1];
        const used = last ? Math.round(Number(last.usedPercent) || 0) : 0;
        return `${item.name || item.id}: ${used}%`;
      })
      .join("; ")
    : "все серии скрыты";
  limitsChart.setAttribute("aria-label", `Израсходовано лимитов по времени. ${summary}.`);
  limitsChart.replaceChildren(svg);
  return allSeries;
}

/* Легенда показывает все доступные серии, включая скрытые. Каждая запись —
 * настоящая кнопка-переключатель (aria-pressed = «серия видима»), скрытая серия
 * приглушена и перечёркнута через класс is-hidden. */
function renderLimitsLegend(series) {
  if (!limitsLegend) return;
  limitsLegend.replaceChildren(...series.map((item) => {
    const last = item.points[item.points.length - 1];
    const used = last ? Math.round(Number(last.usedPercent) || 0) : null;
    const name = item.name || item.id || "";
    const swatch = el("span", { class: "limits-legend-swatch", "aria-hidden": "true" });
    swatch.style.setProperty("--series-color", item.color);
    const toggle = el("button", {
      type: "button",
      class: `limits-legend-toggle${item.hidden ? " is-hidden" : ""}`,
      "aria-pressed": String(!item.hidden),
      "aria-label": `${item.hidden ? "Показать" : "Скрыть"} серию ${name}`,
      "data-series-id": item.id,
    }, [
      swatch,
      el("span", { class: "limits-legend-name", text: name }),
      item.window ? el("span", { class: "limits-legend-window", text: item.window }) : null,
      used != null ? el("span", { class: "limits-legend-value", text: `Расход ${used}%` }) : null,
    ]);
    toggle.addEventListener("click", () => toggleSeriesVisibility(item.id));
    return el("li", { class: "limits-legend-item" }, [toggle]);
  }));
}

function renderLimitsCredits(payload) {
  if (!limitsCredits) return;
  const credits = payload?.resetCredits;
  const hasCount = credits && credits.availableCount != null;
  const nearest = credits?.nearestExpiresAt ? formatLimitsDateTime(credits.nearestExpiresAt) : "";
  if (!hasCount && !nearest) {
    limitsCredits.hidden = true;
    limitsCredits.replaceChildren();
    return;
  }
  const parts = [];
  if (hasCount) {
    parts.push(el("span", { class: "limits-credit" }, [
      el("span", { class: "limits-credit-label", text: "Кредиты сброса" }),
      el("strong", { class: "limits-credit-value", text: String(credits.availableCount) }),
    ]));
  }
  if (nearest) {
    parts.push(el("span", { class: "limits-credit" }, [
      el("span", { class: "limits-credit-label", text: "Ближайшее сгорание" }),
      el("strong", { class: "limits-credit-value", text: nearest }),
    ]));
  }
  limitsCredits.hidden = false;
  limitsCredits.replaceChildren(...parts);
}

function limitsTooltipText(info) {
  const time = formatLimitsDateTime(info.at);
  const used = Math.round(Number(info.used) || 0);
  const remaining = info.remaining == null
    ? Math.max(0, 100 - used)
    : Math.round(Number(info.remaining) || 0);
  const name = info.window ? `${info.name} · ${info.window}` : info.name;
  return `${name}. ${time}: израсходовано ${used}%, осталось ${remaining}%`;
}

function showLimitsTooltip(info, fx, fy) {
  if (!limitsTooltip) return;
  const used = Math.round(Number(info.used) || 0);
  const remaining = info.remaining == null
    ? Math.max(0, 100 - used)
    : Math.round(Number(info.remaining) || 0);
  limitsTooltip.replaceChildren(
    el("span", { class: "limits-tooltip-title", text: info.window ? `${info.name} · ${info.window}` : info.name }),
    el("span", { class: "limits-tooltip-time", text: formatLimitsDateTime(info.at) }),
    el("span", { class: "limits-tooltip-row", text: `Расход ${used}% · остаток ${remaining}%` }),
  );
  limitsTooltip.style.left = `${clampNumber(fx * 100, 0, 100)}%`;
  limitsTooltip.style.top = `${clampNumber(fy * 100, 0, 100)}%`;
  limitsTooltip.dataset.side = fx > 0.6 ? "left" : "right";
  limitsTooltip.hidden = false;
}

function hideLimitsTooltip() {
  if (!limitsTooltip) return;
  limitsTooltip.hidden = true;
}

limitsRanges?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (!button) return;
  requestLimits(button.dataset.range);
});

document.querySelector("[data-limits-retry]")?.addEventListener("click", () => {
  requestLimits(limitsState.range, { force: true });
});

document.addEventListener("keydown", (event) => {
  if (root.dataset.view !== "statistics") return;
  if (event.key === "-" || event.key === "_") {
    event.preventDefault();
    stepLimitsRange(-1);
    return;
  }
  if (event.key === "+" || event.key === "=") {
    event.preventDefault();
    stepLimitsRange(1);
    return;
  }
});

/* ------------------------------------------------ локальный расход / единицы */

function parseCreditsText(text) {
  const match = String(text ?? "").trim().match(
    /^([\d\s\u00a0]+(?:[,.]\d+)?)\s*(Gcr|Mcr|kcr|cr)$/u,
  );
  if (!match) return Number.NaN;
  const value = Number(match[1].replace(/[\s\u00a0]/gu, "").replace(",", "."));
  const multiplier = { cr: 1, kcr: 1e3, Mcr: 1e6, Gcr: 1e9 }[match[2]];
  return Number.isFinite(value) ? value * multiplier : Number.NaN;
}

function spacedNumber(value, fractionDigits) {
  const fixed = Math.max(0, Number(value) || 0).toFixed(fractionDigits);
  const [integer, fraction] = fixed.split(".");
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/gu, " ");
  return fractionDigits ? `${grouped}.${fraction}` : grouped;
}

function formatScaledUsage(value, suffix) {
  const amount = Math.max(0, Number(value) || 0);
  const scales = [
    [1e9, `G${suffix}`],
    [1e6, `M${suffix}`],
    [1e3, `k${suffix}`],
  ];
  const scale = scales.find(([divisor]) => amount >= divisor);
  if (scale) {
    return `${(amount / scale[0]).toLocaleString("ru-RU", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} ${scale[1]}`;
  }
  return `${amount.toLocaleString("ru-RU", {
    minimumFractionDigits: Number.isInteger(amount) ? 0 : 1,
    maximumFractionDigits: 1,
  })} ${suffix}`;
}

function formatUsageValue(credits, unit = usageUnit) {
  const value = Math.max(0, Number(credits) || 0);
  if (unit === "$") {
    const dollars = value / CREDITS_PER_USD;
    return `$${spacedNumber(dollars, dollars < 1 ? 2 : 1)}`;
  }
  if (unit === "rub") {
    if (!usdRubRate) return "₽—";
    const rubles = (value / CREDITS_PER_USD) * usdRubRate;
    return `₽${spacedNumber(rubles, rubles < 1 ? 2 : 1)}`;
  }
  if (unit === "pte") return formatScaledUsage(value * PTE_PER_CREDIT, "ПТЭ");
  return formatScaledUsage(value, "cr");
}

function refreshUsageUnits(scope = document) {
  for (const node of scope.querySelectorAll(
    "[data-kilo-usage], [data-mega-usage], [data-high-usage]",
  )) {
    if (!node.dataset.usageCredits) {
      const credits = parseCreditsText(node.textContent);
      if (Number.isFinite(credits)) node.dataset.usageCredits = String(credits);
    }
    const credits = Number(node.dataset.usageCredits);
    if (Number.isFinite(credits)) node.textContent = formatUsageValue(credits);
  }
}

function statusFromUsagePayload(payload) {
  if (!payload || payload.error) return payload?.error ? "error" : "empty";
  return Array.isArray(payload.points) && payload.points.length ? "ready" : "empty";
}

function applyUsageHistory(payload) {
  const data = payload && typeof payload === "object" ? payload : null;
  usageState.payload = data;
  usageState.error = data?.error ? String(data.error) : "";
  if (data?.range) usageState.range = normalizeRange(data.range);
  usageState.status = statusFromUsagePayload(data);
  renderUsageRanges();
  renderUsageHistory();
}

function requestUsageHistory(range, { force = false } = {}) {
  usageState.range = normalizeRange(range);
  try {
    localStorage.setItem(USAGE_RANGE_KEY, usageState.range);
  } catch {
    // Выбор останется активным до закрытия WebView.
  }
  const cached = usageState.payload
    && !usageState.payload.error
    && normalizeRange(usageState.payload.range) === usageState.range;
  usageState.status = cached && !force ? statusFromUsagePayload(usageState.payload) : "loading";
  usageState.error = "";
  renderUsageRanges();
  renderUsageHistory();
  emit("usage:open", { range: usageState.range });
}

function renderUsageRanges() {
  for (const button of usageRanges?.querySelectorAll("[data-range]") ?? []) {
    const active = button.dataset.range === usageState.range;
    button.setAttribute("aria-pressed", String(active));
    button.toggleAttribute("data-active", active);
  }
}

function formatUsagePeriod(payload) {
  const from = payload?.from ? formatLimitsDateTime(payload.from) : "";
  const to = payload?.to ? formatLimitsDateTime(payload.to) : "";
  return from && to ? `${from} — ${to}` : RANGE_LABELS[usageState.range] ?? "";
}

function formatUsagePointDate(point, daily = false) {
  const date = new Date(point?.at);
  if (Number.isNaN(date.getTime())) return "";
  return daily
    ? date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "numeric" })
    : formatLimitsDateTime(date);
}

/* Две буквы дня недели под датой: по числу месяца трудно понять, будни это
   или выходные, а на расходе разница видна сразу. */
function weekdayLabel(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("ru-RU", { weekday: "short" }).slice(0, 2).toLowerCase();
}

/* Скорость — тот же расход, приведённый к часу: столбики разных периодов
   становятся сравнимыми между собой. */
function usageBucketHours(payload) {
  const points = Array.isArray(payload?.points) ? payload.points : [];
  if (payload?.bucket === "day") return 24;
  if (points.length > 1) {
    const first = Date.parse(points[0].at);
    const second = Date.parse(points[1].at);
    const hours = Math.abs(second - first) / 3_600_000;
    if (Number.isFinite(hours) && hours > 0) return hours;
  }
  return 1;
}

/* Полотно считается по фактической ширине карточки: при фиксированных 640
   единицах viewBox растягивался вместе с подписями, и текст плыл. */
function chartWidth(target, minimum = 520) {
  const width = Math.round(target?.clientWidth || 0);
  return Math.max(minimum, Math.min(2400, width || minimum));
}

function usagePeriodHours(payload) {
  const from = Date.parse(payload?.from ?? "");
  const to = Date.parse(payload?.to ?? "");
  const hours = (to - from) / 3_600_000;
  return Number.isFinite(hours) && hours > 0 ? hours : 1;
}

function formatUsageRate(credits, hours) {
  const perHour = hours > 0 ? credits / hours : 0;
  return `${formatUsageValue(perHour)}/ч`;
}

function showUsageTooltip(point, fx, fy, daily = false, hours = 0) {
  if (!usageTooltip) return;
  usageTooltip.replaceChildren(
    el("span", { class: "limits-tooltip-time", text: formatUsagePointDate(point, daily) }),
    el("span", {
      class: "limits-tooltip-row",
      text: usageState.mode === "rate"
        ? formatUsageRate(point.credits, hours)
        : formatUsageValue(point.credits),
    }),
  );
  usageTooltip.style.left = `${clampNumber(fx * 100, 0, 100)}%`;
  usageTooltip.style.top = `${clampNumber(fy * 100, 0, 100)}%`;
  usageTooltip.dataset.side = fx > 0.6 ? "left" : "right";
  usageTooltip.hidden = false;
}

function hideUsageTooltip() {
  if (usageTooltip) usageTooltip.hidden = true;
}

function usageAxisTicks(fromMs, toMs, plotW) {
  /* Подписи времени ставятся по круглым отметкам: 15 минут, полчаса, час или
     несколько часов — что первым перестаёт слипаться на текущей ширине. */
  const steps = [15, 30, 60, 120, 180, 360, 720].map((minutes) => minutes * 60_000);
  const span = Math.max(1, toMs - fromMs);
  const step = steps.find((value) => (value / span) * plotW >= 56) ?? steps.at(-1);
  const ticks = [];
  for (let cursor = Math.ceil(fromMs / step) * step; cursor <= toMs; cursor += step) {
    ticks.push(cursor);
  }
  return ticks;
}

function buildUsageChart(payload) {
  const points = (Array.isArray(payload?.points) ? payload.points : [])
    .map((point) => ({
      at: point.at,
      time: Date.parse(point.at),
      credits: Math.max(0, Number(point.credits) || 0),
    }))
    .filter((point) => Number.isFinite(point.time));
  const daily = payload?.bucket === "day";
  const rate = usageState.mode === "rate";
  const hours = usageBucketHours(payload);
  const valueOf = (point) => (rate ? point.credits / Math.max(hours, 0.0001) : point.credits);
  // весь период влезает в карточку: горизонтальная прокрутка графику не нужна
  const W = chartWidth(usageChart);
  const H = 260;
  const padL = 62;
  const padR = 14;
  const padT = 14;
  // под датой идёт день недели, поэтому нижнее поле выше
  const padB = daily ? 52 : 34;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const max = Math.max(1, ...points.map(valueOf));
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "limits-chart-svg usage-chart-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    const value = max * fraction;
    const y = padT + (1 - fraction) * plotH;
    svg.append(svgEl("line", {
      x1: padL,
      y1: y,
      x2: W - padR,
      y2: y,
      class: "limits-grid-line",
    }));
    svg.append(svgEl("text", {
      x: padL - 6,
      y: y + 3,
      class: "limits-axis-label limits-axis-y",
      "text-anchor": "end",
    }, [rate ? `${formatUsageValue(value)}/ч` : formatUsageValue(value)]));
  }

  if (daily) {
    const barStep = plotW / Math.max(1, points.length);
    const barWidth = Math.max(2, Math.min(28, barStep * 0.72));
    /* Подписи прореживаются, а столбики сужаются: тридцать дней должны
       помещаться в карточку целиком, без горизонтальной прокрутки. */
    const labelStep = Math.max(1, Math.ceil(30 / Math.max(barStep, 1)));
    points.forEach((point, index) => {
      const height = valueOf(point) / max * plotH;
      const x = padL + index * barStep + (barStep - barWidth) / 2;
      const y = padT + plotH - height;
      const bar = svgEl("rect", {
        x: x.toFixed(1),
        y: y.toFixed(1),
        width: barWidth.toFixed(1),
        height: Math.max(1, height).toFixed(1),
        rx: Math.min(4, barWidth / 3).toFixed(1),
        class: "usage-bar",
        tabindex: 0,
        role: "img",
        "aria-label": `${formatLimitsDateTime(point.at)}: ${
          rate ? formatUsageRate(point.credits, hours) : formatUsageValue(point.credits)
        }`,
      });
      const fx = (x + barWidth / 2) / W;
      const fy = y / H;
      bar.addEventListener("pointerenter", () => showUsageTooltip(point, fx, fy, daily, hours));
      bar.addEventListener("pointerleave", hideUsageTooltip);
      bar.addEventListener("focus", () => showUsageTooltip(point, fx, fy, daily, hours));
      bar.addEventListener("blur", hideUsageTooltip);
      svg.append(bar);
      if (index % labelStep) return;
      const center = (x + barWidth / 2).toFixed(1);
      svg.append(svgEl("text", {
        x: center,
        y: H - 22,
        class: "limits-axis-label limits-axis-x usage-axis-day",
        "text-anchor": "middle",
      }, [new Date(point.at).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })]));
      svg.append(svgEl("text", {
        x: center,
        y: H - 8,
        class: "limits-axis-label limits-axis-x usage-axis-weekday",
        "text-anchor": "middle",
      }, [weekdayLabel(point.at)]));
    });
  } else if (points.length) {
    /* Внутри суток расход идёт линией, как на графике лимитов: столбики в
       пятнадцатиминутной сетке сливались в частокол. */
    const fromMs = Date.parse(payload?.from ?? points[0].at);
    const toMs = Date.parse(payload?.axisTo ?? payload?.to ?? points.at(-1).at);
    const span = Math.max(1, toMs - fromMs);
    const xOf = (time) => padL + ((time - fromMs) / span) * plotW;
    const yOf = (value) => padT + (1 - value / max) * plotH;
    const baseline = (padT + plotH).toFixed(1);
    const line = points
      .map((point, index) => {
        const command = index ? "L" : "M";
        return `${command}${xOf(point.time).toFixed(1)} ${yOf(valueOf(point)).toFixed(1)}`;
      })
      .join(" ");
    const first = xOf(points[0].time).toFixed(1);
    const last = xOf(points.at(-1).time).toFixed(1);
    svg.append(svgEl("path", {
      d: `${line} L${last} ${baseline} L${first} ${baseline} Z`,
      class: "usage-area",
    }));
    svg.append(svgEl("path", { d: line, class: "usage-line", fill: "none" }));
    for (const tick of usageAxisTicks(fromMs, toMs, plotW)) {
      const x = xOf(tick);
      svg.append(svgEl("line", {
        x1: x,
        y1: padT,
        x2: x,
        y2: padT + plotH,
        class: "limits-grid-line limits-grid-day",
      }));
      svg.append(svgEl("text", {
        x,
        y: H - 10,
        class: "limits-axis-label limits-axis-x",
        "text-anchor": "middle",
      }, [new Date(tick).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })]));
    }
    for (const point of points) {
      if (point.credits <= 0) continue;
      const cx = xOf(point.time);
      const cy = yOf(valueOf(point));
      const dot = svgEl("circle", { cx, cy, r: 2.6, class: "usage-dot" });
      const fx = cx / W;
      const fy = cy / H;
      dot.addEventListener("pointerenter", () => showUsageTooltip(point, fx, fy, daily, hours));
      dot.addEventListener("pointerleave", hideUsageTooltip);
      svg.append(dot);
    }
  }

  usageChart.setAttribute(
    "aria-label",
    rate
      ? `Скорость расхода за ${formatUsagePeriod(payload)}.`
      : `Локальный расход: ${formatUsageValue(payload.totalCredits)} за ${formatUsagePeriod(payload)}.`,
  );
  svg.style.width = "100%";
  usageChart.replaceChildren(svg);
}

function renderUsageHistory() {
  if (!usageLoading) return;
  const status = usageState.status;
  usageLoading.hidden = status !== "loading";
  usageError.hidden = status !== "error";
  usageEmpty.hidden = status !== "empty";
  usageChartWrap.hidden = status !== "ready";
  hideUsageTooltip();
  if (status === "error") {
    usageErrorText.textContent = usageState.error || "Не удалось загрузить локальный расход.";
  }
  const payload = usageState.payload;
  const rate = usageState.mode === "rate";
  if (usageTitle) usageTitle.textContent = rate ? "Скорость расхода" : "Локальный расход";
  for (const button of usageModes?.querySelectorAll("[data-usage-mode]") ?? []) {
    const active = button.dataset.usageMode === usageState.mode;
    button.setAttribute("aria-pressed", String(active));
    button.toggleAttribute("data-active", active);
  }
  usageSubtitle.textContent = payload && !payload.error
    ? formatUsagePeriod(payload)
    : RANGE_LABELS[usageState.range] ?? "";
  /* В режиме скорости итог за период бессмыслен: показывается средний расход
     в час, то есть та же величина, что и на столбиках. */
  usageTotal.textContent = payload && !payload.error
    ? (rate
      ? formatUsageRate(Number(payload.totalCredits) || 0, usagePeriodHours(payload))
      : formatUsageValue(payload.totalCredits))
    : "";
  if (status === "ready") {
    buildUsageChart(payload);
    const unpriced = Math.max(0, Number(payload.unpricedCount) || 0);
    usageNote.textContent = unpriced
      ? `Без тарифа и вне суммы: ${unpriced}.`
      : "Все показанные ходы тарифицированы.";
  }
}

usageRanges?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (button) requestUsageHistory(button.dataset.range);
});
/* Расход и скорость считаются из одних данных, поэтому переключение режима
   ничего не запрашивает — просто перерисовывает карточку. */
usageModes?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-usage-mode]");
  if (!button) return;
  usageState.mode = button.dataset.usageMode === "rate" ? "rate" : "total";
  try {
    localStorage.setItem(USAGE_MODE_KEY, usageState.mode);
  } catch {
    // Выбор останется активным до закрытия WebView.
  }
  renderUsageHistory();
});
document.querySelector("[data-usage-retry]")?.addEventListener("click", () => {
  requestUsageHistory(usageState.range, { force: true });
});

/* ================================================================ ЖУРНАЛ */
/* Ниже — прежняя логика журнала: рендер, ленивая подгрузка старых дней и
 * ходов, сохранение раскрытых секций и переносы лимитов в шапку. Она не
 * изменилась по поведению; поменялось только то, что журнал теперь живёт в
 * отдельной вкладке общей оболочки и грузится при первом открытии. */

const OPEN_STATE_KEY = "agent-hub:journal-open-state:v1";
let currentVersion = "";
let loading = null;
const loadingDays = new Map();
const loadingTurns = new Map();
let journalRendered = false;
let journalRequested = false;
let desiredOpenState = null;

function requestHeaders() {
  if (telegramMode) return { Authorization: `tma ${telegramInitData}` };
  try {
    const deviceToken = String(window.AgentHubAndroid?.getAccessToken?.() ?? "").trim();
    if (deviceToken) return { Authorization: `device ${deviceToken}` };
  } catch {
    // The Android bridge is optional for local web and VS Code.
  }
  const browserToken = String(window.AgentHubBrowserDevice?.getAccessToken?.() ?? "").trim();
  if (browserToken) return { Authorization: `device ${browserToken}` };
  return {};
}

async function authenticatedRequestHeaders() {
  await window.AgentHubBrowserDevice?.ensureSession?.();
  return requestHeaders();
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
    subagents: [...journal.querySelectorAll("details[data-work-log-turn-children-details][open]")]
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
    taskGroups: [...journal.querySelectorAll("details[data-work-log-task-group][open]")]
      .map((item) => ({
        provider: item.dataset.workLogProvider,
        threadId: item.dataset.workLogThreadId,
      }))
      .filter((item) => item.provider && item.threadId),
  };
}

function storedOpenState() {
  try {
    const stored = JSON.parse(localStorage.getItem(OPEN_STATE_KEY) || "null");
    return stored && stored.version === 1 ? stored.value : null;
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

function syncCollapseTurnButtons(scope = journal) {
  const hidden = surface === "mobile";
  for (const button of scope.querySelectorAll("[data-work-log-collapse-turns]")) {
    button.hidden = hidden;
  }
}

function prepareMobileControls(scope = journal) {
  if (surface !== "mobile") return;
  const openDays = [...scope.querySelectorAll("details[data-work-log-day-section][open]")];
  for (const details of openDays.slice(1)) details.open = false;
  for (const total of scope.querySelectorAll("[data-day-usage]")) {
    total.setAttribute("role", "button");
    total.setAttribute("tabindex", "0");
    total.setAttribute("aria-expanded", "false");
  }
  for (const title of scope.querySelectorAll("[data-work-log-task-content]")) {
    if (title.querySelector("[data-open-task]")) {
      title.removeAttribute("role");
      title.removeAttribute("tabindex");
      title.removeAttribute("aria-expanded");
      continue;
    }
    title.setAttribute("role", "button");
    title.setAttribute("tabindex", "0");
    title.setAttribute("aria-expanded", "false");
  }
}

function restoreOpenState(openState) {
  desiredOpenState = openState;
  for (const details of journal.querySelectorAll("details[data-work-log-day-section]")) {
    details.open = false;
  }
  const days = surface === "mobile" ? openState.days.slice(0, 1) : openState.days;
  for (const day of days) {
    for (const details of journal.querySelectorAll("details[data-work-log-day-section]")) {
      if (details.querySelector("summary[data-work-log-day] strong")?.textContent.trim() === day) {
        details.open = true;
      }
    }
  }
  for (const threadId of openState.previous) {
    journal.querySelector(
      `[data-work-log-thread-id="${selectorValue(threadId)}"] details[data-work-log-previous-turns]`,
    )?.setAttribute("open", "");
  }
  for (const threadId of openState.taskUsage) {
    journal.querySelector(
      `[data-work-log-thread-id="${selectorValue(threadId)}"] details[data-task-usage-details]`,
    )?.setAttribute("open", "");
  }
  for (const turnId of openState.turns) {
    journal.querySelector(
      `[data-work-log-turn-id="${selectorValue(turnId)}"] details[data-work-log-turn-details]`,
    )?.setAttribute("open", "");
  }
  for (const turnId of openState.subagents ?? []) {
    journal.querySelector(
      `[data-work-log-turn-id="${selectorValue(turnId)}"] > details[data-work-log-turn-children-details]`,
    )?.setAttribute("open", "");
  }
  for (const day of openState.mobileDays ?? []) {
    for (const details of journal.querySelectorAll("details[data-work-log-day-section]")) {
      if (details.querySelector("summary[data-work-log-day] strong")?.textContent.trim() !== day) {
        continue;
      }
      const table = details.querySelector("[data-day-usage-table]");
      table?.setAttribute("data-mobile-expanded", "");
      table?.querySelector("[data-day-usage]")?.setAttribute("aria-expanded", "true");
    }
  }
  for (const task of openState.mobileTasks ?? []) {
    const row = journal.querySelector(
      `[data-work-log-provider="${selectorValue(task.provider)}"]`
      + `[data-work-log-thread-id="${selectorValue(task.threadId)}"]`,
    );
    if (row) setMobileTaskOpen(row, true);
  }
  void hydrateOpenLazyNodes();
  for (const task of openState.taskGroups ?? []) {
    journal.querySelector(
      `details[data-work-log-task-group]`
      + `[data-work-log-provider="${selectorValue(task.provider)}"]`
      + `[data-work-log-thread-id="${selectorValue(task.threadId)}"]`,
    )?.setAttribute("open", "");
  }
}

function removeJournalRateLimits() {
  journal.querySelector("[data-work-log-rate-limits]")?.remove();
}

function disableLocalLinks(scope = journal) {
  for (const link of scope.querySelectorAll("a")) {
    link.removeAttribute("href");
    link.setAttribute("role", "link");
    link.setAttribute("aria-disabled", "true");
  }
}

async function fetchJournalFragment(pathname, params) {
  await localSessionReady;
  const query = new URLSearchParams({ ...params, version: currentVersion });
  const response = await fetch(`${pathname}?${query}`, {
    cache: "no-store",
    headers: await authenticatedRequestHeaders(),
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
    decorateDayHeadings(replacement);
    groupClaudeRowsInDay(replacement);
    refreshUsageUnits(replacement);
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

function formatTaskDuration(value) {
  const totalSeconds = Math.max(0, Math.round(Number(value) || 0));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor(totalSeconds % 86_400 / 3_600);
  const minutes = Math.floor(totalSeconds % 3_600 / 60);
  const seconds = totalSeconds % 60;
  return [
    days ? `${days} д` : "",
    hours ? `${hours} ч` : "",
    minutes ? `${minutes} мин` : "",
    seconds || (!days && !hours && !minutes) ? `${seconds} с` : "",
  ].filter(Boolean).join(" ");
}

/* Тот же цветовой код, что в журнале по датам: cr — «kilo», kcr — «mega»,
   всё крупнее — «high». Разметка совпадает, поэтому бейдж выглядит одинаково
   в обоих режимах. */
function usageBadge(text, credits = Number.NaN) {
  const unit = /\b(Gcr|Mcr|kcr|cr)$/u.exec(String(text))?.[1] ?? "cr";
  const level = unit === "cr" ? "kilo" : unit === "kcr" ? "mega" : "high";
  const badge = document.createElement("span");
  badge.setAttribute(`data-${level}-usage`, "");
  if (Number.isFinite(Number(credits))) badge.dataset.usageCredits = String(Number(credits));
  badge.textContent = text;
  return badge;
}

function formatTaskCredits(value) {
  const credits = Number(value) || 0;
  const scales = [
    [1e9, "Gcr"],
    [1e6, "Mcr"],
    [1e3, "kcr"],
  ];
  const scale = scales.find(([divisor]) => Math.abs(credits) >= divisor);
  if (scale) {
    return `${(credits / scale[0]).toLocaleString("ru-RU", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })} ${scale[1]}`;
  }
  return `${credits.toLocaleString("ru-RU", {
    minimumFractionDigits: Number.isInteger(credits) ? 0 : 1,
    maximumFractionDigits: 1,
  })} cr`;
}

function groupedTurn(entry, date) {
  const copy = entry.cloneNode(true);
  copy.dataset.workLogSourceDate = date;
  copy.querySelector("[data-work-log-turn-share]")?.remove();
  const measure = copy.querySelector("[data-work-log-turn-measure]");
  if (measure) {
    const day = document.createElement("span");
    day.dataset.workLogTurnDay = "";
    day.textContent = `${date} · `;
    measure.prepend(day);
  }
  return copy;
}

function isRootTurnEntry(entry) {
  const depth = String(entry?.dataset?.workLogTurnDepth ?? "").trim();
  return depth === "0" || (!depth && !entry?.closest?.("[data-work-log-turn-children]"));
}

function plainDateText(value) {
  return String(value ?? "").trim().match(/^\d{2}\.\d{2}\.\d{4}/u)?.[0] ?? "";
}

function parseJournalDate(value) {
  const date = plainDateText(value);
  if (!date) return null;
  const [day, month, year] = date.split(".").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatJournalDate(date) {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone: "UTC",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

function decorateDayHeadings(scope = journal) {
  const weekdays = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  for (const heading of scope.querySelectorAll(
    "summary[data-work-log-day] > strong",
  )) {
    const date = parseJournalDate(heading.textContent);
    if (!date) continue;
    const plain = formatJournalDate(date);
    heading.dataset.workLogDate = plain;
    heading.textContent = `${plain} ${weekdays[date.getUTCDay()]}`;
  }
}

function creditsFromEntries(entries) {
  let total = 0;
  let known = 0;
  for (const entry of entries) {
    const value = Number(entry.dataset.workLogTurnCredits);
    if (!Number.isFinite(value) || value < 0) continue;
    total += value;
    known += 1;
  }
  return { total, known };
}

function replaceCollapsedTurnList(list, entries) {
  if (!list) return;
  const table = document.createElement("div");
  table.dataset.workLogTurnTable = "";
  const [latest, ...previousEntries] = entries;
  if (latest) table.append(latest);
  if (previousEntries.length) {
    const previous = document.createElement("details");
    previous.dataset.workLogPreviousTurns = "";
    const summary = document.createElement("summary");
    summary.append(
      el("span", {
        "data-work-log-previous-turns-closed": "",
        text: `Показать предыдущие ходы (${previousEntries.length})`,
      }),
      el("span", {
        "data-work-log-previous-turns-open": "",
        text: "Свернуть",
      }),
    );
    const previousList = document.createElement("div");
    previousList.dataset.workLogPreviousTurnList = "";
    previousList.append(...previousEntries);
    previous.append(summary, previousList);
    table.append(previous);
  } else if (latest) {
    table.append(el("div", {
      "data-work-log-no-previous-turns": "",
      text: "Предыдущих ходов нет.",
    }));
  }
  list.replaceChildren(table);
}

function groupClaudeRowsInDay(day) {
  if (!groupClaudeTasks) return;
  const rows = [...day.querySelectorAll(
    ":scope [data-work-log-row][data-work-log-provider='claude']",
  )];
  if (!rows.length) return;
  const primary = rows[0];
  const entries = [];
  const metricEntries = [];
  const seen = new Set();
  for (const row of rows) {
    for (const entry of row.querySelectorAll("[data-work-log-turn-entry]")) {
      const id = entry.dataset.workLogTurnId || `${entries.length}`;
      if (seen.has(id)) continue;
      seen.add(id);
      metricEntries.push(entry);
      if (isRootTurnEntry(entry)) entries.push(entry.cloneNode(true));
    }
  }
  entries.sort((left, right) => (
    (Date.parse(right.dataset.workLogTurnCompletedAt ?? "") || 0)
      - (Date.parse(left.dataset.workLogTurnCompletedAt ?? "") || 0)
  ));
  primary.dataset.workLogThreadId = "work";
  const title = primary.querySelector("[data-work-log-task-content]");
  if (title) {
    const label = document.createElement("span");
    label.dataset.workLogClaudeWork = "";
    label.textContent = "Claude - Work";
    title.replaceChildren(label);
  }
  const list = primary.querySelector("[data-work-log-turn-list]");
  replaceCollapsedTurnList(list, entries);
  const usage = primary.querySelector("[data-work-log-usage]");
  if (usage) {
    const totals = creditsFromEntries(metricEntries);
    if (state.selection.includeClaudeUsage === false) {
      const collapse = document.createElement("button");
      collapse.type = "button";
      collapse.dataset.workLogCollapseTurns = "";
      collapse.textContent = "Свернуть ходы";
      usage.replaceChildren(collapse);
    } else if (totals.known) {
      const details = document.createElement("details");
      details.dataset.taskUsageDetails = "";
      const summary = document.createElement("summary");
      summary.dataset.taskUsage = "";
      summary.append(
        el("span", { "data-usage-label": "", text: "Итого" }),
        " ",
        usageBadge(formatUsageValue(totals.total), totals.total),
      );
      details.append(summary);
      const collapse = document.createElement("button");
      collapse.type = "button";
      collapse.dataset.workLogCollapseTurns = "";
      collapse.textContent = "Свернуть ходы";
      usage.replaceChildren(details, collapse);
    } else {
      usage.replaceChildren();
    }
  }
  for (const row of rows.slice(1)) row.remove();
}

function periodIdentity(value, mode) {
  const date = parseJournalDate(value);
  if (!date) return null;
  if (mode === "month") {
    const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
    return {
      key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`,
      sort: start.getTime(),
      label: new Intl.DateTimeFormat("ru-RU", {
        timeZone: "UTC",
        month: "long",
        year: "numeric",
      }).format(start),
    };
  }
  const mondayOffset = (date.getUTCDay() + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - mondayOffset);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  return {
    key: start.toISOString().slice(0, 10),
    sort: start.getTime(),
    label: `${formatJournalDate(start)} — ${formatJournalDate(end)}`,
  };
}

function periodGroupingContent(source, mode) {
  const periods = new Map();
  for (const day of source.querySelectorAll("details[data-work-log-day-section]")) {
    const date = day.querySelector("summary[data-work-log-day] strong")?.dataset.workLogDate
      ?? plainDateText(day.querySelector("summary[data-work-log-day] strong")?.textContent);
    const period = periodIdentity(date, mode);
    if (!period) continue;
    if (!periods.has(period.key)) periods.set(period.key, { ...period, days: [] });
    periods.get(period.key).days.push(day.cloneNode(true));
  }
  const fragment = document.createDocumentFragment();
  const ordered = [...periods.values()].sort((left, right) => right.sort - left.sort);
  ordered.forEach((period, index) => {
    const section = document.createElement("details");
    section.dataset.workLogPeriodSection = mode;
    section.open = index === 0;
    const summary = document.createElement("summary");
    summary.dataset.workLogPeriod = "";
    summary.append(el("strong", { text: period.label }));
    const sourceDays = document.createElement("div");
    sourceDays.append(...period.days);
    const groups = taskGroupsFrom(sourceDays);
    const total = groups.reduce((sum, group) => sum + (Number(group.credits) || 0), 0);
    if (groups.some((group) => Number.isFinite(group.credits))) {
      summary.append(el("span", { class: "period-usage" }, [
        el("span", { "data-usage-label": "", text: "Итого" }),
        " ",
        usageBadge(formatUsageValue(total), total),
      ]));
    }
    section.append(summary, taskGroupingContent(sourceDays, {
      overview: `Задач: ${groups.length}.`,
    }));
    fragment.append(section);
  });
  return fragment;
}

const taskProfileAxes = [
  {
    key: "turnCount",
    label: "Ходы",
    format: (value) => `${Math.round(value)} шт.`,
  },
  {
    key: "credits",
    label: "Расход",
    format: (value) => formatUsageValue(value),
  },
  {
    key: "durationSeconds",
    label: "Время",
    format: formatTaskDuration,
  },
  {
    key: "fileTouches",
    label: "Файлы",
    format: (value) => `${Math.round(value)} кас.`,
  },
  {
    key: "changedLines",
    label: "Diff",
    format: (value) => `${Math.round(value)} строк`,
  },
  {
    key: "subagentShare",
    label: "Субагенты",
    format: (value) => `${Math.round(value)}% ходов`,
    linear: true,
  },
  {
    key: "skillCount",
    label: "Навыки",
    format: (value) => `${Math.round(value)} уник.`,
    expandable: true,
    detailItems: (group) => group.skillNames ?? [],
    emptyDetails: "Навыки не использовались",
  },
  {
    key: "mcpCallCount",
    label: "MCP",
    format: (value) => `${Math.round(value)} выз.`,
    expandable: true,
    detailItems: (group) => group.mcpTools ?? [],
    emptyDetails: "MCP-вызовов не было",
    detailNote: (group) => group.mcpFailures
      ? `Завершились с ошибкой: ${group.mcpFailures}`
      : "",
  },
];

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function profileScale(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return 1;
  return Math.max(1, sorted[Math.max(0, Math.ceil(sorted.length * 0.9) - 1)]);
}

function profileScore(value, scale, linear = false) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  const ratio = linear
    ? value / scale
    : Math.log1p(value) / Math.log1p(scale);
  return Math.max(0, Math.min(100, ratio * 100));
}

function svgElement(tag, attributes = {}) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

function radarPoint(index, value, radius = 78) {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / taskProfileAxes.length;
  const distance = radius * value / 100;
  return {
    x: 180 + Math.cos(angle) * distance,
    y: 126 + Math.sin(angle) * distance,
  };
}

function radarPolygon(values, radius = 78) {
  return values.map((value, index) => {
    const point = radarPoint(index, value, radius);
    return `${point.x.toFixed(1)},${point.y.toFixed(1)}`;
  }).join(" ");
}

function formatProfileAxisValue(axis, value) {
  return Number.isFinite(value) ? axis.format(value) : "нет данных";
}

function taskProfileAccordion(axis, group) {
  const details = document.createElement("details");
  details.dataset.workLogTaskProfileDetail = axis.key;
  if (!Number.isFinite(group[axis.key])) details.dataset.missing = "";

  const summary = document.createElement("summary");
  summary.dataset.workLogTaskProfileDetailSummary = "";
  summary.append(
    el("span", { text: axis.label }),
    el("strong", { text: formatProfileAxisValue(axis, group[axis.key]) }),
  );

  const content = document.createElement("div");
  content.dataset.workLogTaskProfileDetailContent = "";
  const items = Number.isFinite(group[axis.key]) ? axis.detailItems?.(group) ?? [] : [];
  if (items.length) {
    const list = document.createElement("div");
    list.dataset.workLogTaskProfileDetailItems = "";
    for (const item of items) {
      list.append(el("span", { text: item }));
    }
    content.append(list);
  } else {
    content.append(el("span", {
      "data-work-log-task-profile-detail-empty": "",
      text: Number.isFinite(group[axis.key])
        ? axis.emptyDetails
        : "Для старых ходов подробные данные недоступны",
    }));
  }
  const note = Number.isFinite(group[axis.key]) ? axis.detailNote?.(group) : "";
  if (note) content.append(el("span", {
    "data-work-log-task-profile-detail-note": "",
    text: note,
  }));
  details.append(summary, content);
  return details;
}

function taskProfile(group, cohort) {
  const comparableCohort = cohort.filter((item) => item.provider === group.provider);
  const scales = Object.fromEntries(taskProfileAxes.map((axis) => [
    axis.key,
    profileScale(comparableCohort.map((item) => item[axis.key])),
  ]));
  const baselines = Object.fromEntries(taskProfileAxes.map((axis) => [
    axis.key,
    median(comparableCohort.map((item) => item[axis.key])),
  ]));
  const currentScores = taskProfileAxes.map((axis) => (
    profileScore(group[axis.key], scales[axis.key], axis.linear)
  ));
  const baselineScores = taskProfileAxes.map((axis) => (
    profileScore(baselines[axis.key], scales[axis.key], axis.linear)
  ));

  const section = document.createElement("section");
  section.dataset.workLogTaskProfile = "";
  const copy = document.createElement("div");
  copy.dataset.workLogTaskProfileCopy = "";
  const heading = document.createElement("div");
  heading.dataset.workLogTaskProfileHeading = "";
  const title = document.createElement("strong");
  title.textContent = "Профиль задачи";
  const caption = document.createElement("span");
  const providerLabel = group.provider === "claude" ? "Claude" : "Codex";
  caption.textContent = `Относительно видимых задач ${providerLabel}. Больше — не лучше, а больше по масштабу.`;
  heading.append(title, caption);
  const values = document.createElement("div");
  values.dataset.workLogTaskProfileValues = "";
  for (const axis of taskProfileAxes) {
    if (axis.expandable) {
      values.append(taskProfileAccordion(axis, group));
      continue;
    }
    const item = document.createElement("div");
    item.dataset.workLogTaskProfileValue = axis.key;
    const label = document.createElement("span");
    label.textContent = axis.label;
    const value = document.createElement("strong");
    value.textContent = Number.isFinite(group[axis.key])
      ? axis.format(group[axis.key])
      : "нет данных";
    if (!Number.isFinite(group[axis.key])) item.dataset.missing = "";
    item.append(label, value);
    values.append(item);
  }
  copy.append(heading, values);

  const figure = document.createElement("figure");
  figure.dataset.workLogTaskRadar = "";
  const tooltip = document.createElement("div");
  tooltip.dataset.radarTooltip = "";
  tooltip.hidden = true;
  tooltip.setAttribute("role", "tooltip");
  const showTooltip = (axis, index, point) => {
    const currentValue = formatProfileAxisValue(axis, group[axis.key]);
    const baselineValue = formatProfileAxisValue(axis, baselines[axis.key]);
    tooltip.replaceChildren(
      el("strong", { text: axis.label }),
      el("span", { text: `Эта задача: ${currentValue}` }),
      el("span", { text: `Медиана: ${baselineValue}` }),
    );
    tooltip.style.setProperty("--radar-tooltip-x", `${point.x / 360 * 100}%`);
    tooltip.style.setProperty("--radar-tooltip-y", `${point.y / 260 * 100}%`);
    tooltip.dataset.axis = String(index);
    tooltip.hidden = false;
  };
  const hideTooltip = () => {
    tooltip.hidden = true;
    delete tooltip.dataset.axis;
  };
  const bindTooltip = (node, axis, index, point) => {
    node.addEventListener("pointerenter", () => showTooltip(axis, index, point));
    node.addEventListener("pointerleave", hideTooltip);
    node.addEventListener("focus", () => showTooltip(axis, index, point));
    node.addEventListener("blur", hideTooltip);
  };
  const svg = svgElement("svg", {
    viewBox: "0 0 360 260",
    role: "img",
    "aria-label": taskProfileAxes.map((axis) => (
      `${axis.label}: ${Number.isFinite(group[axis.key]) ? axis.format(group[axis.key]) : "нет данных"}`
    )).join("; "),
  });
  for (const level of [25, 50, 75, 100]) {
    const ring = svgElement("polygon", {
      points: radarPolygon(taskProfileAxes.map(() => level)),
      "data-radar-ring": level,
    });
    svg.append(ring);
  }
  for (let index = 0; index < taskProfileAxes.length; index += 1) {
    const end = radarPoint(index, 100);
    svg.append(svgElement("line", {
      x1: 180,
      y1: 126,
      x2: end.x,
      y2: end.y,
      "data-radar-spoke": "",
    }));
  }
  svg.append(
    svgElement("polygon", {
      points: radarPolygon(baselineScores),
      "data-radar-baseline": "",
    }),
    svgElement("polygon", {
      points: radarPolygon(currentScores),
      "data-radar-current": "",
    }),
  );
  currentScores.forEach((score, index) => {
    const point = radarPoint(index, score);
    const axis = taskProfileAxes[index];
    const dot = svgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 3.3,
      "data-radar-point": "",
    });
    if (!Number.isFinite(group[axis.key])) dot.dataset.missing = "";
    const hit = svgElement("circle", {
      cx: point.x,
      cy: point.y,
      r: 13,
      tabindex: 0,
      focusable: true,
      "aria-label": `${axis.label}. Эта задача: ${
        formatProfileAxisValue(axis, group[axis.key])
      }. Медиана: ${formatProfileAxisValue(axis, baselines[axis.key])}.`,
      "data-radar-hit": axis.key,
    });
    bindTooltip(hit, axis, index, point);
    svg.append(dot, hit);
  });
  taskProfileAxes.forEach((axis, index) => {
    const point = radarPoint(index, 138, 78);
    const label = svgElement("text", {
      x: point.x,
      y: point.y,
      "text-anchor": Math.abs(point.x - 180) < 8 ? "middle" : point.x < 180 ? "end" : "start",
      "dominant-baseline": "middle",
      "data-radar-label": axis.key,
    });
    label.textContent = axis.label;
    bindTooltip(label, axis, index, radarPoint(index, currentScores[index]));
    svg.append(label);
  });
  const legend = document.createElement("figcaption");
  legend.innerHTML = [
    '<span data-radar-legend="current">Эта задача</span>',
    '<span data-radar-legend="baseline">Медиана</span>',
  ].join("");
  figure.append(svg, tooltip, legend);
  section.append(copy, figure);
  return section;
}

function taskGroupsFrom(source) {
  const groups = new Map();
  let order = 0;
  for (const day of source.querySelectorAll("details[data-work-log-day-section]")) {
    const date = day.querySelector("summary[data-work-log-day] strong")?.dataset.workLogDate
      ?? plainDateText(day.querySelector("summary[data-work-log-day] strong")?.textContent);
    if (!date) continue;
    for (const row of day.querySelectorAll("[data-work-log-row]")) {
      const provider = String(row.dataset.workLogProvider ?? "").trim();
      const sourceThreadId = String(row.dataset.workLogThreadId ?? "").trim();
      const groupedClaude = groupClaudeTasks && provider === "claude";
      const threadId = groupedClaude ? "work" : sourceThreadId;
      if (!provider || !threadId) continue;
      const key = `${provider}\u001f${threadId}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          provider,
          threadId,
          title: groupedClaude
            ? el("span", { "data-work-log-claude-work": "", text: "Claude - Work" })
            : row.querySelector("[data-work-log-task-content]")?.cloneNode(true),
          turns: [],
          turnCount: 0,
          legacy: [],
          seenTurns: new Set(),
          durationSeconds: 0,
          knownDurations: 0,
          unknownDurations: 0,
          credits: 0,
          knownCredits: 0,
          unknownCredits: 0,
          latestAt: 0,
          fileTouches: 0,
          knownFileTouches: 0,
          changedLines: 0,
          knownChangedLines: 0,
          subagentTurns: 0,
          knownSubagentTurns: 0,
          skillNames: new Set(),
          mcpCallCount: 0,
          mcpTools: new Set(),
          mcpFailures: 0,
          knownToolMetricTurns: 0,
          order: order++,
        };
        groups.set(key, group);
      }
      for (const entry of row.querySelectorAll("[data-work-log-turn-entry]")) {
        const turnId = String(entry.dataset.workLogTurnId ?? "").trim();
        if (turnId && group.seenTurns.has(turnId)) continue;
        if (turnId) group.seenTurns.add(turnId);
        group.turnCount += 1;
        const elapsed = Number(entry.dataset.workLogTurnDurationSeconds);
        if (Number.isFinite(elapsed) && elapsed >= 0) {
          group.durationSeconds += elapsed;
          group.knownDurations += 1;
        } else {
          group.unknownDurations += 1;
        }
        const creditValue = entry.dataset.workLogTurnCredits;
        const credits = creditValue === undefined ? Number.NaN : Number(creditValue);
        if (Number.isFinite(credits) && credits >= 0) {
          group.credits += credits;
          group.knownCredits += 1;
        } else {
          group.unknownCredits += 1;
        }
        const completedAt = Date.parse(entry.dataset.workLogTurnCompletedAt ?? "");
        if (Number.isFinite(completedAt)) group.latestAt = Math.max(group.latestAt, completedAt);
        const fileCount = entry.dataset.workLogTurnFileCount;
        if (fileCount !== undefined && Number.isFinite(Number(fileCount))) {
          group.fileTouches += Math.max(0, Number(fileCount));
          group.knownFileTouches += 1;
        }
        const changedLines = entry.dataset.workLogTurnChangeLines;
        if (changedLines !== undefined && Number.isFinite(Number(changedLines))) {
          group.changedLines += Math.max(0, Number(changedLines));
          group.knownChangedLines += 1;
        }
        const subagent = entry.dataset.workLogTurnSubagent;
        if (subagent !== undefined) {
          group.subagentTurns += subagent === "1" ? 1 : 0;
          group.knownSubagentTurns += 1;
        }
        const skillNames = entry.dataset.workLogTurnSkills;
        const mcpCalls = entry.dataset.workLogTurnMcpCalls;
        if (skillNames !== undefined && mcpCalls !== undefined) {
          try {
            for (const name of JSON.parse(skillNames)) {
              if (String(name).trim()) group.skillNames.add(String(name).trim());
            }
            for (const tool of JSON.parse(entry.dataset.workLogTurnMcpTools ?? "[]")) {
              if (String(tool).trim()) group.mcpTools.add(String(tool).trim());
            }
          } catch {
            // Повреждённые дополнительные метрики не должны скрывать журнал.
          }
          group.mcpCallCount += Math.max(0, Number(mcpCalls) || 0);
          group.mcpFailures += Math.max(
            0,
            Number(entry.dataset.workLogTurnMcpFailures) || 0,
          );
          group.knownToolMetricTurns += 1;
        }
        if (isRootTurnEntry(entry)) group.turns.push(groupedTurn(entry, date));
      }
      for (const outcome of row.querySelectorAll("[data-work-log-legacy-outcome]")) {
        const wrapper = document.createElement("div");
        wrapper.dataset.workLogGroupedLegacy = "";
        const label = document.createElement("span");
        label.dataset.workLogTurnDay = "";
        label.textContent = date;
        wrapper.append(label, outcome.cloneNode(true));
        group.legacy.push(wrapper);
      }
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      turnCount: group.turnCount,
      credits: group.knownCredits ? group.credits : null,
      durationSeconds: group.knownDurations ? group.durationSeconds : null,
      fileTouches: group.knownFileTouches ? group.fileTouches : null,
      changedLines: group.knownChangedLines ? group.changedLines : null,
      subagentShare: group.knownSubagentTurns
        ? group.subagentTurns / group.knownSubagentTurns * 100
        : null,
      skillNames: [...group.skillNames].sort((left, right) => left.localeCompare(right)),
      skillCount: group.knownToolMetricTurns ? group.skillNames.size : null,
      mcpCallCount: group.knownToolMetricTurns ? group.mcpCallCount : null,
      mcpTools: [...group.mcpTools].sort((left, right) => left.localeCompare(right)),
    }))
    .sort((left, right) => right.latestAt - left.latestAt || left.order - right.order);
}

function appendTaskGroupTurnPage(details, { nextPage = false } = {}) {
  const turns = taskGroupTurns.get(details);
  const body = details?.querySelector(":scope > [data-work-log-task-group-turns]");
  if (!turns || !body) return;
  const rendered = Math.max(0, Number(body.dataset.workLogTaskRendered) || 0);
  if (rendered > 0 && !nextPage) return;
  body.querySelector("[data-work-log-task-show-more]")?.remove();
  const next = Math.min(turns.length, rendered + TASK_GROUP_TURN_PAGE_SIZE);
  body.append(...turns.slice(rendered, next));
  body.dataset.workLogTaskRendered = String(next);
  refreshUsageUnits(body);
  disableLocalLinks(body);
  if (next >= turns.length) return;
  const more = document.createElement("button");
  more.type = "button";
  more.dataset.workLogTaskShowMore = "";
  more.textContent = `Показать ещё (${turns.length - next})`;
  more.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    appendTaskGroupTurnPage(details, { nextPage: true });
  });
  body.append(more);
}

function taskGroupingContent(source, { overview: overviewText = "" } = {}) {
  const groups = taskGroupsFrom(source);
  if (!groups.length) return source.cloneNode(true);
  const fragment = document.createDocumentFragment();
  const overview = document.createElement("div");
  overview.dataset.workLogTaskOverview = "";
  overview.textContent = overviewText || `Задач: ${groups.length}. Ходы собраны за все даты журнала.`;
  fragment.append(overview);
  const list = document.createElement("div");
  list.dataset.workLogTaskGroups = "";
  for (const group of groups) {
    const details = document.createElement("details");
    details.dataset.workLogTaskGroup = "";
    details.dataset.workLogProvider = group.provider;
    details.dataset.workLogThreadId = group.threadId;
    const summary = document.createElement("summary");
    summary.dataset.workLogTaskGroupSummary = "";
    const title = document.createElement("div");
    title.dataset.workLogTaskGroupTitle = "";
    if (group.title) title.append(group.title);
    else title.textContent = `${group.provider} · ${group.threadId}`;
    const metrics = document.createElement("div");
    metrics.dataset.workLogTaskMetrics = "";
    const turns = document.createElement("span");
    turns.dataset.workLogTaskTurnCount = String(group.turns.length);
    turns.textContent = `Ходов: ${group.turns.length}`;
    /* Подписи и окраска — как в режиме по датам: там «Итого» и значение в
       цветном бейдже по порядку величины, а здесь стояли длинные подписи и
       ровный текст, из-за чего два режима выглядели разными продуктами. */
    const credits = document.createElement("span");
    credits.dataset.workLogTaskCredits = String(group.credits);
    const creditsLabel = document.createElement("span");
    creditsLabel.dataset.usageLabel = "";
    creditsLabel.textContent = "Итого";
    credits.append(creditsLabel, " ");
    if (group.knownCredits) {
      credits.append(usageBadge(formatUsageValue(group.credits), group.credits));
    }
    else credits.append("нет данных");
    const duration = document.createElement("span");
    duration.dataset.workLogTaskDuration = String(group.durationSeconds);
    const durationLabel = document.createElement("span");
    durationLabel.dataset.usageLabel = "";
    durationLabel.textContent = "Длит.";
    duration.append(
      durationLabel,
      ` ${group.knownDurations ? formatTaskDuration(group.durationSeconds) : "неизвестна"}`,
    );
    metrics.append(turns, credits, duration);
    if (group.unknownCredits) {
      const unknown = document.createElement("span");
      unknown.dataset.workLogTaskUnknownCredits = String(group.unknownCredits);
      unknown.textContent = `Без данных по кредитам: ${group.unknownCredits}`;
      metrics.append(unknown);
    }
    if (group.unknownDurations) {
      const unknown = document.createElement("span");
      unknown.dataset.workLogTaskUnknownDurations = String(group.unknownDurations);
      unknown.textContent = `Без времени: ${group.unknownDurations}`;
      metrics.append(unknown);
    }
    summary.append(title, metrics);
    const body = document.createElement("div");
    body.dataset.workLogTaskGroupTurns = "";
    details.append(summary, taskProfile(group, groups), body);
    taskGroupTurns.set(details, [...group.turns, ...group.legacy]);
    list.append(details);
  }
  fragment.append(list);
  return fragment;
}

let journalRenderSequence = 0;

async function hydrateAllLazyDays() {
  const days = [...journal.querySelectorAll(
    "details[data-work-log-day-section][data-lazy-day]",
  )];
  await Promise.all(days.map(loadLazyDay));
}

function applyJournalGrouping() {
  decorateDayHeadings(journal);
  if (grouping === "date") {
    for (const day of journal.querySelectorAll("details[data-work-log-day-section]")) {
      groupClaudeRowsInDay(day);
    }
  } else if (grouping === "task") {
    journal.replaceChildren(taskGroupingContent(journal));
  } else {
    journal.replaceChildren(periodGroupingContent(journal, grouping));
  }
  refreshUsageUnits(journal);
  disableLocalLinks();
  syncCollapseTurnButtons();
  prepareMobileControls();
  const saved = groupingStates[grouping];
  if (saved) restoreOpenState(saved);
  if (grouping === "task") {
    for (const details of journal.querySelectorAll(
      "details[data-work-log-task-group][open]",
    )) appendTaskGroupTurnPage(details);
  }
  journalRendered = true;
  journal.setAttribute("aria-busy", "false");
}

function renderJournal() {
  const sequence = ++journalRenderSequence;
  const template = document.createElement("template");
  template.innerHTML = journalHtml;
  journal.replaceChildren(template.content.cloneNode(true));
  removeJournalRateLimits();
  if (grouping === "date") {
    applyJournalGrouping();
    return;
  }
  journal.setAttribute("aria-busy", "true");
  void hydrateAllLazyDays().then(() => {
    if (sequence !== journalRenderSequence) return;
    applyJournalGrouping();
  }).catch((error) => {
    if (sequence !== journalRenderSequence) return;
    journal.setAttribute("aria-busy", "false");
    showToast(`Не удалось собрать журнал: ${error.message}`);
  });
}

async function loadJournal({ force = false } = {}) {
  if (loading) return loading;
  loading = (async () => {
    refreshButton.disabled = true;
    try {
      await localSessionReady;
      const headers = await authenticatedRequestHeaders();
      if (!force && currentVersion) headers["If-None-Match"] = `"${currentVersion}"`;
      const response = await fetch(`/api/journal?now=${Date.now()}`, {
        cache: "no-store",
        headers,
      });
      if (response.status === 304) return;
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (force || payload.version !== currentVersion) {
        const openState = journalRendered ? captureOpenState() : storedOpenState();
        if (openState) groupingStates[grouping] = openState;
        journalHtml = payload.html;
        renderJournal();
        persistOpenState();
        currentVersion = payload.version;
      }
      const date = new Date(payload.updatedAt);
      /* На телефоне секунды съедают place в шапке, где рядом стоят лимиты и
         выбор темы; точное время остаётся в подсказке кнопки. */
      const stamp = Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleTimeString("ru-RU", {
            hour: "2-digit",
            minute: "2-digit",
            ...(surface === "mobile" ? {} : { second: "2-digit" }),
          });
      const exact = Number.isNaN(date.getTime())
        ? ""
        : date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      updatedAt.textContent = stamp || "Обновить";
      refreshButton.title = exact ? `Журнал обновлён в ${exact}` : "Обновить журнал";
      journal.setAttribute("aria-busy", "false");
    } catch (error) {
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

/* Журнал грузится при первом открытии вкладки; дальше его обновляют SSE или
 * опрос. Ленивая подгрузка старых дней сохраняется. */
function ensureJournalLoaded() {
  if (journalRequested) return;
  journalRequested = true;
  void loadJournal({ force: true });
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
  if (event.target.closest("[data-open-task]")) return;
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
  if (opened.matches?.("details[data-work-log-task-group][open]")) {
    appendTaskGroupTurnPage(opened);
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

/* Обновления журнала: в Telegram — опрос, в браузере/VS Code — SSE. Загрузка
 * начинается только после первого открытия вкладки журнала. */
if (telegramMode) {
  const polling = setInterval(() => {
    if (journalRequested) void loadJournal();
  }, 5_000);
  window.addEventListener("pagehide", () => clearInterval(polling), { once: true });
} else if (!vscodeMode && !window.AgentHubAndroid && !window.AgentHubBrowserDevice) {
  const events = new EventSource("/events");
  events.addEventListener("ready", () => {
    AgentHub.setConnection("online");
    if (journalRequested) void loadJournal();
  });
  events.addEventListener("journal", () => {
    if (journalRequested) void loadJournal();
  });
  events.addEventListener("error", () => AgentHub.setConnection("connecting"));
}
if (vscodeMode) {
  window.addEventListener("message", (event) => {
    if (event.data?.type === "agenthub:journal-changed") {
      if (journalRequested) void loadJournal({ force: event.data.force === true });
    }
    if (event.data?.type === "theme") applyTheme(event.data.theme);
  });
}

/* ------------------------------------------------------------- инициализация */

AgentHub.setConnection(telegramMode ? "online" : "connecting");
const taskDurationTimer = window.setInterval(refreshTaskDurations, 1_000);
restorePersistedDrafts();
window.addEventListener("pagehide", () => {
  saveDraft();
  clearInterval(taskDurationTimer);
}, { once: true });
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveDraft();
});
renderTasks();
renderChat();
renderOptions();
const initialNavigationTab = storedNavigationTab();
if (["journal", "statistics"].includes(initialNavigationTab)) {
  setView(initialNavigationTab, { persist: false, activate: false });
} else {
  setView("chat", { persist: false, activate: false });
  setPane(initialNavigationTab, { persist: false });
}
window.addEventListener("DOMContentLoaded", () => activateView(currentNavigationTab()), {
  once: true,
});
autosizeComposer();
