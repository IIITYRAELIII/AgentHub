import { recycleCodexCompactionTransport } from "./codex-compaction-transport.mjs";
import {
  readCodexTurnItemsAfterCompaction,
  readLatestCodexCompactionItem,
} from "./codex-compaction-rollout.mjs";
import { readCodexRolloutActivity } from "./codex-rollout-activity.mjs";
import { isCodexContextProbeTurn } from "../../domain/codex-context-probe.mjs";

const DEFAULT_CLEANUP_RETRY_MS = 15_000;
const MINIMUM_CLEANUP_RETRY_WINDOW_MS = 2 * 60_000;
const RAW_COMPACTION_EVENT_GRACE_MS = 1_000;

function normalizedId(value) {
  return String(value ?? "").trim();
}

function unsettledContextProbeError(turnId, reason, cause = undefined) {
  return Object.assign(
    new Error(`Скрытый замер ${turnId} принят Codex App Server, но ${reason}; его ход мог остаться активным`,
      cause ? { cause } : undefined),
    { code: "CODEX_CONTEXT_PROBE_UNSETTLED" },
  );
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
    readRolloutActivity = readCodexRolloutActivity,
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
    startContextProbe = async () => null,
    interruptContextProbe = async () => null,
    preserveProbeTitle = async () => {},
    startThread = async () => null,
    injectItems = async () => null,
    deleteThread = async () => null,
    readCompactionItem = readLatestCodexCompactionItem,
    readTurnResponseItems = readCodexTurnItemsAfterCompaction,
    sandboxSettings = () => ({}),
    recycleTransport = recycleCodexCompactionTransport,
    now = Date.now,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
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
    this.readRolloutActivity = readRolloutActivity;
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
    this.startContextProbe = startContextProbe;
    this.interruptContextProbe = interruptContextProbe;
    this.preserveProbeTitle = preserveProbeTitle;
    this.startThread = startThread;
    this.injectItems = injectItems;
    this.deleteThread = deleteThread;
    this.readCompactionItem = readCompactionItem;
    this.readTurnResponseItems = readTurnResponseItems;
    this.sandboxSettings = sandboxSettings;
    this.recycleTransport = recycleTransport;
    this.now = now;
    this.sleep = sleep;
    this.defer = defer;
    this.logger = logger;
    this.recycleInFlight = null;
  }

  async start(target, {
    captureRawItem = false,
    origin = "manual",
    beforePercent = null,
  } = {}) {
    if (target?.provider !== "codex") throw new Error("Свёртка контекста доступна только для Codex");
    const threadId = normalizedId(target.threadId);
    if (!threadId) throw new Error("Укажите корректный поток Codex");
    const currentRun = this.runForTask(target);
    if (this.runIsActive(currentRun) && currentRun?.status !== "finishing") {
      throw new Error("Сначала завершите или остановите текущий ход");
    }
    if (this.compactions.isRunning(threadId)) {
      return { accepted: false, message: "Свёртка контекста уже выполняется" };
    }
    await this.ensureTransport();
    const compaction = await this.mutateCompaction(threadId, () => this.compactions.begin(threadId, {
      origin: origin === "automatic" ? "automatic" : "manual",
      dedicatedProviderTurn: true,
      ...(captureRawItem ? { captureRawItem: true } : {}),
      ...(beforePercent !== null && beforePercent !== undefined && beforePercent !== ""
        && Number.isFinite(Number(beforePercent))
        ? { beforePercent: Number(beforePercent) }
        : {}),
    }));
    try {
      await this.resumeThread(threadId, this.sandboxSettings());
      await this.startCompaction(threadId);
      return {
        accepted: true,
        compactionId: compaction.id,
        message: "Свёртка контекста запущена",
      };
    } catch (error) {
      const current = this.compactions.get(threadId);
      const observed = current?.turnId
        ? current
        : await this.#reconcileUncertainCompactionStart(threadId, compaction, error);
      if (
        observed?.id === compaction.id
        && normalizedId(observed.turnId)
        && ["running", "completed"].includes(normalizedId(observed.status))
      ) {
        this.logger.warn?.(
          `Compaction RPC confirmation failed after provider start ${observed.turnId}: ${error.message}`,
        );
        return {
          accepted: true,
          compactionId: compaction.id,
          message: "Свёртка контекста запущена",
        };
      }
      await this.mutateCompaction(threadId, () => this.compactions.fail(threadId, compaction.id));
      throw error;
    }
  }

  mutateCompaction(threadId, operation) {
    return this.compactions.mutate ? this.compactions.mutate(threadId, operation) : operation();
  }

  async #reconcileUncertainCompactionStart(threadId, compaction, error) {
    if (error?.uncertain !== true) return this.compactions.get(threadId);
    let rolloutPath = await this.knownRolloutPath(threadId, compaction.startedAt).catch(() => "");
    if (!rolloutPath) {
      const source = await this.readThread(threadId, { fresh: true, includeTurns: false })
        .catch(() => null);
      rolloutPath = normalizedId(source?.thread?.path ?? source?.path);
      if (rolloutPath) this.rememberRolloutPath(threadId, rolloutPath);
    }
    if (!rolloutPath) return this.compactions.get(threadId);
    const activity = await this.readRolloutActivity(rolloutPath).catch(() => null);
    const turnId = normalizedId(activity?.activeTurnIds?.at(-1));
    if (!turnId) return this.compactions.get(threadId);
    return this.compactions.begin(threadId, {
      origin: compaction.origin,
      status: "running",
      turnId,
      startedAt: compaction.startedAt,
      captureRawItem: compaction.captureRawItem,
      beforePercent: compaction.beforePercent,
    });
  }

  startManual(target, options = {}) {
    return this.start(target, { ...options, origin: "manual" });
  }

  async probeContext(target, {
    materializationTimeoutMs = 10_000,
    pollMs = 100,
    retryDelayMs = 250,
    compactionId = null,
  } = {}) {
    const threadId = normalizedId(target?.threadId);
    if (!threadId) throw new Error("Укажите корректный поток Codex");
    await this.ensureTransport();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await this.startContextProbe(threadId, target);
      const turnId = normalizedId(result?.turn?.id ?? result?.turnId);
      if (!turnId) throw new Error("Codex App Server не вернул Turn скрытого замера");
      if (normalizedId(compactionId)) {
        this.compactions.annotate?.(threadId, normalizedId(compactionId), { probeTurnId: turnId });
      }
      const observed = await this.#observeProbeTurn(threadId, turnId, {
        timeoutMs: materializationTimeoutMs,
        pollMs,
      });
      if (observed.state === "materialized") return { threadId, turnId, status: "started" };
      if (observed.state !== "terminal") {
        /* Принятый ход не показался и мог остаться активным. Ответ на
           turn/interrupt сам по себе не доказывает остановку: она засчитывается,
           только когда Thread показал этот ход завершённым. Иначе исход
           неизвестен — второй запуск не делается. */
        try {
          await this.interruptContextProbe(threadId, turnId);
        } catch (error) {
          throw unsettledContextProbeError(turnId, `остановить его не удалось: ${error.message}`, error);
        }
        const settled = await this.#observeProbeTurn(threadId, turnId, {
          timeoutMs: materializationTimeoutMs,
          pollMs,
          settleOnly: true,
        });
        if (settled.state !== "terminal") {
          throw unsettledContextProbeError(turnId, "его остановка не подтверждена");
        }
      }
      if (attempt < 2) await this.sleep(Math.max(1, Number(retryDelayMs) || 250));
    }
    // Каждый принятый запуск подтверждённо завершился без фактического хода:
    // провал доказан, а не просто не дождались.
    throw Object.assign(
      new Error("Codex App Server дважды принял скрытый замер без фактического запуска"),
      { code: "CODEX_CONTEXT_PROBE_NOT_STARTED" },
    );
  }

  async waitForContextProbeIdle(target, turnId, {
    timeoutMs = 5_000,
    pollMs = 25,
    quietMs = 250,
  } = {}) {
    const expectedTurnId = normalizedId(turnId);
    if (!expectedTurnId) return true;
    const duration = Math.max(1, Number(timeoutMs) || 5_000);
    const deadline = this.now() + duration;
    let idleSince = null;
    let stage = "rollout-path";
    let timeout;
    // Bound each awaited read with the same deadline. Racing the whole polling
    // loop would leave that loop running after its caller releases admission.
    const expired = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(Object.assign(
        new Error(`Context idle check timed out after ${duration} ms (${stage})`),
        { code: "CODEX_CONTEXT_IDLE_TIMEOUT", stage },
      )), duration);
    });
    try {
      while (true) {
        if (this.now() >= deadline) return false;
        stage = "rollout-path";
        const rolloutPath = await Promise.race([
          this.knownRolloutPath(normalizedId(target?.threadId)), expired,
        ]);
        stage = "rollout-activity";
        const activity = rolloutPath
          ? await Promise.race([this.readRolloutActivity(rolloutPath), expired])
          : null;
        // Recheck the managed run after the asynchronous observation.
        const run = this.runForTask(target);
        const probeBusy = normalizedId(run?.turnId) === expectedTurnId || activity?.running === true;
        const currentTime = this.now();
        if (currentTime >= deadline) return false;
        if (probeBusy) idleSince = null;
        else if (idleSince === null) idleSince = currentTime;
        else if (currentTime - idleSince >= Math.max(1, Number(quietMs) || 250)) {
          // Naming is presentation maintenance; it never holds admission after
          // the exact probe became idle, and the catalog retries stale names.
          void this.preserveProbeTitle(target).catch((error) => {
            this.logger.warn?.(`Cannot restore Thread title after context probe: ${error.message}`);
          });
          return true;
        }
        stage = "idle-poll";
        await Promise.race([
          this.sleep(Math.min(Math.max(1, Number(pollMs) || 25), deadline - currentTime)),
          expired,
        ]);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async #observeProbeTurn(threadId, turnId, { timeoutMs, pollMs, settleOnly = false }) {
    const deadline = this.now() + Math.max(1, Number(timeoutMs) || 10_000);
    while (true) {
      const response = await this.readThread(threadId, { fresh: true, includeTurns: true });
      const thread = response?.thread ?? response;
      const turn = (Array.isArray(thread?.turns) ? thread.turns : [])
        .find((candidate) => normalizedId(candidate?.id) === turnId);
      const status = normalizedId(turn?.status);
      if (!settleOnly && turn && isCodexContextProbeTurn(turn)) return { state: "materialized", status };
      if (turn && status && !["inProgress", "in_progress", "running"].includes(status)) {
        return { state: "terminal", status };
      }
      if (this.now() >= deadline) return { state: "timeout", status };
      await this.sleep(Math.max(1, Number(pollMs) || 100));
    }
  }


  async rotate(target) {
    const sourceThreadId = normalizedId(target?.threadId);
    await this.ensureTransport();
    const source = await this.readThread(sourceThreadId, { fresh: true, includeTurns: false });
    const started = await this.startManual(target, { captureRawItem: true });
    if (!started.accepted) throw new Error(started.message);
    try {
      const settled = await this.compactions.waitForSettlement(sourceThreadId, started.compactionId);
      if (settled?.status !== "completed") {
        throw new Error(settled?.status === "timeout"
          ? "Свёртка контекста не завершилась вовремя"
          : "Свёртка контекста не завершилась");
      }
      return await this.rotateCompacted(target, {
        compactionId: started.compactionId,
        source,
        settlement: settled,
      });
    } catch (error) {
      this.compactions.clearRawItem(sourceThreadId, started.compactionId);
      throw error;
    }
  }

  async rotateCompacted(target, {
    compactionId,
    source = null,
    settlement = null,
    includeTurnId = null,
  } = {}) {
    const sourceThreadId = normalizedId(target?.threadId);
    const expectedId = normalizedId(compactionId);
    if (!sourceThreadId || !expectedId) throw new Error("Не указана завершённая свёртка контекста");
    const trackedCompaction = this.compactions.get(sourceThreadId);
    const completed = settlement?.status === "completed"
      || (trackedCompaction?.id === expectedId && trackedCompaction.status === "completed");
    if (!completed) {
      throw new Error("Свёртка контекста ещё не завершена");
    }
    try {
      const resolvedSource = source
        ?? await this.readThread(sourceThreadId, { fresh: true, includeTurns: false });
      const liveCompactionItem = await this.compactions.waitForRawItem(
        sourceThreadId,
        expectedId,
        RAW_COMPACTION_EVENT_GRACE_MS,
      );
      const rolloutPath = normalizedId(resolvedSource?.thread?.path)
        || normalizedId(await this.knownRolloutPath(sourceThreadId));
      const compactionItem = liveCompactionItem ?? await this.readCompactionItem(rolloutPath, {
        notBefore: trackedCompaction?.startedAt,
      });
      if (!compactionItem) throw new Error("Не удалось извлечь результат свёртки для нового Thread");
      const transferredTurnId = normalizedId(includeTurnId);
      /* Всё, что ход успел сделать до свёртки, уже представлено ею. Переносится
         только хвост этого хода после той самой свёртки; пустой хвост законен,
         а недоказанная граница срывает перенос до создания нового Thread. */
      const turnItems = transferredTurnId
        ? await this.readTurnResponseItems(rolloutPath, transferredTurnId, compactionItem)
        : [];
      await this.ensureTransport();
      const sourceThread = resolvedSource?.thread ?? {};
      const startParams = {
        cwd: normalizedId(
          target?.workingDirectory ?? sourceThread.cwd ?? target?.sessionCwd ?? target?.projectRoot,
        ) || undefined,
        model: normalizedId(target?.model) || undefined,
        modelProvider: normalizedId(sourceThread.modelProvider) || undefined,
        allowProviderModelFallback: true,
        ephemeral: false,
        ...this.sandboxSettings(),
      };
      const result = await this.startThread(Object.fromEntries(
        Object.entries(startParams).filter(([, value]) => value !== undefined),
      ));
      const threadId = normalizedId(result?.thread?.id);
      if (!threadId || threadId === sourceThreadId) {
        throw new Error("Codex App Server не создал новый Thread");
      }
      try {
        await this.injectItems(threadId, [compactionItem, ...turnItems]);
        return {
          accepted: true,
          compactionId: expectedId,
          sourceThreadId,
          ...(transferredTurnId ? {
            transferredTurnId,
            transferredItemCount: turnItems.length,
          } : {}),
          thread: result.thread,
        };
      } catch (error) {
        await this.deleteThread(threadId).catch(() => {});
        throw new Error(`Не удалось передать свёрнутый контекст в новый Thread: ${error.message}`, {
          cause: error,
        });
      }
    } finally {
      this.compactions.clearRawItem(sourceThreadId, expectedId);
    }
  }

  async discardRotationTarget(threadId) {
    const key = normalizedId(threadId);
    if (!key) return false;
    await this.deleteThread(key);
    return true;
  }

  discardCompactionTransfer(threadId, compactionId) {
    return this.compactions.clearRawItem(threadId, compactionId);
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
