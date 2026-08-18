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
const {
  TURN_TRACE_ACTIVITY_GROUP_ID,
  USER_MESSAGE_COLLAPSE_HEIGHT_PX,
  hasCollapsedOverflow,
  liveActivityDisclosureOpen,
  liveActivityTitle,
  liveStageParts,
  standaloneLiveStageDetail,
  liveTraceDisclosureOpen,
  turnTraceContent,
} = window.AgentHubMessageDisclosure;
const chatSurfacePreference = window.AgentHubChatSurfacePreference;
const backgroundMotionPreference = window.AgentHubBackgroundMotionPreference;
const backgroundImageResolver = window.AgentHubBackgroundImageResolver;
const JournalView = window.AgentHubJournalView;
const MessageView = window.AgentHubMessageView;
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
const backgroundMotionToggle = document.querySelector("[data-background-motion-toggle]");
const chatBackgroundToggle = document.querySelector("[data-chat-background-toggle]");
const journalGroupingButtons = [...document.querySelectorAll("[data-journal-grouping]")];
const journalPrimaryColumn = document.querySelector("[data-journal-primary-column]");
const journalWorkspaceCount = document.querySelector("[data-journal-workspace-count]");
const journalTotalCredits = document.querySelector("[data-journal-total-credits]");
const journalTotalDuration = document.querySelector("[data-journal-total-duration]");
const themeColor = document.querySelector("[data-theme-color]");

const taskList = document.querySelector("[data-task-list]");
const taskEmpty = document.querySelector("[data-task-empty]");
const taskCount = document.querySelector("[data-task-count]");
const taskFilter = document.querySelector("[data-task-filter]");
const activityRail = document.querySelector("[data-activity-rail]");
const activityRailToggle = document.querySelector("[data-activity-rail-toggle]");
const activityRailCount = document.querySelector("[data-activity-rail-count]");
const activityStreamList = document.querySelector("[data-activity-stream-list]");
const activityStreamEmpty = document.querySelector("[data-activity-stream-empty]");
const activityRecentList = document.querySelector("[data-activity-recent-list]");
const activityRecentEmpty = document.querySelector("[data-activity-recent-empty]");
const workspaceCardModal = document.querySelector("[data-workspace-card-modal]");
const workspaceCardForm = document.querySelector("[data-workspace-card-form]");
const workspaceCardTitle = document.querySelector("[data-workspace-card-title]");
const workspaceCardName = document.querySelector("[data-workspace-card-name]");
const workspaceCardComment = document.querySelector("[data-workspace-card-comment]");
const workspaceCardWorkingDirectory = document.querySelector("[data-workspace-card-working-directory]");
const workspaceCardRules = document.querySelector("[data-workspace-card-rules]");
const workspaceCardRulesCount = document.querySelector("[data-workspace-card-rules-count]");
const workspaceCardOrder = document.querySelector("[data-workspace-card-order]");
const workspaceCardSubmit = document.querySelector("[data-workspace-card-submit]");
const workspaceReleaseRegistry = document.querySelector("[data-workspace-release-registry]");
const workspaceReleaseSummary = document.querySelector("[data-workspace-release-summary]");
const workspaceReleaseList = document.querySelector("[data-workspace-release-list]");
const workspaceReleaseRegistryByWorkspace = new Map();

const chatPane = document.querySelector("[data-chat-pane]");
const streamTabs = document.querySelector("[data-stream-tabs]");
const streamChatColumns = document.querySelector("[data-stream-chat-columns]");
const streamChatHeader = document.querySelector("[data-stream-chat-header]");
const streamHeaderProviderDot = document.querySelector("[data-stream-header-provider-dot]");
const streamHeaderProvider = document.querySelector("[data-stream-header-provider]");
const streamHeaderModel = document.querySelector("[data-stream-header-model]");
const streamHeaderModelSeparator = document.querySelector("[data-stream-header-model-separator]");
const streamHeaderBranch = document.querySelector("[data-stream-header-branch]");
const streamHeaderBranchSeparator = document.querySelector("[data-stream-header-branch-separator]");
const streamHeaderMessageCount = document.querySelector("[data-stream-header-message-count]");
const chatEmpty = document.querySelector("[data-chat-empty]");
const chatEmptyText = document.querySelector("[data-chat-empty-text]");
const chatScroll = document.querySelector("[data-chat-scroll]");
const chatScrollDown = document.querySelector("[data-chat-scroll-down]");
const historyLoader = document.querySelector("[data-history-loader]");
const historyLoadButton = document.querySelector("[data-history-load]");
const historyLoadLabel = document.querySelector("[data-history-load-label]");
const chatLog = document.querySelector("[data-chat-log]");
const chatLive = document.querySelector("[data-chat-live]");
const chatStops = [...document.querySelectorAll("[data-chat-stop]")];
const dialogSettings = document.querySelector("[data-dialog-settings]");
const dialogSettingsToggle = document.querySelector("[data-dialog-settings-toggle]");
const dialogWorkingDirectory = document.querySelector("[data-dialog-working-directory]");
const dialogWorkingDirectoryNote = document.querySelector("[data-dialog-working-directory-note]");
const dialogStreamRules = document.querySelector("[data-dialog-stream-rules]");
const dialogStreamRulesCount = document.querySelector("[data-dialog-stream-rules-count]");
const dialogStreamRulesSave = document.querySelector("[data-dialog-stream-rules-save]");
const dialogWorkspaceRules = document.querySelector("[data-dialog-workspace-rules]");
const dialogWorkspaceRulesPreview = document.querySelector("[data-dialog-workspace-rules-preview]");
const dialogEffectiveRulesPreview = document.querySelector("[data-dialog-effective-rules-preview]");
const workspaceMessageSearch = document.querySelector("[data-workspace-message-search]");
const workspaceMessageSearchToggle = document.querySelector("[data-workspace-message-search-toggle]");
const workspaceMessageSearchClose = document.querySelector("[data-workspace-message-search-close]");
const workspaceMessageSearchTitle = document.querySelector("[data-workspace-message-search-title]");
const workspaceMessageSearchCount = document.querySelector("[data-workspace-message-search-count]");
const workspaceMessageSearchInput = document.querySelector("[data-workspace-message-search-input]");
const workspaceMessageSearchStatus = document.querySelector("[data-workspace-message-search-status]");
const workspaceMessageSearchResults = document.querySelector("[data-workspace-message-search-results]");
const workspaceMessageSearchMore = document.querySelector("[data-workspace-message-search-more]");

const composer = document.querySelector("[data-composer]");
const composerGrow = document.querySelector("[data-composer-grow]");
const composerInput = document.querySelector("[data-composer-input]");
const composerSend = document.querySelector("[data-composer-send]");
const annotationsBox = document.querySelector("[data-annotations]");
const attachmentsBox = document.querySelector("[data-attachments]");
const annotationContextMenu = document.querySelector("[data-annotation-context-menu]");
const resourceContextMenu = document.querySelector("[data-resource-context-menu]");
// Theme panels may clip their children (for example Lake uses overflow:hidden
// around the chat). Keep the fixed selection menu at the document level so it
// can never be reduced to the narrow fragment left inside the chat boundary.
if (annotationContextMenu?.parentElement !== document.body) {
  document.body.append(annotationContextMenu);
}
const fileInput = document.querySelector("[data-file-input]");
const slashMenu = document.querySelector("[data-slash-menu]");
const slashButton = document.querySelector("[data-action='slash-menu']");
const contextUsageButton = document.querySelector("[data-context-usage]");
const contextRing = document.querySelector("[data-context-ring]");
const contextLabel = document.querySelector("[data-context-label]");
const contextUsageModal = document.querySelector("[data-context-usage-modal]");
const contextUsageSummary = document.querySelector("[data-context-usage-summary]");
const contextUsageSummaryPercent = document.querySelector("[data-context-usage-summary-percent]");
const contextUsageTotalFill = document.querySelector("[data-context-usage-total-fill]");
const contextUsageCategories = document.querySelector("[data-context-usage-categories]");
const contextUsageNote = document.querySelector("[data-context-usage-note]");
const contextUsageCompact = document.querySelector("[data-context-usage-compact]");

const approvalsBox = document.querySelector("[data-approvals]");
const queueBox = document.querySelector("[data-queue]");

const settingsPanel = document.querySelector("[data-settings-panel]");
const bugReportToggle = document.querySelector("[data-bug-report-toggle]");
const bugReportForm = document.querySelector("[data-bug-report-form]");
const bugReportText = document.querySelector("[data-bug-report-text]");
const bugReportFiles = document.querySelector("[data-bug-report-files]");
const bugReportAttach = document.querySelector("[data-bug-report-attach]");
const bugReportScreenshots = document.querySelector("[data-bug-report-screenshots]");
const bugReportSubmit = document.querySelector("[data-bug-report-submit]");
const bugReportStatus = document.querySelector("[data-bug-report-status]");
const telegramFullscreenButton = document.querySelector("[data-telegram-fullscreen]");
const claudeGroupToggle = document.querySelector("[data-claude-group-toggle]");
const streamStatusFillToggle = document.querySelector("[data-stream-status-fill-toggle]");
const streamStatusEffectSelect = document.querySelector("[data-stream-status-effect-select]");
const activityRecentHours = document.querySelector("[data-activity-recent-hours]");
const streamActivityDirectionRow = document.querySelector("[data-stream-activity-direction-row]");
const streamActivityDirectionSelect = document.querySelector("[data-stream-activity-direction-select]");
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
const attachmentViewerStage = document.querySelector(".attachment-viewer-stage");
const attachmentViewerImage = document.querySelector("[data-attachment-viewer-image]");
const attachmentViewerLoading = document.querySelector("[data-attachment-viewer-loading]");
const attachmentViewerClose = document.querySelector("[data-attachment-viewer-close]");
const attachmentViewerPrevious = document.querySelector("[data-attachment-viewer-previous]");
const attachmentViewerNext = document.querySelector("[data-attachment-viewer-next]");
const attachmentViewerCaption = document.querySelector("[data-attachment-viewer-caption]");
const attachmentViewerName = document.querySelector("[data-attachment-viewer-name]");
const attachmentViewerCounter = document.querySelector("[data-attachment-viewer-counter]");
const resourceInteractions = window.AgentHubResourceInteractions;

const limitsRanges = document.querySelector("[data-limits-ranges]");
const limitsModes = document.querySelector("[data-limits-modes]");
const limitsSubtitle = document.querySelector("[data-limits-subtitle]");
const limitsLoading = document.querySelector("[data-limits-loading]");
const limitsError = document.querySelector("[data-limits-error]");
const limitsErrorText = document.querySelector("[data-limits-error-text]");
const limitsEmpty = document.querySelector("[data-limits-empty]");
const limitsChartWrap = document.querySelector("[data-limits-chart-wrap]");
const limitsChart = document.querySelector("[data-limits-chart]");
const limitsTooltip = document.querySelector("[data-limits-tooltip]");
const limitsLegend = document.querySelector("[data-limits-legend]");
const limitsSpeedSummary = document.querySelector("[data-limits-speed-summary]");
const limitsSpeedNote = document.querySelector("[data-limits-speed-note]");
const limitsSpeedWindowSetting = document.querySelector("[data-limits-speed-window-setting]");
const limitsSpeedFullWindow = document.querySelector("[data-limits-speed-full-window]");
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
const usageBurnSummary = document.querySelector("[data-usage-burn-summary]");
const usageChart = document.querySelector("[data-usage-chart]");
const usageTooltip = document.querySelector("[data-usage-tooltip]");
const usageNote = document.querySelector("[data-usage-note]");
const comparisonRanges = document.querySelector("[data-comparison-ranges]");
const comparisonSubtitle = document.querySelector("[data-comparison-subtitle]");
const comparisonSummary = document.querySelector("[data-comparison-summary]");
const comparisonLoading = document.querySelector("[data-comparison-loading]");
const comparisonError = document.querySelector("[data-comparison-error]");
const comparisonErrorText = document.querySelector("[data-comparison-error-text]");
const comparisonEmpty = document.querySelector("[data-comparison-empty]");
const comparisonChartWrap = document.querySelector("[data-comparison-chart-wrap]");
const comparisonCombinedView = document.querySelector("[data-comparison-combined-view]");
const comparisonSplitView = document.querySelector("[data-comparison-split-view]");
const comparisonChart = document.querySelector("[data-comparison-chart]");
const comparisonLocalChart = document.querySelector("[data-comparison-local-chart]");
const comparisonApiChart = document.querySelector("[data-comparison-api-chart]");
const comparisonScatterChart = document.querySelector("[data-comparison-scatter-chart]");
const comparisonDifferenceChart = document.querySelector("[data-comparison-difference-chart]");
const comparisonTooltip = document.querySelector("[data-comparison-tooltip]");
const comparisonLegend = document.querySelector("[data-comparison-legend]");
const comparisonNote = document.querySelector("[data-comparison-note]");
const statisticsAccountSelects = [...document.querySelectorAll("[data-statistics-account-select]")];
const turnTimeModeButtons = [...document.querySelectorAll("[data-turn-time-mode]")];
const comparisonViewModeButtons = [...document.querySelectorAll("[data-comparison-view-mode]")];

/* --------------------------------------------------------- Telegram / темы */

let journalHtml = "";
let grouping = "workspace";
let usageUnit = "cr";
let usdRubRate = null;
let usdRubEffectiveDate = "";
let exchangeRatesInitialized = false;
let groupClaudeTasks = false;
let streamOrderMode = "activity";
let streamActivityDirection = "start";
const groupingStates = { date: null, week: null, month: null, stream: null, workspace: null };
const journalDaySelections = new Map();
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
const localWorkspaceFilesAvailable = resourceInteractions.localWorkspaceFilesAvailable({
  vscode: vscodeMode,
  protocol: window.location.protocol,
  hostname: window.location.hostname,
});
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
/* CSS custom properties can be consumed from shared stylesheets. Chromium then
   resolves a relative url() against that consumer rather than the theme file.
   Catalog URLs are exact HTTP or VS Code WebView URLs, so install them as
   canonical root overrides for both selectable scenes and shared-shell assets. */
function encodedBackgroundUrl(url) {
  return /\.json(?:[?#]|$)/iu.test(String(url ?? ""));
}
for (const [background, url] of Object.entries(backgroundAssets)) {
  if (!encodedBackgroundUrl(url)) root.style.setProperty(`--${background}-image`, cssBackgroundUrl(url));
}
const themeAssets = Object.freeze(Object.fromEntries(themeCatalog.flatMap((theme) => (
  Object.entries(theme.assets ?? {}).map(([asset, url]) => [`${theme.id}-${asset}`, url])
))));
for (const [asset, url] of Object.entries(themeAssets)) {
  root.style.setProperty(`--${asset}-asset`, cssBackgroundUrl(url));
}
const deferredBackgroundAssets = new Set(themeCatalog.flatMap((theme) => (
  theme.backgrounds
    .filter((background) => background.preload || encodedBackgroundUrl(background.assetUrl))
    .map((background) => background.id)
)));
const backgroundAssetLoads = new Map();
const backgroundObjectUrls = new Map();
const sessionBackgrounds = new Map();
const LEGACY_BACKGROUND_STORAGE_KEY = "agent-hub-background";
const ACTIVITY_RAIL_COLLAPSED_KEY = "agent-hub:activity-rail-collapsed:v1";
const DEFAULT_ACTIVITY_RECENT_MINUTES = 3 * 60;
const MAX_ACTIVITY_RECENT_MINUTES = 30 * 24 * 60;
let activityRecentPeriodMinutes = DEFAULT_ACTIVITY_RECENT_MINUTES;
const backgroundStorageKey = (theme) => `${LEGACY_BACKGROUND_STORAGE_KEY}:${theme}`;
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
const groupings = new Set(JournalView.GROUPINGS);
const usageUnits = new Set(["$", "rub", "cr", "pte"]);
const CREDITS_PER_USD = 25;
const PTE_PER_CREDIT = 16_000;
const {
  RANGE_SEQUENCE,
  bindDatasetChoice,
  normalizeRange,
  payloadMatchesSelectedRange,
  persistLimitsRange,
  persistRange,
  storedLimitsRange,
  storedRange,
} = globalThis.AgentHubStatisticsControls;
const USAGE_RANGE_KEY = "agent-hub:usage-range:v1";

function savedUsageRange() {
  return storedRange(localStorage, USAGE_RANGE_KEY);
}

const USAGE_MODE_KEY = "agent-hub:usage-mode:v1";

function savedUsageMode() {
  try {
    const mode = localStorage.getItem(USAGE_MODE_KEY);
    return ["rate", "intensity"].includes(mode) ? mode : "total";
  } catch {
    return "total";
  }
}

const usageState = {
  range: savedUsageRange(),
  mode: savedUsageMode(),
  rateBasis: "task",
  status: "idle",
  payload: null,
  error: "",
};
const COMPARISON_RANGE_KEY = "agent-hub:comparison-range:v1";
const COMPARISON_SERIES_KEY = "agent-hub:comparison-series:v2";
const COMPARISON_VIEW_MODE_KEY = "agent-hub:comparison-view-mode:v1";
const STATISTICS_ACCOUNT_KEY = "agent-hub:statistics-account:v1";
const TURN_TIME_MODE_KEY = "agent-hub:turn-time-mode:v1";
const ALL_STATISTICS_ACCOUNTS = "all";

function normalizeTurnTimeMode(value) {
  return ["start", "middle", "end"].includes(String(value)) ? String(value) : "end";
}

function savedTurnTimeMode() {
  try {
    return normalizeTurnTimeMode(localStorage.getItem(TURN_TIME_MODE_KEY));
  } catch {
    return "end";
  }
}

let turnTimeMode = savedTurnTimeMode();

function savedComparisonRange() {
  return storedRange(localStorage, COMPARISON_RANGE_KEY);
}

function savedComparisonSeriesId() {
  try {
    return String(localStorage.getItem(COMPARISON_SERIES_KEY) || "codex:primary")
      .replace(/^current:/u, "")
      .split("@")[0];
  } catch {
    return "codex:primary";
  }
}

function normalizeComparisonViewMode(value) {
  return value === "split" ? "split" : "combined";
}

function savedComparisonViewMode() {
  try {
    return normalizeComparisonViewMode(localStorage.getItem(COMPARISON_VIEW_MODE_KEY));
  } catch {
    return "combined";
  }
}

const comparisonState = {
  range: savedComparisonRange(),
  seriesId: savedComparisonSeriesId(),
  viewMode: savedComparisonViewMode(),
  status: "idle",
  payload: null,
  error: "",
};
const statisticsAccountState = {
  accountKey: (() => {
    try {
      return String(localStorage.getItem(STATISTICS_ACCOUNT_KEY) || "");
    } catch {
      return "";
    }
  })(),
};
const RANGE_LABELS = {
  "6h": "6 ч",
  "24h": "24 ч",
  "7d": "7 д",
  "15d": "15 д",
  "30d": "30 д",
  all: "Всё время",
};

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
  const allowed = backgroundMotionPreference.enabled(
    root,
    globalThis.matchMedia?.("(prefers-reduced-motion: reduce)"),
  );
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

function applyBackgroundMotion(value, { persist = false } = {}) {
  const selected = backgroundMotionPreference.apply(root, backgroundMotionToggle, value);
  syncParticleLayer(root.dataset.background);
  if (persist) backgroundMotionPreference.persist(localStorage, selected);
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
  populateBackgroundOptions(selected);
  applyBackground(savedBackground(selected));
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

function applyChatSurface(value, { persist = false } = {}) {
  const selected = chatSurfacePreference.apply(root, chatBackgroundToggle, value);
  if (persist) chatSurfacePreference.persist(localStorage, selected);
}

function savedStreamStatusStyle() {
  try {
    const value = localStorage.getItem("agent-hub-stream-status-style")
      ?? localStorage.getItem("agent-hub-context-flash-style");
    return value === "fill" ? "fill" : "edge";
  } catch {
    return "edge";
  }
}

function applyStreamStatusStyle(value, { persist = false } = {}) {
  const style = value === "fill" ? "fill" : "edge";
  root.dataset.streamStatusStyle = style;
  if (streamStatusFillToggle) streamStatusFillToggle.checked = style === "fill";
  if (persist) {
    try {
      localStorage.setItem("agent-hub-stream-status-style", style);
      localStorage.removeItem("agent-hub-context-flash-style");
    } catch {
      // Настройка останется активной до закрытия WebView.
    }
  }
}

const STREAM_STATUS_EFFECTS = new Set([
  "calm", "impulse", "scanner", "energy",
  /* Наборы из stream-status.css: дыхание, нить, осадок и эхо. */
  "breath", "thread", "sediment", "echo",
  "off",
]);

function savedStreamStatusEffect() {
  try {
    const value = localStorage.getItem("agent-hub-stream-status-effect");
    return STREAM_STATUS_EFFECTS.has(value) ? value : "impulse";
  } catch {
    return "impulse";
  }
}

function applyStreamStatusEffect(value, { persist = false } = {}) {
  const effect = STREAM_STATUS_EFFECTS.has(value) ? value : "impulse";
  root.dataset.streamStatusEffect = effect;
  if (streamStatusEffectSelect) streamStatusEffectSelect.value = effect;
  if (persist) {
    try {
      localStorage.setItem("agent-hub-stream-status-effect", effect);
    } catch {
      // Настройка останется активной до закрытия WebView.
    }
  }
}

const STREAM_ORDER_MODE_KEY = "agent-hub-stream-order-mode";
const STREAM_ACTIVITY_DIRECTION_KEY = "agent-hub-stream-activity-direction";

function savedStreamOrderMode() {
  try {
    return window.AgentHubStreamTabs.normalizeStreamOrderMode(
      localStorage.getItem(STREAM_ORDER_MODE_KEY),
    );
  } catch {
    return "activity";
  }
}

function applyStreamOrderMode(value, { persist = false, update = false } = {}) {
  streamOrderMode = window.AgentHubStreamTabs.normalizeStreamOrderMode(value);
  root.dataset.streamOrderMode = streamOrderMode;
  if (streamActivityDirectionRow) streamActivityDirectionRow.hidden = streamOrderMode !== "activity";
  if (streamActivityDirectionSelect) streamActivityDirectionSelect.disabled = streamOrderMode !== "activity";
  if (streamTabs) streamTabs.dataset.orderMode = streamOrderMode;
  if (persist) {
    try {
      localStorage.setItem(STREAM_ORDER_MODE_KEY, streamOrderMode);
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
  }
  if (update) {
    renderStreamTabs();
    renderStreamChatDeck();
  }
}

function normalizedActivityRecentMinutes(value) {
  const minutes = Math.round(Number(value));
  return Number.isFinite(minutes)
    ? Math.max(0, Math.min(MAX_ACTIVITY_RECENT_MINUTES, minutes))
    : DEFAULT_ACTIVITY_RECENT_MINUTES;
}

function applyActivityRecentPeriod(value, { update = false } = {}) {
  activityRecentPeriodMinutes = normalizedActivityRecentMinutes(value);
  if (activityRecentHours) activityRecentHours.value = String(activityRecentPeriodMinutes / 60);
  if (update) renderActivityRail();
}

function applyActivityRecentHoursInput() {
  const value = normalizedActivityRecentMinutes((Number(activityRecentHours?.value) || 0) * 60);
  applyActivityRecentPeriod(value, { update: true });
  state.selection.activityRecentMinutes = value;
  emit("selection:set", { key: "activityRecentMinutes", value });
}

function savedGrouping() {
  try {
    const value = localStorage.getItem("agent-hub-grouping");
    if (value === "task") {
      return localStorage.getItem("agent-hub-collapse-streams") === "on"
        ? "workspace"
        : "stream";
    }
    return JournalView.normalizeGrouping(value);
  } catch {
    return "workspace";
  }
}

function savedStreamActivityDirection() {
  try {
    return window.AgentHubStreamTabs.normalizeStreamActivityDirection(
      localStorage.getItem(STREAM_ACTIVITY_DIRECTION_KEY),
    );
  } catch {
    return "start";
  }
}

function applyStreamActivityDirection(value, { persist = false, update = false } = {}) {
  streamActivityDirection = window.AgentHubStreamTabs.normalizeStreamActivityDirection(value);
  root.dataset.streamActivityDirection = streamActivityDirection;
  if (streamActivityDirectionSelect) streamActivityDirectionSelect.value = streamActivityDirection;
  if (streamTabs) streamTabs.dataset.activityDirection = streamActivityDirection;
  if (persist) {
    try {
      localStorage.setItem(STREAM_ACTIVITY_DIRECTION_KEY, streamActivityDirection);
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
  }
  if (update) {
    renderStreamTabs();
    renderStreamChatDeck();
  }
}

function selectGrouping(value, { persist = false } = {}) {
  grouping = JournalView.normalizeGrouping(value);
  document.documentElement.dataset.grouping = grouping;
  if (journalPrimaryColumn) journalPrimaryColumn.textContent = JournalView.primaryColumn(grouping);
  for (const button of journalGroupingButtons) {
    button.setAttribute("aria-pressed", String(button.dataset.journalGrouping === grouping));
  }
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
  renderUsageComparison();
  if (journalHtml) void renderJournal();
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
applyBackgroundMotion(backgroundMotionPreference.stored(localStorage));
applyTheme(savedTheme());
applyChatSurface(chatSurfacePreference.stored(localStorage));
applyStreamStatusStyle(savedStreamStatusStyle());
applyStreamStatusEffect(savedStreamStatusEffect());
applyStreamOrderMode(savedStreamOrderMode());
applyActivityRecentPeriod(DEFAULT_ACTIVITY_RECENT_MINUTES);
applyStreamActivityDirection(savedStreamActivityDirection());
selectUsageUnit(savedUsageUnit());
selectClaudeGrouping(savedClaudeGrouping());
streamStatusFillToggle?.addEventListener("change", () => {
  applyStreamStatusStyle(streamStatusFillToggle.checked ? "fill" : "edge", { persist: true });
});
streamStatusEffectSelect?.addEventListener("change", () => {
  applyStreamStatusEffect(streamStatusEffectSelect.value, { persist: true });
});
activityRecentHours?.addEventListener("change", applyActivityRecentHoursInput);
streamActivityDirectionSelect?.addEventListener("change", () => {
  applyStreamActivityDirection(streamActivityDirectionSelect.value, { persist: true, update: true });
});
claudeGroupToggle?.addEventListener("change", () => {
  selectClaudeGrouping(claudeGroupToggle.checked, { persist: true });
  if (journalHtml) void renderJournal();
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
backgroundMotionToggle?.addEventListener("change", () => {
  applyBackgroundMotion(backgroundMotionToggle.checked ? "on" : "off", { persist: true });
});
chatBackgroundToggle?.addEventListener("change", () => {
  applyChatSurface(chatBackgroundToggle.checked ? "transparent" : "themed", { persist: true });
});
for (const button of journalGroupingButtons) {
  button.addEventListener("click", () => {
    const next = JournalView.normalizeGrouping(button.dataset.journalGrouping);
    if (next === grouping) return;
    if (journalRendered) groupingStates[grouping] = captureOpenState();
    selectGrouping(next, { persist: true });
    if (journalHtml) void renderJournal();
  });
}

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

let lastActivityRailRefreshMinute = -1;

function refreshTaskDurations() {
  const now = Date.now();
  for (const node of document.querySelectorAll(".task-time[data-task-started-at]")) {
    node.textContent = formatRunningDuration(node.dataset.taskStartedAt, now);
  }
  const minute = Math.floor(now / 60_000);
  if (minute !== lastActivityRailRefreshMinute) {
    lastActivityRailRefreshMinute = minute;
    renderActivityRail();
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

document.addEventListener("agenthub:attachment-open", (event) => {
  emit("attachment:open", event.detail ?? {});
});

/* ------------------------------------------------------------- состояние UI */

const state = {
  tasks: [],
  workspaces: [],
  workspaceColumnOrder: [],
  selectedId: null,
  messages: new Map(),   // taskId -> message[]
  taskDiffs: new Map(),  // taskId -> { text, open }
  historyPagination: new Map(), // taskId -> { hasOlder, loading }
  live: new Map(),       // taskId -> live | null
  approvals: new Map(),  // taskId -> approval[]
  queue: new Map(),      // taskId -> queued[]
  options: {
    provider: [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }],
    model: [],
    modelOptionsByProvider: {},
    reasoning: [],
    reasoningOptionsByProvider: {},
    mode: [],
    project: [],
  },
  selection: {},
  status: null,
  connection: "",
  connectionBlockingCount: 0,
  searchQuery: "",
  searchResults: new Map(),
  searchLoading: false,
  workspaceMessageSearch: {
    open: false,
    workspaceId: "",
    query: "",
    results: [],
    total: 0,
    nextOffset: null,
    loading: false,
    error: "",
    indexing: null,
  },
  // This is presentation state, intentionally local to one client. The Hub
  // selects a Thread; a wide shell may keep several Streams from the same
  // Workspace visible without making another device jump to that layout.
  openStreamsByWorkspace: new Map(),
  activeStreamByWorkspace: new Map(),
  configuredOpenStreamWorkspaces: new Set(),
  visibleStreamTaskIds: [],
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

function streamKey(task) {
  return String(task?.streamId ?? "").trim()
    || `legacy:${String(task?.provider ?? "").trim()}:${String(task?.threadId ?? "").trim()}`;
}

function workspaceKey(task) {
  return String(task?.workspaceId ?? "").trim()
    || `legacy:${String(task?.project ?? "").trim() || "unassigned"}`;
}

const OPEN_STREAMS_STORAGE_VERSION = "agent-hub:workspace-open-streams:v3";
let openStreamsRestored = false;

function openStreamsStorageKey() {
  return `${OPEN_STREAMS_STORAGE_VERSION}:${draftStorageSurface()}`;
}

function restoreOpenStreams() {
  if (openStreamsRestored) return;
  openStreamsRestored = true;
  try {
    const stored = JSON.parse(localStorage.getItem(openStreamsStorageKey()) ?? "[]");
    if (!Array.isArray(stored)) return;
    for (const entry of stored.slice(0, 100)) {
      const workspaceId = String(entry?.workspaceId ?? "").trim();
      const streamIds = [...new Set((Array.isArray(entry?.streamIds) ? entry.streamIds : [])
        .map((value) => String(value ?? "").trim())
        .filter(Boolean))].slice(-4);
      const activeStreamId = String(entry?.activeStreamId ?? "").trim();
      if (!workspaceId) continue;
      state.openStreamsByWorkspace.set(workspaceId, streamIds);
      if (activeStreamId) state.activeStreamByWorkspace.set(workspaceId, activeStreamId);
      state.configuredOpenStreamWorkspaces.add(workspaceId);
    }
  } catch {
    // Недоступный localStorage не мешает текущей вкладке хранить выбор в памяти.
  }
}

function persistOpenStreams() {
  try {
    const stored = [...state.configuredOpenStreamWorkspaces].slice(-100).map((workspaceId) => ({
      workspaceId,
      streamIds: (state.openStreamsByWorkspace.get(workspaceId) ?? []).slice(-4),
      activeStreamId: state.activeStreamByWorkspace.get(workspaceId) ?? "",
    }));
    localStorage.setItem(openStreamsStorageKey(), JSON.stringify(stored));
  } catch {
    // Выбор остаётся действительным до закрытия вкладки.
  }
}

function orderedWorkspaceStreams(streams) {
  return window.AgentHubStreamTabs.orderWorkspaceStreams(
    streams,
    streamOrderMode,
    streamActivityDirection,
  );
}

function reconcileOpenStreams(workspaceId, streams) {
  restoreOpenStreams();
  const ordered = orderedWorkspaceStreams(streams);
  const selected = currentTask();
  const selectedInWorkspace = selected && workspaceKey(selected) === workspaceId
    ? streamKey(selected)
    : "";
  const previous = state.openStreamsByWorkspace.get(workspaceId) ?? [];
  let normalized;
  if (surface === "mobile") {
    const available = new Set(streams.map((stream) => stream.id));
    normalized = [selectedInWorkspace || previous.find((streamId) => available.has(streamId)) || ordered[0]?.id]
      .filter(Boolean);
  } else if (!state.configuredOpenStreamWorkspaces.has(workspaceId)) {
    // Обычный режим показывает один Stream. Несколько колонок появляются
    // только после явного Ctrl+click и сохраняются для этого клиента.
    normalized = [selectedInWorkspace || ordered[0]?.id].filter(Boolean);
  } else {
    // Уже открытые колонки образуют пользовательский layout. Activity order
    // влияет на ленту и первичный выбор, но не переставляет живые колонки.
    normalized = window.AgentHubStreamTabs.reconcileOpenStreamIds(
      previous,
      streams.map((stream) => stream.id),
      selectedInWorkspace || ordered[0]?.id,
    );
  }
  state.openStreamsByWorkspace.set(workspaceId, normalized);
  return new Set(normalized);
}

function toggleOpenStream(workspaceId, streamId, streams, { additive = false } = {}) {
  restoreOpenStreams();
  const stream = streams.find((value) => value.id === streamId);
  const target = representativeStreamTask(stream);
  if (!target) return;
  if (surface === "mobile") {
    state.openStreamsByWorkspace.set(workspaceId, [streamId]);
    selectTaskFromUi(target.id);
    return;
  }
  const available = new Set(streams.map((value) => value.id));
  const selected = (state.openStreamsByWorkspace.get(workspaceId) ?? [])
    .filter((id) => available.has(id));
  const selection = window.AgentHubStreamTabs.applyOpenStreamSelection(selected, streamId, { additive });
  if (selection.limitReached) {
    showToast("Одновременно можно открыть не больше четырёх Streams.");
    return;
  }
  const next = selection.ids;
  state.openStreamsByWorkspace.set(workspaceId, next);
  state.configuredOpenStreamWorkspaces.add(workspaceId);
  persistOpenStreams();
  if (next.includes(streamId)) {
    selectTaskFromUi(target.id);
    return;
  }
  const fallback = representativeStreamTask(streams.find((value) => value.id === next[0]));
  if (fallback) selectTaskFromUi(fallback.id);
}

/* =========================================================== роутер видов */

const NAVIGATION_TAB_KEY = "agent-hub-navigation-tab-v1";
const navigationTabs = window.AgentHubNavigationTabs;

function currentNavigationTab() {
  return navigationTabs.currentNavigationTab(root.dataset.view, root.dataset.pane);
}

function storedNavigationTab() {
  return navigationTabs.storedNavigationTab(localStorage, NAVIGATION_TAB_KEY);
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
    requestUsageComparison(comparisonState.range);
  }
  if (view === "server") emit("devices:refresh");
}

function savedBackground(theme) {
  const sessionBackground = sessionBackgrounds.get(theme);
  if (sessionBackground) return normalizeBackground(theme, sessionBackground);
  try {
    const value = localStorage.getItem(backgroundStorageKey(theme))
      ?? localStorage.getItem(LEGACY_BACKGROUND_STORAGE_KEY);
    return normalizeBackground(theme, value);
  } catch {
    return normalizeBackground(theme, theme);
  }
}

function backgroundAssetUrl(background) {
  return backgroundAssets[background] ?? "";
}

async function decodedBackgroundUrl(background, url) {
  if (!encodedBackgroundUrl(url)) return { loaded: false, url };
  if (backgroundObjectUrls.has(url)) return backgroundObjectUrls.get(url);
  const readPart = async (target, read) => {
    let lastError = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8_000);
      try {
        const response = await fetch(target, {
          cache: "force-cache",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await read(response);
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, 200 * (2 ** attempt)));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new Error("Background transport failed");
  };
  const manifest = await readPart(url, (response) => response.json());
  if (!Array.isArray(manifest.parts) || !manifest.parts.length || manifest.parts.length > 512) {
    throw new Error("Background transport manifest is invalid");
  }
  if (manifest.directUrl && await loadBackgroundImage(manifest.directUrl)) {
    const direct = { loaded: true, url: manifest.directUrl };
    backgroundObjectUrls.set(url, direct);
    root.style.setProperty(`--${background}-image`, cssBackgroundUrl(direct.url));
    return direct;
  }
  const chunks = new Array(manifest.parts.length);
  let nextPart = 0;
  await Promise.all(Array.from({ length: Math.min(6, manifest.parts.length) }, async () => {
    while (nextPart < manifest.parts.length) {
      const index = nextPart++;
      chunks[index] = (await readPart(manifest.parts[index], (response) => response.text())).trim();
    }
  }));
  const encoded = chunks.join("");
  const binary = atob(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (Number(manifest.bytes) !== bytes.length) throw new Error("Background transport size mismatch");
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: String(manifest.type || "image/jpeg") }));
  const decoded = { loaded: false, url: objectUrl };
  backgroundObjectUrls.set(url, decoded);
  root.style.setProperty(`--${background}-image`, cssBackgroundUrl(objectUrl));
  return decoded;
}

function loadBackgroundImage(url) {
  return new Promise((resolve) => {
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
}

function preloadBackgroundAsset(background) {
  const url = backgroundAssetUrl(background);
  if (!url || typeof Image !== "function") return Promise.resolve(true);
  if (backgroundAssetLoads.has(url)) return backgroundAssetLoads.get(url);
  const loading = decodedBackgroundUrl(background, url)
    .then((resolved) => resolved.loaded || loadBackgroundImage(resolved.url))
    .catch(() => false);
  backgroundAssetLoads.set(url, loading);
  return loading;
}

function commitBackground(selected, persist) {
  root.style.removeProperty("--hub-background-image");
  root.dataset.background = selected;
  root.dataset.backgroundOverride = String(selected !== root.dataset.theme);
  if (selected !== root.dataset.theme) {
    const source = getComputedStyle(root).getPropertyValue("--hub-background-image");
    const asset = root.style.getPropertyValue(`--${selected}-image`);
    const resolved = backgroundImageResolver.resolve(source, asset);
    if (resolved) root.style.setProperty("--hub-background-image", resolved);
  }
  delete root.dataset.backgroundLoading;
  if (backgroundSelect) backgroundSelect.value = selected;
  sessionBackgrounds.set(root.dataset.theme, selected);
  syncParticleLayer(selected);
  if (persist) {
    try {
      localStorage.setItem(backgroundStorageKey(root.dataset.theme), selected);
      localStorage.setItem(LEGACY_BACKGROUND_STORAGE_KEY, selected);
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
  const next = navigationTabs.isStandaloneNavigationTab(view) ? view : "chat";
  root.dataset.view = next;
  for (const button of document.querySelectorAll("[data-view-button]")) {
    button.setAttribute("aria-pressed", String(button.dataset.viewButton === next));
  }
  const title = document.querySelector("[data-view-title]");
  if (title) {
    title.textContent = next === "dashboard"
      ? "Dash"
      : next === "journal"
      ? "Log"
      : next === "statistics"
        ? "Stats"
        : next === "background"
          ? "Ground"
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
  const active = navigationTabs.isStandaloneNavigationTab(root.dataset.view)
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
    if (navigationTabs.isStandaloneNavigationTab(target)) { setView(target); return; }
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
    if (state.tasks.length) renderTasks();
    renderChat();
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

function streamProviderModelTitle({ provider = "", agentLabel = "", modelLabel = "" } = {}) {
  const normalizedProvider = String(provider ?? "").trim();
  const providerName = String(agentLabel || providerLabels[normalizedProvider] || normalizedProvider || "не указан").trim();
  const modelName = String(modelLabel ?? "").trim();
  return `Провайдер: ${providerName}${modelName ? `. Модель: ${modelName}` : ""}`;
}

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
    const local = `${task.title ?? ""} ${task.threadTitle ?? ""} ${task.streamDisplayName ?? ""} ${task.project ?? ""} ${task.agentLabel ?? ""}`
      .toLowerCase().includes(filter);
    return local || state.searchResults.has(task.id);
  });
  taskList.replaceChildren();
  let visibleCount = visible.length;
  const { workspaceTasks, unassignedTasks } = window.AgentHubStreamTabs.taskListSections(visible);
  const hasWorkspace = workspaceTasks.length > 0;
  if (hasWorkspace) {
    const groups = new Map();
    for (const task of workspaceTasks) {
      const key = workspaceKey(task);
      if (!groups.has(key)) groups.set(key, {
        id: key,
        name: task.workspaceName || task.title || "Без названия",
        kind: task.workspaceKind ?? "user",
        tasks: [],
      });
      groups.get(key).tasks.push(task);
    }
    visibleCount = groups.size + unassignedTasks.length;
    const orderedGroups = window.AgentHubStreamTabs.orderWorkspaceGroups(groups.values());
    for (const group of orderedGroups) taskList.append(renderTaskWorkspaceItem(group));
    for (const task of unassignedTasks) taskList.append(renderTaskItem(task));
  } else {
    for (const task of visible) taskList.append(renderTaskItem(task));
  }

  const hasTasks = state.tasks.length > 0;
  taskEmpty.hidden = hasTasks;
  if (hasTasks && visible.length === 0) {
    taskEmpty.hidden = false;
    taskEmpty.textContent = "Ничего не найдено по запросу.";
  } else {
    taskEmpty.textContent = hasWorkspace
      ? "Пока нет Workspaces. Создайте новый кнопкой «+»."
      : "Пока нет задач. Создайте новую задачу кнопкой «+».";
  }
  taskCount.hidden = !hasTasks;
  taskCount.textContent = String(visibleCount);
  renderActivityRail();
}

function workspaceStreams(tasks) {
  const byStream = new Map();
  for (const task of tasks) {
    const streamId = streamKey(task);
    if (!byStream.has(streamId)) byStream.set(streamId, {
      id: streamId,
      name: String(task.streamName ?? "").trim(),
      ordinal: Math.max(1, Number(task.streamOrdinal) || 1),
      tasks: [],
    });
    byStream.get(streamId).tasks.push(task);
  }
  return [...byStream.values()]
    .sort((left, right) => (
      left.ordinal - right.ordinal
      || Math.max(...right.tasks.map((task) => Date.parse(task.lastActivity || 0) || 0))
        - Math.max(...left.tasks.map((task) => Date.parse(task.lastActivity || 0) || 0))
    ));
}

function workspaceLastActivity(tasks) {
  return tasks.reduce((latest, task) => {
    const value = Date.parse(task.lastActivity || 0) || 0;
    return value > latest ? value : latest;
  }, 0);
}

function representativeWorkspaceTask(tasks) {
  const selected = currentTask();
  if (selected && tasks.some((task) => task.id === selected.id)) return selected;
  restoreOpenStreams();
  const workspaceId = workspaceKey(tasks[0]);
  const activeStreamId = state.activeStreamByWorkspace.get(workspaceId);
  if (activeStreamId) {
    const activeStream = workspaceStreams(tasks).find((stream) => stream.id === activeStreamId);
    if (!activeStream) {
      state.activeStreamByWorkspace.delete(workspaceId);
      persistOpenStreams();
    }
    const active = representativeStreamTask(activeStream);
    if (active) return active;
  }
  return [...tasks].sort((left, right) => (
    Date.parse(right.lastActivity || 0) - Date.parse(left.lastActivity || 0)
  ))[0] ?? null;
}

function streamMaintenanceKind(task) {
  /* Ротация меняет тред, свёртка сжимает историю: на карточке это два разных
     состояния, и оба видны без анимации. */
  const reason = String(task?.maintenance?.reason ?? "");
  if (["manual-rotation", "automatic-rotation"].includes(reason)) return "rotation";
  return String(task?.context?.compaction?.status ?? "") === "running" ? "compaction" : "";
}

function renderTaskWorkspaceItem({ id, name, kind, tasks }) {
  const selected = workspaceKey(currentTask()) === id;
  const lastActivity = workspaceLastActivity(tasks);
  const unread = tasks.some((task) => task.unread);
  const running = tasks.some((task) => task.running);
  const maintenance = tasks.map(streamMaintenanceKind).find(Boolean) ?? "";
  return el("li", {
    class: "task-workspace-item",
    "data-workspace-id": id,
    "data-workspace-kind": kind,
    "data-workspace-select": id,
    "data-workspace-heading": id,
    "data-workspace-name": name,
    "data-selected": selected ? "" : null,
    "data-unread": unread ? "" : null,
    "data-running": running ? "" : null,
    "data-maintenance": maintenance || null,
    role: "button",
    tabindex: "0",
    "aria-pressed": String(selected),
    title: "ПКМ — редактировать Workspace",
  }, [
    el("span", { class: "task-workspace-name", text: name }),
    el("span", {
      class: "task-workspace-time",
      text: formatRelativeTime(lastActivity),
      title: lastActivity ? new Date(lastActivity).toLocaleString("ru-RU") : "",
    }),
  ]);
}

function streamDisplayName(stream, streamCount) {
  if (stream.name) return stream.name;
  return streamCount > 1 ? `Stream ${stream.ordinal}` : "Stream";
}

function representativeStreamTask(stream) {
  if (!stream) return null;
  return stream.tasks.find((task) => task.id === state.selectedId)
    ?? [...stream.tasks].sort((left, right) => (
      Date.parse(right.lastActivity || 0) - Date.parse(left.lastActivity || 0)
    ))[0]
    ?? null;
}

function streamActivityTime(task) {
  const value = Date.parse(String(task?.lastActivity ?? ""));
  return Number.isFinite(value) ? value : 0;
}

function streamAttentionKind(task, now = Date.now()) {
  if (task?.unread && !task?.running) return "completed";
  if (task?.running) return "running";
  const activityTime = streamActivityTime(task);
  const recentWindow = activityRecentPeriodMinutes * 60_000;
  if (recentWindow > 0 && activityTime > 0 && Math.max(0, now - activityTime) <= recentWindow) {
    return "recent";
  }
  return "";
}

function activityStreamEntries(tasks) {
  const now = Date.now();
  const groups = new Map();
  for (const task of tasks) {
    const kind = streamAttentionKind(task, now);
    if (!kind || !window.AgentHubStreamTabs.includeTaskInActivityRail(task, kind)) continue;
    const key = `${workspaceKey(task)}\u0000${streamKey(task)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const attentionRank = (task) => ({ completed: 0, running: 1, recent: 2 }[
    streamAttentionKind(task, now)
  ] ?? 3);
  return [...groups.values()]
    .map((group) => [...group].sort((left, right) => (
      attentionRank(left) - attentionRank(right)
      || streamActivityTime(right) - streamActivityTime(left)
    ))[0])
    .sort((left, right) => (
      attentionRank(left) - attentionRank(right)
      || streamActivityTime(right) - streamActivityTime(left)
    ));
}

function streamPresentation(task) {
  const provider = String(task?.provider ?? "none");
  const agentLabel = task?.agentLabel || providerLabels[provider] || "Агент";
  const { running, answerReady, statusLabel } = window.AgentHubStreamTabs.streamStatusPresentation(task);
  const time = running && task?.startedAt
    ? formatRunningDuration(task.startedAt)
    : formatRelativeTime(task?.lastActivity);
  return { provider, agentLabel, running, answerReady, time, statusLabel };
}

function renderStreamStatusCard(task, title, presentation) {
  return el("span", { class: "stream-tab-card" }, [
    el("span", {
      class: "provider-dot",
      "data-provider": presentation.provider,
      "aria-hidden": "true",
    }),
    el("span", { class: "stream-tab-body" }, [
      el("span", { class: "stream-tab-title-row" }, [
        el("span", { class: "stream-tab-title", text: title }),
        el("span", {
          class: "task-time",
          text: presentation.time,
          title: presentation.running && task?.startedAt
            ? `Выполняется с ${new Date(task.startedAt).toLocaleString("ru-RU")}`
            : task?.lastActivity ? new Date(task.lastActivity).toLocaleString("ru-RU") : "",
          "data-task-started-at": presentation.running && task?.startedAt ? task.startedAt : null,
        }),
      ]),
      el("span", { class: "stream-tab-meta" }, [
        el("span", { class: "task-agent", text: presentation.agentLabel }),
        task?.modelLabel
          ? el("span", {
            class: "task-agent task-model",
            "data-model-tier": modelTier(task.modelLabel),
            text: shortModelLabel(task.modelLabel),
            title: task.modelLabel,
          })
          : null,
        task?.runtimeLabel
          ? el("span", {
            class: "task-runtime",
            text: task.runtimeLabel,
            title: task.runtimeTitle || task.runtimeLabel,
          })
          : null,
      ]),
    ]),
  ]);
}

function savedActivityRailCollapsed() {
  try {
    return localStorage.getItem(ACTIVITY_RAIL_COLLAPSED_KEY) === "true";
  } catch {
    return false;
  }
}

let activityRailCollapsed = savedActivityRailCollapsed();

function applyActivityRailState({ persist = false } = {}) {
  activityRail?.toggleAttribute("data-collapsed", activityRailCollapsed);
  activityRailToggle?.setAttribute("aria-expanded", String(!activityRailCollapsed));
  if (activityRailToggle) {
    activityRailToggle.title = activityRailCollapsed
      ? "Развернуть активные потоки"
      : "Свернуть активные потоки";
  }
  if (!persist) return;
  try {
    localStorage.setItem(ACTIVITY_RAIL_COLLAPSED_KEY, String(activityRailCollapsed));
  } catch {
    // Недоступный localStorage не мешает сворачивать панель в текущей сессии.
  }
}

function renderActivityRail() {
  if (
    !activityStreamList
    || !activityRailCount
    || !activityStreamEmpty
    || !activityRecentList
    || !activityRecentEmpty
  ) return;
  const selectedWorkspaceId = String(currentTask()?.workspaceId ?? "").trim() || null;
  window.AgentHubTaskBoard?.setSelectedWorkspace(selectedWorkspaceId);
  const entries = activityStreamEntries(state.tasks);
  const sections = window.AgentHubStreamTabs.activityStreamSections(entries);
  activityRailCount.textContent = `Активно: ${sections.active.length}`;
  activityStreamEmpty.hidden = sections.active.length > 0;
  activityRecentEmpty.hidden = sections.recent.length > 0;
  const renderEntry = (task) => {
    const presentation = streamPresentation(task);
    const streamName = String(task.streamName || task.streamDisplayName || "").trim()
      || `Stream ${Math.max(1, Number(task.streamOrdinal) || 1)}`;
    const workspaceName = String(task.workspaceName || task.title || "Workspace").trim();
    const activityTitle = `${workspaceName} — ${streamName}`;
    const provider = String(task?.provider ?? "none");
    const providerModelTitle = streamProviderModelTitle({
      provider,
      agentLabel: presentation.agentLabel,
      modelLabel: task?.modelLabel,
    });
    const title = `${presentation.statusLabel ? `${presentation.statusLabel}. ` : ""}${activityTitle}. ${providerModelTitle}`;
    return el("button", {
      type: "button",
      class: "stream-tab activity-stream-item",
      "data-activity-task-id": task.id,
      "data-stream-provider": provider,
      "data-stream-provider-label": presentation.agentLabel,
      "data-stream-model": task?.modelLabel ?? "",
      "data-stream-title": title,
      "data-current": task.id === state.selectedId ? "" : null,
      "data-running": presentation.running ? "" : null,
      "data-answer-ready": presentation.answerReady ? "" : null,
      "data-recent": streamAttentionKind(task) === "recent" ? "" : null,
      "data-maintenance": streamMaintenanceKind(task) || null,
      "aria-pressed": String(task.id === state.selectedId),
      "aria-label": [workspaceName, streamName, presentation.agentLabel, presentation.statusLabel]
        .filter(Boolean).join(". "),
      title,
    }, [renderStreamStatusCard(task, activityTitle, presentation)]);
  };
  activityStreamList.replaceChildren(...sections.active.map(renderEntry));
  activityRecentList.replaceChildren(...sections.recent.map(renderEntry));
  applyActivityRailState();
}

function visibleWorkspaceStreamTasks() {
  const selected = currentTask();
  if (!selected) return [];
  if (!String(selected.workspaceId ?? "").trim()) return [selected];
  const workspaceId = workspaceKey(selected);
  const streams = workspaceStreams(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  reconcileOpenStreams(workspaceId, streams);
  const byId = new Map(streams.map((stream) => [stream.id, stream]));
  return (state.openStreamsByWorkspace.get(workspaceId) ?? [])
    .map((streamId) => byId.get(streamId))
    .filter(Boolean)
    .map(representativeStreamTask)
    .filter(Boolean);
}

let streamTabsOverflowFrame = 0;

function scheduleStreamTabsOverflow() {
  window.cancelAnimationFrame(streamTabsOverflowFrame);
  streamTabsOverflowFrame = window.requestAnimationFrame(syncStreamTabsOverflow);
}

function syncStreamTabsOverflow() {
  if (!streamTabs || streamTabs.hidden) return;
  const track = streamTabs.querySelector("[data-stream-tabs-track]");
  const overflow = streamTabs.querySelector("[data-stream-tabs-overflow]");
  const count = streamTabs.querySelector("[data-stream-tabs-overflow-count]");
  const groups = [...(track?.querySelectorAll(".stream-tab-group") ?? [])];
  const menuItems = [...(overflow?.querySelectorAll(".stream-overflow-item") ?? [])];
  if (!track || !overflow || !count) return;
  groups.forEach((group) => { group.hidden = false; });
  overflow.hidden = true;
  if (track.scrollWidth <= track.clientWidth + 1) {
    menuItems.forEach((item) => { item.hidden = true; });
    return;
  }
  overflow.hidden = false;
  let used = 0;
  let visible = 0;
  let exhausted = false;
  groups.forEach((group, index) => {
    const width = group.getBoundingClientRect().width;
    const fits = !exhausted && (index === 0 || used + width <= track.clientWidth);
    group.hidden = !fits;
    if (fits) {
      used += width;
      visible += 1;
    } else exhausted = true;
  });
  const hidden = Math.max(0, groups.length - visible);
  count.textContent = String(hidden);
  overflow.hidden = hidden === 0;
  menuItems.forEach((item, index) => { item.hidden = index < visible; });
}

function renderStreamTabs() {
  if (!streamTabs) return;
  const selected = currentTask();
  if (!selected || !String(selected.workspaceId ?? "").trim()) {
    streamTabs.hidden = true;
    streamTabs.replaceChildren();
    return;
  }
  const workspaceId = workspaceKey(selected);
  const streams = workspaceStreams(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  reconcileOpenStreams(workspaceId, streams);
  const ordered = orderedWorkspaceStreams(streams);
  const open = new Set(state.openStreamsByWorkspace.get(workspaceId) ?? []);
  const orderIsManual = streamOrderMode === "manual";
  const orderToggleTitle = orderIsManual
    ? "Ручной порядок. Переключить на порядок по последней активности."
    : "История активности. Переключить на ручной порядок.";
  const orderToggle = el("button", {
    type: "button",
    class: "stream-tab-utility stream-order-toggle",
    "data-action": "stream-order-toggle",
    "data-order-mode": streamOrderMode,
    title: orderToggleTitle,
    "aria-label": orderToggleTitle,
  }, [window.AgentHubStreamTabs.createPhosphorIcon(
    document,
    orderIsManual ? "arrows-down-up" : "clock-counter-clockwise",
    `stream-order-icon stream-order-icon-${streamOrderMode}`,
  )]);
  const createTab = el("button", {
    type: "button",
    class: "stream-tab-utility stream-tab-create",
    "data-action": "stream-create",
    "data-workspace-id": workspaceId,
    title: "Создать Stream и настроить будущий чат",
    "aria-label": "Создать Stream",
  }, [window.AgentHubStreamTabs.createPhosphorIcon(document, "plus", "stream-tab-create-mark")]);
  const overflowItems = [];
  const groups = ordered.map((stream, index) => {
    const task = representativeStreamTask(stream);
    const streamName = streamDisplayName(stream, streams.length);
    const provider = String(task?.provider ?? "none");
    const agentLabel = task?.agentLabel || providerLabels[provider] || "Агент";
    const { running, answerReady, statusLabel } = window.AgentHubStreamTabs.streamStatusPresentation(task);
    const statusState = window.AgentHubStreamTabs.streamStatusState(task);
    const time = statusState === "failed"
      ? "сбой"
      : task?.running && task.startedAt
        ? formatRunningDuration(task.startedAt)
        : formatRelativeTime(task?.lastActivity);
    const title = `${statusLabel ? `${statusLabel}. ` : ""}${streamProviderModelTitle({ provider, agentLabel, modelLabel: task?.modelLabel })}. Нажмите, чтобы переключиться. Ctrl+click — добавить или убрать колонку. ${streamOrderMode === "manual" ? "Перетащите, чтобы изменить порядок." : ""} ПКМ — управление Stream.`;
    const attributes = {
      type: "button",
      "data-stream-tab-id": stream.id,
      "data-workspace-id": workspaceId,
      "data-workspace-name": task?.workspaceName ?? "",
      "data-stream-name": stream.name ?? "",
      "data-stream-task-id": task?.id ?? "",
      "data-stream-provider": provider,
      "data-stream-provider-label": agentLabel,
      "data-stream-model": task?.modelLabel ?? "",
      "data-stream-title": title,
      "aria-pressed": String(open.has(stream.id)),
      "data-current": task?.id === selected.id ? "" : null,
      "data-running": running ? "" : null,
      "data-answer-ready": answerReady ? "" : null,
      "data-state": statusState,
      "data-maintenance": streamMaintenanceKind(task) || null,
      "aria-label": [streamName, agentLabel, task?.modelLabel, statusLabel].filter(Boolean).join(". "),
      title,
    };
    const content = () => [
      el("span", {
        class: "provider-dot",
        "data-provider": provider,
        "data-state": statusState,
        "aria-hidden": "true",
      }),
      el("span", { class: "stream-tab-title", text: streamName }),
      el("span", {
        class: `task-time${statusState === "failed" ? " is-failed" : ""}`,
        text: time,
        title: task?.lastActivity ? new Date(task.lastActivity).toLocaleString("ru-RU") : "",
      }),
    ];
    const button = el("button", {
      ...attributes,
      class: "stream-tab",
      draggable: window.AgentHubStreamTabs.streamsAreDraggable(streamOrderMode, surface) ? "true" : null,
    }, [el("span", { class: "stream-tab-card" }, content())]);
    overflowItems.push(el("button", {
      ...attributes,
      class: "stream-overflow-item",
      hidden: true,
    }, content()));
    return el("span", {
      class: "stream-tab-group",
      "data-current": task?.id === selected.id ? "" : null,
    }, [
      index > 0 ? el("span", { class: "stream-tab-divider", "aria-hidden": "true" }) : null,
      button,
    ]);
  });
  const leftControls = el("span", { class: "stream-tabs-controls" }, [orderToggle, createTab]);
  const track = el("span", { class: "stream-tabs-track", "data-stream-tabs-track": "" }, groups);
  const overflowButton = el("button", {
    type: "button",
    class: "stream-tabs-more",
    "data-stream-overflow-toggle": "",
    "aria-expanded": "false",
    title: "Остальные потоки",
  }, [
    el("span", { text: "ещё " }),
    el("span", { "data-stream-tabs-overflow-count": "", text: "0" }),
    window.AgentHubStreamTabs.createPhosphorIcon(document, "caret-down", "stream-tabs-more-icon"),
  ]);
  const overflowMenu = el("div", {
    class: "stream-tabs-overflow-menu",
    "data-stream-tabs-overflow-menu": "",
    role: "menu",
    hidden: true,
  }, overflowItems);
  const overflow = el("span", {
    class: "stream-tabs-overflow",
    "data-stream-tabs-overflow": "",
    hidden: true,
  }, [overflowButton, overflowMenu]);
  streamTabs.replaceChildren(leftControls, track, overflow);
  streamTabs.hidden = false;
  scheduleStreamTabsOverflow();
}

function publishVisibleStreamTasks(tasks) {
  const ids = tasks.map((task) => task.id);
  if (sameData(ids, state.visibleStreamTaskIds)) return;
  state.visibleStreamTaskIds = ids;
  emit("workspace:visible-streams", { taskIds: ids });
}

const { ChatScrollController, shouldLoadOlderPage } = window.AgentHubChatScroll;
const chatScrollControllers = new WeakMap();

function scrollContainerIsNearBottom(scroll) {
  return chatScrollControllers.get(scroll)?.isNearBottom() ?? true;
}

function syncChatScrollDownButton(scroll, button) {
  if (!scroll || !button) return;
  chatScrollControllers.get(scroll)?.sync();
}

function bindChatScrollDown(scroll, button) {
  if (!scroll || !button || chatScrollControllers.has(scroll)) return;
  chatScrollControllers.set(scroll, new ChatScrollController(scroll, button, {
    onNearTop: scroll === chatScroll ? () => requestOlderHistory() : null,
  }));
}

function createChatScrollDownButton(scroll, task = null) {
  const button = el("button", {
    type: "button",
    class: "chat-scroll-down",
    hidden: true,
    title: "Прокрутить чат вниз",
    "aria-label": "Прокрутить чат вниз",
  }, [
    window.AgentHubStreamTabs.createPhosphorIcon(
      document,
      "caret-down",
      "chat-scroll-down-icon",
    ),
    el("span", { class: "chat-scroll-working", "aria-hidden": "true" }, [
      el("i"), el("i"), el("i"),
    ]),
  ]);
  bindChatScrollDown(scroll, button);
  chatScrollControllers.get(scroll)?.setWorking(task?.running === true);
  return button;
}

bindChatScrollDown(chatScroll, chatScrollDown);

function renderStreamChatPreview(task) {
  const messages = state.messages.get(task.id);
  const preview = el("article", {
    class: "stream-chat-preview",
    "data-stream-chat-task-id": task.id,
  });
  preview.addEventListener("click", (event) => {
    if (event.target.closest("a, button, input, textarea, select, summary")) return;
    selectTaskFromUi(task.id);
  });
  const workspaceName = String(task.workspaceName || task.title || "Workspace").trim();
  const streamName = String(task.streamName || task.streamDisplayName || "Stream").trim();
  const head = el("header", { class: "stream-chat-preview-head" }, [
    el("strong", { class: "stream-chat-preview-title", text: streamName }),
    el("span", { class: "stream-chat-preview-workspace", text: workspaceName }),
  ]);
  const scroll = el("div", { class: "stream-chat-preview-log chat-scroll" });
  const log = el("div", { class: "stream-chat-preview-messages chat-log" });
  if (!messages) {
    log.append(el("p", { class: "stream-chat-preview-empty", text: "Загрузка истории…" }));
  } else if (!messages.length) {
    log.append(el("p", { class: "stream-chat-preview-empty", text: "В этом Stream пока нет сообщений." }));
  } else {
    for (const message of messages.slice(-20)) log.append(renderMessage(message, { readOnly: true, task }));
  }
  const live = state.live.get(task.id);
  if (liveCardHasContent(live)) {
    const liveNode = el("article", { class: "msg msg-live stream-chat-preview-live-card" }, [
      el("div", { class: "msg-head" }, [
        el("span", { class: "msg-author", "data-live-author": "" }),
        el("span", { class: "msg-stage", "data-live-stage": "" }),
      ]),
      el("div", { class: "msg-reasoning msg-stage-detail", "data-live-stage-detail": "", hidden: true }),
      el("div", { class: "msg-reasoning", "data-live-reasoning": "", hidden: true }),
      el("div", { class: "live-turn-trace", "data-live-trace": "", hidden: true }),
      el("details", { class: "activity-feed", "data-activity-feed": "", hidden: true }, [
        el("summary", { "data-activity-summary": "", text: "Выполненные действия" }),
        el("div", { class: "activity-list", "data-activity-list": "" }),
      ]),
      el("div", { class: "msg-body", "data-live-body": "" }),
    ]);
    populateLiveCard(liveNode, live, task.agentLabel || "Агент", task);
    log.append(liveNode);
  }
  const queue = el("div", {
    class: "queue stream-chat-preview-queue",
    hidden: true,
    "aria-label": "Очередь сообщений",
  });
  renderQueueForTask(task.id, queue);
  if (!queue.hidden) log.append(queue);
  scroll.append(log);
  const scrollDown = createChatScrollDownButton(scroll, task);
  preview.append(head, scroll, scrollDown);
  window.requestAnimationFrame(() => {
    chatScrollControllers.get(scroll)?.pinNow();
  });
  return preview;
}

let renderedStreamChatDeckKey = "";

function renderStreamChatDeck() {
  const { force = false } = arguments[0] ?? {};
  if (!streamChatColumns) return;
  const selected = currentTask();
  const visible = visibleWorkspaceStreamTasks();
  publishVisibleStreamTasks(visible);
  const shown = surface === "mobile" ? visible.slice(0, 1) : visible.slice(0, 4);
  const deckKey = window.AgentHubStreamTabs.streamDeckRenderKey(shown, selected?.id);
  const deckStructureIntact = streamChatColumns.contains(chatPane)
    && streamChatColumns.querySelectorAll(".stream-chat-preview").length
      === shown.filter((task) => task.id !== selected?.id).length;
  if (!force && deckStructureIntact && deckKey === renderedStreamChatDeckKey) return;
  const selectedIndex = shown.findIndex((task) => task.id === selected?.id);
  for (const preview of streamChatColumns.querySelectorAll(".stream-chat-preview")) preview.remove();
  chatPane.hidden = selectedIndex < 0;
  chatPane.dataset.streamChatTaskId = selected?.id ?? "";
  chatPane.style.order = String(Math.max(0, selectedIndex));
  chatPane.toggleAttribute("data-active-stream", selectedIndex >= 0);
  shown.forEach((task, index) => {
    if (task.id === selected?.id) return;
    const preview = renderStreamChatPreview(task);
    preview.style.order = String(index);
    streamChatColumns.append(preview);
  });
  const hasVisible = shown.length > 0;
  streamChatColumns.hidden = !hasVisible;
  chatEmpty.hidden = hasVisible;
  if (!hasVisible && chatEmptyText) chatEmptyText.textContent = "Выберите Stream в полосе сверху.";
  streamChatColumns.toggleAttribute("data-multi-stream", shown.length > 1);
  streamChatColumns.style.setProperty("--stream-chat-count", String(Math.max(1, shown.length)));
  renderedStreamChatDeckKey = deckKey;
}

function refreshSupplementaryStreamChat(taskId) {
  if (taskId === state.selectedId || !state.visibleStreamTaskIds.includes(taskId)) return;
  renderStreamChatDeck({ force: true });
}

function renderTaskItem(task, { workspaceGrouped = false } = {}) {
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
    el("span", {
      class: "task-title",
      text: task.displayTitle || task.title || "Без названия",
    }),
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
  const workspace = event.target.closest("[data-workspace-select]");
  if (!workspace) return;
  const workspaceId = String(workspace.dataset.workspaceSelect ?? "");
  const target = representativeWorkspaceTask(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  if (target) selectTaskFromUi(target.id);
});
taskList.addEventListener("keydown", (event) => {
  if (!["Enter", " "].includes(event.key)) return;
  const workspace = event.target.closest("[data-workspace-select]");
  if (!workspace) return;
  event.preventDefault();
  const workspaceId = String(workspace.dataset.workspaceSelect ?? "");
  const target = representativeWorkspaceTask(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  if (target) selectTaskFromUi(target.id);
});
activityRailToggle?.addEventListener("click", () => {
  activityRailCollapsed = !activityRailCollapsed;
  applyActivityRailState({ persist: true });
});
const selectActivityTask = (event) => {
  const item = event.target.closest("[data-activity-task-id]");
  if (item) selectTaskFromUi(String(item.dataset.activityTaskId ?? ""));
};
activityStreamList?.addEventListener("click", selectActivityTask);
activityRecentList?.addEventListener("click", selectActivityTask);
taskFilter.addEventListener("input", () => {
  renderTasks();
});

function workspaceSearchSnippet(text, query) {
  const container = el("span", { class: "workspace-message-search-snippet" });
  const terms = String(query ?? "").trim().split(/\s+/u).filter(Boolean)
    .sort((left, right) => right.length - left.length);
  if (!terms.length) {
    container.textContent = String(text ?? "");
    return container;
  }
  const escaped = terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"));
  const matcher = new RegExp(`(${escaped.join("|")})`, "giu");
  for (const part of String(text ?? "").split(matcher)) {
    if (!part) continue;
    container.append(matcher.test(part) ? el("mark", { text: part }) : document.createTextNode(part));
    matcher.lastIndex = 0;
  }
  return container;
}

function renderWorkspaceMessageSearch() {
  const search = state.workspaceMessageSearch;
  if (!workspaceMessageSearch) return;
  workspaceMessageSearch.hidden = !search.open;
  root.toggleAttribute("data-workspace-message-search-open", search.open);
  if (!search.open) return;
  workspaceMessageSearchCount.textContent = search.total ? `${search.total} совп.` : "";
  workspaceMessageSearchResults.replaceChildren();
  const groups = new Map();
  for (const result of search.results) {
    const values = groups.get(result.streamId) ?? [];
    values.push(result);
    groups.set(result.streamId, values);
  }
  for (const values of groups.values()) {
    const first = values[0];
    const group = el("section", { class: "workspace-message-search-group" }, [
      el("header", { class: "workspace-message-search-group-head" }, [
        el("strong", { text: first.streamName || `Stream ${first.streamOrdinal || 1}` }),
        el("span", { text: String(values.length) }),
      ]),
    ]);
    for (const result of values) {
      const occurred = result.occurredAt ? new Date(result.occurredAt) : null;
      group.append(el("button", {
        type: "button",
        class: "workspace-message-search-hit",
        "data-workspace-message-search-result": result.id,
        title: "Открыть сообщение",
      }, [
        el("span", { class: "workspace-message-search-hit-meta" }, [
          el("strong", { text: result.author || (result.role === "user" ? "Вы" : result.provider === "claude" ? "Claude" : "Codex") }),
          el("span", { text: occurred && Number.isFinite(occurred.getTime())
            ? occurred.toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })
            : "" }),
          result.matchedField === "attachment"
            ? el("span", { class: "workspace-message-search-field", text: "Вложение" })
            : null,
        ]),
        workspaceSearchSnippet(result.snippet, search.query),
      ]));
    }
    workspaceMessageSearchResults.append(group);
  }
  const shortQuery = search.query.length < 2;
  const indexing = search.indexing ?? {};
  const indexingActive = indexing.state === "indexing";
  const indexingPartial = indexing.state === "partial";
  workspaceMessageSearchStatus.hidden = Boolean(search.results.length)
    && !search.loading && !search.error && !indexingActive && !indexingPartial;
  workspaceMessageSearchStatus.textContent = search.error
    || (shortQuery ? "Введите минимум два символа."
      : search.loading ? "Ищем во всех Streams…"
        : indexingActive
          ? `Индексируем историю: ${indexing.completedThreads ?? 0} из ${indexing.totalThreads ?? 0} Streams.`
          : indexingPartial
            ? `Индекс готов частично: ${indexing.failedThreads ?? 0} Streams пока недоступно.`
        : search.results.length ? "" : "Ничего не найдено.");
  workspaceMessageSearchMore.hidden = search.nextOffset == null || search.loading;
}

function openWorkspaceMessageSearch() {
  const task = currentTask();
  const workspaceId = String(task?.workspaceId ?? "").trim();
  if (!workspaceId) return showToast("Сначала выберите Workspace");
  const search = state.workspaceMessageSearch;
  search.open = true;
  search.workspaceId = workspaceId;
  workspaceMessageSearchTitle.textContent = `Поиск в «${task.workspaceName || task.title || "Workspace"}»`;
  renderWorkspaceMessageSearch();
  window.requestAnimationFrame(() => workspaceMessageSearchInput?.focus());
}

function closeWorkspaceMessageSearch({ restoreFocus = true } = {}) {
  state.workspaceMessageSearch.open = false;
  clearTimeout(workspaceMessageSearchIndexPollTimer);
  renderWorkspaceMessageSearch();
  if (restoreFocus) workspaceMessageSearchToggle?.focus();
}

let workspaceMessageSearchTimer = null;
let workspaceMessageSearchIndexPollTimer = null;
function requestWorkspaceMessageSearch({ append = false } = {}) {
  const search = state.workspaceMessageSearch;
  const query = String(workspaceMessageSearchInput?.value ?? "").trim();
  search.query = query;
  search.error = "";
  if (!append) {
    search.results = [];
    search.total = 0;
    search.nextOffset = null;
  }
  if (query.length < 2) {
    search.loading = false;
    renderWorkspaceMessageSearch();
    return;
  }
  search.loading = true;
  renderWorkspaceMessageSearch();
  emit("workspace-search:query", {
    workspaceId: search.workspaceId,
    query,
    offset: append ? search.nextOffset ?? search.results.length : 0,
    limit: 40,
    append,
  });
}

workspaceMessageSearchToggle?.addEventListener("click", openWorkspaceMessageSearch);
workspaceMessageSearchClose?.addEventListener("click", () => closeWorkspaceMessageSearch());
workspaceMessageSearchInput?.addEventListener("input", () => {
  clearTimeout(workspaceMessageSearchTimer);
  workspaceMessageSearchTimer = window.setTimeout(() => requestWorkspaceMessageSearch(), 250);
});
workspaceMessageSearchMore?.addEventListener("click", () => requestWorkspaceMessageSearch({ append: true }));
workspaceMessageSearchResults?.addEventListener("click", (event) => {
  const hit = event.target.closest("[data-workspace-message-search-result]");
  if (!hit) return;
  const result = state.workspaceMessageSearch.results.find(
    (candidate) => candidate.id === hit.dataset.workspaceMessageSearchResult,
  );
  if (result) emit("workspace-search:open", result);
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.workspaceMessageSearch.open) {
    event.preventDefault();
    closeWorkspaceMessageSearch();
  }
});

let suppressStreamTabClick = false;
streamTabs?.addEventListener("click", (event) => {
  const overflowToggle = event.target.closest("[data-stream-overflow-toggle]");
  if (overflowToggle) {
    const menu = streamTabs.querySelector("[data-stream-tabs-overflow-menu]");
    const open = menu?.hidden !== false;
    if (menu) menu.hidden = !open;
    overflowToggle.setAttribute("aria-expanded", String(open));
    return;
  }
  if (suppressStreamTabClick) {
    suppressStreamTabClick = false;
    return;
  }
  const tab = event.target.closest("[data-stream-tab-id][data-workspace-id]");
  if (!tab) return;
  const workspaceId = String(tab.dataset.workspaceId ?? "");
  const streams = workspaceStreams(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  toggleOpenStream(workspaceId, String(tab.dataset.streamTabId ?? ""), streams, {
    additive: event.ctrlKey || event.metaKey,
  });
});

if (streamTabs && typeof ResizeObserver === "function") {
  new ResizeObserver(scheduleStreamTabsOverflow).observe(streamTabs);
}

let streamContextMenu = null;
let workspaceContextMenu = null;
let workspaceCardId = "";
let workspaceCardMode = "edit";
const AGENT_RULES_LIMIT_BYTES = 32 * 1024;
const agentRulesEncoder = new TextEncoder();
const streamRulesDrafts = new Map();

function agentRulesText(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.content === "string") return value.content;
  return "";
}

function entityAgentRules(entity) {
  return agentRulesText(entity?.developerRules ?? entity?.rules);
}

function updateAgentRulesLimit(input, output) {
  if (!input) return true;
  const bytes = agentRulesEncoder.encode(String(input.value ?? "")).byteLength;
  const valid = bytes <= AGENT_RULES_LIMIT_BYTES;
  input.setCustomValidity(valid ? "" : "Правила не должны превышать 32 КиБ в UTF-8.");
  if (output) {
    output.textContent = `${(bytes / 1024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} / 32 КиБ`;
    output.toggleAttribute("data-limit-exceeded", !valid);
  }
  return valid;
}

function effectiveAgentRules(workspaceRules, streamRules) {
  const sections = [];
  const inherited = String(workspaceRules ?? "").trim();
  const own = String(streamRules ?? "").trim();
  if (inherited) sections.push(`<workspace_instructions>\n${inherited}\n</workspace_instructions>`);
  if (own) sections.push(`<stream_instructions>\n${own}\n</stream_instructions>`);
  return sections.join("\n\n");
}

function renderStreamRulesPreview() {
  const task = currentTask();
  const streamId = String(task?.streamId ?? "");
  const serverRules = agentRulesText(task?.streamDeveloperRules ?? task?.streamRules);
  const draft = streamRulesDrafts.get(streamId);
  if (draft?.value === serverRules) streamRulesDrafts.delete(streamId);
  const ownRules = streamRulesDrafts.get(streamId)?.value ?? serverRules;
  const workspaceRules = agentRulesText(task?.workspaceDeveloperRules ?? task?.workspaceRules);
  if (dialogStreamRules && document.activeElement !== dialogStreamRules) dialogStreamRules.value = ownRules;
  const valid = updateAgentRulesLimit(dialogStreamRules, dialogStreamRulesCount);
  if (dialogStreamRules) dialogStreamRules.disabled = !streamId;
  if (dialogStreamRulesSave) {
    dialogStreamRulesSave.disabled = !streamId || !valid || ownRules === serverRules;
  }
  if (dialogWorkspaceRules) dialogWorkspaceRules.hidden = !workspaceRules;
  if (dialogWorkspaceRulesPreview) {
    dialogWorkspaceRulesPreview.textContent = workspaceRules || "Правила Workspace не заданы.";
  }
  if (dialogEffectiveRulesPreview) {
    dialogEffectiveRulesPreview.textContent = effectiveAgentRules(workspaceRules, ownRules)
      || "Дополнительные developer-инструкции не заданы.";
  }
}

function closeStreamContextMenu() {
  if (!streamContextMenu) return;
  streamContextMenu.hidden = true;
  streamContextMenu.replaceChildren();
}

function workspaceCatalogItem(workspaceId) {
  const id = String(workspaceId ?? "").trim();
  return state.workspaces.find((workspace) => String(workspace.id ?? "") === id) ?? null;
}

function dashboardColumnOrder() {
  const workspaceColumns = state.workspaces.map((workspace) => `workspace:${workspace.id}`);
  const available = new Set([...workspaceColumns, "notes"]);
  const order = [];
  for (const columnId of state.workspaceColumnOrder) {
    if (available.has(columnId) && !order.includes(columnId)) order.push(columnId);
  }
  for (const columnId of [...workspaceColumns, "notes"]) {
    if (!order.includes(columnId)) order.push(columnId);
  }
  return order;
}

function closeWorkspaceContextMenu() {
  if (!workspaceContextMenu) return;
  workspaceContextMenu.hidden = true;
  workspaceContextMenu.dataset.workspaceId = "";
}

function closeWorkspaceCard() {
  workspaceCardId = "";
  workspaceCardMode = "edit";
  if (workspaceCardModal?.open) workspaceCardModal.close();
}

function releaseChangeStatusLabel(status) {
  return ({
    draft: "Черновик", ready: "Готово", blocked: "Заблокировано",
    released: "Выпущено", discarded: "Исключено",
  })[status]
    ?? String(status ?? "");
}

function renderWorkspaceReleaseRegistry(workspace) {
  if (!workspaceReleaseRegistry || !workspaceReleaseList || !workspaceReleaseSummary) return;
  const registry = workspaceReleaseRegistryByWorkspace.get(workspace?.id);
  const changes = Array.isArray(registry?.changes) ? registry.changes : [];
  const streamNames = new Map((workspace?.streams ?? []).map((stream) => [stream.id, stream.name]));
  const conflictingChangeIds = new Set((registry?.conflicts ?? [])
    .flatMap((conflict) => conflict.changes ?? []).map((change) => change.id));
  workspaceReleaseRegistry.hidden = workspaceCardMode === "create";
  if (workspaceCardMode === "create") return;
  if (!registry) {
    workspaceReleaseSummary.textContent = "Загрузка…";
    workspaceReleaseList.replaceChildren(el("p", { class: "workspace-release-empty", text: "Загрузка реестра…" }));
    return;
  }
  const count = (status) => Number(registry.counts?.[status]) || 0;
  const conflictCount = Array.isArray(registry.conflicts) ? registry.conflicts.length : 0;
  workspaceReleaseSummary.textContent = `Готово: ${count("ready")} · Черновики: ${count("draft")} · Блокеры: ${count("blocked")} · Конфликты: ${conflictCount}`;
  workspaceReleaseList.replaceChildren(...changes.map((change) => {
    const conflictingFiles = (registry.conflicts ?? [])
      .filter((conflict) => (conflict.changes ?? []).some((item) => item.id === change.id))
      .map((conflict) => conflict.file);
    const select = el("select", {
      "data-release-change-status": change.id,
      "aria-label": `Статус изменения ${change.summary || change.id}`,
    }, ["draft", "ready", "blocked", "discarded"].map((status) => el("option", {
      value: status,
      text: releaseChangeStatusLabel(status),
      selected: change.status === status,
    })));
    return el("article", {
      class: `workspace-release-change${conflictingChangeIds.has(change.id) ? " has-conflict" : ""}`,
    }, [
      el("div", { class: "workspace-release-change-title" }, [
        el("strong", { text: change.summary || "Изменения без описания" }),
        select,
      ]),
      el("span", {
        class: "workspace-release-change-stream",
        text: `${streamNames.get(change.streamId) ?? change.streamId} · ${change.provider} · ${String(change.turnId ?? "").slice(0, 12)}`,
      }),
      conflictingFiles.length
        ? el("strong", { class: "workspace-release-conflict", text: `Пересечение файлов: ${conflictingFiles.join(", ")}` })
        : null,
      el("div", { class: "workspace-release-files" }, (change.files ?? []).map((file) => (
        el("code", { text: file })
      ))),
    ]);
  }));
  if (!changes.length) {
    workspaceReleaseList.append(el("p", { class: "workspace-release-empty", text: "Активных изменений нет." }));
  }
}

function openWorkspaceCard(workspaceId) {
  const workspace = workspaceCatalogItem(workspaceId);
  if (!workspace || !workspaceCardModal) return;
  const columnId = `workspace:${workspace.id}`;
  const order = dashboardColumnOrder();
  workspaceCardMode = "edit";
  workspaceCardId = String(workspace.id);
  workspaceCardTitle.textContent = "Редактирование Workspace";
  workspaceCardSubmit.textContent = "Сохранить";
  workspaceCardName.value = String(workspace.name ?? "");
  workspaceCardName.disabled = workspace.kind === "system";
  workspaceCardComment.value = String(workspace.comment ?? "");
  workspaceCardWorkingDirectory.value = String(workspace.settings?.workingDirectory ?? "");
  workspaceCardRules.value = entityAgentRules(workspace);
  updateAgentRulesLimit(workspaceCardRules, workspaceCardRulesCount);
  renderWorkspaceReleaseRegistry(workspace);
  workspaceCardOrder.max = String(order.length);
  workspaceCardOrder.value = String(Math.max(1, order.indexOf(columnId) + 1));
  workspaceCardModal.showModal();
  emit("workspace-release:open", { workspaceId: workspace.id });
  (workspaceCardName.disabled ? workspaceCardComment : workspaceCardName).focus();
}

function openNewWorkspaceCard() {
  if (!workspaceCardModal) return;
  const order = dashboardColumnOrder();
  const notesIndex = order.indexOf("notes");
  workspaceCardMode = "create";
  workspaceCardId = "";
  workspaceCardTitle.textContent = "Новый Workspace";
  workspaceCardSubmit.textContent = "Создать";
  workspaceCardName.value = "";
  workspaceCardName.disabled = false;
  workspaceCardComment.value = "";
  workspaceCardWorkingDirectory.value = "";
  workspaceCardRules.value = "";
  updateAgentRulesLimit(workspaceCardRules, workspaceCardRulesCount);
  renderWorkspaceReleaseRegistry(null);
  workspaceCardOrder.max = String(order.length + 1);
  workspaceCardOrder.value = String((notesIndex < 0 ? order.length : notesIndex) + 1);
  workspaceCardModal.showModal();
  workspaceCardName.focus();
}

function ensureWorkspaceContextMenu() {
  if (workspaceContextMenu) return workspaceContextMenu;
  workspaceContextMenu = el("div", {
    class: "stream-context-menu workspace-context-menu",
    role: "menu",
    "aria-label": "Управление Workspace",
    hidden: true,
  }, [el("button", {
    type: "button",
    role: "menuitem",
    class: "stream-context-action",
    "data-workspace-menu-action": "edit",
    text: "Редактировать Workspace…",
  })]);
  document.body.append(workspaceContextMenu);
  workspaceContextMenu.addEventListener("click", (event) => {
    const action = event.target.closest("[data-workspace-menu-action='edit']");
    if (!action) return;
    event.preventDefault();
    const workspaceId = String(workspaceContextMenu.dataset.workspaceId ?? "");
    closeWorkspaceContextMenu();
    openWorkspaceCard(workspaceId);
  });
  return workspaceContextMenu;
}

function openWorkspaceContextMenu(event, workspaceId) {
  if (!workspaceCatalogItem(workspaceId)) return;
  closeStreamContextMenu();
  const menu = ensureWorkspaceContextMenu();
  menu.dataset.workspaceId = String(workspaceId);
  menu.hidden = false;
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("button")?.focus();
}

function workspaceMenuOptions(currentWorkspaceId) {
  const workspaces = new Map();
  for (const task of state.tasks) {
    const workspaceId = String(task.workspaceId ?? "").trim();
    if (!workspaceId || workspaceId === currentWorkspaceId || workspaces.has(workspaceId)) continue;
    workspaces.set(workspaceId, String(task.workspaceName ?? task.title ?? "Без названия").trim() || "Без названия");
  }
  return [...workspaces].map(([id, name]) => ({ id, name }))
    .sort((left, right) => left.name.localeCompare(right.name, "ru"));
}

function ensureStreamContextMenu() {
  if (streamContextMenu) return streamContextMenu;
  streamContextMenu = el("div", {
    class: "stream-context-menu",
    role: "menu",
    "aria-label": "Управление Stream",
    hidden: true,
  });
  document.body.append(streamContextMenu);
  streamContextMenu.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-stream-menu-action]");
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    const streamId = String(streamContextMenu.dataset.streamId ?? "");
    const kind = String(action.dataset.streamMenuAction ?? "");
    const currentName = String(streamContextMenu.dataset.streamName ?? "");
    const workspaceId = String(streamContextMenu.dataset.workspaceId ?? "");
    const taskId = String(streamContextMenu.dataset.taskId ?? "");
    const provider = String(streamContextMenu.dataset.provider ?? "codex");
    closeStreamContextMenu();
    if (!streamId) return;
    if (kind === "rename") {
      const name = await askText({ title: "Новое название Stream", value: currentName });
      if (name != null) emit("stream:rename", { streamId, name });
      return;
    }
    if (kind === "edit-stream") {
      if (taskId && currentTask()?.id !== taskId) selectTaskFromUi(taskId);
      openDialogSettings();
      return;
    }
    if (kind === "edit-workspace") {
      if (workspaceId) openWorkspaceCard(workspaceId);
      return;
    }
    if (kind === "replace-thread") {
      emit("stream:rebirth", { streamId, provider, taskId });
      return;
    }
    if (kind === "archive") {
      const intent = window.AgentHubStreamTabs.archiveStreamIntent(streamId);
      emit(intent.type, intent.detail);
      return;
    }
    if (kind === "move") {
      emit("stream:move", { streamId, workspaceId: String(action.dataset.workspaceId ?? "") });
      return;
    }
    if (kind === "create-workspace") {
      const name = await askText({ title: "Название нового Workspace" });
      if (name) emit("workspace:create-from-stream", { streamId, name });
    }
  });
  return streamContextMenu;
}

function openStreamContextMenu(event, tab) {
  const menu = ensureStreamContextMenu();
  const streamId = String(tab.dataset.streamTabId ?? "");
  const workspaceId = String(tab.dataset.workspaceId ?? "");
  menu.dataset.streamId = streamId;
  menu.dataset.workspaceId = workspaceId;
  menu.dataset.workspaceName = String(tab.dataset.workspaceName ?? "");
  menu.dataset.streamName = String(tab.dataset.streamName ?? "");
  menu.dataset.taskId = String(tab.dataset.streamTaskId ?? "");
  menu.dataset.provider = String(tab.dataset.streamProvider ?? "codex");
  menu.replaceChildren(
    el("button", {
      type: "button", role: "menuitem", class: "stream-context-action",
      "data-stream-menu-action": "edit-stream", text: "Редактировать Stream…",
    }),
    el("button", {
      type: "button", role: "menuitem", class: "stream-context-action",
      "data-stream-menu-action": "rename", text: "Переименовать Stream…",
    }),
    el("button", {
      type: "button", role: "menuitem", class: "stream-context-action",
      "data-stream-menu-action": "edit-workspace", text: "Редактировать Workspace…",
    }),
    el("button", {
      type: "button", role: "menuitem", class: "stream-context-action",
      "data-stream-menu-action": "replace-thread", text: "Ротация",
      disabled: tab.hasAttribute("data-running"),
      title: tab.hasAttribute("data-running")
        ? "Сначала завершите текущий ход"
        : "Завершить текущий Thread и продолжить Stream в новом",
    }),
    el("button", {
      type: "button", role: "menuitem", class: "stream-context-action stream-context-danger",
      "data-stream-menu-action": "archive", text: "В архив",
      disabled: tab.hasAttribute("data-running"),
      title: tab.hasAttribute("data-running")
        ? "Сначала завершите активный ход в этом Stream"
        : "Архивировать Stream",
    }),
    el("details", { class: "stream-context-submenu" }, [
      el("summary", { class: "stream-context-action", text: "Перенести в Workspace…" }),
      el("div", { class: "stream-context-submenu-options" }, [
        ...workspaceMenuOptions(workspaceId).map((workspace) => el("button", {
          type: "button", role: "menuitem", class: "stream-context-action",
          "data-stream-menu-action": "move", "data-workspace-id": workspace.id,
          text: workspace.name,
        })),
        el("button", {
          type: "button", role: "menuitem", class: "stream-context-action stream-context-create",
          "data-stream-menu-action": "create-workspace", text: "+ Новый Workspace…",
        }),
      ]),
    ]),
  );
  menu.hidden = false;
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("button")?.focus();
}

streamTabs?.addEventListener("contextmenu", (event) => {
  const tab = event.target.closest("[data-stream-tab-id][data-stream-name]");
  if (!tab) return;
  event.preventDefault();
  openStreamContextMenu(event, tab);
});

let streamLongPress = null;
let streamLongPressOrigin = null;

function cancelStreamLongPress() {
  if (streamLongPress) window.clearTimeout(streamLongPress);
  streamLongPress = null;
  streamLongPressOrigin = null;
}

streamTabs?.addEventListener("pointerdown", (event) => {
  if (event.pointerType !== "touch") return;
  const tab = event.target.closest("[data-stream-tab-id][data-stream-name]");
  if (!tab) return;
  cancelStreamLongPress();
  streamLongPressOrigin = { x: event.clientX, y: event.clientY };
  streamLongPress = window.setTimeout(() => {
    suppressStreamTabClick = true;
    openStreamContextMenu({ clientX: event.clientX, clientY: event.clientY }, tab);
    cancelStreamLongPress();
    window.setTimeout(() => { suppressStreamTabClick = false; }, 700);
  }, 550);
});
streamTabs?.addEventListener("pointermove", (event) => {
  if (!streamLongPressOrigin) return;
  if (Math.hypot(event.clientX - streamLongPressOrigin.x, event.clientY - streamLongPressOrigin.y) > 8) {
    cancelStreamLongPress();
  }
});
streamTabs?.addEventListener("pointerup", cancelStreamLongPress);
streamTabs?.addEventListener("pointercancel", cancelStreamLongPress);

streamTabs?.addEventListener("keydown", (event) => {
  if (!(event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) return;
  const tab = event.target.closest("[data-stream-tab-id][data-stream-name]");
  if (!tab) return;
  event.preventDefault();
  const rect = tab.getBoundingClientRect();
  openStreamContextMenu({ clientX: rect.left + 12, clientY: rect.bottom - 4 }, tab);
});

document.addEventListener("click", (event) => {
  const overflowMenu = streamTabs?.querySelector("[data-stream-tabs-overflow-menu]");
  const overflowToggle = streamTabs?.querySelector("[data-stream-overflow-toggle]");
  if (overflowMenu && !overflowMenu.hidden && !event.target.closest("[data-stream-tabs-overflow]")) {
    overflowMenu.hidden = true;
    overflowToggle?.setAttribute("aria-expanded", "false");
  }
  if (streamContextMenu && !streamContextMenu.contains(event.target)) closeStreamContextMenu();
  if (workspaceContextMenu && !workspaceContextMenu.contains(event.target)) closeWorkspaceContextMenu();
});
window.addEventListener("resize", closeStreamContextMenu);
window.addEventListener("resize", closeWorkspaceContextMenu);
window.addEventListener("resize", scheduleStreamTabsOverflow);
document.addEventListener("scroll", (event) => {
  if (!streamContextMenu?.contains(event.target)) closeStreamContextMenu();
  if (!workspaceContextMenu?.contains(event.target)) closeWorkspaceContextMenu();
}, true);

let draggedStreamId = "";
streamTabs?.addEventListener("dragstart", (event) => {
  if (streamOrderMode !== "manual") {
    event.preventDefault();
    return;
  }
  const tab = event.target.closest("[data-stream-tab-id]");
  draggedStreamId = String(tab?.dataset.streamTabId ?? "");
  if (!draggedStreamId) event.preventDefault();
  else event.dataTransfer?.setData("text/plain", draggedStreamId);
});
streamTabs?.addEventListener("dragover", (event) => {
  if (!draggedStreamId || !event.target.closest("[data-stream-tab-id]")) return;
  event.preventDefault();
});
streamTabs?.addEventListener("drop", (event) => {
  if (streamOrderMode !== "manual") return;
  const target = event.target.closest("[data-stream-tab-id][data-workspace-id]");
  const streamId = draggedStreamId || event.dataTransfer?.getData("text/plain") || "";
  draggedStreamId = "";
  if (!target || !streamId) return;
  event.preventDefault();
  suppressStreamTabClick = true;
  const workspaceId = String(target.dataset.workspaceId ?? "");
  const targetId = String(target.dataset.streamTabId ?? "");
  if (targetId === streamId) return;
  const streams = workspaceStreams(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  const order = orderedWorkspaceStreams(streams).map((stream) => stream.id)
    .filter((id) => id !== streamId);
  const targetIndex = order.indexOf(targetId);
  const insertAfter = event.clientX > target.getBoundingClientRect().left + target.clientWidth / 2;
  order.splice(Math.max(0, targetIndex + (insertAfter ? 1 : 0)), 0, streamId);
  const beforeStreamId = order[order.indexOf(streamId) + 1] ?? null;
  emit("stream:move", { streamId, workspaceId, beforeStreamId });
});
streamTabs?.addEventListener("dragend", () => {
  draggedStreamId = "";
  window.setTimeout(() => { suppressStreamTabClick = false; }, 0);
});

function ensureTaskStreamVisible(task) {
  if (!task || !String(task.workspaceId ?? "").trim()) return;
  const workspaceId = workspaceKey(task);
  const streams = workspaceStreams(state.tasks.filter((candidate) => workspaceKey(candidate) === workspaceId));
  reconcileOpenStreams(workspaceId, streams);
  const streamId = streamKey(task);
  const open = state.openStreamsByWorkspace.get(workspaceId) ?? [];
  if (open.includes(streamId)) return;
  // Любая обычная навигация к скрытому Stream является новым одиночным
  // layout. Расширять набор колонок может только явный Ctrl/Cmd+click.
  state.openStreamsByWorkspace.set(workspaceId, [streamId]);
  state.configuredOpenStreamWorkspaces.add(workspaceId);
  persistOpenStreams();
}

function selectTaskFromUi(id) {
  if (!id) return;
  saveDraft();
  state.selectedId = id;
  for (const task of state.tasks) task.selected = task.id === id;
  const selected = currentTask();
  if (selected) {
    state.activeStreamByWorkspace.set(workspaceKey(selected), streamKey(selected));
  }
  ensureTaskStreamVisible(currentTask());
  persistOpenStreams();
  renderTasks();
  renderChat();
  setPane("chat");
  emit("task:select", { id });
}

/* ================================================================== чат */

let activeChatId = null;

function messageCountLabel(count) {
  const value = Math.max(0, Number(count) || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  const noun = mod100 >= 11 && mod100 <= 14
    ? "сообщений"
    : mod10 === 1 ? "сообщение" : mod10 >= 2 && mod10 <= 4 ? "сообщения" : "сообщений";
  return `${value.toLocaleString("ru-RU")} ${noun}`;
}

function renderStreamChatHeader(task) {
  if (!streamChatHeader) return;
  streamChatHeader.hidden = !task;
  if (!task) return;
  const provider = String(task.provider ?? "none");
  const providerLabel = task.agentLabel || providerLabels[provider] || "Агент";
  const statusState = window.AgentHubStreamTabs.streamStatusState(task);
  if (streamHeaderProviderDot) {
    streamHeaderProviderDot.dataset.provider = provider;
    streamHeaderProviderDot.dataset.state = statusState;
  }
  if (streamHeaderProvider) streamHeaderProvider.textContent = providerLabel;
  const model = String(task.modelLabel ?? "").trim();
  if (streamHeaderModel) {
    streamHeaderModel.textContent = shortModelLabel(model);
    streamHeaderModel.title = model;
    streamHeaderModel.hidden = !model;
  }
  if (streamHeaderModelSeparator) streamHeaderModelSeparator.hidden = !model;
  const branch = String(task.branch ?? task.gitBranch ?? task.repositoryBranch ?? "").trim();
  if (streamHeaderBranch) {
    streamHeaderBranch.textContent = branch;
    streamHeaderBranch.hidden = !branch;
  }
  if (streamHeaderBranchSeparator) streamHeaderBranchSeparator.hidden = !branch;
  if (streamHeaderMessageCount) {
    streamHeaderMessageCount.textContent = messageCountLabel(state.messages.get(task.id)?.length ?? 0);
  }
}

function renderChat() {
  const task = currentTask();
  const hasTask = Boolean(task);
  if (!hasTask) {
    chatEmpty.hidden = false;
    if (chatEmptyText) chatEmptyText.textContent = "Выберите Workspace слева, чтобы открыть его Streams.";
    streamTabs.hidden = true;
    streamTabs.replaceChildren();
    chatPane.hidden = true;
    activeChatId = null;
    renderedStreamChatDeckKey = "";
    streamChatColumns?.replaceChildren(chatPane);
    streamChatColumns.hidden = true;
    streamChatColumns?.removeAttribute("data-multi-stream");
    publishVisibleStreamTasks([]);
    renderStreamChatHeader(null);
    setDialogSettingsOpen(false);
    return;
  }
  // activeChatId is logical state; the physical message surface can still lag
  // behind it after a failed/interrupted render. Treat ownership divergence as
  // a real task switch so the next render self-heals instead of preserving the
  // previous Stream forever.
  const taskChanged = activeChatId !== task.id
    || String(chatLog.dataset.messageOwnerKey ?? "") !== String(task.id ?? "");

  renderDialogSettings();
  renderStreamChatHeader(task);
  for (const stop of chatStops) stop.hidden = !task.running;
  renderContextUsage(task);
  renderStreamTabs();
  // Сначала закрепляем окончательную ширину и порядок колонок. Историю и её
  // нижний якорь рисуем уже после layout, поэтому открытый чат не остаётся выше.
  renderStreamChatDeck();

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
  const available = Number(context?.modelContextWindow) > 0;
  contextUsageButton.hidden = !available;
  if (!available) return;
  const percent = Math.max(0, Math.min(100, Number(context.percent) || 0));
  const used = Math.max(0, Number(context.usedTokens) || 0);
  const total = Math.max(0, Number(context.modelContextWindow) || 0);
  const cleaningImages = context.compaction?.stage === "cleaning-images";
  contextLabel.textContent = context.compacting
    ? "свёртка…"
    : context.usagePending ? "обновление…" : `${Math.round(percent)}% контекста`;
  contextRing.style.setProperty("--context-percent", `${percent}%`);
  contextUsageButton.title = context.compacting
    ? cleaningImages
      ? "Свёртка создана. Удаляются дубликаты изображений…"
      : "Контекст сворачивается…"
    : context.usagePending
      ? "Контекст свёрнут. Ожидается обновлённый объём…"
    : `Контекст: ${used.toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")}. Нажмите для подробностей.`;
  contextUsageButton.disabled = false;
  contextUsageButton.toggleAttribute("data-compacting", Boolean(context.compacting));
  if (contextUsageModal?.open) renderContextUsageDetails(task);
}

function contextTokens(value, estimated = false) {
  if (value == null) return "учтено в остатке";
  return `${estimated ? "≈" : ""}${Math.max(0, Number(value) || 0).toLocaleString("ru-RU")}`;
}

function renderContextUsageDetails(task) {
  const context = task?.context;
  if (!context || !Number(context.modelContextWindow)) return;
  const used = Math.max(0, Number(context.usedTokens) || 0);
  const total = Math.max(0, Number(context.modelContextWindow) || 0);
  const percent = Math.max(0, Math.min(100, Number(context.percent) || 0));
  contextUsageSummary.textContent = `${used.toLocaleString("ru-RU")} из ${total.toLocaleString("ru-RU")} токенов`;
  contextUsageSummaryPercent.textContent = `${Math.round(percent)}%`;
  contextUsageTotalFill.style.width = `${percent}%`;
  contextUsageCategories.replaceChildren();
  for (const category of Array.isArray(context.breakdown?.categories) ? context.breakdown.categories : []) {
    const row = document.createElement("div");
    row.className = "context-usage-category";
    const head = document.createElement("div");
    head.className = "context-usage-category-head";
    const label = document.createElement("span");
    label.textContent = category.label;
    const value = document.createElement("span");
    const count = Math.max(0, Number(category.count) || 0);
    value.textContent = category.tokens == null && count
      ? `${count.toLocaleString("ru-RU")} шт. · ${contextTokens(null)}`
      : contextTokens(category.tokens, category.estimated === true);
    head.append(label, value);
    row.append(head);
    const share = total && category.tokens != null
      ? Math.max(0, Math.min(100, (Number(category.tokens) / total) * 100))
      : 0;
    const major = category.tokens != null && share >= 2;
    if (major) {
      const bar = document.createElement("div");
      bar.className = "context-usage-category-bar";
      if (/свобод/iu.test(String(category.label ?? ""))) bar.dataset.kind = "neutral";
      const fill = document.createElement("span");
      fill.style.width = `${share}%`;
      bar.append(fill);
      row.append(bar);
    } else {
      row.dataset.minor = "";
    }
    contextUsageCategories.append(row);
  }
  contextUsageNote.textContent = context.breakdown?.note ?? "";
  contextUsageCompact.hidden = task.provider !== "codex";
  contextUsageCompact.disabled = Boolean(task.running || context.compacting || context.usagePending);
  contextUsageCompact.textContent = context.compacting ? "Контекст сворачивается…" : "Свернуть контекст";
}

function openContextUsage() {
  const task = currentTask();
  if (!task?.context || !Number(task.context.modelContextWindow) || !contextUsageModal) return;
  if (contextUsageModal.open) {
    closeContextUsage();
    return;
  }
  renderContextUsageDetails(task);
  contextUsageModal.show();
  contextUsageButton.setAttribute("aria-expanded", "true");
  positionContextUsage();
}

function closeContextUsage() {
  if (contextUsageModal?.open) contextUsageModal.close();
  contextUsageButton?.setAttribute("aria-expanded", "false");
}

function positionContextUsage() {
  if (!contextUsageModal?.open || !contextUsageButton) return;
  const rect = contextUsageButton.getBoundingClientRect();
  contextUsageModal.style.setProperty("--context-popover-right", `${Math.max(12, window.innerWidth - rect.right)}px`);
  contextUsageModal.style.setProperty("--context-popover-bottom", `${Math.max(12, window.innerHeight - rect.top + 8)}px`);
}

function chatIsNearBottom() {
  return scrollContainerIsNearBottom(chatScroll);
}

function pinChatToBottom() {
  const controller = chatScrollControllers.get(chatScroll);
  const apply = () => {
    controller?.pinNow();
  };
  apply();
  // Финальная карточка нередко приходит одновременно с удалением live-блока.
  // Два кадра дают браузеру завершить оба reflow, прежде чем фиксировать низ.
  window.requestAnimationFrame(() => {
    apply();
    window.requestAnimationFrame(apply);
  });
}

let attachmentViewerOpen = false;
let attachmentViewerGallery = [];
let attachmentViewerIndex = 0;
let attachmentViewerReturnFocus = null;

function syncAttachmentViewerControls() {
  const length = attachmentViewerGallery.length;
  const selected = attachmentViewerGallery[attachmentViewerIndex] ?? {};
  attachmentViewerPrevious.hidden = length < 2 || attachmentViewerIndex <= 0;
  attachmentViewerNext.hidden = length < 2 || attachmentViewerIndex >= length - 1;
  attachmentViewerCaption.hidden = length === 0;
  attachmentViewerName.textContent = String(selected.name ?? "Изображение");
  attachmentViewerCounter.textContent = length > 1 ? `${attachmentViewerIndex + 1} / ${length}` : "";
}

function openAttachmentViewer({ dataUrl = "", name = "Изображение", gallery = [], index = 0 } = {}) {
  if (!attachmentViewerOpen) attachmentViewerReturnFocus = document.activeElement;
  attachmentViewerGallery = resourceInteractions.imageGallery(
    Array.isArray(gallery) && gallery.length ? gallery : [{ dataUrl, name, type: "image/*" }],
  );
  attachmentViewerIndex = resourceInteractions.galleryIndex(index, attachmentViewerGallery.length);
  const selected = attachmentViewerGallery[attachmentViewerIndex] ?? { dataUrl, name };
  const selectedDataUrl = String(selected.dataUrl ?? dataUrl ?? "");
  attachmentViewerOpen = true;
  attachmentViewer.hidden = false;
  attachmentViewerImage.hidden = !selectedDataUrl;
  attachmentViewerLoading.hidden = Boolean(selectedDataUrl);
  attachmentViewerImage.alt = String(selected.name ?? name);
  attachmentViewerImage.src = selectedDataUrl;
  syncAttachmentViewerControls();
  root.dataset.overlay = "attachment";
  attachmentViewer.focus({ preventScroll: true });
}

function showAttachmentViewer({ dataUrl, name = "Изображение", index = attachmentViewerIndex } = {}) {
  if (!attachmentViewerOpen) openAttachmentViewer();
  if (resourceInteractions.galleryIndex(index, attachmentViewerGallery.length) !== attachmentViewerIndex) return;
  attachmentViewerImage.alt = name;
  attachmentViewerImage.src = String(dataUrl ?? "");
  attachmentViewerImage.hidden = !dataUrl;
  attachmentViewerLoading.hidden = Boolean(dataUrl);
  syncAttachmentViewerControls();
}

function moveAttachmentViewer(direction) {
  if (!attachmentViewerOpen) return false;
  const nextIndex = resourceInteractions.moveGalleryIndex(
    attachmentViewerIndex,
    direction,
    attachmentViewerGallery.length,
  );
  if (nextIndex === attachmentViewerIndex) return false;
  attachmentViewerIndex = nextIndex;
  const attachment = attachmentViewerGallery[attachmentViewerIndex];
  const dataUrl = String(attachment?.dataUrl ?? "");
  attachmentViewerImage.alt = String(attachment?.name ?? "Изображение");
  attachmentViewerImage.src = dataUrl;
  attachmentViewerImage.hidden = !dataUrl;
  attachmentViewerLoading.hidden = Boolean(dataUrl);
  syncAttachmentViewerControls();
  if (!dataUrl) emit("attachment:load", {
    attachment,
    gallery: attachmentViewerGallery,
    index: attachmentViewerIndex,
  });
  return true;
}

function closeAttachmentViewer() {
  if (!attachmentViewerOpen) return false;
  attachmentViewerOpen = false;
  attachmentViewer.hidden = true;
  attachmentViewerImage.removeAttribute("src");
  attachmentViewerImage.hidden = true;
  attachmentViewerLoading.hidden = false;
  attachmentViewerGallery = [];
  attachmentViewerIndex = 0;
  delete root.dataset.overlay;
  const returnFocus = attachmentViewerReturnFocus;
  attachmentViewerReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
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
attachmentViewerPrevious.addEventListener("click", () => moveAttachmentViewer(-1));
attachmentViewerNext.addEventListener("click", () => moveAttachmentViewer(1));
attachmentViewer.addEventListener("click", (event) => {
  if (resourceInteractions.shouldDismissViewer(
    event.target,
    attachmentViewer,
    attachmentViewerStage,
  )) closeAttachmentViewer();
});
window.addEventListener("keydown", (event) => {
  if (!attachmentViewerOpen) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    event.preventDefault();
    event.stopPropagation();
    moveAttachmentViewer(event.key === "ArrowLeft" ? -1 : 1);
    return;
  }
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeAttachmentViewer();
  }
}, true);

const EDGE_SWIPE_ZONE = 32;
const EDGE_SWIPE_DISTANCE = 52;
let swipeStart = null;

function swipeIgnoredTarget(target) {
  return Boolean(target?.closest?.(
    "input, textarea, select, button, a, [contenteditable='true'], .markdown-table-scroll",
  ));
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
  const fromLeftEdge = swipeStart.fromLeftEdge;
  swipeStart = null;
  if (!fromLeftEdge || dx < EDGE_SWIPE_DISTANCE || Math.abs(dx) < Math.abs(dy) * 1.4) return;
  navigateBack();
}, { passive: true });
document.addEventListener("touchcancel", () => { swipeStart = null; }, { passive: true });

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
  const bubble = article.querySelector(".msg-user-bubble");
  if (!bubble) return;
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
  const renderButton = (value) => button.replaceChildren(
    el("span", { text: value ? "Свернуть" : "Показать ещё" }),
    window.AgentHubStreamTabs.createPhosphorIcon(
      document,
      value ? "caret-up" : "caret-down",
      "msg-disclosure-icon",
    ),
  );
  renderButton(expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.onclick = () => {
    const nextExpanded = body.classList.contains("is-collapsed");
    body.classList.toggle("is-collapsed", !nextExpanded);
    if (id) {
      if (nextExpanded) expandedUserMessageIds.add(id);
      else expandedUserMessageIds.delete(id);
    }
    renderButton(nextExpanded);
    button.setAttribute("aria-expanded", String(nextExpanded));
  };
  if (!existing) bubble.append(button);
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

function messageTimeLabel(value) {
  return new Date(value).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function patchRenderedMessage(node, message) {
  const article = node.matches?.("article.msg") ? node : node.querySelector?.("article.msg");
  if (!article) return;
  article.dataset.messageId = message.id ?? "";
  article.dataset.turnId = message.turnId ?? "";
  article.dataset.itemId = message.itemId ?? "";
  article.dataset.deliveryState = message.deliveryState ?? "";
  const role = message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
  const author = message.author
    || (role === "user" ? "Вы" : role === "system" ? "Система" : "Агент");
  const head = article.querySelector(".msg-head");
  const authorNode = head?.querySelector(".msg-author");
  if (authorNode) authorNode.textContent = author;
  let time = head?.querySelector(".msg-time");
  if (message.time) {
    if (!time) {
      time = el("span", { class: "msg-time" });
      head?.insertBefore(time, head.querySelector(".msg-delivery"));
    }
    time.textContent = messageTimeLabel(message.time);
  } else {
    time?.remove();
  }
  let delivery = head?.querySelector(".msg-delivery");
  if (message.delivery) {
    if (!delivery) {
      delivery = el("span", { class: "msg-delivery" });
      head?.append(delivery);
    }
    delivery.textContent = message.delivery;
    delivery.classList.toggle("is-failed", message.failed === true);
  } else {
    delivery?.remove();
  }
}

function messageRenderSpec(message, index, lastAgentIndex, taskDiff) {
  const withDiff = index === lastAgentIndex && Boolean(taskDiff);
  return {
    key: MessageView.messageKey(message, index),
    signature: MessageView.messageContentSignature(message, {
      withDiff,
      diffText: taskDiff?.text ?? "",
    }),
    message,
    withDiff,
    taskDiff,
  };
}

function createRenderedMessage(spec) {
  const rendered = renderMessage(spec.message);
  if (!spec.withDiff) return rendered;
  return el("div", { class: "message-with-diff" }, [
    rendered,
    renderTaskDiff(state.selectedId, spec.taskDiff),
  ]);
}

function renderMessages({ forceBottom = false, preserveTop = false } = {}) {
  const task = currentTask();
  const taskId = String(task?.id ?? "");
  renderStreamChatHeader(task);
  const scrollController = chatScrollControllers.get(chatScroll);
  const scrollSnapshot = scrollController?.capture();
  const stickToBottom = forceBottom || scrollSnapshot?.pinned || chatIsNearBottom();
  // Обновление истории после финального ответа использует preserveTop. У низа
  // якорь первого видимого сообщения оставлял зазор после новой карточки.
  // Якорь нужен только читателю, который уже ушёл выше по истории.
  const anchor = preserveTop && !stickToBottom ? captureChatAnchor() : null;
  // chatLog is a single physical DOM surface shared by every Stream. Claim it
  // before reading the new history so keyed reconciliation can never reuse a
  // message node (or its event handlers) owned by the previously selected
  // Stream, even when providers emit colliding message identifiers.
  MessageView.claimKeyedChildrenOwner(chatLog, taskId);
  const historyLoaded = state.messages.has(taskId);
  const messages = state.messages.get(taskId) ?? [];
  renderHistoryLoader();
  if (messages.length === 0) {
    const emptyText = historyLoaded
      ? "История пуста. Отправьте первое сообщение агенту."
      : "Загрузка истории…";
    const existingEmpty = chatLog.querySelector(":scope > .chat-log-empty");
    if (chatLog.children.length !== 1 || !existingEmpty) {
      chatLog.replaceChildren(el("p", { class: "chat-log-empty", text: emptyText }));
    } else {
      existingEmpty.textContent = emptyText;
    }
    if (anchor) restoreChatAnchor(anchor);
    else if (stickToBottom) pinChatToBottom();
    else window.requestAnimationFrame(() => scrollController?.afterMutation(scrollSnapshot, { preserveDistance: true }));
    scheduleUnderfilledHistoryLoad();
    return;
  }
  let lastAgentIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (!["user", "system"].includes(messages[index]?.role)) {
      lastAgentIndex = index;
      break;
    }
  }
  const taskDiff = state.taskDiffs.get(taskId);
  const specs = messages.map((message, index) => (
    messageRenderSpec(message, index, lastAgentIndex, taskDiff)
  ));
  MessageView.reconcileKeyedChildren(chatLog, specs, createRenderedMessage, (node, spec) => {
    patchRenderedMessage(node, spec.message);
  });
  scheduleUserMessageDisclosureSync();
  if (anchor) restoreChatAnchor(anchor);
  else if (stickToBottom) pinChatToBottom();
  else window.requestAnimationFrame(() => scrollController?.afterMutation(scrollSnapshot, { preserveDistance: true }));
  scheduleUnderfilledHistoryLoad();
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

let historyUnderfillFrame = 0;

function scheduleUnderfilledHistoryLoad() {
  if (historyUnderfillFrame) return;
  historyUnderfillFrame = window.requestAnimationFrame(() => {
    historyUnderfillFrame = 0;
    const pagination = currentHistoryPagination();
    if (shouldLoadOlderPage(chatScroll, pagination)) requestOlderHistory();
  });
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

function currentFileLinkContext(task = currentTask()) {
  return {
    projectRoot: String(task?.projectRoot ?? "").trim(),
    basePath: String(task?.sessionCwd ?? task?.projectRoot ?? "").trim(),
  };
}

function normalizeWindowsPath(raw) {
  const source = String(raw ?? "").trim()
    .replace(/^\/(?=[A-Za-z]:[\\/])/u, "")
    .replaceAll("\\", "/");
  const match = source.match(/^([A-Za-z]):\/(.*)$/u);
  if (!match) return "";
  const segments = [];
  for (const segment of match[2].split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return "";
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return `${match[1].toUpperCase()}:/${segments.join("/")}`;
}

function desktopFileLink(raw, fileContext = currentFileLinkContext()) {
  if (!(vscodeMode || surface === "desktop")) return null;
  const reference = resourceInteractions.fileReferenceParts(raw);
  if (!reference) return null;
  const base = normalizeWindowsPath(fileContext?.basePath)
    || normalizeWindowsPath(fileContext?.projectRoot);
  const absolute = /^\/?[A-Za-z]:[\\/]/u.test(reference.file);
  const editorPath = normalizeWindowsPath(absolute
    ? reference.file
    : `${base}/${reference.file}`);
  if (!editorPath) return null;
  const location = reference.line
    ? `:${reference.line}${reference.column ? `:${reference.column}` : ""}`
    : "";
  const localPath = `${editorPath}${location}`;
  return {
    href: vscodeMode ? "#" : `vscode://file/${encodeURI(localPath)}`,
    localPath,
  };
}

function markdownLink(raw, fileContext = currentFileLinkContext()) {
  const source = String(raw ?? "").trim();
  const value = source.startsWith("<") && source.endsWith(">")
    ? source.slice(1, -1).trim()
    : source;
  if (/^https?:\/\//iu.test(value)) {
    try {
      return { href: new URL(value).href };
    } catch {
      return null;
    }
  }
  return desktopFileLink(value, fileContext);
}

function codexFileCitation(raw) {
  const token = String(raw ?? "");
  const attributes = Object.fromEntries(
    [...token.matchAll(/([\w-]+)="([^"]*)"/gu)]
      .map((match) => [String(match[1]), String(match[2])]),
  );
  const path = String(attributes.path ?? "").trim();
  if (!path) return null;
  const name = path.replaceAll("\\", "/").split("/").filter(Boolean).at(-1) || "Файл";
  const location = [attributes.sheet, attributes.range].filter(Boolean).join(" · ");
  return { path, label: location ? `${name} · ${location}` : name };
}

function appendInlineMarkdown(target, source, fileContext = currentFileLinkContext()) {
  const text = String(source ?? "");
  const pattern = /(:codex-file-citation\{[^}\n]+\}|`[^`\n]+`|\*\*[^*\n]+\*\*|\*[^*\n]+\*|\[[^\]\n]+\]\([^)\n]+\))/gu;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    target.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith(":codex-file-citation{")) {
      const citation = codexFileCitation(token);
      const targetLink = markdownLink(citation?.path, fileContext);
      const attributes = {
        class: "file-citation",
        text: citation?.label ?? "Файл",
        title: citation?.path ?? "",
      };
      if (targetLink) {
        const link = el("a", {
          ...attributes,
          href: targetLink.href,
          target: "_blank",
          rel: "noopener noreferrer",
        });
        if (targetLink.localPath) link.dataset.agentHubLocalLink = targetLink.localPath;
        target.append(link);
      } else {
        target.append(el("span", attributes));
      }
    } else if (token.startsWith("`")) {
      const value = token.slice(1, -1);
      const targetLink = desktopFileLink(value, fileContext);
      const code = el("code", { text: value });
      if (targetLink) {
        const link = el("a", {
          class: "inline-file-link",
          href: targetLink.href,
          target: "_blank",
          rel: "noopener noreferrer",
          title: targetLink.localPath,
        }, [code]);
        link.dataset.agentHubLocalLink = targetLink.localPath;
        target.append(link);
      } else {
        target.append(code);
      }
    } else if (token.startsWith("**")) {
      const strong = el("strong");
      appendInlineMarkdown(strong, token.slice(2, -2), fileContext);
      target.append(strong);
    } else if (token.startsWith("*")) {
      const emphasis = el("em");
      appendInlineMarkdown(emphasis, token.slice(1, -1), fileContext);
      target.append(emphasis);
    } else {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u);
      const targetLink = markdownLink(parts?.[2], fileContext);
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

function renderMarkdownTable(table, fileContext) {
  const head = el("tr");
  table.headers.forEach((value, index) => {
    const cell = el("th", { scope: "col" });
    cell.style.textAlign = table.alignments[index];
    appendInlineMarkdown(cell, value, fileContext);
    head.append(cell);
  });
  const body = el("tbody");
  table.rows.forEach((values) => {
    const row = el("tr");
    values.forEach((value, index) => {
      const cell = el("td");
      cell.style.textAlign = table.alignments[index];
      appendInlineMarkdown(cell, value, fileContext);
      row.append(cell);
    });
    body.append(row);
  });
  return el("div", { class: "markdown-table-scroll", tabindex: "0" }, [
    el("table", { class: "markdown-table" }, [el("thead", {}, [head]), body]),
  ]);
}

function technicalTailLine(line) {
  const match = String(line ?? "").match(/^\s*(?:[-*]\s+)?(runtime|коммит)\s*[:—-]\s*(?:`([^`]+)`|(\S+))(.*)$/iu);
  if (!match) return null;
  return {
    label: match[1].toLocaleUpperCase("ru-RU"),
    value: String(match[2] ?? match[3] ?? "").trim(),
    note: String(match[4] ?? "").replace(/^\s*[,;—-]?\s*/u, "").trim(),
  };
}

function renderTechnicalRows(rows) {
  const values = Array.isArray(rows) ? rows : [];
  if (!values.length) return null;
  return el("div", { class: "msg-technical" }, values.map((row) => el("div", {
    class: "msg-technical-row",
  }, [
    el("span", { class: "msg-technical-label", text: row.label }),
    el("code", { class: "msg-technical-value", text: row.value }),
    row.note ? el("span", { class: "msg-technical-note", text: row.note }) : null,
  ])));
}

function renderMarkdown(target, source, fileContext = currentFileLinkContext()) {
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
    const technical = technicalTailLine(line);
    if (technical) {
      const rows = [];
      while (index < lines.length) {
        const row = technicalTailLine(lines[index]);
        if (!row) break;
        rows.push(row);
        index += 1;
      }
      target.append(renderTechnicalRows(rows));
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+)$/u);
    if (heading) {
      const node = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(node, heading[2], fileContext);
      target.append(node);
      index += 1;
      continue;
    }
    const table = markdownTableAt(lines, index);
    if (table) {
      target.append(renderMarkdownTable(table, fileContext));
      index = table.nextIndex;
      continue;
    }
    const list = line.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/u);
    if (list) {
      const ordered = Boolean(list[2]);
      const node = document.createElement(ordered ? "ol" : "ul");
      if (ordered && Number(list[2]) !== 1) node.start = Number(list[2]);
      while (index < lines.length) {
        const item = lines[index].match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/u);
        if (!item || Boolean(item[2]) !== ordered) break;
        const entry = el("li");
        appendInlineMarkdown(entry, item[3], fileContext);
        node.append(entry);
        index += 1;
        let nextIndex = index;
        while (nextIndex < lines.length && !lines[nextIndex].trim()) nextIndex += 1;
        const nextItem = lines[nextIndex]?.match(/^\s*(?:([-+*])|(\d+)\.)\s+(.+)$/u);
        if (nextItem && Boolean(nextItem[2]) === ordered) index = nextIndex;
      }
      target.append(node);
      continue;
    }
    if (/^\s*>\s?/u.test(line)) {
      const quote = el("blockquote");
      while (index < lines.length && /^\s*>\s?/u.test(lines[index])) {
        if (quote.childNodes.length) quote.append(document.createElement("br"));
        appendInlineMarkdown(quote, lines[index].replace(/^\s*>\s?/u, ""), fileContext);
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
    const extracted = MessageView.extractTechnicalTails(paragraph.join("\n"));
    if (extracted.text) {
      const node = el("p");
      extracted.text.split("\n").forEach((part, lineIndex) => {
        if (lineIndex) node.append(document.createElement("br"));
        appendInlineMarkdown(node, part, fileContext);
      });
      target.append(node);
    }
    const technicalRows = renderTechnicalRows(extracted.rows);
    if (technicalRows) target.append(technicalRows);
  }
}

function activityDisclosureSummary({ label = "Выполненные действия", count = 0, stage = "" } = {}) {
  const summary = el("summary", {}, [
    window.AgentHubStreamTabs.createPhosphorIcon(document, "caret-right", "activity-disclosure-icon"),
    el("span", { class: "activity-disclosure-label", text: stage ? `${label} · ${stage}` : label }),
    el("span", { class: "activity-disclosure-count", text: `(${Math.max(0, Number(count) || 0)})` }),
  ]);
  return summary;
}

function renderActivityDisclosureSummary(summary, options) {
  const replacement = activityDisclosureSummary(options);
  summary.replaceChildren(...replacement.childNodes);
}

function activityItemNode(activity) {
  return el("div", {
    class: "activity-item",
    "data-type": activity.type ?? "stage",
    "data-status": activity.status ?? "",
  }, [
    el("span", { class: "activity-marker", "aria-hidden": "true" }),
    el("span", { class: "activity-time", text: activity.time
      ? new Date(activity.time).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "" }),
    el("span", { class: "activity-label", text: activity.label ?? "Действие" }),
    el("span", { class: "activity-detail", text: activity.detail ?? "" }),
  ]);
}

function activityFeedNode(activities) {
  const values = Array.isArray(activities) ? activities : [];
  if (!values.length) return null;
  return el("details", { class: "activity-feed" }, [
    activityDisclosureSummary({ count: values.length }),
    el("div", { class: "activity-list" }, values.map(activityItemNode)),
  ]);
}

function visibleTurnTraceGroups(groups) {
  return (Array.isArray(groups) ? groups : []).filter((group) => (
    String(group?.reasoning ?? "").trim() || (group?.activities?.length ?? 0) > 0
  ));
}

function turnTraceGroupsNode(values, { liveStage = "", openGroupIds = [] } = {}) {
  const content = turnTraceContent(values);
  const blocks = content.reasoningBlocks.map((reasoning, index) => {
    const section = el("section", {
      class: "turn-trace-block",
      "data-trace-index": String(index),
    });
    const reasoningNode = el("div", { class: "turn-trace-reasoning" });
    renderMarkdown(reasoningNode, reasoning);
    section.append(reasoningNode);
    return section;
  });
  if (content.activities.length) {
    blocks.push(el("details", {
      class: "turn-trace-activities",
      "data-trace-group-id": TURN_TRACE_ACTIVITY_GROUP_ID,
      open: liveTraceDisclosureOpen({
        groupId: TURN_TRACE_ACTIVITY_GROUP_ID,
        openGroupIds,
      }),
    }, [
      activityDisclosureSummary({ count: content.activities.length, stage: liveStage }),
      el("div", { class: "activity-list" }, content.activities.map(activityItemNode)),
    ]));
  }
  return el("div", { class: "turn-trace-groups" }, blocks);
}

function turnTraceNode(groups) {
  const values = visibleTurnTraceGroups(groups);
  if (!values.length) return null;
  const activityCount = values.reduce((total, group) => total + (group.activities?.length ?? 0), 0);
  const content = turnTraceContent(values);
  const expanded = el("div", { class: "turn-trace-groups" });
  content.reasoningBlocks.forEach((reasoning, index) => {
    const reasoningNode = el("div", { class: "turn-trace-reasoning" });
    renderMarkdown(reasoningNode, reasoning);
    expanded.append(el("section", {
      class: "turn-trace-block",
      "data-trace-index": String(index),
    }, [reasoningNode]));
  });
  if (content.activities.length) {
    expanded.append(el("div", { class: "activity-list" }, content.activities.map(activityItemNode)));
  }
  return el("details", { class: "turn-trace" }, [
    activityDisclosureSummary({ count: activityCount }),
    expanded,
  ]);
}

function messageActionButton({ icon, label, action, onClick }) {
  const button = el("button", {
    type: "button",
    class: "msg-action",
    title: label,
    "aria-label": `${label} сообщение`,
    [`data-message-${action}`]: "",
  }, [
    window.AgentHubStreamTabs.createPhosphorIcon(document, icon, "msg-action-icon"),
    el("span", { text: label }),
  ]);
  button.addEventListener("click", onClick);
  return button;
}

function editUserMessage(message) {
  composerInput.value = String(message?.text ?? "");
  autosizeComposer();
  updateSendState();
  saveDraft();
  composerInput.focus({ preventScroll: true });
  composer.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

function repeatAgentMessage(message) {
  const messages = state.messages.get(state.selectedId) ?? [];
  const index = messages.findIndex((candidate) => (
    candidate === message
    || (message?.id && candidate?.id === message.id)
    || (message?.itemId && candidate?.itemId === message.itemId)
  ));
  const prompt = messages.slice(0, index < 0 ? messages.length : index)
    .reverse()
    .find((candidate) => candidate?.role === "user");
  if (!prompt) return;
  composerInput.value = String(prompt.text ?? "");
  autosizeComposer();
  updateSendState();
  submitComposer();
}

function renderMessageActions(message, role) {
  if (!["user", "agent"].includes(role)) return null;
  const actions = [];
  const request = MessageView.messageCopyRequest(message);
  if (request) actions.push(messageActionButton({
    icon: "copy",
    label: "Копировать",
    action: "copy",
    onClick: () => emit("clipboard:write", request),
  }));
  if (role === "user") actions.push(messageActionButton({
    icon: "pencil-simple",
    label: "Редактировать",
    action: "edit",
    onClick: () => editUserMessage(message),
  }));
  if (role === "agent") actions.push(messageActionButton({
    icon: "arrow-clockwise",
    label: "Повторить",
    action: "repeat",
    onClick: () => repeatAgentMessage(message),
  }));
  return actions.length ? el("div", { class: "msg-actions" }, actions) : null;
}

function renderMessage(message, { readOnly = false, task = currentTask() } = {}) {
  const role = message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
  const maintenance = role === "system" && message.kind === "maintenance";
  const article = el("article", {
    class: `msg msg-${role}${maintenance ? " msg-maintenance" : ""}`,
    "data-role": role,
    "data-message-id": message.id ?? "",
    "data-turn-id": message.turnId ?? "",
    "data-item-id": message.itemId ?? "",
    "data-delivery-state": message.deliveryState ?? "",
    "data-provider": String(task?.provider ?? "none"),
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
  if (!renderResponseAnnotations(body, message)) {
    const text = role === "system"
      ? MessageView.normalizeSystemEventText(message.text ?? "")
      : message.text ?? "";
    renderMarkdown(body, text, currentFileLinkContext(task));
  }

  if (maintenance) article.append(body);
  else article.append(head);
  const trace = turnTraceNode(message.activityGroups);
  const activity = trace ? null : activityFeedNode(message.activities);
  if (trace) article.append(trace);
  else if (activity) article.append(activity);
  const attachmentStrip = Array.isArray(message.attachments) && message.attachments.length > 0
    ? renderAttachmentStrip(message.attachments, { readOnly: true })
    : null;
  if (!maintenance && role === "user") {
    article.append(el("div", { class: "msg-user-bubble" }, [body, attachmentStrip]));
  } else if (!maintenance) {
    article.append(body);
    if (attachmentStrip) article.append(attachmentStrip);
  }
  const actions = readOnly ? null : renderMessageActions(message, role);
  if (!actions) return article;
  return el("div", { class: `msg-stack msg-stack-${role}` }, [article, actions]);
}

document.addEventListener("click", (event) => {
  const link = event.target.closest("a[data-agent-hub-local-link]");
  if (!link) return;
  event.preventDefault();
  openResourceContextMenu(event, resourceInteractions.linkResource({
    href: link.href,
    localPath: link.dataset.agentHubLocalLink,
    name: link.textContent,
  }));
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
  const phase = String(live?.responsePhase ?? "");
  if (
    live?.provider === "codex"
    && visibleTurnTraceGroups(live?.activityGroups).length
    && !["final", "final_answer", "finalAnswer"].includes(phase)
  ) return "";
  return normalizedMessageText(live?.text);
}

function liveCardHasContent(live) {
  return Boolean(live && (
    liveTextAfterMessages(live)
    || normalizedMessageText(live.reasoning)
    || normalizedMessageText(live.stage)
    || visibleTurnTraceGroups(live.activityGroups).length
  ));
}

function populateLiveCard(node, live, fallbackAuthor = "Агент", task = currentTask()) {
  if (!node || !liveCardHasContent(live)) return false;
  const visibleText = liveTextAfterMessages(live);
  node.querySelector("[data-live-author]").textContent = live.author || fallbackAuthor;
  const liveStage = liveStageParts(live.stage);
  const stageNode = node.querySelector("[data-live-stage]");
  stageNode.textContent = liveStage.status;
  stageNode.hidden = !liveStage.status;
  const groups = visibleTurnTraceGroups(live.activityGroups);
  const stageDetail = node.querySelector("[data-live-stage-detail]");
  const standaloneStageDetail = standaloneLiveStageDetail({ stage: live.stage, traceGroups: groups });
  stageDetail.textContent = standaloneStageDetail;
  stageDetail.hidden = !standaloneStageDetail;
  const reasoning = node.querySelector("[data-live-reasoning]");
  const standaloneReasoning = groups.length ? "" : live.reasoning || "";
  const fileContext = currentFileLinkContext(task);
  renderMarkdown(reasoning, standaloneReasoning, fileContext);
  reasoning.hidden = !standaloneReasoning;
  const liveTrace = node.querySelector("[data-live-trace]");
  const openGroupIds = new Set(Array.from(
    liveTrace.querySelectorAll("details[data-trace-group-id][open]"),
    (details) => details.dataset.traceGroupId,
  ));
  liveTrace.replaceChildren(...(groups.length ? [turnTraceGroupsNode(groups, {
    liveStage: liveStage.detail,
    openGroupIds,
  })] : []));
  liveTrace.hidden = groups.length === 0;
  const body = node.querySelector("[data-live-body]");
  renderMarkdown(body, visibleText, fileContext);
  body.hidden = !visibleText;
  const activityFeed = node.querySelector("[data-activity-feed]");
  const activities = Array.isArray(live.activities) ? live.activities : [];
  const activityFeedVisible = groups.length === 0 && activities.length > 0;
  activityFeed.open = liveActivityDisclosureOpen({
    open: activityFeed.open,
    wasHidden: activityFeed.hidden,
    visible: activityFeedVisible,
  });
  activityFeed.hidden = !activityFeedVisible;
  renderActivityDisclosureSummary(node.querySelector("[data-activity-summary]"), {
    label: "Выполненные действия",
    count: activities.length,
    stage: liveStage.detail,
  });
  node.querySelector("[data-activity-list]").replaceChildren(...activities.map(activityItemNode));
  return true;
}

function renderLive() {
  // Решение о прилипающей прокрутке принимаем до изменения высоты live-блока.
  // Иначе большой очередной фрагмент уже отодвинет низ дальше порога.
  const scrollController = chatScrollControllers.get(chatScroll);
  const scrollSnapshot = scrollController?.capture();
  const stickToBottom = scrollSnapshot?.pinned || chatIsNearBottom();
  const live = state.live.get(state.selectedId);
  if (!liveCardHasContent(live)) {
    chatLive.hidden = true;
    if (stickToBottom) pinChatToBottom();
    else window.requestAnimationFrame(() => scrollController?.afterMutation(scrollSnapshot, { preserveDistance: true }));
    scheduleUnderfilledHistoryLoad();
    return;
  }
  chatLive.hidden = false;
  populateLiveCard(chatLive, live);
  if (stickToBottom) pinChatToBottom();
  else window.requestAnimationFrame(() => scrollController?.afterMutation(scrollSnapshot, { preserveDistance: true }));
  scheduleUnderfilledHistoryLoad();
}

/* =================================================== подтверждения / очередь */

function renderApprovals() {
  const approvals = state.approvals.get(state.selectedId) ?? [];
  approvalsBox.replaceChildren();
  approvalsBox.hidden = approvals.length === 0;
  for (const approval of approvals) {
    const questions = Array.isArray(approval.questions) ? approval.questions : [];
    const options = Array.isArray(approval.options) && approval.options.length > 0
      ? approval.options
      : [{ id: "approve", label: "Разрешить", kind: "primary" }, { id: "deny", label: "Отклонить" }];
    const questionFields = questions.map((question, index) => {
      const questionId = String(question.id ?? `question-${index}`);
      const choices = Array.isArray(question.options) ? question.options : [];
      const field = el("fieldset", {
        class: "approval-question",
        "data-approval-question": questionId,
        "data-question-kind": choices.length ? "options" : "text",
      }, [
        el("legend", { text: question.header || `Вопрос ${index + 1}` }),
        el("div", { class: "approval-question-text", text: question.question || "" }),
      ]);
      if (choices.length) {
        field.append(...choices.map((choice, choiceIndex) => el("label", { class: "approval-choice" }, [
          el("input", {
            type: "radio",
            name: `approval-${approval.id}-${questionId}`,
            value: choice.label,
            checked: choiceIndex === 0,
          }),
          el("span", {}, [
            el("strong", { text: choice.label }),
            choice.description ? el("small", { text: choice.description }) : null,
          ]),
        ])));
      }
      if (!choices.length || question.isOther) {
        field.append(el("input", {
          class: "approval-input",
          type: question.isSecret ? "password" : "text",
          "data-approval-other": "",
          placeholder: choices.length ? "Другой ответ" : "Ваш ответ",
          autocomplete: question.isSecret ? "off" : "on",
        }));
      }
      return field;
    });
    approvalsBox.append(el("div", { class: "approval", "data-approval-id": approval.id }, [
      el("div", { class: "approval-head" }, [
        el("span", { class: "approval-kind", text: approval.kind || "Подтверждение" }),
      ]),
      el("div", { class: "approval-text", text: approval.text || "" }),
      ...questionFields,
      el("div", { class: "approval-actions" }, options.map((option) =>
        el("button", {
          type: "button",
          class: `chip-button ${option.kind === "primary" ? "primary" : option.kind === "danger" ? "danger" : ""}`,
          "data-action": "approval-respond",
          "data-approval-id": approval.id,
          "data-decision": option.id,
          text: option.label,
        })).concat(questions.length ? [el("button", {
          type: "button",
          class: "chip-button primary",
          "data-action": "approval-submit",
          "data-approval-id": approval.id,
          text: "Ответить",
        })] : [])),
    ]));
  }
}

function renderQueueForTask(taskId, container) {
  const queued = (state.queue.get(taskId) ?? [])
    .filter((entry) => entry.state !== "dispatching" && entry.state !== "steering")
    .slice()
    .sort((left, right) => {
      const leftOrder = Number(left.queueOrder);
      const rightOrder = Number(right.queueOrder);
      if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) {
        return leftOrder - rightOrder;
      }
      const leftAt = Date.parse(left.createdAt || 0);
      const rightAt = Date.parse(right.createdAt || 0);
      return (Number.isFinite(leftAt) ? leftAt : Number.POSITIVE_INFINITY)
        - (Number.isFinite(rightAt) ? rightAt : Number.POSITIVE_INFINITY);
    });
  container.replaceChildren();
  container.hidden = queued.length === 0;
  if (queued.length === 0) return;
  const pendingCount = queued.filter((entry) => entry.state === "pending").length;
  const pausedCount = queued.filter((entry) => entry.state === "paused").length;
  const queuedCount = queued.length - pendingCount - pausedCount;
  const counts = [
    pendingCount ? `Требуют решения: ${pendingCount}` : "",
    queuedCount ? `В очереди: ${queuedCount}` : "",
    pausedCount ? `На паузе: ${pausedCount}` : "",
  ].filter(Boolean).join(" · ");
  container.append(el("div", { class: "queue-head", text: counts }));
  const task = state.tasks.find((entry) => entry.id === taskId);
  for (const entry of queued) {
    const actions = [];
    if (entry.optimistic) {
      actions.push(el("span", { class: "queue-optimistic", text: "В очереди" }));
    } else {
      const steerAvailable = Boolean(task?.running && task?.provider === "codex");
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
      if (["queued", "paused"].includes(entry.state)) {
        if (entry.waitReason === "provider-thread-active") {
          actions.push(el("button", {
            type: "button",
            class: "queue-new",
            "data-action": "queue-new",
            "data-queue-id": entry.id,
            title: "Создать новую задачу и отправить сообщение туда",
            text: "В новую задачу",
          }));
        }
        actions.push(el("button", {
          type: "button",
          class: "queue-pause",
          "data-action": entry.state === "paused" ? "queue-resume" : "queue-pause",
          "data-queue-id": entry.id,
          text: entry.state === "paused"
            ? entry.waitReason === "provider-thread-active" ? "Проверить снова" : "Продолжить"
            : "Пауза",
        }));
      }
      if (entry.state === "pending") {
        actions.push(el("button", {
          type: "button",
          class: "queue-accept",
          "data-action": entry.lastError ? "queue-retry" : "queue-accept",
          "data-queue-id": entry.id,
          title: "Отправить после завершения текущего хода",
          text: entry.lastError ? "Повторить" : "После хода",
        }));
      }
      actions.push(el("button", {
        type: "button", class: "queue-remove", "data-action": "queue-remove", "data-queue-id": entry.id,
        title: "Убрать отложенное сообщение", "aria-label": "Убрать отложенное сообщение", text: "×",
      }));
    }
    const entryAnnotations = Array.isArray(entry.annotations) ? entry.annotations : [];
    const rawText = String(entry.text || entry.summary || "").trim();
    const rawPreview = String(entry.preview || "").trim();
    const annotationEnvelope = /(?:^#\s*Response annotations:|<response-annotations>)/iu;
    const visibleText = rawText && !(entryAnnotations.length && annotationEnvelope.test(rawText))
      ? rawText
      : (!entryAnnotations.length && rawPreview ? rawPreview : "");
    const content = el("div", { class: "queue-content" }, [
      entry.author ? el("strong", { class: "queue-author", text: entry.author }) : null,
      visibleText ? el("div", { class: "queue-text", text: visibleText }) : null,
      entry.waitReason === "provider-thread-active"
        ? el("div", { class: "queue-status", text: "Thread удерживается другим Codex. Автоповторы остановлены; проверьте снова после закрытия задачи или отправьте сообщение в новую." })
        : entry.waitReason === "provider-temporarily-unavailable"
          ? el("div", { class: "queue-status", text: "Связь с Codex временно недоступна; сообщение сохранено и будет отправлено автоматически." })
          : null,
      entry.lastError ? el("div", { class: "queue-error", text: entry.lastError }) : null,
      entryAnnotations.length
        ? el("div", { class: "queue-annotation-list" }, entryAnnotations.map((annotation, index) => {
          const quote = String(annotation?.text ?? "").trim();
          const comment = String(annotation?.annotation ?? "").trim();
          return el("div", { class: "queue-annotation" }, [
            el("span", { class: "queue-annotation-label", text: `Цитата ${index + 1}` }),
            quote ? el("span", { class: "queue-annotation-quote", text: quote }) : null,
            comment ? el("span", { class: "queue-annotation-comment", text: comment }) : null,
          ]);
        }))
        : null,
      !visibleText && !entryAnnotations.length
        ? el("div", { class: "queue-text", text: "Сообщение" })
        : null,
    ]);
    container.append(el("div", { class: "queue-item", "data-queue-id": entry.id }, [
      content,
      Array.isArray(entry.attachments) && entry.attachments.length
        ? renderAttachmentStrip(entry.attachments, { readOnly: true })
        : null,
      el("span", { class: "queue-actions" }, actions),
    ]));
  }
}

function renderQueue() {
  renderQueueForTask(state.selectedId, queueBox);
  window.requestAnimationFrame(() => syncChatScrollDownButton(chatScroll, chatScrollDown));
}

/* ============================================================== композер */

const slashCommands = [
  { command: "/new", label: "Новая задача", action: "task-new" },
  { command: "/tasks", label: "Открыть список задач", run: () => setPane("tasks") },
  { command: "/search", label: "Поиск по сообщениям Workspace", run: openWorkspaceMessageSearch },
  { command: "/model", label: "Выбрать модель", run: openDialogSettings },
  { command: "/reasoning", label: "Настроить reasoning", run: openDialogSettings },
  { command: "/mode", label: "Выбрать режим", run: openDialogSettings },
  { command: "/rename", label: "Переименовать Workspace", action: "task-rename" },
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
  submitComposer({ steerWhileRunning: event.ctrlKey || event.metaKey });
});

slashMenu.addEventListener("click", (event) => {
  const command = event.target.closest("[data-slash-command]")?.dataset.slashCommand;
  if (command) runSlashCommand(command);
});

composer.addEventListener("submit", (event) => {
  event.preventDefault();
  submitComposer();
});

function submitComposer({ steerWhileRunning = false } = {}) {
  if (!state.selectedId || pendingComposerRequest) return;
  const task = currentTask();
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
    followUpMode: MessageView.composerFollowUpMode(task, { steerWhileRunning }),
    deferWhileRunning: task?.running === true && !steerWhileRunning,
    draftStream: task?.draftStream === true,
    streamId: task?.streamId ?? null,
    settings: task?.draftStream ? { ...task.streamSettings } : null,
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
  const gallery = resourceInteractions.imageGallery(items);
  items.forEach((item, index) => {
    const source = item.dataUrl || item.url || "";
    const image = resourceInteractions.isImageAttachment(item);
    const missing = readOnly && (item.missing || (!source && !item.id));
    const thumb = el(readOnly ? "button" : "div", {
      class: `attachment${image ? " attachment-image" : " attachment-file"}${!missing && (readOnly || image) ? " attachment-open" : ""}${missing ? " attachment-missing" : ""}`,
      title: readOnly
        ? (missing ? "Файл недоступен" : (image ? "Открыть изображение" : `Скачать ${item.name || "файл"}`))
        : item.name || "",
      ...(readOnly ? {
        type: "button",
        disabled: missing,
        "aria-label": missing
          ? `${item.name || "Файл"} недоступен`
          : `${image ? "Открыть" : "Скачать"} ${item.name || "вложение"}`,
      } : {}),
    }, missing
      ? [el("span", { class: "attachment-missing-label", text: "Файл недоступен" })]
      : image && source
        ? [el("img", { src: source, alt: item.name || "вложение", loading: "lazy" })]
        : image
          ? [el("span", { class: "attachment-load-label", text: "Открыть" })]
          : [el("span", { class: "attachment-file-card" }, [
            el("span", {
              class: "attachment-file-type",
              text: String(item.name ?? "").split(".").at(-1)?.slice(0, 5).toUpperCase() || "FILE",
            }),
            el("span", { class: "attachment-file-name", text: item.name || "Вложение" }),
            Number(item.size) > 0
              ? el("span", { class: "attachment-file-size", text: formatAttachmentSize(item.size) })
              : null,
          ])]);
    if (readOnly && !missing) {
      thumb.addEventListener("click", () => emit("attachment:open", {
        attachment: item,
        gallery,
        index: image ? gallery.indexOf(item) : index,
      }));
      if (!image) thumb.__agentHubResource = { kind: "attachment", attachment: item };
    } else if (image && !missing) {
      thumb.addEventListener("click", (event) => {
        if (event.target.closest("[data-attachment-index]")) return;
        openAttachmentViewer({ gallery, index: gallery.indexOf(item) });
      });
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

function formatAttachmentSize(value) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} Б`;
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} МБ`;
}

attachmentsBox.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-attachment-index]");
  if (!remove) return;
  const index = Number(remove.dataset.attachmentIndex);
  setAttachments(attachments.filter((_, i) => i !== index));
  saveDraft();
});

async function readAttachmentFiles(files) {
  const selected = [...files].filter((file) => file && file.size > 0);
  if (selected.length === 0) return;
  const limit = 8;
  const room = Math.max(0, limit - attachments.length);
  const accepted = selected.slice(0, room).filter((file) => file.size <= 20 * 1024 * 1024);
  const oversized = selected.slice(0, room).length - accepted.length;
  const loaded = await Promise.all(accepted.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
      dataUrl: String(reader.result),
    });
    reader.onerror = () => reject(new Error(`Не удалось прочитать файл «${file.name}»`));
    reader.readAsDataURL(file);
  }))).catch((error) => {
    showToast(error.message);
    return [];
  });
  if (loaded.length) {
    setAttachments([...attachments, ...loaded].slice(0, limit));
    saveDraft();
  }
  if (selected.length > room) showToast(`Можно приложить не больше ${limit} файлов.`);
  else if (oversized) showToast("Размер одного файла не должен превышать 20 МБ.");
}

document.querySelector("[data-action='attach']").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => {
  void readAttachmentFiles(fileInput.files);
  fileInput.value = "";
});

function clipboardAttachmentFiles(clipboardData) {
  const itemFiles = [...(clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter(Boolean);
  // Chromium часто представляет один и тот же файл одновременно в items и
  // files. Второй список — резервный источник, а не ещё одна пачка вложений.
  const values = itemFiles.length > 0 ? itemFiles : [...(clipboardData?.files ?? [])];
  const known = new Set();
  return values.filter((file) => {
    const key = `${file.name}\0${file.size}\0${file.lastModified}\0${file.type}`;
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
}

const PASTED_TEXT_ATTACHMENT_THRESHOLD = 8_000;

function pastedTextLooksTabular(text, html = "") {
  if (/<table\b/iu.test(String(html ?? ""))) return true;
  const rows = String(text ?? "").split(/\r?\n/u).filter((row) => row.trim());
  if (rows.length >= 2) {
    const tabbedRows = rows.filter((row) => row.includes("\t"));
    if (tabbedRows.length >= Math.min(rows.length, 3)) return true;
  }
  return rows.some((row, index) => (
    index > 0
    && rows[index - 1].includes("|")
    && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(row)
  ));
}

function pastedTextShouldBeAttachment(text, html = "", currentLength = 0) {
  const source = String(text ?? "");
  if (!source) return false;
  return source.length >= PASTED_TEXT_ATTACHMENT_THRESHOLD
    || Math.max(0, Number(currentLength) || 0) + source.length > DRAFT_STORAGE_MAX_TEXT
    || pastedTextLooksTabular(source, html);
}

function pastedTextFile(text) {
  return new File([String(text ?? "")], "Вставленный текст.txt", {
    type: "text/plain",
    lastModified: Date.now(),
  });
}

composerInput.addEventListener("paste", (event) => {
  const files = clipboardAttachmentFiles(event.clipboardData);
  if (files.length > 0) {
    event.preventDefault();
    void readAttachmentFiles(files);
    return;
  }
  const text = String(event.clipboardData?.getData("text/plain") ?? "");
  const html = String(event.clipboardData?.getData("text/html") ?? "");
  if (!pastedTextShouldBeAttachment(text, html, composerInput.value.length)) return;
  event.preventDefault();
  void readAttachmentFiles([pastedTextFile(text)]);
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
    void readAttachmentFiles(event.dataTransfer.files);
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
  const text = selection?.toString() || "";
  if (!text.trim() || selection.rangeCount === 0) return "";
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
  const chatRect = event.target.closest?.("[data-chat]")?.getBoundingClientRect();
  const minLeft = Math.max(8, chatRect?.left ?? 8);
  const viewportMaxLeft = window.innerWidth - menuRect.width - 8;
  const chatMaxLeft = (chatRect?.right ?? window.innerWidth) - menuRect.width - 8;
  const maxLeft = Math.max(minLeft, Math.min(viewportMaxLeft, chatMaxLeft));
  const maxTop = Math.max(8, window.innerHeight - menuRect.height - 8);
  annotationContextMenu.style.left = `${Math.min(Math.max(minLeft, event.clientX), maxLeft)}px`;
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
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!["copy-selection", "annotate-selection"].includes(action)) return;
  const quote = pendingAnnotationQuote;
  closeAnnotationContextMenu();
  if (action === "annotate-selection") addAnnotation(quote);
  else emit("clipboard:write", { text: quote });
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

let pendingResource = null;

function closeResourceContextMenu() {
  pendingResource = null;
  resourceContextMenu.hidden = true;
}

function openResourceContextMenu(event, resource) {
  pendingResource = resource;
  const actions = new Set(resourceInteractions.resourceActions(resource, {
    canCopyLocalObject: localWorkspaceFilesAvailable,
  }));
  for (const button of resourceContextMenu.querySelectorAll("[data-resource-action]")) {
    button.hidden = !actions.has(button.dataset.resourceAction);
  }
  resourceContextMenu.hidden = false;
  const rect = resourceContextMenu.getBoundingClientRect();
  resourceContextMenu.style.left = `${Math.max(8, Math.min(event.clientX, window.innerWidth - rect.width - 8))}px`;
  resourceContextMenu.style.top = `${Math.max(8, Math.min(event.clientY, window.innerHeight - rect.height - 8))}px`;
  resourceContextMenu.querySelector("button:not([hidden])")?.focus({ preventScroll: true });
}

document.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented) return;
  const attachment = event.target.closest?.(".attachment-file, .board-task-attachment")?.__agentHubResource;
  const link = event.target.closest?.("a[href]");
  const resource = attachment ?? (link ? resourceInteractions.linkResource({
    href: link.href,
    localPath: link.dataset.agentHubLocalLink,
    name: link.textContent,
  }) : null);
  if (!resource) {
    closeResourceContextMenu();
    return;
  }
  event.preventDefault();
  closeAnnotationContextMenu();
  openResourceContextMenu(event, resource);
});

resourceContextMenu.addEventListener("click", (event) => {
  const button = event.target.closest("[data-resource-action]");
  if (!button || !pendingResource) return;
  const resource = pendingResource;
  const action = button.dataset.resourceAction;
  closeResourceContextMenu();
  emit(`resource:${action}`, { resource });
});

document.addEventListener("pointerdown", (event) => {
  if (!resourceContextMenu.hidden && !resourceContextMenu.contains(event.target)) closeResourceContextMenu();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeResourceContextMenu();
});
window.addEventListener("scroll", closeResourceContextMenu, true);

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
  const draftsPersisted = persistDrafts();
  const modalOpen = Boolean(
    document.querySelector("dialog[open], [role='dialog']:not([hidden])")
    || dialogSettings?.hidden === false,
  );
  if (window.AgentHubRuntimeReload.runtimeReloadBlocked({
    draftsPersisted,
    drafts: drafts.values(),
    modalOpen,
    requestPending: Boolean(pendingComposerRequest),
    bugReportAttachments,
    bugReportSending,
  })) return false;
  return true;
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
  const task = currentTask();
  if (!open && task?.draftStream) {
    emit("stream:settings-save", { streamId: task.streamId, settings: { ...task.streamSettings } });
  }
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
  if (limitsState.status === "idle") requestLimits(limitsState.range);
  emit("devices:refresh");
  requestAnimationFrame(() => {
    settingsPanel.classList.add("open");
    panelScrim.classList.add("open");
  });
}

let bugReportAttachments = [];
let bugReportSending = false;

function setBugReportStatus(message = "", state = "") {
  if (!bugReportStatus) return;
  bugReportStatus.textContent = message;
  if (state) bugReportStatus.dataset.state = state;
  else delete bugReportStatus.dataset.state;
}

function setBugReportSending(value) {
  bugReportSending = Boolean(value);
  if (bugReportToggle) bugReportToggle.disabled = bugReportSending;
  if (bugReportSubmit) bugReportSubmit.disabled = bugReportSending;
  if (bugReportAttach) bugReportAttach.disabled = bugReportSending;
  if (bugReportText) bugReportText.disabled = bugReportSending;
  if (bugReportSubmit) bugReportSubmit.textContent = bugReportSending ? "Отправляем…" : "Отправить отчёт";
}

function renderBugReportAttachments() {
  if (!bugReportScreenshots) return;
  bugReportScreenshots.hidden = bugReportAttachments.length === 0;
  bugReportScreenshots.replaceChildren(...bugReportAttachments.map((item, index) => {
    const card = el("div", { class: "bug-report-screenshot attachment-open" }, [
      el("img", { src: item.dataUrl, alt: item.name || `Скриншот ${index + 1}` }),
      el("span", { text: item.name || `Скриншот ${index + 1}` }),
      el("button", {
        type: "button",
        class: "attachment-remove",
        "data-bug-report-remove": index,
        title: "Удалить скриншот",
        "aria-label": `Удалить ${item.name || `скриншот ${index + 1}`}`,
        text: "×",
      }),
    ]);
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-bug-report-remove]")) return;
      openAttachmentViewer({ gallery: bugReportAttachments, index });
    });
    return card;
  }));
}

async function readBugReportFiles(files) {
  const selected = [...(files ?? [])].filter((file) => file && file.size > 0);
  const room = Math.max(0, 8 - bugReportAttachments.length);
  const supported = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/bmp"]);
  const accepted = selected.slice(0, room).filter((file) => (
    supported.has(String(file.type).toLowerCase()) && file.size <= 20 * 1024 * 1024
  ));
  const loaded = await Promise.all(accepted.map((file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      name: file.name,
      type: file.type,
      size: file.size,
      dataUrl: String(reader.result),
    });
    reader.onerror = () => reject(new Error(`Не удалось прочитать файл «${file.name}»`));
    reader.readAsDataURL(file);
  }))).catch((error) => {
    setBugReportStatus(error.message, "error");
    return [];
  });
  bugReportAttachments = [...bugReportAttachments, ...loaded].slice(0, 8);
  renderBugReportAttachments();
  if (selected.length > room) setBugReportStatus("Можно приложить не больше восьми скриншотов.", "error");
  else if (accepted.length !== selected.length) {
    setBugReportStatus("Поддерживаются изображения до 20 МБ: PNG, JPEG, WebP, GIF или BMP.", "error");
  } else if (loaded.length) setBugReportStatus();
}

bugReportToggle?.addEventListener("click", () => {
  const visible = bugReportForm?.hidden !== false;
  if (bugReportForm) bugReportForm.hidden = !visible;
  bugReportToggle.setAttribute("aria-expanded", String(visible));
  if (visible) bugReportText?.focus();
});
document.addEventListener("contextmenu", (event) => {
  if (event.defaultPrevented) return;
  const workspace = event.target.closest("[data-workspace-heading], [data-board-workspace-id]");
  if (!workspace) return;
  event.preventDefault();
  const workspaceId = String(workspace.dataset.workspaceHeading ?? workspace.dataset.boardWorkspaceId ?? "");
  openWorkspaceContextMenu(event, workspaceId);
});
workspaceCardForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!updateAgentRulesLimit(workspaceCardRules, workspaceCardRulesCount)) {
    workspaceCardRules.reportValidity();
    return;
  }
  const name = workspaceCardName.value.trim();
  if (!name) return workspaceCardName.focus();
  const order = dashboardColumnOrder();
  const requestedOrder = Math.round(Number(workspaceCardOrder.value));
  if (workspaceCardMode === "create") {
    const targetIndex = Math.max(0, Math.min(order.length, requestedOrder - 1));
    emit("workspace:create", {
      name,
      comment: workspaceCardComment.value.trim(),
      workingDirectory: workspaceCardWorkingDirectory.value.trim(),
      rules: workspaceCardRules.value,
      beforeColumnId: order[targetIndex] ?? null,
    });
    closeWorkspaceCard();
    return;
  }
  const workspace = workspaceCatalogItem(workspaceCardId);
  if (!workspace) return closeWorkspaceCard();
  const columnId = `workspace:${workspace.id}`;
  const remaining = order.filter((id) => id !== columnId);
  const targetIndex = Math.max(0, Math.min(remaining.length, requestedOrder - 1));
  emit("workspace:update", {
    workspaceId: workspace.id,
    name,
    comment: workspaceCardComment.value.trim(),
    workingDirectory: workspaceCardWorkingDirectory.value.trim(),
    rules: workspaceCardRules.value,
    beforeColumnId: remaining[targetIndex] ?? null,
  });
  closeWorkspaceCard();
});
workspaceCardRules?.addEventListener("input", () => {
  updateAgentRulesLimit(workspaceCardRules, workspaceCardRulesCount);
});
workspaceReleaseList?.addEventListener("change", (event) => {
  const select = event.target.closest("[data-release-change-status]");
  if (!select || !workspaceCardId) return;
  emit("workspace-release:status", {
    workspaceId: workspaceCardId,
    changeId: String(select.dataset.releaseChangeStatus ?? ""),
    status: String(select.value ?? "draft"),
  });
});
document.querySelector("[data-workspace-card-close]")?.addEventListener("click", closeWorkspaceCard);
document.querySelector("[data-workspace-card-cancel]")?.addEventListener("click", closeWorkspaceCard);
workspaceCardModal?.addEventListener("click", (event) => {
  if (event.target === workspaceCardModal) closeWorkspaceCard();
});
workspaceCardModal?.addEventListener("close", () => {
  workspaceCardId = "";
  workspaceCardMode = "edit";
});
bugReportAttach?.addEventListener("click", () => bugReportFiles?.click());
bugReportFiles?.addEventListener("change", () => {
  void readBugReportFiles(bugReportFiles.files);
  bugReportFiles.value = "";
});
document.addEventListener("paste", (event) => {
  if (bugReportForm?.hidden !== false || bugReportSending) return;
  const screenshots = [...(event.clipboardData?.items ?? [])]
    .filter((item) => item.kind === "file" && String(item.type).toLowerCase().startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter(Boolean);
  if (screenshots.length === 0) return;
  event.preventDefault();
  void readBugReportFiles(screenshots);
});
bugReportScreenshots?.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-bug-report-remove]");
  if (!remove || bugReportSending) return;
  bugReportAttachments.splice(Number(remove.dataset.bugReportRemove), 1);
  renderBugReportAttachments();
});
bugReportForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = String(bugReportText?.value ?? "").trim();
  if (!text && bugReportAttachments.length === 0) {
    setBugReportStatus("Введите описание бага или приложите скриншот.", "error");
    return;
  }
  setBugReportSending(true);
  setBugReportStatus("Создаём отчёт и отправляем его в Git…", "pending");
  if (bugReportForm) bugReportForm.hidden = true;
  bugReportToggle?.setAttribute("aria-expanded", "false");
  emit("bug-report:submit", {
    text,
    attachments: bugReportAttachments.slice(),
    reportId: crypto.randomUUID(),
  });
});

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

/* Сопряжение выпускает учётные данные, поэтому доступно только на самом
 * компьютере с Agent Hub: локальный Web и панель VS Code. Удалённые поверхности
 * видят список и могут отозвать устройство, но не добавить новое. */
const deviceEnrollmentAllowed = !telegramMode
  && !window.AgentHubAndroid
  && !window.AgentHubBrowserDevice;

function renderTrustedDevices(payload = {}) {
  if (!trustedDeviceList || !trustedDevicePairing) return;
  if (trustedDeviceCreate) {
    trustedDeviceCreate.hidden = !deviceEnrollmentAllowed;
    trustedDeviceCreate.title = deviceEnrollmentAllowed
      ? ""
      : "Новое устройство добавляется только на компьютере с Agent Hub";
  }
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
  renderTurnTimeModeOptions();
  renderComparisonViewModeOptions();
  for (const toggle of document.querySelectorAll("[data-toggle]")) {
    toggle.checked = Boolean(state.selection[toggle.dataset.toggle]);
  }
}

function renderTurnTimeModeOptions() {
  for (const button of turnTimeModeButtons) {
    const active = button.dataset.turnTimeMode === turnTimeMode;
    button.setAttribute("aria-pressed", String(active));
    button.toggleAttribute("data-active", active);
  }
}

function selectTurnTimeMode(value) {
  const next = normalizeTurnTimeMode(value);
  if (next === turnTimeMode) return;
  turnTimeMode = next;
  try {
    localStorage.setItem(TURN_TIME_MODE_KEY, turnTimeMode);
  } catch {
    // Выбор останется активным до закрытия WebView.
  }
  usageState.payload = null;
  comparisonState.payload = null;
  renderTurnTimeModeOptions();
  if (root.dataset.view === "statistics") {
    requestUsageHistory(usageState.range, { force: true });
    requestUsageComparison(comparisonState.range, { force: true });
  }
}

function renderDialogSettings() {
  const task = currentTask();
  const selection = task?.draftStream ? task.streamSettings : state.selection;
  const effectiveProvider = task?.draftStream ? selection?.provider : task?.provider;
  const optionGroups = {
    provider: task?.draftStream
      ? state.options.provider
      : [{ value: task?.provider ?? "", label: task?.agentLabel || providerLabels[task?.provider] || "—" }],
    model: state.options.modelOptionsByProvider?.[effectiveProvider] ?? state.options.model,
    reasoning: state.options.reasoningOptionsByProvider?.[effectiveProvider]
      ?? state.options.reasoning,
    mode: state.options.mode,
  };
  for (const [group, values] of Object.entries(optionGroups)) {
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
      const active = selection?.[group] === value;
      container.append(el("button", {
        type: "button",
        class: "option-chip",
        "data-select-group": group,
        "data-select-value": value,
        "aria-pressed": String(active),
        "data-active": active ? "" : null,
        disabled: group === "provider" && !task?.draftStream,
        text: label,
      }));
    }
  }
  for (const toggle of dialogSettings.querySelectorAll("[data-dialog-toggle]")) {
    const key = toggle.dataset.dialogToggle;
    toggle.checked = Boolean(selection?.[key]);
  }
  if (dialogWorkingDirectory) {
    const workspaceDirectory = String(task?.workspaceSettings?.workingDirectory ?? "").trim();
    const currentDirectory = String(task?.sessionCwd ?? task?.projectRoot ?? "").trim();
    dialogWorkingDirectory.value = String(task?.streamSettings?.workingDirectory ?? "").trim();
    dialogWorkingDirectory.disabled = !task?.streamId;
    dialogWorkingDirectory.placeholder = workspaceDirectory
      ? `Workspace: ${workspaceDirectory}`
      : currentDirectory ? `Текущая: ${currentDirectory}` : "Наследуется от Workspace";
    if (dialogWorkingDirectoryNote) {
      dialogWorkingDirectoryNote.textContent = task?.draftStream
        ? "Будет использована при создании Thread; пустое значение наследуется от Workspace."
        : "Применится при создании следующего Thread; текущий Thread сохраняет свою директорию.";
    }
  }
  renderStreamRulesPreview();
}

dialogSettings.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-select-group]");
  if (!chip) return;
  const group = chip.dataset.selectGroup;
  const value = chip.dataset.selectValue;
  const task = currentTask();
  if (task?.draftStream) {
    task.streamSettings[group] = value;
    if (group === "provider") {
      task.provider = value;
      task.agentLabel = providerLabels[value] ?? value;
      const models = state.options.modelOptionsByProvider?.[value] ?? [];
      if (!models.some((option) => option.value === task.streamSettings.model)) {
        task.streamSettings.model = models[0]?.value ?? "";
      }
      const efforts = state.options.reasoningOptionsByProvider?.[value] ?? [];
      if (!efforts.some((option) => option.value === task.streamSettings.reasoning)) {
        task.streamSettings.reasoning = efforts[0]?.value ?? "";
      }
    }
    emit("stream:settings-save", { streamId: task.streamId, settings: { ...task.streamSettings } });
  } else {
    state.selection[group] = value;
    emit("selection:set", { key: group, value });
  }
  renderOptions();
});

dialogSettings.addEventListener("change", (event) => {
  const directory = event.target.closest("[data-dialog-working-directory]");
  if (directory) {
    const task = currentTask();
    if (!task?.streamId) return;
    task.streamSettings = {
      ...(task.streamSettings ?? {}),
      workingDirectory: directory.value.trim(),
    };
    emit("stream:settings-save", { streamId: task.streamId, settings: { ...task.streamSettings } });
    renderOptions();
    return;
  }
  const toggle = event.target.closest("[data-dialog-toggle]");
  if (!toggle) return;
  const key = toggle.dataset.dialogToggle;
  const task = currentTask();
  if (task?.draftStream) {
    task.streamSettings[key] = toggle.checked;
    emit("stream:settings-save", { streamId: task.streamId, settings: { ...task.streamSettings } });
  } else {
    state.selection[key] = toggle.checked;
    emit("selection:set", { key, value: toggle.checked });
  }
});

dialogStreamRules?.addEventListener("input", () => {
  const task = currentTask();
  const streamId = String(task?.streamId ?? "");
  if (!streamId) return;
  streamRulesDrafts.set(streamId, { value: dialogStreamRules.value });
  renderStreamRulesPreview();
});

dialogStreamRulesSave?.addEventListener("click", () => {
  const task = currentTask();
  const streamId = String(task?.streamId ?? "");
  if (!streamId || !updateAgentRulesLimit(dialogStreamRules, dialogStreamRulesCount)) {
    dialogStreamRules?.reportValidity();
    return;
  }
  const rules = dialogStreamRules.value;
  task.streamRules = rules;
  task.streamDeveloperRules = rules;
  streamRulesDrafts.delete(streamId);
  renderStreamRulesPreview();
  emit("stream:rules-save", { streamId, rules });
});

document.addEventListener("change", (event) => {
  const toggle = event.target.closest("[data-toggle]");
  if (!toggle) return;
  const key = toggle.dataset.toggle;
  state.selection[key] = toggle.checked;
  emit("selection:set", { key, value: toggle.checked });
});

settingsPanel.addEventListener("click", (event) => {
  const turnTimeButton = event.target.closest("[data-turn-time-mode]");
  if (turnTimeButton) {
    selectTurnTimeMode(turnTimeButton.dataset.turnTimeMode);
  }
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
let serverAdvancedOpen = false;

const SERVER_CONFIG_LEFT_KEYS = Object.freeze([
  "autoApproveOnStart",
  "codexSandboxMode",
  "guardConcurrentRepositoryWrites",
]);
const SERVER_CONFIG_RIGHT_KEYS = Object.freeze([
  "contextAutomation.autoCompactAfterTurn",
  "contextAutomation.autoRotateAfterCompaction",
  "components.codexContextCleanup",
]);
const SERVER_CONFIG_ADVANCED_COLUMNS = Object.freeze([
  Object.freeze(["codexRolloutContext.scanIntervalSeconds", "codexRpcTimeoutSeconds"]),
  Object.freeze(["deferredInputTtlHours", "progressStartDelayMs"]),
  Object.freeze(["deliveryRetryIntervalSeconds", "logMaxFiles"]),
]);

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
  serverConfig.replaceChildren(...(entries.length
    ? renderServerConfigLayout(autostart, entries)
    : [el("span", { class: "setting-empty", text: "Конфигурация недоступна" })]));
  syncServerConfigDependencyVisibility();
  syncServerConfigActions();
}

/* Автозапуск — такая же настройка Hub, поэтому лежит первой плиткой сетки. В
   отличие от остальных он применяется сразу: это состояние службы Windows, а
   не значение конфигурации, которое ждёт кнопку «Сохранить». */
let serverAutostartState = {};

function renderAutostartEntry(autostart = {}) {
  const supported = autostart.supported !== false;
  const hint = supported
    ? ""
    : "Управление автозапуском доступно только в Windows.";
  const input = el("input", {
    type: "checkbox",
    checked: autostart.enabled === true,
    disabled: !supported,
    "data-server-autostart": "",
  });
  input.addEventListener("change", () => noteServerConfigDraft(AUTOSTART_KEY, input.checked));
  const switchControl = el("label", { class: "server-config-switch-control" }, [
    input,
    el("span", { class: "switch-track", "aria-hidden": true }),
    el("span", { class: "switch-text", text: "Автозапуск Agent Hub" }),
  ]);
  return el("div", {
    class: `server-config-row server-config-toggle${supported ? "" : " is-disabled"}`,
    title: hint || "Автозапуск Agent Hub",
    "aria-disabled": supported ? null : "true",
  }, [
    switchControl,
    hint ? el("small", { class: "server-config-hint", text: hint }) : null,
  ].filter(Boolean));
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
  syncServerConfigDependencyVisibility();
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

function serverConfigValue(key) {
  if (serverConfigDrafts.has(key)) return serverConfigDrafts.get(key);
  return (lastServerPayload?.configuration ?? []).find((entry) => entry.key === key)?.value;
}

function syncServerConfigDependencyVisibility() {
  for (const row of serverConfig?.querySelectorAll("[data-server-config-visible-when]") ?? []) {
    let conditions = [];
    try {
      conditions = JSON.parse(row.dataset.serverConfigVisibleWhen || "[]");
    } catch {
      conditions = [];
    }
    row.hidden = !conditions.every((condition) => (
      Boolean(serverConfigValue(condition.key)) === Boolean(condition.value)
    ));
  }
}

function prepareServerConfigVisibility(node, entry) {
  const conditions = Array.isArray(entry.visibleWhenAll)
    ? entry.visibleWhenAll
    : entry.visibleWhen ? [entry.visibleWhen] : [];
  if (conditions.length) node.dataset.serverConfigVisibleWhen = JSON.stringify(conditions);
  return node;
}

function renderServerConfigLayout(autostart, entries) {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  const renderKey = (key) => {
    const entry = byKey.get(key);
    if (!entry) return null;
    const inlineEntry = entry.inlineValueKey ? byKey.get(entry.inlineValueKey) : null;
    return renderServerConfigEntry(entry, { inlineEntry });
  };
  const primary = el("div", { class: "server-config-primary" }, [
    el("div", { class: "server-config-column" }, [
      renderAutostartEntry(autostart),
      ...SERVER_CONFIG_LEFT_KEYS.map(renderKey),
    ].filter(Boolean)),
    el("div", { class: "server-config-column" }, [
      el("h3", { class: "server-config-column-title", text: "Оптимизация Codex" }),
      ...SERVER_CONFIG_RIGHT_KEYS.map(renderKey),
    ].filter(Boolean)),
  ]);
  const advanced = el("details", {
    class: "server-config-advanced",
    open: serverAdvancedOpen,
  }, [
    el("summary", {
      class: "server-config-advanced-summary",
      text: "Странные константы, трогать не рекомендую",
    }),
    el("div", { class: "server-config-advanced-grid" }, SERVER_CONFIG_ADVANCED_COLUMNS.map((keys) => (
      el("div", { class: "server-config-advanced-column" }, keys.map(renderKey).filter(Boolean))
    ))),
  ]);
  advanced.addEventListener("toggle", () => {
    serverAdvancedOpen = advanced.open;
  });
  return [primary, advanced];
}

function renderServerConfigCopy(entry, { showHint = true } = {}) {
  return el("div", { class: "server-config-copy" }, [
    el("span", { class: "server-config-name", text: entry.name ?? "" }),
    showHint && entry.hint
      ? el("small", { class: "server-config-hint", text: entry.hint })
      : null,
  ].filter(Boolean));
}

function renderServerConfigNumberControl(entry, { inline = false } = {}) {
  const input = el("input", {
    class: "server-config-number",
    type: "number",
    value: entry.value ?? "",
    min: entry.min,
    max: entry.max,
    step: 1,
    disabled: entry.disabled === true,
    "aria-label": entry.name ?? "Параметр конфигурации",
  });
  input.addEventListener("input", () => noteServerConfigDraft(entry.key, input.value));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveServerConfigDrafts();
  });
  const control = el("div", {
    class: `server-config-number-row${inline ? " server-config-inline-value" : ""}`,
  }, [
    inline ? el("span", { class: "server-config-inline-label", text: entry.name ?? "" }) : null,
    input,
    entry.unit ? el("small", { class: "server-config-unit", text: entry.unit }) : null,
  ].filter(Boolean));
  return prepareServerConfigVisibility(control, entry);
}

function renderServerConfigEntry(entry = {}, { inlineEntry = null } = {}) {
  const pendingNote = entry.pending ? el("small", {
    class: "server-config-pending",
    text: "Применится после перезапуска",
  }) : null;
  const hint = entry.hint ? el("small", { class: "server-config-hint", text: entry.hint }) : null;
  const accessModeToggle = entry.type === "choice" && entry.presentation === "access-toggle";
  if (entry.type === "boolean" || accessModeToggle) {
    const input = el("input", {
      type: "checkbox",
      checked: accessModeToggle ? entry.value === "danger-full-access" : entry.value === true,
      disabled: entry.disabled === true,
      "aria-label": entry.name ?? "Переключатель конфигурации",
    });
    input.addEventListener("change", () => noteServerConfigDraft(
      entry.key,
      accessModeToggle
        ? input.checked ? "danger-full-access" : "workspace-write"
        : input.checked,
    ));
    const switchControl = el("label", { class: "server-config-switch-control" }, [
      input,
      el("span", { class: "switch-track", "aria-hidden": true }),
      el("span", { class: "switch-text", text: entry.name ?? "" }),
    ]);
    const row = el("div", {
      class: [
        "server-config-row",
        "server-config-toggle",
        entry.presentation === "automation" ? "server-config-automation" : "",
        entry.disabled ? "is-disabled" : "",
      ].filter(Boolean).join(" "),
      title: entry.hint || entry.name || "",
      "aria-disabled": entry.disabled ? "true" : null,
    }, [
      switchControl,
      entry.presentation === "automation" ? null : hint,
      inlineEntry ? renderServerConfigNumberControl(inlineEntry, { inline: true }) : null,
      pendingNote,
    ].filter(Boolean));
    return prepareServerConfigVisibility(row, entry);
  }
  if (entry.type === "choice") {
    const input = el("select", {
      class: "server-config-number",
      "aria-label": entry.name ?? "Параметр конфигурации",
      disabled: entry.disabled === true,
    }, (Array.isArray(entry.choices) ? entry.choices : []).map((choice) => el("option", {
      value: choice.value ?? "",
      text: choice.label ?? choice.value ?? "",
      selected: choice.value === entry.value,
    })));
    input.addEventListener("change", () => noteServerConfigDraft(entry.key, input.value));
    return prepareServerConfigVisibility(el("div", {
      class: `server-config-row${entry.disabled ? " is-disabled" : ""}`,
      title: entry.hint || entry.name || "",
    }, [
      renderServerConfigCopy(entry),
      input,
      pendingNote,
    ].filter(Boolean)), entry);
  }
  return prepareServerConfigVisibility(el("div", {
    class: `server-config-row${entry.disabled ? " is-disabled" : ""}`,
    title: entry.hint || entry.name || "",
  }, [
    renderServerConfigCopy(entry),
    renderServerConfigNumberControl(entry),
    pendingNote,
  ].filter(Boolean)), entry);
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
  const trigger = event.target.closest("[data-action]");
  if (!trigger) return;
  const action = trigger.dataset.action;
  handleAction(action, trigger, event);
});

async function handleAction(action, trigger) {
  const taskId = trigger.closest("[data-stream-chat-task-id]")?.dataset.streamChatTaskId
    || state.selectedId;
  switch (action) {
    case "workspace-new":
      openNewWorkspaceCard();
      break;
    case "task-new": {
      const provider = ["codex", "claude"].includes(trigger?.dataset?.provider)
        ? trigger.dataset.provider
        : (currentTask()?.provider ?? "codex");
      const title = await askText({ title: "Название новой задачи" });
      if (title != null) emit("task:new", { title, provider });
      break;
    }
    case "stream-create":
      emit("stream:new", { workspaceId: trigger.dataset.workspaceId });
      break;
    case "stream-order-toggle":
      applyStreamOrderMode(streamOrderMode === "manual" ? "activity" : "manual", {
        persist: true,
        update: true,
      });
      break;
    case "task-settings":
      toggleDialogSettings();
      break;
    case "task-rename": {
      const task = currentTask();
      const title = await askText({ title: "Новое название Workspace", value: task?.workspaceName ?? task?.title ?? "" });
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
    case "approval-submit": {
      emit("approval:respond", {
        taskId,
        id: trigger.dataset.approvalId,
        decision: "submit",
        answers: window.AgentHubApprovalForm.collectAnswers(trigger),
      });
      break;
    }
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
    case "queue-pause":
      emit("queue:pause", { taskId, id: trigger.dataset.queueId });
      break;
    case "queue-resume":
      emit("queue:resume", { taskId, id: trigger.dataset.queueId });
      break;
    case "queue-new":
      emit("queue:new", { taskId, id: trigger.dataset.queueId });
      break;
    case "queue-retry":
      emit("queue:retry", { taskId, id: trigger.dataset.queueId });
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
    case "context-usage-open":
      openContextUsage();
      break;
    case "context-usage-close":
      closeContextUsage();
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

contextUsageModal?.addEventListener("click", (event) => {
  if (event.target === contextUsageModal) closeContextUsage();
});
document.addEventListener("pointerdown", (event) => {
  if (!contextUsageModal?.open) return;
  if (contextUsageModal.contains(event.target) || contextUsageButton?.contains(event.target)) return;
  closeContextUsage();
});
window.addEventListener("resize", positionContextUsage);

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
      "restart-waiting": window.AgentHubConnectionBanner.restartWaitingMessage(blockingCount),
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
    const selectedTaskLocationChanged = Boolean(previousSelectedTask && nextSelectedTask) && (
      workspaceKey(previousSelectedTask) !== workspaceKey(nextSelectedTask)
      || streamKey(previousSelectedTask) !== streamKey(nextSelectedTask)
    );
    if (state.workspaceMessageSearch.open && nextSelectedTask
      && state.workspaceMessageSearch.workspaceId !== workspaceKey(nextSelectedTask)) {
      closeWorkspaceMessageSearch({ restoreFocus: false });
      Object.assign(state.workspaceMessageSearch, {
        workspaceId: "",
        query: "",
        results: [],
        total: 0,
        nextOffset: null,
        loading: false,
        error: "",
        indexing: null,
      });
      if (workspaceMessageSearchInput) workspaceMessageSearchInput.value = "";
    }
    if (!tasksChanged && !selectionChanged) return;
    if (selectionChanged && state.selectedId) saveDraft();
    state.tasks = nextTasks;
    state.selectedId = nextSelectedId;
    if (selectionChanged || selectedTaskLocationChanged) {
      const current = currentTask();
      if (current) state.activeStreamByWorkspace.set(workspaceKey(current), streamKey(current));
      ensureTaskStreamVisible(current);
      persistOpenStreams();
    }
    renderTasks();
    if (selectionChanged || selectedTaskChanged || nextTasks.some((task) => (
      task.id !== nextSelectedId && state.visibleStreamTaskIds.includes(task.id)
    ))) renderChat();
  },
  setWorkspaces(workspaces, columnOrder = []) {
    state.workspaces = Array.isArray(workspaces) ? workspaces.slice() : [];
    state.workspaceColumnOrder = Array.isArray(columnOrder) ? columnOrder.slice() : [];
    if (workspaceCardModal?.open && workspaceCardId) {
      renderWorkspaceReleaseRegistry(workspaceCatalogItem(workspaceCardId));
    }
    if (journalRendered) updateJournalStreamCount();
  },
  setWorkspaceReleaseRegistry(workspaceId, registry) {
    const id = String(workspaceId ?? "");
    workspaceReleaseRegistryByWorkspace.set(id, registry ?? {});
    if (workspaceCardModal?.open && workspaceCardId === id) {
      renderWorkspaceReleaseRegistry(workspaceCatalogItem(id));
    }
  },
  openDialogSettings,
  /** Точечное обновление задачи (статус, время, непрочитанное). */
  patchTask(id, patch) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    const changed = Object.entries(patch ?? {}).some(([key, value]) => !Object.is(task[key], value));
    if (!changed) return;
    Object.assign(task, patch);
    renderTasks();
    if (id === state.selectedId) renderChat();
    else if (state.visibleStreamTaskIds.includes(id)) renderStreamChatDeck({ force: true });
  },
  /** Выбор задачи со стороны backend (например, смена из Telegram). */
  selectTask(id) {
    if (state.selectedId === id) return;
    saveDraft();
    state.selectedId = id;
    for (const task of state.tasks) task.selected = task.id === id;
    const selected = currentTask();
    if (selected) state.activeStreamByWorkspace.set(workspaceKey(selected), streamKey(selected));
    ensureTaskStreamVisible(selected);
    persistOpenStreams();
    renderTasks();
    renderChat();
  },
  /** История сообщений задачи. message: { id, role, author, text, time,
   *  attachments }. role: "user" | "agent" | "system". */
  setMessages(taskId, messages) {
    const next = Array.isArray(messages) ? messages.slice() : [];
    const sameMessages = state.messages.has(taskId) && sameData(state.messages.get(taskId), next);
    const selectedSurfaceOwned = taskId === state.selectedId
      && String(chatLog.dataset.messageOwnerKey ?? "") === String(taskId ?? "");
    if (sameMessages && (taskId !== state.selectedId || selectedSurfaceOwned)) return;
    if (!sameMessages) state.messages.set(taskId, next);
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true });
      renderLive();
    } else refreshSupplementaryStreamChat(taskId);
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
    const sameMessages = state.messages.has(taskId) && sameData(state.messages.get(taskId), next);
    const selectedSurfaceOwned = taskId === state.selectedId
      && String(chatLog.dataset.messageOwnerKey ?? "") === String(taskId ?? "");
    if (sameMessages && (taskId !== state.selectedId || selectedSurfaceOwned)) return;
    if (!sameMessages) state.messages.set(taskId, next);
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true });
      renderLive();
    } else refreshSupplementaryStreamChat(taskId);
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
    } else refreshSupplementaryStreamChat(taskId);
  },
  patchMessage(taskId, messageId, patch) {
    const list = state.messages.get(taskId) ?? [];
    const message = list.find((item) => item.id === messageId);
    if (!message) return;
    Object.assign(message, patch);
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true });
      renderLive();
    } else refreshSupplementaryStreamChat(taskId);
  },
  completeSend(requestId, { accepted = false } = {}) {
    completeComposerSend(requestId, accepted);
  },
  completeBugReport(result = {}) {
    setBugReportSending(false);
    if (result.error) {
      setBugReportStatus(String(result.error), "error");
      if (bugReportForm) bugReportForm.hidden = false;
      bugReportToggle?.setAttribute("aria-expanded", "true");
      bugReportText?.focus();
      return;
    }
    bugReportAttachments = [];
    if (bugReportText) bugReportText.value = "";
    renderBugReportAttachments();
    setBugReportStatus();
    if (bugReportForm) bugReportForm.hidden = true;
    bugReportToggle?.setAttribute("aria-expanded", "false");
    showToast("Отчёт о баге отправлен");
  },
  /** Живой ход: { author, stage, reasoning, text } или null, чтобы скрыть. */
  setLive(taskId, live) {
    const next = live ?? null;
    if (sameData(state.live.get(taskId) ?? null, next)) return;
    state.live.set(taskId, next);
    if (taskId === state.selectedId) renderLive();
    else refreshSupplementaryStreamChat(taskId);
  },
  setSearchResults(query, results) {
    if (String(query ?? "").trim() !== state.searchQuery) return;
    state.searchResults = new Map((Array.isArray(results) ? results : [])
      .map((result) => [result.id, result]));
    state.searchLoading = false;
    renderTasks();
  },
  setWorkspaceMessageSearchResults(payload, { append = false } = {}) {
    const search = state.workspaceMessageSearch;
    if (String(payload?.workspaceId ?? "") !== search.workspaceId
      || String(payload?.query ?? "").trim() !== search.query) return;
    const received = Array.isArray(payload?.results) ? payload.results : [];
    search.results = append ? [...search.results, ...received] : received;
    search.total = Math.max(0, Number(payload?.total) || 0);
    search.nextOffset = Number.isSafeInteger(Number(payload?.nextOffset))
      ? Number(payload.nextOffset)
      : null;
    search.indexing = payload?.indexing ?? null;
    search.loading = false;
    search.error = "";
    renderWorkspaceMessageSearch();
    clearTimeout(workspaceMessageSearchIndexPollTimer);
    if (search.open && search.indexing?.state === "indexing") {
      workspaceMessageSearchIndexPollTimer = window.setTimeout(() => {
        if (!search.open || search.indexing?.state !== "indexing") return;
        emit("workspace-search:query", {
          workspaceId: search.workspaceId,
          query: search.query,
          offset: 0,
          limit: Math.min(100, Math.max(40, search.results.length)),
          append: false,
        });
      }, 800);
    }
  },
  setWorkspaceMessageSearchError(message) {
    clearTimeout(workspaceMessageSearchIndexPollTimer);
    state.workspaceMessageSearch.loading = false;
    state.workspaceMessageSearch.error = String(message ?? "Не удалось выполнить поиск");
    renderWorkspaceMessageSearch();
  },
  openWorkspaceMessageSearch,
  closeWorkspaceMessageSearch,
  focusMessage({ turnId, itemId } = {}) {
    const target = [...chatLog.querySelectorAll("[data-item-id]")].find((node) => (
      String(node.dataset.turnId ?? "") === String(turnId ?? "")
      && String(node.dataset.itemId ?? "") === String(itemId ?? "")
    ));
    if (!target) return false;
    chatLog.querySelectorAll("[data-search-match]").forEach((node) => {
      node.removeAttribute("data-search-match");
    });
    target.setAttribute("data-search-match", "");
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    window.setTimeout(() => target.removeAttribute("data-search-match"), 4_000);
    return true;
  },
  /** running=true подсвечивает индикатор и показывает «Стоп». */
  setRunning(taskId, running) {
    this.patchTask(taskId, { running: Boolean(running) });
    if (taskId === state.selectedId) chatScrollControllers.get(chatScroll)?.setWorking(Boolean(running));
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
    else refreshSupplementaryStreamChat(taskId);
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
   *  includeClaudeUsage, activityRecentMinutes }. */
  setSelection(selection) {
    const claudeUsageChanged = Object.hasOwn(selection ?? {}, "includeClaudeUsage")
      && state.selection.includeClaudeUsage !== selection.includeClaudeUsage;
    const next = { ...state.selection, ...selection };
    if (sameData(state.selection, next)) return;
    state.selection = next;
    if (Object.hasOwn(selection ?? {}, "activityRecentMinutes")) {
      applyActivityRecentPeriod(selection.activityRecentMinutes, { update: true });
    }
    renderOptions();
    if (state.selectedId) renderChat();
    if (claudeUsageChanged && journalHtml) void renderJournal();
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
  /** Сопоставление локального расхода с изменением лимитов API. */
  setUsageComparison(payload) {
    applyUsageComparison(payload);
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
        ? `курс ЦБ РФ ${spacedNumber(usdRubRate, 4)} за $1${date ? ` на ${date}` : ""}.`
        : "курс пока недоступен.";
    }
    refreshUsageUnits();
    renderUsageHistory();
    if (journalHtml) void renderJournal();
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
  showSelectedTask() {
    setView("chat");
    setPane("chat");
  },
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
const LIMITS_MODE_KEY = "agent-hub-limits-mode-v1";
const LIMITS_SPEED_FULL_WINDOW_KEY = "agent-hub-limits-speed-full-window-v1";

function savedLimitsRange() {
  return storedLimitsRange(localStorage);
}

function loadLimitsMode() {
  try {
    return localStorage.getItem(LIMITS_MODE_KEY) === "speed" ? "speed" : "usage";
  } catch {
    return "usage";
  }
}

function loadLimitsSpeedFullWindow() {
  try {
    return localStorage.getItem(LIMITS_SPEED_FULL_WINDOW_KEY) !== "false";
  } catch {
    return true;
  }
}

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
  range: savedLimitsRange(),
  mode: loadLimitsMode(),
  status: "idle", // idle | loading | ready | empty | error
  payload: null,
  error: "",
  hidden: loadHiddenSeries(),
  speedFullWindow: loadLimitsSpeedFullWindow(),
};

function selectLimitsMode(mode) {
  const next = mode === "speed" ? "speed" : "usage";
  if (limitsState.mode === next) return;
  limitsState.mode = next;
  try {
    localStorage.setItem(LIMITS_MODE_KEY, next);
  } catch {
    // Режим останется активным до закрытия WebView.
  }
  renderLimitsModes();
  renderLimits();
}

function renderLimitsModes() {
  if (!limitsModes) return;
  for (const button of limitsModes.querySelectorAll("[data-limits-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.limitsMode === limitsState.mode));
  }
  if (limitsSpeedNote) {
    const hourly = burnRatePolicyForRange(limitsState.range).unit === "hour";
    limitsSpeedNote.hidden = limitsState.mode !== "speed";
    const calculation = limitsState.speedFullWindow
      ? hourly
        ? "Фактическая скорость появляется после накопления почти полного часа."
        : "Фактическая скорость появляется после накопления почти полных суток."
      : "Предварительная скорость считается по доступной истории сразу после второго замера и в начале цикла может резко меняться.";
    limitsSpeedNote.textContent = `${calculation} Разрывы между замерами восстанавливаются: неизменившийся лимит даёт нулевой расход, а изменение равномерно распределяется по пропущенному времени. Пунктир показывает допустимый темп по остатку и времени до сброса. Горизонтальная линия — ровный расход 100% за неделю, или ${hourly ? "0,6% в час" : "14,3% в сутки"}.`;
  }
  if (limitsSpeedWindowSetting) limitsSpeedWindowSetting.hidden = limitsState.mode !== "speed";
  if (limitsSpeedFullWindow) limitsSpeedFullWindow.checked = limitsState.speedFullWindow;
}

function statisticsAccounts(payload = limitsState.payload) {
  const source = Array.isArray(payload?.accounts) ? payload.accounts : [];
  const accounts = new Map();
  for (const account of source) {
    const key = String(account?.key ?? "");
    if (key) accounts.set(key, { ...account, key });
  }
  for (const series of Array.isArray(payload?.series) ? payload.series : []) {
    for (const point of Array.isArray(series?.points) ? series.points : []) {
      const key = String(point?.accountKey ?? series?.accountKey ?? "");
      if (key && !accounts.has(key)) {
        accounts.set(key, {
          key,
          label: String(point?.accountLabel ?? series?.accountLabel ?? key),
          planType: String(point?.accountPlan ?? series?.accountPlan ?? ""),
        });
      }
    }
  }
  return [...accounts.values()];
}

function resolvedStatisticsAccountKey(payload = limitsState.payload) {
  const accounts = statisticsAccounts(payload);
  const selected = String(statisticsAccountState.accountKey || "");
  if (selected === ALL_STATISTICS_ACCOUNTS) return selected;
  if (accounts.some((account) => account.key === selected)) return selected;
  const current = String(payload?.currentAccount?.key ?? "");
  const resolved = accounts.some((account) => account.key === current)
    ? current
    : String(accounts[0]?.key ?? "");
  statisticsAccountState.accountKey = resolved;
  if (resolved) {
    try {
      localStorage.setItem(STATISTICS_ACCOUNT_KEY, resolved);
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
  }
  return resolved;
}

function renderStatisticsAccountSelects(payload = limitsState.payload) {
  const accounts = statisticsAccounts(payload);
  const selected = resolvedStatisticsAccountKey(payload);
  for (const select of statisticsAccountSelects) {
    select.replaceChildren(
      el("option", {
        value: ALL_STATISTICS_ACCOUNTS,
        text: "Все",
        selected: selected === ALL_STATISTICS_ACCOUNTS,
      }),
      ...accounts.map((account) => el("option", {
        value: account.key,
        text: account.label || account.key,
        selected: account.key === selected,
      })),
    );
    select.disabled = accounts.length === 0;
    select.__themedSelect?.render();
  }
}

function selectStatisticsAccount(accountKey) {
  const key = String(accountKey ?? "");
  if (!key || key === resolvedStatisticsAccountKey()) return;
  statisticsAccountState.accountKey = key;
  try {
    localStorage.setItem(STATISTICS_ACCOUNT_KEY, key);
  } catch {
    // Выбор останется активным до закрытия WebView.
  }
  renderStatisticsAccountSelects();
  renderLimits();
  requestUsageComparison(comparisonState.range, { force: true });
}

function statisticsSeriesPoints(series, accountKey = resolvedStatisticsAccountKey()) {
  const points = Array.isArray(series?.points) ? series.points : [];
  if (!series?.baseId || accountKey === ALL_STATISTICS_ACCOUNTS) return points;
  return points.filter((point) => (
    String(point?.accountKey ?? series?.accountKey ?? "") === accountKey
  ));
}

for (const select of statisticsAccountSelects) {
  select.addEventListener("change", () => selectStatisticsAccount(select.value));
}

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
  if (series?.accountKey) {
    const hash = [...String(series.accountKey)]
      .reduce((value, character) => ((value * 31) + character.codePointAt(0)) >>> 0, 0);
    return SERIES_PALETTE[hash % SERIES_PALETTE.length];
  }
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
  if (!payloadMatchesSelectedRange(data, limitsState.range)) return;
  limitsState.payload = data;
  limitsState.error = data?.error ? String(data.error) : "";
  limitsState.status = statusFromPayload(data);
  renderStatisticsAccountSelects(data);
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

const WEEK_MILLISECONDS = 7 * 24 * 60 * 60_000;
const BURN_RATE_ROLLING_WINDOW_MS = 24 * 60 * 60_000;
const BURN_RATE_HOURLY_WINDOW_MS = 60 * 60_000;
// Процент лимита приходит целым числом. На коротком отрезке один новый процент
// превращался в огромный ложный пик, поэтому 24-часовой темп показываем только
// после накопления почти полного окна (с часовым допуском для редких снимков).
const BURN_RATE_MINIMUM_SPAN_MS = 23 * 60 * 60_000;
const BURN_RATE_HOURLY_MINIMUM_SPAN_MS = 45 * 60_000;
const BURN_RATE_CHART_MAX = 400;
const {
  interpolateRateLimitGaps,
  meanSignedComparisonDeviation,
  rateLimitDeltasByBuckets,
  signedComparisonDeviations,
} = globalThis.AgentHubRateLimitSeries;

function burnRatePolicyForRange(range) {
  return ["6h", "24h"].includes(String(range))
    ? {
      rollingWindowMs: BURN_RATE_HOURLY_WINDOW_MS,
      minimumSpanMs: BURN_RATE_HOURLY_MINIMUM_SPAN_MS,
      unit: "hour",
    }
    : {
      rollingWindowMs: BURN_RATE_ROLLING_WINDOW_MS,
      minimumSpanMs: BURN_RATE_MINIMUM_SPAN_MS,
      unit: "day",
    };
}

function selectedBurnRatePolicyForRange(range) {
  const policy = burnRatePolicyForRange(range);
  return limitsState.speedFullWindow ? policy : { ...policy, minimumSpanMs: 0 };
}

function weeklyLimitDurationMs(series) {
  const explicitDurations = (Array.isArray(series?.points) ? series.points : [])
    .map((point) => Number(point?.windowDurationMins) * 60_000)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  if (explicitDurations.length) {
    return explicitDurations.find((duration) => duration >= 6 * 24 * 60 * 60_000) ?? null;
  }
  const id = String(series?.id ?? series?.baseId ?? "").toLowerCase();
  const windowName = String(series?.window ?? "").toLowerCase();
  if (windowName === "week" || id.startsWith("claude:model:") || windowName === "secondary") {
    return WEEK_MILLISECONDS;
  }
  const hasLongReset = (Array.isArray(series?.points) ? series.points : []).some((point) => {
    const atMs = Date.parse(point?.at ?? "");
    const resetMs = Date.parse(point?.resetsAt ?? "");
    return Number.isFinite(atMs) && Number.isFinite(resetMs) && resetMs - atMs > 24 * 60 * 60_000;
  });
  return hasLongReset ? WEEK_MILLISECONDS : null;
}

function limitPointResetMs(point) {
  const isoReset = Date.parse(point?.resetsAt ?? "");
  if (Number.isFinite(isoReset)) return isoReset;
  const atMs = Date.parse(point?.at ?? "");
  return parseClaudeResetAt(point?.resetsText, Number.isFinite(atMs) ? atMs : Date.now());
}

function sameWeeklyLimitCycle(left, right) {
  return Number.isInteger(left?.cycleIndex)
    && Number.isInteger(right?.cycleIndex)
    && left.cycleIndex === right.cycleIndex;
}

function sameLimitsSpeedSegment(left, right) {
  const hasPathSegments = Number.isInteger(left?.pathSegmentIndex)
    && Number.isInteger(right?.pathSegmentIndex);
  return sameWeeklyLimitCycle(left, right)
    && (!hasPathSegments || left.pathSegmentIndex === right.pathSegmentIndex);
}

function limitsSpeedPath(points) {
  return points
    .map((point, index) => {
      const continues = index > 0 && sameLimitsSpeedSegment(points[index - 1], point);
      return `${continues ? "L" : "M"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`;
    })
    .join(" ");
}

function limitsFiniteSpeedPoints(points) {
  let pathSegmentIndex = 0;
  let previousWasFinite = false;
  return (Array.isArray(points) ? points : []).flatMap((point) => {
    if (!Number.isFinite(point?.actualRate)) {
      previousWasFinite = false;
      return [];
    }
    if (!previousWasFinite) pathSegmentIndex += 1;
    previousWasFinite = true;
    return [{ ...point, pathSegmentIndex }];
  });
}

function shouldWaitForBurnRateData(speedFullWindow, latest, range) {
  const fullWindow = burnRatePolicyForRange(range).minimumSpanMs;
  return Boolean(speedFullWindow)
    && Number.isFinite(latest?.cycleAgeMs)
    && latest.cycleAgeMs < fullWindow;
}

function weeklyBurnRatePoints(series, {
  rollingWindowMs = BURN_RATE_ROLLING_WINDOW_MS,
  minimumSpanMs = BURN_RATE_MINIMUM_SPAN_MS,
  maximumLookbackMs = rollingWindowMs * 1.5,
} = {}) {
  const durationMs = weeklyLimitDurationMs(series);
  if (!durationMs) return [];
  const points = interpolateRateLimitGaps(series?.points)
    .map((point) => ({
      raw: point,
      atMs: Date.parse(point?.at ?? ""),
      resetMs: limitPointResetMs(point),
      usedPercent: Number(point?.usedPercent),
      remainingPercent: point?.remainingPercent == null
        ? Math.max(0, 100 - Number(point?.usedPercent || 0))
        : Number(point.remainingPercent),
    }))
    .filter((point) => (
      Number.isFinite(point.atMs)
      && Number.isFinite(point.resetMs)
      && Number.isFinite(point.usedPercent)
      && Number.isFinite(point.remainingPercent)
      && point.resetMs > point.atMs
    ))
    .sort((left, right) => left.atMs - right.atMs);

  let cycleIndex = 0;
  for (let index = 0; index < points.length; index += 1) {
    const previousAccount = String(points[index - 1]?.raw?.accountKey ?? "");
    const currentAccount = String(points[index]?.raw?.accountKey ?? "");
    if (index > 0 && (
      points[index].usedPercent < points[index - 1].usedPercent
      || (previousAccount && currentAccount && previousAccount !== currentAccount)
    )) cycleIndex += 1;
    points[index].cycleIndex = cycleIndex;
  }

  return points.map((point, index) => {
    const remainingMs = point.resetMs - point.atMs;
    const targetRate = Math.max(0, point.remainingPercent) / remainingMs * WEEK_MILLISECONDS;
    let baseline = null;
    let baselineDistance = Number.POSITIVE_INFINITY;
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      const candidate = points[cursor];
      const candidateSpanMs = point.atMs - candidate.atMs;
      if (candidateSpanMs > maximumLookbackMs) break;
      if (!sameWeeklyLimitCycle(point, candidate)) continue;
      if (candidateSpanMs < minimumSpanMs || point.usedPercent < candidate.usedPercent) continue;
      const distance = Math.abs(candidateSpanMs - rollingWindowMs);
      if (distance < baselineDistance) {
        baseline = candidate;
        baselineDistance = distance;
      }
    }
    const spanMs = baseline ? point.atMs - baseline.atMs : 0;
    const usedDelta = baseline ? point.usedPercent - baseline.usedPercent : Number.NaN;
    const actualRate = spanMs > 0 && spanMs >= minimumSpanMs && usedDelta >= 0
      ? usedDelta / spanMs * WEEK_MILLISECONDS
      : null;
    const deviationRate = Number.isFinite(actualRate) ? actualRate - targetRate : null;
    return {
      ...point,
      durationMs,
      cycleAgeMs: Math.max(0, point.atMs - (point.resetMs - durationMs)),
      sampleSpanMs: spanMs,
      targetRate,
      actualRate,
      deviationRate,
      overTarget: Number.isFinite(deviationRate) ? deviationRate > 0 : false,
    };
  });
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
  const currentAccountKey = String(payload?.currentAccount?.key ?? "");
  const available = (Array.isArray(payload?.series) ? payload.series : [])
    .filter((series) => Array.isArray(series.points) && series.points.length)
    .map((series) => {
      const provider = String(series.name ?? "").toLowerCase();
      const codex = provider === "codex" || provider === "spark";
      if (!codex || !currentAccountKey) return { ...series, point: series.points.at(-1) };
      const point = series.points.findLast((item) => (
        String(item?.accountKey ?? "") === currentAccountKey
      )) ?? (series.accountKey === currentAccountKey ? series.points.at(-1) : null);
      return point ? { ...series, point } : null;
    })
    .filter(Boolean);
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
      const progress = Number.isFinite(remaining)
        ? Math.max(0, Math.min(100, remaining))
        : 0;
      const countdown = formatResetCountdown(item.point);
      const id = String(item.id ?? "").toLowerCase();
      const name = String(item.name ?? "").toLowerCase();
      const provider = id.startsWith("claude:") || name === "claude"
        ? "claude"
        : name === "spark" ? "spark" : "codex";
      const ring = el("span", { class: "current-limit-ring" }, [
        el("span", {
          class: "current-limit-ring-value",
          text: Number.isFinite(remaining) ? `${Math.round(remaining)}%` : "—",
        }),
      ]);
      ring.style.setProperty("--current-limit-progress", `${progress}%`);
      const bar = el("span", { class: "current-limit-bar" }, [
        el("span", { class: "current-limit-bar-fill" }),
      ]);
      bar.style.setProperty("--current-limit-progress", `${progress}%`);
      return el("span", {
        class: "current-limit",
        "data-current-limit-provider": provider,
      }, [
        ring,
        el("span", { class: "current-limit-copy" }, [
          el("span", { class: "current-limit-primary" }, [
            el("span", { class: "current-limit-name", text: item.label }),
            el("strong", {
              class: "current-limit-value",
              text: Number.isFinite(remaining) ? `${remaining.toFixed(1)}%` : "—",
            }),
          ]),
          bar,
          countdown
            ? el("span", { class: "current-limit-reset", text: countdown })
            : null,
        ]),
      ]);
    }));
  }
}

/* Запрос данных за период: показываем загрузку (если нет свежих данных за этот
 * период) и просим backend прислать историю. */
function requestLimits(range, { force = false } = {}) {
  limitsState.range = persistLimitsRange(localStorage, range);
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
  const mode = limitsState.mode === "speed" ? "Скорость недельного расхода" : "Расход лимита";
  limitsSubtitle.textContent = [mode, label, period].filter(Boolean).join(" · ");
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
    renderLimitsSpeedSummary(series);
    renderLimitsCredits(limitsState.payload);
  }
  renderLimitsModes();
  renderLimitsSubtitle();
}

/* Собирает SVG-график и возвращает нормализованные серии (с цветом и текущим
 * значением) для легенды. */
function buildLimitsChart(payload) {
  if (limitsState.mode === "speed") return buildLimitsSpeedChart(payload);
  const accountKey = resolvedStatisticsAccountKey(payload);
  const rawSeries = (Array.isArray(payload?.series) ? payload.series : [])
    .map((item) => ({ ...item, points: statisticsSeriesPoints(item, accountKey) }));
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
        name: item.accountLabel
          ? `${item.accountLabel} · ${item.name || item.baseId || item.id || ""}`
          : item.name || item.id || "",
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
        const name = item.accountLabel
          ? `${item.accountLabel} · ${item.name || item.baseId || item.id}`
          : item.name || item.id;
        return `${name}: ${used}%`;
      })
      .join("; ")
    : "все серии скрыты";
  limitsChart.setAttribute("aria-label", `Израсходовано лимитов по времени. ${summary}.`);
  limitsChart.replaceChildren(svg);
  return allSeries;
}

function buildLimitsSpeedChart(payload) {
  const accountKey = resolvedStatisticsAccountKey(payload);
  const rawSeries = (Array.isArray(payload?.series) ? payload.series : [])
    .map((item) => ({ ...item, points: statisticsSeriesPoints(item, accountKey) }));
  const allSeries = rawSeries
    .filter((item) => Array.isArray(item.points) && item.points.length > 0)
    .filter((item) => weeklyLimitDurationMs(item))
    .map((item, index) => {
      const id = seriesId(item);
      return {
        ...item,
        id,
        color: seriesColor(item, index),
        hidden: limitsState.hidden.has(id),
        ratePoints: weeklyBurnRatePoints(item, selectedBurnRatePolicyForRange(limitsState.range)),
      };
    })
    .filter((item) => item.ratePoints.length > 0);
  const series = allSeries.filter((item) => !item.hidden);
  const times = series.flatMap((item) => item.ratePoints.map((point) => point.atMs));
  let tMin = payload?.from ? Date.parse(payload.from) : Number.NaN;
  let tMax = payload?.to ? Date.parse(payload.to) : Number.NaN;
  if (!Number.isFinite(tMin)) tMin = times.length ? Math.min(...times) : 0;
  if (!Number.isFinite(tMax)) tMax = times.length ? Math.max(...times) : tMin + 1;
  if (tMax <= tMin) tMax = tMin + 1;

  const W = chartWidth(limitsChart);
  const H = 260;
  const padL = 48;
  const padR = 14;
  const padT = 14;
  const padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xOf = (time) => padL + ((time - tMin) / (tMax - tMin)) * plotW;
  const yOf = (rate) => (
    padT + (1 - clampNumber(Number(rate) || 0, 0, BURN_RATE_CHART_MAX) / BURN_RATE_CHART_MAX) * plotH
  );
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "limits-chart-svg limits-speed-chart-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });

  for (const value of [0, 100, 200, 300, 400]) {
    const y = yOf(value);
    svg.append(svgEl("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "limits-grid-line" }));
    svg.append(svgEl("text", {
      x: padL - 6,
      y: y + 3,
      class: "limits-axis-label limits-axis-y",
      "text-anchor": "end",
    }, [value === BURN_RATE_CHART_MAX ? `${value}+` : String(value)]));
  }
  svg.append(svgEl("text", {
    x: padL,
    y: padT + 9,
    class: "limits-axis-label limits-speed-unit",
  }, ["% / нед."]));

  const normalRateY = yOf(100);
  svg.append(svgEl("line", {
    x1: padL,
    y1: normalRateY,
    x2: W - padR,
    y2: normalRateY,
    class: "limits-burn-normal-line",
  }));
  svg.append(svgEl("text", {
    x: W - padR,
    y: normalRateY - 6,
    class: "limits-burn-normal-label",
    "text-anchor": "end",
  }, [burnRatePolicyForRange(limitsState.range).unit === "hour"
    ? "Ровный темп · 0,6%/час"
    : "Ровный темп · 14,3%/сутки"]));

  const span = tMax - tMin;
  const dayMs = 24 * 60 * 60_000;
  if (span > dayMs * 1.5) {
    const first = new Date(tMin);
    first.setHours(0, 0, 0, 0);
    const days = [];
    for (let time = first.getTime(); time <= tMax; time += dayMs) {
      if (time >= tMin) days.push(time);
    }
    const step = Math.max(1, Math.ceil(days.length / Math.floor(plotW / 46)));
    days.forEach((time, index) => {
      if (index % step) return;
      const x = xOf(time);
      svg.append(svgEl("line", {
        x1: x, y1: padT, x2: x, y2: padT + plotH, class: "limits-grid-line limits-grid-day",
      }));
      svg.append(svgEl("text", {
        x,
        y: H - 20,
        class: "limits-axis-label limits-axis-x",
        "text-anchor": "middle",
      }, [new Date(time).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })]));
      svg.append(svgEl("text", {
        x,
        y: H - 7,
        class: "limits-axis-label limits-axis-x usage-axis-weekday",
        "text-anchor": "middle",
      }, [weekdayLabel(time)]));
    });
  } else {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const time = tMin + span * fraction;
      svg.append(svgEl("text", {
        x: xOf(time),
        y: H - 8,
        class: "limits-axis-label limits-axis-x",
        "text-anchor": fraction === 0 ? "start" : fraction === 1 ? "end" : "middle",
      }, [formatAxisTime(time, span)]));
    }
  }

  for (const item of series) {
    const targetPoints = item.ratePoints.map((point) => ({
      ...point,
      x: xOf(point.atMs),
      y: yOf(point.targetRate),
    }));
    if (targetPoints.length) {
      svg.append(svgEl("path", {
        d: limitsSpeedPath(targetPoints),
        class: "limits-burn-target-line",
        fill: "none",
        stroke: item.color,
      }));
    }
    const actualPoints = limitsFiniteSpeedPoints(item.ratePoints)
      .map((point) => ({ ...point, x: xOf(point.atMs), y: yOf(point.actualRate) }));
    if (!actualPoints.length) continue;
    svg.append(svgEl("path", {
      d: limitsSpeedPath(actualPoints),
      class: "limits-burn-actual-guide",
      fill: "none",
      stroke: item.color,
    }));
    for (let index = 1; index < actualPoints.length; index += 1) {
      const left = actualPoints[index - 1];
      const right = actualPoints[index];
      if (!sameLimitsSpeedSegment(left, right)) continue;
      svg.append(svgEl("line", {
        x1: left.x,
        y1: left.y,
        x2: right.x,
        y2: right.y,
        class: `limits-burn-rate-segment ${right.overTarget ? "is-over-target" : "is-safe"}`,
      }));
    }
    const markerPoints = limitsMarkerPoints(actualPoints);
    markerPoints.forEach((point) => {
      const isLast = point === actualPoints.at(-1);
      const circle = svgEl("circle", {
        cx: point.x,
        cy: point.y,
        r: isLast ? 4 : 2.8,
        class: `limits-point limits-speed-point ${point.overTarget ? "is-over-target" : "is-safe"}${
          isLast ? " limits-point-current" : ""
        }`,
      });
      const info = {
        mode: "speed",
        name: item.accountLabel
          ? `${item.accountLabel} · ${item.name || item.baseId || item.id || ""}`
          : item.name || item.id || "",
        window: item.window || "",
        at: point.raw.at,
        actualRate: point.actualRate,
        targetRate: point.targetRate,
        deviationRate: point.deviationRate,
        estimated: point.raw?.estimated === true,
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

  if (!series.length) {
    svg.append(svgEl("text", {
      x: padL + plotW / 2,
      y: padT + plotH / 2,
      class: "limits-empty-plot",
      "text-anchor": "middle",
    }, [allSeries.length ? "Все недельные серии скрыты" : "Нет данных недельных лимитов"]));
  }
  const summary = series.length
    ? series.map((item) => {
      const last = item.ratePoints.findLast((point) => Number.isFinite(point.actualRate));
      return last
        ? `${item.name || item.id}: ${Math.round(last.actualRate)}% в неделю, допустимо ${Math.round(last.targetRate)}%`
        : `${item.name || item.id}: недостаточно истории для фактической скорости`;
    }).join("; ")
    : allSeries.length ? "все недельные серии скрыты" : "нет недельных лимитов";
  limitsChart.setAttribute("aria-label", `Скорость расхода недельных лимитов. ${summary}.`);
  limitsChart.replaceChildren(svg);
  return allSeries;
}

function formatLimitRateForPeriod(weeklyRate, range = limitsState.range) {
  const hourly = burnRatePolicyForRange(range).unit === "hour";
  const periodRate = Math.max(0, Number(weeklyRate) || 0) / (hourly ? 7 * 24 : 7);
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: periodRate < 10 ? 1 : 0,
    minimumFractionDigits: periodRate > 0 && periodRate < 10 ? 1 : 0,
  }).format(periodRate);
}

function burnRatePeriodSuffix(range = limitsState.range) {
  return burnRatePolicyForRange(range).unit === "hour" ? "%/час" : "%/сутки";
}

function formatBurnRateSampleSpan(spanMs) {
  const totalMinutes = Math.max(1, Math.round(Number(spanMs) / 60_000));
  if (!Number.isFinite(totalMinutes)) return "";
  if (totalMinutes < 120) return `${totalMinutes} мин.`;
  const hours = totalMinutes / 60;
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(hours)} ч`;
}

function renderLimitsSpeedSummary(series) {
  if (!limitsSpeedSummary) return;
  if (limitsState.mode !== "speed") {
    limitsSpeedSummary.hidden = true;
    limitsSpeedSummary.replaceChildren();
    return;
  }
  const items = (Array.isArray(series) ? series : [])
    .filter((item) => !item.hidden)
    .map((item) => ({
      item,
      latest: item.ratePoints?.at(-1),
      point: item.ratePoints?.findLast((point) => Number.isFinite(point.actualRate)),
    }))
    .filter(({ latest, point }) => latest || point);
  if (!items.length) {
    limitsSpeedSummary.hidden = true;
    limitsSpeedSummary.replaceChildren();
    return;
  }
  const cards = items.map(({ item, latest, point }) => {
    const name = [item.name || item.baseId || item.id, item.window].filter(Boolean).join(" · ");
    const waiting = shouldWaitForBurnRateData(
      limitsState.speedFullWindow,
      latest,
      limitsState.range,
    );
    if (waiting) {
      return el("section", { class: "limits-speed-summary-card is-waiting" }, [
        el("span", { class: "limits-speed-summary-name", text: name }),
        el("div", { class: "limits-speed-summary-rates" }, [
          el("span", { text: "После сброса ещё не накоплен полный интервал скорости." }),
        ]),
        el("strong", { class: "limits-speed-summary-status", text: "Ожидание данных" }),
      ]);
    }
    if (!point) return null;
    const actualPeriod = formatLimitRateForPeriod(point.actualRate);
    const targetPeriod = formatLimitRateForPeriod(point.targetRate);
    const periodSuffix = burnRatePeriodSuffix();
    const ratio = point.targetRate > 0 ? point.actualRate / point.targetRate : Number.POSITIVE_INFINITY;
    const overTarget = point.overTarget;
    const status = overTarget
      ? Number.isFinite(ratio)
        ? `Чтобы лимита хватило, снизьте темп в ${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(ratio)} раза`
        : "Лимит уже исчерпан"
      : "Текущий темп укладывается в допустимый";
    return el("section", {
      class: `limits-speed-summary-card ${overTarget ? "is-over-target" : "is-safe"}`,
    }, [
      el("span", { class: "limits-speed-summary-name", text: name }),
      el("div", { class: "limits-speed-summary-rates" }, [
        el("span", {}, ["Сейчас ", el("strong", { text: `${actualPeriod}${periodSuffix}` })]),
        el("span", {}, ["Допустимо ", el("strong", { text: `${targetPeriod}${periodSuffix}` })]),
        el("span", {}, ["Интервал расчёта ", el("strong", {
          text: formatBurnRateSampleSpan(point.sampleSpanMs),
        })]),
      ]),
      el("strong", { class: "limits-speed-summary-status", text: status }),
    ]);
  }).filter(Boolean);
  limitsSpeedSummary.hidden = false;
  limitsSpeedSummary.replaceChildren(...cards);
}

/* Легенда показывает все доступные серии, включая скрытые. Каждая запись —
 * настоящая кнопка-переключатель (aria-pressed = «серия видима»), скрытая серия
 * приглушена и перечёркнута через класс is-hidden. */
function renderLimitsLegend(series) {
  if (!limitsLegend) return;
  limitsLegend.replaceChildren(...series.map((item) => {
    const last = item.points[item.points.length - 1];
    const used = last ? Math.round(Number(last.usedPercent) || 0) : null;
    const rate = limitsState.mode === "speed"
      ? item.ratePoints?.findLast((point) => Number.isFinite(point.actualRate))
      : null;
    const name = item.accountLabel
      ? `${item.accountLabel} · ${item.name || item.baseId || item.id || ""}`
      : item.name || item.id || "";
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
      rate
        ? el("span", {
          class: `limits-legend-value limits-speed-value${rate.overTarget ? " is-over-target" : " is-safe"}`,
          text: `${Math.round(rate.actualRate)}% / ${Math.round(rate.targetRate)}% в неделю`,
          title: "Фактическая / допустимая скорость в неделю",
        })
        : limitsState.mode === "speed"
          ? el("span", { class: "limits-legend-value", text: "Недостаточно истории" })
          : used != null ? el("span", { class: "limits-legend-value", text: `Расход ${used}%` }) : null,
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
  if (info.mode === "speed") {
    const actual = Math.round(Number(info.actualRate) || 0);
    const target = Math.round(Number(info.targetRate) || 0);
    const actualPeriod = formatLimitRateForPeriod(info.actualRate);
    const targetPeriod = formatLimitRateForPeriod(info.targetRate);
    const periodSuffix = burnRatePeriodSuffix();
    const deviation = actual - target;
    const status = deviation > 0
      ? `выше допустимой на ${deviation}%`
      : `запас ${Math.abs(deviation)}%`;
    const name = info.window ? `${info.name} · ${info.window}` : info.name;
    const estimate = info.estimated ? ". Оценка по соседним замерам" : "";
    return `${name}. ${time}: ${actualPeriod}${periodSuffix} (${actual}% в неделю), допустимо ${targetPeriod}${periodSuffix} (${target}% в неделю), ${status}${estimate}`;
  }
  const used = Math.round(Number(info.used) || 0);
  const remaining = info.remaining == null
    ? Math.max(0, 100 - used)
    : Math.round(Number(info.remaining) || 0);
  const name = info.window ? `${info.name} · ${info.window}` : info.name;
  return `${name}. ${time}: израсходовано ${used}%, осталось ${remaining}%`;
}

function positionChartTooltip(element, fx, fy, options) {
  const positioning = globalThis.AgentHubTooltipPosition;
  if (positioning?.applyTooltipPosition) {
    return positioning.applyTooltipPosition(element, fx, fy, options);
  }
  if (!element) return null;
  const x = clampNumber(fx, 0.08, 0.92);
  const y = clampNumber(fy, 0.14, 0.86);
  element.style.left = `${(x * 100).toFixed(3).replace(/\.?0+$/u, "")}%`;
  element.style.top = `${(y * 100).toFixed(3).replace(/\.?0+$/u, "")}%`;
  element.dataset.side = x > 0.6 ? "left" : "right";
  return { x, y, side: element.dataset.side };
}

function showLimitsTooltip(info, fx, fy) {
  if (!limitsTooltip) return;
  if (info.mode === "speed") {
    const actual = Math.round(Number(info.actualRate) || 0);
    const target = Math.round(Number(info.targetRate) || 0);
    const actualPeriod = formatLimitRateForPeriod(info.actualRate);
    const targetPeriod = formatLimitRateForPeriod(info.targetRate);
    const periodSuffix = burnRatePeriodSuffix();
    const deviation = actual - target;
    limitsTooltip.replaceChildren(
      el("span", { class: "limits-tooltip-title", text: info.window ? `${info.name} · ${info.window}` : info.name }),
      el("span", { class: "limits-tooltip-time", text: formatLimitsDateTime(info.at) }),
      el("span", { class: "limits-tooltip-row", text: `Сейчас ${actualPeriod}${periodSuffix} · допустимо ${targetPeriod}${periodSuffix}` }),
      el("span", { class: "limits-tooltip-row", text: `${actual}%/нед. · допустимо ${target}%/нед.` }),
      el("span", {
        class: `limits-tooltip-row limits-speed-deviation${deviation > 0 ? " is-over-target" : " is-safe"}`,
        text: deviation > 0
          ? `Перерасход скорости +${deviation}%`
          : `Запас скорости ${Math.abs(deviation)}%`,
      }),
      ...(info.estimated ? [el("span", {
        class: "limits-tooltip-row",
        text: "Оценка: изменение равномерно распределено между соседними замерами",
      })] : []),
    );
    positionChartTooltip(limitsTooltip, fx, fy);
    limitsTooltip.hidden = false;
    return;
  }
  const used = Math.round(Number(info.used) || 0);
  const remaining = info.remaining == null
    ? Math.max(0, 100 - used)
    : Math.round(Number(info.remaining) || 0);
  limitsTooltip.replaceChildren(
    el("span", { class: "limits-tooltip-title", text: info.window ? `${info.name} · ${info.window}` : info.name }),
    el("span", { class: "limits-tooltip-time", text: formatLimitsDateTime(info.at) }),
    el("span", { class: "limits-tooltip-row", text: `Расход ${used}% · остаток ${remaining}%` }),
  );
  positionChartTooltip(limitsTooltip, fx, fy);
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

limitsModes?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-limits-mode]");
  if (button) selectLimitsMode(button.dataset.limitsMode);
});

limitsSpeedFullWindow?.addEventListener("change", () => {
  limitsState.speedFullWindow = limitsSpeedFullWindow.checked;
  try {
    localStorage.setItem(LIMITS_SPEED_FULL_WINDOW_KEY, String(limitsState.speedFullWindow));
  } catch {
    // Настройка останется активной до закрытия WebView.
  }
  renderLimitsModes();
  renderLimits();
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
  if (data?.turnTimeMode && normalizeTurnTimeMode(data.turnTimeMode) !== turnTimeMode) return;
  usageState.payload = data;
  usageState.error = data?.error ? String(data.error) : "";
  if (data?.range) usageState.range = normalizeRange(data.range);
  usageState.status = statusFromUsagePayload(data);
  renderUsageRanges();
  renderUsageHistory();
}

function requestUsageHistory(range, { force = false } = {}) {
  usageState.range = persistRange(localStorage, USAGE_RANGE_KEY, range);
  const cached = usageState.payload
    && !usageState.payload.error
    && normalizeRange(usageState.payload.range) === usageState.range
    && normalizeTurnTimeMode(usageState.payload.turnTimeMode) === turnTimeMode;
  usageState.status = cached && !force ? statusFromUsagePayload(usageState.payload) : "loading";
  usageState.error = "";
  renderUsageRanges();
  renderUsageHistory();
  emit("usage:open", { range: usageState.range, turnTimeMode });
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
  if (!(hours > 0)) return "—/ч";
  const perHour = credits / hours;
  return `${formatUsageValue(perHour)}/ч`;
}

function formatUsageIntensity(credits, durationSeconds) {
  const perMinute = durationSeconds > 0 ? credits / durationSeconds * 60 : 0;
  return `${formatUsageValue(perMinute)}/мин`;
}

function formatUsageMinuteRate(creditsPerMinute) {
  if (creditsPerMinute == null || !Number.isFinite(Number(creditsPerMinute))) return "—";
  return `${formatUsageValue(Math.max(0, Number(creditsPerMinute) || 0))}/мин`;
}

function usageRateCredits(source) {
  return usageState.rateBasis === "task"
    ? Math.max(0, Number(source?.timedCredits) || 0)
    : Math.max(0, Number(source?.credits ?? source?.totalCredits) || 0);
}

function usageRateHours(source, calendarHours) {
  return usageState.rateBasis === "task"
    ? Math.max(0, Number(source?.taskDurationSeconds ?? source?.durationSeconds) || 0) / 3600
    : calendarHours;
}

function usageRateBasisLabel() {
  return usageState.rateBasis === "task" ? "по времени задач" : "по календарному времени";
}

function usageBurnRateAnalysis(payload) {
  const calculator = globalThis.AgentHubUsageBurnRate?.buildUsageBurnRate;
  return typeof calculator === "function" ? calculator(payload) : null;
}

function usagePayloadPeriodMinutes(payload) {
  const from = Date.parse(payload?.from ?? "");
  const to = Date.parse(payload?.to ?? "");
  const minutes = (to - from) / 60_000;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 1;
}

function formatUsageMinutes(value) {
  const minutes = Math.max(0, Number(value) || 0);
  if (minutes < 120) return `${Math.round(minutes)} мин`;
  const hours = minutes / 60;
  return `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 }).format(hours)} ч`;
}

const usageBurnSummaryHelp = {
  "EMA сейчас": "Формула: EMAₙ = α × bucketRateₙ + (1 − α) × EMAₙ₋₁, где α считается из полураспада; bucketRate = расход bucket / минуты bucket.",
  "Средняя за день": "Формула: средняя = расход с 00:00 / минуты с 00:00 до текущего момента.",
  "Средняя диапазона": "Формула: средняя = расход выбранного диапазона / длительность выбранного диапазона в минутах.",
  "Рабочая интенсивность": "Формула: рабочая интенсивность = сумма расхода ходов с известной длительностью / сумма длительностей этих ходов.",
  "Прогноз суток": "Формула: прогноз = уже потрачено сегодня + EMA сейчас × оставшиеся минуты суток.",
};

function usageBurnSummaryCard(name, value, detail, status = "") {
  const help = usageBurnSummaryHelp[name] ?? "";
  return el("section", { class: `usage-burn-summary-card${status ? ` ${status}` : ""}` }, [
    el("span", { class: "usage-burn-summary-name-row" }, [
      el("span", { class: "usage-burn-summary-name", text: name }),
      help
        ? el("button", {
          type: "button",
          class: "usage-burn-summary-help",
          "aria-label": `${name}: ${help}`,
          title: help,
          text: "?",
        })
        : null,
    ]),
    el("strong", { class: "usage-burn-summary-value", text: value }),
    el("span", { class: "usage-burn-summary-detail", text: detail }),
  ]);
}

function renderUsageBurnSummary(payload, analysis = usageBurnRateAnalysis(payload)) {
  if (!usageBurnSummary) return;
  if (usageState.mode !== "intensity" || !payload || payload.error || !analysis) {
    usageBurnSummary.hidden = true;
    usageBurnSummary.replaceChildren();
    return;
  }
  const periodRate = analysis.totalCredits / usagePayloadPeriodMinutes(payload);
  const averageName = analysis.forecastAvailable ? "Средняя за день" : "Средняя диапазона";
  const averageValue = formatUsageMinuteRate(
    analysis.forecastAvailable ? analysis.calendarDayRate : periodRate,
  );
  const forecastValue = analysis.forecastAvailable
    ? formatUsageValue(analysis.forecastDay)
    : "—";
  const forecastDetail = analysis.forecastAvailable
    ? `по EMA, осталось ${formatUsageMinutes(analysis.remainingDayMinutes)}`
    : "прогноз доступен на диапазоне 24 ч";
  usageBurnSummary.hidden = false;
  usageBurnSummary.replaceChildren(
    usageBurnSummaryCard(
      "EMA сейчас",
      formatUsageMinuteRate(analysis.emaRate),
      `календарно, полураспад ${analysis.halfLifeMinutes} мин`,
    ),
    usageBurnSummaryCard(
      averageName,
      averageValue,
      analysis.forecastAvailable ? "расход / время с полуночи" : "расход / выбранный период",
    ),
    usageBurnSummaryCard(
      "Рабочая интенсивность",
      analysis.workRate == null ? "—" : formatUsageMinuteRate(analysis.workRate),
      "только ходы с известной длительностью",
    ),
    usageBurnSummaryCard(
      "Прогноз суток",
      forecastValue,
      forecastDetail,
      analysis.forecastAvailable ? "is-forecast" : "is-muted",
    ),
  );
}

function showUsageTooltip(point, fx, fy, daily = false, hours = 0) {
  if (!usageTooltip) return;
  usageTooltip.replaceChildren(
    el("span", { class: "limits-tooltip-time", text: formatUsagePointDate(point, daily) }),
    el("span", {
      class: "limits-tooltip-row",
      text: usageState.mode === "rate"
        ? formatUsageRate(usageRateCredits(point), usageRateHours(point, hours))
        : usageState.mode === "intensity"
          ? `EMA ${formatUsageMinuteRate(point.emaRate)} · bucket ${formatUsageMinuteRate(point.rawRate)}`
          : formatUsageValue(point.credits),
    }),
  );
  positionChartTooltip(usageTooltip, fx, fy);
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
  const burnAnalysis = usageState.mode === "intensity" ? usageBurnRateAnalysis(payload) : null;
  const burnPointsByTime = new Map((burnAnalysis?.points ?? []).map((point) => [point.time, point]));
  const points = (Array.isArray(payload?.points) ? payload.points : [])
    .map((point) => {
      const time = Date.parse(point.at);
      const burnPoint = burnPointsByTime.get(time);
      return {
        at: point.at,
        time,
        credits: Math.max(0, Number(point.credits) || 0),
        timedCredits: Math.max(0, Number(point.timedCredits) || 0),
        durationSeconds: Math.max(0, Number(point.durationSeconds) || 0),
        taskDurationSeconds: Math.max(0, Number(point.taskDurationSeconds ?? point.durationSeconds) || 0),
        rawRate: Math.max(0, Number(burnPoint?.rawRate) || 0),
        emaRate: Math.max(0, Number(burnPoint?.emaRate) || 0),
      };
    })
    .filter((point) => Number.isFinite(point.time));
  const daily = payload?.bucket === "day";
  const rate = usageState.mode === "rate";
  const intensity = usageState.mode === "intensity";
  const hours = usageBucketHours(payload);
  const valueOf = (point) => {
    if (rate) {
      const rateHours = usageRateHours(point, hours);
      return rateHours > 0 ? usageRateCredits(point) / rateHours : 0;
    }
    return intensity
      ? point.emaRate
      : point.credits;
  };
  const formatValue = (value) => (
    rate ? `${formatUsageValue(value)}/ч` : intensity ? `${formatUsageValue(value)}/мин` : formatUsageValue(value)
  );
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
    }, [formatValue(value)]));
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
          rate
            ? formatUsageRate(usageRateCredits(point), usageRateHours(point, hours))
            : intensity
              ? `EMA ${formatUsageMinuteRate(point.emaRate)} · bucket ${formatUsageMinuteRate(point.rawRate)}`
              : formatUsageValue(point.credits)
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
      if (valueOf(point) <= 0) continue;
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
      ? `Скорость расхода ${usageRateBasisLabel()} за ${formatUsagePeriod(payload)}.`
      : intensity
        ? `EMA-поглощение расхода за ${formatUsagePeriod(payload)}.`
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
  const intensity = usageState.mode === "intensity";
  const burnAnalysis = intensity && payload && !payload.error ? usageBurnRateAnalysis(payload) : null;
  if (usageTitle) {
    usageTitle.textContent = rate
      ? "Скорость расхода"
      : intensity
        ? "Поглощение cr"
        : "Локальный расход";
  }
  for (const button of usageModes?.querySelectorAll("[data-usage-mode]") ?? []) {
    const active = button.dataset.usageMode === usageState.mode;
    button.setAttribute("aria-pressed", String(active));
    button.toggleAttribute("data-active", active);
  }
  usageSubtitle.textContent = payload && !payload.error
    ? `${formatUsagePeriod(payload)}${rate ? ` · ${usageRateBasisLabel()}` : intensity ? " · календарная EMA 60 мин" : ""}`
    : RANGE_LABELS[usageState.range] ?? "";
  /* В режиме скорости итог за период бессмыслен: показывается средний расход
     в час, то есть та же величина, что и на столбиках. */
  usageTotal.textContent = payload && !payload.error
    ? (rate
      ? formatUsageRate(
        usageRateCredits(payload),
        usageRateHours(payload, usagePeriodHours(payload)),
      )
      : intensity
        ? formatUsageMinuteRate(burnAnalysis?.emaRate)
        : formatUsageValue(payload.totalCredits))
    : "";
  if (status !== "ready") renderUsageBurnSummary(null, null);
  if (status === "ready") {
    buildUsageChart(payload);
    renderUsageBurnSummary(payload, burnAnalysis);
    if (intensity) {
      usageNote.textContent = burnAnalysis?.forecastAvailable
        ? "EMA считает календарный темп расхода cr/мин; прогноз суток не использует неизвестные лимиты Codex или Claude."
        : "EMA считает календарный темп cr/мин. Суточный прогноз показывается только на диапазоне 24 ч, где известен расход с полуночи.";
    } else {
      renderUsageBurnSummary(null, null);
      const unpriced = Math.max(0, Number(payload.unpricedCount) || 0);
      const untimed = Math.max(0, Number(payload.untimedCount ?? payload.untimedCreditCount) || 0);
      const notes = [];
      if (unpriced) notes.push(`Без тарифа и вне суммы: ${unpriced}.`);
      if (rate && usageState.rateBasis === "task" && untimed) {
        notes.push(`Без длительности и вне скорости по времени задач: ${untimed}.`);
      }
      usageNote.textContent = notes.join(" ") || "Все показанные ходы тарифицированы и имеют длительность.";
    }
  }
}

function renderComparisonViewModeOptions() {
  for (const button of comparisonViewModeButtons) {
    const active = button.dataset.comparisonViewMode === comparisonState.viewMode;
    button.setAttribute("aria-pressed", String(active));
    button.toggleAttribute("data-active", active);
  }
}

function selectComparisonViewMode(value) {
  const next = normalizeComparisonViewMode(value);
  if (next === comparisonState.viewMode) return;
  comparisonState.viewMode = next;
  try {
    localStorage.setItem(COMPARISON_VIEW_MODE_KEY, next);
  } catch {
    // Выбор останется активным до закрытия WebView.
  }
  renderComparisonViewModeOptions();
  renderUsageComparison();
}

bindDatasetChoice(comparisonViewModeButtons, "comparisonViewMode", selectComparisonViewMode);

usageRanges?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (button) requestUsageHistory(button.dataset.range);
});
/* Расход, календарная скорость и интенсивность хода считаются из одних данных,
   поэтому переключение режима ничего не запрашивает — просто перерисовывает карточку. */
usageModes?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-usage-mode]");
  if (!button) return;
  usageState.mode = ["rate", "intensity"].includes(button.dataset.usageMode)
    ? button.dataset.usageMode
    : "total";
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

/* --------------------------------------- сопоставление локального и API расхода */

function comparisonPayloadStatus(payload) {
  if (!payload || payload.error) return payload?.error ? "error" : "empty";
  if (payload.limits?.error || payload.usage?.error) return "error";
  return statusFromPayload(payload.limits) === "ready"
    && statusFromUsagePayload(payload.usage) === "ready"
    ? "ready"
    : "empty";
}

function applyUsageComparison(payload) {
  const data = payload && typeof payload === "object" ? payload : null;
  if (data?.turnTimeMode && normalizeTurnTimeMode(data.turnTimeMode) !== turnTimeMode) return;
  if (data?.seriesId && String(data.seriesId) !== comparisonState.seriesId) return;
  if (data?.accountKey && String(data.accountKey) !== resolvedStatisticsAccountKey(data?.limits)) return;
  comparisonState.payload = data;
  if (data?.range) comparisonState.range = normalizeRange(data.range);
  comparisonState.status = comparisonPayloadStatus(data);
  comparisonState.error = String(
    data?.error || data?.limits?.error || data?.usage?.error || "",
  );
  renderStatisticsAccountSelects(data?.limits);
  renderComparisonRanges();
  renderUsageComparison();
}

function requestUsageComparison(range, { force = false } = {}) {
  comparisonState.range = persistRange(localStorage, COMPARISON_RANGE_KEY, range);
  const cached = comparisonState.payload
    && !comparisonState.payload.error
    && normalizeRange(comparisonState.payload.range) === comparisonState.range
    && String(comparisonState.payload.seriesId ?? "") === comparisonState.seriesId
    && String(comparisonState.payload.accountKey ?? "") === resolvedStatisticsAccountKey()
    && normalizeTurnTimeMode(comparisonState.payload.turnTimeMode) === turnTimeMode;
  comparisonState.status = cached && !force
    ? comparisonPayloadStatus(comparisonState.payload)
    : "loading";
  comparisonState.error = "";
  renderComparisonRanges();
  renderUsageComparison();
  emit("comparison:open", {
    range: comparisonState.range,
    seriesId: comparisonState.seriesId,
    accountKey: resolvedStatisticsAccountKey(),
    turnTimeMode,
  });
}

function selectComparisonSeries(id) {
  const seriesId = String(id ?? "");
  if (!seriesId || seriesId === comparisonState.seriesId) return;
  comparisonState.seriesId = seriesId;
  try {
    localStorage.setItem(COMPARISON_SERIES_KEY, seriesId);
  } catch {
    // Выбор останется активным до закрытия WebView.
  }
  requestUsageComparison(comparisonState.range, { force: true });
}

function renderComparisonRanges() {
  for (const button of comparisonRanges?.querySelectorAll("[data-range]") ?? []) {
    const active = button.dataset.range === comparisonState.range;
    button.setAttribute("aria-pressed", String(active));
    button.toggleAttribute("data-active", active);
  }
}

function comparisonHistoryExtent(payload) {
  const limitTimes = (Array.isArray(payload?.limits?.series) ? payload.limits.series : [])
    .flatMap((series) => Array.isArray(series.points) ? series.points : [])
    .map((point) => Date.parse(point.at))
    .filter(Number.isFinite);
  const usageTimes = (Array.isArray(payload?.usage?.points) ? payload.usage.points : [])
    .map((point) => Date.parse(point.at))
    .filter(Number.isFinite);
  const limitFrom = Date.parse(payload?.limits?.from ?? "");
  const usageFrom = Date.parse(payload?.usage?.from ?? "");
  const limitTo = Date.parse(payload?.limits?.to ?? "");
  const usageTo = Date.parse(payload?.usage?.axisTo ?? payload?.usage?.to ?? "");
  const starts = [limitFrom, usageFrom].filter(Number.isFinite);
  const ends = [limitTo, usageTo].filter(Number.isFinite);
  const from = starts.length
    ? Math.max(...starts)
    : Math.max(Math.min(...limitTimes), Math.min(...usageTimes));
  const to = ends.length
    ? Math.min(...ends)
    : Math.min(Math.max(...limitTimes), Math.max(...usageTimes));
  return Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null;
}

function comparisonBuckets(payload, extent) {
  const points = (Array.isArray(payload?.points) ? payload.points : [])
    .map((point) => ({
      at: point.at,
      time: Date.parse(point.at),
      credits: Math.max(0, Number(point.credits) || 0),
    }))
    .filter((point) => Number.isFinite(point.time))
    .sort((left, right) => left.time - right.time);
  const inferredStep = points.length > 1 ? points[1].time - points[0].time : Number.NaN;
  const step = Math.max(1, Number(payload?.bucketMs) || inferredStep || 3_600_000);
  return points.map((point, index) => {
    const next = points[index + 1]?.time ?? point.time + step;
    const start = Math.max(extent.from, point.time);
    const end = Math.min(extent.to, Math.max(point.time + 1, next));
    return {
      ...point,
      start,
      end,
      time: start + Math.max(1, end - start) / 2,
    };
  }).filter((point) => point.end > point.start);
}

function pearsonCorrelation(left, right) {
  const pairs = left.map((value, index) => [value, right[index]])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pairs.length < 3) return null;
  const meanX = pairs.reduce((sum, [x]) => sum + x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, [, y]) => sum + y, 0) / pairs.length;
  let numerator = 0;
  let squareX = 0;
  let squareY = 0;
  for (const [x, y] of pairs) {
    const dx = x - meanX;
    const dy = y - meanY;
    numerator += dx * dy;
    squareX += dx * dx;
    squareY += dy * dy;
  }
  const denominator = Math.sqrt(squareX * squareY);
  return denominator > 0 ? clampNumber(numerator / denominator, -1, 1) : null;
}

function limitDeltasByBucket(series, buckets) {
  return rateLimitDeltasByBuckets(series?.points, buckets);
}

function normalizeComparisonValues(values) {
  const peak = Math.max(0, ...values.filter(Number.isFinite));
  return {
    peak,
    values: values.map((value) => (
      Number.isFinite(value) ? (peak > 0 ? value / peak * 100 : 0) : null
    )),
  };
}

function comparisonLimitPrice(localValues, apiValues, buckets) {
  const sample = (from, to) => {
    let credits = 0;
    let limitPoints = 0;
    let count = 0;
    for (let index = from; index < to; index += 1) {
      const local = localValues[index];
      const api = apiValues[index];
      if (!(local > 0) || !Number.isFinite(api)) continue;
      credits += local;
      limitPoints += Math.max(0, api);
      count += 1;
    }
    return credits > 0 && count > 0
      ? { value: limitPoints / (credits / 1_000), credits, limitPoints, count }
      : null;
  };
  const windowSize = clampNumber(Math.round(buckets.length / 10), 2, 5);
  const values = buckets.map((_, index) => (
    sample(Math.max(0, index - windowSize + 1), index + 1)?.value ?? null
  ));
  const midpoint = buckets.findIndex((bucket) => bucket.time >= (
    buckets[0].time + (buckets.at(-1).time - buckets[0].time) / 2
  ));
  const split = midpoint > 0 ? midpoint : Math.ceil(buckets.length / 2);
  const early = sample(0, split);
  const late = sample(split, buckets.length);
  const changePercent = early?.value > 0 && Number.isFinite(late?.value)
    ? (late.value / early.value - 1) * 100
    : null;
  return { values, early, late, changePercent, windowSize };
}

function buildUsageComparisonModel(payload) {
  const extent = comparisonHistoryExtent(payload);
  if (!extent) return null;
  const buckets = comparisonBuckets(payload.usage, extent);
  if (!buckets.length) return null;
  const localRaw = buckets.map((bucket) => bucket.credits);
  const local = normalizeComparisonValues(localRaw);
  if (!(local.peak > 0)) return null;
  const accountKey = resolvedStatisticsAccountKey(payload?.limits);
  const rawSeries = (Array.isArray(payload?.limits?.series) ? payload.limits.series : [])
    .filter((item) => item.baseId)
    .map((item) => ({ ...item, points: statisticsSeriesPoints(item, accountKey) }));
  const allSeries = rawSeries
    .filter((item) => Array.isArray(item.points) && item.points.length > 1)
    .map((item, index) => {
      const id = seriesId(item);
      const rawValues = limitDeltasByBucket(item, buckets);
      const normalized = normalizeComparisonValues(rawValues);
      return {
        ...item,
        id,
        color: seriesColor(item, index),
        peak: normalized.peak,
        rawValues,
        values: normalized.values,
        correlation: normalized.peak > 0
          ? pearsonCorrelation(local.values, normalized.values)
          : null,
        deviation: normalized.peak > 0
          ? meanSignedComparisonDeviation(normalized.values, local.values)
          : null,
      };
    });
  const selectedSeries = allSeries.find((series) => series.id === comparisonState.seriesId)
    ?? allSeries.find((series) => series.baseId === "codex:primary")
    ?? allSeries[0]
    ?? null;
  if (selectedSeries && selectedSeries.id !== comparisonState.seriesId) {
    comparisonState.seriesId = selectedSeries.id;
    try {
      localStorage.setItem(COMPARISON_SERIES_KEY, selectedSeries.id);
    } catch {
      // Выбор останется активным до закрытия WebView.
    }
  }
  const visibleSeries = selectedSeries?.peak > 0 ? [selectedSeries] : [];
  const aggregate = selectedSeries?.peak > 0 ? selectedSeries.values : buckets.map(() => null);
  const deviationValues = signedComparisonDeviations(aggregate, local.values);
  const differenceValues = [...deviationValues];
  const price = selectedSeries
    ? comparisonLimitPrice(localRaw, selectedSeries.rawValues, buckets)
    : comparisonLimitPrice([], [], buckets);
  return {
    extent,
    buckets,
    local: { ...local, rawValues: localRaw },
    allSeries,
    selectedSeries,
    visibleSeries,
    aggregate,
    deviationValues,
    differenceValues,
    correlation: pearsonCorrelation(local.values, aggregate),
    deviation: meanSignedComparisonDeviation(aggregate, local.values),
    price,
  };
}

function comparisonPath(values, buckets, xOf, yOf) {
  let path = "";
  let continuing = false;
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) {
      continuing = false;
      return;
    }
    path += `${continuing ? " L" : "M"}${xOf(buckets[index].time).toFixed(1)} ${yOf(value).toFixed(1)}`;
    continuing = true;
  });
  return path;
}

function formatComparisonNumber(value, digits = 2, signed = false) {
  return Number(value).toLocaleString("ru-RU", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
    signDisplay: signed ? "always" : "auto",
  });
}

function correlationStrength(value) {
  if (!Number.isFinite(value)) return "недостаточно данных";
  const strength = Math.abs(value);
  const label = strength >= 0.75 ? "сильная" : strength >= 0.5 ? "заметная" : strength >= 0.25 ? "слабая" : "почти отсутствует";
  return value < 0 ? `${label}, обратная` : label;
}

function comparisonTooltipText(info) {
  if (info.detail) return `${info.name}. ${formatLimitsDateTime(info.at)}: ${info.detail}`;
  if (info.kind === "cost") {
    return `${info.name}. ${formatLimitsDateTime(info.at)}: ${formatComparisonNumber(info.raw, 2)} п.п./kcr`;
  }
  const value = `${Math.round(info.value)}% пика`;
  const raw = info.kind === "local"
    ? formatUsageValue(info.raw)
    : info.kind === "deviation"
      ? `${formatComparisonNumber(info.raw, 1)} п.п.`
      : `+${formatComparisonNumber(info.raw, 1)} п.п.`;
  return `${info.name}. ${formatLimitsDateTime(info.at)}: ${value}, ${raw}`;
}

function comparisonPriceAxisMax(values) {
  const maximum = Math.max(0, ...values.filter(Number.isFinite));
  if (!(maximum > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  return Math.ceil(maximum / magnitude * 2) / 2 * magnitude;
}

function showComparisonTooltip(info, fx, fy, source = comparisonChart) {
  if (!comparisonTooltip) return;
  comparisonTooltip.replaceChildren(
    el("span", { class: "limits-tooltip-title", text: info.name }),
    el("span", { class: "limits-tooltip-time", text: formatLimitsDateTime(info.at) }),
    el("span", { class: "limits-tooltip-row", text: comparisonTooltipText(info).split(": ").at(-1) }),
  );
  const wrapRect = comparisonChartWrap?.getBoundingClientRect();
  const sourceRect = source?.getBoundingClientRect();
  const positionedX = wrapRect?.width && sourceRect?.width
    ? (sourceRect.left - wrapRect.left + fx * sourceRect.width) / wrapRect.width
    : fx;
  const positionedY = wrapRect?.height && sourceRect?.height
    ? (sourceRect.top - wrapRect.top + fy * sourceRect.height) / wrapRect.height
    : fy;
  positionChartTooltip(comparisonTooltip, positionedX, positionedY);
  comparisonTooltip.hidden = false;
}

function hideComparisonTooltip() {
  if (comparisonTooltip) comparisonTooltip.hidden = true;
}

function appendComparisonMarkers(svg, values, rawValues, model, chart, options) {
  const points = values.map((value, index) => Number.isFinite(value) ? {
    x: chart.xOf(model.buckets[index].time),
    y: chart.yOf(value),
    value,
    raw: rawValues[index],
    at: new Date(model.buckets[index].time).toISOString(),
  } : null).filter(Boolean);
  limitsMarkerPoints(points, 16).forEach((point) => {
    const isLast = point === points.at(-1);
    const info = { ...point, name: options.name, kind: options.kind };
    const circle = svgEl("circle", {
      cx: point.x,
      cy: point.y,
      r: isLast ? 3.8 : 2.5,
      class: `limits-point comparison-point comparison-point-${options.kind}`,
      fill: options.color,
    });
    const fx = point.x / chart.W;
    const fy = point.y / chart.H;
    circle.addEventListener("pointerenter", () => showComparisonTooltip(info, fx, fy, svg));
    circle.addEventListener("pointerleave", hideComparisonTooltip);
    if (isLast) {
      circle.setAttribute("tabindex", "0");
      circle.setAttribute("role", "img");
      circle.setAttribute("aria-label", comparisonTooltipText(info));
      circle.addEventListener("focus", () => showComparisonTooltip(info, fx, fy, svg));
      circle.addEventListener("blur", hideComparisonTooltip);
    }
    svg.append(circle);
  });
}

function buildUsageComparisonChart(model) {
  const W = chartWidth(comparisonChart);
  const H = 260;
  const padL = 46;
  const padR = 64;
  const padT = 14;
  const padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const span = Math.max(1, model.extent.to - model.extent.from);
  const xOf = (time) => padL + ((time - model.extent.from) / span) * plotW;
  const minimumDeviation = Math.min(0, ...model.deviationValues.filter(Number.isFinite));
  const yMinimum = Math.max(-100, Math.floor(minimumDeviation / 25) * 25);
  const ySpan = 100 - yMinimum;
  const yOf = (value) => padT + ((100 - clampNumber(value, yMinimum, 100)) / ySpan) * plotH;
  const priceMax = comparisonPriceAxisMax(model.price.values);
  const yOfPrice = (value) => padT + (1 - clampNumber(value, 0, priceMax) / priceMax) * plotH;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "limits-chart-svg comparison-chart-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });
  const yTicks = [...new Set([yMinimum, 0, 25, 50, 75, 100])].sort((left, right) => left - right);
  for (const value of yTicks) {
    const y = yOf(value);
    svg.append(svgEl("line", {
      x1: padL,
      y1: y,
      x2: W - padR,
      y2: y,
      class: value === 0 && yMinimum < 0 ? "comparison-zero-line" : "limits-grid-line",
    }));
    svg.append(svgEl("text", {
      x: padL - 6,
      y: y + 3,
      class: "limits-axis-label limits-axis-y",
      "text-anchor": "end",
    }, [`${value}%`]));
  }
  for (const fraction of [0, 0.5, 1]) {
    const value = priceMax * fraction;
    svg.append(svgEl("text", {
      x: W - padR + 7,
      y: yOfPrice(value) + 3,
      class: "limits-axis-label limits-axis-y comparison-cost-axis",
      "text-anchor": "start",
    }, [formatComparisonNumber(value, value < 10 ? 2 : 1)]));
  }
  svg.append(svgEl("text", {
    x: W - 4,
    y: padT - 3,
    class: "limits-axis-label limits-axis-y comparison-cost-axis",
    "text-anchor": "end",
  }, ["п.п./kcr"]));
  const dayMs = 24 * 60 * 60_000;
  if (span > dayMs * 1.5) {
    const first = new Date(model.extent.from);
    first.setHours(0, 0, 0, 0);
    const days = [];
    for (let time = first.getTime(); time <= model.extent.to; time += dayMs) {
      if (time >= model.extent.from) days.push(time);
    }
    const step = Math.max(1, Math.ceil(days.length / Math.max(1, Math.floor(plotW / 46))));
    days.forEach((time, index) => {
      if (index % step) return;
      const x = xOf(time);
      svg.append(svgEl("line", { x1: x, y1: padT, x2: x, y2: padT + plotH, class: "limits-grid-line limits-grid-day" }));
      svg.append(svgEl("text", {
        x, y: H - 20, class: "limits-axis-label limits-axis-x", "text-anchor": "middle",
      }, [new Date(time).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })]));
      svg.append(svgEl("text", {
        x, y: H - 7, class: "limits-axis-label limits-axis-x usage-axis-weekday", "text-anchor": "middle",
      }, [weekdayLabel(time)]));
    });
  } else {
    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      const time = model.extent.from + span * fraction;
      svg.append(svgEl("text", {
        x: xOf(time),
        y: H - 8,
        class: "limits-axis-label limits-axis-x",
        "text-anchor": fraction === 0 ? "start" : fraction === 1 ? "end" : "middle",
      }, [formatAxisTime(time, span)]));
    }
  }
  const deviationPath = comparisonPath(model.deviationValues, model.buckets, xOf, yOf);
  if (deviationPath) svg.append(svgEl("path", {
    d: deviationPath,
    class: "comparison-deviation-line",
    fill: "none",
  }));
  for (const series of model.visibleSeries) {
    const path = comparisonPath(series.values, model.buckets, xOf, yOf);
    if (!path) continue;
    svg.append(svgEl("path", {
      d: path,
      class: "limits-series-line comparison-api-line",
      fill: "none",
      stroke: series.color,
    }));
    appendComparisonMarkers(svg, series.values, series.rawValues, model, {
      W, H, xOf, yOf,
    }, {
      name: comparisonSeriesName(series),
      kind: "api",
      color: series.color,
    });
  }
  const localPath = comparisonPath(model.local.values, model.buckets, xOf, yOf);
  svg.append(svgEl("path", { d: localPath, class: "comparison-local-line", fill: "none" }));
  appendComparisonMarkers(svg, model.local.values, model.buckets.map((bucket) => bucket.credits), model, {
    W, H, xOf, yOf,
  }, {
    name: "Локальный расход",
    kind: "local",
    color: "var(--comparison-local)",
  });
  const pricePath = comparisonPath(model.price.values, model.buckets, xOf, yOfPrice);
  if (pricePath) {
    svg.append(svgEl("path", { d: pricePath, class: "comparison-cost-line", fill: "none" }));
    appendComparisonMarkers(svg, model.price.values, model.price.values, model, {
      W, H, xOf, yOf: yOfPrice,
    }, {
      name: "Цена лимита",
      kind: "cost",
      color: "var(--comparison-cost)",
    });
  }
  if (!model.visibleSeries.length) {
    svg.append(svgEl("text", {
      x: padL + plotW / 2,
      y: padT + plotH / 2,
      class: "limits-empty-plot",
      "text-anchor": "middle",
    }, ["Нет изменений выбранного лимита API"]));
  }
  const correlation = Number.isFinite(model.correlation)
    ? formatComparisonNumber(model.correlation, 2, true)
    : "не рассчитана";
  comparisonChart.setAttribute(
    "aria-label",
    `Сопоставление локального и API-расхода. Корреляция ${correlation}; среднее отклонение ${
      Number.isFinite(model.deviation) ? `${formatComparisonNumber(model.deviation, 1, true)} процентного пункта` : "не рассчитано"
    }; изменение цены ${
      Number.isFinite(model.price.changePercent)
        ? `${formatComparisonNumber(model.price.changePercent, 0, true)} процента`
        : "не рассчитано"
    }.`,
  );
  comparisonChart.replaceChildren(svg);
}

function comparisonUsageUnitLabel() {
  return usageUnit === "pte" ? "ПТЭ" : usageUnit === "rub" ? "₽" : usageUnit;
}

function comparisonNumericAxisMax(values) {
  const maximum = Math.max(0, ...values.filter(Number.isFinite));
  if (!(maximum > 0)) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(maximum));
  const scaled = maximum / magnitude;
  const factor = [1, 2, 5, 10].find((candidate) => candidate >= scaled) ?? 10;
  return factor * magnitude;
}

function comparisonTimeTicks(model, width) {
  const span = Math.max(1, model.extent.to - model.extent.from);
  const count = clampNumber(Math.floor(width / 90), 2, 6);
  return Array.from({ length: count }, (_, index) => (
    model.extent.from + span * index / Math.max(1, count - 1)
  ));
}

function appendComparisonTimeGrid(svg, model, chart, { labels = true } = {}) {
  const ticks = comparisonTimeTicks(model, chart.plotW);
  for (const [index, time] of ticks.entries()) {
    const x = chart.xOf(time);
    svg.append(svgEl("line", {
      x1: x,
      y1: chart.padT,
      x2: x,
      y2: chart.padT + chart.plotH,
      class: "limits-grid-line limits-grid-day",
    }));
    if (!labels) continue;
    svg.append(svgEl("text", {
      x,
      y: chart.H - 8,
      class: "limits-axis-label limits-axis-x",
      "text-anchor": index === 0 ? "start" : index === ticks.length - 1 ? "end" : "middle",
    }, [formatAxisTime(time, model.extent.to - model.extent.from)]));
  }
}

function appendRawComparisonMarkers(svg, values, model, chart, options) {
  const points = values.map((value, index) => Number.isFinite(value) ? {
    x: chart.xOf(model.buckets[index].time),
    y: chart.yOf(value),
    raw: value,
    at: new Date(model.buckets[index].time).toISOString(),
  } : null).filter(Boolean);
  limitsMarkerPoints(points, 14).forEach((point) => {
    const detail = options.format(point.raw);
    const info = { ...point, name: options.name, kind: options.kind, detail };
    const circle = svgEl("circle", {
      cx: point.x,
      cy: point.y,
      r: point === points.at(-1) ? 3.6 : 2.3,
      class: `limits-point comparison-point comparison-point-${options.kind}`,
      fill: options.color,
    });
    const fx = point.x / chart.W;
    const fy = point.y / chart.H;
    circle.addEventListener("pointerenter", () => showComparisonTooltip(info, fx, fy, svg));
    circle.addEventListener("pointerleave", hideComparisonTooltip);
    if (point === points.at(-1)) {
      circle.setAttribute("tabindex", "0");
      circle.setAttribute("role", "img");
      circle.setAttribute("aria-label", comparisonTooltipText(info));
      circle.addEventListener("focus", () => showComparisonTooltip(info, fx, fy, svg));
      circle.addEventListener("blur", hideComparisonTooltip);
    }
    svg.append(circle);
  });
}

function buildComparisonTimeChart(target, model, options) {
  if (!target) return;
  const W = chartWidth(target);
  const H = 176;
  const padL = 78;
  const padR = 16;
  const padT = 25;
  const padB = options.showDates ? 38 : 14;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const span = Math.max(1, model.extent.to - model.extent.from);
  const axisMax = comparisonNumericAxisMax(options.values);
  const xOf = (time) => padL + ((time - model.extent.from) / span) * plotW;
  const yOf = (value) => padT + (1 - clampNumber(value, 0, axisMax) / axisMax) * plotH;
  const chart = { W, H, padL, padR, padT, padB, plotW, plotH, xOf, yOf };
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "limits-chart-svg comparison-chart-svg comparison-split-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });
  svg.append(svgEl("text", {
    x: padL,
    y: 13,
    class: "comparison-panel-label",
  }, [options.axisTitle]));
  for (const fraction of [0, 0.5, 1]) {
    const value = axisMax * fraction;
    const y = yOf(value);
    svg.append(svgEl("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "limits-grid-line" }));
    svg.append(svgEl("text", {
      x: padL - 7,
      y: y + 3,
      class: "limits-axis-label limits-axis-y",
      "text-anchor": "end",
    }, [options.formatTick(value)]));
  }
  appendComparisonTimeGrid(svg, model, chart, { labels: options.showDates });
  const path = comparisonPath(options.values, model.buckets, xOf, yOf);
  if (path) svg.append(svgEl("path", {
    d: path,
    class: `comparison-split-line ${options.lineClass}`,
    fill: "none",
    stroke: options.color,
  }));
  appendRawComparisonMarkers(svg, options.values, model, chart, options);
  target.setAttribute("aria-label", `${options.axisTitle}. Пик ${options.formatTick(axisMax)}.`);
  target.replaceChildren(svg);
}

function comparisonRegression(pairs) {
  if (pairs.length < 2) return null;
  const meanX = pairs.reduce((sum, point) => sum + point.x, 0) / pairs.length;
  const meanY = pairs.reduce((sum, point) => sum + point.y, 0) / pairs.length;
  const variance = pairs.reduce((sum, point) => sum + (point.x - meanX) ** 2, 0);
  if (!(variance > 0)) return null;
  const slope = pairs.reduce((sum, point) => sum + (point.x - meanX) * (point.y - meanY), 0) / variance;
  return { slope, intercept: meanY - slope * meanX };
}

function buildComparisonScatterChart(model) {
  if (!comparisonScatterChart) return;
  const series = model.selectedSeries;
  const pairs = model.buckets.map((bucket, index) => ({
    x: series?.rawValues[index],
    y: model.local.rawValues[index],
    at: new Date(bucket.time).toISOString(),
  })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  const W = chartWidth(comparisonScatterChart);
  const H = 240;
  const padL = 70;
  const padR = 18;
  const padT = 30;
  const padB = 48;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const xMax = comparisonNumericAxisMax(pairs.map((point) => point.x));
  const yMax = comparisonNumericAxisMax(pairs.map((point) => point.y));
  const xOf = (value) => padL + clampNumber(value, 0, xMax) / xMax * plotW;
  const yOf = (value) => padT + (1 - clampNumber(value, 0, yMax) / yMax) * plotH;
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "limits-chart-svg comparison-chart-svg comparison-split-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });
  for (const fraction of [0, 0.5, 1]) {
    const xValue = xMax * fraction;
    const yValue = yMax * fraction;
    svg.append(svgEl("line", { x1: xOf(xValue), y1: padT, x2: xOf(xValue), y2: padT + plotH, class: "limits-grid-line" }));
    svg.append(svgEl("line", { x1: padL, y1: yOf(yValue), x2: W - padR, y2: yOf(yValue), class: "limits-grid-line" }));
    svg.append(svgEl("text", {
      x: xOf(xValue), y: H - 27, class: "limits-axis-label limits-axis-x", "text-anchor": "middle",
    }, [formatComparisonNumber(xValue, xValue < 10 ? 1 : 0)]));
    svg.append(svgEl("text", {
      x: padL - 7, y: yOf(yValue) + 3, class: "limits-axis-label limits-axis-y", "text-anchor": "end",
    }, [formatUsageValue(yValue)]));
  }
  svg.append(svgEl("text", {
    x: padL + plotW / 2, y: H - 7, class: "comparison-axis-title", "text-anchor": "middle",
  }, ["Расход лимита, п.п."]));
  svg.append(svgEl("text", {
    x: padL, y: 13, class: "comparison-panel-label",
  }, [`Локальный расход, ${comparisonUsageUnitLabel()}`]));
  svg.append(svgEl("text", {
    x: W - padR, y: 13, class: "comparison-correlation-label", "text-anchor": "end",
  }, [`r ${Number.isFinite(model.correlation) ? formatComparisonNumber(model.correlation, 2, true) : "—"}`]));
  const regression = comparisonRegression(pairs);
  if (regression) {
    const fromY = clampNumber(regression.intercept, 0, yMax);
    const toY = clampNumber(regression.intercept + regression.slope * xMax, 0, yMax);
    svg.append(svgEl("line", {
      x1: xOf(0), y1: yOf(fromY), x2: xOf(xMax), y2: yOf(toY), class: "comparison-regression-line",
    }));
  }
  for (const point of pairs) {
    const circle = svgEl("circle", {
      cx: xOf(point.x),
      cy: yOf(point.y),
      r: 3.5,
      class: "comparison-scatter-point",
      fill: series?.color || "var(--accent)",
    });
    const info = {
      ...point,
      name: "Связь расходов",
      detail: `лимит +${formatComparisonNumber(point.x, 1)} п.п.; локально ${formatUsageValue(point.y)}`,
    };
    circle.addEventListener("pointerenter", () => showComparisonTooltip(info, xOf(point.x) / W, yOf(point.y) / H, svg));
    circle.addEventListener("pointerleave", hideComparisonTooltip);
    svg.append(circle);
  }
  if (!pairs.length) svg.append(svgEl("text", {
    x: padL + plotW / 2, y: padT + plotH / 2, class: "limits-empty-plot", "text-anchor": "middle",
  }, ["Нет совпадающих точек"]));
  comparisonScatterChart.setAttribute(
    "aria-label",
    `Связь расходов по ${pairs.length} совпадающим интервалам. Корреляция ${
      Number.isFinite(model.correlation) ? formatComparisonNumber(model.correlation, 2, true) : "не рассчитана"
    }.`,
  );
  comparisonScatterChart.replaceChildren(svg);
}

function buildComparisonDifferenceChart(model) {
  if (!comparisonDifferenceChart) return;
  const values = model.differenceValues;
  const W = chartWidth(comparisonDifferenceChart);
  const H = 240;
  const padL = 52;
  const padR = 16;
  const padT = 28;
  const padB = 42;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const span = Math.max(1, model.extent.to - model.extent.from);
  const maximum = comparisonNumericAxisMax(values.map((value) => Math.abs(value)));
  const xOf = (time) => padL + ((time - model.extent.from) / span) * plotW;
  const yOf = (value) => padT + (maximum - clampNumber(value, -maximum, maximum)) / (maximum * 2) * plotH;
  const chart = { W, H, padL, padR, padT, padB, plotW, plotH, xOf, yOf };
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "limits-chart-svg comparison-chart-svg comparison-split-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });
  svg.append(svgEl("text", { x: padL, y: 13, class: "comparison-panel-label" }, ["Разность, п.п. от пика"]));
  for (const value of [-maximum, 0, maximum]) {
    const y = yOf(value);
    svg.append(svgEl("line", {
      x1: padL, y1: y, x2: W - padR, y2: y, class: value === 0 ? "comparison-zero-line" : "limits-grid-line",
    }));
    svg.append(svgEl("text", {
      x: padL - 7, y: y + 3, class: "limits-axis-label limits-axis-y", "text-anchor": "end",
    }, [formatComparisonNumber(value, 0, value !== 0)]));
  }
  appendComparisonTimeGrid(svg, model, chart);
  const barWidth = clampNumber(plotW / Math.max(1, values.length) * 0.68, 1, 12);
  values.forEach((value, index) => {
    if (!Number.isFinite(value)) return;
    const x = xOf(model.buckets[index].time);
    const zeroY = yOf(0);
    const valueY = yOf(value);
    const rect = svgEl("rect", {
      x: x - barWidth / 2,
      y: Math.min(zeroY, valueY),
      width: barWidth,
      height: Math.max(1, Math.abs(valueY - zeroY)),
      class: `comparison-difference-bar ${value >= 0 ? "is-api-higher" : "is-local-higher"}`,
      fill: value >= 0 ? (model.selectedSeries?.color || "var(--accent)") : "var(--comparison-local)",
    });
    const at = new Date(model.buckets[index].time).toISOString();
    const info = {
      name: "Разность аккаунт − локально",
      at,
      detail: `${formatComparisonNumber(value, 1, true)} п.п.; ${value >= 0 ? "аккаунт выше" : "локальный расход выше"}`,
    };
    rect.addEventListener("pointerenter", () => showComparisonTooltip(info, x / W, valueY / H, svg));
    rect.addEventListener("pointerleave", hideComparisonTooltip);
    svg.append(rect);
  });
  const largest = Math.max(0, ...values.filter(Number.isFinite).map(Math.abs));
  comparisonDifferenceChart.setAttribute(
    "aria-label",
    `Разность нормированных расходов аккаунта и локального расхода. Максимальное расхождение ${formatComparisonNumber(largest, 1)} процентного пункта.`,
  );
  comparisonDifferenceChart.replaceChildren(svg);
}

function buildUsageComparisonSplitCharts(model) {
  const series = model.selectedSeries;
  buildComparisonTimeChart(comparisonLocalChart, model, {
    values: model.local.rawValues,
    axisTitle: `Локальный расход, ${comparisonUsageUnitLabel()}`,
    color: "var(--comparison-local)",
    lineClass: "comparison-local-line",
    name: "Локальный расход",
    kind: "local-raw",
    formatTick: (value) => formatUsageValue(value),
    format: (value) => formatUsageValue(value),
    showDates: false,
  });
  buildComparisonTimeChart(comparisonApiChart, model, {
    values: series?.rawValues ?? model.buckets.map(() => null),
    axisTitle: "Расход выбранного лимита, п.п.",
    color: series?.color || "var(--accent)",
    lineClass: "comparison-api-line",
    name: series ? comparisonSeriesName(series) : "Выбранный лимит",
    kind: "api-raw",
    formatTick: (value) => formatComparisonNumber(value, value < 10 ? 1 : 0),
    format: (value) => `+${formatComparisonNumber(value, 1)} п.п.`,
    showDates: true,
  });
  buildComparisonScatterChart(model);
  buildComparisonDifferenceChart(model);
}

function comparisonLegendItem(name, color, value, attrs = {}) {
  const swatch = el("span", { class: "limits-legend-swatch", "aria-hidden": "true" });
  swatch.style.setProperty("--series-color", color);
  return el("li", { class: "limits-legend-item" }, [
    el("span", { class: "limits-legend-toggle comparison-legend-static", ...attrs }, [
      swatch,
      el("span", { class: "limits-legend-name", text: name }),
      value ? el("span", { class: "limits-legend-value", text: value }) : null,
    ]),
  ]);
}

function comparisonSeriesName(series) {
  return series?.window
    ? `${series.name} · ${series.window}`
    : String(series?.name || series?.id || "Лимит");
}

function comparisonSeriesPicker(model) {
  const selected = model.selectedSeries;
  const select = el("select", {
    "aria-label": "Лимит для сопоставления",
    "data-comparison-series-select": "",
  });
  select.append(...model.allSeries.map((series) => el("option", {
    value: series.id,
    text: comparisonSeriesName(series),
    selected: series.id === selected?.id,
  })));
  select.addEventListener("change", () => selectComparisonSeries(select.value));
  const swatch = el("span", { class: "limits-legend-swatch", "aria-hidden": "true" });
  swatch.style.setProperty("--series-color", selected?.color || "var(--accent)");
  const metrics = selected && Number.isFinite(selected.correlation)
    ? `r ${formatComparisonNumber(selected.correlation, 2, true)} · Δ ${formatComparisonNumber(selected.deviation, 1, true)} п.п.`
    : selected ? "нет изменений" : "нет данных";
  const item = el("li", { class: "limits-legend-item comparison-series-picker" }, [
    swatch,
    select,
    el("span", { class: "limits-legend-value", text: metrics }),
  ]);
  enhanceThemedSelect(select);
  return item;
}

function comparisonPriceText(price) {
  if (!Number.isFinite(price?.early?.value) || !Number.isFinite(price?.late?.value)) return "недостаточно данных";
  const change = Number.isFinite(price.changePercent)
    ? ` · ${formatComparisonNumber(price.changePercent, 0, true)}%`
    : "";
  return `${formatComparisonNumber(price.early.value, 2)} → ${formatComparisonNumber(price.late.value, 2)} п.п./kcr${change}`;
}

function renderComparisonLegend(model) {
  if (!comparisonLegend) return;
  const entries = [
    comparisonSeriesPicker(model),
    comparisonLegendItem("Локальный расход", "var(--comparison-local)", `пик ${formatUsageValue(model.local.peak)}`),
  ];
  entries.push(comparisonLegendItem(
    "Отклонение",
    "var(--comparison-deviation)",
    Number.isFinite(model.deviation) ? `${formatComparisonNumber(model.deviation, 1, true)} п.п.` : "—",
  ));
  entries.push(comparisonLegendItem(
    "Цена лимита",
    "var(--comparison-cost)",
    comparisonPriceText(model.price),
  ));
  comparisonLegend.replaceChildren(...entries);
}

function renderComparisonSummary(model) {
  if (!comparisonSummary) return;
  const correlation = Number.isFinite(model?.correlation)
    ? formatComparisonNumber(model.correlation, 2, true)
    : "—";
  const deviation = Number.isFinite(model?.deviation) ? `${formatComparisonNumber(model.deviation, 1, true)} п.п.` : "—";
  const priceChange = Number.isFinite(model?.price?.changePercent)
    ? `${formatComparisonNumber(model.price.changePercent, 0, true)}%`
    : "—";
  const priceClass = model?.price?.changePercent > 0
    ? " is-costlier"
    : model?.price?.changePercent < 0 ? " is-cheaper" : "";
  comparisonSummary.hidden = false;
  comparisonSummary.replaceChildren(
    el("span", { class: "comparison-metric", title: `Корреляция: ${correlationStrength(model?.correlation)}` }, [
      el("span", { text: "r" }),
      el("strong", { text: correlation }),
    ]),
    el("span", { class: "comparison-metric", title: "Среднее знаковое отклонение: расход аккаунта минус локальный" }, [
      el("span", { text: "Δ" }),
      el("strong", { text: deviation }),
    ]),
    el("span", {
      class: `comparison-metric${priceClass}`,
      title: `Цена лимита, первая → вторая половина: ${comparisonPriceText(model?.price)}`,
    }, [
      el("span", { text: "Цена" }),
      el("strong", { text: priceChange }),
    ]),
  );
}

function renderUsageComparison() {
  if (!comparisonLoading) return;
  const status = comparisonState.status;
  comparisonLoading.hidden = status !== "loading";
  comparisonError.hidden = status !== "error";
  comparisonEmpty.hidden = status !== "empty";
  comparisonChartWrap.hidden = status !== "ready";
  hideComparisonTooltip();
  if (comparisonSummary) comparisonSummary.hidden = status !== "ready";
  if (status === "error") {
    comparisonErrorText.textContent = comparisonState.error || "Не удалось сопоставить расход.";
  }
  const payload = comparisonState.payload;
  const extent = payload && !payload.error ? comparisonHistoryExtent(payload) : null;
  if (comparisonSubtitle) {
    comparisonSubtitle.textContent = extent
      ? `${RANGE_LABELS[comparisonState.range]} · ${formatLimitsDateTime(extent.from)} — ${formatLimitsDateTime(extent.to)}`
      : RANGE_LABELS[comparisonState.range] ?? "";
  }
  if (status !== "ready") return;
  const model = buildUsageComparisonModel(payload);
  if (!model) {
    comparisonState.status = "empty";
    renderUsageComparison();
    return;
  }
  const split = comparisonState.viewMode === "split";
  if (comparisonCombinedView) comparisonCombinedView.hidden = split;
  if (comparisonSplitView) comparisonSplitView.hidden = !split;
  if (split) buildUsageComparisonSplitCharts(model);
  else buildUsageComparisonChart(model);
  if (comparisonNote) {
    comparisonNote.textContent = split
      ? "Временные графики используют исходные единицы и общую ось дат. Точки показывают совпадающие интервалы. Разность считается как нормированный расход аккаунта минус локальный: выше нуля — больше расход лимита, ниже нуля — больше локальный расход. Изменение лимита между соседними замерами равномерно распределяется по их интервалу. Цена остаётся в итоговом показателе."
      : "При выборе аккаунта локальный расход учитывает только ходы, завершённые в интервалах его активности. Пункт «Все» снимает отбор аккаунта. Изменение лимита между соседними замерами равномерно распределяется по их интервалу; неизменное значение считается нулевым расходом. Линии расхода приведены к собственному пику. r — корреляция Пирсона, Δ — среднее знаковое отклонение «аккаунт − локально»: минусы и плюсы взаимно компенсируются. Цена — расход лимита в п.п. на 1 kcr. Изменение цены сравнивает первую и вторую половины периода.";
  }
  renderComparisonLegend(model);
  renderComparisonSummary(model);
}

comparisonRanges?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-range]");
  if (button) requestUsageComparison(button.dataset.range);
});
document.querySelector("[data-comparison-retry]")?.addEventListener("click", () => {
  requestUsageComparison(comparisonState.range, { force: true });
});

/* ================================================================ ЖУРНАЛ */
/* Ниже — прежняя логика журнала: рендер, ленивая подгрузка старых дней и
 * ходов, сохранение раскрытых секций и переносы лимитов в шапку. Она не
 * изменилась по поведению; поменялось только то, что журнал теперь живёт в
 * отдельной вкладке общей оболочки и грузится при первом открытии. */

const OPEN_STATE_KEY = "agent-hub:journal-open-state:v1";
let currentVersion = "";
const loadingDays = new Map();
const loadingTurns = new Map();
const journalDayHtmlCache = new Map();
let journalRendered = false;
let journalRequested = false;
let desiredOpenState = null;

function requestHeaders() {
  if (telegramMode) return { Authorization: `tma ${telegramInitData}` };
  // Trusted devices authenticate with the HttpOnly session cookie the Hub set at
  // /api/device/session, so no credential passes through page JavaScript.
  return {};
}

async function authenticatedRequestHeaders() {
  await window.AgentHubBrowserDevice?.ensureSession?.();
  return requestHeaders();
}

function selectorValue(value) {
  return CSS.escape(String(value ?? ""));
}

function workLogDayKey(details) {
  const heading = details?.querySelector("summary[data-work-log-day] strong");
  return heading?.dataset.workLogDate
    ?? plainDateText(heading?.textContent)
    ?? String(details?.dataset.lazyDay ?? "").trim();
}

function captureOpenState() {
  return {
    days: [...journal.querySelectorAll("details[data-work-log-day-section][open]")]
      .map(workLogDayKey)
      .filter(Boolean),
    previous: [...journal.querySelectorAll("details[data-work-log-previous-turns][open]")]
      .map((item) => item.closest("[data-work-log-row]")?.dataset.workLogThreadId)
      .filter(Boolean),
    workspacePrevious: [...journal.querySelectorAll(
      "[data-work-log-workspace-turns] details[data-work-log-previous-turns][open]",
    )].map((item) => item.closest("[data-work-log-workspace]")?.dataset.workLogWorkspaceId)
      .filter(Boolean),
    taskUsage: [...journal.querySelectorAll("details[data-task-usage-details][open]")]
      .map((item) => item.closest("[data-work-log-row]")?.dataset.workLogThreadId)
      .filter(Boolean),
    workspaceUsage: [...journal.querySelectorAll(
      "details[data-work-log-workspace-usage-details][open]",
    )].map((item) => item.closest("[data-work-log-workspace]")?.dataset.workLogWorkspaceId)
      .filter(Boolean),
    workspaces: [...journal.querySelectorAll("details[data-work-log-workspace][open]")]
      .map((item) => item.dataset.workLogWorkspaceId)
      .filter(Boolean),
    streams: [...journal.querySelectorAll("details[data-work-log-stream][open]")]
      .map((item) => ({
        workspaceId: item.closest("[data-work-log-workspace]")?.dataset.workLogWorkspaceId,
        streamId: item.dataset.workLogStreamId,
      }))
      .filter((item) => item.workspaceId && item.streamId),
    turns: [...journal.querySelectorAll("details[data-work-log-turn-details][open]")]
      .map((item) => item.closest("[data-work-log-turn-id]")?.dataset.workLogTurnId)
      .filter(Boolean),
    subagents: [...journal.querySelectorAll("details[data-work-log-turn-children-details][open]")]
      .map((item) => item.closest("[data-work-log-turn-id]")?.dataset.workLogTurnId)
      .filter(Boolean),
    mobileDays: [...journal.querySelectorAll("[data-day-usage-table][data-mobile-expanded]")]
      .map((item) => workLogDayKey(item.closest("details[data-work-log-day-section]")))
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
  const restoredDays = openState.days.map(plainDateText).filter(Boolean);
  const days = surface === "mobile" ? restoredDays.slice(0, 1) : restoredDays;
  for (const day of days) {
    for (const details of journal.querySelectorAll("details[data-work-log-day-section]")) {
      if (workLogDayKey(details) === day) {
        details.open = true;
      }
    }
  }
  for (const threadId of openState.previous) {
    journal.querySelector(
      `[data-work-log-thread-id="${selectorValue(threadId)}"] details[data-work-log-previous-turns]`,
    )?.setAttribute("open", "");
  }
  for (const workspaceId of openState.workspacePrevious ?? []) {
    journal.querySelector(
      `[data-work-log-workspace-id="${selectorValue(workspaceId)}"] `
      + "details[data-work-log-previous-turns]",
    )?.setAttribute("open", "");
  }
  for (const threadId of openState.taskUsage) {
    journal.querySelector(
      `[data-work-log-thread-id="${selectorValue(threadId)}"] details[data-task-usage-details]`,
    )?.setAttribute("open", "");
  }
  for (const workspaceId of openState.workspaceUsage ?? []) {
    journal.querySelector(
      `[data-work-log-workspace-id="${selectorValue(workspaceId)}"] `
      + "details[data-work-log-workspace-usage-details]",
    )?.setAttribute("open", "");
  }
  if (Array.isArray(openState.workspaces)) {
    for (const details of journal.querySelectorAll("details[data-work-log-workspace]")) {
      details.open = false;
    }
    for (const workspaceId of openState.workspaces) {
      journal.querySelector(
        `details[data-work-log-workspace-id="${selectorValue(workspaceId)}"]`,
      )?.setAttribute("open", "");
    }
  }
  if (Array.isArray(openState.streams)) {
    for (const details of journal.querySelectorAll("details[data-work-log-stream]")) {
      details.open = false;
    }
    for (const stream of openState.streams) {
      journal.querySelector(
        `[data-work-log-workspace-id="${selectorValue(stream.workspaceId)}"] `
        + `details[data-work-log-stream-id="${selectorValue(stream.streamId)}"]`,
      )?.setAttribute("open", "");
    }
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
      if (workLogDayKey(details) !== plainDateText(day)) {
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

async function fetchJournalDayFragments() {
  await localSessionReady;
  const query = new URLSearchParams({ version: currentVersion });
  const response = await fetch(`/api/journal/days?${query}`, {
    cache: "no-store",
    headers: await authenticatedRequestHeaders(),
  });
  const payload = await response.json();
  if (response.status === 409 || payload.version && payload.version !== currentVersion) {
    void loadJournal({ force: true });
    throw new Error("Журнал обновился.");
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload.days && typeof payload.days === "object" ? payload.days : {};
}

function materializeLazyDay(details, html, {
  decorate = true,
  postProcess = true,
} = {}) {
  if (!details?.isConnected) return null;
  const template = document.createElement("template");
  template.innerHTML = String(html ?? "").trim();
  const replacement = template.content.firstElementChild;
  if (!replacement?.matches("details[data-work-log-day-section]")) {
    throw new Error("Некорректный фрагмент дня.");
  }
  replacement.open = true;
  if (decorate) {
    upgradeLegacyWorkspaceGroups(replacement);
    decorateDayHeadings(replacement);
    decorateLegacyStreamTurns(replacement);
    groupClaudeRowsInDay(replacement);
  }
  const renderedDay = grouping === "date" && details.hasAttribute("data-journal-ledger-row")
    ? dayGroupingContent(replacement).firstElementChild
    : replacement;
  if (!renderedDay) throw new Error("Не удалось собрать день журнала.");
  renderedDay.open = true;
  details.replaceWith(renderedDay);
  if (postProcess) {
    refreshUsageUnits(renderedDay);
    disableLocalLinks(renderedDay);
    syncCollapseTurnButtons(renderedDay);
  }
  return renderedDay;
}

async function loadLazyDay(details) {
  const date = details?.dataset.lazyDay;
  if (!date || !details.isConnected) return;
  if (loadingDays.has(date)) return loadingDays.get(date);
  desiredOpenState = captureOpenState();
  details.setAttribute("aria-busy", "true");
  const promise = (async () => {
    let html = journalDayHtmlCache.get(date);
    if (!html) {
      const payload = await fetchJournalFragment("/api/journal/day", { date });
      html = payload.html;
      journalDayHtmlCache.set(date, html);
    }
    if (!details.isConnected) return;
    materializeLazyDay(details, html);
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
  return JournalView.formatDurationHours(value);
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
  const meta = copy.querySelector("[data-work-log-turn-meta]");
  if (meta) {
    const completedAt = new Date(copy.dataset.workLogTurnCompletedAt ?? "");
    const time = Number.isFinite(completedAt.getTime())
      ? completedAt.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })
      : "—";
    const when = document.createElement("span");
    when.dataset.journalTurnWhen = "";
    const day = el("span", { "data-work-log-turn-day": "", text: `${date} · ` });
    when.append(day, document.createTextNode(time));
    const cost = document.createElement("span");
    cost.dataset.journalTurnCost = "";
    const credits = JournalView.turnDisplayCredits(copy.dataset);
    if (credits !== null) cost.append(usageBadge(formatUsageValue(credits), credits));
    else cost.textContent = "—";
    const share = copy.querySelector("[data-work-log-turn-share]")?.cloneNode(true);
    meta.replaceChildren(when, cost, ...(share ? [share] : []));
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

function upgradeLegacyWorkspaceGroups(scope = journal) {
  for (const workspace of [...scope.querySelectorAll("section[data-work-log-workspace]")]) {
    const details = document.createElement("details");
    for (const attribute of workspace.attributes) {
      details.setAttribute(attribute.name, attribute.value);
    }
    details.open = true;
    const header = workspace.querySelector(":scope > header[data-work-log-workspace-header]");
    const summary = document.createElement("summary");
    summary.dataset.workLogWorkspaceHeader = "";
    if (header) {
      const usageDetails = header.querySelector("details[data-work-log-workspace-usage-details]");
      const usageSummary = usageDetails?.querySelector("summary[data-work-log-workspace-usage-summary]");
      if (usageDetails && usageSummary) usageDetails.replaceWith(...usageSummary.childNodes);
      summary.append(...header.childNodes);
    }
    details.append(summary);
    for (const child of [...workspace.childNodes]) {
      if (child !== header) details.append(child);
    }
    workspace.replaceWith(details);
  }
}

function decorateLegacyStreamTurns(scope = journal) {
  for (const stream of scope.querySelectorAll("details[data-work-log-stream]")) {
    const label = stream.querySelector("[data-work-log-stream-title]")?.textContent
      ?.replace(/\s+/gu, " ").trim();
    if (!label) continue;
    for (const title of stream.querySelectorAll("[data-work-log-turn-title]")) {
      if (title.querySelector("[data-work-log-turn-stream]")) continue;
      const heading = document.createElement("span");
      heading.dataset.workLogTurnHeading = "";
      heading.append(...title.childNodes);
      const badge = document.createElement("span");
      badge.dataset.workLogTurnStream = "";
      badge.textContent = label;
      title.append(badge, heading);
    }
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
  return JournalView.periodIdentity(value, mode);
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
  const ordered = [...periods.values()].sort((left, right) => right.sort - left.sort)
    .map((period) => {
      const sourceDays = document.createElement("div");
      sourceDays.append(...period.days);
      return {
        ...period,
        group: combinedJournalGroup(taskGroupsFrom(sourceDays), {
          provider: `period-${mode}`,
          threadId: period.key,
        }),
      };
    });
  const cohort = ordered.map((period) => period.group);
  ordered.forEach((period, index) => {
    const section = journalGroupSection(period.group, cohort, {
      label: period.label,
      profileTitle: mode === "week" ? "Профиль недели" : "Профиль месяца",
      profileItemName: mode === "week" ? "Эта неделя" : "Этот месяц",
      profileCohortName: mode === "week" ? "видимых недель" : "видимых месяцев",
    });
    section.dataset.workLogPeriodSection = mode;
    section.open = index === 0;
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

function journalProfileMetrics(group) {
  const metrics = document.createElement("div");
  metrics.dataset.journalProfileMetrics = "";
  for (const axis of taskProfileAxes.slice(3)) {
    const item = document.createElement("div");
    item.dataset.journalProfileMetric = axis.key;
    const label = el("span", { text: axis.label });
    const value = el("strong", { text: formatProfileAxisValue(axis, group[axis.key]) });
    if (!Number.isFinite(group[axis.key])) item.dataset.missing = "";
    const detailItems = axis.detailItems?.(group) ?? [];
    const note = axis.detailNote?.(group) ?? "";
    if (detailItems.length || note) item.title = [...detailItems, note].filter(Boolean).join("\n");
    item.append(label, value);
    metrics.append(item);
  }
  return metrics;
}

function taskProfile(group, cohort, {
  title: profileTitle = "Профиль задачи",
  itemName = "Эта задача",
  cohortName = "видимых задач",
} = {}) {
  const comparableCohort = JournalView.profileCohort(cohort, group.provider);
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
  title.textContent = profileTitle;
  const caption = document.createElement("span");
  const providerLabel = group.provider === "claude"
    ? "Claude"
    : group.provider === "codex" ? "Codex" : "";
  caption.textContent = "vs медиана";
  caption.title = `Относительно ${cohortName}${providerLabel ? ` ${providerLabel}` : ""}. Больше — не лучше, а больше по масштабу.`;
  heading.append(title, caption);
  copy.append(heading);

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
      el("span", { text: `${itemName}: ${currentValue}` }),
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
      "aria-label": `${axis.label}. ${itemName}: ${
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
  legend.append(
    el("span", { "data-radar-legend": "current", text: itemName }),
    el("span", { "data-radar-legend": "baseline", text: "Медиана" }),
  );
  figure.append(svg, tooltip, legend);
  section.append(copy, figure);
  return section;
}

function taskGroupsFrom(source, { workspace = null, hierarchy = "" } = {}) {
  const groups = new Map();
  let order = 0;
  const days = source.matches?.("details[data-work-log-day-section]")
    ? [source]
    : [...source.querySelectorAll("details[data-work-log-day-section]")];
  for (const day of days) {
    const date = day.querySelector("summary[data-work-log-day] strong")?.dataset.workLogDate
      ?? plainDateText(day.querySelector("summary[data-work-log-day] strong")?.textContent);
    if (!date) continue;
    for (const row of day.querySelectorAll("[data-work-log-row]")) {
      if (workspace && row.closest("details[data-work-log-workspace]") !== workspace) continue;
      const provider = String(row.dataset.workLogProvider ?? "").trim();
      const sourceThreadId = String(row.dataset.workLogThreadId ?? "").trim();
      const workspaceDetails = row.closest("details[data-work-log-workspace]");
      const streamDetails = row.closest("details[data-work-log-stream]");
      const workspaceId = String(
        row.dataset.workLogWorkspaceId ?? workspaceDetails?.dataset.workLogWorkspaceId ?? "",
      ).trim();
      const streamId = String(
        row.dataset.workLogStreamId ?? streamDetails?.dataset.workLogStreamId ?? "",
      ).trim();
      const groupedClaude = groupClaudeTasks && provider === "claude";
      const identity = hierarchy
        ? JournalView.groupIdentity(
          { provider, threadId: sourceThreadId, workspaceId, streamId },
          hierarchy,
          groupedClaude,
        )
        : provider && sourceThreadId
          ? {
            key: `${provider}\u001f${groupedClaude ? "work" : sourceThreadId}`,
            provider,
            threadId: groupedClaude ? "work" : sourceThreadId,
          }
          : null;
      if (!identity) continue;
      const { key, provider: groupProvider, threadId } = identity;
      let group = groups.get(key);
      if (!group) {
        const workspaceTitle = workspaceDetails
          ?.querySelector(":scope > summary[data-work-log-workspace-header] strong")
          ?.textContent?.replace(/\s+/gu, " ").trim();
        const streamTitle = streamDetails
          ?.querySelector(":scope > summary [data-work-log-stream-title]")
          ?.textContent?.replace(/\s+/gu, " ").trim();
        const hierarchyTitle = hierarchy === "workspace"
          ? workspaceDetails?.querySelector(":scope > summary[data-work-log-workspace-header] strong")
          : hierarchy === "stream" && workspaceTitle && streamTitle
            ? el("span", { text: `${workspaceTitle} - ${streamTitle}` })
            : hierarchy === "stream"
              ? streamDetails?.querySelector(":scope > summary [data-work-log-stream-title]")
              : null;
        group = {
          provider: groupProvider,
          threadId,
          hierarchy,
          title: groupedClaude
            ? el("span", { "data-work-log-claude-work": "", text: "Claude - Work" })
            : hierarchyTitle?.cloneNode(true)
              ?? row.querySelector("[data-work-log-task-content]")?.cloneNode(true),
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
          streamLabels: new Set(),
          usageBreakdown: row.querySelector("[data-task-usage-breakdown]")?.cloneNode(true)
            ?? row.querySelector("[data-work-log-workspace-usage-breakdown]")?.cloneNode(true)
            ?? null,
          order: order++,
        };
        groups.set(key, group);
      }
      for (const entry of row.querySelectorAll("[data-work-log-turn-entry]")) {
        const turnIdentity = JournalView.turnIdentity(entry.dataset, {
          provider,
          threadId: sourceThreadId,
        });
        if (turnIdentity && group.seenTurns.has(turnIdentity)) continue;
        if (turnIdentity) group.seenTurns.add(turnIdentity);
        const streamLabel = entry.querySelector("[data-work-log-turn-stream]")?.textContent?.trim();
        if (streamLabel) group.streamLabels.add(streamLabel);
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
      streamLabels: [...group.streamLabels],
    }))
    .sort((left, right) => right.latestAt - left.latestAt || left.order - right.order);
}

function appendTaskGroupTurnPage(details, { nextPage = false } = {}) {
  const turns = taskGroupTurns.get(details);
  const body = details?.querySelector("[data-work-log-task-group-turns]");
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

function combinedJournalGroup(groups, { provider = "period", threadId = "period" } = {}) {
  const values = Array.isArray(groups) ? groups : [];
  const skillNames = new Set(values.flatMap((group) => group.skillNames ?? []));
  const mcpTools = new Set(values.flatMap((group) => group.mcpTools ?? []));
  const turns = values.flatMap((group) => group.turns ?? []).sort((left, right) => (
    (Date.parse(right.dataset.workLogTurnCompletedAt ?? "") || 0)
      - (Date.parse(left.dataset.workLogTurnCompletedAt ?? "") || 0)
  ));
  const knownCredits = values.reduce((sum, group) => sum + (Number(group.knownCredits) || 0), 0);
  const knownDurations = values.reduce((sum, group) => sum + (Number(group.knownDurations) || 0), 0);
  const knownFileTouches = values.reduce((sum, group) => sum + (Number(group.knownFileTouches) || 0), 0);
  const knownChangedLines = values.reduce((sum, group) => sum + (Number(group.knownChangedLines) || 0), 0);
  const knownSubagentTurns = values.reduce((sum, group) => sum + (Number(group.knownSubagentTurns) || 0), 0);
  const knownToolMetricTurns = values.reduce((sum, group) => sum + (Number(group.knownToolMetricTurns) || 0), 0);
  const subagentTurns = values.reduce((sum, group) => sum + (Number(group.subagentTurns) || 0), 0);
  return {
    provider,
    threadId,
    turns,
    turnCount: values.reduce((sum, group) => sum + (Number(group.turnCount) || 0), 0),
    legacy: values.flatMap((group) => group.legacy ?? []),
    credits: knownCredits
      ? values.reduce((sum, group) => sum + (Number(group.credits) || 0), 0)
      : null,
    knownCredits,
    unknownCredits: values.reduce((sum, group) => sum + (Number(group.unknownCredits) || 0), 0),
    durationSeconds: knownDurations
      ? values.reduce((sum, group) => sum + (Number(group.durationSeconds) || 0), 0)
      : null,
    knownDurations,
    unknownDurations: values.reduce((sum, group) => sum + (Number(group.unknownDurations) || 0), 0),
    fileTouches: knownFileTouches
      ? values.reduce((sum, group) => sum + (Number(group.fileTouches) || 0), 0)
      : null,
    knownFileTouches,
    changedLines: knownChangedLines
      ? values.reduce((sum, group) => sum + (Number(group.changedLines) || 0), 0)
      : null,
    knownChangedLines,
    subagentTurns,
    knownSubagentTurns,
    subagentShare: knownSubagentTurns ? subagentTurns / knownSubagentTurns * 100 : null,
    skillNames: [...skillNames].sort((left, right) => left.localeCompare(right)),
    skillCount: knownToolMetricTurns ? skillNames.size : null,
    mcpCallCount: knownToolMetricTurns
      ? values.reduce((sum, group) => sum + (Number(group.mcpCallCount) || 0), 0)
      : null,
    mcpFailures: values.reduce((sum, group) => sum + (Number(group.mcpFailures) || 0), 0),
    mcpTools: [...mcpTools].sort((left, right) => left.localeCompare(right)),
    knownToolMetricTurns,
    latestAt: Math.max(0, ...values.map((group) => Number(group.latestAt) || 0)),
    streamLabels: [...new Set(values.flatMap((group) => group.streamLabels ?? []))],
  };
}

function journalGroupTitle(group, label = "", { showStreams = true } = {}) {
  const cell = document.createElement("span");
  cell.dataset.journalLedgerTitle = "";
  const main = document.createElement("span");
  main.dataset.journalLedgerTitleText = "";
  if (label?.nodeType) main.append(label);
  else if (label) main.textContent = label;
  else if (group.title) {
    const title = group.title.cloneNode(true);
    const target = title.matches?.("[data-open-task]")
      ? title
      : title.querySelector?.("[data-open-task]") ?? title;
    let text = String(target.textContent ?? "").trim()
      .replace(/^(?:Codex|Claude)\s*[-—]\s*/iu, "");
    if (showStreams) {
      for (const streamLabel of group.streamLabels ?? []) {
        const escaped = String(streamLabel).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        text = text.replace(new RegExp(`\\s*[-—]\\s*${escaped}\\s*$`, "iu"), "");
      }
    }
    target.textContent = text || String(target.textContent ?? "").trim();
    main.append(title);
  }
  else main.textContent = `${group.provider} · ${group.threadId}`;
  cell.append(main);
  const streamLabels = group.streamLabels ?? [];
  if (showStreams && streamLabels.length) {
    cell.append(el("span", {
      "data-journal-stream-badge": "",
      text: streamLabels.length === 1 ? streamLabels[0] : `${streamLabels[0]} +${streamLabels.length - 1}`,
    }));
  }
  return cell;
}

function journalLedgerSummary(group, { label = "", showStreams = true } = {}) {
  const summary = document.createElement("summary");
  summary.dataset.workLogTaskGroupSummary = "";
  summary.dataset.journalLedgerSummary = "";
  const turns = el("span", {
    "data-journal-ledger-metric": "turns",
    text: group.lazy ? "—" : String(Math.max(0, Number(group.turnCount) || 0)),
  });
  const credits = el("span", { "data-journal-ledger-metric": "credits" });
  if (group.knownCredits) credits.append(usageBadge(formatUsageValue(group.credits), group.credits));
  else credits.textContent = "—";
  const duration = el("span", {
    "data-journal-ledger-metric": "duration",
    text: group.knownDurations ? formatTaskDuration(group.durationSeconds) : "—",
  });
  const gaps = el("span", {
    "data-journal-ledger-metric": "gaps",
    text: !group.lazy && group.unknownCredits ? String(group.unknownCredits) : "—",
  });
  summary.append(journalGroupTitle(group, label, { showStreams }), turns, credits, duration, gaps);
  return summary;
}

function journalGroupSection(group, cohort, {
  label = "",
  showStreams = true,
  profileTitle = "Профиль задачи",
  profileItemName = "Эта задача",
  profileCohortName = "видимых задач",
} = {}) {
  const details = document.createElement("details");
  details.dataset.workLogTaskGroup = "";
  details.dataset.journalLedgerRow = "";
  details.dataset.workLogProvider = group.provider;
  details.dataset.workLogThreadId = group.threadId;
  const expanded = document.createElement("div");
  expanded.dataset.journalLedgerExpanded = "";
  const overview = document.createElement("div");
  overview.dataset.journalGroupOverview = "";
  const body = document.createElement("div");
  body.dataset.journalTurnList = "";
  body.append(el("span", { "data-journal-section-label": "", text: "Ходы" }));
  const turnTable = document.createElement("div");
  turnTable.dataset.workLogTaskGroupTurns = "";
  turnTable.dataset.journalTurnTable = "";
  body.append(turnTable);
  overview.append(journalProfileMetrics(group), body);
  expanded.append(
    overview,
    taskProfile(group, cohort, {
      title: profileTitle,
      itemName: profileItemName,
      cohortName: profileCohortName,
    }),
  );
  details.append(journalLedgerSummary(group, { label, showStreams }), expanded);
  taskGroupTurns.set(details, [...group.turns, ...group.legacy]);
  return details;
}

function taskGroupingContent(source, mode) {
  const groups = taskGroupsFrom(source, { hierarchy: mode });
  if (!groups.length) return source.cloneNode(true);
  const list = document.createElement("div");
  list.dataset.workLogTaskGroups = "";
  groups.forEach((group, index) => {
    const details = journalGroupSection(group, groups, { showStreams: mode !== "stream" });
    details.open = index === 0;
    list.append(details);
  });
  return list;
}

function journalWeekday(date) {
  const parsed = parseJournalDate(date);
  return parsed
    ? new Intl.DateTimeFormat("ru-RU", { weekday: "short", timeZone: "UTC" })
      .format(parsed).replace(".", "")
    : "";
}

function dayGroupKey(group) {
  return `${group.provider}\u001f${group.threadId}`;
}

function workspaceGroupsFrom(day) {
  if (!day) return [];
  const workspaces = [...day.querySelectorAll("details[data-work-log-workspace]")];
  return workspaces.map((workspace, workspaceIndex) => {
    const workspaceId = String(workspace.dataset.workLogWorkspaceId ?? workspaceIndex);
    const workspaceKind = String(workspace.dataset.workLogWorkspaceKind ?? "workspace");
    const workspaceName = workspace.querySelector(
      ":scope > summary[data-work-log-workspace-header] strong",
    )?.textContent?.trim() || "Workspace";
    const group = combinedJournalGroup(taskGroupsFrom(day, { workspace }), {
      provider: "workspace",
      threadId: `${workspaceKind}:${workspaceId}`,
    });
    group.title = el("span", { text: workspaceName });
    group.workspaceName = workspaceName;
    group.workspaceUsage = workspace.querySelector(
      ":scope > [data-work-log-collapsed-workspace-usage] "
        + "> details[data-work-log-collapsed-workspace-usage-details]",
    )?.cloneNode(true) ?? null;
    if (group.workspaceUsage) group.workspaceUsage.open = true;
    return group;
  }).filter((group) => group.turnCount || group.legacy.length);
}

function dayGroupingContent(source) {
  const list = document.createElement("div");
  list.dataset.journalDayGroups = "";
  const days = source.matches?.("details[data-work-log-day-section]")
    ? [source]
    : [...source.querySelectorAll("details[data-work-log-day-section]")];
  days.forEach((day, dayIndex) => {
    const date = day.querySelector("summary[data-work-log-day] strong")?.dataset.workLogDate
      ?? plainDateText(day.querySelector("summary[data-work-log-day] strong")?.textContent);
    if (!date) return;
    if (day.hasAttribute("data-lazy-day")) {
      const sourceSummary = day.querySelector(":scope > summary[data-work-log-day]");
      const creditsValue = sourceSummary?.querySelector(
        "[data-day-usage] [data-usage-credits]",
      )?.dataset.usageCredits;
      const durationValue = sourceSummary?.querySelector(
        "[data-work-log-day-duration]",
      )?.dataset.workLogDurationSeconds;
      const credits = Number(creditsValue);
      const durationSeconds = Number(durationValue);
      const total = {
        provider: "day",
        threadId: date,
        turnCount: null,
        credits: Number.isFinite(credits) ? credits : null,
        knownCredits: Number.isFinite(credits) ? 1 : 0,
        unknownCredits: 0,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
        knownDurations: Number.isFinite(durationSeconds) ? 1 : 0,
        lazy: true,
        streamLabels: [],
      };
      const details = document.createElement("details");
      details.dataset.workLogDaySection = "";
      details.dataset.journalLedgerRow = "";
      details.dataset.journalDayDate = date;
      details.dataset.lazyDay = date;
      const dateLabel = document.createElement("span");
      const strong = el("strong", { text: date });
      strong.dataset.workLogDate = date;
      dateLabel.append(strong, el("span", {
        "data-journal-weekday": "",
        text: journalWeekday(date),
      }));
      const summary = journalLedgerSummary(total, { label: dateLabel, showStreams: false });
      summary.dataset.workLogDay = "";
      details.append(summary, el("div", { "data-lazy-day-content": "" }));
      list.append(details);
      return;
    }
    const workspaceGroups = workspaceGroupsFrom(day);
    const groups = workspaceGroups.length ? workspaceGroups : taskGroupsFrom(day);
    const total = combinedJournalGroup(groups, { provider: "day", threadId: date });
    const details = document.createElement("details");
    details.dataset.workLogDaySection = "";
    details.dataset.journalLedgerRow = "";
    details.dataset.journalDayDate = date;
    details.open = day.open || dayIndex === 0;
    const dateLabel = document.createElement("span");
    const strong = el("strong", { text: date });
    strong.dataset.workLogDate = date;
    dateLabel.append(strong, el("span", {
      "data-journal-weekday": "",
      text: journalWeekday(date),
    }));
    const summary = journalLedgerSummary(total, { label: dateLabel, showStreams: false });
    summary.dataset.workLogDay = "";
    const expanded = document.createElement("div");
    expanded.dataset.journalDayExpanded = "";
    const picker = document.createElement("div");
    picker.dataset.journalDayPicker = "";
    picker.append(el("span", { "data-journal-section-label": "", text: "Workspace" }));
    const panels = document.createElement("div");
    panels.dataset.journalDayPanels = "";
    const savedKey = journalDaySelections.get(date);
    const selectedKey = groups.some((group) => dayGroupKey(group) === savedKey)
      ? savedKey
      : groups.length ? dayGroupKey(groups[0]) : "";
    if (selectedKey) journalDaySelections.set(date, selectedKey);
    groups.forEach((group) => {
      const key = dayGroupKey(group);
      const selected = key === selectedKey;
      const item = document.createElement("div");
      item.dataset.journalDayPickerItem = "";
      item.toggleAttribute("data-selected", selected);
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.journalDaySelect = key;
      button.setAttribute("aria-pressed", String(selected));
      const title = document.createElement("span");
      title.dataset.journalDayPickerTitle = "";
      if (group.title) title.append(group.title.cloneNode(true));
      else title.textContent = `${group.provider} · ${group.threadId}`;
      const credits = el("span", { "data-journal-day-picker-credits": "" });
      if (group.knownCredits) credits.append(usageBadge(formatUsageValue(group.credits), group.credits));
      else credits.textContent = "—";
      const turns = el("span", {
        "data-journal-day-picker-turns": "",
        text: `${group.turnCount} ходов`,
      });
      button.append(title, turns, credits);
      item.append(button);
      if (group.workspaceUsage) {
        const breakdown = document.createElement("div");
        breakdown.dataset.journalDayBreakdown = "";
        breakdown.append(group.workspaceUsage.cloneNode(true));
        item.append(breakdown);
      }
      picker.append(item);

      const panel = document.createElement("section");
      panel.dataset.journalDayPanel = key;
      panel.hidden = !selected;
      const heading = document.createElement("div");
      heading.dataset.journalDayPanelHeading = "";
      const plainTitle = group.title?.textContent?.trim() || `${group.provider} · ${group.threadId}`;
      heading.textContent = `Ходы · ${plainTitle}`;
      const table = document.createElement("div");
      table.dataset.workLogTurnTable = "";
      for (const entry of [...group.turns, ...group.legacy]) {
        const copy = entry.cloneNode(true);
        copy.querySelector("[data-work-log-turn-day]")?.remove();
        table.append(copy);
      }
      panel.append(heading, table);
      panels.append(panel);
    });
    expanded.append(picker, panels);
    details.append(summary, expanded);
    list.append(details);
  });
  return list;
}

let journalRenderSequence = 0;

async function hydrateAllLazyDays() {
  const days = [...journal.querySelectorAll(
    "details[data-work-log-day-section][data-lazy-day]",
  )];
  const missingDates = days
    .map((details) => details.dataset.lazyDay)
    .filter((date) => date && !journalDayHtmlCache.has(date));
  if (missingDates.length) {
    const fragments = await fetchJournalDayFragments();
    for (const [date, html] of Object.entries(fragments)) {
      if (typeof html === "string") journalDayHtmlCache.set(date, html);
    }
  }
  const fallback = [];
  for (const details of days) {
    const html = journalDayHtmlCache.get(details.dataset.lazyDay);
    if (html) {
      materializeLazyDay(details, html, { decorate: false, postProcess: false });
    } else {
      fallback.push(loadLazyDay(details));
    }
  }
  await Promise.all(fallback);
}

function summarizedLazyDays(source) {
  const lazyDays = source.querySelectorAll(
    "details[data-work-log-day-section][data-lazy-day]",
  );
  if (!lazyDays.length || state.selection.includeClaudeUsage === false) return null;
  let credits = 0;
  let durationSeconds = 0;
  let knownCredits = 0;
  let knownDurations = 0;
  for (const day of source.querySelectorAll("details[data-work-log-day-section]")) {
    const summary = day.querySelector(":scope > summary[data-work-log-day]");
    const creditValue = Number(summary?.querySelector(
      "[data-day-usage] [data-usage-credits]",
    )?.dataset.usageCredits);
    const durationValue = Number(summary?.querySelector(
      "[data-work-log-day-duration]",
    )?.dataset.workLogDurationSeconds);
    if (Number.isFinite(creditValue)) {
      credits += creditValue;
      knownCredits += 1;
    }
    if (Number.isFinite(durationValue)) {
      durationSeconds += durationValue;
      knownDurations += 1;
    }
  }
  return { credits, durationSeconds, knownCredits, knownDurations };
}

function updateJournalStreamCount() {
  if (!journalWorkspaceCount) return;
  journalWorkspaceCount.textContent = JournalView.streamCount(state.workspaces)
    .toLocaleString("ru-RU");
}

function updateJournalSummary(source) {
  const lazyTotals = grouping === "date" ? summarizedLazyDays(source) : null;
  if (lazyTotals) {
    updateJournalStreamCount();
    if (journalTotalCredits) {
      journalTotalCredits.replaceChildren(
        lazyTotals.knownCredits
          ? usageBadge(formatUsageValue(lazyTotals.credits), lazyTotals.credits)
          : document.createTextNode("—"),
      );
    }
    if (journalTotalDuration) {
      journalTotalDuration.textContent = lazyTotals.knownDurations
        ? formatTaskDuration(lazyTotals.durationSeconds)
        : "—";
    }
    return;
  }
  const groups = taskGroupsFrom(source);
  const totals = JournalView.summarizeGroups(groups);
  updateJournalStreamCount();
  if (journalTotalCredits) {
    journalTotalCredits.replaceChildren(
      totals.knownCredits
        ? usageBadge(formatUsageValue(totals.credits), totals.credits)
        : document.createTextNode("—"),
    );
  }
  if (journalTotalDuration) {
    journalTotalDuration.textContent = totals.knownDurations
      ? formatTaskDuration(totals.durationSeconds)
      : "—";
  }
}

function applyJournalGrouping() {
  decorateDayHeadings(journal);
  upgradeLegacyWorkspaceGroups(journal);
  decorateLegacyStreamTurns(journal);
  updateJournalSummary(journal);
  if (grouping === "date") {
    for (const day of journal.querySelectorAll("details[data-work-log-day-section]")) {
      groupClaudeRowsInDay(day);
    }
    journal.replaceChildren(dayGroupingContent(journal));
  } else if (grouping === "stream" || grouping === "workspace") {
    journal.replaceChildren(taskGroupingContent(journal, grouping));
  } else {
    journal.replaceChildren(periodGroupingContent(journal, grouping));
  }
  refreshUsageUnits(journal);
  disableLocalLinks();
  syncCollapseTurnButtons();
  prepareMobileControls();
  const saved = groupingStates[grouping];
  if (saved) {
    restoreOpenState(saved);
  }
  for (const details of journal.querySelectorAll(
    "details[data-work-log-task-group][open]",
  )) appendTaskGroupTurnPage(details);
  journalRendered = true;
  journal.setAttribute("aria-busy", "false");
}

async function renderJournal() {
  const sequence = ++journalRenderSequence;
  const template = document.createElement("template");
  template.innerHTML = journalHtml;
  journal.setAttribute("aria-busy", "true");
  journal.replaceChildren(template.content.cloneNode(true));
  removeJournalRateLimits();
  try {
    if (JournalView.requiresCompleteHistory(grouping)) await hydrateAllLazyDays();
    if (sequence !== journalRenderSequence) return;
    applyJournalGrouping();
  } catch (error) {
    if (sequence !== journalRenderSequence) return;
    journal.setAttribute("aria-busy", "false");
    showToast(`Не удалось собрать журнал: ${error.message}`);
  }
}

async function requestJournal({ force = false, announce = false } = {}) {
  refreshButton.setAttribute("aria-busy", "true");
  try {
    await localSessionReady;
    const headers = await authenticatedRequestHeaders();
    if (!force && currentVersion) headers["If-None-Match"] = `"${currentVersion}"`;
    const response = await fetch(`/api/journal?now=${Date.now()}`, {
      cache: "no-store",
      headers,
    });
    if (response.status === 304) return true;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    if (force || payload.version !== currentVersion) {
      const versionChanged = payload.version !== currentVersion;
      const openState = journalRendered ? captureOpenState() : storedOpenState();
      if (openState) groupingStates[grouping] = openState;
      if (versionChanged) journalDayHtmlCache.clear();
      currentVersion = payload.version;
      journalHtml = payload.html;
      await renderJournal();
      persistOpenState();
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
    if (announce) showToast("Журнал обновлён.");
    return true;
  } catch (error) {
    updatedAt.textContent = "Ошибка";
    refreshButton.title = error.message;
    journal.setAttribute("aria-busy", "false");
    return false;
  } finally {
    refreshButton.setAttribute("aria-busy", "false");
  }
}

const journalRefresh = window.AgentHubJournalView.createQueuedJournalRefresh(requestJournal);

function loadJournal(options = {}) {
  return journalRefresh.refresh(options);
}

/* Журнал грузится при первом открытии вкладки; дальше его обновляют SSE или
 * опрос. Ленивая подгрузка старых дней сохраняется. */
function ensureJournalLoaded() {
  if (journalRequested) return;
  journalRequested = true;
  void loadJournal({ force: true });
  journalPolling?.start();
}

refreshButton.addEventListener("click", () => {
  updatedAt.textContent = "Обновление…";
  refreshButton.title = "Журнал обновляется";
  void loadJournal({ force: true, announce: true });
});
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
  const daySelector = event.target.closest("[data-journal-day-select]");
  if (daySelector) {
    event.preventDefault();
    event.stopPropagation();
    const day = daySelector.closest("[data-journal-day-date]");
    const key = daySelector.dataset.journalDaySelect;
    if (!day || !key) return;
    journalDaySelections.set(day.dataset.journalDayDate, key);
    for (const item of day.querySelectorAll("[data-journal-day-picker-item]")) {
      const button = item.querySelector("[data-journal-day-select]");
      const selected = button?.dataset.journalDaySelect === key;
      item.toggleAttribute("data-selected", selected);
      button?.setAttribute("aria-pressed", String(selected));
    }
    for (const panel of day.querySelectorAll("[data-journal-day-panel]")) {
      panel.hidden = panel.dataset.journalDayPanel !== key;
    }
    return;
  }
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
  if (opened.matches?.("details[data-work-log-day-section]")) {
    const latestOpenState = captureOpenState();
    desiredOpenState = latestOpenState;
    groupingStates[grouping] = latestOpenState;
  }
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

/* Обновления журнала: в Telegram — опрос, в браузере/VS Code — SSE. Android
 * и public BrowserDevice не получают SSE, поэтому используют bounded polling.
 * Загрузка начинается только после первого открытия вкладки журнала. */
const journalPolling = !telegramMode && !vscodeMode
  && (Boolean(window.AgentHubAndroid) || Boolean(window.AgentHubBrowserDevice))
  ? window.AgentHubJournalPolling.createBoundedPollingFallback({
      request: () => loadJournal(),
      isEnabled: () => journalRequested,
      isOnline: () => navigator.onLine !== false,
      isVisible: () => document.visibilityState !== "hidden",
    })
  : null;

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
if (journalPolling) {
  document.addEventListener("visibilitychange", () => journalPolling.reconcile());
  window.addEventListener("online", () => journalPolling.reconcile());
  window.addEventListener("offline", () => journalPolling.reconcile());
  window.addEventListener("pageshow", () => {
    if (journalRequested) journalPolling.start();
  });
  window.addEventListener("pagehide", () => journalPolling.stop());
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
if (navigationTabs.isStandaloneNavigationTab(initialNavigationTab)) {
  setView(initialNavigationTab, { persist: false, activate: false });
} else {
  setView("chat", { persist: false, activate: false });
  setPane(initialNavigationTab, { persist: false });
}
window.addEventListener("DOMContentLoaded", () => activateView(currentNavigationTab()), {
  once: true,
});
autosizeComposer();
