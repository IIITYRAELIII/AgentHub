import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { randomUUID } from "node:crypto";

import { createCommandTraceComposition } from "../../src/composition/command-trace-composition.mjs";
import { clientPerformanceTraceSpans } from "../../src/application/client-performance-trace.mjs";
import { readCommandTraceReport } from "../../src/infrastructure/persistence/command-trace-report-reader.mjs";

test("PERF-001 trace foundation exposes append, timeline and percentile contracts", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-command-trace-contract-"));
  const composition = createCommandTraceComposition({
    dataDir,
    clock: () => 10_000,
    createSpanId: () => "span-contract-1",
  });
  context.after(async () => {
    await composition.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  await composition.initialize();
  await composition.service.record({
    commandId: "command-contract-1",
    stage: "durable-intake-commit",
    outcome: "succeeded",
    transport: "desktop",
    monotonicDurationMs: 42,
    queueDepth: 0,
    lockWaitMs: 0,
    sqliteBusyWaitMs: 0,
    metadata: { clientUserMessageId: "message-contract-1" },
  });

  const timeline = await composition.service.readCommandTimeline("command-contract-1");
  assert.equal(timeline.length, 1);
  assert.equal(timeline[0].observedAtMs, 10_000);
  assert.equal(timeline[0].metadata.clientUserMessageId, "message-contract-1");
  const [summary] = await composition.service.readStagePercentiles({
    stage: "durable-intake-commit",
  });
  assert.equal(summary.sampleCount, 1);
  assert.equal(summary.percentiles[1].durationMs, 42);
});

test("cancelled client spans survive the production worker and close incomplete report pairs", async (context) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-hub-client-worker-trace-"));
  const composition = createCommandTraceComposition({ dataDir });
  context.after(async () => {
    await composition.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await composition.initialize();
  const window = { performance, crypto: { randomUUID },
    document: { documentElement: { dataset: { view: "chat" } }, addEventListener() {} },
    setTimeout() {}, addEventListener() {},
  };
  vm.runInNewContext(await readFile(new URL("../../assets/web-app/command-trace.js", import.meta.url), "utf8"), { window, Date });
  const trace = window.AgentHubCommandTrace;
  trace.bindReporter(async (batch) => {
    for (const span of clientPerformanceTraceSpans(batch)) assert.equal(composition.service.recordBestEffort(span), true);
  });
  const abort = Object.assign(new Error("private diagnostic error"), { name: "AbortError" });
  await assert.rejects(trace.http("http-attachment", async () => { throw abort; }, "cancelled-command"), (error) => error === abort);
  await trace.flush();
  const timeline = await composition.service.readCommandTimeline("cancelled-command");
  assert.deepEqual(timeline.map((entry) => entry.outcome), ["started", "cancelled"]);
  assert.equal(timeline[0].metadata.operationSpanId, timeline[1].metadata.operationSpanId);
  assert.equal(timeline[1].metadata.failureKind, "aborted");
  const [summary] = await composition.service.readStagePercentiles({ stage: "ui-control", outcome: "cancelled" });
  assert.equal(summary.sampleCount, 1);
  const report = readCommandTraceReport(path.join(dataDir, "command-traces.sqlite"));
  assert.equal(report.incompleteCount, 0);
  assert.ok(report.stages.some((entry) => entry.outcome === "cancelled" && entry.count === 1));
  assert.doesNotMatch(JSON.stringify(timeline), /private diagnostic error/u);
});
