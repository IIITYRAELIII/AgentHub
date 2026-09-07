import assert from "node:assert/strict";
import test from "node:test";

import {
  createCodexTerminalAuditScheduler,
} from "../../src/composition/provider-runtime-wiring-composition.mjs";
import {
  createCodexAccountingResolutionPorts,
} from "../../src/composition/codex-observability-composition.mjs";
import { CodexAccountingResolver } from "../../src/providers/codex/codex-accounting-resolver.mjs";
import { CodexTerminalAudit } from "../../src/providers/codex/codex-terminal-audit.mjs";
import {
  CodexTerminalReconciliationService,
} from "../../src/providers/codex/codex-terminal-reconciliation-service.mjs";

test("terminal audit scheduler owns one timer across maintenance, reconnect and failure", async () => {
  let scheduled = null;
  let schedules = 0;
  const runtimeTimers = {
    schedule(name, callback, delayMs) {
      assert.equal(name, "codex-terminal-audit");
      assert.ok(delayMs >= 0);
      if (scheduled) return false;
      scheduled = callback;
      schedules += 1;
      return true;
    },
  };
  const transport = { running: false };
  const calls = [];
  let pendingMaintenance = true;
  const audit = {
    persistsProgress: false,
    hasPendingHistoricalMaintenance: () => pendingMaintenance,
    async runHistoricalMaintenance(options) {
      assert.deepEqual(options, { localOnlyAccounting: true });
      calls.push("maintenance");
      pendingMaintenance = false;
      return true;
    },
    async run() {
      calls.push("live");
      throw new Error("live audit failed");
    },
  };
  const errors = [];
  const scheduler = createCodexTerminalAuditScheduler({
    codexTerminalAudit: audit,
    codexTransport: transport,
    saveState: async () => calls.push("persist"),
    isStopping: () => false,
    runtimeTimers,
    terminalAuditIntervalMs: 30_000,
    logger: { error: (...values) => errors.push(values.join(" ")) },
  });
  const fire = async () => {
    const callback = scheduled;
    assert.equal(typeof callback, "function");
    scheduled = null;
    await callback();
  };

  assert.equal(scheduler.schedule(500), true);
  assert.equal(scheduler.schedule(500), false);
  assert.equal(schedules, 1);
  await fire();
  assert.deepEqual(calls, ["maintenance", "persist"]);
  assert.equal(schedules, 2);

  transport.running = true;
  await fire();
  assert.deepEqual(calls, ["maintenance", "persist", "live"]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /live audit failed/u);
  assert.equal(schedules, 3);

  assert.equal(scheduler.schedule(500), false);
  assert.equal(schedules, 3);
});

test("offline production audit repairs a subagent migration without provider RPC", async () => {
  let providerRpc = 0;
  let repairs = 0;
  let projections = 0;
  let checkpoints = 0;
  const parent = { id: "root-thread", parentThreadId: "" };
  const child = {
    id: "child-thread",
    parentThreadId: parent.id,
    path: "child-rollout.jsonl",
    updatedAt: "2026-08-25T12:00:03.000Z",
  };
  const accounting = new CodexAccountingResolver({
    readThread: async () => {
      providerRpc += 1;
      return new Promise(() => {});
    },
    findRollout: async (threadId) => threadId === parent.id ? "root-rollout.jsonl" : "",
    readRolloutSession: async () => parent,
    readSubagentSpawn: async () => ({ parentTurnId: "root-turn" }),
    scanHistoricalRollout: async () => null,
  });
  const accountingPorts = createCodexAccountingResolutionPorts(accounting);
  const reconciliation = new CodexTerminalReconciliationService({
    notifications: { hasDelivered: () => true, get: () => null },
    turnStarts: new Map(),
    workLogStore: { getTurn: async () => null },
    accountingThread: accountingPorts.accountingThread,
    subagentParentTurnId: accountingPorts.subagentParentTurnId,
    readTurnUsage: async () => { throw new Error("historical usage must be reused"); },
    taskGitDiff: async () => "",
    dataDir: "data",
    projectTurn: async () => { projections += 1; return {}; },
    taskTitle: async () => "Root task",
    defaultChatId: () => 0,
    fallbackMessage: () => "",
    rememberLastMessage() {},
    rememberSeenTurn() {},
    saveState: async () => {},
    deliverNotification: async () => {},
    repairTerminalAttachments: async (_identity, options) => {
      repairs += 1;
      return { enriched: true, attachments: await options.resolveAttachments() };
    },
    resolveTerminalAttachments: async () => [{
      id: "codex-generated-offline.png",
      name: "Изображение",
      type: "image/png",
    }],
    logger: { log() {}, error() {} },
  });
  const audit = new CodexTerminalAudit({
    now: () => Date.parse("2026-08-25T12:05:00.000Z"),
    listPage: async () => { throw new Error("offline maintenance must not list provider threads"); },
    discoverHistoricalThreads: async () => [child],
    resolveProject: async () => ({ path: "C:/workspace" }),
    reconcile: (...args) => reconciliation.reconcile(...args),
    scanHistoricalFile: async () => ({
      session: { threadId: child.id },
      turns: [{
        turnId: "child-turn",
        terminal: true,
        status: "completed",
        completedAt: "2026-08-25T12:00:03.000Z",
        finalAnswer: "Готово",
        reported: true,
        usage: { totalTokens: 10 },
        imageGenerationCount: 0,
        generatedImageSources: [{ type: "generated-path", value: "offline.png" }],
        changedFiles: [],
      }],
    }),
    statFile: async () => ({ size: 128, mtimeMs: Date.parse(child.updatedAt) }),
    shouldRunAudit: () => true,
    shouldRunHistoricalBackfill: () => true,
    prepareHistoricalBackfill: async () => ({ backupFile: "migration.sqlite" }),
    flushHistoricalProjection: async () => {},
    persistProgress: async () => { checkpoints += 1; },
    auditTimeMs: 10_000,
  });
  audit.restore({
    version: 15,
    completedThrough: "2026-08-25T12:04:00.000Z",
    positions: [],
    pendingTurns: [],
    historicalSubagentBackfill: {
      pending: false,
      initialized: true,
      prepared: true,
      queue: [],
    },
  });
  const scheduler = createCodexTerminalAuditScheduler({
    codexTerminalAudit: audit,
    codexTransport: { running: false },
    saveState: async () => {},
    isStopping: () => false,
    runtimeTimers: { schedule: () => true },
  });

  const result = await Promise.race([
    scheduler.auditNow(),
    new Promise((_, reject) => setTimeout(
      () => reject(new Error("offline audit waited for provider RPC")),
      250,
    )),
  ]);

  assert.equal(result, true);
  assert.equal(providerRpc, 0);
  assert.equal(repairs, 1);
  assert.equal(projections, 1);
  assert.ok(checkpoints >= 1);
  assert.equal(audit.snapshot().version, 16);
  assert.equal(audit.snapshot().historicalSubagentBackfill.pending, false);
});
