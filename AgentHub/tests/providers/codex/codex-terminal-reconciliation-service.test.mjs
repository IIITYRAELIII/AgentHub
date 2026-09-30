import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CodexTerminalReconciliationService } from "../../../src/providers/codex/codex-terminal-reconciliation-service.mjs";
import { createRunAccountingComposition } from "../../../src/composition/run-accounting-composition.mjs";
import { RunJournalService } from "../../../src/application/run-journal-service.mjs";
import { createWorkLogUsageStore } from "../../../src/application/work-log-usage-store.mjs";
import { CodexTerminalAudit } from "../../../src/providers/codex/codex-terminal-audit.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";

function usage(overrides = {}) {
  return {
    terminal: true,
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    finalAnswer: "Готово",
    reported: true,
    usage: { totalTokens: 10 },
    changedFiles: [],
    ...overrides,
  };
}

function harness(overrides = {}) {
  const calls = [];
  const delivered = new Set();
  const pending = new Map();
  const completions = [];
  const notifications = {
    hasDelivered: ({ turnId }) => delivered.has(turnId),
    get: ({ turnId }) => pending.get(turnId) ?? null,
    takePendingMessage: ({ turnId }) => pending.get(turnId)?.message ?? null,
    recordCompletion: (completion) => {
      completions.push(completion);
      return completion;
    },
  };
  const service = new CodexTerminalReconciliationService({
    notifications,
    turnStarts: new Map(),
    workLogStore: { getTurn: async () => null },
    accountingThread: async (thread) => ({
      threadId: thread.id,
      parentThreadId: "",
      thread,
      isSubagent: false,
    }),
    subagentParentTurnId: async () => "",
    readTurnUsage: async () => usage(),
    taskGitDiff: async () => "",
    dataDir: "data",
    changedFilesForRun: () => [],
    projectTurn: async (...args) => {
      calls.push(["project", ...args]);
      return {};
    },
    taskTitle: async () => "Task",
    defaultChatId: () => 42,
    fallbackMessage: (status) => `fallback:${status}`,
    rememberLastMessage: (...args) => calls.push(["remember", ...args]),
    rememberSeenTurn: (...args) => calls.push(["seen", ...args]),
    saveState: async () => calls.push(["save"]),
    deliverNotification: async (completion) => calls.push(["deliver", completion.turnId]),
    repairTerminalAttachments: async (...args) => calls.push(["repair-attachments", ...args]),
    resolveTerminalAttachments: async () => [],
    now: () => Date.parse("2026-08-04T12:00:00.000Z"),
    logger: {
      log: (...args) => calls.push(["log", ...args]),
      warn: (...args) => calls.push(["warn", ...args]),
      error: (...args) => calls.push(["error", ...args]),
    },
    ...overrides,
  });
  return { service, calls, completions, delivered, pending, notifications };
}

const thread = { id: "thread-1", path: "rollout.jsonl" };
const project = { path: process.cwd() };

test("persisted dedicated compaction terminal is accounted without completion card or last-message mutation", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-compaction-terminal-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new MaintenanceOperationStore({ dataDir: directory });
  for (const status of ["succeeded", "failed", "reconciling"]) {
    const turnId = `dedicated-${status}`;
    store.create({
      kind: "context-compaction", streamId: "stream-1", threadId: thread.id,
      providerTurnId: turnId, status, metadata: { dedicatedProviderTurn: true },
    });
    for (const deliveryState of ["fresh", "historical", "delivered"]) {
      // Re-open the authority as startup/recovery does; no in-memory tracker proof.
      const { service, calls, completions, delivered } = harness({
        operationStore: new MaintenanceOperationStore({ dataDir: directory }),
      });
      if (deliveryState === "delivered") delivered.add(turnId);
      let deferred = 0;
      service.projectTurn = async (...args) => { calls.push(["project", ...args]); return { projectionDeferred: true }; };
      assert.equal(await service.reconcile(thread, project, {
        turnId, status: "completed", completedAt: "2026-08-04T10:00:00.000Z",
        historical: deliveryState === "historical",
        usageResult: usage({ finalAnswer: "", usage: { totalTokens: 123 } }),
      }, { onProjectionDeferred: () => { deferred += 1; } }), true);
      assert.deepEqual(completions, []);
      assert.equal(calls.some(([name]) => ["deliver", "remember", "seen"].includes(name)), false);
      const projection = calls.find(([name]) => name === "project");
      assert.equal(projection[1].operationKind, "context-compaction");
      assert.equal(projection[1].usage.totalTokens, 123);
      assert.equal(projection[1].usageReported, true);
      assert.equal(projection[1].status, "completed", "provider terminal remains accounting authority");
      assert.equal(projection[2].title, "Свёртка контекста");
      assert.equal(projection[2].body, "");
      assert.equal(deferred, 1);
    }
  }
});

