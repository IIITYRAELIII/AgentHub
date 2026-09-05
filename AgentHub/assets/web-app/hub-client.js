"use strict";

(() => {

const agentHub = window.AgentHub;
const telegramInitData = String(window.Telegram?.WebApp?.initData ?? "");
const localSessionReady = window.AgentHubLocalSessionReady ?? Promise.resolve();
const vscode = window.__agentHubVscode ?? (typeof window.acquireVsCodeApi === "function"
  ? window.acquireVsCodeApi()
  : null);
const pendingBridgeCalls = new Map();
const localWorkspaceFilesAvailable = window.AgentHubResourceInteractions.localWorkspaceFilesAvailable({
  vscode: Boolean(vscode),
  protocol: window.location.protocol,
  hostname: window.location.hostname,
});
function remoteWorkspaceFileBridgeAvailable() {
  return !vscode
    && !localWorkspaceFilesAvailable
    && window.AgentHubBrowserDevice?.isPaired?.() === true;
}

async function launchWorkspaceFileBridge(action, localPath) {
  const response = await hubFetch("/api/workspace-file/transfer-ticket", {
    method: "POST",
    headers: { ...authorizationHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ path: localPath }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(String(payload.error ?? `Не удалось подготовить файл: HTTP ${response.status}`));
  }
  const source = new URL(String(payload.downloadPath ?? ""), window.location.origin);
  const launch = new URL(`agenthub-file://${action}`);
  launch.searchParams.set("source", source.href);
  launch.searchParams.set("name", String(payload.name ?? "file.bin"));
  const link = document.createElement("a");
  link.href = launch.href;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  agentHub.toast("Windows File Bridge вызван. Если он не установлен, скачай /api/workspace-file/bridge-installer.ps1");
}
const selectedTaskKey = "agent-hub:selected-task:v1";
const serverIdentityKey = "agent-hub:server-identity:v1";
const maintenanceEventStorageKey = "agent-hub:maintenance-events:v1";

function createLatestIntentController() {
  let generation = 0;
  return Object.freeze({
    begin: () => ++generation,
    current: (candidate) => candidate === generation,
  });
}

const navigationIntents = createLatestIntentController();
let bridgeSequence = 0;
let lastSnapshot = null;
let observedServerIdentity = readStoredServerIdentity();
let selectedTaskId = readSelectedTaskId();
let refreshTimer = null;
let rateLimitRefreshTimer = null;
let rateLimitRefreshRange = window.AgentHubStatisticsControls.storedLimitsRange(window.localStorage);
let rateLimitRefreshInFlight = false;
let refreshing = false;
let refreshRequested = false;
let connectionFailureCount = 0;
let connectionFailureSince = 0;
let connectionOfflineTimer = null;
let connectionOfflineBreadcrumbRecorded = false;
let connectionLatencyMs = null;
let connectionLatencyProbe = null;
let connectionLatencyProbedAt = 0;
let snapshotTransportPrepared = false;
let pendingSelectionId = "";
let selectionTail = Promise.resolve();
let initialRouteOpening = true;
const historyRefreshAtByTask = new Map();
let visibleStreamTaskIds = new Set();
let boardTaskViewsSource = null;
let boardTaskViewsCache = [];
const EXTERNAL_HISTORY_REFRESH_MS = 2_500;
const HISTORY_ATTACHMENT_REFRESH_MS = 10_000;
const HISTORY_ATTACHMENT_SETTLE_TIMEOUT_MS = 120_000;
const REMOTE_WAIT_MS = 0;
const REMOTE_RESULT_FALLBACK_POLL_MS = 600;
const DEFAULT_CONTROL_TIMEOUT_MS = 45_000;
const LONG_CONTROL_TIMEOUT_MS = 180_000;
const LONG_CONTROL_ACTIONS = new Set(["rotate-stream", "submit-bug-report"]);
const VSCODE_MESSAGE_CONTROL_TIMEOUT_MS = LONG_CONTROL_TIMEOUT_MS;
const VSCODE_MESSAGE_RETRY_DELAYS_MS = Object.freeze([150, 600]);
const VSCODE_DIRECT_SEND_HEDGE_DELAY_MS = 250;
const HTTP_CONTROL_RETRY_DELAYS_MS = Object.freeze([150, 600, 1_500]);
const backgroundHttpScheduler = window.AgentHubBackgroundHttpScheduler.create({ maxConcurrent: 2 });
const HISTORY_CATCH_UP_TIMEOUT_MS = 120_000;
const CONNECTION_OFFLINE_FAILURES = 3;
const CONNECTION_OFFLINE_GRACE_MS = 6_000;
const CONNECTION_LATENCY_PROBE_INTERVAL_MS = 5_000;
const historyByTask = new Map();
const historyPageByTask = new Map();
const historyCatchUpDeadlines = new Map();
const historyCatchUpTurnIds = new Map();
const historyAttachmentSettleDeadlines = new Map();
const visibleHistoryLoads = new Set();
const historyLoadStates = new Map();
const historyRequestGenerationByTask = new Map();
const outgoingByTask = new Map();
const liveProbeByTask = new Map();
const liveUserMessagesByTask = new Map();
const liveCardsByTask = new Map();
const completionOverlaysByTask = new Map();
const queueActionsInFlight = new Set();
const optimisticQueueSteerIds = new Set();
const optimisticDeferredClientUserMessageIds = new Set();
const requestedContextCompactions = new Set();
const streamCreatesInFlight = new Map();
const observedContextCompactions = new Map();
const pendingStreamRotations = new Map();
const activeMaintenanceByTask = new Map();
const batchedMessageRenders = new Map();
let deferredClientUserMessageIds = new Set();
let activeRunClientUserMessageIds = new Set();
let messageRenderBatchDepth = 0;
const MAX_OUTGOING_MESSAGES_PER_TASK = 100;
const acknowledgedFinalByTask = new Map();
const { isUserRunningProjection, projectCanonicalMessages } = window.AgentHubMessageProjection;
const {
  activeRunSubmissionTiming,
  activeRunMessageReceipts,
  authoritativeActiveRunMessageReceipts,
  activeStageLabel,
  activeTaskRun,
  chronologicalMessages,
  completionCatchUpTurnId,
  completedLiveAgentMessage,
  completedLiveTurnIdentity,
  conversationTaskId,
  completedConversationTurnVisible,
  confirmedOutgoingMessageIds,
  conversationMessageAuthor,
  deduplicateConversationMessages,
  deferredInputConversationProjection,
  displayedFinalAcknowledgement,
  focusedTurnAlreadyVisible,
  focusedTurnTaskThreadId,
  historyContainsLatestAnswer,
  historyRefreshSourceRequired,
  historyMatchesIdentity,
  historicalMessagesForDisplay,
  hubErrorMessage,
  httpControlError,
  isConnectionFailure,
  liveCompletionTransition,
  latestAnswerTransition,
  nextHistoryCatchUpDeadline,
  looksLikeConnectionFailure,
  markCommandRejected,
  markConnectionFailure,
  messageSendDefinitelyRejected,
  messageAwaitsProviderAcceptance,
  queueHistoryReceiptProjection,
  mergeDeferredQueueEntries,
  queuedCommandClientUserMessageIds,
  queuedCommandDeliveryState,
  queuedCommandUsesQueue,
  providerAcceptedHistoryClientUserMessageIds,
  optimisticSubmissionUsesQueue,
  runHasAuthoritativeProviderAcceptance,
  mergeLiveMaintenance,
  mergeReconciledUserMessage,
  mergeLiveUserMessages,
  mergeTurnMaintenanceMessages,
  latestMaintenanceMessages,
  normalizedResponseAnnotations,
  normalizedUserMessage,
  outgoingTaskId,
  responseAnnotationPrompt,
  reconcile: reconcileMessageLifecycle,
  rememberBounded: rememberBoundedMessage,
  retryConnectionFailure,
  reusableAttachmentPaths,
  settleOptionalRead,
  snapshotCompletionCandidate,
  snapshotCompletionReplacement,
  visibleConversationMessages,
} = window.AgentHubMessageLifecycle;
const maintenanceEventsByTask = readMaintenanceEvents();

const runtimeShortLabels = Object.freeze({
  hub: "HUB",
  telegram: "HUB",
  vscode: "VSC",
  desktop: "APP",
  cli: "CLI",
  external: "EXT",
});

function taskId(provider, threadId, streamId = "") {
  return conversationTaskId({ provider, threadId, streamId }, lastSnapshot?.tasks ?? []);
}

function readStoredServerIdentity() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(serverIdentityKey) || "null");
    return stored?.instanceId && stored?.releaseId ? stored : null;
  } catch {
    return null;
  }
}

function serverIdentity(snapshot) {
  const process = snapshot?.server?.process;
  const instanceId = String(process?.instanceId ?? "").trim();
  const releaseId = String(process?.releaseId ?? "").trim();
  return instanceId && releaseId ? { instanceId, releaseId } : null;
}

function rememberServerIdentity(identity) {
  observedServerIdentity = identity;
  try {
    sessionStorage.setItem(serverIdentityKey, JSON.stringify(identity));
  } catch {
    // Идентификатор всё равно остаётся в памяти текущего клиента.
  }
}

function notifyAndroidAboutRelease(identity) {
  try {
    window.AgentHubAndroid?.onHubRestarted?.(identity.releaseId);
  } catch {
    // Native bridge существует только в Android App.
  }
}

const runtimeReload = new window.AgentHubRuntimeReload.RuntimeReloadController({
  prepare: () => agentHub.prepareForRuntimeReload?.() !== false,
  apply: () => {
    if (vscode) vscode.postMessage({ type: "agenthub:runtime-changed" });
    else window.location.reload();
  },
  onDeferred: () => agentHub.toast(
    "Обновление интерфейса отложено до завершения ввода или закрытия окна",
  ),
});

function reloadForPublishedRuntime() {
  return runtimeReload.request();
}

function observeServerIdentity(snapshot) {
  const identity = serverIdentity(snapshot);
  if (!identity) return false;
  if (!observedServerIdentity) {
    rememberServerIdentity(identity);
    return false;
  }
  const transition = window.AgentHubRuntimeReload.runtimeIdentityTransition(
    observedServerIdentity,
    identity,
  );
  let reloadStarted = false;
  if (transition.reloadRequired) {
    rememberServerIdentity(identity);
    if (transition.instanceChanged) notifyAndroidAboutRelease(identity);
    reloadStarted = reloadForPublishedRuntime();
  }
  return reloadStarted;
}

function readSelectedTaskId() {
  try {
    return String(localStorage.getItem(selectedTaskKey) ?? "").trim();
  } catch {
    return "";
  }
}

function rememberSelectedTaskId(id) {
  selectedTaskId = String(id ?? "").trim();
  try {
    if (selectedTaskId) localStorage.setItem(selectedTaskKey, selectedTaskId);
    else localStorage.removeItem(selectedTaskKey);
  } catch {
    // Приватный WebView может запрещать localStorage.
  }
  return selectedTaskId;
}

function readMaintenanceEvents() {
  const values = new Map();
  try {
    const stored = JSON.parse(localStorage.getItem(maintenanceEventStorageKey) || "[]");
    for (const entry of Array.isArray(stored) ? stored : []) {
      const task = String(entry?.taskId ?? "").trim();
      const id = String(entry?.message?.id ?? "").trim();
      if (!task || !id) continue;
      const legacyRotation = id.startsWith("maintenance:rotation:") && (
        entry.message?.maintenanceType !== "rotation"
        || entry.message?.placement !== "after-source-turn"
        || !String(entry.message?.sourceThreadId ?? "").trim()
      );
      if (legacyRotation) continue;
      const events = values.get(task) ?? [];
      const match = /(\?|\d+)%>(\?|\d+)%/u.exec(String(entry.message?.text ?? ""));
      const explicitAfter = entry.message?.afterPercent;
      const invalidZeroAfter = id.startsWith("maintenance:compaction:") && (
        (explicitAfter !== null && explicitAfter !== undefined && explicitAfter !== ""
          && Number(explicitAfter) === 0)
        || ((explicitAfter === null || explicitAfter === undefined || explicitAfter === "")
          && match?.[2] === "0")
      );
      events.push(invalidZeroAfter ? {
        ...entry.message,
        afterPercent: null,
        text: String(entry.message?.text ?? "").replace(/>0%$/u, ">?%"),
      } : entry.message);
      values.set(task, latestMaintenanceMessages(events));
    }
    const normalized = [...values].flatMap(([taskIdValue, messages]) => (
      messages.map((message) => ({ taskId: taskIdValue, message }))
    ));
    localStorage.setItem(maintenanceEventStorageKey, JSON.stringify(normalized));
  } catch {
    // Недоступный localStorage не мешает событиям оставаться в текущей сессии.
  }
  return values;
}

function persistMaintenanceEvents() {
  try {
    const stored = [...maintenanceEventsByTask].flatMap(([taskIdValue, messages]) => (
      messages.map((message) => ({ taskId: taskIdValue, message }))
    )).sort((left, right) => Date.parse(left.message.time ?? "") - Date.parse(right.message.time ?? ""))
      .slice(-200);
    localStorage.setItem(maintenanceEventStorageKey, JSON.stringify(stored));
  } catch {
    // События всё равно остаются в памяти текущего клиента.
  }
}

function rememberMaintenanceEvent(taskIdValue, message) {
  const stableTaskId = String(taskIdValue ?? "").trim();
  const eventId = String(message?.id ?? "").trim();
  if (!stableTaskId || !eventId) return false;
  const events = maintenanceEventsByTask.get(stableTaskId) ?? [];
  const previous = JSON.stringify(events);
  const index = events.findIndex((entry) => entry.id === eventId);
  const value = {
    ...message,
    role: "system",
    kind: "maintenance",
    operationKind: String(message?.operationKind ?? "maintenance"),
  };
  if (index >= 0) events[index] = value;
  else events.push(value);
  const normalized = latestMaintenanceMessages(events);
  if (previous === JSON.stringify(normalized)) return false;
  maintenanceEventsByTask.set(stableTaskId, normalized);
  persistMaintenanceEvents();
  return true;
}

function taskIdentity(id) {
  const stableId = String(id ?? "").trim();
  const task = representativeSnapshotTasks(lastSnapshot?.tasks).find((candidate) => (
    taskId(candidate.provider, candidate.threadId, candidate.streamId) === stableId
  ));
  if (task) return {
    streamId: task.streamId ?? null,
    provider: task.provider,
    threadId: task.threadId,
  };
  const separator = String(id ?? "").indexOf(":");
  if (separator < 1) return null;
  return {
    provider: id.slice(0, separator),
    threadId: id.slice(separator + 1),
  };
}

function verifiedTaskHistory(history, identity) {
  if (!historyMatchesIdentity(history, identity)) {
    throw new Error("Agent Hub вернул историю другого Stream. Обновление отклонено.");
  }
  return history;
}

function stableIdentity(identity) {
  return {
    streamId: String(identity?.streamId ?? "").trim(),
    provider: String(identity?.provider ?? "").trim(),
    threadId: String(identity?.threadId ?? "").trim(),
  };
}

function sameIdentity(left, right) {
  const a = stableIdentity(left);
  const b = stableIdentity(right);
  return a.streamId === b.streamId && a.provider === b.provider && a.threadId === b.threadId;
}

function beginHistoryRequest(id, identity) {
  const generation = (historyRequestGenerationByTask.get(id) ?? 0) + 1;
  historyRequestGenerationByTask.set(id, generation);
  return { id, identity: stableIdentity(identity), generation };
}

function currentHistoryRequest(request) {
  return historyRequestGenerationByTask.get(request.id) === request.generation
    && sameIdentity(taskIdentity(request.id), request.identity);
}

function beginNavigation(identity = null) {
  const generation = navigationIntents.begin();
  return {
    generation,
    identity: identity ? stableIdentity(identity) : null,
  };
}

function currentNavigation(intent) {
  return navigationIntents.current(intent.generation);
}

async function runNavigation(identity, load, commit) {
  const intent = beginNavigation(identity);
  try {
    const result = await load();
    if (!currentNavigation(intent)) return null;
    if (result?.history && intent.identity?.streamId) {
      verifiedTaskHistory(result.history, intent.identity);
      const currentIdentity = taskIdentity(intent.identity.streamId);
      if (currentIdentity && !sameIdentity(currentIdentity, result.history)) return null;
    }
    commit(result);
    return result;
  } catch (error) {
    if (!currentNavigation(intent)) return null;
    if (isConnectionFailure(error)) recordTransientConnectionFailure();
    agentHub.toast(hubErrorMessage(error));
    return null;
  }
}

function outgoingMessages(taskIdValue) {
  if (!outgoingByTask.has(taskIdValue)) outgoingByTask.set(taskIdValue, new Map());
  return outgoingByTask.get(taskIdValue);
}

function rememberOutgoing(taskIdValue, message) {
  rememberBoundedMessage(
    outgoingMessages(taskIdValue),
    message,
    MAX_OUTGOING_MESSAGES_PER_TASK,
  );
}

function deliveryPatch(stateName) {
  const states = {
    preparing: { deliveryState: "preparing", delivery: "Подготовка…", failed: false },
    sending: { deliveryState: "sending", delivery: "Отправляется…", failed: false },
    steering: { deliveryState: "steering", delivery: "В текущем ходе", failed: false },
    accepted: { deliveryState: "accepted", delivery: "Принято", failed: false },
    deferred: { deliveryState: "deferred", delivery: "Отложено", failed: false },
    queued: { deliveryState: "queued", delivery: "В очереди", failed: false },
    relaying: { deliveryState: "relaying", delivery: "Доставляется в Hub…", failed: false },
    delivered: { deliveryState: "delivered", delivery: "", failed: false },
    unconfirmed: { deliveryState: "unconfirmed", delivery: "Статус приёма уточняется…", failed: false },
    rejected: { deliveryState: "rejected", delivery: "Не принято", failed: true },
  };
  return states[stateName] ?? states.unconfirmed;
}

const attachmentThumbnailUrls = new Map();
const attachmentThumbnailLoads = new Map();
const unavailableAttachmentThumbnailIds = new Set();
const MAX_CACHED_ATTACHMENT_THUMBNAILS = 96;

function rememberUnavailableAttachmentThumbnail(id) {
  unavailableAttachmentThumbnailIds.delete(id);
  unavailableAttachmentThumbnailIds.add(id);
  while (unavailableAttachmentThumbnailIds.size > MAX_CACHED_ATTACHMENT_THUMBNAILS) {
    unavailableAttachmentThumbnailIds.delete(unavailableAttachmentThumbnailIds.values().next().value);
  }
}

function cacheAttachmentThumbnail(id, url) {
  const previous = attachmentThumbnailUrls.get(id);
  if (previous && previous !== url) URL.revokeObjectURL(previous);
  attachmentThumbnailUrls.delete(id);
  attachmentThumbnailUrls.set(id, url);
  boardTaskViewsSource = null;
  while (attachmentThumbnailUrls.size > MAX_CACHED_ATTACHMENT_THUMBNAILS) {
    const oldestId = attachmentThumbnailUrls.keys().next().value;
    const oldestUrl = attachmentThumbnailUrls.get(oldestId);
    attachmentThumbnailUrls.delete(oldestId);
    if (oldestUrl) URL.revokeObjectURL(oldestUrl);
  }
}

function attachmentView(attachment) {
  const value = { ...attachment };
  const id = String(value.id ?? "").trim();
  const image = value.isImage || String(value.type ?? "").toLowerCase().startsWith("image/");
  const localSurface = !vscode
    && !telegramInitData
    && !window.AgentHubAndroid
    && !window.AgentHubBrowserDevice;
  if (localSurface && id && !value.missing && !String(value.url ?? "").trim()) {
    value.url = `/api/message-attachment/${encodeURIComponent(id)}`;
  }
  if (localSurface && image && id && !value.missing && !String(value.thumbnailUrl ?? "").trim()) {
    value.thumbnailUrl = `/api/message-attachment/${encodeURIComponent(id)}?preview=1`;
  } else if (image && id && attachmentThumbnailUrls.has(id)) {
    value.thumbnailUrl = attachmentThumbnailUrls.get(id);
  }
  return value;
}

function attachmentViews(values) {
  return (Array.isArray(values) ? values : []).map(attachmentView);
}

function boardTaskViews(values) {
  const source = Array.isArray(values) ? values : [];
  if (source === boardTaskViewsSource) return boardTaskViewsCache;
  boardTaskViewsSource = source;
  boardTaskViewsCache = source.map((task) => ({
    ...task,
    attachments: attachmentViews(task.attachments),
  }));
  return boardTaskViewsCache;
}

function nonEmptyAttachmentPatch(values) {
  const attachments = attachmentViews(values);
  return attachments.length ? { attachments } : {};
}

function updateOutgoing(taskIdValue, clientUserMessageId, patch) {
  const resolvedTaskId = outgoingTaskId(outgoingByTask, clientUserMessageId, taskIdValue);
  if (!resolvedTaskId) return "";
  const message = outgoingMessages(resolvedTaskId).get(clientUserMessageId);
  if (!message) return "";
  Object.assign(message, patch);
  return resolvedTaskId;
}

function patchOutgoing(taskIdValue, clientUserMessageId, patch) {
  const resolvedTaskId = updateOutgoing(taskIdValue, clientUserMessageId, patch);
  if (!resolvedTaskId) return;
  renderTaskMessages(resolvedTaskId);
}

function renderOutgoingWithoutBlockingSend(taskIdValue, { queue = false } = {}) {
  try {
    if (queue) renderTaskQueue(taskIdValue);
    renderTaskMessages(taskIdValue);
  } catch (error) {
    console.error("Agent Hub outgoing message render failed", error);
  }
}

function liveUserMessagesSignature(run) {
  const messages = Array.isArray(run?.userMessages) ? run.userMessages : [];
  return JSON.stringify([
    String(run?.turnId ?? ""),
    String(run?.clientUserMessageId ?? ""),
    String(run?.prompt ?? "").length,
    String(run?.promptAuthor ?? ""),
    String(run?.startedAt ?? ""),
    String(run?.submittedAt ?? ""),
    JSON.stringify(run?.attachments ?? []),
    ...messages.map((message) => [
      String(message?.itemId ?? ""),
      String(message?.clientUserMessageId ?? ""),
      String(message?.text ?? "").length,
      String(message?.author ?? ""),
      String(message?.time ?? ""),
      JSON.stringify(message?.attachments ?? []),
      JSON.stringify(message?.responseAnnotations ?? []),
    ]),
  ]);
}

