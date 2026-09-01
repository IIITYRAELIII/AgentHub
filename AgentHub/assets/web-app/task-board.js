"use strict";

(() => {
  function fitTaskCardWidth({ baseWidth, maxWidth, maxHeight, measureHeight } = {}) {
    const minimum = Math.max(1, Math.ceil(Number(baseWidth) || 0));
    const maximum = Math.max(minimum, Math.floor(Number(maxWidth) || minimum));
    const heightLimit = Math.max(1, Number(maxHeight) || 0);
    if (typeof measureHeight !== "function" || measureHeight(minimum) <= heightLimit) return minimum;
    if (measureHeight(maximum) > heightLimit) return maximum;

    let lower = minimum;
    let upper = maximum;
    while (upper - lower > 1) {
      const candidate = Math.floor((lower + upper) / 2);
      if (measureHeight(candidate) <= heightLimit) upper = candidate;
      else lower = candidate;
    }
    return upper;
  }

  function fitTaskCardHeight({ contentHeight, maxHeight } = {}) {
    const maximum = Math.max(1, Math.floor(Number(maxHeight) || 0));
    return Math.min(maximum, Math.max(1, Math.ceil(Number(contentHeight) || 0)));
  }

  window.AgentHubTaskCardSizing = Object.freeze({
    fitHeight: fitTaskCardHeight,
    fitWidth: fitTaskCardWidth,
  });

  function createAutoGrowTextarea({ textarea, getStyle = (element) => window.getComputedStyle(element) } = {}) {
    function resize() {
      if (!textarea) return 0;
      textarea.style.height = "auto";
      const style = getStyle(textarea);
      const height = Math.max(0, Math.ceil(
        (Number(textarea.scrollHeight) || 0)
        + numericCssValue(style?.borderTopWidth)
        + numericCssValue(style?.borderBottomWidth),
      ));
      textarea.style.height = `${height}px`;
      return height;
    }

    textarea?.addEventListener("input", resize);
    resize();
    return Object.freeze({ resize });
  }

  window.AgentHubTaskCardEditor = Object.freeze({ createAutoGrowTextarea });

  function createDeleteDialog({ dialog, cancelButton, confirmButton, onConfirm } = {}) {
    let pendingTaskId = null;

    function close() {
      pendingTaskId = null;
      if (dialog?.open) dialog.close?.();
      dialog?.removeAttribute?.("open");
    }

    function request(taskId) {
      pendingTaskId = taskId ?? null;
      if (pendingTaskId == null || !dialog) return;
      dialog.showModal?.();
      if (!dialog.open) dialog.setAttribute?.("open", "");
    }

    cancelButton?.addEventListener("click", close);
    confirmButton?.addEventListener("click", () => {
      const taskId = pendingTaskId;
      if (taskId == null) return;
      close();
      onConfirm?.(taskId);
    });
    dialog?.addEventListener("cancel", (event) => {
      event.preventDefault();
      close();
    });

    return Object.freeze({ request, close });
  }

  window.AgentHubTaskDeleteDialog = Object.freeze({ create: createDeleteDialog });

  function completedAtMs(task) {
    const value = Date.parse(String(task?.completedAt ?? ""));
    return Number.isFinite(value) ? value : 0;
  }

  const TASK_WORKFLOW_STATUSES = Object.freeze([
    "new", "in_progress", "testing", "awaiting_implementation", "done",
  ]);
  const TASK_STATUS_PRESENTATION = Object.freeze({
    en: Object.freeze({
      new: Object.freeze({ short: "New", full: "New" }),
      in_progress: Object.freeze({ short: "InProg", full: "In progress" }),
      testing: Object.freeze({ short: "Test", full: "Testing" }),
      awaiting_implementation: Object.freeze({ short: "Await", full: "Awaiting implementation" }),
      done: Object.freeze({ short: "Done", full: "Done" }),
    }),
    ru: Object.freeze({
      new: Object.freeze({ short: "Новая", full: "Новая" }),
      in_progress: Object.freeze({ short: "ВРаботе", full: "В работе" }),
      testing: Object.freeze({ short: "Тест", full: "Тестируется" }),
      awaiting_implementation: Object.freeze({ short: "Прим", full: "К применению" }),
      done: Object.freeze({ short: "Готово", full: "Готово" }),
    }),
  });
  const TASK_STATUS_LANGUAGE_STORAGE_KEY = "agent-hub.task-status-language";

  function normalizedTaskStatusLanguage(value) {
    return value === "ru" ? "ru" : "en";
  }

  function taskWorkflowStatus(task) {
    const explicit = String(task?.workflowStatus ?? "").trim().toLowerCase();
    if (TASK_WORKFLOW_STATUSES.includes(explicit)) return explicit;
    if (task?.status === "done") return "done";
    if (["starting", "started"].includes(task?.status)) return "in_progress";
    return "new";
  }

  function taskWorkflowPresentation(task, language = "en") {
    const status = taskWorkflowStatus(task);
    return { status, ...TASK_STATUS_PRESENTATION[normalizedTaskStatusLanguage(language)][status] };
  }

  function syncTaskStatusControl(control, task, language = "en", { pending = false } = {}) {
    if (!control) return { optionsChanged: false, statusChanged: false };
    const presentation = TASK_STATUS_PRESENTATION[normalizedTaskStatusLanguage(language)];
    const desiredOptions = TASK_WORKFLOW_STATUSES.map((status) => ({
      value: status,
      text: presentation[status].full,
    }));
    const currentOptions = Array.from(control.options ?? [], (option) => ({
      value: String(option.value ?? ""),
      text: String(option.textContent ?? option.text ?? ""),
    }));
    const optionsChanged = !sameSnapshotValue(currentOptions, desiredOptions);
    if (optionsChanged) {
      control.replaceChildren(...desiredOptions.map(({ value, text }) => {
        const option = control.ownerDocument.createElement("option");
        option.value = value;
        option.textContent = text;
        return option;
      }));
    }
    const status = taskWorkflowStatus(task);
    const statusChanged = !pending && control.value !== status;
    if (statusChanged) control.value = status;
    return { optionsChanged, statusChanged };
  }

  function storedTaskStatusLanguage() {
    try {
      return normalizedTaskStatusLanguage(window.localStorage?.getItem(TASK_STATUS_LANGUAGE_STORAGE_KEY));
    } catch {
      return "en";
    }
  }

  function tasksForMode(tasks, { completedOnly = false } = {}) {
    const source = Array.isArray(tasks) ? tasks : [];
    if (!completedOnly) return source.filter((task) => task?.status !== "done");
    return source
      .filter((task) => task?.status === "done")
      .map((task, index) => ({ task, index }))
      .sort((left, right) => completedAtMs(left.task) - completedAtMs(right.task)
        || left.index - right.index)
      .map(({ task }) => task);
  }

  function workspaceTasksForPanel(tasks, workspaceId) {
    const normalizedWorkspaceId = String(workspaceId ?? "").trim();
    if (!normalizedWorkspaceId) return [];
    return (Array.isArray(tasks) ? tasks : []).filter((task) => (
      task?.status !== "done"
      && task?.bucket === "workspace"
      && task?.workspaceId === normalizedWorkspaceId
    ));
  }

  function workspaceTaskSectionsForPanel(tasks, workspaceId, streamId) {
    const workspaceTasks = workspaceTasksForPanel(tasks, workspaceId);
    const normalizedStreamId = String(streamId ?? "").trim();
    if (!normalizedStreamId) {
      return Object.freeze({
        streamTasks: [],
        workspaceTasks,
        total: workspaceTasks.length,
      });
    }
    const streamTasks = workspaceTasks.filter((task) => (
      String(task?.streamId ?? "").trim() === normalizedStreamId
    ));
    const remainingWorkspaceTasks = workspaceTasks.filter((task) => (
      String(task?.streamId ?? "").trim() !== normalizedStreamId
    ));
    return Object.freeze({
      streamTasks,
      workspaceTasks: remainingWorkspaceTasks,
      total: workspaceTasks.length,
    });
  }

  function sameSnapshotValue(left, right) {
    if (Object.is(left, right)) return true;
    try {
      return JSON.stringify(left) === JSON.stringify(right);
    } catch {
      return false;
    }
  }

  function taskBoardSnapshotChanges(current = {}, payload = {}, { initialized = true } = {}) {
    const next = {
      tasks: Array.isArray(payload.tasks) ? payload.tasks.slice() : [],
      workspaces: Array.isArray(payload.workspaces) ? payload.workspaces.slice() : [],
      columnOrder: Array.isArray(payload.columnOrder) ? payload.columnOrder.slice() : [],
      notesComment: String(payload.notesComment ?? ""),
      selectedWorkspaceId: payload.selectedWorkspaceId ?? null,
      selectedStreamId: payload.selectedStreamId ?? null,
      provider: payload.provider === "claude" ? "claude" : "codex",
      conversations: Array.isArray(payload.conversations) ? payload.conversations.slice() : [],
      deferredInputs: Array.isArray(payload.deferredInputs) ? payload.deferredInputs.slice() : [],
    };
    const tasksChanged = !sameSnapshotValue(current.tasks ?? [], next.tasks);
    const workspacesChanged = !sameSnapshotValue(current.workspaces ?? [], next.workspaces);
    const boardChanged = !initialized
      || tasksChanged
      || workspacesChanged
      || !sameSnapshotValue(current.columnOrder ?? [], next.columnOrder)
      || String(current.notesComment ?? "") !== next.notesComment;
    return {
      next,
      boardChanged,
      panelChanged: !initialized
        || tasksChanged
        || workspacesChanged
        || (current.selectedWorkspaceId ?? null) !== next.selectedWorkspaceId
        || (current.selectedStreamId ?? null) !== next.selectedStreamId,
      openTaskChanged: !initialized || tasksChanged,
    };
  }

  function streamAvailability(stream, conversations = [], deferredInputs = []) {
    const streamId = String(stream?.id ?? "").trim();
    const threadKeys = new Set((stream?.threads ?? []).map((thread) => (
      `${String(thread?.provider ?? "").trim()}\0${String(thread?.threadId ?? "").trim()}`
    )));
    const activeRuns = (Array.isArray(conversations) ? conversations : []).filter((conversation) => (
      conversation?.running === true && String(conversation?.streamId ?? "").trim() === streamId
    ));
    const queuedInputs = (Array.isArray(deferredInputs) ? deferredInputs : []).filter((input) => (
      String(input?.streamId ?? "").trim() === streamId
      || threadKeys.has(`${String(input?.provider ?? "").trim()}\0${String(input?.threadId ?? "").trim()}`)
    ));
    return Object.freeze({
      active: activeRuns.length > 0,
      activeRunCount: activeRuns.length,
      queuedInputCount: queuedInputs.length,
      free: activeRuns.length === 0 && queuedInputs.length === 0,
    });
  }

  function taskStartActionLabels(task) {
    const reassigning = task?.status === "started";
    return Object.freeze({
      eyebrow: reassigning ? "Переназначить Task" : "Начать работу",
      newStreamSubmit: reassigning ? "Создать Stream и переназначить" : "Создать Stream и начать",
    });
  }

  function taskAttachmentCountLabel(attachments) {
    const count = Array.isArray(attachments) ? attachments.length : 0;
    return count ? `${count} вложений` : "";
  }

  function taskAttachmentFiles(files, { limit = 8, maxBytes = 20 * 1024 * 1024 } = {}) {
    const selected = [...(files ?? [])].filter((file) => file && Number(file.size) > 0);
    return {
      accepted: selected.slice(0, limit).filter((file) => Number(file.size) <= maxBytes),
      oversized: selected.slice(0, limit).filter((file) => Number(file.size) > maxBytes).length,
      truncated: Math.max(0, selected.length - limit),
    };
  }

  function taskPresentationUpdate(task, { title = "", description = "" } = {}) {
    return {
      id: String(task?.id ?? "").trim(),
      title: String(title ?? "").trim(),
      description: String(description ?? "").trim(),
    };
  }

  function createTaskReferenceOpenHandler({ getTasks, openTask } = {}) {
    return (event) => {
      const taskId = String(event?.detail?.taskId ?? "");
      const task = (getTasks?.() ?? []).find((item) => item.id === taskId);
      if (!task) return false;
      openTask?.(task);
      return true;
    };
  }

  function taskExecutorPresentation(task, workspaces = []) {
    const workspaceId = String(task?.workspaceId ?? "").trim();
    const streamId = String(task?.streamId ?? "").trim();
    const workspace = (Array.isArray(workspaces) ? workspaces : [])
      .find((candidate) => String(candidate?.id ?? "") === workspaceId);
    if (!workspace) return { label: "Не назначен", workspace: null, stream: null };
    const workspaceName = String(workspace.name ?? workspaceId).trim() || workspaceId;
    const stream = (Array.isArray(workspace.streams) ? workspace.streams : [])
      .find((candidate) => String(candidate?.id ?? "") === streamId);
    if (!stream) return { label: `${workspaceName} — Stream не назначен`, workspace, stream: null };
    const streamName = String(stream.displayName ?? stream.name ?? "").trim()
      || `Stream ${Number(stream.ordinal) || ""}`.trim();
    return { label: `${workspaceName} — ${streamName}`, workspace, stream };
  }

  function taskExecutorStreamName(task, workspaces = []) {
    const presentation = taskExecutorPresentation(task, workspaces);
    if (!presentation.stream) return "Не назначен";
    return String(presentation.stream.displayName ?? presentation.stream.name ?? "").trim()
      || `Stream ${Number(presentation.stream.ordinal) || ""}`.trim();
  }

  function taskChangedFileGroups(task) {
    const groups = new Map();
    for (const item of Array.isArray(task?.changedFiles) ? task.changedFiles : []) {
      const projectRoot = String(item?.projectRoot ?? "").trim();
      const filePath = String(item?.path ?? "").trim();
      const operation = String(item?.operation ?? "").trim();
      if (!projectRoot || !filePath || !["added", "modified", "deleted"].includes(operation)) continue;
      if (!groups.has(projectRoot)) groups.set(projectRoot, []);
      groups.get(projectRoot).push({
        projectRoot,
        path: filePath,
        operation,
        turnId: String(item?.turnId ?? "").trim() || null,
      });
    }
    return Array.from(groups, ([projectRoot, files]) => ({ projectRoot, files }));
  }

  function taskWorkLogEntries(task) {
    return (Array.isArray(task?.workLog) ? task.workLog : []).flatMap((entry) => {
      const summary = String(entry?.summary ?? "").trim();
      const provider = String(entry?.provider ?? "").trim();
      const status = String(entry?.status ?? "").trim();
      const turnId = String(entry?.turnId ?? "").trim();
      const createdAt = String(entry?.createdAt ?? "").trim();
      if (!summary && !provider && !status && !turnId) return [];
      return [{
        summary,
        provider,
        status,
        turnId,
        createdAt,
        changedFileCount: Array.isArray(entry?.changedFiles) ? entry.changedFiles.length : 0,
      }];
    });
  }

  function changedFileOperationLabel(operation) {
    return ({ added: "Добавлен", modified: "Изменён", deleted: "Удалён" })[operation] ?? operation;
  }

  function taskWorkLogStatusLabel(status) {
    return ({
      completed: "Завершён",
      interrupted: "Прерван",
      failed: "Ошибка",
      running: "Выполняется",
    })[status] ?? status ?? "Неизвестно";
  }

  function taskWorkLogTimeLabel(value) {
    const timestamp = Date.parse(String(value ?? ""));
    if (!Number.isFinite(timestamp)) return "";
    return new Date(timestamp).toLocaleString("ru-RU", {
      dateStyle: "short",
      timeStyle: "short",
    });
  }

  function taskChangedFileCountLabel(count) {
    const value = Math.max(0, Number(count) || 0);
    const mod100 = value % 100;
    const mod10 = value % 10;
    const noun = mod100 >= 11 && mod100 <= 14
      ? "файлов"
      : (mod10 === 1 ? "файл" : (mod10 >= 2 && mod10 <= 4 ? "файла" : "файлов"));
    return `${value} ${noun}`;
  }

  function orderedDashboardColumnIds(columnOrder = [], availableColumnIds = []) {
    const available = new Set(availableColumnIds);
    const result = [];
    if (available.has("backlog")) result.push("backlog");
    for (const id of columnOrder) {
      if (id === "backlog" || id === "notes" || !available.has(id) || result.includes(id)) continue;
      result.push(id);
    }
    for (const id of available) {
      if (id === "backlog" || id === "notes" || result.includes(id)) continue;
      result.push(id);
    }
    if (available.has("notes")) result.push("notes");
    return result;
  }

  function replaceBoardColumnsPreservingScroll(container, columnNodes) {
    const scrollLeft = Math.max(0, Number(container?.scrollLeft) || 0);
    container.replaceChildren(...columnNodes);
    container.scrollLeft = scrollLeft;
  }

  function replaceBoardColumnRegionsPreservingScroll(regions, orderedIds, renderedColumns) {
    const backlog = renderedColumns.get("backlog");
    const notes = renderedColumns.get("notes");
    const workspaceColumns = orderedIds
      .filter((id) => id !== "backlog" && id !== "notes")
      .map((id) => renderedColumns.get(id))
      .filter(Boolean);
    regions.backlog.replaceChildren(...(backlog ? [backlog] : []));
    replaceBoardColumnsPreservingScroll(regions.workspaces, workspaceColumns);
    regions.notes.replaceChildren(...(notes ? [notes] : []));
  }

  window.AgentHubTaskBoardView = Object.freeze({
    createTaskReferenceOpenHandler,
    normalizedTaskStatusLanguage,
    orderedDashboardColumnIds,
    replaceBoardColumnRegionsPreservingScroll,
    replaceBoardColumnsPreservingScroll,
    taskBoardSnapshotChanges,
    taskAttachmentCountLabel,
    taskAttachmentFiles,
    taskChangedFileGroups,
    taskExecutorPresentation,
    taskExecutorStreamName,
    taskPresentationUpdate,
    taskSummaryItems,
    taskWorkLogEntries,
    syncTaskStatusControl,
    taskWorkflowPresentation,
    streamAvailability,
    taskStartActionLabels,
    tasksForMode,
    workspaceTaskSectionsForPanel,
    workspaceTasksForPanel,
  });

  const board = document.querySelector("[data-task-board]");
  const columns = document.querySelector("[data-task-board-columns]");
  const completedToggle = document.querySelector("[data-task-board-completed-toggle]");
  const statusLanguageButtons = Array.from(document.querySelectorAll?.("[data-task-status-language]") ?? []);
  const workspacePanel = document.querySelector("[data-workspace-task-panel]");
  const streamPanelList = document.querySelector("[data-stream-task-list]");
  const workspacePanelList = document.querySelector("[data-workspace-task-list]");
  const activityTaskHeading = document.querySelector("[data-activity-task-heading]");
  const taskCardModal = document.querySelector("[data-task-card-modal]");
  const taskCardSource = document.querySelector("[data-task-card-source]");
  const taskCardEditor = document.querySelector("[data-task-card-editor]");
  const taskCardNumber = document.querySelector("[data-task-card-number]");
  const taskCardTitle = document.querySelector("[data-task-card-title]");
  const taskCardDescription = document.querySelector("[data-task-card-description]");
  const taskCardTitleSizer = createAutoGrowTextarea({ textarea: taskCardTitle });
  const taskCardDescriptionSizer = createAutoGrowTextarea({ textarea: taskCardDescription });
  const taskCardContent = document.querySelector(".task-card-content");
  const taskCardSaveButton = taskCardEditor?.querySelector("button[type='submit']");
  const taskCardAttachments = document.querySelector("[data-task-card-attachments]");
  const taskCardAttachmentAdd = document.querySelector("[data-task-card-attachment-add]");
  const taskCardAttachmentInput = document.querySelector("[data-task-card-attachment-input]");
  const taskCardAttachmentHint = document.querySelector("[data-task-card-attachment-hint]");
  const taskCardExecutor = document.querySelector("[data-task-card-executor]");
  const taskCardChangedFiles = document.querySelector("[data-task-card-changed-files]");
  const taskCardChangedFileGroups = document.querySelector("[data-task-card-changed-file-groups]");
  const taskCardWorkLog = document.querySelector("[data-task-card-work-log]");
  const taskCardWorkLogEntries = document.querySelector("[data-task-card-work-log-entries]");
  const taskCardStatus = document.querySelector("[data-task-card-status]");
  const taskCardOriginal = document.querySelector("[data-task-card-original]");
  const taskCardOriginalToggle = document.querySelector("[data-task-card-original-toggle]");
  const taskCardOriginalText = document.querySelector("[data-task-card-original-text]");
  const taskCardActions = document.querySelector("[data-task-card-actions]");
  const taskDeleteModal = document.querySelector("[data-task-delete-modal]");
  const taskDeleteCancel = document.querySelector("[data-task-delete-cancel]");
  const taskDeleteConfirm = document.querySelector("[data-task-delete-confirm]");
  const startModal = document.querySelector("[data-task-start-modal]");
  const startEyebrow = document.querySelector("[data-task-start-eyebrow]");
  const startTitle = document.querySelector("[data-task-start-title]");
  const startOptions = document.querySelector("[data-task-start-options]");
  const startNewForm = document.querySelector("[data-task-start-new]");
  const startNewName = document.querySelector("[data-task-start-new-name]");
  const startProvider = document.querySelector("[data-task-start-provider]");
  const startSubmit = document.querySelector("[data-task-start-submit]");
  if (!board || !columns) return;

  const boardColumnRegions = {
    backlog: node("div", {
      class: "task-board-edge is-backlog-edge",
      "data-task-board-backlog": "",
    }),
    workspaces: node("div", {
      class: "task-board-workspace-columns",
      "data-task-board-workspace-columns": "",
    }),
    notes: node("div", {
      class: "task-board-edge is-notes-edge",
      "data-task-board-notes": "",
    }),
  };
  columns.replaceChildren(
    boardColumnRegions.backlog,
    boardColumnRegions.workspaces,
    boardColumnRegions.notes,
  );

  const TaskReferences = window.AgentHubTaskReferences;
  const COLUMN_MIME = "application/x-agent-hub-board-column";
  const COLUMN_TEXT_PREFIX = "agent-hub-column:";
  const TASK_CARD_MODAL_BASE_WIDTH_REM = 34;
  const TASK_CARD_MODAL_MAX_WIDTH_REM = 64;
  const TASK_CARD_MODAL_MAX_HEIGHT_REM = 56;
  const TASK_CARD_MODAL_VIEWPORT_GAP_PX = 32;
  let taskCardEditorSizingFrame = null;

  const state = {
    tasks: [],
    workspaces: [],
    columnOrder: [],
    notesComment: "",
    selectedWorkspaceId: null,
    selectedStreamId: null,
    provider: "codex",
    conversations: [],
    deferredInputs: [],
    statusLanguage: storedTaskStatusLanguage(),
    completedOnly: false,
    openTaskId: null,
    startingTaskId: null,
    creatingWorkspaceId: null,
    draggingColumnId: null,
    editingTaskId: null,
    editDirty: false,
    savingTaskId: null,
    savingStatusTaskId: null,
    attachingTaskId: null,
    removingTaskId: null,
    snapshotInitialized: false,
  };
  const taskDeleteDialog = createDeleteDialog({
    dialog: taskDeleteModal,
    cancelButton: taskDeleteCancel,
    confirmButton: taskDeleteConfirm,
    onConfirm: (id) => {
      if (state.removingTaskId != null) return;
      state.removingTaskId = id;
      renderOpenTaskCard();
      emit("remove", { id });
    },
  });

  function node(tag, attributes = {}, children = []) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name === "class") element.className = value;
      else if (name === "text") element.textContent = value;
      else if (name.startsWith("on") && typeof value === "function") {
        element.addEventListener(name.slice(2).toLowerCase(), value);
      } else if (value != null) element.setAttribute(name, String(value));
    }
    for (const child of children) element.append(child);
    return element;
  }

  function numericCssValue(value) {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function resizeTaskCardEditor() {
    taskCardEditorSizingFrame = null;
    if (!taskCardModal?.open || !taskCardContent) return;
    taskCardModal.style.removeProperty("inline-size");
    taskCardModal.style.removeProperty("block-size");
    taskCardModal.removeAttribute("data-width-expanded");
    taskCardTitleSizer.resize();
    taskCardDescriptionSizer.resize();

    const rootFontSize = numericCssValue(window.getComputedStyle(document.documentElement).fontSize) || 16;
    const viewportWidth = Math.max(1, document.documentElement.clientWidth || window.innerWidth);
    const viewportHeight = Math.max(1, document.documentElement.clientHeight || window.innerHeight);
    const availableWidth = Math.max(1, viewportWidth - TASK_CARD_MODAL_VIEWPORT_GAP_PX);
    const baseWidth = Math.min(
      TASK_CARD_MODAL_BASE_WIDTH_REM * rootFontSize,
      availableWidth,
    );
    const maxWidth = Math.max(baseWidth, Math.min(
      TASK_CARD_MODAL_MAX_WIDTH_REM * rootFontSize,
      availableWidth,
    ));
    const maxHeight = Math.max(1, Math.min(
      TASK_CARD_MODAL_MAX_HEIGHT_REM * rootFontSize,
      viewportHeight - TASK_CARD_MODAL_VIEWPORT_GAP_PX,
    ));
    const header = taskCardModal.querySelector(":scope > header");
    const footer = taskCardModal.querySelector(":scope > footer");
    const modalStyle = window.getComputedStyle(taskCardModal);
    const modalBorders = numericCssValue(modalStyle.borderTopWidth)
      + numericCssValue(modalStyle.borderBottomWidth);
    const measureHeight = (width) => {
      taskCardModal.style.setProperty("inline-size", `${width}px`);
      taskCardTitleSizer.resize();
      taskCardDescriptionSizer.resize();
      return (header?.offsetHeight ?? 0)
        + taskCardContent.scrollHeight
        + (footer?.offsetHeight ?? 0)
        + modalBorders;
    };
    const desiredWidth = fitTaskCardWidth({ baseWidth, maxWidth, maxHeight, measureHeight });
    const desiredHeight = fitTaskCardHeight({
      contentHeight: measureHeight(desiredWidth),
      maxHeight,
    });
    taskCardModal.style.setProperty("inline-size", `${desiredWidth}px`);
    taskCardModal.style.setProperty("block-size", `${desiredHeight}px`);
    if (desiredWidth > baseWidth + 1) taskCardModal.setAttribute("data-width-expanded", "");
    taskCardTitleSizer.resize();
    taskCardDescriptionSizer.resize();
  }

  function scheduleTaskCardEditorSizing() {
    if (taskCardEditorSizingFrame != null) window.cancelAnimationFrame(taskCardEditorSizingFrame);
    taskCardEditorSizingFrame = window.requestAnimationFrame(resizeTaskCardEditor);
  }

  function emit(type, detail = {}) {
    document.dispatchEvent(new CustomEvent("agenthub:board-action", {
      detail: { type, ...detail },
    }));
  }

  function openAttachment(event, attachment, gallery, index) {
    event.preventDefault();
    event.stopPropagation();
    document.dispatchEvent(new CustomEvent("agenthub:attachment-open", {
      detail: { attachment, gallery, index },
    }));
  }

  function attachmentStrip(attachments, { compact = false } = {}) {
    const values = Array.isArray(attachments) ? attachments : [];
    const strip = node("div", { class: `board-task-attachments${compact ? " is-compact" : ""}` });
    const gallery = values.filter((attachment) => (
      attachment?.isImage || String(attachment?.type ?? "").toLowerCase().startsWith("image/")
    ));
    for (const attachment of values) {
      const image = attachment?.isImage || String(attachment?.type ?? "").toLowerCase().startsWith("image/");
      const preview = image && attachment?.url
        ? node("img", { src: attachment.url, alt: attachment.name || "Скриншот", loading: "lazy" })
        : node("span", { text: image ? "Скриншот" : (attachment?.name || "Вложение") });
      strip.append(node("button", {
        type: "button",
        class: `board-task-attachment${image ? " is-image" : ""}`,
        title: attachment?.name || "Открыть вложение",
        "aria-label": `Открыть ${attachment?.name || "вложение"}`,
        onclick: (event) => openAttachment(event, attachment, gallery, gallery.indexOf(attachment)),
      }, [preview]));
      const tile = strip.lastElementChild;
      if (!image) tile.__agentHubResource = { kind: "attachment", attachment };
    }
    return strip;
  }

  function workspaceById(id) {
    return state.workspaces.find((workspace) => workspace.id === id) ?? null;
  }

  function destinationValue(task) {
    if (task.bucket === "workspace") return `workspace:${task.workspaceId}`;
    return task.bucket;
  }

  function moveTask(task, destination, beforeId = null) {
    if (destination === "backlog" || destination === "notes") {
      emit("move", { id: task.id, bucket: destination, beforeId });
      return;
    }
    if (destination.startsWith("workspace:")) {
      emit("move", {
        id: task.id,
        bucket: "workspace",
        workspaceId: destination.slice(10),
        beforeId,
      });
    }
  }

  function draggedColumnId(dataTransfer) {
    const custom = dataTransfer.getData(COLUMN_MIME);
    if (custom) return custom;
    const plain = dataTransfer.getData("text/plain");
    return plain.startsWith(COLUMN_TEXT_PREFIX) ? plain.slice(COLUMN_TEXT_PREFIX.length) : "";
  }

  function hasColumnDrag(dataTransfer) {
    return Boolean(state.draggingColumnId)
      || Array.from(dataTransfer.types).includes(COLUMN_MIME);
  }

  function destinationSelect(task) {
    const select = node("select", {
      class: "board-task-destination",
      "aria-label": "Колонка задачи",
      onchange: (event) => moveTask(task, event.currentTarget.value),
    });
    select.append(node("option", { value: "backlog", text: "Бэклог" }));
    for (const workspace of state.workspaces) {
      select.append(node("option", { value: `workspace:${workspace.id}`, text: workspace.name }));
    }
    select.append(node("option", { value: "notes", text: "Заметки" }));
    select.value = destinationValue(task);
    return select;
  }

  function taskSummaryItems(task, workspaces, language = "en") {
    const taskNumber = String(task?.taskNumber ?? "").trim();
    const executor = taskExecutorPresentation(task, workspaces);
    const status = taskWorkflowPresentation(task, language);
    return Object.freeze([
      Object.freeze({
        role: "number",
        text: taskNumber,
        title: taskNumber ? task.title || task.text : "",
        placeholder: !taskNumber,
      }),
      Object.freeze({
        role: "executor",
        text: taskExecutorStreamName(task, workspaces),
        title: executor.label,
      }),
      Object.freeze({ role: "status", ...status }),
    ]);
  }

  function taskLaunchMessageId(taskId) {
    const suffix = window.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `board-task:${taskId}:${suffix}`;
  }

  function openStart(task) {
    const workspace = workspaceById(task.workspaceId);
    if (!workspace) return;
    state.startingTaskId = task.id;
    const reassigning = task.status === "started";
    const currentStream = (workspace.streams ?? []).find((stream) => stream.id === task.streamId);
    const currentAvailability = streamAvailability(
      currentStream,
      state.conversations,
      state.deferredInputs,
    );
    const sourceBusy = reassigning && !currentAvailability.free;
    const actionLabels = taskStartActionLabels(task);
    startEyebrow.textContent = actionLabels.eyebrow;
    startSubmit.textContent = actionLabels.newStreamSubmit;
    startTitle.textContent = task.title || task.text;
    startOptions.replaceChildren();
    for (const stream of workspace.streams ?? []) {
      if (reassigning && stream.id === task.streamId) continue;
      const availability = streamAvailability(stream, state.conversations, state.deferredInputs);
      startOptions.append(node("button", {
        type: "button",
        class: "task-start-stream",
        disabled: sourceBusy ? "" : null,
        title: sourceBusy ? "У текущего исполнителя ещё есть активный ход или очередь" : null,
        onclick: () => {
          closeStart();
          emit("start", {
            id: task.id,
            workspaceId: workspace.id,
            streamId: stream.id,
            provider: state.provider,
            clientUserMessageId: taskLaunchMessageId(task.id),
            reassign: reassigning,
          });
        },
      }, [
        node("strong", { text: stream.displayName || stream.name || `Stream ${stream.ordinal}` }),
        node("span", {
          text: availability.active
            ? "Идёт активный ход"
            : availability.queuedInputCount
              ? `В очереди: ${availability.queuedInputCount}`
              : "Свободен",
        }),
      ]));
    }
    if (!(workspace.streams ?? []).length) {
      startOptions.append(node("p", { class: "task-start-empty", text: "В Workspace пока нет Streams." }));
    }
    startNewName.value = (task.title || task.text).slice(0, 80);
    startProvider.value = state.provider;
    startNewName.disabled = sourceBusy;
    startProvider.disabled = sourceBusy;
    startNewForm.querySelector("button[type='submit']").disabled = sourceBusy;
    startModal.showModal?.();
    if (!startModal.open) startModal.setAttribute("open", "");
  }

  function closeStart() {
    state.startingTaskId = null;
    startModal.close?.();
    startModal.removeAttribute("open");
  }

  function closeTaskCard() {
    taskDeleteDialog.close();
    state.openTaskId = null;
    state.editingTaskId = null;
    state.editDirty = false;
    setTaskCardOriginalExpanded(false);
    taskCardModal?.close?.();
    taskCardModal?.removeAttribute("open");
  }

  function setTaskCardOriginalExpanded(expanded) {
    const nextExpanded = Boolean(expanded && taskCardOriginalText?.textContent);
    if (taskCardOriginalToggle) {
      taskCardOriginalToggle.setAttribute("aria-expanded", String(nextExpanded));
      taskCardOriginalToggle.textContent = nextExpanded
        ? "Скрыть исходный текст"
        : "Показать исходный текст";
    }
    if (taskCardOriginalText) taskCardOriginalText.hidden = !nextExpanded;
  }

  function renderTaskCardSaving(taskId) {
    const saving = state.savingTaskId === taskId;
    const savingStatus = state.savingStatusTaskId === taskId;
    const attaching = state.attachingTaskId === taskId;
    if (taskCardTitle) taskCardTitle.disabled = saving;
    if (taskCardDescription) taskCardDescription.disabled = saving;
    if (taskCardStatus) taskCardStatus.disabled = savingStatus;
    if (taskCardSaveButton) {
      taskCardSaveButton.disabled = saving;
      taskCardSaveButton.setAttribute("aria-busy", String(saving));
      taskCardSaveButton.textContent = saving ? "Сохраняю…" : "Сохранить изменения";
    }
    if (taskCardAttachmentAdd) {
      taskCardAttachmentAdd.disabled = attaching;
      taskCardAttachmentAdd.setAttribute("aria-busy", String(attaching));
    }
    if (taskCardAttachmentHint) {
      taskCardAttachmentHint.textContent = attaching
        ? "Добавляю вложения…"
        : "Выбери файлы или вставь их через Ctrl+V";
    }
  }

  function readTaskAttachmentFiles(files) {
    const task = state.tasks.find((item) => item.id === state.openTaskId);
    if (!task || state.attachingTaskId != null) return;
    const selection = taskAttachmentFiles(files);
    if (!selection.accepted.length) {
      if (selection.oversized) window.AgentHub?.toast?.("Размер одного файла не должен превышать 20 МБ.");
      return;
    }
    state.attachingTaskId = task.id;
    renderTaskCardSaving(task.id);
    emit("attachment-add", { id: task.id, attachments: selection.accepted });
    if (selection.truncated) window.AgentHub?.toast?.("За один раз можно приложить не больше восьми файлов.");
    else if (selection.oversized) window.AgentHub?.toast?.("Файлы больше 20 МБ пропущены.");
  }

  function renderOpenTaskCard() {
    if (!taskCardModal) return;
    const task = state.tasks.find((item) => item.id === state.openTaskId);
    if (!task) {
      if (state.openTaskId) closeTaskCard();
      return;
    }
    taskCardSource.textContent = task.source === "telegram" ? "Telegram" : "Hub";
    syncTaskStatusControl(taskCardStatus, task, state.statusLanguage, {
      pending: state.savingStatusTaskId === task.id,
    });
    if (state.editingTaskId !== task.id || !state.editDirty) {
      const taskNumber = String(task.taskNumber ?? "").trim();
      taskCardNumber.textContent = taskNumber;
      taskCardNumber.hidden = !taskNumber;
      taskCardTitle.value = task.title || task.text;
      taskCardDescription.value = String(task.description ?? "").trim();
      state.editingTaskId = task.id;
    }
    if (taskCardModal.open) scheduleTaskCardEditorSizing();
    renderTaskCardSaving(task.id);
    const originalText = String(task.rawText ?? "").trim();
    taskCardOriginal.hidden = !originalText;
    taskCardOriginalText.textContent = originalText;
    if (!originalText) setTaskCardOriginalExpanded(false);
    const attachments = Array.isArray(task.attachments) ? task.attachments : [];
    taskCardAttachments.hidden = attachments.length === 0;
    taskCardAttachments.replaceChildren(...(attachments.length ? [attachmentStrip(attachments)] : []));
    if (taskCardExecutor) taskCardExecutor.textContent = taskExecutorPresentation(task, state.workspaces).label;
    const changedFileGroups = taskChangedFileGroups(task);
    if (taskCardChangedFiles && taskCardChangedFileGroups) {
      taskCardChangedFiles.hidden = false;
      taskCardChangedFileGroups.replaceChildren(...(changedFileGroups.length
        ? changedFileGroups.map((group) => node("section", {
          class: "task-card-changed-file-group",
        }, [
          node("strong", { class: "task-card-project-root", text: group.projectRoot }),
          node("ul", {}, group.files.map((file) => node("li", {
            class: `task-card-changed-file is-${file.operation}`,
            title: file.turnId ? `Ход ${file.turnId}` : null,
          }, [
            node("span", {
              class: "task-card-changed-file-operation",
              text: changedFileOperationLabel(file.operation),
            }),
            node("code", { text: file.path }),
          ]))),
        ]))
        : [node("p", { class: "task-card-detail-empty", text: "Пока нет зафиксированных изменений." })]));
    }
    if (taskCardWorkLog && taskCardWorkLogEntries) {
      const entries = taskWorkLogEntries(task);
      taskCardWorkLog.hidden = false;
      taskCardWorkLogEntries.replaceChildren(...(entries.length
        ? entries.map((entry) => node("article", {
          class: "task-card-work-log-entry",
          title: entry.turnId ? `Ход ${entry.turnId}` : null,
        }, [
          node("div", { class: "task-card-work-log-meta" }, [
            node("strong", { text: entry.provider || "agent" }),
            node("span", { text: taskWorkLogStatusLabel(entry.status) }),
            ...(taskWorkLogTimeLabel(entry.createdAt) ? [node("time", {
              datetime: entry.createdAt,
              text: taskWorkLogTimeLabel(entry.createdAt),
            })] : []),
          ]),
          node("p", { text: entry.summary || "Без итогового описания." }),
          node("span", {
            class: "task-card-work-log-files",
            text: taskChangedFileCountLabel(entry.changedFileCount),
          }),
        ]))
        : [node("p", { class: "task-card-detail-empty", text: "Пока нет записей о выполненной работе." })]));
    }
    const actions = [];
    if (task.status !== "done" && taskWorkflowStatus(task) !== "done" && task.bucket === "workspace") {
      actions.push(node("button", {
        type: "button",
        class: "board-task-primary",
        text: task.status === "started" ? "Переназначить…" : "Начать работу",
        onclick: () => { closeTaskCard(); openStart(task); },
      }));
    }
    if (task.status !== "done") actions.push(destinationSelect(task));
    if (task.status !== "done" && task.triageStatus === "failed") {
      actions.push(node("button", {
        type: "button", class: "board-task-quiet", text: "Повторить Spark",
        onclick: () => emit("retry-triage", { id: task.id }),
      }));
    }
    if (task.status !== "done") {
      actions.push(node("button", {
        type: "button", class: "board-task-quiet", text: "Закрыть задачу",
        title: "Скрыть после приёмки заказчиком или когда сдача работ не требуется",
        onclick: () => { closeTaskCard(); emit("complete", { id: task.id }); },
      }));
    }
    actions.push(node("button", {
      type: "button",
      class: "board-task-remove",
      text: state.removingTaskId === task.id ? "Удаляю…" : "Удалить",
      disabled: state.removingTaskId === task.id ? "" : null,
      onclick: () => taskDeleteDialog.request(task.id),
    }));
    taskCardActions.replaceChildren(...actions);
  }

  function openTaskCard(task) {
    state.openTaskId = task.id;
    state.editingTaskId = null;
    state.editDirty = false;
    setTaskCardOriginalExpanded(false);
    renderOpenTaskCard();
    taskCardModal.showModal?.();
    if (!taskCardModal.open) taskCardModal.setAttribute("open", "");
    if (taskCardContent) taskCardContent.scrollTop = 0;
    scheduleTaskCardEditorSizing();
  }

  function taskCard(task, { compact = false } = {}) {
    const completed = task.status === "done";
    const movable = !compact && !completed;
    const attachable = true;
    const card = node("article", {
      class: `board-task-card${task.status === "started" ? " is-started" : ""}${completed ? " is-completed" : ""}${compact ? " is-compact" : ""}`,
      draggable: attachable ? "true" : null,
      role: "button",
      tabindex: "0",
      "aria-label": `Открыть задачу ${task.title || task.text}`,
      "data-board-task-id": task.id,
      onclick: () => openTaskCard(task),
      onkeydown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openTaskCard(task);
      },
      ondragstart: (event) => {
        TaskReferences.beginDrag(event.dataTransfer, task);
      },
      ondragend: () => TaskReferences.endDrag(),
    });
    if (movable) {
      card.addEventListener("dragover", (event) => {
        if (hasColumnDrag(event.dataTransfer)) return;
        if (!TaskReferences.hasTransfer(event.dataTransfer)) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.add("is-dragover");
      });
      card.addEventListener("dragleave", () => card.classList.remove("is-dragover"));
      card.addEventListener("drop", (event) => {
        if (draggedColumnId(event.dataTransfer)) return;
        const draggedId = TaskReferences.fromTransfer(event.dataTransfer)?.taskId;
        if (!draggedId || draggedId === task.id) return;
        const draggedTask = state.tasks.find((item) => item.id === draggedId);
        if (!draggedTask) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.remove("is-dragover");
        moveTask(draggedTask, destinationValue(task), task.id);
      });
    }
    const [numberSummary, executorSummary, statusSummary] = taskSummaryItems(
      task,
      state.workspaces,
      state.statusLanguage,
    );
    card.append(node("div", { class: "board-task-summary" }, [
      node("span", {
        class: `board-task-number${numberSummary.placeholder ? " is-placeholder" : ""}`,
        text: numberSummary.text,
        title: numberSummary.title || null,
        "aria-hidden": numberSummary.placeholder ? "true" : null,
      }),
      node("span", {
        class: "board-task-executor",
        text: executorSummary.text,
        title: executorSummary.title,
      }),
      node("span", {
        class: "board-task-status",
        "data-workflow-status": statusSummary.status,
        text: statusSummary.short,
        title: statusSummary.full,
        "aria-label": `Статус: ${statusSummary.full}`,
      }),
    ]));
    card.append(node("h3", { class: "board-task-title", text: task.title || task.text }));
    const attachmentCountLabel = taskAttachmentCountLabel(task.attachments);
    if (attachmentCountLabel) {
      card.append(node("div", { class: "board-task-attachments is-compact" }, [
        node("span", { class: "board-task-attachment-count", text: attachmentCountLabel }),
      ]));
    }
    return card;
  }

  function renderCreateForm(workspace) {
    const input = node("textarea", {
      rows: "3",
      maxlength: "20000",
      placeholder: "Что нужно сделать?",
      "aria-label": `Новая задача в ${workspace.name}`,
    });
    const form = node("form", {
      class: "task-board-inline-create",
      onsubmit: (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        state.creatingWorkspaceId = null;
        emit("create", { text, workspaceId: workspace.id });
        renderBoard();
      },
    }, [
      input,
      node("div", { class: "task-board-inline-actions" }, [
        node("button", { type: "submit", class: "board-task-primary", text: "Добавить" }),
        node("button", {
          type: "button",
          class: "board-task-quiet",
          text: "Отмена",
          onclick: () => { state.creatingWorkspaceId = null; renderBoard(); },
        }),
      ]),
    ]);
    window.requestAnimationFrame(() => input.focus());
    return form;
  }

  function renderColumn({
    id, title, subtitle, tasks, accent = "", workspace = null, movable = false,
    emptyText = "Перетащите задачу сюда",
  }) {
    const column = node("section", {
      class: `task-board-column ${accent}${workspace ? " is-workspace" : ""}`,
      "data-board-destination": id,
      "data-board-workspace-id": workspace?.id,
    });
    column.addEventListener("dragover", (event) => {
      if (hasColumnDrag(event.dataTransfer) && !movable) return;
      event.preventDefault();
      column.classList.add("is-dragover");
    });
    column.addEventListener("dragleave", () => column.classList.remove("is-dragover"));
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      column.classList.remove("is-dragover");
      const movedColumnId = draggedColumnId(event.dataTransfer);
      if (movedColumnId) {
        if (movedColumnId !== id) {
          emit("move-column", { columnId: movedColumnId, beforeColumnId: id });
        }
        return;
      }
      const taskId = TaskReferences.fromTransfer(event.dataTransfer)?.taskId;
      const task = state.tasks.find((item) => item.id === taskId);
      if (task && task.status !== "done") moveTask(task, id);
    });
    const controls = node("div", { class: "task-board-column-controls" }, [
      ...(workspace && !state.completedOnly ? [node("button", {
        type: "button",
        class: "task-board-create-button",
        text: "Создать",
        onclick: () => { state.creatingWorkspaceId = workspace.id; renderBoard(); },
      })] : []),
      node("span", { class: "task-board-count", text: String(tasks.length) }),
      ...(movable ? [node("button", {
        type: "button",
        class: "task-board-workspace-handle",
        draggable: "true",
        title: "Перетащить колонку",
        "aria-label": `Перетащить колонку ${title}`,
        text: "↔",
        ondragstart: (event) => {
          state.draggingColumnId = id;
          event.dataTransfer.setData(COLUMN_MIME, id);
          event.dataTransfer.setData("text/plain", `${COLUMN_TEXT_PREFIX}${id}`);
          event.dataTransfer.effectAllowed = "move";
        },
        ondragend: () => { state.draggingColumnId = null; },
      })] : []),
    ]);
    const heading = node("div", {}, [node("h2", { text: title })]);
    if (String(subtitle ?? "").trim()) heading.append(node("p", { text: subtitle }));
    if (workspace) {
      heading.append(node("span", {
        class: "task-board-stream-count",
        text: `${(workspace.streams ?? []).length} Streams`,
      }));
    }
    column.append(node("header", { class: "task-board-column-head" }, [
      heading,
      controls,
    ]));
    const list = node("div", { class: "task-board-column-list" });
    if (workspace && state.creatingWorkspaceId === workspace.id) list.append(renderCreateForm(workspace));
    if (!tasks.length && state.creatingWorkspaceId !== workspace?.id) {
      list.append(node("p", { class: "task-board-empty", text: emptyText }));
    } else {
      for (const task of tasks) list.append(taskCard(task));
    }
    column.append(list);
    return column;
  }

  function renderBoard() {
    const visibleTasks = tasksForMode(state.tasks, { completedOnly: state.completedOnly });
    const emptyText = state.completedOnly ? "Нет закрытых задач" : "Перетащите задачу сюда";
    const completedCount = state.tasks.filter((task) => task.status === "done").length;
    const openCount = state.tasks.length - completedCount;
    for (const button of statusLanguageButtons) {
      const selected = button.dataset.taskStatusLanguage === state.statusLanguage;
      button.setAttribute("aria-pressed", String(selected));
    }
    if (completedToggle) {
      completedToggle.textContent = state.completedOnly
        ? `Текущие · ${openCount}`
        : `Закрытые · ${completedCount}`;
      completedToggle.setAttribute("aria-pressed", String(state.completedOnly));
      completedToggle.setAttribute(
        "aria-label",
        state.completedOnly ? "Показать текущие задачи" : "Показать только закрытые задачи",
      );
    }
    board.classList.toggle("is-completed-only", state.completedOnly);
    columns.style.setProperty("--board-column-count", String(state.workspaces.length + 2));
    const rendered = new Map();
    rendered.set("backlog", renderColumn({
      id: "backlog", title: "Бэклог", subtitle: "Неразобранные входящие",
      tasks: visibleTasks.filter((task) => task.bucket === "backlog"), accent: "is-backlog", emptyText,
    }));
    for (const workspace of state.workspaces) {
      const id = `workspace:${workspace.id}`;
      rendered.set(id, renderColumn({
        id,
        title: workspace.name,
        subtitle: workspace.comment ?? "",
        tasks: visibleTasks.filter((task) => task.bucket === "workspace" && task.workspaceId === workspace.id),
        workspace, movable: !state.completedOnly, emptyText,
      }));
    }
    rendered.set("notes", renderColumn({
      id: "notes", title: "Заметки", subtitle: state.notesComment,
      tasks: visibleTasks.filter((task) => task.bucket === "notes"),
      accent: "is-notes", movable: !state.completedOnly, emptyText,
    }));
    const orderedIds = orderedDashboardColumnIds(state.columnOrder, rendered.keys());
    replaceBoardColumnRegionsPreservingScroll(boardColumnRegions, orderedIds, rendered);
  }

  function renderWorkspacePanel() {
    const workspace = workspaceById(state.selectedWorkspaceId);
    const sections = workspaceTaskSectionsForPanel(
      state.tasks,
      workspace?.id,
      state.selectedStreamId,
    );
    if (activityTaskHeading) {
      activityTaskHeading.textContent = window.AgentHubActivityRailLayout.countedActivityHeading(
        "Задачи",
        sections.total,
      );
    }
    workspacePanel.hidden = !workspace;
    if (!workspace) return;
    streamPanelList.replaceChildren();
    workspacePanelList.replaceChildren();
    if (!sections.streamTasks.length) {
      streamPanelList.append(node("p", { class: "workspace-task-empty", text: "Нет задач потока" }));
    } else {
      for (const task of sections.streamTasks) streamPanelList.append(taskCard(task, { compact: true }));
    }
    if (!sections.workspaceTasks.length) {
      workspacePanelList.append(node("p", { class: "workspace-task-empty", text: "Нет задач Workspace" }));
    } else {
      for (const task of sections.workspaceTasks) workspacePanelList.append(taskCard(task, { compact: true }));
    }
  }

  document.querySelector("[data-task-start-close]")?.addEventListener("click", closeStart);
  completedToggle?.addEventListener("click", () => {
    closeTaskCard();
    state.completedOnly = !state.completedOnly;
    renderBoard();
  });
  for (const button of statusLanguageButtons) {
    button.addEventListener("click", () => {
      state.statusLanguage = normalizedTaskStatusLanguage(button.dataset.taskStatusLanguage);
      try {
        window.localStorage?.setItem(TASK_STATUS_LANGUAGE_STORAGE_KEY, state.statusLanguage);
      } catch {
        // Language remains active for the current page when storage is unavailable.
      }
      renderBoard();
      renderWorkspacePanel();
      renderOpenTaskCard();
    });
  }
  window.addEventListener("resize", scheduleTaskCardEditorSizing, { passive: true });
  document.querySelector("[data-task-card-close]")?.addEventListener("click", closeTaskCard);
  taskCardOriginalToggle?.addEventListener("click", () => {
    setTaskCardOriginalExpanded(taskCardOriginalToggle.getAttribute("aria-expanded") !== "true");
    scheduleTaskCardEditorSizing();
  });
  taskCardEditor?.addEventListener("input", () => {
    state.editDirty = true;
    scheduleTaskCardEditorSizing();
  });
  taskCardStatus?.addEventListener("change", () => {
    const task = state.tasks.find((item) => item.id === state.openTaskId);
    if (!task || state.savingStatusTaskId != null) return;
    state.savingStatusTaskId = task.id;
    renderTaskCardSaving(task.id);
    emit("status", { id: task.id, status: taskCardStatus.value });
  });
  taskCardAttachmentAdd?.addEventListener("click", () => taskCardAttachmentInput?.click());
  taskCardAttachmentInput?.addEventListener("change", () => {
    readTaskAttachmentFiles(taskCardAttachmentInput.files);
    taskCardAttachmentInput.value = "";
  });
  taskCardModal?.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    readTaskAttachmentFiles(files);
  });
  taskCardTitle?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    taskCardEditor.requestSubmit?.();
  });
  taskCardEditor?.addEventListener("submit", (event) => {
    event.preventDefault();
    const task = state.tasks.find((item) => item.id === state.openTaskId);
    const title = taskCardTitle.value.trim();
    if (!task || !title) {
      taskCardTitle.reportValidity?.();
      return;
    }
    if (state.savingTaskId === task.id) return;
    state.savingTaskId = task.id;
    renderTaskCardSaving(task.id);
    emit("update", taskPresentationUpdate(task, {
      title,
      description: taskCardDescription.value,
    }));
  });
  taskCardModal?.addEventListener("cancel", (event) => { event.preventDefault(); closeTaskCard(); });
  startModal.addEventListener("cancel", (event) => { event.preventDefault(); closeStart(); });
  startNewForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const task = state.tasks.find((item) => item.id === state.startingTaskId);
    if (!task) return;
    const streamName = startNewName.value.trim();
    if (!streamName) return;
    closeStart();
    emit("start", {
      id: task.id,
      workspaceId: task.workspaceId,
      streamName,
      provider: startProvider.value,
      clientUserMessageId: taskLaunchMessageId(task.id),
      reassign: task.status === "started",
    });
  });
  document.querySelector("[data-workspace-task-dashboard]")?.addEventListener("click", () => {
    document.querySelector("[data-view-button='dashboard']")?.click();
  });

  window.AgentHubTaskBoard = Object.freeze({
    setSelectedContext({ workspaceId, streamId } = {}) {
      const nextWorkspaceId = String(workspaceId ?? "").trim() || null;
      const nextStreamId = String(streamId ?? "").trim() || null;
      if (
        state.selectedWorkspaceId === nextWorkspaceId
        && state.selectedStreamId === nextStreamId
      ) return;
      state.selectedWorkspaceId = nextWorkspaceId;
      state.selectedStreamId = nextStreamId;
      renderWorkspacePanel();
    },
    setSelectedWorkspace(workspaceId) {
      const nextWorkspaceId = String(workspaceId ?? "").trim() || null;
      if (state.selectedWorkspaceId === nextWorkspaceId) return;
      state.selectedWorkspaceId = nextWorkspaceId;
      renderWorkspacePanel();
    },
    setSnapshot(payload = {}) {
      const changes = taskBoardSnapshotChanges(state, payload, {
        initialized: state.snapshotInitialized,
      });
      Object.assign(state, changes.next, { snapshotInitialized: true });
      // Run snapshots change while an agent is working, but Dashboard data
      // usually does not. Rebuilding every column also schedules synchronous
      // card measurements and can stall typing in the chat surface.
      if (changes.boardChanged) renderBoard();
      if (changes.panelChanged) renderWorkspacePanel();
      if (changes.openTaskChanged) renderOpenTaskCard();
    },
    finishAction({ type, id, succeeded } = {}) {
      if (type === "update" && state.savingTaskId === id) {
        state.savingTaskId = null;
        if (succeeded) {
          state.editDirty = false;
          closeTaskCard();
          return;
        }
        renderOpenTaskCard();
        return;
      }
      if (type === "remove" && state.removingTaskId === id) {
        state.removingTaskId = null;
        if (succeeded) closeTaskCard();
        else renderOpenTaskCard();
      }
      if (type === "status" && state.savingStatusTaskId === id) {
        state.savingStatusTaskId = null;
        renderOpenTaskCard();
        return;
      }
      if (type === "attachment-add" && state.attachingTaskId === id) {
        state.attachingTaskId = null;
        renderOpenTaskCard();
      }
    },
  });
  document.addEventListener("agenthub:task-reference-open", createTaskReferenceOpenHandler({
    getTasks: () => state.tasks,
    openTask: openTaskCard,
  }));
})();
