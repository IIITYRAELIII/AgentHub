(() => {
  "use strict";

  // Navigation is a projection of canonical Workspace/Stream selection. It owns
  // only the compact conversation/overlay route, never messages, drafts or unread state.
  function create({ root, state, currentTask, workspaceKey, workspaceStreams,
    representativeStreamTask, restoreSelection, selectTask, setView, setPane,
    openSettings, openWorkspaceCard, workspaceDialog, renameWorkspaceFolder,
    textDialog, cancelTextDialog,
    createStream, retryConnection, closeTransient, closeNative, transientLayers = [], isMobile }) {
    const doc = root.ownerDocument;
    const rail = doc.querySelector("[data-task-rail]");
    const railHome = rail.parentNode;
    const railNext = rail.nextSibling;
    const nav = doc.querySelector("[data-mobile-nav]");
    let workspaceId = "";
    let observedWorkspaceId = "";
    let workspaceInitialized = false;
    const workspaceStorageKey = "agentHub.mobileDialogsWorkspace";
    let active = false;
    let syncing = false;
    let historyInstalled = false;
    let historyClosing = false;
    let handlingPop = false;
    let historyClosePromise = Promise.resolve();
    let resolveHistoryClose = null;
    let lastModel = "";
    let loaded = false;
    let editOpener = null;
    let editIdentity = null;
    let editRowIndex = 0;
    let renameHome = null;
    const dialogStack = [];
    doc.addEventListener("beforetoggle", (event) => {
      if (event.target?.tagName !== "DIALOG") return;
      const index = dialogStack.indexOf(event.target);
      if (index >= 0) dialogStack.splice(index, 1);
      if (event.newState === "open") { dialogStack.push(event.target); if (active) installHistory(); }
    }, true);
    doc.addEventListener("close", () => queueMicrotask(settleHistory), true);
    const ownDialogs = [];
    const node = (tag, attrs = {}, children = []) => {
      const result = doc.createElement(tag);
      for (const [key, value] of Object.entries(attrs)) {
        if (key === "text") result.textContent = value;
        else if (key === "class") result.className = value;
        else result.setAttribute(key, value);
      }
      result.append(...children);
      return result;
    };
    const icon = (name) => {
      if (name === "x") return window.AgentHubModalOverlays.createPhosphorXIcon(doc);
      const source = doc.querySelector(`svg[data-phosphor-icon="${name}"]`);
      return source ? source.cloneNode(true)
        : window.AgentHubStreamTabs.createPhosphorIcon(doc, name);
    };
    const button = (label, glyph, run, attrs = {}) => {
      const result = node("button", { type: "button", class: "mobile-dialog-button",
        title: label, "aria-label": label, ...attrs }, [icon(glyph)]);
      result.addEventListener("click", run);
      return result;
    };
    const textButton = (label, glyph, run, attrs = {}) => {
      const result = button(label, glyph, run, attrs);
      result.append(node("span", { text: label }));
      return result;
    };
    const drawerButton = button("Выбрать Workspace", "list", () => open(drawer),
      { "data-mobile-workspaces-open": "", "aria-haspopup": "dialog", "aria-expanded": "false" });
    const workspaceName = node("strong", { "data-mobile-workspace-name": "" });
    const workspaceLabel = node("span", { class: "mobile-context-workspace", "data-mobile-workspace-label": "" }, [
      node("span", { text: "Workspace " }), workspaceName,
    ]);
    const chatHeader = doc.querySelector("[data-stream-chat-header]");
    const headerHome = chatHeader.parentNode;
    const headerNext = chatHeader.nextSibling;
    const chat = doc.querySelector("[data-chat]");
    const switchButton = button("Переключить поток", "caret-down", (event) => {
      filter.value = ""; renderSwitcher(); open(switcher);
      (event.detail === 0 ? filter : switchHeading).focus({ preventScroll: true });
    }, { class: "mobile-dialog-button mobile-conversation-switch", "data-mobile-stream-switch": "",
      "aria-haspopup": "dialog", "aria-expanded": "false" });
    const chatCreate = button("Новый поток", "plus", () => createStream(workspaceId),
      { class: "mobile-dialog-button mobile-conversation-create", "data-mobile-chat-stream-create": "" });
    const streamName = node("strong", { "data-mobile-stream-name": "" });
    const streamLine = node("span", { class: "mobile-context-stream" }, [streamName, switchButton.querySelector("svg")]);
    switchButton.append(streamLine);
    const headerActions = chatHeader.querySelector(".chat-overlay-actions");
    const primaryActions = node("div", { class: "mobile-conversation-actions" }, [chatCreate]);
    chatHeader.prepend(drawerButton, switchButton, primaryActions);
    const meta = chatHeader.querySelector(".stream-chat-meta");
    meta.prepend(workspaceLabel);
    // Move the existing controls, retaining their identities, listeners and form.
    // Restore their original parents when leaving the compact surface.
    const composerMain = doc.querySelector(".composer-main");
    const composerActions = node("div", { class: "composer-primary-actions" });
    const composerButtons = [...composerMain.querySelectorAll(".context-usage, .chat-stop-bottom, .composer-send")];
    const emptyText = node("h2", { tabindex: "-1" });
    const emptyHelper = node("p", { text: "Создайте поток, чтобы начать работу." });
    const emptyCreate = textButton("Новый поток", "plus", () => createStream(workspaceId),
      { "data-mobile-stream-create": "" });
    const empty = node("section", { class: "mobile-conversation-empty", "data-mobile-conversation-empty": "", hidden: "" },
      [emptyText, emptyHelper, emptyCreate]);
    chat.prepend(empty);
    const contextStatus = node("span", { class: "mobile-context-announcement", role: "status", "aria-atomic": "true" });
    chat.append(contextStatus);
    let lastContext = "";
    const currentStatus = node("span", { class: "mobile-current-status", "data-mobile-current-status": "" });
    const currentRuntime = node("span", { class: "mobile-current-runtime", "data-mobile-current-runtime": "" });
    meta.append(currentRuntime, currentStatus);
    const drawer = dialog("Workspace", "mobile-workspace-drawer", "data-mobile-workspace-drawer");
    const drawerBody = node("div", { class: "mobile-workspace-drawer-body" });
    drawer.append(drawerBody);
    const drawerFooter = node("div", { class: "mobile-workspace-footer" });
    for (const [label, glyph, action] of [
      ["Новый Workspace", "plus", "workspace-new"],
      ["Новая папка", "folder", "workspace-folder-new"],
      ["Архив Workspace", "archive-tray", "workspace-archive-open"],
    ]) drawerFooter.append(textButton(label, glyph, () => {
      close(drawer);
      rail.querySelector(`[data-action="${action}"]`)?.click();
    }, { "data-mobile-workspace-action": action }));
    drawerFooter.append(textButton("Настройки Workspace", "sliders-horizontal", () => {
      close(drawer); openWorkspaceCard(workspaceId);
    }));
    drawer.append(drawerFooter);
    const renameLayer = dialog("Новое название папки", "mobile-drawer-rename-layer", "data-mobile-drawer-rename", closeRename, resolveEditOpener);
    renameLayer.querySelector("header").hidden = true;
    renameLayer.addEventListener("keydown", (event) => {
      if (event.key !== "Tab" || event.ctrlKey || event.altKey || event.metaKey) return;
      const controls = [...renameLayer.querySelectorAll("button, input, textarea, select, [tabindex]")]
        .filter((item) => !item.disabled && item.tabIndex >= 0 && item.getClientRects().length && !item.closest("[hidden]"));
      if (!controls.length) return;
      event.preventDefault();
      const index = controls.indexOf(doc.activeElement);
      controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus({ preventScroll: true });
    });
    function restoreRenameForm() {
      if (renameHome) {
        if (!textDialog.hidden) cancelTextDialog();
        renameHome.parent.insertBefore(textDialog, renameHome.next);
        if (renameHome.role !== null) textDialog.setAttribute("role", renameHome.role);
        else textDialog.removeAttribute("role");
        if (renameHome.modal !== null) textDialog.setAttribute("aria-modal", renameHome.modal);
        renameHome = null;
      }
    }
    renameLayer.addEventListener("close", () => {
      if (renameLayer.open) return;
      restoreRenameForm(); restoreEditFocus();
    });
    workspaceDialog.addEventListener("close", () => {
      if (!workspaceDialog.open && editIdentity?.kind === "workspace") restoreEditFocus();
    });
    new MutationObserver(() => {
      if (!renameHome) return;
      if (textDialog.hidden) closeRename();
      else {
        renameLayer.setAttribute("aria-label", textDialog.querySelector("[data-text-dialog-title]").textContent);
        window.AgentHubModalOverlays.activateOverlay(renameLayer, editOpener);
      }
    }).observe(textDialog, { attributes: true, attributeFilter: ["hidden"] });
    const switcher = dialog("Выбрать поток", "mobile-stream-switcher", "data-mobile-stream-switcher");
    const switchHeading = switcher.querySelector("header strong");
    switchHeading.tabIndex = -1;
    const filter = node("input", { type: "search", placeholder: "Поиск по потокам",
      "aria-label": "Поиск по потокам", "data-mobile-stream-filter": "", autocomplete: "off" });
    const clearFilter = button("Очистить поиск по потокам", "x", () => {
      filter.value = ""; renderSwitcher(); filter.focus();
    }, { "data-mobile-stream-filter-clear": "", hidden: "" });
    const switchSearch = node("div", { class: "mobile-switcher-search" }, [filter, clearFilter]);
    const switchList = node("div", { class: "mobile-switcher-list", "data-mobile-stream-list": "" });
    const switchStatus = node("p", { class: "mobile-dialogs-status", role: "status" });
    const switchCreate = textButton("Новый поток", "plus", async () => {
      close(switcher); await settleHistory(); createStream(workspaceId);
    },
      { "data-mobile-switcher-create": "" });
    switcher.append(switchSearch, switchCreate, switchList, switchStatus);
    switcher.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !event.isComposing) { event.preventDefault(); event.stopPropagation(); close(switcher); }
    });
    const more = dialog("Ещё", "mobile-more-sheet", "data-mobile-more-sheet");
    for (const [label, glyph, view] of [
      ["Оформление", "image-square", "background"],
      ["Сервер", "hard-drives", "server"],
      ["Настройки AgentHub", "sliders-horizontal", "settings"],
    ]) more.append(textButton(label, glyph, () => {
      close(more);
      if (view === "settings") openSettings(); else setView(view);
      sync();
    }, { class: "mobile-more-entry" }));
    const mobileNav = node("div", { class: "mobile-dialogs-nav", "data-mobile-dialogs-nav": "" });
    for (const [label, glyph, view] of [
      ["Чат", "chats-circle", "chat"], ["Задачи", "squares-four", "dashboard"],
      ["Журнал", "notebook", "journal"], ["Статистика", "chart-line-up", "statistics"],
      ["Ещё", "dots-three", "more"],
    ]) mobileNav.append(textButton(label, glyph, () => {
      if (view === "more") open(more);
      else if (view === "chat") showConversation();
      else { installHistory(); setView(view); sync(); }
    }, { class: "mobile-tab", "data-mobile-dialogs-tab": view }));
    nav.append(mobileNav);
    filter.addEventListener("input", renderSwitcher);
    switchHeading.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); filter.focus(); }
    });
    filter.addEventListener("keydown", (event) => {
      if (["ArrowDown", "ArrowUp"].includes(event.key)) {
        event.preventDefault();
        const buttons = switchList.querySelectorAll("button");
        (event.key === "ArrowDown" ? buttons[0] : buttons[buttons.length - 1])?.focus();
      }
    });
    switchList.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const buttons = [...switchList.querySelectorAll("button")];
      const index = buttons.indexOf(event.target);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    });

    function dialog(label, className, attribute, onDismiss = null, returnFocus = null) {
      const result = node("dialog", { class: `mobile-navigation-dialog ${className}`,
        [attribute]: "", "aria-label": label });
      result.append(node("header", { class: "mobile-navigation-head" }, [
        node("strong", { text: label }),
        button("Закрыть", "x", () => onDismiss ? onDismiss() : close(result)),
      ]));
      doc.body.append(result);
      ownDialogs.push(result);
      window.AgentHubModalOverlays.installDismissibleOverlay({ dialog: result,
        close: () => onDismiss ? onDismiss() : close(result), returnFocus,
        fallbackFocus: returnFocus ? () => drawer.querySelector("button")
          : () => switchButton.getClientRects().length ? switchButton : drawerButton });
      result.addEventListener("close", () => {
        if (!ownDialogs.some((item) => item.open)) root.removeAttribute("data-mobile-layer");
      });
      return result;
    }
    function installHistory() {
      if (historyInstalled || historyClosing) return;
      historyInstalled = true;
      history.pushState({ ...history.state, mobileDialogs: true }, "");
    }
    function hasHistoryLayer() {
      return dialogStack.some((item) => item.open) || root.dataset.view !== "chat"
        || transientLayers.some((item) => item && !item.hidden && item.getClientRects().length);
    }
    function settleHistory() {
      if (!historyInstalled || handlingPop || hasHistoryLayer()) return historyClosePromise;
      historyInstalled = false;
      historyClosing = true;
      historyClosePromise = new Promise((resolve) => { resolveHistoryClose = resolve; });
      history.back();
      return historyClosePromise;
    }
    const transientObserver = new MutationObserver(() => {
      if (!active || handlingPop) return;
      if (hasHistoryLayer()) installHistory(); else settleHistory();
    });
    for (const layer of transientLayers.filter(Boolean)) transientObserver.observe(layer,
      { attributes: true, attributeFilter: ["hidden", "class"] });
    function open(target) {
      if (!active) return;
      if (!target.open) target.showModal();
      root.dataset.mobileLayer = "open";
      if (target === drawer) drawerButton.setAttribute("aria-expanded", "true");
      if (target === switcher) switchButton.setAttribute("aria-expanded", "true");
      installHistory();
    }
    drawer.addEventListener("close", () => drawerButton.setAttribute("aria-expanded", "false"));
    switcher.addEventListener("close", () => switchButton.setAttribute("aria-expanded", "false"));
    function close(target) { if (target.open) target.close(); }
    function closeRename() {
      restoreRenameForm();
      close(renameLayer);
      restoreEditFocus();
    }
    function resolveEditOpener() {
      if (editOpener?.isConnected && !editOpener.disabled && editOpener.getClientRects().length) return editOpener;
      const rows = [...rail.querySelectorAll(editIdentity?.kind === "folder"
        ? '[data-workspace-folder-kind="folder"]' : "[data-workspace-select]")].filter((row) => row.getClientRects().length);
      const exact = rows.find((row) => editIdentity?.kind === "folder"
        ? row.dataset.workspaceFolderName === editIdentity.id : row.dataset.workspaceSelect === editIdentity?.id);
      // Removed row: keep focus in this navigation owner at the nearest row,
      // or its close/heading control if there are no remaining candidates.
      const row = exact || rows[Math.min(editRowIndex, rows.length - 1)];
      return row?.querySelector(editIdentity?.kind === "folder" ? "[data-mobile-folder-rename]" : "[data-mobile-workspace-edit]") || drawer.querySelector("button");
    }
    function restoreEditFocus() {
      if (active && drawer.open && !doc.querySelector("dialog[open]:not([data-mobile-workspace-drawer])")) resolveEditOpener()?.focus({ preventScroll: true });
    }
    function openDirectEdit(event, identity, kind) {
      editOpener = event.currentTarget;
      editIdentity = { kind, id: identity };
      const rows = [...rail.querySelectorAll(kind === "folder" ? '[data-workspace-folder-kind="folder"]' : "[data-workspace-select]")];
      editRowIndex = Math.max(0, rows.findIndex((row) => kind === "folder" ? row.dataset.workspaceFolderName === identity : row.dataset.workspaceSelect === identity));
      editOpener.focus({ preventScroll: true });
      if (kind === "workspace") { openWorkspaceCard(identity); return; }
      renameHome = { parent: textDialog.parentNode, next: textDialog.nextSibling,
        role: textDialog.getAttribute("role"), modal: textDialog.getAttribute("aria-modal") };
      renameLayer.append(textDialog);
      textDialog.setAttribute("role", "presentation"); textDialog.removeAttribute("aria-modal");
      renameWorkspaceFolder(identity);
      open(renameLayer);
      window.AgentHubModalOverlays.activateOverlay(renameLayer, editOpener);
    }
    function selectedWorkspace() {
      const selected = currentTask();
      const selectedId = selected ? workspaceKey(selected) : "";
      if (!workspaceInitialized && (selected || state.connection === "online")) {
        workspaceInitialized = true;
        observedWorkspaceId = selectedId;
        let saved = "";
        try { saved = localStorage.getItem(workspaceStorageKey) || ""; } catch {}
        workspaceId = saved || selectedId;
      }
      if (selectedId && selectedId !== observedWorkspaceId) {
        workspaceId = selectedId;
        try { localStorage.setItem(workspaceStorageKey, workspaceId); } catch {}
      }
      observedWorkspaceId = selectedId;
      if (!workspaceId || !(state.workspaces ?? []).some((w) => w.id === workspaceId)
        && !state.tasks.some((t) => workspaceKey(t) === workspaceId)) {
        workspaceId = state.workspaces?.[0]?.id || (state.tasks[0] ? workspaceKey(state.tasks[0]) : "");
      }
      return workspaceId;
    }
    function streams() {
      return workspaceStreams(state.tasks.filter((task) => workspaceKey(task) === workspaceId));
    }
    async function openStream(task) {
      close(switcher); await settleHistory();
      if (!state.tasks.some((candidate) => candidate.id === task.id)) { sync(); return; }
      selectTask(task.id); showConversation(); switchButton.focus({ preventScroll: true });
    }
    function showConversation() {
      setView("chat"); setPane("chat"); sync();
      queueMicrotask(settleHistory);
    }
    function showSelected() {
      const selected = currentTask();
      if (selected) {
        workspaceId = workspaceKey(selected);
        try { localStorage.setItem(workspaceStorageKey, workspaceId); } catch {}
      }
      showConversation();
      if (active && !doc.querySelector("dialog[open]")) switchButton.focus({ preventScroll: true });
    }
    function streamRow(stream, count) {
      const task = representativeStreamTask(stream);
      const name = window.AgentHubStreamTabs.streamDisplayName(stream, count);
      const presentation = listPresentation(task);
      const row = node("button", { type: "button", class: "mobile-stream-row",
        "data-mobile-stream-id": stream.id, "data-state": window.AgentHubStreamTabs.streamStatusState(task),
        "aria-current": String(task?.id === currentTask()?.id),
        "aria-label": [name, presentation.status, task?.unread ? "Новое" : ""].filter(Boolean).join(". ") });
      row.append(node("strong", { text: name, title: name }),
        node("span", { class: "mobile-stream-tail" }, [
          ...(presentation.status ? [node("span", { class: "mobile-stream-running", text: presentation.status })] : []),
          ...(task?.unread ? [node("span", { class: "mobile-stream-new", text: "Новое" })] : []),
        ]));
      row.addEventListener("click", () => openStream(task));
      return row;
    }
    function listPresentation(task) {
      return window.AgentHubStreamTabs.dialogListPresentation(task, {
        messages: state.messages.get(task?.id),
        live: state.live.get(task?.id),
      });
    }
    function renderSwitcher() {
      const scrollTop = switchList.scrollTop;
      const focusedId = switchList.contains(doc.activeElement) ? doc.activeElement.dataset.mobileStreamId : null;
      const query = filter.value.trim().toLocaleLowerCase();
      const available = streams();
      const shown = available.filter((s) => `${window.AgentHubStreamTabs.streamDisplayName(s, available.length)} ${s.tasks.map((t) => t.streamDisplayName || t.title).join(" ")}`
        .toLocaleLowerCase().includes(query));
      switchList.replaceChildren();
      if (!loaded && !state.tasks.length) {
        switchList.setAttribute("aria-busy", String(state.connection !== "offline"));
        switchList.append(node("p", { class: "mobile-dialogs-empty", text: state.connection === "offline"
          ? "Не удалось загрузить потоки. Повторите подключение." : "Загрузка потоков…" }));
      } else {
        switchList.removeAttribute("aria-busy");
        switchList.append(...shown.map((stream) => streamRow(stream, available.length)));
        if (!shown.length) switchList.append(node("p", { class: "mobile-dialogs-empty",
          text: query ? "Потоки не найдены" : "В этом Workspace пока нет потоков." }));
      }
      switchList.scrollTop = scrollTop;
      if (focusedId && switcher.open) {
        ([...switchList.querySelectorAll("button")].find((item) => item.dataset.mobileStreamId === focusedId) || filter)
          .focus({ preventScroll: true });
      }
      const resultStatus = query && loaded ? `Найдено потоков: ${shown.length}` : "";
      if (switchStatus.textContent !== resultStatus) switchStatus.textContent = resultStatus;
      switchStatus.hidden = !switchStatus.textContent;
      clearFilter.hidden = !filter.value;
      switchCreate.disabled = !workspaceId;
    }
    function renderEmpty(selected) {
      const noSelection = !selected;
      root.toggleAttribute("data-mobile-empty", noSelection);
      empty.hidden = !noSelection;
      if (!noSelection) return;
      const connection = state.connection;
      empty.setAttribute("aria-busy", String(!loaded && connection !== "offline"));
      emptyText.textContent = !loaded ? connection === "offline"
        ? "Не удалось загрузить потоки. Повторите подключение." : "Загрузка потоков…"
        : workspaceId ? "В этом Workspace пока нет потоков" : "Выберите или создайте Workspace";
      emptyHelper.hidden = !loaded || !workspaceId;
      empty.querySelector("[data-mobile-retry]")?.remove();
      if (connection === "offline") empty.append(textButton("Повторить подключение", "arrow-clockwise", retryConnection,
        { "data-mobile-retry": "" }));
      emptyCreate.disabled = !workspaceId || !loaded;
    }
    function enhanceRail() {
      for (const item of rail.querySelectorAll("[data-workspace-select]")) {
        item.toggleAttribute("data-selected", item.dataset.workspaceSelect === workspaceId);
        let primary = item.querySelector("[data-mobile-workspace-select]");
        if (!primary) {
          primary = node("button", { type: "button", class: "mobile-workspace-select", "data-mobile-workspace-select": "" });
          primary.append(...item.childNodes); item.prepend(primary);
        }
        // Selection and direct edit are sibling controls, not nested buttons/roles.
        item.removeAttribute("role"); item.removeAttribute("tabindex"); item.removeAttribute("aria-pressed");
        primary.setAttribute("aria-pressed", String(item.dataset.workspaceSelect === workspaceId));
        if (item.querySelector("[data-mobile-workspace-edit]")) continue;
        const id = item.dataset.workspaceSelect;
        const name = state.workspaces?.find((workspace) => workspace.id === id)?.name || item.querySelector(".task-workspace-name")?.textContent || "";
        const edit = button(`Редактировать Workspace «${name}»`, "pencil-simple", (event) => {
          event.stopPropagation(); openDirectEdit(event, id, "workspace");
        }, { "data-mobile-workspace-edit": "", "aria-haspopup": "dialog" });
        edit.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) event.stopPropagation(); });
        item.append(edit);
      }
      for (const item of rail.querySelectorAll('[data-workspace-folder-kind="folder"]')) {
        const summary = item.querySelector("summary");
        if (!summary || summary.closest("[data-mobile-folder-row]")) continue;
        // Keep the pencil outside native summary/details, so it never toggles
        // disclosure and remains available even when the folder is collapsed.
        const row = node("div", { class: "mobile-folder-row", "data-mobile-folder-row": "" });
        const details = summary.parentElement;
        details.replaceWith(row); row.append(details);
        const edit = button(`Переименовать папку «${item.dataset.workspaceFolderName}»`, "pencil-simple", (event) => {
          event.stopPropagation(); openDirectEdit(event, item.dataset.workspaceFolderName, "folder");
        }, { "data-mobile-folder-rename": "", "aria-haspopup": "dialog" });
        edit.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) event.stopPropagation(); });
        row.append(edit);
      }
    }
    rail.addEventListener("click", async (event) => {
      if (!active || event.target.closest("[data-mobile-workspace-edit], [data-mobile-folder-rename]")) return;
      if (event.target.closest("[data-action]")) { close(drawer); return; }
      const item = event.target.closest("[data-workspace-select]");
      if (!item) return;
      event.preventDefault(); event.stopPropagation();
      const id = item.dataset.workspaceSelect;
      close(drawer); await settleHistory();
      workspaceId = id;
      observedWorkspaceId = currentTask() ? workspaceKey(currentTask()) : "";
      try { localStorage.setItem(workspaceStorageKey, workspaceId); } catch {}
      showConversation();
      (root.hasAttribute("data-mobile-empty") ? emptyText : switchButton).focus({ preventScroll: true });
    }, true);
    rail.addEventListener("keydown", (event) => {
      if (!active || !["Enter", " "].includes(event.key)
        || event.target.closest("[data-mobile-workspace-edit]")) return;
      const item = event.target.closest("[data-workspace-select]");
      if (!item) return;
      event.preventDefault(); event.stopPropagation();
      item.querySelector("[data-mobile-workspace-select]")?.click();
    }, true);
    function handleBack() {
      if (!active) return false;
      if (renameLayer.open) { closeRename(); return true; }
      if (closeTransient()) return true;
      const opened = dialogStack.filter((item) => item.open).at(-1);
      if (opened) {
        if (!closeNative(opened)) {
          const cancelled = new Event("cancel", { cancelable: true });
          opened.dispatchEvent(cancelled);
          if (!cancelled.defaultPrevented) opened.close();
        }
        return true;
      }
      if (root.dataset.view !== "chat") { showConversation(); return true; }
      return false;
    }
    window.addEventListener("popstate", () => {
      if (historyClosing) {
        historyClosing = false;
        if (active && hasHistoryLayer()) installHistory();
        resolveHistoryClose?.(); resolveHistoryClose = null;
        return;
      }
      if (!active) return;
      if (!historyInstalled) return;
      historyInstalled = false;
      handlingPop = true;
      try { handleBack(); } finally { handlingPop = false; }
      if (hasHistoryLayer()) installHistory();
    });
    const viewport = window.visualViewport;
    const syncViewport = () => {
      if (!active || !viewport) return;
      root.style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
      root.toggleAttribute("data-mobile-keyboard", window.innerHeight - viewport.height > 120);
    };
    viewport?.addEventListener("resize", syncViewport);
    function sync() {
      if (syncing) return;
      syncing = true;
      try {
        const enabled = isMobile();
        if (active !== enabled) {
          active = enabled;
          root.toggleAttribute("data-mobile-dialogs-enabled", enabled);
          if (enabled) {
            drawerBody.append(rail); chat.prepend(chatHeader);
            primaryActions.append(headerActions);
            composerActions.append(...composerButtons); composerMain.append(composerActions);
          }
          else {
            ownDialogs.forEach(close); railHome.insertBefore(rail, railNext);
            headerHome.insertBefore(chatHeader, headerNext);
            chatHeader.append(headerActions);
            composerMain.append(...composerButtons); composerActions.remove();
            for (const item of rail.querySelectorAll("[data-workspace-select]")) {
              const primary = item.querySelector("[data-mobile-workspace-select]");
              if (primary) { item.prepend(...primary.childNodes); primary.remove(); }
              item.setAttribute("role", "button"); item.setAttribute("tabindex", "0");
              item.setAttribute("aria-pressed", String(item.hasAttribute("data-selected")));
            }
            rail.querySelectorAll("[data-mobile-workspace-edit], [data-mobile-folder-rename]").forEach((item) => item.remove());
            rail.querySelectorAll("[data-mobile-folder-row]").forEach((row) => row.replaceWith(...row.childNodes));
            root.removeAttribute("data-mobile-conversation");
            root.removeAttribute("data-mobile-empty");
            empty.hidden = true;
          }
        }
        if (!active) return;
        if (state.connection === "online") loaded = true;
        selectedWorkspace();
        restoreSelection();
        let selected = currentTask();
        if (!selected || workspaceKey(selected) !== workspaceId) {
          const available = streams();
          const savedId = state.activeStreamByWorkspace.get(workspaceId);
          const target = representativeStreamTask(available.find((stream) => stream.id === savedId) || available[0]);
          if (target) selectTask(target.id);
          selected = target;
          // Auto-selection uses the canonical selection owner. Do not interpret a
          // previous Workspace's retained command/draft as this empty scope.
          observedWorkspaceId = currentTask() ? workspaceKey(currentTask()) : "";
        }
        const view = root.dataset.view;
        root.toggleAttribute("data-mobile-conversation", view === "chat");
        if (view === "chat" && root.dataset.pane !== "chat") setPane("chat");
        workspaceName.textContent = state.workspaces?.find((w) => w.id === workspaceId)?.name
          || selected?.workspaceName || "Выбрать Workspace";
        workspaceLabel.title = `Workspace ${workspaceName.textContent}`;
        streamName.textContent = selected ? window.AgentHubStreamTabs.streamDisplayName({
          name: selected?.streamName || selected?.streamDisplayName, ordinal: selected?.streamOrdinal,
        }, streams().length) : "Нет потоков";
        streamName.title = streamName.textContent;
        const switchLabel = `Переключить поток: ${streamName.textContent}`;
        switchButton.title = switchLabel;
        const contextLabel = `Workspace ${workspaceName.textContent} / ${streamName.textContent}`;
        switchButton.setAttribute("aria-label", `${switchLabel}. Workspace ${workspaceName.textContent}`);
        if (contextLabel !== lastContext) { contextStatus.textContent = contextLabel; lastContext = contextLabel; }
        currentRuntime.textContent = selected?.runtimeLabel || "";
        currentRuntime.title = selected?.runtimeTitle || currentRuntime.textContent;
        currentRuntime.hidden = !currentRuntime.textContent;
        currentStatus.textContent = state.connection === "offline" ? "Нет связи" : state.connection !== "online"
          ? "Подключение…" : listPresentation(selected).status;
        currentStatus.title = currentStatus.textContent;
        currentStatus.hidden = !currentStatus.textContent;
        chatCreate.disabled = !workspaceId;
        renderEmpty(selected);
        for (const item of mobileNav.children) item.setAttribute("aria-pressed", String(
          item.dataset.mobileDialogsTab === (view === "chat" ? "chat" : ["dashboard", "journal", "statistics"].includes(view) ? view : "more")));
        const model = JSON.stringify([workspaceId, state.tasks.map((task) => [
          task.id, task.streamId, task.streamName, task.streamDisplayName, task.workspaceId,
          task.running, task.unread, task.lastActivity, task.lastAnswer, task.agentLabel, task.modelLabel, listPresentation(task),
        ]), streams().map((stream) => stream.id), state.connection]);
        if (model !== lastModel) { lastModel = model; renderSwitcher(); }
        enhanceRail(); syncViewport();
        const archiveCount = rail.querySelector("[data-workspace-archive-count]")?.textContent?.trim();
        const archiveButton = drawerFooter.querySelector('[data-mobile-workspace-action="workspace-archive-open"]');
        archiveButton.querySelector("span").textContent = `Архив Workspace${archiveCount ? ` (${archiveCount})` : ""}`;
      } finally { syncing = false; }
    }
    return { sync, showSelected, openStream, handleBack };
  }
  window.AgentHubMobileDialogs = Object.freeze({ create });
})();
