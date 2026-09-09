import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";

import { RateLimitHistoryStore } from "../../../src/infrastructure/persistence/rate-limit-history.mjs";
import { WorkLogUsageSyncStore } from "../../../src/infrastructure/persistence/work-log-usage-sync-store.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-usage-limit-contention-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const usage = new WorkLogUsageSyncStore({ databaseFile, deviceId: "local-device" });
  const limits = new RateLimitHistoryStore({
    databaseFile, rawFile: path.join(root, "limits.jsonl"), csvFile: path.join(root, "limits.csv"),
  });
  await usage.events();
  await limits.read();
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0");
  t.after(async () => {
    blocker.close();
    await usage.close();
    await limits.close();
    await rm(root, { recursive: true, force: true });
  });
  return { usage, limits, blocker };
}

test("usage and rate-limit writes yield under the same WAL writer and retain original deduplication identities", async (t) => {
  const { usage, limits, blocker } = await fixture(t);
  const snapshot = { events: [{
    deviceId: "remote", provider: "codex", threadId: "thread-1", turnId: "turn-1",
    completedAt: "2026-09-10T00:00:00.000Z", usage: { totalTokens: 42 },
  }] };
  const response = { rateLimits: { limitId: "codex", primary: { usedPercent: 20 } } };
  blocker.exec("BEGIN IMMEDIATE");
  const imported = usage.importSnapshot(snapshot);
  const recorded = limits.record(response, "2026-09-10T00:00:00.000Z");
  await delay(35);
  assert.equal(blocker.prepare("SELECT COUNT(*) AS count FROM usage_sync_events").get().count, 0);
  assert.equal(blocker.prepare("SELECT COUNT(*) AS count FROM rate_limit_snapshots").get().count, 0);
  blocker.exec("COMMIT");
  assert.equal((await imported).added, 1);
  assert.equal((await recorded).recorded, true);
  const [original] = await usage.events();
  assert.ok(original.eventId);
  assert.equal((await usage.importSnapshot(snapshot)).added, 0);
  assert.equal((await limits.record(response, "2026-09-10T00:00:00.000Z")).recorded, false);
  assert.equal((await usage.events())[0].eventId, original.eventId);
  assert.equal(blocker.prepare("SELECT COUNT(*) AS count FROM usage_sync_events").get().count, 1);
  assert.equal(blocker.prepare("SELECT COUNT(*) AS count FROM rate_limit_snapshots").get().count, 1);
});
