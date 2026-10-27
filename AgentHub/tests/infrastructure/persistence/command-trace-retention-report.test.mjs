import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CommandTraceSpanStore, COMMAND_TRACE_RETENTION_DEFAULTS } from "../../../src/infrastructure/persistence/command-trace-span-store.mjs";
import { CommandTraceWorkerStore } from "../../../src/infrastructure/persistence/command-trace-worker-store.mjs";
import { readCommandTraceReport } from "../../../src/infrastructure/persistence/command-trace-report-reader.mjs";
import { runCommandTraceReport } from "../../../src/interfaces/cli/command-trace-report.mjs";

async function fixture(context) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-trace-report-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "traces.sqlite");
}

function span(spanId, details = {}) {
  return { spanId, commandId: "command-1", stage: "control-handler", transport: "http",
    outcome: "succeeded", observedAtMs: 10_000, monotonicDurationMs: 25, ...details };
}

test("startup removes old diagnostics after seven days even without an append", async (context) => {
  const databaseFile = await fixture(context);
  const first = new CommandTraceSpanStore({ databaseFile, clock: () => 10_000 });
  await first.append(span("old"));
  await first.close();
  const second = new CommandTraceSpanStore({ databaseFile,
    clock: () => 10_001 + COMMAND_TRACE_RETENTION_DEFAULTS.retentionMs });
  await second.initialize();
  assert.equal(COMMAND_TRACE_RETENTION_DEFAULTS.retentionMs, 7 * 24 * 60 * 60 * 1_000);
  assert.deepEqual(await second.readCommandTimeline("command-1"), []);
  await second.close();
});

test("idle worker expires spans without new traffic and releases its cleanup timer on close", async (context) => {
  const databaseFile = await fixture(context);
  const fixedClockMs = 10_000;
  const clockBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const clock = new Int32Array(clockBuffer);
  Atomics.store(clock, 0, fixedClockMs);
  const store = new CommandTraceWorkerStore({ databaseFile, retentionMs: 80,
    workerUrl: new URL("../../fixtures/command-trace-clock-worker.mjs", import.meta.url),
    workerData: { cleanupIntervalMs: 10, clockBuffer }, logger: { warn() {} } });
  try {
    await store.initialize();
    await store.append(span("idle", { observedAtMs: fixedClockMs }));
    const readOnly = new DatabaseSync(databaseFile, { readOnly: true });
    try {
      const count = () => Number(readOnly.prepare("SELECT COUNT(*) AS n FROM command_trace_spans").get().n);
      assert.equal(count(), 1);
      // Advance age after the initial read, independently of IPC scheduling.
      // The real idle timer must prune; no append/prune request wakes the worker.
      Atomics.store(clock, 0, fixedClockMs + 81);
      const deadline = Date.now() + 2_000;
      while (count() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      assert.equal(count(), 0);
    } finally { readOnly.close(); }
  } finally { await store.close(); }
  assert.equal(store.stats().workerRunning, false);
});

test("bounded retention survives duplicate IDs, sequence gaps and a failed transaction", async (context) => {
  const databaseFile = await fixture(context);
  const store = new CommandTraceSpanStore({ databaseFile, clock: () => 10_000, maxSpans: 3 });
  try {
    await store.appendMany([span("a"), span("b"), span("c")]);
    for (let index = 0; index < 5; index++) await store.append(span("b"));
    const blocker = new DatabaseSync(databaseFile);
    blocker.exec("BEGIN IMMEDIATE");
    await assert.rejects(store.append(span("failed")), /locked|busy/iu);
    blocker.exec("ROLLBACK");
    blocker.exec(`CREATE TRIGGER fail_test_batch BEFORE INSERT ON command_trace_spans
      WHEN NEW.span_id = 'failed-mid-batch' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;`);
    await assert.rejects(store.appendMany([span("rolled-back"), span("failed-mid-batch")]), /synthetic failure/u);
    blocker.exec("DROP TRIGGER fail_test_batch");
    blocker.close();
    await store.appendMany([span("d"), span("e")]);
    assert.deepEqual((await store.readCommandTimeline("command-1")).map((row) => row.spanId), ["c", "d", "e"]);
    await store.prune();
    assert.equal((await store.readCommandTimeline("command-1")).length, 3);
  } finally { await store.close(); }
  const reopened = new CommandTraceSpanStore({ databaseFile, clock: () => 10_000, maxSpans: 3 });
  try {
    await reopened.append(span("f"));
    assert.deepEqual((await reopened.readCommandTimeline("command-1")).map((row) => row.spanId), ["d", "e", "f"]);
  } finally { await reopened.close(); }
});

test("report separates browser and VS Code and exposes only bounded numeric health metadata", async (context) => {
  const databaseFile = await fixture(context);
  const store = new CommandTraceSpanStore({ databaseFile, clock: () => 10_000 });
  const metrics = { "trace.droppedSpans": 7, "command.loopDelayMs": 14, privateText: "do not export",
    "secret unsafe key": 123, nested: { value: 55 }, ...Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`metric${i}`, i])) };
  await store.appendMany([
    span("browser", { transport: "client", monotonicDurationMs: 20,
      metadata: { surface: "browser", view: "chat", instanceId: "instance-1", releaseId: "release-1" } }),
    span("vscode", { transport: "client", monotonicDurationMs: 70,
      metadata: { surface: "vscode", view: "dashboard", instanceId: "instance-1", releaseId: "release-1" } }),
    ...Array.from({ length: 12 }, (_, i) => span(`health-${i}`, { stage: "runtime-health", observedAtMs: 9_900 + i,
      metadata: { instanceId: "instance-1", releaseId: "release-1", metrics } })),
    span("unsafe-identities", { metadata: { surface: "private unsafe message", view: { body: "secret" },
      instanceId: "secret\nmessage", releaseId: "a".repeat(300) } }),
  ]);
  await store.close();
  const report = readCommandTraceReport(databaseFile, { fromMs: 0, toMs: 11_000 });
  const browser = report.stages.find((row) => row.surface === "browser");
  const vscode = report.stages.find((row) => row.surface === "vscode");
  assert.equal(browser.p50Ms, 20);
  assert.equal(vscode.p50Ms, 70);
  assert.equal(vscode.view, "dashboard");
  assert.equal(vscode.releaseId, "release-1");
  assert.equal(report.runtimeHealth.length, 10);
  assert.equal(report.runtimeHealth[0].observedAtMs, 9_911);
  assert.equal(report.runtimeHealth[0].instanceId, "instance-1");
  assert.equal(report.runtimeHealth[0].metrics["trace.droppedSpans"], 7);
  assert.equal(Object.keys(report.runtimeHealth[0].metrics).length, 64);
  const output = JSON.stringify(report);
  assert.equal(output.includes("secret"), false);
  assert.equal(output.includes("do not export"), false);
  assert.equal(output.includes("private unsafe message"), false);
});

