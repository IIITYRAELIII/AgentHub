import assert from "node:assert/strict";
import test from "node:test";

import {
  USAGE_SYNC_AUTO_TIMER_NAME,
  UsageSyncAutoService,
} from "../../src/application/usage-sync-auto-service.mjs";

function fixture({
  serverUrl = "https://sync.example.test/agenthub",
  enrolledAt = "2026-08-20T00:00:00.000Z",
  lastUsagePushWatermark = "",
  lastUsagePushJournalRevision = 0,
  lastUsageHistoryResendVersion = 1,
  lastUsagePullRevision = 0,
  localJournalRevision = 7,
  localEvents = [{ id: "turn-1", observedAt: "2026-08-20T04:00:00.000Z" }],
  remoteEvents = [{ id: "remote-1" }],
  accountBackfillResult = { applied: true, updated: 2 },
  pushResult = null,
  delayPush = false,
  failPush = false,
  failBackfill = false,
} = {}) {
  const events = [];
  let scheduled = null;
  let releasePush;
  const delayedPush = new Promise((resolve) => { releasePush = resolve; });
  const identityStore = {
    deviceId: "device-local",
    label: "DESKTOP-FNNC1JA",
    labelConfirmedAt: "",
    async setLabel(value, options = {}) {
      events.push(["set-label", value, options]);
      this.label = String(value ?? "").trim();
      if (options.confirmed) this.labelConfirmedAt = "2026-08-21T07:00:00.000Z";
    },
  };
  const service = new UsageSyncAutoService({
    timers: {
      schedule: (name, callback, delayMs, options) => {
        events.push(["schedule", name, delayMs, options]);
        scheduled = callback;
      },
      clear: (name) => events.push(["clear", name]),
    },
    remoteConfigStore: {
      load: async () => {
        events.push(["load-config"]);
        return {
          serverUrl,
          enrolledAt,
          lastUsagePushWatermark,
          lastUsagePushJournalRevision,
          lastUsageHistoryResendVersion,
          lastUsagePullRevision,
        };
      },
      rememberPush: async (result, options) => events.push(["remember-push", result, options]),
      rememberPull: async (result, options) => events.push(["remember-pull", result, options]),
    },
    identityStore,
    workLogUsageStore: {
      usageSyncSnapshot: async (options) => {
        events.push(["snapshot", options]);
        return {
          version: 1,
          deviceId: options.deviceId,
          journalRevision: localJournalRevision,
          events: localEvents,
        };
      },
      importUsageSyncSnapshotAndProject: async (options) => {
        events.push(["import-project", options]);
        return { imported: true, added: 1, updated: 0, projected: true };
      },
      setUsageSyncDeviceLabel: (label) => events.push(["set-store-label", label]),
    },
    clientFactory: ({ serverUrl: url, identityStore }) => {
      events.push(["client", url, identityStore.deviceId]);
      return {
        push: async (snapshot) => {
          events.push(["push", snapshot]);
          if (failPush) throw new Error("offline");
          if (delayPush) return delayedPush;
          return pushResult ?? { ok: true, added: localEvents.length, updated: 0, rejected: 0 };
        },
        pull: async (options) => {
          events.push(["pull", options]);
          return { version: 1, serverRevision: 9, events: remoteEvents };
        },
      };
    },
    accountBackfill: async () => {
      events.push(["account-backfill"]);
      if (failBackfill) throw new Error("backfill locked");
      return accountBackfillResult;
    },
    suggestedDeviceLabel: async () => "SidorukSV",
    projectRoot: "D:/projects/Utilities",
    projectionProjectRoots: ["D:/projects/Utilities"],
    initialDelayMs: 10,
    intervalMs: 20,
    logger: {
      info: (...args) => events.push(["info", ...args]),
      warn: (...args) => events.push(["warn", ...args]),
    },
  });
  return {
    service,
    events,
    scheduled: () => scheduled,
    releasePush,
  };
}

test("UsageSyncAutoService quietly skips when no remote is configured and reschedules", async () => {
  const state = fixture({ serverUrl: "" });

  assert.deepEqual(await state.service.sync(), { skipped: true, reason: "not-configured" });
  assert.deepEqual(state.events.map(([name]) => name), ["load-config", "schedule"]);
  assert.deepEqual(state.events.at(-1), [
    "schedule",
    USAGE_SYNC_AUTO_TIMER_NAME,
    20,
    { unref: true },
  ]);
});

test("UsageSyncAutoService keeps default remote URL idle until enrollment", async () => {
  const state = fixture({ enrolledAt: "" });

  assert.deepEqual(await state.service.sync(), {
    skipped: true,
    reason: "not-enrolled",
    serverUrl: "https://sync.example.test/agenthub",
  });
  assert.deepEqual(state.events.map(([name]) => name), ["load-config", "schedule"]);
});