function reconciledMessages(taskIdValue) {
  const durableMessages = projectCanonicalMessages(historyByTask.get(taskIdValue) ?? []);
  const overlays = completionOverlaysByTask.get(taskIdValue);
  if (overlays) {
    for (const [turnId, overlay] of overlays) {
      if (completedConversationTurnVisible(durableMessages, {
        turnId,
        answer: overlay.answer,
        requireAgent: Boolean(overlay.answer),
      })) overlays.delete(turnId);
    }
    if (!overlays.size) completionOverlaysByTask.delete(taskIdValue);
  }
  const overlayMessages = [...(completionOverlaysByTask.get(taskIdValue)?.values() ?? [])]
    .flatMap((overlay) => overlay.messages);
  const maintenanceMessages = maintenanceEventsByTask.get(taskIdValue) ?? [];
  const activeMaintenance = activeMaintenanceByTask.get(taskIdValue);
  const serverMessages = projectCanonicalMessages(mergeLiveUserMessages(
    mergeTurnMaintenanceMessages([
      ...durableMessages,
      ...overlayMessages,
      ...maintenanceMessages,
      ...(activeMaintenance ? [activeMaintenance] : []),
    ]),
    liveUserMessagesByTask.get(taskIdValue) ?? {},
  ));
  const pending = outgoingMessages(taskIdValue);
  const outgoing = [...pending.values()];
  const { matches, matchedIds } = reconcileMessageLifecycle(serverMessages, outgoing);
  const result = matches.map(({ message, local }) => {
    if (!local) return message;
    return {
      ...mergeReconciledUserMessage(message, local),
      attachments: local.attachments?.length ? local.attachments : message.attachments,
      ...deliveryPatch("delivered"),
    };
  });
  for (const message of outgoing) {
    if (!matchedIds.has(message.clientUserMessageId)) result.push(message);
  }
  const confirmedMatchedIds = confirmedOutgoingMessageIds(durableMessages, outgoing);
  for (const clientUserMessageId of confirmedMatchedIds) {
    pending.delete(clientUserMessageId);
    optimisticDeferredClientUserMessageIds.delete(clientUserMessageId);
    deferredClientUserMessageIds.delete(clientUserMessageId);
  }
  const visible = visibleConversationMessages(result.map(normalizedUserMessage), {
    deferredClientUserMessageIds,
    liveProbe: liveProbeByTask.get(taskIdValue) ?? null,
  });
  // Live snapshots, durable history and the optimistic receipt can arrive in
  // either order. Re-run idempotent deduplication after all three were merged.
  return chronologicalMessages(projectCanonicalMessages(visible));
}

function deferredEntriesForTask(snapshot, taskIdValue) {
  const acceptedHistoryIds = new Set(providerAcceptedHistoryClientUserMessageIds(
    historyByTask.get(taskIdValue),
  ));
  return (snapshot?.deferredInputs ?? []).filter((item) => (
    queuedCommandUsesQueue(item, snapshot?.messageReceipts)
    && !acceptedHistoryIds.has(String(item?.clientUserMessageId ?? item?.clientMessageId ?? "").trim())
    && !optimisticQueueSteerIds.has(String(item.id ?? ""))
    && (!item.provider || taskId(item.provider, item.threadId, item.streamId) === taskIdValue)
  ));
}

function optimisticDeferredEntries(taskIdValue, serverEntries = []) {
  const acceptedHistoryIds = new Set(providerAcceptedHistoryClientUserMessageIds(
    historyByTask.get(taskIdValue),
  ));
  const serverClientIds = new Set(serverEntries
    .map((item) => String(item.clientUserMessageId ?? item.clientMessageId ?? "").trim())
    .filter(Boolean));
  return [...outgoingMessages(taskIdValue).values()]
    .filter((message) => (
      !acceptedHistoryIds.has(String(message?.clientUserMessageId ?? "").trim())
      && (
        optimisticDeferredClientUserMessageIds.has(message.clientUserMessageId)
        || serverClientIds.has(message.clientUserMessageId)
        || messageAwaitsProviderAcceptance(message)
      )
    ))
    .map((message) => ({
      id: `local:${message.clientUserMessageId}`,
      state: message.deliveryState === "steering"
        ? "steering"
        : message.deliveryState === "sending" ? "dispatching" : "queued",
      clientUserMessageId: message.clientUserMessageId,
      text: message.responseAnnotationRequest
        || (message.responseAnnotations?.length ? "" : message.text),
      annotations: message.responseAnnotations ?? [],
      attachments: message.attachments ?? [],
      createdAt: message.submittedAt ?? message.time,
      delivery: message.delivery,
      deliveryState: message.deliveryState,
      remoteCommandId: message.remoteCommandId,
      optimistic: !serverClientIds.has(message.clientUserMessageId),
    }));
}

function renderTaskQueue(taskIdValue, snapshot = lastSnapshot) {
  const serverEntries = deferredEntriesForTask(snapshot, taskIdValue)
    .map((item) => ({ ...item, attachments: attachmentViews(item.attachments) }));
  agentHub.setQueue(taskIdValue, mergeDeferredQueueEntries(
    serverEntries,
    optimisticDeferredEntries(taskIdValue, serverEntries),
  ));
}

function restoreImmediateIntakeMessage(deferred, messageReceipts = []) {
  const projection = deferredInputConversationProjection(deferred, messageReceipts);
  if (!projection) return false;
  const stableTaskId = taskId(deferred.provider, deferred.threadId, deferred.streamId);
  const messages = outgoingMessages(stableTaskId);
  const responseAnnotations = normalizedResponseAnnotations(deferred.annotations);
  const text = String(deferred.text ?? deferred.preview ?? "");
  const attachments = attachmentViews(deferred.attachments);
  if (!text.trim() && !responseAnnotations.length && !attachments.length) return false;
  optimisticDeferredClientUserMessageIds.delete(projection.clientUserMessageId);
  deferredClientUserMessageIds.delete(projection.clientUserMessageId);
  const existing = messages.get(projection.clientUserMessageId);
  if (existing) {
    Object.assign(existing, {
      projectionAuthority: "canonical",
      projectionState: projection.projectionState,
      providerAccepted: projection.providerAccepted,
      clientProjectionIntent: projection.clientProjectionIntent,
      ...deliveryPatch(projection.deliveryState),
      ...(!existing.submittedAt && projection.submittedAt
        ? { submittedAt: projection.submittedAt }
        : {}),
      ...(!existing.time && projection.submittedAt ? { time: projection.submittedAt } : {}),
    });
  } else {
    rememberOutgoing(stableTaskId, {
      id: `local:${projection.clientUserMessageId}`,
      provider: String(deferred.provider ?? ""),
      threadId: String(deferred.threadId ?? ""),
      streamId: String(deferred.streamId ?? ""),
      turnId: "",
      itemId: projection.clientUserMessageId,
      clientUserMessageId: projection.clientUserMessageId,
      submissionId: projection.submissionId,
      operationKind: "user-turn",
      projectionAuthority: "canonical",
      projectionState: projection.projectionState,
      providerAccepted: projection.providerAccepted,
      clientProjectionIntent: projection.clientProjectionIntent,
      role: "user",
      author: String(deferred.author ?? "").trim() || "Вы",
      text,
      responseAnnotations,
      responseAnnotationRequest: String(deferred.responseAnnotationRequest ?? text),
      submittedAt: projection.submittedAt,
      time: projection.submittedAt,
      attachments,
      ...deliveryPatch(projection.deliveryState),
    });
  }
  return true;
}

function applyMessageReceipts(snapshot) {
  for (const receipt of snapshot?.messageReceipts ?? []) {
    const clientUserMessageId = String(receipt?.clientUserMessageId ?? "").trim();
    const provider = String(receipt?.provider ?? "").trim();
    const threadId = String(receipt?.threadId ?? "").trim();
    if (!clientUserMessageId || !provider || !threadId) continue;
    const streamId = String(receipt?.streamId ?? "").trim();
    const stableTaskId = taskId(provider, threadId, streamId);
    const projection = queueHistoryReceiptProjection(receipt);
    if (!projection.ownsDeferredQueue) {
      optimisticDeferredClientUserMessageIds.delete(clientUserMessageId);
      deferredClientUserMessageIds.delete(clientUserMessageId);
    }
    if (receipt?.cancelled === true) {
      agentHub.completeSend(clientUserMessageId, { accepted: true });
      outgoingMessages(stableTaskId).delete(clientUserMessageId);
      continue;
    }
    const patch = projection.deliveryState ? deliveryPatch(projection.deliveryState) : null;
    if (!patch) continue;
    agentHub.completeSend(clientUserMessageId, {
      accepted: projection.accepted,
    });
    const restoredText = String(receipt.displayText ?? "");
    const restoredAnnotations = normalizedResponseAnnotations(receipt.responseAnnotations);
    const restoredRequest = String(receipt.responseAnnotationRequest ?? "");
    const restoredAttachments = attachmentViews(receipt.attachments);
    const hasRestorableMessage = Boolean(
      restoredText.trim()
      || restoredAnnotations.length
      || restoredRequest.trim()
      || restoredAttachments.length
    );
    if (hasRestorableMessage && !outgoingMessages(stableTaskId).has(clientUserMessageId)) {
      rememberOutgoing(stableTaskId, {
        id: `local:${clientUserMessageId}`,
        provider,
        threadId,
        streamId,
        turnId: String(receipt.turnId ?? ""),
        itemId: receipt.id ?? clientUserMessageId,
        clientUserMessageId,
        submissionId: String(receipt.submissionId ?? clientUserMessageId),
        operationKind: "user-turn",
        projectionAuthority: "canonical",
        projectionState: projection.projectionState,
        providerAccepted: projection.providerAccepted,
        clientProjectionIntent: projection.clientProjectionIntent,
        role: "user",
        author: String(receipt.author ?? "").trim() || "Вы",
        text: restoredText,
        responseAnnotations: restoredAnnotations,
        responseAnnotationRequest: restoredRequest,
        submittedAt: projection.submittedAt ?? null,
        startedAt: projection.startedAt ?? null,
        time: projection.submittedAt ?? null,
        attachments: restoredAttachments,
      });
    }
    patchOutgoing(stableTaskId, clientUserMessageId, {
      provider,
      threadId,
      streamId,
      turnId: String(receipt.turnId ?? ""),
      itemId: receipt.steered === true ? clientUserMessageId : receipt.id ?? clientUserMessageId,
      submissionId: String(receipt.submissionId ?? clientUserMessageId),
      operationKind: "user-turn",
      projectionAuthority: "canonical",
      projectionState: projection.projectionState,
      providerAccepted: projection.providerAccepted,
      clientProjectionIntent: projection.clientProjectionIntent,
      ...(projection.submittedAt ? {
        submittedAt: projection.submittedAt,
        time: projection.submittedAt,
      } : {}),
      ...(projection.startedAt ? { startedAt: projection.startedAt } : {}),
      ...nonEmptyAttachmentPatch(receipt.attachments),
      ...(receipt.accepted && !receipt.steered ? { turnUserSlot: "root" } : {}),
      ...(receipt.steered ? { turnUserSlot: "steer" } : {}),
      ...patch,
    });
  }
}

function rememberSnapshotCompletion(taskIdValue, selected, incomingTurnId = "") {
  const completion = snapshotCompletionCandidate(selected, incomingTurnId);
  if (!completion) return false;
  const durableMessages = historyByTask.get(taskIdValue) ?? [];
  if (completedConversationTurnVisible(durableMessages, {
    turnId: completion.turnId,
    answer: completion.answer,
    requireAgent: true,
  })) {
    const overlays = completionOverlaysByTask.get(taskIdValue);
    if (!overlays?.delete(completion.turnId)) return false;
    if (!overlays.size) completionOverlaysByTask.delete(taskIdValue);
    return true;
  }
  const overlays = completionOverlaysByTask.get(taskIdValue) ?? new Map();
  const existing = overlays.get(completion.turnId);
  const replacement = snapshotCompletionReplacement(existing, completion);
  if (!replacement) return false;
  const existingAgent = (Array.isArray(existing?.messages) ? existing.messages : [])
    .findLast((message) => message?.role === "agent" && message?.kind !== "subagent");
  overlays.set(replacement.turnId, {
    answer: replacement.answer,
    messages: [{
      id: `${replacement.provider}:${replacement.threadId}:${replacement.turnId}:snapshot-final`,
      provider: replacement.provider,
      threadId: replacement.threadId,
      turnId: replacement.turnId,
      itemId: `${replacement.turnId}:agent:final`,
      role: "agent",
      operationKind: "user-turn",
      projectionAuthority: "terminal",
      projectionState: "completed",
      terminalRevision: Number(selected?.lastAnswerRevision) || 1,
      ...(selected?.latestFinal?.migrationGuard
        ? { terminalRevisionMigrationGuard: String(selected.latestFinal.migrationGuard) }
        : {}),
      author: replacement.provider === "claude" ? "Claude" : "Codex",
      phase: "final",
      text: replacement.answer,
      time: replacement.time,
      activities: Array.isArray(existingAgent?.activities) ? existingAgent.activities : [],
      activityGroups: Array.isArray(existingAgent?.activityGroups) ? existingAgent.activityGroups : [],
      turnStartedAt: existingAgent?.turnStartedAt ?? null,
      turnCompletedAt: replacement.time,
    }],
  });
  while (overlays.size > 20) overlays.delete(overlays.keys().next().value);
  completionOverlaysByTask.set(taskIdValue, overlays);
  return true;
}

function promoteLiveCompletion(taskIdValue, selected, incomingTurnId = "") {
  const previous = liveCardsByTask.get(taskIdValue);
  const previousTurnId = String(previous?.turnId ?? "").trim();
  const transition = liveCompletionTransition(previous, selected, incomingTurnId);
  if (transition === "none") return false;
  if (transition === "discard") {
    liveCardsByTask.delete(taskIdValue);
    liveProbeByTask.delete(taskIdValue);
    liveUserMessagesByTask.delete(taskIdValue);
    completionOverlaysByTask.delete(taskIdValue);
    return true;
  }
  const liveUsers = liveUserMessagesByTask.get(taskIdValue) ?? {};
  const agentMessage = completedLiveAgentMessage(previous, selected);
  if (!agentMessage) return false;
  const answer = agentMessage.text;
  const messages = mergeLiveUserMessages([], liveUsers);
  messages.push(agentMessage);
  const overlays = completionOverlaysByTask.get(taskIdValue) ?? new Map();
  overlays.set(previousTurnId, { answer, messages });
  while (overlays.size > 20) overlays.delete(overlays.keys().next().value);
  completionOverlaysByTask.set(taskIdValue, overlays);
  liveCardsByTask.delete(taskIdValue);
  return true;
}

function clearDurablyCompletedLiveCard(taskIdValue) {
  const liveCard = liveCardsByTask.get(taskIdValue);
  const liveUsers = liveUserMessagesByTask.get(taskIdValue) ?? {};
  const completedIdentity = completedLiveTurnIdentity(
    historyByTask.get(taskIdValue) ?? [],
    {
      provider: liveCard?.provider ?? liveUsers.provider,
      threadId: liveCard?.threadId ?? liveUsers.threadId,
      turnId: liveCard?.turnId,
      clientUserMessageIds: [
        liveUsers.clientUserMessageId,
        ...(Array.isArray(liveUsers.userMessages)
          ? liveUsers.userMessages.map((message) => message?.clientUserMessageId)
          : []),
      ],
    },
  );
  if (!completedIdentity) return false;
  liveCardsByTask.delete(taskIdValue);
  liveProbeByTask.delete(taskIdValue);
  liveUserMessagesByTask.delete(taskIdValue);
  agentHub.setLive(taskIdValue, null);
  return true;
}

function exactSelectedTaskParams() {
  return exactTaskParams(selectedTaskId);
}

function exactTaskParams(id) {
  const identity = taskIdentity(id);
  if (!identity) throw new Error("Сначала выберите задачу");
  return identity;
}

function queueBatchedMessageRender(taskIdValue, { preserveScroll = false } = {}) {
  const id = String(taskIdValue ?? "").trim();
  if (!id || messageRenderBatchDepth <= 0) return false;
  const previous = batchedMessageRenders.get(id);
  batchedMessageRenders.set(id, {
    preserveScroll: Boolean(previous?.preserveScroll || preserveScroll),
  });
  return true;
}

function renderTaskMessagesNow(taskIdValue, { preserveScroll = false } = {}) {
  const messages = reconciledMessages(taskIdValue);
  if (preserveScroll) agentHub.setMessagesPreservingScroll(taskIdValue, messages);
  else agentHub.setMessages(taskIdValue, messages);
  return messages;
}

function renderTaskMessages(taskIdValue, { preserveScroll = false } = {}) {
  if (queueBatchedMessageRender(taskIdValue, { preserveScroll })) return null;
  return renderTaskMessagesNow(taskIdValue, { preserveScroll });
}

function flushBatchedMessageRenders() {
  if (messageRenderBatchDepth > 0 || !batchedMessageRenders.size) return;
  const renders = [...batchedMessageRenders];
  batchedMessageRenders.clear();
  for (const [taskIdValue, options] of renders) renderTaskMessagesNow(taskIdValue, options);
}

function runBatchedMessageRenders(operation) {
  messageRenderBatchDepth += 1;
  try {
    return operation();
  } finally {
    messageRenderBatchDepth -= 1;
    flushBatchedMessageRenders();
  }
}

function clearInternalContextProbe(taskIdValue) {
  const cardRemoved = liveCardsByTask.delete(taskIdValue);
  const probeRemoved = liveProbeByTask.delete(taskIdValue);
  const usersRemoved = liveUserMessagesByTask.delete(taskIdValue);
  if (cardRemoved || probeRemoved || usersRemoved) renderTaskMessages(taskIdValue);
}

function syncHistoryPagination(taskIdValue) {
  const page = historyPageByTask.get(taskIdValue);
  agentHub.setHistoryPagination(taskIdValue, {
    hasOlder: page?.nextBefore != null,
    loading: page?.loading === true,
    messageTotal: page?.messageTotal,
  });
}

function updateLiveMessage(taskIdValue, selected) {
  // Only an explicitly classified user turn may own the live card. Internal or
  // unknown projections must also clear a previously cached card so a hidden
  // probe cannot keep later user input queued behind false activity.
  const run = activeTaskRun(selected);
  if (run && !isUserRunningProjection({ ...run, projectionState: "active" })) {
    const promoted = promoteLiveCompletion(taskIdValue, selected, run.turnId);
    const snapshotCompletionRemembered = rememberSnapshotCompletion(taskIdValue, selected, run.turnId);
    clearInternalContextProbe(taskIdValue);
    if (promoted || snapshotCompletionRemembered) renderTaskMessages(taskIdValue);
    return null;
  }
  const promoted = promoteLiveCompletion(taskIdValue, selected, run?.turnId);
  const snapshotCompletionRemembered = rememberSnapshotCompletion(taskIdValue, selected, run?.turnId);
  if (!run) {
    const staleLiveRemoved = liveCardsByTask.delete(taskIdValue);
    const removed = liveProbeByTask.delete(taskIdValue);
    const userRemoved = liveUserMessagesByTask.delete(taskIdValue);
    if (promoted || snapshotCompletionRemembered || staleLiveRemoved || removed || userRemoved) {
      renderTaskMessages(taskIdValue);
    }
    return null;
  }
  const runTiming = activeRunSubmissionTiming(run);
  const nextLiveUsers = {
    provider: selected.provider,
    threadId: selected.threadId,
    turnId: String(run.turnId ?? ""),
    userMessages: run.userMessages ?? [],
    prompt: run.prompt ?? "",
    promptAuthor: run.promptAuthor ?? "",
    clientUserMessageId: run.clientUserMessageId ?? "",
    submittedAt: runTiming.submittedAt,
    startedAt: runTiming.startedAt,
    time: runTiming.submittedAt,
    attachments: attachmentViews(run.attachments),
    signature: liveUserMessagesSignature(run),
  };
  const previousLiveUsers = liveUserMessagesByTask.get(taskIdValue);
  const liveUsersChanged = previousLiveUsers?.signature !== nextLiveUsers.signature;
  liveUserMessagesByTask.set(taskIdValue, nextLiveUsers);
  const response = String(run.response ?? "");
  if (run.turnId) {
    const nextProbe = {
      provider: selected.provider,
      threadId: selected.threadId,
      turnId: run.turnId,
      itemId: run.responseItemId,
      role: "agent",
    };
    const previousProbe = liveProbeByTask.get(taskIdValue);
    const probeChanged = !previousProbe
      || previousProbe.provider !== nextProbe.provider
      || previousProbe.threadId !== nextProbe.threadId
      || previousProbe.turnId !== nextProbe.turnId
      || previousProbe.itemId !== nextProbe.itemId;
    liveProbeByTask.set(taskIdValue, nextProbe);
    if (snapshotCompletionRemembered || probeChanged || liveUsersChanged) {
      renderTaskMessages(taskIdValue);
    }
  } else {
    const removed = liveProbeByTask.delete(taskIdValue);
    if (snapshotCompletionRemembered || removed || liveUsersChanged) renderTaskMessages(taskIdValue);
  }
  const liveCard = mergeLiveMaintenance({
    author: selected.provider === "claude" ? "Claude" : "Codex",
    stage: activeStageLabel(run.stage),
    reasoning: run.progress || "",
    text: response,
    activities: run.activities ?? [],
    activityGroups: run.activityGroups ?? [],
    responsePhase: run.responsePhase ?? "",
    responseAnnotationReferences: Array.isArray(run.responseAnnotationReferences)
      ? run.responseAnnotationReferences.map((reference) => ({ ...reference }))
      : [],
    threadId: selected.threadId,
    turnId: run.turnId,
    itemId: run.responseItemId ?? null,
    provider: selected.provider,
    operationKind: String(run.operationKind ?? "unknown"),
    ...(run.operationKindMigrationGuard
      ? { operationKindMigrationGuard: String(run.operationKindMigrationGuard) }
      : {}),
    projectionAuthority: "live",
    projectionState: "active",
    time: run.lastActivityAt ?? run.startedAt ?? null,
    turnStartedAt: run.startedAt ?? null,
    snapshotLastAnswerAt: selected.lastAnswerAt ?? null,
  }, maintenanceEventsByTask.get(taskIdValue) ?? []);
  liveCardsByTask.set(taskIdValue, liveCard);
  return liveCard;
}

