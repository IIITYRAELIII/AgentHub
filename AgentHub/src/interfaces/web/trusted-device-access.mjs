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

  constructor(store) {
    this.#localStore = requiredStore(store);
  }

  async use(store) {
    const nextStore = requiredStore(store);
    if (nextStore === this.#workerStore) return { migrated: 0 };
    this.#workerStore = nextStore;
    const devices = typeof this.#localStore.exportActiveDevices === "function"
      ? await this.#localStore.exportActiveDevices()
      : [];
    if (!devices.length) return { migrated: 0 };
    if (typeof nextStore.importDevices !== "function") {
      return { migrated: 0, warning: "Worker не поддерживает импорт доверенных устройств" };
    }
    try {
      const result = await nextStore.importDevices(devices, { timeoutMs: WORKER_DEVICE_TIMEOUT_MS });
      return { migrated: Number(result?.imported ?? devices.length) };
    } catch (error) {
      return { migrated: 0, warning: String(error?.message ?? error) };
    }
  }

  async list(userId) {
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

  async revoke(userId, deviceId) {
    const stores = [this.#localStore, this.#workerStore].filter(Boolean);
    const results = await Promise.allSettled(stores.map((store) => store.revoke(
      userId,
      deviceId,
      { timeoutMs: WORKER_DEVICE_TIMEOUT_MS },
    )));
    const unexpectedFailure = results.find(
      (result) => result.status === "rejected" && !deviceNotFound(result.reason),
    );
    if (unexpectedFailure) throw unexpectedFailure.reason;
    const success = results.find((result) => result.status === "fulfilled");
    if (!success) throw results[0].reason;
    return success.value;
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
  const sessions = new Map();
  const rememberSession = (token, identity, expiresAt) => {
    sessions.set(String(token), { ...identity, expiresAt: Number(expiresAt) || 0 });
    return identity;
  };
  return {
    list: (userId, options) => currentPublisher().trustedDevices(userId, options),
    createPairing: (userId, options) => currentPublisher().createDevicePairing(userId, options),
    async revoke(userId, deviceId, options) {
      const result = await currentPublisher().revokeDevice(userId, deviceId, options);
      for (const [token, session] of sessions) {
        if (session.deviceId === deviceId) sessions.delete(token);
      }
      return result;
    },
    pair: (payload) => currentPublisher().pairDevice(payload),
    createChallenge: (payload) => currentPublisher().createDeviceChallenge(payload),
    async createSession(payload) {
      const result = await currentPublisher().createDeviceSession(payload);
      const identity = await currentPublisher().resolveDeviceSession(result.token);
      rememberSession(result.token, identity, result.expiresAt);
      return result;
    },
    async resolveSession(token) {
      const cached = sessions.get(String(token));
      if (cached && cached.expiresAt > Date.now()) {
        const { expiresAt: _expiresAt, ...identity } = cached;
        return identity;
      }
      const identity = await currentPublisher().resolveDeviceSession(token);
      return rememberSession(token, identity, Date.now() + 60_000);
    },
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