test("UsageSyncAutoService pushes, pulls, imports and remembers remote results", async () => {
  const state = fixture();

  const result = await state.service.sync();

  assert.equal(result.synced, true);
  assert.equal(result.exportedEvents, 1);
  assert.equal(result.remoteEvents, 1);
  assert.deepEqual(state.events.map(([name]) => name), [
    "load-config",
    "client",
    "account-backfill",
    "info",
    "snapshot",
    "push",
    "remember-push",
    "pull",
    "import-project",
    "remember-pull",
    "info",
    "schedule",
  ]);
  assert.deepEqual(state.events.find(([name]) => name === "snapshot")?.[1], {
    deviceId: "device-local",
    deviceLabel: "DESKTOP-FNNC1JA",
    afterObservedAt: "",
    afterJournalRevision: 0,
  });
  assert.deepEqual(state.events.find(([name]) => name === "remember-push")?.[2], {
    usageWatermark: "2026-08-20T04:00:00.000Z",
    usageJournalRevision: 7,
  });
  assert.deepEqual(state.events.find(([name]) => name === "pull")?.[1], {
    sinceRevision: 0,
  });
  assert.deepEqual(state.events.find(([name]) => name === "remember-pull")?.[2], {
    serverRevision: 9,
  });
  const importProject = state.events.find(([name]) => name === "import-project");
  assert.equal(importProject[1].projectRoot, "D:/projects/Utilities");
  assert.deepEqual(importProject[1].projectionProjectRoots, ["D:/projects/Utilities"]);
});

test("UsageSyncAutoService push watermark is based only on turn facts", async () => {
  const state = fixture({
    localEvents: [{
      schemaVersion: 2,
      type: "turn",
      eventId: `usage:${"a".repeat(64)}`,
      observedAt: "2026-08-20T04:00:00.000Z",
    }, {
      schemaVersion: 2,
      type: "auth_observation",
      observationId: `auth:${"b".repeat(64)}`,
      observedAt: "2026-08-20T05:00:00.000Z",
    }, {
      schemaVersion: 2,
      type: "limit_observation",
      observationId: `limit:${"c".repeat(64)}`,
      observedAt: "2026-08-20T06:00:00.000Z",
    }],
    remoteEvents: [],
  });

  await state.service.sync();

  assert.deepEqual(state.events.find(([name]) => name === "remember-push")?.[2], {
    usageWatermark: "2026-08-20T04:00:00.000Z",
    usageJournalRevision: 7,
  });
});

test("UsageSyncAutoService sends only journal deltas after the saved revision", async () => {
  const state = fixture({
    lastUsagePushWatermark: "2026-08-20T04:00:00.000Z",
    lastUsagePushJournalRevision: 6,
    lastUsagePullRevision: 8,
    localEvents: [],
    remoteEvents: [],
    accountBackfillResult: { applied: false },
    pushResult: { ok: true, added: 0, updated: 0, rejected: 0, serverRevision: 8 },
  });

  const result = await state.service.sync();

  assert.equal(result.exportedEvents, 0);
  assert.equal(result.remoteEvents, 0);
  assert.deepEqual(state.events.find(([name]) => name === "snapshot")?.[1], {
    deviceId: "device-local",
    deviceLabel: "DESKTOP-FNNC1JA",
    afterObservedAt: "2026-08-20T04:00:00.000Z",
    afterJournalRevision: 6,
  });
  assert.deepEqual(state.events.find(([name]) => name === "pull")?.[1], {
    sinceRevision: 8,
  });
  assert.equal(state.events.some(([name]) => name === "import-project"), false);
  assert.equal(state.events.some(([name]) => name === "info"), false);
});

test("UsageSyncAutoService resends full history once for USG-001 migration", async () => {
  const state = fixture({
    lastUsagePushWatermark: "2026-08-20T04:00:00.000Z",
    lastUsagePushJournalRevision: 6,
    lastUsageHistoryResendVersion: 0,
    localEvents: [
      { id: "turn-1", observedAt: "2026-08-20T04:00:00.000Z" },
      { id: "turn-2", observedAt: "2026-08-20T04:05:00.000Z" },
    ],
    remoteEvents: [],
    pushResult: {
      ok: true,
      added: 0,
      updated: 0,
      unchanged: 2,
      rejected: 0,
      usageFactSchemaVersion: 2,
    },
  });

  const result = await state.service.sync();

  assert.equal(result.exportedEvents, 2);
  assert.equal(result.usageHistoryResendVersion, 1);
  assert.equal(result.usageHistoryResendPending, false);
  assert.deepEqual(state.events.find(([name]) => name === "snapshot")?.[1], {
    deviceId: "device-local",
    deviceLabel: "DESKTOP-FNNC1JA",
    afterObservedAt: "",
    afterJournalRevision: 0,
  });
  assert.deepEqual(state.events.find(([name]) => name === "remember-push")?.[2], {
    usageWatermark: "2026-08-20T04:05:00.000Z",
    usageJournalRevision: 7,
    usageHistoryResendVersion: 1,
  });
});

