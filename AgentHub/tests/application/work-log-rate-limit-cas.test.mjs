import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { incomingLedgerRecord } from "../../src/application/work-log-usage-projection.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";

async function fixture(t, interleavings) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-rate-limit-cas-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  let reads = 0;
  let latestWorkerHtml;
  const store = createWorkLogUsageStore({
    ledgerFile: path.join(root, "usage.json"), databaseFile, defaultProjectRoot: root,
    usageSyncStore: worker,
    repositoryFactory: (options) => {
      const repository = new WorkLogUsageRepository(options);
      const read = repository.payload.bind(repository);
      repository.payload = async () => {
        const captured = await read();
        reads += 1;
        if (reads <= interleavings) {
          await journal.upsertRecords([incomingLedgerRecord({
            provider: "codex", threadId: "thread", turnId: `turn-${reads}`, projectRoot: root,
            taskTitle: `Concurrent worker task ${reads}`, title: `Concurrent worker turn ${reads}`,
            prompt: "request", body: "answer", status: "completed", usageReported: true,
            usage: { inputTokens: 100 }, completedAt: "2026-09-10T10:00:00.000Z",
          })]);
          const result = await worker.projectJournal({ defaultProjectRoot: root, projectRoots: [root] });
          assert.equal(result.projected, true);
          latestWorkerHtml = (await journal.payload()).html;
        }
        return captured;
      };
      return repository;
    },
  });
  t.after(async () => { await store.close(); journal.close(); await rm(root, { recursive: true, force: true }); });
  return { store, journal, worker, root, reads: () => reads, latestWorkerHtml: () => latestWorkerHtml };
}

test("rate-limit projection rereads after a worker commits a newer journal", async (t) => {
  const f = await fixture(t, 1);
  assert.equal((await f.store.projectRateLimits(null, "Codex: 25%", "2026-09-10T11:00:00.000Z")).projected, true);
  const html = (await f.journal.payload()).html;
  assert.match(html, /data-work-log-day-section/u);
  assert.match(JSON.stringify(await f.journal.snapshot()), /Concurrent worker turn 1/u);
  assert.match(html, /data-work-log-rate-limits/u);
  assert.match(html, /25%/u);
  assert.equal(f.reads(), 2);
  assert.equal(f.store.diagnostics().retainedRecords, 0);
});

test("rate-limit updates do not load or normalize unrelated journal records", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-rate-limit-read-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  await journal.upsertRecords([incomingLedgerRecord({
    provider: "codex", threadId: "thread", turnId: "retained", projectRoot: root,
    prompt: "Preserved prompt", body: "Preserved answer", diff: "x".repeat(1_000_000),
    completedAt: "2026-09-10T10:00:00.000Z",
  })]);
  const original = await journal.getRecord({ provider: "codex", threadId: "thread", turnId: "retained" });
  const store = createWorkLogUsageStore({
    ledgerFile: path.join(root, "usage.json"), databaseFile, defaultProjectRoot: root,
    repositoryFactory: (options) => new WorkLogUsageRepository({
      ...options, journalDatabase: journal,
      normalizePersisted: () => { throw new Error("Rate limits must not read the ledger"); },
    }),
  });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  assert.equal((await store.projectRateLimits(null, "Codex: 25%")).projected, true);
  assert.equal((await store.projectRateLimits(null, "Codex: 26%")).projected, true);
  assert.deepEqual(await journal.getRecord(original), original);
  assert.equal(store.diagnostics().retainedRecords, 0);
});

test("rate-limit projection reports bounded CAS exhaustion without replacing the newer journal", async (t) => {
  const f = await fixture(t, 2);
  await assert.rejects(f.store.projectRateLimits(null, "Codex: 25%"), { code: "JOURNAL_PROJECTION_CONFLICT" });
  assert.equal(f.reads(), 2);
  assert.equal((await f.journal.payload()).html, f.latestWorkerHtml());
});

test("rate-limit updates preserve durable record coverage and lazy journal data", async (t) => {
  const f = await fixture(t, 0);
  await f.journal.upsertRecords([incomingLedgerRecord({
    provider: "codex", threadId: "thread", turnId: "retained", projectRoot: f.root,
    taskTitle: "Retained task", title: "Retained turn", prompt: "request", body: "answer",
    usageReported: true, usage: { inputTokens: 100 }, status: "completed",
    completedAt: "2026-09-10T10:00:00.000Z",
  })]);
  await f.worker.projectJournal({ defaultProjectRoot: f.root, projectRoots: [f.root] });
  const source = await f.journal.projectionSource();
  const before = await f.journal.snapshot();
  assert.ok(source);
  assert.equal(before.turnEntries.length, 1);
  assert.equal(Object.keys(before.turns).length, 1);
  const update = await f.store.projectRateLimits(null, "Codex: 25%", "2026-09-10T11:00:00.000Z");
  assert.equal(update.projected, true);
  assert.deepEqual(await f.journal.projectionSource(), source);
  const after = await f.journal.snapshot();
  for (const field of ["days", "turns", "summary", "turnEntries"]) assert.deepEqual(after[field], before[field]);
  assert.match(after.html, /25%/u);
  const titles = await f.worker.synchronizeTaskTitles({
    defaultProjectRoot: f.root, projectRoot: f.root,
    titles: [{ provider: "codex", threadId: "thread", taskTitle: "Retained task" }],
  });
  assert.equal(titles.updated, 0);
  assert.equal(titles.projectionRequired, false);
  const revision = await f.journal.currentRevision();
  const repeated = await f.store.projectRateLimits(null, "Codex: 25%", "2026-09-10T11:00:00.000Z");
  assert.deepEqual(repeated, { projected: false, reason: "unchanged" });
  assert.equal(await f.journal.currentRevision(), revision);
});
