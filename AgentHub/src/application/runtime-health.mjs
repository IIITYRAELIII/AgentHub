import { monitorEventLoopDelay } from "node:perf_hooks";

const CAPABILITY_STATES = new Set(["pending", "ready", "degraded", "failed", "disabled"]);
const OPERATION_STATES = new Set(["pending", "running", "completed", "failed", "skipped"]);

function capabilityName(value) {
  const name = String(value ?? "").trim();
  if (!name) throw new TypeError("runtime health capability name is required");
  return name;
}

function capabilityState(value) {
  const state = String(value ?? "").trim().toLowerCase();
  if (!CAPABILITY_STATES.has(state)) throw new TypeError(`unsupported runtime health state: ${value}`);
  return state;
}

function operationId(value) {
  const id = String(value ?? "").trim();
  if (!id) throw new TypeError("runtime health operation id is required");
  return id;
}

function operationState(value) {
  const state = String(value ?? "pending").trim().toLowerCase();
  if (!OPERATION_STATES.has(state)) throw new TypeError(`unsupported runtime operation state: ${value}`);
  return state;
}

function capabilitySnapshot(capability) {
  return {
    name: capability.name,
    critical: capability.critical,
    state: capability.state,
    ...(["degraded", "failed"].includes(capability.state) && capability.error
      ? { error: capability.error }
      : {}),
  };
}

function operationSnapshot(operation) {
  return {
    id: operation.id,
    label: operation.label,
    state: operation.state,
    ...(operation.startedAtMs ? { startedAtMs: operation.startedAtMs } : {}),
    ...(operation.completedAtMs ? { completedAtMs: operation.completedAtMs } : {}),
    ...(operation.state === "failed" && operation.error ? { error: operation.error } : {}),
  };
}

export class RuntimeHealth {
  #capabilities = new Map();
  #now;
  #phase = "starting";
  #startup = null;
  #diagnosticSources = new Map();
  #eventLoopDelay = null;

  constructor({ now = Date.now } = {}) {
    this.#now = typeof now === "function" ? now : Date.now;
  }

  setDiagnosticSource(name, source) {
    const normalizedName = capabilityName(name);
    if (source == null) {
      this.#diagnosticSources.delete(normalizedName);
      return this;
    }
    if (typeof source !== "function") throw new TypeError("runtime diagnostic source must be a function");
    this.#diagnosticSources.set(normalizedName, source);
    if (!this.#eventLoopDelay) {
      this.#eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
      this.#eventLoopDelay.enable();
    }
    return this;
  }

  begin({ operations = [] } = {}) {
    this.#capabilities.clear();
    this.#phase = "starting";
    const startedAtMs = Number(this.#now());
    const normalized = operations.map((entry) => {
      const id = operationId(entry?.id);
      const label = String(entry?.label ?? "").trim();
      if (!label) throw new TypeError(`runtime health operation label is required: ${id}`);
      const state = operationState(entry?.state);
      const settled = ["completed", "failed", "skipped"].includes(state);
      return {
        id,
        label,
        state,
        startedAtMs: state === "pending" ? 0 : startedAtMs,
        completedAtMs: settled ? startedAtMs : 0,
        error: state === "failed" ? String(entry?.error ?? "").trim() : "",
      };
    });
    if (new Set(normalized.map((entry) => entry.id)).size !== normalized.length) {
      throw new TypeError("runtime health operation ids must be unique");
    }
    this.#startup = normalized.length ? {
      startedAtMs,
      completedAtMs: 0,
      operations: new Map(normalized.map((entry) => [entry.id, entry])),
    } : null;
    return this;
  }

