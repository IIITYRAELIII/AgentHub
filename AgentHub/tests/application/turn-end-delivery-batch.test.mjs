import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TurnEndDeliveryService } from "../../src/application/turn-end-delivery-service.mjs";
import { AgentHubStartupCoordinator } from "../../src/application/agent-hub-startup-coordinator.mjs";
import { createRuntimeHealth } from "../../src/application/runtime-health.mjs";
import { TerminalTurnCommitService } from "../../src/application/terminal-turn-commit-service.mjs";
import { RunJournalService } from "../../src/application/run-journal-service.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { ProviderTurnTerminalStore } from "../../src/infrastructure/persistence/provider-turn-terminal-store.mjs";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";
import { ProviderTurnTelemetryStore } from "../../src/infrastructure/persistence/provider-turn-telemetry-store.mjs";
import { TurnEndNotificationRegistry } from "../../src/application/turn-end-notifications.mjs";
import { CodexRunFinalizer } from "../../src/providers/codex/codex-run-finalizer.mjs";

async function fixture(t, count = 3, cleanup = null) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-delivery-batch-"));
  t.after(async () => {
    await cleanup?.();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
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
    rememberSeenTurn() {}, saveState: async () => {},
    logger: { error: (...args) => events.push(["error", ...args]) },
  });
  return { root, terminal, completions, service, events, rows };
}

async function completionRecoveryFixture(t) {
  let usage, worker, journal, telemetry;
  const state = await fixture(t, 0, async () => {
    if (usage) await usage.close();
    else await worker?.close();
    await telemetry?.close();
    journal?.close();
  });
  const databaseFile = path.join(state.root, "journal.sqlite");
  journal = new JournalDatabase(databaseFile);
  telemetry = new ProviderTurnTelemetryStore({ databaseFile });
  const runtimeFile = path.join(state.root, "runtime.sqlite");
  const openOwner = () => {
    worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: "device-local" });
    usage = createWorkLogUsageStore({
      ledgerFile: path.join(state.root, "retired.json"), databaseFile,
      defaultProjectRoot: state.root, usageSyncStore: worker,
      usageSyncDeviceId: "device-local", usageSyncRuntimeHomeIds: { codex: "home-local" },
      repositoryFactory: (options) => new WorkLogUsageRepository(options),
      workspaceCatalogStore: {
        resolveThread: (reference) => ({
          workspaceId: "workspace", workspaceName: "Workspace",
          streamId: reference.threadId, streamName: reference.threadId,
        }),
        assignUnknownThread: () => null,
      },
    });
    const commits = new TerminalTurnCommitService({
      store: new ProviderTurnTerminalStore({ dataDir: state.root }),
      readTerminalTelemetry: (identity) => telemetry.terminalEvidence(identity),
    });
    const runJournal = new RunJournalService({
      usageStore: usage, defaultProjectRoot: state.root, projectionProjectRoots: [state.root],
      findProject: (root) => root === state.root ? { path: root } : null,
    });
    Object.assign(state.service, {
      terminalCommits: commits,
      projectTurn: (...args) => runJournal.projectTurn(...args),
      ensureTurnUsageFact: (...args) => runJournal.ensureTurnUsageFact(...args),
      readTurnProjection: (...args) => runJournal.turnProjectionStatus(...args),
      flushTurnProjections: (...args) => runJournal.flushTurnProjections(...args),
      recoverTurnCompletion: (...args) => runJournal.recoverTurnCompletion(...args),
      finalizeRunDelivery: async () => assert.fail("repair must not send Telegram"),
    });
    return { commits, usage, worker, runJournal };
  };
  const readIndex = () => {
    const db = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      return db.prepare(`SELECT turn_id AS turnId, date, workspace_id AS workspaceId,
        stream_id AS streamId, completed_at_ms AS completedAtMs FROM journal_turn_index ORDER BY turn_id`).all();
    } finally { db.close(); }
  };
  const dropLegacyTime = ({ provider, threadId, turnId, terminalRevision }) => {
    const db = new DatabaseSync(runtimeFile);
    try {
      for (const table of ["provider_turn_terminals", "provider_turn_terminal_outbox"]) {
        assert.equal(db.prepare(`UPDATE ${table}
          SET payload_json = json_remove(payload_json, '$.completion.completedAt')
          WHERE provider = ? AND thread_id = ? AND turn_id = ? AND terminal_revision = ?`)
          .run(provider, threadId, turnId, terminalRevision).changes, 1);
      }
    } finally { db.close(); }
  };
  return { ...state, journal, telemetry, openOwner, readIndex, dropLegacyTime };
}

