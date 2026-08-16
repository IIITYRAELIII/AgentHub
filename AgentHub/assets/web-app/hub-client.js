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
const selectedTaskKey = "agent-hub:selected-task:v1";
const serverIdentityKey = "agent-hub:server-identity:v1";
const maintenanceEventStorageKey = "agent-hub:maintenance-events:v1";
let bridgeSequence = 0;
let lastSnapshot = null;
let observedServerIdentity = readStoredServerIdentity();
let selectedTaskId = readSelectedTaskId();
let refreshTimer = null;
let rateLimitRefreshTimer = null;
let rateLimitRefreshRange = window.AgentHubStatisticsControls.storedLimitsRange(window.localStorage);
let rateLimitRefreshInFlight = false;
let refreshing = false;
let connectionFailureCount = 0;
let connectionFailureSince = 0;
let connectionOfflineTimer = null;
let pendingSelectionId = "";
let selectionSequence = 0;
let selectionTail = Promise.resolve();
let initialRouteOpening = true;
const historyRefreshAtByTask = new Map();
let visibleStreamTaskIds = new Set();
const EXTERNAL_HISTORY_REFRESH_MS = 2_500;
const HISTORY_ATTACHMENT_REFRESH_MS = 10_000;
const HISTORY_ATTACHMENT_SETTLE_TIMEOUT_MS = 120_000;
const REMOTE_WAIT_MS = 0;
const REMOTE_RESULT_FALLBACK_POLL_MS = 600;
const DEFAULT_CONTROL_TIMEOUT_MS = 45_000;
const LONG_CONTROL_TIMEOUT_MS = 180_000;
const LONG_CONTROL_ACTIONS = new Set(["rotate-stream", "submit-bug-report"]);
const HISTORY_CATCH_UP_TIMEOUT_MS = 120_000;
const CONNECTION_OFFLINE_FAILURES = 3;
const CONNECTION_OFFLINE_GRACE_MS = 6_000;
const historyByTask = new Map();
const historyPageByTask = new Map();
const historyCatchUpDeadlines = new Map();
const historyAttachmentSettleDeadlines = new Map();
const visibleHistoryLoads = new Set();
const outgoingByTask = new Map();
const liveProbeByTask = new Map();
const liveUserMessagesByTask = new Map();
const liveCardsByTask = new Map();
const completionOverlaysByTask = new Map();
const queueActionsInFlight = new Set();
const optimisticDeferredClientUserMessageIds = new Set();
const requestedContextCompactions = new Set();
const streamCreatesInFlight = new Map();
const observedContextCompactions = new Map();
const maintenanceEventsByTask = readMaintenanceEvents();
const activeMaintenanceByTask = new Map();
let deferredClientUserMessageIds = new Set();
const MAX_OUTGOING_MESSAGES_PER_TASK = 100;
const CONTEXT_PROBE_CLIENT_ID_PREFIX = "agent-hub-context-probe:";
const CONTEXT_PROBE_PROMPT = "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1";
const CONTEXT_PROBE_RESPONSE = "AGENT_HUB_CONTEXT_PROBE_OK_V1";
const {
  activeStageLabel,
  chronologicalMessages,
  conversationTaskId,
  completedConversationTurnVisible,
  confirmedOutgoingMessageIds,
  conversationMessageAuthor,
  deduplicateConversationMessages,
  focusedTurnAlreadyVisible,
  focusedTurnTaskThreadId,
  historyContainsLatestAnswer,
  historicalMessagesForDisplay,
  hubErrorMessage,
  isConnectionFailure,
  liveCompletionTransition,
  looksLikeConnectionFailure,
  markCommandRejected,
  markConnectionFailure,
  messageSendDefinitelyRejected,
  mergeDeferredQueueEntries,
  mergeLiveMaintenance,
  mergeReconciledUserMessage,
  mergeLiveUserMessages,
  mergeTurnMaintenanceMessages,
  normalizedResponseAnnotations,
  normalizedUserMessage,
  outgoingTaskId,
  responseAnnotationPrompt,
  reconcile: reconcileMessageLifecycle,
  rememberBounded: rememberBoundedMessage,
  reusableAttachmentPaths,
  settleOptionalRead,
  withoutSupersededCompactionFailures,
  visibleConversationMessages,
} = window.AgentHubMessageLifecycle;

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
  const instanceChanged = identity.instanceId !== observedServerIdentity.instanceId;
  const releaseChanged = identity.releaseId !== observedServerIdentity.releaseId;
  let reloadStarted = false;
  if (instanceChanged || releaseChanged) {
    rememberServerIdentity(identity);
    if (instanceChanged) notifyAndroidAboutRelease(identity);
    if (releaseChanged) reloadStarted = reloadForPublishedRuntime();
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
      values.set(task, withoutSupersededCompactionFailures(events).slice(-50));
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
  const value = { ...message, role: "system", kind: "maintenance" };
  if (index >= 0) events[index] = value;
  else events.push(value);
  const normalized = withoutSupersededCompactionFailures(events).slice(-50);
  if (previous === JSON.stringify(normalized)) return false;
  maintenanceEventsByTask.set(stableTaskId, normalized);
  persistMaintenanceEvents();
  return true;
}

