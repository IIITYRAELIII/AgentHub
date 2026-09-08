import { normalizeInterstreamOrigin } from "../domain/interstream-message.mjs";

function normalizedIdentity(value = {}) {
  return {
    provider: String(value.provider ?? "").trim().toLowerCase(),
    threadId: String(value.threadId ?? "").trim(),
    streamId: String(value.streamId ?? "").trim(),
  };
}

function sameIdentity(left, right) {
  const expected = normalizedIdentity(left);
  const actual = normalizedIdentity(right);
  return Boolean(expected.provider && expected.threadId && expected.streamId
    && expected.provider === actual.provider
    && expected.threadId === actual.threadId
    && expected.streamId === actual.streamId);
}

function validIdentity(value) {
  const identity = normalizedIdentity(value);
  return Boolean(identity.provider && identity.threadId && identity.streamId);
}

export class DeferredComposerTransferRegistry {
  #values = new Map();
  #claims = new Map();
  #cleanup;
  #persist;
  #ready = Promise.resolve();

  #limit;
  #ttlMs;
  #now;

  constructor({
    cleanup = async () => {},
    persist = async () => {},
    limit = 600,
    ttlMs = 24 * 60 * 60 * 1000,
    now = Date.now,
  } = {}) {
    this.#cleanup = cleanup;
    this.#persist = persist;
    this.#limit = Math.max(1, Number(limit) || 600);
    this.#ttlMs = Math.max(1, Number(ttlMs) || 24 * 60 * 60 * 1000);
    this.#now = now;
  }

  configure({ cleanup, persist } = {}) {
    if (typeof cleanup === "function") this.#cleanup = cleanup;
    if (typeof persist === "function") this.#persist = persist;
  }

  ready() {
    return this.#ready;
  }

  async restore(values, { cleanup = this.#cleanup } = {}) {
    const expired = [];
    const unfinishedCleanup = [];
    this.#values.clear();
    this.#claims.clear();
    for (const value of Array.isArray(values) ? values : []) {
      const token = String(value?.token ?? "").trim();
      const id = String(value?.id ?? "").trim();
      const identity = normalizedIdentity(value?.identity);
      const item = value?.item && typeof value.item === "object" ? structuredClone(value.item) : null;
      const expiresAtMs = Date.parse(String(value?.expiresAt ?? ""));
      if (!token || !id || !item || !validIdentity(identity) || !Number.isFinite(expiresAtMs)) continue;
      const restored = {
        token,
        id,
        identity,
        messageOrigin: normalizeInterstreamOrigin(value.messageOrigin),
        item,
        claimedBy: String(value?.claimedBy ?? value?.consumedBy ?? "").trim() || null,
        effectAccepted: value?.effectAccepted === true,
        cleanupCompleted: value?.cleanupCompleted === true,
        expiresAt: new Date(expiresAtMs).toISOString(),
      };
      if (expiresAtMs <= this.#now()) {
        if (restored.cleanupCompleted) continue;
        this.#values.set(token, restored);
        expired.push(restored);
        continue;
      }
      if (this.#values.size >= this.#limit) {
        if (!restored.cleanupCompleted) expired.push(restored.item);
        continue;
      }
      this.#values.set(token, restored);
      if (restored.effectAccepted && !restored.cleanupCompleted) unfinishedCleanup.push(restored);
    }
    this.#ready = Promise.all([
      ...expired.map(async (stored) => {
        try {
          await cleanup(stored.item);
          stored.cleanupCompleted = true;
          if (this.#values.get(stored.token) === stored) this.#values.delete(stored.token);
        } catch {
          // Retain the expired cleanup obligation durably until cleanup succeeds.
        }
      }),
      ...unfinishedCleanup.map(async (stored) => {
        try {
          await cleanup(stored.item);
          stored.cleanupCompleted = true;
        } catch {
          // Keep the durable cleanup obligation for the next restore.
        }
      }),
    ]);
    await this.#ready;
  }

