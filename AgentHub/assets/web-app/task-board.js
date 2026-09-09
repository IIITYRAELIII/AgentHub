"use strict";

(() => {
  const modalOverlays = window.AgentHubModalOverlays;

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

  function cleanupValue(value, fallback = "<нет>") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function cleanupPaths(title, values) {
    const paths = (Array.isArray(values) ? values : []).map((value) => cleanupValue(value)).filter(Boolean);
    return [`${title}:`, ...(paths.length ? paths.map((value) => `  - ${value}`) : ["  - <нет>"])];
  }

  function taskCleanupConfirmationText(confirmation = {}) {
    const preview = confirmation.preview ?? {};
    const lines = [cleanupValue(confirmation.warning, "Подтвердите удаление артефактов Task."), "", "Состояние Task Git:"];
    const workspaces = Array.isArray(preview.workspaces) ? preview.workspaces : [];
    if (!workspaces.length) lines.push("  <managed worktree отсутствует>");
    for (const [index, workspace] of workspaces.entries()) {
      lines.push(
        `  Checkout ${index + 1}:`,
        `    Ветка: ${cleanupValue(workspace.branch)}`,
        `    Worktree: ${cleanupValue(workspace.projectRoot)}`,
        `    HEAD: ${cleanupValue(workspace.headCommit)}`,
        `    Состояние: ${workspace.dirty === true ? "dirty" : "clean"}`,
        ...cleanupPaths("    Изменённые пути", workspace.changedPaths),
        ...cleanupPaths("    Untracked пути", workspace.untrackedPaths),
      );
    }
    lines.push("", `Общее dirty-состояние: ${preview.dirty === true ? "dirty" : "clean"}`, "", "Результат и публикация:");
    const references = Array.isArray(preview.gitReferences) ? preview.gitReferences : [];
    if (!references.length) lines.push("  <result commit отсутствует>");
    for (const [index, reference] of references.entries()) {
      lines.push(
        `  Результат ${index + 1}:`,
        `    Репозиторий: ${cleanupValue(reference.projectRoot)}`,
        `    Ветка: ${cleanupValue(reference.branch)}`,
        `    Result commit: ${cleanupValue(reference.resultCommit)}`,
        `    Publication state: ${reference.published === true ? "published" : "unpublished"}`,
        `    Publication revision: ${cleanupValue(reference.publishedRevision)}`,
        `    Publication generation: ${cleanupValue(reference.publicationGeneration)}`,
      );
    }
    lines.push("", "Будет удалено:");
    const deleting = Array.isArray(preview.deleting) ? preview.deleting : [];
    if (!deleting.length) lines.push("  - <ничего>");
    for (const item of deleting) {
      const target = cleanupValue(item.path ?? item.name);
      const repository = cleanupValue(item.repositoryRoot, "");
      lines.push(`  - [${cleanupValue(item.kind, "artifact")}] ${target}${repository ? ` (repo: ${repository})` : ""}`);
    }
    return lines.join("\n");
  }

  let dismissCleanupConfirmation = null;

  function showTaskCleanupConfirmation(text, { action, task } = {}) {
    dismissCleanupConfirmation?.();
    return new Promise((resolve, reject) => {
      const dialog = document.createElement("dialog");
      dialog.className = "task-delete-modal";
      dialog.setAttribute("data-task-cleanup-modal", "");
      dialog.setAttribute("aria-labelledby", "task-cleanup-title");
      const section = document.createElement("section");
      const title = document.createElement("h2");
      title.id = "task-cleanup-title";
      const label = action === "board-task-remove" ? "Удалить задачу" : "Закрыть задачу";
      title.textContent = `${label}${task?.taskNumber ? ` ${task.taskNumber}` : ""}?`;
      const preview = document.createElement("pre");
      preview.className = "task-cleanup-preview";
      preview.textContent = text;
      section.append(title, preview);
      const footer = document.createElement("footer");
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "board-task-quiet";
      cancel.textContent = "Отмена";
      cancel.setAttribute("data-task-cleanup-cancel", "");
      const accept = document.createElement("button");
      accept.type = "button";
      accept.className = "task-delete-confirm";
      accept.textContent = label;
      accept.setAttribute("data-task-cleanup-confirm", "");
      footer.append(cancel, accept);
      dialog.append(section, footer);
      let settled = false;
      let uninstall = () => {};
      const settle = (confirmed) => {
        if (settled) return;
        settled = true;
        uninstall();
        if (dismissCleanupConfirmation === dismiss) dismissCleanupConfirmation = null;
        if (dialog.open) dialog.close();
        dialog.remove();
        resolve(confirmed);
      };
      const dismiss = () => settle(false);
      dismissCleanupConfirmation = dismiss;
      cancel.addEventListener("click", dismiss);
      accept.addEventListener("click", () => settle(true));
      dialog.addEventListener("close", dismiss);
      uninstall = modalOverlays.installDismissibleOverlay({ dialog, close: dismiss });
      document.body.append(dialog);
      try {
        dialog.showModal();
        cancel.focus();
      } catch (error) {
        settled = true;
        uninstall();
        if (dismissCleanupConfirmation === dismiss) dismissCleanupConfirmation = null;
        dialog.remove();
        reject(error);
      }
    });
  }

  async function confirmTaskCleanup({ confirmation, action, params = {}, request, confirm = showTaskCleanupConfirmation } = {}) {
    if (typeof request !== "function") throw new TypeError("Task cleanup request is required");
    if (typeof confirm !== "function") throw new TypeError("Task cleanup confirmation UI is required");
    const text = taskCleanupConfirmationText(confirmation);
    const confirmedParams = structuredClone({
      ...params,
      confirmCleanup: true,
      expectedCleanupToken: confirmation?.cleanupToken,
    });
    if (!await confirm(text, { action, task: confirmation?.task })) return { confirmed: false, text, result: null };
    const result = await request(action, confirmedParams);
    return { confirmed: true, text, result };
  }

  window.AgentHubTaskCleanupConfirmation = Object.freeze({
    confirm: confirmTaskCleanup,
    format: taskCleanupConfirmationText,
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
    modalOverlays?.installDismissibleOverlay({ dialog, close });

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
      tasks: Array.isArray(payload.tasks) ? payload.tasks : [],
      workspaces: Array.isArray(payload.workspaces) ? payload.workspaces : [],
      columnOrder: Array.isArray(payload.columnOrder) ? payload.columnOrder : [],
      notesComment: String(payload.notesComment ?? ""),
      selectedWorkspaceId: payload.selectedWorkspaceId ?? null,
      selectedStreamId: payload.selectedStreamId ?? null,
      provider: payload.provider === "claude" ? "claude" : "codex",
      conversations: Array.isArray(payload.conversations) ? payload.conversations : [],
      deferredInputs: Array.isArray(payload.deferredInputs) ? payload.deferredInputs : [],
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

  function taskChecklistProgress(task) {
    const checklist = Array.isArray(task?.checklist) ? task.checklist : [];
    return {
      completed: checklist.filter((item) => item?.completed === true).length,
      total: checklist.length,
    };
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

  function taskBoardScrollSnapshot(regions) {
    const roots = [regions?.backlog, regions?.workspaces, regions?.notes].filter(Boolean);
    const columns = roots.flatMap((root) => Array.from(
      root.querySelectorAll?.("[data-board-destination]") ?? [],
    )).map((column) => ({
      id: String(column.dataset?.boardDestination ?? ""),
      scrollTop: Math.max(0, Number(
        column.querySelector?.(".task-board-column-list")?.scrollTop,
      ) || 0),
    })).filter(({ id }) => id);
    return Object.freeze({
      workspaceScrollLeft: Math.max(0, Number(regions?.workspaces?.scrollLeft) || 0),
      columns: Object.freeze(columns.map((entry) => Object.freeze(entry))),
    });
  }

  function restoreTaskBoardScroll(regions, snapshot) {
    if (regions?.workspaces) {
      regions.workspaces.scrollLeft = Math.max(
        0,
        Number(snapshot?.workspaceScrollLeft) || 0,
      );
    }
    const saved = new Map((snapshot?.columns ?? []).map(({ id, scrollTop }) => [id, scrollTop]));
    const roots = [regions?.backlog, regions?.workspaces, regions?.notes].filter(Boolean);
    for (const column of roots.flatMap((root) => Array.from(
      root.querySelectorAll?.("[data-board-destination]") ?? [],
    ))) {
      const scrollTop = saved.get(String(column.dataset?.boardDestination ?? ""));
      const list = column.querySelector?.(".task-board-column-list");
      if (list && scrollTop != null) list.scrollTop = Math.max(0, Number(scrollTop) || 0);
    }
  }

  function createTaskBoardPointerDrag({
    root,
    pointTargetAt = (x, y) => root?.ownerDocument?.elementFromPoint?.(x, y),
    onMove,
    windowTarget = window,
    threshold = 7,
  } = {}) {
    let pointer = null;
    let nativeDragTaskId = null;
    let suppressClick = false;
    let suppressClickTimer = null;

    function insideRoot(node) {
      return Boolean(node) && (typeof root?.contains !== "function" || root.contains(node));
    }

    function closest(node, selector) {
      const match = node?.closest?.(selector) ?? null;
      return insideRoot(match) ? match : null;
    }

    function movableCard(node) {
      return closest(node, '[data-board-task-id][data-board-task-movable="true"]');
    }

    function taskIdOf(card) {
      return String(card?.dataset?.boardTaskId ?? "").trim();
    }

    function clearDropTarget(current) {
      current?.dropNode?.classList?.remove("is-dragover");
      if (current) {
        current.dropNode = null;
        current.drop = null;
      }
    }

    function armClickSuppression() {
      suppressClick = true;
      if (suppressClickTimer != null) windowTarget.clearTimeout?.(suppressClickTimer);
      suppressClickTimer = windowTarget.setTimeout?.(() => {
        suppressClick = false;
        suppressClickTimer = null;
      }, 0) ?? null;
    }

    function cleanup({ suppress = false } = {}) {
      const current = pointer;
      pointer = null;
      if (!current) return;
      clearDropTarget(current);
      current.source?.classList?.remove("is-pointer-dragging");
      if (current.captured) {
        try {
          current.source?.releasePointerCapture?.(current.id);
        } catch {
          // Capture can already be lost during blur, cancel, or a board rerender.
        }
      }
      if (suppress && current.active) armClickSuppression();
    }

    function resolveDropTarget(event) {
      const hit = pointTargetAt(Number(event.clientX) || 0, Number(event.clientY) || 0);
      const column = closest(hit, "[data-board-destination]");
      if (!column) return null;
      const destination = String(column.dataset?.boardDestination ?? "").trim();
      if (!destination) return null;
      const card = movableCard(hit);
      const beforeId = taskIdOf(card);
      if (beforeId && beforeId === pointer?.taskId) return null;
      return {
        destination,
        beforeId: beforeId || null,
        dropNode: beforeId ? card : column,
      };
    }

    function updateDropTarget(event) {
      const next = resolveDropTarget(event);
      if (pointer?.dropNode === next?.dropNode) {
        if (pointer) pointer.drop = next;
        return;
      }
      clearDropTarget(pointer);
      if (!pointer || !next) return;
      pointer.drop = next;
      pointer.dropNode = next.dropNode;
      pointer.dropNode?.classList?.add("is-dragover");
    }

    function start(event) {
      if (
        nativeDragTaskId
        || event?.isPrimary === false
        || event?.pointerType === "touch"
        || Number(event?.button ?? 0) !== 0
      ) return;
      const source = movableCard(event.target);
      const taskId = taskIdOf(source);
      if (!taskId) return;
      cleanup();
      pointer = {
        id: event.pointerId,
        taskId,
        source,
        startX: Number(event.clientX) || 0,
        startY: Number(event.clientY) || 0,
        active: false,
        captured: false,
        drop: null,
        dropNode: null,
      };
    }

    function move(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      if (event.pointerType === "mouse" && Number(event.buttons) === 0) {
        cleanup({ suppress: pointer.active });
        return;
      }
      if (!pointer.active) {
        const distance = Math.hypot(
          (Number(event.clientX) || 0) - pointer.startX,
          (Number(event.clientY) || 0) - pointer.startY,
        );
        if (distance < Math.max(1, Number(threshold) || 1)) return;
        pointer.active = true;
        pointer.source?.classList?.add("is-pointer-dragging");
        try {
          pointer.source?.setPointerCapture?.(pointer.id);
          pointer.captured = true;
        } catch {
          pointer.captured = false;
        }
      }
      event.preventDefault?.();
      updateDropTarget(event);
    }

    function finish(event) {
      if (!pointer || event.pointerId !== pointer.id) return;
      const current = pointer;
      if (current.active) {
        event.preventDefault?.();
        updateDropTarget(event);
      }
      const moveDetail = current.active && current.drop
        ? {
          taskId: current.taskId,
          destination: current.drop.destination,
          beforeId: current.drop.beforeId,
        }
        : null;
      cleanup({ suppress: current.active });
      if (moveDetail) onMove?.(moveDetail);
    }

    function cancel(event) {
      if (event?.pointerId != null && pointer && event.pointerId !== pointer.id) return;
      cleanup({ suppress: Boolean(pointer?.active) });
    }

    function blur() {
      nativeDragTaskId = null;
      cleanup({ suppress: Boolean(pointer?.active) });
    }

    function nativeDragStart(event) {
      const card = closest(event.target, "[data-board-task-id]");
      const taskId = taskIdOf(card);
      if (!taskId) return;
      nativeDragTaskId = taskId;
      cleanup({ suppress: Boolean(pointer?.active) });
    }

    function nativeDragEnd(event) {
      const taskId = taskIdOf(closest(event.target, "[data-board-task-id]"));
      if (!taskId || taskId === nativeDragTaskId) nativeDragTaskId = null;
    }

    function blockAccidentalClick(event) {
      if (!suppressClick) return;
      suppressClick = false;
      if (suppressClickTimer != null) windowTarget.clearTimeout?.(suppressClickTimer);
      suppressClickTimer = null;
      event.preventDefault?.();
      event.stopImmediatePropagation?.();
    }

    const listeners = [
      ["pointerdown", start, false],
      ["pointermove", move, false],
      ["pointerup", finish, false],
      ["pointercancel", cancel, false],
      ["lostpointercapture", cancel, false],
      ["dragstart", nativeDragStart, true],
      ["dragend", nativeDragEnd, true],
      ["click", blockAccidentalClick, true],
    ];
    for (const [type, listener, capture] of listeners) root?.addEventListener?.(type, listener, capture);
    windowTarget?.addEventListener?.("blur", blur);

    return Object.freeze({
      cancelForRerender() {
        nativeDragTaskId = null;
        cleanup({ suppress: Boolean(pointer?.active) });
      },
      destroy() {
        nativeDragTaskId = null;
        cleanup();
        for (const [type, listener, capture] of listeners) {
          root?.removeEventListener?.(type, listener, capture);
        }
        windowTarget?.removeEventListener?.("blur", blur);
        if (suppressClickTimer != null) windowTarget.clearTimeout?.(suppressClickTimer);
        suppressClick = false;
        suppressClickTimer = null;
      },
    });
  }

  window.AgentHubTaskBoardInteraction = Object.freeze({
    createPointerDrag: createTaskBoardPointerDrag,
  });

  window.AgentHubTaskBoardView = Object.freeze({
    createTaskReferenceOpenHandler,
    normalizedTaskStatusLanguage,
    orderedDashboardColumnIds,
    replaceBoardColumnRegionsPreservingScroll,
    replaceBoardColumnsPreservingScroll,
    restoreTaskBoardScroll,
    taskBoardSnapshotChanges,
    taskBoardScrollSnapshot,
    taskAttachmentCountLabel,
    taskAttachmentFiles,
    taskChangedFileGroups,
    taskExecutorPresentation,
    taskExecutorStreamName,
    taskPresentationUpdate,
    taskSummaryItems,
    taskWorkLogEntries,
    taskChecklistProgress,
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
  const scopeStrip = document.querySelector("[data-task-board-scopes]");
  const filterToggle = document.querySelector("[data-task-board-filter-toggle]");
  const filterControls = document.querySelector("[data-task-board-filter-controls]");
  const completedToggle = document.querySelector("[data-task-board-completed-toggle]");
  const statusLanguageButtons = Array.from(document.querySelectorAll?.("[data-task-status-language]") ?? []);
  const workspacePanel = document.querySelector("[data-workspace-task-panel]");
  const streamPanelList = document.querySelector("[data-stream-task-list]");
  const workspacePanelList = document.querySelector("[data-workspace-task-list]");
  const activityTaskHeading = document.querySelector("[data-activity-task-heading]");
  const taskCardModal = document.querySelector("[data-task-card-modal]");
  const taskCardHome = taskCardModal?.parentElement;
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
  const taskChecklistProgressOutput = document.querySelector("[data-task-checklist-progress]");
  const taskChecklistAddForm = document.querySelector("[data-task-checklist-add]");
  const taskChecklistAddInput = taskChecklistAddForm?.querySelector("input");
  const taskChecklistAddButton = taskChecklistAddForm?.querySelector("button[type='submit']");
  const taskChecklistItems = document.querySelector("[data-task-checklist-items]");
  const taskChecklistParent = document.querySelector("[data-task-checklist-parent]");
  const taskChecklistParentItem = document.querySelector("[data-task-checklist-parent-item]");
  const taskChecklistParentCard = document.querySelector("[data-task-checklist-parent-card]");
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
    columns: node("div", {
      class: "task-board-status-columns",
      "data-task-board-status-columns": "",
    }),
  };
  columns.replaceChildren(boardColumnRegions.columns);

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
    filtersOpen: false,
    boardScope: "all",
    taskCardModalRequested: false,
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
    pendingChecklistActions: new Map(),
    checklistLinkedActionPrompts: new Map(),
    editingChecklistItemId: null,
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
    if (taskCardIsDocked()) return;

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

  function taskCardIsDocked() {
    return !state.taskCardModalRequested && dashboardHasDetailPanel();
  }

  function dashboardHasDetailPanel() {
    return document.documentElement.dataset.view === "dashboard"
      && window.matchMedia?.("(min-width: 960px)")?.matches === true;
  }

  let taskCardBackdrop = null;
  let dockedScrollTop = 0;
  function syncTaskCardBackdrop() {
    taskCardBackdrop?.remove();
    taskCardBackdrop = null;
    if (!state.openTaskId || !state.taskCardModalRequested || !dashboardHasDetailPanel()) return;
    // The native modal makes the background inert. Keep its docked projection
    // visible without creating another editor or duplicate document identities.
    taskCardBackdrop = node("aside", { class: taskCardModal.className });
    for (const child of taskCardModal.childNodes) taskCardBackdrop.append(child.cloneNode(true));
    for (const control of taskCardBackdrop.querySelectorAll("input, textarea, select")) {
      const presentation = node("span", { class: control.className, text: control.value });
      if (control.tagName === "SELECT") presentation.textContent = control.selectedOptions[0]?.textContent ?? "";
      if (control.type === "checkbox") presentation.textContent = control.checked ? "☑" : "☐";
      if (control.type === "hidden") presentation.hidden = true;
      control.replaceWith(presentation);
    }
    for (const element of [taskCardBackdrop, ...taskCardBackdrop.querySelectorAll("*")]) {
      for (const attribute of [...element.attributes]) {
        if (attribute.name === "id" || attribute.name.startsWith("data-")
          || attribute.name.startsWith("aria-") || attribute.name === "for") element.removeAttribute(attribute.name);
      }
    }
    taskCardBackdrop.classList.add("task-card-backdrop");
    taskCardBackdrop.classList.remove("is-editing");
    taskCardBackdrop.removeAttribute("style");
    taskCardBackdrop.setAttribute("inert", "");
    taskCardBackdrop.setAttribute("aria-hidden", "true");
    taskCardBackdrop.setAttribute("open", "");
    board.append(taskCardBackdrop);
    taskCardBackdrop.querySelector(".task-card-content").scrollTop = dockedScrollTop;
  }

  function syncTaskCardPlacement() {
    if (!taskCardModal?.open && !state.openTaskId) return;
    const docked = taskCardIsDocked();
    const target = docked ? board : taskCardHome;
    const changed = taskCardModal.parentElement !== target
      || (taskCardModal.matches?.(":modal") === true) === docked;
    if (changed && taskCardModal.open) taskCardModal.close();
    if (docked) {
      taskCardModal.style.removeProperty("inline-size");
      taskCardModal.style.removeProperty("block-size");
      taskCardModal.removeAttribute("data-width-expanded");
    }
    if (target && taskCardModal.parentElement !== target) target.append(taskCardModal);
    board.classList.toggle("has-open-task", dashboardHasDetailPanel());
    if (!taskCardModal.open) {
      if (docked) taskCardModal.show?.();
      else taskCardModal.showModal?.();
    }
    if (!taskCardModal.open) taskCardModal.setAttribute("open", "");
    syncTaskCardBackdrop();
    for (const card of columns.querySelectorAll("[data-board-task-id]")) {
      const selected = card.dataset.boardTaskId === state.openTaskId;
      card.classList.toggle("is-selected", selected);
      card.setAttribute("aria-current", selected ? "true" : "false");
    }
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
    if (destination.startsWith("status:")) {
      const status = destination.slice(destination.lastIndexOf(":") + 1);
      if (task.bucket === "backlog" || !selectedScopeTasks([task]).length) return;
      if (taskWorkflowStatus(task) !== status) {
        if (state.savingStatusTaskId != null) return;
        state.savingStatusTaskId = task.id;
        renderTaskCardSaving(task.id);
        emit("status", { id: task.id, status });
      } else if (beforeId) {
        const beforeTask = state.tasks.find((item) => item.id === beforeId);
        moveTask(task, beforeTask ? destinationValue(beforeTask) : destinationValue(task), beforeId);
      }
      return;
    }
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

  const pointerTaskDrag = createTaskBoardPointerDrag({
    root: board,
    onMove: ({ taskId, destination, beforeId }) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (task && task.status !== "done") moveTask(task, destination, beforeId);
    },
  });

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

  function checklistRequestId(taskId) {
    const suffix = window.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `task-checklist:${taskId}:${suffix}`;
  }

  function checklistLinkedActionRequestId(taskId) {
    const suffix = window.crypto?.randomUUID?.()
      ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `task-checklist-linked:${taskId}:${suffix}`;
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
    taskCardBackdrop?.remove();
    taskCardBackdrop = null;
    const openedTaskId = state.openTaskId;
    taskDeleteDialog.close();
    state.openTaskId = null;
    state.taskCardModalRequested = false;
    state.editingTaskId = null;
    state.editDirty = false;
    state.editingChecklistItemId = null;
    setTaskCardOriginalExpanded(false);
    board.classList.remove("has-open-task");
    taskCardModal?.close?.();
    taskCardModal?.removeAttribute("open");
    if (taskCardHome && taskCardModal?.parentElement !== taskCardHome) taskCardHome.append(taskCardModal);
    for (const card of columns.querySelectorAll(".is-selected")) {
      card.classList.remove("is-selected");
      card.removeAttribute("aria-current");
      if (card.dataset.boardTaskId === openedTaskId) card.focus();
    }
  }

  function openTaskExecutor(task, event = null) {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    const presentation = taskExecutorPresentation(task, state.workspaces);
    if (!presentation.stream) return false;
    closeTaskCard();
    window.AgentHub?.openStream?.(presentation.workspace.id, presentation.stream.id);
    return true;
  }

  function emitChecklist(task, operation, payload = {}) {
    if (state.pendingChecklistActions.has(task.id)) return;
    const { promptLinkedTaskId = null, ...commandPayload } = payload;
    const requestId = checklistRequestId(task.id);
    state.pendingChecklistActions.set(task.id, {
      taskId: task.id,
      itemId: String(payload.itemId ?? ""),
      operation,
      requestId,
      completed: payload.completed === true,
      linkedTaskId: String(promptLinkedTaskId ?? ""),
    });
    renderOpenTaskCard();
    emit("checklist", {
      id: task.id,
      operation,
      expectedRevision: task.revision,
      requestId,
      ...commandPayload,
    });
  }

  function emitChecklistLinkedTaskAction(prompt, action) {
    if (prompt.pending) return;
    prompt.pending = true;
    prompt.selectedAction ??= action;
    renderOpenTaskCard();
    emit("checklist-linked-task-action", {
      id: prompt.taskId,
      itemId: prompt.itemId,
      linkedTaskId: prompt.linkedTaskId,
      action: prompt.selectedAction,
      expectedTaskRevision: prompt.expectedTaskRevision,
      expectedLinkedTaskRevision: prompt.expectedLinkedTaskRevision,
      requestId: prompt.requestId,
    });
  }

  function checklistLinkedTaskActionPrompt(task, item) {
    const prompt = state.checklistLinkedActionPrompts.get(task.id);
    if (!prompt || prompt.itemId !== item.id) return null;
    if (
      item.manualCompleted !== true
      || item.linkedTaskId !== prompt.linkedTaskId
      || workspaceById(task.workspaceId)?.settings?.releaseWorkflowEnabled === true
    ) {
      state.checklistLinkedActionPrompts.delete(task.id);
      return null;
    }
    const choices = [
      ["none", "Ничего не делать"],
      ["awaiting_implementation", "Отметить Awaiting implementation"],
      ["done", "Отметить Done"],
      ["done_and_close", "Отметить Done и закрыть"],
    ];
    return node("section", {
      class: "task-checklist-linked-action",
      "aria-label": "Действие со связанной Task",
    }, [
      node("p", { text: "Что сделать со связанной Task?" }),
      node("div", { class: "task-checklist-linked-action-choices" }, choices.map(([action, label]) => {
        const button = checklistAction(label, label, () => emitChecklistLinkedTaskAction(prompt, action),
          action === "none" ? "board-task-quiet" : "board-task-primary");
        button.disabled = prompt.pending || (prompt.selectedAction != null && prompt.selectedAction !== action);
        return button;
      })),
    ]);
  }

  function checklistAction(label, title, onclick, className = "board-task-quiet") {
    return node("button", { type: "button", class: className, text: label, title, onclick });
  }

  function checklistLinkSelect(task, item) {
    const select = node("select", {
      class: "task-checklist-link-select",
      "aria-label": item.linkedTaskId ? "Заменить связанную Task" : "Связать с Task",
      onchange: (event) => {
        const linkedTaskId = String(event.currentTarget.value ?? "");
        if (!linkedTaskId || linkedTaskId === item.linkedTaskId) return;
        emitChecklist(task, "link", { itemId: item.id, linkedTaskId });
      },
    });
    select.append(node("option", {
      value: "",
      text: item.linkedTaskId ? "Заменить Task…" : "Связать Task…",
    }));
    for (const candidate of state.tasks.filter((value) => (
      value.id !== task.id && (value.workspaceId ?? null) === (task.workspaceId ?? null)
    ))) {
      select.append(node("option", {
        value: candidate.id,
        text: `${candidate.taskNumber || "TASK"} · ${candidate.title || candidate.text}`,
      }));
    }
    select.disabled = state.pendingChecklistActions.has(task.id);
    return select;
  }

  function checklistItemEditor(task, item) {
    const input = node("input", {
      type: "text",
      maxlength: "1000",
      value: item.text,
      "aria-label": "Текст пункта чек-листа",
    });
    input.value = item.text;
    const form = node("form", {
      class: "task-checklist-edit",
      onsubmit: (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        state.editingChecklistItemId = null;
        emitChecklist(task, "edit", { itemId: item.id, text });
      },
    }, [
      input,
      checklistAction("Сохранить", "Сохранить пункт", () => form.requestSubmit(), "board-task-primary"),
      checklistAction("Отмена", "Отменить редактирование", () => {
        state.editingChecklistItemId = null;
        renderOpenTaskCard();
      }),
    ]);
    window.requestAnimationFrame(() => input.focus());
    return form;
  }

  function renderTaskChecklist(task) {
    if (!taskChecklistItems || !taskChecklistProgressOutput) return;
    const checklist = Array.isArray(task.checklist) ? task.checklist : [];
    const progress = taskChecklistProgress(task);
    const canExtract = Boolean(workspaceById(task.workspaceId));
    taskChecklistProgressOutput.textContent = `${progress.completed} из ${progress.total}`;
    taskChecklistItems.replaceChildren(...checklist.map((item, index) => {
      const busy = state.pendingChecklistActions.has(task.id);
      const linkedTask = item.linkedTaskId
        ? state.tasks.find((candidate) => candidate.id === item.linkedTaskId) ?? item.linkedTask
        : null;
      const checkbox = node("input", {
        type: "checkbox",
        "aria-label": `Выполнено: ${item.text}`,
        onchange: (event) => emitChecklist(task, "toggle", {
          itemId: item.id,
          completed: event.currentTarget.checked,
          promptLinkedTaskId: item.linkedTaskId,
        }),
      });
      checkbox.checked = item.completed === true;
      checkbox.disabled = busy;
      const content = state.editingChecklistItemId === item.id
        ? checklistItemEditor(task, item)
        : linkedTask
          ? taskCard(linkedTask, { compact: true, linked: true })
          : node("span", { class: "task-checklist-text", text: item.text });
      const next = checklist[index + 1];
      const afterNext = checklist[index + 2];
      const actions = node("div", { class: "task-checklist-actions" }, [
        ...(index > 0 ? [checklistAction("↑", "Переместить выше", () => emitChecklist(task, "move", {
          itemId: item.id,
          beforeItemId: checklist[index - 1].id,
        }))] : []),
        ...(next ? [checklistAction("↓", "Переместить ниже", () => emitChecklist(task, "move", {
          itemId: item.id,
          beforeItemId: afterNext?.id ?? null,
        }))] : []),
        checklistAction("Изменить", "Редактировать текст пункта", () => {
          state.editingChecklistItemId = item.id;
          renderOpenTaskCard();
        }),
        checklistLinkSelect(task, item),
        ...(item.linkedTaskId ? [checklistAction("Отвязать", "Оставить Task без удаления", () => (
          emitChecklist(task, "unlink", { itemId: item.id })
        ))] : canExtract ? [checklistAction("Вынести", "Создать отдельную Task", () => (
          emitChecklist(task, "extract", { itemId: item.id })
        ))] : []),
        checklistAction("Удалить", "Удалить пункт", () => emitChecklist(task, "remove", {
          itemId: item.id,
        }), "board-task-remove"),
      ]);
      for (const control of actions.querySelectorAll?.("button, select") ?? []) control.disabled = busy;
      const linkedActionPrompt = checklistLinkedTaskActionPrompt(task, item);
      return node("li", {
        class: `task-checklist-item${item.completed ? " is-completed" : ""}${linkedTask ? " is-linked" : ""}`,
        "data-checklist-item-id": item.id,
      }, [checkbox, node("div", { class: "task-checklist-body" }, [
        content,
        ...(linkedActionPrompt ? [linkedActionPrompt] : []),
        actions,
      ])]);
    }));
  }

  function renderTaskChecklistParent(task) {
    if (!taskChecklistParent || !taskChecklistParentItem || !taskChecklistParentCard) return;
    const relationship = task.checklistParent;
    const parent = relationship?.task
      ? state.tasks.find((candidate) => candidate.id === relationship.task.id) ?? relationship.task
      : null;
    taskChecklistParent.hidden = !parent;
    taskChecklistParentItem.textContent = parent
      ? `Пункт: ${String(relationship.text ?? "").trim() || relationship.itemId}`
      : "";
    taskChecklistParentCard.replaceChildren(...(parent
      ? [taskCard(parent, { compact: true, linked: true })]
      : []));
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
    const savingChecklist = state.pendingChecklistActions.has(taskId);
    if (taskCardTitle) taskCardTitle.disabled = saving;
    if (taskCardDescription) taskCardDescription.disabled = saving;
    if (taskCardStatus) taskCardStatus.disabled = savingStatus;
    if (taskChecklistAddInput) taskChecklistAddInput.disabled = savingChecklist;
    if (taskChecklistAddButton) {
      taskChecklistAddButton.disabled = savingChecklist;
      taskChecklistAddButton.setAttribute("aria-busy", String(savingChecklist));
    }
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

  async function readTaskAttachmentFiles(files) {
    const task = state.tasks.find((item) => item.id === state.openTaskId);
    if (!task || state.attachingTaskId != null) return;
    const selection = taskAttachmentFiles(files);
    if (!selection.accepted.length) {
      if (selection.oversized) window.AgentHub?.toast?.("Размер одного файла не должен превышать 20 МБ.");
      return;
    }
    state.attachingTaskId = task.id;
    renderTaskCardSaving(task.id);
    let attachments;
    try {
      attachments = await Promise.all(selection.accepted.map((file) => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({
          name: file.name,
          type: file.type || "application/octet-stream",
          size: file.size,
          dataUrl: String(reader.result).replace(/^data:;base64,/u, "data:application/octet-stream;base64,"),
        });
        reader.onerror = () => reject(new Error(`Не удалось прочитать файл «${file.name}»`));
        reader.readAsDataURL(file);
      })));
    } catch (error) {
      state.attachingTaskId = null;
      renderTaskCardSaving(task.id);
      window.AgentHub?.toast?.(error.message);
      return;
    }
    emit("attachment-add", { id: task.id, attachments });
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
    const previewNumber = document.querySelector("[data-task-preview-number]");
    const previewTitle = document.querySelector("[data-task-preview-title]");
    const previewDescription = document.querySelector("[data-task-preview-description]");
    if (previewNumber) previewNumber.textContent = task.taskNumber || "";
    if (previewTitle) previewTitle.textContent = task.title || task.text;
    if (previewDescription) previewDescription.textContent = task.description || "Описание пока не добавлено.";
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
    if (taskCardExecutor) {
      const executor = taskExecutorPresentation(task, state.workspaces);
      taskCardExecutor.textContent = executor.label;
      taskCardExecutor.disabled = !executor.stream;
      taskCardExecutor.title = executor.stream ? `Открыть Stream ${executor.label}` : "Stream не назначен или недоступен";
    }
    renderTaskChecklist(task);
    renderTaskChecklistParent(task);
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
    syncTaskCardBackdrop();
  }

  function openTaskCard(task, { modal = false } = {}) {
    if (modal && taskCardIsDocked()) dockedScrollTop = taskCardContent?.scrollTop ?? 0;
    state.taskCardModalRequested = modal;
    state.openTaskId = task.id;
    state.editingTaskId = null;
    state.editDirty = false;
    taskCardModal?.classList.remove("is-editing");
    setTaskCardOriginalExpanded(false);
    renderOpenTaskCard();
    syncTaskCardPlacement();
    if (taskCardContent) taskCardContent.scrollTop = 0;
    scheduleTaskCardEditorSizing();
  }

  let firstBoardClick = null;

  function continuesBoardDoubleClick(event) {
    return event.detail === 2 && event.button === 0 && firstBoardClick
      && firstBoardClick.card.isConnected
      && firstBoardClick.card.dataset.boardTaskId === firstBoardClick.id
      && state.openTaskId === firstBoardClick.id && taskCardIsDocked()
      && Math.abs(event.clientX - firstBoardClick.x) <= 4
      && Math.abs(event.clientY - firstBoardClick.y) <= 4;
  }

  // Docking shifts columns after the first click. Preserve the original connected
  // row for the browser's native double-click sequence, without delaying preview.
  document.addEventListener("mousedown", (event) => {
    if (event.detail === 1) firstBoardClick = null;
  }, true);
  document.addEventListener("click", (event) => {
    if (!continuesBoardDoubleClick(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  document.addEventListener("dblclick", (event) => {
    if (!continuesBoardDoubleClick(event)) return;
    const task = state.tasks.find((candidate) => candidate.id === firstBoardClick.id);
    firstBoardClick = null;
    if (!task) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    openTaskCard(task, { modal: true });
  }, true);

  function taskCard(task, { compact = false, linked = false, movable = !compact, boardRow = false } = {}) {
    const completed = task.status === "done";
    const movableCard = movable && !completed;
    const attachable = !linked && movableCard;
    const card = node("article", {
      class: `board-task-card${task.status === "started" ? " is-started" : ""}${completed ? " is-completed" : ""}${compact ? " is-compact" : ""}`,
      draggable: attachable ? "true" : null,
      role: "button",
      tabindex: "0",
      "aria-label": `Открыть задачу ${task.title || task.text}`,
      "data-board-task-id": task.id,
      "data-board-task-movable": movableCard ? "true" : null,
      onclick: (event) => {
        event?.stopPropagation?.();
        if (boardRow && event.detail === 1) firstBoardClick = {
          card, id: task.id, x: event.clientX, y: event.clientY,
        };
        openTaskCard(state.tasks.find((candidate) => candidate.id === task.id) ?? task);
      },
      onkeydown: (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        openTaskCard(task, { modal: boardRow && event.shiftKey });
      },
      ondragstart: attachable ? (event) => {
        TaskReferences.beginDrag(event.dataTransfer, task);
      } : null,
      ondragend: attachable ? () => TaskReferences.endDrag() : null,
    });
    if (movableCard) {
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
        const columnDestination = card.closest("[data-board-destination]")?.dataset.boardDestination;
        moveTask(draggedTask, columnDestination || destinationValue(task), task.id);
      });
    }
    const [numberSummary, executorSummary, statusSummary] = taskSummaryItems(
      task,
      state.workspaces,
      state.statusLanguage,
    );
    const linkedExecutor = linked ? taskExecutorPresentation(task, state.workspaces) : null;
    card.append(node("div", { class: "board-task-summary" }, [
      node("span", {
        class: `board-task-number${numberSummary.placeholder ? " is-placeholder" : ""}`,
        text: numberSummary.text,
        title: numberSummary.title || null,
        "aria-hidden": numberSummary.placeholder ? "true" : null,
      }),
      linked && String(task.streamId ?? "").trim()
        ? node("button", {
          type: "button",
          class: "board-task-executor is-link",
          text: linkedExecutor?.stream ? executorSummary.text : "Stream недоступен",
          title: linkedExecutor?.stream ? `Открыть ${executorSummary.title}` : "Stream недоступен",
          disabled: !linkedExecutor?.stream,
          onclick: linkedExecutor?.stream ? (event) => openTaskExecutor(task, event) : null,
        })
        : node("span", {
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
    if (boardRow) {
      const workspaceName = task.bucket === "notes" ? "Заметки"
        : task.bucket === "backlog" ? "Бэклог"
          : workspaceById(task.workspaceId)?.name || "Workspace недоступен";
      card.querySelector(".board-task-summary").append(node("span", {
        class: "board-task-workspace", text: showsWorkspaceContext() ? workspaceName : "",
        title: showsWorkspaceContext() ? workspaceName : null,
      }));
    }
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
    acceptsTaskDrops = movable, emptyText = "Нет задач",
  }) {
    const column = node("section", {
      class: `task-board-column ${accent}${workspace ? " is-workspace" : ""}`,
      "data-board-destination": acceptsTaskDrops ? id : null,
      "data-board-workspace-id": workspace?.id,
    });
    column.addEventListener("dragover", (event) => {
      if (!acceptsTaskDrops) return;
      if (hasColumnDrag(event.dataTransfer) && !movable) return;
      event.preventDefault();
      column.classList.add("is-dragover");
    });
    column.addEventListener("dragleave", () => column.classList.remove("is-dragover"));
    column.addEventListener("drop", (event) => {
      if (!acceptsTaskDrops) return;
      event.preventDefault();
      column.classList.remove("is-dragover");
      const movedColumnId = draggedColumnId(event.dataTransfer);
      if (movedColumnId) {
        if (!movable) return;
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
    column.append(node("div", { class: "task-board-row-head", "aria-hidden": "true" }, [
      node("span", { text: "ID" }),
      node("span", { text: showsWorkspaceContext() ? "Workspace" : "" }),
      node("span", { text: "Поток" }),
    ]));
    const list = node("div", { class: "task-board-column-list" });
    if (workspace && state.creatingWorkspaceId === workspace.id) list.append(renderCreateForm(workspace));
    if (!tasks.length && state.creatingWorkspaceId !== workspace?.id) {
      list.append(node("p", { class: "task-board-empty", text: emptyText }));
    } else {
      for (const task of tasks) list.append(taskCard(task, { boardRow: true }));
    }
    column.append(list);
    return column;
  }

  function selectedScopeTasks(tasks) {
    if (state.boardScope === "notes") return tasks.filter((task) => task.bucket === "notes");
    if (state.boardScope.startsWith("folder:")) {
      const folder = state.boardScope.slice(7);
      const ids = new Set(state.workspaces.filter((workspace) => workspaceFolder(workspace) === folder).map((workspace) => workspace.id));
      return tasks.filter((task) => task.bucket === "workspace" && ids.has(task.workspaceId));
    }
    if (state.boardScope.startsWith("workspace:")) {
      const workspaceId = state.boardScope.slice(10);
      return tasks.filter((task) => task.bucket === "workspace" && task.workspaceId === workspaceId);
    }
    return tasks.filter((task) => task.bucket === "workspace" || task.bucket === "notes");
  }

  function showsWorkspaceContext() {
    return state.boardScope === "all" || state.boardScope.startsWith("folder:");
  }

  function workspaceFolder(workspace) {
    return window.AgentHubStreamTabs?.normalizeWorkspaceFolderName(workspace?.settings?.catalogFolder) || "";
  }

  const expandedBoardFolders = new Map();

  function scopeButton(scope) {
    const destination = scope.id === "notes" || scope.id.startsWith("workspace:");
    return node("button", {
      type: "button",
      class: `task-board-scope${state.boardScope === scope.id ? " is-selected" : ""}`,
      "aria-pressed": String(state.boardScope === scope.id),
      "data-board-scope": scope.id,
      "data-board-destination": destination ? scope.id : null,
      draggable: destination ? "true" : null,
      ondragstart: destination ? (event) => {
        state.draggingColumnId = scope.id;
        event.dataTransfer.setData(COLUMN_MIME, scope.id);
        event.dataTransfer.effectAllowed = "move";
      } : null,
      ondragend: () => { state.draggingColumnId = null; },
      ondragover: (event) => {
        if (!destination) return;
        event.preventDefault();
        event.currentTarget.classList.add("is-dragover");
      },
      ondragleave: (event) => event.currentTarget.classList.remove("is-dragover"),
      ondrop: (event) => {
        if (!destination) return;
        event.preventDefault();
        event.currentTarget.classList.remove("is-dragover");
        const columnId = draggedColumnId(event.dataTransfer);
        if (columnId) {
          if (columnId !== scope.id) emit("move-column", { columnId, beforeColumnId: scope.id });
          return;
        }
        const taskId = TaskReferences.fromTransfer(event.dataTransfer)?.taskId;
        const task = state.tasks.find((item) => item.id === taskId);
        if (task && task.status !== "done") moveTask(task, scope.id);
      },
      text: `${scope.label} · ${scope.count}`,
      onclick: () => {
        state.boardScope = scope.id;
        state.creatingWorkspaceId = null;
        renderBoard();
      },
    });
  }

  function renderScopeStrip() {
    if (!scopeStrip) return;
    const openTasks = (predicate) => tasksForMode(state.tasks, { completedOnly: state.completedOnly }).filter(predicate).length;
    const scopes = [
      { id: "all", label: "Все задачи", count: openTasks((task) => task.bucket !== "backlog") },
      ...state.workspaces.map((workspace) => ({
        id: `workspace:${workspace.id}`,
        label: workspace.name,
        folder: workspaceFolder(workspace),
        count: openTasks((task) => task.bucket === "workspace" && task.workspaceId === workspace.id),
      })),
      { id: "notes", label: "Заметки", count: openTasks((task) => task.bucket === "notes") },
    ];
    const scopeById = new Map(scopes.map((scope) => [scope.id, scope]));
    const orderedScopes = [...new Set(["all", ...state.columnOrder, ...scopes.map((scope) => scope.id)])]
      .map((id) => scopeById.get(id)).filter(Boolean);
    const folders = new Set();
    const groups = [];
    for (const scope of orderedScopes) {
      if (!scope.folder) { groups.push(scopeButton(scope)); continue; }
      if (folders.has(scope.folder)) continue;
      folders.add(scope.folder);
      const members = orderedScopes.filter((candidate) => candidate.folder === scope.folder);
      const selectedMember = members.find((candidate) => candidate.id === state.boardScope);
      const folderScope = { id: `folder:${scope.folder}`, label: scope.folder,
        count: members.reduce((sum, member) => sum + member.count, 0) };
      const main = scopeButton(folderScope);
      main.title = `Все Workspace папки ${scope.folder}`;
      const expanded = expandedBoardFolders.get(scope.folder) ?? true;
      const memberList = node("div", {
        class: "task-workspace-folder-list", hidden: expanded ? null : "",
      }, members.map(scopeButton));
      const toggle = node("button", {
        type: "button", class: "task-board-folder-toggle", text: expanded ? "⌄" : "›",
        "aria-label": `Выбрать Workspace в папке ${scope.folder}`,
        "aria-expanded": String(expanded),
        onclick: () => {
          const open = memberList.hidden;
          memberList.hidden = !open;
          expandedBoardFolders.set(scope.folder, open);
          toggle.setAttribute("aria-expanded", String(open));
          toggle.textContent = open ? "⌄" : "›";
        },
      });
      groups.push(node("div", {
        class: `task-board-folder task-workspace-folder-details${selectedMember || state.boardScope === folderScope.id ? " is-selected" : ""}`,
      }, [node("div", { class: "task-board-folder-heading" }, [main, toggle]), memberList]));
    }
    scopeStrip.replaceChildren(...groups);
  }

  function renderBoard() {
    const scrollSnapshot = taskBoardScrollSnapshot({ workspaces: boardColumnRegions.columns });
    pointerTaskDrag.cancelForRerender();
    const visibleTasks = tasksForMode(state.tasks, { completedOnly: state.completedOnly });
    const emptyText = state.completedOnly ? "Нет закрытых задач" : "Нет задач";
    if ((state.boardScope.startsWith("workspace:") && !workspaceById(state.boardScope.slice(10)))
      || (state.boardScope.startsWith("folder:") && !state.workspaces.some((workspace) => workspaceFolder(workspace) === state.boardScope.slice(7)))) {
      state.boardScope = "all";
    }
    board.classList.toggle("has-workspace-context", showsWorkspaceContext());
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
    if (filterControls) filterControls.hidden = !state.filtersOpen;
    filterToggle?.setAttribute("aria-expanded", String(state.filtersOpen));
    renderScopeStrip();
    const rendered = state.boardScope === "all" ? [] : [renderColumn({
      id: "backlog", title: "Бэклог", subtitle: "Неразобранные входящие",
      tasks: visibleTasks.filter((task) => task.bucket === "backlog"), accent: "is-backlog", emptyText,
      acceptsTaskDrops: !state.completedOnly,
    })];
    const scopedTasks = selectedScopeTasks(visibleTasks);
    const statuses = state.completedOnly ? ["done"] : TASK_WORKFLOW_STATUSES.filter((status) => (
      status !== "done" || scopedTasks.some((task) => taskWorkflowStatus(task) === "done")
    ));
    for (const status of statuses) {
      const presentation = taskWorkflowPresentation({ workflowStatus: status }, state.statusLanguage);
      rendered.push(renderColumn({
        id: `status:${state.boardScope}:${status}`,
        title: presentation.full,
        subtitle: state.boardScope === "notes" ? state.notesComment : "",
        tasks: scopedTasks.filter((task) => taskWorkflowStatus(task) === status),
        accent: `is-status-${status}`,
        acceptsTaskDrops: !state.completedOnly,
        workspace: status === "new" && state.boardScope.startsWith("workspace:")
          ? workspaceById(state.boardScope.slice(10)) : null,
        emptyText,
      }));
    }
    replaceBoardColumnsPreservingScroll(boardColumnRegions.columns, rendered);
    restoreTaskBoardScroll({ workspaces: boardColumnRegions.columns }, scrollSnapshot);
    if (state.openTaskId) syncTaskCardPlacement();
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
  filterToggle?.addEventListener("click", () => {
    state.filtersOpen = !state.filtersOpen;
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
  window.addEventListener("resize", () => {
    syncTaskCardPlacement();
    scheduleTaskCardEditorSizing();
  }, { passive: true });
  if (typeof MutationObserver === "function") {
    new MutationObserver(() => {
      syncTaskCardPlacement();
      scheduleTaskCardEditorSizing();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-view"] });
  }
  taskCardModal?.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.defaultPrevented && taskCardIsDocked()) {
      event.preventDefault();
      dismissTaskCard();
    }
  });
  function dismissTaskCard() {
    if (state.taskCardModalRequested && dashboardHasDetailPanel()) {
      state.taskCardModalRequested = false;
      syncTaskCardPlacement();
      if (taskCardContent) taskCardContent.scrollTop = dockedScrollTop;
      scheduleTaskCardEditorSizing();
      taskCardModal.querySelector("[data-task-card-close]")?.focus();
    } else closeTaskCard();
  }
  document.querySelector("[data-task-card-close]")?.addEventListener("click", dismissTaskCard);
  document.querySelector("[data-task-card-edit-toggle]")?.addEventListener("click", () => {
    taskCardModal.classList.add("is-editing");
    scheduleTaskCardEditorSizing();
    taskCardTitle.focus();
  });
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
  taskCardExecutor?.addEventListener("click", (event) => {
    const task = state.tasks.find((item) => item.id === state.openTaskId);
    if (task) openTaskExecutor(task, event);
  });
  taskChecklistAddForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const task = state.tasks.find((item) => item.id === state.openTaskId);
    const text = taskChecklistAddInput?.value.trim();
    if (!task || !text) return;
    emitChecklist(task, "add", { text });
  });
  taskCardAttachmentAdd?.addEventListener("click", () => taskCardAttachmentInput?.click());
  taskCardAttachmentInput?.addEventListener("change", () => {
    void readTaskAttachmentFiles(taskCardAttachmentInput.files);
    taskCardAttachmentInput.value = "";
  });
  taskCardModal?.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    event.preventDefault();
    void readTaskAttachmentFiles(files);
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
  modalOverlays?.installDismissibleOverlay({
    dialog: taskCardModal,
    close: dismissTaskCard,
  });
  modalOverlays?.installDismissibleOverlay({
    dialog: startModal,
    close: closeStart,
  });
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
    finishAction({ type, id, succeeded, requestId = null, operation = null, itemId = null } = {}) {
      if (type === "update" && state.savingTaskId === id) {
        state.savingTaskId = null;
        if (succeeded) {
          state.editDirty = false;
          renderOpenTaskCard();
          dismissTaskCard();
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
      if (type === "checklist") {
        const pending = state.pendingChecklistActions.get(id);
        if (
          !pending
          || pending.requestId !== String(requestId ?? "")
          || pending.operation !== String(operation ?? "")
          || pending.itemId !== String(itemId ?? "")
        ) return;
        state.pendingChecklistActions.delete(id);
        if (succeeded && pending.operation === "add" && state.openTaskId === id && taskChecklistAddInput) {
          taskChecklistAddInput.value = "";
        }
        if (succeeded && pending.operation === "toggle" && pending.completed && pending.linkedTaskId) {
          const task = state.tasks.find((candidate) => candidate.id === id);
          const item = task?.checklist?.find((candidate) => candidate.id === pending.itemId);
          const linkedTask = state.tasks.find((candidate) => candidate.id === pending.linkedTaskId)
            ?? item?.linkedTask;
          const workspace = workspaceById(task?.workspaceId);
          if (
            task && item?.manualCompleted === true
            && item.linkedTaskId === pending.linkedTaskId
            && linkedTask?.revision
            && workspace?.settings?.releaseWorkflowEnabled !== true
          ) {
            state.checklistLinkedActionPrompts.set(id, {
              taskId: id,
              itemId: pending.itemId,
              linkedTaskId: pending.linkedTaskId,
              expectedTaskRevision: task.revision,
              expectedLinkedTaskRevision: linkedTask.revision,
              requestId: checklistLinkedActionRequestId(id),
              selectedAction: null,
              pending: false,
            });
          }
        }
        if (state.openTaskId === id) renderOpenTaskCard();
      }
      if (type === "checklist-linked-task-action") {
        const prompt = state.checklistLinkedActionPrompts.get(id);
        if (!prompt || prompt.requestId !== String(requestId ?? "")) return;
        if (succeeded) state.checklistLinkedActionPrompts.delete(id);
        else prompt.pending = false;
        if (state.openTaskId === id) renderOpenTaskCard();
      }
    },
  });
  document.addEventListener("agenthub:task-reference-open", createTaskReferenceOpenHandler({
    getTasks: () => state.tasks,
    openTask: openTaskCard,
  }));
})();
