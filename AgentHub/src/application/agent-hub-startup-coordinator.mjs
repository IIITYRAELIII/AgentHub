import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { agentHubRuntimeHealth } from "./runtime-health.mjs";

let activeStartupCoordinator = null;

export function retryAgentHubStartup(params) {
  if (!activeStartupCoordinator) throw new Error("Координатор запуска ещё недоступен");
  return activeStartupCoordinator.requestRetry(params);
}

export const AGENT_HUB_STARTUP_OPERATIONS = Object.freeze([
  { id: "release", label: "Проверка установленного релиза", state: "completed" },
  { id: "configuration", label: "Загрузка конфигурации и хранилищ", state: "completed" },
  { id: "web", label: "Запуск Web-интерфейса" },
  { id: "desktop-control", label: "Запуск Desktop Control" },
  { id: "runtime-command", label: "Запуск Runtime Command" },
  { id: "hub-mcp", label: "Запуск Hub MCP" },
  { id: "history", label: "Проверка истории Codex" },
  { id: "provider", label: "Инициализация провайдера" },
  { id: "provider-metadata", label: "Восстановление метаданных провайдера" },
  { id: "runs", label: "Восстановление активных ходов" },
  { id: "notifications", label: "Повтор незавершённых уведомлений" },
  { id: "background-jobs", label: "Восстановление фоновых операций" },
  { id: "timers", label: "Запуск фоновых таймеров" },
  { id: "telegram", label: "Регистрация команд Telegram" },
  { id: "restart", label: "Завершение перезапуска" },
  { id: "readiness", label: "Подтверждение готовности" },
  { id: "recovery", label: "Подтверждение восстановления хранилища" },
]);

