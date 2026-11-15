import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { JournalDatabase } from "../../src/infrastructure/persistence/journal-database.mjs";
import { WorkLogUsageRepository } from "../../src/infrastructure/persistence/work-log-usage-repository.mjs";
import { createWorkLogUsageStore } from "../../src/application/work-log-usage-store.mjs";
import { normalizePersistedWorkLog, buildWorkLogUsageHistory, projectWorkLogUsage,
  mergeLedgerRecord, incomingLedgerRecord } from "../../src/application/work-log-usage-projection.mjs";
import { planTurnDurationRecovery, durationStartForRecord } from "../../src/domain/turn-duration-recovery.mjs";
import { ProviderTurnTelemetryStore } from "../../src/infrastructure/persistence/provider-turn-telemetry-store.mjs";
import { recoverDurationFromDatabase } from "../../turn-duration-recovery.mjs";
import { DatabaseSync } from "node:sqlite";
import { WorkLogUsageSyncWorkerStore } from "../../src/runtime/work-log-usage-sync-worker-client.mjs";

const predecessor = { provider: "codex", threadId: "thread", turnId: "old", runId: "old-run",
  startedAt: "2026-10-15T19:24:58.461Z", completedAt: "2026-10-15T20:00:55.130Z" };
const record = { ...predecessor, turnId: "new", runId: "new-run",
  completedAt: "2026-10-28T02:57:08.758Z", status: "failed", usageReported: false,
  projectRoot: process.cwd(), model: "gpt-6.1-sol" };
const telemetry = { provider: "codex", threadId: "thread", turnId: "new", runId: "new-run",
  requestedAtMs: 1793156184949, acceptedAtMs: 1793156195399,
  turnStartedAtMs: 1793156195415, completedAtMs: 1793156215257 };

test("duration recovery requires exact run and independently proven inherited start", () => {
  assert.equal(planTurnDurationRecovery(record, { predecessor, telemetry: { ...telemetry, runId: "other" } }), null);
  assert.equal(planTurnDurationRecovery(record, { predecessor: { ...predecessor, threadId: "other" }, telemetry }), null);
  assert.equal(planTurnDurationRecovery(record, { predecessor: { ...predecessor, startedAt: "2026-10-16T00:00:00Z" }, telemetry }), null);
  const unknown = planTurnDurationRecovery(record, { predecessor, telemetry: { ...telemetry, turnStartedAtMs: null } });
  assert.equal(unknown.state, "unknown");
  assert.equal(durationStartForRecord({ ...record, durationRecovery: unknown }), "");
  assert.equal(durationStartForRecord({ ...record, turnId: "different", durationRecovery: unknown }), record.startedAt);
});

