import { settleNamedOperations } from "./lifecycle-coordinator.mjs";

const PHASES = Object.freeze(["quiesce", "drain", "close", "releaseLock", "recover", "finalize"]);

function normalizedEntries(entries) {
  if (!Array.isArray(entries)) throw new TypeError("resource phase must be an array");
  return entries.map((entry) => {
    if (!entry || typeof entry.run !== "function") throw new TypeError("resource entry requires run()");
    return {
      name: String(entry.name ?? "resource"),
      run: entry.run,
      preserveOnRestart: entry.preserveOnRestart === true,
      ...(entry.timeoutMs === undefined ? {} : { timeoutMs: Number(entry.timeoutMs) }),
    };
  });
}

export class RuntimeResourceRegistry {
  constructor({
    quiesce = [],
    drain = [],
    close = [],
    releaseLock = [],
    recover = [],
    finalize = [],
    logger = console,
    captureException = () => false,
    settle = settleNamedOperations,
    phaseTimeoutMs = 45_000,
  } = {}) {
    this.phases = {
      quiesce: normalizedEntries(quiesce),
      drain: normalizedEntries(drain),
      close: normalizedEntries(close),
      releaseLock: normalizedEntries(releaseLock),
      recover: normalizedEntries(recover),
      finalize: normalizedEntries(finalize),
    };
    this.logger = logger;
    this.captureException = captureException;
    this.settle = settle;
    this.phaseTimeoutMs = phaseTimeoutMs;
  }

  register(phase, entry) {
    if (!PHASES.includes(phase)) throw new Error(`unsupported runtime resource phase: ${phase}`);
    this.phases[phase].push(...normalizedEntries([entry]));
    return this;
  }

  async run(phase, {
    label = phase,
    timeoutMs = this.phaseTimeoutMs,
    reason = "shutdown",
  } = {}) {
    if (!PHASES.includes(phase)) throw new Error(`unsupported runtime resource phase: ${phase}`);
    const entries = phase === "close" && reason === "restart"
      ? this.phases[phase].filter((entry) => !entry.preserveOnRestart)
      : this.phases[phase];
    return this.settle(entries, {
      logError: (name, error) => {
        this.logger.error(`${label} (${name}):`, error.message);
        try {
          this.captureException(error, {
            surface: "server",
            kind: "runtime-lifecycle",
            component: "resource-registry",
            action: `${phase}:${name}`,
          });
        } catch {}
      },
      timeoutMs,
    });
  }

  quiesce(options) { return this.run("quiesce", options); }
  drain(options) { return this.run("drain", options); }
  close(options) { return this.run("close", options); }
  releaseLock(options) { return this.run("releaseLock", options); }
  recover(options) { return this.run("recover", options); }
  finalize(options) { return this.run("finalize", options); }
}
