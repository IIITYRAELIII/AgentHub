import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function pollingApi() {
  const source = await readFile(
    new URL("../../assets/web-app/journal-polling-policy.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, {
    Object,
    Number,
    Promise,
    TypeError,
    window,
  });
  return window.AgentHubJournalPolling;
}

function scheduler() {
  let sequence = 0;
  const scheduled = new Map();
  return {
    clearTimeout(id) {
      scheduled.delete(id);
    },
    nextDelay() {
      return [...scheduled.values()][0]?.delay ?? null;
    },
    runNext() {
      const [id, job] = scheduled.entries().next().value ?? [];
      if (id === undefined) return false;
      scheduled.delete(id);
      job.callback();
      return true;
    },
    setTimeout(callback, delay) {
      const id = ++sequence;
      scheduled.set(id, { callback, delay });
      return id;
    },
  };
}

async function settlePolling() {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
}

test("journal polling pauses while hidden or offline and resumes immediately", async () => {
  const api = await pollingApi();
  const timers = scheduler();
  let visible = false;
  let online = true;
  let requests = 0;
  const polling = api.createBoundedPollingFallback({
    request: async () => { requests += 1; return true; },
    isOnline: () => online,
    isVisible: () => visible,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  polling.start();
  assert.equal(timers.nextDelay(), null);

  visible = true;
  polling.reconcile();
  assert.equal(timers.nextDelay(), 0);
  timers.runNext();
  await settlePolling();
  assert.equal(requests, 1);
  assert.equal(timers.nextDelay(), 10_000);

  online = false;
  polling.reconcile();
  assert.equal(timers.nextDelay(), null);
});

test("journal polling serializes requests and caps exponential backoff", async () => {
  const api = await pollingApi();
  const timers = scheduler();
  let resolveRequest;
  let requests = 0;
  const polling = api.createBoundedPollingFallback({
    request: () => {
      requests += 1;
      return new Promise((resolve) => { resolveRequest = resolve; });
    },
    intervalMs: 10,
    maxIntervalMs: 40,
    setTimeoutImpl: timers.setTimeout,
    clearTimeoutImpl: timers.clearTimeout,
  });

  polling.start();
  assert.equal(timers.nextDelay(), 10);
  timers.runNext();
  await settlePolling();
  polling.refresh();
  assert.equal(requests, 1);

  resolveRequest(false);
  await settlePolling();
  assert.equal(timers.nextDelay(), 20);
  timers.runNext();
  await settlePolling();
  resolveRequest(false);
  await settlePolling();
  assert.equal(timers.nextDelay(), 40);
});

test("journal live updates wait for authenticated session before opening the event stream", async () => {
  const api = await pollingApi();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const listeners = new Map();
  const received = [];
  let created = 0;
  let closed = 0;
  const live = api.createAuthenticatedEventStream({
    ready,
    createSource: () => {
      created += 1;
      return {
        addEventListener: (type, listener) => listeners.set(type, listener),
        close: () => { closed += 1; },
      };
    },
    onReady: () => received.push("ready"),
    onChange: () => received.push("journal"),
    onError: () => received.push("error"),
  });

  const started = live.start();
  await settlePolling();
  assert.equal(created, 0);
  assert.equal(live.snapshot().starting, true);

  resolveReady();
  await started;
  assert.equal(created, 1);
  assert.equal(live.snapshot().connected, true);
  listeners.get("ready")();
  listeners.get("journal")();
  assert.deepEqual(received, ["ready", "journal"]);

  live.stop();
  assert.equal(closed, 1);
  assert.equal(live.snapshot().connected, false);
});

test("stopped journal live updates do not open a late authenticated stream", async () => {
  const api = await pollingApi();
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  let created = 0;
  const live = api.createAuthenticatedEventStream({
    ready,
    createSource: () => {
      created += 1;
      return { addEventListener() {} };
    },
  });

  const started = live.start();
  live.stop();
  resolveReady();
  assert.equal(await started, null);
  assert.equal(created, 0);
});