function authorizationHeaders() {
  if (telegramInitData) return { Authorization: `tma ${telegramInitData}` };
  // Trusted devices authenticate with the HttpOnly session cookie the Hub set at
  // /api/device/session, so no credential passes through page JavaScript.
  return {};
}

function historyNeedsCatchUp(taskIdValue) {
  const deadline = Number(historyCatchUpDeadlines.get(taskIdValue)) || 0;
  if (!deadline) return false;
  if (deadline > Date.now()) return true;
  historyCatchUpDeadlines.delete(taskIdValue);
  historyCatchUpTurnIds.delete(taskIdValue);
  return false;
}

function updateHistoryCatchUp(taskIdValue, history, task) {
  const deadline = nextHistoryCatchUpDeadline({
    sourceFresh: history?.sourceFresh,
    containsLatestAnswer: historyContainsLatestAnswer(history, task, {
      expectedTurnId: historyCatchUpTurnIds.get(taskIdValue),
    }),
    currentDeadline: historyCatchUpDeadlines.get(taskIdValue),
    timeoutMs: HISTORY_CATCH_UP_TIMEOUT_MS,
  });
  if (deadline == null) {
    historyCatchUpDeadlines.delete(taskIdValue);
    historyCatchUpTurnIds.delete(taskIdValue);
    return;
  }
  historyCatchUpDeadlines.set(taskIdValue, deadline);
}

function scheduleHistoryAttachmentSettle(taskIdValue) {
  const id = String(taskIdValue ?? "").trim();
  if (!id) return;
  historyAttachmentSettleDeadlines.set(id, Date.now() + HISTORY_ATTACHMENT_SETTLE_TIMEOUT_MS);
}

function historyAttachmentsNeedSettling(taskIdValue) {
  const now = Date.now();
  for (const [id, deadline] of historyAttachmentSettleDeadlines) {
    if (Number(deadline) <= now) historyAttachmentSettleDeadlines.delete(id);
  }
  return Number(historyAttachmentSettleDeadlines.get(taskIdValue)) > now;
}

function bridgeCallOnce(action, params = {}) {
  const id = `bridge-${Date.now()}-${++bridgeSequence}`;
  const bridgeParams = action === "send-message"
    ? {
        ...params,
        clientTiming: {
          ...params.clientTiming,
          transportStartedAtMs: Date.now(),
          transportStartedMonotonicMs: performance.now(),
          transport: "vscode-ipc",
        },
      }
    : params;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingBridgeCalls.delete(id);
      reject(markConnectionFailure(new Error("Agent Hub в VS Code не ответил вовремя")));
    }, LONG_CONTROL_ACTIONS.has(action)
      ? LONG_CONTROL_TIMEOUT_MS
      : action === "send-message"
        ? VSCODE_MESSAGE_CONTROL_TIMEOUT_MS
        : DEFAULT_CONTROL_TIMEOUT_MS);
    pendingBridgeCalls.set(id, { resolve, reject, timer });
    vscode.postMessage({ type: "agenthub:control", id, action, params: bridgeParams });
  });
}

function bridgeCall(action, params = {}) {
  if (!vscode) return null;
  return retryConnectionFailure(
    () => bridgeCallOnce(action, params),
    {
      delaysMs: action === "send-message" ? VSCODE_MESSAGE_RETRY_DELAYS_MS : [],
      wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
    },
  );
}

async function hubFetch(input, init, retrySession = true) {
  try {
    // Refreshing the session re-issues the HttpOnly cookie that the request below
    // carries automatically as a same-origin request.
    await window.AgentHubBrowserDevice?.ensureSession?.();
    const response = await fetch(input, init);
    if (response.status !== 401 || !retrySession || !window.AgentHubBrowserDevice?.ensureSession) {
      return response;
    }
    await window.AgentHubBrowserDevice.ensureSession(true);
    return hubFetch(input, init, false);
  } catch (error) {
    throw markConnectionFailure(error);
  }
}

async function hubFetchWithin(input, init, timeoutMs) {
  const controller = new AbortController();
  const effectiveTimeoutMs = Math.max(1, Number(timeoutMs) || 1);
  let timedOut = false;
  const timer = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, effectiveTimeoutMs);
  try {
    return await hubFetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (!timedOut) throw error;
    const timeout = new Error(`Agent Hub не подтвердил команду за ${Math.ceil(effectiveTimeoutMs / 1_000)} с.`);
    timeout.name = "TimeoutError";
    timeout.code = "AGENT_HUB_CONTROL_TIMEOUT";
    throw markConnectionFailure(timeout);
  } finally {
    window.clearTimeout(timer);
  }
}

window.addEventListener("message", window.AgentHubHostMessageTrust.guardHostMessage((event) => {
  const message = event.data;
  if (message?.type === "agenthub:runtime-published") {
    reloadForPublishedRuntime();
    return;
  }
  if (message?.type !== "agenthub:control-result") return;
  const pending = pendingBridgeCalls.get(String(message.id ?? ""));
  if (!pending) return;
  pendingBridgeCalls.delete(String(message.id));
  window.clearTimeout(pending.timer);
  if (message.ok) pending.resolve(message.result);
  else {
    const error = new Error(String(message.error ?? "Команда Agent Hub завершилась с ошибкой"));
    pending.reject(looksLikeConnectionFailure(error)
      ? markConnectionFailure(error)
      : markCommandRejected(error));
  }
}));

