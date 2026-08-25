import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createCommandTraceComposition } from "../../src/composition/command-trace-composition.mjs";

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
