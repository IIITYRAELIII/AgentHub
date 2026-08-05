function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function deferredInputTaskKey(value) {
  const hubTaskId = String(value?.hubTaskId ?? "").trim();
  if (hubTaskId) return `task:${hubTaskId}`;
  return [
    "provider",
    normalized(value?.provider),
    normalized(value?.projectRoot),
    normalized(value?.threadId),
  ].join(":");
}

export class DeferredInputStore {
  #pending = new Map();
  #queued = new Map();

  get pending() {
    return this.#pending;
  }

  get queued() {
    return this.#queued;
  }

  get size() {
    return this.#pending.size + this.#queued.size;
  }

  collection(destination = "pending") {
    return destination === "queued" ? this.#queued : this.#pending;
  }

  put(item, destination = "pending") {
    if (!item?.id) throw new TypeError("deferred input id is required");
    this.#pending.delete(item.id);
    this.#queued.delete(item.id);
    this.collection(destination).set(item.id, item);
    return item;
  }

  get(id) {
    return this.#pending.get(id) ?? this.#queued.get(id) ?? null;
  }

  delete(id) {
    return this.#pending.delete(id) || this.#queued.delete(id);
  }

  values() {
    return [...this.#pending.values(), ...this.#queued.values()];
  }

  hasBacklog(target) {
    const key = deferredInputTaskKey(target);
    return this.values().some((item) => deferredInputTaskKey(item) === key);
  }

  latestActivityAt(target) {
    const key = deferredInputTaskKey(target);
    let latest = 0;
    for (const item of this.values()) {
      if (deferredInputTaskKey(item) !== key) continue;
      latest = Math.max(latest, Date.parse(String(item.createdAt ?? "")) || 0);
    }
    return latest;
  }

  snapshot() {
    return {
      pending: [...this.#pending.values()],
      queued: [...this.#queued.values()],
    };
  }
}
