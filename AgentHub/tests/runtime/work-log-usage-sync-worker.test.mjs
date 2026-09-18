import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { USAGE_FACT_SCHEMA_VERSION } from "../../src/domain/usage-facts.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { buildLazyJournalPayload } from "../../src/application/journal-projection-data.mjs";
import { COMMAND_TRACE_OUTCOMES } from "../../src/domain/command-trace-span.mjs";
import {
  normalizePersistedWorkLog,
  projectWorkLogUsage,
  WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION,
} from "../../src/application/work-log-usage-projection.mjs";

async function removeRoot(root) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (error?.code !== "ENOTEMPTY" || attempt >= 5) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

test("full journal projection stays in worker and preserves canonical fragments, bindings and sync facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-worker-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: "device-local" });
  try {
    await journal.upsertRecords([{
      provider: "codex", threadId: "thread-local", taskThreadId: "thread-local", turnId: "turn-local",
      projectRoot: root, startedAt: "2026-09-08T09:59:00.000Z", completedAt: "2026-09-08T10:00:00.000Z",
      usageReported: true, usage: { inputTokens: 1000, outputTokens: 100 }, model: "gpt-6-astra",
      body: "Large retained answer. ".repeat(100_000), prompt: "Local prompt", status: "completed",
    }, {
      provider: "claude", threadId: "thread-claude", turnId: "turn-claude", projectRoot: root,
      completedAt: "2026-09-08T10:01:00.000Z", body: "Claude answer", estimatedCredits: 2,
    }]);
    const rateLimits = '<div data-work-log-rate-limits>Retained rate limits</div>';
    await journal.replaceIndexProjection(rateLimits);
    await worker.importSnapshot({ events: [{
      deviceId: "device-remote", provider: "codex", threadId: "thread-remote", turnId: "turn-remote",
      completedAt: "2026-09-08T08:00:00.000Z", estimatedCredits: 2,
    }] });
    const binding = {
      workspaceId: "workspace-local", workspaceName: "Local workspace", workspaceKind: "user",
      streamId: "stream-local", streamName: "Local stream", streamOrdinal: 1,
    };
    const references = [];
    const options = {
      projectRoots: [root], defaultProjectRoot: root, includeClaudeUsage: false,
      localDeviceId: "device-local", localDeviceLabel: "Local device", now: Date.parse("2026-09-08T12:00:00Z"),
    };
    const ledger = await journal.loadLedger();
    const expected = buildLazyJournalPayload(projectWorkLogUsage(
      `# Глобальный журнал работ\n${rateLimits}\n`,
      normalizePersistedWorkLog(ledger, { defaultProjectRoot: root }).ledger.turns,
      {
        ...options, syncedUsageEvents: await worker.facts(), accountCatalog: await journal.accountCatalog(),
        workspaceResolver: () => binding,
      },
    ));
    const result = await worker.projectJournal(options, { workspaceResolver: (reference) => {
      references.push(reference);
      return binding;
    } });
    assert.equal(result.projected, true);
    assert.ok(result.workerThreadId > 0);
    assert.equal(result.recordCount, 2);
    assert.equal(result.eventCount, 1);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
    assert.equal(Object.hasOwn(result, "html"), false);
    assert.equal(references.length, 2);
    assert.ok(references.every((reference) => !Object.hasOwn(reference, "body")));
    const actual = await journal.snapshot();
    assert.equal(actual.html, expected.html);
    assert.deepEqual(actual.days, expected.days);
    assert.deepEqual(actual.turns, expected.turns);
    assert.deepEqual(await journal.loadLedger(), ledger);
    assert.equal(await journal.accountUsageProjectionVersion(), WORK_LOG_ACCOUNT_USAGE_PROJECTION_VERSION);
    const unchanged = await worker.projectJournal(options, { workspaceResolver: () => binding });
    assert.equal(unchanged.projected, false);
    assert.equal(unchanged.reason, "unchanged");
    assert.equal(unchanged.revision, result.revision);
  } finally {
    await worker.close();
    journal.close();
    await removeRoot(root);
  }
});

