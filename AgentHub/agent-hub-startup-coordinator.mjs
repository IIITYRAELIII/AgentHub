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
      log,
      logError,
    });
  }

  async start() {
    await this.startControlPlane();
    try {
      const address = await this.startMiniApp();
      if (address?.url) this.log(`Mini App ready at ${address.url}`);
    } catch (error) {
      this.logError("Cannot start Mini App:", error.message);
    }
    await this.sanitizeRollouts();
    await this.initializeProvider().catch((error) => {
      this.logError("Cannot initialize provider during startup:", error.message);
    });
    if (this.providerIsRunning()) {
      await this.backfillProviderMetadata().catch((error) => {
        this.logError("Cannot backfill provider metadata:", error.message);
      });
    }
    if (this.telegramEnabled) {
      await this.recoverRuns().catch(async (error) => {
        this.logError("Cannot recover active tasks:", error.message);
        await this.warnUser(`⚠️ Не удалось восстановить активные задачи: ${error.message}`);
      });
      await this.retryNotifications();
      await this.restoreBackgroundJobs().catch(async (error) => {
        this.logError("Cannot recover background jobs:", error.message);
        await this.warnUser(`⚠️ Не удалось восстановить фоновые медиа-задачи: ${error.message}`);
      });
    }
    this.startTimers();
    if (this.telegramEnabled) {
      await this.registerTelegramCommands().catch((error) => {
        this.logError("Cannot register Telegram commands:", error.message);
      });
    }
    if (this.hasPendingRestart()) {
      await this.finalizeRestart().catch((error) => {
        this.logError("Cannot finalize bot restart:", error.message);
        return false;
      });
    }
    await this.markReady();
    this.log(this.readyMessage());
    if (this.telegramEnabled) return this.pollTelegram();
    return this.waitForever();
  }
}