test("supported recovery persists provenance, reopens, reprojects and is idempotent", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub417-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const db = new JournalDatabase(databaseFile);
  await db.upsertRecords([predecessor, record]);
  db.close();
  const open = () => createWorkLogUsageStore({ repositoryFactory: (options) => new WorkLogUsageRepository(options),
    databaseFile, ledgerFile: path.join(directory, "ledger.json"), defaultProjectRoot: process.cwd() });
  let store = open();
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  const evidence = { predecessorTurnId: "old", telemetry };
  const preview = await store.recoverTurnDuration(record, evidence);
  assert.equal(preview.applied, false);
  const result = await store.recoverTurnDuration(record, evidence, { apply: true });
  assert.equal(result.applied, true);
  await store.close();
  store = open();
  assert.equal((await store.recoverTurnDuration(record, evidence, { apply: true })).unchanged, true);
  const read = new JournalDatabase(databaseFile);
  const raw = await read.getRecord(record);
  assert.equal(raw.startedAt, record.startedAt);
  assert.equal(raw.completedAt, record.completedAt);
  assert.equal(raw.durationRecovery.originalStartedAt, record.startedAt);
  assert.equal(raw.durationRecovery.providerCompletedAtMs - raw.durationRecovery.turnStartedAtMs, 19842);
  const normalized = normalizePersistedWorkLog({ version: 9, turns: { new: raw } }).ledger.turns;
  const html = projectWorkLogUsage("# Глобальный журнал работ\n", normalized);
  assert.match(html, /33 с/u);
  assert.doesNotMatch(html, /295 ч/u);
  const merged = mergeLedgerRecord(raw, incomingLedgerRecord(record));
  assert.equal(merged.durationRecovery.state, "known");
  const unknown = { ...raw, usageReported: true, usage: { inputTokens: 100 },
    durationRecovery: planTurnDurationRecovery(record, { predecessor, telemetry: { ...telemetry, turnStartedAtMs: null } }) };
  const history = buildWorkLogUsageHistory({ unknown }, { range: "all", now: Date.parse(record.completedAt) });
  assert.equal(history.totalDurationSeconds, 0);
  assert.equal(history.unknownDurationCount, 1);
  assert.match(projectWorkLogUsage("# Глобальный журнал работ\n", { unknown }), /неизвестно/u);
  assert.deepEqual(await read.getRecord(predecessor), { ...predecessor, projectRoot: "", taskThreadId: "thread" });
  read.close();
  await store.close();
  const telemetryStore = new ProviderTurnTelemetryStore({ databaseFile });
  await telemetryStore.upsert(telemetry);
  await telemetryStore.close();
  const cliPreview = await recoverDurationFromDatabase({ databaseFile, threadId: "thread", turnId: "new", predecessorTurnId: "old" });
  assert.equal(cliPreview.eligible, true);
  assert.equal(cliPreview.applied, false);
  await assert.rejects(recoverDurationFromDatabase({ databaseFile, threadId: "thread", turnId: "new", predecessorTurnId: "old", apply: true }), /configured work-log usage owner/u);
  store = open();
  const cliApply = await recoverDurationFromDatabase({ databaseFile, threadId: "thread", turnId: "new", predecessorTurnId: "old", apply: true, workLogUsageStore: store });
  assert.equal(cliApply.unchanged, true);
  assert.equal(cliApply.projectionPending, false);
});

test("recovered history places start, middle and end in the corrected day; unknown uses completion with unknown duration", () => {
  const priced = { ...record, usageReported: true, usage: { inputTokens: 1000 },
    durationRecovery: planTurnDurationRecovery(record, { predecessor, telemetry }) };
  const unknown = { ...priced, durationRecovery: planTurnDurationRecovery(record, {
    predecessor, telemetry: { ...telemetry, turnStartedAtMs: null },
  }) };
  for (const turnTimeMode of ["start", "middle", "end"]) {
    const options = { range: "24h", now: Date.parse(record.completedAt), turnTimeMode,
      activeIntervals: [{ from: "2026-10-28T02:56:35.415Z", to: "2026-10-28T02:57:09.000Z" }] };
    const knownHistory = buildWorkLogUsageHistory({ priced }, options);
    assert.equal(knownHistory.totalDurationSeconds, 33, turnTimeMode);
    assert.ok(knownHistory.totalCredits > 0, turnTimeMode);
    const unknownHistory = buildWorkLogUsageHistory({ unknown }, options);
    assert.equal(unknownHistory.unknownDurationCount, 1, turnTimeMode);
    assert.equal(unknownHistory.totalDurationSeconds, 0, turnTimeMode);
    assert.equal(unknownHistory.totalCredits, knownHistory.totalCredits, turnTimeMode);
  }
  assert.equal(priced.startedAt, record.startedAt);
});

