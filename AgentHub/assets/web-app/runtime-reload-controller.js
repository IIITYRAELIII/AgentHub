(() => {
  "use strict";

  const DEFAULT_RETRY_DELAY_MS = 500;

  function runtimeReloadBlocked({
    draftsPersisted = true,
    drafts = [],
    modalOpen = false,
    requestPending = false,
    bugReportAttachments = [],
    bugReportSending = false,
  } = {}) {
    // Text and annotations are persisted synchronously before this check and
    // survive a runtime cutover. Only state that cannot be restored safely is
    // allowed to keep an old client shell alive.
    return draftsPersisted !== true
      || Boolean(modalOpen)
      || Boolean(requestPending)
      || [...drafts].some((draft) => (draft?.attachments ?? []).length > 0)
      || bugReportAttachments.length > 0
      || Boolean(bugReportSending);
  }

  function runtimeIdentityTransition(previous, current) {
    const previousInstanceId = String(previous?.instanceId ?? "").trim();
    const previousReleaseId = String(previous?.releaseId ?? "").trim();
    const currentInstanceId = String(current?.instanceId ?? "").trim();
    const currentReleaseId = String(current?.releaseId ?? "").trim();
    if (!previousInstanceId || !previousReleaseId || !currentInstanceId || !currentReleaseId) {
      return { instanceChanged: false, releaseChanged: false, reloadRequired: false };
    }
    const instanceChanged = previousInstanceId !== currentInstanceId;
    const releaseChanged = previousReleaseId !== currentReleaseId;
    return {
      instanceChanged,
      releaseChanged,
      reloadRequired: instanceChanged || releaseChanged,
    };
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
    runtimeIdentityTransition,
    runtimeReloadBlocked,
  });
})();
