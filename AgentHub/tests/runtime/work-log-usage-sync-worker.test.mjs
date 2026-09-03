import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";

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