  async remember(item, token) {
    await this.#ready;
    const id = String(item?.id ?? "").trim();
    const normalizedToken = String(token ?? "").trim();
    const identity = normalizedIdentity(item);
    if (!id || !normalizedToken || !validIdentity(identity)) {
      throw new Error("Некорректная identity переноса черновика");
    }
    const existing = this.#values.get(normalizedToken);
    if (existing) {
      throw new Error("Перенос черновика с этим идентификатором уже обрабатывается");
    }
    if (this.#values.size >= this.#limit) {
      throw new Error("Хранилище переносов черновика переполнено; повторите позже");
    }
    this.#values.set(normalizedToken, {
      token: normalizedToken,
      id,
      identity,
      messageOrigin: normalizeInterstreamOrigin(item.messageOrigin),
      item: structuredClone(item),
      claimedBy: null,
      effectAccepted: false,
      cleanupCompleted: false,
      expiresAt: new Date(this.#now() + this.#ttlMs).toISOString(),
    });
  }

  forget(value) {
    const token = String(value?.token ?? "").trim();
    const id = String(value?.id ?? "").trim();
    const stored = token ? this.#values.get(token) : null;
    if (!stored || stored.id !== id) return false;
    this.#values.delete(token);
    return true;
  }

  #retireExpired(token, stored) {
    this.#ready = this.#ready.catch(() => {}).then(async () => {
      if (this.#values.get(token) !== stored || Date.parse(stored.expiresAt) > this.#now()) return;
      try {
        if (!stored.cleanupCompleted) await this.#cleanup(stored.item);
        stored.cleanupCompleted = true;
        this.#values.delete(token);
        await this.#persist().catch(() => {});
      } catch {
        // A failed cleanup keeps the expired record as a durable obligation.
      }
    });
  }

  resolve(value, target, { clientUserMessageId = "" } = {}) {
    const token = String(value?.token ?? "").trim();
    const id = String(value?.id ?? "").trim();
    const stored = token ? this.#values.get(token) : null;
    const clientId = String(clientUserMessageId ?? "").trim();
    if (stored && Date.parse(stored.expiresAt) <= this.#now()) this.#retireExpired(token, stored);
    if (!stored || stored.id !== id || Date.parse(stored.expiresAt) <= this.#now()
      || !sameIdentity(stored.identity, target)
      || (stored.claimedBy && stored.claimedBy !== clientId)) return null;
    return {
      token,
      id,
      messageOrigin: stored.messageOrigin,
      consumed: stored.effectAccepted,
    };
  }

  async claim(value, target, { clientUserMessageId = "" } = {}) {
    await this.#ready;
    const token = String(value?.token ?? "").trim();
    const id = String(value?.id ?? "").trim();
    const clientId = String(clientUserMessageId ?? "").trim();
    const stored = token ? this.#values.get(token) : null;
    if (!clientId || !stored || stored.id !== id
      || Date.parse(stored.expiresAt) <= this.#now()
      || !sameIdentity(stored.identity, target)) return null;
    if (stored.claimedBy && stored.claimedBy !== clientId) return null;
    const wasClaimed = Boolean(stored.claimedBy);
    const pendingClaim = this.#claims.get(token);
    if (stored.claimedBy === clientId && pendingClaim) {
      await pendingClaim.promise;
    } else if (!stored.claimedBy) {
      stored.claimedBy = clientId;
      const claimPromise = Promise.resolve().then(() => this.#persist());
      const claim = { clientId, promise: claimPromise };
      this.#claims.set(token, claim);
      try {
        await claimPromise;
      } catch (error) {
        if (this.#values.get(token) === stored && stored.claimedBy === clientId) {
          stored.claimedBy = null;
        }
        throw error;
      } finally {
        if (this.#claims.get(token) === claim) this.#claims.delete(token);
      }
    }
    if (this.#values.get(token) !== stored || stored.claimedBy !== clientId) return null;
    return {
      token,
      id,
      messageOrigin: stored.messageOrigin,
      consumed: wasClaimed,
    };
  }

  async consume(value, { clientUserMessageId = "" } = {}) {
    await this.#ready;
    const token = String(value?.token ?? "").trim();
    const id = String(value?.id ?? "").trim();
    const clientId = String(clientUserMessageId ?? "").trim();
    const stored = token ? this.#values.get(token) : null;
    if (!stored || stored.id !== id || !clientId || stored.claimedBy !== clientId) return false;
    if (!stored.effectAccepted) {
      stored.effectAccepted = true;
      try {
        await this.#persist();
      } catch {
        stored.effectAccepted = false;
        return false;
      }
    }
    if (!stored.cleanupCompleted) {
      try {
        await this.#cleanup(stored.item);
        stored.cleanupCompleted = true;
        await this.#persist().catch(() => {});
      } catch {
        // The consumed identity remains durable and restore retries cleanup.
      }
    }
    return true;
  }

  has(value) {
    const token = String(value?.token ?? "").trim();
    const id = String(value?.id ?? "").trim();
    const stored = token ? this.#values.get(token) : null;
    if (stored && Date.parse(stored.expiresAt) <= this.#now()) this.#retireExpired(token, stored);
    return Boolean(stored && stored.id === id && Date.parse(stored.expiresAt) > this.#now());
  }

  snapshot() {
    return [...this.#values.values()]
      .filter((value) => Date.parse(value.expiresAt) > this.#now() || !value.cleanupCompleted)
      .map((value) => structuredClone(value));
  }
}
