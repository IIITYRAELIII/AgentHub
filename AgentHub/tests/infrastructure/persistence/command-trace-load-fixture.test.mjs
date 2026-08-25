import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CommandTraceSpanStore } from "../../../src/infrastructure/persistence/command-trace-span-store.mjs";
import { createCommandTraceLoadFixture } from "../../fixtures/command-trace-load-fixture.mjs";

test("command trace load fixture remains bounded and queryable by stage", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-command-trace-load-"));
  const startAtMs = 1_787_680_000_000;
  const store = new CommandTraceSpanStore({
    databaseFile: path.join(directory, "command-traces.sqlite"),
    retentionMs: 24 * 60 * 60 * 1_000,
    maxSpans: 1_500,
    clock: () => startAtMs + 100_000,
  });
  context.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  const result = await store.appendMany(createCommandTraceLoadFixture({
    commandCount: 100,
    startAtMs,
  }));
  assert.deepEqual(result, { appended: 1_800, duplicates: 0, pruned: 300 });

  const summaries = await store.readStagePercentiles({
    stage: "client-ack",
    transport: "desktop",
    percentiles: [0.5, 0.95, 0.99],
  });
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].stage, "client-ack");
  assert.equal(summaries[0].sampleCount > 0, true);
  assert.equal(summaries[0].percentiles[1].durationMs <= summaries[0].maxMs, true);
});