const historicalCompletion = {
  provider: "codex", threadId: "evidence-thread", turnId: "older",
  status: "completed", finalAnswer: "Original final", model: "gpt-6-astra",
  usage: { inputTokens: 1000, outputTokens: 100 }, usageReported: true, resolveAccount: false,
  startedAt: "2026-11-19T09:25:06.232Z", completedAt: "2026-11-19T10:25:10.714Z",
};

test("repeated real Codex finalization retains the exact durable time after delivery and registry restart", async (t) => {
  const state = await completionRecoveryFixture(t);
  const owner = state.openOwner();
  const { service } = state;
  let notifications = new TurnEndNotificationRegistry();
  let clock = new Date(historicalCompletion.completedAt);
  const launch = () => new CodexRunFinalizer({
    turnStarts: new Map(), notifications, resolveTerminalAttachments: async () => [],
    discardContextCompaction: async () => false, refreshTaskDiff: async () => {},
    runTitle: () => "Fixture", currentChatId: () => null, defaultNotificationChatId: () => null,
    commitTerminal: (...args) => service.commit(...args),
    deliverTerminal: async (item) => {
      await service.deliverOutbox(item);
      notifications.markDelivered(item);
    },
    markRunCompleted: async () => {}, completeRun: async () => {},
  });
  const run = {
    ...historicalCompletion, id: "run-1", projectRoot: state.root, telegramDeliveryRequested: false,
  };
  const finish = (finalizer, answer) => finalizer.finalize(run, {
    answer, tracker: { usage: historicalCompletion.usage, reported: true, model: historicalCompletion.model },
  });
  t.mock.timers.enable({ apis: ["Date"], now: clock });
  try {
    const finalizer = launch();
    await finish(finalizer, "First final");
    assert.equal(notifications.get(run), null);
    clock = new Date("2026-11-26T10:45:00Z");
    t.mock.timers.setTime(clock.getTime());
    await finish(finalizer, "Enriched final");
    assert.equal((await owner.commits.store.get(run)).payload.completion.completedAt, historicalCompletion.completedAt);
    // The in-memory registry after restart can return a new observation for this old identity.
    notifications = new TurnEndNotificationRegistry();
    const restarted = launch();
    await finish(restarted, "New final metadata");
    await finish(restarted, "New final metadata");
    const latest = await owner.commits.store.get(run);
    assert.equal(latest.terminalRevision, 3);
    assert.equal(latest.lastMessage.updatedAt, historicalCompletion.completedAt);
    assert.equal(latest.payload.completion.completedAt, historicalCompletion.completedAt);
    assert.deepEqual(state.readIndex().map((row) => row.completedAtMs), [Date.parse(historicalCompletion.completedAt)]);
    assert.equal((await owner.worker.events()).length, 1);
  } finally {
    t.mock.timers.reset();
  }
});

