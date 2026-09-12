// HUB-220 isolated benchmark: live terminal delivery, cursor usage sync and a
// main-thread journal writer over one temporary SQLite journal. It never opens
// the live Agent Hub data directory.
//
//   node tests/perf/journal-projection-coalescing.bench.mjs --source <AgentHub root>
//     [--records 12535] [--facts 36397] [--live 6] [--body-bytes 4096] [--barrier-ms 1500]
//
// --source selects the Agent Hub source tree whose modules are measured, so the
// same scenario runs against a baseline checkout and the candidate.
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const argument = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const source = path.resolve(argument("source", path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..")));
const RECORDS = Number(argument("records", 12_535));
const FACTS = Number(argument("facts", 36_397));
const LIVE = Number(argument("live", 6));
const BODY_BYTES = Number(argument("body-bytes", 4096));
const BARRIER_MS = Number(argument("barrier-ms", 1500));

const load = (relative) => import(pathToFileURL(path.join(source, "src", relative)).href);
const [
  { TurnEndDeliveryService }, { TerminalTurnCommitService }, { RunJournalService },
  { createWorkLogUsageStore }, { ProviderTurnTerminalStore }, { JournalDatabase },
  { WorkLogUsageRepository }, { WorkLogUsageSyncWorkerStore }, { AsyncSqliteMutationQueue },
] = await Promise.all([
  load("application/turn-end-delivery-service.mjs"), load("application/terminal-turn-commit-service.mjs"),
  load("application/run-journal-service.mjs"), load("application/work-log-usage-store.mjs"),
  load("infrastructure/persistence/provider-turn-terminal-store.mjs"),
  load("infrastructure/persistence/journal-database.mjs"),
  load("infrastructure/persistence/work-log-usage-repository.mjs"),
  load("runtime/work-log-usage-sync-worker-client.mjs"),
  load("infrastructure/persistence/async-sqlite-mutation-queue.mjs"),
]);

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const round = (value) => Math.round(value * 10) / 10;
const stats = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { count: 0 };
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { count: sorted.length, p50: round(at(0.5)), max: round(sorted.at(-1)), total: round(sorted.reduce((a, b) => a + b, 0)) };
};
const commitOf = (root) => {
  try { return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(); }
  catch { return null; }
};

const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-hub220-bench-"));
const databaseFile = path.join(root, "journal.sqlite");
const projectRoots = ["alpha", "beta", "gamma"].map((name) => path.join(root, name));
const accounts = ["chatgpt:owner", "chatgpt:team", "chatgpt:second"];
const body = "Retained answer text. ".repeat(Math.max(1, Math.ceil(BODY_BYTES / 22))).slice(0, BODY_BYTES);
const report = { source, sourceCommit: commitOf(source), records: RECORDS, facts: FACTS, live: LIVE, bodyBytes: BODY_BYTES };

let journal; let worker; let usage; let writer; let barrier = null; let writerLoop = null; let writing = false;
try {
  // Setup: excluded from every measurement below.
  journal = new JournalDatabase(databaseFile);
  const at = (index) => new Date(Date.parse("2026-06-01T00:00:00Z") + index * 60_000).toISOString();
  for (let offset = 0; offset < RECORDS; offset += 500) {
    await journal.upsertRecords(Array.from({ length: Math.min(500, RECORDS - offset) }, (_, i) => {
      const index = offset + i;
      const thread = `thread-${index % 40}`;
      return {
        provider: "codex", threadId: thread, taskThreadId: thread, turnId: `seed-${index}`,
        projectRoot: projectRoots[index % projectRoots.length], startedAt: at(index), completedAt: at(index + 0.5),
        observedAt: at(index + 0.5), accountKey: accounts[index % accounts.length], accountAttribution: "exact",
        usageReported: true, usage: { inputTokens: 1000 + index % 97, outputTokens: 100 }, model: "gpt-6-astra",
        status: "completed", body, prompt: `Prompt ${index}`,
      };
    }));
  }
  worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: "device-local" });
  for (let offset = 0; offset < FACTS; offset += 2000) {
    await worker.importSnapshot({ events: Array.from({ length: Math.min(2000, FACTS - offset) }, (_, i) => {
      const index = offset + i;
      return {
        deviceId: `device-remote-${index % 3}`, provider: "codex", threadId: `remote-thread-${index % 200}`,
        turnId: `remote-turn-${index}`, completedAt: at(index), accountKey: accounts[index % accounts.length],
        estimatedCredits: 1 + index % 5,
      };
    }) });
  }
  const factIdentity = (fact) => fact.eventId ?? fact.observationId;
  const factsBefore = new Set((await worker.facts()).map(factIdentity));

  usage = createWorkLogUsageStore({
    ledgerFile: path.join(root, "retired.json"), databaseFile, defaultProjectRoot: projectRoots[0],
    usageSyncStore: worker, repositoryFactory: (options) => new WorkLogUsageRepository(options),
    workspaceCatalogStore: { resolveThread: () => null, assignUnknownThread: () => null },
  });
  const calls = [];
  let inFlight = 0;
  let failNextLive = true;
  const projectJournal = worker.projectJournal.bind(worker);
  worker.projectJournal = (payload, options) => {
    const call = { startedWhileInFlight: inFlight > 0, startedAt: performance.now() };
    calls.push(call);
    inFlight += 1;
    const injected = failNextLive && measuring;
    if (injected) failNextLive = false;
    const run = injected ? Promise.reject(new Error("injected projection failure")) : projectJournal(payload, options);
    return run.then((result) => Object.assign(call, {
      totalMs: performance.now() - call.startedAt, queueWaitMs: result.queueWaitMs, durationMs: result.durationMs,
      renderMs: result.renderMs, normalizeMs: result.normalizeMs, factsReadMs: result.factsReadMs,
      commitMs: result.commitMs, conflict: Boolean(result.conflict || result.projectionDeferred),
      recordCount: result.recordCount, eventCount: result.eventCount,
    }) && result, (error) => {
      Object.assign(call, { totalMs: performance.now() - call.startedAt, error: error.message });
      throw error;
    }).finally(() => { inFlight -= 1; });
  };
  const terminal = new TerminalTurnCommitService({ store: new ProviderTurnTerminalStore({ dataDir: root }) });
  const runJournal = new RunJournalService({
    usageStore: usage, defaultProjectRoot: projectRoots[0], projectionProjectRoots: projectRoots,
    findProject: (value) => projectRoots.includes(value) ? { path: value } : null,
  });
  const service = new TurnEndDeliveryService({
    notifications: { values: () => [], markDelivered() {} },
    terminalCommits: terminal, taskRuns: { forEvent: () => null }, persistHistory: async () => {},
    projectTurn: (...args) => runJournal.projectTurn(...args),
    flushTurnProjections: (...args) => runJournal.flushTurnProjections(...args),
    rememberLastMessage() {}, rememberSeenTurn() {}, saveState: async () => {}, logger: { error() {} },
  });
  let measuring = false;
  await usage.project(null, { projectRoot: projectRoots[0], projectionProjectRoots: projectRoots });
  const baselineRevision = await journal.currentRevision();
  calls.length = 0;

  // A main-thread writer on the same file with the production busy_timeout=0
  // and the 2-second deadline used by local task sync.
  writer = new DatabaseSync(databaseFile);
  writer.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS hub220_bench_writer (id INTEGER PRIMARY KEY, at INTEGER NOT NULL)");
  const writerQueue = new AsyncSqliteMutationQueue();
  const writerErrors = [];
  writing = true;
  writerLoop = (async () => {
    while (writing) {
      await writerQueue.run(() => writer.prepare("INSERT INTO hub220_bench_writer (at) VALUES (?)").run(Date.now()), { timeoutMs: 2000 })
        .catch((error) => writerErrors.push(error.message));
      await delay(100);
    }
  })();

  const completion = (index) => ({
    provider: "codex", projectRoot: projectRoots[index % projectRoots.length], threadId: `live-thread-${index}`,
    turnId: `live-${index}`, status: "completed", finalAnswer: `HUB220 live answer ${index}`, model: "gpt-6-astra",
    usage: { inputTokens: 500, outputTokens: 50 }, usageReported: true, resolveAccount: false,
    startedAt: at(RECORDS + index), completedAt: at(RECORDS + index + 0.5),
  });

  // Measured scenario.
  measuring = true;
  const scenarioStart = performance.now();
  const snapshotStart = performance.now();
  const snapshot = usage.usageSyncSnapshot({ afterJournalRevision: baselineRevision, deviceLabel: "bench" })
    .then((value) => ({ value, totalMs: performance.now() - snapshotStart }));
  const deliveries = [];
  let duplicate = null;
  for (let index = 0; index < LIVE; index += 1) {
    const committed = await terminal.commit(completion(index));
    const committedAt = performance.now();
    deliveries.push(service.deliverOutbox(committed.outbox).catch((error) => ({ error: error.message }))
      .then((delivered) => ({ index, delivered, ackMs: performance.now() - committedAt })));
    if (index === 0) duplicate = committed.outbox;
    await delay(60);
  }
  const duplicateResult = await service.deliverOutbox(duplicate).catch(() => false);
  const live = await Promise.all(deliveries);
  const snapshotResult = await snapshot;
  const firstPassMs = performance.now() - scenarioStart;
  const pendingAfterFirstPass = (await terminal.pending()).length;
  const recoveryStart = performance.now();
  await service.retryPending();
  const recoveryMs = performance.now() - recoveryStart;
  const scenarioMs = performance.now() - scenarioStart;

  // Deterministic lock barrier: a second connection owns the write lock while a
  // real terminal is recorded and projected, then releases it.
  barrier = new DatabaseSync(databaseFile);
  barrier.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  const barred = await terminal.commit(completion(LIVE));
  const barrierStart = performance.now();
  const barredDelivery = service.deliverOutbox(barred.outbox)
    .catch((error) => ({ error: error.message, stack: String(error.stack ?? "").split("\n").slice(0, 12) }));
  await delay(BARRIER_MS);
  barrier.exec("COMMIT");
  barrier.close();
  barrier = null;
  const barredResult = await barredDelivery;
  const barrierDeliveryMs = performance.now() - barrierStart;
  await service.retryPending();
  measuring = false;

  writing = false;
  await writerLoop;
  const secondSnapshot = await usage.usageSyncSnapshot({
    afterJournalRevision: snapshotResult.value.journalRevision === undefined ? baselineRevision : await journal.currentRevision(),
    deviceLabel: "bench",
  });
  const ledger = await journal.loadLedger();
  const outbox = new DatabaseSync(path.join(root, "runtime.sqlite"), { readOnly: true });
  const outboxRows = outbox.prepare("SELECT turn_id, terminal_revision, state FROM provider_turn_terminal_outbox").all();
  outbox.close();
  const factsAfter = new Set((await worker.facts()).map(factIdentity));
  const html = JSON.stringify(await journal.snapshot());
  const liveIds = Array.from({ length: LIVE + 1 }, (_, index) => `live-${index}`);

  Object.assign(report, {
    scenario: { firstPassMs: round(firstPassMs), recoveryMs: round(recoveryMs), totalMs: round(scenarioMs) },
    projections: {
      calls: calls.length,
      startedWhileInFlight: calls.filter((call) => call.startedWhileInFlight).length,
      conflicts: calls.filter((call) => call.conflict).length,
      errors: calls.filter((call) => call.error).length,
      totalMs: stats(calls.map((call) => call.totalMs)), queueWaitMs: stats(calls.map((call) => call.queueWaitMs)),
      workerDurationMs: stats(calls.map((call) => call.durationMs)), renderMs: stats(calls.map((call) => call.renderMs)),
      normalizeMs: stats(calls.map((call) => call.normalizeMs)), factsReadMs: stats(calls.map((call) => call.factsReadMs)),
      commitMs: stats(calls.map((call) => call.commitMs)),
      recordCount: calls.find((call) => call.recordCount)?.recordCount, eventCount: calls.find((call) => call.eventCount)?.eventCount,
    },
    delivery: {
      liveCommitToSettleMs: stats(live.map((item) => item.ackMs)), deliveredOnFirstPass: live.filter((item) => item.delivered).length,
      firstPassValues: live.map((item) => item.delivered),
      pendingAfterFirstPass, duplicateDelivered: duplicateResult,
    },
    snapshot: { totalMs: round(snapshotResult.totalMs), workerMs: round(snapshotResult.value.durationMs ?? NaN), events: snapshotResult.value.events.length },
    sqlite: {
      writer: writerQueue.diagnostics(), writerErrors: writerErrors.length, writerErrorSample: writerErrors.slice(0, 3),
      // Repository write queue: queue wait is enqueue delay, lastWaitMs/retries
      // are SQLite contention, lastExecutionMs includes the database call.
      journalWrites: usage.journalWriteDiagnostics?.() ?? null,
    },
    barrier: { heldMs: BARRIER_MS, deliveryMs: round(barrierDeliveryMs), firstAttempt: barredResult },
    correctness: {
      records: Object.keys(ledger.turns).length, expectedRecords: RECORDS + LIVE + 1,
      everyLiveRecordedOnce: liveIds.every((id) => Object.keys(ledger.turns).filter((key) => key.endsWith(`\0${id}`)).length === 1),
      everyOutboxDelivered: outboxRows.length === LIVE + 1 && outboxRows.every((row) => row.state === "delivered" && row.terminal_revision === 1),
      everyLiveAnswerProjected: liveIds.every((_, index) => html.includes(`HUB220 live answer ${index}`)),
      factsPreserved: factsBefore.size === factsAfter.size && [...factsBefore].every((id) => factsAfter.has(id)),
      factCount: factsAfter.size, expectedFacts: FACTS, exactFacts: factsAfter.size === FACTS,
      exactRecords: Object.keys(ledger.turns).length === RECORDS + LIVE + 1,
      secondCursorSnapshotEvents: secondSnapshot.events.length,
    },
  });
  console.log(JSON.stringify(report, null, 2));
  const failed = Object.entries(report.correctness).filter(([, value]) => value === false).map(([name]) => name);
  if (failed.length) {
    console.error(`HUB-220 benchmark correctness failed: ${failed.join(", ")}`);
    process.exitCode = 1;
  }
} finally {
  writing = false;
  await writerLoop?.catch(() => {});
  if (barrier) {
    try { barrier.exec("ROLLBACK"); } catch { /* no open transaction */ }
    try { barrier.close(); } catch { /* already closed */ }
  }
  try { writer?.close(); } catch { /* already closed */ }
  await usage?.close().catch(() => {});
  await worker?.close().catch(() => {});
  journal?.close();
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
