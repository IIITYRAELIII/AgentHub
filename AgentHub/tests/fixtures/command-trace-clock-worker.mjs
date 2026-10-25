import { workerData } from "node:worker_threads";

const clock = new Int32Array(workerData.clockBuffer);
Object.defineProperty(workerData, "fixedClockMs", {
  get: () => Atomics.load(clock, 0),
});

// Run the actual worker and maintenance timer through its existing clock port.
await import("../../src/infrastructure/persistence/command-trace-store-worker.mjs");