test("live context probe service usage keeps its measurement identity and no marker body", async () => {
  const { service, calls, completions } = harness();
  const marker = "AGENT_HUB_CONTEXT_PROBE_OK_V1";
  assert.equal(await service.reconcile(thread, project, {
    turnId: "live-context-probe",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    historical: false,
    usageResult: usage({
      clientUserMessageId: "agent-hub-context-probe:de823030-9f98-40e6-9d93-066062d977c6",
      serviceUsageKind: "context-probe",
      finalAnswer: marker,
      usage: { totalTokens: 120 },
    }),
  }), true);
  const projection = calls.find(([name]) => name === "project");
  assert.ok(projection);
  assert.equal(projection[1].operationKind, "context-measurement");
  assert.equal(projection[1].serviceUsageKind, "context-probe");
  assert.equal(projection[1].usage.totalTokens, 120);
  assert.equal(projection[1].accountAttribution, "unknown");
  assert.equal(projection[1].resolveAccount, false);
  assert.equal(projection[2].title, "Измерение контекста");
  assert.equal(projection[2].body, "");
  assert.deepEqual(completions, []);
  assert.equal(calls.some(([name]) => ["deliver", "remember", "seen"].includes(name)), false);
});

test("inline, legacy markerless and foreign compactions cannot suppress an ordinary provider final", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-inline-compaction-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const operationStore = new MaintenanceOperationStore({ dataDir: directory });
  for (const [turnId, metadata] of [["inline", { dedicatedProviderTurn: false }], ["legacy", {}]]) {
    operationStore.create({ kind: "context-compaction", streamId: "stream-1", threadId: thread.id,
      providerTurnId: turnId, metadata });
  }
  operationStore.create({ kind: "context-compaction", streamId: "stream-2", threadId: "foreign-thread",
    providerTurnId: "foreign", metadata: { dedicatedProviderTurn: true } });
  for (const turnId of ["inline", "legacy", "foreign", "empty-ordinary"]) {
    const { service, calls, completions } = harness({ operationStore });
    const answer = turnId === "empty-ordinary" ? "" : "Ordinary final after inline compaction";
    assert.equal(await service.reconcile(thread, project, {
      turnId, status: "completed", completedAt: "2026-08-04T10:00:00.000Z",
      usageResult: usage({ finalAnswer: answer }),
    }), true);
    assert.equal(completions.length, 1);
    assert.equal(completions[0].operationKind, "user-turn");
    assert.equal(completions[0].finalAnswer, answer);
    assert.equal(calls.some(([name]) => name === "deliver"), true);
  }
});

