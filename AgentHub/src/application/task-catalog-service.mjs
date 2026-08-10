export class TaskCatalogService {
  #entries;
  #refreshedAt = 0;
  #refreshInFlight = null;
  #revision = 0;

  constructor({ initialEntries = [], cacheMs = 0, build, now = () => Date.now() } = {}) {
    if (!Array.isArray(initialEntries)) throw new TypeError("initialEntries must be an array");
    if (typeof build !== "function") throw new TypeError("build is required");
    this.#entries = [...initialEntries];
    this.cacheMs = Math.max(0, Number(cacheMs) || 0);
    this.build = build;
    this.now = now;
  }

  get entries() { return this.#entries; }
  get refreshedAt() { return this.#refreshedAt; }
  get revision() { return this.#revision; }
  get refreshing() { return this.#refreshInFlight !== null; }
  get stale() {
    return !this.#entries.length || this.now() - this.#refreshedAt >= this.cacheMs;
  }

  invalidate() {
    this.#refreshedAt = 0;
  }

  async refresh({ force = false } = {}) {
    if (!force && !this.stale) {
      return this.#entries;
    }
    if (this.#refreshInFlight) return this.#refreshInFlight;
    const operation = Promise.resolve()
      .then(() => this.build())
      .then((next) => {
        if (!Array.isArray(next)) throw new TypeError("task catalog builder must return an array");
        // Preserve the array identity used by already constructed controllers.
        this.#entries.splice(0, this.#entries.length, ...next);
        this.#refreshedAt = this.now();
        this.#revision += 1;
        return this.#entries;
      });
    this.#refreshInFlight = operation;
    try {
      return await operation;
    } finally {
      if (this.#refreshInFlight === operation) this.#refreshInFlight = null;
    }
  }
}
