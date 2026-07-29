/* Agent Hub — общий frontend.
 *
 * Оболочка объединяет три представления над одними данными и темами:
 *   • «Диалоги» — слева компактный список задач, справа чат выбранной задачи;
 *   • «Журнал» — прежнее представление WORK_LOG.md с ленивой подгрузкой.
 *
 * Frontend не хранит собственных задач и сообщений: до подключения backend
 * списки пусты и показывают понятные пустые состояния. Данные приходят через
 * контракт `window.AgentHub.*` (render-функции), а действия пользователя
 * уходят наружу событием `agenthub:intent` и через `AgentHub.on(type, fn)`.
 * Разметка связана с кодом через атрибуты data-* — см. index.html. */

"use strict";

/* ------------------------------------------------------------- ссылки DOM */

const root = document.documentElement;
const journal = document.querySelector("[data-journal]");
const journalView = document.querySelector("[data-journal-view]");
const updatedAt = document.querySelector("[data-updated-at]");
const refreshButton = document.querySelector("[data-refresh]");
const collapseAllButton = document.querySelector("[data-collapse-all]");
const rateLimitsSlot = document.querySelector("[data-rate-limits-slot]");
const themeSelect = document.querySelector("[data-theme-select]");
const themeColor = document.querySelector("[data-theme-color]");

const taskList = document.querySelector("[data-task-list]");
const taskEmpty = document.querySelector("[data-task-empty]");
const taskCount = document.querySelector("[data-task-count]");
const taskFilter = document.querySelector("[data-task-filter]");

const chatPane = document.querySelector("[data-chat-pane]");
const chatEmpty = document.querySelector("[data-chat-empty]");
const chatScroll = document.querySelector("[data-chat-scroll]");
const chatLog = document.querySelector("[data-chat-log]");
const chatLive = document.querySelector("[data-chat-live]");
const chatTitle = document.querySelector("[data-chat-title]");
const chatSubtitle = document.querySelector("[data-chat-subtitle]");
const chatProviderDot = document.querySelector("[data-chat-provider-dot]");
const chatRunning = document.querySelector("[data-chat-running]");
const chatStop = document.querySelector("[data-chat-stop]");

const composer = document.querySelector("[data-composer]");
const composerGrow = document.querySelector("[data-composer-grow]");
const composerInput = document.querySelector("[data-composer-input]");
const composerSend = document.querySelector("[data-composer-send]");
const annotationsBox = document.querySelector("[data-annotations]");
const attachmentsBox = document.querySelector("[data-attachments]");
const annotateButton = document.querySelector("[data-action='annotate']");
const fileInput = document.querySelector("[data-file-input]");

const approvalsBox = document.querySelector("[data-approvals]");
const queueBox = document.querySelector("[data-queue]");

const settingsPanel = document.querySelector("[data-settings-panel]");
const panelScrim = document.querySelector("[data-panel-scrim]");
const statusSlot = document.querySelector("[data-status-slot]");

const dialog = document.querySelector("[data-text-dialog]");
const dialogScrim = document.querySelector("[data-dialog-scrim]");
const dialogForm = document.querySelector("[data-text-dialog-form]");
const dialogTitle = document.querySelector("[data-text-dialog-title]");
const dialogInput = document.querySelector("[data-text-dialog-input]");
const toast = document.querySelector("[data-toast]");
const connectionBanner = document.querySelector("[data-restart-banner]");

/* --------------------------------------------------------- Telegram / темы */

const telegram = window.Telegram?.WebApp;
const telegramInitData = String(telegram?.initData ?? "");
const telegramMode = Boolean(telegramInitData);
const vscodeMode = Boolean(window.__agentHubVscode);
const telegramPlatform = String(telegram?.platform ?? "").toLowerCase();
const mobileTelegramPlatforms = new Set(["android", "ios"]);
const compactSurfaceWidth = 860;

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
themeSelect.addEventListener("change", () => {
  applyTheme(themeSelect.value, { persist: true });
  window.__agentHubVscode?.postMessage({ type: "theme", theme: themeSelect.value });
});

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
  live: new Map(),       // taskId -> live | null
  approvals: new Map(),  // taskId -> approval[]
  queue: new Map(),      // taskId -> queued[]
  options: { agent: [], model: [], reasoning: [], mode: [], project: [] },
  selection: {},
  status: null,
};

/* Черновики живут только в памяти вкладки: текст, аннотации и вложения
 * переживают переключение задач, как в Desktop App. Их долговременное
 * хранение — забота backend. */
const drafts = new Map();
let pendingComposerRequest = null;

function currentTask() {
  return state.tasks.find((task) => task.id === state.selectedId) ?? null;
}

/* =========================================================== роутер видов */

