// Applies the same ordered lifecycle phases to shutdown and restart resources.
export class RuntimeLifecycleController {
  constructor({
    beginStopping,
    stopTimers,
    stopManagedRuns,
    stopMedia,
    resources,
    logger = console,
    captureException = () => false,
  } = {}) {
    if (typeof beginStopping !== "function") throw new TypeError("beginStopping is required");
    if (typeof stopTimers !== "function") throw new TypeError("stopTimers is required");
    if (!resources) throw new TypeError("resources is required");
    this.beginStopping = beginStopping;
    this.stopTimers = stopTimers;
    this.stopManagedRuns = stopManagedRuns ?? (() => {});
    this.stopMedia = stopMedia ?? (() => {});
    this.resources = resources;
    this.logger = logger;
    this.captureException = captureException;
  }

  async shutdown(signal) {
    if (!this.beginStopping()) return false;
    this.logger.log(`Stopping on ${signal}...`);
    this.stopTimers();
    this.stopManagedRuns();
    this.stopMedia();
    const quiesce = await this.#runPhase("quiesce", {
      label: "Shutdown quiesce failed",
      timeoutMs: 60_000,
    });
    if (quiesce?.ok === false) {
      this.logger.error("Shutdown stopped after quiesce failure; the instance lock remains held.");
      return true;
    }
    const drain = await this.#runPhase("drain", { label: "Shutdown drain failed" });
    if (drain?.ok === false) {
      this.logger.error("Shutdown stopped after drain failure; the instance lock remains held.");
      return true;
    }
    const close = await this.#runPhase("close", { label: "Shutdown close failed" });
    if (close?.ok === false) {
      this.logger.error("Shutdown stopped after close failure; the instance lock remains held.");
      return true;
    }
    const release = await this.#runPhase("releaseLock", { label: "Shutdown lock release failed" });
    if (release?.ok === false) return true;
    await this.#runPhase("finalize", { label: "Shutdown finalize failed" });
    return true;
  }

  async #runPhase(phase, options) {
    try {
      return await this.resources[phase](options);
    } catch (error) {
      try {
        this.captureException(error, {
          surface: "server",
          kind: "runtime-lifecycle",
          component: "shutdown-controller",
          action: phase,
        });
      } catch {}
      throw error;
    }
  }
}
