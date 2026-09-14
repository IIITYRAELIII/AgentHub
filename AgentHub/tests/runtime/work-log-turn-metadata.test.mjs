import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { AsyncSqliteMutationQueue } from "../../src/infrastructure/persistence/async-sqlite-mutation-queue.mjs";
import { synchronizeTurnMetadata } from "../../src/runtime/work-log-turn-metadata.mjs";

class PointRepository extends WorkLogUsageRepository {
  get ledger() { throw new Error("Main ledger must remain unloaded"); }
  save() { throw new Error("Main ledger must not be saved"); }
  enqueue(operation, options) {
    assert.equal(options.load, false);
    return super.enqueue(operation, options);
  }
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-turn-metadata-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  let store;
  let worker;
  const open = () => {
    worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
    store = createWorkLogUsageStore({
      ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: root,
      repositoryFactory: (options) => new PointRepository(options), usageSyncStore: worker,
    });
  };
  open();
  return {
    root, journal, get store() { return store; }, get worker() { return worker; },
    async reopen() { await store.close(); open(); },
    async close() { await store.close(); journal.close(); await rm(root, { recursive: true, force: true }); },
  };
}

test("metadata discovery returns canonical compact candidates without retaining the main ledger", async () => {
  const f = await fixture();
  try {
    const base = {
      provider: "codex", threadId: "task", turnId: "pricing", projectRoot: f.root,
      startedAt: "2026-09-08T09:59:00.000Z", completedAt: "2026-09-08T10:00:00.000Z",
      body: "Retained answer ".repeat(100_000), diff: "Large diff ".repeat(100_000),
      usage: { inputTokens: 17 }, usageReported: true, prompt: "Ordinary prompt",
    };
    await f.journal.upsertRecords([
      base,
      { ...base, turnId: "image", model: "gpt-6-astra", pricingMetadataResolved: true, prompt: "imagegen image", estimatedCredits: 0 },
      { ...base, turnId: "estimated", model: "gpt-6-astra", pricingMetadataResolved: true, prompt: "imagegen image", estimatedCredits: 90 },
      { ...base, turnId: "invalid", workLogId: "not-a-uuid" },
      { ...base, provider: "claude" },
    ]);
    const identity = (turnId) => ({
      provider: "codex", threadId: "task", turnId, projectRoot: f.root, startedAt: base.startedAt,
    });
    assert.deepEqual(await f.store.missingPricingTurns({ provider: " CODEX " }), [identity("pricing")]);
    assert.deepEqual(await f.store.missingImageGenerationEstimateTurns(), [identity("image")]);
    assert.equal(f.store.diagnostics().retainedRecords, 0);
    assert.equal((await f.journal.getRecord(base)).diff, base.diff);
  } finally { await f.close(); }
});

for (const scenario of [
  { method: "synchronizePricingMetadataAndProject", discover: "missingPricingTurns",
    patch: { model: " GPT-6-ASTRA ", serviceTier: "priority" },
    expected: { model: "gpt-6-astra", serviceTier: "fast", pricingMetadataResolved: true } },
  { method: "synchronizeUsageEstimatesAndProject", discover: "missingImageGenerationEstimateTurns",
    patch: { estimatedCredits: 180, estimateKind: "imagegen-default" },
    expected: { estimatedCredits: 180, estimateKind: "imagegen-default", imageGenerationCount: 2 } },
]) {
  test(`${scenario.method} preserves other fields and repairs identical retry after worker replacement`, async () => {
    const f = await fixture();
    try {
      const base = {
        provider: "codex", threadId: "task", turnId: "turn", projectRoot: f.root,
        completedAt: "2026-09-08T10:00:00.000Z", body: "Exact retained answer", diff: "Exact retained diff",
        usage: { inputTokens: 17 }, usageReported: true,
      };
      const other = { ...base, turnId: "other", projectRoot: path.join(f.root, "other") };
      await f.journal.upsertRecords([base, other]);
      await f.store.project(null);
      const original = await f.journal.getRecord(base);
      const request = { items: [
        { ...base, ...scenario.patch }, { ...other, ...scenario.patch },
        { ...base, turnId: "absent", ...scenario.patch },
      ] };
      f.worker.projectJournal = async () => { throw new Error("Projection interrupted"); };
      await assert.rejects(f.store[scenario.method](request), /Projection interrupted/u);
      assert.deepEqual(await f.journal.getRecord(base), { ...original, ...scenario.expected });
      assert.deepEqual(await f.journal.getRecord(other), { ...other, taskThreadId: "task" });
      const recordRevision = await f.journal.recordRevision(base);
      await f.reopen();
      assert.deepEqual(await f.store[scenario.method](request), { updated: 0, projected: true });
      assert.equal(await f.journal.recordRevision(base), recordRevision);
      const revision = await f.journal.currentRevision();
      assert.deepEqual(await f.store[scenario.method](request), { updated: 0, projected: false, reason: "unchanged" });
      assert.equal(await f.journal.currentRevision(), revision);
      assert.equal(f.store.diagnostics().retainedRecords, 0);
    } finally { await f.close(); }
  });

  test(`${scenario.method} repairs a committed update after fresh discovery returns no items`, async () => {
    const f = await fixture();
    try {
      const base = {
        provider: "codex", threadId: "task", turnId: "turn", projectRoot: f.root,
        completedAt: "2026-09-08T10:00:00.000Z", body: "Exact retained answer",
        usage: { inputTokens: 1000 }, usageReported: !Object.hasOwn(scenario.expected, "estimatedCredits"),
        prompt: "imagegen image", estimatedCredits: 0,
      };
      await f.journal.upsertRecords([base]);
      await f.store.project(null);
      const before = await f.journal.snapshot();
      assert.equal((await f.store[scenario.discover]()).length, 1);
      f.worker.projectJournal = async () => { throw new Error("Projection interrupted"); };
      await assert.rejects(f.store[scenario.method]({ items: [{ ...base, ...scenario.patch }] }),
        /Projection interrupted/u);
      const recordRevision = await f.journal.recordRevision(base);
      await f.reopen();
      const discovered = await f.store[scenario.discover]();
      assert.deepEqual(discovered, []);
      assert.deepEqual(await f.store[scenario.method]({ items: discovered }), { updated: 0, projected: true });
      assert.equal(await f.journal.recordRevision(base), recordRevision);
      const projected = await f.journal.snapshot();
      if (scenario.discover === "missingPricingTurns") assert.notEqual(projected.version, before.version);
      else assert.equal(projected.version, before.version); // Default ImageGen estimates are not priced.
      assert.equal((await f.journal.projectionSource()).revision, recordRevision);
      const revision = await f.journal.currentRevision();
      assert.deepEqual(await f.store[scenario.method]({ items: [] }), {
        updated: 0, projected: false, reason: "unchanged",
      });
      assert.equal(await f.journal.currentRevision(), revision);
      assert.equal(f.store.diagnostics().retainedRecords, 0);
    } finally { await f.close(); }
  });
}

