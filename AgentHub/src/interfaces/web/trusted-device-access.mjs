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

export function createTrustedDeviceManager({ workerEnabled = false, publisher = null, localStore } = {}) {
  if (workerEnabled) {
    if (!publisher) throw new Error("Доверенные устройства недоступны без Mini App Worker publisher");
    return {
      list: (userId) => publisher.trustedDevices(userId),
      createPairing: (userId) => publisher.createDevicePairing(userId),
      revoke: (userId, deviceId) => publisher.revokeDevice(userId, deviceId),
    };
  }
  if (!localStore) throw new Error("Локальное хранилище доверенных устройств недоступно");
  return {
    list: (userId) => localStore.list(userId),
    createPairing: (userId) => localStore.createPairing(userId),
    revoke: (userId, deviceId) => localStore.revoke(userId, deviceId),
  };
}