async function waitRemoteResult(commandId, timeoutMs = DEFAULT_CONTROL_TIMEOUT_MS) {
  await localSessionReady;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await hubFetch(
      `/api/control/result?id=${encodeURIComponent(commandId)}&waitMs=${REMOTE_WAIT_MS}`,
      {
        headers: authorizationHeaders(),
        cache: "no-store",
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (response.status === 202 || payload.pending) {
      await new Promise((resolve) => window.setTimeout(resolve, REMOTE_RESULT_FALLBACK_POLL_MS));
      continue;
    }
    if (!response.ok || payload.ok === false) {
      throw markCommandRejected(
        new Error(String(payload.error ?? `Agent Hub: HTTP ${response.status}`)),
      );
    }
    return payload.result;
  }
  throw markConnectionFailure(
    new Error("Локальный Agent Hub не ответил. Команда сохранена в Mini App."),
  );
}

async function acknowledgeLocalControl(commandId) {
  const response = await hubFetch("/api/control/ack", {
    method: "POST",
    headers: {
      ...authorizationHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ commandId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw markCommandRejected(
      new Error(String(payload.error ?? `Agent Hub: HTTP ${response.status}`)),
    );
  }
}

function observeQueuedRemoteMessage(commandId, params) {
  const releaseOptimisticQueue = (stateName) => {
    const clientUserMessageId = String(params?.clientUserMessageId ?? "").trim();
    if (!clientUserMessageId) return "";
    optimisticDeferredClientUserMessageIds.delete(clientUserMessageId);
    deferredClientUserMessageIds.delete(clientUserMessageId);
    const resolvedTaskId = updateOutgoing("", clientUserMessageId, {
      remoteQueued: false,
      remoteCommandId: commandId,
      ...deliveryPatch(stateName),
    });
    if (resolvedTaskId) {
      renderTaskQueue(resolvedTaskId);
      renderTaskMessages(resolvedTaskId);
    }
    return resolvedTaskId;
  };
  void window.AgentHubMessageSendTransaction.observeRemote({
    wait: () => waitRemoteResult(commandId, LONG_CONTROL_TIMEOUT_MS),
    receive: (result) => {
      const clientUserMessageId = String(params?.clientUserMessageId ?? "").trim();
      if (clientUserMessageId) {
        const projection = queueHistoryReceiptProjection(result);
        if (!projection.ownsDeferredQueue) {
          optimisticDeferredClientUserMessageIds.delete(clientUserMessageId);
          deferredClientUserMessageIds.delete(clientUserMessageId);
        }
        const resolvedTaskId = updateOutgoing("", clientUserMessageId, {
          threadId: result?.threadId ?? params?.threadId ?? "",
          turnId: result?.turnId ?? "",
          itemId: result?.itemId ?? clientUserMessageId,
          projectionAuthority: "canonical",
          projectionState: projection.projectionState,
          ...(projection.submittedAt ? {
            submittedAt: projection.submittedAt,
            time: projection.submittedAt,
          } : {}),
          ...(projection.startedAt ? { startedAt: projection.startedAt } : {}),
          remoteQueued: false,
          remoteCommandId: commandId,
          providerAccepted: projection.providerAccepted,
          ...deliveryPatch(projection.deliveryState ?? "rejected"),
        });
        if (resolvedTaskId) renderTaskMessages(resolvedTaskId);
      }
      if (result?.snapshot) applySnapshot(result.snapshot);
      else void refresh();
    },
    reject: (error) => {
      releaseOptimisticQueue("rejected");
      agentHub.toast(String(error?.message ?? "Сообщение отклонено локальным Agent Hub"));
    },
    unconfirm: () => {
      releaseOptimisticQueue("unconfirmed");
      agentHub.toast("Hub не подтвердил приём сообщения. Статус будет уточнён по snapshot.");
    },
    refresh: () => { void refresh(); },
    definitelyRejected: messageSendDefinitelyRejected,
    report: (error) => console.error("Agent Hub queued message reconciliation failed", error),
  });
}

async function readSnapshot(params = {}) {
  await localSessionReady;
  const query = snapshotQuery(params);
  const response = await hubFetch(`/api/snapshot?${query}`, {
    headers: authorizationHeaders(),
    cache: "no-store",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.error ?? `Agent Hub: HTTP ${response.status}`));
  }
  return payload;
}

function snapshotQuery(params = {}) {
  return new URLSearchParams({
    knownVersion: String(params?.knownVersion ?? ""),
    compactSnapshot: params?.compactSnapshot === true ? "1" : "0",
    snapshotProtocol: String(params?.snapshotProtocol ?? 3),
    conversationsVersion: String(params?.conversationsVersion ?? ""),
    workspacesVersion: String(params?.workspacesVersion ?? ""),
    boardTasksVersion: String(params?.boardTasksVersion ?? ""),
    messageReceiptsVersion: String(params?.messageReceiptsVersion ?? ""),
    waitMs: String(REMOTE_WAIT_MS),
  });
}

async function probeSnapshotTransport() {
  await localSessionReady;
  const query = snapshotQuery(window.AgentHubSnapshotTransport.requestParams(lastSnapshot));
  const response = await hubFetch(`/api/snapshot?${query}`, {
    method: "HEAD",
    headers: authorizationHeaders(),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Agent Hub: HTTP ${response.status}`);
  }
}

async function probeVscodeRuntimeHealth() {
  const probe = window.__agentHubIpcRuntimeHealth;
  if (typeof probe !== "function") throw new Error("Agent Hub: IPC health недоступен");
  const response = await probe();
  if (!response.ok) {
    throw new Error(`Agent Hub: HTTP ${response.status}`);
  }
}

async function prepareSnapshotTransport() {
  if (snapshotTransportPrepared) return;
  snapshotTransportPrepared = true;
  await localSessionReady;
  await window.AgentHubBrowserDevice?.ensureSession?.();
  if (vscode) await window.__agentHubDirectTransport?.available?.();
}

async function httpControl(action, params = {}) {
  if (action === "snapshot") return readSnapshot(params);
  await localSessionReady;
  const commandId = crypto.randomUUID();
  const payload = await retryConnectionFailure(async () => {
    const requestParams = action === "send-message"
      ? {
          ...params,
          clientTiming: {
            ...params.clientTiming,
            transportStartedAtMs: Date.now(),
            transportStartedMonotonicMs: performance.now(),
            transport: "direct-http",
          },
        }
      : params;
    const response = await hubFetchWithin("/api/control", {
      method: "POST",
      headers: {
        ...authorizationHeaders(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ action, params: requestParams, commandId }),
    }, LONG_CONTROL_ACTIONS.has(action) ? LONG_CONTROL_TIMEOUT_MS : DEFAULT_CONTROL_TIMEOUT_MS);
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result.ok === false) throw httpControlError(response.status, result);
    return result;
  }, {
    delaysMs: HTTP_CONTROL_RETRY_DELAYS_MS,
    wait: (delayMs) => new Promise((resolve) => window.setTimeout(resolve, delayMs)),
    shouldRetry: (error) => String(error?.code ?? "") === "AGENT_HUB_HTTP_GATEWAY",
  });
  if (payload.receiptId === commandId) {
    void acknowledgeLocalControl(commandId).catch((error) => {
      console.warn(`Agent Hub control acknowledgement failed: ${error.message}`);
    });
  }
  if (payload.pending && payload.id && action === "send-message") {
    observeQueuedRemoteMessage(payload.id, params);
    return {
      deferred: true,
      queued: true,
      remoteQueued: true,
      remoteCommandId: payload.id,
      threadId: params.threadId,
      clientUserMessageId: params.clientUserMessageId,
      message: "Сообщение принято Worker и поставлено в очередь доставки.",
    };
  }
  return payload.pending && payload.id
    ? waitRemoteResult(
        payload.id,
        LONG_CONTROL_ACTIONS.has(action) ? LONG_CONTROL_TIMEOUT_MS : DEFAULT_CONTROL_TIMEOUT_MS,
      )
    : payload.result;
}

function clientTraceSurface() {
  if (vscode) return "vscode-webview";
  if (telegramMode) return "telegram-mini-app";
  if (window.AgentHubAndroid) return "android";
  return "browser";
}

function reportClientCommandAck(commandId, clientTiming, outcome) {
  const timing = {
    ...clientTiming,
    clientAckAtMs: Date.now(),
    clientAckMonotonicMs: performance.now(),
  };
  void hubFetch("/api/command-trace/client-ack", {
    method: "POST",
    headers: {
      ...authorizationHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      commandId,
      timing,
      outcome,
      surface: clientTraceSurface(),
    }),
  }).catch(() => {});
}

async function control(action, params = {}) {
  const directTransport = window.__agentHubDirectTransport;
  let directAvailable = false;
  if (vscode && directTransport) {
    if (typeof directTransport.ready === "function") {
      directAvailable = directTransport.ready() === true;
      if (!directAvailable) directTransport.warmup?.();
    } else {
      directAvailable = await directTransport.available();
    }
  }
  const bridged = directAvailable ? null : bridgeCall(action, params);
  if (bridged) return bridged;
  if (vscode && action === "send-message") {
    return window.AgentHubMessageSendTransaction.firstSuccessfulWithDelayedFallback({
      primary: () => httpControl(action, params),
      fallback: () => bridgeCall(action, params),
      delayMs: VSCODE_DIRECT_SEND_HEDGE_DELAY_MS,
    });
  }
  return httpControl(action, params);
}

window.AgentHubWebDiagnostics?.bindReporter?.((event) => control("report-diagnostic", event));

function modelTask(task, snapshot, effectiveSelectedId, serverSelectedId) {
  const id = taskId(task.provider, task.threadId, task.streamId);
  const streamId = String(task.streamId ?? "").trim()
    || `legacy:${String(task.provider ?? "").trim()}:${String(task.threadId ?? "").trim()}`;
  const answerAt = Date.parse(task.lastAnswerAt ?? "") || 0;
  const running = window.AgentHubStreamTabs.isExactActiveUserTurn(task);
  const unknown = task.activityUnknown === true;
  const unread = task.unread === true;
  const serverSelected = id === serverSelectedId;
  const executionOwner = task.run?.executionOwner ?? task.executionOwner ?? "";
  const runtimeTitle = task.run?.runtime ?? task.runtime ?? "";
  const { workspace, stream: catalogStream } = window.AgentHubStreamTabs.resolveTaskHierarchy(
    task,
    snapshot.workspaces,
  );
  return {
    id,
    title: task.displayTitle || task.title || "Без названия",
    displayTitle: task.displayTitle || task.title || "Без названия",
    threadTitle: task.threadTitle || task.title || "Без названия",
    workspaceId: task.workspaceId ?? workspace?.id ?? null,
    workspaceName: task.workspaceName ?? workspace?.name ?? null,
    workspaceKind: task.workspaceKind ?? workspace?.kind ?? null,
    streamId,
    streamName: task.streamName ?? catalogStream?.name ?? null,
    streamDisplayName: task.streamDisplayName ?? catalogStream?.displayName ?? "",
    streamOrdinal: Number(task.streamOrdinal ?? catalogStream?.ordinal) || 1,
    threadPosition: Number(task.threadPosition) || 1,
    threadId: task.threadId,
    provider: task.provider,
    projectRoot: task.projectRoot ?? null,
    sessionCwd: task.sessionCwd ?? null,
    agentLabel: task.provider === "claude" ? "Claude" : "Codex",
    modelLabel: task.run?.model ?? task.model ?? (serverSelected ? snapshot.selected?.model : ""),
    reasoningLabel: serverSelected ? snapshot.selected?.reasoning : task.run?.reasoning ?? "",
    modeLabel: serverSelected ? snapshot.selected?.mode : "",
    runtimeLabel: runtimeShortLabels[executionOwner] ?? (runtimeTitle ? "EXT" : ""),
    runtimeTitle,
    project: task.projectName || "",
    status: running ? "running" : unknown ? "unknown" : unread ? "ready" : "idle",
    statusLabel: running ? "Выполняется" : unknown ? "Статус неизвестен" : unread ? "Ответ готов" : "",
    lastActivity: task.orderingActivityAtMs
      ? new Date(task.orderingActivityAtMs).toISOString()
      : task.lastAnswerAt,
    startedAt: running ? task.run?.startedAt ?? task.startedAt ?? null : null,
    unread: !running && unread,
    running,
    selected: id === effectiveSelectedId,
    maintenance: task.maintenance ?? null,
    context: task.run?.context ?? task.context ?? null,
    providerStart: task.run?.providerStart ?? null,
    providerTurnTelemetry: task.providerTurnTelemetry ?? null,
    latestFinal: task.latestFinal ?? null,
    streamSettings: { ...(catalogStream?.settings ?? {}) },
    workspaceSettings: { ...(workspace?.settings ?? {}) },
    streamDeveloperRules: catalogStream?.developerRules ?? null,
    workspaceDeveloperRules: workspace?.developerRules ?? null,
  };
}

function emptyStreamModels(snapshot, effectiveSelectedId) {
  const realStreamIds = new Set((snapshot.tasks ?? []).map((task) => String(task.streamId ?? "").trim()));
  const defaults = snapshot.settings ?? {};
  const projects = defaults.projects ?? [];
  const modelsByProvider = defaults.modelOptionsByProvider ?? {};
  const drafts = [];
  for (const workspace of snapshot.workspaces ?? []) {
    for (const stream of workspace.streams ?? []) {
      if ((stream.threads ?? []).length || realStreamIds.has(String(stream.id))) continue;
      const settings = {
        provider: stream.settings?.provider ?? defaults.provider ?? "codex",
        model: stream.settings?.model ?? defaults.model ?? "",
        reasoning: stream.settings?.reasoning ?? defaults.reasoning ?? "",
        mode: stream.settings?.mode ?? defaults.mode ?? "",
        project: stream.settings?.project
          ?? projects.find((project) => project.selected)?.path
          ?? projects[0]?.path
          ?? "",
        workingDirectory: String(stream.settings?.workingDirectory ?? "").trim(),
        autoApprove: typeof stream.settings?.autoApprove === "boolean"
          ? stream.settings.autoApprove
          : defaults.approvalMode === "auto",
      };
      const efforts = defaults.reasoningOptionsByProvider?.[settings.provider] ?? [];
      if (!efforts.some((option) => option.value === settings.reasoning)) {
        settings.reasoning = efforts[0]?.value ?? settings.reasoning;
      }
      const model = (modelsByProvider[settings.provider] ?? [])
        .find((option) => option.value === settings.model);
      drafts.push({
        id: String(stream.id),
        title: workspace.name || "Без названия",
        displayTitle: workspace.name || "Без названия",
        threadTitle: "Thread будет создан при отправке",
        workspaceId: workspace.id,
        workspaceName: workspace.name,
        workspaceKind: workspace.kind,
        streamId: stream.id,
        streamName: stream.name,
        streamDisplayName: stream.displayName,
        streamOrdinal: stream.ordinal,
        threadPosition: 0,
        threadId: null,
        provider: settings.provider,
        agentLabel: settings.provider === "claude" ? "Claude" : "Codex",
        modelLabel: model?.label ?? settings.model,
        reasoningLabel: settings.reasoning,
        modeLabel: settings.mode,
        project: projects.find((project) => project.path === settings.project)?.name ?? "",
        status: "draft",
        statusLabel: "Настройка",
        lastActivity: stream.updatedAtMs ? new Date(stream.updatedAtMs).toISOString() : null,
        unread: false,
        running: false,
        selected: String(stream.id) === effectiveSelectedId,
        draftStream: true,
        streamSettings: settings,
        workspaceSettings: { ...(workspace.settings ?? {}) },
        streamDeveloperRules: stream.developerRules ?? null,
        workspaceDeveloperRules: workspace.developerRules ?? null,
      });
    }
  }
  return drafts;
}

function snapshotTaskStableId(task) {
  const streamId = String(task?.streamId ?? "").trim();
  if (streamId) return streamId;
  return `${String(task?.provider ?? "")}:${String(task?.threadId ?? "")}`;
}

function snapshotWorkspaceForSelection(snapshot, selectionId) {
  const id = String(selectionId ?? "").trim();
  if (!id) return null;
  const task = (snapshot?.tasks ?? []).find((candidate) => snapshotTaskStableId(candidate) === id);
  if (task) {
    const taskWorkspaceId = String(task.workspaceId ?? "").trim();
    if (taskWorkspaceId) {
      return (snapshot?.workspaces ?? [])
        .find((workspace) => String(workspace?.id ?? "").trim() === taskWorkspaceId) ?? null;
    }
  }
  return (snapshot?.workspaces ?? []).find((workspace) => (
    (workspace?.streams ?? []).some((stream) => String(stream?.id ?? "").trim() === id)
  )) ?? null;
}

function snapshotFallbackSelectionId(previousSnapshot, snapshot, previousSelectionId) {
  const previousWorkspace = snapshotWorkspaceForSelection(previousSnapshot, previousSelectionId);
  const workspaceId = String(previousWorkspace?.id ?? "").trim();
  if (!workspaceId) return "";
  const nextWorkspace = (snapshot?.workspaces ?? [])
    .find((workspace) => String(workspace?.id ?? "").trim() === workspaceId);
  const availableStreamIds = (nextWorkspace?.streams ?? [])
    .map((stream) => String(stream?.id ?? "").trim())
    .filter(Boolean);
  if (!availableStreamIds.length) return "";
  const previousStreamIds = (previousWorkspace?.streams ?? [])
    .map((stream) => String(stream?.id ?? "").trim())
    .filter(Boolean);
  const previousIndex = previousStreamIds.indexOf(String(previousSelectionId ?? "").trim());
  return availableStreamIds[Math.min(Math.max(0, previousIndex), availableStreamIds.length - 1)] ?? "";
}

function contextPercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const percent = Number(value);
  return Number.isFinite(percent) ? Math.round(Math.max(0, Math.min(100, percent))) : null;
}

function storedMaintenancePercent(event, position) {
  const match = /(\?|\d+)%>(\?|\d+)%/u.exec(String(event?.text ?? ""));
  const percent = match?.[position] === "?" ? null : contextPercent(match?.[position]);
  return position === 2 && percent === 0 ? null : percent;
}

function taskDisplayTitle(task) {
  const displayTitle = String(task?.displayTitle ?? "").trim();
  if (displayTitle) return displayTitle;
  const workspaceName = String(task?.workspaceName ?? "").trim();
  const streamName = String(task?.streamName ?? "").trim()
    || (String(task?.streamId ?? "").trim() ? "Stream 1" : "");
  if (workspaceName && streamName) return `${workspaceName} - ${streamName}`;
  if (workspaceName) return workspaceName;
  if (streamName) return streamName;
  return String(task?.title ?? "").trim() || "Без названия";
}

function rotationMaintenanceActive(task) {
  return ["manual-rotation", "automatic-rotation"].includes(
    String(task?.maintenance?.reason ?? ""),
  );
}

function activeMaintenanceMessage(task) {
  const stableTaskId = taskId(task.provider, task.threadId, task.streamId);
  if (rotationMaintenanceActive(task)) {
    return {
      id: `maintenance:rotation:${stableTaskId}:active`,
      provider: task.provider,
      threadId: task.threadId,
      itemId: `maintenance:rotation:${stableTaskId}:active`,
      role: "system",
      kind: "maintenance",
      operationKind: "maintenance",
      text: "Ротация контекста…",
      time: task.maintenance?.startedAt ?? null,
    };
  }
  const compaction = task.context?.compaction;
  const compactionId = String(compaction?.id ?? "");
  if (!compactionId) return null;
  const status = String(compaction.status ?? "");
  const measurementStatus = String(compaction.measurementStatus ?? "");
  let text = "";
  if (status === "running") {
    text = compaction.origin === "automatic"
      ? "Автосвёртка контекста…"
      : "Свёртка контекста…";
  } else if (status === "completed" && (
    measurementStatus === "running"
    || (!measurementStatus && task.context?.usagePending)
  )) {
    text = "Замер контекста…";
  }
  if (!text) return null;
  return {
    id: `maintenance:compaction:${compactionId}:active`,
    provider: task.provider,
    threadId: task.threadId,
    turnId: compaction.turnId ?? null,
    itemId: `maintenance:compaction:${compactionId}:active`,
    role: "system",
    kind: "maintenance",
    operationKind: status === "completed" ? "measurement" : "compaction",
    text,
    time: status === "completed"
      ? compaction.completedAt ?? compaction.startedAt ?? null
      : compaction.startedAt ?? null,
  };
}

function syncActiveMaintenanceMessages(tasks) {
  const changed = new Set();
  const currentTaskIds = new Set();
  for (const task of tasks ?? []) {
    const stableTaskId = taskId(task.provider, task.threadId, task.streamId);
    currentTaskIds.add(stableTaskId);
    const previous = activeMaintenanceByTask.get(stableTaskId) ?? null;
    const next = activeMaintenanceMessage(task);
    if (JSON.stringify(previous) === JSON.stringify(next)) continue;
    if (next) activeMaintenanceByTask.set(stableTaskId, next);
    else activeMaintenanceByTask.delete(stableTaskId);
    changed.add(stableTaskId);
  }
  for (const stableTaskId of activeMaintenanceByTask.keys()) {
    if (currentTaskIds.has(stableTaskId)) continue;
    activeMaintenanceByTask.delete(stableTaskId);
    changed.add(stableTaskId);
  }
  return changed;
}

function observeContextCompactions(tasks) {
  const changed = new Set();
  for (const task of tasks ?? []) {
    const context = task.context;
    const compaction = context?.compaction;
    const compactionId = String(compaction?.id ?? "");
    if (!compactionId) continue;
    const stableTaskId = taskId(task.provider, task.threadId, task.streamId);
    const eventId = `maintenance:compaction:${compactionId}`;
    const existingEvent = (maintenanceEventsByTask.get(stableTaskId) ?? [])
      .find((event) => event.id === eventId);
    const previous = observedContextCompactions.get(compactionId) ?? {};
    const previousStatus = previous.status;
    const status = String(compaction.status ?? "");
    const measurementStatus = String(compaction.measurementStatus ?? "");
    const beforePercent = contextPercent(compaction.beforePercent)
      ?? previous.beforePercent
      ?? contextPercent(existingEvent?.beforePercent)
      ?? storedMaintenancePercent(existingEvent, 1)
      ?? (status === "running" ? contextPercent(context?.percent) : null);
    const explicitAfterPercent = contextPercent(compaction.afterPercent) || null;
    const afterPercent = ["running", "failed"].includes(measurementStatus)
      ? null
      : measurementStatus === "completed"
        ? explicitAfterPercent
        : previous.afterPercent
          ?? contextPercent(existingEvent?.afterPercent)
          ?? storedMaintenancePercent(existingEvent, 2)
          ?? explicitAfterPercent;
    const requested = requestedContextCompactions.has(compactionId);
    const eventAtMs = Date.parse(String(compaction.completedAt ?? compaction.startedAt ?? "")) || 0;
    const recent = eventAtMs > 0 && Date.now() - eventAtMs < 90_000;
    if (status === "running"
      && previousStatus !== "running"
      && compaction.origin === "automatic"
      && recent) {
      agentHub.toast(`Началась автосвёртка контекста · ${taskDisplayTitle(task)}`);
    } else if (status === "completed" && previousStatus !== "completed") {
      requestedContextCompactions.delete(compactionId);
    } else if (status === "timeout" && previousStatus !== "timeout") {
      if (requested || (compaction.origin === "automatic" && recent)) {
        agentHub.toast(`Не удалось подтвердить завершение свёртки контекста · ${taskDisplayTitle(task)}`);
      }
      requestedContextCompactions.delete(compactionId);
    }
    if (["failed", "timeout"].includes(status)) {
      const automatic = compaction.origin === "automatic";
      if (rememberMaintenanceEvent(stableTaskId, {
        id: eventId,
        provider: task.provider,
        threadId: task.threadId,
        itemId: eventId,
        turnId: compaction.turnId ?? null,
        beforePercent,
        afterPercent: null,
        maintenanceType: "compaction",
        maintenanceStatus: status,
        text: automatic
          ? "Автосвёртка контекста не завершилась"
          : "Свёртка контекста не завершилась",
        time: existingEvent?.time ?? compaction.completedAt ?? new Date().toISOString(),
      })) changed.add(stableTaskId);
    }
    const measurementPending = measurementStatus === "running"
      || (!measurementStatus && context?.usagePending);
    if (status === "completed" && !measurementPending) {
      const measurementKnown = beforePercent !== null && afterPercent !== null;
      const maintenanceLabel = measurementKnown
        ? "Свёртка завершена успешно"
        : "Свёртка завершена";
      const maintenanceDetail = measurementKnown
        ? `${beforePercent}% → ${afterPercent}%`
        : beforePercent !== null
          ? `${beforePercent}% → замер после не получен`
          : "Замер контекста не получен";
      const text = measurementKnown
        ? `Свёртка завершена успешно ${beforePercent}%>${afterPercent}%`
        : beforePercent !== null
          ? `Свёртка завершена; до ${beforePercent}%, замер после не получен`
          : "Свёртка завершена; замер контекста не получен";
      if (rememberMaintenanceEvent(stableTaskId, {
        id: eventId,
        provider: task.provider,
        threadId: task.threadId,
        itemId: eventId,
        turnId: compaction.turnId ?? null,
        maintenanceType: "compaction",
        maintenanceStatus: "completed",
        maintenanceLabel,
        maintenanceDetail,
        beforePercent,
        afterPercent,
        text,
        time: existingEvent?.time ?? compaction.completedAt ?? new Date().toISOString(),
      })) changed.add(stableTaskId);
    }
    observedContextCompactions.delete(compactionId);
    observedContextCompactions.set(compactionId, {
      status,
      measurementStatus,
      beforePercent,
      afterPercent,
    });
    while (observedContextCompactions.size > 100) {
      observedContextCompactions.delete(observedContextCompactions.keys().next().value);
    }
  }
  return changed;
}

function observeStreamRotations(previousTasks, tasks) {
  const changed = new Set();
  const currentByStream = window.AgentHubStreamTabs.streamHeadTasks(tasks);
  for (const transition of window.AgentHubStreamTabs.streamRotationTransitions(previousTasks, tasks)) {
    pendingStreamRotations.set(transition.streamId, {
      provider: transition.task.provider,
      threadId: transition.task.threadId,
      sourceThreadId: transition.sourceThreadId,
      beforePercent: transition.beforePercent,
      time: transition.time,
    });
  }
  for (const [streamId, task] of currentByStream) {
    const pending = pendingStreamRotations.get(streamId);
    if (!pending || String(pending.threadId) !== String(task.threadId)) continue;
    if (rotationMaintenanceActive(task)) continue;
    const beforePercent = contextPercent(pending.beforePercent);
    const afterPercent = task.context?.usagePending
      ? null
      : contextPercent(task.context?.percent);
    const presentation = window.AgentHubStreamTabs.rotationMaintenancePresentation(
      beforePercent,
      afterPercent,
    );
    const stableTaskId = taskId(task.provider, task.threadId, streamId);
    const eventId = `maintenance:rotation:${streamId}:${task.threadId}`;
    if (rememberMaintenanceEvent(stableTaskId, {
      id: eventId,
      provider: pending.provider,
      threadId: task.threadId,
      sourceThreadId: pending.sourceThreadId,
      itemId: eventId,
      maintenanceType: "rotation",
      maintenanceStatus: "completed",
      maintenanceLabel: presentation.maintenanceLabel,
      maintenanceDetail: presentation.maintenanceDetail,
      placement: "after-source-turn",
      beforePercent,
      afterPercent,
      text: presentation.text,
      time: pending.time,
    })) changed.add(stableTaskId);
    if (afterPercent !== null) pendingStreamRotations.delete(streamId);
  }
  for (const streamId of pendingStreamRotations.keys()) {
    if (currentByStream.has(streamId)) continue;
    pendingStreamRotations.delete(streamId);
  }
  return changed;
}

function representativeSnapshotTasks(tasks) {
  return window.AgentHubStreamTabs.representativeSnapshotTasks(tasks);
}

function applySnapshot(snapshot, { materialized = false } = {}) {
  if (!snapshot) return;
  if (!materialized) snapshot = window.AgentHubSnapshotTransport.materialize(lastSnapshot, snapshot);
  if (observeServerIdentity(snapshot)) return;
  let effectiveSelectedId = "";
  let tasks = [];
  runBatchedMessageRenders(() => {
    resetConnectionFailures();
    const previousSnapshot = lastSnapshot;
    const previousTasks = previousSnapshot?.tasks ?? [];
    lastSnapshot = snapshot;
    const representativeTasks = representativeSnapshotTasks(snapshot.tasks);
    agentHub.setExchangeRates(snapshot.exchangeRates ?? null);
    agentHub.setServerStatus(snapshot.server ?? null);
    agentHub.setWorkspaces(snapshot.workspaces ?? [], snapshot.boardLayout?.columnOrder ?? []);
    agentHub.setArchivedWorkspaces(snapshot.archivedWorkspaces ?? []);
    const maintenanceChanged = new Set([
      ...observeContextCompactions(snapshot.tasks),
      ...observeStreamRotations(previousTasks, snapshot.tasks),
      ...syncActiveMaintenanceMessages(representativeTasks),
    ]);
    if (snapshot.messageReceipts !== previousSnapshot?.messageReceipts) applyMessageReceipts(snapshot);
    const serverDeferredClientUserMessageIds = new Set(queuedCommandClientUserMessageIds(
      snapshot.deferredInputs,
      snapshot.messageReceipts,
    ));
    const activeRunReceipts = authoritativeActiveRunMessageReceipts(snapshot.tasks);
    const nextActiveRunClientUserMessageIds = new Set(
      activeRunReceipts.map((receipt) => receipt.clientUserMessageId),
    );
    const newlyAcceptedRunReceipts = activeRunReceipts.filter((receipt) => (
      !activeRunClientUserMessageIds.has(receipt.clientUserMessageId)
    ));
    if (newlyAcceptedRunReceipts.length) {
      applyMessageReceipts({ messageReceipts: newlyAcceptedRunReceipts });
    }
    activeRunClientUserMessageIds = nextActiveRunClientUserMessageIds;
    for (const clientUserMessageId of optimisticDeferredClientUserMessageIds) {
      if (
        serverDeferredClientUserMessageIds.has(clientUserMessageId)
        || activeRunClientUserMessageIds.has(clientUserMessageId)
      ) optimisticDeferredClientUserMessageIds.delete(clientUserMessageId);
    }
    deferredClientUserMessageIds = new Set([
      ...serverDeferredClientUserMessageIds,
      ...optimisticDeferredClientUserMessageIds,
    ]);
    const serverSelected = (snapshot.tasks ?? []).find((task) => task.selected);
    const serverSelectedId = serverSelected
      ? taskId(serverSelected.provider, serverSelected.threadId, serverSelected.streamId)
      : "";
    const emptyStreamIds = (snapshot.workspaces ?? []).flatMap((workspace) => (
      (workspace.streams ?? []).filter((stream) => !(stream.threads ?? []).length).map((stream) => String(stream.id))
    ));
    const availableTaskIds = new Set([
      ...(snapshot.tasks ?? []).map((task) => taskId(task.provider, task.threadId, task.streamId)),
      ...emptyStreamIds,
    ]);
    const pendingExists = pendingSelectionId && availableTaskIds.has(pendingSelectionId);
    const localExists = selectedTaskId && availableTaskIds.has(selectedTaskId);
    const workspaceFallbackSelectionId = !pendingExists && !localExists
      ? snapshotFallbackSelectionId(previousSnapshot, snapshot, selectedTaskId)
      : "";
    const workspaceFallbackExists = workspaceFallbackSelectionId
      && availableTaskIds.has(workspaceFallbackSelectionId);
    effectiveSelectedId = pendingExists
      ? pendingSelectionId
      : localExists
        ? selectedTaskId
        : workspaceFallbackExists
          ? workspaceFallbackSelectionId
          : serverSelectedId;
    tasks = [
      ...representativeTasks.map((task) => modelTask(task, snapshot, effectiveSelectedId, serverSelectedId)),
      ...emptyStreamModels(snapshot, effectiveSelectedId),
    ].sort((left, right) => Date.parse(right.lastActivity || 0) - Date.parse(left.lastActivity || 0));
    const selectedTask = tasks.find((task) => task.id === effectiveSelectedId);
    const selectedWorkspaceId = String(selectedTask?.workspaceId ?? "").trim() || null;
    const selectedStreamId = String(selectedTask?.streamId ?? "").trim() || null;
    window.AgentHubTaskBoard?.setSnapshot({
      tasks: boardTaskViews(snapshot.boardTasks),
      workspaces: snapshot.workspaces ?? [],
      columnOrder: snapshot.boardLayout?.columnOrder ?? [],
      notesComment: snapshot.boardLayout?.notesComment ?? "",
      selectedWorkspaceId,
      selectedStreamId,
      provider: snapshot.settings?.provider ?? "codex",
      conversations: snapshot.tasks ?? [],
      deferredInputs: snapshot.deferredInputs ?? [],
    });
    agentHub.setTasks(tasks);
    for (const task of tasks.filter((candidate) => candidate.draftStream)) agentHub.setMessages(task.id, []);
    if (maintenanceChanged.has(effectiveSelectedId)) {
      renderTaskMessages(effectiveSelectedId, { preserveScroll: true });
    }
    for (const deferred of snapshot.deferredInputs ?? []) {
      const clientUserMessageId = String(deferred.clientUserMessageId ?? "");
      if (!clientUserMessageId) continue;
      const deferredDeliveryState = queuedCommandDeliveryState(
        deferred,
        snapshot.messageReceipts,
      );
      if (!deferredDeliveryState) {
        restoreImmediateIntakeMessage(deferred, snapshot.messageReceipts);
        continue;
      }
      patchOutgoing(
        taskId(deferred.provider, deferred.threadId, deferred.streamId),
        clientUserMessageId,
        {
          ...deliveryPatch(deferredDeliveryState),
          projectionState: "queued",
          providerAccepted: false,
          time: deferred.createdAt ?? null,
          ...nonEmptyAttachmentPatch(deferred.attachments),
        },
      );
    }
    for (const task of snapshot.tasks ?? []) {
      const clientUserMessageId = String(task.run?.clientUserMessageId ?? "");
      if (!clientUserMessageId || !runHasAuthoritativeProviderAcceptance(task.run)) continue;
      patchOutgoing(taskId(task.provider, task.threadId, task.streamId), clientUserMessageId, {
        provider: task.provider,
        threadId: task.threadId,
        turnId: String(task.run?.turnId ?? ""),
        time: task.run?.startedAt ?? null,
        ...nonEmptyAttachmentPatch(task.run?.attachments),
        // The run-level receipt is assigned only when Agent Hub starts a new
        // turn. It identifies the first user item even while Codex history has
        // not yet echoed client_id back to us.
        turnUserSlot: "root",
        projectionState: "active",
        providerAccepted: true,
        ...deliveryPatch("accepted"),
      });
    }
    const selected = representativeTasks.find(
      (task) => taskId(task.provider, task.threadId, task.streamId) === effectiveSelectedId,
    );
    rememberSelectedTaskId(effectiveSelectedId);
    for (const task of representativeTasks) {
      const stableTaskId = taskId(task.provider, task.threadId, task.streamId);
      agentHub.setLive(stableTaskId, updateLiveMessage(stableTaskId, task));
      agentHub.setRunning(stableTaskId, Boolean(task.running));
    }
    for (const task of representativeTasks) {
      renderTaskQueue(taskId(task.provider, task.threadId, task.streamId), snapshot);
    }
    if (selected) {
      agentHub.setApprovals(selectedTaskId, effectiveSelectedId === serverSelectedId
        ? (snapshot.pendingApprovals ?? []).map((approval) => ({
        id: approval.key ?? approval.id,
        kind: approval.kind ?? "Подтверждение",
        text: approval.text ?? approval.preview ?? approval.reason ?? "",
        questions: Array.isArray(approval.questions) ? approval.questions : null,
        options: window.AgentHubApprovalForm.approvalOptions(approval),
        }))
        : []);
    }
  });
  const settings = snapshot.settings ?? {};
  agentHub.setOptions({
    provider: [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }],
    model: settings.models ?? [],
    modelOptionsByProvider: settings.modelOptionsByProvider ?? {},
    reasoning: settings.reasoningOptions ?? [],
    reasoningOptionsByProvider: settings.reasoningOptionsByProvider ?? {},
    mode: settings.modeOptions ?? [],
  });
  const selectedDraft = tasks.find((task) => task.id === effectiveSelectedId && task.draftStream);
  agentHub.setSelection(window.AgentHubSnapshotTransport.selectionFromSnapshotSettings(
    settings,
    selectedDraft?.streamSettings,
  ));
  applySnapshotConnection(snapshot);
}

function applySnapshotConnection(snapshot, idleStatus = "online") {
  const connection = window.AgentHubConnectionBanner.snapshotConnectionState(snapshot, idleStatus);
  agentHub.setConnection(connection.status, { blockingCount: connection.blockingCount });
}

function resetConnectionFailures() {
  if (connectionFailureCount > 0) {
    window.AgentHubWebDiagnostics?.recordBreadcrumb?.("hub-connection-restored");
  }
  connectionFailureCount = 0;
  connectionFailureSince = 0;
  connectionOfflineBreadcrumbRecorded = false;
  if (connectionOfflineTimer != null) window.clearTimeout(connectionOfflineTimer);
  connectionOfflineTimer = null;
}

function recordTransientConnectionFailure() {
  const now = Date.now();
  if (!connectionFailureSince) {
    connectionFailureSince = now;
    window.AgentHubWebDiagnostics?.recordBreadcrumb?.("hub-connection-failure");
  }
  connectionFailureCount += 1;
  const markOffline = () => {
    connectionOfflineTimer = null;
    if (!connectionFailureSince) return;
    if (!connectionOfflineBreadcrumbRecorded) {
      connectionOfflineBreadcrumbRecorded = true;
      window.AgentHubWebDiagnostics?.recordBreadcrumb?.("hub-connection-offline");
    }
    applySnapshotConnection(lastSnapshot, "offline");
  };
  const decision = window.AgentHubConnectionBanner.transientFailureDecision({
    hasSnapshot: Boolean(lastSnapshot),
    failureCount: connectionFailureCount,
    elapsedMs: now - connectionFailureSince,
    offlineFailures: CONNECTION_OFFLINE_FAILURES,
    graceMs: CONNECTION_OFFLINE_GRACE_MS,
  });
  if (decision === "offline") {
    markOffline();
    return;
  }
  if (decision === "connecting") applySnapshotConnection(lastSnapshot, "connecting");
  if (connectionOfflineTimer == null) {
    connectionOfflineTimer = window.setTimeout(
      markOffline,
      CONNECTION_OFFLINE_GRACE_MS - (now - connectionFailureSince),
    );
  }
}

function historyMessages(history, focusedTurn = null) {
  const messages = [];
  const normalizedResponseAnnotationReferences = (references) => {
    const normalize = globalThis.AgentHubMessageView?.normalizedResponseAnnotationReferences;
    return typeof normalize === "function" ? normalize(references) : [];
  };
  const historyStart = Number.isSafeInteger(Number(history?.start))
    ? Number(history.start)
    : 0;
  for (const [itemIndex, item] of (history?.items ?? []).entries()) {
    const itemProvider = String(item?.provider ?? history.provider ?? "");
    const itemThreadId = String(item?.threadId ?? history.threadId ?? "");
    const visible = historicalMessagesForDisplay(item);
    const traceMessageIndex = visible.findLastIndex((message) => (
      message?.role === "agent" && message?.kind !== "subagent"
    ));
    for (const [messageIndex, message] of visible.entries()) messages.push({
      id: `${itemProvider}:${itemThreadId}:${item.id}:${message.itemId}:${message.role}`,
      provider: itemProvider,
      threadId: itemThreadId,
      turnId: item.id,
      itemId: String(message.itemId ?? ""),
      clientUserMessageId: String(message.clientUserMessageId ?? ""),
      turnUserSlot: String(message.turnUserSlot ?? ""),
      role: message.role,
      operationKind: String(item.operationKind ?? "user-turn"),
      ...(item.operationKindMigrationGuard
        ? { operationKindMigrationGuard: String(item.operationKindMigrationGuard) }
        : {}),
      projectionAuthority: "canonical",
      projectionState: item.completed === true
        ? (["failed", "cancelled"].includes(String(item.status ?? "").toLowerCase())
          ? String(item.status).toLowerCase()
          : "completed")
        : item.active === true ? "active" : "unknown",
      terminalRevision: item.completed === true ? Number(item.terminalRevision) || 1 : 0,
      ...(item.completed === true && !Number(item.terminalRevision)
        ? { terminalRevisionMigrationGuard: "legacy-terminal-revision" }
        : {}),
      ...(message.kind ? { kind: message.kind } : {}),
      ...(message.origin ? { origin: message.origin } : {}),
      ...(message.agentThreadId ? { agentThreadId: message.agentThreadId } : {}),
      ...(message.model ? { model: message.model } : {}),
      author: conversationMessageAuthor(message, itemProvider),
      text: message.text,
      ...(message.role === "user" ? {
        responseAnnotations: message.responseAnnotations,
        responseAnnotationRequest: message.responseAnnotationRequest,
      } : message.role === "agent" ? {
        responseAnnotationReferences: normalizedResponseAnnotationReferences(
          message.responseAnnotationReferences,
        ),
      } : {}),
      activities: messageIndex === traceMessageIndex && Array.isArray(item.activities)
        ? item.activities
        : [],
      activityGroups: messageIndex === traceMessageIndex && Array.isArray(item.activityGroups)
        ? item.activityGroups
        : [],
      ...(message.role === "user" ? {
        submittedAt: message.submittedAt ?? message.time ?? item.submittedAt ?? item.startedAt ?? null,
        startedAt: message.startedAt ?? (message.turnUserSlot === "root" ? item.startedAt ?? null : null),
      } : {}),
      time: message.role === "user"
        ? message.submittedAt ?? message.time ?? item.submittedAt ?? item.startedAt ?? null
        : message.time ?? item.completedAt ?? null,
      ...(messageIndex === traceMessageIndex ? {
        turnStartedAt: item.startedAt ?? null,
        turnCompletedAt: item.completedAt ?? null,
      } : {}),
      historyOrder: (historyStart + itemIndex) * 1_000 + messageIndex,
      attachments: attachmentViews(message.attachments),
    });
  }
  if (focusedTurn && Array.isArray(focusedTurn.messages)) {
    const focusedThreadId = focusedTurnTaskThreadId(focusedTurn);
    const focusedTraceItemId = String(focusedTurn.messages.findLast((message) => (
      message?.role === "agent" && message?.kind !== "subagent"
    ))?.itemId ?? "");
    const parentAgentAlreadyVisible = messages.some((message) => (
      message.provider === focusedTurn.provider
      && message.threadId === focusedThreadId
      && message.turnId === focusedTurn.turnId
      && message.role === "agent"
      && message.kind !== "subagent"
    ));
    for (const [index, message] of focusedTurn.messages.entries()) {
      const itemId = String(message?.itemId ?? "").trim();
      if (!itemId || messages.some((candidate) => (
        candidate.provider === focusedTurn.provider
        && candidate.threadId === focusedThreadId
        && candidate.turnId === focusedTurn.turnId
        && candidate.itemId === itemId
      )) || (parentAgentAlreadyVisible
        && message.role === "agent"
        && message.kind !== "subagent")) continue;
      messages.push({
        id: `${focusedTurn.provider}:${focusedThreadId}:${focusedTurn.turnId}:${itemId}:${message.role}`,
        provider: focusedTurn.provider,
        threadId: focusedThreadId,
        turnId: focusedTurn.turnId,
        itemId,
        role: message.role,
        ...(message.kind ? { kind: message.kind } : {}),
        ...(message.origin ? { origin: message.origin } : {}),
        ...(message.agentThreadId ? { agentThreadId: message.agentThreadId } : {}),
        ...(message.model ? { model: message.model } : {}),
        author: conversationMessageAuthor(message, focusedTurn.provider),
        text: message.text,
        ...(message.role === "agent" ? {
          responseAnnotationReferences: normalizedResponseAnnotationReferences(
            message.responseAnnotationReferences,
          ),
        } : {}),
        activities: itemId === focusedTraceItemId && Array.isArray(focusedTurn.activities)
          ? focusedTurn.activities
          : [],
        activityGroups: itemId === focusedTraceItemId && Array.isArray(focusedTurn.activityGroups)
          ? focusedTurn.activityGroups
          : [],
        ...(message.role === "user" ? {
          submittedAt: message.submittedAt ?? message.time ?? focusedTurn.submittedAt ?? focusedTurn.startedAt ?? null,
          startedAt: message.startedAt ?? (message.turnUserSlot === "root" ? focusedTurn.startedAt ?? null : null),
        } : {}),
        time: message.submittedAt
          ?? message.time
          ?? (message.role === "user" ? focusedTurn.submittedAt ?? focusedTurn.startedAt : focusedTurn.completedAt)
          ?? focusedTurn.startedAt
          ?? null,
        ...(itemId === focusedTraceItemId ? {
          turnStartedAt: focusedTurn.startedAt ?? null,
          turnCompletedAt: focusedTurn.completedAt ?? null,
        } : {}),
        attachments: attachmentViews(message.attachments),
      });
    }
  }
  if (focusedTurn && !focusedTurnAlreadyVisible(history, messages, focusedTurn)) {
    const focusedThreadId = focusedTurnTaskThreadId(focusedTurn);
    if (focusedTurn.prompt) messages.push({
      id: `${focusedTurn.turnId}:prompt`,
      provider: focusedTurn.provider,
      threadId: focusedThreadId,
      turnId: focusedTurn.turnId,
      itemId: `${focusedTurn.turnId}:focused:user`,
      role: "user",
      turnUserSlot: "root",
      ...(focusedTurn.promptOrigin ? { kind: "interstream", origin: focusedTurn.promptOrigin } : {}),
      author: focusedTurn.promptAuthor || "Вы",
      text: focusedTurn.prompt,
      responseAnnotations: focusedTurn.promptAnnotations,
      responseAnnotationRequest: focusedTurn.promptRequest,
      submittedAt: focusedTurn.submittedAt ?? focusedTurn.startedAt,
      startedAt: focusedTurn.startedAt,
      time: focusedTurn.submittedAt ?? focusedTurn.startedAt,
    });
    messages.push({
      id: `${focusedTurn.turnId}:answer`,
      provider: focusedTurn.provider,
      threadId: focusedThreadId,
      turnId: focusedTurn.turnId,
      itemId: `${focusedTurn.turnId}:focused:agent`,
      role: "agent",
      author: focusedTurn.provider === "claude" ? "Claude" : "Codex",
      text: focusedTurn.answer || focusedTurn.title || "Ход завершён",
      responseAnnotationReferences: normalizedResponseAnnotationReferences(
        focusedTurn.responseAnnotationReferences,
      ),
      activities: Array.isArray(focusedTurn.activities) ? focusedTurn.activities : [],
      activityGroups: Array.isArray(focusedTurn.activityGroups) ? focusedTurn.activityGroups : [],
      time: focusedTurn.completedAt,
      turnStartedAt: focusedTurn.startedAt ?? null,
      turnCompletedAt: focusedTurn.completedAt ?? null,
    });
  }
  return messages;
}

function mergeNewestHistory(previous, newest) {
  const newestById = new Map(newest.map((message) => [message.id, message]));
  const previousIds = new Set(previous.map((message) => message.id));
  return projectCanonicalMessages([
    ...previous.map((message) => newestById.get(message.id) ?? message),
    ...newest.filter((message) => !previousIds.has(message.id)),
  ]);
}

function prependOlderHistory(previous, older) {
  const seen = new Set(previous.map((message) => message.id));
  const uniqueOlder = [];
  for (const message of older) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    uniqueOlder.push(message);
  }
  return projectCanonicalMessages([...uniqueOlder, ...previous]);
}

function applyOpened(result, {
  preserveScroll = false,
  skipSnapshot = false,
  selectTask = true,
} = {}) {
  const history = result?.history;
  if (!history) {
    applySnapshot(result?.snapshot);
    return;
  }
  const id = taskId(history.provider, history.threadId, history.streamId);
  if (history.notModified === true) {
    const page = historyPageByTask.get(id);
    if (page) page.version = history.version;
    return;
  }
  const newest = historyMessages(history, result.focusedTurn);
  const previousPage = historyPageByTask.get(id);
  const preserveOlder = !result.focusedTurn
    && previousPage
    && Number(previousPage.start) < Number(history.start);
  historyByTask.set(
    id,
    preserveOlder
      ? mergeNewestHistory(historyByTask.get(id) ?? [], newest)
      : newest,
  );
  clearDurablyCompletedLiveCard(id);
  historyPageByTask.set(id, {
    start: preserveOlder ? previousPage.start : history.start,
    end: history.end,
    total: history.total,
    messageTotal: history.messageTotal,
    nextBefore: preserveOlder ? previousPage.nextBefore : history.nextBefore,
    loading: false,
    version: history.version ?? "",
  });
  if (selectTask) rememberSelectedTaskId(id);
  if (!skipSnapshot) applySnapshot(result?.snapshot);
  if (selectTask) agentHub.selectTask(id);
  syncHistoryPagination(id);
  const renderedMessages = renderTaskMessages(id, { preserveScroll });
  renderTaskQueue(id, result?.snapshot ?? lastSnapshot);
  const acknowledgementSnapshot = result?.snapshot ?? lastSnapshot;
  const acknowledgementTask = (acknowledgementSnapshot?.tasks ?? []).find((item) => taskId(
    item.provider,
    item.threadId,
    item.streamId,
  ) === id);
  if (displayedFinalAcknowledgement({
    messages: renderedMessages,
    final: acknowledgementTask?.latestFinal,
    focusedTurn: result.focusedTurn,
    selectTask,
    selectedTaskId,
    taskId: id,
  })) acknowledgeDisplayedFinal(id, acknowledgementSnapshot);
  if (result.focusedMessage) {
    window.requestAnimationFrame(() => agentHub.focusMessage?.({
      turnId: result.focusedMessage.turnId,
      itemId: result.focusedMessage.itemId,
    }));
  }
  if (selectTask && !result.focusedTurn) {
    void settleOpenedTaskHistory(id, {
      ...(history.streamId ? { streamId: history.streamId } : {}),
      provider: history.provider,
      threadId: history.threadId,
    });
  }
  const task = (result.snapshot ?? lastSnapshot)?.tasks?.find(
    (item) => item.provider === history.provider && item.threadId === history.threadId,
  );
  updateHistoryCatchUp(id, history, task);
}

function acknowledgeDisplayedFinal(id, snapshot) {
  if (document.visibilityState !== "visible") return;
  const task = (snapshot?.tasks ?? []).find((item) => taskId(
    item.provider,
    item.threadId,
    item.streamId,
  ) === id);
  const final = task?.latestFinal;
  if (!final?.provider || !final?.threadId || !final?.turnId || !Number(final?.revision)) return;
  const identity = [final.provider, final.threadId, final.turnId, final.revision].join("\0");
  if (acknowledgedFinalByTask.get(id) === identity) return;
  acknowledgedFinalByTask.set(id, identity);
  const acknowledge = () => {
    void control("mark-task-read", { final }).then((result) => {
      if (result?.marked === true && acknowledgedFinalByTask.get(id) === identity) {
        agentHub.patchTask(id, { unread: false, status: "idle", statusLabel: "" });
        return;
      }
      if (acknowledgedFinalByTask.get(id) === identity) acknowledgedFinalByTask.delete(id);
      if (result?.reason === "stale-final") void refresh();
    }).catch(() => {
      if (acknowledgedFinalByTask.get(id) === identity) acknowledgedFinalByTask.delete(id);
    });
  };
  window.requestAnimationFrame(() => window.requestAnimationFrame(acknowledge));
}

function annotatedText(text, annotations) {
  return responseAnnotationPrompt(text, annotations);
}

function dataUrlBody(dataUrl) {
  const match = String(dataUrl ?? "").match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) throw new Error("Файл имеет неподдерживаемый формат");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { type: match[1], body: bytes };
}

async function uploadAttachment(attachment) {
  if (vscode) {
    return bridgeCall("upload-attachment", {
      name: attachment.name ?? "attachment.bin",
      type: attachment.type ?? "application/octet-stream",
      dataUrl: attachment.dataUrl,
    });
  }
  await localSessionReady;
  const file = dataUrlBody(attachment.dataUrl);
  const response = await hubFetch("/api/attachment", {
    method: "POST",
    headers: {
      ...authorizationHeaders(),
      "Content-Type": file.type,
      "X-Agent-Hub-File-Name": encodeURIComponent(String(attachment.name ?? "attachment.bin")),
    },
    body: file.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.path) {
    throw new Error(String(payload.error ?? "Не удалось загрузить файл"));
  }
  return payload.path;
}

async function runAction(operation) {
  try {
    return await operation();
  } catch (error) {
    agentHub.toast(hubErrorMessage(error));
    return null;
  }
}

function replaceRoute(hash) {
  history.replaceState(history.state, "", hash);
}

agentHub.on("task:select", ({ id }) => {
  const identity = taskIdentity(id);
  if (!identity) {
    const draft = emptyStreamModels(lastSnapshot ?? {}, id).find((task) => task.id === id);
    if (!draft) return null;
    beginNavigation();
    pendingSelectionId = id;
    rememberSelectedTaskId(id);
    replaceRoute(`#/chat/stream/${encodeURIComponent(id)}`);
    agentHub.selectTask(id);
    return null;
  }
  pendingSelectionId = id;
  rememberSelectedTaskId(id);
  selectionTail = runNavigation(
    identity,
    async () => {
      const opened = await control("open-task", { ...identity, limit: 20 });
      if (opened?.history) verifiedTaskHistory(opened.history, identity);
      return opened;
    },
    (result) => {
      applyOpened(result);
      pendingSelectionId = "";
      const route = window.AgentHubNavigationTabs.resolvedChatRoute(result, identity);
      if (route.hash) replaceRoute(route.hash);
    },
  ).finally(() => {
    if (pendingSelectionId === id) pendingSelectionId = "";
  });
  return selectionTail;
});

async function settleOpenedTaskHistory(id, identity) {
  await enqueueTaskHistoryLoad(id, identity, {
    refreshSource: true,
    onlyWhenSelected: true,
  });
}

function mergeHistoryLoadRequest(previous, next) {
  if (!previous) return next;
  return {
    ...next,
    refreshSource: previous.refreshSource || next.refreshSource,
    preserveScroll: previous.preserveScroll || next.preserveScroll,
  };
}

function enqueueTaskHistoryLoad(id, identity, {
  refreshSource = false,
  preserveScroll = true,
  onlyWhenSelected = false,
} = {}) {
  let state = historyLoadStates.get(id);
  if (!state) {
    state = { pending: null, running: null };
    historyLoadStates.set(id, state);
  }
  state.pending = mergeHistoryLoadRequest(state.pending, {
    identity: stableIdentity(identity),
    request: beginHistoryRequest(id, identity),
    refreshSource,
    preserveScroll,
    onlyWhenSelected,
  });
  if (state.running) return state.running;
  state.running = (async () => {
    visibleHistoryLoads.add(id);
    try {
      while (state.pending) {
        const pending = state.pending;
        state.pending = null;
        const settled = await settleOptionalRead(() => backgroundHttpScheduler.run(
          () => control("task-history", {
            ...pending.identity,
            limit: 20,
            includeActive: false,
            refreshSource: pending.refreshSource,
            knownVersion: historyPageByTask.get(id)?.version ?? "",
          }),
        ));
        if (settled.status === "rejected" || !currentHistoryRequest(pending.request)) continue;
        const history = verifiedTaskHistory(settled.value, pending.identity);
        if (!sameIdentity(taskIdentity(id), history)) continue;
        if (pending.onlyWhenSelected && selectedTaskId !== id) continue;
        if (history?.notModified === true) {
          const page = historyPageByTask.get(id);
          if (page) page.version = history.version;
          continue;
        }
        applyOpened({ history }, {
          preserveScroll: pending.preserveScroll,
          skipSnapshot: true,
          selectTask: false,
        });
      }
    } finally {
      visibleHistoryLoads.delete(id);
      if (historyLoadStates.get(id) === state) historyLoadStates.delete(id);
    }
  })();
  return state.running;
}

async function loadVisibleTaskHistories(taskIds) {
  const ids = [...new Set((Array.isArray(taskIds) ? taskIds : [])
    .map((id) => String(id ?? "").trim())
    .filter(Boolean))];
  visibleStreamTaskIds = new Set(ids);
  if (initialRouteOpening) return;
  await Promise.all(ids.map(async (id) => {
    // История выбранного Thread уже загружается open-task. Остальные колонки
    // подгружаются только после того, как пользователь открыл их Stream.
    if (id === selectedTaskId || historyPageByTask.has(id)) return;
    const identity = taskIdentity(id);
    if (!identity) return;
    await enqueueTaskHistoryLoad(id, identity, { preserveScroll: false });
  }));
}

agentHub.on("workspace:visible-streams", ({ taskIds }) => void loadVisibleTaskHistories(taskIds));

agentHub.on("devices:refresh", () => void runAction(async () => {
  agentHub.setTrustedDevices({ loading: true });
  const result = await control("trusted-devices", {});
  agentHub.setTrustedDevices(result);
}));

agentHub.on("devices:create", () => void runAction(async () => {
  const pairing = await control("create-device-pairing", {});
  const result = await control("trusted-devices", {});
  agentHub.setTrustedDevices({ ...result, pairing });
}));

agentHub.on("devices:revoke", ({ deviceId }) => void runAction(async () => {
  await control("revoke-device", { deviceId });
  agentHub.setTrustedDevices(await control("trusted-devices", {}));
}));

agentHub.on("bug-report:submit", ({ text, attachments, reportId }) => void (async () => {
  try {
    const paths = [];
    for (const attachment of attachments ?? []) paths.push(await uploadAttachment(attachment));
    const result = await control("submit-bug-report", { text, attachments: paths, reportId });
    agentHub.completeBugReport(result);
  } catch (error) {
    if (isConnectionFailure(error)) recordTransientConnectionFailure();
    agentHub.completeBugReport({ error: hubErrorMessage(error) });
  }
})());

agentHub.on("history:load-older", ({ taskId: id }) => runAction(async () => {
  const identity = taskIdentity(id);
  const page = historyPageByTask.get(id);
  if (!identity || !page || page.nextBefore == null || page.loading) return;
  const requestedBefore = Number(page.nextBefore);
  if (!Number.isSafeInteger(requestedBefore) || requestedBefore < 1) return;
  const request = beginHistoryRequest(id, identity);
  page.loading = true;
  syncHistoryPagination(id);
  try {
    const history = verifiedTaskHistory(await control("task-history", {
      ...identity,
      before: requestedBefore,
      limit: 20,
    }), identity);
    if (!currentHistoryRequest(request) || !sameIdentity(taskIdentity(id), history)) {
      page.loading = false;
      syncHistoryPagination(id);
      return;
    }
    // The Worker queue may redeliver an old response after a reconnect.  Do
    // not silently replace the visible page with its duplicate: it looks like
    // the button did nothing and can loop forever on the same cursor.
    const returnedStart = Number(history?.start);
    const returnedEnd = Number(history?.end);
    if (
      history?.provider !== identity.provider
      || history?.threadId !== identity.threadId
      || !Number.isSafeInteger(returnedStart)
      || !Number.isSafeInteger(returnedEnd)
      || returnedStart < 0
      || returnedEnd > requestedBefore
      || returnedStart >= requestedBefore
    ) {
      throw new Error("Agent Hub вернул не ту страницу истории. Повторите загрузку.");
    }
    // A task switch can finish while the remote command was in flight.  Its
    // old result must not alter the pagination and scroll of the new task.
    if (historyPageByTask.get(id) !== page) return;
    historyByTask.set(
      id,
      prependOlderHistory(historyByTask.get(id) ?? [], historyMessages(history)),
    );
    const nextBefore = Number(history.nextBefore);
    Object.assign(page, {
      start: history.start,
      total: history.total,
      messageTotal: history.messageTotal,
      nextBefore: Number.isSafeInteger(nextBefore) && nextBefore >= 0 && nextBefore < requestedBefore
        ? nextBefore
        : (returnedStart > 0 ? returnedStart : null),
      loading: false,
    });
    syncHistoryPagination(id);
    renderTaskMessages(id, { preserveScroll: true });
  } catch (error) {
    page.loading = false;
    syncHistoryPagination(id);
    throw error;
  }
}));

agentHub.on("message:send", (request) => {
  if (request.draftStream) beginNavigation();
  const sendTransaction = window.AgentHubMessageSendTransaction;
  const optimisticId = `local:${request.requestId}`;
  let identity = taskIdentity(request.taskId);
  const previousAttempt = outgoingMessages(request.taskId).get(request.requestId);
  const requestAttachments = request.attachments ?? [];
  const requestTaskReferences = (request.taskReferences ?? [])
    .map((reference) => window.AgentHubTaskReferences.normalize(reference))
    .filter(Boolean);
  const visibleAttachments = [...requestAttachments, ...requestTaskReferences];
  const queuesOptimistically = request.followUpMode === "queue"
    || request.deferWhileRunning === true;
  const steersOptimistically = request.followUpMode === "steer" && !queuesOptimistically;
  const usesQueueOptimistically = optimisticSubmissionUsesQueue(request);
  const clientProjectionIntent = usesQueueOptimistically ? "queue" : "conversation";
  const visibleText = String(request.text ?? "").trim()
    || ((request.annotations ?? []).length
      ? `Аннотации к ответу: ${(request.annotations ?? []).length}`
      : window.AgentHubMessageLifecycle.attachmentOnlyText(visibleAttachments));
  const submittedAt = new Date().toISOString();
  const optimistic = {
    id: optimisticId,
    provider: identity?.provider ?? request.settings?.provider ?? "",
    threadId: identity?.threadId ?? "",
    turnId: "",
    itemId: request.requestId,
    clientUserMessageId: request.requestId,
    submissionId: request.requestId,
    operationKind: "user-turn",
    projectionAuthority: "optimistic",
    projectionState: usesQueueOptimistically ? "queued" : "optimistic",
    providerAccepted: false,
    clientProjectionIntent,
    role: "user",
    author: "Вы",
    text: visibleText,
    responseAnnotations: normalizedResponseAnnotations(request.annotations),
    responseAnnotationRequest: String(request.text ?? "").trim(),
    submittedAt,
    time: submittedAt,
    attachments: visibleAttachments,
    uploadedPaths: previousAttempt?.uploadedPaths ?? [],
    ...deliveryPatch(queuesOptimistically ? "sending" : steersOptimistically ? "steering" : "preparing"),
  };
  rememberOutgoing(request.taskId, optimistic);
  if (usesQueueOptimistically) {
    optimisticDeferredClientUserMessageIds.add(request.requestId);
    deferredClientUserMessageIds.add(request.requestId);
  }
  renderOutgoingWithoutBlockingSend(request.taskId, { queue: usesQueueOptimistically });
  return runAction(() => sendTransaction.run({
    send: async () => {
      if (request.draftStream) {
        const createdSnapshot = await control("new-task", {
          streamId: request.streamId,
          provider: request.settings?.provider,
          settings: request.settings,
        });
        const created = createdSnapshot?.createdTask;
        if (!created?.provider) throw new Error("Агент не подготовил Thread");
        identity = {
          streamId: created.streamId ?? request.streamId,
          provider: created.provider,
          threadId: created.threadId,
        };
        pendingSelectionId = request.taskId;
        rememberSelectedTaskId(request.taskId);
        applySnapshot(createdSnapshot);
        pendingSelectionId = "";
        const route = window.AgentHubNavigationTabs.resolvedChatRoute(
          { history: identity },
          identity,
        );
        if (route.hash) replaceRoute(route.hash);
      }
      // Worker attachments are deleted after their command finishes. A retry
      // must upload the image again instead of reusing an expired reference.
      const paths = reusableAttachmentPaths(
        optimistic.uploadedPaths,
        (request.attachments ?? []).length,
        { remote: !vscode },
      );
      if (!paths.length) {
        for (const attachment of request.attachments ?? []) paths.push(await uploadAttachment(attachment));
        updateOutgoing(request.taskId, request.requestId, { uploadedPaths: paths.slice() });
        renderOutgoingWithoutBlockingSend(request.taskId, { queue: usesQueueOptimistically });
      }
      updateOutgoing(
        request.taskId,
        request.requestId,
        deliveryPatch(queuesOptimistically ? "sending" : steersOptimistically ? "steering" : "sending"),
      );
      renderOutgoingWithoutBlockingSend(request.taskId, { queue: usesQueueOptimistically });
      const params = {
        text: annotatedText(request.text, request.annotations),
        displayText: visibleText,
        responseAnnotations: normalizedResponseAnnotations(request.annotations),
        responseAnnotationRequest: String(request.text ?? "").trim(),
        streamId: identity?.streamId ?? request.streamId,
        provider: identity?.provider,
        threadId: identity?.threadId,
        clientUserMessageId: request.requestId,
        clientProjectionIntent,
        followUpMode: request.followUpMode,
        clientTiming: {
          submittedAtMs: request.submittedAtMs,
          submittedMonotonicMs: request.submittedMonotonicMs,
          controlStartedAtMs: Date.now(),
          controlStartedMonotonicMs: performance.now(),
          surface: clientTraceSurface(),
        },
      };
      if (paths.length) params.attachments = paths;
      if (requestTaskReferences.length) {
        params.taskReferences = requestTaskReferences.map((reference) => ({
          taskId: reference.taskId,
          intent: reference.intent,
        }));
      }
      try {
        const result = await control("send-message", params);
        reportClientCommandAck(request.requestId, params.clientTiming, "succeeded");
        return result;
      } catch (error) {
        reportClientCommandAck(request.requestId, params.clientTiming, "failed");
        throw error;
      }
    },
    receive: (result) => {
      const projection = queueHistoryReceiptProjection(result);
      if (projection.ownsDeferredQueue) {
        optimisticDeferredClientUserMessageIds.add(request.requestId);
        deferredClientUserMessageIds.add(request.requestId);
      } else {
        optimisticDeferredClientUserMessageIds.delete(request.requestId);
        deferredClientUserMessageIds.delete(request.requestId);
      }
      agentHub.completeSend(request.requestId, { accepted: projection.accepted });
      updateOutgoing(request.taskId, request.requestId, {
        provider: identity?.provider ?? "",
        threadId: result?.threadId ?? identity?.threadId ?? "",
        streamId: result?.streamId ?? identity?.streamId ?? request.streamId,
        turnId: result?.turnId ?? "",
        itemId: result?.itemId ?? request.requestId,
        remoteQueued: result?.remoteQueued === true,
        remoteCommandId: result?.remoteCommandId ?? "",
        projectionAuthority: "canonical",
        projectionState: projection.projectionState,
        providerAccepted: projection.providerAccepted,
        ...(projection.submittedAt ? {
          submittedAt: projection.submittedAt,
          time: projection.submittedAt,
        } : {}),
        ...(projection.startedAt ? { startedAt: projection.startedAt } : {}),
        ...nonEmptyAttachmentPatch(result?.attachments),
        ...(result?.accepted && !result?.steered ? { turnUserSlot: "root" } : {}),
        ...(result?.remoteQueued
          ? deliveryPatch("relaying")
          : deliveryPatch(projection.deliveryState ?? "rejected")),
      });
      renderOutgoingWithoutBlockingSend(request.taskId, { queue: true });
    },
    synchronize: async (result) => {
      if (result?.snapshot) applySnapshot(result.snapshot);
      else if (result?.accepted || result?.deferred) await refresh();
      if (result?.threadId && (
        String(result.threadId) !== String(identity?.threadId ?? "")
        || String(result?.provider ?? identity?.provider ?? "") !== String(identity?.provider ?? "")
      )) {
        identity = {
          ...identity,
          streamId: result?.streamId ?? identity?.streamId ?? request.streamId,
          provider: result?.provider ?? identity?.provider,
          threadId: result.threadId,
        };
        const opened = await control("open-task", { ...identity, limit: 20 });
        applyOpened(opened);
        const route = window.AgentHubNavigationTabs.resolvedChatRoute(
          { history: identity },
          identity,
        );
        if (route.hash) replaceRoute(route.hash);
        agentHub.showSelectedTask();
      }
      renderTaskMessages(request.taskId);
      renderTaskQueue(request.taskId, result?.snapshot ?? lastSnapshot);
      renderTaskMessages(request.taskId);
      agentHub.toast(result?.message ?? (result?.accepted ? "Сообщение принято" : "Сообщение сохранено"));
    },
    reject: (error) => {
      // A remote command may finish after its HTTP result is lost. Preserve
      // its request id for an idempotent retry instead of creating a second
      // optimistic card for the same user action.
      const rejected = messageSendDefinitelyRejected(error);
      agentHub.completeSend(request.requestId, { accepted: false });
      if (rejected) {
        outgoingMessages(request.taskId).delete(request.requestId);
        optimisticDeferredClientUserMessageIds.delete(request.requestId);
        deferredClientUserMessageIds.delete(request.requestId);
      } else {
        optimisticDeferredClientUserMessageIds.add(request.requestId);
        deferredClientUserMessageIds.add(request.requestId);
        updateOutgoing(request.taskId, request.requestId, {
          ...deliveryPatch("unconfirmed"),
          projectionState: "unknown",
          providerAccepted: false,
        });
      }
      renderOutgoingWithoutBlockingSend(request.taskId, { queue: true });
      if (!rejected) void refresh();
    },
    synchronizationFailed: (error) => {
      console.error("Agent Hub accepted a message but could not refresh its card", error);
      agentHub.toast("Сообщение принято. Отображение обновится по квитанции.");
    },
  }));
});

agentHub.on("task:new", ({ title, provider }) => runAction(async () => {
  beginNavigation();
  const selectedProvider = ["codex", "claude"].includes(provider)
    ? provider
    : (lastSnapshot?.settings?.provider ?? "codex");
  const snapshot = await control("new-task", {
    provider: selectedProvider,
    workspaceName: title || undefined,
  });
  const created = (snapshot.tasks ?? []).find((task) => task.selected);
  if (created) {
    pendingSelectionId = taskId(created.provider, created.threadId, created.streamId);
    rememberSelectedTaskId(pendingSelectionId);
  }
  applySnapshot(snapshot);
  pendingSelectionId = "";
  agentHub.showSelectedTask();
  const identity = taskIdentity(selectedTaskId);
  if (identity) {
    const route = window.AgentHubNavigationTabs.resolvedChatRoute({ history: identity }, identity);
    if (route.hash) replaceRoute(route.hash);
  }
}));

agentHub.on("task:rename", ({ id, title }) => runAction(async () => {
  const targetId = id || selectedTaskId;
  const identity = exactTaskParams(targetId);
  const task = (lastSnapshot?.tasks ?? []).find((candidate) => (
    taskId(candidate.provider, candidate.threadId, candidate.streamId) === targetId
  ));
  const action = task?.workspaceId ? "rename-workspace" : "rename-task";
  const params = task?.workspaceId ? { workspaceId: task.workspaceId, name: title } : { ...identity, title };
  applySnapshot(await control(action, params));
}));
agentHub.on("workspace:rename", ({ workspaceId, name }) => runAction(async () => applySnapshot(
  await control("rename-workspace", { workspaceId, name }),
)));
agentHub.on("workspace:folder-move", ({ workspaceId, folderName }) => runAction(async () => {
  const mutation = window.AgentHubStreamTabs.workspaceFolderMutation({ id: workspaceId }, folderName);
  if (!mutation) return;
  applySnapshot(await control("move-workspace-to-folder", mutation));
  agentHub.toast(mutation.folderName
    ? `Workspace перемещён в папку «${mutation.folderName}»`
    : "Workspace убран из папки");
}));
agentHub.on("workspace:folder-rename", ({ fromFolderName, toFolderName }) => runAction(async () => {
  const snapshot = await control("rename-workspace-folder", { fromFolderName, toFolderName });
  applySnapshot(snapshot);
  agentHub.renameWorkspaceFolderCatalog(fromFolderName, toFolderName);
  agentHub.toast(`Папка «${fromFolderName}» переименована в «${toFolderName}»`);
}));
agentHub.on("workspace:archive", ({ workspaceId }) => runAction(async () => {
  applySnapshot(await control("archive-workspace", { workspaceId }));
  agentHub.toast("Workspace удалён в архив на 3 дня");
}));
agentHub.on("workspace:restore", ({ workspaceId }) => runAction(async () => {
  applySnapshot(await control("restore-workspace", { workspaceId }));
  agentHub.toast("Workspace восстановлен");
}));
agentHub.on("workspace:create", ({
  name, folderName, comment, workingDirectory, taskPrefix, rules, releaseWorkflowEnabled, beforeColumnId,
}) => runAction(async () => {
  let snapshot = await control("create-workspace", {
    name,
    comment,
    settings: window.AgentHubStreamTabs.workspaceCreationSettings({
      workingDirectory,
      taskPrefix,
      releaseWorkflowEnabled,
      folderName,
    }),
  });
  const workspaceId = snapshot.createdWorkspace?.workspace?.id;
  if (workspaceId) {
    if (String(rules ?? "")) {
      snapshot = await control("update-workspace-rules", { workspaceId, content: String(rules) });
    }
    snapshot = await control("board-column-move", {
      columnId: `workspace:${workspaceId}`,
      beforeColumnId: beforeColumnId ?? null,
    });
  }
  applySnapshot(snapshot);
}));
agentHub.on("workspace:update", ({
  workspaceId, name, comment, workingDirectory, taskPrefix, rules, releaseWorkflowEnabled,
  beforeColumnId,
}) => runAction(async () => {
  if (!lastSnapshot?.boardLayout) {
    agentHub.toast("Agent Hub завершает обновление runtime. Повторите действие через минуту.");
    return;
  }
  const workspace = (lastSnapshot.workspaces ?? []).find((item) => item.id === workspaceId);
  let snapshot = lastSnapshot;
  const nextSettings = {
    ...(workspace?.settings ?? {}),
    workingDirectory: String(workingDirectory ?? "").trim(),
    taskPrefix: String(taskPrefix ?? "").trim(),
    releaseWorkflowEnabled: releaseWorkflowEnabled === true,
  };
  const settingsChanged = nextSettings.workingDirectory !== String(workspace?.settings?.workingDirectory ?? "")
    || nextSettings.taskPrefix !== String(workspace?.settings?.taskPrefix ?? "")
    || nextSettings.releaseWorkflowEnabled !== (workspace?.settings?.releaseWorkflowEnabled === true);
  if (settingsChanged) {
    snapshot = await control("update-workspace-settings", {
      workspaceId,
      settings: nextSettings,
    });
  }
  if (workspace?.kind !== "system" && name !== workspace?.name) {
    snapshot = await control("rename-workspace", { workspaceId, name });
  }
  if (comment !== String(workspace?.comment ?? "")) {
    snapshot = await control("board-column-comment", { columnId: `workspace:${workspaceId}`, comment });
  }
  const currentRuleValue = workspace?.developerRules ?? workspace?.rules;
  const currentRules = typeof currentRuleValue === "string"
    ? currentRuleValue
    : String(currentRuleValue?.content ?? "");
  if (String(rules ?? "") !== currentRules) {
    snapshot = await control("update-workspace-rules", { workspaceId, content: String(rules ?? "") });
  }
  const columnId = `workspace:${workspaceId}`;
  const currentOrder = snapshot.boardLayout?.columnOrder ?? [];
  const currentIndex = currentOrder.indexOf(columnId);
  const currentBeforeColumnId = currentIndex < 0 ? null : currentOrder[currentIndex + 1] ?? null;
  if (beforeColumnId !== currentBeforeColumnId) {
    snapshot = await control("board-column-move", { columnId, beforeColumnId });
  }
  applySnapshot(snapshot);
}));
document.addEventListener("agenthub:board-action", (event) => {
  const detail = event.detail ?? {};
  let succeeded = false;
  void runAction(async () => {
    if (!lastSnapshot?.boardLayout && ["move-column", "update-comment"].includes(detail.type)) {
      agentHub.toast("Agent Hub завершает обновление runtime. Повторите действие через минуту.");
      return;
    }
    const actions = {
      create: "board-task-create",
      update: "board-task-update",
      checklist: "board-task-checklist",
      "checklist-linked-task-action": "board-task-checklist-linked-action",
      status: "board-task-status",
      move: "board-task-move",
      complete: "board-task-complete",
      remove: "board-task-remove",
      "retry-triage": "board-task-retry-triage",
      start: "board-task-start",
      "move-column": "board-column-move",
      "update-comment": "board-column-comment",
    };
    if (detail.type === "attachment-add") {
      const attachments = [];
      for (const attachment of detail.attachments ?? []) attachments.push(await uploadAttachment(attachment));
      const result = await control("board-task-attachment-add", { id: detail.id, attachments });
      succeeded = true;
      applySnapshot(result);
      agentHub.toast("Вложения добавлены");
      return;
    }
    const action = actions[detail.type];
    if (!action) return;
    const { type: _type, ...params } = detail;
    let result = await control(action, params);
    if (["complete", "remove"].includes(detail.type) && result.lifecycleResult?.confirmationRequired) {
      const decision = await window.AgentHubTaskCleanupConfirmation.confirm({
        confirmation: result.lifecycleResult,
        action,
        params,
        request: control,
      });
      if (!decision.confirmed) return;
      result = decision.result;
    }
    succeeded = true;
    applySnapshot(result);
    if (detail.type === "start") agentHub.showSelectedTask();
    if (detail.type === "update") agentHub.toast("Изменения сохранены");
    if (detail.type === "status") agentHub.toast("Статус задачи изменён");
    if (detail.type === "remove") agentHub.toast("Задача удалена");
  }).finally(() => {
    window.AgentHubTaskBoard?.finishAction?.({
      type: detail.type,
      id: detail.id,
      succeeded,
      requestId: detail.requestId,
      operation: detail.operation,
      itemId: detail.itemId,
    });
  });
});
agentHub.on("workspace:create-from-stream", ({ streamId, name }) => runAction(async () => applySnapshot(
  await control("create-workspace-from-stream", { streamId, name }),
)));
agentHub.on("stream:rename", ({ streamId, name }) => runAction(async () => applySnapshot(
  await control("rename-stream", { streamId, name }),
)));
agentHub.on("stream:archive", ({ streamId }) => runAction(async () => applySnapshot(
  await control("archive-stream", { streamId }),
)));
agentHub.on("stream:move", ({ streamId, workspaceId, beforeStreamId }) => runAction(async () => applySnapshot(
  await control("move-stream", { streamId, workspaceId, beforeStreamId }),
)));
agentHub.on("stream:rebirth", ({ streamId, provider, taskId: targetTaskId }) => runAction(async () => {
  beginNavigation();
  const identity = exactTaskParams(targetTaskId || selectedTaskId);
  const snapshot = await control("rotate-stream", {
    ...identity,
    provider: ["codex", "claude"].includes(provider) ? provider : identity.provider,
    streamId,
  });
  const rotatedThreadId = String(snapshot.rotation?.threadId ?? "").trim();
  const created = (snapshot.tasks ?? []).find((task) => (
    task.streamId === streamId
    && String(task.threadId ?? "").trim() === rotatedThreadId
  ));
  if (created) {
    pendingSelectionId = taskId(created.provider, created.threadId, created.streamId);
    rememberSelectedTaskId(pendingSelectionId);
  }
  applySnapshot(snapshot);
  pendingSelectionId = "";
  if (created) replaceRoute(`#/chat/${encodeURIComponent(created.provider)}/${encodeURIComponent(created.threadId)}`);
  agentHub.showSelectedTask();
}));
agentHub.on("stream:continue-provider", ({ streamId, provider }) => runAction(async () => {
  beginNavigation();
  const selectedProvider = ["codex", "claude"].includes(provider) ? provider : "codex";
  const snapshot = await control("new-task", {
    provider: selectedProvider,
    streamId,
  });
  const created = (snapshot.tasks ?? []).find((task) => task.selected && task.streamId === streamId);
  if (created) {
    pendingSelectionId = taskId(created.provider, created.threadId, created.streamId);
    rememberSelectedTaskId(pendingSelectionId);
  }
  applySnapshot(snapshot);
  pendingSelectionId = "";
  if (created) replaceRoute(`#/chat/${encodeURIComponent(created.provider)}/${encodeURIComponent(created.threadId)}`);
  agentHub.showSelectedTask();
}));
agentHub.on("stream:new", ({ workspaceId, streamName }) => {
  const key = String(workspaceId ?? "").trim() || "default";
  const existing = streamCreatesInFlight.get(key);
  if (existing) return existing;
  beginNavigation();
  const operation = runAction(async () => {
    const settings = lastSnapshot?.settings ?? {};
    const result = await control("create-stream", {
      workspaceId,
      name: streamName,
      settings: {
        provider: settings.provider ?? "codex",
        model: settings.model ?? "",
        reasoning: settings.reasoning ?? "",
        mode: settings.mode ?? "",
        workingDirectory: "",
        autoApprove: settings.approvalMode === "auto",
      },
    });
    const streamId = String(result?.createdStream?.id ?? "");
    if (!streamId) throw new Error("Agent Hub не создал Stream");
    pendingSelectionId = streamId;
    rememberSelectedTaskId(streamId);
    applySnapshot(result);
    pendingSelectionId = "";
    replaceRoute(`#/chat/stream/${encodeURIComponent(streamId)}`);
    agentHub.selectTask(streamId);
    agentHub.showSelectedTask();
    agentHub.openDialogSettings();
  });
  streamCreatesInFlight.set(key, operation);
  void Promise.resolve(operation).finally(() => {
    if (streamCreatesInFlight.get(key) === operation) streamCreatesInFlight.delete(key);
  });
  return operation;
});
agentHub.on("stream:settings-save", ({ streamId, settings }) => runAction(async () => {
  applySnapshot(await control("update-stream-settings", { streamId, settings }));
}));
agentHub.on("stream:rules-save", ({ streamId, rules }) => runAction(async () => {
  applySnapshot(await control("update-stream-rules", { streamId, content: String(rules ?? "") }));
  agentHub.toast("Правила Stream сохранены");
}));
agentHub.on("task:archive", ({ id } = {}) => runAction(async () => applySnapshot(
  await control("archive-task", id ? exactTaskParams(id) : exactSelectedTaskParams()),
)));
agentHub.on("task:stop", ({ id } = {}) => runAction(async () => {
  const targetId = id || selectedTaskId;
  const target = targetId ? exactTaskParams(targetId) : exactSelectedTaskParams();
  const queued = (lastSnapshot?.deferredInputs ?? []).filter((item) => (
    item.state === "queued"
    && taskId(item.provider, item.threadId, item.streamId) === targetId
  ));
  const stopped = await window.AgentHubMessageLifecycle.stopTaskControls({
    cancel: () => control("cancel-run", target),
    pause: (item) => control("deferred-input", { id: item.id, action: "pause" }),
    queued,
  });
  applySnapshot(await control("snapshot"));
  const stoppedMessage = stopped.result?.message ?? "Остановка запрошена";
  agentHub.toast(stopped.pauseFailures
    ? `${stoppedMessage}. Ход остановлен; ${stopped.pauseFailures} сообщений очереди не удалось приостановить.`
    : queued.length
      ? `${stoppedMessage}. Очередь приостановлена.`
      : stoppedMessage);
}));
agentHub.on("task:diff", ({ id }) => runAction(async () => {
  const targetId = id || selectedTaskId;
  const identity = taskIdentity(targetId);
  if (!identity) throw new Error("Сначала выберите задачу");
  const diff = await control("task-diff", identity);
  agentHub.setTaskDiff(targetId, diff?.text || "В выбранной задаче изменений файлов нет.");
}));
agentHub.on("status:open", () => runAction(async () => {
  const status = await control("status-details");
  const rows = Object.entries(status ?? {}).map(([name, value]) => ({
    name,
    value: typeof value === "string" ? value : JSON.stringify(value),
  }));
  agentHub.setStatus({ rows });
}));

function trimHistoryToFifteenDays(payload) {
  if (!payload || typeof payload !== "object" || payload.error) return payload;
  const toMs = Date.parse(payload.to ?? "");
  const endMs = Number.isFinite(toMs) ? toMs : Date.now();
  const start = new Date(endMs);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - 14);
  const fromMs = start.getTime();
  const keepPoint = (point) => {
    const at = Date.parse(point?.at ?? "");
    return Number.isFinite(at) && at >= fromMs && at <= endMs;
  };
  const result = {
    ...payload,
    range: "15d",
    from: new Date(fromMs).toISOString(),
    to: new Date(endMs).toISOString(),
  };
  if (Array.isArray(payload.series)) {
    result.series = payload.series.map((series) => ({
      ...series,
      points: Array.isArray(series.points) ? series.points.filter(keepPoint) : [],
    }));
  }
  if (Array.isArray(payload.points)) {
    result.points = payload.points.filter(keepPoint);
    result.totalCredits = result.points.reduce(
      (total, point) => total + Math.max(0, Number(point?.credits) || 0),
      0,
    );
    result.bucket = "day";
    result.bucketMs = 24 * 60 * 60_000;
    result.axisTo = result.to;
  }
  if (Array.isArray(payload.accountActivity)) {
    result.accountActivity = payload.accountActivity.map((entry) => ({
      ...entry,
      intervals: (Array.isArray(entry?.intervals) ? entry.intervals : []).flatMap((interval) => {
        const intervalFrom = Math.max(fromMs, Date.parse(interval?.from ?? ""));
        const intervalTo = Math.min(endMs, Date.parse(interval?.to ?? ""));
        return Number.isFinite(intervalFrom) && Number.isFinite(intervalTo) && intervalTo > intervalFrom
          ? [{ from: new Date(intervalFrom).toISOString(), to: new Date(intervalTo).toISOString() }]
          : [];
      }),
    }));
  }
  return result;
}

async function readHistoryWithRangeCompatibility(action, range, params = {}) {
  const requestedRange = String(range || "24h");
  let payload = await control(action, { ...params, range: requestedRange });
  if (requestedRange !== "15d" || payload?.range === "15d") return payload;
  // Runtime до поддержки 15d нормализует неизвестный диапазон в 24h.
  // Берём уже поддерживаемые 30d и оставляем 15 календарных дней включая сегодня.
  payload = await control(action, { ...params, range: "30d" });
  return trimHistoryToFifteenDays(payload);
}

async function refreshRateLimitHistory(range = rateLimitRefreshRange, { reportError = false } = {}) {
  const requestedRange = String(range || "24h");
  rateLimitRefreshRange = requestedRange;
  if (rateLimitRefreshInFlight) return;
  rateLimitRefreshInFlight = true;
  try {
    agentHub.setRateLimitHistory(await readHistoryWithRangeCompatibility(
      "rate-limit-history",
      requestedRange,
      {
      maxPointsPerSeries: 600,
      },
    ));
  } catch (error) {
    agentHub.setRateLimitHistory({
      range: requestedRange,
      error: String(error?.message ?? error ?? "Не удалось загрузить историю лимитов"),
    });
    if (reportError) throw error;
  } finally {
    rateLimitRefreshInFlight = false;
    if (rateLimitRefreshRange !== requestedRange) void refreshRateLimitHistory();
  }
}

agentHub.on("limits:open", ({ range }) => runAction(
  () => refreshRateLimitHistory(range, { reportError: true }),
));
agentHub.on("usage:open", ({ range, accountKey, turnTimeMode }) => runAction(async () => {
  try {
    agentHub.setUsageHistory(await readHistoryWithRangeCompatibility("usage-history", range, {
      maxPoints: 600,
      accountKey: String(accountKey || ""),
      turnTimeMode,
    }));
  } catch (error) {
    agentHub.setUsageHistory({
      range,
      accountKey: String(accountKey || ""),
      turnTimeMode,
      error: error?.message || "Не удалось загрузить учётный расход.",
    });
  }
}));
agentHub.on("comparison:open", ({ range, seriesId, accountKey, turnTimeMode }) => runAction(async () => {
  const requestedRange = String(range || "24h");
  const requestedSeriesId = String(seriesId || "codex:primary");
  const requestedAccountKey = String(accountKey || "");
  const provider = "codex";
  let limits;
  try {
    limits = await readHistoryWithRangeCompatibility("rate-limit-history", requestedRange, {
      maxPointsPerSeries: 600,
    });
  } catch (error) {
    agentHub.setUsageComparison({
      range: requestedRange,
      seriesId: requestedSeriesId,
      accountKey: requestedAccountKey,
      limits: { range: requestedRange, error: String(error?.message ?? error) },
      usage: { range: requestedRange, error: "История лимитов недоступна." },
    });
    return;
  }
  const allAccounts = requestedAccountKey === "all";
  const resolvedAccountKey = allAccounts
    ? "all"
    : requestedAccountKey || String(limits?.currentAccount?.key ?? "");
  let usage;
  try {
    usage = await readHistoryWithRangeCompatibility("usage-history", requestedRange, {
      maxPoints: 600,
      provider,
      accountKey: allAccounts ? "" : resolvedAccountKey,
      turnTimeMode,
    });
  } catch (error) {
    usage = { range: requestedRange, error: String(error?.message ?? error) };
  }
  agentHub.setUsageComparison({
    range: requestedRange,
    seriesId: requestedSeriesId,
    accountKey: resolvedAccountKey,
    turnTimeMode,
    limits,
    usage,
  });
}));
agentHub.on("selection:set", async ({ key, value }) => {
  const names = {
    model: "model",
    reasoning: "reasoning",
    mode: "mode",
    project: "project",
    autoApprove: "approvalMode",
    includeClaudeUsage: "includeClaudeUsage",
    activityRecentMinutes: "activityRecentMinutes",
    streamOrderMode: "streamOrderMode",
    streamCardWidthMode: "streamCardWidthMode",
    streamCardFixedWidth: "streamCardFixedWidth",
    streamCardGapEnabled: "streamCardGapEnabled",
    pinnedWorkspaceStreams: "pinnedWorkspaceStreams",
    quickMessages: "quickMessages",
  };
  const name = names[key];
  if (!name) return;
  const tracksProjection = key === "includeClaudeUsage";
  const tracksPending = tracksProjection || ["pinnedWorkspaceStreams", "quickMessages"].includes(key);
  if (tracksPending) agentHub.setSelectionPending(key, true);
  const taskIdentity = ["provider", "project", "model", "reasoning", "mode"].includes(name)
    ? exactSelectedTaskParams()
    : {};
  try {
    await runAction(async () => {
      applySnapshot(await control("update-setting", {
        ...taskIdentity,
        name,
        value: key === "autoApprove"
          ? (value ? "auto" : "manual")
          : ["pinnedWorkspaceStreams", "quickMessages"].includes(key)
            ? JSON.stringify(value ?? {})
            : value,
      }));
      if (tracksProjection) {
        requestUsageHistory(usageState.range, { force: true });
        await loadJournal({ force: true });
      }
    });
  } finally {
    if (tracksPending) agentHub.setSelectionPending(key, false);
  }
});
agentHub.on("approval:respond", ({ id, decision, answers }) => runAction(async () => {
  await control("resolve-approval", { key: id, decision, ...(answers ? { answers } : {}) });
  applySnapshot(await control("snapshot"));
}));
agentHub.on("queue:remove", ({ id }) => runAction(async () => {
  const deferred = (lastSnapshot?.deferredInputs ?? []).find((item) => item.id === id);
  const result = await control("deferred-input", { id, action: "cancel" });
  const clientUserMessageId = String(deferred?.clientUserMessageId ?? "");
  if (clientUserMessageId) {
    const deferredTaskId = taskId(deferred.provider, deferred.threadId, deferred.streamId);
    outgoingMessages(deferredTaskId).delete(clientUserMessageId);
    renderTaskMessages(deferredTaskId);
  }
  applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Отложенное сообщение удалено");
}));
async function runQueueAction(id, taskIdValue, operation) {
  const key = String(id ?? "").trim();
  if (!key || queueActionsInFlight.has(key)) return null;
  queueActionsInFlight.add(key);
  try {
    return await operation();
  } finally {
    try {
      applySnapshot(await control("snapshot"));
    } finally {
      queueActionsInFlight.delete(key);
      optimisticQueueSteerIds.delete(key);
      renderTaskQueue(taskIdValue);
      renderTaskMessages(taskIdValue);
    }
  }
}

agentHub.on("queue:accept", ({ id, taskId: taskIdValue }) => runAction(() => runQueueAction(id, taskIdValue, async () => {
  const result = await control("deferred-input", { id, action: "queue" });
  agentHub.toast(result?.message ?? "Сообщение будет отправлено после текущего хода");
})));
agentHub.on("queue:steer", ({ id, taskId: taskIdValue }) => runAction(() => runQueueAction(id, taskIdValue, async () => {
  const deferred = (lastSnapshot?.deferredInputs ?? []).find((item) => item.id === id);
  const clientUserMessageId = String(deferred?.clientUserMessageId ?? "").trim();
  optimisticQueueSteerIds.add(String(id ?? ""));
  if (clientUserMessageId) {
    const deferredTaskId = taskId(deferred.provider, deferred.threadId, deferred.streamId);
    optimisticDeferredClientUserMessageIds.delete(clientUserMessageId);
    deferredClientUserMessageIds.delete(clientUserMessageId);
    patchOutgoing(deferredTaskId, clientUserMessageId, {
      itemId: clientUserMessageId,
      turnUserSlot: "steer",
      ...deliveryPatch("steering"),
    });
  }
  renderTaskQueue(taskIdValue);
  try {
    const result = await control("deferred-input", { id, action: "steer" });
    if (clientUserMessageId) {
      const deferredTaskId = taskId(deferred.provider, deferred.threadId, deferred.streamId);
      patchOutgoing(deferredTaskId, clientUserMessageId, {
        turnId: String(result?.turnId ?? ""),
        ...deliveryPatch("accepted"),
      });
    }
    agentHub.toast(result?.message ?? "Сообщение добавлено в текущий ход");
  } catch (error) {
    if (clientUserMessageId) {
      const deferredTaskId = taskId(deferred.provider, deferred.threadId, deferred.streamId);
      optimisticDeferredClientUserMessageIds.add(clientUserMessageId);
      deferredClientUserMessageIds.add(clientUserMessageId);
      patchOutgoing(deferredTaskId, clientUserMessageId, deliveryPatch("queued"));
    }
    throw error;
  }
})));
agentHub.on("queue:new", ({ id, taskId: taskIdValue }) => runAction(() => runQueueAction(
  id,
  taskIdValue,
  async () => {
    const result = await control("deferred-input", { id, action: "new" });
    if (result?.snapshot) applySnapshot(result.snapshot);
    agentHub.toast(result?.message ?? "Сообщение отправлено в новую задачу");
    return result;
  },
)));
agentHub.on("queue:edit", ({ id, text }) => runAction(async () => {
  const result = await control("deferred-input", { id, action: "edit", text });
  applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Сообщение в очереди изменено");
}));
for (const [event, action, fallback] of [
  ["queue:pause", "pause", "Сообщение приостановлено"],
  ["queue:resume", "resume", "Очередь возобновлена"],
  ["queue:retry", "retry", "Повтор сообщения запланирован"],
]) {
  agentHub.on(event, ({ id, taskId: taskIdValue }) => runAction(() => runQueueAction(
    id,
    taskIdValue,
    async () => {
      const result = await control("deferred-input", { id, action });
      agentHub.toast(result?.message ?? fallback);
      return result;
    },
  )));
}
agentHub.on("queue:move", ({ id, direction, taskId: taskIdValue }) => runAction(() => runQueueAction(
  id,
  taskIdValue,
  async () => control("deferred-input", { id, action: "move", direction }),
)));
function downloadBlob(blob, name) {
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = String(name || "attachment");
  link.click();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
}

async function saveBlob(blob, name) {
  if (window.AgentHubAndroid?.saveDataUrl) {
    window.AgentHubAndroid.saveDataUrl(String(name || "attachment"), await blobDataUrl(blob));
    return;
  }
  downloadBlob(blob, name);
}

async function attachmentBlob(attachment) {
  const id = String(attachment?.id ?? "").trim();
  const directDataUrl = String(attachment?.dataUrl ?? "").trim();
  if (directDataUrl) {
    const response = await fetch(directDataUrl);
    return { blob: await response.blob(), name: attachment?.name, type: attachment?.type };
  }
  const access = id && !String(attachment?.url ?? "").trim()
    ? await control("open-attachment", { id })
    : attachment;
  const url = String(access?.url ?? attachment?.url ?? "").trim()
    || `/api/attachment/view?id=${encodeURIComponent(String(access?.id ?? ""))}`;
  if (!url || /id=$/u.test(url)) throw new Error("Файл вложения недоступен");
  await localSessionReady;
  const response = await hubFetch(url, {
    headers: authorizationHeaders(),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Файл вложения недоступен: HTTP ${response.status}`);
  return {
    blob: await response.blob(),
    name: access?.name ?? attachment?.name,
    type: access?.type ?? attachment?.type,
  };
}

function attachmentAccessUrl(access) {
  return String(access?.url ?? "").trim()
    || `/api/attachment/view?id=${encodeURIComponent(String(access?.id ?? ""))}`;
}

async function attachmentThumbnailUrl(attachment) {
  const direct = window.AgentHubResourceInteractions.attachmentPreviewSource(attachment, Boolean(vscode));
  if (direct) return direct;
  const id = String(attachment?.id ?? "").trim();
  if (!id) throw new Error("Миниатюра вложения недоступна");
  if (unavailableAttachmentThumbnailIds.has(id)) {
    const error = new Error("Миниатюра вложения недоступна");
    error.attachmentUnavailable = true;
    throw error;
  }
  if (attachmentThumbnailUrls.has(id)) return attachmentThumbnailUrls.get(id);
  if (attachmentThumbnailLoads.has(id)) return attachmentThumbnailLoads.get(id);
  const operation = (async () => {
    const access = await control("open-attachment", { id, preview: true });
    const url = attachmentAccessUrl(access);
    if (!url || /id=$/u.test(url)) throw new Error("Миниатюра вложения недоступна");
    await localSessionReady;
    const response = await hubFetch(url, {
      headers: authorizationHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Миниатюра вложения недоступна: HTTP ${response.status}`);
    const blob = await response.blob();
    if (!String(blob.type).toLowerCase().startsWith("image/")) {
      throw new Error("Сервер вернул некорректную миниатюру");
    }
    const objectUrl = URL.createObjectURL(blob);
    cacheAttachmentThumbnail(id, objectUrl);
    return objectUrl;
  })();
  attachmentThumbnailLoads.set(id, operation);
  try {
    return await operation;
  } finally {
    attachmentThumbnailLoads.delete(id);
  }
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Не удалось прочитать файл вложения"));
    reader.readAsDataURL(blob);
  });
}

