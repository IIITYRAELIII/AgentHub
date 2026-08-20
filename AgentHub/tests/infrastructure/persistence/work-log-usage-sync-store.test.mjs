import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkLogUsageSyncStore } from "../../../src/infrastructure/persistence/work-log-usage-sync-store.mjs";

test("usage sync JSON store imports snapshots through a deduplicating file cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const file = path.join(root, "sync.json");
  try {
    const store = new WorkLogUsageSyncStore({ file, deviceId: "device-local" });
    const first = await store.importSnapshot({
      events: [{
        deviceId: "remote",
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        completedAt: "2026-08-20T00:00:00.000Z",
        estimatedCredits: 4,
        accountKey: "chatgpt:owner",
      }],
    });
    const second = await store.importSnapshot(JSON.parse(await readFile(file, "utf8")));

    assert.equal(first.added, 1);
    assert.equal(second.added, 0);
    assert.equal((await store.events()).length, 1);
    const written = JSON.parse(await readFile(file, "utf8"));
    assert.equal(written.deviceId, "device-local");
    assert.equal(written.events[0].deviceId, "remote");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