test("legacy missing time is repaired from the exact earlier revision across pending recovery and acknowledged rebuild", async (t) => {
  const state = await completionRecoveryFixture(t);
  let owner = state.openOwner();
  const target = { ...historicalCompletion, projectRoot: state.root };
  const pending = { ...target, turnId: "pending", finalAnswer: "Pending final" };
  const independent = { ...target, threadId: "parallel-thread", turnId: "parallel",
    finalAnswer: "Independent long turn", completedAt: "2026-11-19T10:55:00.000Z" };
  const nowDay = { ...target, turnId: "control", finalAnswer: "Correct current day",
    startedAt: "2026-11-26T10:01:00.000Z", completedAt: "2026-11-26T10:02:00.000Z" };
  const erroneousAt = "2026-11-26T10:41:37.878Z";
  const oldRuntimeEvidence = async (completion) => {
    const first = await owner.commits.commit(completion);
    await owner.commits.acknowledge(await owner.commits.claim(first.outbox));
    const later = await owner.commits.commit({ ...completion, finalAnswer: completion.finalAnswer + " enriched" });
    state.dropLegacyTime(later.outbox);
    await state.telemetry.upsert({ ...completion, finalPhase: "completed",
      completedAtMs: Date.parse(completion.completedAt) + 11 });
    return later.outbox;
  };
  const acknowledged = await oldRuntimeEvidence(target);
  await owner.commits.acknowledge(await owner.commits.claim(acknowledged));
  const pendingOutbox = await oldRuntimeEvidence(pending);
  await state.service.deliverOutbox((await owner.commits.commit(independent)).outbox);
  await state.service.deliverOutbox((await owner.commits.commit(nowDay)).outbox);
  await owner.usage.recordAutomaticAndProject({ ...target, completedAt: erroneousAt,
    accountKey: "chatgpt:historical", accountAttribution: "exact", deferProjection: true });
  const prior = { ...(await state.journal.getRecord(target)), observedAt: erroneousAt };
  await state.journal.upsertRecords([prior]);
  await owner.runJournal.ensureTurnUsageFact(target);
  await owner.runJournal.flushTurnProjections([target]);
  const beforeFact = (await owner.worker.events()).find((entry) => entry.completedAt === erroneousAt);
  assert.ok(beforeFact);
  assert.equal(state.readIndex().find((row) => row.turnId === target.turnId).completedAtMs, Date.parse(erroneousAt));

  await owner.usage.close();
  owner = state.openOwner();
  await state.service.retryPendingProjections({ recoverProjecting: true });
  assert.equal((await owner.usage.getTurn(pending)).completedAt, pending.completedAt);
  assert.equal(state.rows().find((row) => row.turn_id === pending.turnId
    && row.terminal_revision === pendingOutbox.terminalRevision).state, "delivered");
  const pinned = { expectedCompletedAt: erroneousAt };
  assert.equal((await state.service.recoverJournalCompletion({ ...acknowledged, terminalRevision: 1 }, pinned)).eligible, false);
  const preview = await state.service.recoverJournalCompletion(acknowledged, pinned);
  assert.deepEqual(preview.recovery, {
    originalCompletedAt: erroneousAt, completedAt: target.completedAt, terminalRevision: 2,
    sourceRevision: 1, providerCompletedAt: "2026-11-19T10:25:10.725Z",
  });
  assert.equal(preview.applied, false);
  assert.deepEqual(await state.journal.getRecord(target), prior);

  const historyOptions = { range: "all", now: Date.parse("2026-11-27T12:00:00Z") };
  const beforeHistory = await owner.usage.usageHistory(historyOptions);
  const beforeRepairEffects = state.events.length;
  const beforeRows = state.rows();
  owner.runJournal.flushTurnProjections = async () => { throw new Error("interrupted after write"); };
  await assert.rejects(state.service.recoverJournalCompletion(acknowledged, { ...pinned, apply: true }),
    /interrupted after write/u);
  await owner.usage.close();
  owner = state.openOwner();
  const retry = await state.service.recoverJournalCompletion(acknowledged, { ...pinned, apply: true });
  assert.equal(retry.unchanged, true);
  assert.equal(retry.projectionPending, false);
  assert.deepEqual(state.rows(), beforeRows);
  assert.equal(state.events.length, beforeRepairEffects);
  assert.deepEqual(await state.journal.getRecord(target), {
    ...prior, completedAt: target.completedAt, completionRecovery: preview.recovery,
  });
  const indexed = state.readIndex();
  assert.equal(indexed.length, 4);
  assert.ok(indexed.every((row) => row.workspaceId === "workspace"));
  assert.equal(indexed.find((row) => row.turnId === target.turnId).streamId, target.threadId);
  const expectedDate = new Date(target.completedAt).toLocaleDateString("ru-RU");
  assert.equal(indexed.find((row) => row.turnId === target.turnId).date, expectedDate);
  assert.equal(indexed.filter((row) => row.date === expectedDate).length, 3);
  assert.equal(indexed.filter((row) => row.date === new Date(erroneousAt).toLocaleDateString("ru-RU")).length, 1);
  const facts = await owner.worker.events();
  assert.equal(facts.length, 4);
  const repairedFact = facts.find((entry) => entry.eventId === beforeFact.eventId);
  assert.equal(repairedFact.completedAt, target.completedAt);
  assert.deepEqual(repairedFact.usage, beforeFact.usage);
  const history = await owner.usage.usageHistory(historyOptions);
  assert.ok(history.totalDurationSeconds >= 10_800 && history.totalDurationSeconds < 20_000,
    "valid long and overlapping turns remain counted");
  assert.equal(history.totalCredits, beforeHistory.totalCredits, "all four turns retain their original token usage");
  const creditsOn = (history, date) => history.points.filter((point) => (
    new Date(point.at).toLocaleDateString("ru-RU") === date
  )).reduce((sum, point) => sum + point.credits, 0);
  const erroneousDate = new Date(erroneousAt).toLocaleDateString("ru-RU");
  assert.ok(creditsOn(history, expectedDate) > creditsOn(beforeHistory, expectedDate));
  assert.ok(creditsOn(history, erroneousDate) < creditsOn(beforeHistory, erroneousDate));
  const later = "2026-11-19T10:25:42.000Z";
  const correction = await state.service.correctFromExactProviderTerminal(acknowledged,
    { status: "aborted", completedAt: later, finalAnswer: "Confirmed corrected status" });
  assert.equal(correction.corrected, true);
  assert.equal((await owner.usage.getTurn(target)).completedAt, later);
  assert.equal((await state.service.recoverJournalCompletion(acknowledged, { ...pinned, apply: true })).eligible, false);
});

