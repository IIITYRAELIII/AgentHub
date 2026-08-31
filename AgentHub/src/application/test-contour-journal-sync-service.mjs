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
      this.schedule();
    });
    return this.syncInFlight;
  }

  async #syncOnce() {
    // Пока контур перезапускается, его journal.sqlite вместе с -wal и -shm
    // пересоздаётся, и чтение из production попадает в середину смены файлов.
    // Ждать тут нечего: цикл повторяется каждые десять секунд.
    if (this.sourceRuntimeAlive && !await this.sourceRuntimeAlive()) {
      return { skipped: true, reason: "source-runtime-stopped" };
    }
    const source = await this.readRecords({
      sourceDatabaseFile: this.sourceDatabaseFile,
      targetDatabaseFile: this.targetDatabaseFile,
      models: ["gpt-5.6-terra"],
    });
    if (!source.records.length) {
      return {
        synced: true,
        imported: 0,
        sourceRecords: source.sourceRecords,
        eligibleRecords: source.eligibleRecords,
        sourceMissing: source.missing,
      };
    }
    const imported = await this.workLogUsageStore.recordAutomaticBatchAndProject({
      records: source.records,
      projectRoot: "",
      projectionProjectRoots: this.projectionProjectRoots,
    });
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