test("audit persists eight corrected turns through accounting without loading the ledger and flushes once", async () => {
  const records = new Map();
  const writes = [];
  const events = [];
  const identities = Array.from({ length: 8 }, (_, index) => ({
    provider: "codex", threadId: thread.id, turnId: `repair-${index}`,
  }));
  const keyFor = (identity) => [identity.provider, identity.threadId, identity.turnId].join("\0");
  for (const identity of identities.slice(0, 3)) {
    records.set(keyFor(identity), { ...identity, projectRoot: project.path, usageReported: false });
  }
  const usageStore = createWorkLogUsageStore({
    defaultProjectRoot: project.path,
    repositoryFactory: () => ({
      get ledger() { assert.fail("Reconciliation must not materialize the full ledger"); },
      enqueue: async (operation, options) => {
        assert.equal(options?.load, false);
        return operation();
      },
      getRecord: async (identity) => records.get(keyFor(identity)) ?? null,
      saveRecord: async (key, record) => {
        records.set(key, record);
        writes.push(key);
        events.push("write");
      },
      save: async () => assert.fail("Reconciliation must not save the full ledger"),
      payload: async () => assert.fail("Reconciliation must not load projection HTML"),
      replaceProjection: async () => assert.fail("Reconciliation must not eagerly project"),
    }),
  });
  const runJournal = new RunJournalService({ usageStore, findProject: () => project });
  const accounting = createRunAccountingComposition({ runJournal });
  const { service, delivered, calls, completions } = harness({
    projectTurn: accounting.projectTurnUsageToWorkLog,
    workLogStore: { getTurn: async (identity) => records.get(keyFor(identity)) ?? null },
  });
  for (const identity of identities) delivered.add(identity.turnId);
  const terminals = identities.map((identity, index) => ({
    turnId: identity.turnId,
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    ...(index >= 6 ? { historical: true } : {}),
    usageResult: usage({ usage: { inputTokens: index + 1 }, finalAnswer: `Corrected ${index}` }),
  }));
  let flushes = 0;
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-04T10:20:00.000Z"),
    discoverHistoricalThreads: async () => [thread],
    resolveProject: () => project,
    statFile: async () => ({ size: 100 }),
    scanFile: async () => ({ terminals, activeTurns: [], nextOffset: 100 }),
    reconcile: (...args) => service.reconcile(...args),
    persistProgress: async () => events.push("checkpoint"),
    flushHistoricalProjection: async () => {
      assert.equal(records.size, 8);
      flushes += 1;
      events.push("flush");
    },
  });
  await audit.run();
  assert.equal(writes.length, 8);
  assert.equal(flushes, 1);
  assert.equal(events.indexOf("checkpoint"), 8);
  assert.equal(events.indexOf("flush"), 9);
  for (const [index, identity] of identities.entries()) {
    const record = records.get(keyFor(identity));
    assert.equal(record.usageReported, true);
    assert.equal(record.usage.inputTokens, index + 1);
    assert.equal(record.completedAt, "2026-08-04T10:00:00.000Z");
    assert.equal(record.body, `Corrected ${index}`);
  }
  assert.deepEqual(completions, []);
  assert.equal(calls.some(([name]) => name === "deliver"), false);
  assert.equal(calls.filter(([name]) => name === "remember").length, 6);
  assert.equal(audit.snapshot().liveProjectionPending, false);
  await audit.run();
  assert.equal(writes.length, 8);
  assert.equal(flushes, 1);
});

test("historical and subagent audit flushes follow actual deferred mutations rather than handled terminals", async () => {
  for (const kind of ["historical", "subagent", "already-equal", "maintenance"]) {
    for (const changed of [false, true]) {
      let projections = 0;
      let flushes = 0;
      const candidate = { ...thread, ...(kind === "subagent" ? { parentThreadId: "parent" } : {}) };
      const { service, calls } = harness({
        accountingThread: async (value) => ({ threadId: value.id, thread: value, isSubagent: kind === "subagent" }),
        workLogStore: { getTurn: async () => kind === "already-equal" ? { usageReported: true, usage: { totalTokens: 10 } } : null },
        projectTurn: async () => { projections += 1; return { projected: false, projectionDeferred: changed }; },
      });
      const terminal = { turnId: "checked", status: "completed", completedAt: "2026-08-04T10:00:00.000Z", usageResult: usage(), ...(kind === "subagent" ? {} : { historical: true }) };
      const audit = new CodexTerminalAudit({
        now: () => Date.parse("2026-08-04T10:20:00.000Z"),
        discoverHistoricalThreads: async () => [candidate],
        resolveProject: () => project,
        statFile: async () => ({ size: 100 }),
        scanFile: async () => ({ terminals: [terminal], activeTurns: [], nextOffset: 100 }),
        scanHistoricalFile: async () => ({ turns: [{ ...terminal.usageResult, turnId: terminal.turnId }] }),
        reconcile: (...args) => service.reconcile(...args),
        flushHistoricalProjection: async () => { flushes += 1; },
      });
      if (kind === "maintenance") {
        audit.restore({
          ...audit.snapshot(),
          historicalSubagentBackfill: { pending: true, initialized: true, prepared: true, queue: [{ thread: candidate, offset: 0, size: 100 }] },
        });
        await audit.runHistoricalMaintenance();
      } else {
        await audit.run();
      }
      assert.equal(projections, kind === "already-equal" ? 0 : 1, kind);
      assert.equal(flushes, changed && kind !== "already-equal" ? 1 : 0, kind);
      assert.equal(calls.some(([name]) => name === "deliver"), false, kind);
    }
  }
});

