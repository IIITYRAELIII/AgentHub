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

function modelTask(task, snapshot, seen) {
  const id = taskId(task.provider, task.threadId);
  const answerAt = Date.parse(task.lastAnswerAt ?? "") || 0;
  const seenAt = Date.parse(seen[id] ?? "") || 0;
  const running = Boolean(task.running);
  const unknown = task.activityUnknown === true;
  return {
    id,
    title: task.title || "Без названия",
    provider: task.provider,
    agentLabel: task.provider === "claude" ? "Claude" : "Codex",
    modelLabel: task.selected ? snapshot.selected?.model : "",
    reasoningLabel: task.selected ? snapshot.selected?.reasoning : "",
    modeLabel: task.selected ? snapshot.selected?.mode : "",
    project: task.projectName || "",
    status: running ? "running" : unknown ? "unknown" : answerAt > seenAt ? "ready" : "idle",
    statusLabel: running ? "Выполняется" : unknown ? "Статус неизвестен" : answerAt > seenAt ? "Ответ готов" : "",
    lastActivity: task.updatedAtMs ? new Date(task.updatedAtMs).toISOString() : task.lastAnswerAt,
    unread: !running && answerAt > seenAt,
    running,
    selected: task.selected === true,
  };
}

function applySnapshot(snapshot) {
  if (!snapshot) return;
  lastSnapshot = snapshot;
  const seen = seenAnswers();
  const tasks = (snapshot.tasks ?? [])
    .map((task) => modelTask(task, snapshot, seen))
    .sort((left, right) => Date.parse(right.lastActivity || 0) - Date.parse(left.lastActivity || 0));
  agentHub.setTasks(tasks);
  const selected = (snapshot.tasks ?? []).find((task) => task.selected);
  selectedTaskId = selected ? taskId(selected.provider, selected.threadId) : "";
  if (selected) {
    agentHub.setLive(selectedTaskId, selected.run ? {
      author: selected.provider === "claude" ? "Claude" : "Codex",
      stage: selected.run.stage,
      text: selected.run.response || selected.run.progress || "",
    } : null);
    agentHub.setRunning(selectedTaskId, Boolean(selected.run || selected.running));
    agentHub.setApprovals(selectedTaskId, (snapshot.pendingApprovals ?? []).map((approval) => ({
      id: approval.key ?? approval.id,
      kind: approval.kind ?? "Подтверждение",
      text: approval.text ?? approval.preview ?? approval.reason ?? "",
      options: [
        { id: "accept", label: "Разрешить", kind: "primary" },
        { id: "decline", label: "Отклонить", kind: "danger" },
      ],
    })));
    agentHub.setQueue(selectedTaskId, snapshot.deferredInputs ?? []);
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
  agentHub.setConnection("online");
}

function historyMessages(history, focusedTurn = null) {
  const messages = [];
  for (const item of history?.items ?? []) {
    if (item.prompt) messages.push({
      id: `${item.id}:prompt`,
      role: "user",
      author: "Вы",
      text: item.prompt,
    });
    if (item.answer) messages.push({
      id: `${item.id}:answer`,
      role: "agent",
      author: history.provider === "claude" ? "Claude" : "Codex",
      text: item.answer,
    });
  }
  if (focusedTurn && !messages.some((message) => message.id.startsWith(`${focusedTurn.turnId}:`))) {
    if (focusedTurn.prompt) messages.push({
      id: `${focusedTurn.turnId}:prompt`,
      role: "user",
      author: "Вы",
      text: focusedTurn.prompt,
      time: focusedTurn.startedAt,
    });
    messages.push({
      id: `${focusedTurn.turnId}:answer`,
      role: "agent",
      author: focusedTurn.provider === "claude" ? "Claude" : "Codex",
      text: focusedTurn.answer || focusedTurn.title || "Ход завершён",
      time: focusedTurn.completedAt,
    });
  }
  return messages;
}

function applyOpened(result) {
  applySnapshot(result?.snapshot);
  const history = result?.history;
  if (!history) return;
  const id = taskId(history.provider, history.threadId);
  selectedTaskId = id;
  agentHub.selectTask(id);
  agentHub.setMessages(id, historyMessages(history, result.focusedTurn));
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
    agentHub.setConnection("offline");
    agentHub.toast(String(error?.message ?? error));
    return null;
  }
}

agentHub.on("task:select", ({ id }) => runAction(async () => {
  const identity = taskIdentity(id);
  if (!identity) return;
  const result = await control("open-task", { ...identity, limit: 20 });
  applyOpened(result);
  location.hash = `#/chat/${encodeURIComponent(identity.provider)}/${encodeURIComponent(identity.threadId)}`;
}));

agentHub.on("message:send", (request) => runAction(async () => {
  const paths = [];
  for (const attachment of request.attachments ?? []) paths.push(await uploadAttachment(attachment));
  const params = {
    text: annotatedText(request.text, request.annotations),
  };
  if (paths.length) params.attachments = paths;
  const result = await control("send-message", params);
  applySnapshot(result?.snapshot);
  agentHub.toast(result?.message ?? (result?.accepted ? "Сообщение принято" : "Сообщение сохранено"));
}));

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
agentHub.on("queue:remove", ({ id }) => runAction(
  () => control("deferred-input", { id, action: "cancel" }),
));
agentHub.on("tts:play", () => runAction(() => control("speak-last-answer")));
agentHub.on("hub:restart", () => runAction(() => control("restart-server")));

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
      location.hash = `#/chat/${encodeURIComponent(provider)}/${encodeURIComponent(threadId)}`;
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
    location.hash = "#/chat/"
      + `${encodeURIComponent(params.provider)}/${encodeURIComponent(params.taskThreadId)}`
      + `/turn/${encodeURIComponent(params.turnThreadId)}/${encodeURIComponent(params.turnId)}`;
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
    const snapshot = await control("snapshot");
    applySnapshot(snapshot);
    if (!selectedTaskId && snapshot.selected?.threadId) {
      selectedTaskId = taskId(snapshot.selected.provider, snapshot.selected.threadId);
    }
    agentHub.setConnection("online");
  } catch {
    agentHub.setConnection("offline");
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
