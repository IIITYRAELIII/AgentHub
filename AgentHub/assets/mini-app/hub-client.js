"use strict";

(() => {

const agentHub = window.AgentHub;
const telegramInitData = String(window.Telegram?.WebApp?.initData ?? "");
const vscode = window.__agentHubVscode ?? (typeof window.acquireVsCodeApi === "function"
  ? window.acquireVsCodeApi()
  : null);
const pendingBridgeCalls = new Map();
const seenAnswerKey = "agent-hub:seen-answers:v1";
let bridgeSequence = 0;
let lastSnapshot = null;
let selectedTaskId = "";
let refreshTimer = null;
let refreshing = false;
let pendingSelectionId = "";
let selectionSequence = 0;
let selectionTail = Promise.resolve();
const historyByTask = new Map();
const outgoingByTask = new Map();
const MAX_OUTGOING_MESSAGES_PER_TASK = 100;
const {
  liveMessageMatch,
  reconcile: reconcileMessageLifecycle,
  rememberBounded: rememberBoundedMessage,
} = window.AgentHubMessageLifecycle;

const runtimeShortLabels = Object.freeze({
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
    queued: { deliveryState: "queued", delivery: "В очереди", failed: false },
    delivered: { deliveryState: "delivered", delivery: "", failed: false },
    unconfirmed: { deliveryState: "unconfirmed", delivery: "Приём не подтверждён", failed: true },
    rejected: { deliveryState: "rejected", delivery: "Не принято", failed: true },
  };
  return states[stateName] ?? states.unconfirmed;
}

function patchOutgoing(taskIdValue, clientUserMessageId, patch) {
  const message = outgoingMessages(taskIdValue).get(clientUserMessageId);
  if (!message) return;
  Object.assign(message, patch);
  renderTaskMessages(taskIdValue);
}

function reconciledMessages(taskIdValue) {
  const serverMessages = historyByTask.get(taskIdValue) ?? [];
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
  return result;
}

function renderTaskMessages(taskIdValue) {
  agentHub.setMessages(taskIdValue, reconciledMessages(taskIdValue));
}

function updateLiveMessage(taskIdValue, selected) {
  const run = selected?.run;
  if (!run) return null;
  const response = String(run.response ?? "");
  if (!response || !run.turnId) return {
    author: selected.provider === "claude" ? "Claude" : "Codex",
    stage: run.stage,
    reasoning: run.progress || "",
    text: response,
    activities: run.activities ?? [],
    threadId: selected.threadId,
    turnId: run.turnId ?? null,
    itemId: run.responseItemId ?? null,
  };
  const probe = {
    provider: selected.provider,
    threadId: selected.threadId,
    turnId: run.turnId,
    itemId: run.responseItemId,
    role: "agent",
  };
  const messages = historyByTask.get(taskIdValue) ?? [];
  const match = liveMessageMatch(messages, probe);
  if (match) {
    match.text = response;
    renderTaskMessages(taskIdValue);
  }
  return {
    author: selected.provider === "claude" ? "Claude" : "Codex",
    stage: run.stage,
    reasoning: run.progress || "",
    text: match ? "" : response,
    activities: run.activities ?? [],
    threadId: selected.threadId,
    turnId: run.turnId,
    itemId: run.responseItemId ?? null,
  };
}

function authorizationHeaders() {
  return telegramInitData ? { Authorization: `tma ${telegramInitData}` } : {};
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
      reject(new Error("Agent Hub в VS Code не ответил вовремя"));
    }, 30_000);
    pendingBridgeCalls.set(id, { resolve, reject, timer });
    vscode.postMessage({ type: "agenthub:control", id, action, params });
  });
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
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const response = await fetch(`/api/control/result?id=${encodeURIComponent(commandId)}`, {
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
  throw new Error("Локальный Agent Hub не ответил. Команда сохранена в Mini App.");
}

async function control(action, params = {}) {
  const bridged = bridgeCall(action, params);
  if (bridged) return bridged;
  const response = await fetch("/api/control", {
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
    lastActivity: task.updatedAtMs ? new Date(task.updatedAtMs).toISOString() : task.lastAnswerAt,
    unread: !running && answerAt > seenAt,
    running,
    selected: id === effectiveSelectedId,
    context: task.run?.context ?? task.context ?? null,
  };
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  lastSnapshot = snapshot;
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
  for (const task of snapshot.tasks ?? []) {
    const clientUserMessageId = String(task.run?.clientUserMessageId ?? "");
    if (!clientUserMessageId) continue;
    patchOutgoing(taskId(task.provider, task.threadId), clientUserMessageId, {
      provider: task.provider,
      threadId: task.threadId,
      turnId: String(task.run?.turnId ?? ""),
      ...deliveryPatch("accepted"),
    });
  }
  const selected = (snapshot.tasks ?? []).find(
    (task) => taskId(task.provider, task.threadId) === effectiveSelectedId,
  );
  selectedTaskId = effectiveSelectedId;
  if (selected) {
    for (const deferred of snapshot.deferredInputs ?? []) {
      const clientUserMessageId = String(deferred.clientUserMessageId ?? "");
      if (!clientUserMessageId) continue;
      const deferredTaskId = taskId(deferred.provider, deferred.threadId);
      patchOutgoing(
        deferredTaskId,
        clientUserMessageId,
        deliveryPatch(deferred.state === "queued" ? "queued" : "accepted"),
      );
    }
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
      (!item.provider || item.provider === selected.provider)
      && (!item.threadId || item.threadId === selected.threadId)));
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
      : agentMessages.at(-1);
    const visible = [
      ...(userMessages.length ? userMessages : item.prompt ? [{
        itemId: `${item.id}:prompt`,
        role: "user",
        text: item.prompt,
      }] : []),
      ...(visibleAgent ? [visibleAgent] : item.answer ? [{
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

function applyOpened(result) {
  const history = result?.history;
  if (!history) {
    applySnapshot(result?.snapshot);
    return;
  }
  const id = taskId(history.provider, history.threadId);
  historyByTask.set(id, historyMessages(history, result.focusedTurn));
  applySnapshot(result?.snapshot);
  selectedTaskId = id;
  agentHub.selectTask(id);
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
  const image = dataUrlBody(attachment.dataUrl);
  const response = await fetch("/api/attachment", {
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
    applySnapshotConnection(lastSnapshot, "offline");
    agentHub.toast(String(error?.message ?? error));
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
      const paths = optimistic.uploadedPaths.length === (request.attachments ?? []).length
        ? optimistic.uploadedPaths.slice()
        : [];
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
      patchOutgoing(request.taskId, request.requestId, deliveryPatch("unconfirmed"));
      throw error;
    }
  });
});

agentHub.on("task:new", ({ title }) => runAction(async () => {
  const provider = lastSnapshot?.settings?.provider ?? "codex";
  let snapshot = await control("new-task", { provider });
  applySnapshot(snapshot);
  if (title) {
    snapshot = await control("rename-task", { title });
    applySnapshot(snapshot);
  }
}));

agentHub.on("task:rename", ({ title }) => runAction(async () => applySnapshot(
  await control("rename-task", { title }),
)));
agentHub.on("task:archive", () => runAction(async () => applySnapshot(
  await control("archive-task"),
)));
agentHub.on("task:stop", () => runAction(async () => agentHub.toast(
  (await control("cancel-run"))?.message ?? "Остановка запрошена",
)));
agentHub.on("task:diff", () => runAction(async () => {
  const diff = await control("task-diff");
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
agentHub.on("limits:open", ({ range }) => runAction(async () => {
  try {
    agentHub.setRateLimitHistory(await control("rate-limit-history", {
      range,
      maxPointsPerSeries: 600,
    }));
  } catch (error) {
    agentHub.setRateLimitHistory({
      range,
      error: String(error?.message ?? error ?? "Не удалось загрузить историю лимитов"),
    });
    throw error;
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
  };
  const name = names[key];
  if (!name) return;
  applySnapshot(await control("update-setting", {
    name,
    value: key === "autoApprove" ? (value ? "auto" : "manual") : value,
  }));
}));
agentHub.on("approval:respond", ({ id, decision }) => runAction(
  () => control("resolve-approval", { key: id, decision }),
));
agentHub.on("queue:remove", ({ id }) => runAction(async () => {
  const result = await control("deferred-input", { id, action: "cancel" });
  applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Отложенное сообщение удалено");
}));
agentHub.on("queue:accept", ({ id }) => runAction(async () => {
  const result = await control("deferred-input", { id, action: "queue" });
  applySnapshot(await control("snapshot"));
  agentHub.toast(result?.message ?? "Сообщение будет отправлено после текущего хода");
}));
agentHub.on("tts:play", () => runAction(() => control("speak-last-answer")));
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
  const result = await control("compact-context");
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
    const active = Boolean(lastSnapshot?.tasks?.some((task) => task.running));
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

window.addEventListener("hashchange", () => void runAction(openRoute));
window.addEventListener("beforeunload", () => window.clearTimeout(refreshTimer));

})();