async function loadAttachmentImage(attachment, index) {
  const directDataUrl = String(attachment?.dataUrl ?? "").trim();
  const directResourceUrl = String(attachment?.url ?? "").trim();
  const vscodeResource = vscode && !directDataUrl && !directResourceUrl && attachment?.id
    ? await bridgeCall("resolve-attachment", { id: attachment.id })
    : null;
  const resolvedResourceUrl = String(vscodeResource?.url ?? directResourceUrl).trim();
  const result = directDataUrl
    ? { dataUrl: directDataUrl, name: attachment?.name }
    : resolvedResourceUrl
      ? { dataUrl: resolvedResourceUrl, name: attachment?.name }
    : await attachmentBlob(attachment).then(async ({ blob, name }) => ({
      dataUrl: await blobDataUrl(blob),
      name,
    }));
  agentHub.showAttachmentViewer({ ...result, index });
}

agentHub.on("attachment:open", ({ attachment, gallery = [], index = 0 }) => runAction(async () => {
  const image = String(attachment?.type ?? "").toLowerCase().startsWith("image/") || attachment?.isImage;
  if (image) {
    const viewerGallery = window.AgentHubResourceInteractions.viewerGallery(
      gallery.length ? gallery : [attachment],
      vscode,
    );
    const viewerAttachment = viewerGallery[index] ?? viewerGallery[0] ?? attachment;
    agentHub.openAttachmentViewer({
      gallery: viewerGallery,
      index,
      dataUrl: viewerAttachment?.dataUrl,
      name: viewerAttachment?.name,
    });
    try {
      if (!viewerAttachment?.dataUrl) await loadAttachmentImage(viewerAttachment, index);
    } catch (error) {
      agentHub.closeAttachmentViewer();
      throw error;
    }
    return;
  }
  const id = String(attachment?.id ?? "").trim();
  if (vscode && id) {
    await bridgeCall("open-attachment", { id });
    return;
  }
  const result = await attachmentBlob(attachment);
  await saveBlob(result.blob, result.name);
}));