test("UsageSyncAutoService keeps USG-001 history resend pending against legacy servers", async () => {
  const state = fixture({
    lastUsagePushWatermark: "2026-08-20T04:00:00.000Z",
    lastUsagePushJournalRevision: 6,
    lastUsageHistoryResendVersion: 0,
    localEvents: [{ id: "turn-1", observedAt: "2026-08-20T04:00:00.000Z" }],
    remoteEvents: [],
    pushResult: {
      ok: true,
      added: 0,
      updated: 0,
      unchanged: 1,
      rejected: 0,
    },
  });

  const result = await state.service.sync();

  assert.equal(result.usageHistoryResendVersion, null);
  assert.equal(result.usageHistoryResendPending, true);
  assert.deepEqual(state.events.find(([name]) => name === "snapshot")?.[1], {
    deviceId: "device-local",
    deviceLabel: "DESKTOP-FNNC1JA",
    afterObservedAt: "",
    afterJournalRevision: 0,
  });
  assert.deepEqual(state.events.find(([name]) => name === "remember-push")?.[2], {
    usageWatermark: "",
    usageJournalRevision: null,
  });
});

test("UsageSyncAutoService exposes and confirms the device nickname", async () => {
  const state = fixture();

  assert.deepEqual(await state.service.deviceLabelStatus(), {
    deviceId: "device-local",
    deviceLabel: "DESKTOP-FNNC1JA",
    suggestedDeviceLabel: "SidorukSV",
    deviceLabelConfirmed: false,
    deviceLabelConfirmedAt: "",
    deviceLabelPromptRequired: true,
  });

  const result = await state.service.setDeviceLabel("SidorukSV");

  assert.equal(result.updated, true);
  assert.equal(result.deviceLabel, "SidorukSV");
  assert.equal(result.deviceLabelConfirmedAt, "2026-08-21T07:00:00.000Z");
  assert.deepEqual(state.events.find(([name]) => name === "set-label"), [
    "set-label",
    "SidorukSV",
    { confirmed: true },
  ]);
  assert.deepEqual(state.events.find(([name]) => name === "set-store-label"), [
    "set-store-label",
    "SidorukSV",
  ]);
  assert.deepEqual(state.events.find(([name]) => name === "snapshot")?.[1], {
    deviceId: "device-local",
    deviceLabel: "SidorukSV",
    afterObservedAt: "",
    afterJournalRevision: 0,
  });
});

test("UsageSyncAutoService warns and still syncs when account backfill fails", async () => {
  const state = fixture({ failBackfill: true });

  const result = await state.service.sync();

  assert.equal(result.synced, true);
  assert.deepEqual(result.accountBackfill, {
    applied: false,
    failed: true,
    reason: "backfill locked",
  });
  assert.deepEqual(state.events.map(([name]) => name), [
    "load-config",
    "client",
    "account-backfill",
    "warn",
    "snapshot",
    "push",
    "remember-push",
    "pull",
    "import-project",
    "remember-pull",
    "info",
    "schedule",
  ]);
});

test("UsageSyncAutoService coalesces overlapping sync runs", async () => {
  const state = fixture({ delayPush: true });

  const first = state.service.sync();
  const second = state.service.sync();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(first, second);
  assert.equal(state.events.filter(([name]) => name === "push").length, 1);
  state.releasePush({ ok: true, added: 0, updated: 0, rejected: 0 });
  await first;
  assert.equal(state.events.filter(([name]) => name === "schedule").length, 1);
});

test("UsageSyncAutoService schedules the initial timer and logs timer failures", async () => {
  const state = fixture({ failPush: true });

  state.service.scheduleInitial();
  assert.deepEqual(state.events.at(-1), [
    "schedule",
    USAGE_SYNC_AUTO_TIMER_NAME,
    10,
    { unref: true },
  ]);

  state.scheduled()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.events.some(([name, message]) => (
    name === "warn" && message === "Usage sync failed: offline"
  )), true);
  assert.equal(state.events.filter(([name]) => name === "schedule").length, 2);
});
