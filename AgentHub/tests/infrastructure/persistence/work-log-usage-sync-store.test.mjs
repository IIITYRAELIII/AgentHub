import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { detectIdentityCollisions } from "../../../src/domain/usage-facts.mjs";
import { WorkLogUsageSyncStore } from "../../../src/infrastructure/persistence/work-log-usage-sync-store.mjs";

async function observeJournalMaterialization(operation, { fail = null } = {}) {
  const prepare = DatabaseSync.prototype.prepare;
  const observations = [];
  DatabaseSync.prototype.prepare = function (...args) {
    const statement = Reflect.apply(prepare, this, args);
    return new Proxy(statement, { get(target, property) {
      if (property === "all") return (...parameters) => {
        const rows = Reflect.apply(target.all, target, parameters);
        for (const row of rows) if (typeof row.record_json === "string") {
          if (fail) throw fail;
          let keys = [];
          try { keys = Object.keys(JSON.parse(row.record_json)); } catch { /* Count malformed selected input too. */ }
          observations.push({ bytes: Buffer.byteLength(row.record_json), keys });
        }
        return rows;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  try { return { value: await operation(), observations }; }
  finally { DatabaseSync.prototype.prepare = prepare; }
}

test("usage input metrics count selected UTF8 strings without changing cursor or journal reads", async () => {
  const { JournalDatabase } = await import("../../../src/infrastructure/persistence/journal-database.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-input-metrics-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
  try {
    const record = turnId => ({ provider: "codex", threadId: "thread", turnId, projectRoot: root,
      completedAt: "2026-11-03T09:00:00.000Z", observedAt: "2026-11-03T09:01:00.000Z",
      model: "модель😀", body: "Private retained answer", diff: "Private retained diff", estimatedCredits: 2 });
    const initial = await journal.upsertRecords([record("a"), record("b")]);
    const before = await journal.loadLedger();
    const measure = async (payload, mode, count) => {
      const { value, observations } = await observeJournalMaterialization(() => store.usageSyncSnapshot(payload));
      assert.equal(value.selectedJournalRecords, count);
      assert.equal(value.materializedRecordJsonBytes, observations.reduce((sum, row) => sum + row.bytes, 0));
      assert.equal(value.journalSelectionMode, mode);
      return value;
    };
    const full = await measure({}, 0, 2);
    assert.equal(full.events.length, 2);
    const empty = await measure({ afterJournalRevision: initial.revision }, 1, 0);
    assert.equal(empty.events.length, 0);
    // Existing revision-backed selection ignores the legacy observed-at cursor.
    assert.deepEqual((await measure({ afterObservedAt: "2026-11-03T10:00:00.000Z", afterJournalRevision: -1 }, 0, 2)).events, full.events);
    await journal.upsertRecords([record("late")]);
    assert.equal((await measure({ afterJournalRevision: initial.revision }, 1, 1)).events.length, 1);
    assert.deepEqual((await store.journalTurns())["codex\0thread\0a"], before.turns["codex\0thread\0a"]);
    const failure = new Error("original metrics-source failure");
    await assert.rejects(observeJournalMaterialization(() => store.usageSyncSnapshot(), { fail: failure }), error => error === failure);
    assert.equal((await measure({}, 0, 3)).events.length, 3);
  } finally {
    await store.close(); await journal.close();
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test("usage input metrics classify legacy observed selection and unavailable journal without private cursors", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-input-metrics-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
  try {
    const absent = await store.usageSyncSnapshot();
    assert.equal(absent.selectedJournalRecords, 0);
    assert.equal(absent.materializedRecordJsonBytes, 0);
    assert.equal(absent.journalSelectionMode, 3);
    const database = new DatabaseSync(databaseFile);
    try {
      database.exec(`CREATE TABLE journal_records(provider TEXT,thread_id TEXT,turn_id TEXT,project_root TEXT,observed_at_ms INTEGER,record_json TEXT);
        CREATE TABLE journal_store_meta(key TEXT PRIMARY KEY,value TEXT);
        INSERT INTO journal_store_meta VALUES('revision','7')`);
      const insert = database.prepare("INSERT INTO journal_records VALUES(?,?,?,?,?,?)");
      for (const [turn, minute] of [["a", 0], ["b", 1]]) insert.run("codex", "thread", turn, root,
        Date.parse(`2026-11-03T09:0${minute}:00.000Z`), JSON.stringify({ provider: "codex", threadId: "thread", turnId: turn,
          completedAt: `2026-11-03T09:0${minute}:00.000Z`, observedAt: `2026-11-03T09:0${minute}:00.000Z`, model: "модель😀", body: "PRIVATE" }));
      insert.run("codex", "thread", "invalid", root, Date.parse("2026-11-03T09:02:00.000Z"), "not valid JSON");
    } finally { database.close(); }
    const full = await store.usageSyncSnapshot({ afterObservedAt: "private-invalid-cursor" });
    assert.equal(full.journalSelectionMode, 0);
    assert.equal(full.selectedJournalRecords, 3, "selected rows include invalid JSON that the existing converter skips");
    const { value, observations } = await observeJournalMaterialization(() => store.usageSyncSnapshot({ afterObservedAt: "2026-11-03T09:01:00.000Z" }));
    assert.equal(value.journalSelectionMode, 2);
    assert.equal(value.selectedJournalRecords, 2);
    assert.equal(value.materializedRecordJsonBytes, observations.reduce((sum, row) => sum + row.bytes, 0));
    assert.equal(value.events.length, 1);
    assert.equal(value.journalRevision, 7);
    assert.doesNotMatch(JSON.stringify({ selectedJournalRecords: value.selectedJournalRecords,
      materializedRecordJsonBytes: value.materializedRecordJsonBytes, journalSelectionMode: value.journalSelectionMode }), /PRIVATE|cursor|thread/);
    const nonText = new DatabaseSync(databaseFile);
    try { nonText.prepare("INSERT INTO journal_records VALUES(?,?,?,?,?,?)").run("codex", "thread", "blob", root, 0,
      new Uint8Array([255, 0])); }
    finally { nonText.close(); }
    const unknown = await store.usageSyncSnapshot();
    assert.equal(unknown.selectedJournalRecords, 4);
    assert.equal(unknown.materializedRecordJsonBytes, null, "non-text legacy input has unknown UTF8 string volume");
    assert.equal(unknown.events.length, full.events.length);
  } finally {
    await store.close();
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test("usage snapshots materialize only accounting input while retaining full journal content", async () => {
  const { JournalDatabase } = await import("../../../src/infrastructure/persistence/journal-database.mjs");
  const { usageSyncSnapshotFromLedger } = await import("../../../src/domain/work-log-usage-sync.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-materialization-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local",
    defaultRuntimeHomeIds: { codex: "1".repeat(64) } });
  try {
    const large = "Retained answer 😀\n".repeat(4000);
    const record = (turnId, legacy = false) => ({ provider: "codex", threadId: "thread", taskThreadId: "task", turnId,
      projectRoot: root, ...(legacy ? {} : { startedAt: "2026-10-31T09:59:00.000Z" }),
      completedAt: "2026-10-31T10:00:00.000Z", observedAt: "2026-10-31T10:01:00.000Z",
      usageReported: true, usage: { inputTokens: 21, cacheWriteInputTokens: 3, outputTokens: 5 },
      model: "gpt-6.1-sol", serviceTier: "fast", estimatedCredits: 2, imageGenerationCount: 1,
      estimateKind: "imagegen-default", body: large, text: large, prompt: large, diff: large,
      changedFiles: [large], skillsUsed: [large], mcpCalls: [large],
      limitSamples: [{ observedAt: "2026-10-31T10:00:00.000Z", limitId: "codex", window: "primary", usedPercent: 42 }],
    });
    const initial = await journal.upsertRecords([record("modern"), record("legacy", true)]);
    const original = await journal.loadLedger();
    const expected = usageSyncSnapshotFromLedger(original.turns, {
      deviceId: "device-local", deviceLabel: "local", defaultRuntimeHomeIds: { codex: "1".repeat(64) },
    });
    const fullBytes = Buffer.byteLength(JSON.stringify(original.turns));
    const result = await observeJournalMaterialization(() => store.usageSyncSnapshot({ deviceLabel: "local" }));
    assert.deepEqual(result.value.events, expected.events);
    assert.equal(result.value.journalRevision, initial.revision);
    assert.equal(result.observations.length, 2);
    const inputBytes = result.observations.reduce((total, row) => total + row.bytes, 0);
    assert.ok(inputBytes < fullBytes / 8, `unused journal content was materialized: ${inputBytes}/${fullBytes}`);
    for (const row of result.observations) {
      for (const key of ["body", "text", "prompt", "diff", "changedFiles", "skillsUsed", "mcpCalls"]) assert.ok(!row.keys.includes(key));
    }
    const complete = await store.journalTurns();
    assert.deepEqual(complete, original.turns, "full accounting/history caller retains original source records");
    assert.deepEqual(await journal.loadLedger(), original);
    assert.equal((await store.usageSyncSnapshot({ afterJournalRevision: initial.revision })).events.length, 0);
    await journal.upsertRecords([record("late")]);
    const delta = await observeJournalMaterialization(() => store.usageSyncSnapshot({ afterJournalRevision: initial.revision }));
    assert.equal(delta.value.events.length, 1);
    assert.equal(delta.observations.length, 1);
    assert.deepEqual(delta.value.events[0], expected.events.find(event => event.schemaVersion === 2)
      ? usageSyncSnapshotFromLedger({ late: (await journal.loadLedger()).turns["codex\0thread\0late"] }, {
        deviceId: "device-local", defaultRuntimeHomeIds: { codex: "1".repeat(64) },
      }).events[0] : null);
  } finally {
    await store.close(); await journal.close();
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

test("usage snapshot source read failures preserve the original error and leave journal bytes unchanged", async () => {
  const { JournalDatabase } = await import("../../../src/infrastructure/persistence/journal-database.mjs");
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-usage-materialization-"));
  const databaseFile = path.join(root, "journal.sqlite");
  const journal = new JournalDatabase(databaseFile);
  const store = new WorkLogUsageSyncStore({ databaseFile, deviceId: "device-local" });
  try {
    await journal.upsertRecords([{ provider: "codex", threadId: "thread", turnId: "turn",
      projectRoot: root, completedAt: "2026-10-31T10:00:00.000Z", body: "preserve full answer", diff: "preserve diff" }]);
    const before = await journal.loadLedger();
    const revision = await journal.currentRevision();
    const failure = new Error("owned fixture source-read failure");
    await assert.rejects(observeJournalMaterialization(() => store.usageSyncSnapshot(), { fail: failure }), error => error === failure);
    assert.deepEqual(await journal.loadLedger(), before);
    assert.equal(await journal.currentRevision(), revision);
    assert.equal((await store.usageSyncSnapshot()).events.length, 1);
  } finally {
    await store.close(); await journal.close();
    assert.equal(path.dirname(root), os.tmpdir());
    await rm(root, { recursive: true, force: true });
  }
});

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
