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

  const STREAM_CARD_WIDTH_MODES = Object.freeze({
    AUTO: "auto",
    FIXED: "fixed",
  });

  const STREAM_CARD_MIN_WIDTH = 90;
  const STREAM_CARD_MAX_WIDTH = 450;
  const STREAM_CARD_SETTINGS_CHANGE_EVENT = "agenthub:stream-card-settings-change";

  function normalizeStreamCardSettings(value) {
    const widthMode = value?.streamCardWidthMode ?? value?.widthMode;
    const fixedWidth = value?.streamCardFixedWidth ?? value?.fixedWidth;
    const gapEnabled = value?.streamCardGapEnabled ?? value?.gapEnabled;
    const width = Math.round(Number(fixedWidth));
    return {
      widthMode: widthMode === STREAM_CARD_WIDTH_MODES.FIXED
        ? STREAM_CARD_WIDTH_MODES.FIXED
        : STREAM_CARD_WIDTH_MODES.AUTO,
      fixedWidth: Number.isFinite(width)
        ? Math.min(STREAM_CARD_MAX_WIDTH, Math.max(STREAM_CARD_MIN_WIDTH, width))
        : STREAM_CARD_MIN_WIDTH,
      gapEnabled: gapEnabled === true,
    };
  }

  function streamCardSettingsAvailable({ isWide, surface }) {
    return Boolean(isWide) && surface !== "mobile";
  }

  function streamCardSettingsWrapperNeedsReplacement(currentWrapper, renderedWrapper) {
    return !renderedWrapper || renderedWrapper !== currentWrapper;
  }

  function setTextContentIfChanged(element, value) {
    if (!element) return false;
    const nextValue = String(value);
    if (element.textContent === nextValue) return false;
    element.textContent = nextValue;
    return true;
  }

  const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
  const PHOSPHOR_ICON_PATHS = Object.freeze({
    "caret-down": "M213.66,101.66l-80,80a8,8,0,0,1-11.32,0l-80-80A8,8,0,0,1,53.66,90.34L128,164.69l74.34-74.35a8,8,0,0,1,11.32,11.32Z",
    "caret-right": "M181.66,133.66l-80,80a8,8,0,0,1-11.32-11.32L164.69,128,90.34,53.66a8,8,0,0,1,11.32-11.32l80,80A8,8,0,0,1,181.66,133.66Z",
    copy: "M216,32H88A16,16,0,0,0,72,48V72H48A16,16,0,0,0,32,88V216a16,16,0,0,0,16,16H176a16,16,0,0,0,16-16V192h24a16,16,0,0,0,16-16V48A16,16,0,0,0,216,32ZM176,216H48V88H72v88a16,16,0,0,0,16,16h88Zm40-40H88V48H216Z",
    "clock-counter-clockwise": "M136,80v43.47l36.12,21.67a8,8,0,0,1-8.24,13.72l-40-24A8,8,0,0,1,120,128V80a8,8,0,0,1,16,0Zm-8-48A95.44,95.44,0,0,0,60.08,60.15C52.81,67.51,46.35,74.59,40,82V64a8,8,0,0,0-16,0v40a8,8,0,0,0,8,8H72a8,8,0,0,0,0-16H49c7.15-8.42,14.27-16.35,22.39-24.57a80,80,0,1,1,1.66,114.75,8,8,0,1,0-11,11.64A96,96,0,1,0,128,32Z",
    "arrow-clockwise": "M240,56v48a8,8,0,0,1-8,8H184a8,8,0,0,1,0-16h28.77L194.4,77.33a80,80,0,1,0,1.84,99.28,8,8,0,0,1,12.48,10A96,96,0,1,1,207.5,67.64L224,84.44V56a8,8,0,0,1,16,0Z",
    "arrows-down-up": "M117.66,170.34a8,8,0,0,1,0,11.32l-32,32a8,8,0,0,1-11.32,0l-32-32a8,8,0,0,1,11.32-11.32L72,188.69V48a8,8,0,0,1,16,0V188.69l18.34-18.35A8,8,0,0,1,117.66,170.34Zm96-96-32-32a8,8,0,0,0-11.32,0l-32,32a8,8,0,0,0,11.32,11.32L168,67.31V208a8,8,0,0,0,16,0V67.31l18.34,18.35a8,8,0,0,0,11.32-11.32Z",
    "pencil-simple": "M227.31,73.37,182.63,28.69a16,16,0,0,0-22.63,0L36.69,152A15.86,15.86,0,0,0,32,163.31V208a16,16,0,0,0,16,16H92.69A15.86,15.86,0,0,0,104,219.31L227.31,96A16,16,0,0,0,227.31,73.37ZM92.69,208H48V163.31l88-88L180.69,120ZM216,84.69,192,108.69,147.31,64,171.31,40,216,84.69Z",
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

  function streamDeckRenderKey(tasks, selectedTaskId) {
    return JSON.stringify({
      selectedTaskId: String(selectedTaskId ?? ""),
      streams: (Array.isArray(tasks) ? tasks : []).map((task) => [
        String(task?.id ?? ""),
        String(task?.workspaceName ?? task?.title ?? ""),
        String(task?.streamName ?? task?.streamDisplayName ?? ""),
      ]),
    });
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

  function streamStatusState(task) {
    const failed = Boolean(task?.failed || task?.error)
      || /(?:fail|error|сбой|ошиб)/iu.test(`${String(task?.status ?? "")} ${String(task?.statusLabel ?? "")}`);
    if (failed) return "failed";
    return task?.running ? "running" : "idle";
  }

  function compactStreamActivityValue(value) {
    const source = String(value ?? "").trim();
    const compact = source.replace(/\s*\d+\s*с$/u, "").trim();
    return compact !== source ? compact || "<1м" : source;
  }

  function resolveStableStreamCardWidth(widths, streamId, measuredWidth = 0) {
    const key = String(streamId ?? "").trim();
    if (!key) return 0;
    const cached = Number(widths.get(key)) || 0;
    if (cached > 0) return cached;
    const width = Number(measuredWidth) || 0;
    if (width > 0) widths.set(key, width);
    return width;
  }

  function calculateOverflowShift(overflowLeft, lastVisibleRight, currentShift = 0) {
    return Math.max(0, Number(overflowLeft) + Number(currentShift) - Number(lastVisibleRight));
  }

  function includeTaskInActivityRail(task, kind) {
    const workspaceName = String(task?.workspaceName ?? "").trim();
    return workspaceName !== "Other" || kind === "running" || kind === "completed";
  }

  function resolveTaskHierarchy(task, workspaces) {
    const workspaceId = String(task?.workspaceId ?? "").trim();
    const streamId = String(task?.streamId ?? "").trim();
    const provider = String(task?.provider ?? "");
    const threadId = String(task?.threadId ?? "");
    const matches = [];
    for (const candidate of workspaces ?? []) {
      for (const stream of candidate?.streams ?? []) {
        const streamMatches = streamId
          ? String(stream?.id ?? "") === streamId
          : (provider && threadId && (stream.threads ?? []).some((thread) => (
            String(thread?.provider ?? "") === provider
            && String(thread?.threadId ?? thread?.id ?? "") === threadId
          )));
        if (streamMatches || (workspaceId && String(candidate?.id ?? "") === workspaceId)) {
          matches.push({ workspace: candidate, stream: streamMatches ? stream : null });
        }
      }
      if (workspaceId && !(candidate?.streams ?? []).length && String(candidate?.id ?? "") === workspaceId) {
        matches.push({ workspace: candidate, stream: null });
      }
    }
    if (!matches.length) return { workspace: null, stream: null };
    const exact = matches.find((match) => match.stream) ?? matches[0];
    if (!streamId && !workspaceId && matches.length !== 1) return { workspace: null, stream: null };
    return exact;
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

  function reconcileOpenStreamIds(previousIds, availableIds, fallbackId, limit = 4) {
    const available = new Set((availableIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean));
    const normalized = [];
    for (const value of previousIds ?? []) {
      const id = String(value ?? "").trim();
      if (!available.has(id) || normalized.includes(id)) continue;
      normalized.push(id);
      if (normalized.length >= limit) break;
    }
    if (normalized.length) return normalized;
    const fallback = String(fallbackId ?? "").trim();
    if (available.has(fallback)) return [fallback];
    const first = available.values().next().value;
    return first ? [first] : [];
  }

  function applyOpenStreamSelection(openIds, streamId, { additive = false, limit = 4 } = {}) {
    const target = String(streamId ?? "").trim();
    const current = [...new Set((openIds ?? []).map((value) => String(value ?? "").trim()).filter(Boolean))]
      .slice(0, limit);
    if (!target) return { ids: current, limitReached: false };
    if (!additive) {
      return {
        ids: current.includes(target) && current.length > 1 ? current : [target],
        limitReached: false,
      };
    }
    if (current.includes(target)) {
      return {
        ids: current.length > 1 ? current.filter((id) => id !== target) : current,
        limitReached: false,
      };
    }
    if (current.length >= limit) return { ids: current, limitReached: true };
    return { ids: [...current, target], limitReached: false };
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

  class StreamCardSettingsController {
    constructor(documentRef, windowRef) {
      this.document = documentRef;
      this.window = windowRef;
      this.root = documentRef.documentElement;
      this.tabs = documentRef.querySelector("[data-stream-tabs]");
      this.widthMode = STREAM_CARD_WIDTH_MODES.AUTO;
      this.fixedWidth = STREAM_CARD_MIN_WIDTH;
      this.gapEnabled = false;
      this.open = false;
      this.frame = 0;
      this.autoWidths = new Map();
      this.wrapper = null;
      this.tabsObserver = null;
      this.rootObserver = null;
      if (!this.tabs) return;
      this.onDocumentClick = (event) => {
        const wrapper = this.tabs.querySelector("[data-stream-card-settings]");
        if (wrapper && !wrapper.contains(event.target)) this.close(wrapper);
      };
      this.onDocumentKeydown = (event) => {
        if (event.key === "Escape") this.close(this.tabs.querySelector("[data-stream-card-settings]"));
      };
      this.document.addEventListener("click", this.onDocumentClick);
      this.document.addEventListener("keydown", this.onDocumentKeydown);
      this.window.addEventListener("resize", (event) => {
        if (event.isTrusted) this.autoWidths.clear();
        this.schedule();
      });
      if (typeof this.window.MutationObserver === "function") {
        this.tabsObserver = new this.window.MutationObserver((mutations) => {
          const overflowChanged = mutations.some((mutation) => mutation.type === "attributes"
            && mutation.attributeName === "hidden"
            && mutation.target.matches?.(".stream-tab-group, .stream-tabs-overflow"));
          const contentChanged = mutations.some((mutation) => mutation.type !== "attributes"
            || mutation.attributeName === "data-order-mode");
          if (contentChanged) this.sync();
          else if (overflowChanged) this.alignOverflow();
        });
        this.tabsObserver.observe(this.tabs, {
          attributes: true,
          attributeFilter: ["data-order-mode", "hidden"],
          characterData: true,
          childList: true,
          subtree: true,
        });
        this.rootObserver = new this.window.MutationObserver(() => this.schedule());
        this.rootObserver.observe(this.root, {
          attributes: true,
          attributeFilter: ["data-surface", "data-theme"],
        });
      }
      this.schedule();
    }

    isActive() {
      const wide = typeof this.window.matchMedia !== "function"
        || this.window.matchMedia("(min-width: 860px)").matches;
      return streamCardSettingsAvailable({
        isWide: wide,
        surface: this.root.dataset.surface,
      });
    }

    schedule() {
      if (this.frame) return;
      this.frame = this.window.requestAnimationFrame(() => {
        this.frame = 0;
        this.sync();
      });
    }

    sync() {
      if (!this.isActive()) {
        this.root.removeAttribute("data-stream-card-settings");
        this.tabs.querySelector("[data-stream-card-settings]")?.remove();
        this.wrapper = null;
        this.tabs.removeAttribute("data-stream-card-width-mode");
        this.tabs.removeAttribute("data-stream-card-gap-mode");
        this.tabs.style.removeProperty("--stream-card-width");
        this.tabs.style.removeProperty("--stream-overflow-shift");
        return;
      }
      const overflow = this.tabs.querySelector(".stream-tabs-overflow");
      const orderToggle = this.tabs.querySelector(".stream-order-toggle");
      if (!overflow || !orderToggle) return;
      this.root.dataset.streamCardSettings = "true";
      let wrapper = this.tabs.querySelector("[data-stream-card-settings]");
      if (streamCardSettingsWrapperNeedsReplacement(this.wrapper, wrapper)) {
        wrapper?.remove();
        wrapper = this.createWrapper(overflow, orderToggle);
        this.wrapper = wrapper;
      }
      this.update(wrapper);
      this.alignOverflow();
    }

    createWrapper(overflow, orderToggle) {
      const wrapper = this.document.createElement("span");
      wrapper.className = "stream-card-settings";
      wrapper.dataset.streamCardSettings = "true";
      wrapper.innerHTML = `
        <button type="button" class="stream-card-settings-toggle" data-stream-card-settings-toggle
          aria-label="Настройки карточек потоков" aria-expanded="false" title="Настройки карточек потоков"></button>
        <div class="stream-card-settings-menu" data-stream-card-settings-menu role="dialog"
          aria-label="Настройки карточек потоков" hidden>
          <div class="stream-card-settings-section stream-card-settings-order-section">
            <span class="stream-card-settings-kicker">Порядок потоков</span>
            <span class="stream-card-settings-segmented" role="group" aria-label="Порядок потоков">
              <button type="button" data-stream-order-mode="activity" title="По последней активности">Авто</button>
              <button type="button" data-stream-order-mode="manual">Фикс</button>
            </span>
          </div>
          <div class="stream-card-settings-section">
            <span class="stream-card-settings-kicker">Ширина карточек потоков</span>
            <span class="stream-card-settings-segmented" role="group" aria-label="Режим ширины карточек потоков">
              <button type="button" data-stream-width-mode="auto" aria-pressed="true">Авто</button>
              <button type="button" data-stream-width-mode="fixed" aria-pressed="false">Фикс</button>
            </span>
            <label class="stream-card-settings-range" data-stream-card-range hidden>
              <span><span data-stream-card-width-value>${this.fixedWidth}</span> px</span>
              <input type="range" min="${STREAM_CARD_MIN_WIDTH}" max="${STREAM_CARD_MAX_WIDTH}" step="1"
                value="${this.fixedWidth}" data-stream-card-width aria-label="Ширина карточек потоков">
              <small>${STREAM_CARD_MIN_WIDTH} — ${STREAM_CARD_MAX_WIDTH} px</small>
            </label>
          </div>
          <div class="stream-card-settings-section stream-card-settings-gap-section">
            <span class="stream-card-settings-kicker">Отступ</span>
            <button type="button" class="stream-card-gap-toggle" role="switch" aria-checked="false"
              aria-label="Отступ между карточками потоков" data-stream-gap-toggle>
              <span class="switch-track" aria-hidden="true"></span>
            </button>
          </div>
        </div>`;
      const sourceIcon = this.document.querySelector(".view-settings svg");
      if (sourceIcon) {
        const icon = sourceIcon.cloneNode(true);
        icon.classList.add("stream-card-settings-icon");
        wrapper.querySelector("[data-stream-card-settings-toggle]").append(icon);
      }
      overflow.after(wrapper);
      const settingsButton = wrapper.querySelector("[data-stream-card-settings-toggle]");
      const settingsMenu = wrapper.querySelector("[data-stream-card-settings-menu]");
      settingsMenu.hidden = !this.open;
      settingsButton.setAttribute("aria-expanded", String(this.open));
      settingsButton.addEventListener("click", () => {
        this.open = settingsMenu.hidden;
        settingsMenu.hidden = !this.open;
        settingsButton.setAttribute("aria-expanded", String(this.open));
        if (this.open) this.update(wrapper);
      });
      wrapper.querySelectorAll("[data-stream-order-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          if (button.dataset.streamOrderMode !== this.orderMode()) orderToggle.click();
          this.window.setTimeout(() => this.schedule(), 0);
        });
      });
      wrapper.querySelectorAll("[data-stream-width-mode]").forEach((button) => {
        button.addEventListener("click", () => {
          const nextMode = button.dataset.streamWidthMode === STREAM_CARD_WIDTH_MODES.FIXED
            ? STREAM_CARD_WIDTH_MODES.FIXED
            : STREAM_CARD_WIDTH_MODES.AUTO;
          if (nextMode !== this.widthMode && nextMode === STREAM_CARD_WIDTH_MODES.AUTO) {
            this.autoWidths.clear();
          }
          this.widthMode = nextMode;
          this.emitSetting("streamCardWidthMode", this.widthMode);
          this.update(wrapper);
          this.refreshOverflow();
        });
      });
      wrapper.querySelector("[data-stream-gap-toggle]").addEventListener("click", () => {
        this.gapEnabled = !this.gapEnabled;
        this.emitSetting("streamCardGapEnabled", this.gapEnabled);
        this.update(wrapper);
        this.refreshOverflow();
      });
      const range = wrapper.querySelector("[data-stream-card-width]");
      range.addEventListener("input", (event) => {
        this.fixedWidth = Math.min(
          STREAM_CARD_MAX_WIDTH,
          Math.max(STREAM_CARD_MIN_WIDTH, Number(event.currentTarget.value) || STREAM_CARD_MIN_WIDTH),
        );
        setTextContentIfChanged(
          wrapper.querySelector("[data-stream-card-width-value]"),
          this.fixedWidth,
        );
        this.update(wrapper);
      });
      range.addEventListener("change", () => {
        this.emitSetting("streamCardFixedWidth", this.fixedWidth);
        this.refreshOverflow();
      });
      range.addEventListener("pointerup", () => this.refreshOverflow());
      return wrapper;
    }

    applySettings(value) {
      const settings = normalizeStreamCardSettings(value);
      if (settings.widthMode === STREAM_CARD_WIDTH_MODES.AUTO
        && this.widthMode !== STREAM_CARD_WIDTH_MODES.AUTO) this.autoWidths.clear();
      this.widthMode = settings.widthMode;
      this.fixedWidth = settings.fixedWidth;
      this.gapEnabled = settings.gapEnabled;
      if (this.wrapper?.isConnected) this.update(this.wrapper);
      else this.schedule();
      this.refreshOverflow();
      return settings;
    }

    emitSetting(key, value) {
      this.document.dispatchEvent(new this.window.CustomEvent(
        STREAM_CARD_SETTINGS_CHANGE_EVENT,
        { detail: { key, value } },
      ));
    }

    orderMode() {
      return this.tabs.dataset.orderMode === STREAM_ORDER_MODES.MANUAL
        ? STREAM_ORDER_MODES.MANUAL
        : STREAM_ORDER_MODES.ACTIVITY;
    }

    update(wrapper) {
      const orderMode = this.orderMode();
      wrapper.querySelectorAll("[data-stream-order-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.streamOrderMode === orderMode));
      });
      this.tabs.dataset.streamCardWidthMode = this.widthMode;
      if (this.widthMode === STREAM_CARD_WIDTH_MODES.FIXED) {
        this.tabs.style.setProperty("--stream-card-width", `${this.fixedWidth}px`);
      } else {
        this.tabs.style.removeProperty("--stream-card-width");
      }
      wrapper.querySelectorAll("[data-stream-width-mode]").forEach((button) => {
        button.setAttribute("aria-pressed", String(button.dataset.streamWidthMode === this.widthMode));
      });
      const range = wrapper.querySelector("[data-stream-card-width]");
      if (range) range.value = String(this.fixedWidth);
      const widthValue = wrapper.querySelector("[data-stream-card-width-value]");
      setTextContentIfChanged(widthValue, this.fixedWidth);
      this.tabs.dataset.streamCardGapMode = this.gapEnabled ? "on" : "off";
      wrapper.querySelector("[data-stream-gap-toggle]")
        ?.setAttribute("aria-checked", String(this.gapEnabled));
      const rangeWrap = wrapper.querySelector("[data-stream-card-range]");
      if (rangeWrap) rangeWrap.hidden = this.widthMode !== STREAM_CARD_WIDTH_MODES.FIXED;
      this.updateCardPresentation();
    }

    updateCardPresentation() {
      this.tabs.querySelectorAll(".stream-tab .task-time").forEach((time) => {
        const value = compactStreamActivityValue(time.textContent);
        if (value !== time.textContent.trim()) {
          if (!time.style.getPropertyValue("--stream-task-time-font-size")) {
            time.style.setProperty(
              "--stream-task-time-font-size",
              this.window.getComputedStyle(time).fontSize,
            );
          }
          time.dataset.compactStreamTime = value;
        } else {
          delete time.dataset.compactStreamTime;
        }
      });
      this.tabs.querySelectorAll(".stream-tab").forEach((tab) => {
        const streamId = tab.dataset.streamTabId;
        if (this.widthMode === STREAM_CARD_WIDTH_MODES.FIXED) {
          const width = `${this.fixedWidth}px`;
          tab.style.setProperty("box-sizing", "border-box", "important");
          tab.style.setProperty("flex", `0 0 ${width}`, "important");
          tab.style.setProperty("max-width", width, "important");
          tab.style.setProperty("min-width", width, "important");
          tab.style.setProperty("padding-inline", "0.5rem", "important");
          tab.style.setProperty("width", width, "important");
        } else {
          const stableWidth = resolveStableStreamCardWidth(this.autoWidths, streamId);
          if (stableWidth > 0) {
            const width = `${stableWidth}px`;
            tab.style.setProperty("box-sizing", "border-box", "important");
            tab.style.setProperty("flex", `0 0 ${width}`, "important");
            tab.style.setProperty("max-width", width, "important");
            tab.style.setProperty("min-width", width, "important");
            tab.style.removeProperty("padding-inline");
            tab.style.setProperty("width", width, "important");
          } else {
            for (const property of [
              "box-sizing",
              "flex",
              "max-width",
              "min-width",
              "padding-inline",
              "width",
            ]) tab.style.removeProperty(property);
          }
        }
      });
      this.window.requestAnimationFrame(() => {
        this.tabs.querySelectorAll(".stream-tab").forEach((tab) => {
          if (this.widthMode === STREAM_CARD_WIDTH_MODES.AUTO) {
            const width = resolveStableStreamCardWidth(
              this.autoWidths,
              tab.dataset.streamTabId,
              tab.getBoundingClientRect().width,
            );
            if (width > 0) {
              tab.style.setProperty("box-sizing", "border-box", "important");
              tab.style.setProperty("flex", `0 0 ${width}px`, "important");
              tab.style.setProperty("max-width", `${width}px`, "important");
              tab.style.setProperty("min-width", `${width}px`, "important");
              tab.style.setProperty("width", `${width}px`, "important");
            }
          }
          const title = tab.querySelector(".stream-tab-title");
          if (!title) return;
          if (title.scrollWidth > title.clientWidth) {
            title.title = tab.dataset.streamName || title.textContent.trim();
          } else {
            title.removeAttribute("title");
          }
        });
      });
    }

    refreshOverflow() {
      this.window.requestAnimationFrame(() => {
        this.window.dispatchEvent(new this.window.Event("resize"));
      });
    }

    alignOverflow() {
      const visibleTabs = [...this.tabs.querySelectorAll(".stream-tabs-track .stream-tab")]
        .filter((tab) => tab.getBoundingClientRect().width > 0);
      const lastVisible = visibleTabs.at(-1);
      const moreButton = this.tabs.querySelector(".stream-tabs-more");
      if (!lastVisible || !moreButton || moreButton.getBoundingClientRect().width === 0) {
        this.tabs.style.removeProperty("--stream-overflow-shift");
        return;
      }
      const currentShift = Number.parseFloat(
        this.tabs.style.getPropertyValue("--stream-overflow-shift") || "0",
      ) || 0;
      const shift = calculateOverflowShift(
        moreButton.getBoundingClientRect().left,
        lastVisible.getBoundingClientRect().right,
        currentShift,
      );
      const value = `${shift}px`;
      if (this.tabs.style.getPropertyValue("--stream-overflow-shift") !== value) {
        this.tabs.style.setProperty("--stream-overflow-shift", value);
      }
    }

    close(wrapper) {
      const button = wrapper?.querySelector("[data-stream-card-settings-toggle]");
      const menu = wrapper?.querySelector("[data-stream-card-settings-menu]");
      if (!button || !menu) return;
      this.open = false;
      button.setAttribute("aria-expanded", "false");
      menu.hidden = true;
    }
  }

  let installedStreamCardSettings = null;

  function installStreamCardSettings(documentRef, windowRef) {
    installedStreamCardSettings = new StreamCardSettingsController(documentRef, windowRef);
    return installedStreamCardSettings;
  }

  function applyStreamCardSettings(settings) {
    const normalized = normalizeStreamCardSettings(settings);
    installedStreamCardSettings?.applySettings(normalized);
    return normalized;
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
    STREAM_CARD_MAX_WIDTH,
    STREAM_CARD_MIN_WIDTH,
    STREAM_CARD_SETTINGS_CHANGE_EVENT,
    STREAM_CARD_WIDTH_MODES,
    streamCardSettingsAvailable,
    streamCardSettingsWrapperNeedsReplacement,
    setTextContentIfChanged,
    STREAM_ORDER_MODES,
    calculateOverflowShift,
    compactStreamActivityValue,
    applyStreamCardSettings,
    installStreamCardSettings,
    normalizeStreamActivityDirection,
    normalizeStreamCardSettings,
    normalizeStreamOrderMode,
    applyOpenStreamSelection,
    orderWorkspaceStreams,
    reconcileOpenStreamIds,
    resolveStableStreamCardWidth,
    streamCreationSide,
    streamDeckRenderKey,
    streamLastActivity,
    streamStatusPresentation,
    streamStatusState,
    streamsAreDraggable,
    taskListSections,
  });

  if (typeof document !== "undefined") {
    const start = () => installStreamCardSettings(document, window);
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
})();
