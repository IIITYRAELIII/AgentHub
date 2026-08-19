(() => {
  "use strict";

  const STORAGE_KEY = "agent-hub:side-panel-widths:v1";
  const CENTER_MINIMUM_WIDTH = 420;
  const PANEL_CONFIG = Object.freeze({
    task: Object.freeze({ minimumWidth: 180, property: "--task-rail-width", selector: "[data-task-rail]", title: "Изменить ширину левой панели. Двойной клик — сбросить." }),
    activity: Object.freeze({ minimumWidth: 220, property: "--activity-rail-width", selector: "[data-activity-rail]", title: "Изменить ширину правой панели. Двойной клик — сбросить." }),
  });

  function normalizedWidth(value) {
    const width = Number(value);
    return Number.isFinite(width) && width > 0 ? Math.round(width) : null;
  }

  function storedWidths(storage) {
    try {
      const parsed = JSON.parse(storage?.getItem(STORAGE_KEY) || "{}");
      if (!parsed || typeof parsed !== "object") return {};
      return Object.fromEntries(Object.keys(PANEL_CONFIG).flatMap((side) => {
        const width = normalizedWidth(parsed[side]);
        return width === null ? [] : [[side, width]];
      }));
    } catch {
      return {};
    }
  }

  function persistWidth(storage, side, width) {
    if (!PANEL_CONFIG[side]) return storedWidths(storage);
    const selectedWidth = normalizedWidth(width);
    if (selectedWidth === null) return storedWidths(storage);
    const widths = { ...storedWidths(storage), [side]: selectedWidth };
    try {
      storage?.setItem(STORAGE_KEY, JSON.stringify(widths));
    } catch {}
    return widths;
  }

  function forgetWidth(storage, side) {
    const widths = storedWidths(storage);
    delete widths[side];
    try {
      if (Object.keys(widths).length > 0) storage?.setItem(STORAGE_KEY, JSON.stringify(widths));
      else storage?.removeItem(STORAGE_KEY);
    } catch {}
    return widths;
  }

  function clampWidth(width, minimumWidth, maximumWidth) {
    return Math.min(Math.max(minimumWidth, maximumWidth), Math.max(minimumWidth, width));
  }

  function widthFromPointer({ side, startWidth, startX, pointerX, maximumWidth }) {
    const delta = side === "activity" ? startX - pointerX : pointerX - startX;
    return Math.round(clampWidth(startWidth + delta, PANEL_CONFIG[side]?.minimumWidth || 0, maximumWidth));
  }

  function fitPanelWidths({ taskWidth, activityWidth, availableWidth, customTask, customActivity }) {
    const taskMinimum = PANEL_CONFIG.task.minimumWidth;
    const activityMinimum = PANEL_CONFIG.activity.minimumWidth;
    const available = Math.max(taskMinimum + activityMinimum, availableWidth);
    let task = clampWidth(taskWidth, taskMinimum, available - activityMinimum);
    let activity = clampWidth(activityWidth, activityMinimum, available - taskMinimum);
    const excess = task + activity - available;
    if (excess <= 0) return { task, activity };
    if (customTask && !customActivity) return { task: Math.max(taskMinimum, task - excess), activity };
    if (!customTask && customActivity) return { task, activity: Math.max(activityMinimum, activity - excess) };
    const taskExtra = task - taskMinimum;
    const activityExtra = activity - activityMinimum;
    const extraTotal = taskExtra + activityExtra;
    if (extraTotal <= 0) return { task: taskMinimum, activity: activityMinimum };
    const allowedExtra = available - taskMinimum - activityMinimum;
    task = taskMinimum + (taskExtra * allowedExtra / extraTotal);
    activity = activityMinimum + (activityExtra * allowedExtra / extraTotal);
    return { task: Math.round(task), activity: Math.round(activity) };
  }

  function applyWidth(workspace, side, width) {
    const config = PANEL_CONFIG[side];
    const selectedWidth = normalizedWidth(width);
    if (!workspace?.style || !config || selectedWidth === null) return null;
    workspace.style.setProperty(config.property, `${selectedWidth}px`);
    return selectedWidth;
  }

  function clearWidth(workspace, side) {
    const config = PANEL_CONFIG[side];
    if (workspace?.style && config) workspace.style.removeProperty(config.property);
  }

  function createController({ document: currentDocument, window: currentWindow, storage }) {
    const root = currentDocument.documentElement;
    const workspace = currentDocument.querySelector("body > .workspace");
    if (!root || !workspace) return null;
    const rails = Object.fromEntries(Object.entries(PANEL_CONFIG).map(([side, config]) => [side, workspace.querySelector(config.selector)]));
    const chat = workspace.querySelector("[data-chat]");
    if (!rails.task || !rails.activity || !chat) return null;
    let activeDrag = null;
    let positionFrame = 0;

    function layout() {
      return {
        workspace: workspace.getBoundingClientRect(),
        task: rails.task.getBoundingClientRect(),
        chat: chat.getBoundingClientRect(),
        activity: rails.activity.getBoundingClientRect(),
      };
    }

    function desktopChatVisible() {
      return root.dataset.view === "chat"
        && root.dataset.surface !== "mobile"
        && currentWindow.innerWidth >= 860
        && currentWindow.getComputedStyle(rails.task).display !== "none"
        && currentWindow.getComputedStyle(rails.activity).display !== "none";
    }

    function restoreWidths() {
      if (activeDrag) return;
      clearWidth(workspace, "task");
      clearWidth(workspace, "activity");
      if (!desktopChatVisible()) return;
      const saved = storedWidths(storage);
      if (saved.task === undefined && saved.activity === undefined) return;
      const defaults = layout();
      const gapWidth = Math.max(0, defaults.chat.left - defaults.task.right)
        + Math.max(0, defaults.activity.left - defaults.chat.right);
      const fitted = fitPanelWidths({
        taskWidth: saved.task ?? defaults.task.width,
        activityWidth: saved.activity ?? defaults.activity.width,
        availableWidth: defaults.workspace.width - gapWidth - CENTER_MINIMUM_WIDTH,
        customTask: saved.task !== undefined,
        customActivity: saved.activity !== undefined,
      });
      if (saved.task !== undefined) applyWidth(workspace, "task", fitted.task);
      if (saved.activity !== undefined) applyWidth(workspace, "activity", fitted.activity);
    }

    function schedulePositions() {
      if (positionFrame) return;
      positionFrame = currentWindow.requestAnimationFrame(updatePositions);
    }

    function buildHandle(side) {
      const handle = currentDocument.createElement("div");
      handle.dataset.sidePanelResizer = side;
      handle.title = PANEL_CONFIG[side].title;
      handle.addEventListener("pointerdown", (event) => {
        if (event.button !== 0 || !desktopChatVisible()) return;
        const current = layout();
        const sideRect = current[side];
        activeDrag = {
          handle,
          maximumWidth: Math.max(PANEL_CONFIG[side].minimumWidth, sideRect.width + current.chat.width - CENTER_MINIMUM_WIDTH),
          pointerId: event.pointerId,
          side,
          startWidth: sideRect.width,
          startX: event.clientX,
          width: sideRect.width,
        };
        handle.setPointerCapture?.(event.pointerId);
        root.dataset.sidePanelResizing = side;
        event.preventDefault();
      });
      handle.addEventListener("pointermove", (event) => {
        if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
        activeDrag.width = widthFromPointer({
          side: activeDrag.side,
          startWidth: activeDrag.startWidth,
          startX: activeDrag.startX,
          pointerX: event.clientX,
          maximumWidth: activeDrag.maximumWidth,
        });
        applyWidth(workspace, activeDrag.side, activeDrag.width);
        schedulePositions();
      });
      function finishDrag(event) {
        if (!activeDrag || event.pointerId !== activeDrag.pointerId) return;
        persistWidth(storage, activeDrag.side, activeDrag.width);
        activeDrag.handle.releasePointerCapture?.(activeDrag.pointerId);
        activeDrag = null;
        delete root.dataset.sidePanelResizing;
        schedulePositions();
      }
      handle.addEventListener("pointerup", finishDrag);
      handle.addEventListener("pointercancel", finishDrag);
      handle.addEventListener("dblclick", (event) => {
        forgetWidth(storage, side);
        restoreWidths();
        schedulePositions();
        event.preventDefault();
      });
      currentDocument.body.append(handle);
      return handle;
    }

    const handles = { task: buildHandle("task"), activity: buildHandle("activity") };

    function updatePositions() {
      positionFrame = 0;
      if (!desktopChatVisible()) {
        Object.values(handles).forEach((handle) => { handle.hidden = true; });
        return;
      }
      const current = layout();
      const top = Math.max(current.task.top, current.activity.top);
      const bottom = Math.min(current.task.bottom, current.activity.bottom);
      const boundaries = { task: current.task.right, activity: current.activity.left };
      Object.entries(handles).forEach(([side, handle]) => {
        handle.hidden = bottom <= top;
        handle.style.left = `${boundaries[side]}px`;
        handle.style.top = `${top}px`;
        handle.style.height = `${Math.max(0, bottom - top)}px`;
      });
    }

    function refreshLayout() {
      restoreWidths();
      schedulePositions();
    }

    restoreWidths();
    schedulePositions();
    currentWindow.addEventListener("resize", refreshLayout);
    currentWindow.addEventListener("scroll", schedulePositions, true);
    const mutationObserver = new currentWindow.MutationObserver(refreshLayout);
    mutationObserver.observe(root, { attributes: true, attributeFilter: ["data-surface", "data-theme", "data-view"] });
    const resizeObserver = typeof currentWindow.ResizeObserver === "function" ? new currentWindow.ResizeObserver(schedulePositions) : null;
    [workspace, rails.task, rails.activity, chat].forEach((element) => resizeObserver?.observe(element));
    return Object.freeze({ refreshLayout, restoreWidths, schedulePositions });
  }

  const api = Object.freeze({ CENTER_MINIMUM_WIDTH, PANEL_CONFIG, STORAGE_KEY, applyWidth, clampWidth, clearWidth, createController, fitPanelWidths, forgetWidth, normalizedWidth, persistWidth, storedWidths, widthFromPointer });
  if (typeof window === "object") window.AgentHubSidePanelResizer = api;
  if (typeof document === "object") {
    const start = () => createController({ document, window, storage: globalThis.localStorage });
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
    else start();
  }
})();
