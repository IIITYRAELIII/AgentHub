import { settleNamedOperations } from "./lifecycle-coordinator.mjs";

const PHASES = Object.freeze(["flush", "suspend", "finalize"]);

function normalizedEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("resource phase must be an array");
  return entries.map((entry) => {
    if (!entry || typeof entry.run !== "function") throw new TypeError("resource entry requires run()");
    return { name: String(entry.name ?? "resource"), run: entry.run };
  });
}

export class RuntimeResourceRegistry {
  constructor({ flush = [], suspend = [], finalize = [], logger = console, settle = settleNamedOperations } = {}) {
    this.phases = Object.freeze({
      flush: normalizedEntries(flush),
      suspend: normalizedEntries(suspend),
      finalize: normalizedEntries(finalize),
    });
    this.logger = logger;
    this.settle = settle;
  }

  async run(phase, { label = phase } = {}) {
    if (!PHASES.includes(phase)) throw new Error(`unsupported runtime resource phase: ${phase}`);
    return this.settle(this.phases[phase], {
      logError: (name, error) => this.logger.error(`${label} (${name}):`, error.message),
    });
  }

  flush(options) { return this.run("flush", options); }
  suspend(options) { return this.run("suspend", options); }
  finalize(options) { return this.run("finalize", options); }
}
