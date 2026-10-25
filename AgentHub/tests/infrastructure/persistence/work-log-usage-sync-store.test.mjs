import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { detectIdentityCollisions } from "../../../src/domain/usage-facts.mjs";
import { WorkLogUsageSyncStore } from "../../../src/infrastructure/persistence/work-log-usage-sync-store.mjs";

test("usage sync SQLite store clears legacy inferred account fields on open", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  let database = null;
  let store = null;
  try {
    database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TABLE usage_sync_events (
        event_id TEXT PRIMARY KEY,
        device_id TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'sync',
        provider TEXT NOT NULL,
        thread_key TEXT NOT NULL,
        task_key TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        completed_ms INTEGER NOT NULL,
        started_at TEXT NOT NULL DEFAULT '',
        account_key TEXT NOT NULL DEFAULT '',
        account_label TEXT NOT NULL DEFAULT '',
        account_type TEXT NOT NULL DEFAULT '',
        account_plan TEXT NOT NULL DEFAULT '',
        account_attribution TEXT NOT NULL DEFAULT 'inferred',
        estimated_credits REAL NOT NULL DEFAULT 0,
        estimate_kind TEXT NOT NULL DEFAULT '',
        image_generation_count INTEGER NOT NULL DEFAULT 0,
        context_probe INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        reasoning_output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        usage_reported INTEGER NOT NULL DEFAULT 1,
        model TEXT NOT NULL DEFAULT '',
        service_tier TEXT NOT NULL DEFAULT '',
        device_label TEXT NOT NULL DEFAULT '',
        observed_at TEXT NOT NULL
      ) WITHOUT ROWID
    `);
    database.prepare(`
      INSERT INTO usage_sync_events (
        event_id, device_id, provider, thread_key, task_key, completed_at, completed_ms,
        account_key, account_label, account_type, account_plan, account_attribution,
        estimated_credits, total_tokens, model, device_label, observed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      `usage:${"a".repeat(64)}`,
      "remote-device",
      "codex",
      "b".repeat(64),
      "c".repeat(64),
      "2026-08-31T07:27:16.605Z",
      Date.parse("2026-08-31T07:27:16.605Z"),
      "chatgpt:baseus",
      "account-3@example.invalid",
      "chatgpt",
      "pro",
      "inferred",
      12,
      1200,
      "gpt-5.6-sol",
      "Nikita",
      "2026-08-31T07:27:16.605Z",
    );
    database.exec("UPDATE usage_sync_events SET context_probe = 1");
    database.close();
    database = null;

    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    const [event] = await store.events();
    assert.ok(!Object.hasOwn(event, "accountKey"));
    assert.ok(!Object.hasOwn(event, "accountLabel"));
    assert.ok(!Object.hasOwn(event, "accountAttribution"));
    assert.equal(event.contextProbe, undefined);
    await store.importSnapshot({ events: [{ ...event, estimatedCredits: 13 }] });
    await store.close();
    store = null;

    database = new DatabaseSync(databaseFile);
    assert.equal(database.prepare("SELECT context_probe FROM usage_sync_events").get().context_probe, 1);
    const row = database.prepare(`
      SELECT account_key, account_label, account_type, account_plan, account_attribution
      FROM usage_sync_events
    `).get();
    assert.deepEqual({ ...row }, {
      account_key: "",
      account_label: "",
      account_type: "",
      account_plan: "",
      account_attribution: "inferred",
    });
  } finally {
    database?.close();
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
        estimateKind: "imagegen-default",
        imageGenerationCount: 2,
        contextProbe: true,
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
    assert.ok(!Object.hasOwn(events[0], "accountLabel"));
    assert.ok(!Object.hasOwn(events[0], "accountType"));
    assert.ok(!Object.hasOwn(events[0], "accountPlan"));
    assert.equal(events[0].estimateKind, "imagegen-default");
    assert.equal(events[0].imageGenerationCount, 2);
    assert.equal(events[0].contextProbe, undefined);
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
    assert.ok(!Object.hasOwn(events[0], "accountKey"), "legacy account attribution is not retained");
    assert.equal(events[0].deviceId, "device-uuid");

    const result = await store.adoptDeviceIds(["agent-hub:0123456789abcdef"]);
    assert.equal(result.migrated, 0, "there is nothing left to re-home");
    assert.equal((await store.events()).length, 1);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage sync SQLite store preserves schema 2 mixed facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  const runtimeHomeId = "1".repeat(64);
  let store = null;
  try {
    store = new WorkLogUsageSyncStore({
      databaseFile,
      deviceId: "device-local",
      defaultRuntimeHomeIds: { codex: runtimeHomeId },
    });
    const turn = {
      schemaVersion: 2,
      type: "turn",
      eventId: `usage:${"a".repeat(64)}`,
      deviceId: "device-local",
      provider: "codex",
      runtimeHomeId,
      threadKey: "b".repeat(64),
      taskKey: "c".repeat(64),
      startedAt: "2026-08-20T00:59:00.000Z",
      completedAt: "2026-08-20T01:00:00.000Z",
      observedAt: "2026-08-20T01:00:01.000Z",
      model: "gpt-6.1-sol",
      usage: {
        inputTokens: 300_000, cachedInputTokens: 100_000, cacheWriteInputTokens: 50_000,
        outputTokens: 20_000, reasoningOutputTokens: 5_000, totalTokens: 320_000,
        longContextInputTokens: 300_000, longContextCachedInputTokens: 100_000,
        longContextCacheWriteInputTokens: 50_000, longContextOutputTokens: 20_000,
        longContextReasoningOutputTokens: 5_000,
      },
      limitSamples: [
        { observedAt: "2026-08-20T00:59:10.000Z", limitId: "codex", window: "primary", usedPercent: 10 },
        { observedAt: "2026-08-20T00:59:10.000Z", limitId: "codex", window: "secondary", usedPercent: 50 },
      ],
    };
    const auth = {
      schemaVersion: 2,
      type: "auth_observation",
      observationId: `auth:${"d".repeat(64)}`,
      deviceId: "device-local",
      installationInstanceId: "11111111-2222-4333-8444-555555555555",
      provider: "codex",
      runtimeHomeId,
      accountKey: "chatgpt:owner",
      observedAt: "2026-08-20T00:58:00.000Z",
      evidenceSource: "account-read",
      authFingerprint: "fingerprint",
    };
    const limit = {
      schemaVersion: 2,
      type: "limit_observation",
      observationId: `limit:${"e".repeat(64)}`,
      deviceId: "device-local",
      provider: "codex",
      accountKey: "chatgpt:owner",
      limitId: "codex",
      window: "primary",
      usedPercent: 11,
      observedAt: "2026-08-20T01:05:00.000Z",
    };

    const imported = await store.importSnapshot({ events: [turn, auth, limit] });
    assert.equal(imported.added, 3);
    assert.equal(imported.before, 0);
    assert.equal(imported.after, 3);
    assert.equal((await store.events()).length, 1);
    const facts = await store.facts();
    assert.deepEqual(facts.map((fact) => fact.type).sort(), [
      "auth_observation",
      "limit_observation",
      "turn",
    ]);
    const snapshot = await store.usageSyncSnapshot();
    assert.equal(snapshot.events.length, 3);
    const exportedTurn = snapshot.events.find((fact) => fact.type === "turn");
    assert.deepEqual(exportedTurn.limitSamples.map((sample) => sample.window), ["primary", "secondary"]);
    assert.deepEqual(exportedTurn.usage, turn.usage);
    assert.ok(!Object.hasOwn(exportedTurn, "accountKey"));
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage sync SQLite store merges persisted and incoming limit samples", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  const runtimeHomeId = "1".repeat(64);
  let store = null;
  try {
    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    const turn = {
      schemaVersion: 2,
      type: "turn",
      eventId: `usage:${"a".repeat(64)}`,
      deviceId: "device-local",
      provider: "codex",
      runtimeHomeId,
      threadKey: "b".repeat(64),
      taskKey: "c".repeat(64),
      startedAt: "2026-08-20T00:59:00.000Z",
      completedAt: "2026-08-20T01:00:00.000Z",
      observedAt: "2026-08-20T01:00:01.000Z",
    };

    const first = await store.importSnapshot({
      events: [{
        ...turn,
        limitSamples: [
          { observedAt: "2026-08-20T00:59:10.000Z", limitId: "codex", window: "primary", usedPercent: 10 },
        ],
      }],
    });
    const second = await store.importSnapshot({
      events: [{
        ...turn,
        limitSamples: [
          { observedAt: "2026-08-20T00:59:11.000Z", limitId: "codex", window: "secondary", usedPercent: 50 },
        ],
      }],
    });

    assert.equal(first.added, 1);
    assert.equal(second.updated, 1);
    const [event] = await store.events();
    assert.deepEqual(event.limitSamples.map((sample) => sample.window), ["primary", "secondary"]);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage sync SQLite store preserves identity-collision auth observations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  const runtimeHomeId = "1".repeat(64);
  const firstInstallation = "11111111-2222-4333-8444-555555555555";
  const secondInstallation = "22222222-3333-4333-8444-666666666666";
  let store = null;
  try {
    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    const base = {
      schemaVersion: 2,
      type: "auth_observation",
      deviceId: "device-a",
      provider: "codex",
      runtimeHomeId,
      accountKey: "chatgpt:owner",
      observedAt: "2026-08-20T01:00:00.000Z",
    };

    const imported = await store.importSnapshot({
      events: [
        { ...base, installationInstanceId: firstInstallation },
        { ...base, installationInstanceId: secondInstallation },
      ],
    });

    assert.equal(imported.added, 2);
    assert.equal(imported.after, 2);
    const facts = await store.facts();
    assert.equal(facts.length, 2);
    assert.deepEqual(facts.map((fact) => fact.installationInstanceId).sort(), [
      firstInstallation,
      secondInstallation,
    ]);
    assert.deepEqual(detectIdentityCollisions(facts), [{
      deviceId: "device-a",
      installationInstanceIds: [firstInstallation, secondInstallation],
      reason: "identity-collision",
    }]);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage sync SQLite store canonicalizes stale limit observation ids", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  let store = null;
  try {
    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    const staleId = `limit:${"0".repeat(64)}`;
    const base = {
      schemaVersion: 2,
      type: "limit_observation",
      observationId: staleId,
      deviceId: "device-a",
      provider: "codex",
      accountKey: "chatgpt:owner",
      limitId: "codex",
      usedPercent: 10,
      observedAt: "2026-08-20T01:00:00.000Z",
    };

    const imported = await store.importSnapshot({
      events: [
        { ...base, window: "primary" },
        { ...base, window: "secondary" },
      ],
    });

    assert.equal(imported.added, 2);
    assert.equal(imported.after, 2);
    const facts = (await store.facts()).filter((fact) => fact.type === "limit_observation");
    assert.equal(facts.length, 2);
    assert.deepEqual(facts.map((fact) => fact.window).sort(), ["primary", "secondary"]);
    assert.equal(facts.some((fact) => fact.observationId === staleId), false);
    assert.equal(new Set(facts.map((fact) => fact.observationId)).size, 2);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage sync SQLite store keeps generation stable and summarizes facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  let store = null;
  try {
    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    const empty = await store.usageSyncState();
    assert.ok(empty.localStoreGeneration);
    assert.equal(empty.factSummary.count, 0);

    await store.importSnapshot({
      events: [{
        deviceId: "remote",
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-1",
        completedAt: "2026-08-20T00:00:00.000Z",
      }],
    });
    const populated = await store.usageSyncState();
    assert.equal(populated.localStoreGeneration, empty.localStoreGeneration);
    assert.equal(populated.factSummary.count, 1);
    assert.equal(populated.factSummary.byType.turn, 1);
    assert.match(populated.factSummary.digest, /^sha256:[0-9a-f]{64}$/u);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage sync SQLite store reconciles remote cache without dropping local unsent facts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  let store = null;
  try {
    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    await store.importSnapshot({
      events: [{
        deviceId: "device-local",
        provider: "codex",
        threadId: "local-thread",
        turnId: "local-turn",
        completedAt: "2026-08-20T00:00:00.000Z",
      }, {
        deviceId: "remote-old",
        provider: "codex",
        threadId: "old-thread",
        turnId: "old-turn",
        completedAt: "2026-08-20T00:01:00.000Z",
      }],
    });

    const result = await store.reconcileSnapshot({
      events: [{
        deviceId: "remote-new",
        provider: "codex",
        threadId: "new-thread",
        turnId: "new-turn",
        completedAt: "2026-08-20T00:02:00.000Z",
      }],
    });

    assert.equal(result.reconciled, true);
    assert.equal(result.added, 1);
    assert.equal(result.pruned, 1);
    const events = await store.events();
    assert.deepEqual(events.map((event) => event.deviceId).sort(), ["device-local", "remote-new"]);
  } finally {
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("usage sync SQLite store rolls back the whole reconcile when prune fails", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-sync-"));
  const databaseFile = path.join(root, "sync.sqlite");
  let store = null;
  let database = null;
  try {
    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    await store.importSnapshot({
      events: [{
        deviceId: "device-local",
        provider: "codex",
        threadId: "local-thread",
        turnId: "local-turn",
        completedAt: "2026-08-20T00:00:00.000Z",
      }, {
        deviceId: "remote-old",
        provider: "codex",
        threadId: "old-thread",
        turnId: "old-turn",
        completedAt: "2026-08-20T00:01:00.000Z",
      }],
    });
    await store.close();
    store = null;

    database = new DatabaseSync(databaseFile);
    database.exec(`
      CREATE TRIGGER fail_remote_prune
      BEFORE DELETE ON usage_sync_events
      WHEN OLD.device_id <> 'device-local'
      BEGIN
        SELECT RAISE(ABORT, 'fault-injected prune failure');
      END;
    `);
    database.close();
    database = null;

    store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
    await assert.rejects(
      store.reconcileSnapshot({
        events: [{
          deviceId: "remote-new",
          provider: "codex",
          threadId: "new-thread",
          turnId: "new-turn",
          completedAt: "2026-08-20T00:02:00.000Z",
        }],
      }),
      /fault-injected prune failure/u,
    );

    const events = await store.events();
    assert.deepEqual(events.map((event) => event.deviceId).sort(), ["device-local", "remote-old"]);
  } finally {
    database?.close();
    await store?.close();
    await rm(root, { recursive: true, force: true });
  }
});
