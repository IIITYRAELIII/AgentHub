import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

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

test("telemetry retries a busy writer asynchronously and keeps the same turn identity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-telemetry-contention-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const store = new ProviderTurnTelemetryStore({ databaseFile });
  await store.initialize();
  const blocker = new DatabaseSync(databaseFile);
  t.after(async () => {
    blocker.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  blocker.exec("BEGIN IMMEDIATE");
  let timerRan = false;
  const startedAt = performance.now();
  const identity = { provider: "codex", threadId: "thread-1", turnId: "turn-1" };
  const pending = store.upsert({ ...identity, completedAtMs: 100 });
  setTimeout(() => { timerRan = true; blocker.exec("COMMIT"); }, 30);
  assert.deepEqual(await pending, { upserted: 1 });
  assert.equal(timerRan, true);
  assert.ok(performance.now() - startedAt < 1_000, "SQLite contention must yield to runtime timers");
  await store.upsert({ ...identity, completedAtMs: 200 });
  const rows = await store.recent(identity);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].completedAtMs, 200);
});

test("telemetry initialization retries schema creation and a failed deadline does not poison its handle", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-telemetry-init-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA journal_mode = WAL; CREATE TABLE unrelated (id INTEGER); BEGIN IMMEDIATE");
  const store = new ProviderTurnTelemetryStore({ databaseFile, mutationTimeoutMs: 30 });
  t.after(async () => {
    blocker.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await assert.rejects(store.initialize(), /database is locked/u);
  blocker.exec("COMMIT");
  await store.initialize();
  await store.upsert({ provider: "codex", threadId: "thread-1", turnId: "turn-1" });
  assert.equal((await store.recent()).length, 1);
});
