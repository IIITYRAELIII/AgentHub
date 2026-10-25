import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("explicit server setting preserves synchronization cursors and does not rewrite enrollment on load", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-explicit-sync-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "remote.json");
  const old = { serverUrl: "https://old.example.invalid", deviceId: "device-1", enrolledAt: "2026-01-01T00:00:00Z",
    lastUsagePushJournalRevision: 7, lastUsagePullRevision: 9, lastUsagePullServerGeneration: "server-1" };
  await writeFile(file, JSON.stringify(old));
  const originalBytes = await readFile(file);
  const store = new UsageSyncRemoteConfigStore({ file, configuredServerUrl: "https://new.example.invalid" });
  const loaded = await store.load();
  assert.equal(loaded.serverUrl, "https://new.example.invalid");
  for (const key of Object.keys(old).filter(key => key !== "serverUrl")) assert.equal(loaded[key], old[key]);
  assert.deepEqual(await readFile(file), originalBytes);
  await assert.rejects(store.rememberEnrollment({ serverUrl: "https://old.example.invalid", deviceId: "other" }), /configured server/u);
  assert.deepEqual(await readFile(file), originalBytes);
  await store.rememberPush({ ok: true }, { usageJournalRevision: 8 });
  assert.equal((await store.load()).lastUsagePullRevision, 9);
  assert.equal((await store.load()).lastUsagePushJournalRevision, 8);
  const disabled = new UsageSyncRemoteConfigStore({ file, configuredServerUrl: "", defaultServerUrl: "https://fallback.example.invalid" });
  assert.equal((await disabled.load()).serverUrl, "");
});

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

test("remote config stores pull cursor generations and can replace a repaired cursor", async () => {
  const root = await temporaryRoot();
  const file = path.join(root, "usage-sync-remote.json");
  try {
    const store = new UsageSyncRemoteConfigStore({
      file,
      now: () => new Date("2026-09-07T15:30:00.000Z"),
    });
    await store.rememberPull(
      { imported: true },
      {
        serverRevision: 90,
        serverGeneration: "server-a",
        localGeneration: "local-a",
        factSummary: { version: 1, count: 3, digest: "sha256:" + "1".repeat(64) },
        antiEntropyAt: "2026-09-07T15:29:00.000Z",
      },
    );
    const repaired = await store.rememberPull(
      { imported: true, reconciled: true },
      {
        serverRevision: 12,
        serverGeneration: "server-b",
        localGeneration: "local-a",
        factSummary: { version: 1, count: 4, digest: "sha256:" + "2".repeat(64) },
        replaceCursor: true,
      },
    );

    assert.equal(repaired.version, 3);
    assert.equal(repaired.lastUsagePullRevision, 12);
    assert.equal(repaired.lastUsagePullServerGeneration, "server-b");
    assert.equal(repaired.lastUsagePullLocalGeneration, "local-a");
    assert.equal(repaired.lastUsagePullFactSummary.count, 4);
    assert.equal(repaired.lastUsageAntiEntropyAt, "2026-09-07T15:29:00.000Z");
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
    assert.equal(state.lastUsageHistoryResendVersion, 0);
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
    await store.rememberPush({ ok: true, added: 2 }, {
      usageWatermark: "2026-08-20T04:00:30.000Z",
      usageJournalRevision: 17,
      usageHistoryResendVersion: 1,
    });
    await store.rememberPush({ ok: true, added: 0 }, {
      usageHistoryResendVersion: 0,
    });
    const pulled = await store.rememberPull(
      { imported: true, added: 1 },
      { serverRevision: 42 },
    );

    assert.equal(pulled.lastPushAt, "2026-08-20T04:01:00.000Z");
    assert.equal(pulled.lastPullAt, "2026-08-20T04:01:00.000Z");
    assert.equal(pulled.lastUsagePushWatermark, "2026-08-20T04:00:30.000Z");
    assert.equal(pulled.lastUsagePushJournalRevision, 17);
    assert.equal(pulled.lastUsageHistoryResendVersion, 1);
    assert.equal(pulled.lastUsagePullRevision, 42);
    assert.deepEqual(pulled.lastResult, { imported: true, added: 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
