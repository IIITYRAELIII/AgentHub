"use strict";

(() => {

const agentHub = window.AgentHub;
const telegramInitData = String(window.Telegram?.WebApp?.initData ?? "");
const localSessionReady = window.AgentHubLocalSessionReady ?? Promise.resolve();
const vscode = window.__agentHubVscode ?? (typeof window.acquireVsCodeApi === "function"
  ? window.acquireVsCodeApi()
  : null);
const pendingBridgeCalls = new Map();
const seenAnswerKey = "agent-hub:seen-answers:v1";
let bridgeSequence = 0;
let lastSnapshot = null;
let selectedTaskId = "";
let refreshTimer = null;
let rateLimitRefreshTimer = null;
let rateLimitRefreshRange = "24h";
let rateLimitRefreshInFlight = false;
let refreshing = false;
let pendingSelectionId = "";
let selectionSequence = 0;
let selectionTail = Promise.resolve();
const historyByTask = new Map();
const historyPageByTask = new Map();
const outgoingByTask = new Map();
const liveProbeByTask = new Map();
const liveUserMessagesByTask = new Map();
const requestedContextCompactions = new Set();
const observedContextCompactions = new Map();
let deferredClientUserMessageIds = new Set();
const MAX_OUTGOING_MESSAGES_PER_TASK = 100;
const {
  activeStageLabel,
  hubErrorMessage,
  isConnectionFailure,
  markConnectionFailure,
  mergeLiveUserMessages,
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
    ]),
  ]);
}

function reconciledMessages(taskIdValue) {
  const serverMessages = mergeLiveUserMessages(
    historyByTask.get(taskIdValue) ?? [],
    liveUserMessagesByTask.get(taskIdValue) ?? {},
  );
  const pending = outgoingMessages(taskIdValue);
  const outgoing = [...pending.values()];
  const { matches, matchedIds } = reconcileMessageLifecycle(serverMessages, outgoing);
  const result = matches.map(({ message, local }) => {
    if (!local) return message;
    return {
      ...message,
      attachments: local.attachments?.length ? local.attachments : message.attachments,
      ...deliveryPatch("delivered"),
    };
  });
  for (const message of outgoing) {
    if (!matchedIds.has(message.clientUserMessageId)) result.push(message);
  }
  for (const clientUserMessageId of matchedIds) pending.delete(clientUserMessageId);
  return visibleConversationMessages(result, {
    deferredClientUserMessageIds,
    liveProbe: liveProbeByTask.get(taskIdValue) ?? null,
  });
}

