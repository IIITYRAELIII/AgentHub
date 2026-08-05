import { recycleCodexCompactionTransport } from "./codex-compaction-transport.mjs";

const DEFAULT_CLEANUP_RETRY_MS = 15_000;
const MINIMUM_CLEANUP_RETRY_WINDOW_MS = 2 * 60_000;

function normalizedId(value) {
  return String(value ?? "").trim();
}

export class CodexContextMaintenanceService {
  constructor({
    timers,
    compactions,
    sanitizer,
    contextCleanupEnabled = () => false,
    periodicCleanupEnabled = () => false,
    compactionTriggeredCleanupEnabled = false,
    scanIntervalMs = () => 30 * 60_000,
    cleanupRetryMs = DEFAULT_CLEANUP_RETRY_MS,
    isStopping = () => false,
    transportRunning = () => false,
    activeRuns = () => [],
    runIsActive = () => false,
    refreshTaskCatalog = async () => [],
    knownRolloutPath = async () => "",
    readThread = async () => null,
    rememberRolloutPath = () => {},
    stopTransport = async () => {},
    startTransport = async () => {},
    initializeTransport = async () => {},
    providerIsSelected = () => false,
    setTransportRestarting = () => {},
    invalidateTaskCatalog = () => {},
    restartTransportAfterCrash = async () => {},
    runForTask = () => null,
    ensureTransport = async () => {},
    resumeThread = async () => {},
    startCompaction = async () => {},
    sandboxSettings = () => ({}),
    recycleTransport = recycleCodexCompactionTransport,
    now = Date.now,
    defer = queueMicrotask,
    logger = console,
  }) {
    this.timers = timers;
    this.compactions = compactions;
    this.sanitizer = sanitizer;
    this.contextCleanupEnabled = contextCleanupEnabled;
    this.periodicCleanupEnabled = periodicCleanupEnabled;
    this.compactionTriggeredCleanupEnabled = Boolean(compactionTriggeredCleanupEnabled);
    this.scanIntervalMs = scanIntervalMs;
    this.cleanupRetryMs = cleanupRetryMs;
    this.isStopping = isStopping;
    this.transportRunning = transportRunning;
    this.activeRuns = activeRuns;
    this.runIsActive = runIsActive;
    this.refreshTaskCatalog = refreshTaskCatalog;
    this.knownRolloutPath = knownRolloutPath;
    this.readThread = readThread;
    this.rememberRolloutPath = rememberRolloutPath;
    this.stopTransport = stopTransport;
    this.startTransport = startTransport;
    this.initializeTransport = initializeTransport;
    this.providerIsSelected = providerIsSelected;
    this.setTransportRestarting = setTransportRestarting;
    this.invalidateTaskCatalog = invalidateTaskCatalog;
    this.restartTransportAfterCrash = restartTransportAfterCrash;
    this.runForTask = runForTask;
    this.ensureTransport = ensureTransport;
    this.resumeThread = resumeThread;
    this.startCompaction = startCompaction;
    this.sandboxSettings = sandboxSettings;
    this.recycleTransport = recycleTransport;
    this.now = now;
    this.defer = defer;
    this.logger = logger;
    this.recycleInFlight = null;
  }

  async startManual(target) {
    if (target?.provider !== "codex") throw new Error("Свёртка контекста доступна только для Codex");
    const threadId = normalizedId(target.threadId);
    if (!threadId) throw new Error("Укажите корректную задачу Codex");
    if (this.runIsActive(this.runForTask(target))) {
      throw new Error("Сначала завершите или остановите текущий ход");
    }
    if (this.compactions.isRunning(threadId)) {
      return { accepted: false, message: "Свёртка контекста уже выполняется" };
    }
    await this.ensureTransport();
    const compaction = this.compactions.begin(threadId, { origin: "manual" });
    try {
      await this.resumeThread(threadId, this.sandboxSettings());
      await this.startCompaction(threadId);
      return {
        accepted: true,
        compactionId: compaction.id,
        message: "Свёртка контекста запущена",
      };
    } catch (error) {
      this.compactions.fail(threadId, compaction.id);
      throw error;
    }
  }

  beginCompactionCleanup(threadId, details = {}) {
    const key = normalizedId(threadId);
    if (!key) return;
    if (!this.contextCleanupEnabled() || !this.compactionTriggeredCleanupEnabled) {
      this.compactions.complete(key, {
        turnId: details.turnId,
        itemId: details.itemId,
        completedAt: details.compactedAt,
      });
      return;
    }
    this.compactions.beginCleanup(key, details);
    this.scheduleCompactionCleanup(key, {
      turnId: details.turnId,
      itemId: details.itemId,
      startedAtMs: this.now(),
    });
  }

