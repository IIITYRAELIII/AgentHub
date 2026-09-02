import assert from "node:assert/strict";
import test from "node:test";

import {
  RemoteControlWakeChannel,
  REMOTE_CONTROL_WAKE_PROTOCOL,
  remoteControlWakeUrl,
} from "../../../src/interfaces/web/remote-control-wake-channel.mjs";
import {
  assertRemoteControlTransportBudget,
  remoteControlTransportBudget,
} from "../../../src/interfaces/web/remote-control-transport-budget.mjs";

class FakeSocket {
  listeners = new Map();
  sent = [];
  closed = false;

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, payload = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener(payload);
  }

  send(payload) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
  }
}

function manualTimers() {
  let nextId = 0;
  const timeouts = new Map();
  const intervals = new Map();
  return {
    setTimeout(callback) {
      nextId += 1;
      timeouts.set(nextId, callback);
      return nextId;
    },
    clearTimeout(id) {
      timeouts.delete(id);
    },
    setInterval(callback) {
      nextId += 1;
      intervals.set(nextId, callback);
      return nextId;
    },
    clearInterval(id) {
      intervals.delete(id);
    },
    runTimeouts() {
      const pending = [...timeouts.values()];
      timeouts.clear();
      for (const callback of pending) callback();
    },
    runIntervals() {
      for (const callback of intervals.values()) callback();
    },
  };
}

const settleAsyncSetup = () => new Promise((resolve) => setImmediate(resolve));

test("wake URLs bind the exact GET path and service identity", () => {
  const target = new URL(remoteControlWakeUrl({
    publicUrl: "https://hub.example.test/root",
    pathname: "/api/dashboard-bot/wake",
    secret: "s".repeat(64),
    parameters: { hubId: "018f6c86-3f34-7a31-8f27-16f5b96cce71" },
  }));

  assert.equal(target.protocol, "wss:");
  assert.equal(target.pathname, "/api/dashboard-bot/wake");
  assert.equal(target.searchParams.get("hubId"), "018f6c86-3f34-7a31-8f27-16f5b96cce71");
  assert.match(target.searchParams.get("signature"), /^[a-f0-9]{64}$/u);
});

test("wake channel drains on connect, wake, duplicate hint and reconnect", async () => {
  const timers = manualTimers();
  const sockets = [];
  const channel = new RemoteControlWakeChannel({
    createUrl: async () => "wss://hub.example.test/api/control/wake",
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    fallbackMs: 1_000,
    heartbeatMs: 10_000,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });

  const connected = channel.wait();
  await settleAsyncSetup();
  sockets[0].emit("open");
  assert.equal(await connected, "connected");

  const firstWake = channel.wait();
  sockets[0].emit("message", { data: JSON.stringify({
    protocol: REMOTE_CONTROL_WAKE_PROTOCOL,
    kind: "available",
    revision: 1,
  }) });
  sockets[0].emit("message", { data: JSON.stringify({
    protocol: REMOTE_CONTROL_WAKE_PROTOCOL,
    kind: "available",
    revision: 1,
  }) });
  assert.equal(await firstWake, "wake");
  assert.equal(await channel.wait(), "wake");

  sockets[0].emit("close");
  const fallback = channel.wait();
  await settleAsyncSetup();
  timers.runTimeouts();
  assert.equal(await fallback, "fallback");

  const reconnected = channel.wait();
  await settleAsyncSetup();
  sockets[1].emit("open");
  assert.equal(await reconnected, "connected");
  timers.runIntervals();
  assert.deepEqual(sockets[1].sent, ["ping"]);
  channel.close();
  assert.equal(sockets[1].closed, true);
});

test("wake channel falls back at the fixed cadence without a socket implementation", async () => {
  const timers = manualTimers();
  const channel = new RemoteControlWakeChannel({
    createUrl: async () => "wss://hub.example.test/api/control/wake",
    createSocket: () => { throw new Error("upgrade unavailable"); },
    fallbackMs: 1_000,
    logger: { warn() {} },
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
    setIntervalImpl: timers.setInterval,
    clearIntervalImpl: timers.clearInterval,
  });

  const waiting = channel.wait();
  await settleAsyncSetup();
  timers.runTimeouts();
  assert.equal(await waiting, "fallback");
  channel.close();
});

test("Free-plan idle and immediate fallback budget stays below deterministic limits", () => {
  const budget = assertRemoteControlTransportBudget(remoteControlTransportBudget());

  assert.equal(budget.fallbackRequests, 17_280);
  assert.equal(budget.fallbackGbSeconds, 540);
  assert.equal(budget.websocketRequestEquivalents, 146);
  assert.equal(budget.websocketIdleGbSeconds, 0);
  assert.ok(budget.fallbackRequestRatio < 0.25);
  assert.ok(budget.fallbackDurationRatio < 0.1);
  assert.throws(
    () => assertRemoteControlTransportBudget(remoteControlTransportBudget({ fallbackMs: 1_000 })),
    /request budget/u,
  );
});
