import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { CommandTraceSpanStore } from "../../../src/infrastructure/persistence/command-trace-span-store.mjs";

function span({ spanId, commandId = "command-1", stage, duration, observedAtMs }) {
  return {
    spanId,
    commandId,
    stage,
    outcome: "succeeded",
    transport: "desktop",
    observedAtMs,
    monotonicDurationMs: duration,
    metadata: { source: "test" },
  };
}

test("command trace store is append-only, idempotent and returns ordered timelines", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-command-trace-"));
  const databaseFile = path.join(directory, "command-traces.sqlite");
  const store = new CommandTraceSpanStore({ databaseFile, clock: () => 10_000 });
  context.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.deepEqual(await store.append(span({
    spanId: "span-2",
    stage: "client-ack",
    duration: 20,
    observedAtMs: 9_200,
  })), { appended: 1, duplicate: false, pruned: 0 });
  await store.append(span({
    spanId: "span-1",
    stage: "hub-receive",
    duration: 10,
    observedAtMs: 9_100,
  }));
  assert.deepEqual(await store.append(span({
    spanId: "span-1",
    stage: "hub-receive",
    duration: 99,
    observedAtMs: 9_900,
  })), { appended: 0, duplicate: true, pruned: 0 });

  const timeline = await store.readCommandTimeline("command-1");
  assert.deepEqual(timeline.map((item) => [item.spanId, item.stage, item.monotonicDurationMs]), [
    ["span-1", "hub-receive", 10],
    ["span-2", "client-ack", 20],
  ]);
  assert.deepEqual(timeline[0].metadata, { source: "test" });

  await store.close();
  const database = new DatabaseSync(databaseFile);
  assert.throws(
    () => database.prepare("UPDATE command_trace_spans SET outcome = ? WHERE span_id = ?").run("failed", "span-1"),
    /append-only/u,
  );
  database.close();
});

test("command trace store calculates nearest-rank stage percentiles", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-command-trace-percentile-"));
  const store = new CommandTraceSpanStore({
    databaseFile: path.join(directory, "command-traces.sqlite"),
    clock: () => 10_000,
  });
  context.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  await store.appendMany([10, 20, 30, 40].map((duration, index) => span({
    spanId: `span-${index}`,
    stage: "durable-intake-commit",
    duration,
    observedAtMs: 9_000 + index,
  })));
  const [summary] = await store.readStagePercentiles({
    stage: "durable-intake-commit",
    percentiles: [0.5, 0.95, 0.99],
  });

  assert.deepEqual(summary, {
    stage: "durable-intake-commit",
    sampleCount: 4,
    minMs: 10,
    maxMs: 40,
    percentiles: [
      { quantile: 0.5, durationMs: 20 },
      { quantile: 0.95, durationMs: 40 },
      { quantile: 0.99, durationMs: 40 },
    ],
  });
});

test("command trace store enforces age and row-count retention", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-command-trace-retention-"));
  const store = new CommandTraceSpanStore({
    databaseFile: path.join(directory, "command-traces.sqlite"),
    retentionMs: 1_000,
    maxSpans: 3,
    clock: () => 10_000,
  });
  context.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const result = await store.appendMany([
    span({ spanId: "expired", stage: "hub-receive", duration: 1, observedAtMs: 8_999 }),
    ...[0, 1, 2, 3].map((index) => span({
      spanId: `current-${index}`,
      stage: "client-ack",
      duration: index,
      observedAtMs: 9_500 + index,
    })),
  ]);
  assert.deepEqual(result, { appended: 5, duplicates: 0, pruned: 2 });
  assert.deepEqual(
    (await store.readCommandTimeline("command-1")).map((item) => item.spanId),
    ["current-1", "current-2", "current-3"],
  );
});
