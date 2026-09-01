import assert from "node:assert/strict";
import test from "node:test";

import { CodexTerminalReconciliationService } from "../../../src/providers/codex/codex-terminal-reconciliation-service.mjs";
import { CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX } from "../../../src/domain/codex-context-probe.mjs";

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

test("terminal reconciliation ignores a context probe before any recovery", async () => {
  const { service, calls, completions } = harness();
  const result = await service.reconcile(thread, project, {
    turnId: "probe-turn",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    clientUserMessageId: `${CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX}test`,
  });

  assert.equal(result, true);
  assert.deepEqual(calls, []);
  assert.deepEqual(completions, []);
});

test("historical context probe is projected for accounting without notification", async () => {
  const { service, calls, completions } = harness();
  const result = await service.reconcile(thread, project, {
    turnId: "probe-turn",
    status: "completed",
    completedAt: "2026-08-04T10:00:00.000Z",
    clientUserMessageId: `${CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX}historical`,
    historical: true,
    usageResult: usage({
      clientUserMessageId: `${CODEX_CONTEXT_PROBE_CLIENT_ID_PREFIX}historical`,
    }),
  });

  assert.equal(result, true);
  assert.deepEqual(completions, []);
  const projection = calls.find(([name]) => name === "project");
  assert.equal(projection[1].contextProbe, true);
  assert.equal(projection[1].usageReported, true);
  assert.equal(projection[2].deferProjection, true);
  assert.equal(calls.some(([name]) => name === "deliver"), false);
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
