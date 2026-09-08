import { taskOccupancyIdentity } from "../domain/task-runs.mjs";

export function deferredInputTaskKey(value) {
  return taskOccupancyIdentity(value)?.key ?? "unbound";
}

function deferredInputDiagnostic(item, state) {
  return {
    id: String(item?.id ?? ""),
    streamId: String(item?.streamId ?? ""),
    provider: String(item?.provider ?? ""),
    threadId: String(item?.threadId ?? ""),
    clientUserMessageId: String(item?.clientUserMessageId ?? ""),
    state,
    conflictKind: String(item?.conflictKind ?? ""),
    waitReason: String(item?.waitReason ?? ""),
    createdAt: String(item?.createdAt ?? ""),
    dispatchingAt: String(item?.dispatchingAt ?? ""),
    lastAttemptAt: String(item?.lastAttemptAt ?? ""),
    attempts: Math.max(0, Number(item?.attempts) || 0),
  };
}

function queuedDiagnosticState(item) {
  if (item?.paused === true) return "paused";
  if (!item?.dispatchingAt) return "queued";
  return String(item?.waitReason ?? "").includes("unconfirmed")
    ? "reconciling"
    : "dispatching";
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

  diagnostics() {
    return [
      ...[...this.#pending.values()].map((item) => deferredInputDiagnostic(item, "pending")),
      ...[...this.#queued.values()].map((item) => deferredInputDiagnostic(
        item,
        queuedDiagnosticState(item),
      )),
    ];
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
