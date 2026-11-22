import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";
import { TestContourJournalSyncService } from "../../src/application/test-contour-journal-sync-service.mjs";
import { TEST_CONTOUR_RECORD_BYTES } from "../../src/infrastructure/persistence/test-contour-journal-source.mjs";

function turn(turnId) {
  return { id: randomUUID(), provider: "codex", threadId: "fixture-thread", turnId,
    projectRoot: "", model: "gpt-5.6-terra", status: "completed", provisional: false,
    usageReported: true, usage: { inputTokens: 42, outputTokens: 3 }, body: "fixture answer",
    startedAt: "2026-09-01T09:59:00Z", completedAt: "2026-09-01T10:00:00Z" };
}

for (const excluded of [{ model: "gpt-6.1-sol" }, { provisional: true }, { status: "running" }]) {
  test(`contour excluded oversized ${JSON.stringify(excluded)} never blocks eligible import/ACK/retry/idle`, async () => {
    await fixture(async (f) => {
      await f.source.upsertRecords([
        { ...turn("000-excluded"), ...excluded, body: "x".repeat(TEST_CONTOUR_RECORD_BYTES + 1024) },
        turn("100-eligible"),
      ]);
      const before = await f.store.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile });
      assert.deepEqual(before.records.map((record) => record.turnId), ["100-eligible"]);
      assert.equal(before.sourceRecords, 2);
      assert.equal(before.targetLookups, 1);
      assert.ok(before.recordBytes < 4096);
      const retry = await f.store.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile });
      assert.equal(retry.nextCheckpoint, before.nextCheckpoint);
      assert.equal((await f.service().sync()).imported, 1);
      assert.equal(await f.target.getRecord({ provider: "codex", threadId: "fixture-thread", turnId: "000-excluded" }), null);
      assert.ok(await f.target.getRecord({ provider: "codex", threadId: "fixture-thread", turnId: "100-eligible" }));
      const checkpoint = await f.target.testContourJournalCheckpoint();
      assert.ok(checkpoint);
      await f.reopen();
      const idle = await f.store.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile });
      assert.equal(idle.sourceRecords, 0);
      assert.equal(idle.recordBytes, 0);
      assert.equal(idle.targetLookups, 0);
      assert.equal(idle.nextCheckpoint, checkpoint);
      assert.equal((await f.service().sync()).imported, 0);
      assert.equal(await f.target.testContourJournalCheckpoint(), checkpoint);
    });
  });
}

test("contour eligible oversized row visibly fails repeated service attempts without import or ACK", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([
      { ...turn("000-eligible-large"), body: "x".repeat(TEST_CONTOUR_RECORD_BYTES + 1024) },
      turn("100-eligible"),
    ]);
    const service = f.service();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await assert.rejects(service.sync(), { code: "TEST_CONTOUR_RECORD_TOO_LARGE" });
      assert.equal(await f.target.testContourJournalCheckpoint(), "");
      assert.equal(await f.target.getRecord({ provider: "codex", threadId: "fixture-thread", turnId: "100-eligible" }), null);
    }
  });
});

