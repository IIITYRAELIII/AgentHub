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
  #inFlight = null;

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
    measure = (_id, _stage, action) => action(),
    captureException = () => false,
    packageHandoff = null,
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
      captureException, measure, packageHandoff,
    });
  }

  perform() {
    if (!this.#inFlight) {
      this.#inFlight = this.#perform().finally(() => { this.#inFlight = null; });
    }
    return this.#inFlight;
  }

  async #perform() {
    const request = this.getRequest();
    const measure = (stage, action) => this.measure(request?.operationId, stage, action);
    if (this.isStopping() || !request) return { status: "ignored" };
    if (this.updateOffset() < Number(request.minimumUpdateOffset ?? 0)) {
      return { status: "waiting-for-update" };
    }
    if (this.hasBlockingWork()) {
      try {
        if (await this.setWaiting(true) === false) return { status: "ignored" };
      } catch (error) {
        return this.#abort(error, "waiting", false);
      }
      return { status: "waiting-for-work" };
    }

    if (!this.beginStopping()) return { status: "ignored" };
    try {
      if (await this.setWaiting(false) === false) {
        throw new Error("Restart operation no longer permits cutover");
      }
    } catch (error) {
      return this.#abort(error, "cutover-state", false);
    }
    await this.updateMessage("🔄 Перезапускаю Agent Hub…").catch(() => {});
    try {
      const quiesce = await measure("quiesce", () => this.resources.quiesce({
        label: "Restart quiesce failed",
        timeoutMs: 60_000,
      }));
      if (failed(quiesce)) throw lifecycleFailure("quiesce", quiesce);
    } catch (error) {
      if (timedOut(error)) return this.#halt(error, error?.phase ?? "quiesce");
      return this.#abort(error, error?.phase ?? "quiesce", false);
    }

    this.stopTimers();
    this.stopMedia();
    try {
      await measure("save-state", () => this.saveState());
      const drain = await measure("drain", () => this.resources.drain({ label: "Restart drain failed" }));
      if (failed(drain)) throw lifecycleFailure("drain", drain);
    } catch (error) {
      if (timedOut(error)) return this.#halt(error, error?.phase ?? "prepare");
      return this.#abort(error, error?.phase ?? "prepare", true);
    }

    if (request.metadata?.packageHandoff) {
      // This branch cannot recover the old in-process stores after finalization.
      // The independent owned Host waits actual process/job retirement, not just
      // the instance lock, before running the unchanged stopped-only installer.
      try {
        if (!this.packageHandoff) throw new Error("Package handoff owner is unavailable");
        await measure("package-arm", () => this.packageHandoff.arm(request));
        const close = await measure("package-close", () => this.resources.close({
          label: "Package restart close failed", reason: "package-handoff",
        }));
        if (failed(close)) throw lifecycleFailure("package-close", close);
        const finalize = await measure("package-finalize", () => this.resources.finalize({
          label: "Package restart finalize failed",
        }));
        if (failed(finalize)) throw lifecycleFailure("package-finalize", finalize);
        await this.packageHandoff.writersClosed(request);
        const release = await this.resources.releaseLock({ label: "Package restart lock release failed" });
        if (failed(release)) throw lifecycleFailure("package-release-lock", release);
        await this.finishSuccessfulReplacement();
        return { status: "handed-off", operationId: request.operationId };
      } catch (error) {
        return this.#halt(error, error?.phase ?? "package-handoff");
      }
    }

    let lockReleased = false;
    try {
      const close = await measure("close", () => this.resources.close({
        label: "Restart close failed",
        reason: "restart",
      }));
      if (failed(close)) throw lifecycleFailure("close", close);
      const release = await measure("release-lock", () => this.resources.releaseLock({ label: "Restart lock release failed" }));
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
    this.#capture(error, phase);
    this.logger.error("Cannot prepare runtime restart:", error.message);
    let abortError = null;
    let restartStateSettled = false;
    try {
      await this.abortRestart(error);
      restartStateSettled = true;
    } catch (recoveryError) {
      this.#capture(recoveryError, "abort-state");
      abortError = recoveryError;
      this.logger.error("Cannot persist aborted restart state:", recoveryError.message);
    }
    try {
      if (resumeRuntime) await this.resumeAfterAbort();
      const recover = await this.resources.recover({ label: "Restart polling recovery failed" });
      if (failed(recover)) throw lifecycleFailure("recover", recover);
    } catch (recoveryError) {
      this.#capture(recoveryError, "abort-recovery");
      abortError ??= recoveryError;
      this.logger.error("Cannot resume aborted restart:", recoveryError.message);
    }
    return { status: "aborted", phase, error, restartStateSettled, ...(abortError ? { abortError } : {}) };
  }

  #halt(error, phase) {
    this.#capture(error, phase);
    this.logger.error(`Runtime restart halted after ${phase}; original ownership requires reconciliation.`);
    return { status: "failed", phase, error };
  }

  async #recover(error, phase, { lockReleased }) {
    this.#capture(error, phase);
    this.logger.error(`Cannot complete runtime restart ${phase}:`, error.message);
    try {
      await this.recoverPrevious(error, { lockReleased });
      const recover = await this.resources.recover({ label: "Restart polling recovery failed" });
      if (failed(recover)) throw lifecycleFailure("recover", recover);
      return { status: "recovered", phase, error, restartStateSettled: true };
    } catch (restoreError) {
      this.#capture(restoreError, "restore-previous");
      this.logger.error("Cannot restore the previous bot after failed restart:", restoreError.message);
      return { status: "failed", phase, error, restoreError };
    }
  }

  #capture(error, action) {
    try {
      this.captureException(error, {
        surface: "server",
        kind: "runtime-lifecycle",
        component: "restart-controller",
        action,
      });
    } catch {}
  }
}
