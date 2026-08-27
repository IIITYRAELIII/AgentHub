import assert from "node:assert/strict";
import test from "node:test";

import {
  USAGE_SYNC_AUTO_TIMER_NAME,
  UsageSyncAutoService,
} from "../../src/application/usage-sync-auto-service.mjs";

function fixture({
  serverUrl = "https://sync.example.test/agenthub",
  enrolledAt = "2026-08-20T00:00:00.000Z",
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
        return { serverUrl, enrolledAt };
      },
      rememberPush: async (result) => events.push(["remember-push", result]),
      rememberPull: async (result) => events.push(["remember-pull", result]),
    },
    identityStore,
    workLogUsageStore: {
      usageSyncSnapshot: async (options) => {
        events.push(["snapshot", options]);
        return { version: 1, deviceId: options.deviceId, events: [{ id: "turn-1" }] };
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
          return { ok: true, added: 1, updated: 0, rejected: 0 };
        },
        pull: async () => {
          events.push(["pull"]);
          return { version: 1, events: [{ id: "remote-1" }] };
        },
      };
    },
    accountBackfill: async () => {
      events.push(["account-backfill"]);
      if (failBackfill) throw new Error("backfill locked");
      return { applied: true, updated: 2 };
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
  });
  const importProject = state.events.find(([name]) => name === "import-project");
  assert.equal(importProject[1].projectRoot, "D:/projects/Utilities");
  assert.deepEqual(importProject[1].projectionProjectRoots, ["D:/projects/Utilities"]);
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
