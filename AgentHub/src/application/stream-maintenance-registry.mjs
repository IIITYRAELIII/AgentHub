function normalized(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function streamMaintenanceKey(target) {
  const streamId = String(target?.streamId ?? "").trim();
  if (streamId) return `stream:${streamId}`;
  return [
    "provider",
    normalized(target?.provider),
    normalized(target?.projectRoot),
    normalized(target?.threadId),
  ].join(":");
}

export class StreamMaintenanceRegistry {
  #entries = new Map();

  begin(target, reason = "context-maintenance") {
    const key = streamMaintenanceKey(target);
    if (this.#entries.has(key)) return null;
    const entry = {
      key,
      reason: String(reason ?? "context-maintenance").trim() || "context-maintenance",
      streamId: String(target?.streamId ?? "").trim() || null,
      threadId: String(target?.threadId ?? "").trim() || null,
      startedAt: new Date().toISOString(),
    };
    this.#entries.set(key, entry);
    return entry;
  }

  end(targetOrEntry) {
    const key = String(targetOrEntry?.key ?? "").trim()
      || streamMaintenanceKey(targetOrEntry);
    return this.#entries.delete(key);
  }

  isActive(target) {
    return this.#entries.has(streamMaintenanceKey(target));
  }

  activeCount() {
    return this.#entries.size;
  }

  entry(target) {
    return this.#entries.get(streamMaintenanceKey(target)) ?? null;
  }

  update(targetOrEntry, details = {}) {
    const key = String(targetOrEntry?.key ?? "").trim()
      || streamMaintenanceKey(targetOrEntry);
    const current = this.#entries.get(key);
    if (!current) return null;
    const reason = String(details.reason ?? "").trim();
    const entry = {
      ...current,
      ...(reason ? { reason } : {}),
    };
    this.#entries.set(key, entry);
    return entry;
  }
}