for (const scenario of [
  {
    method: "synchronizePricingMetadataAndProject",
    input: (record) => ({ items: [{ ...record, model: "gpt-6-astra", serviceTier: "priority" }] }),
    verify: (record) => {
      assert.equal(record.model, "gpt-6-astra");
      assert.equal(record.serviceTier, "fast");
      assert.equal(record.pricingMetadataResolved, true);
    },
    expected: { updated: 1, projected: true },
  },
  {
    method: "synchronizeUsageEstimatesAndProject",
    input: (record) => ({ items: [{
      ...record, estimatedCredits: 20, estimateKind: "imagegen-default", imageGenerationCount: 2,
    }] }),
    verify: (record) => {
      assert.equal(record.estimatedCredits, 20);
      assert.equal(record.estimateKind, "imagegen-default");
      assert.equal(record.imageGenerationCount, 2);
    },
    expected: { updated: 1, projected: true },
  },
  {
    method: "recordAutomaticBatchAndProject",
    input: (record) => ({ records: [{ ...record, body: "Corrected batch answer" }] }),
    verify: (record) => assert.equal(record.body, "Corrected batch answer"),
    expected: { recorded: 0, updated: 1, projected: true },
  },
]) {
  test(`${scenario.method} saves under lock then projects in worker and propagates projection failure`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-maintenance-projection-"));
    const databaseFile = path.join(root, "journal.sqlite");
    const journal = new JournalDatabase(databaseFile);
    const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
    let locked = false;
    let saves = 0;
    let projections = 0;
    let failProjection = false;
    class GuardedRepository extends WorkLogUsageRepository {
      enqueue(operation, options) {
        return super.enqueue(async () => {
          locked = true;
          try { return await operation(); } finally { locked = false; }
        }, options);
      }
      save(options) {
        assert.equal(locked, true);
        saves += 1;
        return super.save(options);
      }
      async applyExternalMutation(operation) {
        assert.equal(locked, true);
        const result = await super.applyExternalMutation(operation);
        if (result.updated || result.upserted) saves += 1;
        return result;
      }
      replaceProjection() { throw new Error("Main projection must not run"); }
    }
    const store = createWorkLogUsageStore({
      ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: root,
      repositoryFactory: (options) => new GuardedRepository(options), usageSyncStore: worker,
    });
    const record = {
      provider: "codex", threadId: "task", turnId: "turn", projectRoot: root,
      completedAt: "2026-09-08T10:00:00.000Z", body: "Original answer",
      usage: { inputTokens: 15 }, usageReported: true,
    };
    const project = worker.projectJournal.bind(worker);
    worker.projectJournal = async (payload, options) => {
      assert.equal(locked, false);
      assert.ok(saves > 0);
      assert.deepEqual(payload.projectRoots, [root]);
      scenario.verify(await journal.getRecord(record));
      projections += 1;
      if (failProjection) throw new Error("Worker projection failed");
      return project(payload, options);
    };
    try {
      await journal.upsertRecords([record]);
      const input = { ...scenario.input(record), projectionProjectRoots: [root] };
      assert.deepEqual(await store[scenario.method](input), scenario.expected);
      assert.equal(projections, 1);
      const savesAfterSuccess = saves;
      const unchanged = await store[scenario.method](input);
      assert.equal(unchanged.projected, false);
      assert.equal(unchanged.reason, "unchanged");
      assert.equal(saves, savesAfterSuccess);
      assert.equal(projections, 1);
      await journal.upsertRecords([record]);
      failProjection = true;
      await assert.rejects(store[scenario.method](input), /Worker projection failed/u);
      scenario.verify(await journal.getRecord(record));
      assert.equal(projections, 2);
      assert.equal(locked, false);
      failProjection = false;
      await store.project(null);
      assert.equal(projections, 3);
    } finally {
      await store.close();
      journal.close();
      await removeRoot(root);
    }
  });
}

