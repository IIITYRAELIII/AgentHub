import { settleNamedOperations } from "./lifecycle-coordinator.mjs";

export class RuntimeLifecycleController {
  constructor({
    beginStopping,
    stopTimers,
    stopManagedRuns,
    stopMedia,
    operations,
    afterClose = () => {},
    logger = console,
    settle = settleNamedOperations,
  } = {}) {
    if (typeof beginStopping !== "function") throw new TypeError("beginStopping is required");
    if (typeof stopTimers !== "function") throw new TypeError("stopTimers is required");
    if (typeof operations !== "function") throw new TypeError("operations is required");
    this.beginStopping = beginStopping;
    this.stopTimers = stopTimers;
    this.stopManagedRuns = stopManagedRuns ?? (() => {});
    this.stopMedia = stopMedia ?? (() => {});
    this.operations = operations;
    this.afterClose = afterClose;
    this.logger = logger;
    this.settle = settle;
  }

  async shutdown(signal) {
    if (!this.beginStopping()) return false;
    this.logger.log(`Stopping on ${signal}...`);
    this.stopTimers();
    this.stopManagedRuns();
    this.stopMedia();
    await this.settle(this.operations(), {
      logError: (name, error) => this.logger.error(`Shutdown failed (${name}):`, error.message),
    });
    await this.afterClose();
    return true;
  }
}
