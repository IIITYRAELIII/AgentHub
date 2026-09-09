import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { buildWorkLogUsageHistory, normalizePersistedWorkLog } from "../../src/application/work-log-usage-projection.mjs";

test("worker usage history preserves accounting, filters and time buckets without materializing the runtime ledger", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-history-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: "local-device" });
  let locked = false;
  let runtimeLedgerReads = 0;
  let resolvedWorkspaces = 0;
  let runtimeRepository;
  const spans = [];
  worker.setTraceService(new CommandTraceService({
    store: { appendBestEffort: (span) => { spans.push(span); return true; } },
    metadata: { instanceId: "instance", releaseId: "release" },
  }));
  class RuntimeJournal extends JournalDatabase {
    loadLedger() {
      runtimeLedgerReads += 1;
      throw new Error("usage read must not materialize all records in the runtime");
    }
  }
  class RuntimeRepository extends WorkLogUsageRepository {
    enqueue(operation, options) {
      return super.enqueue(async () => {
        locked = true;
        try { return await operation(); } finally { locked = false; }
      }, options);
    }
  }
  const runtimeJournal = new RuntimeJournal(databaseFile);
  const base = {
    provider: "codex", threadId: "thread", projectRoot: root,
    startedAt: "2026-09-08T07:50:00.000Z", completedAt: "2026-09-08T08:10:00.000Z",
    usage: { inputTokens: 1000, cachedInputTokens: 250, outputTokens: 500, totalTokens: 1500 },
    model: "gpt-6-astra", serviceTier: "fast", accountKey: "chatgpt:account",
  };
  const binding = { workspaceId: "workspace", streamId: "stream", workspaceName: "Workspace", streamName: "Stream" };
  const originalUsageHistory = worker.usageHistory.bind(worker);
  worker.usageHistory = (...args) => {
    assert.equal(locked, false, "worker read must start after migration fence releases the mutation lock");
    return originalUsageHistory(...args);
  };
  try {
    await journal.upsertRecords([
      { ...base, turnId: "priced", prompt: "Prompt", body: "Answer", diff: "large diff\n".repeat(100_000) },
      { ...base, turnId: "old-price", completedAt: "2026-09-07T08:10:00.000Z", model: "gpt-5.6-sol" },
      { ...base, turnId: "image", usageReported: false, estimatedCredits: 20, estimateKind: "imagegen-default" },
      { ...base, turnId: "unknown", usageReported: false, estimatedCredits: 0 },
      { ...base, turnId: "claude", provider: "claude", accountKey: "anthropic:account" },
      { ...base, turnId: "invalid", workLogId: "invalid" },
    ]);
    await worker.importSnapshot({ events: [{
      schemaVersion: 2, type: "turn", deviceId: "remote-device", runtimeHomeId: "remote-home",
      provider: "codex", threadId: "remote-thread", turnId: "remote-turn",
      startedAt: base.startedAt, completedAt: base.completedAt, usage: base.usage,
      model: base.model, usageReported: true,
    }, {
      schemaVersion: 2, type: "auth_observation", deviceId: "remote-device",
      installationInstanceId: "remote-installation", provider: "codex", runtimeHomeId: "remote-home",
      accountKey: "chatgpt:account", accountLabel: "account@example.test", accountType: "chatgpt",
      accountPlan: "pro", observedAt: "2026-09-08T07:00:00.000Z",
      evidenceSource: "account-read", authFingerprint: "fingerprint",
    }] });
    const ledger = await journal.loadLedger();
    const normalized = normalizePersistedWorkLog(ledger, { defaultProjectRoot: root });
    const facts = await worker.facts();
    const store = createWorkLogUsageStore({
      repositoryFactory: (options) => {
        runtimeRepository = new RuntimeRepository({ ...options, journalDatabase: runtimeJournal });
        return runtimeRepository;
      },
      ledgerFile: path.join(root, "retired-ledger.json"), databaseFile,
      defaultProjectRoot: root, usageSyncStore: worker,
      usageSyncDeviceId: "local-device", usageSyncDeviceLabel: "Local device",
      workspaceCatalogStore: {
        resolveThread: () => { resolvedWorkspaces += 1; return binding; },
        assignUnknownThread: () => { throw new Error("statistics must not assign already-resolved threads"); },
      },
    });
    const common = {
      now: Date.parse("2026-09-08T12:00:00Z"),
      localDeviceId: "local-device", localDeviceLabel: "Local device",
      accountActivity: [{ accountKey: "chatgpt:account", intervals: [{ from: "2026-09-08T07:00:00Z", to: "2026-09-08T12:00:00Z" }] }],
    };
    for (const options of [
      ...["6h", "24h", "7d", "all"].flatMap((range) => ["start", "middle", "end"].map((turnTimeMode) => ({ range, turnTimeMode }))),
      { provider: "claude" }, { includeClaudeUsage: false }, { accountKey: "chatgpt:account" },
      { accountActivity: [] }, { workspaceId: "workspace" }, { streamId: "absent" },
      { activeIntervals: [{ from: "2026-09-08T08:00:00Z", to: "2026-09-08T09:00:00Z" }] },
    ]) {
      const input = { ...common, ...options };
      const expected = buildWorkLogUsageHistory(normalized.ledger.turns, {
        ...input, syncedUsageEvents: facts, workspaceResolver: () => binding,
      });
      const actual = await store.usageHistory(input);
      assert.deepEqual(actual, expected, JSON.stringify(options));
      assert.equal(store.diagnostics().retainedRecords, 0);
    }
    assert.equal(runtimeLedgerReads, 0);
    assert.equal(resolvedWorkspaces, 4, "only the two explicitly scoped queries resolve two distinct threads");
    assert.deepEqual(await journal.loadLedger(), ledger, "read projection never changes canonical usage or diff");
    const measured = worker.diagnostics().lastUsageHistory;
    assert.ok(measured.workerThreadId > 0);
    assert.equal(measured.recordCount, 5);
    assert.equal(measured.invalidRecordCount, 1);
    for (const key of ["queueWaitMs", "ledgerReadMs", "normalizeMs", "factsReadMs", "aggregateMs", "totalMs"]) {
      assert.ok(Number.isFinite(measured[key]) && measured[key] >= 0, key);
    }
    const historySpans = spans.filter((span) => span.metadata.action === "usage-history");
    assert.equal(historySpans.filter((span) => span.outcome === "started").length, 19);
    assert.equal(historySpans.filter((span) => span.outcome === "succeeded").length, 19);
    for (const terminal of historySpans.filter((span) => span.outcome === "succeeded")) {
      assert.ok(historySpans.some((span) => span.outcome === "started"
        && span.metadata.operationSpanId === terminal.metadata.operationSpanId));
      assert.ok(Number.isFinite(terminal.metadata.ledgerReadMs));
      assert.ok(Number.isFinite(terminal.metadata.queueWaitMs));
      assert.equal(terminal.metadata.releaseId, "release");
    }
    assert.equal(JSON.stringify(spans).includes("Prompt"), false);
    assert.equal(JSON.stringify(spans).includes("account@example.test"), false);

    worker.usageHistory = originalUsageHistory;
    let releaseMutation;
    let enteredMutation;
    const entered = new Promise((resolve) => { enteredMutation = resolve; });
    const held = runtimeRepository.enqueue(async () => {
      enteredMutation();
      await new Promise((resolve) => { releaseMutation = resolve; });
    }, { load: false });
    await entered;
    let deadline;
    try {
      const independent = await Promise.race([
        store.usageHistory(common),
        new Promise((_, reject) => {
          deadline = setTimeout(() => reject(new Error("statistics waited behind an unrelated runtime mutation")), 5_000);
        }),
      ]);
      assert.equal(independent.totalCredits, buildWorkLogUsageHistory(normalized.ledger.turns, {
        ...common, syncedUsageEvents: facts,
      }).totalCredits);
    } finally {
      clearTimeout(deadline);
      releaseMutation();
      await held;
    }
    worker.setTraceService({ startBestEffortSpan: () => { throw new Error("trace unavailable"); } });
    await store.usageHistory(common);
    worker.setTraceService({ startBestEffortSpan: () => ({ finish: () => { throw new Error("trace unavailable"); } }) });
    await store.usageHistory(common);
  } finally {
    await worker.close();
    runtimeJournal.close();
    journal.close();
    await rm(root, { recursive: true, force: true });
  }
});
