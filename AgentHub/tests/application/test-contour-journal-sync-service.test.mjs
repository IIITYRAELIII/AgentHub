import assert from "node:assert/strict";
import test from "node:test";

import {
  TEST_CONTOUR_JOURNAL_SYNC_TIMER_NAME,
  TestContourJournalSyncService,
} from "../../src/application/test-contour-journal-sync-service.mjs";

test("TestContourJournalSyncService imports a Terra batch and reschedules", async () => {
  const events = [];
  const service = new TestContourJournalSyncService({
    timers: {
      schedule: (name, callback, delayMs, options) => {
        events.push(["schedule", name, delayMs, options]);
        return callback;
      },
      clear: (name) => events.push(["clear", name]),
    },
    workLogUsageStore: {
      recordAutomaticBatchAndProject: async (options) => {
        events.push(["import", options]);
        return { recorded: 2, updated: 0, projected: true };
      },
    },
    sourceDatabaseFile: "D:/contour/journal.sqlite",
    targetDatabaseFile: "D:/production/journal.sqlite",
    projectionProjectRoots: ["D:/production", "D:/contour"],
    readRecords: async (options) => {
      events.push(["read", options]);
      return {
        records: [{ provider: "codex", threadId: "one", turnId: "a" }, { provider: "codex", threadId: "two", turnId: "b" }],
        sourceRecords: 20,
        eligibleRecords: 2,
        missing: false,
      };
    },
    intervalMs: 20,
    logger: { info: (message) => events.push(["info", message]) },
  });

  const result = await service.sync();

  assert.deepEqual(result, {
    synced: true,
    imported: 2,
    updated: 0,
    projected: true,
    sourceRecords: 20,
    eligibleRecords: 2,
  });
  assert.deepEqual(events.find(([name]) => name === "read")?.[1].models, ["gpt-5.6-terra"]);
  assert.deepEqual(events.find(([name]) => name === "import")?.[1].projectionProjectRoots, [
    "D:/production",
    "D:/contour",
  ]);
  assert.deepEqual(events.at(-1), [
    "schedule",
    TEST_CONTOUR_JOURNAL_SYNC_TIMER_NAME,
    20,
    { unref: true },
  ]);
});

test("TestContourJournalSyncService is inert inside Test Contour", async () => {
  const events = [];
  const service = new TestContourJournalSyncService({
    timers: {
      schedule: (...args) => events.push(args),
      clear: (...args) => events.push(args),
    },
    workLogUsageStore: { recordAutomaticBatchAndProject: async () => ({}) },
    readRecords: async () => ({ records: [] }),
    enabled: false,
  });

  assert.deepEqual(await service.sync(), { skipped: true, reason: "disabled" });
  assert.equal(service.scheduleInitial(), false);
  assert.deepEqual(events, []);
});

test("TestContourJournalSyncService does not reschedule after stop during sync", async () => {
  const events = [];
  let releaseRead;
  const readStarted = new Promise((resolve) => { releaseRead = resolve; });
  const service = new TestContourJournalSyncService({
    timers: {
      schedule: (...args) => events.push(["schedule", ...args]),
      clear: (...args) => events.push(["clear", ...args]),
    },
    workLogUsageStore: { recordAutomaticBatchAndProject: async () => ({}) },
    readRecords: async () => {
      await readStarted;
      return { records: [], sourceRecords: 0, eligibleRecords: 0, missing: false };
    },
  });

  const syncing = service.sync();
  service.stop();
  releaseRead();
  await syncing;

  assert.deepEqual(events, [["clear", TEST_CONTOUR_JOURNAL_SYNC_TIMER_NAME]]);
  assert.deepEqual(await service.sync(), { skipped: true, reason: "stopped" });
});