function taskIdentity(id) {
  const stableId = String(id ?? "").trim();
  const task = (lastSnapshot?.tasks ?? []).find((candidate) => (
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
    accepted: { deliveryState: "accepted", delivery: "Принято", failed: false },
    deferred: { deliveryState: "deferred", delivery: "Отложено", failed: false },
    queued: { deliveryState: "queued", delivery: "В очереди", failed: false },
    delivered: { deliveryState: "delivered", delivery: "", failed: false },
    unconfirmed: { deliveryState: "unconfirmed", delivery: "Статус приёма уточняется…", failed: false },
    rejected: { deliveryState: "rejected", delivery: "Не принято", failed: true },
  };
  return states[stateName] ?? states.unconfirmed;
}

function attachmentView(attachment) {
  const value = { ...attachment };
  const id = String(value.id ?? "").trim();
  const localSurface = !vscode
    && !telegramInitData
    && !window.AgentHubAndroid
    && !window.AgentHubBrowserDevice;
  if (localSurface && id && !value.missing && !String(value.url ?? "").trim()) {
    value.url = `/api/message-attachment/${encodeURIComponent(id)}`;
  }
  return value;
}

function attachmentViews(values) {
  return (Array.isArray(values) ? values : []).map(attachmentView);
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
  const durableMessages = deduplicateConversationMessages(historyByTask.get(taskIdValue) ?? []);
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
  const serverMessages = deduplicateConversationMessages(mergeLiveUserMessages(
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
  for (const clientUserMessageId of confirmedMatchedIds) pending.delete(clientUserMessageId);
  const visible = visibleConversationMessages(result.map(normalizedUserMessage), {
    deferredClientUserMessageIds,
    liveProbe: liveProbeByTask.get(taskIdValue) ?? null,
  });
  // Live snapshots, durable history and the optimistic receipt can arrive in
  // either order. Re-run idempotent deduplication after all three were merged.
  return chronologicalMessages(deduplicateConversationMessages(visible));
}

function deferredEntriesForTask(snapshot, taskIdValue) {
  return (snapshot?.deferredInputs ?? []).filter((item) => (
    item.state !== "dispatching"
    && item.state !== "steering"
    && (!item.provider || taskId(item.provider, item.threadId) === taskIdValue)
  ));
}

function optimisticDeferredEntries(taskIdValue, serverEntries = []) {
  const serverClientIds = new Set(serverEntries
    .map((item) => String(item.clientUserMessageId ?? item.clientMessageId ?? "").trim())
    .filter(Boolean));
  return [...outgoingMessages(taskIdValue).values()]
    .filter((message) => (
      optimisticDeferredClientUserMessageIds.has(message.clientUserMessageId)
      || serverClientIds.has(message.clientUserMessageId)
    ))
    .map((message) => ({
      id: `local:${message.clientUserMessageId}`,
      state: "queued",
      clientUserMessageId: message.clientUserMessageId,
      text: message.responseAnnotationRequest
        || (message.responseAnnotations?.length ? "" : message.text),
      annotations: message.responseAnnotations ?? [],
      attachments: message.attachments ?? [],
      createdAt: message.time,
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

function receiptDeliveryPatch(receipt) {
  if (receipt?.accepted === true || receipt?.steered === true) return deliveryPatch("accepted");
  if (receipt?.deferred === true) {
    return deliveryPatch(receipt?.queued === true ? "queued" : "deferred");
  }
  if (receipt?.cancelled === true) return deliveryPatch("rejected");
  return null;
}

function applyMessageReceipts(snapshot) {
  for (const receipt of snapshot?.messageReceipts ?? []) {
    const clientUserMessageId = String(receipt?.clientUserMessageId ?? "").trim();
    const provider = String(receipt?.provider ?? "").trim();
    const threadId = String(receipt?.threadId ?? "").trim();
    const patch = receiptDeliveryPatch(receipt);
    if (!clientUserMessageId || !provider || !threadId || !patch) continue;
    const accepted = receipt.accepted === true
      || receipt.deferred === true
      || receipt.steered === true;
    agentHub.completeSend(clientUserMessageId, { accepted });
    const stableTaskId = taskId(provider, threadId);
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
        turnId: String(receipt.turnId ?? ""),
        itemId: receipt.id ?? clientUserMessageId,
        clientUserMessageId,
        role: "user",
        author: "Вы",
        text: restoredText,
        responseAnnotations: restoredAnnotations,
        responseAnnotationRequest: restoredRequest,
        time: receipt.createdAt ?? null,
        attachments: restoredAttachments,
      });
    }
    patchOutgoing(stableTaskId, clientUserMessageId, {
      provider,
      threadId,
      turnId: String(receipt.turnId ?? ""),
      itemId: receipt.steered === true ? clientUserMessageId : receipt.id ?? clientUserMessageId,
      time: receipt.deliveredAt ?? receipt.createdAt ?? null,
      ...nonEmptyAttachmentPatch(receipt.attachments),
      ...(receipt.accepted && !receipt.steered ? { turnUserSlot: "root" } : {}),
      ...(receipt.steered ? { turnUserSlot: "steer" } : {}),
      ...patch,
    });
  }
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
  const taskAnswerTurnId = String(selected?.lastAnswerTurnId ?? "").trim();
  const answer = String(
    taskAnswerTurnId === previousTurnId ? selected?.lastAnswer : previous?.text,
  ).trim();
  const incomingStartedAtMs = Date.parse(selected?.run?.startedAt ?? "");
  const recordedCompletionTime = taskAnswerTurnId === previousTurnId
    ? selected?.lastAnswerAt
    : previous?.time;
  const recordedCompletionAtMs = Date.parse(recordedCompletionTime ?? "");
  const completionTime = Number.isFinite(incomingStartedAtMs)
    && (!Number.isFinite(recordedCompletionAtMs) || recordedCompletionAtMs >= incomingStartedAtMs)
    ? new Date(incomingStartedAtMs - 1).toISOString()
    : recordedCompletionTime ?? null;
  const messages = mergeLiveUserMessages([], liveUsers);
  if (answer) {
    messages.push({
      id: `${previous.provider}:${previous.threadId}:${previousTurnId}:completion-overlay:agent`,
      provider: previous.provider,
      threadId: previous.threadId,
      turnId: previousTurnId,
      itemId: previous.itemId || `${previousTurnId}:agent:final`,
      role: "agent",
      author: previous.author,
      phase: "final",
      text: answer,
      time: completionTime,
    });
  }
  if (messages.length) {
    const overlays = completionOverlaysByTask.get(taskIdValue) ?? new Map();
    overlays.set(previousTurnId, { answer, messages });
    while (overlays.size > 20) overlays.delete(overlays.keys().next().value);
    completionOverlaysByTask.set(taskIdValue, overlays);
  }
  liveCardsByTask.delete(taskIdValue);
  return messages.length > 0;
}

function exactSelectedTaskParams() {
  return exactTaskParams(selectedTaskId);
}

function exactTaskParams(id) {
  const identity = taskIdentity(id);
  if (!identity) throw new Error("Сначала выберите задачу");
  return identity;
}

function renderTaskMessages(taskIdValue, { preserveScroll = false } = {}) {
  const messages = reconciledMessages(taskIdValue);
  if (preserveScroll) agentHub.setMessagesPreservingScroll(taskIdValue, messages);
  else agentHub.setMessages(taskIdValue, messages);
}

function internalContextProbeRun(run) {
  if (!run) return false;
  const messages = Array.isArray(run.userMessages) ? run.userMessages : [];
  const clientIds = [run.clientUserMessageId, ...messages.map((message) => (
    message?.clientUserMessageId ?? message?.clientId
  ))].map((value) => String(value ?? "").trim());
  if (clientIds.some((value) => value.startsWith(CONTEXT_PROBE_CLIENT_ID_PREFIX))) return true;
  const texts = [run.prompt, run.response, ...messages.map((message) => message?.text)]
    .map((value) => String(value ?? "").trim());
  return texts.some((value) => value === CONTEXT_PROBE_PROMPT || value === CONTEXT_PROBE_RESPONSE);
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
  });
}

function updateLiveMessage(taskIdValue, selected) {
  const run = selected?.run;
  if (internalContextProbeRun(run)) {
    clearInternalContextProbe(taskIdValue);
    return null;
  }
  const promoted = promoteLiveCompletion(taskIdValue, selected, run?.turnId);
  if (!run) {
    const removed = liveProbeByTask.delete(taskIdValue);
    const userRemoved = liveUserMessagesByTask.delete(taskIdValue);
    if (promoted || removed || userRemoved) renderTaskMessages(taskIdValue);
    return null;
  }
  const nextLiveUsers = {
    provider: selected.provider,
    threadId: selected.threadId,
    turnId: String(run.turnId ?? ""),
    userMessages: run.userMessages ?? [],
    prompt: run.prompt ?? "",
    promptAuthor: run.promptAuthor ?? "",
    clientUserMessageId: run.clientUserMessageId ?? "",
    time: run.startedAt ?? null,
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
    if (probeChanged || liveUsersChanged) renderTaskMessages(taskIdValue);
  } else {
    const removed = liveProbeByTask.delete(taskIdValue);
    if (removed || liveUsersChanged) renderTaskMessages(taskIdValue);
  }
  const liveCard = mergeLiveMaintenance({
    author: selected.provider === "claude" ? "Claude" : "Codex",
    stage: activeStageLabel(run.stage),
    reasoning: run.progress || "",
    text: response,
    activities: run.activities ?? [],
    activityGroups: run.activityGroups ?? [],
    responsePhase: run.responsePhase ?? "",
    threadId: selected.threadId,
    turnId: run.turnId,
    itemId: run.responseItemId ?? null,
    provider: selected.provider,
    time: run.lastActivityAt ?? run.startedAt ?? null,
  }, maintenanceEventsByTask.get(taskIdValue) ?? []);
  liveCardsByTask.set(taskIdValue, liveCard);
  return liveCard;
}

function authorizationHeaders() {
  if (telegramInitData) return { Authorization: `tma ${telegramInitData}` };
  try {
    const deviceToken = String(window.AgentHubAndroid?.getAccessToken?.() ?? "").trim();
    if (deviceToken) return { Authorization: `device ${deviceToken}` };
  } catch {
    // The native bridge is optional; local web and VS Code use their existing transport.
  }
  const browserToken = String(window.AgentHubBrowserDevice?.getAccessToken?.() ?? "").trim();
  if (browserToken) return { Authorization: `device ${browserToken}` };
  return {};
}

function historyNeedsCatchUp(taskIdValue) {
  const deadline = Number(historyCatchUpDeadlines.get(taskIdValue)) || 0;
  if (!deadline) return false;
  if (deadline > Date.now()) return true;
  historyCatchUpDeadlines.delete(taskIdValue);
  return false;
}

function updateHistoryCatchUp(taskIdValue, history, task) {
  if (historyContainsLatestAnswer(history, task)) {
    historyCatchUpDeadlines.delete(taskIdValue);
    return;
  }
  if (!historyCatchUpDeadlines.has(taskIdValue)) {
    historyCatchUpDeadlines.set(taskIdValue, Date.now() + HISTORY_CATCH_UP_TIMEOUT_MS);
  }
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

function bridgeCall(action, params = {}) {
  if (!vscode) return null;
  const id = `bridge-${Date.now()}-${++bridgeSequence}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingBridgeCalls.delete(id);
      reject(markConnectionFailure(new Error("Agent Hub в VS Code не ответил вовремя")));
    }, LONG_CONTROL_ACTIONS.has(action) ? LONG_CONTROL_TIMEOUT_MS : DEFAULT_CONTROL_TIMEOUT_MS);
    pendingBridgeCalls.set(id, { resolve, reject, timer });
    vscode.postMessage({ type: "agenthub:control", id, action, params });
  });
}

async function hubFetch(input, init) {
  try {
    await window.AgentHubBrowserDevice?.ensureSession?.();
    const browserToken = String(window.AgentHubBrowserDevice?.getAccessToken?.() ?? "").trim();
    if (!browserToken) return await fetch(input, init);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `device ${browserToken}`);
    return await fetch(input, { ...init, headers });
  } catch (error) {
    throw markConnectionFailure(error);
  }
}

window.addEventListener("message", (event) => {
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
});

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
  void waitRemoteResult(commandId, LONG_CONTROL_TIMEOUT_MS).then((result) => {
    const clientUserMessageId = String(params?.clientUserMessageId ?? "").trim();
    if (clientUserMessageId) {
      const resolvedTaskId = updateOutgoing("", clientUserMessageId, {
        threadId: result?.threadId ?? params?.threadId ?? "",
        turnId: result?.turnId ?? "",
        itemId: result?.itemId ?? clientUserMessageId,
        ...(result?.accepted
          ? deliveryPatch("accepted")
          : result?.deferred
            ? deliveryPatch(result?.queued ? "queued" : "deferred")
            : deliveryPatch("rejected")),
      });
      if (resolvedTaskId) renderTaskMessages(resolvedTaskId);
    }
    if (result?.snapshot) applySnapshot(result.snapshot);
    else void refresh();
  }).catch((error) => {
    console.error("Agent Hub queued message reconciliation failed", error);
    if (messageSendDefinitelyRejected(error)) {
      const clientUserMessageId = String(params?.clientUserMessageId ?? "").trim();
      const resolvedTaskId = updateOutgoing("", clientUserMessageId, deliveryPatch("rejected"));
      if (resolvedTaskId) renderTaskMessages(resolvedTaskId);
      agentHub.toast(String(error?.message ?? "Сообщение отклонено локальным Agent Hub"));
    }
    void refresh();
  });
}

async function readSnapshot(params = {}) {
  await localSessionReady;
  const query = new URLSearchParams({
    knownVersion: String(params?.knownVersion ?? ""),
    waitMs: String(REMOTE_WAIT_MS),
  });
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

async function control(action, params = {}) {
  const bridged = bridgeCall(action, params);
  if (bridged) return bridged;
  if (action === "snapshot") return readSnapshot(params);
  await localSessionReady;
  const commandId = crypto.randomUUID();
  const response = await hubFetch("/api/control", {
    method: "POST",
    headers: {
      ...authorizationHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, params, commandId }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw markCommandRejected(
      new Error(String(payload.error ?? `Agent Hub: HTTP ${response.status}`)),
    );
  }
  if (payload.receiptId === commandId) {
    await acknowledgeLocalControl(commandId).catch((error) => {
      console.warn(`Agent Hub control acknowledgement failed: ${error.message}`);
    });
  }
  if (payload.pending && payload.id && action === "send-message") {
    observeQueuedRemoteMessage(payload.id, params);
    return {
      deferred: true,
      queued: true,
      remoteQueued: true,
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

function modelTask(task, snapshot, effectiveSelectedId, serverSelectedId) {
  const id = taskId(task.provider, task.threadId, task.streamId);
  const streamId = String(task.streamId ?? "").trim()
    || `legacy:${String(task.provider ?? "").trim()}:${String(task.threadId ?? "").trim()}`;
  const answerAt = Date.parse(task.lastAnswerAt ?? "") || 0;
  const running = Boolean(task.running);
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

function activeMaintenanceMessage(task) {
  const stableTaskId = taskId(task.provider, task.threadId, task.streamId);
  const maintenanceReason = String(task.maintenance?.reason ?? "");
  if (["manual-rotation", "automatic-rotation"].includes(maintenanceReason)) {
    return {
      id: `maintenance:rotation:${stableTaskId}:active`,
      provider: task.provider,
      threadId: task.threadId,
      itemId: `maintenance:rotation:${stableTaskId}:active`,
      role: "system",
      kind: "maintenance",
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
    itemId: `maintenance:compaction:${compactionId}:active`,
    role: "system",
    kind: "maintenance",
    text,
    time: compaction.startedAt ?? null,
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
      const visibleBeforePercent = beforePercent ?? "?";
      const visibleAfterPercent = afterPercent ?? "?";
      if (rememberMaintenanceEvent(stableTaskId, {
        id: eventId,
        provider: task.provider,
        threadId: task.threadId,
        itemId: eventId,
        turnId: compaction.turnId ?? null,
        maintenanceType: "compaction",
        maintenanceStatus: "completed",
        maintenanceLabel: "Свёртка завершена успешно",
        maintenanceDetail: `${visibleBeforePercent}% → ${visibleAfterPercent}%`,
        beforePercent,
        afterPercent,
        text: `Свёртка завершена успешно ${visibleBeforePercent}%>${visibleAfterPercent}%`,
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
  const previousByStream = new Map((previousTasks ?? []).flatMap((task) => (
    task.streamId ? [[String(task.streamId), task]] : []
  )));
  for (const task of tasks ?? []) {
    const streamId = String(task.streamId ?? "").trim();
    const previous = previousByStream.get(streamId);
    if (!streamId) continue;
    const stableTaskId = taskId(task.provider, task.threadId, streamId);
    const eventId = `maintenance:rotation:${streamId}:${task.threadId}`;
    const existingEvent = (maintenanceEventsByTask.get(stableTaskId) ?? [])
      .find((event) => event.id === eventId);
    const rotated = previous && String(previous.threadId) !== String(task.threadId);
    if (!rotated && !existingEvent) continue;
    const beforePercent = contextPercent(existingEvent?.beforePercent)
      ?? storedMaintenancePercent(existingEvent, 1)
      ?? (rotated ? contextPercent(previous.context?.percent) : null);
    const afterPercent = contextPercent(existingEvent?.afterPercent)
      ?? storedMaintenancePercent(existingEvent, 2)
      ?? (task.context?.usagePending ? null : contextPercent(task.context?.percent));
    const visibleBeforePercent = beforePercent ?? "?";
    const visibleAfterPercent = afterPercent ?? "?";
    if (rememberMaintenanceEvent(stableTaskId, {
      id: eventId,
      provider: task.provider,
      threadId: task.threadId,
      itemId: eventId,
      beforePercent,
      afterPercent,
      text: `Ротация завершена успешно ${visibleBeforePercent}%>${visibleAfterPercent}%`,
      time: existingEvent?.time ?? new Date().toISOString(),
    })) changed.add(stableTaskId);
  }
  return changed;
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  if (observeServerIdentity(snapshot)) return;
  resetConnectionFailures();
  const previousTasks = lastSnapshot?.tasks ?? [];
  lastSnapshot = snapshot;
  agentHub.setExchangeRates(snapshot.exchangeRates ?? null);
  agentHub.setServerStatus(snapshot.server ?? null);
  agentHub.setWorkspaces(snapshot.workspaces ?? [], snapshot.boardLayout?.columnOrder ?? []);
  window.AgentHubTaskBoard?.setSnapshot({
    tasks: (snapshot.boardTasks ?? []).map((task) => ({
      ...task,
      attachments: attachmentViews(task.attachments),
    })),
    workspaces: snapshot.workspaces ?? [],
    columnOrder: snapshot.boardLayout?.columnOrder ?? [],
    notesComment: snapshot.boardLayout?.notesComment ?? "Игры, фильмы, сериалы и идеи",
    selectedWorkspaceId: snapshot.selected?.workspaceId ?? null,
    provider: snapshot.settings?.provider ?? "codex",
  });
  const maintenanceChanged = new Set([
    ...observeContextCompactions(snapshot.tasks),
    ...observeStreamRotations(previousTasks, snapshot.tasks),
    ...syncActiveMaintenanceMessages(snapshot.tasks),
  ]);
  applyMessageReceipts(snapshot);
  const serverDeferredClientUserMessageIds = new Set(
    (snapshot.deferredInputs ?? [])
      .filter((item) => item.state !== "dispatching")
      .map((item) => String(item.clientUserMessageId ?? "").trim())
      .filter(Boolean),
  );
  const activeRunClientUserMessageIds = new Set((snapshot.tasks ?? [])
    .map((task) => String(task.run?.clientUserMessageId ?? "").trim())
    .filter(Boolean));
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
  const effectiveSelectedId = pendingExists
    ? pendingSelectionId
    : localExists
      ? selectedTaskId
      : serverSelectedId;
  const tasks = [
    ...(snapshot.tasks ?? []).map((task) => modelTask(task, snapshot, effectiveSelectedId, serverSelectedId)),
    ...emptyStreamModels(snapshot, effectiveSelectedId),
  ].sort((left, right) => Date.parse(right.lastActivity || 0) - Date.parse(left.lastActivity || 0));
  agentHub.setTasks(tasks);
  for (const task of tasks.filter((candidate) => candidate.draftStream)) agentHub.setMessages(task.id, []);
  if (maintenanceChanged.has(effectiveSelectedId)) {
    renderTaskMessages(effectiveSelectedId, { preserveScroll: true });
  }
  for (const deferred of snapshot.deferredInputs ?? []) {
    const clientUserMessageId = String(deferred.clientUserMessageId ?? "");
    if (!clientUserMessageId) continue;
    patchOutgoing(
      taskId(deferred.provider, deferred.threadId),
      clientUserMessageId,
      {
        ...deliveryPatch(
          deferred.state === "dispatching" || deferred.state === "steering"
            ? "sending"
            : deferred.state === "queued"
              ? "queued"
              : "deferred",
        ),
        time: deferred.createdAt ?? null,
        ...nonEmptyAttachmentPatch(deferred.attachments),
      },
    );
  }
  for (const task of snapshot.tasks ?? []) {
    const clientUserMessageId = String(task.run?.clientUserMessageId ?? "");
    if (!clientUserMessageId) continue;
    patchOutgoing(taskId(task.provider, task.threadId), clientUserMessageId, {
      provider: task.provider,
      threadId: task.threadId,
      turnId: String(task.run?.turnId ?? ""),
      time: task.run?.startedAt ?? null,
      ...nonEmptyAttachmentPatch(task.run?.attachments),
      // The run-level receipt is assigned only when Agent Hub starts a new
      // turn. It identifies the first user item even while Codex history has
      // not yet echoed client_id back to us.
      turnUserSlot: "root",
      ...deliveryPatch("accepted"),
    });
  }
  const selected = (snapshot.tasks ?? []).find(
    (task) => taskId(task.provider, task.threadId) === effectiveSelectedId,
  );
  rememberSelectedTaskId(effectiveSelectedId);
  for (const task of snapshot.tasks ?? []) {
    const stableTaskId = taskId(task.provider, task.threadId, task.streamId);
    agentHub.setLive(stableTaskId, updateLiveMessage(stableTaskId, task));
    agentHub.setRunning(stableTaskId, Boolean(task.running));
  }
  for (const task of snapshot.tasks ?? []) {
    renderTaskQueue(taskId(task.provider, task.threadId, task.streamId), snapshot);
  }
  if (selected) {
    agentHub.setApprovals(selectedTaskId, effectiveSelectedId === serverSelectedId
      ? (snapshot.pendingApprovals ?? []).map((approval) => ({
      id: approval.key ?? approval.id,
      kind: approval.kind ?? "Подтверждение",
      text: approval.text ?? approval.preview ?? approval.reason ?? "",
      questions: Array.isArray(approval.questions) ? approval.questions : null,
      options: approval.kind === "user-input"
        ? [{ id: "decline", label: "Отменить", kind: "danger" }]
        : [
          ...(approval.canAccept === false ? [] : [{ id: "once", label: "Разрешить", kind: "primary" }]),
          ...(approval.canAllowSession === false ? [] : [{ id: "session", label: "На сессию" }]),
          { id: "decline", label: "Отклонить", kind: "danger" },
        ],
      }))
      : []);
  }
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
  agentHub.setSelection({
    provider: settings.provider,
    model: settings.model,
    reasoning: settings.reasoning,
    mode: settings.mode,
    autoApprove: settings.approvalMode === "auto",
    includeClaudeUsage: settings.includeClaudeUsage !== false,
    activityRecentMinutes: settings.activityRecentMinutes,
    ...(selectedDraft?.streamSettings ?? {}),
  });
  applySnapshotConnection(snapshot);
}

function applySnapshotConnection(snapshot, idleStatus = "online") {
  const hasDetailedCount = snapshot?.restartBlockingCount != null;
  const blockingCount = Math.max(
    0,
    Number(hasDetailedCount ? snapshot.restartBlockingCount : snapshot?.activeCount) || 0,
  );
  const waiting = snapshot?.restartPending && (
    snapshot?.restartWaiting === true
    || (snapshot?.restartWaiting == null && blockingCount > 0)
  );
  agentHub.setConnection(
    waiting ? "restart-waiting" : snapshot?.restartPending ? "restarting" : idleStatus,
    { blockingCount },
  );
}

function resetConnectionFailures() {
  connectionFailureCount = 0;
  connectionFailureSince = 0;
  if (connectionOfflineTimer != null) window.clearTimeout(connectionOfflineTimer);
  connectionOfflineTimer = null;
}

function recordTransientConnectionFailure() {
  const now = Date.now();
  if (!connectionFailureSince) connectionFailureSince = now;
  connectionFailureCount += 1;
  const markOffline = () => {
    connectionOfflineTimer = null;
    if (!connectionFailureSince) return;
    applySnapshotConnection(lastSnapshot, "offline");
  };
  if (connectionFailureCount >= CONNECTION_OFFLINE_FAILURES
    || now - connectionFailureSince >= CONNECTION_OFFLINE_GRACE_MS) {
    markOffline();
    return;
  }
  applySnapshotConnection(lastSnapshot, "connecting");
  if (connectionOfflineTimer == null) {
    connectionOfflineTimer = window.setTimeout(
      markOffline,
      CONNECTION_OFFLINE_GRACE_MS - (now - connectionFailureSince),
    );
  }
}

function historyMessages(history, focusedTurn = null) {
  const messages = [];
  const historyStart = Number.isSafeInteger(Number(history?.start))
    ? Number(history.start)
    : 0;
  for (const [itemIndex, item] of (history?.items ?? []).entries()) {
    const visible = historicalMessagesForDisplay(item);
    for (const [messageIndex, message] of visible.entries()) messages.push({
      id: `${history.provider}:${history.threadId}:${item.id}:${message.itemId}:${message.role}`,
      provider: history.provider,
      threadId: history.threadId,
      turnId: item.id,
      itemId: String(message.itemId ?? ""),
      clientUserMessageId: String(message.clientUserMessageId ?? ""),
      turnUserSlot: String(message.turnUserSlot ?? ""),
      role: message.role,
      ...(message.kind ? { kind: message.kind } : {}),
      ...(message.agentThreadId ? { agentThreadId: message.agentThreadId } : {}),
      ...(message.model ? { model: message.model } : {}),
      author: conversationMessageAuthor(message, history.provider),
      text: message.text,
      ...(message.role === "user" ? {
        responseAnnotations: message.responseAnnotations,
        responseAnnotationRequest: message.responseAnnotationRequest,
      } : {}),
      activities: [],
      activityGroups: [],
      time: message.time ?? (message.role === "user" ? item.startedAt : item.completedAt) ?? null,
      historyOrder: (historyStart + itemIndex) * 1_000 + messageIndex,
      attachments: attachmentViews(message.attachments),
    });
  }
  if (focusedTurn && Array.isArray(focusedTurn.messages)) {
    const focusedThreadId = focusedTurnTaskThreadId(focusedTurn);
    for (const [index, message] of focusedTurn.messages.entries()) {
      const itemId = String(message?.itemId ?? "").trim();
      if (!itemId || messages.some((candidate) => (
        candidate.turnId === focusedTurn.turnId && candidate.itemId === itemId
      ))) continue;
      messages.push({
        id: `${focusedTurn.provider}:${focusedThreadId}:${focusedTurn.turnId}:${itemId}:${message.role}`,
        provider: focusedTurn.provider,
        threadId: focusedThreadId,
        turnId: focusedTurn.turnId,
        itemId,
        role: message.role,
        ...(message.kind ? { kind: message.kind } : {}),
        ...(message.agentThreadId ? { agentThreadId: message.agentThreadId } : {}),
        ...(message.model ? { model: message.model } : {}),
        author: conversationMessageAuthor(message, focusedTurn.provider),
        text: message.text,
        time: message.time ?? null,
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
      author: focusedTurn.promptAuthor || "Вы",
      text: focusedTurn.prompt,
      responseAnnotations: focusedTurn.promptAnnotations,
      responseAnnotationRequest: focusedTurn.promptRequest,
      time: focusedTurn.startedAt,
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
      time: focusedTurn.completedAt,
    });
  }
  return messages;
}

function mergeNewestHistory(previous, newest) {
  const newestById = new Map(newest.map((message) => [message.id, message]));
  const previousIds = new Set(previous.map((message) => message.id));
  return deduplicateConversationMessages([
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
  return deduplicateConversationMessages([...uniqueOlder, ...previous]);
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
  historyPageByTask.set(id, {
    start: preserveOlder ? previousPage.start : history.start,
    end: history.end,
    total: history.total,
    nextBefore: preserveOlder ? previousPage.nextBefore : history.nextBefore,
    loading: false,
    version: history.version ?? "",
  });
  if (selectTask) rememberSelectedTaskId(id);
  if (!skipSnapshot) applySnapshot(result?.snapshot);
  if (selectTask) agentHub.selectTask(id);
  syncHistoryPagination(id);
  renderTaskMessages(id, { preserveScroll });
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
    if (isConnectionFailure(error)) recordTransientConnectionFailure();
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
    pendingSelectionId = id;
    rememberSelectedTaskId(id);
    replaceRoute(`#/chat/stream/${encodeURIComponent(id)}`);
    agentHub.selectTask(id);
    return null;
  }
  const sequence = ++selectionSequence;
  pendingSelectionId = id;
  rememberSelectedTaskId(id);
  selectionTail = selectionTail.catch(() => null).then(async () => {
    if (sequence !== selectionSequence) return null;
    const result = await runAction(() => control("open-task", { ...identity, limit: 20 }));
    if (sequence !== selectionSequence) return null;
    if (!result) {
      pendingSelectionId = "";
      return null;
    }
    applyOpened(result);
    pendingSelectionId = "";
    replaceRoute(`#/chat/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.threadId)}`);
    return result;
  });
  return selectionTail;
});

async function settleOpenedTaskHistory(id, identity) {
  const settled = await settleOptionalRead(() => control("task-history", {
    ...identity,
    limit: 20,
    includeActive: false,
    refreshSource: true,
    knownVersion: historyPageByTask.get(id)?.version ?? "",
  }));
  if (settled.status === "rejected") return;
  const history = settled.value;
  if (selectedTaskId !== id || history?.notModified === true) return;
  applyOpened({ history }, {
    preserveScroll: true,
    skipSnapshot: true,
    selectTask: false,
  });
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
    if (id === selectedTaskId || historyPageByTask.has(id) || visibleHistoryLoads.has(id)) return;
    const identity = taskIdentity(id);
    if (!identity) return;
    visibleHistoryLoads.add(id);
    const settled = await settleOptionalRead(() => control("task-history", {
      ...identity,
      limit: 20,
      includeActive: false,
    }));
    try {
      if (settled.status === "rejected") return;
      const history = settled.value;
      applyOpened({ history }, { skipSnapshot: true, selectTask: false });
    } finally {
      visibleHistoryLoads.delete(id);
    }
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
  page.loading = true;
  syncHistoryPagination(id);
  try {
    const history = await control("task-history", {
      ...identity,
      before: requestedBefore,
      limit: 20,
    });
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
  const sendTransaction = window.AgentHubMessageSendTransaction;
  const optimisticId = `local:${request.requestId}`;
  let identity = taskIdentity(request.taskId);
  const previousAttempt = outgoingMessages(request.taskId).get(request.requestId);
  const requestAttachments = request.attachments ?? [];
  const visibleText = String(request.text ?? "").trim()
    || ((request.annotations ?? []).length
      ? `Аннотации к ответу: ${(request.annotations ?? []).length}`
      : window.AgentHubMessageLifecycle.attachmentOnlyText(requestAttachments));
  const optimistic = {
    id: optimisticId,
    provider: identity?.provider ?? request.settings?.provider ?? "",
    threadId: identity?.threadId ?? "",
    turnId: "",
    itemId: request.requestId,
    clientUserMessageId: request.requestId,
    role: "user",
    author: "Вы",
    text: visibleText,
    responseAnnotations: normalizedResponseAnnotations(request.annotations),
    responseAnnotationRequest: String(request.text ?? "").trim(),
    time: new Date().toISOString(),
    attachments: requestAttachments,
    uploadedPaths: previousAttempt?.uploadedPaths ?? [],
    ...deliveryPatch("preparing"),
  };
  rememberOutgoing(request.taskId, optimistic);
  const queuesOptimistically = request.followUpMode === "queue"
    || request.deferWhileRunning === true;
  if (queuesOptimistically) {
    optimisticDeferredClientUserMessageIds.add(request.requestId);
    deferredClientUserMessageIds.add(request.requestId);
  }
  renderOutgoingWithoutBlockingSend(request.taskId, { queue: queuesOptimistically });
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
        if (identity.threadId) {
          replaceRoute(`#/chat/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.threadId)}`);
        }
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
        renderOutgoingWithoutBlockingSend(request.taskId);
      }
      updateOutgoing(request.taskId, request.requestId, deliveryPatch("sending"));
      renderOutgoingWithoutBlockingSend(request.taskId);
      const params = {
        text: annotatedText(request.text, request.annotations),
        displayText: visibleText,
        responseAnnotations: normalizedResponseAnnotations(request.annotations),
        responseAnnotationRequest: String(request.text ?? "").trim(),
        streamId: identity?.streamId ?? request.streamId,
        provider: identity?.provider,
        threadId: identity?.threadId,
        clientUserMessageId: request.requestId,
        followUpMode: request.followUpMode,
      };
      if (paths.length) params.attachments = paths;
      return control("send-message", params);
    },
    receive: (result) => {
      const accepted = Boolean(result?.accepted || result?.deferred);
      if (result?.deferred) {
        optimisticDeferredClientUserMessageIds.add(request.requestId);
        deferredClientUserMessageIds.add(request.requestId);
      } else {
        optimisticDeferredClientUserMessageIds.delete(request.requestId);
        deferredClientUserMessageIds.delete(request.requestId);
      }
      agentHub.completeSend(request.requestId, { accepted });
      if (result?.duplicate) {
        optimisticDeferredClientUserMessageIds.delete(request.requestId);
        deferredClientUserMessageIds.delete(request.requestId);
        outgoingMessages(request.taskId).delete(request.requestId);
        return;
      }
      updateOutgoing(request.taskId, request.requestId, {
        provider: identity?.provider ?? "",
        threadId: result?.threadId ?? identity?.threadId ?? "",
        turnId: result?.turnId ?? "",
        itemId: result?.itemId ?? request.requestId,
        ...nonEmptyAttachmentPatch(result?.attachments),
        ...(result?.accepted && !result?.steered ? { turnUserSlot: "root" } : {}),
        ...(result?.accepted
          ? deliveryPatch("accepted")
          : result?.deferred
            ? deliveryPatch(result?.queued ? "queued" : "accepted")
            : deliveryPatch("rejected")),
      });
    },
    synchronize: (result) => {
      applySnapshot(result?.snapshot);
      if (!identity?.threadId && result?.threadId) {
        identity = { ...identity, threadId: result.threadId };
        replaceRoute(`#/chat/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.threadId)}`);
      }
      renderTaskMessages(request.taskId);
      if (queuesOptimistically) {
        deferredClientUserMessageIds = new Set([
          ...deferredClientUserMessageIds,
          ...(result?.deferred ? [request.requestId] : []),
        ]);
        if (!result?.deferred) deferredClientUserMessageIds.delete(request.requestId);
        renderTaskQueue(request.taskId, result?.snapshot ?? lastSnapshot);
        renderTaskMessages(request.taskId);
      }
      agentHub.toast(result?.message ?? (result?.accepted ? "Сообщение принято" : "Сообщение сохранено"));
    },
    reject: (error) => {
      // A remote command may finish after its HTTP result is lost. Preserve
      // its request id for an idempotent retry instead of creating a second
      // optimistic card for the same user action.
      const rejected = messageSendDefinitelyRejected(error);
      optimisticDeferredClientUserMessageIds.delete(request.requestId);
      deferredClientUserMessageIds.delete(request.requestId);
      agentHub.completeSend(request.requestId, { accepted: false });
      updateOutgoing(
        request.taskId,
        request.requestId,
        deliveryPatch(rejected ? "rejected" : "unconfirmed"),
      );
      renderOutgoingWithoutBlockingSend(request.taskId, { queue: queuesOptimistically });
    },
    synchronizationFailed: (error) => {
      console.error("Agent Hub accepted a message but could not refresh its card", error);
      agentHub.toast("Сообщение принято. Отображение обновится по квитанции.");
    },
  }));
});

