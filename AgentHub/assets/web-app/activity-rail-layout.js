"use strict";

(() => {
  const SEPARATE_COLUMN_STORAGE_KEY = "agent-hub:activity-tasks-separate-column:v1";
  const ALWAYS_SEPARATE_COLUMN_STORAGE_KEY = "agent-hub:activity-tasks-always-separate-column:v1";
  const TASKS_COLLAPSED_STORAGE_KEY = "agent-hub:activity-tasks-collapsed:v1";
  const WORKSPACE_TASKS_COLLAPSED_STORAGE_KEY = "agent-hub:workspace-tasks-collapsed:v1";
  const RECENT_STREAMS_COLLAPSED_STORAGE_KEY = "agent-hub:recent-streams-collapsed:v1";
  const COLUMN_RATIO_STORAGE_KEY = "agent-hub:activity-task-column-ratio:v1";
  const VIEW_SETTINGS_CHANGE_EVENT = "agenthub:stream-view-settings-change";
  const DEFAULT_COLUMN_RATIO = 0.5;
  const MIN_COLUMN_RATIO = 0.25;
  const MAX_COLUMN_RATIO = 0.75;

  function storedBoolean(storage, key, fallback = false) {
    try {
      const value = storage?.getItem?.(key);
      if (value === "true") return true;
      if (value === "false") return false;
    } catch {}
    return Boolean(fallback);
  }

  function persistBoolean(storage, key, value) {
    const normalized = Boolean(value);
    try {
      storage?.setItem?.(key, String(normalized));
    } catch {}
    return normalized;
  }

  function installCollapsibleSection({
    section,
    toggle,
    trigger,
    storage,
    key,
    collapsedTitle = "Развернуть секцию",
    expandedTitle = "Свернуть секцию",
    onChange = () => {},
  } = {}) {
    if (!section || !toggle || !key) return null;
    let collapsed = storedBoolean(storage, key);
    const sync = () => {
      section.toggleAttribute("data-section-collapsed", collapsed);
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.setAttribute("aria-label", collapsed ? collapsedTitle : expandedTitle);
      toggle.title = collapsed ? collapsedTitle : expandedTitle;
      return collapsed;
    };
    const toggleSection = () => {
      collapsed = persistBoolean(storage, key, !collapsed);
      sync();
      onChange(collapsed);
    };
    toggle.addEventListener("click", (event) => {
      event?.stopPropagation?.();
      toggleSection();
    });
    trigger?.addEventListener("click", (event) => {
      if (event?.defaultPrevented) return;
      if (event?.target?.closest?.("button, a, input, select, textarea, [role='button']")) return;
      toggleSection();
    });
    sync();
    return Object.freeze({
      get collapsed() {
        return collapsed;
      },
      sync,
    });
  }

  function normalizeColumnRatio(value, fallback = DEFAULT_COLUMN_RATIO) {
    if (value === null || value === undefined || value === "") return fallback;
    const ratio = Number(value);
    if (!Number.isFinite(ratio)) return fallback;
    return Math.min(MAX_COLUMN_RATIO, Math.max(MIN_COLUMN_RATIO, ratio));
  }

  function storedColumnRatio(storage) {
    try {
      return normalizeColumnRatio(storage?.getItem?.(COLUMN_RATIO_STORAGE_KEY));
    } catch {
      return DEFAULT_COLUMN_RATIO;
    }
  }

  function persistColumnRatio(storage, value) {
    const ratio = normalizeColumnRatio(value);
    try {
      storage?.setItem?.(COLUMN_RATIO_STORAGE_KEY, String(ratio));
    } catch {}
    return ratio;
  }

  function columnRatioFromPointer({ left = 0, width = 0, pointerX = 0 } = {}) {
    const availableWidth = Number(width);
    if (!Number.isFinite(availableWidth) || availableWidth <= 0) return DEFAULT_COLUMN_RATIO;
    return normalizeColumnRatio((Number(pointerX) - Number(left)) / availableWidth);
  }

  function countedActivityHeading(label, count) {
    const normalizedLabel = String(label ?? "").trim();
    const normalizedCount = Math.max(0, Math.trunc(Number(count) || 0));
    return `${normalizedLabel} (${normalizedCount})`;
  }

  function naturalStackHeight({ chrome = 0, gap = 0, itemHeights = [] } = {}) {
    const heights = Array.from(itemHeights, (height) => Math.max(0, Number(height) || 0))
      .filter((height) => height > 0);
    return Math.max(0, Number(chrome) || 0)
      + heights.reduce((total, height) => total + height, 0)
      + Math.max(0, Number(gap) || 0) * Math.max(0, heights.length - 1);
  }

  function taskPanelHasCards(taskPanel) {
    return Boolean(taskPanel?.querySelector?.(".board-task-card"));
  }

  function shouldSeparateActivityColumns({
    autoSeparate = true,
    alwaysSeparate = false,
    tasksAvailable = true,
    tasksPresent = true,
    availableHeight = 0,
    requiredHeight = 0,
  } = {}) {
    if (!autoSeparate || !tasksAvailable) return false;
    if (alwaysSeparate) return true;
    if (!tasksPresent) return false;
    const available = Math.max(0, Number(availableHeight) || 0);
    const required = Math.max(0, Number(requiredHeight) || 0);
    return available > 0 && required > available + 1;
  }

  function resolveActivityColumnSeparation({
    autoSeparate = true,
    columnCollapsed = false,
    wasSeparate = false,
    ...fit
  } = {}) {
    if (!autoSeparate) return false;
    return Boolean(columnCollapsed && wasSeparate)
      || shouldSeparateActivityColumns({ ...fit, autoSeparate });
  }

  function activityRailColumnState({
    separate = false,
    tasksCollapsed = false,
    streamsCollapsed = false,
    tasksAvailable = true,
  } = {}) {
    const tasksVisible = Boolean(separate && tasksAvailable && !tasksCollapsed);
    const streamsVisible = Boolean(!streamsCollapsed);
    return Object.freeze({
      separate: Boolean(separate),
      tasksVisible,
      streamsVisible,
      visibleColumns: separate ? Number(tasksVisible) + Number(streamsVisible) : 1,
    });
  }

  function activityRailWidthFactor(
    state,
    columnRatio = DEFAULT_COLUMN_RATIO,
    { autoCombined = false } = {},
  ) {
    if (!state) return 1;
    const ratio = normalizeColumnRatio(columnRatio);
    if (autoCombined && !state.separate) return Math.max(ratio, 1 - ratio);
    if (!state.separate || state.visibleColumns !== 1) return 1;
    return state.tasksVisible ? ratio : 1 - ratio;
  }

  function activityHeadingsShouldStack({
    availableWidth = 0,
    columnRatio = DEFAULT_COLUMN_RATIO,
    gap = 0,
    streamWidth = 0,
    taskWidth = 0,
  } = {}) {
    const width = Math.max(0, Number(availableWidth) || 0);
    const columnGap = Math.max(0, Number(gap) || 0);
    const usableWidth = Math.max(0, width - columnGap);
    const ratio = normalizeColumnRatio(columnRatio);
    return Math.max(0, Number(taskWidth) || 0) > usableWidth * ratio
      || Math.max(0, Number(streamWidth) || 0) > usableWidth * (1 - ratio);
  }

  function minimumCollapsedRailWidth({ horizontalPadding = 0, streamWidth = 0, taskWidth = 0 } = {}) {
    return Math.ceil(
      Math.max(0, Number(horizontalPadding) || 0)
      + Math.max(0, Number(streamWidth) || 0, Number(taskWidth) || 0),
    );
  }

  function installActivityRailLayout(documentRef = window.document, windowRef = window) {
    const root = documentRef.documentElement;
    const rail = documentRef.querySelector("[data-activity-rail]");
    const head = rail?.querySelector?.(".activity-rail-head");
    const taskToggle = documentRef.querySelector("[data-activity-task-toggle]");
    const streamToggle = documentRef.querySelector("[data-activity-rail-toggle]");
    const taskPanel = documentRef.querySelector("[data-workspace-task-panel]");
    const streamColumn = documentRef.querySelector("[data-activity-stream-column]");
    const recentStreamSection = documentRef.querySelector(".activity-recent-streams");
    const recentStreamToggle = documentRef.querySelector("[data-activity-recent-toggle]");
    const workspaceTaskSection = documentRef.querySelector("[data-workspace-task-section]");
    const workspaceTaskToggle = documentRef.querySelector("[data-workspace-task-toggle]");
    const content = documentRef.querySelector(".activity-rail-content");
    const resizer = documentRef.querySelector("[data-activity-column-resizer]");
    const workspace = rail?.closest?.("[data-workspace]");
    if (
      !root || !rail || !head || !taskToggle || !streamToggle || !streamColumn
      || !taskPanel || !recentStreamSection || !recentStreamToggle
      || !workspaceTaskSection || !workspaceTaskToggle
      || !content || !resizer || !workspace
    ) return null;

    const widthProbe = documentRef.createElement("span");
    widthProbe.setAttribute("aria-hidden", "true");
    Object.assign(widthProbe.style, {
      display: "block",
      height: "0",
      pointerEvents: "none",
      position: "fixed",
      visibility: "hidden",
      width: "var(--activity-rail-width)",
    });
    workspace.append(widthProbe);

    let autoSeparate = storedBoolean(windowRef.localStorage, SEPARATE_COLUMN_STORAGE_KEY, true);
    let alwaysSeparate = storedBoolean(windowRef.localStorage, ALWAYS_SEPARATE_COLUMN_STORAGE_KEY);
    let tasksCollapsed = storedBoolean(windowRef.localStorage, TASKS_COLLAPSED_STORAGE_KEY);
    let columnRatio = storedColumnRatio(windowRef.localStorage);
    let activePointerId = null;
    let currentState = null;

    const numericStyleValue = (value) => {
      const number = Number.parseFloat(String(value ?? ""));
      return Number.isFinite(number) ? number : 0;
    };

    const verticalChrome = (element) => {
      const style = windowRef.getComputedStyle(element);
      return numericStyleValue(style.paddingTop)
        + numericStyleValue(style.paddingBottom)
        + numericStyleValue(style.borderTopWidth)
        + numericStyleValue(style.borderBottomWidth);
    };

    const outerHeight = (element) => {
      if (!element || element.hidden) return 0;
      const style = windowRef.getComputedStyle(element);
      if (style.display === "none") return 0;
      return (element.getBoundingClientRect?.().height ?? 0)
        + numericStyleValue(style.marginTop)
        + numericStyleValue(style.marginBottom);
    };

    const naturalListHeight = (list) => {
      if (!list || list.hidden) return 0;
      const style = windowRef.getComputedStyle(list);
      if (style.display === "none") return 0;
      return numericStyleValue(style.marginTop)
        + numericStyleValue(style.marginBottom)
        + naturalStackHeight({
          chrome: verticalChrome(list),
          gap: numericStyleValue(style.rowGap || style.gap),
          itemHeights: Array.from(list.children, outerHeight),
        });
    };

    const naturalTaskSectionHeight = (section) => verticalChrome(section)
      + Array.from(section.children).reduce((height, child) => (
        height + (child.matches?.(".workspace-task-list") ? naturalListHeight(child) : outerHeight(child))
      ), 0);

    const naturalPanelHeight = (panel) => verticalChrome(panel)
      + Array.from(panel.children).reduce((height, child) => (
        height + (child.matches?.(".workspace-task-section")
          ? naturalTaskSectionHeight(child)
          : outerHeight(child))
      ), 0);

    const naturalStreamHeight = () => verticalChrome(streamColumn)
      + Array.from(streamColumn.children).reduce((height, section) => (
        height + verticalChrome(section)
        + Array.from(section.children).reduce((sectionHeight, child) => (
          sectionHeight + (child.matches?.(".activity-stream-list")
            ? naturalListHeight(child)
            : outerHeight(child))
        ), 0)
      ), 0);

    const combinedContentHeight = () => naturalStreamHeight()
      + naturalPanelHeight(taskPanel);

    const intrinsicToggleWidth = (toggle) => {
      const style = windowRef.getComputedStyle(toggle);
      const label = toggle.querySelector("span");
      const icon = toggle.querySelector("svg");
      return (label?.scrollWidth ?? 0)
        + (icon?.getBoundingClientRect?.().width ?? 0)
        + numericStyleValue(style.columnGap || style.gap)
        + numericStyleValue(style.paddingLeft)
        + numericStyleValue(style.paddingRight)
        + numericStyleValue(style.borderLeftWidth)
        + numericStyleValue(style.borderRightWidth);
    };

    const headingMetrics = () => {
      const style = windowRef.getComputedStyle(head);
      const railStyle = windowRef.getComputedStyle(rail);
      const headPadding = numericStyleValue(style.paddingLeft)
        + numericStyleValue(style.paddingRight);
      const horizontalPadding = headPadding
        + numericStyleValue(railStyle.borderLeftWidth)
        + numericStyleValue(railStyle.borderRightWidth);
      return {
        availableWidth: Math.max(0, head.clientWidth - headPadding),
        gap: numericStyleValue(style.columnGap || style.gap),
        horizontalPadding,
        streamWidth: intrinsicToggleWidth(streamToggle),
        taskWidth: intrinsicToggleWidth(taskToggle),
      };
    };

    const syncHeadingLayout = (state = currentState) => {
      if (!state?.separate || root.dataset.surface === "mobile") {
        rail.removeAttribute("data-activity-headings-stacked");
        return false;
      }
      const metrics = headingMetrics();
      const headingRatio = state.visibleColumns === 2 ? columnRatio : DEFAULT_COLUMN_RATIO;
      const stacked = state.visibleColumns === 0 || activityHeadingsShouldStack({
        ...metrics,
        columnRatio: headingRatio,
      });
      rail.toggleAttribute("data-activity-headings-stacked", stacked);
      return stacked;
    };

    const syncVisibleRailWidth = (state = currentState) => {
      if (!state) return;
      const autoCombined = autoSeparate && !alwaysSeparate && !state.separate;
      const factor = activityRailWidthFactor(state, columnRatio, { autoCombined });
      if ((!autoCombined && (!state.separate || state.visibleColumns === 2))
        || root.dataset.surface === "mobile") {
        delete rail.dataset.sidePanelWidthScale;
        if (workspace.style.getPropertyValue("--activity-rail-visible-width")) {
          workspace.style.removeProperty("--activity-rail-visible-width");
        }
        return;
      }
      if (state.visibleColumns === 0) delete rail.dataset.sidePanelWidthScale;
      else rail.dataset.sidePanelWidthScale = String(factor);
      const metrics = headingMetrics();
      const minimumWidth = minimumCollapsedRailWidth(metrics);
      const baseWidth = widthProbe.getBoundingClientRect().width
        || rail.getBoundingClientRect().width;
      const targetWidth = state.visibleColumns === 0
        ? minimumWidth
        : Math.max(minimumWidth, baseWidth * factor);
      const visibleWidth = `${Math.max(0, targetWidth).toFixed(2)}px`;
      if (workspace.style.getPropertyValue("--activity-rail-visible-width") !== visibleWidth) {
        workspace.style.setProperty("--activity-rail-visible-width", visibleWidth);
      }
    };

    const applyColumnRatio = (value, { persist = false } = {}) => {
      columnRatio = persist
        ? persistColumnRatio(windowRef.localStorage, value)
        : normalizeColumnRatio(value);
      rail.style.setProperty("--activity-task-column-ratio", `${columnRatio * 100}%`);
      resizer.setAttribute("aria-valuenow", String(Math.round(columnRatio * 100)));
      syncVisibleRailWidth();
      syncHeadingLayout();
      return columnRatio;
    };

    const sync = () => {
      const tasksAvailable = !taskPanel.hidden;
      const tasksPresent = taskPanelHasCards(taskPanel);
      const columnCollapsed = tasksCollapsed || rail.hasAttribute("data-collapsed");
      const separate = resolveActivityColumnSeparation({
        autoSeparate,
        alwaysSeparate,
        tasksAvailable,
        tasksPresent,
        columnCollapsed,
        wasSeparate: currentState?.separate,
        availableHeight: content.clientHeight,
        requiredHeight: combinedContentHeight(),
      });
      const state = activityRailColumnState({
        separate,
        tasksCollapsed,
        streamsCollapsed: rail.hasAttribute("data-collapsed"),
        tasksAvailable,
      });
      currentState = state;
      root.toggleAttribute("data-activity-tasks-auto-separate", autoSeparate);
      root.toggleAttribute("data-activity-tasks-always-separate", alwaysSeparate);
      if (state.separate) {
        root.dataset.activityTaskColumn = "separate";
        root.dataset.activityColumnCount = String(state.visibleColumns);
      } else {
        delete root.dataset.activityTaskColumn;
        delete root.dataset.activityColumnCount;
      }
      rail.toggleAttribute("data-task-column-collapsed", state.separate && tasksCollapsed);
      taskToggle.hidden = !state.separate;
      resizer.hidden = !(state.separate && state.visibleColumns === 2);
      taskToggle.setAttribute("aria-expanded", String(!tasksCollapsed));
      taskToggle.title = tasksCollapsed ? "Развернуть задачи" : "Свернуть задачи";
      applyColumnRatio(columnRatio);
      syncVisibleRailWidth(state);
      syncHeadingLayout(state);
      return state;
    };

    taskToggle.addEventListener("click", () => {
      if (!currentState?.separate) return;
      tasksCollapsed = persistBoolean(
        windowRef.localStorage,
        TASKS_COLLAPSED_STORAGE_KEY,
        !tasksCollapsed,
      );
      sync();
    });

    resizer.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || resizer.hidden) return;
      activePointerId = event.pointerId;
      resizer.setPointerCapture?.(activePointerId);
      root.dataset.activityColumnResizing = "true";
      event.preventDefault();
    });
    resizer.addEventListener("pointermove", (event) => {
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      const bounds = content.getBoundingClientRect();
      applyColumnRatio(columnRatioFromPointer({
        left: bounds.left,
        width: bounds.width,
        pointerX: event.clientX,
      }));
      event.preventDefault();
    });
    const finishResize = (event) => {
      if (activePointerId === null || event.pointerId !== activePointerId) return;
      applyColumnRatio(columnRatio, { persist: true });
      resizer.releasePointerCapture?.(activePointerId);
      activePointerId = null;
      delete root.dataset.activityColumnResizing;
    };
    resizer.addEventListener("pointerup", finishResize);
    resizer.addEventListener("pointercancel", finishResize);
    resizer.addEventListener("dblclick", (event) => {
      applyColumnRatio(DEFAULT_COLUMN_RATIO, { persist: true });
      event.preventDefault();
    });
    resizer.addEventListener("keydown", (event) => {
      const keyboardRatios = {
        ArrowLeft: columnRatio - 0.05,
        ArrowRight: columnRatio + 0.05,
        Home: MIN_COLUMN_RATIO,
        End: MAX_COLUMN_RATIO,
      };
      if (!Object.hasOwn(keyboardRatios, event.key)) return;
      applyColumnRatio(keyboardRatios[event.key], { persist: true });
      event.preventDefault();
    });
    documentRef.addEventListener(VIEW_SETTINGS_CHANGE_EVENT, (event) => {
      if (event.detail?.key === "activityTasksSeparateColumn") {
        autoSeparate = persistBoolean(
          windowRef.localStorage,
          SEPARATE_COLUMN_STORAGE_KEY,
          event.detail?.value,
        );
      } else if (event.detail?.key === "activityTasksAlwaysSeparateColumn") {
        alwaysSeparate = persistBoolean(
          windowRef.localStorage,
          ALWAYS_SEPARATE_COLUMN_STORAGE_KEY,
          event.detail?.value,
        );
      } else return;
      sync();
    });

    installCollapsibleSection({
      section: workspaceTaskSection,
      toggle: workspaceTaskToggle,
      trigger: workspaceTaskSection.querySelector(":scope > header"),
      storage: windowRef.localStorage,
      key: WORKSPACE_TASKS_COLLAPSED_STORAGE_KEY,
      collapsedTitle: "Развернуть задачи Workspace",
      expandedTitle: "Свернуть задачи Workspace",
      onChange: sync,
    });
    installCollapsibleSection({
      section: recentStreamSection,
      toggle: recentStreamToggle,
      trigger: recentStreamSection.querySelector(":scope > header"),
      storage: windowRef.localStorage,
      key: RECENT_STREAMS_COLLAPSED_STORAGE_KEY,
      collapsedTitle: "Развернуть недавние потоки",
      expandedTitle: "Свернуть недавние потоки",
      onChange: sync,
    });

    if (typeof windowRef.MutationObserver === "function") {
      const observer = new windowRef.MutationObserver(sync);
      observer.observe(rail, { attributes: true, attributeFilter: ["data-collapsed"] });
      observer.observe(taskPanel, { attributes: true, attributeFilter: ["hidden"] });
      observer.observe(streamColumn, { childList: true, characterData: true, subtree: true });
      observer.observe(taskPanel, { childList: true, characterData: true, subtree: true });
      const widthObserver = new windowRef.MutationObserver(() => syncVisibleRailWidth());
      widthObserver.observe(workspace, { attributes: true, attributeFilter: ["style"] });
      const headingObserver = new windowRef.MutationObserver(() => {
        syncVisibleRailWidth();
        syncHeadingLayout();
      });
      headingObserver.observe(head, { childList: true, characterData: true, subtree: true });
    }
    if (typeof windowRef.ResizeObserver === "function") {
      new windowRef.ResizeObserver(() => syncVisibleRailWidth()).observe(widthProbe);
      new windowRef.ResizeObserver(() => syncHeadingLayout()).observe(head);
      new windowRef.ResizeObserver(sync).observe(content);
    } else {
      windowRef.addEventListener?.("resize", () => {
        syncVisibleRailWidth();
        syncHeadingLayout();
      }, { passive: true });
    }
    sync();
    return Object.freeze({ sync });
  }

  window.AgentHubActivityRailLayout = Object.freeze({
    ALWAYS_SEPARATE_COLUMN_STORAGE_KEY,
    COLUMN_RATIO_STORAGE_KEY,
    DEFAULT_COLUMN_RATIO,
    MAX_COLUMN_RATIO,
    MIN_COLUMN_RATIO,
    RECENT_STREAMS_COLLAPSED_STORAGE_KEY,
    SEPARATE_COLUMN_STORAGE_KEY,
    TASKS_COLLAPSED_STORAGE_KEY,
    WORKSPACE_TASKS_COLLAPSED_STORAGE_KEY,
    activityHeadingsShouldStack,
    activityRailColumnState,
    activityRailWidthFactor,
    columnRatioFromPointer,
    countedActivityHeading,
    installCollapsibleSection,
    installActivityRailLayout,
    minimumCollapsedRailWidth,
    naturalStackHeight,
    normalizeColumnRatio,
    persistBoolean,
    persistColumnRatio,
    resolveActivityColumnSeparation,
    shouldSeparateActivityColumns,
    storedColumnRatio,
    storedBoolean,
    taskPanelHasCards,
  });

  installActivityRailLayout();
})();