async function fixture(run) {
  const root = await mkdtemp(path.join(process.env.AGENT_HUB_TEST_TEMP_ROOT || tmpdir(), "agent-hub-contour-worker-"));
  const sourceDatabaseFile = path.join(root, "source.sqlite");
  const databaseFile = path.join(root, "target.sqlite");
  const source = new JournalDatabase(sourceDatabaseFile);
  const target = new JournalDatabase(databaseFile);
  let worker;
  let store;
  const open = () => {
    worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
    store = createWorkLogUsageStore({
      ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: "",
      repositoryFactory: (options) => new WorkLogUsageRepository(options), usageSyncStore: worker,
    });
    return store;
  };
  try {
    await target.upsertRecords([turn("production-existing")]);
    open();
    const service = (overrides = {}) => new TestContourJournalSyncService({
      timers: { schedule: () => true, clear: () => {} }, logger: {}, sourceRuntimeAlive: () => true,
      sourceDatabaseFile, targetDatabaseFile: databaseFile, workLogUsageStore: store,
      readRecords: (options) => store.readTestContourJournalPage(options),
      acknowledgePage: (options) => store.acknowledgeTestContourJournalPage(options), ...overrides,
    });
    await run({ root, source, target, sourceDatabaseFile, databaseFile,
      get worker() { return worker; }, get store() { return store; }, service,
      reopen: async () => { await store.close(); open(); } });
  } finally {
    await store?.close(); await worker?.close(); source.close(); target.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("contour production ingestion acknowledges only durable import and projection, cold retry repairs projection", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([turn("a"), turn("b")]);
    let failed = false;
    const service = f.service({ workLogUsageStore: {
      recordAutomaticBatchAndProject: async (options) => {
        const result = await f.store.recordAutomaticBatchAndProject(options);
        if (!failed) { failed = true; throw new Error("lost import reply"); }
        return result;
      },
    } });
    await assert.rejects(service.sync(), /lost import reply/);
    assert.equal(await f.target.testContourJournalCheckpoint(), "");
    assert.ok(await f.target.getRecord({ provider: "codex", threadId: "fixture-thread", turnId: "a" }));
    await f.reopen();
    assert.equal((await f.service().sync()).imported, 0);
    const checkpoint = await f.target.testContourJournalCheckpoint();
    assert.ok(checkpoint);
    const idle = await f.worker.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile });
    assert.equal(idle.workerThreadId > 0, true);
    assert.equal(idle.sourceRecords, 0);
    assert.equal(idle.targetLookups, 0);
    assert.equal(idle.recordBytes, 0);
    assert.equal((await f.target.loadLedger()).turns["codex\0fixture-thread\0a"].usage.inputTokens, 42);
    assert.equal(await f.target.testContourJournalCheckpoint(), checkpoint);
  });
});

test("contour failure between durable rows and projection is retried after reopening via exact target revisions", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([turn("a")]);
    const service = f.service({ workLogUsageStore: {
      recordAutomaticBatchAndProject: async ({ records }) => {
        await f.target.upsertRecords(records);
        throw new Error("projection failed after import");
      },
    } });
    await assert.rejects(service.sync(), /projection failed/);
    assert.equal(await f.target.testContourJournalCheckpoint(), "");
    await f.reopen();
    let projected = 0;
    const originalProject = f.store.project.bind(f.store);
    f.store.project = (...args) => { projected += 1; return originalProject(...args); };
    await f.service().sync();
    assert.equal(projected, 1);
    assert.ok(await f.target.projectionSource());
    assert.ok(await f.target.testContourJournalCheckpoint());
    await f.service().sync();
    assert.equal(projected, 1);
  });
});

test("contour ACK failure reuses original trace ID, coalesces calls and lost ACK does not duplicate import", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([turn("a")]);
    const ids = [];
    const trace = [];
    f.worker.setTraceService({ startBestEffortSpan: (event) => {
      trace.push(event); return { finish: (result) => trace.push(result) };
    } });
    let first = true;
    const service = f.service({
      readRecords: async (options) => { ids.push(options.operationId); return f.store.readTestContourJournalPage(options); },
      acknowledgePage: async (options) => {
        await f.store.acknowledgeTestContourJournalPage(options);
        if (first) { first = false; throw new Error("lost ACK reply"); }
      },
    });
    const pending = service.sync();
    assert.equal(service.sync(), pending);
    await assert.rejects(pending, /lost ACK/);
    assert.equal((await service.sync()).imported, 0);
    assert.equal(ids[0], ids[1]);
    assert.equal(Object.values((await f.target.loadLedger()).turns).filter((row) => row.turnId === "a").length, 1);
    assert.ok(trace.filter((event) => ["read-test-contour-journal", "ack-test-contour-journal"].includes(event.metadata?.action))
      .every((event) => event.commandId === ids[0]));
    assert.ok(!JSON.stringify(trace).includes("fixture answer"));
    assert.ok(trace.some((event) => event.metadata?.workerThreadId > 0));
  });
});

test("contour source replacement/reclone and canonical target reset restart bounded import", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([turn("a")]);
    await f.service().sync();
    f.source.close();
    await rename(f.sourceDatabaseFile, path.join(f.root, "old-source.sqlite"));
    const replacement = new JournalDatabase(f.sourceDatabaseFile);
    try {
      await replacement.upsertRecords([turn("earlier")]);
      assert.equal((await f.service().sync()).imported, 1);
      await f.target.replaceLedger({ turns: {}, version: 9 });
      assert.equal((await f.service().sync()).imported, 1);
    } finally { replacement.close(); }
  });
});

