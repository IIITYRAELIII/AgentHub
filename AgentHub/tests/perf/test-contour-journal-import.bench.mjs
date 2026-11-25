// Synthetic read-owner benchmark. Never point this helper at a live database.
// node --expose-gc tests/perf/test-contour-journal-import.bench.mjs <exact-base-reader.mjs>
// AGENT_HUB_TEST_TEMP_ROOT selects disposable storage (default OS temp).
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";

if (!process.argv[2]) throw new Error("An exact baseline reader module is required");
const baseline = await import(pathToFileURL(path.resolve(process.argv[2])).href);

async function database(file, count) {
  const owner = new JournalDatabase(file);
  await owner.currentRevision(); owner.close();
  const db = new DatabaseSync(file);
  try {
    db.exec("BEGIN IMMEDIATE");
    const insert = db.prepare(`INSERT INTO journal_records
      (provider, thread_id, turn_id, project_root, task_thread_id, completed_at_ms, observed_at_ms, changed_revision, record_json)
      VALUES ('codex', ?, ?, '', ?, 1000, 1000, 1, ?)`);
    for (let index = 0; index < count; index += 1) {
      const threadId = `fixture-${String(index).padStart(6, "0")}`;
      const turnId = "turn";
      insert.run(threadId, turnId, threadId, JSON.stringify({
        provider: "codex", threadId, turnId, model: "gpt-5.6-terra", status: "completed",
        provisional: false, completedAt: "1970-01-01T00:00:01Z", body: "x".repeat(2048),
      }));
    }
    db.exec(`UPDATE journal_store_meta SET value = '1' WHERE key = 'revision';
      INSERT INTO journal_store_meta VALUES ('journal_projection_source', '{"revision":1,"projectRoots":[]}'); COMMIT`);
  } finally { db.close(); }
}

async function measure(operation) {
  global.gc?.();
  const before = process.memoryUsage();
  let last = performance.now();
  let maxTimerGapMs = 0;
  const timer = setInterval(() => {
    const now = performance.now(); maxTimerGapMs = Math.max(maxTimerGapMs, now - last); last = now;
  }, 2);
  await delay(10);
  const start = performance.now();
  let result;
  let requestMs;
  try { result = await operation(); requestMs = performance.now() - start; }
  finally { await delay(10); clearInterval(timer); }
  const after = process.memoryUsage();
  return { requestMs, durationIncludingDrainMs: performance.now() - start,
    maxTimerGapMs, mainHeapDeltaBytes: after.heapUsed - before.heapUsed,
    processRssDeltaBytes: after.rss - before.rss,
    sourceRowsMaterialized: result.sourceRecords,
    targetPointLookups: result.targetLookups ?? null, jsonBytesHydrated: result.recordBytes ?? null,
    returnedRecords: result.records.length, workerThreadId: result.workerThreadId ?? 0 };
}

for (const count of [100, 20_000]) {
  const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || tmpdir(), "agent-hub-contour-bench-"));
  const sourceDatabaseFile = path.join(root, "source.sqlite");
  const targetDatabaseFile = path.join(root, "target.sqlite");
  let worker;
  try {
    await database(sourceDatabaseFile, count); await database(targetDatabaseFile, count);
    worker = new WorkLogUsageSyncWorkerStore({ databaseFile: targetDatabaseFile });
    const options = { sourceDatabaseFile, targetDatabaseFile, operationId: `hub296-synthetic-${count}` };
    const initial = await measure(() => worker.readTestContourJournalPage(options));
    let page = await worker.readTestContourJournalPage(options);
    let inspected = 0;
    do {
      inspected += page.sourceRecords;
      assert.equal(page.records.length, 0); assert.equal(page.projectionRequired, false);
      await worker.acknowledgeTestContourJournalPage({ ...options, ...page }, { mutationLock: (mutate) => mutate() });
      page = await worker.readTestContourJournalPage(options);
    } while (page.hasMore || page.sourceRecords);
    assert.equal(inspected, count);
    const before = [];
    const after = [];
    for (let run = 0; run < 3; run += 1) {
      before.push(await measure(() => baseline.readMissingTestContourJournalRecords(options)));
      after.push(await measure(() => worker.readTestContourJournalPage(options)));
    }
    assert.ok(before.every((result) => result.sourceRowsMaterialized === count && result.returnedRecords === 0));
    assert.ok(after.every((result) => result.sourceRowsMaterialized === 0 && result.targetPointLookups === 0 && result.jsonBytesHydrated === 0));
    console.log(JSON.stringify({ operationId: options.operationId, syntheticRows: count,
      initialPage: initial, initialRowsInspectedTotal: inspected, before, after }));
  } finally { await worker?.close(); await rm(root, { recursive: true, force: true }); }
}
