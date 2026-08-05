// Coordinates one safe runtime replacement without owning process transport.
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
    finishSuccessfulReplacement,
    isStopping = () => false,
    logger = console,
  } = {}) {
    for (const [name, value] of Object.entries({
      getRequest, updateOffset, hasBlockingWork, setWaiting, updateMessage, saveState,
      beginStopping, stopTimers, stopMedia, launchReplacement, recoverPrevious,
      finishSuccessfulReplacement,
    })) {
      if (typeof value !== "function") throw new TypeError(`${name} is required`);
    }
    if (!resources) throw new TypeError("resources is required");
    Object.assign(this, {
      getRequest, updateOffset, hasBlockingWork, setWaiting, updateMessage, saveState,
      resources, beginStopping, stopTimers, stopMedia, launchReplacement,
      recoverPrevious, finishSuccessfulReplacement, isStopping, logger,
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
    await this.updateMessage("🔄 Перезапускаю Agent Hub…").catch(() => {});
    await this.saveState();
    await this.resources.flush({ label: "Restart flush failed" });
    if (!this.beginStopping()) return { status: "ignored" };
    this.stopTimers();
    this.stopMedia();
    await this.resources.suspend({ label: "Restart close failed" });

    try {
      const replacement = await this.launchReplacement();
      this.logger.log(
        `Replacement bot ready: PID ${replacement.lock.pid}; attempt ${replacement.attempt}`
          + `${replacement.usedFallback ? " (direct launcher fallback)" : ""}.`,
      );
    } catch (error) {
      this.logger.error("Cannot start replacement bot:", error.message);
      try {
        await this.recoverPrevious(error);
        return { status: "recovered", error };
      } catch (restoreError) {
        this.logger.error("Cannot restore the previous bot after failed replacement:", restoreError.message);
        return { status: "failed", error, restoreError };
      }
    }

    await this.resources.finalize({ label: "Restart finalize failed" });
    await this.finishSuccessfulReplacement();
    return { status: "replaced" };
  }
}
