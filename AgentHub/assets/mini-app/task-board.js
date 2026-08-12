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

  window.AgentHubTaskCardSizing = Object.freeze({ fitWidth: fitTaskCardWidth });

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

  const board = document.querySelector("[data-task-board]");
  const columns = document.querySelector("[data-task-board-columns]");
  const workspacePanel = document.querySelector("[data-workspace-task-panel]");
  const workspacePanelList = document.querySelector("[data-workspace-task-list]");
  const workspacePanelTitle = document.querySelector("[data-workspace-task-title]");
  const taskCardModal = document.querySelector("[data-task-card-modal]");
  const taskCardSource = document.querySelector("[data-task-card-source]");
  const taskCardEditor = document.querySelector("[data-task-card-editor]");
  const taskCardTitle = document.querySelector("[data-task-card-title]");
  const taskCardDescription = document.querySelector("[data-task-card-description]");
  const taskCardTitleSizer = createAutoGrowTextarea({ textarea: taskCardTitle });
  const taskCardSaveButton = taskCardEditor?.querySelector("button[type='submit']");
  const taskCardAttachments = document.querySelector("[data-task-card-attachments]");
  const taskCardOriginal = document.querySelector("[data-task-card-original]");
  const taskCardOriginalToggle = document.querySelector("[data-task-card-original-toggle]");
  const taskCardOriginalText = document.querySelector("[data-task-card-original-text]");
  const taskCardActions = document.querySelector("[data-task-card-actions]");
  const taskDeleteModal = document.querySelector("[data-task-delete-modal]");
  const taskDeleteCancel = document.querySelector("[data-task-delete-cancel]");
  const taskDeleteConfirm = document.querySelector("[data-task-delete-confirm]");
  const startModal = document.querySelector("[data-task-start-modal]");
  const startTitle = document.querySelector("[data-task-start-title]");
  const startOptions = document.querySelector("[data-task-start-options]");
  const startNewForm = document.querySelector("[data-task-start-new]");
  const startNewName = document.querySelector("[data-task-start-new-name]");
  const startProvider = document.querySelector("[data-task-start-provider]");
  if (!board || !columns) return;

  const TASK_MIME = "application/x-agent-hub-board-task";
  const COLUMN_MIME = "application/x-agent-hub-board-column";
  const COLUMN_TEXT_PREFIX = "agent-hub-column:";
  const TASK_CARD_MAX_TEXT_LINES = 6;
  const TASK_CARD_MAX_WIDTH_REM = 42;
  let taskCardSizingFrame = null;

  const state = {
    tasks: [],
    workspaces: [],
    columnOrder: [],
    notesComment: "Игры, фильмы, сериалы и идеи",
    selectedWorkspaceId: null,
    provider: "codex",
    openTaskId: null,
    startingTaskId: null,
    creatingWorkspaceId: null,
    draggingColumnId: null,
    editingTaskId: null,
    editDirty: false,
    savingTaskId: null,
    removingTaskId: null,
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

  function resizeTaskCards() {
    taskCardSizingFrame = null;
    const columnNodes = Array.from(columns.querySelectorAll(".task-board-column"));
    for (const column of columnNodes) {
      column.style.removeProperty("--task-column-card-width");
      for (const card of column.querySelectorAll(".board-task-card:not(.is-compact)")) {
        card.style.removeProperty("inline-size");
        card.removeAttribute("data-width-expanded");
      }
    }

    const rootFontSize = numericCssValue(window.getComputedStyle(document.documentElement).fontSize) || 16;
    const boardStyle = window.getComputedStyle(columns);
    const boardInnerWidth = Math.max(1, columns.clientWidth
      - numericCssValue(boardStyle.paddingLeft)
      - numericCssValue(boardStyle.paddingRight));

    for (const column of columnNodes) {
      const list = column.querySelector(".task-board-column-list");
      const cards = Array.from(list?.querySelectorAll(".board-task-card:not(.is-compact)") ?? []);
      if (!list || !cards.length) continue;

      const baseWidth = Math.max(1, Math.round(cards[0].getBoundingClientRect().width));
      const maxWidth = Math.max(baseWidth, Math.min(
        TASK_CARD_MAX_WIDTH_REM * rootFontSize,
        boardInnerWidth - (2 * rootFontSize),
      ));
      let widestCard = baseWidth;

      for (const card of cards) {
        const title = card.querySelector(".board-task-title");
        if (!title) continue;
        const titleStyle = window.getComputedStyle(title);
        const lineHeight = numericCssValue(titleStyle.lineHeight)
          || (numericCssValue(titleStyle.fontSize) * 1.35);
        const desiredWidth = fitTaskCardWidth({
          baseWidth,
          maxWidth,
          maxHeight: lineHeight * TASK_CARD_MAX_TEXT_LINES,
          measureHeight: (width) => {
            card.style.setProperty("inline-size", `${width}px`);
            return title.scrollHeight;
          },
        });
        card.style.setProperty("inline-size", `${desiredWidth}px`);
        if (desiredWidth > baseWidth + 1) card.setAttribute("data-width-expanded", "");
        widestCard = Math.max(widestCard, desiredWidth);
      }

      const listStyle = window.getComputedStyle(list);
      const listPadding = numericCssValue(listStyle.paddingLeft) + numericCssValue(listStyle.paddingRight);
      column.style.setProperty("--task-column-card-width", `${Math.ceil(widestCard + listPadding)}px`);
    }
  }

  function scheduleTaskCardSizing() {
    if (taskCardSizingFrame != null) window.cancelAnimationFrame(taskCardSizingFrame);
    taskCardSizingFrame = window.requestAnimationFrame(resizeTaskCards);
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

  function openStart(task) {
    const workspace = workspaceById(task.workspaceId);
    if (!workspace) return;
    state.startingTaskId = task.id;
    startTitle.textContent = task.title || task.text;
    startOptions.replaceChildren();
    for (const stream of workspace.streams ?? []) {
      startOptions.append(node("button", {
        type: "button",
        class: "task-start-stream",
        onclick: () => {
          closeStart();
          emit("start", {
            id: task.id,
            workspaceId: workspace.id,
            streamId: stream.id,
            provider: state.provider,
          });
        },
      }, [
        node("strong", { text: stream.displayName || stream.name || `Stream ${stream.ordinal}` }),
        node("span", { text: `${(stream.threads ?? []).length} диалогов` }),
      ]));
    }
    if (!(workspace.streams ?? []).length) {
      startOptions.append(node("p", { class: "task-start-empty", text: "В Workspace пока нет Streams." }));
    }
    startNewName.value = (task.title || task.text).slice(0, 80);
    startProvider.value = state.provider;
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
    if (taskCardTitle) taskCardTitle.disabled = saving;
    if (taskCardDescription) taskCardDescription.disabled = saving;
    if (taskCardSaveButton) {
      taskCardSaveButton.disabled = saving;
      taskCardSaveButton.setAttribute("aria-busy", String(saving));
      taskCardSaveButton.textContent = saving ? "Сохраняю…" : "Сохранить изменения";
    }
  }

  function renderOpenTaskCard() {
    if (!taskCardModal) return;
    const task = state.tasks.find((item) => item.id === state.openTaskId && item.status !== "done");
    if (!task) {
      if (state.openTaskId) closeTaskCard();
      return;
    }
    taskCardSource.textContent = task.source === "telegram" ? "Telegram" : "Hub";
    if (state.editingTaskId !== task.id || !state.editDirty) {
      taskCardTitle.value = task.title || task.text;
      taskCardDescription.value = String(task.description ?? "").trim();
      state.editingTaskId = task.id;
    }
    if (taskCardModal.open) taskCardTitleSizer.resize();
    renderTaskCardSaving(task.id);
    const originalText = String(task.rawText ?? "").trim();
    taskCardOriginal.hidden = !originalText;
    taskCardOriginalText.textContent = originalText;
    if (!originalText) setTaskCardOriginalExpanded(false);
    const attachments = Array.isArray(task.attachments) ? task.attachments : [];
    taskCardAttachments.hidden = attachments.length === 0;
    taskCardAttachments.replaceChildren(...(attachments.length ? [attachmentStrip(attachments)] : []));
    const actions = [];
    if (task.bucket === "workspace") {
      actions.push(node("button", {
        type: "button",
        class: "board-task-primary",
        text: task.status === "started" ? "Продолжить" : "Начать работу",
        onclick: () => { closeTaskCard(); openStart(task); },
      }));
    }
    actions.push(destinationSelect(task));
    if (task.triageStatus === "failed") {
      actions.push(node("button", {
        type: "button", class: "board-task-quiet", text: "Повторить Spark",
        onclick: () => emit("retry-triage", { id: task.id }),
      }));
    }
    actions.push(node("button", {
      type: "button", class: "board-task-quiet", text: "Завершить задачу",
      title: "Убрать задачу с доски как выполненную",
      onclick: () => { closeTaskCard(); emit("complete", { id: task.id }); },
    }));
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
    taskCardTitleSizer.resize();
  }

  function taskCard(task, { compact = false } = {}) {
    const card = node("article", {
      class: `board-task-card${task.status === "started" ? " is-started" : ""}${compact ? " is-compact" : ""}`,
      draggable: compact ? null : "true",
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
        event.dataTransfer.setData(TASK_MIME, task.id);
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.effectAllowed = "move";
      },
    });
    if (!compact) {
      card.addEventListener("dragover", (event) => {
        if (hasColumnDrag(event.dataTransfer)) return;
        if (!Array.from(event.dataTransfer.types).includes(TASK_MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.add("is-dragover");
      });
      card.addEventListener("dragleave", () => card.classList.remove("is-dragover"));
      card.addEventListener("drop", (event) => {
        if (draggedColumnId(event.dataTransfer)) return;
        const draggedId = event.dataTransfer.getData(TASK_MIME) || event.dataTransfer.getData("text/plain");
        if (!draggedId || draggedId === task.id) return;
        const draggedTask = state.tasks.find((item) => item.id === draggedId);
        if (!draggedTask) return;
        event.preventDefault();
        event.stopPropagation();
        card.classList.remove("is-dragover");
        moveTask(draggedTask, destinationValue(task), task.id);
      });
    }
    card.append(node("h3", { class: "board-task-title", text: task.title || task.text }));
    if (task.attachments?.length) card.append(attachmentStrip(task.attachments, { compact: true }));
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

  function renderColumn({ id, title, subtitle, tasks, accent = "", workspace = null, movable = false }) {
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
      const taskId = event.dataTransfer.getData(TASK_MIME) || event.dataTransfer.getData("text/plain");
      const task = state.tasks.find((item) => item.id === taskId);
      if (task) moveTask(task, id);
    });
    const controls = node("div", { class: "task-board-column-controls" }, [
      ...(workspace ? [node("button", {
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
      list.append(node("p", { class: "task-board-empty", text: "Перетащите задачу сюда" }));
    } else {
      for (const task of tasks) list.append(taskCard(task));
    }
    column.append(list);
    return column;
  }

  function renderBoard() {
    const openTasks = state.tasks.filter((task) => task.status !== "done");
    columns.style.setProperty("--board-column-count", String(state.workspaces.length + 2));
    const rendered = new Map();
    rendered.set("backlog", renderColumn({
      id: "backlog", title: "Бэклог", subtitle: "Неразобранные входящие",
      tasks: openTasks.filter((task) => task.bucket === "backlog"), accent: "is-backlog",
    }));
    for (const workspace of state.workspaces) {
      const id = `workspace:${workspace.id}`;
      rendered.set(id, renderColumn({
        id,
        title: workspace.name,
        subtitle: workspace.comment ?? "",
        tasks: openTasks.filter((task) => task.bucket === "workspace" && task.workspaceId === workspace.id),
        workspace, movable: true,
      }));
    }
    rendered.set("notes", renderColumn({
      id: "notes", title: "Заметки", subtitle: state.notesComment,
      tasks: openTasks.filter((task) => task.bucket === "notes"),
      accent: "is-notes", movable: true,
    }));
    const orderedIds = ["backlog", ...state.columnOrder.filter((id) => rendered.has(id) && id !== "backlog")];
    for (const id of rendered.keys()) if (!orderedIds.includes(id)) orderedIds.push(id);
    columns.replaceChildren(...orderedIds.map((id) => rendered.get(id)));
    scheduleTaskCardSizing();
  }

  function renderWorkspacePanel() {
    const workspace = workspaceById(state.selectedWorkspaceId);
    const tasks = workspace
      ? state.tasks.filter((task) => task.status !== "done" && task.bucket === "workspace" && task.workspaceId === workspace.id)
      : [];
    workspacePanel.hidden = !workspace;
    if (!workspace) return;
    workspacePanelTitle.textContent = `Задачи · ${workspace.name}`;
    workspacePanelList.replaceChildren();
    if (!tasks.length) {
      workspacePanelList.append(node("p", { class: "workspace-task-empty", text: "Нет назначенных задач" }));
      return;
    }
    for (const task of tasks.slice(0, 6)) workspacePanelList.append(taskCard(task, { compact: true }));
  }

  document.querySelector("[data-task-start-close]")?.addEventListener("click", closeStart);
  window.addEventListener("resize", scheduleTaskCardSizing, { passive: true });
  if (typeof window.ResizeObserver === "function") {
    new window.ResizeObserver(scheduleTaskCardSizing).observe(columns);
  }
  document.fonts?.ready?.then(scheduleTaskCardSizing).catch(() => {});
  document.querySelector("[data-task-card-close]")?.addEventListener("click", closeTaskCard);
  taskCardOriginalToggle?.addEventListener("click", () => {
    setTaskCardOriginalExpanded(taskCardOriginalToggle.getAttribute("aria-expanded") !== "true");
  });
  taskCardEditor?.addEventListener("input", () => { state.editDirty = true; });
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
    emit("update", { id: task.id, title, description: taskCardDescription.value.trim() });
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
    });
  });
  document.querySelector("[data-workspace-task-dashboard]")?.addEventListener("click", () => {
    document.querySelector("[data-view-button='dashboard']")?.click();
  });

  window.AgentHubTaskBoard = Object.freeze({
    setSelectedWorkspace(workspaceId) {
      const nextWorkspaceId = String(workspaceId ?? "").trim() || null;
      if (state.selectedWorkspaceId === nextWorkspaceId) return;
      state.selectedWorkspaceId = nextWorkspaceId;
      renderWorkspacePanel();
    },
    setSnapshot(payload = {}) {
      state.tasks = Array.isArray(payload.tasks) ? payload.tasks.slice() : [];
      state.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces.slice() : [];
      state.columnOrder = Array.isArray(payload.columnOrder) ? payload.columnOrder.slice() : [];
      state.notesComment = String(payload.notesComment ?? "Игры, фильмы, сериалы и идеи");
      state.selectedWorkspaceId = payload.selectedWorkspaceId ?? null;
      state.provider = payload.provider === "claude" ? "claude" : "codex";
      renderBoard();
      renderWorkspacePanel();
      renderOpenTaskCard();
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
    },
  });
})();
