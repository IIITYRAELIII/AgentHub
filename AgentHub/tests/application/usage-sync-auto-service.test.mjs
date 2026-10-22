import assert from "node:assert/strict";
import test from "node:test";
import { CommandTraceService } from "../../src/application/command-trace-service.mjs";

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
  lastUsagePullServerGeneration = "",
  lastUsagePullLocalGeneration = "",
  lastUsagePullFactSummary = null,
  lastUsageAntiEntropyAt = "2026-08-20T03:30:00.000Z",
  localJournalRevision = 7,
  localEvents = [{ id: "turn-1", observedAt: "2026-08-20T04:00:00.000Z" }],
  localUsageStates = [{ localStoreGeneration: "", factSummary: null }],
  remoteEvents = [{ id: "remote-1" }],
  pullResults = null,
  summaryResult = null,
  accountBackfillResult = { applied: true, updated: 2 },
  pushResult = null,
  delayPush = false,
  failPush = false,
  failBackfill = false,
  trace = null,
  now = () => new Date("2026-08-20T04:00:00.000Z"),
} = {}) {
  const events = [];
  let scheduled = null;
  let releasePush;
  const delayedPush = new Promise((resolve) => { releasePush = resolve; });
  const usageStates = [...localUsageStates];
  const nextUsageState = () => {
    if (usageStates.length > 1) return usageStates.shift();
    return usageStates[0] ?? { localStoreGeneration: "", factSummary: null };
  };
  const queuedPullResults = Array.isArray(pullResults) ? [...pullResults] : null;
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
          lastUsagePullServerGeneration,
          lastUsagePullLocalGeneration,
          lastUsagePullFactSummary,
          lastUsageAntiEntropyAt,
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
      usageSyncState: async () => nextUsageState(),
      ensureAccountUsageProjectionCurrent: async (options) => {
        events.push(["ensure-projection", options]);
        return { projected: true, projectionRequired: true, projectionVersion: "sha256:projection" };
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
          if (queuedPullResults?.length) return queuedPullResults.shift();
          return { version: 1, serverRevision: 9, events: remoteEvents };
        },
        summary: async () => {
          events.push(["summary"]);
          return summaryResult ?? { version: 1, serverRevision: 9, events: [] };
        },
      };
    },
    accountBackfill: async () => {
      events.push(["account-backfill"]);
      if (failBackfill) throw new Error("backfill locked");
      return accountBackfillResult;
    },
    trace,
    suggestedDeviceLabel: async () => "SidorukSV",
    projectRoot: "D:/projects/Utilities",
    projectionProjectRoots: ["D:/projects/Utilities"],
    initialDelayMs: 10,
    intervalMs: 20,
    now,
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

test("scheduled usage sync never runs the legacy ambient account writer", async () => {
  const state = fixture({ failBackfill: true });
  for (let index = 0; index < 2; index += 1) assert.equal((await state.service.sync()).synced, true);
  assert.equal(state.events.filter(([name]) => name === "account-backfill").length, 0);
  assert.equal(state.events.filter(([name]) => name === "push").length, 2);
  assert.equal(state.events.filter(([name]) => name === "import-project").length, 2);
});

test("auto-sync timing follows one coalesced operation and cannot change its outcome", async () => {
  const spans = [];
  const trace = new CommandTraceService({ store: { appendBestEffort(span) {
    spans.push(span); throw new Error("telemetry offline");
  } }, logger: { warn() {} } });
  const state = fixture({ delayPush: true, trace });
  const first = state.service.sync();
  assert.equal(first, state.service.sync());
  await new Promise(resolve => setImmediate(resolve));
  state.releasePush({ ok: true, added: 1, rejected: 0 });
  assert.equal((await first).synced, true);
  assert.equal(new Set(spans.map(s => s.commandId)).size, 1);
  for (const stage of ["usage-sync-config", "usage-sync-snapshot", "usage-sync-push", "usage-sync-import", "usage-sync-total"]) {
    assert.ok(spans.some(s => s.stage === stage && s.outcome === "succeeded"), stage);
  }
  assert.ok(spans.every(s => Number.isFinite(s.monotonicDurationMs) && s.monotonicDurationMs >= 0));
  for (const completed of spans.filter(s => s.outcome !== "started")) {
    assert.ok(spans.some(s => s.outcome === "started" && s.metadata.operationSpanId === completed.metadata.operationSpanId));
  }
  assert.ok(spans.every(s => !JSON.stringify(s).includes("sync.example") && !JSON.stringify(s).includes("turn-1")));
});

