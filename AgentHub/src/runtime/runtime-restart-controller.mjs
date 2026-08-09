// Coordinates one safe runtime replacement without owning process transport.
function lifecycleFailure(phase, result) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  const errors = failures.map((failure) => failure?.error instanceof Error
    ? failure.error
    : new Error(String(failure?.error ?? failure?.name ?? `${phase} failed`)));
  const error = new AggregateError(errors, `Restart ${phase} failed`);
  error.failures = failures;
  return error;
}

export class RuntimeRestartController {
  constructor({
    getRequest,
    updateOffset,
    hasBlockingWork,
    setWaiting,
    updateMessage,
    saveState,
    resources,
    beginStopping,
    stopTimers,
    stopMedia,
    launchReplacement,
    recoverPrevious,
    abortRestart,
    finishSuccessfulReplacement,
    isStopping = () => false,
    logger = console,
  } = {}) {
    for (const [name, value] of Object.entries({
      getRequest, updateOffset, hasBlockingWork, setWaiting, updateMessage, saveState,
      beginStopping, stopTimers, stopMedia, launchReplacement, recoverPrevious,
      abortRestart, finishSuccessfulReplacement,
    })) {
      if (typeof value !== "function") throw new TypeError(`${name} is required`);
    }
    if (!resources) throw new TypeError("resources is required");
    Object.assign(this, {
      getRequest, updateOffset, hasBlockingWork, setWaiting, updateMessage, saveState,
      resources, beginStopping, stopTimers, stopMedia, launchReplacement,
      recoverPrevious, abortRestart, finishSuccessfulReplacement, isStopping, logger,
    });
  }

  async perform() {
    const request = this.getRequest();
    if (this.isStopping() || !request) return { status: "ignored" };
    if (this.updateOffset() < Number(request.minimumUpdateOffset ?? 0)) {
      return { status: "waiting-for-update" };
    }
    if (this.hasBlockingWork()) {
      this.setWaiting(true);
      return { status: "waiting-for-work" };
    }

    this.setWaiting(false);
    if (!this.beginStopping()) return { status: "ignored" };
    await this.updateMessage("🔄 Перезапускаю Agent Hub…").catch(() => {});
    try {
      await this.saveState();
      const flush = await this.resources.flush({ label: "Restart flush failed" });
      if (flush?.ok === false) throw lifecycleFailure("flush", flush);
    } catch (error) {
      this.logger.error("Cannot prepare runtime restart:", error.message);
      let abortError = null;
      try {
        await this.abortRestart(error);
      } catch (recoveryError) {
        abortError = recoveryError;
        this.logger.error("Cannot persist aborted restart state:", recoveryError.message);
      }
      return { status: "aborted", phase: "flush", error, ...(abortError ? { abortError } : {}) };
    }

    this.stopTimers();
    this.stopMedia();
    try {
      const suspend = await this.resources.suspend({ label: "Restart close failed" });
      if (suspend?.ok === false) throw lifecycleFailure("suspend", suspend);
    } catch (error) {
      return this.#recover(error, "suspend");
    }

    try {
      const replacement = await this.launchReplacement();
      this.logger.log(
        `Replacement bot ready: PID ${replacement.lock.pid}; attempt ${replacement.attempt}`
          + `${replacement.usedFallback ? " (direct launcher fallback)" : ""}.`,
      );
    } catch (error) {
      return this.#recover(error, "launch");
    }

    await this.resources.finalize({ label: "Restart finalize failed" });
    await this.finishSuccessfulReplacement();
    return { status: "replaced" };
  }

  async #recover(error, phase) {
    this.logger.error(`Cannot complete runtime restart ${phase}:`, error.message);
    try {
      await this.recoverPrevious(error);
      return { status: "recovered", phase, error };
    } catch (restoreError) {
      this.logger.error("Cannot restore the previous bot after failed restart:", restoreError.message);
      return { status: "failed", phase, error, restoreError };
    }
  }
}