  scheduleCompactionCleanup(threadId, state, delayMs = 0) {
    const key = normalizedId(threadId);
    if (!key || this.isStopping()) return false;
    return this.timers.scheduleInGroup("codex-compaction-cleanup", key, () => (
      this.runCompactionCleanup(key, state)
    ), Math.max(0, Number(delayMs) || 0), { unref: true });
  }

  async runCompactionCleanup(threadId, state) {
    if (this.isStopping() || !this.contextCleanupEnabled()) return null;
    const key = normalizedId(threadId);
    let rolloutPath = await this.knownRolloutPath(key);
    if (!rolloutPath && this.transportRunning()) {
      try {
        const result = await this.readThread(key, { fresh: true, includeTurns: false });
        rolloutPath = normalizedId(result?.thread?.path);
        if (rolloutPath) this.rememberRolloutPath(key, rolloutPath);
      } catch (error) {
        this.logger.warn(`Cannot resolve compacted Codex rollout ${key}: ${error.message}`);
      }
    }
    let result = rolloutPath
      ? await this.sanitizer.runForRollout(rolloutPath)
      : { applied: false, reason: "rollout-not-found" };
    if (rolloutPath) {
      result = await this.recycleForManualCompaction(key, rolloutPath, result) ?? result;
    }
    if (result.applied || result.reason === "below-threshold") {
      this.compactions.complete(key, {
        turnId: state.turnId,
        itemId: state.itemId,
      });
      return result;
    }
    const retryWindowMs = Math.max(
      MINIMUM_CLEANUP_RETRY_WINDOW_MS,
      Math.max(0, Number(this.scanIntervalMs()) || 0),
    );
    if (this.now() - state.startedAtMs < retryWindowMs) {
      this.scheduleCompactionCleanup(key, state, this.cleanupRetryMs);
      return result;
    }
    this.logger.warn(
      `Codex compaction image cleanup timed out for ${key}: ${result.reason}. `
        + "The periodic cleanup pass will retry it later.",
    );
    return result;
  }

  async recycleForManualCompaction(threadId, rolloutPath, result) {
    const key = normalizedId(threadId);
    const compaction = this.compactions.get(key);
    if (
      result?.reason !== "rollout-open"
      || compaction?.origin !== "manual"
      || this.recycleInFlight
    ) return null;

    this.recycleInFlight = this.#recycleIfIdle(key, rolloutPath, result);
    try {
      return await this.recycleInFlight;
    } finally {
      this.recycleInFlight = null;
    }
  }

  async #recycleIfIdle(threadId, rolloutPath, result) {
    const activeRuns = this.activeRuns().filter((run) => (
      run.provider === "codex"
      && this.runIsActive(run)
      && !this.compactions.isManualTurn(run.threadId, run.turnId)
    ));
    if (activeRuns.length) return null;

    const catalog = await this.refreshTaskCatalog({ force: true });
    const otherActiveCodexTask = catalog.some((entry) => (
      entry.provider === "codex"
      && entry.running
      && normalizedId(entry.threadId) !== threadId
    ));
    if (otherActiveCodexTask) return null;

    this.setTransportRestarting(true);
    try {
      const recycled = await this.recycleTransport({
        stop: this.stopTransport,
        sanitize: () => this.sanitizer.runForRollout(rolloutPath),
        start: this.startTransport,
        initialize: () => this.initializeTransport({
          attachSelectedThread: this.providerIsSelected(),
        }),
      });
      this.invalidateTaskCatalog();
      if (recycled.error) {
        this.logger.error(
          `Cannot recycle Codex app-server for manual compaction ${threadId}:`,
          recycled.error.message,
        );
        this.defer(() => void this.restartTransportAfterCrash());
        return { ...result, applied: false, reason: "transport-recycle-failed" };
      }
      return recycled.result ?? result;
    } finally {
      this.setTransportRestarting(false);
    }
  }

  schedulePeriodic(delayMs = this.scanIntervalMs()) {
    if (!this.periodicCleanupEnabled() || this.isStopping()) return false;
    return this.timers.schedule("codex-rollout-context", () => (
      this.runPeriodic()
    ), Math.max(0, Number(delayMs) || 0), { unref: true });
  }

  async runPeriodic({ reschedule = true } = {}) {
    if (!this.periodicCleanupEnabled() || this.isStopping()) return null;
    try {
      const result = await this.sanitizer.runOnce();
      if (result.skipped) {
        this.logger.log(
          `Codex rollout context sanitation deferred for ${result.skipped} open or changing file(s).`,
        );
      }
      return result;
    } catch (error) {
      this.logger.warn(`Cannot maintain Codex rollout context: ${error.message}`);
      return null;
    } finally {
      if (reschedule) this.schedulePeriodic();
    }
  }
}
