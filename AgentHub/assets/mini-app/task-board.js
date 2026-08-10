"use strict";

(() => {
  const board = document.querySelector("[data-task-board]");
  const columns = document.querySelector("[data-task-board-columns]");
  const workspacePanel = document.querySelector("[data-workspace-task-panel]");
  const workspacePanelList = document.querySelector("[data-workspace-task-list]");
  const workspacePanelTitle = document.querySelector("[data-workspace-task-title]");
  const taskCardModal = document.querySelector("[data-task-card-modal]");
  const taskCardSource = document.querySelector("[data-task-card-source]");
  const taskCardTitle = document.querySelector("[data-task-card-title]");
  const taskCardDescription = document.querySelector("[data-task-card-description]");
  const taskCardEmptyDescription = document.querySelector("[data-task-card-empty-description]");
  const taskCardOriginal = document.querySelector("[data-task-card-original]");
  const taskCardOriginalText = document.querySelector("[data-task-card-original-text]");
  const taskCardActions = document.querySelector("[data-task-card-actions]");
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
  };

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

  function emit(type, detail = {}) {
    document.dispatchEvent(new CustomEvent("agenthub:board-action", {
      detail: { type, ...detail },
    }));
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
    state.openTaskId = null;
    taskCardModal?.close?.();
    taskCardModal?.removeAttribute("open");
  }

  function renderOpenTaskCard() {
    if (!taskCardModal) return;
    const task = state.tasks.find((item) => item.id === state.openTaskId && item.status !== "done");
    if (!task) {
      if (state.openTaskId) closeTaskCard();
      return;
    }
    taskCardSource.textContent = task.source === "telegram" ? "Telegram" : "Hub";
    taskCardTitle.textContent = task.title || task.text;
    const description = String(task.description ?? "").trim();
    taskCardDescription.textContent = description;
    taskCardDescription.hidden = !description;
    taskCardEmptyDescription.hidden = Boolean(description);
    const hasOriginal = Boolean(task.correctedText && task.correctedText.trim() !== task.rawText.trim());
    taskCardOriginal.hidden = !hasOriginal;
    taskCardOriginalText.textContent = hasOriginal ? task.rawText : "";
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
      type: "button", class: "board-task-quiet", text: "Готово",
      onclick: () => { closeTaskCard(); emit("complete", { id: task.id }); },
    }));
    actions.push(node("button", {
      type: "button", class: "board-task-remove", text: "Удалить",
      onclick: () => {
        if (!window.confirm("Удалить задачу без возможности восстановления?")) return;
        closeTaskCard();
        emit("remove", { id: task.id });
      },
    }));
    taskCardActions.replaceChildren(...actions);
  }

  function openTaskCard(task) {
    state.openTaskId = task.id;
    renderOpenTaskCard();
    taskCardModal.showModal?.();
    if (!taskCardModal.open) taskCardModal.setAttribute("open", "");
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
  document.querySelector("[data-task-card-close]")?.addEventListener("click", closeTaskCard);
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
  });
})();
