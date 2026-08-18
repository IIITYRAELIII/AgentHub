import { agentHubRuntimeHealth } from "./runtime-health.mjs";

export const AGENT_HUB_STARTUP_OPERATIONS = Object.freeze([
  { id: "release", label: "Проверка установленного релиза", state: "completed" },
  { id: "configuration", label: "Загрузка конфигурации и хранилищ", state: "completed" },
  { id: "desktop-control", label: "Запуск Desktop Control" },
  { id: "runtime-command", label: "Запуск Runtime Command" },
  { id: "hub-mcp", label: "Запуск Hub MCP" },
  { id: "web", label: "Запуск Web-интерфейса" },
  { id: "history", label: "Проверка истории Codex" },
  { id: "provider", label: "Инициализация провайдера" },
  { id: "provider-metadata", label: "Восстановление метаданных провайдера" },
  { id: "runs", label: "Восстановление активных ходов" },
  { id: "notifications", label: "Повтор незавершённых уведомлений" },
  { id: "background-jobs", label: "Восстановление фоновых задач" },
  { id: "timers", label: "Запуск фоновых таймеров" },
  { id: "telegram", label: "Регистрация команд Telegram" },
  { id: "restart", label: "Завершение перезапуска" },
  { id: "readiness", label: "Подтверждение готовности" },
  { id: "recovery", label: "Подтверждение восстановления хранилища" },
]);

export class AgentHubStartupCoordinator {
  constructor({
    telegramEnabled,
    startDesktopControl,
    startRuntimeCommand,
    startHubMcp,
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
      startDesktopControl,
      startRuntimeCommand,
      startHubMcp,
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

  async #runOperation(id, operation) {
    this.health.startOperation(id);
    try {
      const result = await operation();
      this.health.completeOperation(id);
      return result;
    } catch (error) {
      this.health.failOperation(id, error);
      throw error;
    }
  }

  async start() {
    this.health.begin({ operations: AGENT_HUB_STARTUP_OPERATIONS });
    if (this.sqliteRecovery?.degraded) {
      this.health.setCapability("sqlite_recovery", {
        critical: false,
        state: "degraded",
        error: this.sqliteRecovery.message,
      });
    }

    await this.#runOperation("desktop-control", this.startDesktopControl);
    await this.#runOperation("runtime-command", this.startRuntimeCommand);
    await this.#runOperation("hub-mcp", this.startHubMcp);

    this.health.startOperation("web");
    this.health.setCapability("mini_app", { critical: false });
    try {
      const address = await this.startMiniApp();
      if (address?.url) {
        this.health.setCapability("mini_app", { critical: false, state: "ready" });
        this.log(`Mini App ready at ${address.url}`);
      } else {
        this.health.setCapability("mini_app", { critical: false, state: "disabled" });
      }
      this.health.completeOperation("web");
    } catch (error) {
      this.health.failOperation("web", error);
      this.health.setCapability("mini_app", {
        critical: false,
        state: "failed",
        error: error.message,
      });
      this.logError("Cannot start Mini App:", error.message);
    }

    await this.#runOperation("history", this.sanitizeRollouts);

    this.health.startOperation("provider");
    this.health.setCapability("provider", { critical: true });
    let providerFailed = false;
    await this.initializeProvider().catch((error) => {
      providerFailed = true;
      this.health.failOperation("provider", error);
      this.health.setCapability("provider", {
        critical: true,
        state: "failed",
        error: error.message,
      });
      this.logError("Cannot initialize provider during startup:", error.message);
    });
    let providerRunning = false;
    if (!providerFailed) {
      try {
        this.health.setCapability("provider", { critical: true, state: "ready" });
        providerRunning = this.providerIsRunning();
        this.health.completeOperation("provider");
      } catch (error) {
        this.health.failOperation("provider", error);
        this.health.setCapability("provider", {
          critical: true,
          state: "failed",
          error: error.message,
        });
        throw error;
      }
    }
    if (providerFailed || !providerRunning) {
      this.health.skipOperation("provider-metadata");
    } else {
      this.health.startOperation("provider-metadata");
      await this.backfillProviderMetadata().then(() => {
        this.health.completeOperation("provider-metadata");
      }).catch((error) => {
        this.health.failOperation("provider-metadata", error);
        this.logError("Cannot backfill provider metadata:", error.message);
      });
    }

    this.health.startOperation("runs");
    await this.recoverRuns().then(() => {
      this.health.completeOperation("runs");
    }).catch(async (error) => {
      this.health.failOperation("runs", error);
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
      this.health.startOperation("notifications");
      try {
        await this.retryNotifications();
        this.health.completeOperation("notifications");
      } catch (error) {
        this.health.failOperation("notifications", error);
        throw error;
      }
    } else {
      this.health.setCapability("telegram", { critical: false, state: "disabled" });
      this.health.skipOperation("notifications");
    }

    let backgroundFailed = false;
    if (this.telegramEnabled) {
      this.health.startOperation("background-jobs");
      await this.restoreBackgroundJobs().catch(async (error) => {
        backgroundFailed = true;
        this.health.failOperation("background-jobs", error);
        this.health.setCapability("telegram", {
          critical: false,
          state: "failed",
          error: error.message,
        });
        this.logError("Cannot recover background jobs:", error.message);
        await this.warnUser(`⚠️ Не удалось восстановить фоновые медиа-задачи: ${error.message}`);
      });
    } else {
      this.health.skipOperation("background-jobs");
    }
    if (this.telegramEnabled && !backgroundFailed) this.health.completeOperation("background-jobs");

    await this.#runOperation("timers", async () => this.startTimers());

    if (this.telegramEnabled) {
      this.health.startOperation("telegram");
      await this.registerTelegramCommands().then(() => {
        this.health.completeOperation("telegram");
      }).catch((error) => {
        this.health.failOperation("telegram", error);
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
    } else {
      this.health.skipOperation("telegram");
    }

    if (this.hasPendingRestart()) {
      await this.#runOperation("restart", this.finalizeRestart);
    } else {
      this.health.skipOperation("restart");
    }

    await this.#runOperation("readiness", this.markReady);

    if (this.sqliteRecovery?.degraded) {
      this.health.startOperation("recovery");
      await this.acknowledgeSqliteRecovery().then(() => {
        this.health.completeOperation("recovery");
      }).catch((error) => {
        this.health.failOperation("recovery", error);
        this.health.setCapability("sqlite_recovery", {
          critical: false,
          state: "degraded",
          error: `Recovery marker acknowledgement failed: ${error.message}`,
        });
      });
    } else {
      this.health.skipOperation("recovery");
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
