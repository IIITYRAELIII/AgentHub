import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TurnEndDeliveryService } from "../../src/application/turn-end-delivery-service.mjs";
import { TerminalTurnCommitService } from "../../src/application/terminal-turn-commit-service.mjs";
import { RunJournalService } from "../../src/application/run-journal-service.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { ProviderTurnTerminalStore } from "../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";

async function fixture(t, count = 3) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-delivery-batch-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const terminal = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir: root }) });
  const completions = Array.from({ length: count }, (_, i) => ({
    provider: "codex", projectRoot: root, threadId: "thread", turnId: `turn-${i}`,
    status: "completed", finalAnswer: `Answer ${i}`, model: "gpt-6-astra",
    usage: { inputTokens: 100, outputTokens: 20 }, usageReported: true, resolveAccount: false,
    startedAt: `2026-09-09T10:${String(i).padStart(2, "0")}:00.000Z`,
    completedAt: `2026-09-09T10:${String(i).padStart(2, "0")}:30.000Z`,
  }));
  const rows = () => {
    const reader = new DatabaseSync(path.join(root, "runtime.sqlite"), { readOnly: true });
    try { return reader.prepare("SELECT turn_id, terminal_revision, state FROM provider_turn_terminal_outbox ORDER BY turn_id, terminal_revision").all(); }
    finally { reader.close(); }
  };
  const events = [];
  const service = new TurnEndDeliveryService({
    notifications: { values: () => completions, markDelivered() {} },
    terminalCommits: terminal, taskRuns: { forEvent: () => null },
    persistHistory: async (value) => events.push(["history", value.turnId]),
    projectTurn: async (value, options) => {
      assert.equal(options.deferProjection, true);
      events.push(["record", value.turnId]);
      return { projectionDeferred: true };
    },
    flushTurnProjections: async (values) => {
      events.push(["flush", values.map((value) => value.turnId)]);
      assert.ok(rows().filter((row) => values.some((value) => value.turnId === row.turn_id))
        .every((row) => row.state === "projecting"));
      return { projected: true };
    },
    rememberLastMessage: (value) => events.push(["message", value.turnId]),
    rememberSeenTurn() {}, saveState: async () => {}, logger: { error() {} },
  });
  return { root, terminal, completions, service, events, rows };
}

test("pending legacy completions use bounded shared projections and ACK only after each flush", async (t) => {
  const state = await fixture(t, 18);
  await state.service.retryPending();
  const flushes = state.events.filter(([event]) => event === "flush");
  assert.deepEqual(flushes.map(([, ids]) => ids.length), [16, 2]);
  assert.equal(state.rows().length, 18);
  assert.ok(state.rows().every((row) => row.state === "delivered"));
  assert.equal(state.events.findIndex(([event]) => event === "message"), 33);
  await state.service.retryPending();
  assert.equal(state.events.filter(([event]) => event === "flush").length, 2);
});

test("failed or deferred shared projection leaves every exact revision retryable", async (t) => {
  const state = await fixture(t);
  const successful = state.service.flushTurnProjections;
  for (const failure of [new Error("worker failed"), { projectionDeferred: true, reason: "stale-journal-revision" }, undefined]) {
    state.service.flushTurnProjections = async () => {
      if (failure instanceof Error) throw failure;
      return failure;
    };
    await state.service.retryPending();
    assert.ok(state.rows().every((row) => row.state === "pending" && row.terminal_revision === 1));
    assert.equal(state.events.filter(([event]) => event === "message").length, 0);
    assert.equal(state.service.delivering.size, 0);
  }
  state.service.flushTurnProjections = successful;
  await state.service.retryPending();
  assert.ok(state.rows().every((row) => row.state === "delivered" && row.terminal_revision === 1));
});

test("legacy migration batch retains pending work beyond the store's default recovery page", async (t) => {
  const state = await fixture(t, 18);
  const pending = state.terminal.pending.bind(state.terminal);
  state.terminal.pending = () => pending({ limit: 2 });
  await state.service.retryPending();
  assert.equal(state.rows().length, 18);
  assert.ok(state.rows().every((row) => row.state === "delivered"));
});

test("one failed history does not acknowledge that turn or starve successful batch members", async (t) => {
  const state = await fixture(t);
  state.service.persistHistory = async (value) => {
    if (value.turnId === "turn-1") throw new Error("history unavailable");
  };
  await state.service.retryPending();
  assert.deepEqual(state.rows().map((row) => row.state), ["delivered", "pending", "delivered"]);
  assert.deepEqual(state.events.find(([event]) => event === "flush")[1], ["turn-0", "turn-2"]);
});

