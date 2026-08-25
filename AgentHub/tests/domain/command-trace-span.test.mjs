import assert from "node:assert/strict";
import test from "node:test";

import {
  COMMAND_TRACE_STAGES,
  normalizeCommandTraceSpan,
} from "../../src/domain/command-trace-span.mjs";

test("command trace spans preserve epoch time, monotonic duration and bounded metadata", () => {
  const metadata = { clientUserMessageId: "message-1", nested: { retry: 0 } };
  const span = normalizeCommandTraceSpan({
    commandId: "command-1",
    stage: COMMAND_TRACE_STAGES.DURABLE_INTAKE_COMMIT,
    outcome: "succeeded",
    transport: "desktop",
    observedAtMs: 1_787_680_000_000,
    monotonicDurationMs: 12.75,
    queueDepth: 2,
    lockWaitMs: 3.5,
    sqliteBusyWaitMs: 4.25,
    metadata,
  }, { createSpanId: () => "span-1" });

  metadata.nested.retry = 9;
  assert.deepEqual(span, {
    spanId: "span-1",
    commandId: "command-1",
    stage: "durable-intake-commit",
    outcome: "succeeded",
    transport: "desktop",
    observedAtMs: 1_787_680_000_000,
    monotonicDurationMs: 12.75,
    queueDepth: 2,
    lockWaitMs: 3.5,
    sqliteBusyWaitMs: 4.25,
    metadata: { clientUserMessageId: "message-1", nested: { retry: 0 } },
  });
  assert.equal(Object.isFrozen(span), true);
  assert.equal(Object.isFrozen(span.metadata), true);
});

test("command trace spans reject ambiguous timestamps and invalid measurements", () => {
  const base = {
    commandId: "command-1",
    stage: "hub-receive",
    outcome: "succeeded",
    transport: "desktop",
  };
  assert.throws(() => normalizeCommandTraceSpan({ ...base, observedAtMs: "now" }), /observedAtMs/u);
  assert.throws(() => normalizeCommandTraceSpan({ ...base, monotonicDurationMs: -1 }), /monotonicDurationMs/u);
  assert.throws(() => normalizeCommandTraceSpan({ ...base, queueDepth: 1.5 }), /queueDepth/u);
  assert.throws(() => normalizeCommandTraceSpan({ ...base, stage: "Hub Receive" }), /stage/u);
  assert.throws(() => normalizeCommandTraceSpan({ ...base, metadata: [] }), /metadata/u);
});