test("read-only report excludes starts from percentiles and correlates exact incomplete operations", async (context) => {
  const databaseFile = await fixture(context);
  const store = new CommandTraceSpanStore({ databaseFile, clock: () => 10_000 });
  await store.appendMany([
    span("start-a", { outcome: "started", monotonicDurationMs: 0, metadata: { operationSpanId: "a" } }),
    span("a", { monotonicDurationMs: 10, metadata: { operationSpanId: "a", action: "snapshot", privateText: "must not export" } }),
    span("start-b", { outcome: "started", monotonicDurationMs: 0, metadata: { operationSpanId: "b" } }),
    ...[20, 30, 40].map((duration) => span(`sample-${duration}`, { monotonicDurationMs: duration, metadata: { action: "snapshot" } })),
  ]);
  await store.close();
  const before = await readFile(databaseFile);
  let output;
  const report = runCommandTraceReport([databaseFile, "--hours", "1", "--limit", "2"], {
    readReport: readCommandTraceReport, nowMs: 11_000, write: (value) => { output = value; },
  });
  assert.deepEqual(await readFile(databaseFile), before);
  assert.equal(report.storage.rows, 6);
  assert.ok(report.storage.totalBytes > 0);
  assert.equal(report.incompleteCount, 1);
  assert.equal(report.incomplete[0].spanId, "start-b");
  assert.equal(report.incomplete[0].correlated, true);
  assert.equal(report.stages[0].count, 4);
  assert.equal(report.stages[0].p50Ms, 20);
  assert.equal(report.stages[0].p95Ms, 40);
  assert.equal(report.slowest[0].durationMs, 40);
  assert.equal(output.includes("must not export"), false);
  assert.equal(report.truncated, false);
  assert.equal(readCommandTraceReport(databaseFile, { fromMs: 0, toMs: 11_000, maxRows: 2 }).truncated, true);
});
