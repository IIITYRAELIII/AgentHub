import { randomUUID } from "node:crypto";
import { setImmediate, setTimeout } from "node:timers/promises";
import { agentHubRuntimeHealth } from "./runtime-health.mjs";

const TELEGRAM_COMMAND_RETRY_DELAYS_MS = [500, 2_000, 10_000, 30_000];

let activeStartupCoordinator = null;

export function retryAgentHubStartup(params) {
  if (!activeStartupCoordinator) throw new Error("Координатор запуска ещё недоступен");
  return activeStartupCoordinator.requestRetry(params);
}

// Called only by the real lifecycle after successful initialize. It is not a
// second retry owner and never resubmits provider/metadata/recovery commands.
export function observeAgentHubProviderInitialized() {
  activeStartupCoordinator?.providerInitialized();
}

export function observeAgentHubProviderInitializing() {
  activeStartupCoordinator?.providerInitializing();
}

export function observeAgentHubProviderInitializationFailure(error) {
  activeStartupCoordinator?.providerInitializationFailed(error);
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
  { id: "notifications", label: "Сверка квитанций команд" },
  { id: "terminal-projections", label: "Восстановление проекций завершённых ходов", background: true },
  { id: "telegram-delivery", label: "Доставка завершённых ходов в Telegram", background: true },
  { id: "background-jobs", label: "Восстановление фоновых операций" },
  { id: "timers", label: "Запуск фоновых таймеров" },
  { id: "telegram", label: "Регистрация команд Telegram", background: true },
  { id: "restart", label: "Завершение перезапуска" },
  { id: "readiness", label: "Подтверждение готовности" },
  { id: "recovery", label: "Подтверждение восстановления хранилища" },
]);

export class AgentHubStartupCoordinator {
  #initialStartupFinished = false;
  #retryPromise = null;
  #metadataPromise = null;
  #metadataAbort = null;
  #notificationAbort = null;
  #notificationRecovery = null;
  #providerInitializeObserved = false;
  #providerUpdatePending = false;

