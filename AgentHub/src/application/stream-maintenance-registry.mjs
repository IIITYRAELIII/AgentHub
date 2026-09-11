import { randomUUID } from "node:crypto";

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

function streamMaintenanceKeys(target) {
  const keys = [];
  const streamId = String(target?.streamId ?? "").trim();
  const provider = normalized(target?.provider);
  const projectRoot = normalized(target?.projectRoot);
  const threadId = normalized(target?.threadId);
  if (streamId) keys.push(`stream:${streamId}`);
  if (provider && threadId) {
    keys.push(`provider:${provider}:${projectRoot}:${threadId}`);
    keys.push(`provider-thread:${provider}:${threadId}`);
  }
  if (!keys.length) keys.push(streamMaintenanceKey(target));
  return [...new Set(keys)];
}

export class StreamMaintenanceRegistry {
  #entries = new Map();
  #aliases = new Map();

  #entryKey(targetOrEntry) {
    const explicitKey = String(targetOrEntry?.key ?? "").trim();
    if (targetOrEntry?.reservationId) {
      return this.#entries.get(explicitKey)?.reservationId === targetOrEntry.reservationId
        ? explicitKey : null;
    }
    if (explicitKey && this.#entries.has(explicitKey)) return explicitKey;
    for (const alias of streamMaintenanceKeys(targetOrEntry)) {
      const key = this.#aliases.get(alias);
      if (key) return key;
    }
    return null;
  }

  begin(target, reason = "context-maintenance") {
    const aliases = streamMaintenanceKeys(target);
    if (aliases.some((alias) => this.#aliases.has(alias))) return null;
    const key = streamMaintenanceKey(target);
    const entry = {
      key,
      reservationId: randomUUID(),
      phase: "preparing",
      reason: String(reason ?? "context-maintenance").trim() || "context-maintenance",
      streamId: String(target?.streamId ?? "").trim() || null,
      threadId: String(target?.threadId ?? "").trim() || null,
      ownerRunId: String(target?.id ?? target?.runId ?? "").trim() || null,
      ownerTurnId: String(target?.turnId ?? "").trim() || null,
      startedAt: new Date().toISOString(),
    };
    this.#entries.set(key, entry);
    for (const alias of aliases) this.#aliases.set(alias, key);
    return entry;
  }

  end(targetOrEntry) {
    const key = this.#entryKey(targetOrEntry);
    if (!key) return false;
    for (const [alias, entryKey] of this.#aliases) {
      if (entryKey === key) this.#aliases.delete(alias);
    }
    return this.#entries.delete(key);
  }

  isActive(target) {
    return this.#entryKey(target) !== null;
  }

  activeCount() {
    return this.#entries.size;
  }

  entry(target) {
    const key = this.#entryKey(target);
    return key ? this.#entries.get(key) ?? null : null;
  }

  update(targetOrEntry, details = {}) {
    const key = this.#entryKey(targetOrEntry);
    if (!key) return null;
    const current = this.#entries.get(key);
    const reason = String(details.reason ?? "").trim();
    const phase = String(details.phase ?? "").trim();
    const entry = {
      ...current,
      ...(reason ? { reason } : {}),
      ...(["preparing", "starting", "running", "measuring"].includes(phase) ? { phase } : {}),
    };
    this.#entries.set(key, entry);
    return entry;
  }
}