function setView(view) {
  const next = view === "journal" ? "journal" : "chat";
  root.dataset.view = next;
  for (const button of document.querySelectorAll("[data-view-button]")) {
    button.setAttribute("aria-pressed", String(button.dataset.viewButton === next));
  }
  const title = document.querySelector("[data-view-title]");
  if (title) title.textContent = next === "journal" ? "Журнал" : "Диалоги";
  syncMobileNav();
  if (next === "journal") ensureJournalLoaded();
}

function setPane(pane) {
  root.dataset.pane = pane === "chat" ? "chat" : "tasks";
  syncMobileNav();
}

function syncMobileNav() {
  const active = root.dataset.view === "journal"
    ? "journal"
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
    if (target === "journal") { setView("journal"); return; }
    setView("chat");
    setPane(target === "chat" ? "chat" : "tasks");
  });
}

function syncSurface() {
  const nextSurface = resolveSurface();
  if (nextSurface !== surface) {
    surface = nextSurface;
    document.documentElement.dataset.surface = surface;
    syncCollapseTurnButtons();
    if (journalRendered) prepareMobileControls();
  }
}

window.addEventListener("resize", syncSurface);
telegram?.onEvent?.("viewportChanged", syncSurface);
telegram?.onEvent?.("fullscreenChanged", syncSurface);

/* ============================================================ список задач */

const providerLabels = { codex: "Codex", claude: "Claude" };

function renderTasks() {
  const filter = (taskFilter.value ?? "").trim().toLowerCase();
  const visible = state.tasks.filter((task) => {
    if (!filter) return true;
    return `${task.title ?? ""} ${task.project ?? ""} ${task.agentLabel ?? ""}`
      .toLowerCase().includes(filter);
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
    task.runtimeLabel
      ? el("span", {
        class: "task-runtime",
        text: task.runtimeLabel,
        title: task.runtimeTitle || task.runtimeLabel,
      })
      : null,
    task.statusLabel
      ? el("span", { class: "task-status", "data-status": task.status || "", text: task.statusLabel })
      : null,
  ]);

  const time = el("span", {
    class: "task-time",
    text: formatRelativeTime(task.lastActivity),
    title: task.lastActivity ? new Date(task.lastActivity).toLocaleString("ru-RU") : "",
  });

  const titleRow = el("div", { class: "task-title-row" }, [
    el("span", { class: "task-title", text: task.title || "Без названия" }),
    time,
  ]);

  const footer = el("div", { class: "task-footer" }, [
    meta,
    task.unread ? el("span", { class: "task-unread", title: "Есть непрочитанный ответ" }) : null,
  ]);

  const body = el("div", { class: "task-body" }, [titleRow, footer]);
  item.append(dot, body);
  return item;
}