test("fresh audit terminal still saves and delivers its notification when projection deferral is requested", async () => {
  let deferred = 0;
  const { service, calls, completions } = harness();
  await service.reconcile(thread, project, {
    turnId: "fresh", status: "completed", completedAt: "2026-08-04T10:00:00.000Z", usageResult: usage(),
  }, { deferProjection: true, onProjectionDeferred: () => { deferred += 1; } });
  assert.equal(completions.length, 1);
  assert.equal(completions[0].turnId, "fresh");
  assert.ok(calls.findIndex(([name]) => name === "save") < calls.findIndex(([name]) => name === "deliver"));
  assert.deepEqual(calls.filter(([name]) => name === "deliver"), [["deliver", "fresh"]]);
  assert.equal(deferred, 0);
});

test("delivered correction outside an audit retains immediate projection", async () => {
  const { service, delivered, calls } = harness();
  delivered.add("turn-1");
  await service.reconcile(thread, project, {
    turnId: "turn-1", status: "completed", completedAt: "2026-08-04T10:00:00.000Z", usageResult: usage(),
  });
  assert.equal(calls.find(([name]) => name === "project")[2].deferProjection, false);
});

test("recent completed Codex turns keep their grace period before reconciliation", async () => {
  const { service, completions } = harness({
    now: () => Date.parse("2026-08-04T10:00:05.000Z"),
  });
  const result = await service.reconcile(thread, project, {
    turnId: "turn-1",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
  });
  assert.equal(result, false);
  assert.deepEqual(completions, []);
});




test("historical reconciliation refreshes an existing turn when rollout usage changed", async () => {
  const { service, calls } = harness({
    workLogStore: {
      getTurn: async () => ({
        provisional: false,
        usageReported: true,
        usage: { totalTokens: 5 },
        serviceTier: "default",
      }),
    },
  });
  const result = await service.reconcile(thread, project, {
    turnId: "turn-1",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    historical: true,
    usageResult: usage({ usage: { totalTokens: 10 }, serviceTier: "default" }),
  });

  assert.equal(result, true);
  assert.equal(calls.some(([name]) => name === "project"), true);
});

test("unhooked terminal Codex turn is recorded, saved and delivered once", async () => {
  const { service, calls, completions } = harness();
  const result = await service.reconcile(thread, project, {
    turnId: "turn-1",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    usageResult: usage(),
  });
  assert.equal(result, true);
  assert.equal(completions.length, 1);
  assert.equal(completions[0].threadId, "thread-1");
  assert.equal(completions[0].chatId, 42);
  assert.equal(calls.some(([name]) => name === "save"), true);
  assert.equal(calls.some(([name, turnId]) => name === "deliver" && turnId === "turn-1"), true);
});

