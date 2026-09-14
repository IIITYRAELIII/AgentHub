import assert from "node:assert/strict";
import test from "node:test";

import { CommandTraceService } from "../../src/application/command-trace-service.mjs";

test("CommandTraceService records a stage duration from a monotonic clock", async () => {
  const appended = [];
  const epochs = [1_000, 1_025];
  const monotonic = [250.5, 263.25];
  const store = {
    append: async (span) => {
      appended.push(span);
      return { appended: 1, duplicate: false, pruned: 0 };
    },
  };
  const service = new CommandTraceService({
    store,
    clock: () => epochs.shift(),
    monotonicClock: () => monotonic.shift(),
    createSpanId: () => "span-1",
  });

  const active = service.startSpan({
    commandId: "command-1",
    stage: "receipt-lock-wait",
    transport: "desktop",
    metadata: { lock: "desktop-control" },
  });
  const result = await active.finish({
    outcome: "succeeded",
    queueDepth: 3,
    lockWaitMs: 12.75,
    metadata: { attempt: 1 },
  });

  assert.deepEqual(result, { appended: 1, duplicate: false, pruned: 0 });
  assert.equal(appended[0].observedAtMs, 1_025);
  assert.equal(appended[0].monotonicDurationMs, 12.75);
  assert.deepEqual(appended[0].metadata, {
    lock: "desktop-control",
    attempt: 1,
    startedAtMs: 1_000,
  });
  await assert.rejects(active.finish({ outcome: "succeeded" }), /already finished/u);
});

test("CommandTraceService retries a failed append with the original span identity", async () => {
  let attempts = 0;
  const appended = [];
  const store = {
    append: async (span) => {
      attempts += 1;
      appended.push(span);
      if (attempts === 1) throw new Error("temporary trace write failure");
      return { appended: 1, duplicate: false, pruned: 0 };
    },
  };
  const service = new CommandTraceService({
    store,
    clock: () => 1_000 + attempts,
    monotonicClock: () => 100 + attempts,
    createSpanId: () => "stable-span-id",
  });
  const active = service.startSpan({
    commandId: "command-1",
    stage: "hub-receive",
    transport: "desktop",
  });

  await assert.rejects(active.finish({ outcome: "failed" }), /temporary trace write failure/u);
  await active.finish({ outcome: "succeeded" });

  assert.equal(appended.length, 2);
  assert.equal(appended[0].spanId, "stable-span-id");
  assert.equal(appended[1].spanId, "stable-span-id");
});

test("CommandTraceService delegates bounded timeline, percentile and retention reads", async () => {
  const calls = [];
  const store = {
    readCommandTimeline: async (...args) => {
      calls.push(["timeline", ...args]);
      return [{ spanId: "span-1" }];
    },
    readStagePercentiles: async (...args) => {
      calls.push(["percentiles", ...args]);
      return [{ stage: "client-ack", sampleCount: 1 }];
    },
    prune: async () => {
      calls.push(["prune"]);
      return { pruned: 2 };
    },
  };
  const service = new CommandTraceService({ store });

  assert.deepEqual(await service.readCommandTimeline("command-1", { limit: 20 }), [{ spanId: "span-1" }]);
  assert.deepEqual(await service.readStagePercentiles({ stage: "client-ack" }), [{
    stage: "client-ack",
    sampleCount: 1,
  }]);
  assert.deepEqual(await service.prune(), { pruned: 2 });
  assert.deepEqual(calls, [
    ["timeline", "command-1", { limit: 20 }],
    ["percentiles", { stage: "client-ack" }],
    ["prune"],
  ]);
});

test("CommandTraceService best-effort writes never reject the command path", async () => {
  const warnings = [];
  const service = new CommandTraceService({
    store: { appendBestEffort: () => { throw new Error("trace worker unavailable"); } },
    logger: { warn: (message) => warnings.push(message) },
    createSpanId: () => "best-effort-span",
  });

  assert.equal(service.recordBestEffort({
    commandId: "command-best-effort",
    stage: "hub-receive",
    outcome: "succeeded",
    transport: "desktop-control",
  }), false);
  const span = service.startBestEffortSpan({
    commandId: "command-best-effort",
    stage: "durable-intake-commit",
    transport: "desktop-control",
  });
  assert.equal(span.finish({ outcome: "succeeded" }), false);
  assert.equal(warnings.length, 2);
});


test("measured operation records its start before settling, keeps identity and monotonic timing", async () => {
  const records = [];
  let monotonic = 50;
  let ids = 0;
  let release;
  const service = new CommandTraceService({
    store: { appendBestEffort: (span) => { records.push(span); return true; } },
    clock: () => 1000, monotonicClock: () => monotonic,
    createSpanId: () => `span-${++ids}`, metadata: { instanceId: "actual-instance" },
  });
  const pending = service.measureBestEffort({
    commandId: "exact-command", stage: "terminal-state-save", transport: "server-runtime",
    metadata: { instanceId: "caller-instance", turnId: "exact-turn" },
  }, () => new Promise((resolve) => { release = resolve; }));
  assert.equal(records.length, 1);
  assert.equal(records[0].outcome, "started");
  assert.equal(records[0].metadata.instanceId, "actual-instance");
  monotonic = 72.5;
  release("original result");
  assert.equal(await pending, "original result");
  assert.equal(records[1].outcome, "succeeded");
  assert.equal(records[1].monotonicDurationMs, 22.5);
  assert.equal(records[0].metadata.operationSpanId, records[1].spanId);
  assert.equal(records[1].metadata.turnId, "exact-turn");
});

test("measured operation preserves failure identity and does not put error content in trace", async () => {
  const records = [];
  const service = new CommandTraceService({
    store: { appendBestEffort: (span) => { records.push(span); return true; } },
  });
  const error = new Error("private prompt and token");
  await assert.rejects(service.measureBestEffort({
    commandId: "command", stage: "startup-provider", transport: "server-runtime",
  }, () => { throw error; }), (observed) => observed === error);
  assert.deepEqual(records.map((record) => record.outcome), ["started", "failed"]);
  assert.equal(JSON.stringify(records).includes(error.message), false);
});
