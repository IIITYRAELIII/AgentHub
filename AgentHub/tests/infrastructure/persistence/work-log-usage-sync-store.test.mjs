import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { WorkLogUsageSyncStore } from "../../../src/infrastructure/persistence/work-log-usage-sync-store.mjs";

test("usage sync SQLite store imports snapshots through a deduplicating cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  let store = null;
  try {
    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    const first = await store.importSnapshot({
      events: [{
        deviceId: "remote",
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        completedAt: "2026-08-20T00:00:00.000Z",
        estimatedCredits: 4,
        accountKey: "chatgpt:owner",
        accountLabel: "owner@example.com",
        accountType: "chatgpt",
        accountPlan: "plus",
        deviceLabel: "teammate",
      }],
    });
    const second = await store.importSnapshot(await store.events());

    assert.equal(first.added, 1);
    assert.equal(second.added, 0);
    const events = await store.events();
    assert.equal(events.length, 1);
    assert.equal(events[0].deviceId, "remote");
    assert.equal(events[0].deviceLabel, "teammate");
    assert.equal(events[0].accountLabel, "owner@example.com");
    assert.equal(events[0].accountType, "chatgpt");
    assert.equal(events[0].accountPlan, "plus");
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage sync SQLite store imports and archives the retired JSON cache", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  const legacyFile = path.join(root, "sync.json");
  let store = null;
  try {
    await writeFile(legacyFile, JSON.stringify({
      events: [{
        deviceId: "remote",
        provider: "codex",
        threadId: "thread-legacy",
        turnId: "turn-legacy",
        completedAt: "2026-08-20T00:00:00.000Z",
        estimatedCredits: 4,
      }],
    }), "utf8");
    store = new WorkLogUsageSyncStore({ databaseFile, legacyFile, deviceId: "device-local" });
    const events = await store.events();
    assert.equal(events.length, 1);
    assert.equal(events[0].deviceId, "remote");
    assert.equal(events[0].estimatedCredits, 4);
    await assert.rejects(readFile(legacyFile, "utf8"), { code: "ENOENT" });
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("adopting a superseded device id re-homes local events without duplicating turns", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  const turn = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    completedAt: "2026-08-20T00:00:00.000Z",
    estimatedCredits: 4,
    accountKey: "chatgpt:owner",
  };
  let legacy = null;
  let adopted = null;
  try {
    legacy = new WorkLogUsageSyncStore({
      databaseFile,
      deviceId: "agent-hub:0123456789abcdef",
    });
    await legacy.importSnapshot({
      events: [
        { ...turn, deviceId: "agent-hub:0123456789abcdef" },
        { ...turn, turnId: "turn-2", deviceId: "remote" },
      ],
    });

    const [legacyEvent] = (await legacy.events())
      .filter((event) => event.deviceId === "agent-hub:0123456789abcdef");
    const legacyEventId = legacyEvent.eventId;
    await legacy.close();
    legacy = null;

    adopted = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-uuid" });
    const result = await adopted.adoptDeviceIds(["agent-hub:0123456789abcdef"]);
    assert.equal(result.migrated, 1);

    const events = await adopted.events();
    assert.deepEqual(events.map((event) => event.deviceId).sort(), ["device-uuid", "remote"]);
    const local = events.find((event) => event.deviceId === "device-uuid");
    assert.equal(local.eventId, legacyEventId, "the turn identity survives the move");

    const repeated = await adopted.adoptDeviceIds(["agent-hub:0123456789abcdef"]);
    assert.equal(repeated.migrated, 0, "adoption is idempotent");
    assert.equal((await adopted.events()).length, 2);
  } finally {
    await legacy?.close();
    await adopted?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the same turn recorded under two device ids is counted once", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  const turn = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    completedAt: "2026-08-20T00:00:00.000Z",
    estimatedCredits: 4,
  };
  let store = null;
  try {
    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-uuid" });
    await store.importSnapshot({
      events: [
        { ...turn, deviceId: "agent-hub:0123456789abcdef" },
        { ...turn, deviceId: "device-uuid", accountKey: "chatgpt:owner" },
      ],
    });
    const events = await store.events();
    assert.equal(events.length, 1, "the same turn must not be counted twice");
    assert.equal(events[0].accountKey, "chatgpt:owner", "the stronger attribution wins");
    assert.equal(events[0].deviceId, "device-uuid");

    const result = await store.adoptDeviceIds(["agent-hub:0123456789abcdef"]);
    assert.equal(result.migrated, 0, "there is nothing left to re-home");
    assert.equal((await store.events()).length, 1);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