test("contour checkpoint CAS rejects stale/reset pages and SQLite contention yields without a second mutation owner", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([turn("a")]);
    const page = await f.store.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile });
    await f.target.replaceLedger({ turns: {}, version: 9 });
    await assert.rejects(f.store.acknowledgeTestContourJournalPage({ ...page, sourceDatabaseFile: f.sourceDatabaseFile }), /generation changed/);
    await f.service().sync();
    await f.source.upsertRecords([turn("b")]);
    const fresh = await f.store.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile });
    await f.store.recordAutomaticBatchAndProject({ records: fresh.records });
    const lock = new DatabaseSync(f.databaseFile);
    lock.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    const pending = f.store.acknowledgeTestContourJournalPage({ ...fresh, sourceDatabaseFile: f.sourceDatabaseFile });
    const release = setTimeout(() => lock.exec("ROLLBACK"), 100);
    try { await pending; assert.ok(ticks >= 5); }
    finally { clearInterval(timer); clearTimeout(release); lock.close(); }
    await f.store.acknowledgeTestContourJournalPage({ ...fresh, sourceDatabaseFile: f.sourceDatabaseFile }); // same ACK
    await assert.rejects(f.store.acknowledgeTestContourJournalPage({ ...page, sourceDatabaseFile: f.sourceDatabaseFile }), /generation changed/);
    assert.equal((await f.worker.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile })).records.length, 0);
  });
});

test("contour stop during delayed read never imports or promotes its checkpoint", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([turn("a")]);
    let release;
    let enter;
    const entered = new Promise((resolve) => { enter = resolve; });
    const held = new Promise((resolve) => { release = resolve; });
    const service = f.service({ readRecords: async (options) => {
      const result = await f.store.readTestContourJournalPage(options);
      enter();
      await held; return result;
    } });
    const pending = service.sync();
    await entered; service.stop(); release();
    assert.equal((await pending).reason, "stopped");
    assert.equal(await f.target.testContourJournalCheckpoint(), "");
    assert.equal(await f.target.getRecord({ provider: "codex", threadId: "fixture-thread", turnId: "a" }), null);
  });
});

test("contour concurrent exact import still repairs projection before checkpoint", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([turn("a")]);
    let projections = 0;
    const original = f.store.project.bind(f.store);
    f.store.project = (...args) => { projections += 1; return original(...args); };
    const service = f.service({ readRecords: async (options) => {
      const page = await f.store.readTestContourJournalPage(options);
      await f.store.recordAutomaticBatchAndProject({ records: page.records });
      const db = new DatabaseSync(f.databaseFile);
      db.exec("DELETE FROM journal_store_meta WHERE key = 'journal_projection_source'"); db.close();
      return page;
    } });
    await service.sync();
    assert.equal(projections, 2); // Other writer's projection, then unchanged-batch repair.
    assert.ok(await f.target.projectionSource());
    assert.ok(await f.target.testContourJournalCheckpoint());
  });
});

test("contour target file replacement cannot ACK through a stale worker handle", async () => {
  await fixture(async (f) => {
    await f.source.upsertRecords([turn("a")]);
    await f.store.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile });
    const db = new DatabaseSync(f.databaseFile); db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); db.close();
    f.target.close();
    let replacedWhileOpen = true;
    try { await rename(f.databaseFile, path.join(f.root, "old-target.sqlite")); }
    catch (error) {
      // Windows forbids replacing a SQLite file with active worker handles.
      assert.equal(process.platform, "win32"); assert.equal(error.code, "EBUSY");
      assert.equal(await f.target.testContourJournalCheckpoint(), ""); f.target.close();
      replacedWhileOpen = false;
      await f.store.close();
      await rename(f.databaseFile, path.join(f.root, "old-target.sqlite"));
    }
    const replacement = new JournalDatabase(f.databaseFile);
    try {
      await replacement.currentRevision();
      if (replacedWhileOpen) {
        await assert.rejects(f.store.readTestContourJournalPage({ sourceDatabaseFile: f.sourceDatabaseFile }), { code: "TEST_CONTOUR_TARGET_REOPEN_REQUIRED" });
      }
      await f.reopen();
      assert.equal((await f.service().sync()).imported, 1);
      assert.ok(await replacement.testContourJournalCheckpoint());
    } finally { replacement.close(); }
  });
});