test("task title synchronization selects and writes in the worker without loading the main ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-title-worker-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: "device-local" });
  let locked = false;
  let projections = 0;
  class PointRepository extends WorkLogUsageRepository {
    get ledger() { throw new Error("Main ledger must remain unloaded"); }
    save() { throw new Error("Main ledger must not be saved"); }
    enqueue(operation, options) {
      assert.equal(options.load, false);
      return super.enqueue(async () => {
        locked = true;
        try { return await operation(); } finally { locked = false; }
      }, options);
    }
  }
  const synchronize = worker.synchronizeTaskTitles.bind(worker);
  worker.synchronizeTaskTitles = async (payload, options) => {
    assert.equal(locked, false);
    const result = await synchronize(payload, options);
    assert.ok(result.workerThreadId > 0);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1024);
    return result;
  };
  const project = worker.projectJournal.bind(worker);
  worker.projectJournal = (...args) => {
    assert.equal(locked, false);
    projections += 1;
    return project(...args);
  };
  const store = createWorkLogUsageStore({
    ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: root,
    repositoryFactory: (options) => new PointRepository(options), usageSyncStore: worker,
    workspaceCatalogStore: {
      resolveThread: () => ({ workspaceId: "workspace-title", streamId: "stream-title" }),
      assignUnknownThread: () => null,
    },
  });
  try {
    const base = {
      provider: "codex", taskThreadId: "task-root", threadId: "task-root", turnId: "turn-root",
      projectRoot: root, taskTitle: "Old title", body: "Retained answer. ".repeat(100_000),
      completedAt: "2026-09-08T10:00:00.000Z", usage: { inputTokens: 31 }, usageReported: true,
    };
    await journal.upsertRecords([
      base,
      { ...base, threadId: "child", turnId: "child-turn", body: "Child answer" },
      { ...base, threadId: "other-project", projectRoot: path.join(root, "other"), body: "Other root" },
      { ...base, provider: "claude", body: "Other provider" },
      { ...base, taskThreadId: "another-task", threadId: "another-task", body: "Other task" },
      { ...base, turnId: "invalid", workLogId: "invalid-uuid", body: "Excluded legacy record" },
    ]);
    const before = await journal.loadLedger();
    const request = { titles: [{ provider: " CODEX ", threadId: "task-root", taskTitle: " New   title " }] };
    const changed = await store.synchronizeTaskTitlesAndProject(request);
    assert.deepEqual(changed, { updated: 2, projected: true });
    assert.equal(projections, 1);
    assert.equal(store.diagnostics().retainedRecords, 0);
    const after = await journal.loadLedger();
    for (const [key, record] of Object.entries(before.turns)) {
      const selected = record.provider === "codex" && record.projectRoot === root
        && record.taskThreadId === "task-root" && record.turnId !== "invalid";
      assert.deepEqual(after.turns[key], selected ? { ...record, taskTitle: "New title" } : record);
    }
    const snapshot = await journal.snapshot();
    assert.match(JSON.stringify(snapshot), /workspace-title/u);
    const revision = await journal.currentRevision();
    assert.deepEqual(await store.synchronizeTaskTitlesAndProject(request), {
      updated: 0, projected: false, reason: "unchanged",
    });
    assert.equal(projections, 1);
    assert.equal(await journal.currentRevision(), revision);
    assert.deepEqual(await journal.projectionSource(), { revision: revision - 1, projectRoots: [root] });
    assert.deepEqual(await store.synchronizeTaskTitlesAndProject({ titles: [] }), {
      updated: 0, projected: false, reason: "unchanged",
    });
    assert.equal(projections, 1);
  } finally {
    await store.close();
    journal.close();
    await removeRoot(root);
  }
});

test("identical task title retry after projection failure survives worker replacement", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-title-retry-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  let worker;
  let store;
  const open = () => {
    worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
    store = createWorkLogUsageStore({
      ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: root,
      repositoryFactory: (options) => new WorkLogUsageRepository(options), usageSyncStore: worker,
    });
  };
  try {
    await journal.upsertRecords([{
      provider: "codex", threadId: "task", turnId: "turn", projectRoot: root,
      completedAt: "2026-09-08T10:00:00.000Z", body: "Answer", taskTitle: "Old title",
    }]);
    open();
    assert.deepEqual(await store.synchronizeTaskTitlesAndProject({ titles: [] }), {
      updated: 0, projected: false, reason: "unchanged",
    });
    assert.equal(await journal.projectionSource(), null);
    await store.project(null);
    const snapshot = await journal.snapshot();
    await journal.replaceProjection(snapshot, { version: snapshot.version });
    assert.equal(await journal.projectionSource(), null);
    await store.synchronizeTaskTitlesAndProject({
      titles: [{ provider: "codex", threadId: "task", taskTitle: "Old title" }],
    });
    assert.ok((await journal.projectionSource()).revision > 0);
    worker.projectJournal = async () => { throw new Error("Projection unavailable"); };
    const request = { titles: [{ provider: "codex", threadId: "task", taskTitle: "Correct title" }] };
    await assert.rejects(store.synchronizeTaskTitlesAndProject(request), /Projection unavailable/u);
    assert.equal((await journal.getRecord({ provider: "codex", threadId: "task", turnId: "turn" })).taskTitle,
      "Correct title");
    const recordRevision = new DatabaseSync(databaseFile, { readOnly: true });
    const readRevision = () => recordRevision.prepare("SELECT changed_revision FROM journal_records").get().changed_revision;
    const changedRevision = readRevision();
    try {
      await store.close();
      open();
      await worker.projectJournal({ projectRoots: [path.join(root, "unrelated")] });
      assert.deepEqual(await store.synchronizeTaskTitlesAndProject(request), { updated: 0, projected: true });
      assert.equal(readRevision(), changedRevision);
      assert.match(JSON.stringify(await journal.snapshot()), /Correct title/u);
      assert.deepEqual(await store.synchronizeTaskTitlesAndProject(request), {
        updated: 0, projected: false, reason: "unchanged",
      });
    } finally {
      recordRevision.close();
    }
  } finally {
    await store?.close();
    journal.close();
    await removeRoot(root);
  }
});

