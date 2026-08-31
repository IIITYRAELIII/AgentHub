import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";

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
  });
  try {
    await store.importSnapshot({
      events: [{
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
    assert.equal(result.eventCount, 1);
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
    await rm(root, { recursive: true, force: true });
  }
});
