import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { createTaskOperationTimingBatchRecorder, measureTaskOperation, measureTaskOperationAwait,
  withTaskOperationTiming } from "../../src/infrastructure/process/task-operation-timing.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { createTaskOperationTimingLogRecorder } from "../../src/infrastructure/persistence/task-operation-timing-log.mjs";

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test("concurrent operations retain identity, original errors and bounded diagnostics", async () => {
  const events = [], gate = deferred(), started = deferred();
  const failure = new Error("private failure contents");
  const first = withTaskOperationTiming({ operationId: "first", taskId: "a", record: event => events.push(event) }, async () => {
    started.resolve();
    await gate.promise;
    for (let i = 0; i < 520; i += 1) await measureTaskOperation("git-child", () => i, { detail: true });
    throw failure;
  });
  const rejection = assert.rejects(first, error => error === failure);
  await started.promise;
  assert.equal(await withTaskOperationTiming({ operationId: "second", taskId: "b", record: event => events.push(event) },
    () => measureTaskOperation("snapshot", () => 42)), 42);
  gate.resolve(); await rejection;
  assert.equal(events.filter(event => event.stage === "git-child" && event.phase === "start").length, 512);
  assert.equal(events.find(event => event.operationId === "first" && event.stage === "trace-summary").suppressedDetailSpans, 8);
  assert.equal(events.find(event => event.operationId === "first" && event.stage === "workflow" && event.phase === "end").outcome, "error");
  assert.ok(events.filter(event => event.stage === "snapshot").every(event => event.operationId === "second" && event.taskId === "b"));
  assert.ok(!JSON.stringify(events).includes(failure.message));
  for (const event of events.filter(event => event.durationMs != null)) assert.ok(event.durationMs >= 0);
});

test("failed synchronous or asynchronous diagnostic sink cannot fail the operation", async () => {
  for (const record of [() => { throw new Error("sink"); }, () => Promise.reject(new Error("sink"))]) {
    assert.equal(await withTaskOperationTiming({ operationId: "sink-failure", record }, () => 12), 12);
  }
});

test("bounded batches retain every span, flush on failure and reduce synchronous writes", async () => {
  const batches = [];
  const record = createTaskOperationTimingBatchRecorder(events => batches.push(events), { maxEvents: 16 });
  const failure = new Error("private failure contents");
  await assert.rejects(withTaskOperationTiming({ operationId: "batched", record }, async () => {
    for (let i = 0; i < 40; i += 1) await measureTaskOperation("git-child", () => i, { detail: true });
    throw failure;
  }), error => error === failure);
  const events = batches.flat();
  assert.equal(events.filter(event => event.stage === "git-child").length, 80);
  assert.equal(events.at(-2).stage, "trace-summary");
  assert.equal(events.at(-1).stage, "timing-sink-final");
  assert.ok(batches.length < 10, `expected fewer writes than spans, got ${batches.length}`);
  assert.ok(batches.every(batch => batch.length <= 16));
  assert.ok(events.every(event => event.operationId === "batched"));
  assert.ok(!JSON.stringify(events).includes(failure.message));
});

test("concurrent invocations with the same operation ID keep separate bounded batches", async () => {
  const batches = [], firstGate = deferred(), firstStarted = deferred();
  const record = createTaskOperationTimingBatchRecorder(events => batches.push(events), { maxEvents: 16 });
  const first = withTaskOperationTiming({ operationId: "same", record }, async () => {
    firstStarted.resolve();
    await firstGate.promise;
  });
  await firstStarted.promise;
  await withTaskOperationTiming({ operationId: "same", record }, () => 12);
  firstGate.resolve();
  await first;
  const summaries = batches.flat().filter(event => event.stage === "trace-summary");
  assert.equal(summaries.length, 2);
  assert.notEqual(summaries[0].traceId, summaries[1].traceId);
  assert.ok(batches.every(batch => batch.every(event => event.traceId === batch[0].traceId)));
});

test("batch writer preserves timestamped timing lines in a rotating log", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-timing-log-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "agent-hub.log");
  const record = createTaskOperationTimingLogRecorder({
    logFile: log, maxBytes: 1024 * 1024, maxFiles: 2, maxEvents: 4,
  });
  await withTaskOperationTiming({ operationId: "physical-log", record }, async () => {
    for (let i = 0; i < 8; i += 1) await measureTaskOperation("git-child", () => i, { detail: true });
  });
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(lines.length, 20);
  assert.ok(lines.every(line => line.includes("[task-operation-timing]")));
  const summary = JSON.parse(lines.at(-2).split("[task-operation-timing] ")[1]);
  const tail = JSON.parse(lines.at(-1).split("[task-operation-timing] ")[1]);
  assert.equal(summary.stage, "trace-summary");
  assert.equal(tail.stage, "timing-sink-final");
  assert.equal(tail.unmeasuredTailWrites, 1);
  assert.ok(summary.batchWrites > 0);
  assert.ok(summary.batchWriteMs >= 0);
});