test("exact telemetry backfills missing completion while an unproven time remains undated and separately counted", async (t) => {
  const state = await completionRecoveryFixture(t);
  const owner = state.openOwner();
  const known = { ...historicalCompletion, projectRoot: state.root, runId: "known-run",
    turnId: "known-from-telemetry", completedAt: "" };
  const unknown = { ...known, runId: "right-run", turnId: "unknown" };
  const verifiedAt = historicalCompletion.completedAt;
  await state.telemetry.upsert({ ...known, finalPhase: "completed", completedAtMs: Date.parse(verifiedAt) });
  await state.telemetry.upsert({ ...unknown, runId: "some-other-run",
    finalPhase: "completed", completedAtMs: Date.parse(verifiedAt) });
  await owner.commits.commit(known);
  await owner.commits.commit(unknown);
  await state.service.retryPendingProjections();
  assert.ok(state.rows().every((row) => row.state === "delivered"));
  assert.equal((await owner.runJournal.turnProjectionStatus(unknown)).current, true);
  assert.equal((await owner.usage.getTurn(known)).completedAt, verifiedAt);
  assert.equal((await owner.usage.getTurn(unknown)).completedAt, "");
  assert.deepEqual(state.readIndex().map((row) => row.turnId), [known.turnId]);
  assert.equal((await owner.worker.events()).length, 1);
  const history = await owner.usage.usageHistory({ range: "all", now: Date.parse("2026-11-27T12:00:00Z") });
  assert.equal(history.undatedUsage.turnCount, 1);
  assert.equal(history.undatedUsage.credits, history.totalCredits);
  assert.ok(history.totalCredits > 0);
});

