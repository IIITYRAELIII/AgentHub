import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProviderTurnTelemetryStore } from "../../../src/infrastructure/persistence/provider-turn-telemetry-store.mjs";

test("provider turn telemetry is upserted once and remains queryable", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-turn-telemetry-"));
  const store = new ProviderTurnTelemetryStore({ databaseFile: path.join(directory, "journal.sqlite") });
  context.after(async () => {
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });

  await store.upsert({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    streamId: "stream-1",
    startedAtMs: 100,
    completedAtMs: 500,
    maxEventGapMs: 250,
    compaction: { count: 1, totalMs: 80, maxMs: 80 },
    timeline: [{ atMs: 100, type: "phase", phase: "starting" }],
  });
  await store.upsert({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    streamId: "stream-1",
    startedAtMs: 100,
    completedAtMs: 600,
    maxEventGapMs: 300,
    compaction: { count: 1, totalMs: 80, maxMs: 80 },
    timeline: [{ atMs: 600, type: "completed", phase: "completed" }],
  });

  const rows = await store.recent({ provider: "codex", threadId: "thread-1" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].completedAtMs, 600);
  assert.equal(rows[0].timeline[0].type, "completed");
});