test("failed push retains failed timing and never advances cursors or triggers legacy recovery", async () => {
  const spans = [];
  const trace = new CommandTraceService({ store: { appendBestEffort: s => { spans.push(s); return true; } } });
  const state = fixture({ failPush: true, trace });
  await assert.rejects(state.service.sync(), /offline/u);
  assert.equal(state.events.filter(([name]) => name === "remember-push" || name === "remember-pull" || name === "account-backfill").length, 0);
  assert.ok(spans.some(s => s.stage === "usage-sync-push" && s.outcome === "failed"));
  assert.ok(spans.some(s => s.stage === "usage-sync-total" && s.outcome === "failed"));
  assert.equal(new Set(spans.map(s => s.commandId)).size, 1);
  assert.equal(state.events.filter(([name]) => name === "schedule").length, 1);
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
    ownFactsOnly: true,
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
    lastUsagePullServerGeneration: "server-generation-1",
    lastUsagePullLocalGeneration: "local-generation-1",
    localUsageStates: [{ localStoreGeneration: "local-generation-1", factSummary: null }],
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
    ownFactsOnly: true,
  });
  assert.deepEqual(state.events.find(([name]) => name === "pull")?.[1], {
    sinceRevision: 8,
  });
  assert.equal(state.events.some(([name]) => name === "import-project"), false);
  assert.equal(state.events.some(([name]) => name === "info"), false);
});

test("UsageSyncAutoService keeps legacy pull cursors when the server has no generation proof", async () => {
  const state = fixture({
    lastUsagePushWatermark: "2026-08-20T04:00:00.000Z",
    lastUsagePushJournalRevision: 6,
    lastUsagePullRevision: 8,
    localEvents: [],
    remoteEvents: [],
    accountBackfillResult: { applied: false },
    pushResult: { ok: true, added: 0, updated: 0, rejected: 0, serverRevision: 8 },
  });

  await state.service.sync();

  assert.deepEqual(state.events.find(([name]) => name === "pull")?.[1], {
    sinceRevision: 8,
  });
  assert.deepEqual(state.events.find(([name]) => name === "remember-pull")?.[2], {
    serverRevision: 9,
  });
  assert.equal(state.events.some(([name]) => name === "ensure-projection"), false);
});

test("UsageSyncAutoService full reconciles invalid cursors before replacing the pull cursor", async () => {
  const summary = { version: 1, count: 1, byType: { turn: 1 }, digest: "sha256:abc" };
  const state = fixture({
    lastUsagePullRevision: 8,
    lastUsagePullServerGeneration: "server-old",
    lastUsagePullLocalGeneration: "local-generation-1",
    localUsageStates: [
      { localStoreGeneration: "local-generation-2", factSummary: { ...summary, digest: "sha256:old" } },
      { localStoreGeneration: "local-generation-2", factSummary: summary },
    ],
    pushResult: {
      ok: true,
      added: 0,
      updated: 0,
      rejected: 0,
      serverRevision: 12,
      datasetGeneration: "server-new",
    },
    pullResults: [{
      version: 1,
      serverRevision: 12,
      datasetGeneration: "server-new",
      factSummary: summary,
      events: [{ id: "remote-1" }],
    }],
  });

  const result = await state.service.sync();

  assert.equal(result.repair?.converged, true);
  assert.deepEqual(result.repair?.reasons, ["cursor-generation-mismatch", "server-generation-changed"]);
  assert.deepEqual(state.events.find(([name]) => name === "pull")?.[1], undefined);
  assert.equal(state.events.find(([name]) => name === "import-project")?.[1].reconcile, true);
  assert.deepEqual(state.events.find(([name]) => name === "ensure-projection")?.[1], {
    required: true,
    reason: "sync-repair",
    projectRoot: "D:/projects/Utilities",
    projectionProjectRoots: ["D:/projects/Utilities"],
  });
  assert.deepEqual(state.events.find(([name]) => name === "remember-pull")?.[2], {
    serverRevision: 12,
    serverGeneration: "server-new",
    localGeneration: "local-generation-2",
    factSummary: summary,
    replaceCursor: true,
  });
});