test("pending legacy completions use bounded shared projections and ACK only after each flush", async (t) => {
  const state = await fixture(t, 18);
  await state.service.retryPending();
  const flushes = state.events.filter(([event]) => event === "flush");
  assert.deepEqual(flushes.map(([, ids]) => ids.length), [16, 2]);
  assert.equal(state.rows().length, 18);
  assert.ok(state.rows().every((row) => row.state === "delivered"));
  const firstFlush = state.events.findIndex(([event]) => event === "flush");
  for (const completion of state.completions.slice(0,16)) {
    const history = state.events.findIndex(([event,id]) => event === "history" && id === completion.turnId);
    const message = state.events.findIndex(([event,id]) => event === "message" && id === completion.turnId);
    assert.ok(history >= 0 && message > history && message < firstFlush,
      'each exact final becomes readable after its own history and before shared journal flush');
  }
  assert.equal(state.events.filter(([event]) => event === "message").length, 36);
  await state.service.retryPending();
  assert.equal(state.events.filter(([event]) => event === "flush").length, 2);
});

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise,resolve};
}

async function within(promise, description) {
  let timer;
  try {
    return await Promise.race([promise,new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new Error(description)),1500);
    })]);
  } finally {clearTimeout(timer);}
}

test('independent recovery preparation proceeds while an earlier history write is held',async t=>{
  const state=await fixture(t,18);
  const first=gate(),secondEntered=gate();
  const history=state.service.persistHistory;
  state.service.persistHistory=async value=>{
    if(value.turnId==='turn-0')await first.promise;
    if(value.turnId==='turn-1')secondEntered.resolve();
    return history(value);
  };
  const drain=state.service.retryPendingProjections();
  try {
    await within(secondEntered.promise,'second exact turn was serialized behind unrelated held history');
    assert.equal(state.events.some(([event])=>event==='flush'),false);
    assert.equal(state.events.some(([event,id])=>event==='history'&&id==='turn-16'),false,
      'the next page must not bypass the active bounded page');
    assert.equal(state.rows().some(row=>row.state==='delivered'),false);
  } finally {first.resolve();await drain;}
  assert.deepEqual(state.events.filter(([event])=>event==='flush').map(([,ids])=>ids.length),[16,2]);
  assert.ok(state.rows().every(row=>row.state==='delivered'));
});

test('batch persistence fences can coalesce without acknowledging any held save',async t=>{
  const state=await fixture(t,3);
  const stateWritten=gate(),secondSaveEntered=gate();let saves=0;
  state.service.saveState=async()=>{
    saves+=1;if(saves===2)secondSaveEntered.resolve();await stateWritten.promise;
  };
  const drain=state.service.retryPendingProjections();
  try {
    await within(secondSaveEntered.promise,'a later persistence fence was serialized behind the first save');
    assert.ok(state.rows().every(row=>row.state==='projecting'),'no ACK may precede durable state');
    assert.equal(state.events.filter(([event])=>event==='flush').length,1);
  } finally {stateWritten.resolve();await drain;}
  assert.equal(saves,3);assert.ok(state.rows().every(row=>row.state==='delivered'));
});