function exactSelectedTaskParams() {
  const identity = taskIdentity(selectedTaskId);
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
  if (!run) {
    const removed = liveProbeByTask.delete(taskIdValue);
    const userRemoved = liveUserMessagesByTask.delete(taskIdValue);
    if (removed || userRemoved) renderTaskMessages(taskIdValue);
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
  return {
    author: selected.provider === "claude" ? "Claude" : "Codex",
    stage: activeStageLabel(run.stage),
    reasoning: run.progress || "",
    text: response,
    activities: run.activities ?? [],
    threadId: selected.threadId,
    turnId: run.turnId,
    itemId: run.responseItemId ?? null,
  };
}

function authorizationHeaders() {
  if (telegramInitData) return { Authorization: `tma ${telegramInitData}` };
  try {
    const deviceToken = String(window.AgentHubAndroid?.getAccessToken?.() ?? "").trim();
    if (deviceToken) return { Authorization: `device ${deviceToken}` };
  } catch {
    // The native bridge is optional; local web and VS Code use their existing transport.
  }
  return {};
}

function seenAnswers() {
  try {
    return JSON.parse(localStorage.getItem(seenAnswerKey) || "{}");
  } catch {
    return {};
  }
}

function markAnswerSeen(task) {
  if (!task?.lastAnswerAt) return;
  const seen = seenAnswers();
  seen[taskId(task.provider, task.threadId)] = task.lastAnswerAt;
  try {
    localStorage.setItem(seenAnswerKey, JSON.stringify(seen));
  } catch {
    // Приватный WebView может запрещать localStorage.
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
    return await fetch(input, init);
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
  else pending.reject(new Error(String(message.error ?? "Команда Agent Hub завершилась с ошибкой")));
});

async function waitRemoteResult(commandId) {
  await localSessionReady;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await hubFetch(`/api/control/result?id=${encodeURIComponent(commandId)}`, {
      headers: authorizationHeaders(),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    if (response.status === 202 || payload.pending) {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
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

function modelTask(task, snapshot, seen, effectiveSelectedId, serverSelectedId) {
  const id = taskId(task.provider, task.threadId);
  const answerAt = Date.parse(task.lastAnswerAt ?? "") || 0;
  const seenAt = Date.parse(seen[id] ?? "") || 0;
  const running = Boolean(task.running);
  const unknown = task.activityUnknown === true;
  const serverSelected = id === serverSelectedId;
  const executionOwner = task.run?.executionOwner ?? task.executionOwner ?? "";
  const runtimeTitle = task.run?.runtime ?? task.runtime ?? "";
  return {
    id,
    title: task.title || "Без названия",
    provider: task.provider,
    agentLabel: task.provider === "claude" ? "Claude" : "Codex",
    modelLabel: serverSelected ? snapshot.selected?.model : task.run?.model ?? "",
    reasoningLabel: serverSelected ? snapshot.selected?.reasoning : task.run?.reasoning ?? "",
    modeLabel: serverSelected ? snapshot.selected?.mode : "",
    runtimeLabel: runtimeShortLabels[executionOwner] ?? (runtimeTitle ? "EXT" : ""),
    runtimeTitle,
    project: task.projectName || "",
    status: running ? "running" : unknown ? "unknown" : answerAt > seenAt ? "ready" : "idle",
    statusLabel: running ? "Выполняется" : unknown ? "Статус неизвестен" : answerAt > seenAt ? "Ответ готов" : "",
    lastActivity: task.orderingActivityAtMs
      ? new Date(task.orderingActivityAtMs).toISOString()
      : task.lastAnswerAt,
    startedAt: running ? task.run?.startedAt ?? task.startedAt ?? null : null,
    unread: !running && answerAt > seenAt,
    running,
    selected: id === effectiveSelectedId,
    context: task.run?.context ?? task.context ?? null,
  };
}

function compactionContextLabel(context) {
  if (context?.usagePending) return "объём обновляется";
  return `контекст ${Math.round(Math.max(0, Math.min(100, Number(context?.percent) || 0)))}%`;
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
      agentHub.toast("Началась автосвёртка контекста");
    } else if (status === "completed" && previousStatus !== "completed") {
      if (requested || (compaction.origin === "automatic" && recent)) {
        const completionLabel = compaction.origin === "automatic"
          ? "Автосвёртка контекста завершена"
          : "Свёртка контекста завершена";
        agentHub.toast(`${completionLabel} · ${compactionContextLabel(context)}`);
      }
      requestedContextCompactions.delete(compactionId);
    } else if (status === "timeout" && previousStatus !== "timeout") {
      if (requested || (compaction.origin === "automatic" && recent)) {
        agentHub.toast("Не удалось подтвердить завершение свёртки контекста");
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
  lastSnapshot = snapshot;
  agentHub.setExchangeRates(snapshot.exchangeRates ?? null);
  observeContextCompactions(snapshot.tasks);
  deferredClientUserMessageIds = new Set(
    (snapshot.deferredInputs ?? [])
      .filter((item) => item.state !== "dispatching")
      .map((item) => String(item.clientUserMessageId ?? "").trim())
      .filter(Boolean),
  );
  const seen = seenAnswers();
  const serverSelected = (snapshot.tasks ?? []).find((task) => task.selected);
  const serverSelectedId = serverSelected
    ? taskId(serverSelected.provider, serverSelected.threadId)
    : "";
  const pendingExists = pendingSelectionId
    && (snapshot.tasks ?? []).some((task) => taskId(task.provider, task.threadId) === pendingSelectionId);
  const effectiveSelectedId = pendingExists ? pendingSelectionId : serverSelectedId;
  const tasks = (snapshot.tasks ?? [])
    .map((task) => modelTask(task, snapshot, seen, effectiveSelectedId, serverSelectedId))
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
          deferred.state === "dispatching"
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
      ...deliveryPatch("accepted"),
    });
  }
  const selected = (snapshot.tasks ?? []).find(
    (task) => taskId(task.provider, task.threadId) === effectiveSelectedId,
  );
  selectedTaskId = effectiveSelectedId;
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
      item.state !== "dispatching"
      &&
      (!item.provider || item.provider === selected.provider)
      && (!item.threadId || item.threadId === selected.threadId))
      .map((item) => ({ ...item, attachments: attachmentViews(item.attachments) })));
  }
  const settings = snapshot.settings ?? {};
  agentHub.setOptions({
    agent: [
      { value: "codex", label: "Codex" },
      { value: "claude", label: "Claude" },
    ],
    model: settings.models ?? [],
    reasoning: settings.reasoningOptions ?? [],
    mode: settings.modeOptions ?? [],
    project: (settings.projects ?? []).map((project) => ({
      value: project.path,
      label: project.name,
    })),
  });
  agentHub.setSelection({
    agent: settings.provider,
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

function historyMessages(history, focusedTurn = null) {
  const messages = [];
  for (const item of history?.items ?? []) {
    const itemMessages = Array.isArray(item.messages) ? item.messages : [];
    const userMessages = itemMessages.filter((message) => message.role === "user");
    const agentMessages = itemMessages.filter((message) => message.role === "agent");
    const visibleAgent = item.completed
      ? agentMessages.findLast((message) => ["final", "final_answer", "finalAnswer"].includes(message.phase))
        ?? agentMessages.at(-1)
      : null;
    const visible = [
      ...(userMessages.length ? userMessages : item.prompt ? [{
        itemId: `${item.id}:prompt`,
        role: "user",
        text: item.prompt,
      }] : []),
      ...(visibleAgent ? [visibleAgent] : item.completed && item.answer ? [{
        itemId: `${item.id}:answer`,
        role: "agent",
        text: item.answer,
      }] : []),
    ];
    for (const message of visible) messages.push({
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
      activities: message.role === "agent" && item.completed ? (item.activities ?? []) : [],
      time: message.time ?? (message.role === "user" ? item.startedAt : item.completedAt) ?? null,
      attachments: attachmentViews(message.attachments),
    });
  }
  if (focusedTurn && !messages.some((message) => (
    message.provider === focusedTurn.provider
    && message.threadId === (focusedTurn.turnThreadId ?? focusedTurn.taskThreadId)
    && message.turnId === focusedTurn.turnId
  ))) {
    if (focusedTurn.prompt) messages.push({
      id: `${focusedTurn.turnId}:prompt`,
      provider: focusedTurn.provider,
      threadId: focusedTurn.turnThreadId ?? focusedTurn.taskThreadId,
      turnId: focusedTurn.turnId,
      itemId: `${focusedTurn.turnId}:focused:user`,
      role: "user",
      author: "Вы",
      text: focusedTurn.prompt,
      time: focusedTurn.startedAt,
    });
    messages.push({
      id: `${focusedTurn.turnId}:answer`,
      provider: focusedTurn.provider,
      threadId: focusedTurn.turnThreadId ?? focusedTurn.taskThreadId,
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

function applyOpened(result) {
  const history = result?.history;
  if (!history) {
    applySnapshot(result?.snapshot);
    return;
  }
  const id = taskId(history.provider, history.threadId);
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
  });
  applySnapshot(result?.snapshot);
  selectedTaskId = id;
  agentHub.selectTask(id);
  syncHistoryPagination(id);
  renderTaskMessages(id);
  const task = result.snapshot?.tasks?.find(
    (item) => item.provider === history.provider && item.threadId === history.threadId,
  );
  markAnswerSeen(task);
}

function annotatedText(text, annotations) {
  if (!Array.isArray(annotations) || !annotations.length) return text;
  const payload = annotations.map((item) => ({
    text: String(item.text ?? ""),
    annotation: String(item.annotation ?? item.comment ?? ""),
  }));
  return "# Response annotations:\n"
    + "Each item contains text selected from an earlier Codex response and may include a user comment. "
    + "Use every selection as context and address every comment in your response.\n"
    + `<response-annotations>\n${JSON.stringify(payload)}\n</response-annotations>\n\n`
    + `## My request for Codex:\n${text}`;
}

function dataUrlBody(dataUrl) {
  const match = String(dataUrl ?? "").match(/^data:([^;,]+);base64,(.+)$/u);
  if (!match) throw new Error("Изображение имеет неподдерживаемый формат");
  const binary = atob(match[2]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return { type: match[1], body: bytes };
}

async function uploadAttachment(attachment) {
  if (vscode) {
    return bridgeCall("upload-attachment", {
      name: attachment.name ?? "image.png",
      type: attachment.type ?? "image/png",
      dataUrl: attachment.dataUrl,
    });
  }
  await localSessionReady;
  const image = dataUrlBody(attachment.dataUrl);
  const response = await hubFetch("/api/attachment", {
    method: "POST",
    headers: {
      ...authorizationHeaders(),
      "Content-Type": image.type,
    },
    body: image.body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.path) {
    throw new Error(String(payload.error ?? "Не удалось загрузить изображение"));
  }
  return payload.path;
}

async function runAction(operation) {
  try {
    return await operation();
  } catch (error) {
    if (isConnectionFailure(error)) applySnapshotConnection(lastSnapshot, "offline");
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
  selectedTaskId = id;
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
  page.loading = true;
  syncHistoryPagination(id);
  try {
    const history = await control("task-history", {
      ...identity,
      before: page.nextBefore,
      limit: 20,
    });
    historyByTask.set(
      id,
      prependOlderHistory(historyByTask.get(id) ?? [], historyMessages(history)),
    );
    Object.assign(page, {
      start: history.start,
      total: history.total,
      nextBefore: history.nextBefore,
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
        ...(result?.accepted
          ? deliveryPatch("accepted")
          : result?.deferred
            ? deliveryPatch(result?.queued ? "queued" : "accepted")
            : deliveryPatch("rejected")),
      });
      agentHub.toast(result?.message ?? (result?.accepted ? "Сообщение принято" : "Сообщение сохранено"));
    } catch (error) {
      agentHub.completeSend(request.requestId, { accepted: false });
      patchOutgoing(
        request.taskId,
        request.requestId,
        deliveryPatch(isConnectionFailure(error) ? "unconfirmed" : "rejected"),
      );
      throw error;
    }
  });
});

agentHub.on("task:new", ({ title }) => runAction(async () => {
  const provider = lastSnapshot?.settings?.provider ?? "codex";
  let snapshot = await control("new-task", { provider });
  applySnapshot(snapshot);
  if (title) {
    snapshot = await control("rename-task", { ...exactSelectedTaskParams(), title });
    applySnapshot(snapshot);
  }
}));

agentHub.on("task:rename", ({ title }) => runAction(async () => applySnapshot(
  await control("rename-task", { ...exactSelectedTaskParams(), title }),
)));
agentHub.on("task:archive", () => runAction(async () => applySnapshot(
  await control("archive-task", exactSelectedTaskParams()),
)));
agentHub.on("task:stop", () => runAction(async () => agentHub.toast(
  (await control("cancel-run", exactSelectedTaskParams()))?.message ?? "Остановка запрошена",
)));
agentHub.on("task:diff", () => runAction(async () => {
  const diff = await control("task-diff", exactSelectedTaskParams());
  agentHub.setStatus({ rows: [{ name: "Diff", value: diff?.text || "Изменений нет" }] });
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
    agent: "provider",
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
agentHub.on("queue:accept", ({ id }) => runAction(async () => {
  const result = await control("deferred-input", { id, action: "queue" });
  applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Сообщение будет отправлено после текущего хода");
}));
agentHub.on("tts:play", () => runAction(() => control("speak-last-answer", exactSelectedTaskParams())));
agentHub.on("attachment:open", ({ attachment }) => runAction(async () => {
  const id = String(attachment?.id ?? "").trim();
  if (vscode && id) {
    await bridgeCall("open-attachment", { id });
    return;
  }
  const directDataUrl = String(attachment?.dataUrl ?? "").trim();
  if (directDataUrl) {
    agentHub.openAttachmentViewer({ dataUrl: directDataUrl, name: attachment?.name });
    return;
  }
  agentHub.openAttachmentViewer({ name: attachment?.name });
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
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("Не удалось прочитать файл вложения"));
      reader.readAsDataURL(blob);
    });
    agentHub.showAttachmentViewer({ dataUrl, name: access?.name ?? attachment?.name });
  } catch (error) {
    agentHub.closeAttachmentViewer();
    throw error;
  }
}));
agentHub.on("hub:restart", () => runAction(() => control("restart-server")));
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
  return true;
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const previousSelected = (lastSnapshot?.tasks ?? []).find((task) => task.selected);
    const snapshot = await control("snapshot");
    applySnapshot(snapshot);
    const currentSelected = (snapshot.tasks ?? []).find((task) => task.selected);
    const sameSelection = previousSelected && currentSelected
      && previousSelected.provider === currentSelected.provider
      && previousSelected.threadId === currentSelected.threadId;
    if (!pendingSelectionId && previousSelected && currentSelected && !sameSelection) {
      applyOpened(await control("open-task", {
        provider: currentSelected.provider,
        threadId: currentSelected.threadId,
        limit: 20,
      }));
    } else if (sameSelection && previousSelected.running && !currentSelected.running) {
      applyOpened(await control("open-task", {
        provider: currentSelected.provider,
        threadId: currentSelected.threadId,
        limit: 20,
      }));
    }
    if (!selectedTaskId && snapshot.selected?.threadId) {
      selectedTaskId = taskId(snapshot.selected.provider, snapshot.selected.threadId);
    }
    applySnapshotConnection(snapshot);
  } catch {
    applySnapshotConnection(lastSnapshot, "offline");
  } finally {
    refreshing = false;
    const active = Boolean(lastSnapshot?.tasks?.some(
      (task) => task.running || task.context?.compacting,
    ));
    refreshTimer = window.setTimeout(refresh, active ? 1_200 : 5_000);
  }
}

void runAction(async () => {
  agentHub.setConnection("connecting");
  await refresh();
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
  window.clearInterval(rateLimitRefreshTimer);
});

})();