test("a running child start is persisted by the batch deadline", async () => {
  const batches = [];
  const record = createTaskOperationTimingBatchRecorder(events => batches.push(events),
    { maxEvents: 16, maxDelayMs: 10 });
  const gate = deferred(), started = deferred();
  const running = withTaskOperationTiming({ operationId: "pending-child", record }, () =>
    measureTaskOperation("git-child", async () => { started.resolve(); await gate.promise; }, { detail: true }));
  await started.promise;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.ok(batches.flat().some(event => event.stage === "git-child" && event.phase === "start"));
  gate.resolve();
  await running;
  assert.equal(batches.flat().at(-1).stage, "timing-sink-final");
});

test("final summary sink delay is durably reported with one explicit tail write", async (t) => {
  const events = [];
  const record = createTaskOperationTimingBatchRecorder(batch => {
    if (batch.some(event => event.stage === "trace-summary")) {
      const until = performance.now() + 50;
      while (performance.now() < until) { /* Exact delayed final batch. */ }
    }
    events.push(...batch);
  });
  await withTaskOperationTiming({ operationId: "final-sink", record }, () => 1);
  const summary = events.find(event => event.stage === "trace-summary");
  const tail = events.find(event => event.stage === "timing-sink-final");
  assert.ok(summary.batchWriteMs < 20);
  assert.ok(tail.finalBatchWriteMs >= 50);
  assert.ok(tail.totalBatchWriteMs >= tail.finalBatchWriteMs);
  assert.equal(tail.batchWrites, 2);
  assert.equal(tail.unmeasuredTailWrites, 1);
  t.diagnostic(`final-summary sink=${tail.finalBatchWriteMs.toFixed(1)}ms residual=${tail.unmeasuredTailWrites} tail write`);
});

test("bounded batching shortens a critical path with a slow synchronous log sink", async (t) => {
  const write = () => {
    const until = performance.now() + 2;
    while (performance.now() < until) { /* Model delayed filesystem logging. */ }
  };
  const operation = async (record) => withTaskOperationTiming({ operationId: "slow-log", record }, async () => {
    for (let i = 0; i < 32; i += 1) await measureTaskOperation("git-child", () => i, { detail: true });
  });
  const directStarted = performance.now();
  await operation(write);
  const directMs = performance.now() - directStarted;
  const batchedStarted = performance.now();
  await operation(createTaskOperationTimingBatchRecorder(write, { maxEvents: 16 }));
  const batchedMs = performance.now() - batchedStarted;
  t.diagnostic(`synthetic-sink direct=${directMs.toFixed(1)}ms batched=${batchedMs.toFixed(1)}ms`);
  assert.ok(directMs > batchedMs * 2, `direct=${directMs}ms batched=${batchedMs}ms`);
});

test("slow await and synchronous recorder cost are attributed without changing errors", async () => {
  const events = [], failure = new Error("private owner failure");
  await assert.rejects(withTaskOperationTiming({ operationId: "await-owner", record: event => {
    const until = performance.now() + 2;
    while (performance.now() < until) { /* Model a synchronous log sink. */ }
    events.push(event);
  } }, () => measureTaskOperationAwait("lock-owner-read-await", async () => {
    await new Promise(resolve => setTimeout(resolve, 10));
    throw failure;
  }, { reportAtMs: 1 })), error => error === failure);
  const checkpoint = events.find(event => event.stage === "lock-owner-read-await");
  const summary = events.find(event => event.stage === "trace-summary");
  assert.equal(checkpoint.outcome, "error");
  assert.ok(checkpoint.durationMs >= 1);
  assert.ok(summary.synchronousRecordMs >= 2);
  assert.ok(summary.maxSynchronousRecordMs >= 2);
  assert.ok(Number.isFinite(summary.eventLoopDelayMaxMs));
  assert.ok(!JSON.stringify(events).includes(failure.message));
});

test("real child failures keep stderr out of timing and preserve the original rejection", async () => {
  const events = [];
  await assert.rejects(withTaskOperationTiming({ operationId: "child", record: event => events.push(event) },
    () => runTaskGitCommand(["-e", "process.stderr.write('PRIVATE_PAYLOAD');process.exit(7)"],
      { executable: process.execPath, commandLabel: "test-private-label" })), /PRIVATE_PAYLOAD/u);
  const child = events.find(event => event.stage === "git-child" && event.phase === "end");
  assert.equal(child.command, "external"); assert.equal(child.outcome, "error");
  assert.ok(!JSON.stringify(events).includes("PRIVATE"));
  assert.ok(!JSON.stringify(events).includes("test-private-label"));
});

