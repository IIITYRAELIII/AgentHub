function requiredFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`${name} is required`);
  return value;
}

export class ClaudeTaskSnapshotService {
  #d;

  constructor(dependencies = {}) {
    for (const name of [
      "readSession", "findProject", "cancellationKey", "activityAtMs", "activityState", "saveState",
    ]) requiredFunction(dependencies[name], name);
    if (!(dependencies.cancelledTasks instanceof Map)) throw new TypeError("cancelledTasks map is required");
    this.#d = dependencies;
  }

  applyManagedCancellation(snapshot) {
    const d = this.#d;
    if (!snapshot?.sessionId || !snapshot.cwd) return snapshot;
    const project = d.findProject(snapshot.cwd);
    if (!project) return snapshot;
    const key = d.cancellationKey({
      provider: "claude",
      threadId: snapshot.sessionId,
    });
    const cancelledAtMs = d.cancelledTasks.get(key);
    if (!Number.isFinite(cancelledAtMs)) return snapshot;
    const activityAtMs = d.activityAtMs(snapshot);
    if (Number.isFinite(activityAtMs) && activityAtMs > cancelledAtMs) {
      d.cancelledTasks.delete(key);
      void d.saveState().catch((error) => d.logError?.("Cannot persist cleared Claude cancellation marker:", error.message));
      return snapshot;
    }
    return { ...snapshot, active: false, completed: true, cancelled: true };
  }

  async read(sessionId, { includeHistory = false } = {}) {
    const rawSnapshot = await this.#d.readSession(sessionId, { includeHistory });
    const snapshot = this.applyManagedCancellation(rawSnapshot);
    if (!snapshot) return null;
    const activityState = this.#d.activityState(snapshot);
    return {
      ...snapshot,
      active: activityState === "active",
      activityUnknown: activityState === "unknown",
      stale: activityState === "unknown",
      activityAtMs: this.#d.activityAtMs(snapshot),
    };
  }
}
