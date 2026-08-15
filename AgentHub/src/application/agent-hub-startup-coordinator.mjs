import { agentHubRuntimeHealth } from "./runtime-health.mjs";

// Sequences application startup while keeping provider and transport details injected.
export class AgentHubStartupCoordinator {
  constructor({
    telegramEnabled,
    startControlPlane,
    startMiniApp,
    sanitizeRollouts,
    initializeProvider,
    providerIsRunning,
    backfillProviderMetadata,
    recoverRuns,
    retryNotifications,
    restoreBackgroundJobs,
    startTimers,
    registerTelegramCommands,
    hasPendingRestart,
    finalizeRestart,
    markReady,
    readyMessage,
    pollTelegram,
    waitForever = () => new Promise(() => {}),
    warnUser = async () => {},
    health = agentHubRuntimeHealth,
    sqliteRecovery = null,
    acknowledgeSqliteRecovery = async () => false,
    log = (...args) => console.log(...args),
    logError = (...args) => console.error(...args),
  }) {
    Object.assign(this, {
      telegramEnabled,
      startControlPlane,
      startMiniApp,
      sanitizeRollouts,
      initializeProvider,
      providerIsRunning,
      backfillProviderMetadata,
      recoverRuns,
      retryNotifications,
      restoreBackgroundJobs,
      startTimers,
      registerTelegramCommands,
      hasPendingRestart,
      finalizeRestart,
      markReady,
      readyMessage,
      pollTelegram,
      waitForever,
      warnUser,
      health,
      sqliteRecovery,
      acknowledgeSqliteRecovery,
      log,
      logError,
    });
  }

  async start() {
    this.health.begin();
    if (this.sqliteRecovery?.degraded) {
      this.health.setCapability("sqlite_recovery", {
        critical: false,
        state: "degraded",
        error: this.sqliteRecovery.message,
      });
    }
    await this.startControlPlane();
    this.health.setCapability("mini_app", { critical: false });
    try {
      const address = await this.startMiniApp();
      if (address?.url) {
        this.health.setCapability("mini_app", { critical: false, state: "ready" });
        this.log(`Mini App ready at ${address.url}`);
      } else {
        this.health.setCapability("mini_app", { critical: false, state: "disabled" });
      }
    } catch (error) {
      this.health.setCapability("mini_app", {
        critical: false,
        state: "failed",
        error: error.message,
      });
      this.logError("Cannot start Mini App:", error.message);
    }
    await this.sanitizeRollouts();
    this.health.setCapability("provider", { critical: true });
    await this.initializeProvider().catch((error) => {
      this.health.setCapability("provider", {
        critical: true,
        state: "failed",
        error: error.message,
      });
      this.logError("Cannot initialize provider during startup:", error.message);
    });
    if (!this.health.snapshot().capabilities.some((capability) => capability.name === "provider" && capability.state === "failed")) {
      this.health.setCapability("provider", { critical: true, state: "ready" });
    }
    if (this.providerIsRunning()) {
      await this.backfillProviderMetadata().catch((error) => {
        this.logError("Cannot backfill provider metadata:", error.message);
      });
    }
    await this.recoverRuns().catch(async (error) => {
      if (this.telegramEnabled) {
        this.health.setCapability("telegram", {
          critical: false,
          state: "failed",
          error: error.message,
        });
        await this.warnUser(`⚠️ Не удалось восстановить активные задачи: ${error.message}`);
      } else {
        this.health.setCapability("provider", {
          critical: true,
          state: "failed",
          error: error.message,
        });
      }
      this.logError("Cannot recover active tasks:", error.message);
    });
    if (this.telegramEnabled) {
      this.health.setCapability("telegram", { critical: false });
      await this.retryNotifications();
      await this.restoreBackgroundJobs().catch(async (error) => {
        this.health.setCapability("telegram", {
          critical: false,
          state: "failed",
          error: error.message,
        });
        this.logError("Cannot recover background jobs:", error.message);
        await this.warnUser(`⚠️ Не удалось восстановить фоновые медиа-задачи: ${error.message}`);
      });
    }
    if (!this.telegramEnabled) this.health.setCapability("telegram", { critical: false, state: "disabled" });
    this.startTimers();
    if (this.telegramEnabled) {
      await this.registerTelegramCommands().catch((error) => {
        this.health.setCapability("telegram", {
          critical: false,
          state: "failed",
          error: error.message,
        });
        this.logError("Cannot register Telegram commands:", error.message);
      });
      if (!this.health.snapshot().capabilities.some((capability) => capability.name === "telegram" && capability.state === "failed")) {
        this.health.setCapability("telegram", { critical: false, state: "ready" });
      }
    }
    if (this.hasPendingRestart()) {
      await this.finalizeRestart().catch((error) => {
        this.logError("Cannot finalize bot restart:", error.message);
        return false;
      });
    }
    await this.markReady();
    if (this.sqliteRecovery?.degraded) {
      await this.acknowledgeSqliteRecovery().catch((error) => {
        this.health.setCapability("sqlite_recovery", {
          critical: false,
          state: "degraded",
          error: `Recovery marker acknowledgement failed: ${error.message}`,
        });
      });
    }
    this.health.complete();
    const status = this.health.snapshot();
    if (status.status === "ready") this.log(this.readyMessage());
    else this.log(`Agent Hub started ${status.status}; unavailable capabilities: ${status.capabilities
      .filter((capability) => !["ready", "disabled"].includes(capability.state))
      .map((capability) => capability.name)
      .join(", ") || "unknown"}`);
    if (this.telegramEnabled) return this.pollTelegram();
    return this.waitForever();
  }
}