  constructor({
    telegramEnabled,
    startDesktopControl,
    startRuntimeCommand,
    startHubMcp,
    startMiniApp,
    startMiniAppTransports = null,
    sanitizeRollouts,
    initializeProvider,
    providerIsRunning,
    backfillProviderMetadata,
    prepareStartupCommandAdmission = async () => {},
    retryTerminalProjections,
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
      startMiniAppTransports,
      sanitizeRollouts,
      initializeProvider,
      providerIsRunning,
      backfillProviderMetadata,
      prepareStartupCommandAdmission,
      retryTerminalProjections,
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
      startupTraceId,
      log,
      logError,
    });
    if (commandTrace?.measureBestEffort && typeof startDesktopControl === "function") {
      this.startDesktopControl = () => startDesktopControl((phase, operation) => commandTrace.measureBestEffort({
        commandId: `startup:${startupTraceId}`, stage: `startup-desktop-control-${phase}`, transport: "server-runtime",
        metadata: { startupTraceId, operationId: "desktop-control" },
      }, operation));
    }
    // Wrap the existing awaited ports, keeping their order and failure handling.
    // Recording the start separately makes a never-settled port observable.
    for (const [name, stage, action] of [
      ["startMiniApp", "web"], ["startDesktopControl", "desktop-control"],
      ["startRuntimeCommand", "runtime-command"], ["startHubMcp", "hub-mcp"],
      ["sanitizeRollouts", "history"], ["initializeProvider", "provider"],
      ["backfillProviderMetadata", "provider-metadata"],
      ["prepareStartupCommandAdmission", "notifications", "terminal-admission"],
      ["retryTerminalProjections", "notifications", "terminal-projections"],
      ["retryNotifications", "notifications", "telegram-delivery"],
      ["restoreBackgroundJobs", "background-jobs"],
      ["registerTelegramCommands", "telegram"], ["finalizeRestart", "restart"],
      ["markReady", "readiness"], ["startTimers", "timers"],
      ["acknowledgeSqliteRecovery", "recovery"],
    ]) {
      const operation = this[name];
      if (commandTrace?.measureBestEffort && typeof operation === "function") {
        this[name] = (...args) => {
          const startedAtMs = Date.now();
          const metadata = { startupTraceId, operationId: stage, ...(action ? { action } : {}) };
          return commandTrace.measureBestEffort({
            commandId: `startup:${startupTraceId}`, stage: `startup-${stage}`,
            transport: "server-runtime", metadata,
          }, async () => {
            try { return await operation(...args); }
            finally {
              if (stage === "provider") {
                try {
                  const selection = health.readDiagnostic("codexExecutableUpdate")?.startupSelection;
                  if (selection?.startedAtMs >= startedAtMs && selection.outcome) {
                    const { previousAttempt, ...current } = selection;
                    metadata.codexSelection = current;
                    if (previousAttempt?.startedAtMs >= startedAtMs) current.previousAttempt = previousAttempt;
                  }
                } catch { /* Diagnostics cannot change the provider outcome. */ }
              }
            }
          });
        };
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

    if (this.telegramEnabled) this.health.setCapability("telegram", { critical: false });
    else this.health.setCapability("telegram", { critical: false, state: "disabled" });
    this.health.startOperation("notifications");
    try {
      await this.prepareStartupCommandAdmission({ startupTraceId: this.startupTraceId });
      this.health.completeOperation("notifications");
    } catch (error) {
      this.health.failOperation("notifications", error);
      this.#capture(error, "notifications");
      throw error;
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

    if (this.telegramEnabled && !backgroundFailed) {
      this.health.setCapability("telegram", { critical: false, state: "ready" });
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
    if (this.startMiniAppTransports) {
      void this.startMiniAppTransports().catch(error => this.#capture(error, "web-transports"));
    }
    this.#startNotificationRecovery();
    if (this.#providerInitializeObserved) this.providerInitialized();
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

  providerInitializing() {
    if (!this.#initialStartupFinished) return;
    this.#providerUpdatePending = true;
    this.health.setCapability("provider", { critical: true, state: "pending" });
  }

  providerInitializationFailed(error) {
    if (!this.#initialStartupFinished || !this.#providerUpdatePending) return;
    this.health.setCapability("provider", { critical: true, state: "failed", error: error.message });
  }

  providerInitialized() {
    this.#providerInitializeObserved = true;
    if (!this.#initialStartupFinished || !this.providerIsRunning()) return;
    const snapshot = this.health.snapshot();
    const operation = snapshot.startup.operations.find(entry => entry.id === "provider");
    if (operation?.state !== "failed" && !this.#providerUpdatePending) return;
    if (operation?.state === "failed") {
      this.health.retryOperation("provider", { background: true });
      this.health.completeOperation("provider");
    }
    this.#providerUpdatePending = false;
    this.health.setCapability("provider", { critical: true, state: "ready" });
    this.#startMetadataBackfill();
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

  #startNotificationRecovery() {
    if (this.#notificationRecovery) return;
    this.#notificationAbort = new AbortController();
    const signal = this.#notificationAbort.signal;
    const operations = [["terminal-projections",
      () => this.retryTerminalProjections({ startupTraceId: this.startupTraceId, signal })]];
    if (this.telegramEnabled) {
      operations.push(
        ["telegram-delivery", () => this.retryNotifications({ startupTraceId: this.startupTraceId, signal })],
        ["telegram", () => this.#registerTelegramWithRetry(signal)],
      );
    } else {
      this.health.skipOperation("telegram-delivery");
      this.health.skipOperation("telegram");
    }
    this.#notificationRecovery = setImmediate(undefined, { signal }).then(() =>
      Promise.all(operations.map(async ([id, recover]) => {
        this.health.startOperation(id, { background: true });
        try {
          await recover();
          this.health.completeOperation(id);
        } catch (error) {
          if (signal.aborted) {
            this.health.skipOperation(id);
            return;
          }
          this.health.failOperation(id, error);
          this.#capture(error, id);
          this.logError(`Cannot recover ${id}:`, error.message);
        }
      }))
    ).catch((error) => {
      if (!signal.aborted) this.logError("Cannot start notification recovery:", error.message);
    }).finally(() => { this.#notificationRecovery = null; });
  }

  async #registerTelegramWithRetry(signal) {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      try {
        return await this.registerTelegramCommands({ signal });
      } catch (error) {
        signal?.throwIfAborted();
        const backoffMs = TELEGRAM_COMMAND_RETRY_DELAYS_MS[attempt];
        const retryAfterMs = Number(error?.retryAfterMs);
        if (error?.retryable !== true || backoffMs === undefined
          || retryAfterMs > 2_147_483_647) throw error;
        const waitMs = Math.max(backoffMs, Number.isFinite(retryAfterMs) ? retryAfterMs : 0);
        await setTimeout(waitMs, undefined, { signal });
      }
    }
  }

  stopBackgroundWork() {
    this.#metadataAbort?.abort();
    this.#notificationAbort?.abort();
  }

  async waitForBackgroundWork() {
    await Promise.all([this.#metadataPromise, this.#notificationRecovery]);
  }

  requestRetry({ startedAtMs } = {}) {
    const snapshot = this.health.snapshot();
    if (Number(startedAtMs) !== snapshot.startup?.startedAtMs) {
      throw new Error("Процесс Хаба уже сменился. Обновите состояние запуска.");
    }
    if (!this.#initialStartupFinished) throw new Error("Первичный запуск ещё выполняется. Можно перезапустить Хаб.");
    const retryableIds = new Set(["provider", "provider-metadata", "notifications", "terminal-projections", "telegram-delivery", "background-jobs", "telegram", "recovery"]);
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
    const signal = this.#notificationAbort?.signal;
    const retryable = [
      ["provider", this.initializeProvider, "provider"],
      ["provider-metadata", this.backfillProviderMetadata],
      ["notifications", () => this.prepareStartupCommandAdmission({ startupTraceId: this.startupTraceId })],
      ["terminal-projections", () => this.retryTerminalProjections({ startupTraceId: this.startupTraceId, signal })],
      ["telegram-delivery", () => this.retryNotifications({ startupTraceId: this.startupTraceId, signal })],
      ["background-jobs", this.restoreBackgroundJobs, "telegram"],
      ["telegram", () => this.#registerTelegramWithRetry(signal)],
      ["recovery", this.acknowledgeSqliteRecovery, "sqlite_recovery"],
    ];
    try {
      for (const [id, run, capability] of retryable) {
        const operation = operations.find((entry) => entry.id === id);
        if (operation?.state !== "failed"
          && !(id === "provider-metadata" && providerRetry && operation?.state === "skipped")) continue;
        if (id === "provider-metadata" && !this.providerIsRunning()) continue;
        if (id === "provider-metadata") {
          this.#startMetadataBackfill();
          continue;
        }
        this.health.retryOperation(id, { background: operation?.background === true });
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
