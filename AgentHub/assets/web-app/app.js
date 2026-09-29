/* Agent Hub — общий frontend.
 *
 * Оболочка объединяет четыре представления над одними данными и темами:
 *   • «Диалоги» — слева компактный список задач, справа чат выбранной задачи;
 *   • «Журнал» — SQLite-представление журнала с ленивой подгрузкой;
 *   • «Статистика» — учётный расход журнала и история лимитов API.
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
  nativeSelectionMenuRequired,
  domRangeFromOffsets,
  domRangeOffsets,
  highlightResponseAnnotationRange,
  normalizedResponseAnnotationSource,
  quotableSelectionScope,
  quotableSelectionText,
  responseAnnotationSha256,
  responseAnnotationSourceContent,
  responseAnnotationSourceHashesMatch,
  responseAnnotationSourceIdentity,
  responseAnnotationSourceMessages,
  responseAnnotationSourceProjection,
  responseAnnotationSourceSurface,
  responseAnnotationSurfaceLocator,
  turnTraceContent,
  turnTraceSummary,
} = window.AgentHubMessageDisclosure;
const chatSurfacePreference = window.AgentHubChatSurfacePreference;
const backgroundMotionPreference = window.AgentHubBackgroundMotionPreference;
const activityRailPreference = window.AgentHubActivityRailPreference;
const backgroundImageResolver = window.AgentHubBackgroundImageResolver;
const modalOverlays = window.AgentHubModalOverlays;
const particleStyle = window.AgentHubParticleStyle;
const JournalView = window.AgentHubJournalView;
const JournalAccountPanel = window.AgentHubJournalAccountPanel;
const MessageView = window.AgentHubMessageView;
const liveCardRenderController = window.AgentHubLiveCardRender.createLiveCardRenderController();
const expandedUserMessageIds = new Set();
const responseCitationSources = new WeakMap();
let activeSourceCitationCleanup = null;
let messageDisclosureFrame = 0;
const journal = document.querySelector("[data-journal]");
const journalView = document.querySelector("[data-journal-view]");
const statisticsView = document.querySelector("[data-statistics-view]");
const statisticsAccountPanelHost = document.querySelector("[data-statistics-account-panel-host]");
const statisticsSyncCard = document.querySelector("[data-statistics-sync-card]");
const statisticsSyncHost = document.querySelector("[data-statistics-sync-host]");
const serverView = document.querySelector("[data-server-view]");
const updatedAt = document.querySelector("[data-updated-at]");
const refreshButton = document.querySelector("[data-refresh]");
const collapseAllButton = document.querySelector("[data-collapse-all]");
const themeSelect = document.querySelector("[data-theme-select]");
const backgroundSelect = document.querySelector("[data-background-select]");
const backgroundMotionToggle = document.querySelector("[data-background-motion-toggle]");
const chatBackgroundToggle = document.querySelector("[data-chat-background-toggle]");
const journalGroupingButtons = [...document.querySelectorAll("[data-journal-grouping]")];
const journalStreamGroupToggle = document.querySelector("[data-journal-stream-group-toggle]");
const journalPrimaryColumn = document.querySelector("[data-journal-primary-column]");
const journalWorkspaceCount = document.querySelector("[data-journal-workspace-count]");
const journalTotalCredits = document.querySelector("[data-journal-total-credits]");
const journalTotalDuration = document.querySelector("[data-journal-total-duration]");
const journalSyncStatus = document.querySelector("[data-journal-sync-status]");
const journalSyncButton = document.querySelector("[data-journal-sync]");
const journalSyncConnectButton = document.querySelector("[data-journal-sync-connect]");
const journalSyncDeviceLabelButton = document.createElement("button");
journalSyncDeviceLabelButton.className = "journal-sync-button";
journalSyncDeviceLabelButton.type = "button";
journalSyncDeviceLabelButton.hidden = true;
journalSyncDeviceLabelButton.textContent = "Ник устройства";
const themeColor = document.querySelector("[data-theme-color]");

const taskList = document.querySelector("[data-task-list]");
const taskEmpty = document.querySelector("[data-task-empty]");
const taskCount = document.querySelector("[data-task-count]");
const taskFilter = document.querySelector("[data-task-filter]");
const workspaceArchiveOpen = document.querySelector("[data-action='workspace-archive-open']");
const workspaceArchiveCount = document.querySelector("[data-workspace-archive-count]");
const workspaceArchiveModal = document.querySelector("[data-workspace-archive-modal]");
const workspaceArchiveList = document.querySelector("[data-workspace-archive-list]");
const workspaceArchiveEmpty = document.querySelector("[data-workspace-archive-empty]");
const activityRail = document.querySelector("[data-activity-rail]");
const activityRailToggle = document.querySelector("[data-activity-rail-toggle]");
const activityRailCount = document.querySelector("[data-activity-rail-count]");
const activityStreamHeading = document.querySelector("[data-activity-stream-heading]");
const activityStreamList = document.querySelector("[data-activity-stream-list]");
const activityStreamEmpty = document.querySelector("[data-activity-stream-empty]");
const activityRecentList = document.querySelector("[data-activity-recent-list]");
const activityRecentEmpty = document.querySelector("[data-activity-recent-empty]");
const workspaceCardModal = document.querySelector("[data-workspace-card-modal]");
const workspaceCardForm = document.querySelector("[data-workspace-card-form]");
const workspaceCardTitle = document.querySelector("[data-workspace-card-title]");
const workspaceCardName = document.querySelector("[data-workspace-card-name]");
const workspaceCardFolderField = document.querySelector("[data-workspace-card-folder-field]");
const workspaceCardFolder = document.querySelector("[data-workspace-card-folder]");
const workspaceCardComment = document.querySelector("[data-workspace-card-comment]");
const workspaceCardWorkingDirectory = document.querySelector("[data-workspace-card-working-directory]");
const workspaceCardTaskPrefix = document.querySelector("[data-workspace-card-task-prefix]");
const workspaceCardRules = document.querySelector("[data-workspace-card-rules]");
const workspaceCardRulesCount = document.querySelector("[data-workspace-card-rules-count]");
const workspaceCardQuickMessagesEntry = document.querySelector("[data-workspace-card-quick-messages-entry]");
const workspaceCardQuickMessagesCount = document.querySelector("[data-workspace-card-quick-messages-count]");
const workspaceCardArchive = document.querySelector("[data-workspace-card-archive]");
const workspaceCardReleaseWorkflow = document.querySelector("[data-workspace-release-workflow]");
const workspaceCardReleaseWorkflowTooltip = document.querySelector("[data-workspace-release-workflow-tooltip]");
const workspaceCardAutoReview = document.querySelector("[data-workspace-auto-review]");
const workspaceCardOrder = document.querySelector("[data-workspace-card-order]");
const workspaceCardSubmit = document.querySelector("[data-workspace-card-submit]");
window.AgentHubWorkspaceReleaseWorkflow?.renderTooltip(workspaceCardReleaseWorkflowTooltip);
window.AgentHubWorkspaceReleaseWorkflow?.renderAutoReviewTooltip(document.querySelector("[data-workspace-auto-review-tooltip]"));

const chatPane = document.querySelector("[data-chat-pane]");
const streamTabs = document.querySelector("[data-stream-tabs]");
const streamChatColumns = document.querySelector("[data-stream-chat-columns]");
const streamChatHeader = document.querySelector("[data-stream-chat-header]");
const streamHeaderWorkspace = document.querySelector("[data-stream-header-workspace]");
const streamHeaderName = document.querySelector("[data-stream-header-name]");
const streamHeaderProviderDot = document.querySelector("[data-stream-header-provider-dot]");
const streamHeaderProvider = document.querySelector("[data-stream-header-provider]");
const streamHeaderProviderConnection = document.querySelector("[data-provider-connection-quality]");
const streamHeaderProviderConnectionLabel = document.querySelector("[data-provider-connection-label]");
const streamHeaderProviderConnectionRetry = document.querySelector("[data-provider-connection-retry]");
const providerTurnTooltip = document.querySelector("[data-provider-turn-tooltip]");
const providerTurnTooltipText = document.querySelector("[data-provider-turn-tooltip-text]");
const providerTurnModal = document.querySelector("[data-provider-turn-modal]");
const providerTurnTelemetry = window.AgentHubProviderTurnTelemetry?.createController({
  indicator: streamHeaderProviderConnection,
  tooltip: providerTurnTooltip,
  tooltipText: providerTurnTooltipText,
  dialog: providerTurnModal,
  summary: document.querySelector("[data-provider-turn-summary]"),
  metrics: document.querySelector("[data-provider-turn-metrics]"),
  timeline: document.querySelector("[data-provider-turn-timeline]"),
  close: document.querySelector("[data-provider-turn-close]"),
}) ?? { update() {} };
const streamHeaderModel = document.querySelector("[data-stream-header-model]");
const streamHeaderModelSeparator = document.querySelector("[data-stream-header-model-separator]");
const streamHeaderBranch = document.querySelector("[data-stream-header-branch]");
const streamHeaderBranchSeparator = document.querySelector("[data-stream-header-branch-separator]");
const streamHeaderMessageCount = document.querySelector("[data-stream-header-message-count]");
const messagePinShelf = document.querySelector("[data-message-pin-shelf]");
const messagePinCurrent = document.querySelector("[data-message-pin-current]");
const messagePinPosition = document.querySelector("[data-message-pin-position]");
const messagePinPrevious = document.querySelector("[data-message-pin-previous]");
const messagePinNext = document.querySelector("[data-message-pin-next]");
const messagePinsOpen = document.querySelector("[data-message-pins-open]");
const messagePinStatus = document.querySelector("[data-message-pin-status]");
const messagePinsModal = document.querySelector("[data-message-pins-modal]");
const messagePinsList = document.querySelector("[data-message-pins-list]");
const messagePinsClear = document.querySelector("[data-message-pins-clear]");
const messagePinsClearModal = document.querySelector("[data-message-pins-clear-modal]");
const messagePinsClearCopy = document.querySelector("[data-message-pins-clear-copy]");
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
const dialogSettingsClose = document.querySelector("[data-dialog-settings-close]");
const dialogStreamName = document.querySelector("[data-dialog-stream-name]");
const dialogWorkingDirectory = document.querySelector("[data-dialog-working-directory]");
const dialogWorkingDirectoryNote = document.querySelector("[data-dialog-working-directory-note]");
const dialogStreamRules = document.querySelector("[data-dialog-stream-rules]");
const dialogStreamRulesCount = document.querySelector("[data-dialog-stream-rules-count]");
const dialogStreamRulesSave = document.querySelector("[data-dialog-stream-rules-save]");
const dialogStreamReleaseManager = document.querySelector("[data-dialog-stream-release-manager]");
const dialogStreamTeamLead = document.querySelector("[data-dialog-stream-team-lead]");
const dialogStreamTeamLeadTooltip = document.querySelector("[data-stream-team-lead-tooltip]");
const dialogStreamQuickMessagesEntry = document.querySelector("[data-dialog-stream-quick-messages-entry]");
const dialogStreamQuickMessagesCount = document.querySelector("[data-dialog-stream-quick-messages-count]");
const streamCardPin = document.querySelector("[data-stream-card-pin]");
const streamCardWorkspace = document.querySelector("[data-stream-card-workspace]");
const streamCardRotate = document.querySelector("[data-stream-card-rotate]");
const streamCardContinueProvider = document.querySelector("[data-stream-card-continue-provider]");
const streamCardMove = document.querySelector("[data-stream-card-move]");
const streamCardMoveMenu = document.querySelector("[data-stream-card-move-menu]");
const streamCardArchive = document.querySelector("[data-stream-card-archive]");
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
const composerQuickMessages = document.querySelector("[data-composer-quick-messages]");
const connectionQualityIndicator = document.querySelector("[data-connection-quality]");
const annotationsBox = document.querySelector("[data-annotations]");
const attachmentsBox = document.querySelector("[data-attachments]");
const TaskReferences = window.AgentHubTaskReferences;
const streamRoleSettings = window.AgentHubStreamRoleSettings;
streamRoleSettings?.renderTeamLeadTooltip(dialogStreamTeamLeadTooltip);
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
const quickMessageActionModeSelect = document.querySelector("[data-quick-message-action-mode]");
const quickMessageActionModeNote = document.querySelector("[data-quick-message-action-mode-note]");
const settingsGlobalQuickMessagesEntry = document.querySelector("[data-settings-global-quick-messages-entry]");
const promptTemplatesModal = document.querySelector("[data-prompt-templates-modal]");
const promptTemplatesScopes = document.querySelector("[data-prompt-templates-scopes]");
const promptTemplatesNote = document.querySelector("[data-prompt-templates-note]");
const promptTemplatesEditor = document.querySelector("[data-prompt-templates-editor]");
const promptTemplatesConflict = document.querySelector("[data-prompt-templates-conflict]");
const promptTemplatesConflictText = document.querySelector("[data-prompt-templates-conflict-text]");
const promptTemplatesReload = document.querySelector("[data-prompt-templates-reload]");
const settingsGlobalQuickMessagesCount = document.querySelector("[data-settings-global-quick-messages-count]");
const bugReportToggle = document.querySelector("[data-bug-report-toggle]");
const bugReportForm = document.querySelector("[data-bug-report-form]");
const bugReportText = document.querySelector("[data-bug-report-text]");
const bugReportFiles = document.querySelector("[data-bug-report-files]");
const bugReportAttach = document.querySelector("[data-bug-report-attach]");
const bugReportScreenshots = document.querySelector("[data-bug-report-screenshots]");
const bugReportSubmit = document.querySelector("[data-bug-report-submit]");
const bugReportStatus = document.querySelector("[data-bug-report-status]");
const bugReportFlow = window.AgentHubBugReportFlow;
const telegramFullscreenButton = document.querySelector("[data-telegram-fullscreen]");
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
const serverAccounts = document.querySelector("[data-server-accounts]");
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
let journalSummary = null;
let grouping = "workspace";
let usageUnit = "cr";
let usdRubRate = null;
let usdRubEffectiveDate = "";
let exchangeRatesInitialized = false;
let groupClaudeTasks = false;
let groupJournalTurnsByStream = true;
let streamOrderMode = "activity";
const groupingStates = { date: null, week: null, month: null, stream: null, workspace: null };
const journalDaySelections = new Map();
const TASK_GROUP_TURN_PAGE_SIZE = 30;
const taskGroupTurns = new WeakMap();
const telegram = window.Telegram?.WebApp;
const telegramInitData = String(telegram?.initData ?? "");
const telegramMode = Boolean(telegramInitData);
const protectedLocalSessionReady = window.AgentHubProtectedLocalSessionReady ?? Promise.resolve();
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
const ACTIVITY_STREAM_DETAILED_CARDS_KEY = "agent-hub:activity-stream-detailed-cards:v1";
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
  resolveStatisticsAccountSelection,
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
const STATISTICS_CURRENT_ACCOUNT_KEY = "agent-hub:statistics-current-account:v1";
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
  currentAccountKey: (() => {
    try {
      return String(localStorage.getItem(STATISTICS_CURRENT_ACCOUNT_KEY) || "");
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
    return { element: drop, parameters: {
      "--x": `${Math.random() * 108 - 4}%`,
      "--len": `${(34 + near * 58).toFixed(1)}px`,
      "--thickness": `${(1.1 + near * 1.2).toFixed(2)}px`,
      "--alpha": (0.3 + near * 0.34).toFixed(2),
      "--dur": `${(0.62 - near * 0.3).toFixed(2)}s`,
      "--delay": `-${(Math.random() * 2).toFixed(2)}s`,
    } };
  }
  // ближние капли длиннее, ярче и падают быстрее — этим читается глубина
  return { element: drop, parameters: {
    "--x": `${Math.random() * 104 - 2}%`,
    "--len": `${(8 + near * 14).toFixed(1)}px`,
    "--thickness": `${(0.8 + near * 0.8).toFixed(2)}px`,
    "--alpha": (0.2 + near * 0.3).toFixed(2),
    "--dur": `${(1.45 - near * 0.7).toFixed(2)}s`,
    "--delay": `-${(Math.random() * 2).toFixed(2)}s`,
  } };
}

function buildMote() {
  const mote = document.createElement("span");
  const near = Math.random();
  /* Пыль в свете факела: ближние пылинки крупнее и бледнее, дальние мельче и
     ярче, поднимаются медленно и слегка виляют вбок. */
  return { element: mote, parameters: {
    "--x": `${8 + Math.random() * 94}%`,
    "--size": `${(1.6 + near * 5).toFixed(1)}px`,
    "--alpha": (0.7 - near * 0.4).toFixed(2),
    "--drift": `${(Math.random() * 46 - 23).toFixed(0)}px`,
    "--dur": `${(9 + Math.random() * 12).toFixed(1)}s`,
    "--delay": `-${(Math.random() * 20).toFixed(1)}s`,
  } };
}

function buildParticleLayer(kind) {
  const layer = document.createElement("div");
  layer.className = kind === "motes" ? "motes" : `rain${kind === "downpour" ? " downpour" : ""}`;
  layer.setAttribute("aria-hidden", "true");
  const build = kind === "motes"
    ? buildMote
    : () => buildRainDrop(kind === "downpour");
  const particles = Array.from({ length: particleCount(kind) }, build);
  layer.dataset.agentHubParticles = "";
  layer.append(...particles.map((particle) => particle.element));
  particleStyle.install(document, layer, particles.map((particle) => particle.parameters));
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

function applyActivityRailVisibility(value, { persist = false } = {}) {
  const selected = activityRailPreference.apply(root, null, value);
  if (persist) activityRailPreference.persist(localStorage, selected);
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
  if (persist) {
    try {
      localStorage.setItem("agent-hub-stream-status-effect", effect);
    } catch {
      // Настройка останется активной до закрытия WebView.
    }
  }
}

function savedActivityStreamDetailedCards() {
  try {
    return localStorage.getItem(ACTIVITY_STREAM_DETAILED_CARDS_KEY) === "true";
  } catch {
    return false;
  }
}

function applyActivityStreamDetailedCards(value, { persist = false } = {}) {
  const detailed = value === true;
  root.dataset.activityStreamCards = detailed ? "detailed" : "compact";
  if (persist) {
    try {
      localStorage.setItem(ACTIVITY_STREAM_DETAILED_CARDS_KEY, String(detailed));
    } catch {
      // Настройка останется активной до закрытия WebView.
    }
  }
}

function applyStreamOrderMode(value, { update = false } = {}) {
  streamOrderMode = window.AgentHubStreamTabs.normalizeStreamOrderMode(value);
  root.dataset.streamOrderMode = streamOrderMode;
  if (streamTabs) streamTabs.dataset.orderMode = streamOrderMode;
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
  if (update) renderActivityRail();
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

function savedJournalStreamGrouping() {
  try {
    return localStorage.getItem("agent-hub-journal-stream-groups") !== "off";
  } catch {
    return true;
  }
}

function selectJournalStreamGrouping(value, { persist = false } = {}) {
  groupJournalTurnsByStream = value !== false;
  if (journalStreamGroupToggle) journalStreamGroupToggle.checked = groupJournalTurnsByStream;
  if (persist) {
    try {
      localStorage.setItem(
        "agent-hub-journal-stream-groups",
        groupJournalTurnsByStream ? "on" : "off",
      );
    } catch {
      // Настройка останется активной до закрытия WebView.
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
applyActivityRailVisibility(activityRailPreference.stored(localStorage));
applyStreamStatusStyle(savedStreamStatusStyle());
applyStreamStatusEffect(savedStreamStatusEffect());
applyActivityStreamDetailedCards(savedActivityStreamDetailedCards());
applyStreamOrderMode("activity");
applyActivityRecentPeriod(DEFAULT_ACTIVITY_RECENT_MINUTES);
selectUsageUnit(savedUsageUnit());
selectClaudeGrouping(savedClaudeGrouping());
selectJournalStreamGrouping(savedJournalStreamGrouping());
claudeGroupToggle?.addEventListener("change", () => {
  selectClaudeGrouping(claudeGroupToggle.checked, { persist: true });
  if (journalHtml) void renderJournal();
});
journalStreamGroupToggle?.addEventListener("change", () => {
  selectJournalStreamGrouping(journalStreamGroupToggle.checked, { persist: true });
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
  const placement = window.AgentHubThemedSelectPlacement.resolve(select, menu);
  const supportsPopover = placement.usePopover;
  if (supportsPopover) menu.setAttribute("popover", "manual");
  placement.host.append(menu);

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
    if (menu.matches?.(":popover-open")) menu.hidePopover();
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
      openThemedSelect.close();
    }
    render();
    menu.hidden = false;
    if (supportsPopover) menu.showPopover();
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
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close({ restoreFocus: true });
      return;
    }
    if (event.key === "Tab") {
      close();
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
      if (!(node instanceof Element) || node === journal || journal.contains(node)) continue;
      if (node instanceof HTMLSelectElement || node.querySelector?.("select")) {
        enhanceThemedSelects(node);
      }
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

/* Анимации состояния живут на псевдоэлементах карточки, поэтому новый узел
   начинает их заново. Списки пересобираются целиком, и при частых обновлениях
   полоса активности не успевает пройти свой цикл. Узел с тем же ключом
   переиспользуется, а его анимации продолжаются с накопленного времени. */
const STREAM_STATUS_LAYER_SELECTOR = ".stream-tab-status-layer";
const STREAM_STATUS_ANIMATION_PREFIX = "stream-";
let reusableWorkspaceCards = new Map();
let reusableStreamTabs = new Map();
let adoptedCardAnimations = [];

function statusAnimationKey(animation) {
  return `${animation.animationName} ${animation.effect?.pseudoElement ?? ""}`;
}

function statusAnimationTimes(node) {
  const times = new Map();
  for (const animation of node.getAnimations?.({ subtree: true }) ?? []) {
    if (!String(animation.animationName ?? "").startsWith(STREAM_STATUS_ANIMATION_PREFIX)) continue;
    const time = Number(animation.currentTime);
    if (Number.isFinite(time)) times.set(statusAnimationKey(animation), time);
  }
  return times;
}

function indexRenderedCards(container, selector, attribute) {
  const index = new Map();
  for (const node of container?.querySelectorAll(selector) ?? []) {
    const key = node.getAttribute(attribute);
    if (key && !index.has(key)) index.set(key, { node, times: statusAnimationTimes(node) });
  }
  return index;
}

function adoptRenderedCard(index, key, next) {
  const previous = index.get(key);
  if (!previous || previous.node.tagName !== next.tagName) return next;
  index.delete(key);
  const node = previous.node;
  /* Наблюдатель видимости помечает карточку своим атрибутом, и рендер им не
     владеет: при обновлении он сохраняется. */
  for (const attribute of [...node.attributes]) {
    if (attribute.name === "data-stream-offscreen") continue;
    if (!next.hasAttribute(attribute.name)) node.removeAttribute(attribute.name);
  }
  for (const attribute of next.attributes) {
    if (node.getAttribute(attribute.name) !== attribute.value) {
      node.setAttribute(attribute.name, attribute.value);
    }
  }
  /* У вкладки Stream анимацию несёт собственный слой статуса, поэтому он
     переносится в обновлённое содержимое вместо заново созданного. */
  const keptLayer = node.querySelector(STREAM_STATUS_LAYER_SELECTOR);
  const nextLayer = next.querySelector(STREAM_STATUS_LAYER_SELECTOR);
  if (keptLayer && nextLayer) nextLayer.replaceWith(keptLayer);
  node.replaceChildren(...next.childNodes);
  if (previous.times.size) adoptedCardAnimations.push(previous);
  return node;
}

/* Возврат узла в документ перезапускает его анимации, поэтому уже пройденное
   время восстанавливается сразу после вставки. */
function resumeAdoptedCardAnimations() {
  for (const { node, times } of adoptedCardAnimations) {
    if (!node.isConnected) continue;
    for (const animation of node.getAnimations?.({ subtree: true }) ?? []) {
      const time = times.get(statusAnimationKey(animation));
      if (time === undefined) continue;
      try { animation.currentTime = time; } catch { /* анимация уже недоступна */ }
    }
  }
  adoptedCardAnimations = [];
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
function activityTimestamp(input) {
  if (input == null || input === "" || input === 0 || input === "0") return 0;
  const value = input instanceof Date ? input.getTime() : Date.parse(String(input));
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function formatRelativeTime(input) {
  const timestamp = activityTimestamp(input);
  if (!timestamp) return "";
  const date = new Date(timestamp);
  const diff = Date.now() - date.getTime();
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "<1м";
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
  for (const node of document.querySelectorAll("[data-live-turn-duration][data-turn-started-at]")) {
    const label = MessageView.turnDurationLabel(node.dataset.turnStartedAt, now);
    node.textContent = label;
    node.hidden = !label;
  }
  const minute = Math.floor(now / 60_000);
  if (minute !== lastActivityRailRefreshMinute) {
    lastActivityRailRefreshMinute = minute;
    renderActivityRail();
  }
  renderStreamChatHeader(currentTask(), now);
}

let toastTimer = 0;
function showToast(message, action = null) {
  if (!message) return;
  toast.replaceChildren(el("span", { text: message }));
  if (action?.label && typeof action.onClick === "function") {
    const button = el("button", { type: "button", text: action.label });
    button.addEventListener("click", () => {
      clearTimeout(toastTimer);
      toast.hidden = true;
      toast.classList.remove("visible");
      action.onClick();
    }, { once: true });
    toast.append(button);
  }
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
  return window.AgentHubCommandTrace.intent(type, detail, () => emitIntent(type, detail));
}

function emitIntent(type, detail) {
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

const directoryBrowseAvailable = window.AgentHubResourceInteractions.localWorkspaceFilesAvailable({
  vscode: vscodeMode,
  protocol: window.location.protocol,
  hostname: window.location.hostname,
});
function createDirectoryField(input) {
  return input && window.AgentHubDirectoryField?.create(input, {
    browseAvailable: directoryBrowseAvailable,
    browse: ({ initialPath }) => new Promise((resolve, reject) => {
      emit("directory:browse", { initialPath, resolve, reject });
    }),
    onError: (error) => showToast(String(error?.message ?? error)),
  });
}
const workspaceWorkingDirectoryField = createDirectoryField(workspaceCardWorkingDirectory);
const streamWorkingDirectoryField = createDirectoryField(dialogWorkingDirectory);

document.addEventListener("agenthub:attachment-open", (event) => {
  emit("attachment:open", event.detail ?? {});
});

/* ------------------------------------------------------------- состояние UI */

const state = {
  tasks: [],
  workspaces: [],
  archivedWorkspaces: [],
  workspaceColumnOrder: [],
  selectedId: null,
  messages: new Map(),   // taskId -> message[]
  messageRenderLimits: new Map(), // taskId -> visible newest-message count
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
  pendingSelections: new Set(),
  status: null,
  connection: "",
  connectionBlockingCount: 0,
  connectionLatencyMs: null,
  providerResponseSamples: new Map(),
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
  collapsedWorkspaceFolders: new Set(),
  workspaceFolderNames: new Set(),
  visibleStreamTaskIds: [],
  messagePins: [],
  activeMessagePinByStream: new Map(),
  pendingMessagePinKeys: new Set(),
  messagePinMutationBackups: new Map(),
};
let transientAnswerArrivalTaskIds = new Set();
const observedAnswerFinalIdentityByTaskId = new Map();

/* Черновики принадлежат конкретному клиенту и задаче. Обычные вложения остаются
 * в памяти страницы. Только payload, который Hub точно отклонил, может быть
 * сохранён для явного retry: сохраняем исходный data:-URL, но никогда не
 * временный transport path. Quota/privacy отказ остаётся явным и fail-closed. */
const drafts = new Map();
const DRAFT_STORAGE_VERSION = "agent-hub:composer-drafts:v1";

function renderConnectionQuality() {
  if (!connectionQualityIndicator) return;
  const presentation = window.AgentHubConnectionQuality.connectionQualityPresentation({
    status: state.connection || "connecting",
    latencyMs: state.connectionLatencyMs,
  });
  connectionQualityIndicator.dataset.quality = presentation.quality;
  connectionQualityIndicator.dataset.bars = String(presentation.bars);
  connectionQualityIndicator.title = presentation.title;
  connectionQualityIndicator.setAttribute("aria-label", presentation.title);
}
const DRAFT_STORAGE_MAX_TASKS = 100;
const DRAFT_STORAGE_MAX_TEXT = 100_000;
const DRAFT_RECOVERY_MAX_ATTACHMENTS = 8;
const DRAFT_RECOVERY_MAX_ATTACHMENT_CHARS = 4_000_000;
const DRAFT_ATTACHMENT_MAX_BYTES = 256 * 1024 * 1024;
const DRAFT_ATTACHMENT_MAX_TOTAL_BYTES = 512 * 1024 * 1024;
const DRAFT_RECOVERY_AUTHORITY_DB = "agent-hub-composer-recovery-v1";
const DRAFT_RECOVERY_AUTHORITY_STORE = "surfaces";
const composerTaskGenerations = new Map();
let composerRecoveryWarningShown = false;
let composerRecoveryAuthorityReady = false;
let composerRecoveryAuthorityTrusted = false;
let composerRecoveryAuthorityEpoch = 0;
let composerRecoveryAuthorityPending = 0;
let composerRecoveryAuthorityInitialization = null;
let composerDraftRestoreInitialization = null;
let composerDraftRestoreReady = false;
let composerRecoveryAuthorityTail = Promise.resolve();
let composerRecoveryAuthorityDatabase = null;
let pendingComposerRequest = null;
const retryComposerRequests = new Map();
const composerDraftReconciliation = window.AgentHubComposerDraftReconciliation.create({
  drafts,
  retries: retryComposerRequests,
  persist: (options) => persistDrafts(options),
  render: (taskId) => {
    if (state.selectedId === taskId) restoreDraft();
  },
  persistenceFailed: () => reportComposerRecoveryFailure(),
  invalidateRecovery: ({ taskId, requestId }) => recordRecoveryInvalidation(taskId, requestId),
});

function draftStorageSurface() {
  if (vscodeMode) return "vscode";
  if (window.AgentHubAndroid) return "android";
  if (telegramMode) return `telegram:${telegramPlatform || "unknown"}`;
  return "web";
}

function draftStorageKey() {
  return `${DRAFT_STORAGE_VERSION}:${draftStorageSurface()}`;
}

function reportComposerRecoveryFailure() {
  if (composerRecoveryWarningShown) return;
  composerRecoveryWarningShown = true;
  showToast(
    "Браузер не может точно сохранить или инвалидировать восстановленное сообщение. Повтори отправку до перезагрузки; обновление интерфейса заблокировано.",
  );
}

function composerRecoveryAuthorityRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function openComposerRecoveryAuthority() {
  if (composerRecoveryAuthorityDatabase) return Promise.resolve(composerRecoveryAuthorityDatabase);
  if (!globalThis.indexedDB) return Promise.reject(new Error("IndexedDB is unavailable"));
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DRAFT_RECOVERY_AUTHORITY_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(DRAFT_RECOVERY_AUTHORITY_STORE)) {
        request.result.createObjectStore(DRAFT_RECOVERY_AUTHORITY_STORE, { keyPath: "surface" });
      }
    };
    request.onsuccess = () => {
      composerRecoveryAuthorityDatabase = request.result;
      composerRecoveryAuthorityDatabase.onversionchange = () => {
        composerRecoveryAuthorityDatabase.close();
        composerRecoveryAuthorityDatabase = null;
        composerRecoveryAuthorityTrusted = false;
      };
      resolve(composerRecoveryAuthorityDatabase);
    };
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
    request.onblocked = () => reject(new Error("IndexedDB upgrade blocked"));
  });
}

async function readComposerRecoveryAuthority() {
  try {
    const database = await openComposerRecoveryAuthority();
    const transaction = database.transaction(DRAFT_RECOVERY_AUTHORITY_STORE, "readonly");
    const record = await composerRecoveryAuthorityRequest(
      transaction.objectStore(DRAFT_RECOVERY_AUTHORITY_STORE).get(draftStorageSurface()),
    );
    const epoch = Number(record?.epoch ?? 0);
    if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error("Invalid recovery epoch");
    composerRecoveryAuthorityEpoch = epoch;
    composerRecoveryAuthorityTrusted = true;
  } catch {
    composerRecoveryAuthorityTrusted = false;
    reportComposerRecoveryFailure();
  } finally {
    composerRecoveryAuthorityReady = true;
  }
}

function ensureComposerRecoveryAuthority() {
  if (!composerRecoveryAuthorityInitialization) {
    composerRecoveryAuthorityInitialization = readComposerRecoveryAuthority();
  }
  return composerRecoveryAuthorityInitialization;
}

function ensureComposerDraftsRestored() {
  if (!composerDraftRestoreInitialization) {
    composerDraftRestoreInitialization = (async () => {
      await ensureComposerRecoveryAuthority();
      try {
        await restorePersistedDrafts();
        if (state.selectedId) restoreDraft();
      } catch {
        reportComposerRecoveryFailure();
      } finally {
        composerDraftRestoreReady = true;
      }
    })();
  }
  return composerDraftRestoreInitialization;
}

async function bumpComposerRecoveryAuthority() {
  await ensureComposerRecoveryAuthority();
  if (!composerRecoveryAuthorityTrusted) throw new Error("Recovery authority unavailable");
  const database = await openComposerRecoveryAuthority();
  const transaction = database.transaction(DRAFT_RECOVERY_AUTHORITY_STORE, "readwrite");
  const store = transaction.objectStore(DRAFT_RECOVERY_AUTHORITY_STORE);
  const current = await composerRecoveryAuthorityRequest(store.get(draftStorageSurface()));
  const previousEpoch = Number(current?.epoch ?? 0);
  if (!Number.isSafeInteger(previousEpoch) || previousEpoch < 0
    || previousEpoch >= Number.MAX_SAFE_INTEGER) throw new Error("Recovery epoch exhausted");
  const nextEpoch = previousEpoch + 1;
  store.put({ surface: draftStorageSurface(), epoch: nextEpoch, updatedAt: Date.now() });
  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error ?? new Error("Recovery authority write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Recovery authority write aborted"));
  });
  composerRecoveryAuthorityEpoch = nextEpoch;
  composerRecoveryAuthorityTrusted = true;
}

function recordRecoveryInvalidation(taskId, requestId, { clearNonDurableWhenPersisted = true } = {}) {
  const id = String(requestId ?? "").trim();
  if (!id) return true;
  composerRecoveryAuthorityPending += 1;
  composerRecoveryAuthorityTail = composerRecoveryAuthorityTail.then(async () => {
    try {
      await bumpComposerRecoveryAuthority();
      discardPersistedRecovery(id);
    } catch {
      composerRecoveryAuthorityTrusted = false;
      reportComposerRecoveryFailure();
    } finally {
      composerRecoveryAuthorityPending = Math.max(0, composerRecoveryAuthorityPending - 1);
    }
    if (composerRecoveryAuthorityPending === 0 && composerRecoveryAuthorityTrusted) {
      const represented = persistDrafts();
      const draft = drafts.get(taskId);
      if (clearNonDurableWhenPersisted && represented
        && draft?.recoveryNonDurable === true && !draft.recoveryRequestId) {
        delete draft.recoveryNonDurable;
      }
    }
  });
  // The monotonic durable write is asynchronous. Until it commits, runtime
  // reload remains blocked and this invalidation must not be called durable.
  return false;
}

function normalizedDraftText(value) {
  return String(value ?? "").slice(0, DRAFT_STORAGE_MAX_TEXT);
}

function normalizedDraftAnnotations(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 20).map((annotation) => {
    const source = normalizedResponseAnnotationSource(annotation?.source);
    return {
      quote: String(annotation?.quote ?? ""),
      annotation: String(annotation?.annotation ?? annotation?.comment ?? "").slice(0, 20_000),
      ...(source ? { source } : {}),
    };
  }).filter((annotation) => annotation.quote);
}

async function restorePersistedDrafts() {
  let persisted;
  try {
    persisted = JSON.parse(localStorage.getItem(draftStorageKey()) ?? "[]");
  } catch {
    return;
  }
  if (!Array.isArray(persisted)) return;
  await window.AgentHubComposerFiles.hydrate(persisted.slice(0, DRAFT_STORAGE_MAX_TASKS)
    .flatMap((entry) => Array.isArray(entry?.attachments) ? entry.attachments.slice(0, DRAFT_RECOVERY_MAX_ATTACHMENTS) : []));
  let invalidRecoveryFound = false;
  for (const entry of persisted.slice(0, DRAFT_STORAGE_MAX_TASKS)) {
    const taskId = String(entry?.taskId ?? "").trim();
    if (!taskId) continue;
    // A snapshot can make the composer interactive while IndexedDB is still
    // opening. Never let a late persisted read replace a draft the user has
    // already edited in this page generation.
    if (composerDraftReconciliation.revision(taskId) !== 0) continue;
    const text = normalizedDraftText(entry.text);
    const annotations = normalizedDraftAnnotations(entry.annotations);
    const taskReferences = (Array.isArray(entry?.taskReferences) ? entry.taskReferences : [])
      .map((reference) => TaskReferences.normalize(reference))
      .filter(Boolean);
    const recoveryRequestId = String(entry?.recoveryRequestId ?? "").trim();
    const recoveryFingerprint = String(entry?.recoveryFingerprint ?? "");
    const rawRecoveryMetadata = Boolean(recoveryRequestId && recoveryFingerprint);
    const recoveryEpoch = Number(entry?.recoveryEpoch);
    const authorityMatches = composerRecoveryAuthorityReady
      && composerRecoveryAuthorityTrusted
      && Number.isSafeInteger(recoveryEpoch)
      && recoveryEpoch === composerRecoveryAuthorityEpoch;
    const durablyInvalidated = rawRecoveryMetadata
      && composerRecoveryAuthorityReady
      && composerRecoveryAuthorityTrusted
      && Number.isSafeInteger(recoveryEpoch)
      && recoveryEpoch < composerRecoveryAuthorityEpoch;
    if (durablyInvalidated) continue;
    const recoveredAttachments = !rawRecoveryMetadata || authorityMatches
      ? normalizedRecoveryAttachments(entry?.attachments)
      : [];
    const attachments = recoveredAttachments ?? [];
    const exactRecovery = Boolean(rawRecoveryMetadata && authorityMatches && recoveredAttachments)
      && window.AgentHubComposerDraftReconciliation.recoveryFingerprint({
        taskId,
        text,
        attachments,
        taskReferences,
        annotations,
      }) === recoveryFingerprint;
    const invalidRecovery = (rawRecoveryMetadata && !exactRecovery)
      || (!recoveredAttachments && Boolean(entry?.attachments?.length));
    if (invalidRecovery) {
      invalidRecoveryFound = true;
      recordRecoveryInvalidation(taskId, recoveryRequestId, { clearNonDurableWhenPersisted: false });
    }
    if (!text && annotations.length === 0 && taskReferences.length === 0 && attachments.length === 0
      && !invalidRecovery) continue;
    composerDraftReconciliation.restore(taskId, {
      text,
      attachments,
      taskReferences,
      annotations,
      ...(exactRecovery ? {
        recoveryRequestId,
        recoveryFingerprint,
        recoveryEpoch,
      } : {}),
      ...(invalidRecovery ? { recoveryNonDurable: true } : {}),
    });
  }
  if (invalidRecoveryFound) reportComposerRecoveryFailure();
}

function composerTaskIdentity(task) {
  if (!task) return "";
  return JSON.stringify([
    String(task.id ?? ""),
    String(task.provider ?? ""),
    String(task.threadId ?? ""),
    String(task.streamId ?? ""),
    String(task.workspaceId ?? ""),
  ]);
}

function updateComposerTaskGenerations(previousTasks, nextTasks) {
  const previous = new Map((previousTasks ?? []).map((task) => [task.id, composerTaskIdentity(task)]));
  const next = new Map((nextTasks ?? []).map((task) => [task.id, composerTaskIdentity(task)]));
  for (const id of new Set([...previous.keys(), ...next.keys()])) {
    if (previous.get(id) === next.get(id)) continue;
    composerTaskGenerations.set(id, (composerTaskGenerations.get(id) ?? 0) + 1);
    discardAttachmentPreviews(id);
  }
}

function removeComposerTask(taskId) {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  if (pendingComposerRequest?.taskId === id) {
    recordRecoveryInvalidation(id, pendingComposerRequest.requestId);
    pendingComposerRequest = null;
  }
  composerDraftReconciliation.remove(id);
  discardAttachmentPreviews(id);
  attachmentOperationSequences.delete(id);
  annotationOperationSequences.delete(id);
}

function captureComposerTaskOperation(taskId = state.selectedId) {
  const id = String(taskId ?? "").trim();
  const task = state.tasks.find((candidate) => candidate.id === id);
  if (!id || !task) return null;
  return {
    taskId: id,
    taskIdentity: composerTaskIdentity(task),
    taskGeneration: composerTaskGenerations.get(id) ?? 0,
    editRevision: composerDraftReconciliation.revision(id),
  };
}

function composerTaskOperationCurrent(operation, { allowDraftEdits = false } = {}) {
  if (!operation) return false;
  const task = state.tasks.find((candidate) => candidate.id === operation.taskId);
  return Boolean(task)
    && composerTaskIdentity(task) === operation.taskIdentity
    && (composerTaskGenerations.get(operation.taskId) ?? 0) === operation.taskGeneration
    && (allowDraftEdits || composerDraftReconciliation.revision(operation.taskId) === operation.editRevision);
}

function advanceComposerAsyncOperationFence(taskId) {
  const id = String(taskId ?? "").trim();
  if (!id) return;
  attachmentOperationSequences.set(id, (attachmentOperationSequences.get(id) ?? 0) + 1);
  annotationOperationSequences.set(id, (annotationOperationSequences.get(id) ?? 0) + 1);
  discardAttachmentPreviews(id);
}

function taskNavigationData(task) {
  if (!task) return null;
  const {
    context,
    providerStart: _providerStart,
    providerTurnTelemetry: _providerTurnTelemetry,
    streamSettings: _streamSettings,
    workspaceSettings: _workspaceSettings,
    streamDeveloperRules: _streamDeveloperRules,
    workspaceDeveloperRules: _workspaceDeveloperRules,
    ...navigation
  } = task;
  return {
    ...navigation,
    workspaceFolder: window.AgentHubStreamTabs.normalizeWorkspaceFolderName(
      task.workspaceSettings?.catalogFolder,
    ),
    lastActivity: task.running ? task.startedAt ?? null : task.lastActivity ?? null,
    compactionStatus: context?.compaction?.status ?? null,
  };
}

function taskChatData(task) {
  if (!task) return null;
  const {
    providerStart: _providerStart,
    providerTurnTelemetry: _providerTurnTelemetry,
    ...chat
  } = task;
  return {
    ...chat,
    lastActivity: task.running ? task.startedAt ?? null : task.lastActivity ?? null,
  };
}

function changedTaskIds(previousTasks, nextTasks, project) {
  const previousById = new Map(previousTasks.map((task) => [task.id, task]));
  const nextIds = new Set(nextTasks.map((task) => task.id));
  const changed = new Set(previousTasks
    .filter((task) => !nextIds.has(task.id))
    .map((task) => task.id));
  for (const task of nextTasks) {
    if (!sameData(project(previousById.get(task.id)), project(task))) changed.add(task.id);
  }
  return changed;
}

function discardPersistedRecovery(requestId) {
  try {
    const current = JSON.parse(localStorage.getItem(draftStorageKey()) ?? "[]");
    const scrubbed = Array.isArray(current)
      ? current.filter((entry) => String(entry?.recoveryRequestId ?? "") !== requestId)
      : [];
    if (scrubbed.length) localStorage.setItem(draftStorageKey(), JSON.stringify(scrubbed));
    else localStorage.removeItem(draftStorageKey());
    return true;
  } catch {
    try {
      localStorage.removeItem(draftStorageKey());
      return true;
    } catch {
      // The independent IndexedDB epoch remains authoritative across WebView
      // recreation even when the stale localStorage record cannot be scrubbed.
      return false;
    }
  }
}

function persistDrafts({ requiredRecoveryRequestId = "" } = {}) {
  queueMicrotask(pruneComposerFiles);
  let requiredRecoveryRepresented = !requiredRecoveryRequestId;
  let everyDraftRepresented = true;
  let recoveryCharacters = 0;
  const eligible = [...drafts.entries()]
    .filter(([taskId, draft]) => String(taskId).trim() && (
      draft?.text || draft?.annotations?.length || draft?.taskReferences?.length
      || draft?.attachments?.length
    ));
  const selected = eligible.slice(-DRAFT_STORAGE_MAX_TASKS);
  if (selected.length !== eligible.length) everyDraftRepresented = false;
  const persisted = selected
    .map(([taskId, draft]) => {
      const recoveryRequestId = String(draft?.recoveryRequestId ?? "").trim();
      const recoveryFingerprint = String(draft?.recoveryFingerprint ?? "");
      const rawAttachments = Array.isArray(draft?.attachments) ? draft.attachments : [];
      const attachmentCharacters = recoveryRequestId ? rawAttachments.reduce((sum, attachment) => (
        sum + (attachment?.blobId ? 0 : String(attachment?.dataUrl ?? "").length)
      ), 0) : 0;
      const withinSurfaceBound = recoveryCharacters + attachmentCharacters
        <= DRAFT_RECOVERY_MAX_ATTACHMENT_CHARS;
      const recoveryAttachments = withinSurfaceBound && rawAttachments.every(window.AgentHubComposerFiles.durable)
        ? window.AgentHubComposerDraftReconciliation.recoveryAttachments(rawAttachments, {
          maxCount: DRAFT_RECOVERY_MAX_ATTACHMENTS,
          maxDataUrlCharacters: DRAFT_RECOVERY_MAX_ATTACHMENT_CHARS - recoveryCharacters,
          maxBytes: DRAFT_ATTACHMENT_MAX_BYTES,
          maxTotalBytes: DRAFT_ATTACHMENT_MAX_TOTAL_BYTES,
        })
        : null;
      const candidate = {
        taskId,
        text: normalizedDraftText(draft.text),
        taskReferences: (draft.taskReferences ?? [])
          .map((reference) => TaskReferences.normalize(reference))
          .filter(Boolean),
        annotations: normalizedDraftAnnotations(draft.annotations),
      };
      const exactRecovery = Boolean(
        composerRecoveryAuthorityReady
        && composerRecoveryAuthorityTrusted
        && composerRecoveryAuthorityPending === 0
        && recoveryRequestId
        && recoveryFingerprint
        && recoveryAttachments
      )
        && window.AgentHubComposerDraftReconciliation.recoveryFingerprint({
          ...candidate,
          attachments: recoveryAttachments,
        }) === recoveryFingerprint;
      if (exactRecovery) recoveryCharacters += attachmentCharacters;
      const serializedAttachments = (!recoveryRequestId || exactRecovery) && recoveryAttachments
        ? recoveryAttachments.map(window.AgentHubComposerFiles.serialized) : [];
      const exactSerializedPayload = String(draft?.text ?? "") === candidate.text
        && JSON.stringify(draft?.taskReferences ?? []) === JSON.stringify(candidate.taskReferences)
        && JSON.stringify(draft?.annotations ?? []) === JSON.stringify(candidate.annotations)
        && rawAttachments.length === serializedAttachments.length;
      if (!exactSerializedPayload) everyDraftRepresented = false;
      if (recoveryRequestId && !exactRecovery) everyDraftRepresented = false;
      if (recoveryRequestId === requiredRecoveryRequestId && exactRecovery) {
        requiredRecoveryRepresented = true;
      }
      return {
        ...candidate,
        attachments: serializedAttachments,
        ...(exactRecovery ? {
          recoveryRequestId,
          recoveryFingerprint,
          recoveryEpoch: composerRecoveryAuthorityEpoch,
        } : {}),
      };
    })
    .filter(Boolean);
  if (!requiredRecoveryRepresented) {
    discardPersistedRecovery(requiredRecoveryRequestId);
    return false;
  }
  try {
    if (persisted.length) localStorage.setItem(draftStorageKey(), JSON.stringify(persisted));
    else localStorage.removeItem(draftStorageKey());
    return everyDraftRepresented;
  } catch {
    if (requiredRecoveryRequestId) discardPersistedRecovery(requiredRecoveryRequestId);
    return false;
  }
}

function currentTask() {
  return state.tasks.find((task) => task.id === state.selectedId) ?? null;
}

function pinsForTask(task = currentTask()) {
  const streamId = String(task?.streamId ?? "").trim();
  return streamId ? state.messagePins.filter((pin) => pin.streamId === streamId) : [];
}

function activePinForTask(task = currentTask()) {
  const pins = pinsForTask(task);
  if (!pins.length) return null;
  const streamId = String(task.streamId);
  const selectedPinId = state.activeMessagePinByStream.get(streamId);
  const index = Math.max(0, pins.findIndex((pin) => pin.id === selectedPinId));
  const pin = pins[index] ?? pins[0];
  state.activeMessagePinByStream.set(streamId, pin.id);
  return { pin, pins, index };
}

function setActiveMessagePinId(streamId, pinId = "") {
  const normalizedStreamId = String(streamId ?? "").trim();
  if (!normalizedStreamId) return;
  if (pinId) state.activeMessagePinByStream.set(normalizedStreamId, pinId);
  else state.activeMessagePinByStream.delete(normalizedStreamId);
}

function selectedMessagePinId(streamId, pins = state.messagePins) {
  const streamPins = pins.filter((pin) => pin.streamId === streamId);
  const selectedPinId = state.activeMessagePinByStream.get(streamId);
  return streamPins.some((pin) => pin.id === selectedPinId)
    ? selectedPinId
    : streamPins[0]?.id ?? "";
}

function selectMessagePinAfterRemoval({ streamId, removedIndex, pins = state.messagePins }) {
  const streamPins = pins.filter((pin) => pin.streamId === streamId);
  if (!streamPins.length) {
    setActiveMessagePinId(streamId);
    return;
  }
  const index = Math.min(Math.max(0, removedIndex), streamPins.length - 1);
  setActiveMessagePinId(streamId, streamPins[index].id);
}

function reconcilePendingMessagePins(pins) {
  let reconciled = pins.slice();
  for (const backup of state.messagePinMutationBackups.values()) {
    if (backup.pinned) {
      const committed = reconciled.find((pin) => (
        pin.streamId === backup.streamId && pin.messageKey === backup.messageKey
      ));
      if (committed) {
        if (state.activeMessagePinByStream.get(backup.streamId) === backup.optimisticPinId) {
          setActiveMessagePinId(backup.streamId, committed.id);
        }
        continue;
      }
      const optimistic = state.messagePins.find((pin) => pin.id === backup.optimisticPinId);
      if (optimistic) reconciled.unshift(optimistic);
      continue;
    }
    reconciled = reconciled.filter((pin) => !(
      pin.streamId === backup.streamId
      && (pin.id === backup.targetPinId || pin.messageKey === backup.messageKey)
    ));
  }
  return reconciled;
}

function pinMetaLabel(pin) {
  const role = pin?.role === "user" ? "Вы" : String(pin?.author ?? "Агент").trim() || "Агент";
  const timestamp = MessageView.messageTimestampLabel(pin?.time);
  return [role, timestamp].filter(Boolean).join(" · ");
}

function messagePinIcon(name, className = "") {
  return window.AgentHubStreamTabs.createPhosphorIcon(document, name, className);
}

function jumpToMessagePin(pin) {
  if (!pin?.available) return;
  emit("message-pin:open", { pin });
}

function setActiveMessagePin(indexDelta) {
  const current = activePinForTask();
  if (!current || current.pins.length < 2) return;
  const index = (current.index + indexDelta + current.pins.length) % current.pins.length;
  state.activeMessagePinByStream.set(current.pin.streamId, current.pins[index].id);
  renderMessagePinShelf();
}

function renderMessagePinShelf() {
  if (!messagePinShelf) return;
  const current = activePinForTask();
  messagePinShelf.hidden = !current;
  if (!current) return;
  const { pin, pins, index } = current;
  messagePinCurrent.replaceChildren(
    el("span", { class: "message-pin-current-meta", text: pinMetaLabel(pin) }),
    el("span", {
      class: "message-pin-current-preview",
      text: pin.available ? pin.preview : `Недоступно · ${pin.preview}`,
    }),
  );
  messagePinCurrent.disabled = !pin.available;
  messagePinCurrent.title = pin.available ? "Перейти к сообщению" : "Исходное сообщение недоступно";
  messagePinPosition.textContent = `${index + 1} из ${pins.length}`;
  messagePinPrevious.disabled = pins.length < 2;
  messagePinNext.disabled = pins.length < 2;
  messagePinStatus.textContent = pin.available
    ? `Закреплённое сообщение ${index + 1} из ${pins.length}`
    : `Закреплённое сообщение ${index + 1} из ${pins.length} недоступно`;
}

function closeMessagePins() {
  messagePinsModal?.close();
  messagePinsOpen?.focus({ preventScroll: true });
}

function renderMessagePinsList() {
  if (!messagePinsList) return;
  const pins = pinsForTask();
  messagePinsList.replaceChildren(...pins.map((pin) => {
    const pending = state.pendingMessagePinKeys.has(pin.messageKey);
    const row = el("article", {
      class: "message-pin-row",
      "data-message-pin-id": pin.id,
      ...(pin.available ? {} : { "data-unavailable": "" }),
    });
    row.append(
      el("div", { class: "message-pin-row-copy" }, [
        el("span", { class: "message-pin-row-meta", text: pinMetaLabel(pin) }),
        el("p", { text: pin.preview }),
        pin.available ? null : el("span", { class: "message-pin-unavailable", text: "Исходное сообщение недоступно" }),
      ]),
      el("div", { class: "message-pin-row-actions" }, [
        el("button", {
          type: "button",
          class: "chip-button",
          text: "Перейти",
          disabled: !pin.available,
          "data-message-pin-jump": pin.id,
        }),
        el("button", {
          type: "button",
          class: "chip-button ghost",
          text: "Открепить",
          disabled: pending,
          "data-message-pin-remove": pin.id,
        }),
      ]),
    );
    return row;
  }));
  messagePinsClear.disabled = pins.length === 0;
}

function openMessagePins() {
  renderMessagePinsList();
  const mobileSheet = surface === "mobile" || window.innerWidth <= 760;
  if (messagePinsModal && !mobileSheet && messagePinShelf) {
    const rect = messagePinShelf.getBoundingClientRect();
    const width = Math.min(620, window.innerWidth - 32);
    messagePinsModal.style.left = `${Math.max(16, Math.min(window.innerWidth - width - 16, rect.right - width))}px`;
    messagePinsModal.style.top = `${Math.min(window.innerHeight - 160, rect.bottom + 6)}px`;
  } else {
    messagePinsModal?.style.removeProperty("left");
    messagePinsModal?.style.removeProperty("top");
  }
  messagePinsModal?.showModal();
}

function requestMessagePinChange({ message = null, pin = null, pinned, undoToken = "" }) {
  const task = currentTask();
  const streamId = String(task?.streamId ?? pin?.streamId ?? "").trim();
  const messageKey = String(message?.messageKey ?? pin?.messageKey ?? "").trim();
  if (!streamId || (!messageKey && !undoToken)) return;
  const mutationId = crypto.randomUUID();
  const previous = state.messagePins.slice();
  const streamPins = previous.filter((candidate) => candidate.streamId === streamId);
  const selectedPinId = selectedMessagePinId(streamId, previous);
  const removedIndex = Math.max(0, streamPins.findIndex((candidate) => candidate.id === pin?.id));
  const backup = {
    pins: previous,
    messageKey,
    streamId,
    selectedPinId,
    targetPinId: pin?.id ?? "",
    removedIndex,
    pinned: Boolean(pinned),
    optimisticPinId: "",
  };
  if (pinned && !undoToken) {
    backup.optimisticPinId = `optimistic:${mutationId}`;
    state.messagePins = [{
      id: backup.optimisticPinId,
      streamId,
      messageKey,
      provider: message.provider ?? task.provider,
      taskThreadId: message.threadId ?? task.threadId,
      turnThreadId: message.threadId ?? task.threadId,
      turnId: message.turnId,
      itemId: message.itemId,
      role: message.role,
      preview: String(message.text ?? "").replace(/\s+/gu, " ").trim().slice(0, 320),
      author: message.author ?? "",
      time: message.time ?? null,
      pinnedAt: new Date().toISOString(),
      available: true,
    }, ...state.messagePins];
    setActiveMessagePinId(streamId, backup.optimisticPinId);
  } else if (!undoToken) {
    state.messagePins = state.messagePins.filter((candidate) => candidate.id !== pin?.id);
    if (selectedPinId === pin?.id) {
      selectMessagePinAfterRemoval({ streamId, removedIndex });
    }
  }
  state.messagePinMutationBackups.set(mutationId, backup);
  if (messageKey) state.pendingMessagePinKeys.add(messageKey);
  renderMessagePinShelf();
  renderMessagePinsList();
  renderMessages({ preserveTop: true });
  emit("message-pin:set", {
    mutationId,
    pinned,
    streamId,
    pinId: pin?.id,
    messageKey,
    undoToken,
    provider: message?.provider,
    taskThreadId: message?.threadId,
    turnId: message?.turnId,
    itemId: message?.itemId,
    role: message?.role,
  });
}

messagePinPrevious?.replaceChildren(messagePinIcon("caret-left"));
messagePinNext?.replaceChildren(messagePinIcon("caret-right"));
messagePinsOpen?.replaceChildren(messagePinIcon("list-bullets"));
messagePinCurrent?.addEventListener("click", () => jumpToMessagePin(activePinForTask()?.pin));
messagePinPrevious?.addEventListener("click", () => setActiveMessagePin(-1));
messagePinNext?.addEventListener("click", () => setActiveMessagePin(1));
messagePinsOpen?.addEventListener("click", openMessagePins);
document.querySelector("[data-message-pins-close]")?.addEventListener("click", closeMessagePins);
modalOverlays?.installDismissibleOverlay({ dialog: messagePinsModal, close: closeMessagePins });
messagePinsList?.addEventListener("click", (event) => {
  const jump = event.target.closest("[data-message-pin-jump]");
  const remove = event.target.closest("[data-message-pin-remove]");
  const pinId = String(jump?.dataset.messagePinJump ?? remove?.dataset.messagePinRemove ?? "");
  const pin = state.messagePins.find((candidate) => candidate.id === pinId);
  if (!pin) return;
  if (jump) {
    closeMessagePins();
    jumpToMessagePin(pin);
  } else requestMessagePinChange({ pin, pinned: false });
});
messagePinsClear?.addEventListener("click", () => {
  const count = pinsForTask().length;
  if (!count) return;
  messagePinsClearCopy.textContent = `${count} закреплённых сообщений будут откреплены.`;
  messagePinsClearModal?.showModal();
});
function closeMessagePinsClear() {
  messagePinsClearModal?.close();
  messagePinsClear?.focus({ preventScroll: true });
}
document.querySelector("[data-message-pins-clear-cancel]")?.addEventListener("click", closeMessagePinsClear);
modalOverlays?.installDismissibleOverlay({ dialog: messagePinsClearModal, close: closeMessagePinsClear });
document.querySelector("[data-message-pins-clear-confirm]")?.addEventListener("click", () => {
  const task = currentTask();
  const streamId = String(task?.streamId ?? "").trim();
  if (!streamId) return;
  const mutationId = crypto.randomUUID();
  state.messagePinMutationBackups.set(mutationId, { pins: state.messagePins.slice(), messageKey: "" });
  state.messagePins = state.messagePins.filter((pin) => pin.streamId !== streamId);
  closeMessagePinsClear();
  closeMessagePins();
  renderMessagePinShelf();
  renderMessages({ preserveTop: true });
  emit("message-pins:clear", { mutationId, streamId });
});

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
const COLLAPSED_WORKSPACE_FOLDERS_STORAGE_VERSION = "agent-hub:workspace-collapsed-folders:v1";
let collapsedWorkspaceFoldersRestored = false;
/* Идея и постановка пользовательской группировки Workspace принадлежат
   ZeroFakt (GitHub), 01.09.2026. Папки остаются отдельной сущностью интерфейса,
   чтобы их создание не перемещало выбранный Workspace неявно. */
const WORKSPACE_FOLDERS_STORAGE_VERSION = "agent-hub:workspace-folders:v1";
let workspaceFoldersRestored = false;

function openStreamsStorageKey() {
  return `${OPEN_STREAMS_STORAGE_VERSION}:${draftStorageSurface()}`;
}

function collapsedWorkspaceFoldersStorageKey() {
  return `${COLLAPSED_WORKSPACE_FOLDERS_STORAGE_VERSION}:${draftStorageSurface()}`;
}

function workspaceFoldersStorageKey() {
  return `${WORKSPACE_FOLDERS_STORAGE_VERSION}:${draftStorageSurface()}`;
}

function restoreWorkspaceFolders() {
  if (workspaceFoldersRestored) return;
  workspaceFoldersRestored = true;
  try {
    const stored = JSON.parse(localStorage.getItem(workspaceFoldersStorageKey()) ?? "[]");
    if (!Array.isArray(stored)) return;
    state.workspaceFolderNames = new Set(
      window.AgentHubStreamTabs.workspaceFolderNames([], stored).slice(0, 100),
    );
  } catch {
    // Недоступный localStorage оставляет каталог папок в памяти текущей вкладки.
  }
}

function persistWorkspaceFolders() {
  try {
    localStorage.setItem(
      workspaceFoldersStorageKey(),
      JSON.stringify([...state.workspaceFolderNames].slice(0, 100)),
    );
  } catch {
    // Каталог папок остаётся действительным до закрытия вкладки.
  }
}

function workspaceFolderCatalogNames() {
  restoreWorkspaceFolders();
  const names = window.AgentHubStreamTabs.workspaceFolderNames(
    state.workspaces,
    state.workspaceFolderNames,
  );
  if (names.some((name) => !state.workspaceFolderNames.has(name))) {
    state.workspaceFolderNames = new Set(names);
    persistWorkspaceFolders();
  }
  return names;
}

function createWorkspaceFolder(requestedName) {
  const folderName = window.AgentHubStreamTabs.normalizeWorkspaceFolderName(requestedName);
  if (!folderName) return false;
  const duplicate = workspaceFolderCatalogNames().find((name) => (
    name.toLocaleLowerCase("ru") === folderName.toLocaleLowerCase("ru")
  ));
  if (duplicate) {
    showToast(`Папка «${duplicate}» уже существует`);
    return false;
  }
  state.workspaceFolderNames.add(folderName);
  persistWorkspaceFolders();
  renderTasks();
  showToast(`Папка «${folderName}» создана`);
  return true;
}

function renameWorkspaceFolderCatalog(fromFolderName, toFolderName) {
  const fromName = window.AgentHubStreamTabs.normalizeWorkspaceFolderName(fromFolderName);
  const toName = window.AgentHubStreamTabs.normalizeWorkspaceFolderName(toFolderName);
  if (!fromName || !toName || fromName === toName) return false;
  restoreWorkspaceFolders();
  state.workspaceFolderNames.delete(fromName);
  state.workspaceFolderNames.add(toName);
  persistWorkspaceFolders();
  restoreCollapsedWorkspaceFolders();
  for (const oldKey of [fromName, `folder:${fromName}`]) {
    if (!state.collapsedWorkspaceFolders.delete(oldKey)) continue;
    state.collapsedWorkspaceFolders.add(`folder:${toName}`);
  }
  persistCollapsedWorkspaceFolders();
  renderTasks();
  return true;
}

function populateWorkspaceFolderSelect(selectedName = "") {
  if (!workspaceCardFolder) return;
  const normalizedSelected = window.AgentHubStreamTabs.normalizeWorkspaceFolderName(selectedName);
  const names = workspaceFolderCatalogNames();
  workspaceCardFolder.replaceChildren(
    el("option", { value: "", text: "Без папки — общий список" }),
    ...names.map((name) => el("option", { value: name, text: name })),
  );
  workspaceCardFolder.value = names.includes(normalizedSelected) ? normalizedSelected : "";
}

function renderWorkspaceArchive() {
  const items = window.AgentHubStreamTabs.workspaceArchivePresentation(state.archivedWorkspaces);
  if (workspaceArchiveOpen) workspaceArchiveOpen.hidden = items.length === 0;
  if (workspaceArchiveCount) workspaceArchiveCount.textContent = String(items.length);
  if (workspaceArchiveEmpty) workspaceArchiveEmpty.hidden = items.length > 0;
  if (!workspaceArchiveList) return;
  workspaceArchiveList.hidden = items.length === 0;
  workspaceArchiveList.replaceChildren(...items.map((workspace) => el("article", {
    class: "workspace-archive-item",
  }, [
    el("strong", { text: workspace.name || "Без названия" }),
    el("span", {
      text: `${workspace.streamCount} Streams · ${workspace.threadCount} Threads · хранится бессрочно`,
    }),
    el("span", { class: "workspace-archive-actions" }, [
      el("button", {
        type: "button",
        class: "board-task-quiet workspace-archive-restore",
        "data-workspace-archive-restore": workspace.id,
        text: "Восстановить",
      }),
      el("button", {
        type: "button",
        class: "workspace-archive-delete",
        "data-workspace-archive-delete": workspace.id,
        text: "Удалить окончательно",
      }),
    ]),
  ])));
}

function openWorkspaceArchive() {
  renderWorkspaceArchive();
  workspaceArchiveModal?.showModal();
}

function closeWorkspaceArchive() {
  if (workspaceArchiveModal?.open) workspaceArchiveModal.close();
}

function restoreCollapsedWorkspaceFolders() {
  if (collapsedWorkspaceFoldersRestored) return;
  collapsedWorkspaceFoldersRestored = true;
  try {
    const stored = JSON.parse(localStorage.getItem(collapsedWorkspaceFoldersStorageKey()) ?? "[]");
    if (!Array.isArray(stored)) return;
    state.collapsedWorkspaceFolders = new Set(stored
      .map((value) => String(value ?? "").trim())
      .filter(Boolean)
      .slice(0, 100));
  } catch {
    // Недоступный localStorage оставляет папки открытыми в текущей вкладке.
  }
}

function persistCollapsedWorkspaceFolders() {
  try {
    localStorage.setItem(
      collapsedWorkspaceFoldersStorageKey(),
      JSON.stringify([...state.collapsedWorkspaceFolders].slice(0, 100)),
    );
  } catch {
    // Состояние папок остаётся действительным до закрытия вкладки.
  }
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

function orderedWorkspaceStreams(streams, workspaceId = workspaceKey(currentTask())) {
  return window.AgentHubStreamTabs.orderWorkspaceStreams(
    streams,
    streamOrderMode,
    window.AgentHubStreamTabs.pinnedWorkspaceStreamIds(state.selection, workspaceId),
  );
}

function togglePinnedWorkspaceStream(workspaceId, streamId) {
  const pinnedWorkspaceStreams = window.AgentHubStreamTabs.togglePinnedWorkspaceStream(
    state.selection,
    workspaceId,
    streamId,
  );
  state.selection = { ...state.selection, pinnedWorkspaceStreams };
  renderStreamTabs();
  emit("selection:set", { key: "pinnedWorkspaceStreams", value: pinnedWorkspaceStreams });
}

function currentQuickMessageContext() {
  const task = currentTask();
  if (!task) return null;
  return {
    streamId: streamKey(task),
    streamName: String(task.streamName ?? task.streamDisplayName ?? "Stream").trim() || "Stream",
    workspaceId: workspaceKey(task),
    workspaceName: String(task.workspaceName ?? task.title ?? "Workspace").trim() || "Workspace",
  };
}

function quickMessageEntriesForCurrentTask() {
  const context = currentQuickMessageContext();
  if (!context) return [];
  return window.AgentHubStreamTabs.quickMessagesForStream(
    state.selection,
    context.workspaceId,
    context.streamId,
  );
}

function quickMessagesForScope(scope, scopeId = "") {
  const quickMessages = window.AgentHubStreamTabs.normalizeQuickMessages(state.selection.quickMessages);
  if (scope === "global") return quickMessages.global;
  const id = String(scopeId ?? "").trim();
  if (!id) return [];
  const key = scope === "workspace" ? "workspaces" : "streams";
  return quickMessages[key][id] ?? [];
}

function quickMessagesCountText(entries) {
  const count = window.AgentHubStreamTabs.normalizeQuickMessages({ global: entries }).global.length;
  return window.AgentHubStreamTabs.quickMessagesCountLabel(count);
}

const quickMessageEditorStates = new Map();
const quickMessageEditorBindings = new WeakMap();
const quickMessageMutations = new Map();
const quickMessagePendingMutationIds = new Set();
let quickMessageEditorNextId = 0;
let quickMessageMutationNextId = 0;

function quickMessageOwnerKey(scope, scopeId = "") {
  const normalizedScope = scope === "global" ? "global" : scope === "workspace" ? "workspace" : "stream";
  const normalizedId = normalizedScope === "global" ? "" : String(scopeId ?? "").trim();
  return `${normalizedScope}\0${normalizedId}`;
}

function quickMessageEditorItem(entry, id = "") {
  return {
    id: id || `prompt-template-${++quickMessageEditorNextId}`,
    title: String(entry?.title ?? entry?.label ?? entry?.text ?? ""),
    text: String(entry?.text ?? ""),
  };
}

function quickMessageEditorSignature(entries) {
  return JSON.stringify((Array.isArray(entries) ? entries : []).map((entry) => ({
    title: String(entry?.title ?? entry?.label ?? entry?.text ?? "").trim(),
    text: String(entry?.text ?? "").trim(),
  })).filter((entry) => entry.title || entry.text));
}

function quickMessageEditorState(container, ownerKey, entries = []) {
  quickMessageEditorBindings.set(container, ownerKey);
  let editorState = quickMessageEditorStates.get(ownerKey);
  if (!editorState) {
    const items = (Array.isArray(entries) ? entries : []).map((entry) => quickMessageEditorItem(entry));
    editorState = {
      items,
      openId: items[0]?.id ?? "",
      projectedSignature: quickMessageEditorSignature(entries),
      keepDraft: false,
      error: "",
      disabled: false,
    };
    quickMessageEditorStates.set(ownerKey, editorState);
  }
  return editorState;
}

function boundQuickMessageEditorState(container) {
  const ownerKey = quickMessageEditorBindings.get(container);
  return ownerKey ? quickMessageEditorStates.get(ownerKey) : null;
}

function reconcileQuickMessageEditorState(editorState, entries) {
  const values = Array.isArray(entries) ? entries : [];
  const signature = quickMessageEditorSignature(values);
  if (editorState.keepDraft || signature === editorState.projectedSignature) return;
  const unused = new Set(editorState.items);
  editorState.items = values.map((entry, index) => {
    const normalized = quickMessageEditorItem(entry, "candidate");
    const exact = [...unused].find((item) => (
      item.title.trim() === normalized.title.trim() && item.text.trim() === normalized.text.trim()
    ));
    const positional = unused.has(editorState.items[index]) ? editorState.items[index] : null;
    const previous = exact ?? positional;
    if (previous) unused.delete(previous);
    return quickMessageEditorItem(entry, previous?.id);
  });
  editorState.projectedSignature = signature;
  if (!editorState.items.some((item) => item.id === editorState.openId)) {
    editorState.openId = editorState.items[0]?.id ?? "";
  }
}

function quickMessageEditorEntries(container) {
  const editorState = boundQuickMessageEditorState(container);
  return (editorState?.items ?? []).map(({ title, text }) => ({
    title: String(title).trim(),
    text: String(text).trim(),
  }));
}

function validQuickMessageEditorEntries(container) {
  return quickMessageEditorEntries(container).filter((entry) => entry.title || entry.text);
}

function quickMessageEditorIcon(name, className = "") {
  return window.AgentHubStreamTabs.createPhosphorIcon(document, name, className);
}

function quickMessageEditorActionButton({ action, icon, label = "", title, disabled = false, className = "" }) {
  return el("button", {
    type: "button",
    class: `quick-message-editor-action ${className}`.trim(),
    title,
    "aria-label": title,
    "data-quick-message-action": action,
    disabled,
  }, [
    quickMessageEditorIcon(icon, "quick-message-editor-action-icon"),
    label ? el("span", { text: label }) : null,
  ].filter(Boolean));
}

function quickMessageEditorRow(entry, index, count, openId, disabled) {
  const expanded = entry.id === openId;
  const panelId = `${entry.id}-panel`;
  const title = entry.title.trim() || "Без названия";
  const preview = entry.text.trim() || "Пустой шаблон";
  return el("div", {
    class: `quick-message-editor-row${expanded ? " is-open" : ""}`,
    "data-quick-message-row": entry.id,
    "data-quick-message-index": String(index),
  }, [
    el("div", { class: "quick-message-editor-summary-row" }, [
      el("button", {
        type: "button",
        class: "quick-message-editor-summary",
        "data-quick-message-action": "toggle",
        "aria-expanded": String(expanded),
        "aria-controls": panelId,
        disabled,
      }, [
        el("span", { class: "quick-message-editor-number", text: String(index + 1).padStart(2, "0") }),
        el("span", { class: "quick-message-editor-title", text: title }),
        el("span", { class: "quick-message-editor-preview", text: preview }),
      ]),
      el("div", { class: "quick-message-editor-order", "aria-label": `Порядок шаблона ${index + 1}` }, [
        quickMessageEditorActionButton({
          action: "up", icon: "arrow-up", title: `Переместить шаблон ${index + 1} выше`,
          disabled: disabled || index === 0,
        }),
        quickMessageEditorActionButton({
          action: "down", icon: "arrow-down", title: `Переместить шаблон ${index + 1} ниже`,
          disabled: disabled || index === count - 1,
        }),
      ]),
      quickMessageEditorActionButton({
        action: "toggle",
        icon: expanded ? "caret-down" : "caret-right",
        title: expanded ? `Свернуть шаблон ${index + 1}` : `Развернуть шаблон ${index + 1}`,
        disabled,
        className: "toggle",
      }),
    ]),
    el("div", {
      class: "quick-message-editor-details",
      id: panelId,
      hidden: !expanded,
    }, [
      el("input", {
        type: "text",
        maxlength: "64",
        value: entry.title,
        placeholder: "Название шаблона",
        "aria-label": `Название prompt-шаблона ${index + 1}`,
        "data-quick-message-title": "",
        disabled,
      }),
      el("textarea", {
        rows: "5",
        maxlength: "4000",
        text: entry.text,
        placeholder: "Текст промпта…",
        "aria-label": `Текст prompt-шаблона ${index + 1}`,
        "data-quick-message-text": "",
        disabled,
      }),
      el("div", { class: "quick-message-editor-footer" }, [
        el("div", { class: "quick-message-editor-footer-order" }, [
          quickMessageEditorActionButton({
            action: "up", icon: "arrow-up", label: "выше", title: `Переместить шаблон ${index + 1} выше`,
            disabled: disabled || index === 0,
          }),
          quickMessageEditorActionButton({
            action: "down", icon: "arrow-down", label: "ниже", title: `Переместить шаблон ${index + 1} ниже`,
            disabled: disabled || index === count - 1,
          }),
          quickMessageEditorActionButton({
            action: "duplicate", icon: "copy", label: "Дублировать", title: `Дублировать шаблон ${index + 1}`,
            disabled: disabled || count >= 20,
          }),
        ]),
        quickMessageEditorActionButton({
          action: "delete", icon: "trash", label: "Удалить", title: `Удалить шаблон ${index + 1}`,
          disabled, className: "danger",
        }),
      ]),
    ]),
  ]);
}

function quickMessageEditorFocus(container) {
  const active = document.activeElement;
  const row = active?.closest?.("[data-quick-message-row]");
  if (!row || !container.contains(active)) return null;
  return {
    id: row.dataset.quickMessageRow,
    action: active.dataset.quickMessageAction ?? "",
    field: active.hasAttribute("data-quick-message-title")
      ? "title"
      : active.hasAttribute("data-quick-message-text") ? "text" : "",
    start: active.selectionStart,
    end: active.selectionEnd,
  };
}

function restoreQuickMessageEditorFocus(container, focus) {
  if (!focus?.id) return;
  const row = [...container.querySelectorAll("[data-quick-message-row]")]
    .find((candidate) => candidate.dataset.quickMessageRow === focus.id);
  const target = focus.field
    ? row?.querySelector(`[data-quick-message-${focus.field}]`)
    : row?.querySelector(`[data-quick-message-action="${focus.action}"]`);
  if (!target || target.disabled) return;
  target.focus({ preventScroll: true });
  if (focus.field && Number.isInteger(focus.start) && Number.isInteger(focus.end)) {
    target.setSelectionRange?.(focus.start, focus.end);
  }
}

function setQuickMessageEditorCount(container, count) {
  const output = container?.closest(".quick-messages-editor")?.querySelector(".setting-value");
  if (output) output.textContent = window.AgentHubStreamTabs.quickMessagesCountLabel(count);
}

function paintQuickMessagesEditor(container, disabled = false, requestedFocus = null) {
  const editorState = boundQuickMessageEditorState(container);
  if (!container || !editorState) return;
  const preservedFocus = requestedFocus ?? quickMessageEditorFocus(container);
  editorState.disabled = disabled;
  if (editorState.items.length && !editorState.items.some((item) => item.id === editorState.openId)) {
    editorState.openId = editorState.items[0].id;
  }
  const rows = container.querySelector("[data-quick-message-rows]");
  rows?.replaceChildren(...editorState.items.map((entry, index) => (
    quickMessageEditorRow(entry, index, editorState.items.length, editorState.openId, disabled)
  )));
  const error = container.querySelector("[data-quick-message-error]");
  if (error) {
    error.textContent = editorState.error;
    error.hidden = !editorState.error;
  }
  const add = container.querySelector("[data-quick-message-add]");
  if (add) {
    add.disabled = disabled || editorState.items.length >= 20;
    add.replaceChildren(
      quickMessageEditorIcon("plus", "quick-message-editor-add-icon"),
      el("span", { text: "Добавить шаблон" }),
    );
  }
  container.setAttribute("aria-busy", String(disabled));
  restoreQuickMessageEditorFocus(container, preservedFocus);
}

function renderQuickMessagesEditor(container, scope, scopeId, entries, disabled = false) {
  if (!container) return;
  const ownerKey = quickMessageOwnerKey(scope, scopeId);
  const editorState = quickMessageEditorState(container, ownerKey, entries);
  reconcileQuickMessageEditorState(editorState, entries);
  setQuickMessageEditorCount(container, editorState.items.length);
  paintQuickMessagesEditor(container, disabled);
}

function saveQuickMessagesForScope(scope, scopeId, entries, { rerender = true, container = null } = {}) {
  const ownerKey = quickMessageOwnerKey(scope, scopeId);
  /* Область разошлась с хранилищем, пока её правили: запись отключена до
     явного решения человека, иначе черновик затёр бы чужое изменение. */
  if (promptTemplatesConflicts.has(ownerKey)) return;
  if (container && quickMessageEditorBindings.get(container) !== ownerKey) return;
  const editorState = container ? boundQuickMessageEditorState(container) : quickMessageEditorStates.get(ownerKey);
  const mutationId = `quick-messages-${++quickMessageMutationNextId}`;
  const backup = window.AgentHubStreamTabs.normalizeQuickMessages(state.selection.quickMessages);
  if (editorState) {
    editorState.error = "";
    editorState.keepDraft = false;
    editorState.pendingMutationId = mutationId;
    editorState.projectedSignature = quickMessageEditorSignature(entries);
  }
  const quickMessages = window.AgentHubStreamTabs.setQuickMessagesForScope(
    state.selection,
    scope,
    scopeId,
    entries,
  );
  state.selection = { ...state.selection, quickMessages };
  quickMessageMutations.set(mutationId, { ownerKey, backup, rejected: false });
  renderComposerQuickMessages();
  if (rerender) renderQuickMessageSettingsControls();
  emit("selection:set", { key: "quickMessages", value: quickMessages, mutationId });
}

function handleQuickMessageEditorClick(event, container, scope, scopeId) {
  const ownerKey = quickMessageOwnerKey(scope, scopeId);
  if (quickMessageEditorBindings.get(container) !== ownerKey) return;
  const editorState = boundQuickMessageEditorState(container);
  if (!editorState || editorState.disabled) return;
  const add = event.target.closest("[data-quick-message-add]");
  if (add) {
    if (editorState.items.length >= 20) return;
    const item = quickMessageEditorItem({ title: "", text: "" });
    editorState.items.push(item);
    editorState.openId = item.id;
    setQuickMessageEditorCount(container, editorState.items.length);
    paintQuickMessagesEditor(container, false, { id: item.id, field: "title" });
    return;
  }
  const action = event.target.closest("[data-quick-message-action]");
  const row = action?.closest("[data-quick-message-row]");
  if (!action || !row) return;
  const index = editorState.items.findIndex((item) => item.id === row.dataset.quickMessageRow);
  if (index < 0) return;
  const kind = action.dataset.quickMessageAction;
  if (kind === "toggle") {
    editorState.openId = editorState.items[index].id;
    paintQuickMessagesEditor(container, false, { id: editorState.openId, action: "toggle" });
    return;
  }
  let focus = { id: editorState.items[index].id, action: kind };
  if (kind === "delete") {
    editorState.items.splice(index, 1);
    editorState.openId = editorState.items[Math.min(index, editorState.items.length - 1)]?.id ?? "";
    focus = editorState.openId ? { id: editorState.openId, action: "toggle" } : null;
  } else if (kind === "duplicate") {
    if (editorState.items.length >= 20) return;
    const original = editorState.items[index];
    const copy = quickMessageEditorItem({
      title: `${original.title.trim() || "Без названия"} (копия)`,
      text: original.text,
    });
    editorState.items.splice(index + 1, 0, copy);
    editorState.openId = copy.id;
    focus = { id: copy.id, field: "title" };
  } else {
    const nextIndex = kind === "up" ? index - 1 : index + 1;
    if (nextIndex < 0 || nextIndex >= editorState.items.length) return;
    [editorState.items[index], editorState.items[nextIndex]] = [
      editorState.items[nextIndex], editorState.items[index],
    ];
  }
  setQuickMessageEditorCount(container, editorState.items.length);
  paintQuickMessagesEditor(container, false, focus);
  saveQuickMessagesForScope(scope, scopeId, validQuickMessageEditorEntries(container), {
    container,
    rerender: false,
  });
}

function handleQuickMessageEditorInput(event, container) {
  const field = event.target.closest("[data-quick-message-title], [data-quick-message-text]");
  const row = field?.closest("[data-quick-message-row]");
  const editorState = boundQuickMessageEditorState(container);
  const item = editorState?.items.find((candidate) => candidate.id === row?.dataset.quickMessageRow);
  if (!field || !item) return;
  if (field.hasAttribute("data-quick-message-title")) item.title = field.value;
  else item.text = field.value;
  editorState.error = "";
  const summary = row.querySelector(".quick-message-editor-title");
  const preview = row.querySelector(".quick-message-editor-preview");
  if (summary) summary.textContent = item.title.trim() || "Без названия";
  if (preview) preview.textContent = item.text.trim() || "Пустой шаблон";
}

function handleQuickMessageEditorChange(container, scope, scopeId) {
  if (quickMessageEditorBindings.get(container) !== quickMessageOwnerKey(scope, scopeId)) return;
  const entries = validQuickMessageEditorEntries(container);
  saveQuickMessagesForScope(scope, scopeId, entries, { rerender: false, container });
  setQuickMessageEditorCount(container, boundQuickMessageEditorState(container)?.items.length ?? entries.length);
}

function renderGlobalQuickMessagesSettings() {
  const pending = state.pendingSelections.has("quickMessages");
  if (settingsGlobalQuickMessagesCount) {
    settingsGlobalQuickMessagesCount.textContent = quickMessagesCountText(quickMessagesForScope("global"));
  }
  settingsGlobalQuickMessagesEntry?.setAttribute("aria-busy", String(pending));
  refreshOpenPromptTemplates();
}

function renderWorkspaceCardQuickMessages(workspaceId = workspaceCardId) {
  const id = String(workspaceId ?? "").trim();
  const pending = state.pendingSelections.has("quickMessages");
  const createMode = workspaceCardMode === "create" || !id;
  if (workspaceCardQuickMessagesCount) {
    workspaceCardQuickMessagesCount.textContent = createMode
      ? "Доступно после создания"
      : quickMessagesCountText(quickMessagesForScope("workspace", id));
  }
  if (workspaceCardQuickMessagesEntry) {
    workspaceCardQuickMessagesEntry.disabled = createMode;
    workspaceCardQuickMessagesEntry.title = createMode
      ? "Шаблоны Workspace доступны после создания"
      : "Открыть общую форму prompt-шаблонов";
    workspaceCardQuickMessagesEntry.setAttribute("aria-busy", String(pending));
  }
  refreshOpenPromptTemplates();
}

function renderStreamQuickMessagesSettings() {
  const task = currentTask();
  const streamId = String(task?.streamId ?? "").trim();
  if (dialogStreamQuickMessagesCount) {
    dialogStreamQuickMessagesCount.textContent = streamId
      ? quickMessagesCountText(quickMessagesForScope("stream", streamId))
      : "Недоступно";
  }
  if (dialogStreamQuickMessagesEntry) dialogStreamQuickMessagesEntry.disabled = !streamId;
  refreshOpenPromptTemplates();
}

function renderQuickMessageSettingsControls() {
  renderGlobalQuickMessagesSettings();
  renderWorkspaceCardQuickMessages();
  renderStreamQuickMessagesSettings();
}

function rejectQuickMessagesSelection(mutationId = "") {
  const mutation = quickMessageMutations.get(String(mutationId ?? ""));
  if (!mutation) return;
  state.selection = { ...state.selection, quickMessages: mutation.backup };
  const editorState = quickMessageEditorStates.get(mutation.ownerKey);
  if (editorState?.pendingMutationId === mutationId) {
    editorState.keepDraft = true;
    editorState.error = "Не удалось сохранить. Черновик оставлен в редакторе.";
  }
  mutation.rejected = true;
  renderComposerQuickMessages();
  renderQuickMessageSettingsControls();
}

function settleQuickMessagesSelection(mutationId = "") {
  const key = String(mutationId ?? "");
  const mutation = quickMessageMutations.get(key);
  if (!mutation) return;
  const editorState = quickMessageEditorStates.get(mutation.ownerKey);
  if (editorState?.pendingMutationId === key) {
    if (!mutation.rejected) {
      editorState.keepDraft = false;
      editorState.error = "";
    }
    editorState.pendingMutationId = "";
  }
  quickMessageMutations.delete(key);
}

/* ------------------------------------------ общая форма prompt-шаблонов */

/* Один и тот же редактор стоял сразу в трёх местах и в узкой панели настроек
   не помещался. Теперь он один и живёт в общей форме, а прежние места её
   открывают с нужной областью. Сам редактор, его состояние, ошибки и учёт
   незавершённых сохранений остались прежними: форма их переносит, а не
   заменяет, поэтому и запись идёт единственным прежним путём. */
const PROMPT_TEMPLATE_SCOPES = ["global", "workspace", "stream"];
const PROMPT_TEMPLATE_SCOPE_NOTES = {
  global: "Видны во всех Workspace и Stream.",
  workspace: "Видны во всех Stream этого Workspace.",
  stream: "Видны только в этом Stream.",
};

let promptTemplatesScope = "global";
let promptTemplatesContext = { streamId: "", streamName: "", workspaceId: "", workspaceName: "" };
let promptTemplatesReturnFocus = null;
/* Область считается правленой с первого ввода, и тогда же запоминается точка
   отсчёта — снимок хранилища на этот момент. Пока область правится, входящее
   обновление её черновик не подменяет. Если оно изменило ту же область, это
   расхождение: до явного решения человека ни один путь записи не срабатывает
   и форма не закрывается, чтобы черновик не потерялся. */
const promptTemplatesEditBase = new Map();
const promptTemplatesConflicts = new Set();

function promptTemplateScopeId(scope) {
  if (scope === "workspace") return promptTemplatesContext.workspaceId;
  if (scope === "stream") return promptTemplatesContext.streamId;
  return "";
}

function promptTemplateScopeAvailable(scope) {
  return scope === "global" || Boolean(promptTemplateScopeId(scope));
}

function promptTemplateScopeName(scope) {
  if (scope === "global") return "Глобальные";
  if (scope === "workspace") return promptTemplatesContext.workspaceName || "Workspace";
  return promptTemplatesContext.streamName || "Stream";
}

function promptTemplateScopeEntries(scope) {
  return promptTemplateScopeAvailable(scope)
    ? quickMessagesForScope(scope, promptTemplateScopeId(scope))
    : [];
}

function promptTemplatesOwnerKey(scope = promptTemplatesScope) {
  return quickMessageOwnerKey(scope, promptTemplateScopeId(scope));
}

function promptTemplateEditorState(scope) {
  return quickMessageEditorStates.get(promptTemplatesOwnerKey(scope)) ?? null;
}

function markPromptTemplatesEdited(scope = promptTemplatesScope) {
  if (!promptTemplateScopeAvailable(scope)) return;
  const ownerKey = promptTemplatesOwnerKey(scope);
  if (!promptTemplatesEditBase.has(ownerKey)) {
    promptTemplatesEditBase.set(ownerKey, {
      scope,
      scopeId: promptTemplateScopeId(scope),
      signature: quickMessageEditorSignature(promptTemplateScopeEntries(scope)),
    });
  }
  const editorState = quickMessageEditorStates.get(ownerKey);
  if (editorState) editorState.keepDraft = true;
}

/* Точка отсчёта появляется и без ввода — когда сохранение отклонили и черновик
   остался в редакторе: тогда отсчёт ведётся от откатившегося хранилища. */
function refreshPromptTemplatesConflicts() {
  for (const [ownerKey, editorState] of quickMessageEditorStates) {
    if (editorState?.keepDraft !== true) {
      promptTemplatesEditBase.delete(ownerKey);
      promptTemplatesConflicts.delete(ownerKey);
    }
  }
  for (const scope of PROMPT_TEMPLATE_SCOPES) {
    if (!promptTemplateScopeAvailable(scope)) continue;
    const ownerKey = promptTemplatesOwnerKey(scope);
    if (promptTemplatesEditBase.has(ownerKey)) continue;
    if (quickMessageEditorStates.get(ownerKey)?.keepDraft !== true) continue;
    promptTemplatesEditBase.set(ownerKey, {
      scope,
      scopeId: promptTemplateScopeId(scope),
      signature: quickMessageEditorSignature(promptTemplateScopeEntries(scope)),
    });
  }
  for (const [ownerKey, base] of promptTemplatesEditBase) {
    const stored = quickMessageEditorSignature(quickMessagesForScope(base.scope, base.scopeId));
    if (stored !== base.signature) promptTemplatesConflicts.add(ownerKey);
  }
  return promptTemplatesConflicts;
}

function promptTemplatesScopeConflicted(scope = promptTemplatesScope) {
  return promptTemplateScopeAvailable(scope) && promptTemplatesConflicts.has(promptTemplatesOwnerKey(scope));
}

/* Область доступна в этом окне формы, только если её можно выбрать прямо
   здесь: глобальная, открытый Workspace и его Stream. Черновик и расхождение
   чужой области сохраняются и ждут, когда откроют её Workspace, но форму,
   открытую в другом месте, они не держат — иначе из неё некуда деться. */
function promptTemplatesAccessibleScopes() {
  return PROMPT_TEMPLATE_SCOPES.filter((scope) => promptTemplateScopeAvailable(scope));
}

function promptTemplatesBlocked() {
  return promptTemplatesAccessibleScopes().some((scope) => promptTemplatesScopeConflicted(scope));
}

/* У области с неудавшимся сохранением счётчик показывает то, что человек видит
   в редакторе, а не то, что успело лечь в хранилище. */
function promptTemplateScopeCount(scope) {
  const editorState = promptTemplateEditorState(scope);
  if (editorState && (editorState.keepDraft || editorState.pendingMutationId)) return editorState.items.length;
  return window.AgentHubStreamTabs.normalizeQuickMessages({
    global: promptTemplateScopeEntries(scope),
  }).global.length;
}

/* Кнопки областей создаются один раз и правятся на месте: счётчик обновляется
   и по change из поля, а change приходит на blur между mousedown и click по
   самой кнопке, и пересборка узлов съедала бы этот клик. */
function promptTemplatesScopeButton(scope) {
  const existing = promptTemplatesScopes.querySelector(`[data-prompt-templates-scope="${scope}"]`);
  if (existing) return existing;
  const button = el("button", {
    type: "button",
    class: "chip-button prompt-templates-scope",
    "data-prompt-templates-scope": scope,
  }, [
    el("span", { class: "prompt-templates-scope-name" }),
    el("span", { class: "prompt-templates-scope-count" }),
  ]);
  promptTemplatesScopes.append(button);
  return button;
}

function renderPromptTemplatesScopes() {
  if (!promptTemplatesScopes) return;
  for (const scope of PROMPT_TEMPLATE_SCOPES) {
    const button = promptTemplatesScopeButton(scope);
    const available = promptTemplateScopeAvailable(scope);
    button.disabled = !available;
    button.setAttribute("aria-pressed", String(available && scope === promptTemplatesScope));
    button.toggleAttribute("data-prompt-templates-diverged", available && promptTemplatesScopeDiverged(scope));
    if (available) button.removeAttribute("title");
    else button.title = "В текущем контексте эта область недоступна";
    button.querySelector(".prompt-templates-scope-name").textContent = promptTemplateScopeName(scope);
    button.querySelector(".prompt-templates-scope-count").textContent = available
      ? String(promptTemplateScopeCount(scope))
      : "—";
  }
  if (promptTemplatesNote) {
    promptTemplatesNote.textContent = PROMPT_TEMPLATE_SCOPE_NOTES[promptTemplatesScope] ?? "";
  }
}

/* Неудавшееся сохранение оставляет черновик в редакторе. Если ту же область за
   это время изменили снаружи, подменять черновик молча нельзя и записывать его
   поверх тоже: расхождение показывается явно, а выбор остаётся за человеком. */
function promptTemplatesScopeDiverged(scope = promptTemplatesScope) {
  return promptTemplatesScopeConflicted(scope);
}

function renderPromptTemplatesConflict() {
  /* Пересчёт обязателен именно здесь: после удачной записи черновик совпал с
     хранилищем, и точку отсчёта надо снять, иначе следующее чужое обновление
     выглядело бы расхождением там, где его нет. */
  refreshPromptTemplatesConflicts();
  const active = promptTemplatesScopeConflicted();
  const others = promptTemplatesAccessibleScopes()
    .filter((scope) => scope !== promptTemplatesScope && promptTemplatesScopeConflicted(scope))
    .map((scope) => promptTemplateScopeName(scope));
  if (promptTemplatesConflict) promptTemplatesConflict.hidden = !(active || others.length > 0);
  if (promptTemplatesConflictText) {
    promptTemplatesConflictText.textContent = active
      ? "Сохранённые шаблоны этой области изменились, пока правка не записалась. Черновик оставлен здесь, запись отключена до вашего решения."
      : others.length
        ? `Шаблоны области «${others.join("», «")}» изменились в другом месте. Откройте эту область и разберите расхождение.`
        : "";
  }
  if (promptTemplatesReload) promptTemplatesReload.hidden = !active;
}

/* Подпись со счётчиком стоит рядом со входом, а редактор теперь в форме,
   поэтому после правки счётчики обновляются отдельно от перерисовки строк.
   У области, открытой в форме, подпись показывает то же число строк, что
   человек видит в редакторе, включая только что добавленную пустую. */
function promptTemplateEntryCountText(scope, scopeId) {
  const editorState = quickMessageEditorStates.get(quickMessageOwnerKey(scope, scopeId));
  if (promptTemplatesModal?.open && editorState
    && promptTemplatesScope === scope && promptTemplateScopeId(scope) === scopeId) {
    return window.AgentHubStreamTabs.quickMessagesCountLabel(editorState.items.length);
  }
  return quickMessagesCountText(quickMessagesForScope(scope, scopeId));
}

function renderPromptTemplateEntryCounts() {
  if (settingsGlobalQuickMessagesCount) {
    settingsGlobalQuickMessagesCount.textContent = promptTemplateEntryCountText("global", "");
  }
  if (workspaceCardQuickMessagesCount && workspaceCardId && workspaceCardMode !== "create") {
    workspaceCardQuickMessagesCount.textContent = promptTemplateEntryCountText("workspace", workspaceCardId);
  }
  const streamId = String(currentTask()?.streamId ?? "").trim();
  if (dialogStreamQuickMessagesCount && streamId) {
    dialogStreamQuickMessagesCount.textContent = promptTemplateEntryCountText("stream", streamId);
  }
}

function renderPromptTemplatesForm() {
  const scope = promptTemplatesScope;
  refreshPromptTemplatesConflicts();
  renderQuickMessagesEditor(
    promptTemplatesEditor,
    scope,
    promptTemplateScopeId(scope),
    promptTemplateScopeEntries(scope),
    state.pendingSelections.has("quickMessages")
      || !promptTemplateScopeAvailable(scope)
      || promptTemplatesScopeConflicted(scope),
  );
  renderPromptTemplatesScopes();
  renderPromptTemplatesConflict();
}

/* Пока форма открыта, снимок может обновить ту же область. Редактор без
   незаписанного черновика следует хранилищу, черновик остаётся на месте.
   Форма сама знает свою активную область, поэтому перерисовывается на любое
   обновление шаблонов: сверять её с областью вызывающего незачем. */
function refreshOpenPromptTemplates() {
  if (!promptTemplatesModal?.open) return;
  renderPromptTemplatesForm();
}

function setPromptTemplatesScope(scope) {
  if (scope === promptTemplatesScope || !promptTemplateScopeAvailable(scope)) return;
  promptTemplatesScope = scope;
  renderPromptTemplatesForm();
  promptTemplatesScopes
    ?.querySelector(`[data-prompt-templates-scope="${scope}"]`)
    ?.focus({ preventScroll: true });
}

/* Явный отказ от своего черновика в пользу сохранённых значений. */
function reloadPromptTemplatesScope() {
  const ownerKey = promptTemplatesOwnerKey();
  promptTemplatesEditBase.delete(ownerKey);
  promptTemplatesConflicts.delete(ownerKey);
  const editorState = promptTemplateEditorState(promptTemplatesScope);
  if (editorState) {
    editorState.keepDraft = false;
    editorState.error = "";
    editorState.projectedSignature = "";
  }
  renderPromptTemplatesForm();
}

function openPromptTemplates(scope, overrides = {}) {
  if (!promptTemplatesModal) return;
  const current = currentQuickMessageContext();
  const workspaceId = String(overrides.workspaceId ?? current?.workspaceId ?? "").trim();
  /* Форму открывают и из карточки чужого Workspace: область Stream остаётся
     доступной только тогда, когда открытый Stream действительно его. */
  const keepsStream = Boolean(current) && current.workspaceId === workspaceId;
  promptTemplatesContext = {
    streamId: keepsStream ? current.streamId : "",
    streamName: keepsStream ? current.streamName : "",
    workspaceId,
    workspaceName: String(
      overrides.workspaceName
      ?? (keepsStream ? current.workspaceName : workspaceCatalogItem(workspaceId)?.name)
      ?? "",
    ).trim(),
  };
  promptTemplatesScope = promptTemplateScopeAvailable(scope) ? scope : "global";
  promptTemplatesReturnFocus = document.activeElement;
  renderPromptTemplatesForm();
  if (!promptTemplatesModal.open) promptTemplatesModal.showModal();
  promptTemplatesScopes?.querySelector("[aria-pressed='true']")?.focus({ preventScroll: true });
}

function quickMessageScopeLabel(scope) {
  return ({ global: "G", workspace: "W", stream: "S" })[scope] ?? "S";
}

function quickMessageActionMode() {
  return state.selection.quickMessageActionMode === "send" ? "send" : "insert";
}

function quickMessageAction(mode, inverted = false) {
  const primary = mode === "send" ? "send" : "insert";
  return inverted ? (primary === "send" ? "insert" : "send") : primary;
}

function quickMessageActionCopy(mode) {
  return mode === "send"
    ? {
        note: "Ctrl + нажатие — вставить в поле.",
        title: "Отправить сразу. Ctrl + нажатие — вставить в поле.",
      }
    : {
        note: "Ctrl + нажатие — отправить.",
        title: "Вставить в поле. Ctrl + нажатие — отправить.",
      };
}

function renderComposerQuickMessages() {
  if (!composerQuickMessages) return;
  const entries = quickMessageEntriesForCurrentTask();
  const actionCopy = quickMessageActionCopy(quickMessageActionMode());
  composerQuickMessages.hidden = entries.length === 0;
  composerQuickMessages.replaceChildren(...entries.map((entry, index) => {
    const button = el("button", {
      type: "button",
      class: "composer-quick-message",
      "data-quick-message-index": String(index),
      "data-quick-message-scope": entry.scope,
      title: `${entry.title}. ${actionCopy.title}`,
      "aria-label": `${entry.title}. ${actionCopy.title}`,
      disabled: Boolean(pendingComposerRequest),
    }, [
      el("span", { class: "composer-quick-message-scope", text: quickMessageScopeLabel(entry.scope) }),
      el("span", { class: "composer-quick-message-label", text: entry.title }),
    ]);
    button.__agentHubQuickMessage = entry;
    return button;
  }));
}

function renderQuickMessageActionModeSetting() {
  const mode = quickMessageActionMode();
  const pending = state.pendingSelections.has("quickMessageActionMode");
  if (quickMessageActionModeSelect) {
    quickMessageActionModeSelect.value = mode;
    quickMessageActionModeSelect.disabled = pending;
    quickMessageActionModeSelect.setAttribute("aria-busy", String(pending));
  }
  if (quickMessageActionModeNote) quickMessageActionModeNote.textContent = quickMessageActionCopy(mode).note;
}

function reconcileOpenStreams(workspaceId, streams) {
  restoreOpenStreams();
  const ordered = orderedWorkspaceStreams(streams, workspaceId);
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

function toggleOpenStream(workspaceId, streamId, streams, { additive = false, preserveClickTarget = false } = {}) {
  restoreOpenStreams();
  const stream = streams.find((value) => value.id === streamId);
  const target = representativeStreamTask(stream);
  if (!target) return;
  if (surface === "mobile") {
    state.openStreamsByWorkspace.set(workspaceId, [streamId]);
    selectTaskFromUi(target.id, { preserveStreamTabs: preserveClickTarget });
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
    selectTaskFromUi(target.id, { preserveStreamTabs: preserveClickTarget });
    return;
  }
  const fallback = representativeStreamTask(streams.find((value) => value.id === next[0]));
  if (fallback) selectTaskFromUi(fallback.id, { preserveStreamTabs: preserveClickTarget });
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
    ensureJournalLoaded();
    requestUsageHistory(usageState.range);
    requestLimits(limitsState.range);
    requestUsageComparison(comparisonState.range);
  }
  if (view === "server") {
    if (lastServerPayload) renderServerStatus(lastServerPayload);
    emit("devices:refresh");
  }
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
  return window.AgentHubCommandTrace.measure("ui-navigation", "set-view", () => (
    setViewContent(view, { persist, activate })
  ));
}

function setViewContent(view, { persist = true, activate = true } = {}) {
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
          ? "Null"
          : next === "server"
            ? "Server"
            : "Chat";
  }
  syncMobileNav();
  if (activate) activateView(next);
  if (persist) persistNavigationTab();
  if (next === "chat") scheduleUnderfilledHistoryLoad();
}

function setPane(pane, { persist = true } = {}) {
  root.dataset.pane = pane === "chat" ? "chat" : "tasks";
  syncMobileNav();
  if (persist) persistNavigationTab();
  if (root.dataset.pane === "chat") scheduleUnderfilledHistoryLoad();
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
  const versionedVariant = normalized.match(/^(?:gpt[- ]?)?(5\.6|6)[- ](sol|luna)$/u);
  if (versionedVariant) return `${versionedVariant[1]} ${versionedVariant[2] === "sol" ? "Sol" : "Luna"}`;
  if (normalized === "gpt-6-astra" || normalized === "gpt-6 astra") return "Astra";
  if (normalized.includes("astra")) return source;
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
  return window.AgentHubCommandTrace.measure("ui-render", "task-list", renderTasksContent);
}

function renderTasksContent() {
  const filter = (taskFilter.value ?? "").trim().toLowerCase();
  const visible = state.tasks.filter((task) => {
    if (!filter) return true;
    const local = `${task.title ?? ""} ${task.threadTitle ?? ""} ${task.streamDisplayName ?? ""} ${task.project ?? ""} ${task.agentLabel ?? ""}`
      .toLowerCase().includes(filter);
    return local || state.searchResults.has(task.id);
  });
  reusableWorkspaceCards = indexRenderedCards(taskList, ".task-workspace-item", "data-workspace-id");
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
        folderName: task.workspaceSettings?.catalogFolder ?? "",
        tasks: [],
      });
      groups.get(key).tasks.push(task);
    }
    visibleCount = groups.size + unassignedTasks.length;
    /* Поиск ищет по всему списку сразу, поэтому при фильтре деление на ленту
       и каталог только мешает: показываем плоский результат. */
    if (filter) {
      for (const group of window.AgentHubStreamTabs.orderWorkspaceGroups(groups.values())) {
        taskList.append(renderTaskWorkspaceItem(group));
      }
    } else {
      const sections = window.AgentHubStreamTabs.workspaceSections(groups.values(), {
        folderNames: workspaceFolderCatalogNames(),
      });
      for (const group of sections.active) taskList.append(renderTaskWorkspaceItem(group));
      for (const entry of sections.catalog) {
        if (entry.type === "workspace") {
          taskList.append(renderTaskWorkspaceItem(entry.group));
          continue;
        }
        taskList.append(renderTaskWorkspaceFolder(entry));
      }
    }
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
    taskEmpty.hidden = true;
    taskEmpty.textContent = "";
  }
  taskCount.hidden = !hasTasks;
  taskCount.textContent = String(visibleCount);
  reusableWorkspaceCards = new Map();
  resumeAdoptedCardAnimations();
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
      || Math.max(...right.tasks.map((task) => activityTimestamp(task.lastActivity)))
        - Math.max(...left.tasks.map((task) => activityTimestamp(task.lastActivity)))
    ));
}

function workspaceLastActivity(tasks) {
  return tasks.reduce((latest, task) => {
    const value = activityTimestamp(task.lastActivity);
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
    activityTimestamp(right.lastActivity) - activityTimestamp(left.lastActivity)
  ))[0] ?? null;
}

function streamMaintenanceKind(task) {
  /* Ротация меняет тред, свёртка сжимает историю: на карточке это два разных
     состояния, и оба видны без анимации. */
  const reason = String(task?.maintenance?.reason ?? "");
  if (["manual-rotation", "automatic-rotation"].includes(reason)) return "rotation";
  return String(task?.context?.compaction?.status ?? "") === "running" ? "compaction" : "";
}

function renderTaskWorkspaceFolder(folder) {
  restoreCollapsedWorkspaceFolders();
  const folderKey = String(folder.key ?? folder.name ?? "").trim();
  const open = window.AgentHubStreamTabs.workspaceFolderOpen(
    folder,
    state.collapsedWorkspaceFolders,
    workspaceKey(currentTask()),
  );
  const items = folder.items ?? [];
  const running = items.some((item) => (item.tasks ?? []).some((task) => task?.running));
  const unread = items.some((item) => (item.tasks ?? []).some((task) => task?.unread));
  const selected = items.some((item) => item.id === workspaceKey(currentTask()));
  return el("li", {
    class: "task-workspace-folder",
    "data-workspace-folder": folderKey,
    "data-workspace-folder-name": folder.name,
    "data-workspace-folder-kind": folder.type,
    "data-selected": selected ? "" : null,
    "data-running": running ? "" : null,
    "data-unread": unread ? "" : null,
  }, [
    el("details", {
      class: "task-workspace-folder-details",
      open,
      "data-workspace-folder-details": folderKey,
    }, [
      el("summary", {
        class: "task-workspace-folder-summary",
        title: "Свернуть или раскрыть папку Workspace",
      }, [
        ...window.AgentHubStreamTabs.workspaceFolderSummaryIcons(document),
        el("span", { class: "task-workspace-folder-name", text: folder.name }),
        el("span", { class: "task-workspace-folder-count", text: String(items.length) }),
      ]),
      el("ul", { class: "task-workspace-folder-list" }, items.length
        ? items.map((item) => renderTaskWorkspaceItem(item, { folderMember: true }))
        : [el("li", {
            class: "task-workspace-folder-empty",
            text: "Папка пуста",
            role: "presentation",
          })]),
    ]),
  ]);
}

function renderTaskWorkspaceItem({ id, name, kind, tasks }, { folderMember = false } = {}) {
  const selected = workspaceKey(currentTask()) === id;
  const lastActivity = workspaceLastActivity(tasks);
  const unread = tasks.some((task) => task.unread);
  const running = tasks.some((task) => task.running);
  const maintenance = tasks.map(streamMaintenanceKind).find(Boolean) ?? "";
  return adoptRenderedCard(reusableWorkspaceCards, id, el("li", {
    class: "task-workspace-item",
    "data-workspace-id": id,
    "data-workspace-kind": kind,
    "data-workspace-select": id,
    "data-workspace-heading": id,
    "data-workspace-name": name,
    "data-selected": selected ? "" : null,
    "data-unread": unread ? "" : null,
    "data-answer-arrived": tasks.some((task) => transientAnswerArrivalTaskIds.has(task.id)) ? "" : null,
    "data-running": running ? "" : null,
    "data-maintenance": maintenance || null,
    "data-folder-member": folderMember ? "" : null,
    role: "button",
    tabindex: "0",
    "aria-pressed": String(selected),
    "aria-label": folderMember ? name : null,
    title: "ПКМ — редактировать Workspace",
  }, [
    el("span", { class: "task-workspace-name", text: name }),
    el("span", {
      class: "task-workspace-time",
      text: formatRelativeTime(lastActivity),
      title: lastActivity ? new Date(lastActivity).toLocaleString("ru-RU") : "",
    }),
  ]));
}

function representativeStreamTask(stream) {
  if (!stream) return null;
  // У потока обычно несколько задач: каждый Thread — своя. Вкладка показывает
  // одну из них, и выбирать её только по времени последней активности нельзя:
  // идущий ход часто не самый свежий по этому полю, и вкладка молча брала
  // соседнюю задачу без признака работы. Правая панель тем временем выбирает по
  // состоянию и показывает поток работающим — отсюда «справа есть, сверху нет».
  // Порядок здесь тот же, что в рельсе: сначала состояние, потом время.
  // Порядок обязан совпадать с attentionRank рельса: там готовый ответ идёт
  // впереди идущего хода. Обратный порядок давал разные ветки одного потока
  // в полосе и в панели, и они показывали разные состояния одновременно.
  const attention = (task) => (task?.unread && !task?.running ? 0 : task?.running ? 1 : 2);
  return stream.tasks.find((task) => task.id === state.selectedId)
    ?? [...stream.tasks].sort((left, right) => (
      attention(left) - attention(right)
      || Date.parse(right.lastActivity || 0) - Date.parse(left.lastActivity || 0)
    ))[0]
    ?? null;
}

function streamActivityTime(task) {
  return activityTimestamp(task?.lastActivity);
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
  const selectedTask = currentTask();
  window.AgentHubTaskBoard?.setSelectedContext({
    workspaceId: String(selectedTask?.workspaceId ?? "").trim() || null,
    streamId: String(selectedTask?.streamId ?? "").trim() || null,
  });
  const entries = activityStreamEntries(state.tasks);
  const sections = window.AgentHubStreamTabs.activityStreamSections(entries);
  activityRailCount.textContent = "Активно";
  if (activityStreamHeading) {
    activityStreamHeading.textContent = window.AgentHubActivityRailLayout.countedActivityHeading(
      "Потоки",
      sections.active.length,
    );
  }
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
      "data-answer-arrived": transientAnswerArrivalTaskIds.has(task.id) ? "" : null,
      "data-recent": streamAttentionKind(task) === "recent" ? "" : null,
      "data-maintenance": streamMaintenanceKind(task) || null,
      "aria-pressed": String(task.id === state.selectedId),
      "aria-label": [workspaceName, streamName, presentation.agentLabel, presentation.statusLabel]
        .filter(Boolean).join(". "),
      title,
    }, [
      el("span", { class: "stream-tab-status-layer", "aria-hidden": "true" }),
      renderStreamStatusCard(task, activityTitle, presentation),
    ]);
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
    delete streamTabs.dataset.workspaceId;
    return;
  }
  const workspaceId = workspaceKey(selected);
  reusableStreamTabs = indexRenderedCards(streamTabs, ".stream-tab", "data-stream-tab-id");
  const overflowMenuOpen = window.AgentHubStreamTabs.preserveStreamOverflowMenuOpen(
    streamTabs.dataset.workspaceId,
    workspaceId,
    streamTabs.querySelector("[data-stream-tabs-overflow-menu]")?.hidden === false,
  );
  const streams = workspaceStreams(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  reconcileOpenStreams(workspaceId, streams);
  const ordered = orderedWorkspaceStreams(streams, workspaceId);
  const pinnedIds = window.AgentHubStreamTabs.pinnedWorkspaceStreamIds(state.selection, workspaceId);
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
    hidden: window.AgentHubStreamTabs.streamCardSettingsAvailable({
      isWide: typeof window.matchMedia !== "function"
        || window.matchMedia("(min-width: 860px)").matches,
      surface: root.dataset.surface,
    }),
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
    const streamName = window.AgentHubStreamTabs.streamDisplayName(stream, streams.length);
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
    const pinned = pinnedIds.includes(stream.id);
    const attributes = {
      type: "button",
      "data-stream-tab-id": stream.id,
      "data-workspace-id": workspaceId,
      "data-workspace-name": task?.workspaceName ?? "",
      "data-stream-name": streamName,
      "data-stream-task-id": task?.id ?? "",
      "data-stream-provider": provider,
      "data-stream-provider-label": agentLabel,
      "data-stream-model": task?.modelLabel ?? "",
      "data-stream-title": title,
      "data-pinned": pinned ? "" : null,
      "aria-pressed": String(open.has(stream.id)),
      "data-current": task?.id === selected.id ? "" : null,
      "data-running": running ? "" : null,
      "data-answer-ready": answerReady ? "" : null,
      "data-answer-arrived": transientAnswerArrivalTaskIds.has(task?.id) ? "" : null,
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
      pinned ? window.AgentHubStreamTabs.createPhosphorIcon(
        document,
        "push-pin-simple",
        "stream-tab-pin-icon",
      ) : null,
      el("span", { class: "stream-tab-title", text: streamName }),
      el("span", {
        class: `task-time${statusState === "failed" ? " is-failed" : ""}`,
        text: time,
        title: task?.lastActivity ? new Date(task.lastActivity).toLocaleString("ru-RU") : "",
      }),
    ];
    const button = adoptRenderedCard(reusableStreamTabs, stream.id, el("button", {
      ...attributes,
      class: "stream-tab",
      draggable: window.AgentHubStreamTabs.streamsAreDraggable(streamOrderMode, surface) ? "true" : null,
    }, [
      el("span", { class: "stream-tab-status-layer", "aria-hidden": "true" }),
      el("span", { class: "stream-tab-card" }, content()),
    ]));
    overflowItems.push(el("button", {
      ...attributes,
      class: "stream-overflow-item",
      draggable: window.AgentHubStreamTabs.streamsAreDraggable(streamOrderMode, surface) ? "true" : null,
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
    "aria-expanded": String(overflowMenuOpen),
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
    hidden: !overflowMenuOpen,
  }, overflowItems);
  const overflow = el("span", {
    class: "stream-tabs-overflow",
    "data-stream-tabs-overflow": "",
    hidden: true,
  }, [overflowButton, overflowMenu]);
  streamTabs.dataset.workspaceId = workspaceId;
  streamTabs.replaceChildren(leftControls, track, overflow);
  reusableStreamTabs = new Map();
  resumeAdoptedCardAnimations();
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
    onReturnBottom: scroll === chatScroll
      ? () => emit("history:return-bottom", { taskId: state.selectedId })
      : null,
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
    el("span", { class: "chat-scroll-label", text: "Вниз" }),
    el("span", { class: "chat-scroll-count", hidden: true, text: "0" }),
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
    for (const message of MessageView.conversationSurfaceMessages(messages).slice(-20)) {
      log.append(renderMessage(message, { readOnly: true, task }));
    }
  }
  const live = state.live.get(task.id);
  if (liveCardHasContent(live)) {
    const liveNode = el("article", {
      class: "msg msg-live stream-chat-preview-live-card",
      "data-role": "agent",
    }, [
      el("div", { class: "msg-head" }, [
        el("span", { class: "msg-author", "data-live-author": "" }),
        el("span", { class: "msg-stage", "data-live-stage": "" }),
        el("span", {
          class: "msg-turn-duration",
          "data-live-turn-duration": "",
          title: "Длительность хода",
          "aria-label": "Длительность хода",
          hidden: true,
        }),
      ]),
      el("div", { class: "msg-reasoning msg-stage-detail", "data-live-stage-detail": "", hidden: true }),
      el("div", { class: "msg-reasoning", "data-live-reasoning": "", hidden: true }),
      el("div", { class: "live-turn-trace", "data-live-trace": "", hidden: true }),
      el("details", { class: "activity-feed", "data-activity-feed": "", hidden: true }, [
        el("summary", { "data-activity-summary": "", text: "Выполненные действия" }),
        el("div", { class: "activity-list", "data-activity-list": "" }),
      ]),
      el("div", { class: "msg-body", "data-live-body": "" }),
      el("div", { "data-live-attachments": "", hidden: true }),
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
  const previewPins = pinsForTask(task);
  const pin = previewPins[0];
  const shelf = pin ? el("button", {
    type: "button",
    class: "message-pin-shelf stream-chat-preview-pins",
    title: pin.available ? "Перейти к закреплённому сообщению" : "Исходное сообщение недоступно",
    disabled: !pin.available,
  }, [
    messagePinIcon("push-pin-simple", "message-pin-shelf-icon"),
    el("span", { class: "message-pin-current-preview", text: pin.preview }),
    el("span", { class: "message-pin-position", text: `1 из ${previewPins.length}` }),
  ]) : null;
  shelf?.addEventListener("click", () => {
    selectTaskFromUi(task.id);
    state.activeMessagePinByStream.set(String(task.streamId), pin.id);
    jumpToMessagePin(pin);
  });
  preview.append(head, ...(shelf ? [shelf] : []), scroll, scrollDown);
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

let workspaceDblclickCandidate = null;
taskList.addEventListener("click", (event) => {
  const workspace = event.target.closest("[data-workspace-select]");
  if (!workspace) return;
  const workspaceId = String(workspace.dataset.workspaceSelect ?? "");
  if (event.detail === 1) workspaceDblclickCandidate = { workspaceId };
  else if (workspaceDblclickCandidate?.workspaceId !== workspaceId) workspaceDblclickCandidate = null;
  const target = representativeWorkspaceTask(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  if (target) selectTaskFromUi(target.id, {
    preserveTaskList: true,
    preservePane: surface === "mobile",
  });
});
taskList.addEventListener("dblclick", (event) => {
  const candidate = workspaceDblclickCandidate;
  workspaceDblclickCandidate = null;
  const workspace = event.target.closest?.("[data-workspace-select]");
  const workspaceId = String(workspace?.dataset.workspaceSelect ?? "");
  if (!candidate || candidate.workspaceId !== workspaceId
    || !workspace?.isConnected || !taskList.contains(workspace) || !workspaceCatalogItem(workspaceId)) return;
  openWorkspaceCard(workspaceId);
});
taskList.addEventListener("keydown", (event) => {
  if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
    const workspace = event.target.closest("[data-workspace-select]");
    if (workspace) {
      event.preventDefault();
      const rect = workspace.getBoundingClientRect();
      openWorkspaceContextMenu(
        { clientX: rect.left + 12, clientY: rect.top + 36 },
        workspace.dataset.workspaceSelect,
      );
      return;
    }
    const folder = event.target.closest("[data-workspace-folder-name]");
    if (folder?.dataset.workspaceFolderKind === "folder") {
      event.preventDefault();
      const rect = folder.getBoundingClientRect();
      openWorkspaceFolderContextMenu(
        { clientX: rect.left + 12, clientY: rect.top + 36 },
        folder.dataset.workspaceFolderName,
      );
      return;
    }
    return;
  }
  if (!["Enter", " "].includes(event.key)) return;
  const workspace = event.target.closest("[data-workspace-select]");
  if (!workspace) return;
  event.preventDefault();
  const workspaceId = String(workspace.dataset.workspaceSelect ?? "");
  const target = representativeWorkspaceTask(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  if (target) selectTaskFromUi(target.id, { preserveTaskList: true });
});
taskList.addEventListener("toggle", (event) => {
  const details = event.target.closest?.("[data-workspace-folder-details]");
  if (!details || !taskList.contains(details)) return;
  const folderKey = String(details.dataset.workspaceFolderDetails ?? "").trim();
  if (!folderKey) return;
  restoreCollapsedWorkspaceFolders();
  if (details.open) state.collapsedWorkspaceFolders.delete(folderKey);
  else state.collapsedWorkspaceFolders.add(folderKey);
  persistCollapsedWorkspaceFolders();
}, true);

function moveWorkspaceToFolder(workspaceId, folderName) {
  const workspace = workspaceCatalogItem(workspaceId);
  const mutation = window.AgentHubStreamTabs.workspaceFolderMutation(workspace, folderName);
  if (!mutation) return;
  const current = window.AgentHubStreamTabs.normalizeWorkspaceFolderName(
    workspace?.settings?.catalogFolder,
  );
  if (current === mutation.folderName) return;
  emit("workspace:folder-move", {
    workspaceId: mutation.workspaceId,
    folderName: mutation.folderName,
  });
}
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
let streamDblclickCandidate = null;
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
  const candidate = {
    workspaceId: String(tab.dataset.workspaceId ?? ""),
    streamId: String(tab.dataset.streamTabId ?? ""),
    taskId: String(tab.dataset.streamTaskId ?? ""),
  };
  if (event.detail === 1) streamDblclickCandidate = candidate;
  else if (streamDblclickCandidate?.workspaceId !== candidate.workspaceId
    || streamDblclickCandidate?.streamId !== candidate.streamId
    || streamDblclickCandidate?.taskId !== candidate.taskId) streamDblclickCandidate = null;
  const overflowMenu = streamTabs.querySelector("[data-stream-tabs-overflow-menu]");
  if (overflowMenu) overflowMenu.hidden = true;
  streamTabs.querySelector("[data-stream-overflow-toggle]")?.setAttribute("aria-expanded", "false");
  const workspaceId = String(tab.dataset.workspaceId ?? "");
  const streams = workspaceStreams(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
  toggleOpenStream(workspaceId, String(tab.dataset.streamTabId ?? ""), streams, {
    additive: event.ctrlKey || event.metaKey,
    preserveClickTarget: true,
  });
});
streamTabs?.addEventListener("dblclick", (event) => {
  const candidate = streamDblclickCandidate;
  streamDblclickCandidate = null;
  const tab = event.target.closest?.("[data-stream-tab-id][data-workspace-id]");
  const workspaceId = String(tab?.dataset.workspaceId ?? "");
  const streamId = String(tab?.dataset.streamTabId ?? "");
  const taskId = String(tab?.dataset.streamTaskId ?? "");
  const task = state.tasks.find((entry) => entry.id === taskId);
  if (!candidate || candidate.workspaceId !== workspaceId
    || candidate.streamId !== streamId || candidate.taskId !== taskId
    || !tab?.isConnected || !streamTabs.contains(tab) || !task
    || workspaceKey(task) !== workspaceId || String(task.streamId ?? "") !== streamId) return;
  if (taskId && currentTask()?.id !== taskId) selectTaskFromUi(taskId);
  openDialogSettings();
});

function streamTaskDropTarget(event) {
  return event.target.closest?.(
    "[data-stream-task-id], [data-activity-task-id]",
  ) ?? null;
}

function streamDropConversationTaskId(target) {
  return String(target?.dataset?.streamTaskId ?? target?.dataset?.activityTaskId ?? "").trim();
}

function attachTaskReferenceToComposer(targetTaskId, reference) {
  if (!targetTaskId || !reference) return false;
  if (state.selectedId !== targetTaskId) selectTaskFromUi(targetTaskId);
  const draft = drafts.get(targetTaskId) ?? {
    text: "", attachments: [], taskReferences: [], annotations: [],
  };
  const alreadyAttached = (draft.taskReferences ?? [])
    .some((item) => String(item?.taskId ?? "") === reference.taskId);
  if (!alreadyAttached && (draft.taskReferences ?? []).length >= 8) {
    showToast("К одному сообщению можно приложить не больше восьми Task");
    return false;
  }
  const nextReferences = TaskReferences.merge(draft.taskReferences, reference);
  setTaskReferences(nextReferences);
  saveDraft({ userEdited: true });
  composerInput.focus({ preventScroll: true });
  composer.scrollIntoView({ block: "nearest", behavior: "smooth" });
  showToast(`Task «${reference.title}» прикреплена к сообщению`);
  return true;
}

function bindTaskReferenceDrop(container, {
  targetFromEvent = streamTaskDropTarget,
  conversationTaskId = streamDropConversationTaskId,
} = {}) {
  container?.addEventListener("dragover", (event) => {
    if (!TaskReferences.hasTransfer(event.dataTransfer)) return;
    const target = targetFromEvent(event);
    if (!conversationTaskId(target, event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    target.classList.add("is-task-drop-target");
  });
  container?.addEventListener("dragleave", (event) => {
    const target = targetFromEvent(event);
    if (!target?.contains?.(event.relatedTarget)) target?.classList.remove("is-task-drop-target");
  });
  container?.addEventListener("drop", (event) => {
    if (!TaskReferences.hasTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = targetFromEvent(event);
    const targetTaskId = conversationTaskId(target, event);
    const reference = TaskReferences.fromTransfer(event.dataTransfer, { intent: "context" });
    target?.classList.remove("is-task-drop-target");
    if (!targetTaskId || !reference) return;
    const trace = window.AgentHubCommandTrace;
    const started = trace?.now();
    const commandId = trace?.newId();
    const attach = () => attachTaskReferenceToComposer(targetTaskId, reference);
    if (trace) {
      trace.measure("ui-interaction", "task-drop", attach, commandId);
      trace.afterPaint("ui-render", "task-drop", started, commandId, { trigger: "next-paint" });
    } else attach();
  });
}

bindTaskReferenceDrop(streamTabs);
bindTaskReferenceDrop(activityStreamList);
bindTaskReferenceDrop(activityRecentList);
bindTaskReferenceDrop(chatPane, {
  targetFromEvent: () => chatPane,
  conversationTaskId: () => String(state.selectedId ?? "").trim(),
});
bindTaskReferenceDrop(composer, {
  targetFromEvent: () => composer,
  conversationTaskId: () => String(state.selectedId ?? "").trim(),
});

if (streamTabs && typeof ResizeObserver === "function") {
  new ResizeObserver(scheduleStreamTabsOverflow).observe(streamTabs);
}

let streamContextMenu = null;
let workspaceContextMenu = null;
let workspaceFolderContextMenu = null;
let workspaceCardId = "";
let workspaceCardMode = "edit";
let workspaceCardReturnFocus = null;
let streamCardReturnFocus = null;
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

function renderStreamRulesPreview() {
  const task = currentTask();
  const streamId = String(task?.streamId ?? "");
  const serverRules = agentRulesText(task?.streamDeveloperRules ?? task?.streamRules);
  const draft = streamRulesDrafts.get(streamId);
  if (draft?.value === serverRules) streamRulesDrafts.delete(streamId);
  const ownRules = streamRulesDrafts.get(streamId)?.value ?? serverRules;
  if (dialogStreamRules && document.activeElement !== dialogStreamRules) dialogStreamRules.value = ownRules;
  const valid = updateAgentRulesLimit(dialogStreamRules, dialogStreamRulesCount);
  if (dialogStreamRules) dialogStreamRules.disabled = !streamId;
  if (dialogStreamRulesSave) {
    dialogStreamRulesSave.disabled = !streamId || !valid || ownRules === serverRules;
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
  const returnFocus = workspaceCardReturnFocus;
  workspaceCardId = "";
  workspaceCardMode = "edit";
  if (workspaceCardModal?.open) workspaceCardModal.close();
  workspaceCardReturnFocus = null;
  returnFocus?.focus?.({ preventScroll: true });
}

function openWorkspaceCard(workspaceId) {
  const workspace = workspaceCatalogItem(workspaceId);
  if (!workspace || !workspaceCardModal) return;
  const columnId = `workspace:${workspace.id}`;
  const order = dashboardColumnOrder();
  workspaceCardReturnFocus = document.activeElement;
  workspaceCardMode = "edit";
  workspaceCardId = String(workspace.id);
  workspaceCardTitle.textContent = "Редактирование Workspace";
  workspaceCardSubmit.textContent = "Сохранить";
  workspaceCardName.value = String(workspace.name ?? "");
  workspaceCardName.disabled = workspace.kind === "system";
  if (workspaceCardFolderField) workspaceCardFolderField.hidden = false;
  if (workspaceCardFolder) workspaceCardFolder.disabled = workspace.kind === "system";
  populateWorkspaceFolderSelect(workspace.settings?.catalogFolder);
  workspaceCardComment.value = String(workspace.comment ?? "");
  workspaceWorkingDirectoryField?.setValue(String(workspace.settings?.workingDirectory ?? ""));
  workspaceCardTaskPrefix.value = String(workspace.settings?.taskPrefix ?? "");
  workspaceCardRules.value = entityAgentRules(workspace);
  workspaceCardReleaseWorkflow.checked = workspace.settings?.releaseWorkflowEnabled === true;
  workspaceCardAutoReview.checked = workspace.settings?.autoReviewEnabled === true;
  updateAgentRulesLimit(workspaceCardRules, workspaceCardRulesCount);
  renderWorkspaceCardQuickMessages(workspace.id);
  if (workspaceCardArchive) {
    workspaceCardArchive.hidden = workspace.kind === "system";
    workspaceCardArchive.disabled = state.tasks.some((task) => (
      workspaceKey(task) === workspace.id && task.running === true
    ));
    workspaceCardArchive.title = workspaceCardArchive.disabled
      ? "Сначала завершите активные ходы в этом Workspace"
      : "Переместить Workspace в бессрочный архив";
  }
  workspaceCardOrder.max = String(order.length);
  workspaceCardOrder.value = String(Math.max(1, order.indexOf(columnId) + 1));
  workspaceCardModal.showModal();
  (workspaceCardName.disabled ? workspaceCardComment : workspaceCardName).focus();
}

function openNewWorkspaceCard() {
  if (!workspaceCardModal) return;
  const order = dashboardColumnOrder();
  const notesIndex = order.indexOf("notes");
  workspaceCardReturnFocus = document.activeElement;
  workspaceCardMode = "create";
  workspaceCardId = "";
  workspaceCardTitle.textContent = "Новый Workspace";
  workspaceCardSubmit.textContent = "Создать";
  workspaceCardName.value = "";
  workspaceCardName.disabled = false;
  if (workspaceCardFolderField) workspaceCardFolderField.hidden = false;
  if (workspaceCardFolder) workspaceCardFolder.disabled = false;
  populateWorkspaceFolderSelect();
  workspaceCardComment.value = "";
  workspaceWorkingDirectoryField?.setValue("");
  workspaceCardTaskPrefix.value = "";
  workspaceCardRules.value = "";
  workspaceCardReleaseWorkflow.checked = false;
  workspaceCardAutoReview.checked = false;
  updateAgentRulesLimit(workspaceCardRules, workspaceCardRulesCount);
  renderWorkspaceCardQuickMessages("");
  if (workspaceCardArchive) workspaceCardArchive.hidden = true;
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
  });
  document.body.append(workspaceContextMenu);
  workspaceContextMenu.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-workspace-menu-action]");
    if (!action) return;
    event.preventDefault();
    const workspaceId = String(workspaceContextMenu.dataset.workspaceId ?? "");
    const kind = String(action.dataset.workspaceMenuAction ?? "");
    closeWorkspaceContextMenu();
    if (kind === "edit") openWorkspaceCard(workspaceId);
  });
  return workspaceContextMenu;
}

function closeWorkspaceFolderContextMenu() {
  if (!workspaceFolderContextMenu) return;
  workspaceFolderContextMenu.hidden = true;
  workspaceFolderContextMenu.dataset.folderName = "";
}

function renderWorkspaceContextMenu(menu, workspace) {
  menu.replaceChildren(
    el("button", {
      type: "button",
      role: "menuitem",
      class: "stream-context-action",
      "data-workspace-menu-action": "edit",
      text: "Редактировать…",
    }),
  );
}

function openWorkspaceContextMenu(event, workspaceId) {
  if (!workspaceCatalogItem(workspaceId)) return;
  closeStreamContextMenu();
  closeWorkspaceFolderContextMenu();
  const menu = ensureWorkspaceContextMenu();
  const workspace = workspaceCatalogItem(workspaceId);
  renderWorkspaceContextMenu(menu, workspace);
  menu.dataset.workspaceId = String(workspaceId);
  menu.hidden = false;
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("button")?.focus();
}

function ensureWorkspaceFolderContextMenu() {
  if (workspaceFolderContextMenu) return workspaceFolderContextMenu;
  workspaceFolderContextMenu = el("div", {
    class: "stream-context-menu workspace-context-menu",
    role: "menu",
    "aria-label": "Управление папкой Workspace",
    hidden: true,
  }, [el("button", {
    type: "button",
    role: "menuitem",
    class: "stream-context-action",
    "data-workspace-folder-menu-action": "rename",
    text: "Переименовать папку…",
  })]);
  document.body.append(workspaceFolderContextMenu);
  workspaceFolderContextMenu.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-workspace-folder-menu-action]");
    if (!action) return;
    event.preventDefault();
    const currentName = String(workspaceFolderContextMenu.dataset.folderName ?? "");
    closeWorkspaceFolderContextMenu();
    if (action.dataset.workspaceFolderMenuAction !== "rename") return;
    const requestedName = await askText({ title: "Новое название папки", value: currentName });
    if (requestedName == null) return;
    const plan = window.AgentHubStreamTabs.workspaceFolderRenamePlan(
      state.workspaces,
      currentName,
      requestedName,
      workspaceFolderCatalogNames(),
    );
    if (!plan) return;
    if (plan.duplicateFolderName) {
      showToast(`Папка «${plan.duplicateFolderName}» уже существует`);
      return;
    }
    emit("workspace:folder-rename", plan);
  });
  return workspaceFolderContextMenu;
}

function openWorkspaceFolderContextMenu(event, folderName) {
  const normalizedName = window.AgentHubStreamTabs.normalizeWorkspaceFolderName(folderName);
  if (!normalizedName) return;
  closeStreamContextMenu();
  closeWorkspaceContextMenu();
  const menu = ensureWorkspaceFolderContextMenu();
  menu.dataset.folderName = normalizedName;
  menu.hidden = false;
  const left = Math.max(8, Math.min(event.clientX, window.innerWidth - menu.offsetWidth - 8));
  const top = Math.max(8, Math.min(event.clientY, window.innerHeight - menu.offsetHeight - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.querySelector("button")?.focus();
}

function workspaceMenuOptions(currentWorkspaceId) {
  return state.workspaces
    .filter((workspace) => String(workspace.id ?? "") !== String(currentWorkspaceId ?? ""))
    .map((workspace) => ({
      id: String(workspace.id ?? ""),
      name: String(workspace.name ?? "Без названия").trim() || "Без названия",
    }))
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
    const taskId = String(streamContextMenu.dataset.taskId ?? "");
    const provider = String(streamContextMenu.dataset.provider ?? "").trim();
    closeStreamContextMenu();
    if (!streamId) return;
    if (kind === "edit-stream") {
      if (taskId && currentTask()?.id !== taskId) selectTaskFromUi(taskId);
      openDialogSettings();
      return;
    }
    if (kind === "replace-thread") {
      emit("stream:rebirth", { streamId, provider, taskId });
      return;
    }
    if (kind === "continue-provider") {
      const targetProvider = String(action.dataset.provider ?? "").trim();
      emit("stream:continue-provider", { streamId, provider: targetProvider, taskId });
      return;
    }
  });
  return streamContextMenu;
}

function openStreamContextMenu(event, tab) {
  closeWorkspaceContextMenu();
  closeWorkspaceFolderContextMenu();
  const menu = ensureStreamContextMenu();
  const streamId = String(tab.dataset.streamTabId ?? "");
  const workspaceId = String(tab.dataset.workspaceId ?? "");
  const provider = String(tab.dataset.streamProvider ?? "").trim();
  menu.dataset.streamId = streamId;
  menu.dataset.workspaceId = workspaceId;
  menu.dataset.workspaceName = String(tab.dataset.workspaceName ?? "");
  menu.dataset.streamName = String(tab.dataset.streamName ?? "");
  menu.dataset.taskId = String(tab.dataset.streamTaskId ?? "");
  menu.dataset.provider = provider;
  const oppositeProvider = provider === "codex" ? "claude" : provider === "claude" ? "codex" : "";
  const oppositeLabel = oppositeProvider === "claude" ? "Claude" : oppositeProvider === "codex" ? "Codex" : "";
  menu.replaceChildren(
    el("button", {
      type: "button", role: "menuitem", class: "stream-context-action",
      "data-stream-menu-action": "edit-stream", text: "Редактировать…",
    }),
    el("button", {
      type: "button", role: "menuitem", class: "stream-context-action",
      "data-stream-menu-action": "replace-thread", text: "Ротация",
      disabled: tab.hasAttribute("data-running") || !["codex", "claude"].includes(provider),
      title: tab.hasAttribute("data-running")
        ? "Сначала завершите текущий ход"
        : !["codex", "claude"].includes(provider)
          ? "Ротация доступна для Codex и Claude"
          : `Завершить текущий Thread и продолжить Stream в новом Thread ${provider === "claude" ? "Claude" : "Codex"}`,
    }),
    el("button", {
      type: "button", role: "menuitem", class: "stream-context-action",
      "data-stream-menu-action": "continue-provider",
      "data-provider": oppositeProvider,
      text: oppositeProvider ? `Продолжить в ${oppositeLabel}` : "Продолжение недоступно",
      disabled: tab.hasAttribute("data-running") || !oppositeProvider,
      title: tab.hasAttribute("data-running")
        ? "Сначала завершите текущий ход"
        : oppositeProvider
          ? `Создать новый ${oppositeLabel} Thread в этом Stream и передать ему handoff-пакет`
          : "Провайдер Stream не определён",
    }),
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
  if (workspaceFolderContextMenu && !workspaceFolderContextMenu.contains(event.target)) {
    closeWorkspaceFolderContextMenu();
  }
});
window.addEventListener("resize", closeStreamContextMenu);
window.addEventListener("resize", closeWorkspaceContextMenu);
window.addEventListener("resize", closeWorkspaceFolderContextMenu);
window.addEventListener("resize", scheduleStreamTabsOverflow);
document.addEventListener("scroll", (event) => {
  if (!streamContextMenu?.contains(event.target)) closeStreamContextMenu();
  if (!workspaceContextMenu?.contains(event.target)) closeWorkspaceContextMenu();
  if (!workspaceFolderContextMenu?.contains(event.target)) closeWorkspaceFolderContextMenu();
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
  if (TaskReferences.hasTransfer(event.dataTransfer)) return;
  if (!draggedStreamId || !event.target.closest("[data-stream-tab-id]")) return;
  event.preventDefault();
});
streamTabs?.addEventListener("drop", (event) => {
  if (TaskReferences.hasTransfer(event.dataTransfer)) return;
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
  const order = orderedWorkspaceStreams(streams, workspaceId).map((stream) => stream.id)
    .filter((id) => id !== streamId);
  const targetIndex = order.indexOf(targetId);
  const rect = target.getBoundingClientRect();
  const insertAfter = target.classList.contains("stream-overflow-item")
    ? event.clientY > rect.top + rect.height / 2
    : event.clientX > rect.left + rect.width / 2;
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

function syncTaskListSelection() {
  const selected = currentTask();
  const selectedWorkspaceId = workspaceKey(selected);
  for (const item of taskList.querySelectorAll("[data-workspace-select]")) {
    const active = String(item.dataset.workspaceSelect ?? "") === selectedWorkspaceId;
    item.toggleAttribute("data-selected", active);
    item.setAttribute("aria-pressed", String(active));
  }
  for (const item of taskList.querySelectorAll("[data-task-id]")) {
    const active = String(item.dataset.taskId ?? "") === String(selected?.id ?? "");
    item.toggleAttribute("data-selected", active);
    item.setAttribute("aria-pressed", String(active));
  }
}

function syncStreamTabsSelection() {
  const selected = currentTask();
  const workspaceId = workspaceKey(selected);
  const open = new Set(state.openStreamsByWorkspace.get(workspaceId) ?? []);
  for (const tab of streamTabs?.querySelectorAll("[data-stream-tab-id]") ?? []) {
    const taskId = String(tab.dataset.streamTaskId ?? "");
    const streamId = String(tab.dataset.streamTabId ?? "");
    tab.toggleAttribute("data-current", taskId === String(selected?.id ?? ""));
    tab.setAttribute("aria-pressed", String(open.has(streamId)));
  }
}

function selectTaskFromUi(id, {
  preserveTaskList = false,
  preserveStreamTabs = false,
  preservePane = false,
} = {}) {
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
  if (preserveTaskList) syncTaskListSelection();
  else renderTasks();
  renderChat({ preserveStreamTabs });
  if (!preservePane) setPane("chat");
  emit("task:select", { id });
}

/* ================================================================== чат */

let activeChatId = null;
const INITIAL_MESSAGE_RENDER_LIMIT = 40;
const MESSAGE_RENDER_PAGE_SIZE = 40;

function messageCountLabel(count) {
  const value = Math.max(0, Number(count) || 0);
  const mod100 = value % 100;
  const mod10 = value % 10;
  const noun = mod100 >= 11 && mod100 <= 14
    ? "сообщений"
    : mod10 === 1 ? "сообщение" : mod10 >= 2 && mod10 <= 4 ? "сообщения" : "сообщений";
  return `${value.toLocaleString("ru-RU")} ${noun}`;
}

function providerResponseForTask(task, now = Date.now()) {
  if (!task) return null;
  const key = String(task.id ?? task.streamId ?? task.threadId ?? "");
  const providerStart = task.providerStart ?? (!task.running
    ? window.AgentHubProviderTurnTelemetry.providerStartFromTelemetry(task.providerTurnTelemetry)
    : null);
  const selected = window.AgentHubConnectionQuality.selectModelResponseSample({
    providerStart,
    previous: state.providerResponseSamples.get(key) ?? null,
    now,
    running: task.running,
    compaction: task.context?.compaction,
  });
  if (!selected) return null;
  if (selected.remember && key) state.providerResponseSamples.set(key, {
    measurement: structuredClone(selected.measurement),
    providerStart: structuredClone(selected.providerStart),
  });
  return { ...selected.measurement, sampleKind: selected.sampleKind };
}

function cachedProviderStartForTask(task, measurement = null) {
  const key = String(task?.id ?? task?.streamId ?? task?.threadId ?? "");
  if (measurement?.sampleKind === "previous") {
    return state.providerResponseSamples.get(key)?.providerStart ?? null;
  }
  if (task?.providerStart) return task.providerStart;
  if (!task?.running && task?.providerTurnTelemetry) {
    return window.AgentHubProviderTurnTelemetry.providerStartFromTelemetry(task.providerTurnTelemetry);
  }
  return state.providerResponseSamples.get(key)?.providerStart ?? null;
}

function formatModelResponseLatency(latencyMs) {
  const milliseconds = Math.max(0, Number(latencyMs) || 0);
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} мс`;
  const seconds = milliseconds / 1_000;
  if (seconds < 60) {
    return `${seconds.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} с`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function providerPhaseLabel(phase) {
  return ({
    starting: "запуск",
    working: "работа",
    reasoning: "размышление",
    answering: "ответ",
    tool: "инструмент",
    compaction: "свёртка",
    "waiting-user": "ожидание пользователя",
    completed: "завершён",
  })[String(phase ?? "")] ?? "работа";
}

function compactionStageLabel(stage) {
  return ({
    compacting: "провайдер",
    "cleaning-images": "очистка изображений",
    "measuring-context": "замер контекста",
  })[String(stage ?? "")] ?? String(stage ?? "свёртка");
}

function providerStallSummary(task, now) {
  const active = state.tasks.filter((candidate) => (
    candidate.running && String(candidate.provider ?? "") === String(task.provider ?? "")
  ));
  const stalled = active.filter((candidate) => {
    const measurement = window.AgentHubConnectionQuality.modelResponseMeasurement(candidate.providerStart, now, {
      running: candidate.running,
      compaction: candidate.context?.compaction,
    });
    if (!measurement || measurement.phase === "waiting-user") return false;
    return Number(measurement.compaction?.elapsedMs) > 300_000
      || Number(measurement.eventSilenceMs) > 120_000;
  });
  return { active: active.length, stalled: stalled.length };
}

function providerResponseTitle(task, measurement, presentation, providerLabel, now) {
  const sampleLabel = measurement.sampleKind === "previous"
    ? `предыдущий ход · ${presentation.label.toLowerCase()}`
    : presentation.label.toLowerCase();
  const lines = [`${providerLabel} ↔ модель: ${sampleLabel}`];
  lines.push(`Фаза: ${providerPhaseLabel(measurement.phase)}`);
  if (measurement.requestAcceptedMs != null) {
    lines.push(`Принятие хода: ${formatModelResponseLatency(measurement.requestAcceptedMs)}`);
  }
  if (measurement.firstEventMs != null) {
    lines.push(`До первого события: ${formatModelResponseLatency(measurement.firstEventMs)}`);
  } else if (measurement.active) {
    lines.push(`Первого события ещё нет: ${formatModelResponseLatency(measurement.latencyMs)}`);
  }
  if (measurement.firstContentMs != null) {
    lines.push(`До первого текста: ${formatModelResponseLatency(measurement.firstContentMs)}`);
  }
  if (measurement.active && measurement.eventSilenceMs != null) {
    lines.push(`Тишина событий: ${formatModelResponseLatency(measurement.eventSilenceMs)}`);
  }
  if (measurement.active && measurement.contentSilenceMs != null) {
    lines.push(`Без нового текста: ${formatModelResponseLatency(measurement.contentSilenceMs)}`);
  }
  if (measurement.maxEventGapMs != null) {
    lines.push(`Максимальная пауза: ${formatModelResponseLatency(measurement.maxEventGapMs)}`);
  }
  if (measurement.compaction?.active) {
    lines.push(`Свёртка: ${formatModelResponseLatency(measurement.compaction.elapsedMs)} · ${compactionStageLabel(measurement.compaction.stage)}`);
  }
  if (state.connection === "online" && state.connectionLatencyMs != null) {
    lines.push(`Локальный Hub: ${formatModelResponseLatency(state.connectionLatencyMs)}`);
  }
  const correlation = providerStallSummary(task, now);
  if (correlation.stalled > 0) {
    lines.push(`Зависание: ${correlation.stalled} из ${correlation.active} активных потоков`);
    if (correlation.stalled === 1) lines.push("Сигнал: проверить или ротировать этот поток");
    else if (
      state.connection === "online"
      && state.connectionLatencyMs != null
      && Number(state.connectionLatencyMs) <= 800
    ) {
      lines.push("Сигнал: проверить VPN, интернет или провайдера");
    } else {
      lines.push("Сигнал: проверить локальный Hub");
    }
  }
  return lines.join("\n");
}

function providerConnectionTitle(providerLabel, presentation, measurement) {
  if (presentation.state === "offline") {
    if (measurement?.failed && presentation.latencyMs != null) {
      return `${providerLabel} ↔ модель: нет связи, ошибка через ${formatModelResponseLatency(presentation.latencyMs)}`;
    }
    return `${providerLabel} ↔ модель: нет связи`;
  }
  if (presentation.latencyMs == null) {
    return `${providerLabel} ↔ модель: ${presentation.label.toLowerCase()}`;
  }
  const timing = formatModelResponseLatency(presentation.latencyMs);
  if (measurement?.sampleKind === "previous") {
    return `${providerLabel} ↔ модель: предыдущий ход · ${timing}`;
  }
  if (measurement?.waiting) return `${providerLabel} ↔ модель: ожидание первого ответа · ${timing}`;
  return `${providerLabel} ↔ модель: ${presentation.label.toLowerCase()} · ${timing}`;
}

function renderStreamChatHeader(task, now = Date.now()) {
  if (!streamChatHeader) return;
  streamChatHeader.hidden = !task;
  const workspaceName = task ? String(task.workspaceName || task.title || "Workspace").trim() : "";
  const streamName = task ? String(task.streamName || task.streamDisplayName || "Stream").trim() : "";
  if (streamHeaderWorkspace) {
    streamHeaderWorkspace.textContent = workspaceName;
    streamHeaderWorkspace.title = workspaceName;
  }
  if (streamHeaderName) streamHeaderName.textContent = streamName;
  if (!task) return;
  const provider = String(task.provider ?? "none");
  const providerLabel = task.agentLabel || providerLabels[provider] || "Агент";
  const statusState = window.AgentHubStreamTabs.streamStatusState(task);
  if (streamHeaderProviderDot) {
    streamHeaderProviderDot.dataset.provider = provider;
    streamHeaderProviderDot.dataset.state = statusState;
  }
  if (streamHeaderProvider) streamHeaderProvider.textContent = providerLabel;
  if (streamHeaderProviderConnection) {
    const measurement = providerResponseForTask(task, now);
    const presentation = window.AgentHubConnectionQuality.modelLinkState({
      measurement,
      status: state.connection || "offline",
    });
    const label = presentation.latencyMs == null
      ? presentation.label.toLowerCase()
      : presentation.state === "offline"
        ? "нет связи"
        : `${measurement?.sampleKind === "previous" ? "пред. " : ""}${formatModelResponseLatency(presentation.latencyMs)}`;
    const title = providerConnectionTitle(providerLabel, presentation, measurement);
    streamHeaderProviderConnection.hidden = false;
    streamHeaderProviderConnection.dataset.quality = presentation.quality;
    streamHeaderProviderConnection.dataset.linkState = presentation.state;
    streamHeaderProviderConnection.dataset.bars = String(presentation.bars);
    streamHeaderProviderConnection.title = title;
    streamHeaderProviderConnection.setAttribute("aria-label", title);
    if (streamHeaderProviderConnectionLabel) streamHeaderProviderConnectionLabel.textContent = label;
    if (streamHeaderProviderConnectionRetry) streamHeaderProviderConnectionRetry.hidden = !presentation.retry;
    if (measurement) {
      const telemetryPresentation = window.AgentHubConnectionQuality.modelResponseQuality(measurement);
      providerTurnTelemetry.update({
        task,
        providerStart: cachedProviderStartForTask(task, measurement),
        measurement,
        presentation: telemetryPresentation,
        title: providerResponseTitle(task, measurement, telemetryPresentation, providerLabel, now),
      });
    } else {
      providerTurnTelemetry.update(null);
    }
  }
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
    streamHeaderMessageCount.textContent = messageCountLabel(MessageView.resolvedMessageCount(
      state.messages.get(task.id)?.length ?? 0,
      state.historyPagination.get(task.id)?.messageTotal,
    ));
  }
}

function renderChat({ preserveStreamTabs = false } = {}) {
  return window.AgentHubCommandTrace.measure("ui-render", "chat", () => renderChatContent({ preserveStreamTabs }));
}

function renderChatContent({ preserveStreamTabs = false } = {}) {
  const task = currentTask();
  const hasTask = Boolean(task);
  if (!hasTask) {
    chatEmpty.hidden = false;
    if (chatEmptyText) chatEmptyText.textContent = "Выберите Workspace слева, чтобы открыть его Потоки.";
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
    renderMessagePinShelf();
    renderComposerQuickMessages();
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
  renderMessagePinShelf();
  for (const stop of chatStops) {
    const preparing = contextMaintenancePreparing(task);
    stop.hidden = !task.running && !preparing;
    stop.title = preparing ? "Отменить подготовку обслуживания контекста" : "Остановить ход";
    stop.setAttribute("aria-label", stop.title);
  }
  renderContextUsage(task);
  if (preserveStreamTabs) syncStreamTabsSelection();
  else renderStreamTabs();
  // Сначала закрепляем окончательную ширину и порядок колонок. Историю и её
  // нижний якорь рисуем уже после layout, поэтому открытый чат не остаётся выше.
  renderStreamChatDeck();

  if (taskChanged) {
    activeChatId = task.id;
    state.messageRenderLimits.set(task.id, INITIAL_MESSAGE_RENDER_LIMIT);
    renderMessages({ forceBottom: true });
  }
  renderLive();
  renderApprovals();
  renderQueue();
  renderComposerQuickMessages();
  // Композер восстанавливаем только при реальной смене задачи, чтобы фоновые
  // обновления статуса не сбрасывали курсор и набранный текст.
  if (taskChanged) restoreDraft();
}

function contextMaintenancePreparing(task) {
  return ["automatic-post-turn", "automatic-post-turn-rotation"].includes(task?.maintenance?.reason)
    && task?.maintenance?.phase === "preparing";
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
  const preparing = contextMaintenancePreparing(task);
  const starting = ["automatic-post-turn", "automatic-post-turn-rotation"].includes(task?.maintenance?.reason)
    && task?.maintenance?.phase === "starting";
  contextLabel.textContent = preparing ? "подготовка…" : starting ? "запуск…" : context.compacting
    ? "свёртка…"
    : context.usagePending ? "обновление…" : `${Math.round(percent)}% контекста`;
  contextRing.style.setProperty("--context-percent", `${percent}%`);
  contextUsageButton.title = preparing ? "Подготовка обслуживания контекста. Проверяется завершение предыдущего хода…"
    : starting ? "Запуск обслуживания контекста…" : context.compacting
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
  contextUsageCompact.hidden = !["codex", "claude"].includes(String(task.provider ?? ""));
  contextUsageCompact.disabled = Boolean(task.running || task.maintenance || context.compacting || context.usagePending);
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
let attachmentViewerGeneration = 0;
let attachmentViewerLoadTimer = null;
let attachmentViewerDeadlineAt = 0;
const ATTACHMENT_VIEWER_LOAD_TIMEOUT_MS = Math.max(
  1,
  Number(window.__agentHubAttachmentViewerLoadTimeoutMs) || 30_000,
);

function attachmentViewerLoadAuthority({
  generation = attachmentViewerGeneration,
  index = attachmentViewerIndex,
} = {}) {
  const current = attachmentViewerOpen
    && generation === attachmentViewerGeneration
    && index === attachmentViewerIndex;
  const remainingMs = current
    ? Math.max(0, attachmentViewerDeadlineAt - performance.now())
    : 0;
  return Object.freeze({
    current,
    owned: current && remainingMs > 0,
    generation: attachmentViewerGeneration,
    index: attachmentViewerIndex,
    deadlineAt: attachmentViewerDeadlineAt,
    remainingMs,
  });
}

function syncAttachmentViewerControls() {
  const length = attachmentViewerGallery.length;
  const selected = attachmentViewerGallery[attachmentViewerIndex] ?? {};
  attachmentViewerPrevious.hidden = length < 2 || attachmentViewerIndex <= 0;
  attachmentViewerNext.hidden = length < 2 || attachmentViewerIndex >= length - 1;
  attachmentViewerCaption.hidden = length === 0;
  attachmentViewerName.textContent = String(selected.name ?? "Изображение");
  attachmentViewerCounter.textContent = length > 1 ? `${attachmentViewerIndex + 1} / ${length}` : "";
}

function clearAttachmentViewerLoad() {
  if (attachmentViewerLoadTimer != null) window.clearTimeout(attachmentViewerLoadTimer);
  attachmentViewerLoadTimer = null;
  attachmentViewerImage.onload = null;
  attachmentViewerImage.onerror = null;
}

function disposeAttachmentViewerResource(generation = attachmentViewerGeneration) {
  document.dispatchEvent(new CustomEvent("agenthub:attachment-viewer-dispose", {
    detail: { generation, index: attachmentViewerIndex },
  }));
}

function setAttachmentViewerLoading(message = "Загрузка…", error = false) {
  attachmentViewerLoading.textContent = String(message || "Не удалось загрузить изображение");
  attachmentViewerLoading.classList.toggle("is-error", error);
  attachmentViewerLoading.hidden = false;
}

function settleAttachmentViewerLoad({ generation, index, loaded, message = "" }) {
  if (!attachmentViewerOpen
    || generation !== attachmentViewerGeneration
    || index !== attachmentViewerIndex) return false;
  const loadedInTime = loaded && performance.now() <= attachmentViewerDeadlineAt;
  if (!loadedInTime) disposeAttachmentViewerResource(generation);
  clearAttachmentViewerLoad();
  if (loadedInTime) {
    attachmentViewerImage.hidden = false;
    attachmentViewerLoading.hidden = true;
    attachmentViewerLoading.classList.remove("is-error");
    return true;
  }
  attachmentViewerImage.removeAttribute("src");
  attachmentViewerImage.hidden = true;
  setAttachmentViewerLoading(
    message || (loaded ? "Изображение не загрузилось вовремя" : "Не удалось загрузить изображение"),
    true,
  );
  return true;
}

function loadAttachmentViewerSource({ source = "", name = "Изображение", generation, index }) {
  const authority = attachmentViewerLoadAuthority({ generation, index });
  if (!authority.owned) return false;
  clearAttachmentViewerLoad();
  attachmentViewerImage.removeAttribute("src");
  attachmentViewerImage.hidden = true;
  attachmentViewerImage.alt = String(name || "Изображение");
  setAttachmentViewerLoading();
  attachmentViewerLoadTimer = window.setTimeout(() => {
    settleAttachmentViewerLoad({
      generation,
      index,
      loaded: false,
      message: "Изображение не загрузилось вовремя",
    });
  }, Math.max(1, authority.remainingMs));
  const resource = String(source ?? "").trim();
  if (!resource) return true;
  attachmentViewerImage.onload = () => {
    settleAttachmentViewerLoad({ generation, index, loaded: true });
  };
  attachmentViewerImage.onerror = () => {
    settleAttachmentViewerLoad({
      generation,
      index,
      loaded: false,
      message: "Не удалось загрузить изображение",
    });
  };
  attachmentViewerImage.src = resource;
  return true;
}

function openAttachmentViewer({ dataUrl = "", name = "Изображение", gallery = [], index = 0 } = {}) {
  if (!attachmentViewerOpen) attachmentViewerReturnFocus = document.activeElement;
  disposeAttachmentViewerResource();
  attachmentViewerGallery = resourceInteractions.imageGallery(
    Array.isArray(gallery) && gallery.length ? gallery : [{ dataUrl, name, type: "image/*" }],
  );
  attachmentViewerIndex = resourceInteractions.galleryIndex(index, attachmentViewerGallery.length);
  const selected = attachmentViewerGallery[attachmentViewerIndex] ?? { dataUrl, name };
  const selectedDataUrl = String(selected.dataUrl ?? dataUrl ?? "");
  attachmentViewerGeneration += 1;
  const generation = attachmentViewerGeneration;
  attachmentViewerDeadlineAt = performance.now() + ATTACHMENT_VIEWER_LOAD_TIMEOUT_MS;
  attachmentViewerOpen = true;
  attachmentViewer.hidden = false;
  if (!attachmentViewer.open) {
    if (typeof attachmentViewer.showModal === "function") attachmentViewer.showModal();
    else attachmentViewer.setAttribute("open", "");
  }
  modalOverlays?.activateOverlay(attachmentViewer, attachmentViewerReturnFocus);
  modalOverlays?.activateOverlay(attachmentViewerStage, attachmentViewerReturnFocus);
  syncAttachmentViewerControls();
  root.dataset.overlay = "attachment";
  attachmentViewer.focus({ preventScroll: true });
  loadAttachmentViewerSource({
    source: selectedDataUrl,
    name: selected.name ?? name,
    generation,
    index: attachmentViewerIndex,
  });
  return generation;
}

function showAttachmentViewer({
  dataUrl,
  name = "Изображение",
  index = attachmentViewerIndex,
  generation = attachmentViewerGeneration,
  transient = false,
} = {}) {
  if (!attachmentViewerOpen) {
    if (generation !== attachmentViewerGeneration) return false;
    generation = openAttachmentViewer({ name, index });
  }
  if (!attachmentViewerLoadAuthority({ generation, index }).owned) return false;
  if (resourceInteractions.galleryIndex(index, attachmentViewerGallery.length) !== attachmentViewerIndex) return false;
  if (!transient) {
    const selected = attachmentViewerGallery[attachmentViewerIndex] ?? {};
    attachmentViewerGallery[attachmentViewerIndex] = { ...selected, dataUrl: String(dataUrl ?? "") };
  }
  syncAttachmentViewerControls();
  return loadAttachmentViewerSource({
    source: dataUrl,
    name,
    generation,
    index: attachmentViewerIndex,
  });
}

function failAttachmentViewer({
  message = "Не удалось загрузить изображение",
  index = attachmentViewerIndex,
  generation = attachmentViewerGeneration,
} = {}) {
  return settleAttachmentViewerLoad({ generation, index, loaded: false, message });
}

function moveAttachmentViewer(direction) {
  if (!attachmentViewerOpen) return false;
  const nextIndex = resourceInteractions.moveGalleryIndex(
    attachmentViewerIndex,
    direction,
    attachmentViewerGallery.length,
  );
  if (nextIndex === attachmentViewerIndex) return false;
  disposeAttachmentViewerResource();
  attachmentViewerIndex = nextIndex;
  attachmentViewerGeneration += 1;
  const generation = attachmentViewerGeneration;
  attachmentViewerDeadlineAt = performance.now() + ATTACHMENT_VIEWER_LOAD_TIMEOUT_MS;
  const attachment = attachmentViewerGallery[attachmentViewerIndex];
  const dataUrl = String(attachment?.dataUrl ?? "");
  syncAttachmentViewerControls();
  loadAttachmentViewerSource({
    source: dataUrl,
    name: attachment?.name,
    generation,
    index: attachmentViewerIndex,
  });
  if (!dataUrl) emit("attachment:load", {
    attachment,
    gallery: attachmentViewerGallery,
    index: attachmentViewerIndex,
    generation,
  });
  return true;
}

function closeAttachmentViewer() {
  if (!attachmentViewerOpen) return false;
  modalOverlays?.deactivateOverlay(attachmentViewerStage);
  modalOverlays?.deactivateOverlay(attachmentViewer);
  disposeAttachmentViewerResource();
  attachmentViewerOpen = false;
  attachmentViewerGeneration += 1;
  attachmentViewerDeadlineAt = 0;
  clearAttachmentViewerLoad();
  if (attachmentViewer.open && typeof attachmentViewer.close === "function") attachmentViewer.close();
  else attachmentViewer.removeAttribute("open");
  attachmentViewer.hidden = true;
  attachmentViewerImage.removeAttribute("src");
  attachmentViewerImage.hidden = true;
  setAttachmentViewerLoading();
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
modalOverlays?.installDismissibleOverlay({
  dialog: attachmentViewer,
  content: attachmentViewerStage,
  close: closeAttachmentViewer,
});
modalOverlays?.installScrimDismiss({
  scrim: attachmentViewerStage,
  close: closeAttachmentViewer,
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

function renderedMessageTarget({ turnId, itemId } = {}) {
  return [...chatLog.querySelectorAll("[data-item-id]")].find((node) => (
    String(node.dataset.turnId ?? "") === String(turnId ?? "")
    && String(node.dataset.itemId ?? "") === String(itemId ?? "")
  )) ?? null;
}

function focusRenderedMessage(identity, { behavior = "smooth" } = {}) {
  const target = renderedMessageTarget(identity);
  if (!target) return false;
  chatLog.querySelectorAll("[data-search-match], [data-pin-highlight]").forEach((node) => {
    node.removeAttribute("data-search-match");
    node.removeAttribute("data-pin-highlight");
  });
  const scrollController = chatScrollControllers.get(chatScroll);
  const navigationGeneration = scrollController?.beginExactNavigation();
  target.setAttribute("data-pin-highlight", "");
  target.tabIndex = -1;
  target.scrollIntoView({ block: "center", behavior });
  target.focus({ preventScroll: true });
  scrollController?.completeExactNavigation(navigationGeneration);
  if (messagePinStatus) messagePinStatus.textContent = "Закреплённое сообщение показано";
  window.setTimeout(() => target.removeAttribute("data-pin-highlight"), 4_000);
  return true;
}

function currentHistoryPagination() {
  return state.historyPagination.get(state.selectedId) ?? { hasOlder: false, loading: false };
}

function messageTailPagination(taskId = state.selectedId) {
  const messages = state.messages.get(taskId) ?? [];
  const visibleLimit = state.messageRenderLimits.get(taskId) ?? INITIAL_MESSAGE_RENDER_LIMIT;
  return MessageView.messageTailPagination(messages.length, visibleLimit, MESSAGE_RENDER_PAGE_SIZE);
}

function canLoadOlderHistory(taskId = state.selectedId) {
  return messageTailPagination(taskId).hiddenCount > 0
    || (state.historyPagination.get(taskId)?.hasOlder === true);
}

function renderHistoryLoader() {
  const pagination = currentHistoryPagination();
  const tail = messageTailPagination();
  historyLoader.hidden = tail.hiddenCount === 0 && !pagination.hasOlder && !pagination.loading;
  historyLoader.toggleAttribute("data-loading", pagination.loading);
  historyLoadButton.disabled = pagination.loading;
  if (!historyLoader.hasAttribute("data-pulling")) {
    historyLoadLabel.textContent = pagination.loading
      ? "Загрузка…"
      : tail.hiddenCount > 0
        ? `Показать ещё (${tail.nextCount})`
        : "Загрузить ещё";
  }
}

function messageDisclosureId(article) {
  return String(article.dataset.messageId ?? "").trim();
}

const deferredUserMessageBodyRenderers = new WeakMap();

function configureDeferredUserMessageBody(body, { renderPreview, renderFull, expanded = false }) {
  const state = { expanded: null, renderFull, renderPreview };
  deferredUserMessageBodyRenderers.set(body, state);
  syncDeferredUserMessageBody(body, expanded);
}

function syncDeferredUserMessageBody(body, expanded) {
  const state = deferredUserMessageBodyRenderers.get(body);
  if (!state || state.expanded === expanded) return;
  body.replaceChildren();
  (expanded ? state.renderFull : state.renderPreview)(body);
  state.expanded = expanded;
}

function updateUserMessageDisclosure(article) {
  const body = article.querySelector(".msg-body[data-user-message-disclosure]");
  if (!body) return;
  const bubble = article.querySelector(".msg-user-bubble");
  if (!bubble) return;
  const id = messageDisclosureId(article);
  const deferred = deferredUserMessageBodyRenderers.has(body);
  const overflows = deferred || hasCollapsedOverflow(body.scrollHeight, USER_MESSAGE_COLLAPSE_HEIGHT_PX);
  const existing = article.querySelector("[data-message-disclosure]");
  if (!overflows) {
    body.classList.remove("is-collapsed");
    existing?.remove();
    if (id) expandedUserMessageIds.delete(id);
    return;
  }

  const expanded = Boolean(id && expandedUserMessageIds.has(id));
  syncDeferredUserMessageBody(body, expanded);
  body.classList.toggle("is-collapsed", !expanded);
  const button = existing ?? el("button", {
    type: "button",
    class: "msg-disclosure",
    "data-message-disclosure": "",
  });
  const renderButton = (value) => {
    const presentation = MessageView.messageDisclosurePresentation(value);
    button.replaceChildren(
      el("span", { text: presentation.label }),
      window.AgentHubStreamTabs.createPhosphorIcon(
        document,
        presentation.icon,
        "msg-disclosure-icon",
      ),
    );
  };
  renderButton(expanded);
  button.setAttribute("aria-expanded", String(expanded));
  button.onclick = () => {
    const nextExpanded = body.classList.contains("is-collapsed");
    syncDeferredUserMessageBody(body, nextExpanded);
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

const pendingUserMessageDisclosureArticles = new Set();
let syncAllUserMessageDisclosures = false;

function scheduleUserMessageDisclosureSync(roots = null) {
  const scopedRoots = Array.isArray(roots) ? roots : null;
  if (scopedRoots == null) syncAllUserMessageDisclosures = true;
  else for (const root of scopedRoots) {
    const article = root?.matches?.(".msg-user[data-message-id]")
      ? root
      : root?.querySelector?.(".msg-user[data-message-id]");
    if (article) pendingUserMessageDisclosureArticles.add(article);
  }
  if (messageDisclosureFrame) return;
  messageDisclosureFrame = window.requestAnimationFrame(() => {
    messageDisclosureFrame = 0;
    const articles = syncAllUserMessageDisclosures
      ? chatLog.querySelectorAll(".msg-user[data-message-id]")
      : [...pendingUserMessageDisclosureArticles];
    syncAllUserMessageDisclosures = false;
    pendingUserMessageDisclosureArticles.clear();
    for (const article of articles) {
      updateUserMessageDisclosure(article);
    }
  });
}

window.addEventListener("resize", scheduleUserMessageDisclosureSync, { passive: true });

function renderedMessageAuthor(message, role) {
  const author = String(message?.author ?? "").trim()
    || (role === "user" ? "Вы" : role === "system" ? "Система" : "Агент");
  return message?.kind === "interstream" ? `Служебное · ${author}` : author;
}

function pruneComposerFiles() {
  const attachments = [...drafts.values()].flatMap((draft) => draft.attachments ?? []);
  attachments.push(...(pendingComposerRequest?.attachments ?? []), ...(window.AgentHubRetainedUploadAttachments?.() ?? []));
  window.AgentHubComposerFiles.prune(attachments.map((file) => file.blobId).filter(Boolean));
}
window.AgentHubPruneComposerFiles = pruneComposerFiles;

function syncMessageUploadActions(head, message) {
  const state = String(message.uploadState ?? "");
  let actions = head?.querySelector("[data-message-upload-actions]");
  if (!state) { actions?.remove(); return; }
  if (actions?.dataset.uploadState === state) return;
  actions?.remove();
  actions = el("span", { "data-message-upload-actions": "", "data-upload-state": state, class: "msg-upload-actions" });
  for (const action of state === "paused" ? ["resume", "cancel"] : ["cancel"]) {
    const button = el("button", {
      type: "button", class: "queue-accept", [`data-upload-${action}`]: "",
      text: action === "resume" ? "Продолжить загрузку" : "Отменить отправку",
    });
    button.addEventListener("click", () => emit(`message:upload-${action}`, {
      clientUserMessageId: message.clientUserMessageId,
    }));
    actions.append(button);
  }
  head?.append(actions);
}

function patchRenderedMessage(node, message) {
  const article = node.matches?.("article.msg, details.msg")
    ? node
    : node.querySelector?.("article.msg, details.msg");
  if (!article) return;
  article.dataset.messageId = message.id ?? "";
  article.dataset.turnId = message.turnId ?? "";
  article.dataset.itemId = message.itemId ?? "";
  article.dataset.deliveryState = message.deliveryState ?? "";
  const role = message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
  const author = renderedMessageAuthor(message, role);
  const head = article.querySelector(".msg-head");
  syncMessageUploadActions(head, message);
  const authorNode = head?.querySelector(".msg-author");
  if (authorNode) authorNode.textContent = author;
  let time = head?.querySelector(".msg-time");
  if (message.time) {
    if (!time) {
      time = el("span", { class: "msg-time" });
      head?.insertBefore(time, head.querySelector(".msg-delivery"));
    }
    time.textContent = MessageView.messageTimestampLabel(message.time);
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
  let duration = head?.querySelector(".msg-turn-duration");
  const durationLabel = role === "agent"
    ? MessageView.turnDurationLabel(message.turnStartedAt, message.turnCompletedAt)
    : "";
  if (durationLabel) {
    if (!duration) {
      duration = el("span", {
        class: "msg-turn-duration",
        title: "Длительность хода",
        "aria-label": "Длительность хода",
      });
      head?.append(duration);
    }
    duration.textContent = durationLabel;
  } else {
    duration?.remove();
  }
}

function messageRenderSpec(message, index, lastAgentIndex, taskDiff, citationPresentations = []) {
  const withDiff = index === lastAgentIndex && Boolean(taskDiff);
  const renderedMessage = citationPresentations.length
    ? { ...message, responseCitationPresentations: citationPresentations }
    : message;
  return {
    key: MessageView.messageKey(message, index),
    signature: MessageView.messageContentSignature(renderedMessage, {
      withDiff,
      diffText: taskDiff?.text ?? "",
    }),
    message: renderedMessage,
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

function renderMessages(options = {}) {
  return window.AgentHubCommandTrace.measure("ui-render", "messages", () => renderMessagesContent(options));
}

function renderMessagesContent({
  forceBottom = false,
  preserveTop = false,
  prependedCount = 0,
  tailLimit = 0,
  exactNavigation = null,
} = {}) {
  const task = currentTask();
  const taskId = String(task?.id ?? "");
  renderStreamChatHeader(task);
  const scrollController = chatScrollControllers.get(chatScroll);
  const scrollSnapshot = exactNavigation ? null : scrollController?.capture();
  const stickToBottom = !exactNavigation
    && (forceBottom || scrollSnapshot?.pinned || chatIsNearBottom());
  // Обновление истории после финального ответа использует preserveTop. У низа
  // якорь первого видимого сообщения оставлял зазор после новой карточки.
  // Якорь нужен только читателю, который уже ушёл выше по истории.
  const incrementalPrepend = Number(prependedCount) > 0 && !tailLimit;
  const anchor = !exactNavigation && preserveTop && !stickToBottom && !incrementalPrepend
    ? captureChatAnchor()
    : null;
  // chatLog is a single physical DOM surface shared by every Stream. Claim it
  // before reading the new history so keyed reconciliation can never reuse a
  // message node (or its event handlers) owned by the previously selected
  // Stream, even when providers emit colliding message identifiers.
  const ownerChanged = MessageView.claimKeyedChildrenOwner(chatLog, taskId);
  const previousMessageKeys = new Set(Array.from(chatLog.children ?? [])
    .map((node) => String(node?.dataset?.messageKey ?? ""))
    .filter(Boolean));
  const historyLoaded = state.messages.has(taskId);
  const allMessages = MessageView.conversationSurfaceMessages(state.messages.get(taskId) ?? []);
  const visibleLimit = tailLimit > 0
    ? tailLimit
    : (state.messageRenderLimits.get(taskId) ?? INITIAL_MESSAGE_RENDER_LIMIT);
  const messages = MessageView.messageTailWindow(allMessages, visibleLimit);
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
    if (exactNavigation) focusRenderedMessage(exactNavigation, { behavior: "auto" });
    else if (anchor) restoreChatAnchor(anchor);
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
  const messageOffset = Math.max(0, allMessages.length - messages.length);
  const citationsFor = (index) => MessageView.responseCitationPresentations(
    allMessages,
    messageOffset + index,
  );
  let prependedNodes = null;
  let newTailMessages = 0;
  const added = Math.min(messages.length, Math.max(0, Number(prependedCount) || 0));
  if (!ownerChanged && added > 0 && added < messages.length) {
    const prefixSpecs = messages.slice(0, added).map((message, index) => (
      messageRenderSpec(message, index, lastAgentIndex, taskDiff, citationsFor(index))
    ));
    const expectedExistingKeys = messages.slice(added).map((message, index) => (
      MessageView.messageKey(message, added + index)
    ));
    prependedNodes = MessageView.reconcilePrependedKeyedChildren(
      chatLog,
      prefixSpecs,
      expectedExistingKeys,
      createRenderedMessage,
    );
  }
  if (prependedNodes == null) {
    const specs = messages.map((message, index) => (
      messageRenderSpec(message, index, lastAgentIndex, taskDiff, citationsFor(index))
    ));
    newTailMessages = !ownerChanged && !tailLimit && !incrementalPrepend && !stickToBottom
      ? specs.filter((spec, index) => index >= previousMessageKeys.size
        && !previousMessageKeys.has(String(spec?.key ?? ""))).length
      : 0;
    MessageView.reconcileKeyedChildren(chatLog, specs, createRenderedMessage, (node, spec) => {
      patchRenderedMessage(node, spec.message);
    });
  }
  scheduleUserMessageDisclosureSync(prependedNodes);
  syncMessagePinActions();
  if (exactNavigation) {
    focusRenderedMessage(exactNavigation, { behavior: "auto" });
  } else if (anchor) {
    restoreChatAnchor(anchor);
    scrollController?.addUnread(newTailMessages);
  }
  else if (stickToBottom) pinChatToBottom();
  else window.requestAnimationFrame(() => scrollController?.afterMutation(scrollSnapshot, {
    preserveDistance: true,
    newItemsCount: newTailMessages,
  }));
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

function chatHistoryViewportVisible() {
  return root.dataset.view === "chat" && !document.hidden && !chatPane.hidden
    && chatScroll.clientHeight > 0 && chatScroll.clientWidth > 0;
}

function requestOlderHistory() {
  // Resize/scroll callbacks can still arrive after navigation hides this pane.
  // Zero-sized hidden history is not an empty viewport asking for more pages.
  if (!chatHistoryViewportVisible()) return;
  const pagination = currentHistoryPagination();
  if (!state.selectedId || pagination.loading) return;
  const tail = messageTailPagination();
  if (tail.hiddenCount > 0) {
    state.messageRenderLimits.set(state.selectedId, tail.visibleCount + tail.nextCount);
    renderMessages({ preserveTop: true, prependedCount: tail.nextCount });
    return;
  }
  if (!pagination.hasOlder) return;
  emit("history:load-older", { taskId: state.selectedId });
}

let historyUnderfillFrame = 0;

function scheduleUnderfilledHistoryLoad() {
  if (historyUnderfillFrame || root.dataset.view !== "chat" || document.hidden) return;
  historyUnderfillFrame = window.requestAnimationFrame(() => {
    historyUnderfillFrame = 0;
    if (!chatHistoryViewportVisible()) return;
    const pagination = currentHistoryPagination();
    if (shouldLoadOlderPage(chatScroll, {
      ...pagination,
      hasOlder: canLoadOlderHistory(),
    })) requestOlderHistory();
  });
}

historyLoadButton.addEventListener("click", requestOlderHistory);

chatScroll.addEventListener("touchstart", (event) => {
  const pagination = currentHistoryPagination();
  if (
    !phoneComposerMode()
    || event.touches.length !== 1
    || chatScroll.scrollTop > 1
    || !canLoadOlderHistory()
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
  const workspaceId = task ? workspaceKey(task) : "";
  const roots = [];
  const appendRoot = (value) => {
    const text = String(value ?? "").trim();
    if (!text || roots.includes(text)) return;
    roots.push(text);
  };
  appendRoot(task?.sessionCwd);
  appendRoot(task?.projectRoot);
  for (const candidate of state.tasks) {
    if (workspaceId && workspaceKey(candidate) !== workspaceId) continue;
    appendRoot(candidate?.sessionCwd);
    appendRoot(candidate?.projectRoot);
  }
  return {
    projectRoot: String(task?.projectRoot ?? "").trim(),
    sessionCwd: String(task?.sessionCwd ?? "").trim(),
    basePath: String(task?.sessionCwd ?? task?.projectRoot ?? "").trim(),
    homePath: String(state.options?.homePath ?? state.selection?.homePath ?? "").trim(),
    workspaceRoots: roots,
  };
}

function desktopFileLink(raw, fileContext = currentFileLinkContext()) {
  if (!(vscodeMode || surface === "desktop")) return null;
  const resolved = resourceInteractions.resolveFileReference(raw, fileContext);
  if (!resolved?.localPath) return null;
  return {
    candidates: resolved.candidates,
    href: vscodeMode ? "#" : `vscode://file/${encodeURI(resolved.localPath)}`,
    localPath: resolved.localPath,
  };
}

function markdownLink(raw, fileContext = currentFileLinkContext()) {
  const source = String(raw ?? "").trim();
  const value = source.startsWith("<") && source.endsWith(">")
    ? source.slice(1, -1).trim()
    : source;
  const taskReferenceLink = TaskReferences.link(value);
  if (taskReferenceLink) return taskReferenceLink;
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
  let cursor = 0;
  for (const match of MessageView.inlineMarkdownTokens(text)) {
    target.append(document.createTextNode(text.slice(cursor, match.index)));
    const token = match.token;
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
      const parts = token.match(/^\[([^\]\n]+)\]\(<([^>\n]+)>(?:\s+"([^"]*)")?\)$/u)
        ?? token.match(/^\[([^\]\n]+)\]\(([^)\n]+?)(?:\s+"([^"]*)")?\)$/u);
      const targetLink = markdownLink(parts?.[2], fileContext);
      if (targetLink) {
        const link = el("a", {
          href: targetLink.href,
          target: targetLink.taskId ? null : "_blank",
          rel: targetLink.taskId ? null : "noopener noreferrer",
          text: parts[1],
          title: parts[3] || null,
        });
        if (targetLink.taskId) link.dataset.agentHubTaskReference = targetLink.taskId;
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

function renderMarkdownCodeBlock(lines, language = "") {
  const text = lines.join("\n");
  const request = MessageView.codeBlockCopyRequest(text);
  const copyButton = request ? el("button", {
    type: "button",
    class: "msg-action markdown-code-copy",
    title: "Копировать блок",
    "aria-label": "Копировать блок",
    "data-code-block-copy": "",
  }, [
    window.AgentHubStreamTabs.createPhosphorIcon(document, "copy", "msg-action-icon"),
  ]) : null;
  copyButton?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    emit("clipboard:write", request);
  });
  return el("div", { class: "markdown-code-block" }, [
    el("pre", {}, [
      el("code", { class: language ? `language-${language}` : "", text }),
    ]),
    copyButton,
  ]);
}

function renderMarkdown(target, source, fileContext = currentFileLinkContext(), messageRole = "agent", detailsDepth = 0) {
  const disclosureState = MessageView.captureMarkdownDetailsState(target);
  target.replaceChildren();
  const lines = String(source ?? "").replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = MessageView.markdownFenceStart(line);
    if (fence) {
      const code = [];
      index += 1;
      while (index < lines.length && !MessageView.markdownFenceEnd(lines[index], fence)) code.push(lines[index++]);
      if (index < lines.length) index += 1;
      target.append(renderMarkdownCodeBlock(code, fence.language));
      continue;
    }
    const disclosure = detailsDepth < 32 ? MessageView.markdownDetailsAt(lines, index) : null;
    if (disclosure) {
      const summary = el("summary");
      appendInlineMarkdown(summary, disclosure.summary || "Подробнее", fileContext);
      const body = el("div", { class: "markdown-details-body" });
      renderMarkdown(body, disclosure.body, fileContext, messageRole, detailsDepth + 1);
      const details = el("details", { class: "markdown-details" }, [summary, body]);
      details.agentHubMarkdownDetailsSource = JSON.stringify([disclosure.summary, disclosure.body]);
      target.append(details);
      index = disclosure.nextIndex;
      continue;
    }
    const standaloneCode = MessageView.standaloneInlineCode(line);
    if (standaloneCode !== null) {
      target.append(renderMarkdownCodeBlock([standaloneCode]));
      index += 1;
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
        const quoteLine = lines[index].replace(/^\s*>\s?/u, "");
        const quoteCode = MessageView.standaloneInlineCode(quoteLine);
        if (quote.childNodes.length) quote.append(document.createElement("br"));
        if (quoteCode !== null) quote.append(renderMarkdownCodeBlock([quoteCode]));
        else appendInlineMarkdown(quote, quoteLine, fileContext);
        index += 1;
      }
      target.append(quote);
      continue;
    }
    const paragraph = [];
    while (index < lines.length
      && lines[index].trim()
      && !MessageView.markdownFenceStart(lines[index])
      && !/^\s*(?:#{1,6}\s|[-+*]\s+|\d+\.\s+|>\s?)/u.test(lines[index])
      && !(paragraph.length && detailsDepth < 32 && MessageView.markdownDetailsAt(lines, index))
      && !markdownTableAt(lines, index)) {
      paragraph.push(lines[index++]);
    }
    const extracted = MessageView.messageTechnicalContent(messageRole, paragraph.join("\n"));
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
  MessageView.restoreMarkdownDetailsState(target, disclosureState);
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
    ...(activity.type === "compaction" ? { title: String(activity.detail ?? "") } : {}),
  }, [
    el("span", { class: "activity-marker", "aria-hidden": "true" }),
    el("span", { class: "activity-time", text: activity.time
      ? new Date(activity.time).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
      : "" }),
    el("span", { class: "activity-label", text: activity.label ?? "Действие" }),
    el("span", { class: "activity-detail", text: activity.detail ?? "" }),
  ]);
}

const deferredDisclosureControllers = new WeakMap();

function configureDeferredDisclosure(details, content, renderContent) {
  const existing = deferredDisclosureControllers.get(details);
  if (existing) existing.update(renderContent);
  else deferredDisclosureControllers.set(
    details,
    MessageView.createDeferredDisclosureController(details, content, renderContent),
  );
  return details;
}

function syncDeferredDisclosure(details) {
  deferredDisclosureControllers.get(details)?.sync();
}

function activityFeedNode(activities) {
  const values = Array.isArray(activities) ? activities : [];
  if (!values.length) return null;
  const content = el("div", { class: "activity-list", "data-deferred-disclosure-content": "" });
  const details = el("details", { class: "activity-feed" }, [
    activityDisclosureSummary({ count: values.length }),
    content,
  ]);
  return configureDeferredDisclosure(details, content, (target) => {
    target.replaceChildren(...values.map(activityItemNode));
  });
}

function visibleTurnTraceGroups(groups) {
  return (Array.isArray(groups) ? groups : []).filter((group) => (
    String(group?.reasoning ?? "").trim() || (group?.activities?.length ?? 0) > 0
  ));
}

const traceDetailSources = new WeakMap();

function traceReasoningNode(group) {
  const node = el("div", { class: "turn-trace-reasoning", "data-trace-group-id": group.id });
  renderMarkdown(node, group.reasoning);
  traceDetailSources.set(node, group);
  return node;
}

function requestTracePage(identity, tracePage) {
  const boundIdentity = { ...identity, streamId: identity.streamId || currentTask()?.streamId };
  return new Promise((resolve, reject) => emit("history:trace-page", { identity: boundIdentity, tracePage, resolve, reject }));
}

function traceArchiveNode(identity) {
  const content = el("div", { class: "turn-trace-archive-content" });
  const previous = el("button", { type: "button", text: "Назад", disabled: true });
  const next = el("button", { type: "button", text: "Далее", disabled: true });
  const status = el("span", { role: "status" });
  const details = el("details", { class: "turn-trace-archive" }, [
    el("summary", { text: "Все этапы" }), content, previous, next, status,
  ]);
  let page = null;
  let pending = false;
  const offsets = [];
  async function load(offset, direction = "initial") {
    if (pending) return;
    pending = true;
    previous.disabled = next.disabled = true;
    status.textContent = "Загрузка…";
    try {
      const result = await requestTracePage(identity, {
        turnId: identity.turnId, offset,
        ...(page ? { generation: page.generation, sourceSize: page.sourceSize, sourceHash: page.sourceHash } : {}),
      });
      if (!details.isConnected) return;
      if (direction === "next") offsets.push(page.offset);
      if (direction === "previous") offsets.pop();
      page = result;
      content.replaceChildren(...page.groups.map((group) => el("section", {}, [
        ...(group.reasoning ? [traceReasoningNode(group)] : []),
        ...group.activities.map(activityItemNode),
      ])));
      status.textContent = "";
    } catch (error) {
      if (details.isConnected) status.textContent = error.message || "Не удалось прочитать этапы";
    } finally {
      pending = false;
      previous.disabled = !offsets.length;
      next.disabled = page?.nextOffset == null;
    }
  }
  details.addEventListener("toggle", () => { if (details.open && !page) void load(0); });
  previous.addEventListener("click", () => void load(offsets.at(-1), "previous"));
  next.addEventListener("click", () => void load(page.nextOffset, "next"));
  return details;
}

function traceOmissionNode(groups, identity = null) {
  const earlierGroups = Number(groups[0]?.omittedGroupsBefore) || 0;
  const earlierActivities = groups.reduce(
    (count, group) => count + (Number(group?.omittedActivities) || 0), 0,
  );
  if (!earlierGroups && !earlierActivities) return null;
  return identity?.provider === "codex" && identity.threadId && identity.turnId
    ? traceArchiveNode(identity)
    : el("div", { class: "turn-trace-omission", text: "Показаны последние этапы" });
}

function turnTraceGroupsNode(values, { liveStage = "", openGroupIds = [], identity = null } = {}) {
  const content = turnTraceContent(values);
  const blocks = content.reasoningBlocks.map((reasoning, index) => {
    const section = el("section", {
      class: "turn-trace-block",
      "data-trace-index": String(index),
    });
    const reasoningNode = traceReasoningNode(values.filter((group) => String(group.reasoning ?? "").trim())[index]);
    section.append(reasoningNode);
    return section;
  });
  if (content.activities.length) {
    const activityContent = el("div", {
      class: "activity-list",
      "data-deferred-disclosure-content": "",
    });
    const activityDetails = el("details", {
      class: "turn-trace-activities",
      "data-trace-group-id": TURN_TRACE_ACTIVITY_GROUP_ID,
      open: liveTraceDisclosureOpen({
        groupId: TURN_TRACE_ACTIVITY_GROUP_ID,
        openGroupIds,
      }),
    }, [
      activityDisclosureSummary({ count: content.activities.length, stage: liveStage }),
      activityContent,
    ]);
    blocks.push(configureDeferredDisclosure(activityDetails, activityContent, (target) => {
      target.replaceChildren(...content.activities.map(activityItemNode));
    }));
  }
  const omission = traceOmissionNode(values, identity);
  return el("div", { class: "turn-trace-groups" }, omission ? [omission, ...blocks] : blocks);
}

function turnTraceNode(groups, identity = null) {
  const values = visibleTurnTraceGroups(groups);
  if (!values.length) return null;
  const activityCount = values.reduce((total, group) => total + (group.activities?.length ?? 0), 0);
  const content = turnTraceContent(values);
  const summary = turnTraceSummary({
    reasoningCount: content.reasoningBlocks.length,
    activityCount,
  });
  if (traceOmissionNode(values)) summary.label += " · последние";
  const expanded = el("div", {
    class: "turn-trace-groups",
    "data-deferred-disclosure-content": "",
  });
  const details = el("details", { class: "turn-trace" }, [
    activityDisclosureSummary(summary),
    expanded,
  ]);
  return configureDeferredDisclosure(details, expanded, (target) => {
    const omission = traceOmissionNode(values, identity);
    if (omission) target.append(omission);
    content.reasoningBlocks.forEach((reasoning, index) => {
      const reasoningNode = traceReasoningNode(values.filter((group) => String(group.reasoning ?? "").trim())[index]);
      target.append(el("section", {
        class: "turn-trace-block",
        "data-trace-index": String(index),
      }, [reasoningNode]));
    });
    if (content.activities.length) {
      target.append(el("div", { class: "activity-list" }, content.activities.map(activityItemNode)));
    }
  });
}

function messageActionButton({ icon, label, action, onClick, pressed = null, disabled = false }) {
  const button = el("button", {
    type: "button",
    class: "msg-action",
    title: label,
    "aria-label": `${label} сообщение`,
    [`data-message-${action}`]: "",
    ...(pressed === null ? {} : { "aria-pressed": String(pressed) }),
    disabled,
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
  saveDraft({ userEdited: true });
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
  saveDraft({ userEdited: true });
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
  if (message.pinEligible === true && message.messageKey) {
    const pin = pinsForTask().find((candidate) => candidate.messageKey === message.messageKey);
    const pinned = Boolean(pin);
    actions.push(messageActionButton({
      icon: "push-pin-simple",
      label: pinned ? "Открепить" : "Закрепить",
      action: "pin",
      pressed: pinned,
      disabled: state.pendingMessagePinKeys.has(message.messageKey),
      onClick: () => {
        const currentPin = pinsForTask().find((candidate) => candidate.messageKey === message.messageKey);
        requestMessagePinChange({ message, pin: currentPin, pinned: !currentPin });
      },
    }));
  }
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

function syncMessagePinActions() {
  for (const button of chatLog.querySelectorAll("[data-message-pin]")) {
    const article = button.closest(".msg-stack")?.querySelector("[data-message-key]");
    const messageKey = String(article?.dataset.messageKey ?? "");
    const pinned = pinsForTask().some((pin) => pin.messageKey === messageKey);
    const label = pinned ? "Открепить" : "Закрепить";
    button.setAttribute("aria-pressed", String(pinned));
    button.setAttribute("aria-label", `${label} сообщение`);
    button.title = label;
    button.disabled = state.pendingMessagePinKeys.has(messageKey);
    const caption = button.querySelector("span");
    if (caption) caption.textContent = label;
  }
}

function renderMessage(message, { readOnly = false, task = currentTask() } = {}) {
  const role = message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
  const maintenance = role === "system" && message.kind === "maintenance";
  const subagent = role === "agent" && message.kind === "subagent";
  const subagentTitle = subagent ? subagentResponseTitle(message) : "";
  const article = el(subagent ? "details" : "article", {
    class: `msg msg-${role}${maintenance ? " msg-maintenance" : ""}${subagent ? " msg-subagent" : ""}`,
    "data-role": role,
    "data-message-id": message.id ?? "",
    "data-turn-id": message.turnId ?? "",
    "data-item-id": message.itemId ?? "",
    "data-message-key": message.messageKey ?? "",
    "data-delivery-state": message.deliveryState ?? "",
    "data-provider": String(task?.provider ?? "none"),
    ...(maintenance && message.measurementKind === "estimated"
      ? { title: String(message.maintenanceDetail ?? "Предварительная оценка провайдера после свёртки") }
      : {}),
    ...(subagent ? { "data-subagent-response": true } : {}),
  });

  const author = renderedMessageAuthor(message, role);
  const head = el(subagent ? "summary" : "div", { class: "msg-head" }, [
    subagent
      ? el("span", { class: "msg-subagent-chevron", "aria-hidden": "true" }, [
          window.AgentHubStreamTabs.createPhosphorIcon(
            document,
            "caret-right",
            "msg-subagent-chevron-icon",
          ),
        ])
      : null,
    el("span", { class: "msg-author", text: author }),
    subagent
      ? el("span", { class: "msg-subagent-title", text: subagentTitle, title: subagentTitle })
      : null,
    message.time
      ? el("span", {
          class: "msg-time",
          text: MessageView.messageTimestampLabel(message.time),
        })
      : null,
    message.delivery
      ? el("span", {
          class: `msg-delivery${message.failed ? " is-failed" : ""}`,
          text: message.delivery,
        })
      : null,
    role === "agent" && MessageView.turnDurationLabel(message.turnStartedAt, message.turnCompletedAt)
      ? el("span", {
          class: "msg-turn-duration",
          title: "Длительность хода",
          "aria-label": "Длительность хода",
          text: MessageView.turnDurationLabel(message.turnStartedAt, message.turnCompletedAt),
        })
      : null,
  ]);

  const body = el("div", {
    class: "msg-body",
    ...(role === "user" ? { "data-user-message-disclosure": "" } : {}),
  });
  const renderBody = (target) => {
    target.replaceChildren();
    // Markdown собирается только безопасными DOM-узлами; сырой HTML не исполняется.
    if (renderResponseAnnotations(target, message)) return;
    const text = role === "system"
      ? MessageView.normalizeSystemEventText(message.text ?? "")
      : message.text ?? "";
    if (role === "agent" && Array.isArray(message.responseCitationPresentations)
      && message.responseCitationPresentations.length) {
      renderAgentResponseBody(target, message, text, currentFileLinkContext(task));
    } else renderMarkdown(target, text, currentFileLinkContext(task), role);
  };
  const deferredPreview = MessageView.deferredUserMessagePreview(message);
  if (deferredPreview != null) {
    body.dataset.deferredMessageBody = "";
    configureDeferredUserMessageBody(body, {
      expanded: Boolean(message.id && expandedUserMessageIds.has(message.id)),
      renderPreview: (target) => target.append(el("p", {
        class: "msg-deferred-preview",
        text: deferredPreview,
      })),
      renderFull: renderBody,
    });
  } else renderBody(body);

  if (maintenance) article.append(body);
  else { article.append(head); if (!readOnly) syncMessageUploadActions(head, message); }
  const trace = turnTraceNode(message.activityGroups, message);
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
  if (subagent) {
    if (actions) article.append(actions);
    return article;
  }
  if (!actions) return article;
  return el("div", { class: `msg-stack msg-stack-${role}` }, [article, actions]);
}

function subagentResponseTitle(message) {
  const firstLine = String(message?.text ?? "")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean)
    ?? "Ответ субагента";
  const title = firstLine
    .replace(/^#{1,6}\s+/u, "")
    .replace(/^[-*+]\s+/u, "")
    .replace(/^(?:\*\*|__)(.*)(?:\*\*|__)$/u, "$1")
    .trim()
    || "Ответ субагента";
  return title.length > 120 ? `${title.slice(0, 117).trimEnd()}…` : title;
}

document.addEventListener("click", (event) => {
  const responseAnnotation = event.target.closest("button[data-response-annotation-source]");
  if (responseAnnotation) {
    event.preventDefault();
    void focusResponseCitationSource(responseAnnotation);
    return;
  }
  const responseCitation = event.target.closest("button[data-response-citation-target]");
  if (responseCitation) {
    event.preventDefault();
    void focusResponseCitation(responseCitation);
    return;
  }
  const resourceActionButton = event.target.closest("button[data-agent-hub-resource-action][data-agent-hub-local-link]");
  if (resourceActionButton) {
    event.preventDefault();
    event.stopPropagation();
    emit(`resource:${resourceActionButton.dataset.agentHubResourceAction}`, {
      resource: resourceInteractions.linkResource({
        href: resourceActionButton.dataset.agentHubResourceHref,
        localPath: resourceActionButton.dataset.agentHubLocalLink,
        name: resourceActionButton.dataset.agentHubResourceName,
      }),
    });
    return;
  }
  const taskReferenceLink = event.target.closest("a[data-agent-hub-task-reference]");
  if (taskReferenceLink) {
    event.preventDefault();
    TaskReferences.open({ taskId: taskReferenceLink.dataset.agentHubTaskReference });
    return;
  }
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
    const control = MessageView.responseAnnotationCardControl(item);
    const content = el(control.tagName, {
      class: "msg-annotation-content",
      tabIndex: -1,
      "data-response-annotation-index": String(index + 1),
      ...(control.interactive ? {
        type: "button",
        tabIndex: 0,
        "data-response-annotation-source": "",
        title: "Перейти к исходному фрагменту",
      } : {}),
    }, [
      el("div", { class: "msg-annotation-label", text: `Цитата ${index + 1}` }),
      text ? el("div", { class: "msg-annotation-quote", text }) : null,
    ]);
    if (comment) {
      const commentNode = el("div", { class: "msg-annotation-comment" });
      renderMarkdown(commentNode, comment, undefined, "user");
      content.append(commentNode);
    }
    if (control.interactive) {
      responseCitationSources.set(content, { source: control.source, quote: text });
    }
    annotations.append(content);
  });
  if (!annotations.childElementCount) return false;
  body.append(annotations);
  const request = String(message.responseAnnotationRequest ?? message.text ?? "").trim();
  if (request) {
    const requestNode = el("div", { class: "msg-annotation-request" });
    renderMarkdown(requestNode, request, undefined, "user");
    body.append(requestNode);
  }
  return true;
}

function renderResponseCitations(message) {
  const citations = Array.isArray(message?.responseCitationPresentations)
    ? message.responseCitationPresentations
    : [];
  if (!citations.length) return null;
  return el("div", { class: "msg-response-citations", "aria-label": "Цитаты ответа" }, citations.map((citation) => {
    const control = MessageView.responseCitationControl(citation);
    const node = el(control.tagName, {
      class: control.className,
      ...(control.interactive ? {
        type: "button",
        "data-response-citation-index": String(control.index),
        "data-response-citation-target": control.targetMessageKey,
        title: control.quote ? `Перейти к цитате: ${control.quote}` : "Перейти к цитате",
      } : {}),
    }, [
      el("span", { class: "msg-response-citation-label", text: control.label }),
      control.quote
        ? el("span", { class: "msg-response-citation-quote", text: control.quote })
        : null,
    ]);
    return node;
  }));
}

function renderAgentResponseBody(body, message, text, fileContext) {
  const references = message.responseAnnotationReferences ?? [];
  const visibleText = MessageView.withoutResponseCitationFallbacks(text, references);
  const content = el("div", { class: "msg-response-content" });
  renderMarkdown(content, visibleText, fileContext, "agent");
  body.replaceChildren(renderResponseCitations(message), content);
}

function focusResponseAnnotationCard(button) {
  const targetKey = String(button?.dataset?.responseCitationTarget ?? "");
  const index = String(button?.dataset?.responseCitationIndex ?? "");
  if (!targetKey || !index) return false;
  const root = Array.from(chatLog.children).find((node) => node.dataset?.messageKey === targetKey);
  const target = root?.querySelector?.(
    `.msg-annotation-content[data-response-annotation-index="${index}"]`,
  );
  if (!target) return false;
  const article = target.closest(".msg-user");
  const body = article?.querySelector(".msg-body[data-user-message-disclosure]");
  if (body?.classList.contains("is-collapsed")) {
    const id = messageDisclosureId(article);
    if (id) expandedUserMessageIds.add(id);
    body.classList.remove("is-collapsed");
    updateUserMessageDisclosure(article);
  }
  target.classList.remove("is-citation-target");
  window.requestAnimationFrame(() => {
    target.classList.add("is-citation-target");
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.focus({ preventScroll: true });
    window.setTimeout(() => target.classList.remove("is-citation-target"), 1800);
  });
  return true;
}

function selectedResponseAnnotationSourceMessages() {
  const messages = state.messages.get(state.selectedId) ?? [];
  const live = state.live.get(state.selectedId);
  return responseAnnotationSourceMessages(
    messages,
    liveCardHasContent(live) ? { ...live, role: "agent" } : null,
  );
}

function sourceMessageProjection(source) {
  return responseAnnotationSourceProjection(selectedResponseAnnotationSourceMessages(), source);
}

function renderedResponseAnnotationSourceRoot(renderedKey) {
  const historyRoot = Array.from(chatLog.children).find((node) => node.dataset?.messageKey === renderedKey);
  if (historyRoot) return historyRoot;
  return chatLive.dataset?.messageKey === renderedKey ? chatLive : null;
}

function revealResponseCitationSource(article, surface) {
  for (let node = surface; node && node !== article.parentElement; node = node.parentElement) {
    if (node.tagName === "DETAILS") node.open = true;
    if (node === article) break;
  }
}

function materializeDeferredCitationSource(article, surfaceKind) {
  if (!article || surfaceKind !== "message-body") return;
  const body = article.querySelector(".msg-body[data-deferred-message-body]");
  if (!body || !deferredUserMessageBodyRenderers.has(body)) return;
  const disclosure = article.querySelector("[data-message-disclosure]");
  if (body.classList.contains("is-collapsed") && disclosure) disclosure.click();
  else syncDeferredUserMessageBody(body, true);
}

async function focusResponseCitationSource(button) {
  const target = responseCitationSources.get(button);
  const source = normalizedResponseAnnotationSource(target?.source);
  if (!source) return false;
  let projection = sourceMessageProjection(source);
  if (!projection) return false;
  const renderedKey = MessageView.messageKey(projection.message, projection.index);
  const rootNode = renderedResponseAnnotationSourceRoot(renderedKey);
  const article = rootNode?.matches?.("article.msg, details.msg")
    ? rootNode
    : rootNode?.querySelector?.("article.msg, details.msg");
  materializeDeferredCitationSource(article, source.surfaceKind);
  if (article && source.surfaceKind === "trace-reasoning") {
    for (const details of article.querySelectorAll("details.turn-trace")) {
      details.open = true;
      syncDeferredDisclosure(details);
    }
  }
  if (source.traceGroupId && article) {
    let surface = responseAnnotationSourceSurface(article, source);
    let group = surface && traceDetailSources.get(surface);
    if (!group) {
      try {
        const page = await requestTracePage(projection.message, { turnId: source.turnId, groupId: source.traceGroupId });
        if (!article.isConnected) return false;
        group = page.groups[0];
        const candidate = { ...projection.message, activityGroups: [group] };
        if (await responseAnnotationSha256(responseAnnotationSourceContent(candidate, source)) !== source.contentHash) return false;
        article.querySelector("[data-citation-trace]")?.remove();
        const target = el("section", { "data-citation-trace": "" }, [traceReasoningNode(group)]);
        article.append(target);
      } catch { return false; }
    }
    projection = { ...projection, message: { ...projection.message, activityGroups: [group] } };
  }
  const surface = responseAnnotationSourceSurface(article, source);
  if (!article || !surface) return false;
  const range = domRangeFromOffsets(surface, source.start, source.end);
  if (!range) return false;
  const [contentHash, surfaceHash, selectionHash] = await Promise.all([
    responseAnnotationSha256(responseAnnotationSourceContent(projection.message, source)),
    responseAnnotationSha256(surface.textContent),
    responseAnnotationSha256(range.toString().trim()),
  ]);
  if (!responseAnnotationSourceHashesMatch(source, { contentHash, surfaceHash, selectionHash })) return false;
  activeSourceCitationCleanup?.();
  const highlight = highlightResponseAnnotationRange(surface, source.start, source.end);
  if (!highlight) return false;
  const previousTabIndex = surface.getAttribute("tabindex");
  const previousLabel = surface.getAttribute("aria-label");
  surface.tabIndex = -1;
  surface.dataset.responseCitationSourceFocus = "";
  surface.setAttribute("aria-label", `Цитируемый фрагмент: ${target.quote}`);
  revealResponseCitationSource(article, surface);
  highlight.first.scrollIntoView({ behavior: "smooth", block: "center" });
  surface.focus({ preventScroll: true });
  let timeout = 0;
  const cleanup = () => {
    if (timeout) window.clearTimeout(timeout);
    highlight.cleanup();
    if (previousTabIndex == null) surface.removeAttribute("tabindex");
    else surface.setAttribute("tabindex", previousTabIndex);
    if (previousLabel == null) surface.removeAttribute("aria-label");
    else surface.setAttribute("aria-label", previousLabel);
    delete surface.dataset.responseCitationSourceFocus;
    if (activeSourceCitationCleanup === cleanup) activeSourceCitationCleanup = null;
  };
  activeSourceCitationCleanup = cleanup;
  timeout = window.setTimeout(cleanup, 1_800);
  return true;
}

function focusResponseCitation(button) {
  return focusResponseAnnotationCard(button);
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
    || (Array.isArray(live.attachments) && live.attachments.length)
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
  const durationNode = node.querySelector("[data-live-turn-duration]");
  if (durationNode) {
    const startedAt = String(live.turnStartedAt ?? "").trim();
    if (startedAt) durationNode.dataset.turnStartedAt = startedAt;
    else delete durationNode.dataset.turnStartedAt;
    const durationLabel = MessageView.turnDurationLabel(startedAt, Date.now());
    durationNode.textContent = durationLabel;
    durationNode.hidden = !durationLabel;
  }
  const groups = visibleTurnTraceGroups(live.activityGroups);
  const stageDetail = node.querySelector("[data-live-stage-detail]");
  const standaloneStageDetail = standaloneLiveStageDetail({ stage: live.stage, traceGroups: groups });
  stageDetail.textContent = standaloneStageDetail;
  stageDetail.hidden = !standaloneStageDetail;
  const reasoning = node.querySelector("[data-live-reasoning]");
  const standaloneReasoning = groups.length ? "" : live.reasoning || "";
  const fileContext = currentFileLinkContext(task);
  const activities = Array.isArray(live.activities) ? live.activities : [];
  const historyMessages = state.messages.get(state.selectedId) ?? [];
  const liveMessage = {
    ...live,
    role: "agent",
    responseCitationPresentations: MessageView.responseCitationPresentations(
      [...historyMessages, { ...live, role: "agent" }],
      historyMessages.length,
    ),
  };
  node.dataset.messageKey = MessageView.messageKey(liveMessage, historyMessages.length);
  const renderParts = window.AgentHubLiveCardRender.liveCardRenderParts({
    visibleText,
    standaloneReasoning,
    traceGroups: groups,
    activities,
    stageDetail: liveStage.detail,
    fileContext,
    bodyState: liveMessage.responseCitationPresentations,
  });
  liveCardRenderController.reconcile(node, "reasoning", renderParts.reasoning, () => {
    renderMarkdown(reasoning, standaloneReasoning, fileContext);
  });
  reasoning.hidden = !standaloneReasoning;
  const liveTrace = node.querySelector("[data-live-trace]");
  liveCardRenderController.reconcile(node, "trace", renderParts.trace, () => {
    const openGroupIds = new Set(Array.from(
      liveTrace.querySelectorAll("details[data-trace-group-id][open]"),
      (details) => details.dataset.traceGroupId,
    ));
    liveTrace.replaceChildren(...(groups.length ? [turnTraceGroupsNode(groups, {
      liveStage: liveStage.detail,
      openGroupIds,
      identity: liveMessage,
    })] : []));
  });
  liveCardRenderController.reconcile(node, "trace-summary", renderParts.traceSummary, () => {
    const summary = liveTrace.querySelector(
      `details[data-trace-group-id="${TURN_TRACE_ACTIVITY_GROUP_ID}"] > summary`,
    );
    if (summary) renderActivityDisclosureSummary(summary, {
      count: renderParts.traceSummary.count,
      stage: renderParts.traceSummary.stageDetail,
    });
  });
  liveTrace.hidden = groups.length === 0;
  const body = node.querySelector("[data-live-body]");
  liveCardRenderController.reconcile(node, "body", renderParts.body, () => {
    if (liveMessage.responseCitationPresentations.length) {
      renderAgentResponseBody(body, liveMessage, visibleText, fileContext);
    } else renderMarkdown(body, visibleText, fileContext);
  });
  body.hidden = !visibleText && liveMessage.responseCitationPresentations.length === 0;
  const attachmentStrip = node.querySelector("[data-live-attachments]");
  const liveAttachments = Array.isArray(liveMessage.attachments) ? liveMessage.attachments : [];
  if (attachmentStrip) {
    liveCardRenderController.reconcile(node, "attachments", liveAttachments, () => {
      attachmentStrip.replaceChildren(...(liveAttachments.length
        ? [renderAttachmentStrip(liveAttachments, { readOnly: true })]
        : []));
    });
    attachmentStrip.hidden = liveAttachments.length === 0;
  }
  const activityFeed = node.querySelector("[data-activity-feed]");
  liveCardRenderController.reconcile(node, "activity-feed", renderParts.activityFeed, () => {
    activityFeed.open = liveActivityDisclosureOpen({
      open: activityFeed.open,
      wasHidden: activityFeed.hidden,
      visible: renderParts.activityFeed.visible,
    });
    activityFeed.hidden = !renderParts.activityFeed.visible;
    const activityList = node.querySelector("[data-activity-list]");
    configureDeferredDisclosure(activityFeed, activityList, (target) => {
      target.replaceChildren(...renderParts.activityFeed.activities.map(activityItemNode));
    });
  });
  liveCardRenderController.reconcile(node, "activity-feed-summary", renderParts.activityFeedSummary, () => {
    renderActivityDisclosureSummary(node.querySelector("[data-activity-summary]"), {
      label: "Выполненные действия",
      count: renderParts.activityFeedSummary.count,
      stage: renderParts.activityFeedSummary.stageDetail,
    });
  });
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
  window.AgentHubApprovalForm.reconcileApprovals(approvalsBox, approvals, (approval) => {
    const asyncQuestion = approval.kind === "async-user-input";
    const frozen = asyncQuestion && approval.state === "dispatching";
    const questions = Array.isArray(approval.questions) ? approval.questions : [];
    const options = Array.isArray(approval.options)
      ? approval.options
      : [{ id: "approve", label: "Разрешить", kind: "primary" }, { id: "deny", label: "Отклонить" }];
    const questionFields = questions.map((question, index) => {
      const questionId = String(question.id ?? `question-${index}`);
      const choices = Array.isArray(question.options) ? question.options : [];
      const frozenAnswer = frozen ? String(approval.answers?.[questionId]?.[0] ?? "") : "";
      const field = el("fieldset", {
        class: "approval-question",
        "data-approval-question": questionId,
        "data-question-kind": choices.length ? "options" : "text",
        disabled: frozen,
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
            checked: frozen ? frozenAnswer === choice.label : !asyncQuestion && choiceIndex === 0,
          }),
          el("span", {}, [
            el("strong", { text: choice.label }),
            choice.description ? el("small", { text: choice.description }) : null,
          ]),
        ])));
      }
      if (!choices.length || question.isOther || asyncQuestion) {
        field.append(el("input", {
          class: "approval-input",
          type: question.isSecret ? "password" : "text",
          "data-approval-other": "",
          placeholder: choices.length ? "Другой ответ" : "Ваш ответ",
          autocomplete: question.isSecret ? "off" : "on",
          value: frozen && !choices.some((choice) => choice.label === frozenAnswer) ? frozenAnswer : "",
        }));
      }
      return field;
    });
    return el("div", { class: "approval", "data-approval-id": approval.id }, [
      el("div", { class: "approval-head" }, [
        el("span", { class: "approval-kind", text: asyncQuestion ? "Вопрос агента" : approval.kind || "Подтверждение" }),
      ]),
      el("div", { class: "approval-text", text: approval.text || "" }),
      ...questionFields,
      frozen ? el("div", { class: "approval-text", text: "Ответ сохранён. Доставка уточняется; повтор отправит тот же ответ." }) : null,
      el("div", { class: "approval-actions" }, options.map((option) => {
        const attributes = {
          class: `chip-button ${option.kind === "primary" ? "primary" : option.kind === "danger" ? "danger" : ""}`,
          "data-action": "approval-respond",
          "data-approval-id": approval.id,
          "data-decision": option.id,
          text: option.label,
        };
        return option.href
          ? el("a", { ...attributes, href: option.href, target: "_blank", rel: "noopener noreferrer" })
          : el("button", { ...attributes, type: "button" });
      }).concat(questions.length ? [el("button", {
          type: "button",
          class: "chip-button primary",
          "data-action": "approval-submit",
          "data-approval-id": approval.id,
          text: frozen ? "Повторить отправку" : "Ответить",
        })] : [])),
    ]);
  });
}

function renderQueueForTask(taskId, container) {
  const queued = (state.queue.get(taskId) ?? [])
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
  const queueCounts = MessageView.deferredQueueCounts(queued);
  const counts = [
    queueCounts.pending ? `Требуют решения: ${queueCounts.pending}` : "",
    queueCounts.starting ? `Запускается: ${queueCounts.starting}` : "",
    queueCounts.queued ? `В очереди: ${queueCounts.queued}` : "",
    queueCounts.paused ? `На паузе: ${queueCounts.paused}` : "",
  ].filter(Boolean).join(" · ");
  container.append(el("div", { class: "queue-head", text: counts }));
  const task = state.tasks.find((entry) => entry.id === taskId);
  const movable = queued.filter((entry) => !entry.optimistic && ["queued", "paused"].includes(entry.state));
  for (const entry of queued) {
    const actions = [];
    if (entry.optimistic) {
      actions.push(el("span", {
        class: "queue-optimistic",
        text: String(entry.delivery ?? "").trim() || "Ожидает подтверждения Hub…",
      }));
      if (entry.uploadState) {
        for (const action of entry.uploadState === "paused" ? ["resume", "cancel"] : ["cancel"]) {
          const button = el("button", {
            type: "button", class: "queue-accept", [`data-upload-${action}`]: "",
            text: action === "resume" ? "Продолжить загрузку" : "Отменить отправку",
          });
          button.addEventListener("click", () => emit(`message:upload-${action}`, {
            taskId, clientUserMessageId: entry.clientUserMessageId,
          }));
          actions.push(button);
        }
      }
      if (entry.admissionRetryAvailable) {
        const retry = el("button", {
          type: "button", class: "queue-accept", "data-message-retry-unconfirmed": "",
          text: "Повторить отправку",
          title: "Повторить исходный запрос с тем же идентификатором; приём Hub пока не подтверждён",
        });
        retry.addEventListener("click", () => emit("message:retry-unconfirmed", {
          taskId, clientUserMessageId: entry.clientUserMessageId,
        }));
        actions.push(retry);
      }
    } else {
      const steerAvailable = Boolean(task?.running && ["codex", "claude"].includes(String(task?.provider ?? "")));
      const exactSteerDecision = entry.state === "pending"
        && entry.attentionRequired === true
        && entry.conflictKind === "message-steer";
      if (!exactSteerDecision) {
        actions.push(el("button", {
          type: "button",
          class: "queue-steer",
          "data-action": "queue-steer",
          "data-queue-id": entry.id,
          title: steerAvailable
            ? (task.provider === "claude"
              ? "Прервать текущий ход и продолжить его этим сообщением"
              : "Добавить это сообщение в текущий ход")
            : "Доступно, пока эта задача выполняет ход",
          disabled: !steerAvailable,
          text: "В текущий ход",
        }));
      }
      actions.push(el("button", {
        type: "button",
        class: "queue-edit",
        "data-action": "queue-edit",
        "data-queue-id": entry.id,
        title: "Вернуть весь исходный черновик в основной композер",
        text: "Изменить",
      }));
      if (["queued", "paused"].includes(entry.state)) {
        const movableIndex = movable.findIndex((candidate) => candidate.id === entry.id);
        actions.push(el("button", {
          type: "button",
          class: "queue-move",
          "data-action": "queue-move",
          "data-direction": "up",
          "data-queue-id": entry.id,
          title: "Поднять сообщение в очереди",
          "aria-label": "Поднять сообщение в очереди",
          disabled: movableIndex <= 0,
          text: "↑",
        }));
        actions.push(el("button", {
          type: "button",
          class: "queue-move",
          "data-action": "queue-move",
          "data-direction": "down",
          "data-queue-id": entry.id,
          title: "Опустить сообщение в очереди",
          "aria-label": "Опустить сообщение в очереди",
          disabled: movableIndex < 0 || movableIndex >= movable.length - 1,
          text: "↓",
        }));
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
        if (entry.lastError) {
          actions.push(el("button", {
            type: "button",
            class: "queue-accept",
            "data-action": "queue-retry",
            "data-queue-id": entry.id,
            title: "Повторить доставку в исходный ход с тем же идентификатором",
            text: "Повторить",
          }));
        }
        if (!entry.lastError || entry.queueAfterTurnAvailable === true) {
          actions.push(el("button", {
            type: "button",
            class: "queue-accept",
            "data-action": "queue-accept",
            "data-queue-id": entry.id,
            title: "Явно разрешить отправку после завершения текущего хода",
            text: "После хода",
          }));
        }
      }
      actions.push(el("button", {
        type: "button", class: "queue-remove", "data-action": "queue-remove", "data-queue-id": entry.id,
        title: "Отменить отложенное сообщение", "aria-label": "Отменить отложенное сообщение", text: "Отменить",
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
  saveDraft({ userEdited: true });
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
    || currentTaskReferences().length > 0
    || currentAnnotations().length > 0;
  const preparing = currentAttachmentPreviews().length > 0;
  composerSend.disabled = !draftFilled || !state.selectedId || Boolean(pendingComposerRequest) || preparing;
  composerQuickMessages?.querySelectorAll("button").forEach((button) => {
    button.disabled = !state.selectedId || Boolean(pendingComposerRequest) || preparing;
  });
}

composerInput.addEventListener("input", () => {
  autosizeComposer();
  updateSendState();
  saveDraft({ userEdited: true });
  slashSelection = 0;
  renderSlashMenu();
});

composerQuickMessages?.addEventListener("pointerdown", (event) => {
  if (event.target.closest("[data-quick-message-index]")) event.preventDefault();
});

composerQuickMessages?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quick-message-index]");
  if (!button || button.disabled) return;
  const entry = button.__agentHubQuickMessage;
  if (quickMessageAction(quickMessageActionMode(), event.ctrlKey) === "send") submitQuickMessage(entry);
  else insertQuickMessage(entry);
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

function sendComposerRequest({
  rawText,
  attachments: requestAttachments = [],
  taskReferences: requestTaskReferences = [],
  annotations: requestAnnotations = [],
  messageOrigin: requestMessageOrigin = null,
  composerTransfer: requestComposerTransfer = null,
  steerWhileRunning = false,
  clearComposer = false,
  restoreOnReject = false,
} = {}) {
  if (!state.selectedId || pendingComposerRequest) return;
  if (currentAttachmentPreviews().length) {
    showToast("Вложения ещё готовятся. Дождись подготовки или удали их перед отправкой.");
    return;
  }
  const submittedAtMs = Date.now();
  const submittedMonotonicMs = performance.now();
  const task = currentTask();
  const text = String(rawText ?? "").trim();
  const payloadAttachments = requestAttachments.slice();
  const payloadTaskReferences = requestTaskReferences.slice();
  const payloadAnnotations = requestAnnotations.slice();
  if (!text
    && payloadAttachments.length === 0
    && payloadTaskReferences.length === 0
    && payloadAnnotations.length === 0) return;
  const fingerprint = window.AgentHubComposerDraftReconciliation.recoveryFingerprint({
    taskId: state.selectedId,
    rawText,
    attachments: payloadAttachments,
    taskReferences: payloadTaskReferences,
    annotations: payloadAnnotations,
    messageOrigin: requestMessageOrigin,
    composerTransfer: requestComposerTransfer,
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
    attachments: payloadAttachments,
    taskReferences: payloadTaskReferences,
    annotations: payloadAnnotations,
    messageOrigin: requestMessageOrigin,
    composerTransfer: requestComposerTransfer,
    restoreOnReject,
    editRevision: composerDraftReconciliation.revision(state.selectedId),
  };
  if (clearComposer) {
    // Sending is itself a composition boundary. A FileReader or annotation
    // hash that started from the pre-send draft must not reapply that draft
    // after the accepted send has cleared it.
    advanceComposerAsyncOperationFence(state.selectedId);
    drafts.set(state.selectedId, { text: "", attachments: [], taskReferences: [], annotations: [] });
    composerInput.value = "";
    setAttachments([]);
    setTaskReferences([]);
    setAnnotations([]);
    autosizeComposer();
  }
  emit("message:send", {
    requestId,
    submittedAtMs,
    submittedMonotonicMs,
    taskId: state.selectedId,
    text,
    annotations: payloadAnnotations,
    attachments: payloadAttachments,
    taskReferences: payloadTaskReferences,
    messageOrigin: requestMessageOrigin,
    composerTransfer: requestComposerTransfer,
    followUpMode: MessageView.composerFollowUpMode(task, { steerWhileRunning }),
    deferWhileRunning: task?.running === true && !steerWhileRunning,
    draftStream: task?.draftStream === true,
    streamId: task?.streamId ?? null,
    settings: task?.draftStream ? { ...task.streamSettings } : null,
  });
  updateSendState();
  if (clearComposer) saveDraft();
  return true;
}

function submitComposer({ steerWhileRunning = false } = {}) {
  return sendComposerRequest({
    rawText: composerInput.value,
    attachments: currentAttachments(),
    taskReferences: currentTaskReferences(),
    annotations: currentAnnotations(),
    messageOrigin: drafts.get(state.selectedId)?.messageOrigin ?? null,
    composerTransfer: drafts.get(state.selectedId)?.composerTransfer ?? null,
    steerWhileRunning,
    clearComposer: true,
    restoreOnReject: true,
  });
}

function submitQuickMessage(entry) {
  if (!entry?.text) return;
  const sent = sendComposerRequest({
    rawText: entry.text,
    clearComposer: false,
    restoreOnReject: false,
  });
  if (sent) showToast(`Отправлено: ${entry.title}`);
}

function insertTextAtCaret(input, text) {
  if (!input || !text) return false;
  const start = Number.isSafeInteger(input.selectionStart) ? input.selectionStart : input.value.length;
  input.setRangeText(text, start, start, "end");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus({ preventScroll: true });
  return true;
}

function insertQuickMessage(entry) {
  const text = String(entry?.text ?? "");
  if (!text) return;
  const activeComment = document.activeElement?.closest?.("[data-annotation-comment-index]");
  if (activeComment && annotationsBox.contains(activeComment)) {
    insertTextAtCaret(activeComment, text);
    return;
  }
  insertTextAtCaret(composerInput, text);
}

function completeComposerSend(requestId, { outcome = "unknown", taskId = "" } = {}) {
  const pending = pendingComposerRequest;
  const completion = composerDraftReconciliation.complete({
    pending,
    requestId,
    taskId,
    outcome,
  });
  pendingComposerRequest = completion.pending;
  updateSendState();
  return completion;
}

function normalizedRecoveryAttachments(value) {
  return window.AgentHubComposerDraftReconciliation.recoveryAttachments(value, {
    maxCount: DRAFT_RECOVERY_MAX_ATTACHMENTS,
    maxDataUrlCharacters: DRAFT_RECOVERY_MAX_ATTACHMENT_CHARS,
    maxBytes: DRAFT_ATTACHMENT_MAX_BYTES,
    maxTotalBytes: DRAFT_ATTACHMENT_MAX_TOTAL_BYTES,
  });
}

/* ---- вложения: локальные Blob-превью и опубликованные ссылки ---- */

let attachments = [];
let taskReferences = [];
const attachmentOperationSequences = new Map();
let pendingAttachmentPreparations = 0;
// Transient selection projection only: never persisted or used as send payload.
const attachmentPreparationPreviews = new Set();

function currentAttachmentPreviews(taskId = state.selectedId) {
  return [...attachmentPreparationPreviews].filter((entry) => entry.operation.taskId === taskId)
    .flatMap((entry) => entry.items);
}

function disposeAttachmentPreview(entry) {
  if (!attachmentPreparationPreviews.delete(entry)) return;
  for (const item of entry.items) if (item.url) URL.revokeObjectURL(item.url);
}

function discardAttachmentPreviews(taskId) {
  for (const entry of attachmentPreparationPreviews) {
    if (entry.operation.taskId === taskId) disposeAttachmentPreview(entry);
  }
  if (state.selectedId === taskId) {
    renderAttachments();
    updateSendState();
  }
}

function currentAttachments() {
  return attachments;
}

function setAttachments(next) {
  attachments = next;
  renderAttachments();
  updateSendState();
}

function currentTaskReferences() {
  return taskReferences;
}

function setTaskReferences(next) {
  taskReferences = (Array.isArray(next) ? next : [])
    .map((reference) => TaskReferences.normalize(reference))
    .filter(Boolean);
  renderAttachments();
  updateSendState();
}

function renderAttachments() {
  attachmentsBox.replaceChildren();
  const previews = currentAttachmentPreviews();
  attachmentsBox.hidden = attachments.length === 0 && taskReferences.length === 0 && previews.length === 0;
  if (taskReferences.length) {
    attachmentsBox.append(renderAttachmentStrip(taskReferences, {
      readOnly: false,
      taskReferenceList: true,
    }));
  }
  if (attachments.length) attachmentsBox.append(renderAttachmentStrip(attachments, { readOnly: false }));
  if (previews.length) {
    const strip = el("div", { class: "attachment-strip" });
    for (const item of previews) {
      strip.append(el("div", {
        class: `attachment attachment-preparing${item.url ? " attachment-image" : " attachment-file"}`,
        "data-attachment-preparing": "", "aria-busy": "true", title: item.name,
      }, [
        item.url ? el("img", { src: item.url, alt: item.name })
          : el("span", { class: "attachment-file-card", text: item.name }),
        el("span", { class: "attachment-preparing-label", role: "status", text: "Подготовка…" }),
        el("button", {
          type: "button", class: "attachment-remove", "data-attachment-preparation-remove": "",
          title: "Отменить подготовку вложений", "aria-label": "Отменить подготовку вложений", text: "×",
        }),
      ]));
    }
    attachmentsBox.append(strip);
  }
}

const attachmentThumbnailObserver = typeof window.IntersectionObserver === "function"
  ? new window.IntersectionObserver((entries, observer) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      entry.target.__agentHubLoadThumbnail?.();
    }
  }, { rootMargin: "160px" })
  : null;

function observeAttachmentThumbnail(node, item) {
  const load = () => {
    if (!node.isConnected) return;
    emit("attachment:thumbnail", {
      attachment: item,
      render: (source) => {
        if (!node.isConnected || !source) return;
        node.classList.remove("attachment-loading");
        node.replaceChildren(el("img", {
          src: source,
          alt: item.name || "вложение",
          loading: "lazy",
        }));
      },
      fail: ({ missing = false } = {}) => {
        if (!node.isConnected) return;
        node.classList.remove("attachment-loading");
        if (missing) {
          node.classList.remove("attachment-open");
          node.classList.add("attachment-missing");
          node.disabled = true;
          node.title = "Файл недоступен";
          node.setAttribute("aria-label", `${item.name || "Файл"} недоступен`);
        }
        node.replaceChildren(el("span", {
          class: missing ? "attachment-missing-label" : "attachment-load-label",
          text: missing ? "Файл недоступен" : "Открыть",
        }));
      },
    });
  };
  node.__agentHubLoadThumbnail = load;
  if (attachmentThumbnailObserver) attachmentThumbnailObserver.observe(node);
  else window.queueMicrotask(load);
}

function renderAttachmentStrip(items, { readOnly, taskReferenceList = false }) {
  const strip = el("div", { class: "attachment-strip" });
  const gallery = resourceInteractions.imageGallery(items);
  items.forEach((item, index) => {
    if (TaskReferences.isTaskReference(item)) {
      const reference = TaskReferences.normalize(item);
      const presentation = TaskReferences.presentation(reference);
      const status = ({
        new: "New",
        in_progress: "InProg",
        blocked: "Blocked",
        testing: "Test",
        awaiting_implementation: "Await",
        done: "Done",
      })[reference.workflowStatus] ?? "New";
      const card = el(readOnly ? "button" : "div", {
        class: "attachment attachment-task-reference",
        title: reference.title,
        ...(readOnly ? { type: "button" } : {}),
      }, [el("span", { class: "attachment-task-card" }, [
        el("span", { class: "attachment-file-type", text: presentation.badge }),
        el("span", { class: "attachment-task-copy" }, [
          el("span", { class: "attachment-file-name", text: presentation.title }),
          el("span", { class: "attachment-task-status", text: status }),
        ]),
      ])]);
      if (readOnly) {
        card.addEventListener("click", () => document.dispatchEvent(new CustomEvent(
          "agenthub:task-reference-open",
          { detail: { taskId: reference.taskId } },
        )));
      } else {
        card.append(el("button", {
          type: "button",
          class: "attachment-remove",
          "data-task-reference-index": taskReferenceList ? index : null,
          title: "Убрать Task из сообщения",
          "aria-label": "Убрать Task из сообщения",
          text: "×",
        }));
      }
      strip.append(card);
      return;
    }
    const source = item.dataUrl || item.thumbnailUrl || item.url || "";
    const image = resourceInteractions.isImageAttachment(item);
    const missing = readOnly && (item.missing || (!source && !item.id));
    const thumb = el(readOnly ? "button" : "div", {
      class: `attachment${image ? " attachment-image" : " attachment-file"}${!missing && (readOnly || image) ? " attachment-open" : ""}${missing ? " attachment-missing" : ""}${readOnly && image && !source && item.id ? " attachment-loading" : ""}`,
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
          ? [el("span", {
            class: "attachment-load-label",
            text: readOnly && item.id ? "Загрузка" : "Открыть",
          })]
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
    if (readOnly && image && !source && item.id && !missing) observeAttachmentThumbnail(thumb, item);
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
  if (event.target.closest("[data-attachment-preparation-remove]")) {
    advanceComposerAsyncOperationFence(state.selectedId);
    return;
  }
  const taskReferenceRemove = event.target.closest("[data-task-reference-index]");
  if (taskReferenceRemove) {
    const index = Number(taskReferenceRemove.dataset.taskReferenceIndex);
    setTaskReferences(taskReferences.filter((_, itemIndex) => itemIndex !== index));
    saveDraft({ userEdited: true });
    return;
  }
  const remove = event.target.closest("[data-attachment-index]");
  if (!remove) return;
  const index = Number(remove.dataset.attachmentIndex);
  advanceComposerAsyncOperationFence(state.selectedId);
  setAttachments(attachments.filter((_, i) => i !== index));
  saveDraft({ userEdited: true });
});

async function readAttachmentFiles(files) {
  const operation = captureComposerTaskOperation();
  if (!operation) return;
  const initialDraft = composerDraftSnapshot(operation.taskId);
  const selected = [...files].filter((file) => (
    file && Number.isSafeInteger(file.size) && file.size > 0
  ));
  if (selected.length === 0) return;
  // Selection prepares a local draft, not an upload. Network negotiation belongs
  // to sending; it must not make clipboard bytes wait for the server.
  const operationSequence = attachmentOperationSequences.get(operation.taskId) ?? 0;
  const policy = { maxBytes: DRAFT_ATTACHMENT_MAX_BYTES, maxTotalBytes: DRAFT_ATTACHMENT_MAX_TOTAL_BYTES };
  const limit = 8;
  const reserved = [...initialDraft.attachments, ...currentAttachmentPreviews(operation.taskId)];
  const room = Math.max(0, limit - reserved.length);
  const existingBytes = reserved.reduce((sum, item) => sum + (Number(item?.size) || 0), 0);
  let remainingBytes = Math.max(0, policy.maxTotalBytes - existingBytes);
  let oversized = 0;
  let unsafe = 0;
  const accepted = [];
  for (const file of selected.slice(0, room)) {
    const metadata = window.AgentHubComposerDraftReconciliation.safeAttachmentMetadata({
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
    }, { maxBytes: Math.min(policy.maxBytes, DRAFT_ATTACHMENT_MAX_BYTES) });
    if (!metadata) {
      unsafe += 1;
      continue;
    }
    if (file.size > remainingBytes) {
      oversized += 1;
      continue;
    }
    accepted.push(file);
    remainingBytes -= file.size;
  }
  if (accepted.length === 0) {
    if (room === 0 || selected.length > room) showToast(`Можно приложить не больше ${limit} файлов.`);
    else if (unsafe) showToast("Имя или тип файла небезопасны для отправки.");
    else if (oversized) showToast(`Общий лимит вложений: ${Math.floor(policy.maxTotalBytes / 1024 / 1024)} МБ.`);
    return;
  }
  pendingAttachmentPreparations += 1;
  const preview = { operation, items: accepted.map((file) => {
    let url = "";
    if (file.type.startsWith("image/")) {
      try { url = URL.createObjectURL(file); } catch { /* Preparation still owns file validation. */ }
    }
    return { name: file.name, size: file.size, url };
  }) };
  attachmentPreparationPreviews.add(preview);
  renderAttachments();
  updateSendState();
  let settled;
  try {
    settled = await Promise.allSettled(accepted.map((file) => window.AgentHubComposerFiles.prepare(file, {
      name: file.name,
      type: file.type || "application/octet-stream",
      size: file.size,
    })));
  } finally {
    pendingAttachmentPreparations -= 1;
    disposeAttachmentPreview(preview);
    renderAttachments();
    updateSendState();
  }
  const failed = settled.find((result) => result.status === "rejected");
  if (failed) {
    window.AgentHubComposerFiles.settle(settled.filter((result) => result.status === "fulfilled").map((result) => result.value));
    pruneComposerFiles();
    showToast(failed.reason?.message ?? "Не удалось прочитать вложение");
    return;
  }
  const loaded = settled.map((result) => result.value);
  const canonical = window.AgentHubComposerDraftReconciliation.recoveryAttachments(loaded, {
    maxCount: limit,
    maxBytes: DRAFT_ATTACHMENT_MAX_BYTES,
    maxTotalBytes: policy.maxTotalBytes - existingBytes,
  });
  if (!canonical) {
    window.AgentHubComposerFiles.settle(loaded);
    pruneComposerFiles();
    showToast("Вложение не прошло проверку целостности.");
    return;
  }
  if ((attachmentOperationSequences.get(operation.taskId) ?? 0) === operationSequence
    && composerTaskOperationCurrent(operation, { allowDraftEdits: true })) {
    // Independent pastes append to the current composition. Never replay the
    // pre-read text/attachments over edits or another completed paste.
    const current = composerDraftSnapshot(operation.taskId);
    let bytes = current.attachments.reduce((sum, item) => sum + (Number(item?.size) || 0), 0);
    const additions = [];
    for (const item of canonical) {
      if (current.attachments.length + additions.length >= limit) break;
      if (bytes + item.size > policy.maxTotalBytes) { oversized += 1; continue; }
      additions.push(item);
      bytes += item.size;
    }
    if (additions.length > 0) {
      composerDraftReconciliation.save(operation.taskId, {
        ...current,
        attachments: [...current.attachments, ...additions],
      }, { userEdited: true });
      if (state.selectedId === operation.taskId) restoreDraft();
    }
    if (additions.length < canonical.length && !oversized) showToast(`Можно приложить не больше ${limit} файлов.`);
  }
  window.AgentHubComposerFiles.settle(loaded);
  pruneComposerFiles();
  if (selected.length > room) showToast(`Можно приложить не больше ${limit} файлов.`);
  else if (unsafe) showToast("Часть файлов отклонена: небезопасное имя или тип.");
  else if (oversized) showToast(`Общий лимит вложений: ${Math.floor(policy.maxTotalBytes / 1024 / 1024)} МБ.`);
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

/* ---- аннотации к выделенному фрагменту сообщения или рассуждения ---- */

let annotations = [];
let pendingAnnotationSelection = null;
let lastAnnotationSelection = null;
let lastTouchSelectionAt = 0;
const annotationOperationSequences = new Map();
const TOUCH_CONTEXT_MENU_WINDOW_MS = 3_000;

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
        el("span", { class: "annotation-quote", tabindex: "0", text: annotation.quote }),
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
  saveDraft({ userEdited: true });
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
  saveDraft({ userEdited: true });
});

annotationsBox.addEventListener("keydown", (event) => {
  const input = event.target.closest("[data-annotation-comment-index]");
  if (!input || event.key !== "Enter" || event.isComposing) return;
  if (event.shiftKey || event.ctrlKey) {
    event.preventDefault();
    if (!event.repeat) insertTextAtCaret(input, "\n");
    return;
  }
  event.preventDefault();
  if (event.repeat || pendingComposerRequest) return;
  submitComposer({ steerWhileRunning: event.metaKey });
});

const QUOTABLE_SURFACE_SELECTOR = ".msg-body, .turn-trace-reasoning, .msg-reasoning";

function selectionBoundary(node) {
  const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
  const surface = element?.closest?.(QUOTABLE_SURFACE_SELECTOR) ?? null;
  return {
    message: surface?.closest?.("[data-role]") ?? null,
    surface,
  };
}

function intersectedQuotableSelection(range) {
  const commonElement = range.commonAncestorContainer?.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer
    : range.commonAncestorContainer?.parentElement;
  const containingMessage = commonElement?.closest?.("[data-role]") ?? null;
  const messages = containingMessage
    ? [containingMessage]
    : [...(commonElement?.querySelectorAll?.("[data-role]") ?? [])];
  const matches = [];
  for (const message of messages) {
    const surface = [...message.querySelectorAll(QUOTABLE_SURFACE_SELECTOR)]
      .find((candidate) => range.intersectsNode(candidate));
    if (surface) matches.push({ message, surface });
    if (matches.length > 1) return null;
  }
  return matches[0] ?? null;
}

function selectedQuotableSelection() {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start = selectionBoundary(range.startContainer);
  const end = selectionBoundary(range.endContainer);
  const intersected = intersectedQuotableSelection(range);
  const scope = quotableSelectionScope({
    startMessage: start.message,
    endMessage: end.message,
    intersectedMessage: intersected?.message,
    startSurface: start.surface,
    endSurface: end.surface,
    intersectedSurface: intersected?.surface,
  });
  if (!scope) return null;
  if (scope.startSurface !== scope.endSurface) return null;
  const offsets = domRangeOffsets(scope.startSurface, range);
  if (!offsets) return null;
  const exactRange = domRangeFromOffsets(scope.startSurface, offsets.start, offsets.end);
  const quote = quotableSelectionText({
    text: exactRange?.toString(),
    rangeCount: selection.rangeCount,
    startMessage: scope.message,
    endMessage: scope.message,
    startSurface: scope.startSurface,
    endSurface: scope.endSurface,
  });
  if (!quote) return null;
  return { quote, message: scope.message, surface: scope.startSurface, offsets };
}

function selectedQuotableSelectionAt(target) {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const boundary = selectionBoundary(target);
  if (!selection || !range || !boundary.message || !boundary.surface) return null;
  const offsets = domRangeOffsets(boundary.surface, range);
  if (!offsets) return null;
  const exactRange = domRangeFromOffsets(boundary.surface, offsets.start, offsets.end);
  const quote = quotableSelectionText({
    text: exactRange?.toString(),
    rangeCount: selection.rangeCount,
    startMessage: boundary.message,
    endMessage: boundary.message,
    startSurface: boundary.surface,
    endSurface: boundary.surface,
  });
  if (!quote) return null;
  return { quote, message: boundary.message, surface: boundary.surface, offsets };
}

function normalizedAnnotationQuote(value) {
  return String(value ?? "").trim();
}

function meaningfulAnnotationSelection(value) {
  return Boolean(String(value ?? "").trim());
}

document.addEventListener("selectionchange", () => {
  const rawSelection = window.getSelection()?.toString().trim() ?? "";
  const selection = selectedQuotableSelection();
  if (selection) {
    lastAnnotationSelection = selection;
  } else if (rawSelection) {
    lastAnnotationSelection = null;
  }
});

function sourceMessageForSelection(selection) {
  let renderedRoot = selection?.message ?? null;
  while (renderedRoot && renderedRoot !== chatLive && renderedRoot.parentElement !== chatLog) {
    renderedRoot = renderedRoot.parentElement;
  }
  const renderedKey = String(renderedRoot?.dataset?.messageKey ?? "");
  if (!renderedKey) return null;
  const messages = selectedResponseAnnotationSourceMessages();
  const index = messages.findIndex((message, messageIndex) => (
    MessageView.messageKey(message, messageIndex) === renderedKey
  ));
  if (index < 0) return null;
  const group = traceDetailSources.get(selection.surface);
  return { message: group ? { ...messages[index], activityGroups: [group] } : messages[index], root: renderedRoot };
}

async function responseAnnotationFromSelection(selection) {
  const quote = normalizedAnnotationQuote(selection?.quote);
  const projection = sourceMessageForSelection(selection);
  const identity = responseAnnotationSourceIdentity(projection?.message);
  const locator = responseAnnotationSurfaceLocator(selection?.message, selection?.surface);
  const start = Number(selection?.offsets?.start);
  const end = Number(selection?.offsets?.end);
  if (!quote || !projection || !identity || !locator
    || !Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return null;
  const [contentHash, surfaceHash, selectionHash] = await Promise.all([
    responseAnnotationSha256(responseAnnotationSourceContent(projection.message, locator)),
    responseAnnotationSha256(selection.surface.textContent),
    responseAnnotationSha256(quote),
  ]);
  const source = normalizedResponseAnnotationSource({
    version: 1,
    ...identity,
    ...locator,
    start,
    end,
    contentHash,
    surfaceHash,
    selectionHash,
  });
  return source ? { quote, annotation: "", source } : null;
}

function duplicateResponseAnnotation(left, right) {
  const leftSource = normalizedResponseAnnotationSource(left?.source);
  const rightSource = normalizedResponseAnnotationSource(right?.source);
  if (leftSource && rightSource) return JSON.stringify(leftSource) === JSON.stringify(rightSource);
  return !leftSource && !rightSource && left?.quote === right?.quote;
}

async function addAnnotation(selection) {
  const quote = normalizedAnnotationQuote(selection?.quote);
  if (!quote) {
    showToast("Выделите фрагмент сообщения или рассуждения.");
    return false;
  }
  const operation = captureComposerTaskOperation();
  if (!operation) return false;
  const operationSequence = (annotationOperationSequences.get(operation.taskId) ?? 0) + 1;
  annotationOperationSequences.set(operation.taskId, operationSequence);
  let next;
  try {
    next = await responseAnnotationFromSelection(selection);
  } catch {
    next = null;
  }
  if (!next) {
    showToast("Не удалось подтвердить источник выделенного фрагмента.");
    return false;
  }
  if (annotationOperationSequences.get(operation.taskId) !== operationSequence
    || !composerTaskOperationCurrent(operation)) return false;
  const current = composerDraftSnapshot(operation.taskId);
  if (current.annotations.some((annotation) => duplicateResponseAnnotation(annotation, next))) {
    showToast("Этот фрагмент уже добавлен.");
    return false;
  }
  const nextAnnotations = [...current.annotations, next];
  composerDraftReconciliation.save(operation.taskId, {
    ...current,
    annotations: nextAnnotations,
  }, { userEdited: true });
  if (state.selectedId === operation.taskId) {
    restoreDraft();
    lastAnnotationSelection = null;
    window.getSelection()?.removeAllRanges();
    annotationsBox.querySelector(
      `[data-annotation-comment-index="${nextAnnotations.length - 1}"]`,
    )?.focus();
  }
  return true;
}

function closeAnnotationContextMenu() {
  pendingAnnotationSelection = null;
  annotationContextMenu.hidden = true;
}

function openAnnotationContextMenu(event, selection) {
  pendingAnnotationSelection = selection;
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

function handleAnnotationContextMenu(event) {
  const selected = selectedQuotableSelection() ?? selectedQuotableSelectionAt(event.target);
  const message = event.target.closest?.("[data-role]") ?? null;
  const quote = selected?.quote
    || (lastAnnotationSelection?.message === message ? lastAnnotationSelection.quote : "");
  if (!meaningfulAnnotationSelection(quote)) {
    closeAnnotationContextMenu();
    return;
  }
  // Android WebView adds “Цитировать” to its native touch-selection menu.
  // A coarse-pointer media query is also true in some VS Code webviews on
  // hybrid Windows devices, so only a real or recently observed touch keeps it.
  if (nativeSelectionMenuRequired({
    pointerType: event.pointerType,
    recentTouch: Date.now() - lastTouchSelectionAt <= TOUCH_CONTEXT_MENU_WINDOW_MS,
  })) return;
  event.preventDefault();
  openAnnotationContextMenu(event, selected ?? lastAnnotationSelection);
}

document.addEventListener("contextmenu", handleAnnotationContextMenu, { capture: true });

annotationContextMenu.addEventListener("click", (event) => {
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!["copy-selection", "annotate-selection"].includes(action)) return;
  const selection = pendingAnnotationSelection;
  const quote = selection?.quote ?? "";
  closeAnnotationContextMenu();
  if (action === "annotate-selection") void addAnnotation(selection);
  else emit("clipboard:write", { text: quote });
});

document.addEventListener("pointerdown", (event) => {
  if (event.pointerType === "touch") lastTouchSelectionAt = Date.now();
  if (event.button === 0) lastAnnotationSelection = null;
  if (!annotationContextMenu.hidden && !annotationContextMenu.contains(event.target)) {
    closeAnnotationContextMenu();
  }
});

document.addEventListener("pointerup", (event) => {
  if (event.button !== 0) return;
  const target = event.target;
  window.requestAnimationFrame(() => {
    const selection = selectedQuotableSelection() ?? selectedQuotableSelectionAt(target);
    if (selection) lastAnnotationSelection = selection;
  });
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
    localWorkspaceFilesAvailable: directoryBrowseAvailable,
    vscode: vscodeMode,
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

function composerDraftSnapshot(taskId) {
  const id = String(taskId ?? "").trim();
  if (id && state.selectedId === id) {
    return window.AgentHubComposerDraftReconciliation.normalizedDraft({
      ...(drafts.get(id) ?? {}),
      text: composerInput.value,
      attachments: attachments.slice(),
      taskReferences: taskReferences.slice(),
      annotations: annotations.slice(),
    });
  }
  return window.AgentHubComposerDraftReconciliation.normalizedDraft(
    drafts.get(id) ?? window.AgentHubComposerDraftReconciliation.emptyDraft(),
  );
}

function saveDraft({ userEdited = false } = {}) {
  if (!state.selectedId) return;
  const draft = composerDraftSnapshot(state.selectedId);
  if (userEdited && !window.AgentHubComposerDraftReconciliation.hasDraftContent(draft)
    && window.AgentHubComposerDraftReconciliation.hasDraftContent(drafts.get(state.selectedId))) {
    advanceComposerAsyncOperationFence(state.selectedId);
  }
  composerDraftReconciliation.save(
    state.selectedId,
    draft,
    { userEdited },
  );
}

function composerDraftState(taskId) {
  return composerDraftSnapshot(taskId);
}

function writeComposerDraft(taskId, draft) {
  advanceComposerAsyncOperationFence(taskId);
  const next = composerDraftReconciliation.save(
    taskId,
    draft,
    { userEdited: true },
  );
  if (state.selectedId === taskId) restoreDraft();
  return next;
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
    requestPending: Boolean(pendingComposerRequest) || pendingAttachmentPreparations > 0,
    bugReportAttachments,
    bugReportSending,
  })) return false;
  return true;
}

function restoreDraft() {
  const draft = drafts.get(state.selectedId) ?? {
    text: "", attachments: [], taskReferences: [], annotations: [],
  };
  composerInput.value = draft.text ?? "";
  attachments = draft.attachments ?? [];
  taskReferences = (draft.taskReferences ?? [])
    .map((reference) => TaskReferences.normalize(reference))
    .filter(Boolean);
  annotations = draft.annotations ?? [];
  renderAttachments();
  renderAnnotations();
  autosizeComposer();
  updateSendState();
}

const queueComposerTransfer = window.AgentHubQueueComposerTransfer.create({
  read: composerDraftState,
  write: writeComposerDraft,
  revision: (taskId) => composerDraftReconciliation.revision(taskId),
  notify: showToast,
});

/* ============================================= панель настроек и селекторы */

let settingsPanelReturnFocus = null;

function setDialogSettingsOpen(open) {
  const task = currentTask();
  if (!open && task?.draftStream) {
    emit("stream:settings-save", { streamId: task.streamId, settings: { ...task.streamSettings } });
  }
  const visible = Boolean(open && currentTask());
  if (!visible && streamCardMoveMenu?.matches(":popover-open")) streamCardMoveMenu.hidePopover();
  chatPane.toggleAttribute("data-dialog-settings-open", visible);
  dialogSettingsToggle.setAttribute("aria-pressed", String(visible));
  if (visible) {
    streamCardReturnFocus = document.activeElement;
    renderDialogSettings();
    dialogSettings.hidden = false;
    if (!dialogSettings.open) dialogSettings.showModal();
    dialogStreamName?.focus();
    dialogStreamName?.select();
    return;
  }
  if (dialogSettings.open) dialogSettings.close();
  dialogSettings.hidden = true;
}

function openDialogSettings() {
  setDialogSettingsOpen(true);
}

function toggleDialogSettings() {
  setDialogSettingsOpen(!dialogSettings.open);
}

dialogSettingsClose?.addEventListener("click", (event) => {
  event.stopPropagation();
  setDialogSettingsOpen(false);
});

function openPanel() {
  if (settingsPanel.hidden) settingsPanelReturnFocus = document.activeElement;
  renderGlobalQuickMessagesSettings();
  settingsPanel.hidden = false;
  panelScrim.hidden = false;
  modalOverlays?.activateOverlay(panelScrim, settingsPanelReturnFocus);
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
  if (bugReportToggle) bugReportToggle.disabled = false;
  if (bugReportSubmit) bugReportSubmit.disabled = bugReportSending;
  if (bugReportAttach) bugReportAttach.disabled = bugReportSending;
  if (bugReportText) bugReportText.disabled = bugReportSending;
  if (bugReportSubmit) bugReportSubmit.textContent = bugReportSending ? "Отправляем…" : "Отправить отчёт";
}

function applyBugReportFlowState(next) {
  setBugReportSending(next.sending);
  setBugReportStatus(next.status, next.statusState);
  if (bugReportForm) bugReportForm.hidden = next.formHidden;
  bugReportToggle?.setAttribute("aria-expanded", String(next.expanded));
  if (next.focus) bugReportText?.focus();
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
  if (workspace) {
    event.preventDefault();
    const workspaceId = String(workspace.dataset.workspaceHeading ?? workspace.dataset.boardWorkspaceId ?? "");
    openWorkspaceContextMenu(event, workspaceId);
    return;
  }
  const folder = event.target.closest("[data-workspace-folder-name]");
  if (folder?.dataset.workspaceFolderKind === "folder") {
    event.preventDefault();
    openWorkspaceFolderContextMenu(event, folder.dataset.workspaceFolderName);
    return;
  }
});
workspaceCardQuickMessagesEntry?.addEventListener("click", () => {
  if (!workspaceCardId) return;
  openPromptTemplates("workspace", {
    workspaceId: workspaceCardId,
    workspaceName: workspaceCatalogItem(workspaceCardId)?.name ?? "",
  });
});
/* Редактор внутри формы остался прежним, поэтому и обработчики его прежние —
   форма только подставляет активную область и обновляет свои подписи. */
promptTemplatesModal?.addEventListener("click", (event) => {
  const scopeButton = event.target.closest("[data-prompt-templates-scope]");
  if (scopeButton) {
    /* Переключение области — не запись, и оно нужно, чтобы дойти до соседней
       области с расхождением и разобрать его. */
    setPromptTemplatesScope(scopeButton.dataset.promptTemplatesScope);
    return;
  }
  if (event.target.closest("[data-prompt-templates-reload]")) {
    reloadPromptTemplatesScope();
    return;
  }
  if (event.target.closest("[data-prompt-templates-close], [data-prompt-templates-done]")) {
    if (promptTemplatesBlocked()) return;
    promptTemplatesModal.close();
    return;
  }
  const editorAction = event.target.closest("[data-quick-message-add], [data-quick-message-action]");
  if (!editorAction) return;
  if (promptTemplatesScopeConflicted()) return;
  /* Раскрытие строки правкой не является и точку отсчёта не заводит. */
  if (editorAction.dataset.quickMessageAction !== "toggle") markPromptTemplatesEdited();
  handleQuickMessageEditorClick(
    event,
    promptTemplatesEditor,
    promptTemplatesScope,
    promptTemplateScopeId(promptTemplatesScope),
  );
  renderPromptTemplatesScopes();
  renderPromptTemplatesConflict();
  renderPromptTemplateEntryCounts();
});
promptTemplatesModal?.addEventListener("input", (event) => {
  if (!event.target.closest("[data-quick-message-title], [data-quick-message-text]")) return;
  if (promptTemplatesScopeConflicted()) return;
  /* Первый же ввод отмечает область правленой: входящее обновление снимка с
     этого момента черновик не подменяет. */
  markPromptTemplatesEdited();
  handleQuickMessageEditorInput(event, promptTemplatesEditor);
  renderPromptTemplatesScopes();
});
promptTemplatesModal?.addEventListener("change", (event) => {
  if (!event.target.closest("[data-quick-message-title], [data-quick-message-text]")) return;
  if (promptTemplatesScopeConflicted()) return;
  markPromptTemplatesEdited();
  handleQuickMessageEditorChange(
    promptTemplatesEditor,
    promptTemplatesScope,
    promptTemplateScopeId(promptTemplatesScope),
  );
  renderPromptTemplatesScopes();
  renderPromptTemplatesConflict();
  renderPromptTemplateEntryCounts();
});
/* Escape тоже закрывает форму, поэтому расхождение останавливает и его:
   иначе черновик исчез бы вместе с окном. */
promptTemplatesModal?.addEventListener("cancel", (event) => {
  if (promptTemplatesBlocked()) event.preventDefault();
});
/* Форму закрывают и клавишей Escape, поэтому фокус возвращается в обработчике
   самого закрытия. Черновик остаётся в состоянии редактора и переживёт
   повторное открытие. */
promptTemplatesModal?.addEventListener("close", () => {
  const returnFocus = promptTemplatesReturnFocus;
  promptTemplatesReturnFocus = null;
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
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
      folderName: workspaceCardFolder?.value ?? "",
      comment: workspaceCardComment.value.trim(),
      workingDirectory: workspaceCardWorkingDirectory.value.trim(),
      taskPrefix: workspaceCardTaskPrefix.value.trim(),
      rules: workspaceCardRules.value,
      releaseWorkflowEnabled: workspaceCardReleaseWorkflow.checked,
      autoReviewEnabled: workspaceCardAutoReview.checked,
      beforeColumnId: order[targetIndex] ?? null,
    });
    closeWorkspaceCard();
    return;
  }
  const workspace = workspaceCatalogItem(workspaceCardId);
  if (!workspace) return closeWorkspaceCard();
  const releaseWorkflowEnabled = workspaceCardReleaseWorkflow.checked;
  const columnId = `workspace:${workspace.id}`;
  const remaining = order.filter((id) => id !== columnId);
  const targetIndex = Math.max(0, Math.min(remaining.length, requestedOrder - 1));
  emit("workspace:update", {
    workspaceId: workspace.id,
    name,
    folderName: workspaceCardFolder?.value ?? "",
    comment: workspaceCardComment.value.trim(),
    workingDirectory: workspaceCardWorkingDirectory.value.trim(),
    taskPrefix: workspaceCardTaskPrefix.value.trim(),
    rules: workspaceCardRules.value,
    releaseWorkflowEnabled,
    autoReviewEnabled: workspaceCardAutoReview.checked,
    beforeColumnId: remaining[targetIndex] ?? null,
  });
  closeWorkspaceCard();
});
workspaceCardRules?.addEventListener("input", () => {
  updateAgentRulesLimit(workspaceCardRules, workspaceCardRulesCount);
});
document.querySelector("[data-workspace-card-close]")?.addEventListener("click", closeWorkspaceCard);
document.querySelector("[data-workspace-card-cancel]")?.addEventListener("click", closeWorkspaceCard);
workspaceCardArchive?.addEventListener("click", () => {
  if (!workspaceCardId || workspaceCardArchive.disabled) return;
  const workspaceId = workspaceCardId;
  closeWorkspaceCard();
  emit("workspace:archive", { workspaceId });
});
modalOverlays?.installDismissibleOverlay({
  dialog: workspaceCardModal,
  content: workspaceCardForm,
  close: closeWorkspaceCard,
});
workspaceCardModal?.addEventListener("close", () => {
  const returnFocus = workspaceCardReturnFocus;
  workspaceCardId = "";
  workspaceCardMode = "edit";
  workspaceCardReturnFocus = null;
  returnFocus?.focus?.({ preventScroll: true });
});
workspaceArchiveList?.addEventListener("click", (event) => {
  const restore = event.target.closest("[data-workspace-archive-restore]");
  const workspaceId = String(restore?.dataset?.workspaceArchiveRestore ?? "").trim();
  if (workspaceId) {
    emit("workspace:restore", { workspaceId });
    return;
  }
  const remove = event.target.closest("[data-workspace-archive-delete]");
  const deleteWorkspaceId = String(remove?.dataset?.workspaceArchiveDelete ?? "").trim();
  if (!deleteWorkspaceId) return;
  const workspace = state.archivedWorkspaces.find((item) => String(item.id ?? "") === deleteWorkspaceId);
  if (!workspace) return;
  closeWorkspaceArchive();
  void askText({
    title: `Окончательное удаление необратимо и уничтожит Workspace «${workspace.name}» вместе со связанными Streams и Threads. Для подтверждения введите точное имя: ${workspace.name}`,
  }).then((confirmationName) => {
    if (confirmationName == null) {
      openWorkspaceArchive();
      return;
    }
    if (confirmationName !== workspace.name) {
      showToast("Название не совпало — Workspace не удалён");
      openWorkspaceArchive();
      return;
    }
    emit("workspace:delete-permanently", { workspaceId: deleteWorkspaceId, confirmationName });
  });
});
document.querySelector("[data-workspace-archive-close]")?.addEventListener("click", closeWorkspaceArchive);
document.addEventListener("agenthub:workspace-delete-rejected", (event) => {
  openWorkspaceArchive();
  const workspaceId = String(event.detail?.workspaceId ?? "").trim();
  if (!workspaceId) return;
  workspaceArchiveList?.querySelector(`[data-workspace-archive-delete="${CSS.escape(workspaceId)}"]`)
    ?.focus({ preventScroll: true });
});
modalOverlays?.installDismissibleOverlay({
  dialog: workspaceArchiveModal,
  close: closeWorkspaceArchive,
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
  applyBugReportFlowState(bugReportFlow.pending());
  emit("bug-report:submit", {
    text,
    attachments: bugReportAttachments.slice(),
    reportId: crypto.randomUUID(),
  });
});

trustedDeviceCreate?.addEventListener("click", () => emit("devices:create"));
streamHeaderProviderConnectionRetry?.addEventListener("click", (event) => {
  event.preventDefault();
  event.stopPropagation();
  emit("connection:retry", { taskId: state.selectedId });
});
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

/* Telegram и Android не выпускают новые учётные данные. Доверенный браузер
 * может делегировать доступ другому устройству через локальный Hub. */
const deviceEnrollmentAllowed = !telegramMode
  && !window.AgentHubAndroid;

function renderTrustedDevices(payload = {}) {
  if (!trustedDeviceList || !trustedDevicePairing) return;
  if (trustedDeviceCreate) {
    trustedDeviceCreate.hidden = !deviceEnrollmentAllowed;
    trustedDeviceCreate.title = deviceEnrollmentAllowed
      ? ""
      : "Новое устройство добавляется через доверенный браузер Agent Hub";
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
  const returnFocus = settingsPanelReturnFocus;
  settingsPanelReturnFocus = null;
  modalOverlays?.deactivateOverlay(panelScrim);
  settingsPanel.classList.remove("open");
  panelScrim.classList.remove("open");
  window.setTimeout(() => {
    settingsPanel.hidden = true;
    panelScrim.hidden = true;
  }, 220);
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

for (const opener of document.querySelectorAll("[data-panel-open='settings']")) {
  opener.addEventListener("click", openPanel);
}
for (const closer of document.querySelectorAll("[data-panel-close]")) {
  closer.addEventListener("click", closePanel);
}
modalOverlays?.installScrimDismiss({ scrim: panelScrim, close: closePanel });

function renderOptions() {
  renderDialogSettings();
  renderQuickMessageActionModeSetting();
  renderGlobalQuickMessagesSettings();
  renderTurnTimeModeOptions();
  renderComparisonViewModeOptions();
  for (const toggle of document.querySelectorAll("[data-toggle]")) {
    const key = toggle.dataset.toggle;
    const pending = state.pendingSelections.has(key);
    toggle.checked = Boolean(state.selection[key]);
    toggle.disabled = pending;
    toggle.setAttribute("aria-busy", String(pending));
    toggle.closest(".setting-switch")?.toggleAttribute("data-pending", pending);
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
  const streamId = String(task?.streamId ?? "").trim();
  const workspaceId = workspaceKey(task);
  const running = task?.running === true;
  const provider = String(task?.provider ?? selection?.provider ?? "").trim();
  const oppositeProvider = provider === "codex" ? "claude" : provider === "claude" ? "codex" : "";
  const oppositeLabel = oppositeProvider === "claude" ? "Claude" : oppositeProvider === "codex" ? "Codex" : "";
  if (dialogStreamName && document.activeElement !== dialogStreamName) {
    dialogStreamName.value = String(task?.streamName ?? task?.streamDisplayName ?? "").trim();
  }
  if (dialogStreamName) dialogStreamName.disabled = !streamId;
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
      if (container instanceof HTMLSelectElement) {
        container.append(el("option", { value: "", selected: true, text: "—" }));
        container.disabled = true;
      } else {
        container.append(el("span", { class: "setting-empty", text: "—" }));
      }
      continue;
    }
    if (container instanceof HTMLSelectElement) container.disabled = false;
    for (const option of values) {
      const value = typeof option === "string" ? option : option.value;
      const label = typeof option === "string" ? option : (option.label ?? option.value);
      const active = selection?.[group] === value;
      container.append(container instanceof HTMLSelectElement
        ? el("option", { value, selected: active, text: label })
        : el("button", {
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
    streamWorkingDirectoryField?.setValue(String(task?.streamSettings?.workingDirectory ?? "").trim());
    dialogWorkingDirectory.disabled = !task?.streamId;
    dialogWorkingDirectory.placeholder = workspaceDirectory
      ? `Workspace: ${workspaceDirectory}`
      : currentDirectory ? `Текущая: ${currentDirectory}` : "Наследуется от Workspace";
    if (dialogWorkingDirectoryNote) {
      dialogWorkingDirectoryNote.textContent = task?.draftStream
        ? "Будет использована при создании Thread; пустое значение наследуется от Workspace."
        : "Применится при создании следующего Thread; текущий Thread сохраняет свою директорию.";
    }
    streamWorkingDirectoryField?.refresh();
  }
  if (dialogStreamReleaseManager) {
    dialogStreamReleaseManager.checked = streamRoleSettings.releaseManagerEnabled(task?.streamSettings);
    dialogStreamReleaseManager.disabled = !task?.streamId;
  }
  if (dialogStreamTeamLead) {
    dialogStreamTeamLead.checked = streamRoleSettings.teamLeadEnabled(task?.streamSettings);
    dialogStreamTeamLead.disabled = !task?.streamId;
  }
  const pinned = window.AgentHubStreamTabs.streamIsPinned(state.selection, workspaceId, streamId);
  if (streamCardPin) {
    streamCardPin.textContent = window.AgentHubStreamTabs.pinnedStreamActionLabel(pinned);
    streamCardPin.title = window.AgentHubStreamTabs.pinnedStreamActionTitle(pinned);
    streamCardPin.disabled = !streamId;
  }
  if (streamCardWorkspace) {
    const workspace = workspaceCatalogItem(workspaceId);
    streamCardWorkspace.textContent = workspace ? `Workspace: ${workspace.name}` : "Открыть карточку Workspace";
    streamCardWorkspace.disabled = !workspace;
  }
  if (streamCardRotate) {
    streamCardRotate.disabled = !streamId || running || !["codex", "claude"].includes(provider);
    streamCardRotate.title = running ? "Сначала завершите текущий ход" : "Продолжить Stream в новом Thread текущего провайдера";
  }
  if (streamCardContinueProvider) {
    streamCardContinueProvider.textContent = oppositeProvider
      ? `Продолжить в ${oppositeLabel}`
      : "Продолжение недоступно";
    streamCardContinueProvider.dataset.provider = oppositeProvider;
    streamCardContinueProvider.disabled = !streamId || running || !oppositeProvider;
    streamCardContinueProvider.title = running
      ? "Сначала завершите текущий ход"
      : oppositeProvider ? "Продолжить Stream в противоположном провайдере" : "Провайдер Stream не определён";
  }
  const moveOptions = workspaceMenuOptions(workspaceId);
  if (streamCardMoveMenu) {
    streamCardMoveMenu.replaceChildren(...moveOptions.map((workspace) => el("button", {
      type: "button",
      class: "stream-card-move-option",
      role: "menuitem",
      "data-stream-card-move-workspace": workspace.id,
      text: workspace.name,
    })));
  }
  if (streamCardMove) {
    streamCardMove.disabled = !streamId || moveOptions.length === 0
      || typeof streamCardMoveMenu?.showPopover !== "function";
    streamCardMove.title = moveOptions.length
      ? "Выбрать Workspace и сразу перенести Stream"
      : "Нет доступных Workspace для переноса";
  }
  if (streamCardArchive) {
    streamCardArchive.disabled = !streamId || running;
    streamCardArchive.title = running ? "Сначала завершите активный ход в этом Stream" : "Архивировать Stream";
  }
  renderStreamRulesPreview();
  renderStreamQuickMessagesSettings();
}

function selectDialogSetting(group, value) {
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
}

function openStreamCardMoveMenu() {
  if (!streamCardMoveMenu || !streamCardMove || streamCardMove.disabled
    || typeof streamCardMoveMenu.showPopover !== "function") return;
  streamCardMoveMenu.showPopover();
  const anchor = streamCardMove.getBoundingClientRect();
  const menu = streamCardMoveMenu.getBoundingClientRect();
  const left = Math.max(8, Math.min(anchor.left, window.innerWidth - menu.width - 8));
  const below = anchor.bottom + 6;
  const top = below + menu.height <= window.innerHeight - 8
    ? below
    : Math.max(8, anchor.top - menu.height - 6);
  streamCardMoveMenu.style.left = `${left}px`;
  streamCardMoveMenu.style.top = `${top}px`;
  streamCardMoveMenu.querySelector("[role='menuitem']")?.focus({ preventScroll: true });
}

settingsGlobalQuickMessagesEntry?.addEventListener("click", () => {
  openPromptTemplates("global");
});

quickMessageActionModeSelect?.addEventListener("change", () => {
  const value = quickMessageActionModeSelect.value === "send" ? "send" : "insert";
  state.selection = { ...state.selection, quickMessageActionMode: value };
  renderQuickMessageActionModeSetting();
  renderComposerQuickMessages();
  emit("selection:set", { key: "quickMessageActionMode", value });
});

dialogSettings.addEventListener("click", (event) => {
  const task = currentTask();
  const streamId = String(task?.streamId ?? "").trim();
  const workspaceId = workspaceKey(task);
  if (event.target.closest("[data-prompt-templates-open]")) {
    if (streamId) openPromptTemplates("stream");
    return;
  }
  if (event.target.closest("[data-stream-card-pin]")) {
    if (streamId) togglePinnedWorkspaceStream(workspaceId, streamId);
    renderDialogSettings();
    return;
  }
  if (event.target.closest("[data-stream-card-workspace]")) {
    if (!workspaceCatalogItem(workspaceId)) return;
    setDialogSettingsOpen(false);
    openWorkspaceCard(workspaceId);
    return;
  }
  if (event.target.closest("[data-stream-card-rotate]")) {
    if (!streamId || streamCardRotate?.disabled) return;
    emit("stream:rebirth", { streamId, provider: task.provider, taskId: task.id });
    setDialogSettingsOpen(false);
    return;
  }
  const continuation = event.target.closest("[data-stream-card-continue-provider]");
  if (continuation) {
    const provider = String(continuation.dataset.provider ?? "");
    if (!streamId || continuation.disabled || !provider) return;
    emit("stream:continue-provider", { streamId, provider, taskId: task.id });
    setDialogSettingsOpen(false);
    return;
  }
  const moveOption = event.target.closest("[data-stream-card-move-workspace]");
  if (moveOption) {
    const targetWorkspaceId = String(moveOption.dataset.streamCardMoveWorkspace ?? "");
    const allowed = workspaceMenuOptions(workspaceId).some((workspace) => workspace.id === targetWorkspaceId);
    if (!streamId || !allowed) {
      if (streamCardMoveMenu?.matches(":popover-open")) streamCardMoveMenu.hidePopover();
      renderDialogSettings();
      return;
    }
    emit("stream:move", { streamId, workspaceId: targetWorkspaceId });
    setDialogSettingsOpen(false);
    return;
  }
  if (event.target.closest("[data-stream-card-move]")) {
    openStreamCardMoveMenu();
    return;
  }
  if (event.target.closest("[data-stream-card-archive]")) {
    if (!streamId || streamCardArchive?.disabled) return;
    emit("stream:archive", { streamId });
    setDialogSettingsOpen(false);
    return;
  }
  const chip = event.target.closest("[data-select-group]");
  if (!chip) return;
  selectDialogSetting(chip.dataset.selectGroup, chip.dataset.selectValue);
});

dialogSettings.addEventListener("change", (event) => {
  const streamName = event.target.closest("[data-dialog-stream-name]");
  if (streamName) {
    const task = currentTask();
    const name = String(streamName.value ?? "").trim();
    if (!task?.streamId || !name) {
      renderDialogSettings();
      return;
    }
    if (name !== String(task.streamName ?? task.streamDisplayName ?? "")) {
      emit("stream:rename", { streamId: task.streamId, name });
    }
    return;
  }
  const setting = event.target.closest("select[data-dialog-options]");
  if (setting) {
    selectDialogSetting(setting.dataset.dialogOptions, setting.value);
    return;
  }
  const releaseManager = event.target.closest("[data-dialog-stream-release-manager]");
  if (releaseManager) {
    const task = currentTask();
    if (!task?.streamId) return;
    task.streamSettings = streamRoleSettings.withReleaseManager(task.streamSettings, releaseManager.checked);
    emit("stream:settings-save", { streamId: task.streamId, settings: { ...task.streamSettings } });
    renderOptions();
    return;
  }
  const teamLead = event.target.closest("[data-dialog-stream-team-lead]");
  if (teamLead) {
    const task = currentTask();
    if (!task?.streamId) return;
    task.streamSettings = streamRoleSettings.withTeamLead(task.streamSettings, teamLead.checked);
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

dialogSettings.addEventListener("directorycommit", (event) => {
  const directory = event.target.closest("[data-dialog-working-directory]");
  if (!directory) return;
  const task = currentTask();
  if (!task?.streamId) return;
  task.streamSettings = {
    ...(task.streamSettings ?? {}),
    workingDirectory: directory.value.trim(),
  };
  emit("stream:settings-save", { streamId: task.streamId, settings: { ...task.streamSettings } });
  renderOptions();
});

modalOverlays?.installDismissibleOverlay({
  dialog: dialogSettings,
  close: () => setDialogSettingsOpen(false),
});
dialogSettings.addEventListener("close", () => {
  if (dialogSettings.open) return;
  const returnFocus = streamCardReturnFocus;
  streamCardReturnFocus = null;
  dialogSettings.hidden = true;
  chatPane.toggleAttribute("data-dialog-settings-open", false);
  dialogSettingsToggle.setAttribute("aria-pressed", "false");
  returnFocus?.focus?.({ preventScroll: true });
});
streamCardMoveMenu?.addEventListener("toggle", (event) => {
  streamCardMove?.setAttribute("aria-expanded", String(event.newState === "open"));
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
  const value = toggle.checked;
  if (key === "includeClaudeUsage") {
    toggle.checked = Boolean(state.selection[key]);
  } else {
    state.selection[key] = value;
  }
  emit("selection:set", { key, value });
});

for (const button of turnTimeModeButtons) {
  button.addEventListener("click", () => selectTurnTimeMode(button.dataset.turnTimeMode));
}

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
    serverFact("Версия", processInfo.version ? `v${processInfo.version}` : "—"),
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
  renderServerAccounts(payload.accounts);
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

/* Вход идёт штатным способом провайдера: Hub только запускает его и показывает
   состояние. Повторное нажатие отменяет незавершённый вход, поэтому кнопка
   остаётся доступной и во время ожидания. */
/* Ссылку входа знает только локальный клиент, запустивший вход: в общий снапшот
   она не попадает. */
const providerLoginLocal = new Map();
/* Черновик кода живёт только в памяти страницы, чтобы снапшот не стирал ввод. */
const providerLoginCodeDrafts = new Map();
let providerLoginRenderKey = "";

function renderServerAccounts(accounts) {
  const panel = window.AgentHubProviderLoginPanel;
  if (!serverAccounts || !panel) return;
  const list = Array.isArray(accounts) ? accounts : [];
  const views = list.map((account) => {
    if (!panel.retainLocal(account, providerLoginLocal.get(account?.provider))) {
      providerLoginLocal.delete(account?.provider);
      providerLoginCodeDrafts.delete(account?.provider);
    }
    return panel.accountView(account, providerLoginLocal.get(account?.provider));
  });
  const key = panel.renderKey(views);
  if (key === providerLoginRenderKey && serverAccounts.childElementCount) return;
  providerLoginRenderKey = key;
  serverAccounts.replaceChildren(...(views.length ? views.map((view) => {
    const start = el("button", { type: "button", class: "chip-button", text: view.startText });
    start.addEventListener("click", () => emit("server:provider-login", { provider: view.provider }));
    const open = view.authUrl
      ? el("button", { type: "button", class: "chip-button ghost", text: "Открыть страницу входа" })
      : null;
    open?.addEventListener("click", () => emit("server:provider-login-open", { authUrl: view.authUrl }));
    const cancel = view.canCancel
      ? el("button", { type: "button", class: "chip-button ghost", text: "Отменить" })
      : null;
    cancel?.addEventListener("click", () => {
      providerLoginCodeDrafts.delete(view.provider);
      emit("server:provider-login-cancel", { provider: view.provider });
    });
    let codeRow = null;
    if (view.acceptsCode) {
      const input = el("input", { type: "text", class: "server-account-code" });
      input.autocomplete = "off";
      input.spellcheck = false;
      input.placeholder = "code#state";
      input.setAttribute("aria-label", "Код со страницы входа Claude");
      input.value = providerLoginCodeDrafts.get(view.provider) ?? "";
      const send = el("button", { type: "button", class: "chip-button", text: "Отправить код" });
      const sync = () => {
        if (input.value) providerLoginCodeDrafts.set(view.provider, input.value);
        else providerLoginCodeDrafts.delete(view.provider);
        send.disabled = !panel.codeSubmission(view, input.value);
      };
      input.addEventListener("input", sync);
      sync();
      send.addEventListener("click", () => {
        const submission = panel.codeSubmission(view, input.value);
        if (!submission) return;
        providerLoginCodeDrafts.delete(view.provider);
        input.value = "";
        sync();
        emit("server:provider-login-code", submission);
      });
      codeRow = el("div", { class: "server-account-code-row" }, [
        el("small", { text: view.codeHint }),
        el("div", { class: "server-account-actions" }, [input, send]),
      ]);
    }
    return el("div", { class: "server-component server-account", "data-status": view.status }, [
      el("span", { class: "server-component-name", text: view.label }),
      el("span", { class: "server-component-status", text: view.statusText }),
      view.loginStatusText ? el("small", { text: view.loginStatusText }) : null,
      view.error ? el("small", { text: view.error }) : null,
      el("div", { class: "server-account-actions" }, [start, open, cancel].filter(Boolean)),
      codeRow,
    ].filter(Boolean));
  }) : [el("span", { class: "setting-empty", text: "Вход недоступен в этой версии Hub" })]));
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
let dialogReturnFocus = null;

function askText({ title, value = "", multiline = false }) {
  return new Promise((resolve) => {
    if (dialog.hidden) dialogReturnFocus = document.activeElement;
    dialogResolve = resolve;
    dialogTitle.textContent = title;
    dialogActiveInput = multiline ? dialogTextarea : dialogInput;
    dialogInput.hidden = multiline;
    dialogTextarea.hidden = !multiline;
    dialogActiveInput.value = value;
    dialog.hidden = false;
    dialogScrim.hidden = false;
    modalOverlays?.activateOverlay(dialogScrim, dialogReturnFocus);
    requestAnimationFrame(() => dialogActiveInput.focus());
  });
}

function closeDialog(result) {
  const returnFocus = dialogReturnFocus;
  dialogReturnFocus = null;
  modalOverlays?.deactivateOverlay(dialogScrim);
  dialog.hidden = true;
  dialogScrim.hidden = true;
  const resolve = dialogResolve;
  dialogResolve = null;
  resolve?.(result);
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
}

dialogForm.addEventListener("submit", (event) => {
  event.preventDefault();
  closeDialog(dialogActiveInput.value.trim());
});
document.querySelector("[data-text-dialog-cancel]").addEventListener("click", () => closeDialog(null));
modalOverlays?.installScrimDismiss({
  scrim: dialogScrim,
  close: () => closeDialog(null),
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  /* Escape снимает только верхний слой. Модальный диалог закрывает себя сам, и
     панель под ним остаётся: иначе форма шаблонов, открытая из настроек,
     уносила бы за собой и сами настройки. */
  if (document.querySelector("dialog[open]")) return;
  if (!dialog.hidden) closeDialog(null);
  if (!settingsPanel.hidden) closePanel();
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
    case "workspace-archive-open":
      openWorkspaceArchive();
      break;
    case "workspace-folder-new": {
      const folderName = await askText({ title: "Название папки Workspace" });
      if (folderName) createWorkspaceFolder(folderName);
      break;
    }
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
      applyStreamOrderMode(streamOrderMode === "manual" ? "activity" : "manual", { update: true });
      state.selection.streamOrderMode = streamOrderMode;
      emit("selection:set", { key: "streamOrderMode", value: streamOrderMode });
      break;
    case "task-settings":
      toggleDialogSettings();
      break;
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
      const guard = queueComposerTransfer.begin(taskId);
      if (guard) emit("queue:edit", { taskId, id: entry.id, guard });
      break;
    }
    case "queue-move":
      emit("queue:move", {
        taskId,
        id: trigger.dataset.queueId,
        direction: trigger.dataset.direction,
      });
      break;
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
        if (!composerInput.value.trim()) {
          composerInput.value = "/";
          autosizeComposer();
          updateSendState();
          saveDraft({ userEdited: true });
        }
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
  composerRecoveryDiagnostics() {
    return Object.freeze({
      epoch: composerRecoveryAuthorityEpoch,
      pending: composerRecoveryAuthorityPending,
      ready: composerRecoveryAuthorityReady,
      restored: composerDraftRestoreReady,
      trusted: composerRecoveryAuthorityTrusted,
    });
  },
  whenComposerRecoveryReady() {
    return ensureComposerDraftsRestored();
  },
  prepareForRuntimeReload,
  setConnectionQuality({ latencyMs = null } = {}) {
    const latency = Number(latencyMs);
    const nextLatency = Number.isFinite(latency) && latency >= 0 ? Math.round(latency) : null;
    if (state.connectionLatencyMs === nextLatency) return;
    state.connectionLatencyMs = nextLatency;
    renderConnectionQuality();
    renderStreamChatHeader(currentTask());
  },
  /** Состояние соединения и отложенного перезапуска Agent Hub. */
  setConnection(status, details = {}) {
    const value = ["online", "connecting", "restart-waiting", "restarting", "offline"].includes(status)
      ? status
      : "offline";
    const blockingCount = Math.max(0, Number(details.blockingCount) || 0);
    const unchanged = state.connection === value && state.connectionBlockingCount === blockingCount;
    if (unchanged) return;
    state.connection = value;
    state.connectionBlockingCount = blockingCount;
    window.dispatchEvent(new CustomEvent("agenthub:connection-state", {
      detail: { status: value, blockingCount },
    }));
    renderConnectionQuality();
    renderStreamChatHeader(currentTask());
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
    const previousTasks = state.tasks;
    const selected = nextTasks.find((task) => task.selected);
    const nextSelectedId = selected?.id
      ?? (nextTasks.some((task) => task.id === state.selectedId) ? state.selectedId : null);
    const previousSelectedTask = state.tasks.find((task) => task.id === state.selectedId) ?? null;
    const nextSelectedTask = nextTasks.find((task) => task.id === nextSelectedId) ?? null;
    const selectionChanged = nextSelectedId !== state.selectedId;
    const taskDataChanged = !sameData(previousTasks, nextTasks);
    const navigationChangedIds = changedTaskIds(previousTasks, nextTasks, taskNavigationData);
    const chatChangedIds = changedTaskIds(previousTasks, nextTasks, taskChatData);
    const tasksChanged = chatChangedIds.size > 0;
    const navigationChanged = navigationChangedIds.size > 0;
    const selectedTaskDataChanged = !sameData(previousSelectedTask, nextSelectedTask);
    const selectedTaskChanged = chatChangedIds.has(nextSelectedId)
      || !sameData(taskChatData(previousSelectedTask), taskChatData(nextSelectedTask));
    const selectedTaskLocationChanged = Boolean(previousSelectedTask && nextSelectedTask) && (
      workspaceKey(previousSelectedTask) !== workspaceKey(nextSelectedTask)
      || streamKey(previousSelectedTask) !== streamKey(nextSelectedTask)
    );
    const nextTaskIds = new Set(nextTasks.map((task) => String(task?.id ?? "").trim()).filter(Boolean));
    for (const previousTask of previousTasks) {
      if (!nextTaskIds.has(String(previousTask?.id ?? "").trim())) removeComposerTask(previousTask.id);
    }
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
    if (!taskDataChanged && !selectionChanged) return;
    transientAnswerArrivalTaskIds = window.AgentHubStreamTabs.answerArrivalTaskIds(
      nextTasks,
      observedAnswerFinalIdentityByTaskId,
    );
    if (selectionChanged && state.selectedId) saveDraft();
    updateComposerTaskGenerations(previousTasks, nextTasks);
    state.tasks = nextTasks;
    state.selectedId = nextSelectedId;
    if (selectionChanged || selectedTaskLocationChanged) {
      const current = currentTask();
      if (current) state.activeStreamByWorkspace.set(workspaceKey(current), streamKey(current));
      ensureTaskStreamVisible(current);
      persistOpenStreams();
    }
    try {
      if (navigationChanged || selectionChanged) renderTasks();
      const chatNeedsRender = selectionChanged || selectedTaskChanged || nextTasks.some((task) => (
        task.id !== nextSelectedId
        && state.visibleStreamTaskIds.includes(task.id)
        && chatChangedIds.has(task.id)
      ));
      if (chatNeedsRender) renderChat();
      else {
        if (navigationChanged) renderStreamTabs();
        if (selectedTaskDataChanged) renderStreamChatHeader(nextSelectedTask);
      }
    } finally {
      transientAnswerArrivalTaskIds = new Set();
    }
  },
  setWorkspaces(workspaces, columnOrder = []) {
    const nextWorkspaces = Array.isArray(workspaces) ? workspaces.slice() : [];
    const nextColumnOrder = Array.isArray(columnOrder) ? columnOrder.slice() : [];
    if (sameData(state.workspaces, nextWorkspaces)
      && sameData(state.workspaceColumnOrder, nextColumnOrder)) return;
    state.workspaces = nextWorkspaces;
    state.workspaceColumnOrder = nextColumnOrder;
    if (journalRendered) updateJournalStreamCount();
  },
  setArchivedWorkspaces(workspaces) {
    const next = Array.isArray(workspaces) ? workspaces.slice() : [];
    if (sameData(state.archivedWorkspaces, next)) return;
    state.archivedWorkspaces = next;
    renderWorkspaceArchive();
  },
  renameWorkspaceFolderCatalog,
  openDialogSettings,
  /** Точечное обновление задачи (статус, время, непрочитанное). */
  patchTask(id, patch) {
    const task = state.tasks.find((item) => item.id === id);
    if (!task) return;
    const changed = Object.entries(patch ?? {}).some(([key, value]) => !Object.is(task[key], value));
    if (!changed) return;
    Object.assign(task, patch);
    transientAnswerArrivalTaskIds = window.AgentHubStreamTabs.answerArrivalTaskIds(
      [task],
      observedAnswerFinalIdentityByTaskId,
    );
    try {
      renderTasks();
      if (id === state.selectedId) renderChat();
      else {
        renderStreamTabs();
        if (state.visibleStreamTaskIds.includes(id)) renderStreamChatDeck({ force: true });
      }
    } finally {
      transientAnswerArrivalTaskIds = new Set();
    }
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
      renderStreamChatHeader(currentTask());
    } else refreshSupplementaryStreamChat(taskId);
  },
  setMessagesForExactNavigation(taskId, messages, exactNavigation) {
    const next = Array.isArray(messages) ? messages.slice() : [];
    const sameMessages = state.messages.has(taskId) && sameData(state.messages.get(taskId), next);
    const selectedSurfaceOwned = taskId === state.selectedId
      && String(chatLog.dataset.messageOwnerKey ?? "") === String(taskId ?? "");
    if (!sameMessages) state.messages.set(taskId, next);
    if (taskId === state.selectedId) {
      if (sameMessages && selectedSurfaceOwned) {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        focusRenderedMessage(exactNavigation, { behavior: reducedMotion ? "auto" : "smooth" });
      } else {
        renderMessages({ exactNavigation });
      }
      renderLive();
      renderStreamChatHeader(currentTask());
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
    const previous = state.messages.get(taskId) ?? [];
    const sameMessages = state.messages.has(taskId) && sameData(previous, next);
    const prependedCount = sameMessages ? 0 : MessageView.prependedMessageCount(previous, next);
    const previousTail = MessageView.messageTailPagination(
      previous.length,
      state.messageRenderLimits.get(taskId) ?? INITIAL_MESSAGE_RENDER_LIMIT,
      MESSAGE_RENDER_PAGE_SIZE,
    );
    const selectedSurfaceOwned = taskId === state.selectedId
      && String(chatLog.dataset.messageOwnerKey ?? "") === String(taskId ?? "");
    if (sameMessages && (taskId !== state.selectedId || selectedSurfaceOwned)) return;
    if (!sameMessages) state.messages.set(taskId, next);
    if (prependedCount > 0 && previousTail.hiddenCount === 0) {
      state.messageRenderLimits.set(
        taskId,
        previousTail.visibleCount + Math.min(prependedCount, MESSAGE_RENDER_PAGE_SIZE),
      );
    }
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true, prependedCount });
      renderLive();
      renderStreamChatHeader(currentTask());
    } else refreshSupplementaryStreamChat(taskId);
  },
  setHistoryPagination(taskId, pagination) {
    const next = {
      hasOlder: pagination?.hasOlder === true,
      loading: pagination?.loading === true,
      messageTotal: Number.isSafeInteger(Number(pagination?.messageTotal))
        ? Math.max(0, Number(pagination.messageTotal))
        : null,
    };
    if (sameData(state.historyPagination.get(taskId) ?? {}, next)) return;
    state.historyPagination.set(taskId, next);
    if (taskId === state.selectedId) {
      renderHistoryLoader();
      renderStreamChatHeader(currentTask());
    }
  },
  appendMessage(taskId, message) {
    const list = state.messages.get(taskId) ?? [];
    list.push(message);
    state.messages.set(taskId, list);
    if (taskId === state.selectedId) {
      renderMessages({ preserveTop: true });
      renderLive();
      renderStreamChatHeader(currentTask());
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
  completeSend(requestId, options = {}) {
    return completeComposerSend(requestId, options);
  },
  applyQueueComposerTransfer(guard, draft, identity) {
    return queueComposerTransfer.apply(guard, draft, identity);
  },
  rollbackQueueComposerTransfer(applied) {
    return queueComposerTransfer.rollback(applied);
  },
  completeBugReport(result = {}) {
    applyBugReportFlowState(bugReportFlow.complete(result));
    if (result.error) {
      return;
    }
    bugReportAttachments = [];
    if (bugReportText) bugReportText.value = "";
    renderBugReportAttachments();
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
  setMessagePins(pins) {
    const next = reconcilePendingMessagePins(Array.isArray(pins) ? pins : []);
    if (sameData(state.messagePins, next)) return;
    state.messagePins = next;
    for (const [streamId, pinId] of state.activeMessagePinByStream) {
      if (!next.some((pin) => pin.streamId === streamId && pin.id === pinId)) {
        state.activeMessagePinByStream.delete(streamId);
      }
    }
    renderMessagePinShelf();
    renderMessagePinsList();
    renderMessages({ preserveTop: true });
    renderStreamChatDeck({ force: true });
  },
  completeMessagePinMutation(mutationId, result = {}) {
    const backup = state.messagePinMutationBackups.get(mutationId);
    if (!backup) return;
    state.messagePinMutationBackups.delete(mutationId);
    if (backup.messageKey) state.pendingMessagePinKeys.delete(backup.messageKey);
    if (result.error) {
      state.messagePins = backup.pins;
      setActiveMessagePinId(backup.streamId, backup.selectedPinId);
      showToast(String(result.error));
    } else if (Array.isArray(result.messagePins)) {
      state.messagePins = result.messagePins;
      if (backup.pinned) {
        const committed = result.messagePins.find((pin) => (
          pin.streamId === backup.streamId && pin.messageKey === backup.messageKey
        ));
        setActiveMessagePinId(backup.streamId, committed?.id);
      } else if (backup.selectedPinId === backup.targetPinId) {
        selectMessagePinAfterRemoval({
          streamId: backup.streamId,
          removedIndex: backup.removedIndex,
          pins: result.messagePins,
        });
      } else if (!result.messagePins.some((pin) => pin.id === backup.selectedPinId)) {
        setActiveMessagePinId(backup.streamId);
      }
      if (result.undoToken && result.removedPin) {
        showToast("Сообщение откреплено", {
          label: "Отменить",
          onClick: () => requestMessagePinChange({
            pin: result.removedPin,
            pinned: true,
            undoToken: result.undoToken,
          }),
        });
      }
    }
    renderMessagePinShelf();
    renderMessagePinsList();
    renderMessages({ preserveTop: true });
    renderStreamChatDeck({ force: true });
  },
  openWorkspaceMessageSearch,
  closeWorkspaceMessageSearch,
  focusMessage({ turnId, itemId } = {}) {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    return focusRenderedMessage({ turnId, itemId }, {
      behavior: reducedMotion ? "auto" : "smooth",
    });
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
   *  includeClaudeUsage, activityRecentMinutes, streamOrderMode,
   *  streamCardWidthMode, streamCardFixedWidth, streamCardGapEnabled,
   *  pinnedWorkspaceStreams, quickMessages, quickMessageActionMode }. */
  setSelection(selection) {
    const incoming = { ...(selection ?? {}) };
    for (const key of state.pendingSelections) {
      if (Object.hasOwn(incoming, key) && !sameData(incoming[key], state.selection[key])) delete incoming[key];
    }
    const claudeUsageChanged = Object.hasOwn(incoming, "includeClaudeUsage")
      && state.selection.includeClaudeUsage !== incoming.includeClaudeUsage;
    const pinnedWorkspaceStreamsChanged = Object.hasOwn(incoming, "pinnedWorkspaceStreams")
      && !sameData(state.selection.pinnedWorkspaceStreams, incoming.pinnedWorkspaceStreams);
    const next = { ...state.selection, ...incoming };
    if (sameData(state.selection, next)) return;
    state.selection = next;
    if (Object.hasOwn(incoming, "activityRecentMinutes")) {
      applyActivityRecentPeriod(incoming.activityRecentMinutes, { update: true });
    }
    if (Object.hasOwn(incoming, "streamOrderMode")) {
      applyStreamOrderMode(incoming.streamOrderMode, { update: true });
    }
    window.AgentHubStreamTabs.applyStreamCardSettings(incoming);
    renderOptions();
    if (pinnedWorkspaceStreamsChanged) {
      renderStreamTabs();
      renderActivityRail();
    }
    if (state.selectedId) renderChat();
    else renderComposerQuickMessages();
    if (claudeUsageChanged && journalHtml) void renderJournal();
  },
  setSelectionPending(key, pending, mutationId = "") {
    const normalizedKey = String(key ?? "").trim();
    if (!normalizedKey) return;
    const normalizedMutationId = String(mutationId ?? "").trim();
    if (normalizedKey === "quickMessages" && normalizedMutationId) {
      if (pending) quickMessagePendingMutationIds.add(normalizedMutationId);
      else quickMessagePendingMutationIds.delete(normalizedMutationId);
      if (quickMessagePendingMutationIds.size) state.pendingSelections.add(normalizedKey);
      else state.pendingSelections.delete(normalizedKey);
    } else if (pending) state.pendingSelections.add(normalizedKey);
    else state.pendingSelections.delete(normalizedKey);
    if (normalizedKey === "quickMessages" && !pending) settleQuickMessagesSelection(mutationId);
    renderOptions();
    /* Редактор шаблонов теперь один на все области, поэтому снятие блокировки
       перерисовывает его целиком, а не только карточку Workspace. */
    if (normalizedKey === "quickMessages") renderQuickMessageSettingsControls();
  },
  rejectSelection(key, mutationId = "") {
    if (String(key ?? "") === "quickMessages") rejectQuickMessagesSelection(mutationId);
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
  /** Учётный расход завершённых ходов из ledger Agent Hub и синхронизации устройств. */
  setUsageHistory(payload) {
    applyUsageHistory(payload);
  },
  /** Сопоставление учётного расхода с изменением лимитов API. */
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
    lastServerPayload = payload ?? {};
    if (root.dataset.view === "server") renderServerStatus(lastServerPayload);
  },
  /** Попытка и ссылка входа из локального ответа на запуск; снапшот их не содержит. */
  setProviderLoginUrl(provider, { attemptId = null, authUrl = null } = {}) {
    providerLoginCodeDrafts.delete(provider);
    if (attemptId) providerLoginLocal.set(provider, { attemptId: String(attemptId), authUrl });
    else providerLoginLocal.delete(provider);
    providerLoginRenderKey = "";
    if (root.dataset.view === "server" && lastServerPayload) renderServerStatus(lastServerPayload);
  },
  openAttachmentViewer,
  attachmentViewerLoadAuthority,
  showAttachmentViewer,
  failAttachmentViewer,
  closeAttachmentViewer,
  openStream(workspaceId, streamId) {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    const normalizedStreamId = String(streamId ?? "").trim();
    const streams = workspaceStreams(state.tasks.filter((task) => (
      workspaceKey(task) === normalizedWorkspaceId
    )));
    const stream = streams.find((candidate) => candidate.id === normalizedStreamId);
    const target = representativeStreamTask(stream);
    if (!target) {
      showToast("Stream недоступен");
      return false;
    }
    state.openStreamsByWorkspace.set(normalizedWorkspaceId, [normalizedStreamId]);
    state.configuredOpenStreamWorkspaces.add(normalizedWorkspaceId);
    selectTaskFromUi(target.id);
    return true;
  },
  showSelectedTask() {
    setView("chat");
    setPane("chat");
  },
  addSelectedAnnotation() {
    return addAnnotation(selectedQuotableSelection() || lastAnnotationSelection);
  },
  navigateBack,
  toast: showToast,
};

window.AgentHub = AgentHub;

/* ============================================= статистика и история лимитов */
/* Страница открывается отдельной вкладкой или по сводке лимитов в шапке и
 * показывает учётный расход вместе с SVG-графиком лимитов. Данные о
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
    limitsSpeedNote.hidden = limitsState.mode !== "speed";
    limitsSpeedNote.textContent = "Основная линия показывает сглаженный текущий темп с чувствительностью около 3 часов, длинный пунктир — средний темп за последние 24 часа, мелкий пунктир — допустимый темп по остатку и времени до сброса. Допустимый темп не меняет масштаб графика: значения выше шкалы прижимаются к верхней границе. Простои снижают текущий темп, а сброс лимита не обрывает историю и не создаёт нулевую точку. Пока доступно меньше суток истории, среднее отмечается как предварительное. Горизонтальная линия — ровный расход 14,3% в сутки.";
  }
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
  const current = String(payload?.currentAccount?.key ?? "");
  const resolved = resolveStatisticsAccountSelection({
    availableAccountKeys: accounts.map((account) => account.key),
    selectedAccountKey: statisticsAccountState.accountKey,
    currentAccountKey: current,
    previousCurrentAccountKey: statisticsAccountState.currentAccountKey,
    allAccountsKey: ALL_STATISTICS_ACCOUNTS,
  });
  statisticsAccountState.accountKey = resolved;
  statisticsAccountState.currentAccountKey = current;
  try {
    if (resolved) {
      localStorage.setItem(STATISTICS_ACCOUNT_KEY, resolved);
    }
    if (current) localStorage.setItem(STATISTICS_CURRENT_ACCOUNT_KEY, current);
  } catch {
    // Выбор останется активным до закрытия WebView.
  }
  return resolved;
}

document.addEventListener("agenthub:stream-card-settings-change", (event) => {
  const key = String(event.detail?.key ?? "");
  if (!["activityRecentMinutes", "streamCardWidthMode", "streamCardFixedWidth", "streamCardGapEnabled"].includes(key)) return;
  const value = key === "activityRecentMinutes"
    ? normalizedActivityRecentMinutes(event.detail?.value)
    : event.detail?.value;
  if (key === "activityRecentMinutes") applyActivityRecentPeriod(value, { update: true });
  state.selection[key] = value;
  emit("selection:set", { key, value });
});

document.addEventListener("agenthub:stream-view-settings-change", (event) => {
  const key = String(event.detail?.key ?? "");
  const value = event.detail?.value;
  if (key === "streamStatusEffect") {
    applyStreamStatusEffect(value, { persist: true });
  } else if (key === "streamStatusStyle") {
    applyStreamStatusStyle(value, { persist: true });
  } else if (key === "activityStreamDetailedCards") {
    applyActivityStreamDetailedCards(value, { persist: true });
  } else if (key === "activityRailVisibility") {
    applyActivityRailVisibility(value, { persist: true });
  }
});

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
  requestUsageHistory(usageState.range, { force: true });
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
  const previousStatisticsAccount = statisticsAccountState.accountKey;
  limitsState.payload = data;
  limitsState.error = data?.error ? String(data.error) : "";
  limitsState.status = statusFromPayload(data);
  renderStatisticsAccountSelects(data);
  const statisticsAccountChanged = statisticsAccountState.accountKey !== previousStatisticsAccount;
  renderCurrentLimits();
  if (root.dataset.view === "statistics") {
    renderLimitsRanges();
    renderLimits();
    if (statisticsAccountChanged) {
      requestUsageHistory(usageState.range, { force: true });
      requestUsageComparison(comparisonState.range, { force: true });
    }
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
const BURN_RATE_CURRENT_HALF_LIFE_MS = 3 * 60 * 60_000;
const BURN_RATE_AVERAGE_WINDOW_MS = 24 * 60 * 60_000;
const BURN_RATE_RESET_SHIFT_TOLERANCE_MS = 30 * 60_000;
const {
  interpolateRateLimitGaps,
  limitPriceStatistics,
  meanSignedComparisonDeviation,
  recoverRateLimitResetGaps,
  selectCurrentLimitSeries,
  signedComparisonDeviations,
  smoothedRateLimitConsumption,
} = globalThis.AgentHubRateLimitSeries;

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

function sameLimitsSpeedSegment(left, right) {
  const hasPathSegments = Number.isInteger(left?.pathSegmentIndex)
    && Number.isInteger(right?.pathSegmentIndex);
  const sameContinuity = Number.isInteger(left?.continuityIndex)
    && Number.isInteger(right?.continuityIndex)
    && left.continuityIndex === right.continuityIndex;
  return sameContinuity
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

function limitsFiniteSpeedPoints(points, field = "actualRate") {
  let pathSegmentIndex = 0;
  let previousWasFinite = false;
  return (Array.isArray(points) ? points : []).flatMap((point) => {
    if (!Number.isFinite(point?.[field])) {
      previousWasFinite = false;
      return [];
    }
    if (!previousWasFinite) pathSegmentIndex += 1;
    previousWasFinite = true;
    return [{ ...point, pathSegmentIndex }];
  });
}

function weeklyBurnRatePoints(series, options = {}) {
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
    const previous = points[index - 1];
    const resetAdvanceMs = previous ? points[index].resetMs - previous.resetMs : 0;
    const crossedPreviousReset = previous
      && previous.resetMs > previous.atMs
      && previous.resetMs <= points[index].atMs;
    const advancedByFullWindow = previous
      && Math.abs(resetAdvanceMs - durationMs) <= BURN_RATE_RESET_SHIFT_TOLERANCE_MS;
    const scheduledReset = Boolean(crossedPreviousReset && advancedByFullWindow);
    const earlyReset = previous
      && points[index].usedPercent < previous.usedPercent
      && resetAdvanceMs > BURN_RATE_RESET_SHIFT_TOLERANCE_MS;
    const startsAfterReset = Boolean(scheduledReset || earlyReset);
    const cycleStartMs = scheduledReset ? previous.resetMs : points[index].resetMs - durationMs;
    const previousAccount = String(points[index - 1]?.raw?.accountKey ?? "");
    const currentAccount = String(points[index]?.raw?.accountKey ?? "");
    const startsAfterAccountChange = index > 0
      && previousAccount
      && currentAccount
      && previousAccount !== currentAccount;
    if (startsAfterReset || startsAfterAccountChange) cycleIndex += 1;
    points[index].cycleIndex = cycleIndex;
    points[index].startsAfterReset = startsAfterReset;
    points[index].cycleStartMs = cycleStartMs;
  }

  return smoothedRateLimitConsumption(points, {
    currentHalfLifeMs: BURN_RATE_CURRENT_HALF_LIFE_MS,
    averageWindowMs: BURN_RATE_AVERAGE_WINDOW_MS,
    ratePeriodMs: WEEK_MILLISECONDS,
    ...options,
  }).map((point) => {
    const remainingMs = point.resetMs - point.atMs;
    const targetRate = Math.max(0, point.remainingPercent) / remainingMs * WEEK_MILLISECONDS;
    const actualRate = point.currentRate;
    const deviationRate = Number.isFinite(actualRate) ? actualRate - targetRate : null;
    return {
      ...point,
      durationMs,
      cycleAgeMs: Math.max(0, point.atMs - (point.resetMs - durationMs)),
      targetRate,
      actualRate,
      deviationRate,
      overTarget: Number.isFinite(deviationRate) ? deviationRate > 0 : false,
    };
  });
}

function limitsSpeedChartScale(series, normalWeeklyRate = 100) {
  const normalDailyRate = Math.max(0, Number(normalWeeklyRate) || 0) / 7;
  const visibleDailyRates = (Array.isArray(series) ? series : []).flatMap((item) => (
    Array.isArray(item?.ratePoints) ? item.ratePoints : []
  ).flatMap((point) => [
    Number.isFinite(point.actualRate) ? point.actualRate / 7 : null,
    Number.isFinite(point.averageRate) ? point.averageRate / 7 : null,
  ])).filter(Number.isFinite);
  const maximumDailyRate = Math.max(normalDailyRate, ...visibleDailyRates);
  const roughStep = maximumDailyRate / 4;
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(1, roughStep)));
  const normalizedStep = roughStep / magnitude;
  const tickStep = (normalizedStep <= 1 ? 1 : normalizedStep <= 2 ? 2 : normalizedStep <= 5 ? 5 : 10)
    * magnitude;
  return {
    chartMaximum: Math.max(tickStep, Math.ceil(maximumDailyRate / tickStep) * tickStep),
    maximumDailyRate,
    normalDailyRate,
    tickStep,
  };
}

function limitsSpeedChartRate(weeklyRate, chartMaximum) {
  const dailyRate = Math.max(0, Number(weeklyRate) || 0) / 7;
  const maximum = Math.max(0, Number(chartMaximum) || 0);
  return {
    dailyRate,
    offScale: dailyRate > maximum,
    plottedDailyRate: Math.min(dailyRate, maximum),
  };
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
  return selectCurrentLimitSeries(payload);
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
            el("span", {
              class: "current-limit-name",
              text: item.windowLabel ? `${item.label} · ${item.windowLabel}` : item.label,
            }),
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
  return window.AgentHubCommandTrace.measure("ui-render", "limits", renderLimitsContent);
}

function renderLimitsContent() {
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
        ratePoints: weeklyBurnRatePoints(item),
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
  const { chartMaximum, tickStep } = limitsSpeedChartScale(series);
  const yOf = (weeklyRate) => {
    const { plottedDailyRate } = limitsSpeedChartRate(weeklyRate, chartMaximum);
    return padT + (1 - plottedDailyRate / chartMaximum) * plotH;
  };
  const svg = svgEl("svg", {
    viewBox: `0 0 ${W} ${H}`,
    class: "limits-chart-svg limits-speed-chart-svg",
    preserveAspectRatio: "none",
    "aria-hidden": "true",
  });

  for (let value = 0; value <= chartMaximum + tickStep / 2; value += tickStep) {
    const y = yOf(value * 7);
    svg.append(svgEl("line", { x1: padL, y1: y, x2: W - padR, y2: y, class: "limits-grid-line" }));
    svg.append(svgEl("text", {
      x: padL - 6,
      y: y + 3,
      class: "limits-axis-label limits-axis-y",
      "text-anchor": "end",
    }, [new Intl.NumberFormat("ru-RU", { maximumFractionDigits: value < 10 ? 1 : 0 }).format(value)]));
  }
  svg.append(svgEl("text", {
    x: padL,
    y: padT + 9,
    class: "limits-axis-label limits-speed-unit",
  }, ["% / сутки"]));

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
  }, ["Ровный темп · 14,3%/сутки"]));

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
    const targetPoints = limitsFiniteSpeedPoints(item.ratePoints, "targetRate")
      .map((point) => ({ ...point, x: xOf(point.atMs), y: yOf(point.targetRate) }));
    if (targetPoints.length) {
      const targetOffScale = targetPoints.some((point) => (
        limitsSpeedChartRate(point.targetRate, chartMaximum).offScale
      ));
      svg.append(svgEl("path", {
        d: limitsSpeedPath(targetPoints),
        class: `limits-burn-target-line${targetOffScale ? " is-off-scale" : ""}`,
        fill: "none",
        stroke: item.color,
      }));
    }
    const averagePoints = limitsFiniteSpeedPoints(item.ratePoints, "averageRate")
      .map((point) => ({ ...point, x: xOf(point.atMs), y: yOf(point.averageRate) }));
    for (let index = 1; index < averagePoints.length; index += 1) {
      const left = averagePoints[index - 1];
      const right = averagePoints[index];
      if (!sameLimitsSpeedSegment(left, right)) continue;
      svg.append(svgEl("line", {
        x1: left.x,
        y1: left.y,
        x2: right.x,
        y2: right.y,
        class: `limits-burn-average-segment${right.averagePreliminary ? " is-preliminary" : ""}`,
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
        class: `limits-burn-rate-segment ${right.overTarget ? "is-over-target" : "is-safe"}${
          right.currentPreliminary ? " is-preliminary" : ""
        }`,
      }));
    }
    const markerPoints = limitsMarkerPoints(actualPoints.filter((point) => !point.resetBoundary));
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
        averageRate: point.averageRate,
        averageSpanMs: point.averageSpanMs,
        averagePreliminary: point.averagePreliminary,
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
        ? `${item.name || item.id}: сейчас ${formatLimitRateForPeriod(last.actualRate)}% в сутки, за 24 часа ${formatLimitRateForPeriod(last.averageRate)}%`
        : `${item.name || item.id}: недостаточно истории для фактической скорости`;
    }).join("; ")
    : allSeries.length ? "все недельные серии скрыты" : "нет недельных лимитов";
  limitsChart.setAttribute("aria-label", `Скорость расхода недельных лимитов. ${summary}.`);
  limitsChart.replaceChildren(svg);
  return allSeries;
}

function formatLimitRateForPeriod(weeklyRate) {
  const periodRate = Math.max(0, Number(weeklyRate) || 0) / 7;
  return new Intl.NumberFormat("ru-RU", {
    maximumFractionDigits: periodRate < 10 ? 1 : 0,
    minimumFractionDigits: periodRate > 0 && periodRate < 10 ? 1 : 0,
  }).format(periodRate);
}

function burnRatePeriodSuffix() {
  return "%/сутки";
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
      point: item.ratePoints?.findLast((point) => Number.isFinite(point.actualRate)),
    }))
    .filter(({ point }) => point);
  if (!items.length) {
    limitsSpeedSummary.hidden = true;
    limitsSpeedSummary.replaceChildren();
    return;
  }
  const cards = items.map(({ item, point }) => {
    const name = [item.name || item.baseId || item.id, item.window].filter(Boolean).join(" · ");
    const actualPeriod = formatLimitRateForPeriod(point.actualRate);
    const averagePeriod = formatLimitRateForPeriod(point.averageRate);
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
        Number.isFinite(point.averageRate)
          ? el("span", {}, [
            point.averagePreliminary
              ? `Среднее за ${formatBurnRateSampleSpan(point.averageSpanMs)} (предв.) `
              : "За 24 часа ",
            el("strong", { text: `${averagePeriod}${periodSuffix}` }),
          ])
          : null,
        el("span", {}, ["Допустимо ", el("strong", { text: `${targetPeriod}${periodSuffix}` })]),
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
          text: `сейчас ${formatLimitRateForPeriod(rate.actualRate)}%/сутки · 24 ч ${formatLimitRateForPeriod(rate.averageRate)}%/сутки`,
          title: "Сглаженный текущий темп и средний темп за 24 часа",
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
    const actualPeriod = formatLimitRateForPeriod(info.actualRate);
    const averagePeriod = formatLimitRateForPeriod(info.averageRate);
    const targetPeriod = formatLimitRateForPeriod(info.targetRate);
    const periodSuffix = burnRatePeriodSuffix();
    const deviation = (Number(info.actualRate) - Number(info.targetRate)) / 7;
    const status = deviation > 0
      ? `выше допустимой на ${formatLimitRateForPeriod(deviation * 7)}${periodSuffix}`
      : `запас ${formatLimitRateForPeriod(Math.abs(deviation) * 7)}${periodSuffix}`;
    const name = info.window ? `${info.name} · ${info.window}` : info.name;
    const estimate = info.estimated ? ". Оценка по соседним замерам" : "";
    const average = Number.isFinite(info.averageRate)
      ? `, среднее ${averagePeriod}${periodSuffix}${info.averagePreliminary ? ` за ${formatBurnRateSampleSpan(info.averageSpanMs)}` : " за 24 часа"}`
      : "";
    return `${name}. ${time}: сейчас ${actualPeriod}${periodSuffix}${average}, допустимо ${targetPeriod}${periodSuffix}, ${status}${estimate}`;
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
    const actualPeriod = formatLimitRateForPeriod(info.actualRate);
    const averagePeriod = formatLimitRateForPeriod(info.averageRate);
    const targetPeriod = formatLimitRateForPeriod(info.targetRate);
    const periodSuffix = burnRatePeriodSuffix();
    const deviation = (Number(info.actualRate) - Number(info.targetRate)) / 7;
    limitsTooltip.replaceChildren(
      el("span", { class: "limits-tooltip-title", text: info.window ? `${info.name} · ${info.window}` : info.name }),
      el("span", { class: "limits-tooltip-time", text: formatLimitsDateTime(info.at) }),
      el("span", { class: "limits-tooltip-row", text: `Сейчас ${actualPeriod}${periodSuffix} · допустимо ${targetPeriod}${periodSuffix}` }),
      Number.isFinite(info.averageRate)
        ? el("span", { class: "limits-tooltip-row", text: info.averagePreliminary
          ? `Среднее ${averagePeriod}${periodSuffix} за ${formatBurnRateSampleSpan(info.averageSpanMs)} · предварительно`
          : `Среднее за 24 часа ${averagePeriod}${periodSuffix}` })
        : null,
      el("span", {
        class: `limits-tooltip-row limits-speed-deviation${deviation > 0 ? " is-over-target" : " is-safe"}`,
        text: deviation > 0
          ? `Выше допустимой на ${formatLimitRateForPeriod(deviation * 7)}${periodSuffix}`
          : `Запас ${formatLimitRateForPeriod(Math.abs(deviation) * 7)}${periodSuffix}`,
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

/* ------------------------------------------------ учётный расход / единицы */

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
  if (String(data?.accountKey ?? "")) return;
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
    && !String(usageState.payload.accountKey ?? "")
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

function usageHistoryDevices(source) {
  const devices = (Array.isArray(source?.devices) ? source.devices : [])
    .map((device) => ({
      deviceId: String(device?.deviceId ?? "").trim(),
      label: String(device?.label ?? "").trim() || "Устройство",
      source: device?.source === "local" ? "local" : "sync",
      credits: Math.max(0, Number(device?.credits) || 0),
      timedCredits: Math.max(0, Number(device?.timedCredits) || 0),
      durationSeconds: Math.max(0, Number(device?.durationSeconds) || 0),
    }))
    .filter((device) => device.deviceId);
  if (devices.length) return devices;
  return [{
    deviceId: "local",
    label: "Это устройство",
    source: "local",
    credits: Math.max(0, Number(source?.localCredits ?? source?.credits ?? source?.totalCredits) || 0),
    timedCredits: Math.max(0, Number(source?.localTimedCredits ?? source?.timedCredits) || 0),
    durationSeconds: Math.max(0, Number(source?.localDurationSeconds ?? source?.durationSeconds) || 0),
  }];
}

function usageDeviceColorSlot(index) {
  return Math.max(0, Number(index) || 0) % SERIES_PALETTE.length;
}

function usageDeviceBurnRateAnalysis(payload, deviceId) {
  const calculator = globalThis.AgentHubUsageBurnRate?.buildUsageBurnRate;
  if (typeof calculator !== "function") return null;
  const total = usageHistoryDevices(payload).find((device) => device.deviceId === deviceId);
  return calculator({
    ...payload,
    totalCredits: total?.credits ?? 0,
    totalTimedCredits: total?.timedCredits ?? 0,
    totalDurationSeconds: total?.durationSeconds ?? 0,
    points: (Array.isArray(payload?.points) ? payload.points : []).map((point) => {
      const device = usageHistoryDevices(point).find((entry) => entry.deviceId === deviceId);
      return {
        ...point,
        credits: device?.credits ?? 0,
        timedCredits: device?.timedCredits ?? 0,
        durationSeconds: device?.durationSeconds ?? 0,
        taskDurationSeconds: device?.durationSeconds ?? 0,
      };
    }),
  });
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

function usagePointMetric(value) {
  if (usageState.mode === "rate") return `${formatUsageValue(value)}/ч`;
  if (usageState.mode === "intensity") return `${formatUsageValue(value)}/мин`;
  return formatUsageValue(value);
}

function showUsageTooltip(point, fx, fy, daily = false, hours = 0) {
  if (!usageTooltip) return;
  const total = usageChartValue(point, hours);
  const deviceValues = usageChartDeviceValues(point, hours).filter((device) => device.value > 0);
  usageTooltip.replaceChildren(
    el("span", { class: "limits-tooltip-time", text: formatUsagePointDate(point, daily) }),
    el("span", {
      class: "limits-tooltip-row",
      text: `Всего: ${usagePointMetric(total)}`,
    }),
    ...deviceValues.map((device) => el("span", { class: "limits-tooltip-row" }, [
      el("i", {
        class: "usage-device-swatch",
        "data-device-color": device.colorSlot,
      }),
      document.createTextNode(`${device.label}: ${usagePointMetric(device.value)}`),
    ])),
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

function usageChartValue(point, hours) {
  if (usageState.mode === "rate") {
    const rateHours = usageRateHours(point, hours);
    return rateHours > 0 ? usageRateCredits(point) / rateHours : 0;
  }
  return usageState.mode === "intensity" ? point.emaRate : point.credits;
}

function usageChartDeviceValues(point, hours) {
  const rateHours = usageRateHours(point, hours);
  return (Array.isArray(point?.devices) ? point.devices : []).map((device) => ({
    ...device,
    value: usageState.mode === "rate"
      ? (rateHours > 0
        ? (usageState.rateBasis === "task" ? device.timedCredits : device.credits) / rateHours
        : 0)
      : usageState.mode === "intensity" ? device.emaRate : device.credits,
  }));
}

function buildUsageChart(payload) {
  const burnAnalysis = usageState.mode === "intensity" ? usageBurnRateAnalysis(payload) : null;
  const devices = usageHistoryDevices(payload);
  const burnPointsByTime = new Map((burnAnalysis?.points ?? []).map((point) => [point.time, point]));
  const deviceBurnPoints = new Map(devices.map((device) => [
    device.deviceId,
    new Map((usageState.mode === "intensity"
      ? usageDeviceBurnRateAnalysis(payload, device.deviceId)?.points ?? []
      : []).map((point) => [point.time, point])),
  ]));
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
        devices: devices.map((device, index) => {
          const bucket = usageHistoryDevices(point).find((entry) => entry.deviceId === device.deviceId);
          return {
            ...device,
            credits: bucket?.credits ?? 0,
            timedCredits: bucket?.timedCredits ?? 0,
            durationSeconds: bucket?.durationSeconds ?? 0,
            emaRate: Math.max(0, Number(deviceBurnPoints.get(device.deviceId)?.get(time)?.emaRate) || 0),
            colorSlot: usageDeviceColorSlot(index),
          };
        }),
        rawRate: Math.max(0, Number(burnPoint?.rawRate) || 0),
        emaRate: Math.max(0, Number(burnPoint?.emaRate) || 0),
      };
    })
    .filter((point) => Number.isFinite(point.time));
  const daily = payload?.bucket === "day";
  const rate = usageState.mode === "rate";
  const intensity = usageState.mode === "intensity";
  const hours = usageBucketHours(payload);
  const valueOf = (point) => usageChartValue(point, hours);
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
      const totalValue = valueOf(point);
      const deviceValues = usageChartDeviceValues(point, hours);
      const height = totalValue / max * plotH;
      const x = padL + index * barStep + (barStep - barWidth) / 2;
      const y = padT + plotH - height;
      const group = svgEl("g", { class: "usage-bar-group" });
      let stackedValue = 0;
      for (const device of deviceValues) {
        if (!(device.value > 0)) continue;
        const segmentHeight = device.value / max * plotH;
        stackedValue += device.value;
        group.append(svgEl("rect", {
          x: x.toFixed(1),
          y: (padT + plotH - (stackedValue / max * plotH)).toFixed(1),
          width: barWidth.toFixed(1),
          height: Math.max(1, segmentHeight).toFixed(1),
          rx: Math.min(4, barWidth / 3).toFixed(1),
          class: "usage-bar usage-bar-device",
          "data-device-color": device.colorSlot,
        }));
      }
      const deviceAria = deviceValues
        .filter((device) => device.value > 0)
        .map((device) => `${device.label} ${usagePointMetric(device.value)}`)
        .join(", ");
      const hit = svgEl("rect", {
        x: x.toFixed(1),
        y: y.toFixed(1),
        width: barWidth.toFixed(1),
        height: Math.max(1, height).toFixed(1),
        class: "usage-bar-hit",
        tabindex: 0,
        role: "img",
        "aria-label": `${formatLimitsDateTime(point.at)}: всего ${usagePointMetric(totalValue)}${
          deviceAria ? `, ${deviceAria}` : ""
        }`,
      });
      const fx = (x + barWidth / 2) / W;
      const fy = y / H;
      hit.addEventListener("pointerenter", () => showUsageTooltip(point, fx, fy, daily, hours));
      hit.addEventListener("pointerleave", hideUsageTooltip);
      hit.addEventListener("focus", () => showUsageTooltip(point, fx, fy, daily, hours));
      hit.addEventListener("blur", hideUsageTooltip);
      group.append(hit);
      svg.append(group);
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
    const lineFor = (valueGetter) => points
      .map((point, index) => {
        const command = index ? "L" : "M";
        return `${command}${xOf(point.time).toFixed(1)} ${yOf(valueGetter(point)).toFixed(1)}`;
      })
      .join(" ");
    const cumulativeValue = (point, lastDeviceIndex) => usageChartDeviceValues(point, hours)
      .slice(0, lastDeviceIndex + 1)
      .reduce((sum, device) => sum + device.value, 0);
    for (const [deviceIndex, device] of devices.entries()) {
      if (!points.some((point) => usageChartDeviceValues(point, hours)[deviceIndex]?.value > 0)) continue;
      const upperValue = (point) => cumulativeValue(point, deviceIndex);
      const lowerValue = (point) => deviceIndex ? cumulativeValue(point, deviceIndex - 1) : 0;
      const upperLine = lineFor(upperValue);
      const reverseLowerLine = [...points].reverse().map((point) => (
        `L${xOf(point.time).toFixed(1)} ${yOf(lowerValue(point)).toFixed(1)}`
      )).join(" ");
      svg.append(svgEl("path", {
        d: `${upperLine} ${reverseLowerLine} Z`,
        class: "usage-device-area",
        "data-device-color": usageDeviceColorSlot(deviceIndex),
      }));
      svg.append(svgEl("path", {
        d: upperLine,
        class: "usage-device-line",
        fill: "none",
        "data-device-color": usageDeviceColorSlot(deviceIndex),
      }));
    }
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
      const topDevice = usageChartDeviceValues(point, hours).filter((device) => device.value > 0).at(-1);
      const dot = svgEl("circle", {
        cx,
        cy,
        r: 2.6,
        class: "usage-dot",
        "data-device-color": topDevice?.colorSlot ?? 0,
      });
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
        : `Учётный расход: ${formatUsageValue(payload.totalCredits)} за ${formatUsagePeriod(payload)}.`,
  );
  svg.style.width = "100%";
  usageChart.replaceChildren(svg);
}

function renderUsageHistory() {
  return window.AgentHubCommandTrace.measure("ui-render", "usage-history", renderUsageHistoryContent);
}

function renderUsageHistoryContent() {
  if (!usageLoading) return;
  const status = usageState.status;
  usageLoading.hidden = status !== "loading";
  usageError.hidden = status !== "error";
  usageEmpty.hidden = status !== "empty";
  usageChartWrap.hidden = status !== "ready";
  hideUsageTooltip();
  if (status === "error") {
    usageErrorText.textContent = usageState.error || "Не удалось загрузить учётный расход.";
  }
  const payload = usageState.payload;
  const rate = usageState.mode === "rate";
  const intensity = usageState.mode === "intensity";
  const burnAnalysis = intensity && payload && !payload.error ? usageBurnRateAnalysis(payload) : null;
  if (usageTitle) {
    usageTitle.textContent = rate
      ? "Скорость учётного расхода"
      : intensity
        ? "Поглощение учётного расхода"
        : "Учётный расход";
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
    const scopeNote = "Учтён весь локальный расход; расход других устройств — только в интервалы активности того же аккаунта на этом компьютере.";
    if (intensity) {
      usageNote.textContent = burnAnalysis?.forecastAvailable
        ? `${scopeNote} EMA считает календарный темп расхода cr/мин; прогноз суток не использует неизвестные лимиты Codex или Claude.`
        : `${scopeNote} EMA считает календарный темп cr/мин. Суточный прогноз показывается только на диапазоне 24 ч, где известен расход с полуночи.`;
    } else {
      renderUsageBurnSummary(null, null);
      const unpriced = Math.max(0, Number(payload.unpricedCount) || 0);
      const untimed = Math.max(0, Number(payload.untimedCount ?? payload.untimedCreditCount) || 0);
      const notes = [];
      const syncedDevices = usageHistoryDevices(payload)
        .filter((device) => device.source === "sync" && device.credits > 0);
      if (syncedDevices.length) {
        notes.push(`Отдельные цвета устройств: ${syncedDevices.map((device) => (
          `${device.label} — ${formatUsageValue(device.credits)}`
        )).join("; ")}.`);
      }
      if (unpriced) notes.push(`Без тарифа и вне суммы: ${unpriced}.`);
      if (rate && usageState.rateBasis === "task" && untimed) {
        notes.push(`Без длительности и вне скорости по времени задач: ${untimed}.`);
      }
      usageNote.textContent = `${scopeNote} ${notes.join(" ") || "Все показанные ходы тарифицированы и имеют длительность."}`;
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

/* --------------------------------------- сопоставление учётного и API расхода */

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
      tokenCredits: Math.max(0, Number(point.tokenCredits ?? point.credits) || 0),
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

function comparisonReconstructionBuckets(payload, extent) {
  const step = Math.max(1, Number(payload?.bucketMs) || 0);
  if (!(step > 1)) return [];
  return (Array.isArray(payload?.points) ? payload.points : []).map((point) => {
    const start = Date.parse(point?.at ?? "");
    return {
      start,
      end: start + step,
      credits: Math.max(0, Number(point?.credits) || 0),
      tokenCredits: Math.max(0, Number(point?.tokenCredits ?? point?.credits) || 0),
    };
  }).filter((bucket) => (
    Number.isFinite(bucket.start)
    && bucket.end > extent.from
    && bucket.start < extent.to
    && bucket.credits > 0
  ));
}

function limitDeltasByBucket(series, buckets, accountingValues = [], reconstructionBuckets = []) {
  return recoverRateLimitResetGaps(series?.points, buckets, accountingValues, reconstructionBuckets);
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
  const midpoint = buckets.findIndex((bucket) => bucket.time >= (
    buckets[0].time + (buckets.at(-1).time - buckets[0].time) / 2
  ));
  const split = midpoint > 0 ? midpoint : Math.ceil(buckets.length / 2);
  return limitPriceStatistics(localValues, apiValues, { splitIndex: split });
}

function buildUsageComparisonModel(payload) {
  const extent = comparisonHistoryExtent(payload);
  if (!extent) return null;
  const buckets = comparisonBuckets(payload.usage, extent);
  if (!buckets.length) return null;
  const localRaw = buckets.map((bucket) => bucket.credits);
  const priceLocalRaw = buckets.map((bucket) => bucket.tokenCredits);
  const reconstructionBuckets = comparisonReconstructionBuckets(payload?.usage?.reconstruction, extent)
    .map((bucket) => ({ ...bucket, credits: bucket.tokenCredits }));
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
      const recovery = limitDeltasByBucket(item, buckets, priceLocalRaw, reconstructionBuckets);
      const rawValues = recovery.values;
      const normalized = normalizeComparisonValues(rawValues);
      return {
        ...item,
        id,
        color: seriesColor(item, index),
        peak: normalized.peak,
        rawValues,
        recovery,
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
    ? comparisonLimitPrice(priceLocalRaw, selectedSeries.rawValues, buckets)
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
    name: "Учётный расход",
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
    `Сопоставление учётного и API-расхода. Корреляция ${correlation}; среднее отклонение ${
      Number.isFinite(model.deviation) ? `${formatComparisonNumber(model.deviation, 1, true)} процентного пункта` : "не рассчитано"
    }; средняя цена ${
      Number.isFinite(model.price.overall?.value)
        ? `${formatComparisonNumber(model.price.overall.value, 2)} процентного пункта на kcr`
        : "не рассчитана"
    }; расчётный недельный лимит ${
      Number.isFinite(model.price.weeklyCredits)
        ? formatUsageValue(model.price.weeklyCredits)
        : "не рассчитан"
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
  }, [`Учётный расход, ${comparisonUsageUnitLabel()}`]));
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
      detail: `лимит +${formatComparisonNumber(point.x, 1)} п.п.; учётный ${formatUsageValue(point.y)}`,
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
      name: "Разность аккаунт − учётный",
      at,
      detail: `${formatComparisonNumber(value, 1, true)} п.п.; ${value >= 0 ? "аккаунт выше" : "учётный расход выше"}`,
    };
    rect.addEventListener("pointerenter", () => showComparisonTooltip(info, x / W, valueY / H, svg));
    rect.addEventListener("pointerleave", hideComparisonTooltip);
    svg.append(rect);
  });
  const largest = Math.max(0, ...values.filter(Number.isFinite).map(Math.abs));
  comparisonDifferenceChart.setAttribute(
    "aria-label",
    `Разность нормированных расходов аккаунта и учётного расхода. Максимальное расхождение ${formatComparisonNumber(largest, 1)} процентного пункта.`,
  );
  comparisonDifferenceChart.replaceChildren(svg);
}

function buildUsageComparisonSplitCharts(model) {
  const series = model.selectedSeries;
  buildComparisonTimeChart(comparisonLocalChart, model, {
    values: model.local.rawValues,
    axisTitle: `Учётный расход, ${comparisonUsageUnitLabel()}`,
    color: "var(--comparison-local)",
    lineClass: "comparison-local-line",
    name: "Учётный расход",
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
  if (!Number.isFinite(price?.overall?.value)) return "недостаточно данных";
  const average = `${formatComparisonNumber(price.overall.value, 2)} п.п./kcr в среднем`;
  if (!Number.isFinite(price?.early?.value) || !Number.isFinite(price?.late?.value)) return average;
  const change = Number.isFinite(price.changePercent)
    ? ` · ${formatComparisonNumber(price.changePercent, 0, true)}%`
    : "";
  return `${average} · ${formatComparisonNumber(price.early.value, 2)} → ${formatComparisonNumber(price.late.value, 2)}${change}`;
}

function renderComparisonLegend(model) {
  if (!comparisonLegend) return;
  const entries = [
    comparisonSeriesPicker(model),
    comparisonLegendItem("Учётный расход", "var(--comparison-local)", `пик ${formatUsageValue(model.local.peak)}`),
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
  const averagePrice = Number.isFinite(model?.price?.overall?.value)
    ? `${formatComparisonNumber(model.price.overall.value, 2)} п.п./kcr`
    : "—";
  const weeklyLimit = Number.isFinite(model?.price?.weeklyCredits)
    ? `≈ ${formatUsageValue(model.price.weeklyCredits)}/нед.`
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
      title: `Средняя цена лимита и первая → вторая половина: ${comparisonPriceText(model?.price)}`,
    }, [
      el("span", { text: "Цена" }),
      el("strong", { text: averagePrice }),
    ]),
    el("span", {
      class: "comparison-metric",
      title: "Расчётный недельный лимит: 100 п.п. делятся на среднюю цену лимита",
    }, [
      el("span", { text: "Лимит" }),
      el("strong", { text: weeklyLimit }),
    ]),
  );
}

function renderUsageComparison() {
  return window.AgentHubCommandTrace.measure("ui-render", "usage-comparison", renderUsageComparisonContent);
}

function renderUsageComparisonContent() {
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
    const baseNote = split
      ? "Временные графики используют исходные единицы и общую ось дат. Точки показывают совпадающие интервалы. Разность считается как нормированный расход аккаунта минус учётный: выше нуля — больше расход лимита, ниже нуля — больше учётный расход. Изменение лимита между соседними замерами равномерно распределяется по их интервалу. Цена — взвешенная средняя по токенному расходу без фиксированных оценок ImageGen; расчётный недельный лимит равен 100 п.п., делённым на эту цену."
      : "При выборе аккаунта учётный расход включает его ходы на этом и всех синхронизированных устройствах. Пункт «Все» снимает отбор аккаунта. Изменение лимита между соседними замерами равномерно распределяется по их интервалу; неизменное значение считается нулевым расходом. Линии расхода приведены к собственному пику. r — корреляция Пирсона, Δ — среднее знаковое отклонение «аккаунт − учётный»: минусы и плюсы взаимно компенсируются. Цена — взвешенная средняя: весь расход лимита делится на весь токенный расход; фиксированные оценки ImageGen не учитываются. Расчётный недельный лимит равен 100 п.п., делённым на эту цену. Изменение цены сравнивает первую и вторую половины периода.";
    const recovery = model.selectedSeries?.recovery;
    const recoveryNote = recovery?.estimatedLimitPoints > 0
      ? ` Разрыв${recovery.recoveredIntervals === 1 ? "" : "ы"} со сбросом восстановлен${recovery.recoveredIntervals === 1 ? "" : "ы"} по токенному учётному расходу и цене соседних полных интервалов: ${formatComparisonNumber(recovery.estimatedLimitPoints, 1)} п.п.`
      : " Разрывы со сбросом без учётного расхода остаются неизвестными.";
    comparisonNote.textContent = baseNote + recoveryNote;
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
let currentJournalEtag = "";
let journalSyncDeviceLabelPromptInFlight = false;
const journalSyncDeviceLabelPrompted = new Set();
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
    virtualScopes: [...journal.querySelectorAll("details[data-journal-virtual-scope][open]")]
      .map((item) => item.dataset.journalVirtualScope)
      .filter(Boolean),
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
  for (const key of openState.virtualScopes ?? []) {
    journal.querySelector(
      `details[data-journal-virtual-scope="${selectorValue(key)}"]`,
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

let journalFragmentRefreshVersion = null;

function isSupersededJournalFragment(error) {
  return error?.code === "JOURNAL_FRAGMENT_SUPERSEDED";
}

async function fetchJournalFragment(pathname, params) {
  await localSessionReady;
  const requestedVersion = currentVersion;
  const query = new URLSearchParams({ ...params, version: requestedVersion });
  const response = await fetch(`${pathname}?${query}`, {
    cache: "no-store",
    headers: await authenticatedRequestHeaders(),
  });
  const payload = await response.json();
  if (requestedVersion !== currentVersion || response.status === 409
    || payload.version && payload.version !== requestedVersion) {
    // A fragment belongs to its requested snapshot. Refresh through the normal
    // owner once per stale version, never replay an old page into the new DOM.
    // Do not await this refresh: the current render may itself await a fragment.
    if (requestedVersion === currentVersion && journalFragmentRefreshVersion !== requestedVersion) {
      journalFragmentRefreshVersion = requestedVersion;
      void loadJournal({ force: true });
    }
    throw Object.assign(new Error("Журнал обновился."), { code: "JOURNAL_FRAGMENT_SUPERSEDED" });
  }
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  return payload;
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
      if (!isSupersededJournalFragment(error)) details.title = error.message;
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
      if (!isSupersededJournalFragment(error)) details.title = error.message;
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
        const entryProvider = String(
          entry.dataset.workLogTurnProvider ?? provider,
        ).trim().toLowerCase();
        if (state.selection.includeClaudeUsage !== false || entryProvider !== "claude") {
          const creditValue = entry.dataset.workLogTurnCredits;
          const credits = creditValue === undefined ? Number.NaN : Number(creditValue);
          if (Number.isFinite(credits) && credits >= 0) {
            group.credits += credits;
            group.knownCredits += 1;
          } else {
            group.unknownCredits += 1;
          }
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
let journalSyncLatestStatus = null;

async function hydrateAllLazyDays({ isCurrent = () => true } = {}) {
  const days = [...journal.querySelectorAll(
    "details[data-work-log-day-section][data-lazy-day]",
  )];
  return JournalView.hydrateLazyDays(days, {
    dateFor: (details) => details.dataset.lazyDay,
    cachedHtml: (date) => journalDayHtmlCache.get(date),
    fetchHtml: async (date) => (
      await fetchJournalFragment("/api/journal/day", { date })
    ).html,
    rememberHtml: (date, html) => journalDayHtmlCache.set(date, html),
    materialize: (details, html) => materializeLazyDay(details, html, {
      decorate: false,
      postProcess: false,
    }),
    isCurrent,
    yieldControl: () => new Promise((resolve) => requestAnimationFrame(() => resolve())),
    batchSize: 2,
  });
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

function currentWorkLogAccountPanel() {
  return JournalAccountPanel
    .freshAccountPanelSource(journal, statisticsAccountPanelHost)
    ?.cloneNode(true) ?? null;
}

let accountPanelRange = JournalAccountPanel.storedRange(localStorage);
let accountPanelDevices = JournalAccountPanel.storedExpandedAccounts(localStorage);

function accountPanelRanges(panel) {
  return [...panel.querySelectorAll("[data-work-log-account-period-tab]")]
    .map((tab) => tab.dataset.accountRange);
}

/* Кнопка шапки работает с аккаунтами показанного периода: в остальных периодах
   набор аккаунтов другой, а состояние раскрытия у аккаунта общее. */
function accountPanelAccountKeys(panel) {
  const body = panel.querySelector("[data-work-log-account-period-body][data-active]");
  return [...(body?.querySelectorAll("[data-work-log-account-row]:not([disabled])") ?? [])]
    .map((row) => row.dataset.accountKey)
    .filter(Boolean);
}

function applyAccountPanelState(panel) {
  const ranges = accountPanelRanges(panel);
  accountPanelRange = JournalAccountPanel.normalizeRange(accountPanelRange, ranges);
  panel.querySelector("[data-work-log-account-periods]")
    ?.style.setProperty("--account-period-count", String(ranges.length));
  for (const node of panel.querySelectorAll("[data-account-range]")) {
    const active = node.dataset.accountRange === accountPanelRange;
    node.toggleAttribute("data-active", active);
    if (node.matches("[data-work-log-account-period-tab]")) {
      node.setAttribute("aria-expanded", String(active));
    }
  }
  for (const group of panel.querySelectorAll("[data-work-log-account-group]")) {
    const row = group.querySelector("[data-work-log-account-row]");
    const expanded = Boolean(row) && !row.disabled
      && accountPanelDevices.includes(String(group.dataset.accountKey ?? ""));
    group.toggleAttribute("data-open", expanded);
    row?.setAttribute("aria-expanded", String(expanded));
  }
  const toggle = panel.querySelector("[data-work-log-account-devices-toggle]");
  if (toggle) {
    const keys = accountPanelAccountKeys(panel);
    toggle.textContent = JournalAccountPanel.devicesToggleLabel(accountPanelDevices, keys);
    toggle.setAttribute(
      "aria-pressed",
      String(JournalAccountPanel.allAccountsExpanded(accountPanelDevices, keys)),
    );
    toggle.disabled = keys.length === 0;
  }
}

/* Панель приходит готовой разметкой журнала, поэтому доли и крупные суммы
   расставляются здесь: CSP запрещает инлайновый style, а единица расхода
   переключается пользователем уже после проекции. */
function decorateAccountPanel(scope = journal) {
  const panel = scope.querySelector("[data-work-log-account-panel]");
  if (!panel) return;
  for (const segment of panel.querySelectorAll(
    "[data-work-log-account-bar-segment], [data-work-log-account-bar-device-fill]",
  )) {
    const share = Math.min(100, Math.max(0, Number(segment.dataset.accountShare) || 0));
    segment.style.setProperty("--account-share", `${share}%`);
    if ("accountOffset" in segment.dataset) {
      const offset = Math.min(100, Math.max(0, Number(segment.dataset.accountOffset) || 0));
      segment.style.setProperty("--account-offset", `${offset}%`);
    }
  }
  for (const value of panel.querySelectorAll("[data-work-log-account-period-value]")) {
    const credits = Number(value.dataset.accountCredits);
    const { amount, unit } = JournalAccountPanel.splitUsageAmount(
      Number.isFinite(credits) ? formatUsageValue(credits) : "",
    );
    const amountNode = value.querySelector("[data-work-log-account-period-amount]");
    const unitNode = value.querySelector("[data-work-log-account-period-unit]");
    if (amountNode) amountNode.textContent = amount;
    if (unitNode) unitNode.textContent = unit;
  }
  applyAccountPanelState(panel);
}

function mountStatisticsAccountPanel() {
  if (!statisticsAccountPanelHost) return;
  const panel = journal.querySelector(":scope > [data-work-log-account-panel]");
  if (panel) statisticsAccountPanelHost.replaceChildren(panel);
  else if (!statisticsAccountPanelHost.querySelector("[data-work-log-account-panel]")) {
    statisticsAccountPanelHost.replaceChildren();
  }
  decorateAccountPanel(statisticsAccountPanelHost);
}

function rememberAccountPanelDevices(panel, keys) {
  accountPanelDevices = JournalAccountPanel.persistExpandedAccounts(localStorage, keys);
  applyAccountPanelState(panel);
}

/* Делегирование переживает пересборку группировки: панель переносится клоном и
   собственные обработчики на плитках были бы потеряны. */
document.addEventListener("click", (event) => {
  const panel = event.target?.closest?.("[data-work-log-account-panel]");
  if (!panel) return;
  const tab = event.target.closest("[data-work-log-account-period-tab]");
  if (tab) {
    const ranges = accountPanelRanges(panel);
    accountPanelRange = JournalAccountPanel.persistRange(
      localStorage,
      tab.dataset.accountRange,
      ranges,
    );
    applyAccountPanelState(panel);
    return;
  }
  const row = event.target.closest("[data-work-log-account-row]");
  if (row && !row.disabled) {
    rememberAccountPanelDevices(
      panel,
      JournalAccountPanel.toggleExpandedAccount(accountPanelDevices, row.dataset.accountKey),
    );
    return;
  }
  if (event.target.closest("[data-work-log-account-devices-toggle]")) {
    rememberAccountPanelDevices(
      panel,
      JournalAccountPanel.toggleAllAccounts(accountPanelDevices, accountPanelAccountKeys(panel)),
    );
  }
});

function replaceJournalGroupedContent(content) {
  const accountPanel = currentWorkLogAccountPanel();
  if (accountPanel) journal.replaceChildren(accountPanel, content);
  else journal.replaceChildren(content);
  mountStatisticsAccountPanel();
}

function virtualUsageShare(value, total, known = true) {
  if (!known) return "";
  if (!(Number(total) > 0)) return " (0%)";
  const share = Math.max(0, Math.min(100, Number(value) / Number(total) * 100));
  return ` (${Math.round(share)}%)`;
}

function virtualStreamUsage(stream, workspace) {
  const usage = document.createElement("span");
  usage.dataset.workLogStreamUsage = "";
  const creditShare = stream.knownCredits
    ? virtualUsageShare(stream.credits, workspace.credits, workspace.knownCredits)
    : "";
  usage.append(
    stream.knownDurations
      ? el("span", {
        "data-work-log-stream-duration": "",
        text: `${formatTaskDuration(stream.durationSeconds)}${virtualUsageShare(
          stream.durationSeconds,
          workspace.durationSeconds,
          workspace.knownDurations,
        )}`,
      })
      : el("span", { "data-work-log-stream-duration": "", text: "время —" }),
    stream.knownCredits
      ? el("span", { "data-work-log-stream-credits": "" }, [
        usageBadge(formatUsageValue(stream.credits), stream.credits),
      ])
      : el("span", { text: "расход —" }),
    el("span", { "data-work-log-stream-credit-share": "", text: creditShare }),
  );
  return usage;
}

function virtualWorkspaceBreakdown(workspace) {
  const source = String(workspace.workspaceUsageHtml ?? "").trim();
  if (!source) return null;
  const template = document.createElement("template");
  template.innerHTML = source;
  const usage = template.content.querySelector("details[data-work-log-workspace-usage-details]");
  if (!usage) return null;
  usage.open = true;
  const breakdown = document.createElement("div");
  breakdown.dataset.journalDayBreakdown = "";
  breakdown.append(usage);
  return breakdown;
}

function applyVirtualTurnQuery(node, scope, workspace, stream = null) {
  const query = JournalView.virtualTurnQuery(scope, workspace, stream);
  node.dataset.journalVirtualTurns = "";
  node.dataset.virtualWorkspaceId = query.workspaceId;
  node.dataset.virtualStreamId = query.streamId;
  node.dataset.virtualProvider = query.provider;
  node.dataset.virtualFromMs = String(query.fromMs);
  node.dataset.virtualToMs = String(query.toMs);
  node.dataset.virtualDateKeys = query.dateKeys.join(",");
  if (scope.mode === "stream") node.dataset.virtualProfileMode = "stream";
}

function virtualTurnTable() {
  const table = document.createElement("div");
  table.dataset.journalTurnTable = "";
  return table;
}

function virtualStreamDetails(scope, workspace, stream) {
  const details = document.createElement("details");
  details.dataset.workLogStream = "";
  details.dataset.workLogStreamId = stream.id;
  details.dataset.workLogWorkspaceId = workspace.id;
  if (stream.providers.length === 1) {
    details.dataset.workLogProvider = stream.providers[0];
  }
  applyVirtualTurnQuery(details, scope, workspace, stream);
  const summary = document.createElement("summary");
  summary.dataset.workLogStreamSummary = "";
  const title = document.createElement("span");
  title.dataset.workLogStreamTitle = "";
  title.append(
    el("span", { "data-work-log-stream-name": "", text: stream.name }),
    el("span", {
      "data-work-log-stream-turn-count": "",
      text: `${Math.max(0, Number(stream.turnCount) || 0)} ход.${virtualUsageShare(
        stream.turnCount,
        workspace.turnCount,
      )}`,
    }),
  );
  summary.append(
    virtualStreamUsage(stream, workspace),
    title,
  );
  const body = document.createElement("div");
  body.dataset.workLogStreamTurns = "";
  body.append(virtualTurnTable());
  details.append(summary, body);
  return details;
}

function virtualWorkspaceTurns(scope, workspace) {
  const body = document.createElement("div");
  body.dataset.journalVirtualFlatTurns = "";
  applyVirtualTurnQuery(body, scope, workspace);
  body.append(virtualTurnTable());
  return body;
}

function virtualWorkspaceContent(scope, workspace) {
  if (!groupJournalTurnsByStream) return virtualWorkspaceTurns(scope, workspace);
  const streams = document.createElement("div");
  streams.dataset.workLogWorkspaceStreams = "";
  for (const stream of workspace.streams) {
    streams.append(virtualStreamDetails(scope, workspace, stream));
  }
  return streams;
}

function virtualTemporalContent(scope) {
  const expanded = document.createElement("div");
  expanded.dataset.journalDayExpanded = "";
  const picker = document.createElement("div");
  picker.dataset.journalDayPicker = "";
  picker.append(el("span", { "data-journal-section-label": "", text: "Workspace" }));
  const panels = document.createElement("div");
  panels.dataset.journalDayPanels = "";
  const remembered = journalDaySelections.get(scope.key);
  const selected = scope.workspaces.some((workspace) => workspace.id === remembered)
    ? remembered
    : scope.workspaces[0]?.id ?? "";
  if (selected) journalDaySelections.set(scope.key, selected);
  for (const workspace of scope.workspaces) {
    const active = workspace.id === selected;
    const item = document.createElement("div");
    item.dataset.journalDayPickerItem = "";
    item.toggleAttribute("data-selected", active);
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.journalDaySelect = workspace.id;
    button.setAttribute("aria-pressed", String(active));
    const credits = el("span", { "data-journal-day-picker-credits": "" });
    if (workspace.knownCredits) {
      credits.append(
        usageBadge(formatUsageValue(workspace.credits), workspace.credits),
        el("span", {
          "data-journal-day-picker-share": "",
          text: virtualUsageShare(workspace.credits, scope.credits, scope.knownCredits),
        }),
      );
    } else {
      credits.textContent = "—";
    }
    button.append(
      el("span", { "data-journal-day-picker-title": "", text: workspace.name }),
      el("span", {
        "data-journal-day-picker-turns": "",
        text: `${workspace.turnCount} ходов${virtualUsageShare(workspace.turnCount, scope.turnCount)}`,
      }),
      el("span", {
        "data-journal-day-picker-duration": "",
        text: workspace.knownDurations
          ? `${formatTaskDuration(workspace.durationSeconds)}${virtualUsageShare(
            workspace.durationSeconds,
            scope.durationSeconds,
            scope.knownDurations,
          )}`
          : "—",
      }),
      credits,
    );
    item.append(button);
    const breakdown = virtualWorkspaceBreakdown(workspace);
    if (breakdown) item.append(breakdown);
    picker.append(item);
    const panel = document.createElement("section");
    panel.dataset.journalDayPanel = workspace.id;
    panel.dataset.workLogWorkspace = "";
    panel.dataset.workLogWorkspaceId = workspace.id;
    panel.hidden = !active;
    panel.append(virtualWorkspaceContent(scope, workspace));
    panels.append(panel);
  }
  expanded.append(picker, panels);
  return expanded;
}

function virtualScopeSection(scope, index) {
  const details = document.createElement("details");
  details.dataset.workLogTaskGroup = "";
  details.dataset.journalLedgerRow = "";
  details.dataset.journalVirtualScope = scope.key;
  details.dataset.journalVirtualMode = scope.mode;
  if (scope.mode === "date") {
    details.dataset.workLogDaySection = "";
    details.dataset.journalDayDate = scope.key;
  }
  if (scope.mode === "workspace" && scope.workspaces[0]) {
    details.dataset.workLogWorkspace = "";
    details.dataset.workLogWorkspaceId = scope.workspaces[0].id;
  }
  const label = scope.mode === "stream"
    ? `${scope.workspaces[0]?.name ?? "Workspace"} — ${scope.label}`
    : scope.label;
  details.append(journalLedgerSummary(scope, { label, showStreams: false }));
  const expanded = document.createElement("div");
  expanded.dataset.journalLedgerExpanded = "";
  if (scope.mode === "stream") {
    const workspace = scope.workspaces[0];
    const stream = workspace?.streams[0];
    if (workspace && stream) {
      applyVirtualTurnQuery(expanded, scope, workspace, stream);
      const overview = document.createElement("div");
      overview.dataset.journalGroupOverview = "";
      const metrics = document.createElement("div");
      metrics.dataset.journalVirtualProfileMetrics = "";
      metrics.append(el("span", { text: "Профиль загружается при раскрытии." }));
      const body = document.createElement("div");
      body.dataset.journalTurnList = "";
      body.append(
        el("span", { "data-journal-section-label": "", text: "Ходы" }),
        virtualTurnTable(),
      );
      overview.append(metrics, body);
      const profile = document.createElement("div");
      profile.dataset.journalVirtualTaskProfile = "";
      expanded.append(overview, profile);
    }
  } else if (scope.mode === "workspace") {
    const workspace = scope.workspaces[0];
    if (workspace) {
      const overview = document.createElement("div");
      overview.dataset.journalGroupOverview = "";
      const metrics = document.createElement("div");
      metrics.dataset.journalVirtualWorkspaceProfileMetrics = "";
      metrics.append(el("span", { text: "Профиль загружается при раскрытии." }));
      const body = document.createElement("div");
      body.dataset.journalTurnList = "";
      body.append(
        el("span", { "data-journal-section-label": "", text: "Потоки" }),
        virtualWorkspaceContent(scope, workspace),
      );
      overview.append(metrics, body);
      const profile = document.createElement("div");
      profile.dataset.journalVirtualWorkspaceProfile = "";
      expanded.append(overview, profile);
    }
  } else {
    details.dataset.journalDayDate = scope.key;
    expanded.append(virtualTemporalContent(scope));
  }
  details.append(expanded);
  if (scope.mode === "stream" && index === 0) details.open = true;
  return details;
}

function renderVirtualWorkspaceProfile(summary, scopeKey) {
  const profiles = JournalView.virtualJournalScopes(summary, "workspace", {
    includeClaudeUsage: state.selection.includeClaudeUsage !== false,
    groupClaude: groupClaudeTasks,
  });
  const group = profiles.find((profile) => profile.key === scopeKey);
  if (!group) return;
  const details = [...journal.querySelectorAll(
    'details[data-journal-virtual-scope][data-journal-virtual-mode="workspace"]',
  )].find((item) => item.dataset.journalVirtualScope === scopeKey);
  const metrics = details?.querySelector("[data-journal-virtual-workspace-profile-metrics]");
  const profile = details?.querySelector("[data-journal-virtual-workspace-profile]");
  if (metrics) metrics.replaceWith(journalProfileMetrics(group));
  if (profile) profile.replaceChildren(taskProfile(group, profiles, {
    title: "Профиль Workspace",
    itemName: "Этот Workspace",
    cohortName: "видимых Workspace",
  }));
}

async function loadVirtualWorkspaceProfile(details) {
  if (!details || details.dataset.virtualWorkspaceProfileLoaded === "true") return;
  const renderSequence = journalRenderSequence;
  details.dataset.virtualWorkspaceProfileLoaded = "true";
  try {
    const payload = await fetchJournalFragment("/api/journal/turns", {
      workspaceId: details.dataset.workLogWorkspaceId ?? "",
      profileMode: "stream",
      limit: "1",
    });
    if (!details.isConnected || renderSequence !== journalRenderSequence) return;
    if (payload.profileSummary) {
      renderVirtualWorkspaceProfile(payload.profileSummary, details.dataset.journalVirtualScope ?? "");
    }
  } catch (error) {
    delete details.dataset.virtualWorkspaceProfileLoaded;
    if (!details.isConnected || renderSequence !== journalRenderSequence
      || isSupersededJournalFragment(error)) return;
    showToast(`Не удалось загрузить профиль Workspace: ${error.message}`);
  }
}

function renderVirtualStreamProfiles(summary, scopeKey) {
  const profiles = JournalView.virtualJournalScopes(summary, "stream", {
    includeClaudeUsage: state.selection.includeClaudeUsage !== false,
    groupClaude: groupClaudeTasks,
  });
  const byKey = new Map(profiles.map((profile) => [profile.key, profile]));
  for (const details of journal.querySelectorAll(
    'details[data-journal-virtual-scope][data-journal-virtual-mode="stream"]',
  )) {
    if (details.dataset.journalVirtualScope !== scopeKey) continue;
    const group = byKey.get(details.dataset.journalVirtualScope);
    if (!group) continue;
    const metrics = details.querySelector("[data-journal-virtual-profile-metrics]");
    const profile = details.querySelector("[data-journal-virtual-task-profile]");
    if (metrics) metrics.replaceWith(journalProfileMetrics(group));
    if (profile) profile.replaceChildren(taskProfile(group, profiles));
  }
}

function virtualJournalTotals() {
  const scopes = JournalView.virtualJournalScopes(journalSummary, "stream", {
    includeClaudeUsage: state.selection.includeClaudeUsage !== false,
    groupClaude: groupClaudeTasks,
  });
  return {
    scopes,
    totals: JournalView.summarizeGroups(scopes),
  };
}

function updateVirtualJournalSummary() {
  const { scopes, totals } = virtualJournalTotals();
  if (journalWorkspaceCount) {
    journalWorkspaceCount.textContent = scopes.length.toLocaleString("ru-RU");
  }
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

function renderVirtualJournal() {
  const scopes = JournalView.virtualJournalScopes(journalSummary, grouping, {
    includeClaudeUsage: state.selection.includeClaudeUsage !== false,
    groupClaude: groupClaudeTasks,
  });
  const list = document.createElement("div");
  list.dataset.workLogTaskGroups = "";
  scopes.forEach((scope, index) => list.append(virtualScopeSection(scope, index)));
  updateVirtualJournalSummary();
  replaceJournalGroupedContent(list);
  refreshUsageUnits(journal);
  disableLocalLinks();
  const saved = groupingStates[grouping];
  if (saved) restoreOpenState(saved);
  for (const opened of list.querySelectorAll(
    'details[data-journal-virtual-scope][data-journal-virtual-mode="stream"][open]',
  )) {
    const turns = opened.querySelector(
      ":scope > [data-journal-ledger-expanded][data-journal-virtual-turns]",
    );
    if (turns) void appendVirtualTurnPage(turns);
  }
  for (const opened of list.querySelectorAll(
    'details[data-journal-virtual-scope][data-journal-virtual-mode="workspace"][open]',
  )) void loadVirtualWorkspaceProfile(opened);
  journalRendered = true;
  journal.setAttribute("aria-busy", "false");
}

async function appendVirtualTurnPage(container, { nextPage = false } = {}) {
  if (!container?.isConnected || container.dataset.virtualLoading === "true") return;
  const renderSequence = journalRenderSequence;
  if (container.dataset.virtualLoaded === "true" && !nextPage) return;
  const table = container.querySelector(":scope [data-journal-turn-table]")
    ?? container.querySelector("[data-journal-turn-table]");
  if (!table) return;
  const offset = nextPage ? Math.max(0, Number(container.dataset.virtualNextOffset) || 0) : 0;
  container.dataset.virtualLoading = "true";
  container.setAttribute("aria-busy", "true");
  try {
    const payload = await fetchJournalFragment("/api/journal/turns", {
      workspaceId: container.dataset.virtualWorkspaceId ?? "",
      streamId: container.dataset.virtualStreamId ?? "",
      provider: container.dataset.virtualProvider ?? "",
      fromMs: container.dataset.virtualFromMs ?? "0",
      toMs: container.dataset.virtualToMs ?? "0",
      dates: container.dataset.virtualDateKeys ?? "",
      profileMode: container.dataset.virtualProfileMode ?? "",
      offset: String(offset),
      limit: "30",
    });
    if (!container.isConnected || renderSequence !== journalRenderSequence) return;
    if (payload.profileSummary) {
      renderVirtualStreamProfiles(
        payload.profileSummary,
        container.closest("[data-journal-virtual-scope]")?.dataset.journalVirtualScope ?? "",
      );
      delete container.dataset.virtualProfileMode;
    }
    table.querySelector("[data-journal-turn-show-more]")?.remove();
    const known = new Set([...table.querySelectorAll("[data-work-log-turn-entry]")]
      .map((entry) => JournalView.turnIdentity(entry.dataset)).filter(Boolean));
    for (const item of Array.isArray(payload.turns) ? payload.turns : []) {
      const template = document.createElement("template");
      template.innerHTML = String(item?.html ?? "").trim();
      const entry = template.content.firstElementChild;
      if (!entry?.matches("[data-work-log-turn-entry]")) continue;
      const identity = JournalView.turnIdentity(entry.dataset);
      if (identity && known.has(identity)) continue;
      if (identity) known.add(identity);
      table.append(groupedTurn(entry, String(item?.date ?? "")));
    }
    if (!table.children.length) {
      table.append(el("span", { "data-journal-turn-empty": "", text: "Ходов нет." }));
    }
    if (payload.nextOffset !== null && payload.nextOffset !== undefined) {
      container.dataset.virtualNextOffset = String(payload.nextOffset);
      const more = document.createElement("button");
      more.type = "button";
      more.dataset.journalTurnShowMore = "";
      more.textContent = "Показать ещё";
      more.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void appendVirtualTurnPage(container, { nextPage: true });
      });
      table.append(more);
    } else {
      delete container.dataset.virtualNextOffset;
    }
    container.dataset.virtualLoaded = "true";
    refreshUsageUnits(table);
    disableLocalLinks(table);
  } catch (error) {
    if (!container.isConnected || renderSequence !== journalRenderSequence
      || isSupersededJournalFragment(error)) return;
    container.title = error.message;
    showToast(`Не удалось загрузить ходы: ${error.message}`);
  } finally {
    delete container.dataset.virtualLoading;
    container.removeAttribute("aria-busy");
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
    replaceJournalGroupedContent(dayGroupingContent(journal));
  } else if (grouping === "stream" || grouping === "workspace") {
    replaceJournalGroupedContent(taskGroupingContent(journal, grouping));
  } else {
    replaceJournalGroupedContent(periodGroupingContent(journal, grouping));
  }
  refreshUsageUnits(journal);
  mountStatisticsAccountPanel();
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
  return window.AgentHubCommandTrace.measure("ui-render", "journal", renderJournalContent);
}

async function renderJournalContent() {
  const sequence = ++journalRenderSequence;
  const template = document.createElement("template");
  template.innerHTML = journalHtml;
  journal.setAttribute("aria-busy", "true");
  journal.replaceChildren(template.content.cloneNode(true));
  removeJournalRateLimits();
  try {
    if (JournalView.virtualSummaryBuckets(journalSummary).length) {
      if (sequence !== journalRenderSequence) return;
      renderVirtualJournal();
      return;
    }
    if (JournalView.requiresCompleteHistory(grouping)) {
      await hydrateAllLazyDays({ isCurrent: () => sequence === journalRenderSequence });
    }
    if (sequence !== journalRenderSequence) return;
    applyJournalGrouping();
  } catch (error) {
    if (sequence !== journalRenderSequence) return;
    journal.setAttribute("aria-busy", "false");
    if (isSupersededJournalFragment(error)) return;
    showToast(`Не удалось собрать журнал: ${error.message}`);
  }
}

function shortDeviceId(value) {
  const text = String(value ?? "").trim();
  return text ? text.slice(0, 8) : "";
}

function formatJournalSyncClock(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function usageSyncDeviceLabel(status = null) {
  return String(status?.deviceLabel ?? "").trim();
}

function usageSyncSuggestedDeviceLabel(status = null) {
  return String(status?.suggestedDeviceLabel || status?.deviceLabel || "").trim();
}

function usageSyncCanSetDeviceLabel(status = null) {
  return Boolean(status && typeof status === "object");
}

function mountStatisticsSyncControls() {
  if (!statisticsSyncHost) return;
  for (const control of [journalSyncStatus, journalSyncButton, journalSyncConnectButton, journalSyncDeviceLabelButton]) {
    if (control && control.parentElement !== statisticsSyncHost) statisticsSyncHost.append(control);
  }
}

function updateStatisticsSyncCardVisibility() {
  if (!statisticsSyncCard) return;
  const visible = [journalSyncStatus, journalSyncButton, journalSyncConnectButton, journalSyncDeviceLabelButton]
    .some((control) => control && !control.hidden);
  statisticsSyncCard.hidden = !visible;
}

function updateUsageSyncDeviceLabelButton(status = null) {
  const visible = usageSyncCanSetDeviceLabel(status);
  const label = usageSyncDeviceLabel(status);
  const suggested = usageSyncSuggestedDeviceLabel(status);
  journalSyncDeviceLabelButton.hidden = !visible;
  journalSyncDeviceLabelButton.disabled = !visible;
  journalSyncDeviceLabelButton.textContent = status?.deviceLabelPromptRequired || !label ? "Задать ник" : "Ник устройства";
  journalSyncDeviceLabelButton.title = [
    "Задать никнейм этого устройства для Sync.",
    label ? `Текущий ник: ${label}` : "",
    suggested && suggested !== label ? `Предложение: ${suggested}` : "",
  ].filter(Boolean).join("\n");
}

function updateJournalSyncStatus(status = null) {
  mountStatisticsSyncControls();
  journalSyncLatestStatus = status;
  updateUsageSyncDeviceLabelButton(status);
  if (!journalSyncStatus && !journalSyncButton && !journalSyncConnectButton && !journalSyncDeviceLabelButton) return;
  if (!status?.configured) {
    const canConnect = Boolean(status?.serverUrl);
    if (journalSyncStatus) {
      const label = usageSyncDeviceLabel(status);
      journalSyncStatus.hidden = !canConnect && !label && !status?.deviceLabelPromptRequired;
      journalSyncStatus.textContent = [
        canConnect ? "Sync не подключён" : "Sync",
        label ? `ник ${label}` : "",
        status?.deviceLabelPromptRequired ? "нужно подтвердить ник" : "",
      ].filter(Boolean).join(" · ");
      journalSyncStatus.title = canConnect
        ? `Сервер: ${status.serverUrl}\nВведите одноразовый код подключения Sync.`
        : "Синхронизация расхода не настроена";
    }
    if (journalSyncButton) {
      journalSyncButton.hidden = true;
      journalSyncButton.disabled = true;
      journalSyncButton.removeAttribute("aria-busy");
      journalSyncButton.textContent = "Синхр.";
    }
    if (journalSyncConnectButton) {
      journalSyncConnectButton.hidden = !canConnect;
      journalSyncConnectButton.disabled = !canConnect;
      journalSyncConnectButton.removeAttribute("aria-busy");
      journalSyncConnectButton.textContent = "Подключить Sync";
      journalSyncConnectButton.title = canConnect
        ? "Ввести одноразовый код подключения Sync"
        : "Sync server не задан";
    }
    updateStatisticsSyncCardVisibility();
    maybePromptUsageSyncDeviceLabel(status);
    return;
  }
  const lastSync = status.lastPullAt || status.lastPushAt;
  const clock = formatJournalSyncClock(lastSync);
  const result = status.lastResult && typeof status.lastResult === "object" ? status.lastResult : {};
  const added = Number(result.added || 0);
  const updated = Number(result.updated || 0);
  const changed = added + updated;
  const device = shortDeviceId(status.deviceId);
  const label = usageSyncDeviceLabel(status);
  if (journalSyncStatus) {
    journalSyncStatus.hidden = false;
    journalSyncStatus.textContent = [
      `Sync ${clock || "ожидает"}`,
      changed ? `+${added} / Δ${updated}` : "без изменений",
      label ? `ник ${label}` : "",
      device ? `device ${device}` : "",
    ].filter(Boolean).join(" · ");
    journalSyncStatus.title = [
      status.serverUrl ? `Сервер: ${status.serverUrl}` : "",
      status.lastPushAt ? `Последний push: ${new Date(status.lastPushAt).toLocaleString("ru-RU")}` : "",
      status.lastPullAt ? `Последний pull: ${new Date(status.lastPullAt).toLocaleString("ru-RU")}` : "",
      Number(result.after || 0) ? `Событий локально: ${Number(result.after || 0)}` : "",
      result.projected ? "Журнал перепроецирован" : "",
    ].filter(Boolean).join("\n") || "Sync настроен";
  }
  if (journalSyncButton) {
    journalSyncButton.hidden = false;
    journalSyncButton.disabled = false;
    journalSyncButton.title = "Синхронизировать расход через Sync";
  }
  if (journalSyncConnectButton) {
    journalSyncConnectButton.hidden = false;
    journalSyncConnectButton.disabled = false;
    journalSyncConnectButton.textContent = "Код Sync";
    journalSyncConnectButton.title = "Создать одноразовый код для подключения другого устройства";
  }
  updateStatisticsSyncCardVisibility();
  maybePromptUsageSyncDeviceLabel(status);
}

async function syncJournalUsageNow() {
  if (!journalSyncButton || journalSyncButton.disabled) return;
  journalSyncButton.disabled = true;
  journalSyncButton.setAttribute("aria-busy", "true");
  journalSyncButton.textContent = "Sync…";
  try {
    await localSessionReady;
    const response = await fetch("/api/journal/usage-sync", {
      method: "POST",
      cache: "no-store",
      headers: await authenticatedRequestHeaders(),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    updateJournalSyncStatus(payload.usageSync);
    await requestJournal({ force: true, announce: true });
    showToast("Расход синхронизирован");
  } catch (error) {
    showToast(`Не удалось синхронизировать расход: ${error.message}`);
  } finally {
    journalSyncButton.removeAttribute("aria-busy");
    journalSyncButton.textContent = "Синхр.";
    journalSyncButton.disabled = journalSyncButton.hidden;
  }
}

journalSyncButton?.addEventListener("click", () => {
  void syncJournalUsageNow();
});

async function setUsageSyncDeviceLabel(deviceLabel) {
  const response = await fetch("/api/journal/usage-sync/device-label", {
    method: "POST",
    cache: "no-store",
    headers: {
      ...await authenticatedRequestHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ deviceLabel }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  updateJournalSyncStatus(payload.usageSync);
  return payload;
}

function refreshJournalAfterUsageSyncDeviceLabel() {
  void requestJournal({ force: true, announce: true })
    .catch((error) => showToast(`Ник сохранён, но журнал не обновился: ${error.message}`));
}

async function promptUsageSyncDeviceLabel(status = journalSyncLatestStatus) {
  const suggested = usageSyncSuggestedDeviceLabel(status);
  const current = usageSyncDeviceLabel(status);
  const value = await askText({ title: "Никнейм этого устройства для Sync", value: suggested || current });
  if (value === null) return false;
  const next = String(value).trim();
  if (!next) {
    showToast("Никнейм устройства не изменён: пустое значение");
    return false;
  }
  await setUsageSyncDeviceLabel(next);
  showToast("Никнейм устройства сохранён");
  refreshJournalAfterUsageSyncDeviceLabel();
  return true;
}

function maybePromptUsageSyncDeviceLabel(status = null) {
  if (!status?.deviceLabelPromptRequired || journalSyncDeviceLabelPromptInFlight) return;
  if (dialog && !dialog.hidden) return;
  const suggested = usageSyncSuggestedDeviceLabel(status);
  const key = [
    String(status.deviceId ?? ""),
    String(status.deviceLabel ?? ""),
    suggested,
  ].join("\0");
  if (journalSyncDeviceLabelPrompted.has(key)) return;
  journalSyncDeviceLabelPrompted.add(key);
  journalSyncDeviceLabelPromptInFlight = true;
  setTimeout(() => {
    void promptUsageSyncDeviceLabel(status)
      .catch((error) => showToast(`Не удалось сохранить ник устройства: ${error.message}`))
      .finally(() => {
        journalSyncDeviceLabelPromptInFlight = false;
      });
  }, 0);
}

journalSyncDeviceLabelButton.addEventListener("click", () => {
  if (journalSyncDeviceLabelButton.disabled) return;
  journalSyncDeviceLabelButton.disabled = true;
  journalSyncDeviceLabelButton.setAttribute("aria-busy", "true");
  const previousText = journalSyncDeviceLabelButton.textContent;
  journalSyncDeviceLabelButton.textContent = "Ник…";
  void promptUsageSyncDeviceLabel()
    .catch((error) => showToast(`Не удалось сохранить ник устройства: ${error.message}`))
    .finally(() => {
      journalSyncDeviceLabelButton.removeAttribute("aria-busy");
      if (journalSyncLatestStatus) updateUsageSyncDeviceLabelButton(journalSyncLatestStatus);
      else journalSyncDeviceLabelButton.textContent = previousText;
      journalSyncDeviceLabelButton.disabled = journalSyncDeviceLabelButton.hidden;
    });
});

async function requestUsageSyncInvite() {
  const response = await fetch("/api/journal/usage-sync/invite", {
    method: "POST",
    cache: "no-store",
    headers: await authenticatedRequestHeaders(),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  updateJournalSyncStatus(payload.usageSync);
  const code = String(payload.result?.code ?? "").trim();
  if (!code) throw new Error("Сервер не вернул код Sync");
  try {
    await navigator.clipboard?.writeText?.(code);
    showToast("Код Sync скопирован");
  } catch {
    showToast("Код Sync создан");
  }
  await askText({ title: "Код подключения Sync для другого устройства", value: code });
}

async function enrollJournalSync() {
  const serverUrl = String(journalSyncLatestStatus?.serverUrl ?? "").trim();
  const code = await askText({ title: "Введите код подключения Sync" });
  if (!code) return;
  const response = await fetch("/api/journal/usage-sync/enroll", {
    method: "POST",
    cache: "no-store",
    headers: {
      ...await authenticatedRequestHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ serverUrl, code }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
  updateJournalSyncStatus(payload.usageSync);
  await requestJournal({ force: true, announce: true });
  showToast("Sync подключён");
}

async function connectJournalSync() {
  if (!journalSyncConnectButton || journalSyncConnectButton.disabled) return;
  journalSyncConnectButton.disabled = true;
  journalSyncConnectButton.setAttribute("aria-busy", "true");
  const previousText = journalSyncConnectButton.textContent;
  journalSyncConnectButton.textContent = journalSyncLatestStatus?.configured ? "Код…" : "Подкл…";
  try {
    await localSessionReady;
    if (journalSyncLatestStatus?.configured) await requestUsageSyncInvite();
    else await enrollJournalSync();
  } catch (error) {
    showToast(`Sync недоступен: ${error.message}`);
  } finally {
    journalSyncConnectButton.removeAttribute("aria-busy");
    journalSyncConnectButton.textContent = previousText;
    journalSyncConnectButton.disabled = journalSyncConnectButton.hidden;
  }
}

journalSyncConnectButton?.addEventListener("click", () => {
  void connectJournalSync();
});

async function requestJournal({ force = false, announce = false } = {}) {
  refreshButton.setAttribute("aria-busy", "true");
  try {
    await localSessionReady;
    const headers = await authenticatedRequestHeaders();
    if (!force && currentJournalEtag) headers["If-None-Match"] = currentJournalEtag;
    const response = await fetch(`/api/journal?now=${Date.now()}`, {
      cache: "no-store",
      headers,
    });
    if (response.status === 304) return true;
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
    currentJournalEtag = response.headers.get("etag") || "";
    updateJournalSyncStatus(payload.usageSync);
    if (force || payload.version !== currentVersion) {
      const versionChanged = payload.version !== currentVersion;
      const openState = journalRendered ? captureOpenState() : storedOpenState();
      if (openState) groupingStates[grouping] = openState;
      if (versionChanged) journalDayHtmlCache.clear();
      currentVersion = payload.version;
      journalHtml = payload.html;
      journalSummary = payload.summary ?? null;
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

/* Journal payload грузится при первом открытии Журнала или Статистики: сама
 * таблица остаётся ленивой, но Статистике нужны account panel и Sync status. */
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
    const selectedPanel = day.querySelector(
      `[data-journal-day-panel="${selectorValue(key)}"]`,
    );
    const flatTurns = selectedPanel?.querySelector("[data-journal-virtual-flat-turns]");
    if (flatTurns && day.open) void appendVirtualTurnPage(flatTurns);
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
  if (opened.matches?.("details[data-work-log-stream][data-journal-virtual-turns][open]")) {
    void appendVirtualTurnPage(opened);
  }
  if (opened.matches?.("details[data-journal-virtual-scope][open]")) {
    if (opened.matches('[data-journal-virtual-mode="stream"]')) {
      const turns = opened.querySelector(
        ":scope > [data-journal-ledger-expanded][data-journal-virtual-turns]",
      );
      if (turns) void appendVirtualTurnPage(turns);
    } else if (opened.matches('[data-journal-virtual-mode="workspace"]')) {
      void loadVirtualWorkspaceProfile(opened);
    } else {
      const selectedPanel = opened.querySelector("[data-journal-day-panel]:not([hidden])");
      const flatTurns = selectedPanel?.querySelector("[data-journal-virtual-flat-turns]")
        ?? opened.querySelector(":scope > [data-journal-ledger-expanded] > [data-journal-virtual-flat-turns]");
      if (flatTurns) void appendVirtualTurnPage(flatTurns);
    }
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
  /* Защищённая локальная ссылка сначала устанавливает HttpOnly-сессию. Если
     открыть EventSource раньше, его первый запрос получает 401 и открытая
     Статистика больше не узнаёт о входящем Usage Sync. */
  const journalEvents = window.AgentHubJournalPolling.createAuthenticatedEventStream({
    ready: localSessionReady,
    createSource: () => new EventSource("/events"),
    onReady: () => {
      AgentHub.setConnection("online");
      if (journalRequested) void loadJournal();
    },
    onChange: () => {
      if (journalRequested) void loadJournal();
    },
    onError: () => AgentHub.setConnection("connecting"),
  });
  void journalEvents.start();
  window.addEventListener("pagehide", () => journalEvents.stop(), { once: true });
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
void ensureComposerDraftsRestored();
window.addEventListener("pagehide", () => {
  saveDraft();
  clearInterval(taskDurationTimer);
}, { once: true });
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") saveDraft();
  else scheduleUnderfilledHistoryLoad();
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
