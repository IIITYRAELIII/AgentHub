import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { incomingLedgerRecord } from "../../src/application/work-log-usage-projection.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";

test("automatic batch reads only exact turns and preserves repeated-identity enrichment atomically", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-batch-points-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const base = {
    provider: "codex", threadId: "task", turnId: "existing", projectRoot: root,
    completedAt: "2026-09-10T10:00:00.000Z", body: "Retained answer", prompt: "Original prompt",
  };
  await journal.upsertRecords([
    incomingLedgerRecord(base),
    incomingLedgerRecord({ ...base, threadId: "unrelated", diff: "x".repeat(1_000_000) }),
  ]);
  const unrelated = await journal.getRecord({ ...base, threadId: "unrelated" });
  let projections = 0;
  const store = createWorkLogUsageStore({
    ledgerFile: path.join(root, "usage.json"), databaseFile, defaultProjectRoot: root,
    usageSyncStore: {
      async events() { return []; },
      async projectJournal() { projections += 1; return { projected: true }; },
    },
    repositoryFactory: (options) => new WorkLogUsageRepository({
      ...options, journalDatabase: journal,
      normalizePersisted: () => { throw new Error("Batch must not load the retained ledger"); },
    }),
  });
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }); });
  const before = await journal.currentRevision();
  const records = [
    { ...base, turnId: "new" },
    { ...base, turnId: "new", usageReported: true, usage: { inputTokens: 101 } },
    { ...base, title: "Enriched title" },
  ];
  assert.deepEqual(await store.recordAutomaticBatchAndProject({ records }), {
    recorded: 1, updated: 2, projected: true,
  });
  assert.equal(await journal.currentRevision(), before + 1);
  assert.equal((await journal.getRecord({ ...base, turnId: "new" })).usage.inputTokens, 101);
  assert.deepEqual(await journal.getRecord(unrelated), unrelated);
  assert.equal(store.diagnostics().retainedRecords, 0);
  assert.equal(projections, 1);
  assert.deepEqual(await store.recordAutomaticBatchAndProject({ records }), {
    recorded: 0, updated: 0, projected: false, reason: "unchanged",
  });
  assert.equal(projections, 1);
  assert.equal(await journal.currentRevision(), before + 1);
  const upsert = journal.upsertRecords.bind(journal);
  let fail = true;
  journal.upsertRecords = (...args) => {
    if (fail) { fail = false; throw new Error("Interrupted before commit"); }
    return upsert(...args);
  };
  const later = [{ ...base, turnId: "later-1" }, { ...base, turnId: "later-2" }];
  await assert.rejects(store.recordAutomaticBatchAndProject({ records: later }), /Interrupted before commit/u);
  assert.equal(await journal.getRecord(later[0]), null);
  assert.equal(await journal.getRecord(later[1]), null);
  assert.equal(projections, 1);
  assert.deepEqual(await store.recordAutomaticBatchAndProject({ records: later }), {
    recorded: 2, updated: 0, projected: true,
  });
});