test("empty metadata reconciliation uses record revisions and exact project scope", async () => {
  const f = await fixture();
  try {
    const unchanged = { updated: 0, projected: false, reason: "unchanged" };
    assert.deepEqual(await f.store.synchronizePricingMetadataAndProject({ items: [] }), unchanged);
    const base = {
      provider: "codex", threadId: "task", turnId: "turn", projectRoot: f.root,
      completedAt: "2026-09-08T10:00:00.000Z", body: "Exact retained answer", model: "gpt-6-astra",
    };
    await f.journal.upsertRecords([base]);
    // No projection source: only a project with retained records needs repair.
    assert.deepEqual(await f.store.synchronizePricingMetadataAndProject({
      items: [], projectRoot: path.join(f.root, "empty"),
    }), unchanged);
    assert.deepEqual(await f.store.synchronizePricingMetadataAndProject({ items: [] }), { updated: 0, projected: true });
    await f.store.project(null, { projectRoot: path.join(f.root, "elsewhere") });
    // An existing projection for a different root does not cover this project.
    assert.deepEqual(await f.store.synchronizePricingMetadataAndProject({ items: [] }), { updated: 0, projected: true });
    const source = await f.journal.projectionSource();
    await f.journal.replaceIndexProjection("Updated account panel only");
    assert.ok(await f.journal.currentRevision() > source.revision);
    assert.deepEqual(await f.store.synchronizePricingMetadataAndProject({ items: [] }), unchanged);
    await f.journal.upsertRecords([{ ...base, threadId: "other", projectRoot: path.join(f.root, "other") }]);
    assert.deepEqual(await f.store.synchronizePricingMetadataAndProject({ items: [] }), unchanged);
  } finally { await f.close(); }
});

test("metadata update retries an exact revision conflict without overwriting a newer answer or usage", async () => {
  const f = await fixture();
  try {
    const base = {
      provider: "codex", threadId: "task", turnId: "turn", projectRoot: f.root,
      completedAt: "2026-09-08T10:00:00.000Z", body: "Old answer", usage: { inputTokens: 1 },
    };
    await f.journal.upsertRecords([base]);
    const upsert = f.journal.upsertRecords.bind(f.journal);
    let changed = false;
    f.journal.upsertRecords = async (records, options) => {
      if (!changed) {
        changed = true;
        await upsert([{ ...base, body: "New answer", usage: { inputTokens: 91 } }]);
      }
      return upsert(records, options);
    };
    const result = await synchronizeTurnMetadata(f.journal, new AsyncSqliteMutationQueue(), {
      kind: "pricing", projectRoot: f.root, defaultProjectRoot: f.root,
      items: [{ ...base, model: "gpt-6-astra", serviceTier: "priority" }],
    });
    assert.equal(result.updated, 1);
    const record = await f.journal.getRecord(base);
    assert.equal(record.body, "New answer");
    assert.deepEqual(record.usage, { inputTokens: 91 });
    assert.equal(record.model, "gpt-6-astra");
  } finally { await f.close(); }
});
