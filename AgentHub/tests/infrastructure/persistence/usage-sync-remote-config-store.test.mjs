import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { UsageSyncRemoteConfigStore } from "../../../src/infrastructure/persistence/usage-sync-remote-config-store.mjs";

async function temporaryRoot() {
  return mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-remote-config-"));
}

test("remote config stores server enrollment state without secrets", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-remote.json");
  try {
    const store = new UsageSyncRemoteConfigStore({
      file,
      now: () => new Date("2026-08-20T04:00:00.000Z"),
    });
    const enrolled = await store.rememberEnrollment({
      serverUrl: "https://sync.example.test/?token=not-stored#x",
      deviceId: "device-a",
      result: { ok: true },
    });

    assert.equal(enrolled.serverUrl, "https://sync.example.test");
    assert.equal(enrolled.enrolledAt, "2026-08-20T04:00:00.000Z");
    assert.ok(!JSON.stringify(enrolled).includes("token=not-stored"));

    const reloaded = new UsageSyncRemoteConfigStore({ file });
    assert.deepEqual(await reloaded.load(), enrolled);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote config exposes default server URL without marking enrollment", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-remote.json");
  try {
    const store = new UsageSyncRemoteConfigStore({
      file,
      defaultServerUrl: "https://sync.example.test/default?ignored=1#x",
    });
    const state = await store.load();

    assert.equal(state.serverUrl, "https://sync.example.test/default");
    assert.equal(state.deviceId, "");
    assert.equal(state.enrolledAt, "");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("remote config records push and pull timestamps", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-remote.json");
  try {
    const store = new UsageSyncRemoteConfigStore({
      file,
      now: () => new Date("2026-08-20T04:01:00.000Z"),
    });
    await store.rememberPush({ ok: true, added: 1 });
    await store.rememberPush({ ok: true, added: 2 }, { usageWatermark: "2026-08-20T04:00:30.000Z" });
    const pulled = await store.rememberPull(
      { imported: true, added: 1 },
      { serverRevision: 42 },
    );

    assert.equal(pulled.lastPushAt, "2026-08-20T04:01:00.000Z");
    assert.equal(pulled.lastPullAt, "2026-08-20T04:01:00.000Z");
    assert.equal(pulled.lastUsagePushWatermark, "2026-08-20T04:00:30.000Z");
    assert.equal(pulled.lastUsagePullRevision, 42);
    assert.deepEqual(pulled.lastResult, { imported: true, added: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