taskList.addEventListener("click", (event) => {
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
taskFilter.addEventListener("input", renderTasks);

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
    return;
  }
  const taskChanged = activeChatId !== task.id;

  chatTitle.textContent = task.title || "Без названия";
  chatProviderDot.dataset.provider = String(task.provider ?? "none");
  chatProviderDot.setAttribute("data-provider", String(task.provider ?? "none"));
  chatSubtitle.replaceChildren(...buildSubtitleChips(task));
  chatRunning.hidden = !task.running;
  chatStop.hidden = !task.running;

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

function buildSubtitleChips(task) {
  const parts = [
    task.agentLabel || providerLabels[task.provider] || null,
    task.modelLabel || null,
    task.reasoningLabel || null,
    task.modeLabel || null,
    task.runtimeLabel || null,
    task.project || null,
  ].filter(Boolean);
  return parts.map((part, index) =>
    el("span", { class: "chat-chip", "data-order": index, text: part }));
}

function chatIsNearBottom() {
  return chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 120;
}

function pinChatToBottom() {
  const apply = () => { chatScroll.scrollTop = chatScroll.scrollHeight; };
  apply();
  window.requestAnimationFrame(apply);
}

function renderMessages({ forceBottom = false } = {}) {
  const stickToBottom = forceBottom || chatIsNearBottom();
  const historyLoaded = state.messages.has(state.selectedId);
  const messages = state.messages.get(state.selectedId) ?? [];
  chatLog.replaceChildren();
  if (messages.length === 0) {
    chatLog.append(el("p", {
      class: "chat-log-empty",
      text: historyLoaded
        ? "История пуста. Отправьте первое сообщение агенту."
        : "Загрузка истории…",
    }));
    if (stickToBottom) pinChatToBottom();
    return;
  }
  for (const message of messages) chatLog.append(renderMessage(message));
  if (stickToBottom) pinChatToBottom();
}

function renderMessage(message) {
  const role = message.role === "user" ? "user" : message.role === "system" ? "system" : "agent";
  const article = el("article", {
    class: `msg msg-${role}`,
    "data-role": role,
    "data-message-id": message.id ?? "",
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

  const body = el("div", { class: "msg-body" });
  // Текст сообщений — только textContent: данные приходят от агента и могут
  // содержать любые символы, поэтому HTML не интерпретируется.
  body.textContent = message.text ?? "";

  article.append(head, body);

  if (Array.isArray(message.attachments) && message.attachments.length > 0) {
    article.append(renderAttachmentStrip(message.attachments, { readOnly: true }));
  }

  if (role === "agent") {
    const actions = el("div", { class: "msg-actions" }, [
      el("button", {
        type: "button", class: "msg-action", "data-action": "tts", "data-message-id": message.id ?? "",
        title: "Озвучить ответ", "aria-label": "Озвучить ответ",
        html: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
          + ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
          + '<path d="M5 9.5v5h3l4 3.5V6L8 9.5z"></path>'
          + '<path d="M15.5 9a4 4 0 0 1 0 6"></path></svg>',
      }),
    ]);
    article.append(actions);
  }
  return article;
}

function renderLive() {
  const live = state.live.get(state.selectedId);
  if (!live) {
    chatLive.hidden = true;
    return;
  }
  chatLive.hidden = false;
  chatLive.querySelector("[data-live-author]").textContent = live.author || "Агент";
  chatLive.querySelector("[data-live-stage]").textContent = live.stage || "";
  const reasoning = chatLive.querySelector("[data-live-reasoning]");
  reasoning.textContent = live.reasoning || "";
  reasoning.hidden = !live.reasoning;
  chatLive.querySelector("[data-live-body]").textContent = live.text || "";
  scrollChatToBottom();
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
  const queued = state.queue.get(state.selectedId) ?? [];
  queueBox.replaceChildren();
  queueBox.hidden = queued.length === 0;
  if (queued.length === 0) return;
  queueBox.append(el("div", { class: "queue-head", text: `Отложено: ${queued.length}` }));
  for (const entry of queued) {
    const actions = [];
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
      el("span", { class: "queue-actions" }, actions),
    ]));
  }
}

/* ============================================================== композер */

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
});

composerInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
  event.preventDefault();
  submitComposer();
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
  const requestId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  pendingComposerRequest = {
    requestId,
    taskId: state.selectedId,
    rawText,
    attachments,
    annotations,
  };
  emit("message:send", {
    requestId,
    taskId: state.selectedId,
    text,
    annotations,
    attachments,
  });
  updateSendState();
  saveDraft();
}

function sameItems(current, original) {
  return current.length === original.length
    && current.every((item, index) => item === original[index]);
}