test("queued title mutation leaves an earlier projection callback free to record an exact turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-title-queue-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  let releaseCallback;
  let callbackEntered;
  const entered = new Promise((resolve) => { callbackEntered = resolve; });
  const released = new Promise((resolve) => { releaseCallback = resolve; });
  const store = createWorkLogUsageStore({
    ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: root,
    repositoryFactory: (options) => new WorkLogUsageRepository(options), usageSyncStore: worker,
  });
  try {
    const record = {
      provider: "codex", threadId: "task", turnId: "turn", projectRoot: root,
      completedAt: "2026-09-08T10:00:00.000Z", body: "Answer", taskTitle: "Old title",
    };
    await journal.upsertRecords([record]);
    const earlierProjection = worker.projectJournal({ projectRoots: [root] }, {
      workspaceResolver: async () => {
        callbackEntered();
        await released;
        await store.recordAutomaticAndProject({
          ...record, turnId: "concurrent", text: "Concurrent answer", deferProjection: true, resolveAccount: false,
        });
        return null;
      },
    });
    await entered;
    const titleUpdate = store.synchronizeTaskTitlesAndProject({
      titles: [{ provider: "codex", threadId: "task", taskTitle: "Correct title" }],
    });
    releaseCallback();
    assert.equal((await earlierProjection).conflict, true);
    assert.deepEqual(await titleUpdate, { updated: 2, projected: true });
    assert.equal(store.diagnostics().retainedRecords, 0);
  } finally {
    releaseCallback();
    await store.close();
    journal.close();
    await removeRoot(root);
  }
});

test("journal worker projects canonical valid records while preserving excluded legacy rows byte-for-byte", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-worker-invalid-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  let reader;
  try {
    const common = {
      provider: "codex", projectRoot: root, completedAt: "2026-09-08T10:00:00.000Z",
      usageReported: true, usage: { inputTokens: 1000 }, model: "gpt-6-astra",
    };
    await journal.upsertRecords([
      { ...common, threadId: "valid-thread", turnId: "valid-turn", body: "Valid retained answer" },
      { ...common, threadId: "invalid-thread", turnId: "invalid-turn", workLogId: "legacy-invalid-id", body: "Excluded private answer" },
      {
        ...common, threadId: "01900000-0002-7000-8000-000000000001",
        turnId: "01900000-0001-7000-8000-000000000002", aggregateOnly: true, body: "Inherited private answer",
      },
    ]);
    await journal.replaceIndexProjection("Original index");
    reader = new DatabaseSync(databaseFile, { readOnly: true });
    const rows = () => reader.prepare(
      "SELECT record_json, changed_revision FROM journal_records ORDER BY provider, thread_id, turn_id",
    ).all();
    const before = rows();
    const normalized = normalizePersistedWorkLog(await journal.loadLedger(), { defaultProjectRoot: root });
    assert.equal(normalized.invalidRecords.length, 2);
    const options = { projectRoots: [root], defaultProjectRoot: root, now: Date.parse("2026-09-08T12:00:00Z") };
    const canary = await worker.projectJournal({ ...options, expectedRevision: -1 });
    assert.equal(canary.conflict, true);
    assert.equal(canary.invalidRecordCount, 2);
    assert.equal((await journal.payload()).html, "Original index");
    const result = await worker.projectJournal(options);
    assert.equal(result.projected, true);
    assert.equal(result.recordCount, 1);
    assert.equal(result.invalidRecordCount, 2);
    assert.deepEqual(result.invalidRecordReasonCounts, { "inherited-parent-turn": 1, "invalid-work-log-id": 1 });
    assert.doesNotMatch(JSON.stringify(result), /private answer|legacy-invalid-id|invalid-thread/u);
    const expected = buildLazyJournalPayload(projectWorkLogUsage("# Глобальный журнал работ\n", normalized.ledger.turns, {
      accountCatalog: await journal.accountCatalog(), now: options.now,
    }));
    const actual = await journal.snapshot();
    assert.equal(actual.html, expected.html);
    assert.deepEqual(actual.days, expected.days);
    assert.deepEqual(actual.turns, expected.turns);
    assert.deepEqual(rows(), before);
  } finally {
    await worker.close();
    reader?.close();
    journal.close();
    await removeRoot(root);
  }
});

