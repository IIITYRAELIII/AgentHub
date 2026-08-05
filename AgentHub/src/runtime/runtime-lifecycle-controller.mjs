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
    await this.resources.flush({ label: "Shutdown flush failed" });
    await this.resources.suspend({ label: "Shutdown close failed" });
    await this.resources.finalize({ label: "Shutdown finalize failed" });
    return true;
  }
}