test("real Task lock wait is separated from the protected operation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-task-timing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const events = [], held = deferred(), release = deferred();
  const service = new TaskGitWorkspaceService({ dataDir: root, recordTiming: event => events.push(event) });
  const first = service.withTaskLock("same-task", async () => { held.resolve(); await release.promise; });
  await held.promise;
  const second = service.withOperationTrace({ operationId: "waiter", taskId: "same-task" },
    () => service.withTaskLock("same-task", () => "completed"));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(events.some(event => event.stage === "lock" && event.phase === "start"));
  assert.ok(!events.some(event => event.stage === "lock-acquired"));
  release.resolve(); await first;
  assert.equal(await second, "completed");
  const acquired = events.find(event => event.stage === "lock-acquired");
  assert.equal(acquired.lockKind, "task"); assert.ok(acquired.waitMs > 0);
  assert.ok(events.some(event => event.stage === "workflow" && event.phase === "end" && event.outcome === "ok"));
});

test("post-budget aggregates preserve full static operator counts and original failures", async () => {
  const batches = [];
  const record = createTaskOperationTimingBatchRecorder(rows => batches.push(rows));
  const original = new Error("private aggregate failure");
  await assert.rejects(withTaskOperationTiming({ operationId: "post-budget", record }, async () => {
    for (let index = 0; index < 600; index += 1) {
      await measureTaskOperation("git-child", () => index, { detail: true, command: "rev-parse" });
    }
    await measureTaskOperation("release:base-evidence", async () => {
      await measureTaskOperation("release:git-command", () => 7, { detail: true });
      await assert.rejects(measureTaskOperation("release:git-input", () => { throw original; }, { detail: true }), error => error === original);
    });
    throw original;
  }), error => error === original);
  const events = batches.flat();
  const summary = events.find(row => row.stage === "trace-summary");
  assert.equal(events.filter(row => row.stage === "git-child" && row.phase === "start").length, 512);
  assert.equal(summary.suppressedDetailSpans, 90);
  assert.equal(summary.aggregateSemantics, "inclusive-nested-not-additive");
  const group = name => summary.stageAggregates.find(row => row.stage === name);
  assert.equal(group("git-child").count, 600);
  assert.equal(group("git-child").suppressedCount, 88);
  assert.equal(group("git-child").command, "rev-parse");
  assert.equal(group("release:git-command").count, 1);
  assert.equal(group("release:git-command").suppressedCount, 1);
  assert.equal(group("release:git-input").count, 1);
  assert.equal(group("release:git-input").errorCount, 1);
  assert.equal(group("release:base-evidence").count, 1);
  assert.ok(group("release:base-evidence").inclusiveMs >= group("release:git-input").inclusiveMs);
  assert.ok(summary.stageAggregates.every(row => Number.isFinite(row.inclusiveMs) && row.inclusiveMs >= 0 && row.maxMs >= 0));
  assert.equal(events.at(-1).stage, "timing-sink-final");
  assert.ok(!JSON.stringify(summary).includes(original.message));
  assert.ok(events.every(row => row.operationId === "post-budget"));
});

test("aggregate classes are fixed and do not retain arbitrary labels or argument content", async () => {
  const events = [];
  await withTaskOperationTiming({ operationId: "aggregate-privacy", record: row => events.push(row) }, async () => {
    await measureTaskOperation("PRIVATE_PATH_STAGE", () => 1, { detail: true, command: "PRIVATE_TOKEN_COMMAND", arbitrary: "PRIVATE_BODY" });
    await measureTaskOperation("git-child", () => 2, { detail: true, command: "PRIVATE_TOKEN_COMMAND" });
  });
  const summary = events.find(row => row.stage === "trace-summary");
  const wire = JSON.stringify(summary.stageAggregates);
  assert.equal(wire.includes("PRIVATE"), false);
  assert.ok(summary.stageAggregates.some(row => row.stage === "other"));
  assert.ok(summary.stageAggregates.some(row => row.stage === "git-child" && row.command === "other"));
  assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 16 * 1024);
});

test("a closed trace retains its immutable aggregate snapshot when a detached child settles later", async () => {
  const gate = deferred(), entered = deferred(), events = [];
  let pending;
  await withTaskOperationTiming({ operationId: "late-child", record: row => events.push(row) }, async () => {
    pending = measureTaskOperation("git-child", async () => { entered.resolve(); await gate.promise; }, { detail: true, command: "status" });
    await entered.promise;
  });
  const summary = events.find(row => row.stage === "trace-summary");
  const before = JSON.stringify(summary);
  gate.resolve(); await pending;
  assert.equal(JSON.stringify(summary), before);
});