agentHub.on("attachment:thumbnail", ({ attachment, render, fail }) => void (async () => {
  try {
    const url = await attachmentThumbnailUrl(attachment);
    if (typeof render === "function") render(url);
  } catch (error) {
    const unavailable = window.AgentHubResourceInteractions.unavailableAttachmentError(error);
    const id = String(attachment?.id ?? "").trim();
    if (unavailable && id) rememberUnavailableAttachmentThumbnail(id);
    if (typeof fail === "function") fail({ missing: unavailable });
    if (!unavailable) console.warn(`Cannot load attachment thumbnail: ${error.message}`);
  }
})());

agentHub.on("attachment:load", ({ attachment, index }) => runAction(
  () => loadAttachmentImage(attachment, index),
));

function resourceReference(resource) {
  if (resource?.kind === "attachment") {
    return String(resource.attachment?.url ?? resource.attachment?.name ?? resource.attachment?.id ?? "");
  }
  return String(resource?.localPath ?? resource?.href ?? "");
}

function resourceFileName(resource) {
  if (resource?.kind === "attachment") return String(resource.attachment?.name ?? "attachment");
  const localPath = String(resource?.localPath ?? "").trim()
    .replace(/:[1-9][0-9]*(?::[1-9][0-9]*)?$/u, "")
    .replaceAll("\\", "/");
  if (localPath) return localPath.split("/").filter(Boolean).at(-1) || "download";
  try {
    const url = new URL(String(resource?.href ?? ""));
    return decodeURIComponent(url.pathname.split("/").filter(Boolean).at(-1) || "download");
  } catch {
    return String(resource?.name ?? "download");
  }
}