test("unhooked terminal reconciliation commits generated image attachments", async () => {
  const responseAttachments = [
    { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
  ];
  const resolverCalls = [];
  const { service, completions } = harness({
    resolveTerminalAttachments: async (run, turnId) => {
      resolverCalls.push({ run, turnId });
      return responseAttachments;
    },
  });
  await service.reconcile(thread, project, {
    turnId: "turn-image",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    usageResult: usage({ startedAt: "2026-08-04T09:59:00.000Z" }),
  });

  assert.deepEqual(resolverCalls, [{
    run: {
      threadId: "thread-1",
      startedAt: "2026-08-04T09:59:00.000Z",
      rolloutPath: "rollout.jsonl",
    },
    turnId: "turn-image",
  }]);
  assert.deepEqual(completions[0].responseAttachments, responseAttachments);
});

test("terminal reconciliation keeps only exact rollout file receipts", async () => {
  const { service, completions } = harness({
    changedFilesForRun: () => ["foreign.mjs"],
  });
  await service.reconcile(thread, project, {
    turnId: "turn-files",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    usageResult: usage({ changedFiles: ["owned.mjs"] }),
  });

  assert.deepEqual(completions[0].changedFiles, ["owned.mjs"]);
});

test("delivered provisional turn is corrected without a second notification", async () => {
  const pendingMessage = { text: "Исправленный ответ", title: "Исправлено" };
  const { service, calls, delivered, pending, completions } = harness({
    workLogStore: { getTurn: async () => ({ provisional: true }) },
  });
  delivered.add("turn-1");
  pending.set("turn-1", { message: pendingMessage });
  const result = await service.reconcile(thread, project, {
    turnId: "turn-1",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    usageResult: usage({ finalAnswer: "" }),
  });
  assert.equal(result, true);
  assert.deepEqual(completions, []);
  assert.equal(calls.some(([name, , message]) => (
    name === "remember" && message === "Исправленный ответ"
  )), true);
  assert.equal(calls.some(([name]) => name === "seen"), true);
});

test("delivered historical ImageGen turn repairs its durable terminal before usage short-circuit", async () => {
  const generated = [
    { id: "codex-generated-one.png", name: "Изображение", type: "image/png" },
    { id: "codex-generated-two.png", name: "Изображение", type: "image/png" },
  ];
  const resolverCalls = [];
  const repairCalls = [];
  const { service, delivered } = harness({
    workLogStore: {
      getTurn: async () => ({
        provisional: false,
        usageReported: true,
        usage: { totalTokens: 10 },
        imageGenerationCount: 2,
      }),
    },
    resolveTerminalAttachments: async (run, turnId) => {
      resolverCalls.push({ run, turnId });
      return generated;
    },
    repairTerminalAttachments: async (identity, options) => {
      repairCalls.push({ identity, expectedCount: options.expectedCount });
      return { enriched: true, attachments: await options.resolveAttachments() };
    },
  });
  delivered.add("turn-image");

  const result = await service.reconcile(thread, project, {
    turnId: "turn-image",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    historical: true,
    usageResult: usage({ imageGenerationCount: 2 }),
  });

  assert.equal(result, true);
  assert.deepEqual(repairCalls, [{
    identity: { provider: "codex", threadId: "thread-1", turnId: "turn-image" },
    expectedCount: 2,
  }]);
  assert.deepEqual(resolverCalls, [{
    run: {
      threadId: "thread-1",
      startedAt: undefined,
      rolloutPath: "rollout.jsonl",
      expectedImageCount: 2,
    },
    turnId: "turn-image",
  }]);
});

test("subagent terminal turn is aggregated into its parent task without delivery", async () => {
  const { service, calls, completions } = harness({
    accountingThread: async () => ({
      threadId: "parent-thread",
      parentThreadId: "parent-thread",
      thread: { id: "parent-thread" },
      isSubagent: true,
    }),
    subagentParentTurnId: async () => "parent-turn",
  });
  await service.reconcile(
    { ...thread, parentThreadId: "parent-thread" },
    project,
    {
      turnId: "child-turn",
      status: "completed",
      completedAt: "2026-08-04T10:00:00.000Z",
      usageResult: usage(),
    },
  );
  assert.deepEqual(completions, []);
  const projection = calls.find(([name]) => name === "project");
  assert.equal(projection[1].aggregateOnly, true);
  assert.equal(projection[1].taskThreadId, "parent-thread");
  assert.equal(projection[1].parentTurnId, "parent-turn");
});

test("historical reconciliation forwards the local-only accounting boundary", async () => {
  const accountingOptions = [];
  const { service } = harness({
    accountingThread: async (value, options) => {
      accountingOptions.push(options);
      return { threadId: value.id, parentThreadId: "", thread: value, isSubagent: false };
    },
  });

  await service.reconcile(thread, project, {
    turnId: "historical-local-turn",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    historical: true,
    usageResult: usage(),
  }, { localOnlyAccounting: true });

  assert.deepEqual(accountingOptions, [{ localOnly: true }]);
});

test("the same terminal turn cannot reconcile concurrently", async () => {
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const { service } = harness({
    accountingThread: async (value) => {
      await blocked;
      return { threadId: value.id, parentThreadId: "", thread: value, isSubagent: false };
    },
  });
  const terminal = {
    turnId: "turn-1",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    usageResult: usage(),
  };
  const first = service.reconcile(thread, project, terminal);
  const second = await service.reconcile(thread, project, terminal);
  assert.equal(second, false);
  release();
  assert.equal(await first, true);
});
