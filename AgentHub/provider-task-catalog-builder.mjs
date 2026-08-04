function sourceName(source, index) {
  const name = String(source?.name ?? "").trim();
  return name || `provider-${index + 1}`;
}

function requireEntries(value, label) {
  if (!Array.isArray(value)) throw new TypeError(`${label} must return an array`);
  return value;
}

export class ProviderTaskCatalogBuilder {
  #sources;

  constructor({
    durableEntries,
    sources = [],
    managedRuns = () => [],
    merge,
    finalize = (entries) => entries,
    onSourceError = () => {},
  } = {}) {
    if (typeof durableEntries !== "function") throw new TypeError("durableEntries is required");
    if (typeof merge !== "function") throw new TypeError("merge is required");
    if (typeof managedRuns !== "function") throw new TypeError("managedRuns must be a function");
    if (typeof finalize !== "function") throw new TypeError("finalize must be a function");
    if (typeof onSourceError !== "function") throw new TypeError("onSourceError must be a function");
    if (!Array.isArray(sources)) throw new TypeError("sources must be an array");
    this.#sources = sources.map((source, index) => {
      if (typeof source?.discover !== "function") {
        throw new TypeError(`${sourceName(source, index)}.discover is required`);
      }
      if (source.toEntries !== undefined && typeof source.toEntries !== "function") {
        throw new TypeError(`${sourceName(source, index)}.toEntries must be a function`);
      }
      return Object.freeze({
        name: sourceName(source, index),
        discover: source.discover,
        toEntries: source.toEntries ?? ((entries) => entries),
      });
    });
    this.durableEntries = durableEntries;
    this.managedRuns = managedRuns;
    this.merge = merge;
    this.finalize = finalize;
    this.onSourceError = onSourceError;
  }

  async build() {
    const discoveries = await Promise.allSettled(
      this.#sources.map((source) => Promise.resolve().then(() => source.discover())),
    );
    const entries = [...requireEntries(await this.durableEntries(), "durableEntries")];
    const sourceResults = [];
    for (let index = 0; index < this.#sources.length; index += 1) {
      const source = this.#sources[index];
      const discovery = discoveries[index];
      if (discovery.status === "rejected") {
        const result = { name: source.name, status: "rejected", reason: discovery.reason };
        sourceResults.push(result);
        await this.onSourceError(result);
        continue;
      }
      try {
        const projected = requireEntries(
          await source.toEntries(discovery.value),
          `${source.name}.toEntries`,
        );
        entries.push(...projected);
        sourceResults.push({ name: source.name, status: "fulfilled", count: projected.length });
      } catch (reason) {
        const result = { name: source.name, status: "rejected", reason };
        sourceResults.push(result);
        await this.onSourceError(result);
      }
    }
    const runs = requireEntries(await this.managedRuns(), "managedRuns");
    const merged = requireEntries(await this.merge(entries, runs), "merge");
    return requireEntries(await this.finalize(merged, { sourceResults }), "finalize");
  }
}
