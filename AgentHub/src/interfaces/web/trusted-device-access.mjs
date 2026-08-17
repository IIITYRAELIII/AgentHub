export function resolveTrustedDeviceUserId(
  allowedUserIds,
  context = null,
  localAndroidUserId = "",
) {
  const requested = String(context?.userId ?? "").trim();
  const allowed = [...(allowedUserIds ?? [])].map(String);
  const localUserId = String(localAndroidUserId ?? "").trim();
  const userId = requested || allowed[0] || localUserId;
  if (!userId || (!allowed.includes(userId) && userId !== localUserId)) {
    throw new Error("Пользователь устройства не разрешён");
  }
  return userId;
}

function requiredStore(store) {
  if (!store) throw new Error("Хранилище доверенных устройств недоступно");
  return store;
}

const WORKER_DEVICE_TIMEOUT_MS = 3_000;

function deviceTimestamp(device) {
  return Number(device?.lastSeenAt ?? device?.createdAt ?? 0);
}

function mergeDeviceRecords(results) {
  const devices = new Map();
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    for (const device of result.value?.devices ?? []) {
      const id = String(device?.id ?? "").trim().toLowerCase();
      if (!id) continue;
      const current = devices.get(id);
      if (!current) {
        devices.set(id, device);
        continue;
      }
      const newest = deviceTimestamp(device) >= deviceTimestamp(current) ? device : current;
      devices.set(id, {
        ...current,
        ...newest,
        lastSeenAt: Math.max(Number(current.lastSeenAt) || 0, Number(device.lastSeenAt) || 0) || null,
        revokedAt: Math.max(Number(current.revokedAt) || 0, Number(device.revokedAt) || 0) || null,
      });
    }
  }
  return [...devices.values()].sort((left, right) => deviceTimestamp(right) - deviceTimestamp(left));
}

function deviceNotFound(error) {
  return /device not found|устройство не найдено/iu.test(String(error?.message ?? error));
}

export class TrustedDeviceRegistry {
  #localStore;
  #workerStore = null;
  #reconciliation = null;

  constructor(store) {
    this.#localStore = requiredStore(store);
  }

  /**
   * Replays revocations the Worker has not confirmed yet. A device revoked while
   * the Worker was unreachable must not stay trusted there, so every attach,
   * listing and revoke drains the queue again.
   */
  async #reconcileRevocations() {
    if (!this.#workerStore
      || typeof this.#localStore.exportPendingRevocations !== "function") return { revoked: 0, pending: 0 };
    const pending = await this.#localStore.exportPendingRevocations();
    let revoked = 0;
    let unconfirmed = 0;
    for (const device of pending) {
      try {
        await this.#workerStore.revoke(device.userId, device.id, { timeoutMs: WORKER_DEVICE_TIMEOUT_MS });
        await this.#localStore.confirmFederatedRevocation(device.id);
        revoked += 1;
      } catch (error) {
        if (deviceNotFound(error)) {
          // The Worker never learned about this device, so nothing can be trusted there.
          await this.#localStore.confirmFederatedRevocation(device.id);
          revoked += 1;
          continue;
        }
        unconfirmed += 1;
      }
    }
    return { revoked, pending: unconfirmed };
  }

