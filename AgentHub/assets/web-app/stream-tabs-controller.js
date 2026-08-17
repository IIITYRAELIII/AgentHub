(() => {
  "use strict";

  const STREAM_ORDER_MODES = Object.freeze({
    ACTIVITY: "activity",
    MANUAL: "manual",
  });

  const STREAM_ACTIVITY_DIRECTIONS = Object.freeze({
    START: "start",
    END: "end",
  });

  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const PHOSPHOR_ICON_PATHS = Object.freeze({
    copy: "M216,32H88A16,16,0,0,0,72,48V72H48A16,16,0,0,0,32,88V216a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V192h24a16,16,0,0,0,16-16V48A16,16,0,0,0,216,32ZM176,216H48V88H72v88a16,16,0,0,0,16,16h88Zm40-40H88V48H216Z",
    "clock-counter-clockwise": "M136,80v43.47l36.12,21.67a8,8,0,0,1-8.24,13.72l-40-24A8,8,0,0,1,120,128V80a8,8,0,0,1,16,0Zm-8-48A95.44,95.44,0,0,0,60.08,60.15C52.81,67.51,46.35,74.59,40,82V64a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H72a8,8,0,0,0,0-16H49c7.15-8.42,14.27-16.35,22.39-24.57a80,80,0,1,1,1.66,114.75,8,8,0,1,0-11,11.64A96,96,0,1,0,128,32Z",
    "arrows-down-up": "M117.66,170.34a8,8,0,0,1,0,11.32l-32,32a8,8,0,0,1-11.32,0l-32-32a8,8,0,0,1,11.32-11.32L72,188.69V48a8,8,0,0,1,16,0V188.69l18.34-18.35A8,8,0,0,1,117.66,170.34Zm96-96-32-32a8,8,0,0,0-11.32,0l-32,32a8,8,0,0,0,11.32,11.32L168,67.31V208a8,8,0,0,0,16,0V67.31l18.34,18.35a8,8,0,0,0,11.32-11.32Z",
    plus: "M216,128a8,8,0,0,1-8,8H136v72a8,8,0,0,1-16,0V136H48a8,8,0,0,1,0-16h72V48a8,8,0,0,1,16,0v72h72A8,8,0,0,1,216,128Z",
  });

  function createPhosphorIcon(documentRef, name, className = "") {
    if (typeof documentRef?.createElementNS !== "function") {
      throw new TypeError("SVG-capable document is required");
    }
    const pathData = PHOSPHOR_ICON_PATHS[name];
    if (!pathData) throw new Error(`unknown Phosphor icon: ${name}`);
    const svg = documentRef.createElementNS(SVG_NAMESPACE, "svg");
    svg.setAttribute("data-phosphor-icon", name);
    svg.setAttribute("viewBox", "0 0 256 256");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    const path = documentRef.createElementNS(SVG_NAMESPACE, "path");
    path.setAttribute("d", pathData);
    path.setAttribute("fill", "currentColor");
    svg.append(path);
    return svg;
  }

  function archiveStreamIntent(streamId) {
    const id = String(streamId ?? "").trim();
    if (!id) throw new Error("stream id is required");
    return { type: "stream:archive", detail: { streamId: id } };
  }

  function normalizeStreamOrderMode(value) {
    return value === STREAM_ORDER_MODES.MANUAL
      ? STREAM_ORDER_MODES.MANUAL
      : STREAM_ORDER_MODES.ACTIVITY;
  }

  function normalizeStreamActivityDirection(value) {
    return value === STREAM_ACTIVITY_DIRECTIONS.END
      ? STREAM_ACTIVITY_DIRECTIONS.END
      : STREAM_ACTIVITY_DIRECTIONS.START;
  }

  function streamLastActivity(stream) {
    return Math.max(0, ...(stream?.tasks ?? []).map((task) => (
      Date.parse(task?.lastActivity || 0) || 0
    )));
  }

  function streamsAreDraggable(mode, surface) {
    return normalizeStreamOrderMode(mode) === STREAM_ORDER_MODES.MANUAL
      && surface !== "mobile";
  }

  function streamCreationSide(mode, activityDirection) {
    return normalizeStreamOrderMode(mode) === STREAM_ORDER_MODES.ACTIVITY
      ? normalizeStreamActivityDirection(activityDirection)
      : STREAM_ACTIVITY_DIRECTIONS.END;
  }

  function attentionStreamCount(tasks) {
    return (tasks ?? []).reduce((count, task) => (
      count + (task?.running || task?.unread ? 1 : 0)
    ), 0);
  }

  function activityStreamSections(tasks) {
    const active = [];
    const recent = [];
    for (const task of tasks ?? []) {
      if (task?.running || task?.unread) active.push(task);
      else recent.push(task);
    }
    return { active, recent };
  }

  function taskListSections(tasks) {
    const workspaceTasks = [];
    const unassignedTasks = [];
    for (const task of tasks ?? []) {
      if (String(task?.workspaceId ?? "").trim()) workspaceTasks.push(task);
      else unassignedTasks.push(task);
    }
    return { workspaceTasks, unassignedTasks };
  }

  function streamStatusPresentation(task) {
    const running = Boolean(task?.running);
    const answerReady = Boolean(task?.unread);
    const statusLabel = [
      running ? "Ход выполняется" : "",
      answerReady ? "Ответ готов" : "",
    ].filter(Boolean).join(" · ") || String(task?.statusLabel ?? "");
    return { running, answerReady, statusLabel };
  }

  function includeTaskInActivityRail(task, kind) {
    const workspaceName = String(task?.workspaceName ?? "").trim();
    return workspaceName !== "Other" || kind === "running" || kind === "completed";
  }

  function resolveTaskHierarchy(task, workspaces) {
    const workspaceId = String(task?.workspaceId ?? "").trim();
    const streamId = String(task?.streamId ?? "").trim();
    const workspace = (workspaces ?? []).find((candidate) => (
      (workspaceId && String(candidate?.id ?? "") === workspaceId)
      || (streamId && (candidate?.streams ?? []).some((stream) => String(stream?.id ?? "") === streamId))
    )) ?? null;
    const stream = workspace && streamId
      ? (workspace.streams ?? []).find((candidate) => String(candidate?.id ?? "") === streamId) ?? null
      : null;
    return { workspace, stream };
  }

  function workspaceGroupLastActivity(group) {
    return Math.max(0, ...(group?.tasks ?? []).map((task) => (
      Date.parse(task?.lastActivity || 0) || 0
    )));
  }

  function orderWorkspaceGroups(groups) {
    return [...(groups ?? [])].sort((left, right) => (
      Number(left?.kind === "system") - Number(right?.kind === "system")
      || workspaceGroupLastActivity(right) - workspaceGroupLastActivity(left)
      || String(left?.name ?? "").localeCompare(String(right?.name ?? ""), "ru")
      || String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
    ));
  }

  function orderWorkspaceStreams(streams, mode, activityDirection = STREAM_ACTIVITY_DIRECTIONS.START) {
    const uniqueStreams = [];
    const available = new Map();
    for (const stream of streams ?? []) {
      const id = String(stream?.id ?? "").trim();
      if (!id || available.has(id)) continue;
      available.set(id, stream);
      uniqueStreams.push(stream);
    }

    if (normalizeStreamOrderMode(mode) === STREAM_ORDER_MODES.ACTIVITY) {
      const direction = normalizeStreamActivityDirection(activityDirection)
        === STREAM_ACTIVITY_DIRECTIONS.END ? 1 : -1;
      return uniqueStreams.sort((left, right) => (
        direction * (streamLastActivity(left) - streamLastActivity(right))
        || direction * ((Number(left?.ordinal) || 0) - (Number(right?.ordinal) || 0))
      ));
    }

    const ordered = uniqueStreams.sort((left, right) => (
      (Number(left?.ordinal) || 0) - (Number(right?.ordinal) || 0)
      || String(left?.id ?? "").localeCompare(String(right?.id ?? ""))
    ));
    const dashBotIndex = ordered.findIndex((stream) => stream?.name === "DashBot");
    if (dashBotIndex > 0) {
      const [dashBot] = ordered.splice(dashBotIndex, 1);
      ordered.unshift(dashBot);
    }
    return ordered;
  }

  class HorizontalPointerScroller {
    constructor(target, options = {}) {
      if (!target) throw new TypeError("target is required");
      this.target = target;
      this.enabled = typeof options.enabled === "function" ? options.enabled : () => true;
      this.onDragStart = typeof options.onDragStart === "function" ? options.onDragStart : () => {};
      this.onDragEnd = typeof options.onDragEnd === "function" ? options.onDragEnd : () => {};
      this.threshold = Math.max(1, Number(options.thresholdPx) || 5);
      this.pointer = null;
      this.listeners = [];
      this.bind("pointerdown", (event) => this.start(event));
      this.bind("pointermove", (event) => this.move(event));
      this.bind("pointerup", (event) => this.finish(event));
      this.bind("pointercancel", (event) => this.finish(event));
    }

    bind(type, listener) {
      this.target.addEventListener(type, listener);
      this.listeners.push({ type, listener });
    }

    start(event) {
      if (!this.enabled() || event?.isPrimary === false || event?.pointerType === "touch") return;
      if (Number(event?.button ?? 0) !== 0) return;
      this.pointer = {
        id: event.pointerId,
        x: Number(event.clientX) || 0,
        scrollLeft: Number(this.target.scrollLeft) || 0,
        moved: false,
      };
    }

    move(event) {
      const pointer = this.pointer;
      if (!pointer || event.pointerId !== pointer.id) return;
      const delta = (Number(event.clientX) || 0) - pointer.x;
      if (!pointer.moved && Math.abs(delta) < this.threshold) return;
      if (!pointer.moved) {
        pointer.moved = true;
        this.target.setPointerCapture?.(pointer.id);
        this.target.toggleAttribute?.("data-scroll-drag", true);
        this.onDragStart();
      }
      this.target.scrollLeft = pointer.scrollLeft - delta;
      event.preventDefault?.();
    }

    finish(event) {
      const pointer = this.pointer;
      if (!pointer || event.pointerId !== pointer.id) return;
      this.pointer = null;
      if (!pointer.moved) return;
      this.target.releasePointerCapture?.(pointer.id);
      this.target.toggleAttribute?.("data-scroll-drag", false);
      this.onDragEnd({ moved: true });
    }

    destroy() {
      this.pointer = null;
      this.target.toggleAttribute?.("data-scroll-drag", false);
      for (const { type, listener } of this.listeners) {
        this.target.removeEventListener(type, listener);
      }
      this.listeners = [];
    }
  }

  window.AgentHubStreamTabs = Object.freeze({
    archiveStreamIntent,
    activityStreamSections,
    attentionStreamCount,
    createPhosphorIcon,
    HorizontalPointerScroller,
    includeTaskInActivityRail,
    orderWorkspaceGroups,
    resolveTaskHierarchy,
    STREAM_ACTIVITY_DIRECTIONS,
    STREAM_ORDER_MODES,
    normalizeStreamActivityDirection,
    normalizeStreamOrderMode,
    orderWorkspaceStreams,
    streamCreationSide,
    streamLastActivity,
    streamStatusPresentation,
    streamsAreDraggable,
    taskListSections,
  });
})();
