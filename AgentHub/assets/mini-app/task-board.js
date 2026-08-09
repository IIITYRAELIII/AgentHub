"use strict";

(() => {
  const board = document.querySelector("[data-task-board]");
  const columns = document.querySelector("[data-task-board-columns]");
  const createForm = document.querySelector("[data-task-board-create]");
  const createInput = document.querySelector("[data-task-board-input]");
  const workspacePanel = document.querySelector("[data-workspace-task-panel]");
  const workspacePanelList = document.querySelector("[data-workspace-task-list]");
  const workspacePanelTitle = document.querySelector("[data-workspace-task-title]");
  const startModal = document.querySelector("[data-task-start-modal]");
  const startTitle = document.querySelector("[data-task-start-title]");
  const startOptions = document.querySelector("[data-task-start-options]");
  const startNewForm = document.querySelector("[data-task-start-new]");
  const startNewName = document.querySelector("[data-task-start-new-name]");
  const startProvider = document.querySelector("[data-task-start-provider]");
  if (!board || !columns) return;

  const state = {
    tasks: [],
    workspaces: [],
    selectedWorkspaceId: null,
    provider: "codex",
    startingTaskId: null,
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

  function moveTask(task, destination) {
    if (destination === "backlog" || destination === "notes") {
      emit("move", { id: task.id, bucket: destination });
      return;
    }
    if (destination.startsWith("workspace:")) {
      emit("move", { id: task.id, bucket: "workspace", workspaceId: destination.slice(10) });
    }
  }

  function destinationSelect(task) {
    const select = node("select", {
      class: "board-task-destination",
      "aria-label": "Колонка Task",
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

  function triageBadge(task) {
    const status = task.triageStatus;
    if (status === "running" || status === "pending") {
      return node("span", { class: "board-task-ai is-pending", text: "Spark разбирает…" });
    }
    if (status === "failed") {
      return node("button", {
        type: "button",
        class: "board-task-ai is-failed",
        text: "Spark: повторить",
        onclick: () => emit("retry-triage", { id: task.id }),
      });
    }
    if (status === "completed") {
      const confidence = Math.round((Number(task.triageConfidence) || 0) * 100);
      return node("span", {
        class: "board-task-ai",
        text: `${task.category === "note" ? "Заметка" : "Task"} · ${confidence}%`,
        title: task.triageReason || "Разобрано Codex Spark",
      });
    }
    return null;
  }

  function openStart(task) {
    const workspace = workspaceById(task.workspaceId);
    if (!workspace) return;
    state.startingTaskId = task.id;
    startTitle.textContent = task.text;
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
    startNewName.value = task.text.split("\n")[0].slice(0, 80);
    startProvider.value = state.provider;
    startModal.showModal?.();
    if (!startModal.open) startModal.setAttribute("open", "");
  }

  function closeStart() {
    state.startingTaskId = null;
    startModal.close?.();
    startModal.removeAttribute("open");
  }

  function taskCard(task, { compact = false } = {}) {
    const card = node("article", {
      class: `board-task-card${task.status === "started" ? " is-started" : ""}${compact ? " is-compact" : ""}`,
      draggable: compact ? null : "true",
      "data-board-task-id": task.id,
      ondragstart: (event) => {
        event.dataTransfer.setData("text/plain", task.id);
        event.dataTransfer.effectAllowed = "move";
      },
    });
    const badge = triageBadge(task);
    const heading = node("div", { class: "board-task-card-head" }, [
      node("span", { class: "board-task-source", text: task.source === "telegram" ? "Telegram" : "Hub" }),
      ...(badge ? [badge] : []),
    ]);
    const text = node("p", { class: "board-task-text", text: task.text });
    const actions = node("div", { class: "board-task-actions" });
    if (task.bucket === "workspace") {
      actions.append(node("button", {
        type: "button", class: "board-task-primary", text: task.status === "started" ? "Продолжить" : "Начать работу",
        onclick: () => openStart(task),
      }));
    }
    if (!compact) {
      actions.append(destinationSelect(task));
      actions.append(node("button", {
        type: "button", class: "board-task-quiet", text: "Готово",
        onclick: () => emit("complete", { id: task.id }),
      }));
      actions.append(node("button", {
        type: "button", class: "board-task-remove", text: "Удалить",
        onclick: () => {
          if (window.confirm("Удалить Task без возможности восстановления?")) emit("remove", { id: task.id });
        },
      }));
    }
    card.append(heading, text);
    if (task.correctedText && task.correctedText.trim() !== task.rawText.trim() && !compact) {
      card.append(node("details", { class: "board-task-original" }, [
        node("summary", { text: "Исходный текст" }),
        node("p", { text: task.rawText }),
      ]));
    }
    card.append(actions);
    return card;
  }

  function renderColumn({ id, title, subtitle, tasks, accent = "" }) {
    const column = node("section", {
      class: `task-board-column ${accent}`,
      "data-board-destination": id,
    });
    column.addEventListener("dragover", (event) => {
      event.preventDefault();
      column.classList.add("is-dragover");
    });
    column.addEventListener("dragleave", () => column.classList.remove("is-dragover"));
    column.addEventListener("drop", (event) => {
      event.preventDefault();
      column.classList.remove("is-dragover");
      const task = state.tasks.find((item) => item.id === event.dataTransfer.getData("text/plain"));
      if (task) moveTask(task, id);
    });
    column.append(node("header", { class: "task-board-column-head" }, [
      node("div", {}, [node("h2", { text: title }), node("p", { text: subtitle })]),
      node("span", { class: "task-board-count", text: String(tasks.length) }),
    ]));
    const list = node("div", { class: "task-board-column-list" });
    if (!tasks.length) list.append(node("p", { class: "task-board-empty", text: "Перетащите Task сюда" }));
    else for (const task of tasks) list.append(taskCard(task));
    column.append(list);
    return column;
  }

  function renderBoard() {
    const openTasks = state.tasks.filter((task) => task.status !== "done");
    columns.replaceChildren(renderColumn({
      id: "backlog", title: "Бэклог", subtitle: "Неразобранные входящие",
      tasks: openTasks.filter((task) => task.bucket === "backlog"), accent: "is-backlog",
    }));
    for (const workspace of state.workspaces) {
      columns.append(renderColumn({
        id: `workspace:${workspace.id}`,
        title: workspace.name,
        subtitle: `${(workspace.streams ?? []).length} Streams`,
        tasks: openTasks.filter((task) => task.bucket === "workspace" && task.workspaceId === workspace.id),
      }));
    }
    columns.append(renderColumn({
      id: "notes", title: "Заметки", subtitle: "Игры, фильмы, сериалы и идеи",
      tasks: openTasks.filter((task) => task.bucket === "notes"), accent: "is-notes",
    }));
  }

  function renderWorkspacePanel() {
    const workspace = workspaceById(state.selectedWorkspaceId);
    const tasks = workspace
      ? state.tasks.filter((task) => task.status !== "done" && task.bucket === "workspace" && task.workspaceId === workspace.id)
      : [];
    workspacePanel.hidden = !workspace;
    if (!workspace) return;
    workspacePanelTitle.textContent = `Task · ${workspace.name}`;
    workspacePanelList.replaceChildren();
    if (!tasks.length) {
      workspacePanelList.append(node("p", { class: "workspace-task-empty", text: "Нет назначенных Task" }));
      return;
    }
    for (const task of tasks.slice(0, 6)) workspacePanelList.append(taskCard(task, { compact: true }));
  }

  createForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = createInput.value.trim();
    if (!text) return;
    emit("create", { text });
    createInput.value = "";
  });
  document.querySelector("[data-task-start-close]")?.addEventListener("click", closeStart);
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
    setSnapshot(payload = {}) {
      state.tasks = Array.isArray(payload.tasks) ? payload.tasks.slice() : [];
      state.workspaces = Array.isArray(payload.workspaces) ? payload.workspaces.slice() : [];
      state.selectedWorkspaceId = payload.selectedWorkspaceId ?? null;
      state.provider = payload.provider === "claude" ? "claude" : "codex";
      renderBoard();
      renderWorkspacePanel();
    },
  });
})();