test('startup readiness still waits for every exact projection persistence fence',async t=>{
  const state=await fixture(t,3);
  const written=gate(),saving=gate();let saveCount=0,ready=0,timers=0;
  state.service.saveState=async()=>{if(++saveCount===3)saving.resolve();await written.promise;};
  const health=createRuntimeHealth(),noop=async()=>{};
  const startup=new AgentHubStartupCoordinator({telegramEnabled:false,health,
    startMiniApp:noop,startDesktopControl:noop,startRuntimeCommand:noop,startHubMcp:noop,
    sanitizeRollouts:noop,initializeProvider:noop,providerIsRunning:()=>true,
    recoverRuns:noop,retryTerminalProjections:()=>state.service.retryPendingProjections({recoverProjecting:true}),
    retryNotifications:noop,restoreBackgroundJobs:noop,registerTelegramCommands:noop,
    hasPendingRestart:()=>true,finalizeRestart:noop,
    markReady:async()=>{assert.ok(state.rows().every(row=>row.state==='delivered'));ready+=1;},
    startTimers:()=>{timers+=1;},readyMessage:()=>'',backfillProviderMetadata:noop,
    pollTelegram:noop,waitForever:noop,log(){},logError(){},
  });
  const start=startup.start();
  try {
    await within(saving.promise,'startup did not reach the bounded projection persistence fences');
    assert.equal(health.snapshot().ready,false);assert.equal(ready,0);assert.equal(timers,0);
    assert.ok(state.rows().every(row=>row.state==='projecting'));
  } finally {written.resolve();await start;await startup.waitForBackgroundWork();}
  assert.equal(ready,1);assert.equal(timers,1);assert.equal(health.snapshot().ready,true);
});

test('a late older preparation cannot replace a newer last-message projection',async t=>{
  const state=await fixture(t,2);
  const older=gate(),newer=gate();
  const journal=new RunJournalService({usageStore:{},findProject:()=>({path:state.root})});
  state.service.rememberLastMessage=(...args)=>journal.rememberLastMessage(...args);
  state.service.persistHistory=async value=>{if(value.turnId==='turn-0')await older.promise;};
  state.service.projectTurn=async value=>{if(value.turnId==='turn-1')newer.resolve();return {projectionDeferred:true};};
  const drain=state.service.retryPendingProjections();
  try {
    await within(newer.promise,'newer independent preparation did not progress');
    assert.equal(journal.lastMessageRecord(state.completions[1]).turnId,'turn-1');
  } finally {older.resolve();await drain;}
  assert.equal(journal.lastMessageRecord(state.completions[1]).turnId,'turn-1');
  assert.equal(journal.lastMessage(state.completions[1]),'Answer 1');
});

test('a rejected persistence fence keeps only its unacknowledged revision retryable',async t=>{
  const state=await fixture(t,3);let attempts=0;
  state.service.saveState=async()=>{if(++attempts===1)throw new Error('durable state unavailable');};
  await state.service.retryPendingProjections();
  assert.deepEqual(state.rows().map(row=>row.state),['pending','delivered','delivered']);
  assert.equal(state.service.delivering.size,0);
  state.completions.splice(0);state.service.saveState=async()=>{};
  await state.service.retryPendingProjections();assert.ok(state.rows().every(row=>row.state==='delivered'));
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
    assert.equal(state.events.filter(([event]) => event === "message").length, 3);
    state.events.splice(0);
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
  assert.equal(state.events.filter(([event]) => event === "message").length, 1);
  state.completions.splice(0);
  state.service.flushTurnProjections = async () => ({ projected: true });
  await state.service.retryPending();
  assert.deepEqual(state.rows().map((row) => [row.terminal_revision, row.state]), [[1, "superseded"], [2, "delivered"]]);
  assert.equal((await state.terminal.get(original)).finalAnswer, "Richer exact final");
});

test("a correction during saved-state persistence delivers only the newer terminal revision", async (t) => {
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
  const telegram = [];
  state.service.commandTrace = { recordBestEffort: () => { visible += 1; } };
  state.service.finalizeRunDelivery = async (_run, options) => { telegram.push(options); };
  state.service.saveState = async () => {
    await state.terminal.commit({ ...original, finalAnswer: "Newer final" });
    lastMessages.rememberLastMessage(original, "Newer final", { terminalRevision: 2 });
  };
  await state.service.retryPending();
  assert.equal(lastMessages.lastMessage(original), "Newer final", JSON.stringify(state.events));
  assert.equal(visible, 0);
  assert.equal(telegram.length, 1);
  assert.equal(telegram[0].message, "Newer final");
  assert.deepEqual(state.rows().map((row) => [row.terminal_revision, row.state]), [[1, "superseded"], [2, "pending"]]);
});

