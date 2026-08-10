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

export class TrustedDeviceRegistry {
  #store;

  constructor(store) {
    this.#store = requiredStore(store);
  }

  async use(store) {
    const nextStore = requiredStore(store);
    if (nextStore === this.#store) return { migrated: 0 };
    const devices = typeof this.#store.exportActiveDevices === "function"
      ? await this.#store.exportActiveDevices()
      : [];
    if (devices.length) {
      if (typeof nextStore.importDevices !== "function") {
        throw new Error("Новое хранилище не поддерживает миграцию доверенных устройств");
      }
      await nextStore.importDevices(devices);
    }
    this.#store = nextStore;
    return { migrated: devices.length };
  }

  list(userId) { return this.#store.list(userId); }
  createPairing(userId) { return this.#store.createPairing(userId); }
  revoke(userId, deviceId) { return this.#store.revoke(userId, deviceId); }
  pair(payload) { return this.#store.pair(payload); }
  createChallenge(payload) { return this.#store.createChallenge(payload); }
  createSession(payload) { return this.#store.createSession(payload); }
  resolveSession(token) { return this.#store.resolveSession(token); }
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
    list: (userId) => currentPublisher().trustedDevices(userId),
    createPairing: (userId) => currentPublisher().createDevicePairing(userId),
    async revoke(userId, deviceId) {
      const result = await currentPublisher().revokeDevice(userId, deviceId);
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
    async importDevices(devices) {
      const grouped = Map.groupBy(devices, (device) => String(device.userId));
      let imported = 0;
      for (const [userId, records] of grouped) {
        const result = await currentPublisher().importDevices(userId, records);
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