  #operation(id) {
    const normalizedId = operationId(id);
    const operation = this.#startup?.operations.get(normalizedId);
    if (!operation) throw new TypeError(`unknown runtime health operation: ${normalizedId}`);
    return operation;
  }

  startOperation(id) {
    const operation = this.#operation(id);
    const running = [...this.#startup.operations.values()]
      .find((entry) => entry.state === "running" && entry.id !== operation.id);
    if (running) throw new Error(`runtime health operation already running: ${running.id}`);
    if (!["pending", "running"].includes(operation.state)) {
      throw new Error(`runtime health operation cannot start from ${operation.state}: ${operation.id}`);
    }
    operation.state = "running";
    operation.startedAtMs ||= Number(this.#now());
    operation.completedAtMs = 0;
    operation.error = "";
    return this;
  }

  completeOperation(id) {
    const operation = this.#operation(id);
    if (!["pending", "running"].includes(operation.state)) {
      throw new Error(`runtime health operation cannot complete from ${operation.state}: ${operation.id}`);
    }
    operation.state = "completed";
    operation.startedAtMs ||= Number(this.#now());
    operation.completedAtMs = Number(this.#now());
    operation.error = "";
    return this;
  }

  failOperation(id, error = "") {
    const operation = this.#operation(id);
    if (!["pending", "running"].includes(operation.state)) {
      throw new Error(`runtime health operation cannot fail from ${operation.state}: ${operation.id}`);
    }
    operation.state = "failed";
    operation.startedAtMs ||= Number(this.#now());
    operation.completedAtMs = Number(this.#now());
    operation.error = String(error?.message ?? error ?? "").trim();
    return this;
  }

  skipOperation(id) {
    const operation = this.#operation(id);
    if (!["pending", "running"].includes(operation.state)) {
      throw new Error(`runtime health operation cannot skip from ${operation.state}: ${operation.id}`);
    }
    operation.state = "skipped";
    operation.startedAtMs = Number(this.#now());
    operation.completedAtMs = Number(this.#now());
    operation.error = "";
    return this;
  }

  setCapability(name, {
    critical = false,
    state = "pending",
    error = "",
  } = {}) {
    const normalizedName = capabilityName(name);
    const normalizedState = capabilityState(state);
    this.#capabilities.set(normalizedName, {
      name: normalizedName,
      critical: critical === true,
      state: normalizedState,
      error: ["degraded", "failed"].includes(normalizedState) ? String(error ?? "").trim() : "",
    });
    return this;
  }

  complete() {
    this.#phase = "complete";
    if (this.#startup) this.#startup.completedAtMs = Number(this.#now());
    return this;
  }

  snapshot() {
    const capabilities = [...this.#capabilities.values()].map(capabilitySnapshot);
    const impaired = capabilities.filter((capability) => ["degraded", "failed"].includes(capability.state));
    const required = capabilities.filter((capability) => capability.critical && capability.state !== "disabled");
    const ready = this.#phase === "complete" && required.every((capability) => capability.state === "ready");
    const degraded = impaired.length > 0;
    const diagnostics = {};
    for (const [name, source] of this.#diagnosticSources) {
      try {
        diagnostics[name] = source();
      } catch (error) {
        diagnostics[name] = { error: String(error?.message ?? error) };
      }
    }
    if (this.#diagnosticSources.size) {
      const memory = process.memoryUsage();
      diagnostics.process = {
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        heapTotalBytes: memory.heapTotal,
        externalBytes: memory.external,
        eventLoopDelayP95Ms: Number(this.#eventLoopDelay.percentile(95)) / 1e6,
        eventLoopDelayMaxMs: Number(this.#eventLoopDelay.max) / 1e6,
      };
    }
    return {
      live: true,
      ready,
      degraded,
      status: ready ? (degraded ? "degraded" : "ready") : (degraded ? "unready" : "starting"),
      capabilities,
      ...(this.#diagnosticSources.size ? { diagnostics } : {}),
      ...(this.#startup ? {
        startup: {
          startedAtMs: this.#startup.startedAtMs,
          ...(this.#startup.completedAtMs ? { completedAtMs: this.#startup.completedAtMs } : {}),
          operations: [...this.#startup.operations.values()].map(operationSnapshot),
        },
      } : {}),
    };
  }
}

export function createRuntimeHealth(options) {
  return new RuntimeHealth(options);
}

export const agentHubRuntimeHealth = createRuntimeHealth();