test("same-revision live delivery cannot steal a staged claim and late correction keeps its own pending revision", async (t) => {
  const state = await fixture(t, 1);
  const original = state.completions[0];
  const committed = await state.terminal.commit(original);
  state.service.flushTurnProjections = async () => {
    assert.equal(await state.service.deliverOutbox(committed.outbox), false);
    await state.terminal.commit({ ...original, finalAnswer: "Richer exact final" });
    return { projected: true };
  };
  await state.service.retryPending();
  assert.deepEqual(state.rows().map((row) => [row.terminal_revision, row.state]), [[1, "superseded"], [2, "pending"]]);
  assert.equal(state.events.filter(([event]) => event === "message").length, 0);
  state.completions.splice(0);
  state.service.flushTurnProjections = async () => ({ projected: true });
  await state.service.retryPending();
  assert.deepEqual(state.rows().map((row) => [row.terminal_revision, row.state]), [[1, "superseded"], [2, "delivered"]]);
  assert.equal((await state.terminal.get(original)).finalAnswer, "Richer exact final");
});

test("a correction during saved-state persistence keeps the newer message and cannot acknowledge the superseded batch revision", async (t) => {
  const state = await fixture(t, 1);
  const original = state.completions[0];
  original.clientUserMessageId = "command-1";
  await state.terminal.commit(original, {
    channelIntents: { telegram: { requested: true, run: { ...original, chatId: 7 }, message: original.finalAnswer } },
  });
  state.completions.splice(0);
  const lastMessages = new RunJournalService({ usageStore: {}, findProject: () => ({ path: state.root }) });
  state.service.rememberLastMessage = (...args) => lastMessages.rememberLastMessage(...args);
  state.service.logger = { error: (...args) => state.events.push(["error", ...args]) };
  let visible = 0;
  let telegram = 0;
  state.service.commandTrace = { recordBestEffort: () => { visible += 1; } };
  state.service.finalizeRunDelivery = async () => { telegram += 1; };
  state.service.saveState = async () => {
    await state.terminal.commit({ ...original, finalAnswer: "Newer final" });
    lastMessages.rememberLastMessage(original, "Newer final", { terminalRevision: 2 });
  };
  await state.service.retryPending();
  assert.equal(lastMessages.lastMessage(original), "Newer final", JSON.stringify(state.events));
  assert.equal(visible, 0);
  assert.equal(telegram, 0);
  assert.deepEqual(state.rows().map((row) => [row.terminal_revision, row.state]), [[1, "superseded"], [2, "pending"]]);
});

test("automatic and explicit work-log records persist before one real canonical worker projection", async (t) => {
  const state = await fixture(t, 3);
  state.completions[1].message = { workLogId: "cc9b43ae-080f-48bf-bc2e-75af63603acd" };
  const databaseFile = path.join(state.root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  const usage = createWorkLogUsageStore({
    ledgerFile: path.join(state.root, "retired.json"), databaseFile,
    defaultProjectRoot: state.root, usageSyncStore: worker,
    repositoryFactory: (options) => new WorkLogUsageRepository(options),
  });
  const runJournal = new RunJournalService({
    usageStore: usage, defaultProjectRoot: state.root, projectionProjectRoots: [state.root],
    findProject: (root) => root === state.root ? { path: root } : null,
  });
  let projections = 0;
  const project = worker.projectJournal.bind(worker);
  worker.projectJournal = (...args) => { projections += 1; return project(...args); };
  state.service.projectTurn = (...args) => runJournal.projectTurn(...args);
  state.service.flushTurnProjections = async (...args) => {
    assert.equal(projections, 0);
    const ledger = await journal.loadLedger();
    assert.equal(Object.keys(ledger.turns).length, 3);
    assert.ok(state.rows().every((row) => row.state === "projecting"));
    return runJournal.flushTurnProjections(...args);
  };
  try {
    await state.service.retryPending();
    assert.equal(projections, 1);
    assert.ok(state.rows().every((row) => row.state === "delivered"));
    const snapshot = JSON.stringify(await journal.snapshot());
    for (const value of state.completions) assert.ok(snapshot.includes(value.finalAnswer));
    assert.equal((await journal.getRecord(state.completions[1])).workLogId, state.completions[1].message.workLogId);
  } finally {
    await usage.close();
    journal.close();
  }
});
