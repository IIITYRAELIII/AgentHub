(() => {
  "use strict";

  // Navigation is a projection of canonical Workspace/Stream selection. It owns
  // only the mobile list/overlay route, never messages, drafts or unread state.
  function create({ root, state, currentTask, workspaceKey, workspaceStreams,
    representativeStreamTask, selectTask, setView, setPane, openSearch,
    openSettings, openWorkspaceCard, workspaceMenu, folderMenu,
    createStream, retryConnection, closeTransient, closeNative, isMobile, formatTime, shortModel }) {
    const doc = root.ownerDocument;
    const rail = doc.querySelector("[data-task-rail]");
    const railHome = rail.parentNode;
    const railNext = rail.nextSibling;
    const nav = doc.querySelector("[data-mobile-nav]");
    let workspaceId = "";
    let observedWorkspaceId = "";
    let workspaceInitialized = false;
    const workspaceStorageKey = "agentHub.mobileDialogsWorkspace";
    let conversation = false;
    let active = false;
    let historyInstalled = false;
    let lastModel = "";
    let loaded = false;
    let menuReturn = null;
    const dialogStack = [];
    const closingDialogs = new Set();
    doc.addEventListener("beforetoggle", (event) => {
      if (event.target?.tagName !== "DIALOG") return;
      const index = dialogStack.indexOf(event.target);
      if (index >= 0) dialogStack.splice(index, 1);
      if (event.newState === "open") dialogStack.push(event.target);
      else if (event.newState === "closed") closingDialogs.add(event.target);
    }, true);
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
    const host = node("section", { class: "mobile-dialogs", "data-mobile-dialogs": "",
      "aria-label": "Диалоги выбранного Workspace", hidden: "" });
    const drawerButton = button("Выбрать Workspace", "list", () => open(drawer),
      { "data-mobile-workspaces-open": "", "aria-haspopup": "dialog" });
    const top = node("header", { class: "mobile-dialogs-top" }, [drawerButton,
      node("strong", { text: "AgentHub" }),
      button("Поиск по сообщениям Workspace", "magnifying-glass", search),
      button("Настройки AgentHub", "sliders-horizontal", openSettings)]);
    const heading = node("h1", { text: "Диалоги" });
    const workspaceLabel = node("button", { type: "button", class: "mobile-dialogs-workspace",
      "data-mobile-workspace-label": "", "aria-label": "Выбрать Workspace" });
    workspaceLabel.addEventListener("click", () => open(drawer));
    const filter = node("input", { type: "search", placeholder: "Найти Stream",
      "aria-label": "Найти Stream в Workspace", "data-mobile-stream-filter": "" });
    const status = node("p", { class: "mobile-dialogs-status", role: "status" });
    const list = node("div", { class: "mobile-dialogs-list", "data-mobile-stream-list": "" });
    const fab = textButton("Новый Stream", "plus", () => createStream(workspaceId),
      { class: "mobile-dialogs-fab", "data-mobile-stream-create": "" });
    host.append(top, heading, workspaceLabel, filter, status, list, fab);
    railHome.prepend(host);
    const chatHeader = doc.querySelector("[data-stream-chat-header]");
    const back = button("К Диалогам Workspace", "caret-left", showList,
      { class: "mobile-dialog-button mobile-conversation-back", "data-mobile-conversation-back": "" });
    const switchButton = textButton("Переключить Stream", "caret-down", () => {
      renderSwitcher(); open(switcher);
    }, { class: "mobile-dialog-button mobile-conversation-switch", "data-mobile-stream-switch": "",
      "aria-haspopup": "dialog" });
    chatHeader.prepend(back, switchButton);
    switchButton.append(switchButton.querySelector("svg"));
    const currentStatus = node("span", { class: "mobile-current-status", "data-mobile-current-status": "" });
    const currentRuntime = node("span", { class: "mobile-current-runtime", "data-mobile-current-runtime": "" });
    chatHeader.querySelector(".stream-chat-meta").append(currentRuntime, currentStatus);
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
    const switcher = dialog("Потоки Workspace", "mobile-stream-switcher", "data-mobile-stream-switcher");
    const switchList = node("div", { class: "mobile-switcher-list" });
    switcher.append(switchList);
    const more = dialog("Ещё", "mobile-more-sheet", "data-mobile-more-sheet");
    for (const [label, glyph, view] of [
      ["Статистика", "chart-line-up", "statistics"],
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
      ["Диалоги", "chats-circle", "chat"], ["Задачи", "squares-four", "dashboard"],
      ["Журнал", "notebook", "journal"], ["Ещё", "dots-three", "more"],
    ]) mobileNav.append(textButton(label, glyph, () => {
      if (view === "more") open(more);
      else if (view === "chat") showList();
      else { setView(view); sync(); }
    }, { class: "mobile-tab", "data-mobile-dialogs-tab": view }));
    nav.append(mobileNav);
    filter.addEventListener("input", renderList);

    function dialog(label, className, attribute) {
      const result = node("dialog", { class: `mobile-navigation-dialog ${className}`,
        [attribute]: "", "aria-label": label });
      result.append(node("header", { class: "mobile-navigation-head" }, [
        node("strong", { text: label }),
        button("Закрыть", "x", () => close(result)),
      ]));
      doc.body.append(result);
      ownDialogs.push(result);
      window.AgentHubModalOverlays.installDismissibleOverlay({ dialog: result,
        close: () => close(result), fallbackFocus: drawerButton });
      result.addEventListener("close", () => {
        if (!ownDialogs.some((item) => item.open)) root.removeAttribute("data-mobile-layer");
      });
      return result;
    }
    function installHistory() {
      if (historyInstalled) return;
      historyInstalled = true;
      history.replaceState({ ...history.state, mobileDialogs: true }, "");
      history.pushState({ ...history.state, mobileDialogs: true }, "");
    }
    function open(target) {
      if (!active) return;
      if (!target.open) target.showModal();
      root.dataset.mobileLayer = "open";
      installHistory();
    }
    function close(target) { if (target.open) target.close(); }
    function search() {
      // Existing Workspace search is inside the chat shell. Keep that owner,
      // expose its current Stream and let search-result navigation select it.
      conversation = true; setView("chat"); setPane("chat"); sync(); openSearch(workspaceId);
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
    function openStream(task) {
      close(switcher); conversation = true; selectTask(task.id); setView("chat"); setPane("chat"); sync();
    }
    function showList() {
      conversation = false; setView("chat"); setPane("tasks"); sync();
    }
    function showSelected() {
      const selected = currentTask();
      if (selected) {
        workspaceId = workspaceKey(selected);
        try { localStorage.setItem(workspaceStorageKey, workspaceId); } catch {}
      }
      conversation = true; sync();
    }
    function streamRow(stream, count) {
      const task = representativeStreamTask(stream);
      const name = window.AgentHubStreamTabs.streamDisplayName(stream, count);
      const row = node("button", { type: "button", class: "mobile-stream-row",
        "data-mobile-stream-id": stream.id, "data-state": window.AgentHubStreamTabs.streamStatusState(task),
        "aria-label": `${name}${task?.unread ? ", Новое" : ""}` });
      row.append(node("span", { class: "provider-dot", "data-state": row.dataset.state,
        "data-provider": task?.provider || "", "aria-hidden": "true" }),
        node("span", { class: "mobile-stream-body" }, [
          node("span", { class: "mobile-stream-line" }, [node("strong", { text: name }),
            node("span", { text: `${task?.agentLabel || task?.provider || ""} · ${shortModel(task?.modelLabel)}` })]),
          node("span", { class: "mobile-stream-preview", text: String(task?.lastAnswer?.text ?? task?.lastAnswer ?? "")
            .replace(/\s+/gu, " ").trim() || "Пока нет ответа" }),
        ]), node("span", { class: "mobile-stream-tail" }, [
          node("time", { text: formatTime(task?.lastActivity) }),
          ...(task?.running ? [node("span", { class: "mobile-stream-running", text: "Ход выполняется" })]
            : task?.unread ? [node("span", { class: "mobile-stream-new", text: "Новое" })] : []),
        ]));
      row.addEventListener("click", () => openStream(task));
      return row;
    }
    function renderList() {
      const attentionOpen = list.querySelector(".mobile-attention")?.open ?? true;
      const scrollTop = list.scrollTop;
      const query = filter.value.trim().toLocaleLowerCase();
      const available = streams();
      const shown = available.filter((s) => `${s.name} ${s.tasks.map((t) => t.streamDisplayName || t.title).join(" ")}`
        .toLocaleLowerCase().includes(query));
      list.replaceChildren();
      if (!loaded && !state.tasks.length) {
        list.setAttribute("aria-busy", String(state.connection !== "offline"));
        list.append(node("p", { class: "mobile-dialogs-empty", text: state.connection === "offline"
          ? "Не удалось загрузить Диалоги. Повторите подключение." : "Загрузка Диалогов…" }));
      } else {
        list.removeAttribute("aria-busy");
      const attention = shown.filter((s) => s.tasks.some((t) => t.running || t.unread));
      if (attention.length) {
        const section = node("details", { class: "mobile-attention" }, [
          node("summary", { text: "Требуют внимания" }), ...attention.map((stream) => streamRow(stream, available.length)),
        ]);
        section.open = attentionOpen;
        list.append(section);
      }
      list.append(node("h2", { text: "Все потоки" }), ...shown.map((stream) => streamRow(stream, available.length)));
      if (!shown.length) list.append(node("p", { class: "mobile-dialogs-empty",
        text: query ? "Ничего не найдено" : "В этом Workspace пока нет Stream." }));
      }
      list.scrollTop = scrollTop;
      fab.disabled = !workspaceId;
      const connection = state.connection;
      status.textContent = connection === "online" ? "" : connection === "offline"
        ? "Нет связи с Agent Hub" : "Подключение к Agent Hub…";
      status.hidden = !status.textContent;
      if (connection === "offline") status.append(textButton("Повторить подключение", "arrow-clockwise", retryConnection));
    }
    function renderSwitcher() {
      const available = streams();
      switchList.replaceChildren(...available.map((stream) => streamRow(stream, available.length)));
    }
    function enhanceRail() {
      for (const item of rail.querySelectorAll("[data-workspace-select]")) {
        item.toggleAttribute("data-selected", item.dataset.workspaceSelect === workspaceId);
        item.setAttribute("aria-pressed", String(item.dataset.workspaceSelect === workspaceId));
        if (item.querySelector("[data-mobile-workspace-menu]")) continue;
        const id = item.dataset.workspaceSelect;
        const menu = button("Действия Workspace", "dots-three", (event) => {
          menuReturn = { workspaceId: id };
          event.stopPropagation(); close(drawer); workspaceMenu(event, id);
        }, { "data-mobile-workspace-menu": "" });
        item.append(menu);
      }
      for (const item of rail.querySelectorAll('[data-workspace-folder-kind="folder"]')) {
        const summary = item.querySelector("summary");
        if (!summary || summary.querySelector("[data-mobile-folder-menu]")) continue;
        summary.append(button("Действия папки", "dots-three", (event) => {
          menuReturn = { folderName: item.dataset.workspaceFolderName };
          event.preventDefault(); event.stopPropagation(); close(drawer); folderMenu(event, item.dataset.workspaceFolderName);
        }, { "data-mobile-folder-menu": "" }));
      }
    }
    // Existing menus and their dialogs retain their owners outside the modal
    // rail. Once their exact interaction ends, restore its spatial context.
    function restoreMenuContext() {
      if (!active || !menuReturn || closingDialogs.size || doc.querySelector('dialog[open], .workspace-context-menu:not([hidden]), [data-text-dialog]:not([hidden])')) return;
      const target = menuReturn;
      menuReturn = null;
      open(drawer);
      const candidates = target.workspaceId
        ? [...rail.querySelectorAll("[data-workspace-select]")]
        : [...rail.querySelectorAll('[data-workspace-folder-kind="folder"]')];
      const row = candidates.find((item) => target.workspaceId
        ? item.dataset.workspaceSelect === target.workspaceId : item.dataset.workspaceFolderName === target.folderName);
      (row?.querySelector("[data-mobile-workspace-menu], [data-mobile-folder-menu]") || drawer.querySelector("button")).focus({ preventScroll: true });
    }
    new MutationObserver(restoreMenuContext).observe(doc.body,
      { subtree: true, attributes: true, attributeFilter: ["hidden", "open"] });
    doc.addEventListener("close", (event) => {
      closingDialogs.delete(event.target);
      queueMicrotask(restoreMenuContext);
    }, true);
    rail.addEventListener("click", (event) => {
      if (!active || event.target.closest("[data-mobile-workspace-menu], [data-mobile-folder-menu]")) return;
      if (event.target.closest("[data-action]")) { close(drawer); return; }
      const item = event.target.closest("[data-workspace-select]");
      if (!item) return;
      workspaceId = item.dataset.workspaceSelect;
      try { localStorage.setItem(workspaceStorageKey, workspaceId); } catch {}
      close(drawer); showList();
    });
    rail.addEventListener("keydown", (event) => {
      if (!active || !["Enter", " "].includes(event.key)
        || event.target.closest("[data-mobile-workspace-menu]")) return;
      const item = event.target.closest("[data-workspace-select]");
      if (!item) return;
      workspaceId = item.dataset.workspaceSelect;
      try { localStorage.setItem(workspaceStorageKey, workspaceId); } catch {}
      close(drawer); showList();
    });
    function handleBack() {
      if (!active) return false;
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
      if (conversation || root.dataset.view !== "chat") { showList(); return true; }
      return false;
    }
    window.addEventListener("popstate", () => {
      if (!active || !historyInstalled) return;
      if (handleBack()) { history.pushState({ ...history.state, mobileDialogs: true }, ""); return; }
      historyInstalled = false;
    });
    const viewport = window.visualViewport;
    const syncViewport = () => {
      if (!active || !viewport) return;
      root.style.setProperty("--mobile-viewport-height", `${viewport.height}px`);
      root.toggleAttribute("data-mobile-keyboard", window.innerHeight - viewport.height > 120);
    };
    viewport?.addEventListener("resize", syncViewport);
    function sync() {
      const enabled = isMobile();
      if (active !== enabled) {
        active = enabled;
        root.toggleAttribute("data-mobile-dialogs-enabled", enabled);
        if (enabled) { drawerBody.append(rail); installHistory(); }
        else {
          ownDialogs.forEach(close); railHome.insertBefore(rail, railNext);
          root.removeAttribute("data-mobile-conversation");
        }
      }
      if (!active) return;
      if (state.connection === "online") loaded = true;
      selectedWorkspace();
      const selected = currentTask();
      const view = root.dataset.view;
      root.toggleAttribute("data-mobile-conversation", conversation && view === "chat");
      host.hidden = view !== "chat" || conversation;
      workspaceLabel.textContent = state.workspaces?.find((w) => w.id === workspaceId)?.name
        || selected?.workspaceName || "Выбрать Workspace";
      switchButton.querySelector("span").textContent = selected?.streamName || selected?.streamDisplayName || "Stream";
      currentRuntime.textContent = selected?.runtimeLabel || "";
      currentRuntime.title = selected?.runtimeTitle || "";
      currentRuntime.hidden = !currentRuntime.textContent;
      currentStatus.textContent = state.connection === "offline" ? "Нет связи" : state.connection !== "online"
        ? "Подключение…" : selected?.running ? "Ход выполняется" : "";
      currentStatus.hidden = !currentStatus.textContent;
      back.hidden = switchButton.hidden = !conversation;
      for (const item of mobileNav.children) item.setAttribute("aria-pressed", String(
        item.dataset.mobileDialogsTab === (view === "chat" ? "chat" : ["dashboard", "journal"].includes(view) ? view : "more")));
      const model = JSON.stringify([workspaceId, state.tasks.map((task) => [
        task.id, task.streamId, task.streamName, task.streamDisplayName, task.workspaceId,
        task.running, task.unread, task.lastActivity, task.lastAnswer, task.agentLabel, task.modelLabel,
      ]), streams().map((stream) => stream.id), state.connection]);
      if (model !== lastModel) { lastModel = model; renderList(); }
      enhanceRail(); syncViewport();
      const archiveCount = rail.querySelector("[data-workspace-archive-count]")?.textContent?.trim();
      const archiveButton = drawerFooter.querySelector('[data-mobile-workspace-action="workspace-archive-open"]');
      archiveButton.querySelector("span").textContent = `Архив Workspace${archiveCount ? ` (${archiveCount})` : ""}`;
    }
    return { sync, showList, showSelected, openStream, handleBack };
  }
  window.AgentHubMobileDialogs = Object.freeze({ create });
})();
