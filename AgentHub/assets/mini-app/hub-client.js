"use strict";

(() => {

const agentHub = window.AgentHub;
const telegramInitData = String(window.Telegram?.WebApp?.initData ?? "");
const localSessionReady = window.AgentHubLocalSessionReady ?? Promise.resolve();
const vscode = window.__agentHubVscode ?? (typeof window.acquireVsCodeApi === "function"
  ? window.acquireVsCodeApi()
  : null);
const pendingBridgeCalls = new Map();
const selectedTaskKey = "agent-hub:selected-task:v1";
const serverIdentityKey = "agent-hub:server-identity:v1";
let bridgeSequence = 0;
let lastSnapshot = null;
let observedServerIdentity = readStoredServerIdentity();
let runtimeReloadPending = false;
let runtimeReloadNoticeShown = false;
let selectedTaskId = readSelectedTaskId();
let refreshTimer = null;
let rateLimitRefreshTimer = null;
let rateLimitRefreshRange = "24h";
let rateLimitRefreshInFlight = false;
let refreshing = false;
let connectionFailureCount = 0;
let connectionFailureSince = 0;
let connectionOfflineTimer = null;
let pendingSelectionId = "";
let selectionSequence = 0;
let selectionTail = Promise.resolve();
let selectedHistoryRefreshAt = 0;
const EXTERNAL_HISTORY_REFRESH_MS = 2_500;
const REMOTE_RESULT_LONG_POLL_MS = 25_000;
const REMOTE_RESULT_FALLBACK_POLL_MS = 600;
const HISTORY_CATCH_UP_TIMEOUT_MS = 120_000;
const CONNECTION_OFFLINE_FAILURES = 3;
const CONNECTION_OFFLINE_GRACE_MS = 6_000;
const historyByTask = new Map();
const historyPageByTask = new Map();
const historyCatchUpDeadlines = new Map();
const outgoingByTask = new Map();
const liveProbeByTask = new Map();
const liveUserMessagesByTask = new Map();
const liveCardsByTask = new Map();
const completionOverlaysByTask = new Map();
const queueActionsInFlight = new Set();
const requestedContextCompactions = new Set();
const observedContextCompactions = new Map();
let deferredClientUserMessageIds = new Set();
const MAX_OUTGOING_MESSAGES_PER_TASK = 100;
const {
  activeStageLabel,
  chronologicalMessages,
  completedConversationTurnVisible,
  confirmedOutgoingMessageIds,
  deduplicateConversationMessages,
  focusedTurnAlreadyVisible,
  focusedTurnTaskThreadId,
  historyContainsLatestAnswer,
  historicalAgentResponseVisible,
  hubErrorMessage,
  isConnectionFailure,
  looksLikeConnectionFailure,
  markConnectionFailure,
  mergeReconciledUserMessage,
  mergeLiveUserMessages,
  normalizedResponseAnnotations,
  normalizedUserMessage,
  responseAnnotationPrompt,
  reconcile: reconcileMessageLifecycle,
  rememberBounded: rememberBoundedMessage,
  reusableAttachmentPaths,
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

function taskId(provider, threadId) {
  return `${String(provider)}:${String(threadId)}`;
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

function reloadForPublishedRuntime() {
  if (!runtimeReloadPending) return false;
  if (agentHub.prepareForRuntimeReload?.() === false) {
    if (!runtimeReloadNoticeShown) {
      agentHub.toast("Обновление интерфейса отложено до отправки или удаления вложений");
      runtimeReloadNoticeShown = true;
    }
    return false;
  }
  runtimeReloadPending = false;
  runtimeReloadNoticeShown = false;
  if (vscode) vscode.postMessage({ type: "agenthub:runtime-changed" });
  else window.location.reload();
  return true;
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
  if (instanceChanged || releaseChanged) {
    rememberServerIdentity(identity);
    if (instanceChanged) notifyAndroidAboutRelease(identity);
    if (releaseChanged) runtimeReloadPending = true;
  }
  return reloadForPublishedRuntime();
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

function taskIdentity(id) {
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
    unconfirmed: { deliveryState: "unconfirmed", delivery: "Приём не подтверждён", failed: true },
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

function patchOutgoing(taskIdValue, clientUserMessageId, patch) {
  const message = outgoingMessages(taskIdValue).get(clientUserMessageId);
  if (!message) return;
  Object.assign(message, patch);
  renderTaskMessages(taskIdValue);
}

function liveUserMessagesSignature(run) {
  const messages = Array.isArray(run?.userMessages) ? run.userMessages : [];
  return JSON.stringify([
    String(run?.turnId ?? ""),
    String(run?.clientUserMessageId ?? ""),
    String(run?.prompt ?? "").length,
    String(run?.startedAt ?? ""),
    JSON.stringify(run?.attachments ?? []),
    ...messages.map((message) => [
      String(message?.itemId ?? ""),
      String(message?.clientUserMessageId ?? ""),
      String(message?.text ?? "").length,
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
  const serverMessages = deduplicateConversationMessages(mergeLiveUserMessages(
    [...durableMessages, ...overlayMessages],
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
    patchOutgoing(taskId(provider, threadId), clientUserMessageId, {
      provider,
      threadId,
      turnId: String(receipt.turnId ?? ""),
      itemId: receipt.id ?? clientUserMessageId,
      time: receipt.createdAt ?? null,
      attachments: attachmentViews(receipt.attachments),
      ...(receipt.accepted && !receipt.steered ? { turnUserSlot: "root" } : {}),
      ...patch,
    });
  }
}

function messageSendDefinitelyRejected(error) {
  return /^(?:Введите сообщение|Сообщение слишком длинное|Сначала выберите|Неизвестный режим|Идентификатор сообщения)/iu
    .test(String(error?.message ?? error ?? "").trim());
}

function promoteLiveCompletion(taskIdValue, selected, incomingTurnId = "") {
  const previous = liveCardsByTask.get(taskIdValue);
  const previousTurnId = String(previous?.turnId ?? "").trim();
  if (!previousTurnId || previousTurnId === String(incomingTurnId ?? "").trim()) return false;
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

function syncHistoryPagination(taskIdValue) {
  const page = historyPageByTask.get(taskIdValue);
  agentHub.setHistoryPagination(taskIdValue, {
    hasOlder: page?.nextBefore != null,
    loading: page?.loading === true,
  });
}

function updateLiveMessage(taskIdValue, selected) {
  const run = selected?.run;
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
  const liveCard = {
    author: selected.provider === "claude" ? "Claude" : "Codex",
    stage: activeStageLabel(run.stage),
    reasoning: run.progress || "",
    text: response,
    activities: run.activities ?? [],
    threadId: selected.threadId,
    turnId: run.turnId,
    itemId: run.responseItemId ?? null,
    provider: selected.provider,
    time: run.lastActivityAt ?? run.startedAt ?? null,
  };
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

function bridgeCall(action, params = {}) {
  if (!vscode) return null;
  const id = `bridge-${Date.now()}-${++bridgeSequence}`;
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingBridgeCalls.delete(id);
      reject(markConnectionFailure(new Error("Agent Hub в VS Code не ответил вовремя")));
    }, 30_000);
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
  if (message?.type !== "agenthub:control-result") return;
  const pending = pendingBridgeCalls.get(String(message.id ?? ""));
  if (!pending) return;
  pendingBridgeCalls.delete(String(message.id));
  window.clearTimeout(pending.timer);
  if (message.ok) pending.resolve(message.result);
  else {
    const error = new Error(String(message.error ?? "Команда Agent Hub завершилась с ошибкой"));
    pending.reject(looksLikeConnectionFailure(error) ? markConnectionFailure(error) : error);
  }
});

async function waitRemoteResult(commandId) {
  await localSessionReady;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await hubFetch(
      `/api/control/result?id=${encodeURIComponent(commandId)}&waitMs=${REMOTE_RESULT_LONG_POLL_MS}`,
      {
        headers: authorizationHeaders(),
        cache: "no-store",
      },
    );
    const payload = await response.json().catch(() => ({}));
    if (response.status === 202 || payload.pending) {
      if (payload.longPoll !== true) {
        await new Promise((resolve) => window.setTimeout(resolve, REMOTE_RESULT_FALLBACK_POLL_MS));
      }
      continue;
    }
    if (!response.ok || payload.ok === false) {
      throw new Error(String(payload.error ?? `Agent Hub: HTTP ${response.status}`));
    }
    return payload.result;
  }
  throw markConnectionFailure(
    new Error("Локальный Agent Hub не ответил. Команда сохранена в Mini App."),
  );
}

async function control(action, params = {}) {
  const bridged = bridgeCall(action, params);
  if (bridged) return bridged;
  await localSessionReady;
  const response = await hubFetch("/api/control", {
    method: "POST",
    headers: {
      ...authorizationHeaders(),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ action, params, commandId: crypto.randomUUID() }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.ok === false) {
    throw new Error(String(payload.error ?? `Agent Hub: HTTP ${response.status}`));
  }
  return payload.pending && payload.id
    ? waitRemoteResult(payload.id)
    : payload.result;
}

function modelTask(task, snapshot, effectiveSelectedId, serverSelectedId) {
  const id = taskId(task.provider, task.threadId);
  const answerAt = Date.parse(task.lastAnswerAt ?? "") || 0;
  const running = Boolean(task.running);
  const unknown = task.activityUnknown === true;
  const unread = task.unread === true;
  const serverSelected = id === serverSelectedId;
  const executionOwner = task.run?.executionOwner ?? task.executionOwner ?? "";
  const runtimeTitle = task.run?.runtime ?? task.runtime ?? "";
  return {
    id,
    title: task.title || "Без названия",
    provider: task.provider,
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
    context: task.run?.context ?? task.context ?? null,
  };
}

function compactionContextLabel(context) {
  if (context?.usagePending) return "объём обновляется";
  return `контекст ${Math.round(Math.max(0, Math.min(100, Number(context?.percent) || 0)))}%`;
}

function compactionTaskTitle(task) {
  return String(task?.title ?? "").trim() || "Без названия";
}

function observeContextCompactions(tasks) {
  for (const task of tasks ?? []) {
    const context = task.context;
    const compaction = context?.compaction;
    const compactionId = String(compaction?.id ?? "");
    if (!compactionId) continue;
    const previousStatus = observedContextCompactions.get(compactionId);
    const status = String(compaction.status ?? "");
    const requested = requestedContextCompactions.has(compactionId);
    const eventAtMs = Date.parse(String(compaction.completedAt ?? compaction.startedAt ?? "")) || 0;
    const recent = eventAtMs > 0 && Date.now() - eventAtMs < 90_000;
    if (status === "running"
      && previousStatus !== "running"
      && compaction.origin === "automatic"
      && recent) {
      agentHub.toast(`Началась автосвёртка контекста · ${compactionTaskTitle(task)}`);
    } else if (status === "completed" && previousStatus !== "completed") {
      if (requested || (compaction.origin === "automatic" && recent)) {
        const completionLabel = compaction.origin === "automatic"
          ? "Автосвёртка контекста завершена"
          : "Свёртка контекста завершена";
        agentHub.toast(`${completionLabel} · ${compactionTaskTitle(task)} · ${compactionContextLabel(context)}`);
      }
      requestedContextCompactions.delete(compactionId);
    } else if (status === "timeout" && previousStatus !== "timeout") {
      if (requested || (compaction.origin === "automatic" && recent)) {
        agentHub.toast(`Не удалось подтвердить завершение свёртки контекста · ${compactionTaskTitle(task)}`);
      }
      requestedContextCompactions.delete(compactionId);
    }
    observedContextCompactions.delete(compactionId);
    observedContextCompactions.set(compactionId, status);
    while (observedContextCompactions.size > 100) {
      observedContextCompactions.delete(observedContextCompactions.keys().next().value);
    }
  }
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  if (observeServerIdentity(snapshot)) return;
  resetConnectionFailures();
  lastSnapshot = snapshot;
  agentHub.setExchangeRates(snapshot.exchangeRates ?? null);
  agentHub.setServerStatus(snapshot.server ?? null);
  observeContextCompactions(snapshot.tasks);
  applyMessageReceipts(snapshot);
  deferredClientUserMessageIds = new Set(
    (snapshot.deferredInputs ?? [])
      .filter((item) => item.state !== "dispatching")
      .map((item) => String(item.clientUserMessageId ?? "").trim())
      .filter(Boolean),
  );
  const serverSelected = (snapshot.tasks ?? []).find((task) => task.selected);
  const serverSelectedId = serverSelected
    ? taskId(serverSelected.provider, serverSelected.threadId)
    : "";
  const availableTaskIds = new Set(
    (snapshot.tasks ?? []).map((task) => taskId(task.provider, task.threadId)),
  );
  const pendingExists = pendingSelectionId && availableTaskIds.has(pendingSelectionId);
  const localExists = selectedTaskId && availableTaskIds.has(selectedTaskId);
  const effectiveSelectedId = pendingExists
    ? pendingSelectionId
    : localExists
      ? selectedTaskId
      : serverSelectedId;
  const tasks = (snapshot.tasks ?? [])
    .map((task) => modelTask(task, snapshot, effectiveSelectedId, serverSelectedId))
    .sort((left, right) => Date.parse(right.lastActivity || 0) - Date.parse(left.lastActivity || 0));
  agentHub.setTasks(tasks);
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
        attachments: attachmentViews(deferred.attachments),
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
      attachments: attachmentViews(task.run?.attachments),
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
  if (selected) {
    agentHub.setLive(selectedTaskId, updateLiveMessage(selectedTaskId, selected));
    agentHub.setRunning(selectedTaskId, Boolean(selected.run || selected.running));
    agentHub.setApprovals(selectedTaskId, effectiveSelectedId === serverSelectedId
      ? (snapshot.pendingApprovals ?? []).map((approval) => ({
      id: approval.key ?? approval.id,
      kind: approval.kind ?? "Подтверждение",
      text: approval.text ?? approval.preview ?? approval.reason ?? "",
      options: [
        { id: "accept", label: "Разрешить", kind: "primary" },
        { id: "decline", label: "Отклонить", kind: "danger" },
      ],
      }))
      : []);
    agentHub.setQueue(selectedTaskId, (snapshot.deferredInputs ?? []).filter((item) =>
      item.state !== "dispatching" && item.state !== "steering"
      &&
      (!item.provider || item.provider === selected.provider)
      && (!item.threadId || item.threadId === selected.threadId))
      .map((item) => ({ ...item, attachments: attachmentViews(item.attachments) })));
  }
  const settings = snapshot.settings ?? {};
  agentHub.setOptions({
    model: settings.models ?? [],
    reasoning: settings.reasoningOptions ?? [],
    mode: settings.modeOptions ?? [],
    project: (settings.projects ?? []).map((project) => ({
      value: project.path,
      label: project.name,
    })),
  });
  agentHub.setSelection({
    model: settings.model,
    reasoning: settings.reasoning,
    mode: settings.mode,
    project: (settings.projects ?? []).find((project) => project.selected)?.path ?? "",
    autoApprove: settings.approvalMode === "auto",
    includeClaudeUsage: settings.includeClaudeUsage !== false,
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
    const itemMessages = Array.isArray(item.messages) ? item.messages : [];
    const userMessages = itemMessages.filter((message) => message.role === "user");
    const agentMessages = itemMessages.filter((message) => message.role === "agent");
    const visibleAgent = historicalAgentResponseVisible(item)
      ? agentMessages.findLast((message) => ["final", "final_answer", "finalAnswer"].includes(message.phase))
        ?? agentMessages.at(-1)
      : null;
    const visible = [
      ...(userMessages.length ? userMessages : item.prompt ? [{
        itemId: `${item.id}:prompt`,
        role: "user",
        text: item.prompt,
        responseAnnotations: item.promptAnnotations,
        responseAnnotationRequest: item.promptRequest,
      }] : []),
      ...(visibleAgent ? [visibleAgent] : historicalAgentResponseVisible(item) && item.answer ? [{
        itemId: `${item.id}:answer`,
        role: "agent",
        text: item.answer,
      }] : []),
    ];
    for (const [messageIndex, message] of visible.entries()) messages.push({
      id: `${history.provider}:${history.threadId}:${item.id}:${message.itemId}:${message.role}`,
      provider: history.provider,
      threadId: history.threadId,
      turnId: item.id,
      itemId: String(message.itemId ?? ""),
      clientUserMessageId: String(message.clientUserMessageId ?? ""),
      role: message.role,
      author: message.role === "user"
        ? "Вы"
        : history.provider === "claude" ? "Claude" : "Codex",
      text: message.text,
      ...(message.role === "user" ? {
        responseAnnotations: message.responseAnnotations,
        responseAnnotationRequest: message.responseAnnotationRequest,
      } : {}),
      activities: message.role === "agent" && item.completed ? (item.activities ?? []) : [],
      time: message.time ?? (message.role === "user" ? item.startedAt : item.completedAt) ?? null,
      historyOrder: (historyStart + itemIndex) * 1_000 + messageIndex,
      attachments: attachmentViews(message.attachments),
    });
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
      author: "Вы",
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
  return [
    ...previous.map((message) => newestById.get(message.id) ?? message),
    ...newest.filter((message) => !previousIds.has(message.id)),
  ];
}

function prependOlderHistory(previous, older) {
  const seen = new Set(previous.map((message) => message.id));
  const uniqueOlder = [];
  for (const message of older) {
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    uniqueOlder.push(message);
  }
  return [...uniqueOlder, ...previous];
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
  const id = taskId(history.provider, history.threadId);
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
  if (!identity) return null;
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
  const optimisticId = `local:${request.requestId}`;
  const identity = taskIdentity(request.taskId);
  const previousAttempt = outgoingMessages(request.taskId).get(request.requestId);
  const visibleText = String(request.text ?? "").trim()
    || ((request.annotations ?? []).length
      ? `Аннотации к ответу: ${(request.annotations ?? []).length}`
      : "Изображение");
  const optimistic = {
    id: optimisticId,
    provider: identity?.provider ?? "",
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
    attachments: request.attachments ?? [],
    uploadedPaths: previousAttempt?.uploadedPaths ?? [],
    ...deliveryPatch("preparing"),
  };
  rememberOutgoing(request.taskId, optimistic);
  renderTaskMessages(request.taskId);
  return runAction(async () => {
    try {
      // Worker attachments are deleted after their command finishes. A retry
      // must upload the image again instead of reusing an expired reference.
      const paths = reusableAttachmentPaths(
        optimistic.uploadedPaths,
        (request.attachments ?? []).length,
        { remote: !vscode },
      );
      if (!paths.length) {
        for (const attachment of request.attachments ?? []) paths.push(await uploadAttachment(attachment));
        patchOutgoing(request.taskId, request.requestId, { uploadedPaths: paths.slice() });
      }
      patchOutgoing(request.taskId, request.requestId, deliveryPatch("sending"));
      const params = {
        text: annotatedText(request.text, request.annotations),
        provider: identity?.provider,
        threadId: identity?.threadId,
        clientUserMessageId: request.requestId,
        followUpMode: request.followUpMode,
      };
      if (paths.length) params.attachments = paths;
      const result = await control("send-message", params);
      applySnapshot(result?.snapshot);
      agentHub.completeSend(request.requestId, {
        accepted: Boolean(result?.accepted || result?.deferred),
      });
      patchOutgoing(request.taskId, request.requestId, {
        provider: identity?.provider ?? "",
        threadId: result?.threadId ?? identity?.threadId ?? "",
        turnId: result?.turnId ?? "",
        itemId: result?.itemId ?? request.requestId,
        ...(result?.accepted && !result?.steered ? { turnUserSlot: "root" } : {}),
        ...(result?.accepted
          ? deliveryPatch("accepted")
          : result?.deferred
            ? deliveryPatch(result?.queued ? "queued" : "accepted")
            : deliveryPatch("rejected")),
      });
      agentHub.toast(result?.message ?? (result?.accepted ? "Сообщение принято" : "Сообщение сохранено"));
    } catch (error) {
      // A remote command may finish after its HTTP result is lost. Preserve
      // the durable optimistic message and let the next snapshot reconcile it
      // through the exact server receipt instead of restoring a duplicate
      // draft and labelling an accepted turn as rejected.
      const rejected = messageSendDefinitelyRejected(error);
      agentHub.completeSend(request.requestId, { accepted: !rejected });
      patchOutgoing(
        request.taskId,
        request.requestId,
        deliveryPatch(rejected ? "rejected" : "unconfirmed"),
      );
      throw error;
    }
  });
});

agentHub.on("task:new", ({ title, provider }) => runAction(async () => {
  const selectedProvider = ["codex", "claude"].includes(provider)
    ? provider
    : (lastSnapshot?.settings?.provider ?? "codex");
  let snapshot = await control("new-task", { provider: selectedProvider });
  const created = (snapshot.tasks ?? []).find((task) => task.selected);
  if (created) {
    pendingSelectionId = taskId(created.provider, created.threadId);
    rememberSelectedTaskId(pendingSelectionId);
  }
  applySnapshot(snapshot);
  try {
    if (title) {
      snapshot = await control("rename-task", { ...exactSelectedTaskParams(), title });
      applySnapshot(snapshot);
    }
  } finally {
    pendingSelectionId = "";
    agentHub.showSelectedTask();
    const identity = taskIdentity(selectedTaskId);
    if (identity) replaceRoute(`#/chat/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.threadId)}`);
  }
}));

agentHub.on("task:rename", ({ id, title }) => runAction(async () => applySnapshot(
  await control("rename-task", { ...exactTaskParams(id || selectedTaskId), title }),
)));
agentHub.on("task:archive", () => runAction(async () => applySnapshot(
  await control("archive-task", exactSelectedTaskParams()),
)));
agentHub.on("task:stop", () => runAction(async () => agentHub.toast(
  (await control("cancel-run", exactSelectedTaskParams()))?.message ?? "Остановка запрошена",
)));
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
async function refreshRateLimitHistory(range = rateLimitRefreshRange, { reportError = false } = {}) {
  const requestedRange = String(range || "24h");
  rateLimitRefreshRange = requestedRange;
  if (rateLimitRefreshInFlight) return;
  rateLimitRefreshInFlight = true;
  try {
    agentHub.setRateLimitHistory(await control("rate-limit-history", {
      range: requestedRange,
      maxPointsPerSeries: 600,
    }));
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
agentHub.on("usage:open", ({ range }) => runAction(async () => {
  try {
    agentHub.setUsageHistory(await control("usage-history", {
      range,
      maxPoints: 600,
    }));
  } catch (error) {
    agentHub.setUsageHistory({
      range,
      error: error?.message || "Не удалось загрузить локальный расход.",
    });
  }
}));
agentHub.on("selection:set", ({ key, value }) => runAction(async () => {
  const names = {
    model: "model",
    reasoning: "reasoning",
    mode: "mode",
    project: "project",
    autoApprove: "approvalMode",
    includeClaudeUsage: "includeClaudeUsage",
  };
  const name = names[key];
  if (!name) return;
  applySnapshot(await control("update-setting", {
    name,
    value: key === "autoApprove" ? (value ? "auto" : "manual") : value,
  }));
  if (key === "includeClaudeUsage") {
    requestUsageHistory(usageState.range, { force: true });
    void loadJournal({ force: true });
  }
}));
agentHub.on("approval:respond", ({ id, decision }) => runAction(
  () => control("resolve-approval", { key: id, decision }),
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
async function runQueueAction(id, operation) {
  const key = String(id ?? "").trim();
  if (!key || queueActionsInFlight.has(key)) return null;
  queueActionsInFlight.add(key);
  if (selectedTaskId) {
    const visible = (lastSnapshot?.deferredInputs ?? []).filter((item) => item.id !== key);
    agentHub.setQueue(selectedTaskId, visible.filter((item) => (
      (!item.provider || taskId(item.provider, item.threadId) === selectedTaskId)
    )));
  }
  try {
    return await operation();
  } finally {
    queueActionsInFlight.delete(key);
    applySnapshot(await control("snapshot"));
  }
}

agentHub.on("queue:accept", ({ id }) => runAction(() => runQueueAction(id, async () => {
  const result = await control("deferred-input", { id, action: "queue" });
  agentHub.toast(result?.message ?? "Сообщение будет отправлено после текущего хода");
})));
agentHub.on("queue:steer", ({ id }) => runAction(() => runQueueAction(id, async () => {
  const result = await control("deferred-input", { id, action: "steer" });
  agentHub.toast(result?.message ?? "Сообщение добавлено в текущий ход");
})));
agentHub.on("queue:edit", ({ id, text }) => runAction(async () => {
  const result = await control("deferred-input", { id, action: "edit", text });
  applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Сообщение в очереди изменено");
}));
agentHub.on("tts:play", () => runAction(() => control("speak-last-answer", exactSelectedTaskParams())));
agentHub.on("attachment:open", ({ attachment }) => runAction(async () => {
  const id = String(attachment?.id ?? "").trim();
  if (vscode && id) {
    await bridgeCall("open-attachment", { id });
    return;
  }
  const directDataUrl = String(attachment?.dataUrl ?? "").trim();
  const image = String(attachment?.type ?? "").toLowerCase().startsWith("image/");
  if (directDataUrl) {
    if (image) agentHub.openAttachmentViewer({ dataUrl: directDataUrl, name: attachment?.name });
    else {
      const link = document.createElement("a");
      link.href = directDataUrl;
      link.download = String(attachment?.name ?? "attachment");
      link.click();
    }
    return;
  }
  if (image) agentHub.openAttachmentViewer({ name: attachment?.name });
  try {
    const access = id
      ? await control("open-attachment", { id })
      : { url: String(attachment?.url ?? "").trim() };
    const url = String(access?.url ?? attachment?.url ?? "").trim()
      || `/api/attachment/view?id=${encodeURIComponent(String(access?.id ?? ""))}`;
    if (!url || /id=$/u.test(url)) throw new Error("Файл вложения недоступен");
    await localSessionReady;
    const response = await hubFetch(url, {
      headers: authorizationHeaders(),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Файл вложения недоступен: HTTP ${response.status}`);
    const blob = await response.blob();
    const resultType = String(access?.type ?? attachment?.type ?? blob.type ?? "").toLowerCase();
    if (!resultType.startsWith("image/")) {
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = String(access?.name ?? attachment?.name ?? "attachment");
      link.click();
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
      return;
    }
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Не удалось прочитать файл вложения"));
      reader.readAsDataURL(blob);
    });
    agentHub.showAttachmentViewer({ dataUrl, name: access?.name ?? attachment?.name });
  } catch (error) {
    if (image) agentHub.closeAttachmentViewer();
    throw error;
  }
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

async function refresh({ reportError = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  try {
    const previousSelectedId = selectedTaskId;
    const previousSelected = (lastSnapshot?.tasks ?? []).find(
      (task) => taskId(task.provider, task.threadId) === previousSelectedId,
    );
    const snapshotResult = await control("snapshot", { knownVersion: lastSnapshot?.version ?? "" });
    const snapshot = snapshotResult?.notModified === true ? lastSnapshot : snapshotResult;
    if (snapshotResult?.notModified === true) {
      resetConnectionFailures();
      applySnapshotConnection(snapshot);
    } else {
      applySnapshot(snapshot);
    }
    if (!snapshot) return;
    const currentSelected = (snapshot.tasks ?? []).find(
      (task) => taskId(task.provider, task.threadId) === selectedTaskId,
    );
    const sameSelection = previousSelected && currentSelected
      && previousSelected.provider === currentSelected.provider
      && previousSelected.threadId === currentSelected.threadId;
    const answerChanged = sameSelection
      && String(previousSelected.lastAnswerAt ?? "") !== String(currentSelected.lastAnswerAt ?? "");
    const selectedHistoryMissing = sameSelection
      && !historyPageByTask.has(taskId(currentSelected.provider, currentSelected.threadId));
    const externalLive = sameSelection
      && currentSelected.running
      && !["hub", "telegram"].includes(String(
        currentSelected.run?.executionOwner ?? currentSelected.executionOwner ?? "",
      ));
    const refreshExternalHistory = externalLive
      && Date.now() - selectedHistoryRefreshAt >= EXTERNAL_HISTORY_REFRESH_MS;
    const refreshCaughtUpHistory = sameSelection
      && historyNeedsCatchUp(taskId(currentSelected.provider, currentSelected.threadId))
      && Date.now() - selectedHistoryRefreshAt >= EXTERNAL_HISTORY_REFRESH_MS;
    if (sameSelection && (
      selectedHistoryMissing
      || (previousSelected.running && !currentSelected.running)
      || answerChanged
      || refreshExternalHistory
      || refreshCaughtUpHistory
    )) {
      selectedHistoryRefreshAt = Date.now();
      const history = await control("task-history", {
        provider: currentSelected.provider,
        threadId: currentSelected.threadId,
        limit: 20,
        includeActive: false,
        knownVersion: historyPageByTask.get(
          taskId(currentSelected.provider, currentSelected.threadId),
        )?.version ?? "",
      });
      applyOpened({ snapshot: lastSnapshot, history }, {
        preserveScroll: true,
        skipSnapshot: true,
        selectTask: false,
      });
    }
    applySnapshotConnection(snapshot);
  } catch (error) {
    recordTransientConnectionFailure();
    if (reportError) throw error;
  } finally {
    refreshing = false;
    const active = Boolean(lastSnapshot?.tasks?.some(
      (task) => task.running || task.context?.compacting,
    )) || historyNeedsCatchUp(selectedTaskId);
    refreshTimer = window.setTimeout(refresh, active ? 1_200 : 5_000);
  }
}

void runAction(async () => {
  agentHub.setConnection("connecting");
  await refresh({ reportError: true });
  const routed = await openRoute();
  const identity = !routed ? taskIdentity(selectedTaskId) : null;
  if (identity) {
    applyOpened(await control("open-task", { ...identity, limit: 20 }));
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
