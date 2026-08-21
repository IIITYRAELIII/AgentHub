import path from "node:path";

import { createWorkerTrustedDeviceStore } from "./trusted-device-access.mjs";

export class MiniAppLifecycleService {
  constructor({
    config,
    localServer,
    publicServer,
    runtimeCommandRoot,
    journalDatabaseFile,
    telegram,
    menuButtonRequests,
    loadGatewaySettings,
    DirectGatewayControllerClass,
    MiniAppPublisherClass,
    QuickTunnelControllerClass,
    controlHandler,
    controlReconciler,
    forgetControl,
    trustedDeviceStore = null,
    sharedDashboardBotClient = null,
    logger = console,
  } = {}) {
    if (!config) throw new TypeError("config is required");
    Object.assign(this, {
      config,
      localServer,
      publicServer,
      runtimeCommandRoot,
      journalDatabaseFile,
      telegram,
      menuButtonRequests,
      loadGatewaySettings,
      DirectGatewayControllerClass,
      MiniAppPublisherClass,
      QuickTunnelControllerClass,
      controlHandler,
      controlReconciler,
      forgetControl,
      trustedDeviceStore,
      sharedDashboardBotClient,
      logger,
    });
    this.publisher = null;
    this.directGateway = null;
    this.quickTunnel = null;
  }

  async configureMenu(url, text) {
    if (!this.config.components.miniApp) return;
    const requests = this.menuButtonRequests({
      url,
      text,
      chatIds: this.config.allowedUserIds,
    });
    await Promise.all(requests.map((body) => this.telegram("setChatMenuButton", body)));
  }

  async start() {
    const address = this.localServer ? await this.localServer.start() : null;
    if (this.sharedDashboardBotClient) {
      await this.sharedDashboardBotClient.start().catch((error) => {
        this.logger.warn(`Cannot start Shared Dashboard bot: ${error.message}`);
      });
    }
    if (!address) return null;
    const gatewaySettings = await this.loadGatewaySettings(
      path.join(this.runtimeCommandRoot, "gateway.json"),
      { localUrl: address.url },
    );
    let preferredMenuUrl = "";
    if (gatewaySettings.enabled) {
      this.directGateway ??= new this.DirectGatewayControllerClass(gatewaySettings);
      const publicUrl = await this.directGateway.start();
      preferredMenuUrl = publicUrl;
      await this.configureMenu(publicUrl, this.config.miniApp.worker.menuText);
      this.logger.log(`Direct Agent Hub gateway ready at ${publicUrl}`);
    }
    if (this.config.miniApp.worker.enabled) {
      this.publisher ??= new this.MiniAppPublisherClass({
        journalDatabaseFile: this.journalDatabaseFile,
        ...this.config.miniApp.worker,
        controlHandler: this.controlHandler,
        snapshotUserIds: [...this.config.allowedUserIds],
        controlReceiptFile: path.join(this.config.dataDir, "mini-app-control-receipts.json"),
        controlReconciler: this.controlReconciler,
        onControlResultDelivered: async ({ id }) => this.forgetControl(id),
        attachmentDirectory: path.join(this.runtimeCommandRoot, "attachments"),
        onPublished: async (url) => {
          if (!preferredMenuUrl) await this.configureMenu(url, this.config.miniApp.worker.menuText);
          this.logger.log(`Agent Hub Worker ready at ${url}`);
        },
      });
      if (this.trustedDeviceStore) {
        try {
          const migration = await this.trustedDeviceStore.use(
            createWorkerTrustedDeviceStore(() => this.publisher),
          );
          this.logger.log(`Trusted device registry federates Worker; migrated ${migration.migrated} local device(s)`);
          if (migration.warning) {
            this.logger.warn(`Trusted device Worker migration deferred: ${migration.warning}`);
          }
        } catch (error) {
          this.logger.warn(`Cannot attach Worker trusted device registry: ${error.message}`);
        }
      }
      await this.publisher.start().catch((error) => {
        this.logger.warn(`Cannot publish Mini App journal yet: ${error.message}`);
      });
    }
    if (!this.config.miniApp.quickTunnel.enabled) {
      return gatewaySettings.enabled
        ? { ...address, publicUrl: gatewaySettings.publicUrl }
        : address;
    }
    const publicAddress = await this.publicServer.start();
    this.quickTunnel ??= new this.QuickTunnelControllerClass({
      executable: this.config.miniApp.quickTunnel.executable,
      provider: this.config.miniApp.quickTunnel.provider,
      mode: this.config.miniApp.quickTunnel.mode,
      publicUrl: this.config.miniApp.quickTunnel.publicUrl,
      tokenFile: this.config.miniApp.quickTunnel.tokenFile,
      edgeBindAddress: this.config.miniApp.quickTunnel.edgeBindAddress,
      controlPort: this.config.miniApp.quickTunnel.controlPort,
      localUrl: publicAddress.url,
      onUrl: async (url) => {
        if (!preferredMenuUrl) await this.configureMenu(url, this.config.miniApp.quickTunnel.menuText);
      },
    });
    const publicUrl = await this.quickTunnel.start();
    this.logger.log(`Public Agent Hub Web App ready at ${publicUrl}`);
    return { ...address, publicUrl };
  }

  closePublisher() { return this.publisher?.close(); }
  closeSharedDashboardBot() { return this.sharedDashboardBotClient?.close(); }
  closeDirectGateway() { return this.directGateway?.close(); }
  closeQuickTunnel() { return this.quickTunnel?.close(); }
  closePublicServer() { return this.publicServer?.close(); }
  closeLocalServer() { return this.localServer?.close(); }
}
