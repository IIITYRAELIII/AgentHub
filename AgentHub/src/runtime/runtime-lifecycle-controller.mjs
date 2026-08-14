// Applies the same ordered lifecycle phases to shutdown and restart resources.
export class RuntimeLifecycleController {
  constructor({
    beginStopping,
    stopTimers,
    stopManagedRuns,
    stopMedia,
    resources,
    logger = console,
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
  }

  async shutdown(signal) {
    if (!this.beginStopping()) return false;
    this.logger.log(`Stopping on ${signal}...`);
    this.stopTimers();
    this.stopManagedRuns();
    this.stopMedia();
    const quiesce = await this.resources.quiesce({
      label: "Shutdown quiesce failed",
      timeoutMs: 60_000,
    });
    if (quiesce?.ok === false) {
      this.logger.error("Shutdown stopped after quiesce failure; the instance lock remains held.");
      return true;
    }
    const drain = await this.resources.drain({ label: "Shutdown drain failed" });
    if (drain?.ok === false) {
      this.logger.error("Shutdown stopped after drain failure; the instance lock remains held.");
      return true;
    }
    const close = await this.resources.close({ label: "Shutdown close failed" });
    if (close?.ok === false) {
      this.logger.error("Shutdown stopped after close failure; the instance lock remains held.");
      return true;
    }
    const release = await this.resources.releaseLock({ label: "Shutdown lock release failed" });
    if (release?.ok === false) return true;
    await this.resources.finalize({ label: "Shutdown finalize failed" });
    return true;
  }
}