test("live point write releases repository lock before worker projection and stale projection cannot overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-worker-race-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: "device-local" });
  let store;
  let concurrentWrite = null;
  const record = (turnId) => ({
    provider: "codex", threadId: "thread-local", turnId, projectRoot: root,
    startedAt: "2026-09-08T09:59:00.000Z", completedAt: "2026-09-08T10:00:00.000Z",
    usageReported: true, usage: { inputTokens: 1000 }, model: "gpt-6-astra", body: turnId,
    resolveAccount: false,
  });
  store = createWorkLogUsageStore({
    ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: root,
    repositoryFactory: (options) => new WorkLogUsageRepository(options), usageSyncStore: worker,
    workspaceCatalogStore: {
      resolveThread: () => {
        concurrentWrite ??= store.recordAutomaticAndProject({ ...record("concurrent"), deferProjection: true })
          .then(() => journal.replaceIndexProjection("Concurrent index"));
        return null;
      },
      assignUnknownThread: () => null,
    },
  });
  try {
    await journal.replaceIndexProjection("Original index");
    const first = await store.recordAutomaticAndProject({ ...record("initial"), deferProjection: true });
    assert.equal(first.recorded, true);
    const projected = await worker.projectJournal({ projectRoots: [root] }, {
      workspaceResolver: async (reference) => {
        store.setUsageSyncDeviceLabel("Local device");
        concurrentWrite = store.recordAutomaticAndProject({ ...record("concurrent"), deferProjection: true })
          .then(() => journal.replaceIndexProjection("Concurrent index"));
        await concurrentWrite;
        return { workspaceId: "workspace-local", streamId: reference.threadId };
      },
    });
    assert.equal(projected.projected, false);
    assert.equal(projected.projectionDeferred, true);
    assert.equal(projected.reason, "stale-journal-revision");
    assert.equal((await journal.payload()).html, "Concurrent index");
    const recovered = await store.project(null, { projectRoot: root });
    assert.equal(recovered.projected, true);
    assert.equal(recovered.recordCount, 2);
    assert.equal(store.diagnostics().retainedRecords, 0);
    const live = await store.recordAutomaticAndProject(record("live"));
    assert.equal(live.projected, true);
    assert.ok(live.workerThreadId > 0);
    assert.equal(live.recordCount, 3);
    assert.equal(store.diagnostics().retainedRecords, 0);
  } finally {
    await concurrentWrite;
    await store.close();
    journal.close();
    await removeRoot(root);
  }
});

test("journal projection retries conflicts twice then rejects without holding the recording lock", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-worker-conflict-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  const journal = new JournalDatabase(databaseFile);
  let attempts = 0;
  let conflict = true;
  let store;
  const record = {
    provider: "codex", threadId: "thread-local", turnId: "turn-local", projectRoot: root,
    completedAt: "2026-09-08T10:00:00.000Z", body: "Durable answer", resolveAccount: false,
  };
  store = createWorkLogUsageStore({
    ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: root,
    repositoryFactory: (options) => new WorkLogUsageRepository(options), usageSyncStore: worker,
    workspaceCatalogStore: {
      resolveThread: async () => {
        attempts += 1;
        if (conflict) {
          await store.recordAutomaticAndProject({ ...record, title: `revision-${attempts}`, deferProjection: true });
          await journal.replaceIndexProjection(`Concurrent revision ${attempts}`);
        }
        return { workspaceId: "workspace-local", streamId: "stream-local" };
      },
      assignUnknownThread: () => null,
    },
  });
  try {
    await store.recordAutomaticAndProject({ ...record, deferProjection: true });
    await assert.rejects(store.project(null), { code: "JOURNAL_PROJECTION_CONFLICT" });
    assert.equal(attempts, 2);
    assert.equal((await journal.payload()).html, "Concurrent revision 2");
    assert.equal(store.diagnostics().retainedRecords, 0);
    conflict = false;
    const recovered = await store.project(null);
    assert.equal(recovered.projected, true);
    assert.equal(attempts, 3);
    await assert.rejects(worker.projectJournal({}, {
      workspaceResolver: () => { throw new Error("binding lookup failed"); },
    }), /binding lookup failed/u);
    assert.equal((await store.project(null)).reason, "unchanged");
  } finally {
    await store.close();
    journal.close();
    await removeRoot(root);
  }
});