  #reconcileOnce() {
    this.#reconciliation ??= this.#reconcileRevocations()
      .catch(() => ({ revoked: 0, pending: 0 }))
      .finally(() => {
        this.#reconciliation = null;
      });
    return this.#reconciliation;
  }

  async use(store) {
    const nextStore = requiredStore(store);
    if (nextStore === this.#workerStore) return { migrated: 0 };
    this.#workerStore = nextStore;
    const reconciled = await this.#reconcileOnce();
    const devices = typeof this.#localStore.exportActiveDevices === "function"
      ? await this.#localStore.exportActiveDevices()
      : [];
    const unconfirmed = reconciled.pending > 0
      ? { warning: `Worker не подтвердил отзыв устройств: ${reconciled.pending}` }
      : {};
    if (!devices.length) return { migrated: 0, ...unconfirmed };
    if (typeof nextStore.importDevices !== "function") {
      return { migrated: 0, warning: "Worker не поддерживает импорт доверенных устройств" };
    }
    try {
      const result = await nextStore.importDevices(devices, { timeoutMs: WORKER_DEVICE_TIMEOUT_MS });
      return { migrated: Number(result?.imported ?? devices.length), ...unconfirmed };
    } catch (error) {
      return { migrated: 0, warning: String(error?.message ?? error) };
    }
  }

  async list(userId) {
    void this.#reconcileOnce();
    const requests = [this.#localStore.list(userId)];
    if (this.#workerStore) {
      requests.push(this.#workerStore.list(userId, { timeoutMs: WORKER_DEVICE_TIMEOUT_MS }));
    }
    const results = await Promise.allSettled(requests);
    const available = results.filter((result) => result.status === "fulfilled");
    if (!available.length) throw results[0].reason;
    return {
      devices: mergeDeviceRecords(results),
      partial: available.length !== results.length,
    };
  }

  async createPairing(userId) {
    const pairing = await this.#localStore.createPairing(userId);
    if (!this.#workerStore) return { ...pairing, workerAvailable: false };
    try {
      await this.#workerStore.createPairing(userId, {
        code: pairing.code,
        timeoutMs: WORKER_DEVICE_TIMEOUT_MS,
      });
      return { ...pairing, workerAvailable: true };
    } catch {
      return { ...pairing, workerAvailable: false };
    }
  }

  /**
   * The local store is authoritative: once it has revoked the device the call
   * succeeds even when the Worker is unreachable, and the queued revocation is
   * replayed later instead of being reported as a failed revoke.
   */
  async revoke(userId, deviceId) {
    const local = await this.#localStore.revoke(userId, deviceId).catch((error) => {
      if (deviceNotFound(error) && this.#workerStore) return null;
      throw error;
    });
    if (!this.#workerStore) return local ?? { device: { id: deviceId } };
    try {
      const worker = await this.#workerStore.revoke(userId, deviceId, {
        timeoutMs: WORKER_DEVICE_TIMEOUT_MS,
      });
      if (local) await this.#localStore.confirmFederatedRevocation(deviceId).catch(() => {});
      return local ?? worker;
    } catch (error) {
      if (deviceNotFound(error)) {
        if (local) await this.#localStore.confirmFederatedRevocation(deviceId).catch(() => {});
        if (local) return local;
        throw error;
      }
      if (!local) throw error;
      return { ...local, workerPending: true };
    }
  }

  pair(payload) { return this.#localStore.pair(payload); }
  createChallenge(payload) { return this.#localStore.createChallenge(payload); }
  createSession(payload) { return this.#localStore.createSession(payload); }
  resolveSession(token) { return this.#localStore.resolveSession(token); }
}

export function createWorkerTrustedDeviceStore(publisher) {
  const currentPublisher = () => requiredStore(
    typeof publisher === "function" ? publisher() : publisher,
  );
  return {
    list: (userId, options) => currentPublisher().trustedDevices(userId, options),
    createPairing: (userId, options) => currentPublisher().createDevicePairing(userId, options),
    revoke: (userId, deviceId, options) => currentPublisher().revokeDevice(userId, deviceId, options),
    pair: (payload) => currentPublisher().pairDevice(payload),
    createChallenge: (payload) => currentPublisher().createDeviceChallenge(payload),
    createSession: (payload) => currentPublisher().createDeviceSession(payload),
    // Sessions are never cached locally: a revoked device must lose access at the
    // next request instead of surviving inside a stale identity window.
    resolveSession: (token) => currentPublisher().resolveDeviceSession(token),
    async importDevices(devices, options) {
      const grouped = Map.groupBy(devices, (device) => String(device.userId));
      let imported = 0;
      for (const [userId, records] of grouped) {
        const result = await currentPublisher().importDevices(userId, records, options);
        imported += Number(result?.imported ?? 0);
      }
      return { imported };
    },
  };
}

export function createTrustedDeviceManager({ localStore } = {}) {
  const store = requiredStore(localStore);
  return {
    list: (userId) => store.list(userId),
    createPairing: (userId) => store.createPairing(userId),
    revoke: (userId, deviceId) => store.revoke(userId, deviceId),
  };
}
