export class TaskProgressController {
  constructor({
    isCurrentRun,
    render,
    sendInitial,
    deleteMessage,
    removeBindings,
    editMessage,
    persist,
    retainAfterEditError,
    onChange = () => {},
    onWarning = (message, error) => console.warn(message, error?.message ?? error),
    onError = (message, error) => console.error(message, error?.message ?? error),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    updateDelayMs = 1_500,
  }) {
    this.isCurrentRun = isCurrentRun;
    this.render = render;
    this.sendInitial = sendInitial;
    this.deleteMessage = deleteMessage;
    this.removeBindings = removeBindings;
    this.editMessage = editMessage;
    this.persist = persist;
    this.retainAfterEditError = retainAfterEditError;
    this.onChange = onChange;
    this.onWarning = onWarning;
    this.onError = onError;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.delay = delay;
    this.updateDelayMs = updateDelayMs;
  }

  scheduleStart(run, delayMs) {
    this.cancelStart(run);
    run.progressStartTimer = this.setTimeoutImpl(() => {
      run.progressStartTimer = null;
      void this.start(run);
    }, delayMs);
  }

  async start(run, { forceNew = false } = {}) {
    if (!run || run.status !== "running" || (!forceNew && run.progressMessageIds.length)) return;
    if (run.observer) {
      run.displayRequested = true;
      run.telegramDeliveryRequested = true;
    }
    const text = this.render(run);
    const message = await this.sendInitial(run, text);
    if (!this.isCurrentRun(run) || run.status !== "running") {
      if (message?.message_id) await this.deleteMessage(run, message.message_id).catch(() => {});
      return;
    }
    if (Number.isSafeInteger(message?.message_id)) run.progressMessageIds.push(message.message_id);
    run.lastProgressText = text;
    await this.persist();
  }

  async clear(run) {
    if (!run) return;
    while (run.progressUpdateInFlight) await this.delay(50);
    const previousIds = [...run.progressMessageIds];
    run.progressMessageIds = [];
    run.lastProgressText = "";
    for (const messageId of previousIds) {
      await this.deleteMessage(run, messageId).catch((error) => {
        this.onWarning(`Cannot remove old progress message ${messageId}:`, error);
      });
    }
    if (previousIds.length) await this.removeBindings(run, previousIds);
  }

  async replace(run) {
    await this.clear(run);
    await this.start(run, { forceNew: true });
  }

  setStage(run, stage) {
    if (!run) return;
    const value = String(stage ?? "").trim();
    if (value && value !== run.progressStage) {
      run.progressStage = value;
      this.noteActivity(run);
    }
    this.schedule(run);
  }

  appendReasoning(run, delta) {
    if (!run) return;
    const value = String(delta ?? "");
    run.progressReasoning += value;
    if (run.progressReasoning.length > 5_000) run.progressReasoning = run.progressReasoning.slice(-5_000);
    if (value) this.noteActivity(run);
    this.schedule(run);
  }

  noteActivity(run, value = Date.now()) {
    if (!run) return;
    const timestamp = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(timestamp)) return;
    const previous = Date.parse(String(run.lastMeaningfulProgressAt ?? ""));
    if (!Number.isFinite(previous) || timestamp > previous) {
      run.lastMeaningfulProgressAt = new Date(timestamp).toISOString();
      this.onChange(run);
    }
  }

  heartbeatState(run, now = Date.now(), stalledAfterMs) {
    const lastActivity = Date.parse(String(run?.lastMeaningfulProgressAt ?? run?.startedAt ?? ""));
    return Number.isFinite(lastActivity) && now - lastActivity >= stalledAfterMs ? "stalled" : "active";
  }

  schedule(run, delayMs = this.updateDelayMs) {
    if (!run?.progressMessageIds.length || run.progressTimer) return;
    run.progressTimer = this.setTimeoutImpl(() => {
      run.progressTimer = null;
      void this.flush(run);
    }, delayMs);
  }

  async flush(run, done = false) {
    if (!run?.progressMessageIds.length) return;
    if (run.progressUpdateInFlight) {
      run.progressUpdatePending = true;
      return;
    }
    const text = this.render(run, done);
    if (text === run.lastProgressText) return;
    run.progressUpdateInFlight = true;
    let retryNeeded = false;
    try {
      const retained = [];
      for (const messageId of run.progressMessageIds) {
        try {
          await this.editMessage(run, messageId, text);
          retained.push(messageId);
        } catch (error) {
          if (this.retainAfterEditError(error)) {
            retained.push(messageId);
            if (error?.retryable === true) retryNeeded = true;
          } else {
            this.onError(`Cannot update task progress message ${messageId}:`, error);
          }
        }
      }
      run.progressMessageIds = retained;
      if (!retryNeeded && retained.length) run.lastProgressText = text;
      await this.persist();
    } finally {
      run.progressUpdateInFlight = false;
      if (run.progressUpdatePending) {
        run.progressUpdatePending = false;
        this.schedule(run, 0);
      }
    }
    if (retryNeeded) this.schedule(run);
  }

  async finish(run, stage) {
    if (!run) return;
    const completedMessageIds = [...run.progressMessageIds ?? []];
    run.finishedProgressMessageIds = [...new Set([
      ...(run.finishedProgressMessageIds ?? []),
      ...completedMessageIds,
    ])];
    run.status = "finishing";
    this.cancelStart(run);
    this.cancelUpdate(run);
    run.progressStage = stage;
    this.onChange(run);
    if (!run.progressMessageIds.length) {
      run.progressReasoning = "";
      run.lastProgressText = "";
      return;
    }
    while (run.progressUpdateInFlight) await this.delay(50);
    await this.flush(run, true);
    run.progressMessageIds = [];
    run.progressReasoning = "";
    run.lastProgressText = "";
  }

  pause(run) {
    this.cancelStart(run);
    this.cancelUpdate(run);
  }

  cancelStart(run) {
    if (!run?.progressStartTimer) return;
    this.clearTimeoutImpl(run.progressStartTimer);
    run.progressStartTimer = null;
  }

  cancelUpdate(run) {
    if (!run?.progressTimer) return;
    this.clearTimeoutImpl(run.progressTimer);
    run.progressTimer = null;
  }
}