export class AgentHubStartupCoordinator {
  #initialStartupFinished = false;
  #retryPromise = null;
  #metadataPromise = null;
  #metadataAbort = null;

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
    captureException = () => false,
    commandTrace = null,
    startupTraceId = randomUUID(),
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
      captureException,
      log,
      logError,
    });
    // Wrap the existing awaited ports, keeping their order and failure handling.
    // Recording the start separately makes a never-settled port observable.
    for (const [name, stage] of [
      ["startMiniApp", "web"], ["startDesktopControl", "desktop-control"],
      ["startRuntimeCommand", "runtime-command"], ["startHubMcp", "hub-mcp"],
      ["sanitizeRollouts", "history"], ["initializeProvider", "provider"],
      ["backfillProviderMetadata", "provider-metadata"], ["recoverRuns", "runs"],
      ["retryNotifications", "notifications"], ["restoreBackgroundJobs", "background-jobs"],
      ["registerTelegramCommands", "telegram"], ["finalizeRestart", "restart"],
      ["markReady", "readiness"], ["startTimers", "timers"],
      ["acknowledgeSqliteRecovery", "recovery"],
    ]) {
      const operation = this[name];
      if (commandTrace?.measureBestEffort && typeof operation === "function") {
        this[name] = (...args) => commandTrace.measureBestEffort({
          commandId: `startup:${startupTraceId}`, stage: `startup-${stage}`,
          transport: "server-runtime", metadata: { startupTraceId, operationId: stage },
        }, () => operation(...args));
      }
    }
  }

  #capture(error, action) {
    try {
      this.captureException(error, {
        surface: "server",
        kind: "startup",
        component: "startup-coordinator",
        action,
      });
    } catch {}
  }

  async #runOperation(id, operation) {
    this.health.startOperation(id);
    try {
      const result = await operation();
      this.health.completeOperation(id);
      return result;
    } catch (error) {
      this.health.failOperation(id, error);
      this.#capture(error, id);
      throw error;
    }
  }

  async start() {
    activeStartupCoordinator = this;
    this.health.begin({ operations: AGENT_HUB_STARTUP_OPERATIONS });
    if (this.sqliteRecovery?.degraded) {
      this.health.setCapability("sqlite_recovery", {
        critical: false,
        state: "degraded",
        error: this.sqliteRecovery.message,
      });
    }

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
      this.#capture(error, "web");
      this.health.setCapability("mini_app", {
        critical: false,
        state: "failed",
        error: error.message,
      });
      this.logError("Cannot start Mini App:", error.message);
    }

    await this.#runOperation("desktop-control", this.startDesktopControl);
    await this.#runOperation("runtime-command", this.startRuntimeCommand);
    await this.#runOperation("hub-mcp", this.startHubMcp);

    await this.#runOperation("history", this.sanitizeRollouts);

    this.health.startOperation("provider");
    this.health.setCapability("provider", { critical: true });
    let providerFailed = false;
    await this.initializeProvider().catch((error) => {
      providerFailed = true;
      this.health.failOperation("provider", error);
      this.#capture(error, "provider");
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
        this.#capture(error, "provider-status");
        this.health.setCapability("provider", {
          critical: true,
          state: "failed",
          error: error.message,
        });
        throw error;
      }
    }
    // Optional catalog/pricing repair runs after readiness, never in the restart barrier.
    this.health.skipOperation("provider-metadata");

    this.health.startOperation("runs");
    await this.recoverRuns().then(() => {
      this.health.completeOperation("runs");
    }).catch(async (error) => {
      this.health.failOperation("runs", error);
      this.#capture(error, "runs");
      if (this.telegramEnabled) {
        this.health.setCapability("telegram", {
          critical: false,
          state: "failed",
          error: error.message,
        });
        await this.warnUser(`⚠️ Не удалось восстановить активные потоки: ${error.message}`);
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
        this.#capture(error, "notifications");
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
        this.#capture(error, "background-jobs");
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

    if (this.telegramEnabled) {
      this.health.startOperation("telegram");
      await this.registerTelegramCommands().then(() => {
        this.health.completeOperation("telegram");
      }).catch((error) => {
        this.health.failOperation("telegram", error);
        this.#capture(error, "telegram");
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

    await this.#runOperation("timers", async () => this.startTimers());

    if (this.sqliteRecovery?.degraded) {
      this.health.startOperation("recovery");
      await this.acknowledgeSqliteRecovery().then(() => {
        this.health.completeOperation("recovery");
      }).catch((error) => {
        this.health.failOperation("recovery", error);
        this.#capture(error, "recovery");
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
    this.#initialStartupFinished = true;
    if (!providerFailed && providerRunning) this.#startMetadataBackfill();
    const status = this.health.snapshot();
    if (status.status === "ready") this.log(this.readyMessage());
    else this.log(`Agent Hub started ${status.status}; unavailable capabilities: ${status.capabilities
      .filter((capability) => !["ready", "disabled"].includes(capability.state))
      .map((capability) => capability.name)
      .join(", ") || "unknown"}`);
    if (this.telegramEnabled) return this.pollTelegram();
    return this.waitForever();
  }

  #startMetadataBackfill() {
    if (this.#metadataPromise) return this.#metadataPromise;
    const operation = this.health.snapshot().startup.operations.find((entry) => entry.id === "provider-metadata");
    if (!["failed", "skipped"].includes(operation?.state)) return Promise.resolve();
    this.#metadataAbort = new AbortController();
    this.health.retryOperation("provider-metadata", { background: true });
    this.#metadataPromise = setImmediate(undefined, { signal: this.#metadataAbort.signal }).then(() => this.backfillProviderMetadata({
      signal: this.#metadataAbort.signal,
    })).then(() => {
      this.health.completeOperation("provider-metadata");
    }).catch((error) => {
      this.health.failOperation("provider-metadata", error);
      this.#capture(error, "provider-metadata");
      this.logError("Cannot backfill provider metadata:", error.message);
    }).finally(() => { this.#metadataPromise = null; });
    return this.#metadataPromise;
  }

  stopBackgroundWork() {
    this.#metadataAbort?.abort();
  }

  async waitForBackgroundWork() {
    await this.#metadataPromise;
  }

  requestRetry({ startedAtMs } = {}) {
    const snapshot = this.health.snapshot();
    if (Number(startedAtMs) !== snapshot.startup?.startedAtMs) {
      throw new Error("Процесс Хаба уже сменился. Обновите состояние запуска.");
    }
    if (!this.#initialStartupFinished) throw new Error("Первичный запуск ещё выполняется. Можно перезапустить Хаб.");
    const retryableIds = new Set(["provider", "provider-metadata", "runs", "notifications", "background-jobs", "telegram", "recovery"]);
    const failed = snapshot.startup.operations.filter((operation) => operation.state === "failed");
    if (!this.#retryPromise && failed.length && !failed.some((operation) => retryableIds.has(operation.id))) {
      throw new Error("Оставшиеся инфраструктурные этапы требуют перезапуска Хаба.");
    }
    if (!this.#retryPromise) {
      this.#retryPromise = this.#retryFailed().finally(() => { this.#retryPromise = null; });
      void this.#retryPromise.catch((error) => this.logError("Cannot retry startup:", error.message));
    }
    return { accepted: true, message: "Повтор неудачных этапов запущен" };
  }

  async waitForRetry() {
    await this.#retryPromise;
  }

  async #retryFailed() {
    const operations = this.health.snapshot().startup.operations;
    const providerRetry = operations.some((operation) => operation.id === "provider" && operation.state === "failed");
    const retryable = [
      ["provider", this.initializeProvider, "provider"],
      ["provider-metadata", this.backfillProviderMetadata],
      ["runs", this.recoverRuns, "provider"],
      ["notifications", this.retryNotifications, "telegram"],
      ["background-jobs", this.restoreBackgroundJobs, "telegram"],
      ["telegram", this.registerTelegramCommands, "telegram"],
      ["recovery", this.acknowledgeSqliteRecovery, "sqlite_recovery"],
    ];
    try {
      for (const [id, run, capability] of retryable) {
        const operation = operations.find((entry) => entry.id === id);
        if (operation?.state !== "failed"
          && !(id === "provider-metadata" && providerRetry && operation?.state === "skipped")) continue;
        if (["provider-metadata", "runs"].includes(id) && !this.providerIsRunning()) continue;
        if (id === "provider-metadata") {
          this.#startMetadataBackfill();
          continue;
        }
        this.health.retryOperation(id);
        if (capability) this.health.setCapability(capability, { critical: capability === "provider" });
        try {
          await run();
          if (id === "provider" && !this.providerIsRunning()) throw new Error("Процесс Codex не запущен");
          this.health.completeOperation(id);
          if (capability) {
            const related = retryable.filter((entry) => entry[2] === capability).map((entry) => entry[0]);
            const failure = this.health.snapshot().startup.operations.find((entry) => related.includes(entry.id) && entry.state === "failed");
            this.health.setCapability(capability, {
              critical: capability === "provider", state: failure ? "failed" : "ready", error: failure?.error,
            });
          }
        } catch (error) {
          this.health.failOperation(id, error);
          this.#capture(error, `retry-${id}`);
          if (capability) this.health.setCapability(capability, { critical: capability === "provider", state: "failed", error: error.message });
        }
      }
    } finally {
      this.health.complete();
    }
  }
}
