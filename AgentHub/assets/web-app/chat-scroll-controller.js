(() => {
  "use strict";

  const DEFAULT_BOTTOM_THRESHOLD_PX = 24;
  const DEFAULT_TOP_THRESHOLD_PX = 64;
  const DEFAULT_ANIMATION_DURATION_MS = 260;

  function distanceFromBottom(scroll) {
    return Math.max(0, Number(scroll?.scrollHeight) - Number(scroll?.scrollTop) - Number(scroll?.clientHeight));
  }

  function shouldLoadOlderPage(scroll, pagination) {
    return pagination?.hasOlder === true
      && pagination?.loading !== true
      && Number(scroll?.clientHeight) > 0
      && Number(scroll?.scrollHeight) <= Number(scroll?.clientHeight) + 1;
  }

  class ChatScrollController {
    constructor(scroll, button, options = {}) {
      if (!scroll) throw new TypeError("scroll is required");
      this.scroll = scroll;
      this.button = button ?? null;
      this.threshold = Number(options.thresholdPx) || DEFAULT_BOTTOM_THRESHOLD_PX;
      this.duration = Number(options.animationDurationMs) || DEFAULT_ANIMATION_DURATION_MS;
      this.topThreshold = Number(options.topThresholdPx) || DEFAULT_TOP_THRESHOLD_PX;
      this.onNearTop = typeof options.onNearTop === "function" ? options.onNearTop : null;
      this.onReturnBottom = typeof options.onReturnBottom === "function" ? options.onReturnBottom : null;
      this.requestFrame = options.requestAnimationFrame ?? window.requestAnimationFrame.bind(window);
      this.cancelFrame = options.cancelAnimationFrame ?? window.cancelAnimationFrame.bind(window);
      this.reducedMotion = options.reducedMotion ?? (() => (
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
      ));
      this.ResizeObserver = options.ResizeObserver ?? window.ResizeObserver;
      this.animationFrame = 0;
      this.animationGeneration = 0;
      this.exactNavigationGeneration = 0;
      this.exactNavigationActive = false;
      this.working = false;
      this.unreadCount = 0;
      this.pinned = this.isNearBottom();
      this.lastDistance = distanceFromBottom(scroll);
      this.lastScrollHeight = Number(scroll.scrollHeight) || 0;
      this.nearTopPending = false;
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
      if (this.button) this.bind(this.button, "click", () => {
        this.onReturnBottom?.();
        this.scrollToBottom({ animate: true });
      });
      this.resizeObserver = typeof this.ResizeObserver === "function"
        ? new this.ResizeObserver(() => this.handleResize())
        : null;
      this.resizeObserver?.observe(scroll);
      if (scroll.firstElementChild) this.resizeObserver?.observe(scroll.firstElementChild);
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
      if (nearBottom) {
        this.pinned = true;
        this.unreadCount = 0;
      }
      this.lastDistance = distanceFromBottom(this.scroll);
      this.updateButton(nearBottom);
      this.maybeLoadOlder();
    }

    updateButton(nearBottom = this.isNearBottom()) {
      if (!this.button) return;
      this.button.hidden = nearBottom && !this.working;
      this.button.toggleAttribute?.("data-working", this.working);
      this.button.toggleAttribute?.("data-has-unread", this.unreadCount > 0);
      if (this.button.dataset) this.button.dataset.unreadCount = String(this.unreadCount);
      const label = this.button.querySelector?.(".chat-scroll-label");
      if (label) label.textContent = this.working ? "Ход идёт" : "Вниз";
      const counter = this.button.querySelector?.(".chat-scroll-count");
      if (counter) {
        counter.hidden = this.unreadCount <= 0;
        counter.textContent = this.unreadCount > 99 ? "99+" : String(this.unreadCount);
      }
    }

    setWorking(value) {
      this.working = Boolean(value);
      this.updateButton();
    }

    addUnread(count = 1) {
      const value = Math.max(0, Math.trunc(Number(count) || 0));
      if (!value || this.isNearBottom()) return;
      this.unreadCount = Math.min(99, this.unreadCount + value);
      this.lastScrollHeight = Number(this.scroll.scrollHeight) || 0;
      this.updateButton(false);
    }

    maybeLoadOlder() {
      if (!this.onNearTop || this.nearTopPending || Number(this.scroll.scrollTop) > this.topThreshold) return;
      this.nearTopPending = true;
      Promise.resolve(this.onNearTop()).catch(() => {}).finally(() => {
        this.nearTopPending = false;
      });
    }

    noteUserIntent() {
      this.animationGeneration += 1;
      if (this.animationFrame) this.cancelFrame(this.animationFrame);
      this.animationFrame = 0;
      this.pinned = false;
    }

    syncExactNavigation() {
      this.pinned = false;
      this.lastDistance = distanceFromBottom(this.scroll);
      this.lastScrollHeight = Number(this.scroll.scrollHeight) || 0;
      this.updateButton(this.isNearBottom());
    }

    beginExactNavigation() {
      this.noteUserIntent();
      this.exactNavigationActive = true;
      return ++this.exactNavigationGeneration;
    }

    completeExactNavigation(generation) {
      if (generation !== this.exactNavigationGeneration) return;
      this.syncExactNavigation();
      let remainingFrames = 2;
      const settle = () => {
        if (generation !== this.exactNavigationGeneration) return;
        this.syncExactNavigation();
        remainingFrames -= 1;
        if (remainingFrames > 0) {
          this.requestFrame(settle);
          return;
        }
        this.exactNavigationActive = false;
        this.sync();
      };
      this.requestFrame(settle);
    }

    handleScroll() {
      if (this.exactNavigationActive) {
        this.syncExactNavigation();
        return;
      }
      this.pinned = this.isNearBottom();
      this.sync();
    }

    handleResize() {
      const nextHeight = Number(this.scroll.scrollHeight) || 0;
      if (this.exactNavigationActive) {
        this.syncExactNavigation();
        return;
      }
      if (this.pinned) this.pinNow();
      else if (nextHeight !== this.lastScrollHeight) {
        this.scroll.scrollTop = Math.max(0, nextHeight - this.scroll.clientHeight - this.lastDistance);
        this.sync();
      } else this.sync();
      this.lastScrollHeight = nextHeight;
    }

    pinNow() {
      this.animationGeneration += 1;
      if (this.animationFrame) this.cancelFrame(this.animationFrame);
      this.animationFrame = 0;
      this.scroll.scrollTop = this.scroll.scrollHeight;
      this.lastScrollHeight = Number(this.scroll.scrollHeight) || 0;
      this.unreadCount = 0;
      this.pinned = true;
      this.sync();
    }

    afterMutation(snapshot, { preserveDistance = false, newItemsCount = 0 } = {}) {
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
      this.lastScrollHeight = Number(this.scroll.scrollHeight) || 0;
      this.addUnread(newItemsCount);
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
    DEFAULT_TOP_THRESHOLD_PX,
    distanceFromBottom,
    shouldLoadOlderPage,
  });
})();
