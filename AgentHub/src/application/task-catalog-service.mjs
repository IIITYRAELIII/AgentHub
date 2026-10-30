export class TaskCatalogService {
  #entries;
  #refreshedAt = 0;
  #refreshInFlight = null;
  #revision = 0;
  #invalidationRevision = 0;
  #builtInvalidationRevision = -1;

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
  get snapshotRevision() { return `${this.#revision}:${this.#invalidationRevision}`; }
  get refreshing() { return this.#refreshInFlight !== null; }
  get stale() {
    return !this.#entries.length || this.now() - this.#refreshedAt >= this.cacheMs;
  }

  invalidate() {
    this.#invalidationRevision += 1;
    this.#refreshedAt = 0;
  }

  async refresh({ force = false } = {}) {
    if (!force && !this.stale) {
      return this.#entries;
    }
    if (this.#refreshInFlight) {
      await this.#refreshInFlight;
      if (this.#builtInvalidationRevision < this.#invalidationRevision) {
        return this.refresh({ force: true });
      }
      return this.#entries;
    }
    const buildInvalidationRevision = this.#invalidationRevision;
    const operation = Promise.resolve()
      .then(() => this.build())
      .then((next) => {
        if (!Array.isArray(next)) throw new TypeError("task catalog builder must return an array");
        // An invalidated build cannot overwrite a newer acknowledged local change.
        if (buildInvalidationRevision !== this.#invalidationRevision) return this.#entries;
        // Preserve the array identity used by already constructed controllers.
        this.#entries.splice(0, this.#entries.length, ...next);
        this.#builtInvalidationRevision = buildInvalidationRevision;
        this.#refreshedAt = buildInvalidationRevision === this.#invalidationRevision
          ? this.now()
          : 0;
        this.#revision += 1;
        return this.#entries;
      });
    this.#refreshInFlight = operation;
    try {
      await operation;
    } finally {
      if (this.#refreshInFlight === operation) this.#refreshInFlight = null;
    }
    if (this.#builtInvalidationRevision < this.#invalidationRevision) {
      return this.refresh({ force: true });
    }
    return this.#entries;
  }
}
