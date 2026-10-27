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
    recordCommandTrace = null,
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
      recordCommandTrace,
    });
    this.publisher = null;
    this.directGateway = null;
    this.quickTunnel = null;
    this.localAddress = undefined;
    this.transportStartup = null;
    this.transportStartupGeneration = -1;
    this.transportGeneration = 0;
    this.closing = false;
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

  async startLocal() {
    if (this.localAddress !== undefined) return this.localAddress;
    this.localAddress = this.localServer ? await this.localServer.start() : null;
    return this.localAddress;
  }

  async startTransports(address = this.localAddress) {
    const generation = this.transportGeneration;
    if (this.transportStartup && this.transportStartupGeneration === generation) {
      return this.transportStartup;
    }
    this.transportStartupGeneration = generation;
    this.transportStartup = this.#startTransports(address, generation).catch((error) => {
      this.logger.warn(`Cannot start optional Web transports: ${error.message}`);
      throw error;
    });
    return this.transportStartup;
  }

  #transportActive(generation) {
    return !this.closing && generation === this.transportGeneration;
  }

  async #startTransports(address, generation) {
    if (this.sharedDashboardBotClient) {
      await this.sharedDashboardBotClient.start().catch((error) => {
        this.logger.warn(`Cannot start Shared Dashboard bot: ${error.message}`);
      });
    }
    if (!address || !this.#transportActive(generation)) return address ?? null;
    const gatewaySettings = await this.loadGatewaySettings(
      path.join(this.runtimeCommandRoot, "gateway.json"),
      { localUrl: address.url },
    );
    if (!this.#transportActive(generation)) return address;
    let preferredMenuUrl = "";
    let deferredGatewayError = null;
    if (gatewaySettings.enabled) {
      this.directGateway ??= new this.DirectGatewayControllerClass(gatewaySettings, { recordCommandTrace: this.recordCommandTrace });
      let publicUrl;
      try {
        publicUrl = await this.directGateway.start();
      } catch (error) {
        if (error?.code !== "DIRECT_GATEWAY_CONFIG_HANDOFF_REQUIRED") throw error;
        // A preserved gateway awaiting its owner does not own independent
        // Worker startup. Keep its exact failure for the startup promise below.
        deferredGatewayError = error;
      }
      if (!this.#transportActive(generation)) return address;
      if (!deferredGatewayError) {
        preferredMenuUrl = publicUrl;
        await this.configureMenu(publicUrl, this.config.miniApp.worker.menuText);
        if (!this.#transportActive(generation)) return address;
        this.logger.log(`Direct Agent Hub gateway ready at ${publicUrl}`);
      }
    }
    if (this.config.miniApp.worker.enabled) {
      this.publisher ??= new this.MiniAppPublisherClass({
        journalDatabaseFile: this.journalDatabaseFile,
        recordCommandTrace: this.recordCommandTrace,
        ...this.config.miniApp.worker,
        controlHandler: this.controlHandler,
        snapshotUserIds: [...this.config.allowedUserIds],
        controlReceiptFile: path.join(this.config.dataDir, "mini-app-control-receipts.json"),
        controlReconciler: this.controlReconciler,
        onControlResultDelivered: async ({ id }) => this.forgetControl(id),
        attachmentDirectory: path.join(this.runtimeCommandRoot, "attachments"),
        onPublished: async (url) => {
          if (!this.#transportActive(generation)) return;
          if (!preferredMenuUrl) await this.configureMenu(url, this.config.miniApp.worker.menuText);
          if (!this.#transportActive(generation)) return;
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
      if (!this.#transportActive(generation)) return address;
    }
    if (!this.config.miniApp.quickTunnel.enabled) {
      if (deferredGatewayError) throw deferredGatewayError;
      return gatewaySettings.enabled
        ? { ...address, publicUrl: gatewaySettings.publicUrl }
        : address;
    }
    const publicAddress = await this.publicServer.start();
    if (!this.#transportActive(generation)) return address;
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
        if (!this.#transportActive(generation)) return;
        if (!preferredMenuUrl) await this.configureMenu(url, this.config.miniApp.quickTunnel.menuText);
      },
    });
    const publicUrl = await this.quickTunnel.start();
    if (!this.#transportActive(generation)) return address;
    this.logger.log(`Public Agent Hub Web App ready at ${publicUrl}`);
    if (deferredGatewayError) throw deferredGatewayError;
    return { ...address, publicUrl };
  }

  async start({ waitForTransports = true } = {}) {
    if (this.closing) {
      this.closing = false;
      this.transportGeneration += 1;
      this.transportStartup = null;
      this.transportStartupGeneration = -1;
    }
    const address = await this.startLocal();
    const transports = this.startTransports(address);
    if (waitForTransports) return transports;
    void transports.catch(() => {});
    return address;
  }

  waitForTransports() { return this.transportStartup; }

  #beginClose() {
    if (!this.closing) {
      this.closing = true;
      this.transportGeneration += 1;
    }
    this.transportStartup = null;
    this.transportStartupGeneration = -1;
  }

  async closePublisher() {
    this.#beginClose();
    const publisher = this.publisher;
    await publisher?.close();
    if (this.publisher === publisher) this.publisher = null;
  }

  async closeSharedDashboardBot() {
    this.#beginClose();
    return this.sharedDashboardBotClient?.close();
  }

  async closeDirectGateway() {
    this.#beginClose();
    return this.directGateway?.close();
  }

  async closeQuickTunnel() {
    this.#beginClose();
    const tunnel = this.quickTunnel;
    await tunnel?.close();
    if (this.quickTunnel === tunnel) this.quickTunnel = null;
  }

  async closePublicServer() {
    this.#beginClose();
    return this.publicServer?.close();
  }

  async closeLocalServer() {
    this.#beginClose();
    const result = await this.localServer?.close();
    this.localAddress = undefined;
    return result;
  }
}