test("worker journal initialization retries contention with a bounded deadline and can recover", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-journal-worker-busy-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  let blocker;
  let worker;
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 20);
  try {
    await journal.replaceIndexProjection("Preserved index");
    blocker = new DatabaseSync(databaseFile);
    blocker.exec("BEGIN IMMEDIATE");
    worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
    const started = performance.now();
    await assert.rejects(worker.projectJournal({ expectedRevision: -1 }), /database is locked|SQLITE_BUSY/iu);
    assert.ok(performance.now() - started >= 2_000);
    assert.ok(ticks > 1);
    blocker.exec("ROLLBACK");
    const result = await worker.projectJournal({ expectedRevision: -1 });
    assert.equal(result.conflict, true);
    assert.equal(result.projected, false);
    assert.equal((await journal.payload()).html, "Preserved index");
  } finally {
    clearInterval(timer);
    blocker?.close();
    await worker?.close();
    journal.close();
    await removeRoot(root);
  }
});

test("journal worker traces refused projections without changing results or exposing content", async (t) => {
  for (const scenario of [
    { conflict: true, projectionDeferred: true, projected: false, outcome: "failed" },
    { projectionDeferred: true, projected: false, outcome: "failed" },
    { conflict: false, projectionDeferred: false, projected: true, outcome: "succeeded" },
    { projected: false, reason: "unchanged", outcome: "succeeded" },
  ]) {
    await t.test(JSON.stringify(scenario), async () => {
      const { outcome, ...result } = scenario;
      const value = {
        ...result, expectedRevision: 41, revision: 42, durationMs: 12,
        html: "Private journal content", reasonDetail: "Private conflict detail",
        recordCount: NaN, renderMs: -1,
      };
      class ReplyWorker extends EventEmitter {
        postMessage(message) {
          queueMicrotask(() => this.emit("message", {
            id: message.id, value: message.type === "close" ? {} : value,
          }));
        }
        async terminate() {}
      }
      const spans = [];
      const worker = new WorkLogUsageSyncWorkerStore({ databaseFile: "unused.sqlite", WorkerImpl: ReplyWorker });
      worker.setTraceService({
        startBestEffortSpan: () => ({ finish: (span) => spans.push(span) }),
      });
      try {
        assert.deepEqual(await worker.projectJournal(), value);
        assert.equal(spans.length, 1);
        assert.equal(spans[0].outcome, outcome);
        assert.ok(Object.values(COMMAND_TRACE_OUTCOMES).includes(spans[0].outcome));
        assert.deepEqual(spans[0].metadata, {
          durationMs: 12, expectedRevision: 41, revision: 42,
          ...Object.fromEntries(["conflict", "projectionDeferred"]
            .filter((key) => typeof result[key] === "boolean")
            .map((key) => [key, result[key]])),
        });
      } finally {
        await worker.close();
      }
    });
  }
});

test("journal worker zero exit without a result rejects pending and future projections", async () => {
  class ExitingWorker extends EventEmitter {
    constructor() {
      super();
      queueMicrotask(() => this.emit("exit", 0));
    }
    postMessage() {}
  }
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile: "unused.sqlite", WorkerImpl: ExitingWorker });
  await assert.rejects(worker.projectJournal(), /exited with code 0/u);
  await assert.rejects(worker.projectJournal(), /unavailable/u);
});

