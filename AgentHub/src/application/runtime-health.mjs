const CAPABILITY_STATES = new Set(["pending", "ready", "degraded", "failed", "disabled"]);

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

export class RuntimeHealth {
  #capabilities = new Map();
  #phase = "starting";

  begin() {
    this.#capabilities.clear();
    this.#phase = "starting";
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
    return this;
  }

  snapshot() {
    const capabilities = [...this.#capabilities.values()].map(capabilitySnapshot);
    const impaired = capabilities.filter((capability) => ["degraded", "failed"].includes(capability.state));
    const required = capabilities.filter((capability) => capability.critical && capability.state !== "disabled");
    const ready = this.#phase === "complete" && required.every((capability) => capability.state === "ready");
    const degraded = impaired.length > 0;
    return {
      live: true,
      ready,
      degraded,
      status: ready ? (degraded ? "degraded" : "ready") : (degraded ? "unready" : "starting"),
      capabilities,
    };
  }
}

export function createRuntimeHealth() {
  return new RuntimeHealth();
}

export const agentHubRuntimeHealth = createRuntimeHealth();
