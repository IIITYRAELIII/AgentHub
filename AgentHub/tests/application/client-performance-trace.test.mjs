import test from "node:test";
import assert from "node:assert/strict";
import { clientPerformanceTraceSpans } from "../../src/application/client-performance-trace.mjs";
import { createRuntimePerformanceSampler } from "../../src/application/runtime-performance-sampler.mjs";

test("client trace keeps bounded timings and discards content and arbitrary metadata", () => {
  const event = { commandId: "ui-1", stage: "ui-render", outcome: "succeeded", observedAtMs: 1000,
    monotonicDurationMs: 72, metadata: { action: "messages", surface: "web", count: 10,
      text: "private message", url: "https://secret", error: "secret", view: "invalid space" } };
  const [span] = clientPerformanceTraceSpans({ events: [event] }, { now: 1010 });
  assert.equal(span.monotonicDurationMs, 72);
  assert.deepEqual(span.metadata, { action: "messages", surface: "web", count: 10 });
  for (const changes of [{ stage: "terminal-commit" }, { commandId: "bad id" },
    { observedAtMs: 99999999 }, { monotonicDurationMs: -1 }]) {
    assert.throws(() => clientPerformanceTraceSpans({ events: [{ ...event, ...changes }] }, { now: 1010 }));
  }
  assert.throws(() => clientPerformanceTraceSpans({ events: Array(33).fill(event) }));
});

test("client ACK shares existing monotonic measurement conversion", () => {
  const [span] = clientPerformanceTraceSpans({ events: [{ commandId: "ack-1", stage: "client-ack",
    outcome: "succeeded", surface: "vscode-webview", timing: { submittedAtMs: 1000,
      submittedMonotonicMs: 20, clientAckAtMs: 1300, clientAckMonotonicMs: 320 } }] }, { now: 1301 });
  assert.equal(span.stage, "client-ack"); assert.equal(span.monotonicDurationMs, 300);
});

test("client pairing and cancellation accept only bounded diagnostic identity, time and failure class", () => {
  const event = { commandId: "command-1", stage: "ui-control", outcome: "cancelled",
    observedAtMs: 2000, monotonicDurationMs: 1000, metadata: {
      operationSpanId: "operation-1", startedAtMs: 1000, failureKind: "aborted", statusCode: 503,
    } };
  assert.deepEqual(clientPerformanceTraceSpans({ events: [event] }, { now: 2000 })[0].metadata, event.metadata);
  event.metadata = { operationSpanId: "private invalid identity", startedAtMs: 2001,
    failureKind: "private failure", statusCode: 999, body: "private" };
  assert.deepEqual(clientPerformanceTraceSpans({ events: [event] }, { now: 2000 })[0].metadata, {});
  event.observedAtMs = 62_000;
  event.metadata = { startedAtMs: 61_000 };
  assert.equal(clientPerformanceTraceSpans({ events: [event] }, { now: 2000 })[0].metadata.startedAtMs, 61_000);
  event.observedAtMs = 62_001;
  assert.throws(() => clientPerformanceTraceSpans({ events: [event] }, { now: 2000 }), /timing/u);
});

test("runtime sampler reuses bounded numeric health counters and stops its timer", () => {
  const events = []; let callback; let cleared = false;
  const sampler = createRuntimePerformanceSampler({ instanceId: "instance-1",
    trace: { recordBestEffort: (span) => events.push(span), backpressureStats: () => ({ droppedSpans: 3 }) },
    readHealth: () => ({ diagnostics: { process: { rssBytes: 99, eventLoopDelayMaxMs: 80 },
      store: { pending: 2, error: "private", path: "secret" } } }),
    setIntervalImpl: (fn) => { callback = fn; return { unref() {} }; }, clearIntervalImpl: () => { cleared = true; } });
  sampler.start(); callback(); sampler.stop();
  assert.equal(cleared, true); assert.equal(events.length, 1);
  assert.equal(events[0].metadata.metrics["trace.droppedSpans"], 3);
  assert.equal(events[0].metadata.metrics["store.error"], undefined);
  assert.equal(events[0].metadata.metrics["process.eventLoopDelayMaxMs"], 80);
});