test("configured-owner repair preserves scoped index, sync facts and account projection through failure, reopen and retry", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub417-context-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const otherRoot = path.join(directory, "other");
  const records = [{ ...predecessor, projectRoot: directory }, { ...record, projectRoot: directory,
    usageReported: true, usage: { inputTokens: 1000 }, accountKey: "account", accountLabel: "Account", accountAttribution: "exact" },
  { ...record, threadId: "other-thread", turnId: "unrelated", runId: "unrelated-run", projectRoot: otherRoot,
    startedAt: "2026-10-28T02:56:00Z", usageReported: true, usage: { inputTokens: 300 } }];
  await journal.upsertRecords(records);
  const telemetryStore = new ProviderTurnTelemetryStore({ databaseFile });
  await telemetryStore.upsert(telemetry);
  await telemetryStore.close();
  let failProjection = false;
  let worker;
  const open = () => {
    worker = new WorkLogUsageSyncWorkerStore({ databaseFile, deviceId: "device-local" });
    return createWorkLogUsageStore({ repositoryFactory: (options) => new WorkLogUsageRepository(options),
      databaseFile, ledgerFile: path.join(directory, "ledger.json"), defaultProjectRoot: directory,
      usageSyncStore: { events: (...args) => worker.events(...args), facts: (...args) => worker.facts(...args),
        projectJournal: (...args) => {
          if (failProjection) throw new Error("fixture projection failure");
          return worker.projectJournal(...args);
        }, close: () => worker.close() },
      usageSyncDeviceId: "device-local", usageSyncDeviceLabel: "Local device",
      usageSyncRuntimeHomeIds: { codex: "runtime-local" },
      workspaceCatalogStore: {
        resolveThread: (ref) => ({ workspaceId: "workspace", workspaceName: "Workspace",
          streamId: ref.threadId === "thread" ? "stream" : "other-stream", streamName: ref.threadId }),
        assignUnknownThread: () => null,
      },
    });
  };
  let store = open();
  t.after(async () => { await store.close(); journal.close(); await rm(directory, { recursive: true, force: true }); });
  await worker.importSnapshot({ events: [{ deviceId: "remote", provider: "codex", threadId: "remote-thread",
    turnId: "remote-turn", completedAt: record.completedAt, estimatedCredits: 2 }] });
  await store.project(null, { projectionProjectRoots: [directory, otherRoot] });
  const rows = () => {
    const reader = new DatabaseSync(databaseFile, { readOnly: true });
    try { return reader.prepare("SELECT provider,thread_id,turn_id,workspace_id,stream_id FROM journal_turn_index ORDER BY turn_id").all(); }
    finally { reader.close(); }
  };
  const beforeIndex = rows();
  assert.equal(beforeIndex.length, 3);
  assert.ok(beforeIndex.every((row) => row.workspace_id === "workspace"));
  const beforeLedger = await journal.loadLedger();
  const beforeFacts = await worker.facts();
  const beforeSource = await journal.projectionSource();
  const beforePayload = await journal.payload();
  const accountPanel = (html) => html.match(/<!-- work-log-account-panel:start -->[\s\S]*?<!-- work-log-account-panel:end -->/u)?.[0];
  assert.ok(accountPanel(beforePayload.html));
  failProjection = true;
  const request = { databaseFile, threadId: "thread", turnId: "new", predecessorTurnId: "old", apply: true };
  await assert.rejects(recoverDurationFromDatabase({ ...request, workLogUsageStore: store }), /fixture projection failure/u);
  assert.deepEqual(rows(), beforeIndex);
  await store.close();
  store = open();
  failProjection = false;
  const retry = await recoverDurationFromDatabase({ ...request, workLogUsageStore: store });
  assert.equal(retry.unchanged, true);
  assert.equal(retry.projectionPending, false);
  assert.deepEqual(rows(), beforeIndex);
  assert.deepEqual(await worker.facts(), beforeFacts);
  const afterSource = await journal.projectionSource();
  assert.deepEqual(afterSource.projectRoots, beforeSource.projectRoots);
  assert.deepEqual(afterSource.bindings, beforeSource.bindings);
  assert.equal(accountPanel((await journal.payload()).html), accountPanel(beforePayload.html));
  const afterLedger = await journal.loadLedger();
  for (const [key, previous] of Object.entries(beforeLedger.turns)) {
    const actual = { ...afterLedger.turns[key] };
    if (previous.turnId === "new") {
      assert.equal(actual.durationRecovery.state, "known");
      delete actual.durationRecovery;
    }
    assert.deepEqual(actual, previous);
  }
});