async function copyAttachmentResource(attachment) {
  if (vscode && attachment?.id) {
    await bridgeCall("copy-attachment", { id: attachment.id });
    return;
  }
  const { blob } = await attachmentBlob(attachment);
  try {
    if (!window.ClipboardItem || !navigator.clipboard?.write) throw new Error("binary clipboard unavailable");
    await navigator.clipboard.write([new ClipboardItem({
      [blob.type || "application/octet-stream"]: blob,
    })]);
  } catch {
    await navigator.clipboard.writeText(resourceReference({ kind: "attachment", attachment }));
  }
}

async function saveLinkResource(resource) {
  if (vscode) {
    await bridgeCall("save-link", {
      href: resource.href,
      localPath: resource.localPath,
      name: resource.name,
    });
    return;
  }
  if (String(resource?.localPath ?? "").trim()) {
    if (!localWorkspaceFilesAvailable) {
      throw new Error("Локальный файл Workspace доступен только на этом компьютере");
    }
    await localSessionReady;
    const response = await hubFetch(
      `/api/workspace-file?path=${encodeURIComponent(resource.localPath)}`,
      { headers: authorizationHeaders(), cache: "no-store" },
    );
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(String(payload.error ?? `Не удалось сохранить файл: HTTP ${response.status}`));
    }
    await saveBlob(await response.blob(), resourceFileName(resource));
    return;
  }
  const target = new URL(String(resource.href ?? ""), window.location.href);
  const sameOrigin = target.origin === window.location.origin;
  const response = await hubFetch(target.href, {
    headers: sameOrigin ? authorizationHeaders() : {},
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Не удалось сохранить ссылку: HTTP ${response.status}`);
  await saveBlob(await response.blob(), resourceFileName(resource));
}

async function revealWorkspaceFileOnServer(target) {
  await localSessionReady;
  const response = await hubFetch("/api/workspace-file/reveal", {
    method: "POST",
    headers: { ...authorizationHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ path: target }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    const error = new Error(String(payload.error ?? `Не удалось показать файл: HTTP ${response.status}`));
    error.code = String(payload.code ?? "");
    error.status = response.status;
    throw error;
  }
}

agentHub.on("resource:open", ({ resource }) => runAction(async () => {
  if (vscode) {
    await bridgeCall("open-link", { href: resource.localPath || resource.href });
    return;
  }
  window.open(String(resource.href ?? ""), "_blank", "noopener,noreferrer");
}));

agentHub.on("resource:open-editor", ({ resource }) => runAction(async () => {
  const target = String(resource?.localPath ?? "").trim();
  if (!target) throw new Error("Локальный путь не указан");
  if (vscode) await bridgeCall("open-link", { href: target });
  else window.open(`vscode://file/${encodeURI(target)}`, "_blank", "noopener,noreferrer");
}));