test("UsageSyncAutoService repairs bounded anti-entropy summary mismatches", async () => {
  const summary = { version: 1, count: 1, byType: { turn: 1 }, digest: "sha256:remote" };
  const state = fixture({
    lastUsagePullRevision: 8,
    lastUsagePullServerGeneration: "server-generation-1",
    lastUsagePullLocalGeneration: "local-generation-1",
    lastUsageAntiEntropyAt: "2026-08-20T02:30:00.000Z",
    localUsageStates: [
      { localStoreGeneration: "local-generation-1", factSummary: { ...summary, digest: "sha256:local" } },
      { localStoreGeneration: "local-generation-1", factSummary: { ...summary, digest: "sha256:still-local" } },
      { localStoreGeneration: "local-generation-1", factSummary: summary },
    ],
    pushResult: {
      ok: true,
      added: 0,
      updated: 0,
      rejected: 0,
      serverRevision: 9,
      datasetGeneration: "server-generation-1",
    },
    summaryResult: {
      version: 1,
      serverRevision: 9,
      datasetGeneration: "server-generation-1",
      factSummary: summary,
      events: [],
    },
    pullResults: [{
      version: 1,
      serverRevision: 9,
      datasetGeneration: "server-generation-1",
      events: [],
    }, {
      version: 1,
      serverRevision: 9,
      datasetGeneration: "server-generation-1",
      factSummary: summary,
      events: [{ id: "remote-1" }],
    }],
  });

  const result = await state.service.sync();

  assert.equal(result.antiEntropy.checked, true);
  assert.equal(result.antiEntropy.mismatch, true);
  assert.equal(result.repair?.converged, true);
  assert.equal(state.events.filter(([name]) => name === "summary").length, 1);
  assert.deepEqual(state.events.filter(([name]) => name === "pull").map(([, options]) => options), [
    { sinceRevision: 8 },
    undefined,
  ]);
  assert.equal(state.events.find(([name]) => name === "import-project")?.[1].reconcile, true);
});

test("UsageSyncAutoService does not advance pull cursor after failed repair convergence", async () => {
  const remoteSummary = { version: 1, count: 1, byType: { turn: 1 }, digest: "sha256:remote" };
  const localSummary = { version: 1, count: 1, byType: { turn: 1 }, digest: "sha256:local" };
  const state = fixture({
    lastUsagePullRevision: 8,
    lastUsagePullServerGeneration: "server-old",
    lastUsagePullLocalGeneration: "local-generation-1",
    localUsageStates: [
      { localStoreGeneration: "local-generation-2", factSummary: localSummary },
      { localStoreGeneration: "local-generation-2", factSummary: localSummary },
    ],
    pushResult: {
      ok: true,
      added: 0,
      updated: 0,
      rejected: 0,
      serverRevision: 12,
      datasetGeneration: "server-new",
    },
    pullResults: [{
      version: 1,
      serverRevision: 12,
      datasetGeneration: "server-new",
      factSummary: remoteSummary,
      events: [{ id: "remote-1" }],
    }],
  });

  const result = await state.service.sync();

  assert.equal(result.repair?.failed, true);
  assert.equal(result.repair?.reason, "fact-summary-mismatch-after-reconcile");
  assert.deepEqual(state.events.find(([name]) => name === "remember-pull")?.[2], {
    serverRevision: null,
  });
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
    ownFactsOnly: true,
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
    ownFactsOnly: true,
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
    ownFactsOnly: true,
  });
});

test("UsageSyncAutoService ignores retired ambient backfill even when it would fail", async () => {
  const state = fixture({ failBackfill: true });

  const result = await state.service.sync();

  assert.equal(result.synced, true);
  assert.equal(result.accountBackfill, undefined);
  assert.deepEqual(state.events.map(([name]) => name), [
    "load-config",
    "client",
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