test("usage sync account projection executes in a worker thread", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-worker-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  await journal.upsertRecords([{
    provider: "codex",
    threadId: "thread-local",
    taskThreadId: "thread-local",
    turnId: "turn-local",
    projectRoot: root,
    startedAt: "2026-08-20T09:59:00.000Z",
    completedAt: "2026-08-20T10:00:00.000Z",
    observedAt: "2026-08-20T10:01:00.000Z",
    accountKey: "chatgpt:owner",
    accountAttribution: "exact",
    usageReported: true,
    usage: { inputTokens: 100 },
    body: "x".repeat(2 * 1024 * 1024),
  }]);
  journal.close();
  const store = new WorkLogUsageSyncWorkerStore({
    databaseFile,
    deviceId: "device-local",
    defaultRuntimeHomeIds: { codex: "1".repeat(64) },
  });
  try {
    await store.importSnapshot({
      events: [{
        deviceId: "device-remote",
        provider: "codex",
        threadId: "thread-legacy",
        turnId: "turn-legacy",
        completedAt: "2026-08-20T08:00:00.000Z",
        accountKey: "chatgpt:untrusted",
        accountLabel: "untrusted@example.com",
        accountAttribution: "inferred",
        estimatedCredits: 1,
      }, {
        deviceId: "device-remote",
        provider: "codex",
        threadId: "thread-remote",
        turnId: "turn-remote",
        completedAt: "2026-08-20T09:00:00.000Z",
        accountKey: "chatgpt:owner",
        estimatedCredits: 2,
      }],
    });
    const result = await store.projectAccountUsage({
      html: "# Глобальный журнал работ\n",
      projectRoots: [root],
      accountCatalog: [{ key: "chatgpt:owner", label: "owner@example.com" }],
      localDeviceId: "device-local",
      now: Date.parse("2026-08-20T12:00:00.000Z"),
    });
    assert.equal(result.projected, true);
    assert.ok(result.workerThreadId > 0);
    assert.match(result.html, /data-work-log-account-panel/u);
    assert.match(result.html, /data-account-key="chatgpt:owner"/u);
    assert.match(result.html, /data-account-key="__unknown_account__"/u);
    assert.match(result.html, /data-account-turns="1"/u);
    assert.match(result.html, /data-account-sync-turns="2"/u);
    assert.equal(result.eventCount, 2);
    const forced = await store.projectAccountUsage({
      html: result.html,
      projectRoots: [root],
      accountCatalog: [{ key: "chatgpt:owner", label: "owner@example.com" }],
      localDeviceId: "device-local",
      now: Date.parse("2026-08-20T12:00:00.000Z"),
      force: true,
    });
    assert.equal(forced.projected, true);
    assert.ok(["forced", "updated"].includes(forced.reason));
    assert.ok(forced.html);
    const snapshot = await store.usageSyncSnapshot({
      deviceLabel: "local",
      afterObservedAt: "2026-08-20T10:00:30.000Z",
    });
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].completedAt, "2026-08-20T10:00:00.000Z");
    assert.ok(snapshot.workerThreadId > 0);
    assert.equal(store.diagnostics().pendingRequests, 0);
  } finally {
    await store.close();
    await removeRoot(root);
  }
});

test("usage sync revision cursor retains same-ms and late journal changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-cursor-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const observedAt = "2026-08-20T10:01:00.000Z";
  const record = (turnId, overrides = {}) => ({
    provider: "codex",
    threadId: `thread-${turnId}`,
    taskThreadId: `thread-${turnId}`,
    turnId,
    projectRoot: root,
    startedAt: "2026-08-20T09:59:00.000Z",
    completedAt: "2026-08-20T10:00:00.000Z",
    observedAt,
    accountKey: "chatgpt:owner",
    accountAttribution: "exact",
    usageReported: true,
    usage: { inputTokens: 10 },
    ...overrides,
  });
  const journal = new JournalDatabase(databaseFile);
  const initial = await journal.upsertRecords([record("a"), record("b")]);
  journal.close();
  const store = new WorkLogUsageSyncWorkerStore({
    databaseFile,
    deviceId: "device-local",
    defaultRuntimeHomeIds: { codex: "1".repeat(64) },
  });
  try {
    const first = await store.usageSyncSnapshot({ afterJournalRevision: 0 });
    assert.equal(first.journalRevision, initial.revision);
    assert.equal(first.events.length, 2);

    const updatedJournal = new JournalDatabase(databaseFile);
    const updated = await updatedJournal.upsertRecords([
      record("a", { usage: { inputTokens: 99 } }),
      record("late", {
        completedAt: "2026-08-20T09:00:00.000Z",
        observedAt: "2026-08-20T09:01:00.000Z",
      }),
    ]);
    updatedJournal.close();

    const delta = await store.usageSyncSnapshot({ afterJournalRevision: initial.revision });
    assert.equal(delta.journalRevision, updated.revision);
    assert.equal(delta.events.length, 2);
    assert.deepEqual(delta.events.map((event) => event.usage.inputTokens).sort((a, b) => a - b), [10, 99]);
    assert.equal((await store.usageSyncSnapshot({
      afterJournalRevision: updated.revision,
    })).events.length, 0);
  } finally {
    await store.close();
    await removeRoot(root);
  }
});

