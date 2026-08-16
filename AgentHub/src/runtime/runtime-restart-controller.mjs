// Coordinates one safe runtime replacement without owning process transport.
function lifecycleFailure(phase, result) {
  const failures = Array.isArray(result?.failures) ? result.failures : [];
  const errors = failures.map((failure) => failure?.error instanceof Error
    ? failure.error
    : new Error(String(failure?.error ?? failure?.name ?? `${phase} failed`)));
  const error = new AggregateError(errors, `Restart ${phase} failed`);
  error.failures = failures;
  error.phase = phase;
  return error;
}

function failed(result) {
  return result?.ok === false;
}

function timedOut(error) {
  return Array.isArray(error?.failures)
    && error.failures.some((failure) => failure?.error?.name === "LifecycleOperationTimeoutError");
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
    resumeAfterAbort = () => {},
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
      resources, beginStopping, stopTimers, stopMedia, resumeAfterAbort, launchReplacement,
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
      const quiesce = await this.resources.quiesce({
        label: "Restart quiesce failed",
        timeoutMs: 60_000,
      });
      if (failed(quiesce)) throw lifecycleFailure("quiesce", quiesce);
    } catch (error) {
      if (timedOut(error)) return this.#halt(error, error?.phase ?? "quiesce");
      return this.#abort(error, error?.phase ?? "quiesce", false);
    }

    this.stopTimers();
    this.stopMedia();
    try {
      await this.saveState();
      const drain = await this.resources.drain({ label: "Restart drain failed" });
      if (failed(drain)) throw lifecycleFailure("drain", drain);
    } catch (error) {
      if (timedOut(error)) return this.#halt(error, error?.phase ?? "prepare");
      return this.#abort(error, error?.phase ?? "prepare", true);
    }

    let lockReleased = false;
    try {
      const close = await this.resources.close({ label: "Restart close failed" });
      if (failed(close)) throw lifecycleFailure("close", close);
      const release = await this.resources.releaseLock({ label: "Restart lock release failed" });
      if (failed(release)) throw lifecycleFailure("releaseLock", release);
      lockReleased = true;
    } catch (error) {
      if (timedOut(error)) return this.#halt(error, error?.phase ?? "close");
      return this.#recover(error, error?.phase ?? "close", { lockReleased });
    }

    try {
      const replacement = await this.launchReplacement();
      this.logger.log(
        `Replacement bot ready: PID ${replacement.lock.pid}; attempt ${replacement.attempt}`
          + `${replacement.usedFallback ? " (direct launcher fallback)" : ""}.`,
      );
    } catch (error) {
      if (error?.replacementCleanup?.confirmed === false) {
        return this.#halt(error, "launch cleanup");
      }
      return this.#recover(error, "launch", { lockReleased: true });
    }

    await this.resources.finalize({ label: "Restart finalize failed" });
    await this.finishSuccessfulReplacement();
    return { status: "replaced" };
  }

  async #abort(error, phase, resumeRuntime) {
    this.logger.error("Cannot prepare runtime restart:", error.message);
    let abortError = null;
    try {
      await this.abortRestart(error);
    } catch (recoveryError) {
      abortError = recoveryError;
      this.logger.error("Cannot persist aborted restart state:", recoveryError.message);
    }
    try {
      if (resumeRuntime) await this.resumeAfterAbort();
      const recover = await this.resources.recover({ label: "Restart polling recovery failed" });
      if (failed(recover)) throw lifecycleFailure("recover", recover);
    } catch (recoveryError) {
      abortError ??= recoveryError;
      this.logger.error("Cannot resume aborted restart:", recoveryError.message);
    }
    return { status: "aborted", phase, error, ...(abortError ? { abortError } : {}) };
  }

  #halt(error, phase) {
    this.logger.error(`Runtime restart halted after ${phase} timeout; the instance lock remains held.`);
    return { status: "failed", phase, error };
  }

  async #recover(error, phase, { lockReleased }) {
    this.logger.error(`Cannot complete runtime restart ${phase}:`, error.message);
    try {
      await this.recoverPrevious(error, { lockReleased });
      const recover = await this.resources.recover({ label: "Restart polling recovery failed" });
      if (failed(recover)) throw lifecycleFailure("recover", recover);
      return { status: "recovered", phase, error };
    } catch (restoreError) {
      this.logger.error("Cannot restore the previous bot after failed restart:", restoreError.message);
      return { status: "failed", phase, error, restoreError };
    }
  }
}
