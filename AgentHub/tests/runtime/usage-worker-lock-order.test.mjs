import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

for (const scenario of [
  { name: "statistics", methods: ["usageHistory"], run: (store) => store.usageHistory() },
  { name: "export", methods: ["usageSyncSnapshot"], run: (store) => store.usageSyncSnapshot() },
  { name: "import", methods: ["importSnapshot"], run: (store) => store.importUsageSyncSnapshotAndProject({
    snapshot: { events: [{ provider: "codex", deviceId: "other-device", threadId: "remote", turnId: "remote-turn",
      completedAt: "2026-09-08T08:00:00Z", estimatedCredits: 2 }] },
  }) },
  { name: "account projection", methods: ["projectAccountUsage"], run: (store) => store.ensureAccountUsageProjectionCurrent({ required: true }) },
  { name: "explicit record projection", methods: ["facts", "projectJournal"], run: (store, record) => store.recordAndProject({
    ...record, workLogId: "3bccb994-1944-4e0d-8784-37d85c2a4a17", resolveAccount: false,
  }) },
]) {
  test(`${scenario.name} cannot invert the usage worker and runtime mutation locks`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-lock-order-"));
    const databaseFile = path.join(root, "journal.sqlite");
    const journal = new JournalDatabase(databaseFile);
    const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
    let repository;
    const metadataEntered = deferred();
    const grantMetadata = deferred();
    const operationSubmitted = deferred();
    let timer;
    let settlements;
    const record = {
      provider: "codex", threadId: "thread", turnId: "turn", projectRoot: root,
      completedAt: "2026-09-08T08:00:00Z", startedAt: "2026-09-08T07:59:00Z",
      body: "Canonical answer", taskTitle: "Before", estimatedCredits: 2,
    };
    try {
      await journal.upsertRecords([record]);
      const store = createWorkLogUsageStore({
        repositoryFactory: (options) => {
          repository = new WorkLogUsageRepository({ ...options, journalDatabase: journal });
          return repository;
        },
        ledgerFile: path.join(root, "retired.json"), databaseFile,
        defaultProjectRoot: root, usageSyncStore: worker,
      });
      await store.getTurn(record);
      const metadata = worker.synchronizeTaskTitles({
        projectRoot: root, defaultProjectRoot: root,
        titles: [{ provider: "codex", threadId: "thread", taskTitle: "After" }],
      }, { mutationLock: async (mutate) => {
        metadataEntered.resolve();
        await grantMetadata.promise;
        return repository.enqueue(() => repository.applyExternalMutation(mutate), { load: false, pointRead: true });
      } });
      await metadataEntered.promise;
      for (const method of scenario.methods) {
        const original = worker[method].bind(worker);
        worker[method] = (...args) => {
          operationSubmitted.resolve();
          return original(...args);
        };
      }
      const operation = scenario.run(store, record);
      settlements = Promise.allSettled([metadata, operation]);
      await operationSubmitted.promise;
      grantMetadata.resolve();
      const results = await Promise.race([
        settlements,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("crossed worker/runtime lock requests did not finish")), 5_000);
        }),
      ]);
      assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
      assert.equal((await journal.getRecord(record)).taskTitle, "After");
      assert.equal((await journal.getRecord(record)).body, record.body);
    } finally {
      clearTimeout(timer);
      grantMetadata.resolve();
      await worker.close();
      await settlements;
      journal.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
