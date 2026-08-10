import { DesktopSystemService } from "../interfaces/desktop/desktop-system-service.mjs";
import {
  createTrustedDeviceManager,
  resolveTrustedDeviceUserId,
} from "../interfaces/web/trusted-device-access.mjs";

export function createDesktopSystemComposition({
  config,
  dependencies,
}) {
  const {
    trustedDeviceStore,
    ...systemDependencies
  } = dependencies;
  function trustedDeviceUserId(context) {
    const localAndroidUserId = config.components.androidApp && !config.components.telegram
      ? "local"
      : "";
    return resolveTrustedDeviceUserId(config.allowedUserIds, context, localAndroidUserId);
  }

  const desktopSystemService = new DesktopSystemService({
    ...systemDependencies,
    trustedDeviceManager: (context) => {
      const userId = trustedDeviceUserId(context);
      const manager = createTrustedDeviceManager({
        localStore: trustedDeviceStore,
      });
      return {
        list: () => manager.list(userId),
        createPairing: () => manager.createPairing(userId),
        revoke: (deviceId) => manager.revoke(userId, deviceId),
      };
    },
  });

  return {
    trustedDeviceUserId,
    desktopStatusDetails: (...args) => desktopSystemService.statusDetails(...args),
    desktopRateLimitHistory: (...args) => desktopSystemService.rateLimitHistory(...args),
    desktopUsageHistory: (...args) => desktopSystemService.usageHistory(...args),
    desktopSearch: (...args) => desktopSystemService.search(...args),
    desktopTrustedDevices: (...args) => desktopSystemService.trustedDevices(...args),
    desktopCreateDevicePairing: (...args) => desktopSystemService.createDevicePairing(...args),
    desktopRevokeDevice: (...args) => desktopSystemService.revokeDevice(...args),
    desktopSpeakLastAnswer: (...args) => desktopSystemService.speakLastAnswer(...args),
  };
}
