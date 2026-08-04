const REQUIRED_OPERATIONS = Object.freeze([
  "discoverTasks",
  "projectTasks",
  "createTask",
  "launchTurn",
  "steerTurn",
  "cancelRun",
  "readTaskActivity",
  "readRunSnapshot",
  "completeObservedRun",
  "completeManagedRun",
  "recoverRun",
  "readRecoverySnapshot",
  "prepareRecovery",
  "shouldObserveRun",
  "applyObservedSnapshot",
  "applyActiveSnapshot",
  "blocksRuntimeRestart",
  "stopManagedRunForShutdown",
]);

function providerId(value) {
  const id = String(value ?? "").trim().toLowerCase();
  if (!id) throw new Error("provider id is required");
  return id;
}

function providerName(adapter, id) {
  return String(adapter?.name ?? "").trim() || id;
}

export class AgentProviderRegistry {
  #providers = new Map();

  constructor(adapters = []) {
    if (!Array.isArray(adapters)) throw new TypeError("provider adapters must be an array");
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter) {
    if (!adapter || typeof adapter !== "object") throw new TypeError("provider adapter is required");
    const id = providerId(adapter.id);
    if (this.#providers.has(id)) throw new Error(`provider already registered: ${id}`);
    for (const operation of REQUIRED_OPERATIONS) {
      if (typeof adapter[operation] !== "function") {
        throw new TypeError(`${id}.${operation} is required`);
      }
    }
    this.#providers.set(id, Object.freeze({ ...adapter, id, name: providerName(adapter, id) }));
    return this;
  }

  has(id) {
    return this.#providers.has(String(id ?? "").trim().toLowerCase());
  }

  get(id) {
    const key = providerId(id);
    const adapter = this.#providers.get(key);
    if (!adapter) throw new Error(`unknown agent provider: ${key}`);
    return adapter;
  }

  call(id, operation, ...args) {
    const adapter = this.get(id);
    const handler = adapter[String(operation ?? "").trim()];
    if (typeof handler !== "function") {
      throw new Error(`${adapter.id} does not support provider operation: ${operation}`);
    }
    return handler(...args);
  }

  catalogSources() {
    return [...this.#providers.values()].map((adapter) => Object.freeze({
      name: adapter.name,
      discover: () => adapter.discoverTasks(),
      toEntries: (value) => adapter.projectTasks(value),
    }));
  }

  ids() {
    return [...this.#providers.keys()];
  }
}

export { REQUIRED_OPERATIONS as AGENT_PROVIDER_REQUIRED_OPERATIONS };
