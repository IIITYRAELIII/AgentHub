(() => {
  "use strict";

  const DEFAULT_RETRY_DELAY_MS = 500;

  function runtimeReloadBlocked({
    currentDraft = {},
    drafts = [],
    modalOpen = false,
    requestPending = false,
    bugReportAttachments = [],
    bugReportSending = false,
  } = {}) {
    const currentDraftActive = Boolean(
      String(currentDraft?.text ?? "").trim()
      || (currentDraft?.attachments ?? []).length
      || (currentDraft?.annotations ?? []).length,
    );
    return currentDraftActive
      || Boolean(modalOpen)
      || Boolean(requestPending)
      || [...drafts].some((draft) => (draft?.attachments ?? []).length > 0)
      || bugReportAttachments.length > 0
      || Boolean(bugReportSending);
  }

  class RuntimeReloadController {
    constructor({
      prepare,
      apply,
      onDeferred = () => {},
      setTimer = window.setTimeout.bind(window),
      clearTimer = window.clearTimeout.bind(window),
      retryDelayMs = DEFAULT_RETRY_DELAY_MS,
    }) {
      if (typeof prepare !== "function") throw new TypeError("prepare is required");
      if (typeof apply !== "function") throw new TypeError("apply is required");
      this.prepare = prepare;
      this.apply = apply;
      this.onDeferred = onDeferred;
      this.setTimer = setTimer;
      this.clearTimer = clearTimer;
      this.retryDelayMs = Math.max(50, Number(retryDelayMs) || DEFAULT_RETRY_DELAY_MS);
      this.pending = false;
      this.deferredNotified = false;
      this.timer = null;
    }

    request() {
      this.pending = true;
      return this.attempt();
    }

    attempt() {
      if (!this.pending) return false;
      if (this.prepare() === false) {
        if (!this.deferredNotified) {
          this.deferredNotified = true;
          this.onDeferred();
        }
        this.scheduleRetry();
        return false;
      }
      this.pending = false;
      this.deferredNotified = false;
      if (this.timer != null) this.clearTimer(this.timer);
      this.timer = null;
      this.apply();
      return true;
    }

    scheduleRetry() {
      if (this.timer != null) return;
      this.timer = this.setTimer(() => {
        this.timer = null;
        this.attempt();
      }, this.retryDelayMs);
    }
  }

  window.AgentHubRuntimeReload = Object.freeze({
    DEFAULT_RETRY_DELAY_MS,
    RuntimeReloadController,
    runtimeReloadBlocked,
  });
})();
