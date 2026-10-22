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
    rememberSeenTurn() {}, saveState: async () => {},
    logger: { error: (...args) => events.push(["error", ...args]) },
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
