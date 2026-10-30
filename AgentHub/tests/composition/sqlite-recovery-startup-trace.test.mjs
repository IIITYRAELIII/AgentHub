import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { measureStartupBeforeTrace } from "../../src/composition/command-trace-composition.mjs";
import { SharedSqliteRecoveryCoordinator } from "../../src/infrastructure/persistence/shared-sqlite-recovery.mjs";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";
import { CommandTraceWorkerStore } from "../../src/infrastructure/persistence/command-trace-worker-store.mjs";
import { withInterprocessLocks, readInterprocessLockStatus } from "../../src/infrastructure/process/interprocess-lock.mjs";

test("existing startup owner distinguishes admission from recovery without changing outcomes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "startup-recovery-trace-"));
  const canonicalRoot = await fs.realpath(root);
  t.after(async () => {
    assert.equal(await fs.realpath(root), canonicalRoot);
    assert.equal((await fs.lstat(root)).isSymbolicLink(), false);
    await fs.rm(root, { recursive: true });
  });
  const healthyRoot = path.join(root, "healthy");
  const partial = path.join(root, "partial", "journal.sqlite");
  await fs.mkdir(`${partial}.lock`, { recursive: true });
  // Controlled unresolved metadata, not an asserted historical owner identity.
  await fs.writeFile(path.join(`${partial}.lock`, `owner-${"0".repeat(64)}.json`), "", { flag: "wx" });
  const legacyLogs = [];
  const legacy = await measureStartupBeforeTrace("configuration", async (...args) => {
    assert.equal(args.length, 0);
    return 17;
  }, { logger: { info: (...a) => legacyLogs.push(a) } });
  assert.equal(legacy.value, 17);
  const legacySpans = [];
  legacy.record({ recordBestEffort: s => legacySpans.push(s) });
  assert.equal(legacySpans.length, 2);
  assert.equal(Object.hasOwn(legacySpans[0].metadata, "phaseMarkers"), false);

  const ownerFiles = await fs.readdir(`${partial}.lock`);
  assert.equal(ownerFiles.length, 1);
  const ownerFile = path.join(`${partial}.lock`, ownerFiles[0]);
  const before = await fs.readFile(ownerFile);
  assert.equal(before.length, 0);
  const beforeStatus = await readInterprocessLockStatus(partial);
  assert.equal(beforeStatus.status, "unknown");
  const failedLogs = [];
  const coordinator = new SharedSqliteRecoveryCoordinator({
    databaseFile: partial,
    withDatabaseLock: operation => withInterprocessLocks([partial], operation, { timeoutMs: 150, retryDelayMs: 5 }),
  });
  await assert.rejects(measureStartupBeforeTrace("sqlite-recovery", recordPhase => coordinator.prepare({ recordPhase }), {
    providePhaseRecorder: true,
    logger: { info: (_prefix, body) => failedLogs.push(JSON.parse(body)) },
  }), error => {
    assert.equal(error.code, "INTERPROCESS_LOCK_ADMISSION_TIMEOUT");
    return true;
  });
  const failedPhases = failedLogs.filter(x => x.phase);
  assert.deepEqual(failedPhases.map(x => [x.phase, x.outcome]), [["database-lock", "started"], ["database-lock", "failed"]]);
  assert.equal(new Set(failedLogs.map(x => x.operationSpanId)).size, 1);
  assert.deepEqual(await fs.readFile(ownerFile), before);
  assert.equal((await readInterprocessLockStatus(partial)).status, "unknown");
  assert(failedPhases[1].durationMs >= 150);
  assert.equal(failedLogs.at(-1).outcome, "failed");

  await fs.mkdir(healthyRoot);
  const healthyDb = path.join(healthyRoot, "journal.sqlite");
  const healthyLogs = [];
  const healthyCoordinator = new SharedSqliteRecoveryCoordinator({ databaseFile: healthyDb });
  const measurement = await measureStartupBeforeTrace("sqlite-recovery", recordPhase => healthyCoordinator.prepare({ recordPhase }), {
    providePhaseRecorder: true,
    logger: { info: (_prefix, body) => healthyLogs.push(JSON.parse(body)) },
  });
  assert.deepEqual(measurement.value, { degraded: false });
  const phases = healthyLogs.filter(x => x.phase);
  const names = ["database-lock", "recovery-lock-acquire", "marker-read", "intent-read", "database-stat", "recovery-lock-release"];
  assert.deepEqual(phases.map(x => [x.phase, x.outcome]), names.flatMap(p => [[p, "started"], [p, "succeeded"]]));
  assert.equal(new Set(healthyLogs.map(x => x.operationSpanId)).size, 1);
  assert.equal(phases.some(x => x.phase === "database-check"), false);
  await assert.rejects(fs.stat(healthyDb), { code: "ENOENT" });
  assert.equal((await readInterprocessLockStatus(healthyDb)).status, "available");
  const spans = [];
  measurement.record({ recordBestEffort: s => spans.push(s) });
  measurement.record({ recordBestEffort: s => spans.push(s) });
  assert.equal(spans.length, 2);
  assert.deepEqual(spans[1].metadata.phaseMarkers.map(x => [x.phase, x.outcome]), phases.map(x => [x.phase, x.outcome]));
  assert.equal(spans[1].metadata.operationSpanId, healthyLogs[0].operationSpanId);
  for (const p of phases) {
    assert.deepEqual(Object.keys(p).sort(), ["durationMs", "observedAtMs", "operationSpanId", "outcome", "phase", "pid", "releaseId", "stage"].sort());
    assert(Number.isFinite(p.durationMs) && p.durationMs >= 0);
  }
  // Observer failures cannot change lock/recovery outcomes.
  assert.deepEqual(await healthyCoordinator.prepare({ recordPhase: () => { throw new Error("observer"); } }), { degraded: false });
  assert.deepEqual(await healthyCoordinator.prepare({ recordPhase: () => Promise.reject(new Error("async observer")) }), { degraded: false });
  assert.deepEqual((await measureStartupBeforeTrace("sqlite-recovery", recordPhase => healthyCoordinator.prepare({ recordPhase }), {
    providePhaseRecorder: true, logger: { info() { throw new Error("logger"); } },
  })).value, { degraded: false });
  assert.deepEqual((await measureStartupBeforeTrace("sqlite-recovery", recordPhase => healthyCoordinator.prepare({ recordPhase }), {
    providePhaseRecorder: true, logger: { info: () => Promise.reject(new Error("async logger")) },
  })).value, { degraded: false });
  const sameFailure = new Error("original");
  await assert.rejects(measureStartupBeforeTrace("sqlite-recovery", () => { throw sameFailure; }, {
    providePhaseRecorder: true, logger: { info() { throw new Error("logger"); } },
  }), error => error === sameFailure);
  assert.equal((await readInterprocessLockStatus(healthyDb)).status, "available");

  // Capture before the worker exists, then prove the actual worker's persisted
  // timeline retains the SAME startup identity and phase boundaries on reopen.
  const bufferedLogs = [];
  const buffered = await measureStartupBeforeTrace("sqlite-recovery", recordPhase => healthyCoordinator.prepare({ recordPhase }), {
    providePhaseRecorder: true, logger: { info: (_prefix, body) => bufferedLogs.push(JSON.parse(body)) },
  });
  const commandId = `startup:${bufferedLogs[0].operationSpanId}`;
  const traceFile = path.join(root, "startup-traces.sqlite");
  let persistedPhases;
  const traceStore = new CommandTraceWorkerStore({ databaseFile: traceFile });
  try {
    await traceStore.initialize();
    const trace = new CommandTraceService({ store: traceStore });
    buffered.record(trace);
    const timeline = await trace.readCommandTimeline(commandId);
    assert.equal(timeline.length, 2);
    const terminal = timeline.find(span => span.outcome === "succeeded");
    assert.equal(terminal.metadata.operationSpanId, bufferedLogs[0].operationSpanId);
    assert.equal(terminal.metadata.bufferedUntilTraceReady, true);
    persistedPhases = terminal.metadata.phaseMarkers;
    assert.deepEqual(persistedPhases.map(x => [x.phase, x.outcome]), names.flatMap(p => [[p, "started"], [p, "succeeded"]]));
    assert.equal(traceStore.stats().droppedSpans, 0);
  } finally { await traceStore.close(); }
  const reopened = new CommandTraceWorkerStore({ databaseFile: traceFile });
  try {
    await reopened.initialize();
    const timeline = await reopened.readCommandTimeline(commandId);
    assert.deepEqual(timeline.find(span => span.outcome === "succeeded").metadata.phaseMarkers, persistedPhases);
  } finally { await reopened.close(); }
});