function completeComposerSend(requestId, accepted) {
  const pending = pendingComposerRequest;
  if (!pending || pending.requestId !== requestId) return;
  pendingComposerRequest = null;
  if (accepted) {
    const draft = drafts.get(pending.taskId);
    const unchanged = draft
      && draft.text === pending.rawText
      && sameItems(draft.attachments ?? [], pending.attachments)
      && sameItems(draft.annotations ?? [], pending.annotations);
    if (unchanged) {
      drafts.set(pending.taskId, { text: "", attachments: [], annotations: [] });
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
    const thumb = el("div", { class: "attachment", title: item.name || "" }, [
      el("img", { src: item.dataUrl || item.url || "", alt: item.name || "вложение", loading: "lazy" }),
    ]);
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
      el("span", { class: "annotation-quote", text: annotation.quote }),
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

document.addEventListener("selectionchange", () => {
  annotateButton.disabled = selectedAgentText().length === 0;
});

annotateButton.addEventListener("click", () => {
  const quote = selectedAgentText();
  if (!quote) {
    showToast("Выделите фрагмент ответа агента.");
    return;
  }
  const trimmed = quote.length > 400 ? `${quote.slice(0, 400)}…` : quote;
  setAnnotations([...annotations, { quote: trimmed }]);
  window.getSelection()?.removeAllRanges();
  annotateButton.disabled = true;
  composerInput.focus();
  saveDraft();
});

/* ---- черновики ---- */

function saveDraft() {
  if (!state.selectedId) return;
  drafts.set(state.selectedId, {
    text: composerInput.value,
    attachments: attachments.slice(),
    annotations: annotations.slice(),
  });
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

function openPanel() {
  settingsPanel.hidden = false;
  panelScrim.hidden = false;
  requestAnimationFrame(() => {
    settingsPanel.classList.add("open");
    panelScrim.classList.add("open");
  });
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
  for (const [group, values] of Object.entries(state.options)) {
    const container = settingsPanel.querySelector(`[data-options='${group}']`);
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
  for (const toggle of settingsPanel.querySelectorAll("[data-toggle]")) {
    toggle.checked = Boolean(state.selection[toggle.dataset.toggle]);
  }
}

settingsPanel.addEventListener("click", (event) => {
  const chip = event.target.closest("[data-select-group]");
  if (!chip) return;
  const group = chip.dataset.selectGroup;
  const value = chip.dataset.selectValue;
  state.selection[group] = value;
  renderOptions();
  emit("selection:set", { key: group, value });
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

/* ================================================= диалог ввода текста */

let dialogResolve = null;

function askText({ title, value = "" }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogTitle.textContent = title;
    dialogInput.value = value;
    dialog.hidden = false;
    dialogScrim.hidden = false;
    requestAnimationFrame(() => dialogInput.focus());
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
  closeDialog(dialogInput.value.trim());
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
  const taskId = state.selectedId;
  switch (action) {
    case "task-new": {
      const title = await askText({ title: "Название новой задачи" });
      if (title != null) emit("task:new", { title });
      break;
    }
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
    case "tts":
      emit("tts:play", { taskId, messageId: trigger.dataset.messageId });
      break;
    case "hub-restart":
      emit("hub:restart", {});
      showToast("Перезапуск Agent Hub запрошен.");
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
  /** Состояние соединения: "online" | "connecting" | "restarting" | "offline". */
  setConnection(status) {
    const value = ["online", "connecting", "restarting", "offline"].includes(status) ? status : "offline";
    if (state.connection === value) return;
    state.connection = value;
    root.dataset.connection = value;
    const messages = {
      connecting: "Подключение к Agent Hub…",
      restarting: "Agent Hub перезапускается… Сообщение останется в поле ввода.",
      offline: "Нет связи с Agent Hub. Неотправленное сообщение сохранено в поле ввода.",
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
    state.messages.set(taskId, Array.isArray(messages) ? messages.slice() : []);
    if (taskId === state.selectedId) renderMessages({ forceBottom: true });
  },
  appendMessage(taskId, message) {
    const list = state.messages.get(taskId) ?? [];
    list.push(message);
    state.messages.set(taskId, list);
    if (taskId === state.selectedId) renderMessages({ forceBottom: true });
  },
  patchMessage(taskId, messageId, patch) {
    const list = state.messages.get(taskId) ?? [];
    const message = list.find((item) => item.id === messageId);
    if (!message) return;
    Object.assign(message, patch);
    if (taskId === state.selectedId) renderMessages();
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
  /** Списки вариантов для селекторов: { agent, model, reasoning, mode,
   *  project }. Значение — строка или { value, label }. */
  setOptions(options) {
    const next = { ...state.options, ...options };
    if (sameData(state.options, next)) return;
    state.options = next;
    renderOptions();
  },
  /** Текущий выбор: { agent, model, reasoning, mode, project, autoApprove,
   *  tts }. */
  setSelection(selection) {
    const next = { ...state.selection, ...selection };
    if (sameData(state.selection, next)) return;
    state.selection = next;
    renderOptions();
    if (state.selectedId) renderChat();
  },
  /** Сводка статуса/лимитов для панели: { rows: [{ name, value }] }. */
  setStatus(status) {
    state.status = status ?? null;
    renderStatus();
  },
  toast: showToast,
};

window.AgentHub = AgentHub;

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
}

/* Лимиты приходят первым блоком журнала, но место им — в шапке. */
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

function disableLocalLinks(scope = journal) {
  for (const link of scope.querySelectorAll("a")) {
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
        const openState = journalRendered ? captureOpenState() : storedOpenState();
        journal.innerHTML = payload.html;
        hoistRateLimits();
        disableLocalLinks();
        syncCollapseTurnButtons();
        prepareMobileControls();
        if (openState) restoreOpenState(openState);
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

/* Обновления журнала: в Telegram — опрос, в браузере/VS Code — SSE. Загрузка
 * начинается только после первого открытия вкладки журнала. */
if (telegramMode) {
  const polling = setInterval(() => {
    if (journalRequested) void loadJournal();
  }, 5_000);
  window.addEventListener("pagehide", () => clearInterval(polling), { once: true });
} else if (!vscodeMode) {
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
    if (event.data?.type === "agenthub:journal-changed" && journalRequested) {
      void loadJournal({ force: event.data.force === true });
    }
    if (event.data?.type === "theme") applyTheme(event.data.theme);
  });
}

/* ------------------------------------------------------------- инициализация */

AgentHub.setConnection(telegramMode ? "online" : "connecting");
renderTasks();
renderChat();
renderOptions();
setView("chat");
setPane("tasks");
autosizeComposer();
