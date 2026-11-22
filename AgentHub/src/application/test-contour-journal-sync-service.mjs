import { randomUUID } from "node:crypto";

const TIMER_NAME = "test-contour-journal-sync";

export class TestContourJournalSyncService {
  constructor({
    timers,
    workLogUsageStore,
    sourceDatabaseFile,
    targetDatabaseFile,
    projectionProjectRoots = [],
    enabled = true,
    initialDelayMs = 3_000,
    intervalMs = 10_000,
    readRecords,
    acknowledgePage = null,
    commandTrace = null,
    sourceRuntimeAlive = null,
    logger = console,
  } = {}) {
    if (!timers || typeof timers.schedule !== "function") {
      throw new TypeError("TestContourJournalSyncService requires timers");
    }
    if (!workLogUsageStore || typeof workLogUsageStore.recordAutomaticBatchAndProject !== "function") {
      throw new TypeError("TestContourJournalSyncService requires a workLogUsageStore");
    }
    if (typeof readRecords !== "function") {
      throw new TypeError("TestContourJournalSyncService requires readRecords");
    }
    this.timers = timers;
    this.workLogUsageStore = workLogUsageStore;
    this.sourceDatabaseFile = sourceDatabaseFile;
    this.targetDatabaseFile = targetDatabaseFile;
    this.projectionProjectRoots = projectionProjectRoots;
    this.enabled = enabled !== false;
    this.initialDelayMs = initialDelayMs;
    this.intervalMs = intervalMs;
    this.readRecords = readRecords;
    this.acknowledgePage = acknowledgePage;
    this.commandTrace = commandTrace;
    this.operationId = null;
    this.hasMore = false;
    this.sourceRuntimeAlive = typeof sourceRuntimeAlive === "function" ? sourceRuntimeAlive : null;
    this.logger = logger;
    this.syncInFlight = null;
    this.stopped = false;
  }

  schedule(delayMs = this.intervalMs) {
    if (!this.enabled || this.stopped) return false;
    return this.timers.schedule(TIMER_NAME, () => {
      void this.sync().catch((error) => {
        this.logger.warn?.(`Test Contour journal sync failed: ${error.message}`);
      });
    }, Math.max(0, Number(delayMs) || 0), { unref: true });
  }

  scheduleInitial() {
    return this.schedule(this.initialDelayMs);
  }

  stop() {
    this.stopped = true;
    this.timers.clear?.(TIMER_NAME);
  }

  sync() {
    if (!this.enabled || this.stopped) return Promise.resolve({
      skipped: true,
      reason: this.stopped ? "stopped" : "disabled",
    });
    if (this.syncInFlight) return this.syncInFlight;
    this.syncInFlight = this.#syncOnce().finally(() => {
      this.syncInFlight = null;
      this.schedule(this.hasMore ? Math.min(1_000, this.intervalMs) : this.intervalMs);
    });
    return this.syncInFlight;
  }

  async #syncOnce() {
    this.hasMore = false;
    // Пока контур перезапускается, его journal.sqlite вместе с -wal и -shm
    // пересоздаётся, и чтение из production попадает в середину смены файлов.
    // Ждать тут нечего: цикл повторяется каждые десять секунд.
    if (this.sourceRuntimeAlive && !await this.sourceRuntimeAlive()) {
      return { skipped: true, reason: "source-runtime-stopped" };
    }
    if (this.stopped) return { skipped: true, reason: "stopped" };
    this.operationId ??= `test-contour-import:${randomUUID()}`;
    let trace;
    try {
      trace = this.commandTrace?.startBestEffortSpan?.({
        commandId: this.operationId, stage: "test-contour-journal-import",
        transport: "server-runtime", recordStarted: true,
      });
    } catch { /* Diagnostics never authorize or prevent import. */ }
    try {
      const result = await this.#importPage();
      try { trace?.finish({ outcome: result.skipped ? "queued" : "succeeded", metadata: {
        imported: result.imported ?? 0, sourceRecords: result.sourceRecords ?? 0,
        eligibleRecords: result.eligibleRecords ?? 0,
      } }); } catch { /* Best effort. */ }
      return result;
    } catch (error) {
      this.hasMore = false;
      try { trace?.finish({ outcome: "failed" }); } catch { /* Best effort. */ }
      throw error;
    }
  }

  async #importPage() {
    const source = await this.readRecords({
      sourceDatabaseFile: this.sourceDatabaseFile,
      targetDatabaseFile: this.targetDatabaseFile,
      models: ["gpt-5.6-terra"],
      operationId: this.operationId,
    });
    this.hasMore = false;
    if (this.stopped) return { skipped: true, reason: "stopped" };
    let imported = { recorded: 0, updated: 0, projected: false };
    if (source.records.length) {
      imported = await this.workLogUsageStore.recordAutomaticBatchAndProject({
        records: source.records, projectRoot: "", projectionProjectRoots: this.projectionProjectRoots,
      });
      if (!imported.recorded && !imported.updated && !imported.projected) {
        // Another canonical writer may have committed these exact rows between
        // read and import. Its durability is not proof of projection completion.
        imported = { ...imported, ...await this.workLogUsageStore.project(undefined, {
          projectRoot: "", projectionProjectRoots: this.projectionProjectRoots,
        }) };
      }
    } else if (source.projectionRequired) {
      // Crash after durable import but before projection/ACK: exact target rows
      // exist, yet their canonical projection revision still needs repair.
      imported = { ...imported, ...await this.workLogUsageStore.project(undefined, {
        projectRoot: "", projectionProjectRoots: this.projectionProjectRoots,
      }) };
    }
    if (imported.projectionDeferred || imported.projectionError || imported.conflict) {
      throw new Error("Test Contour journal projection is not committed; checkpoint not advanced");
    }
    if (this.stopped) return { skipped: true, reason: "stopped" };
    if (source.nextCheckpoint && source.nextCheckpoint !== source.expectedCheckpoint) {
      if (typeof this.acknowledgePage !== "function") throw new Error("Test Contour import requires checkpoint acknowledgement");
      await this.acknowledgePage({
        sourceDatabaseFile: this.sourceDatabaseFile, targetDatabaseFile: this.targetDatabaseFile,
        expectedCheckpoint: source.expectedCheckpoint, nextCheckpoint: source.nextCheckpoint,
        operationId: this.operationId,
      });
    }
    this.hasMore = source.hasMore === true;
    this.operationId = null;
    if (!source.records.length) {
      return {
        synced: true,
        imported: 0,
        sourceRecords: source.sourceRecords,
        eligibleRecords: source.eligibleRecords,
        sourceMissing: source.missing,
      };
    }
    this.logger.info?.(
      `Imported ${imported.recorded ?? source.records.length} Terra Test Contour journal turn(s).`,
    );
    return {
      synced: true,
      imported: imported.recorded ?? source.records.length,
      updated: imported.updated ?? 0,
      projected: imported.projected ?? false,
      sourceRecords: source.sourceRecords,
      eligibleRecords: source.eligibleRecords,
    };
  }
}

export { TIMER_NAME as TEST_CONTOUR_JOURNAL_SYNC_TIMER_NAME };