agentHub.on("task:new", ({ title, provider }) => runAction(async () => {
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
  if (identity) replaceRoute(`#/chat/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.threadId)}`);
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
agentHub.on("workspace:create", ({ name, comment, workingDirectory, rules, beforeColumnId }) => runAction(async () => {
  let snapshot = await control("create-workspace", {
    name,
    comment,
    settings: { workingDirectory: String(workingDirectory ?? "").trim() },
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
  workspaceId, name, comment, workingDirectory, rules, beforeColumnId,
}) => runAction(async () => {
  if (!lastSnapshot?.boardLayout) {
    agentHub.toast("Agent Hub завершает обновление runtime. Повторите действие через минуту.");
    return;
  }
  const workspace = (lastSnapshot.workspaces ?? []).find((item) => item.id === workspaceId);
  let snapshot = lastSnapshot;
  if (workspace?.kind !== "system" && name !== workspace?.name) {
    snapshot = await control("rename-workspace", { workspaceId, name });
  }
  if (comment !== String(workspace?.comment ?? "")) {
    snapshot = await control("board-column-comment", { columnId: `workspace:${workspaceId}`, comment });
  }
  const nextSettings = {
    ...(workspace?.settings ?? {}),
    workingDirectory: String(workingDirectory ?? "").trim(),
  };
  if (nextSettings.workingDirectory !== String(workspace?.settings?.workingDirectory ?? "")) {
    snapshot = await control("update-workspace-settings", { workspaceId, settings: nextSettings });
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
async function loadWorkspaceReleaseRegistry(workspaceId) {
  const registry = await control("read-workspace-release-registry", { workspaceId, limit: 50 });
  agentHub.setWorkspaceReleaseRegistry(workspaceId, registry);
}
agentHub.on("workspace-release:open", ({ workspaceId }) => runAction(
  () => loadWorkspaceReleaseRegistry(workspaceId),
));
agentHub.on("workspace-release:status", ({ workspaceId, changeId, status }) => runAction(async () => {
  const registry = await control("update-release-change-status", { changeId, status });
  agentHub.setWorkspaceReleaseRegistry(workspaceId, registry);
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
      move: "board-task-move",
      complete: "board-task-complete",
      remove: "board-task-remove",
      "retry-triage": "board-task-retry-triage",
      start: "board-task-start",
      "move-column": "board-column-move",
      "update-comment": "board-column-comment",
    };
    const action = actions[detail.type];
    if (!action) return;
    const { type: _type, ...params } = detail;
    const result = await control(action, params);
    succeeded = true;
    applySnapshot(result);
    if (detail.type === "start") agentHub.showSelectedTask();
    if (detail.type === "update") agentHub.toast("Изменения сохранены");
    if (detail.type === "remove") agentHub.toast("Задача удалена");
  }).finally(() => {
    window.AgentHubTaskBoard?.finishAction?.({
      type: detail.type,
      id: detail.id,
      succeeded,
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
  const identity = exactTaskParams(targetTaskId || selectedTaskId);
  const snapshot = await control("rotate-stream", {
    ...identity,
    provider: ["codex", "claude"].includes(provider) ? provider : identity.provider,
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
agentHub.on("usage:open", ({ range, turnTimeMode }) => runAction(async () => {
  try {
    agentHub.setUsageHistory(await readHistoryWithRangeCompatibility("usage-history", range, {
      maxPoints: 600,
      turnTimeMode,
    }));
  } catch (error) {
    agentHub.setUsageHistory({
      range,
      error: error?.message || "Не удалось загрузить локальный расход.",
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
  const activeIntervals = allAccounts
    ? null
    : (Array.isArray(limits?.accountActivity) ? limits.accountActivity : [])
      .find((entry) => String(entry?.accountKey ?? "") === resolvedAccountKey)?.intervals ?? [];
  let usage;
  try {
    usage = await readHistoryWithRangeCompatibility("usage-history", requestedRange, {
      maxPoints: 600,
      provider,
      turnTimeMode,
      ...(activeIntervals ? { activeIntervals } : {}),
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
agentHub.on("selection:set", ({ key, value }) => runAction(async () => {
  const names = {
    model: "model",
    reasoning: "reasoning",
    mode: "mode",
    project: "project",
    autoApprove: "approvalMode",
    includeClaudeUsage: "includeClaudeUsage",
    activityRecentMinutes: "activityRecentMinutes",
  };
  const name = names[key];
  if (!name) return;
  const taskIdentity = ["provider", "project", "model", "reasoning", "mode"].includes(name)
    ? exactSelectedTaskParams()
    : {};
  applySnapshot(await control("update-setting", {
    ...taskIdentity,
    name,
    value: key === "autoApprove" ? (value ? "auto" : "manual") : value,
  }));
  if (key === "includeClaudeUsage") {
    requestUsageHistory(usageState.range, { force: true });
    void loadJournal({ force: true });
  }
}));
agentHub.on("approval:respond", ({ id, decision, answers }) => runAction(
  () => control("resolve-approval", { key: id, decision, ...(answers ? { answers } : {}) }),
));
agentHub.on("queue:remove", ({ id }) => runAction(async () => {
  const deferred = (lastSnapshot?.deferredInputs ?? []).find((item) => item.id === id);
  const result = await control("deferred-input", { id, action: "cancel" });
  const clientUserMessageId = String(deferred?.clientUserMessageId ?? "");
  if (clientUserMessageId) {
    const deferredTaskId = taskId(deferred.provider, deferred.threadId);
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
    queueActionsInFlight.delete(key);
    applySnapshot(await control("snapshot"));
  }
}

agentHub.on("queue:accept", ({ id, taskId: taskIdValue }) => runAction(() => runQueueAction(id, taskIdValue, async () => {
  const result = await control("deferred-input", { id, action: "queue" });
  agentHub.toast(result?.message ?? "Сообщение будет отправлено после текущего хода");
})));
agentHub.on("queue:steer", ({ id, taskId: taskIdValue }) => runAction(() => runQueueAction(id, taskIdValue, async () => {
  const deferred = (lastSnapshot?.deferredInputs ?? []).find((item) => item.id === id);
  const result = await control("deferred-input", { id, action: "steer" });
  const clientUserMessageId = String(deferred?.clientUserMessageId ?? "").trim();
  if (clientUserMessageId) {
    const deferredTaskId = taskId(deferred.provider, deferred.threadId);
    optimisticDeferredClientUserMessageIds.delete(clientUserMessageId);
    deferredClientUserMessageIds.delete(clientUserMessageId);
    patchOutgoing(deferredTaskId, clientUserMessageId, {
      turnId: String(result?.turnId ?? ""),
      itemId: clientUserMessageId,
      turnUserSlot: "steer",
      ...deliveryPatch("accepted"),
    });
  }
  agentHub.toast(result?.message ?? "Сообщение добавлено в текущий ход");
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
  const result = directDataUrl
    ? { dataUrl: directDataUrl, name: attachment?.name }
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
  if (!target || !localWorkspaceFilesAvailable) {
    throw new Error("Показ файла в проводнике недоступен в этой поверхности");
  }
  if (vscode) await bridgeCall("reveal-link", { href: target });
  else {
    const response = await hubFetch("/api/workspace-file/reveal", {
      method: "POST",
      headers: { ...authorizationHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ path: target }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      throw new Error(String(payload.error ?? `Не удалось показать файл: HTTP ${response.status}`));
    }
  }
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

agentHub.on("clipboard:write", ({ text }) => runAction(async () => {
  const value = String(text ?? "");
  if (vscode) await bridgeCall("copy-text", { text: value });
  else await navigator.clipboard.writeText(value);
  agentHub.toast("Скопировано в буфер обмена");
}));

agentHub.on("resource:copy-object", ({ resource }) => runAction(async () => {
  const localPath = String(resource?.localPath ?? "").trim();
  if (!localPath || !localWorkspaceFilesAvailable) {
    throw new Error("Копирование файлового объекта недоступно в этой поверхности");
  }
  if (vscode) await bridgeCall("copy-link-object", { href: localPath });
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
  agentHub.toast("Файл скопирован в буфер обмена");
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
  void runAction(() => control("workspace-message-search", {
    workspaceId,
    query,
    offset,
    limit,
  })).then((result) => {
    if (sequence !== workspaceMessageSearchSequence) return;
    if (!result) {
      agentHub.setWorkspaceMessageSearchError("Не удалось выполнить поиск");
      return;
    }
    agentHub.setWorkspaceMessageSearchResults(result, { append: Boolean(append) });
  });
});
agentHub.on("workspace-search:open", (result) => runAction(async () => {
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
  applyOpened(await control("workspace-message-open", params));
  agentHub.closeWorkspaceMessageSearch({ restoreFocus: false });
  document.querySelector("[data-view-button='chat']")?.click();
  replaceRoute("#/chat/"
    + `${encodeURIComponent(params.provider)}/${encodeURIComponent(params.taskThreadId)}`
    + `/turn/${encodeURIComponent(params.turnThreadId)}/${encodeURIComponent(params.turnId)}`);
}));
agentHub.on("context:compact", () => runAction(async () => {
  const result = await control("compact-context", exactSelectedTaskParams());
  if (result?.accepted && result.compactionId) {
    requestedContextCompactions.add(String(result.compactionId));
  }
  agentHub.toast(result?.message ?? "Свёртка контекста запущена");
  applySnapshot(await control("snapshot"));
}));
agentHub.on("turn:open", (params) => runAction(async () => {
  applyOpened(await control("open-turn", { ...params, limit: 20 }));
  document.querySelector("[data-view-button='chat']")?.click();
  replaceRoute("#/chat/"
    + `${encodeURIComponent(params.provider)}/${encodeURIComponent(params.taskThreadId)}`
    + `/turn/${encodeURIComponent(params.turnThreadId)}/${encodeURIComponent(params.turnId)}`);
}));

document.addEventListener("click", (event) => {
  const openTask = event.target.closest("[data-open-task]");
  if (openTask) {
    event.preventDefault();
    event.stopPropagation();
    const provider = openTask.dataset.provider
      ?? openTask.closest("[data-work-log-provider]")?.dataset.workLogProvider;
    const threadId = openTask.dataset.threadId
      ?? openTask.closest("[data-work-log-thread-id]")?.dataset.workLogThreadId;
    void runAction(async () => {
      applyOpened(await control("open-task", { provider, threadId, limit: 20 }));
      document.querySelector("[data-view-button='chat']")?.click();
      replaceRoute(`#/chat/${encodeURIComponent(provider)}/${encodeURIComponent(threadId)}`);
    });
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
  void runAction(async () => {
    applyOpened(await control("open-turn", params));
    document.querySelector("[data-view-button='chat']")?.click();
    replaceRoute("#/chat/"
      + `${encodeURIComponent(params.provider)}/${encodeURIComponent(params.taskThreadId)}`
      + `/turn/${encodeURIComponent(params.turnThreadId)}/${encodeURIComponent(params.turnId)}`);
  });
});

async function openRoute() {
  const parts = location.hash.split("/").slice(1).map(decodeURIComponent);
  if (parts[0] !== "chat" || !parts[1] || !parts[2]) return false;
  if (parts[1] === "stream") {
    const streamId = parts[2];
    if (!emptyStreamModels(lastSnapshot ?? {}, streamId).some((task) => task.id === streamId)) return false;
    pendingSelectionId = streamId;
    rememberSelectedTaskId(streamId);
    applySnapshot(lastSnapshot);
    pendingSelectionId = "";
    agentHub.selectTask(streamId);
    return true;
  }
  if (parts[3] === "turn" && parts[4] && parts[5]) {
    applyOpened(await control("open-turn", {
      provider: parts[1],
      taskThreadId: parts[2],
      turnThreadId: parts[4],
      turnId: parts[5],
      limit: 20,
    }));
  } else {
    applyOpened(await control("open-task", {
      provider: parts[1],
      threadId: parts[2],
      limit: 20,
    }));
  }
  rememberSelectedTaskId(taskId(parts[1], parts[2]));
  return true;
}

function snapshotTask(snapshot, id) {
  return (snapshot?.tasks ?? []).find((task) => (
    taskId(task.provider, task.threadId, task.streamId) === id
  )) ?? null;
}

function directChatRoute() {
  const parts = location.hash.split("/").slice(1).map(decodeURIComponent);
  return parts[0] === "chat" && Boolean(parts[1]) && Boolean(parts[2]) && parts[1] !== "stream";
}

async function refreshVisibleTaskHistories(previousSnapshot, snapshot) {
  const visibleIds = new Set(visibleStreamTaskIds);
  if (selectedTaskId) visibleIds.add(selectedTaskId);
  await Promise.all([...visibleIds].map(async (id) => {
    if (visibleHistoryLoads.has(id)) return;
    const previousTask = snapshotTask(previousSnapshot, id);
    const currentTask = snapshotTask(snapshot, id);
    if (!currentTask) return;
    const sameTask = previousTask
      && previousTask.provider === currentTask.provider
      && previousTask.threadId === currentTask.threadId;
    const answerChanged = sameTask
      && String(previousTask.lastAnswerAt ?? "") !== String(currentTask.lastAnswerAt ?? "");
    const turnCompleted = Boolean(sameTask && previousTask.running && !currentTask.running);
    if (answerChanged || turnCompleted) scheduleHistoryAttachmentSettle(id);
    const historyMissing = Boolean(previousTask) && !historyPageByTask.has(id);
    const externalLive = currentTask.running && !["hub", "telegram"].includes(String(
      currentTask.run?.executionOwner ?? currentTask.executionOwner ?? "",
    ));
    const lastRefreshAt = Number(historyRefreshAtByTask.get(id)) || 0;
    const refreshExternalHistory = externalLive
      && Date.now() - lastRefreshAt >= EXTERNAL_HISTORY_REFRESH_MS;
    const refreshCaughtUpHistory = historyNeedsCatchUp(id)
      && Date.now() - lastRefreshAt >= EXTERNAL_HISTORY_REFRESH_MS;
    const refreshSettlingAttachments = historyAttachmentsNeedSettling(id)
      && Date.now() - lastRefreshAt >= HISTORY_ATTACHMENT_REFRESH_MS;
    if (!historyMissing && !turnCompleted && !answerChanged
      && !refreshExternalHistory && !refreshCaughtUpHistory && !refreshSettlingAttachments) return;
    historyRefreshAtByTask.set(id, Date.now());
    visibleHistoryLoads.add(id);
    try {
      const settled = await settleOptionalRead(() => control("task-history", {
        provider: currentTask.provider,
        threadId: currentTask.threadId,
        limit: 20,
        includeActive: false,
        refreshSource: turnCompleted || answerChanged,
        knownVersion: historyPageByTask.get(id)?.version ?? "",
      }));
      if (settled.status === "rejected") return;
      const history = settled.value;
      applyOpened({ snapshot: lastSnapshot, history }, {
        preserveScroll: true,
        skipSnapshot: true,
        selectTask: false,
      });
    } finally {
      visibleHistoryLoads.delete(id);
    }
  }));
}

async function refresh({ reportError = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    const previousSnapshot = lastSnapshot;
    const snapshotResult = await control("snapshot", { knownVersion: lastSnapshot?.version ?? "" });
    const snapshot = snapshotResult?.notModified === true ? lastSnapshot : snapshotResult;
    if (snapshotResult?.notModified === true) {
      resetConnectionFailures();
      applySnapshotConnection(snapshot);
    } else {
      applySnapshot(snapshot);
    }
    if (!snapshot) return;
    void refreshVisibleTaskHistories(previousSnapshot, snapshot).catch((error) => {
      console.error("Agent Hub visible history refresh failed", error);
    });
    applySnapshotConnection(snapshot);
  } catch (error) {
    recordTransientConnectionFailure();
    if (reportError) throw error;
  } finally {
    refreshing = false;
    const active = Boolean(lastSnapshot?.tasks?.some(
      (task) => task.running || task.context?.compacting || task.maintenance,
    )) || [...visibleStreamTaskIds].some(historyNeedsCatchUp) || historyNeedsCatchUp(selectedTaskId);
    refreshTimer = window.setTimeout(refresh, active ? 1_200 : 5_000);
  }
}

void runAction(async () => {
  agentHub.setConnection("connecting");
  try {
    let routed = false;
    if (directChatRoute()) {
      routed = await openRoute();
    } else {
      await refresh({ reportError: true });
      routed = await openRoute();
    }
    const identity = !routed ? taskIdentity(selectedTaskId) : null;
    if (identity) {
      applyOpened(await control("open-task", { ...identity, limit: 20 }));
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
