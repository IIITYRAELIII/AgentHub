import { createHash } from "node:crypto";

const DEFAULT_CACHE_LIMIT = 4;

export function createSnapshotCollectionDelta({
  keyOf,
  cacheLimit = DEFAULT_CACHE_LIMIT,
  serialize = JSON.stringify,
}) {
  if (typeof keyOf !== "function") throw new TypeError("Snapshot collection keyOf is required");
  if (typeof serialize !== "function") throw new TypeError("Snapshot collection serializer must be a function");
  const snapshots = new Map();
  const sourceSnapshots = new Map();
  const limit = Math.max(2, Number(cacheLimit) || DEFAULT_CACHE_LIMIT);

  function collect(items) {
    const hash = createHash("sha256");
    const keyed = new Map();
    const order = [];
    const values = new Map();
    for (const item of items) {
      const key = String(keyOf(item) ?? "").trim();
      if (!key) throw new Error("Snapshot collection item has no stable key");
      if (keyed.has(key)) throw new Error(`Snapshot collection contains duplicate key: ${key}`);
      const serialized = serialize(item);
      hash.update(String(serialized.length)).update(":").update(serialized);
      keyed.set(key, serialized);
      values.set(key, item);
      order.push(key);
    }
    return {
      keyed,
      order,
      values,
      version: hash.digest("base64url").slice(0, 22),
    };
  }

  function remember(version, keyed, order) {
    snapshots.delete(version);
    snapshots.set(version, { keyed, order });
    while (snapshots.size > limit) snapshots.delete(snapshots.keys().next().value);
    return snapshots.get(version);
  }

  function rememberSource(sourceVersion, current) {
    sourceSnapshots.delete(sourceVersion);
    sourceSnapshots.set(sourceVersion, current);
    while (sourceSnapshots.size > limit) sourceSnapshots.delete(sourceSnapshots.keys().next().value);
    return current;
  }

  return function project(items, knownVersion = "", { sourceVersion = "" } = {}) {
    const values = Array.isArray(items) ? items : [];
    const exactSourceVersion = String(sourceVersion ?? "");
    const current = exactSourceVersion
      ? sourceSnapshots.get(exactSourceVersion)
        ?? rememberSource(exactSourceVersion, collect(values))
      : collect(values);
    const { version } = current;
    const previous = snapshots.get(String(knownVersion ?? ""));
    remember(version, current.keyed, current.order);
    if (previous && knownVersion === version) {
      return { baseVersion: String(knownVersion), version };
    }
    if (!previous) {
      return {
        version,
        reset: current.order.map((key) => structuredClone(current.values.get(key))),
      };
    }
    const upserts = [];
    for (const key of current.order) {
      if (previous.keyed.get(key) !== current.keyed.get(key)) {
        upserts.push(structuredClone(current.values.get(key)));
      }
    }
    const removed = previous.order.filter((key) => !current.keyed.has(key));
    return {
      baseVersion: String(knownVersion),
      version,
      upserts,
      removed,
      order: current.order,
    };
  };
}
