(() => {
  "use strict";

  const DEFAULT_BOTTOM_THRESHOLD_PX = 24;
  const DEFAULT_ANIMATION_DURATION_MS = 260;

  function distanceFromBottom(scroll) {
    return Math.max(0, Number(scroll?.scrollHeight) - Number(scroll?.scrollTop) - Number(scroll?.clientHeight));
  }

  function shouldLoadOlderPage(scroll, pagination) {
    return pagination?.hasOlder === true
      && pagination?.loading !== true
      && Number(scroll?.scrollHeight) <= Number(scroll?.clientHeight) + 1;
  }

  class ChatScrollController {
    constructor(scroll, button, options = {}) {
      if (!scroll) throw new TypeError("scroll is required");
      this.scroll = scroll;
      this.button = button ?? null;
      this.threshold = Number(options.thresholdPx) || DEFAULT_BOTTOM_THRESHOLD_PX;
      this.duration = Number(options.animationDurationMs) || DEFAULT_ANIMATION_DURATION_MS;
      this.requestFrame = options.requestAnimationFrame ?? window.requestAnimationFrame.bind(window);
      this.cancelFrame = options.cancelAnimationFrame ?? window.cancelAnimationFrame.bind(window);
      this.reducedMotion = options.reducedMotion ?? (() => (
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
      ));
      this.ResizeObserver = options.ResizeObserver ?? window.ResizeObserver;
      this.animationFrame = 0;
      this.animationGeneration = 0;
      this.pinned = this.isNearBottom();
      this.lastDistance = distanceFromBottom(scroll);
      this.listeners = [];
      this.bind(scroll, "scroll", () => this.handleScroll(), { passive: true });
      for (const type of ["wheel", "touchstart", "pointerdown"]) {
        this.bind(scroll, type, () => this.noteUserIntent(), { passive: true });
      }
      this.bind(scroll, "keydown", (event) => {
        if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) {
          this.noteUserIntent();
        }
      });
      if (this.button) this.bind(this.button, "click", () => this.scrollToBottom({ animate: true }));
      this.resizeObserver = typeof this.ResizeObserver === "function"
        ? new this.ResizeObserver(() => this.handleResize())
        : null;
      this.resizeObserver?.observe(scroll);
      this.requestFrame(() => this.sync());
    }

    bind(target, type, listener, options) {
      target.addEventListener(type, listener, options);
      this.listeners.push({ target, type, listener, options });
    }

    isNearBottom() {
      return distanceFromBottom(this.scroll) <= this.threshold;
    }

    capture() {
      return {
        distance: distanceFromBottom(this.scroll),
        pinned: this.pinned || this.isNearBottom(),
      };
    }

    sync() {
      const nearBottom = this.isNearBottom();
      if (nearBottom) this.pinned = true;
      this.lastDistance = distanceFromBottom(this.scroll);
      if (this.button) this.button.hidden = nearBottom;
    }

    noteUserIntent() {
      this.animationGeneration += 1;
      if (this.animationFrame) this.cancelFrame(this.animationFrame);
      this.animationFrame = 0;
      this.pinned = false;
    }

    handleScroll() {
      this.pinned = this.isNearBottom();
      this.sync();
    }

    handleResize() {
      if (this.pinned) this.pinNow();
      else this.sync();
    }

    pinNow() {
      this.animationGeneration += 1;
      if (this.animationFrame) this.cancelFrame(this.animationFrame);
      this.animationFrame = 0;
      this.scroll.scrollTop = this.scroll.scrollHeight;
      this.pinned = true;
      this.sync();
    }

    afterMutation(snapshot, { preserveDistance = false } = {}) {
      if (snapshot?.pinned) {
        this.pinNow();
        return;
      }
      if (preserveDistance && Number.isFinite(Number(snapshot?.distance))) {
        this.scroll.scrollTop = Math.max(
          0,
          this.scroll.scrollHeight - this.scroll.clientHeight - Number(snapshot.distance),
        );
      }
      this.pinned = false;
      this.sync();
    }

    scrollToBottom({ animate = true } = {}) {
      const start = Number(this.scroll.scrollTop) || 0;
      const target = Math.max(0, this.scroll.scrollHeight - this.scroll.clientHeight);
      if (!animate || this.reducedMotion() || Math.abs(target - start) < 2) {
        this.pinNow();
        return;
      }
      this.noteUserIntent();
      const generation = ++this.animationGeneration;
      let startedAt = null;
      const step = (timestamp) => {
        if (generation !== this.animationGeneration) return;
        startedAt ??= timestamp;
        const progress = Math.min(1, (timestamp - startedAt) / this.duration);
        const eased = 1 - ((1 - progress) ** 3);
        this.scroll.scrollTop = start + ((target - start) * eased);
        if (progress < 1) {
          this.animationFrame = this.requestFrame(step);
          return;
        }
        this.animationFrame = 0;
        this.pinned = true;
        this.sync();
      };
      this.animationFrame = this.requestFrame(step);
    }

    destroy() {
      this.noteUserIntent();
      this.resizeObserver?.disconnect();
      for (const { target, type, listener, options } of this.listeners) {
        target.removeEventListener(type, listener, options);
      }
      this.listeners = [];
    }
  }

  window.AgentHubChatScroll = Object.freeze({
    ChatScrollController,
    DEFAULT_BOTTOM_THRESHOLD_PX,
    distanceFromBottom,
    shouldLoadOlderPage,
  });
})();