test("usage sync worker keeps turns without startedAt as accountless legacy events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-missing-start-"));
  const sourceDatabaseFile = path.join(root, "source.sqlite");
  const targetDatabaseFile = path.join(root, "target.sqlite");
  const journal = new JournalDatabase(sourceDatabaseFile);
  await journal.upsertRecords([{
    provider: "codex",
    threadId: "thread-missing-start",
    taskThreadId: "thread-missing-start",
    turnId: "turn-missing-start",
    projectRoot: root,
    completedAt: "2026-08-20T10:00:00.000Z",
    observedAt: "2026-08-20T10:01:00.000Z",
    accountKey: "chatgpt:owner",
    accountAttribution: "exact",
    estimatedCredits: 4,
    usage: { inputTokens: 10 },
  }]);
  journal.close();
  const source = new WorkLogUsageSyncWorkerStore({
    databaseFile: sourceDatabaseFile,
    deviceId: "device-local",
    defaultRuntimeHomeIds: { codex: "1".repeat(64) },
  });
  const target = new WorkLogUsageSyncWorkerStore({
    databaseFile: targetDatabaseFile,
    deviceId: "device-target",
  });
  try {
    const snapshot = await source.usageSyncSnapshot({ deviceLabel: "local" });
    assert.equal(snapshot.events.length, 1);
    assert.equal(snapshot.events[0].schemaVersion, 1);
    assert.equal(snapshot.events[0].startedAt, "");
    assert.equal(snapshot.events[0].runtimeHomeId, "");
    assert.ok(!Object.hasOwn(snapshot.events[0], "accountKey"));

    const imported = await target.importSnapshot(snapshot);
    assert.equal(imported.added, 1);
    const [event] = await target.events();
    assert.equal(event.schemaVersion, 1);
    assert.equal(event.estimatedCredits, 4);
    assert.ok(!Object.hasOwn(event, "accountKey"));
  } finally {
    await source.close();
    await target.close();
    await removeRoot(root);
  }
});

test("cursor usage snapshot keeps auth and limit facts without re-exporting stored sync events", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-cursor-facts-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const initial = await journal.upsertRecords([{
    provider: "codex", threadId: "thread-local", taskThreadId: "thread-local", turnId: "turn-local",
    projectRoot: root, startedAt: "2026-08-20T09:59:00.000Z", completedAt: "2026-08-20T10:00:00.000Z",
    observedAt: "2026-08-20T10:01:00.000Z", accountKey: "chatgpt:owner", accountAttribution: "exact",
    usageReported: true, usage: { inputTokens: 10 },
  }]);
  journal.close();
  const store = new WorkLogUsageSyncWorkerStore({
    databaseFile, deviceId: "device-local", defaultRuntimeHomeIds: { codex: "1".repeat(64) },
  });
  try {
    await store.importSnapshot({ events: [{
      deviceId: "device-remote", provider: "codex", threadId: "thread-remote", turnId: "turn-remote",
      completedAt: "2026-08-20T09:00:00.000Z", estimatedCredits: 2,
    }, {
      schemaVersion: USAGE_FACT_SCHEMA_VERSION,
      type: "auth_observation", deviceId: "device-remote", provider: "codex", runtimeHomeId: "2".repeat(64),
      accountKey: "chatgpt:owner", observedAt: "2026-08-20T09:30:00.000Z",
      installationInstanceId: "0b7f3a52-3c1e-4c55-9a8e-5d2f1a7c9e10",
    }, {
      schemaVersion: USAGE_FACT_SCHEMA_VERSION,
      type: "limit_observation", deviceId: "device-remote", provider: "codex", accountKey: "chatgpt:owner",
      limitId: "codex", window: "primary", observedAt: "2026-08-20T09:30:00.000Z", usedPercent: 40,
    }] });
    const turns = (snapshot) => snapshot.events.filter((event) => event.type === "turn").map((event) => event.deviceId).sort();
    const observations = (snapshot) => snapshot.events.filter((event) => event.observationId).map((event) => event.type).sort();

    const full = await store.usageSyncSnapshot();
    assert.deepEqual(turns(full), ["device-local", "device-remote"]);
    assert.deepEqual(observations(full), ["auth_observation", "limit_observation"]);

    const cursor = await store.usageSyncSnapshot({ afterJournalRevision: initial.revision });
    assert.equal(cursor.journalRevision, initial.revision);
    assert.deepEqual(turns(cursor), []);
    assert.deepEqual(observations(cursor), ["auth_observation", "limit_observation"]);
  } finally {
    await store.close();
    await removeRoot(root);
  }
});
