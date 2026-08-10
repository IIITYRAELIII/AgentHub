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
    HorizontalPointerScroller,
    STREAM_ACTIVITY_DIRECTIONS,
    STREAM_ORDER_MODES,
    normalizeStreamActivityDirection,
    normalizeStreamOrderMode,
    orderWorkspaceStreams,
    streamCreationSide,
    streamLastActivity,
    streamsAreDraggable,
  });
})();