agentHub.on("resource:reveal", ({ resource }) => runAction(async () => {
  const target = String(resource?.localPath ?? "").trim();
  await window.AgentHubResourceInteractions.revealWorkspaceFileResource({
    target,
    vscode: Boolean(vscode),
    localWorkspaceFilesAvailable,
    remoteWorkspaceFileBridgeAvailable: remoteWorkspaceFileBridgeAvailable(),
    bridgeCall,
    revealOnServer: revealWorkspaceFileOnServer,
    launchWorkspaceFileBridge,
  });
}));

agentHub.on("resource:copy", ({ resource }) => runAction(async () => {
  if (resource?.kind === "attachment") await copyAttachmentResource(resource.attachment);
  else if (vscode) await bridgeCall("copy-link", { href: resource.localPath || resource.href });
  else await navigator.clipboard.writeText(resourceReference(resource));
  agentHub.toast("Скопировано в буфер обмена");
}));

agentHub.on("resource:copy-path", ({ resource }) => runAction(async () => {
  await navigator.clipboard.writeText(String(resource?.localPath ?? ""));
  agentHub.toast("Путь скопирован в буфер обмена");
}));

agentHub.on("clipboard:write", ({ text, successMessage }) => runAction(async () => {
  const value = String(text ?? "");
  if (vscode) await bridgeCall("copy-text", { text: value });
  else await navigator.clipboard.writeText(value);
  agentHub.toast(String(successMessage ?? "").trim() || "Скопировано в буфер обмена");
}));

agentHub.on("resource:copy-object", ({ resource }) => runAction(async () => {
  const localPath = String(resource?.localPath ?? "").trim();
  if (!localPath) throw new Error("Локальный путь не указан");
  if (vscode) await bridgeCall("copy-link-object", { href: localPath });
  else if (remoteWorkspaceFileBridgeAvailable()) await launchWorkspaceFileBridge("copy", localPath);
  else if (!localWorkspaceFilesAvailable) {
    throw new Error("Для удалённого браузера сопряги устройство и установи Windows File Bridge");
  }
  else {
    const response = await hubFetch("/api/workspace-file/copy", {
      method: "POST",
      headers: { ...authorizationHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ path: localPath }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(String(payload.error ?? `Не удалось скопировать файл: HTTP ${response.status}`));
    }
  }
  if (!remoteWorkspaceFileBridgeAvailable()) agentHub.toast("Файл скопирован в буфер обмена");
}));

agentHub.on("resource:save", ({ resource }) => runAction(async () => {
  if (resource?.kind === "attachment") {
    if (vscode && resource.attachment?.id) {
      await bridgeCall("save-attachment", { id: resource.attachment.id, name: resource.attachment.name });
    } else {
      const result = await attachmentBlob(resource.attachment);
      await saveBlob(result.blob, result.name);
    }
  } else await saveLinkResource(resource);
}));
agentHub.on("hub:restart", () => runAction(async () => {
  const result = await control("restart-server");
  if (result?.snapshot) applySnapshot(result.snapshot);
  else applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Перезапуск Agent Hub запрошен");
}));
agentHub.on("server:autostart", ({ enabled }) => runAction(async () => {
  const result = await control("set-autostart", { enabled: enabled === true });
  if (result?.snapshot) applySnapshot(result.snapshot);
  else applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Автозапуск Agent Hub обновлён");
}));
agentHub.on("server:config-update", ({ key, value, changes }) => runAction(async () => {
  /* Страница сохраняет всю карточку разом, поэтому принимаем и набор правок,
     и одиночную настройку. */
  const payload = changes && typeof changes === "object" ? changes : { [key]: value };
  const result = await control("update-server-configuration", { changes: payload });
  if (result?.snapshot) applySnapshot(result.snapshot);
  else applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Конфигурация сохранена");
}).then((result) => {
  // A rejected toggle must return to its actual persisted state instead of
  // leaving the switch visually changed after the error toast.
  if (result == null) agentHub.setServerStatus(lastSnapshot?.server ?? null);
}));
document.addEventListener("agenthub:root-agents-read", () => void (async () => {
  const editor = window.AgentHubRootAgentsEditor;
  try {
    editor?.setDocument(await control("read-root-agents"));
  } catch (error) {
    editor?.setError(hubErrorMessage(error));
    agentHub.toast(hubErrorMessage(error));
  }
})());
document.addEventListener("agenthub:pre-turn-instructions-read", () => void (async () => {
  const editor = window.AgentHubPreTurnInstructionsEditor;
  try {
    editor?.setSnapshot(await control("read-pre-turn-instructions"));
  } catch (error) {
    editor?.setError(hubErrorMessage(error));
    agentHub.toast(hubErrorMessage(error));
  }
})());
document.addEventListener("agenthub:global-pre-turn-update", (event) => void (async () => {
  const editor = window.AgentHubPreTurnInstructionsEditor;
  try {
    const result = await control("update-global-pre-turn-instructions", {
      content: String(event.detail?.content ?? ""),
    });
    editor?.setGlobalDocument(result?.document ?? {});
    agentHub.toast(result?.message ?? "Global pre-turn instructions сохранены");
  } catch (error) {
    editor?.setError(hubErrorMessage(error));
    agentHub.toast(hubErrorMessage(error));
  }
})());
document.addEventListener("agenthub:root-agents-update", (event) => void (async () => {
  const editor = window.AgentHubRootAgentsEditor;
  try {
    const result = await control("update-root-agents", { content: String(event.detail?.content ?? "") });
    editor?.setDocument(result?.document ?? {});
    agentHub.toast(result?.message ?? "Корневой AGENTS.md сохранён");
  } catch (error) {
    editor?.setError(hubErrorMessage(error));
    agentHub.toast(hubErrorMessage(error));
  }
})());
let searchSequence = 0;
agentHub.on("search:query", ({ query }) => {
  const sequence = ++searchSequence;
  void runAction(async () => {
    const result = await control("search", { query, limit: 100 });
    if (sequence === searchSequence) {
      agentHub.setSearchResults(result?.query ?? query, result?.results ?? []);
    }
  });
});
let workspaceMessageSearchSequence = 0;
agentHub.on("workspace-search:query", ({ workspaceId, query, offset, limit, append }) => {
  const sequence = ++workspaceMessageSearchSequence;
  void control("workspace-message-search", {
    workspaceId,
    query,
    offset,
    limit,
  }).then((result) => {
    if (sequence !== workspaceMessageSearchSequence) return;
    agentHub.setWorkspaceMessageSearchResults(result, { append: Boolean(append) });
  }).catch((error) => {
    if (sequence !== workspaceMessageSearchSequence) return;
    if (isConnectionFailure(error)) recordTransientConnectionFailure();
    const message = hubErrorMessage(error);
    agentHub.setWorkspaceMessageSearchError(message);
    agentHub.toast(message);
  });
});
agentHub.on("workspace-search:open", (result) => {
  const params = {
    workspaceId: result.workspaceId,
    streamId: result.streamId,
    provider: result.provider,
    taskThreadId: result.threadId,
    threadId: result.threadId,
    turnThreadId: result.turnThreadId,
    turnId: result.turnId,
    itemId: result.itemId,
    limit: 20,
  };
  return runNavigation(
    { streamId: params.streamId, provider: params.provider, threadId: params.taskThreadId },
    () => control("workspace-message-open", params),
    (opened) => {
      applyOpened(opened);
      agentHub.closeWorkspaceMessageSearch({ restoreFocus: false });
      document.querySelector("[data-view-button='chat']")?.click();
      replaceRoute("#/chat/"
        + `${encodeURIComponent(params.provider)}/${encodeURIComponent(params.taskThreadId)}`
        + `/turn/${encodeURIComponent(params.turnThreadId)}/${encodeURIComponent(params.turnId)}`);
    },
  );
});
agentHub.on("context:compact", () => runAction(async () => {
  const result = await control("compact-context", exactSelectedTaskParams());
  if (result?.accepted && result.compactionId) {
    requestedContextCompactions.add(String(result.compactionId));
  }
  agentHub.toast(result?.message ?? "Свёртка контекста запущена");
  applySnapshot(await control("snapshot"));
}));
agentHub.on("turn:open", (params) => runNavigation(
  { provider: params.provider, threadId: params.taskThreadId },
  () => control("open-turn", { ...params, limit: 20 }),
  (opened) => {
    applyOpened(opened);
    document.querySelector("[data-view-button='chat']")?.click();
    replaceRoute("#/chat/"
      + `${encodeURIComponent(params.provider)}/${encodeURIComponent(params.taskThreadId)}`
      + `/turn/${encodeURIComponent(params.turnThreadId)}/${encodeURIComponent(params.turnId)}`);
  },
));

document.addEventListener("click", (event) => {
  const openTask = event.target.closest("[data-open-task]");
  if (openTask) {
    event.preventDefault();
    event.stopPropagation();
    const provider = openTask.dataset.provider
      ?? openTask.closest("[data-work-log-provider]")?.dataset.workLogProvider;
    const threadId = openTask.dataset.threadId
      ?? openTask.closest("[data-work-log-thread-id]")?.dataset.workLogThreadId;
    void runNavigation(
      { provider, threadId },
      () => control("open-task", { provider, threadId, limit: 20 }),
      (opened) => {
        applyOpened(opened);
        document.querySelector("[data-view-button='chat']")?.click();
        const route = window.AgentHubNavigationTabs.resolvedChatRoute(opened, { provider, threadId });
        if (route.hash) replaceRoute(route.hash);
      },
    );
    return;
  }
  /* Кнопка субагентов стоит в той же строке, что «Открыть ход», поэтому её клик
     не должен ни раскрывать сам ход, ни открывать диалог. */
  const toggleSubagents = event.target.closest("[data-toggle-subagents]");
  if (toggleSubagents) {
    event.preventDefault();
    event.stopPropagation();
    const entry = toggleSubagents.closest("[data-work-log-turn-entry]");
    const children = entry?.querySelector("details[data-work-log-turn-children-details]");
    if (children) {
      children.open = !children.open;
      toggleSubagents.setAttribute("aria-pressed", String(children.open));
    }
    return;
  }
  const openTurn = event.target.closest("[data-open-turn]");
  if (!openTurn) return;
  event.preventDefault();
  event.stopPropagation();
  const entry = openTurn.closest("[data-work-log-turn-entry]");
  const row = openTurn.closest("[data-work-log-row]");
  const params = {
    provider: entry?.dataset.workLogTurnProvider ?? row?.dataset.workLogProvider,
    taskThreadId: entry?.dataset.workLogTaskThreadId ?? row?.dataset.workLogThreadId,
    turnThreadId: entry?.dataset.workLogTurnThreadId ?? row?.dataset.workLogThreadId,
    turnId: entry?.dataset.workLogTurnId,
    limit: 20,
  };
  void runNavigation(
    { provider: params.provider, threadId: params.taskThreadId },
    () => control("open-turn", params),
    (opened) => {
      applyOpened(opened);
      document.querySelector("[data-view-button='chat']")?.click();
      replaceRoute("#/chat/"
        + `${encodeURIComponent(params.provider)}/${encodeURIComponent(params.taskThreadId)}`
        + `/turn/${encodeURIComponent(params.turnThreadId)}/${encodeURIComponent(params.turnId)}`);
    },
  );
});

async function openRoute() {
  let parts;
  try {
    parts = location.hash.split("/").slice(1).map(decodeURIComponent);
  } catch {
    beginNavigation();
    return false;
  }
  if (parts[0] !== "chat" || !parts[1] || !parts[2]) {
    beginNavigation();
    return false;
  }
  if (parts[1] === "stream") {
    const streamId = parts[2];
    const task = snapshotTask(lastSnapshot, streamId);
    if (task) {
      const identity = {
        provider: task.provider,
        threadId: task.threadId,
        streamId: task.streamId,
      };
      const opened = await runNavigation(
        identity,
        () => control("open-task", { ...identity, limit: 20 }),
        applyOpened,
      );
      return Boolean(opened);
    }
    if (!emptyStreamModels(lastSnapshot ?? {}, streamId).some((draft) => draft.id === streamId)) {
      beginNavigation();
      return false;
    }
    beginNavigation();
    pendingSelectionId = streamId;
    rememberSelectedTaskId(streamId);
    applySnapshot(lastSnapshot);
    pendingSelectionId = "";
    agentHub.selectTask(streamId);
    return true;
  }
  if ((parts[3] && parts[3] !== "turn") || (parts[3] === "turn" && (!parts[4] || !parts[5]))) {
    beginNavigation();
    return false;
  }
  if (parts[3] === "turn") {
    const params = {
      provider: parts[1],
      taskThreadId: parts[2],
      turnThreadId: parts[4],
      turnId: parts[5],
      limit: 20,
    };
    const opened = await runNavigation(
      { provider: params.provider, threadId: params.taskThreadId },
      () => control("open-turn", params),
      applyOpened,
    );
    if (!opened) return false;
  } else {
    const identity = {
      provider: parts[1],
      threadId: parts[2],
    };
    const opened = await runNavigation(
      identity,
      () => control("open-task", { ...identity, limit: 20 }),
      applyOpened,
    );
    if (!opened) return false;
    const route = window.AgentHubNavigationTabs.resolvedChatRoute(opened, {
      provider: parts[1],
      threadId: parts[2],
    });
    rememberSelectedTaskId(taskId(route.provider, route.threadId, route.streamId));
    if (route.hash && route.hash !== location.hash) replaceRoute(route.hash);
  }
  return true;
}

function snapshotTask(snapshot, id) {
  return representativeSnapshotTasks(snapshot?.tasks).find((task) => (
    taskId(task.provider, task.threadId, task.streamId) === id
  )) ?? null;
}

function directChatRoute() {
  const parts = location.hash.split("/").slice(1).map(decodeURIComponent);
  return parts[0] === "chat" && Boolean(parts[1]) && Boolean(parts[2]) && parts[1] !== "stream";
}

function streamChatRoute() {
  const parts = location.hash.split("/").slice(1).map(decodeURIComponent);
  return parts[0] === "chat" && parts[1] === "stream" && Boolean(parts[2]);
}

async function refreshVisibleTaskHistories(previousSnapshot, snapshot) {
  const visibleIds = new Set(visibleStreamTaskIds);
  if (selectedTaskId) visibleIds.add(selectedTaskId);
  const chatVisible = document.documentElement.dataset.view === "chat";
  await Promise.all([...visibleIds].map(async (id) => {
    const previousTask = snapshotTask(previousSnapshot, id);
    const currentTask = snapshotTask(snapshot, id);
    if (!currentTask) return;
    const bindingTransition = Boolean(previousTask) && !sameIdentity(previousTask, currentTask);
    const answerTransition = latestAnswerTransition(previousTask, currentTask);
    if (answerTransition) {
      scheduleHistoryAttachmentSettle(id);
      historyCatchUpDeadlines.set(id, Date.now() + HISTORY_CATCH_UP_TIMEOUT_MS);
      const completedTurnId = completionCatchUpTurnId(previousTask, currentTask);
      if (completedTurnId) historyCatchUpTurnIds.set(id, completedTurnId);
    }
    const historyMissing = Boolean(previousTask) && !historyPageByTask.has(id);
    const externalLive = currentTask.running && !["hub", "telegram"].includes(String(
      currentTask.run?.executionOwner ?? currentTask.executionOwner ?? "",
    ));
    const lastRefreshAt = Number(historyRefreshAtByTask.get(id)) || 0;
    const refreshExternalHistory = chatVisible && externalLive
      && Date.now() - lastRefreshAt >= EXTERNAL_HISTORY_REFRESH_MS;
    const catchUpPending = historyNeedsCatchUp(id);
    const refreshCaughtUpHistory = chatVisible && catchUpPending
      && Date.now() - lastRefreshAt >= EXTERNAL_HISTORY_REFRESH_MS;
    const refreshSettlingAttachments = chatVisible && historyAttachmentsNeedSettling(id)
      && Date.now() - lastRefreshAt >= HISTORY_ATTACHMENT_REFRESH_MS;
    if (!historyMissing && !bindingTransition && !answerTransition
      && !refreshExternalHistory && !refreshCaughtUpHistory && !refreshSettlingAttachments) return;
    historyRefreshAtByTask.set(id, Date.now());
    const identity = {
      streamId: currentTask.streamId,
      provider: currentTask.provider,
      threadId: currentTask.threadId,
    };
    await enqueueTaskHistoryLoad(id, identity, {
      refreshSource: historyRefreshSourceRequired({ answerTransition, catchUpPending }),
      preserveScroll: true,
    });
  }));
}

function refreshConnectionLatency() {
  const now = Date.now();
  if (connectionLatencyProbe) return connectionLatencyProbe;
  if (now - connectionLatencyProbedAt < CONNECTION_LATENCY_PROBE_INTERVAL_MS) return null;
  connectionLatencyProbedAt = now;
  connectionLatencyProbe = window.AgentHubConnectionQuality.measureLatency(
    () => (vscode ? probeVscodeRuntimeHealth() : probeSnapshotTransport()),
  ).then((sample) => {
    connectionLatencyMs = window.AgentHubConnectionQuality.smoothLatency(connectionLatencyMs, sample);
    agentHub.setConnectionQuality({ latencyMs: connectionLatencyMs });
  }).catch(() => {}).finally(() => {
    connectionLatencyProbe = null;
  });
  return connectionLatencyProbe;
}

async function refresh({ reportError = false } = {}) {
  if (refreshing) {
    refreshRequested = true;
    return;
  }
  window.clearTimeout(refreshTimer);
  refreshTimer = null;
  refreshing = true;
  try {
    const previousSnapshot = lastSnapshot;
    await prepareSnapshotTransport();
    let snapshotResult = await control(
      "snapshot",
      window.AgentHubSnapshotTransport.requestParams(lastSnapshot),
    );
    let snapshot = lastSnapshot;
    if (snapshotResult?.notModified !== true) {
      try {
        snapshot = window.AgentHubSnapshotTransport.materialize(lastSnapshot, snapshotResult);
      } catch (error) {
        if (!window.AgentHubSnapshotTransport.isBaselineError(error)) throw error;
        snapshotResult = await control(
          "snapshot",
          window.AgentHubSnapshotTransport.requestParams(null),
        );
        if (snapshotResult?.notModified === true) {
          throw new Error("Agent Hub returned notModified without a snapshot baseline");
        }
        snapshot = window.AgentHubSnapshotTransport.materialize(null, snapshotResult);
      }
    }
    void refreshConnectionLatency();
    if (snapshotResult?.notModified === true) {
      resetConnectionFailures();
      applySnapshotConnection(snapshot);
    } else {
      applySnapshot(snapshot, { materialized: true });
    }
    if (!snapshot) return;
    void refreshVisibleTaskHistories(previousSnapshot, snapshot).catch((error) => {
      console.error("Agent Hub visible history refresh failed", error);
    });
  } catch (error) {
    recordTransientConnectionFailure();
    if (reportError) throw error;
  } finally {
    refreshing = false;
    if (refreshRequested) {
      refreshRequested = false;
      refreshTimer = window.setTimeout(refresh, 0);
      return;
    }
    const active = Boolean(lastSnapshot?.tasks?.some(
      (task) => task.running || task.context?.compacting || task.maintenance,
    )) || [...visibleStreamTaskIds].some(historyNeedsCatchUp) || historyNeedsCatchUp(selectedTaskId);
    refreshTimer = window.setTimeout(refresh, active ? 1_200 : 5_000);
  }
}

agentHub.on("connection:retry", () => void refresh({ reportError: false }));

void runAction(async () => {
  agentHub.setConnection("connecting");
  try {
    let routed = false;
    if (streamChatRoute()) {
      // A stable Stream route needs the first snapshot to resolve its current
      // provider/Thread binding. Opening it before refresh used to reject the
      // route and permanently fall back to snapshot.selected for this page.
      await refresh({ reportError: true });
      routed = await openRoute();
    } else if (directChatRoute()) {
      routed = await openRoute();
      // openRoute загружает актуальную историю раньше фонового prefetch, но
      // сам по себе не запускает периодический refresh. Без этого первый
      // snapshot остаётся последним до полной перезагрузки страницы.
      await refresh({ reportError: true });
    } else {
      await refresh({ reportError: true });
      routed = await openRoute();
    }
    const identity = !routed ? taskIdentity(selectedTaskId) : null;
    if (identity) {
      await runNavigation(
        identity,
        () => control("open-task", { ...identity, limit: 20 }),
        applyOpened,
      );
    }
  } finally {
    initialRouteOpening = false;
    void loadVisibleTaskHistories([...visibleStreamTaskIds]);
  }
});
void refreshRateLimitHistory();
rateLimitRefreshTimer = window.setInterval(() => {
  void refreshRateLimitHistory();
}, 5 * 60_000);

window.addEventListener("hashchange", () => void runAction(openRoute));
window.addEventListener("beforeunload", () => {
  window.clearTimeout(refreshTimer);
  if (connectionOfflineTimer != null) window.clearTimeout(connectionOfflineTimer);
  window.clearInterval(rateLimitRefreshTimer);
});

})();