test("automatic and explicit work-log records persist before one real canonical worker projection", async (t) => {
  const state = await fixture(t, 3);
  state.completions[1].message = { workLogId: "cc9b43ae-080f-48bf-bc2e-75af63603acd" };
  const databaseFile = path.join(state.root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({
    databaseFile, deviceId: "device-local", defaultRuntimeHomeIds: { codex: "home-local" },
  });
  const usage = createWorkLogUsageStore({
    ledgerFile: path.join(state.root, "retired.json"), databaseFile,
    defaultProjectRoot: state.root, usageSyncStore: worker,
    usageSyncDeviceId: "device-local", usageSyncRuntimeHomeIds: { codex: "home-local" },
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
  state.service.ensureTurnUsageFact = (...args) => runJournal.ensureTurnUsageFact(...args);
  state.service.readTurnProjection = (...args) => runJournal.turnProjectionStatus(...args);
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
    const statuses = await Promise.all(state.completions.map((completion) => runJournal.turnProjectionStatus(completion)));
    assert.ok(state.rows().every((row) => row.state === "delivered"), JSON.stringify({ events: state.events, statuses }));
    const snapshot = JSON.stringify(await journal.snapshot());
    for (const value of state.completions) assert.ok(snapshot.includes(value.finalAnswer));
    assert.equal((await journal.getRecord(state.completions[1])).workLogId, state.completions[1].message.workLogId);
    const reader = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM journal_turn_index").get().count, 3);
      assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM usage_sync_events").get().count, 3);
    } finally { reader.close(); }
  } finally {
    await usage.close();
    journal.close();
  }
});

test("canonical recovery preserves enriched partial success and does not infer a missing turn account", async (t) => {
  const state = await fixture(t, 1);
  state.completions.splice(0);
  const databaseFile = path.join(state.root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: "device-local" });
  let ambientAccountReads = 0;
  const usage = createWorkLogUsageStore({
    ledgerFile: path.join(state.root, "retired.json"), databaseFile,
    defaultProjectRoot: state.root, usageSyncStore: worker,
    usageSyncDeviceId: "device-local", usageSyncRuntimeHomeIds: { codex: "home-local" },
    resolveAccount: async () => {
      ambientAccountReads += 1;
      return { accountKey: "chatgpt:ambient", accountAttribution: "exact" };
    },
    repositoryFactory: (options) => new WorkLogUsageRepository(options),
  });
  const runJournal = new RunJournalService({
    usageStore: usage, defaultProjectRoot: state.root, projectionProjectRoots: [state.root],
    findProject: (root) => root === state.root ? { path: root } : null,
  });
  state.service.projectTurn = (...args) => runJournal.projectTurn(...args);
  state.service.flushTurnProjections = (...args) => runJournal.flushTurnProjections(...args);
  state.service.ensureTurnUsageFact = (...args) => runJournal.ensureTurnUsageFact(...args);
  state.service.readTurnProjection = (...args) => runJournal.turnProjectionStatus(...args);
  let telegramDeliveries = 0;
  state.service.finalizeRunDelivery = async () => { telegramDeliveries += 1; };

  const base = {
    provider: "codex", projectRoot: state.root, threadId: "thread-recovery",
    status: "completed", finalAnswer: "Exact retained final", model: "gpt-6-astra",
    serviceTier: "priority", usage: { inputTokens: 100, cachedInputTokens: 50, outputTokens: 20 },
    usageReported: true, startedAt: "2026-09-17T09:00:00.000Z", completedAt: "2026-09-17T09:01:00.000Z",
  };
  const enriched = { ...base, turnId: "partial", taskTitle: "Enriched task", prompt: "Enriched prompt" };
  await usage.recordAutomaticAndProject({
    ...enriched, title: "Enriched title", body: enriched.finalAnswer,
    accountKey: "chatgpt:historical", accountAttribution: "exact",
    resolveAccount: false, deferProjection: true,
  });
  await runJournal.ensureTurnUsageFact(enriched);
  await runJournal.flushTurnProjections([enriched]);
  const staleFactWriter = new DatabaseSync(databaseFile);
  try {
    staleFactWriter.prepare(`
      UPDATE usage_sync_events
      SET input_tokens = 999, total_tokens = 1069
      WHERE event_id LIKE 'usage:%'
    `).run();
  } finally { staleFactWriter.close(); }
  const staleProjection = await runJournal.turnProjectionStatus(enriched);
  assert.equal(staleProjection.usageFactMatches, false);
  assert.equal(staleProjection.current, false);
  const committedPartial = await state.terminal.commit({ ...base, turnId: "partial" });
  const claimedPartial = await state.terminal.claim(committedPartial.outbox);
  await state.terminal.retry(claimedPartial, new Error("Journal projection could not commit after a journal revision conflict"));
  const before = await usage.getTurn(enriched);

  await state.service.retryPendingProjections();
  const repairedProjection = await runJournal.turnProjectionStatus(enriched);
  assert.equal(repairedProjection.usageFactMatches, true, JSON.stringify(repairedProjection));
  assert.equal(repairedProjection.indexFresh, true);
  assert.ok(repairedProjection.projectionSource.revision >= repairedProjection.recordRevision);
  assert.equal(repairedProjection.current, true, JSON.stringify(repairedProjection));
  const after = await usage.getTurn(enriched);
  assert.equal(after.taskTitle, before.taskTitle);
  assert.equal(after.prompt, before.prompt);
  assert.equal(after.title, before.title);
  assert.equal(after.accountKey, "chatgpt:historical");
  assert.equal(after.accountAttribution, "exact");

  await usage.recordAutomaticAndProject({
    ...enriched, taskTitle: "Newer retained task title", title: "Newer retained title",
    body: enriched.finalAnswer, resolveAccount: false, deferProjection: true,
  });
  const staleIndex = await runJournal.turnProjectionStatus(enriched);
  assert.ok(staleIndex.projectionSource.revision < staleIndex.recordRevision);
  assert.equal(staleIndex.current, false);
  await runJournal.flushTurnProjections([enriched]);
  const refreshedIndex = await runJournal.turnProjectionStatus(enriched);
  assert.ok(refreshedIndex.projectionSource.revision >= refreshedIndex.recordRevision);
  assert.equal(refreshedIndex.indexFresh, true);
  assert.equal(refreshedIndex.current, true);

  const missing = { ...base, turnId: "missing" };
  const committedMissing = await state.terminal.commit(missing);
  const claimedMissing = await state.terminal.claim(committedMissing.outbox);
  await state.terminal.retry(claimedMissing, Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }));
  await state.service.retryPendingProjections();
  const recovered = await usage.getTurn(missing);
  assert.ok(recovered);
  assert.equal(recovered.accountKey, "");
  assert.equal(recovered.accountAttribution, "inferred");
  assert.equal(ambientAccountReads, 0);
  assert.equal((await runJournal.turnProjectionStatus(missing)).current, true);
  assert.equal(telegramDeliveries, 0);

  const reader = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM journal_records WHERE thread_id = ?").get(base.threadId).count, 2);
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM usage_sync_events WHERE event_id LIKE 'usage:%'").get().count, 2);
    assert.equal(reader.prepare("SELECT input_tokens FROM usage_sync_events WHERE event_id LIKE 'usage:%' ORDER BY completed_ms LIMIT 1").get().input_tokens, 100);
    assert.equal(reader.prepare("SELECT COUNT(*) AS count FROM journal_turn_index WHERE thread_id = ?").get(base.threadId).count, 2);
    assert.equal(state.rows().filter((row) => row.state === "delivered").length, 2);
  } finally {
    reader.close();
    await usage.close();
    journal.close();
  }
});
