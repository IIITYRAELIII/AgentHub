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

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error("condition was not reached");
    await delay(10);
  }
}

// Live terminal delivery over the real outbox, usage store and journal worker.
// The gate holds one worker projection after it has read its journal revision.
async function liveDelivery(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-projection-coalescing-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const worker = new WorkLogUsageSyncWorkerStore({ databaseFile });
  const usage = createWorkLogUsageStore({
    ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: root,
    usageSyncStore: worker, repositoryFactory: (options) => new WorkLogUsageRepository(options),
    workspaceCatalogStore: { resolveThread: () => null, assignUnknownThread: () => null },
  });
  const state = { calls: [], inFlight: 0, gate: null, failCall: -1 };
  const project = worker.projectJournal.bind(worker);
  worker.projectJournal = (payload, options = {}) => {
    const ordinal = state.calls.length;
    state.calls.push({ ordinal, startedWhileInFlight: state.inFlight > 0 });
    state.inFlight += 1;
    const gate = state.gate;
    state.gate = null;
    const resolver = options.workspaceResolver;
    const run = ordinal === state.failCall
      ? Promise.reject(new Error("injected journal projection failure"))
      : project(payload, gate ? {
        ...options,
        workspaceResolver: async (reference) => {
          gate.enter();
          await gate.released;
          return resolver?.(reference) ?? null;
        },
      } : options);
    return run.finally(() => { state.inFlight -= 1; });
  };
  state.hold = () => {
    const gate = {};
    gate.entered = new Promise((resolve) => { gate.enter = resolve; });
    gate.released = new Promise((resolve) => { gate.release = resolve; });
    state.gate = gate;
    return gate;
  };
  const terminal = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir: root }) });
  const runJournal = new RunJournalService({
    usageStore: usage, defaultProjectRoot: root, projectionProjectRoots: [root],
    findProject: (value) => value === root ? { path: root } : null,
  });
  const service = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} },
    terminalCommits: terminal, taskRuns: { forEvent: () => null },
    persistHistory: async () => {},
    projectTurn: (...args) => runJournal.projectTurn(...args),
    rememberLastMessage() {}, rememberSeenTurn() {}, saveState: async () => {}, logger: { error() {} },
  });
  const completion = (index) => ({
    provider: "codex", projectRoot: root, threadId: "thread", turnId: `turn-${index}`,
    status: "completed", finalAnswer: `Answer ${index}`, model: "gpt-6-astra",
    usage: { inputTokens: 100, outputTokens: 20 }, usageReported: true, resolveAccount: false,
    startedAt: `2026-09-12T10:0${index}:00.000Z`, completedAt: `2026-09-12T10:0${index}:30.000Z`,
  });
  const rows = () => {
    const reader = new DatabaseSync(path.join(root, "runtime.sqlite"), { readOnly: true });
    try {
      return reader.prepare(`
        SELECT turn_id, terminal_revision, state FROM provider_turn_terminal_outbox
        ORDER BY turn_id, terminal_revision
      `).all().map((row) => ({ ...row }));
    } finally { reader.close(); }
  };
  const stateOf = (turnId) => rows().filter((row) => row.turn_id === turnId).map((row) => row.state);
  const records = async () => Object.keys((await journal.loadLedger()).turns).length;
  t.after(async () => {
    await usage.close().catch(() => {});
    await worker.close().catch(() => {});
    journal.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  return { root, journal, usage, service, terminal, completion, rows, stateOf, records, state };
}

test("live terminals written during an in-flight projection wait for one trailing projection", async (t) => {
  const s = await liveDelivery(t);
  const leadingCommit = await s.terminal.commit(s.completion(0));
  const gate = s.state.hold();
  const leading = s.service.deliverOutbox(leadingCommit.outbox);
  await gate.entered;

  const late = [];
  for (const index of [1, 2, 3]) {
    const committed = await s.terminal.commit(s.completion(index));
    late.push(s.service.deliverOutbox(committed.outbox));
  }
  await waitFor(async () => await s.records() === 4);
  // Give an uncoalesced store every opportunity to issue its own requests.
  await delay(300);

  assert.equal(s.state.calls.filter((call) => call.startedWhileInFlight).length, 0,
    "a request made during an in-flight projection must not start another projection beside it");
  for (const index of [1, 2, 3]) {
    assert.notDeepEqual(s.stateOf(`turn-${index}`), ["delivered"],
      "the older in-flight projection must not acknowledge a later terminal revision");
  }

  gate.release();
  await Promise.all([leading, ...late]);

  assert.ok(s.rows().every((row) => row.state === "delivered" && row.terminal_revision === 1));
  // The leading run conflicts once on the late writes and retries; the late
  // terminals share exactly one projection that starts after it settles.
  assert.equal(s.state.calls.length, 3);
  const snapshot = JSON.stringify(await s.journal.snapshot());
  for (const index of [0, 1, 2, 3]) assert.ok(snapshot.includes(`Answer ${index}`));
  assert.equal(await s.records(), 4);
});

test("a failed trailing projection keeps its terminals pending and the lane recovers exactly once", async (t) => {
  const s = await liveDelivery(t);
  const leadingCommit = await s.terminal.commit(s.completion(0));
  const gate = s.state.hold();
  const leading = s.service.deliverOutbox(leadingCommit.outbox);
  await gate.entered;
  const late = [];
  for (const index of [1, 2]) {
    const committed = await s.terminal.commit(s.completion(index));
    late.push(s.service.deliverOutbox(committed.outbox).catch(() => false));
  }
  await waitFor(async () => await s.records() === 3);
  await delay(300);
  // Calls 0 and 1 are the leading run and its conflict retry; call 2 is the trailing run.
  s.state.failCall = 2;
  gate.release();
  await Promise.all([leading, ...late]);

  assert.deepEqual(s.stateOf("turn-0"), ["delivered"]);
  for (const index of [1, 2]) assert.deepEqual(s.stateOf(`turn-${index}`), ["pending"]);

  await s.service.retryPending();

  assert.ok(s.rows().every((row) => row.state === "delivered" && row.terminal_revision === 1));
  assert.equal(s.rows().length, 3);
  assert.equal(await s.records(), 3);
  const recovered = await s.usage.project(null, { projectRoot: s.root, projectionProjectRoots: [s.root] });
  assert.ok(recovered.projected === true || recovered.reason === "unchanged");
});

test("projections with a different semantic scope never share a run", async (t) => {
  const s = await liveDelivery(t);
  await s.terminal.commit(s.completion(0)).then(({ outbox }) => s.service.deliverOutbox(outbox));
  const before = s.state.calls.length;
  const gate = s.state.hold();
  const leading = s.usage.project(null, { projectRoot: s.root, projectionProjectRoots: [s.root] });
  await gate.entered;
  const other = s.usage.project(null, {
    projectRoot: s.root, projectionProjectRoots: [s.root], includeClaudeUsage: false,
  });
  await waitFor(() => s.state.calls.length === before + 2);
  assert.equal(s.state.calls[before + 1].startedWhileInFlight, true);
  gate.release();
  await Promise.all([leading, other]);
});

// A second connection owning the SQLite write lock, as any other Hub store may.
function foreignWriteLock(root) {
  const barrier = new DatabaseSync(path.join(root, "journal.sqlite"));
  barrier.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  return () => { barrier.exec("COMMIT"); barrier.close(); };
}

test("a live terminal waits out a short foreign write lock and is delivered once", async (t) => {
  const s = await liveDelivery(t);
  await s.terminal.commit(s.completion(0)).then(({ outbox }) => s.service.deliverOutbox(outbox));
  const before = await s.journal.currentRevision();
  const release = foreignWriteLock(s.root);
  const committed = await s.terminal.commit(s.completion(1));
  const delivery = s.service.deliverOutbox(committed.outbox).catch((error) => error);
  await delay(300);
  release();

  const result = await delivery;
  assert.equal(result?.projection, true, String(result?.message ?? ""));
  assert.deepEqual(s.stateOf("turn-1"), ["delivered"]);
  assert.equal(await s.records(), 2);
  // One record upsert and one projection: no write committed twice.
  assert.equal(await s.journal.currentRevision(), before + 2);
});

test("a live terminal blocked past the contention window stays pending and is delivered exactly once on retry", async (t) => {
  const s = await liveDelivery(t);
  await s.terminal.commit(s.completion(0)).then(({ outbox }) => s.service.deliverOutbox(outbox));
  const before = await s.journal.currentRevision();
  const release = foreignWriteLock(s.root);
  const committed = await s.terminal.commit(s.completion(1));
  const delivery = s.service.deliverOutbox(committed.outbox).catch((error) => error);
  await delay(2_500);
  release();

  assert.match(String((await delivery)?.message ?? ""), /database is locked/u);
  assert.deepEqual(s.stateOf("turn-1"), ["pending"]);
  assert.equal(await s.journal.currentRevision(), before);

  await s.service.retryPending();
  assert.deepEqual(s.stateOf("turn-1"), ["delivered"]);
  assert.equal(await s.records(), 2);
  assert.equal(await s.journal.currentRevision(), before + 2);
});
