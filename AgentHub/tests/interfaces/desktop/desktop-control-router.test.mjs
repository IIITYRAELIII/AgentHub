import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createDesktopControlRouter } from "../../../src/interfaces/desktop/desktop-control-router.mjs";

test("desktop router preserves transport receive and handler-enter trace boundaries", async () => {
  const spans = [];
  const receivedAtMs = Date.now() - 25;
  const router = createDesktopControlRouter({
    handlers: { "send-message": async () => ({ accepted: true }) },
    mutationActions: ["send-message"],
    commandTrace: {
      recordBestEffort: (span) => {
        spans.push(span);
        return true;
      },
      startBestEffortSpan: () => ({ finish: () => true }),
    },
  });

  assert.deepEqual(await router.handleDesktopControl({
    action: "send-message",
    params: {
      text: "Измерь ACK",
      clientTiming: {
        submittedAtMs: receivedAtMs - 100,
        transportStartedAtMs: receivedAtMs - 40,
        transport: "direct-http",
        surface: "browser",
      },
    },
    context: {
      source: "local-mini-app",
      commandId: "trace-boundary-command",
      transportReceivedAtMs: receivedAtMs,
    },
  }), { accepted: true });

  const hubReceive = spans.find((span) => span.stage === "hub-receive");
  const handlerEnter = spans.find((span) => span.stage === "handler-enter");
  assert.equal(hubReceive.observedAtMs, receivedAtMs);
  assert.equal(hubReceive.metadata.transportToHubMs, 40);
  assert.ok(handlerEnter.observedAtMs >= receivedAtMs);
  assert.equal(
    handlerEnter.metadata.transportReceiveToHandlerMs,
    handlerEnter.observedAtMs - receivedAtMs,
  );
});

test("desktop mutation reconciles a redelivery after a crash without repeating its effect", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-receipt-"));
  const receiptFile = path.join(root, "receipts.json");
  let effects = 0;
  let effectStarted;
  const started = new Promise((resolve) => { effectStarted = resolve; });
  const request = {
    action: "mutate",
    params: { value: "one" },
    context: { source: "telegram-mini-app", userId: "42", commandId: "command-1" },
  };
  const first = createDesktopControlRouter({
    handlers: {
      mutate: async () => {
        effects += 1;
        effectStarted();
        await new Promise(() => {});
      },
    },
    mutationActions: ["mutate"],
    receiptFile,
  });
  void first.handleDesktopControl(request);
  await started;
  const receipts = JSON.parse(await readFile(receiptFile, "utf8"));
  receipts.records[0].effectOwner.pid = 999_999;
  await writeFile(receiptFile, `${JSON.stringify(receipts)}\n`);
  const restarted = createDesktopControlRouter({
    handlers: { mutate: async () => { effects += 1; } },
    mutationActions: ["mutate"],
    receiptFile,
    reconcileMutation: async () => ({ resolved: true, result: { accepted: true } }),
  });
  assert.deepEqual(await restarted.handleDesktopControl(request), { accepted: true });
  assert.equal(effects, 1);
});

test("desktop mutation receipt protects retries until delivery is acknowledged", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-ack-"));
  const request = {
    action: "mutate",
    params: { value: "one" },
    context: { source: "desktop-control", commandId: "stable-command" },
  };
  let effects = 0;
  const router = createDesktopControlRouter({
    handlers: { mutate: async () => ({ effect: ++effects }) },
    mutationActions: ["mutate"],
    receiptFile: path.join(root, "receipts.json"),
  });
  try {
    assert.deepEqual(await router.handleDesktopControl(request), { effect: 1 });
    assert.deepEqual(await router.handleDesktopControl(request), { effect: 1 });
    assert.equal(effects, 1);
    assert.equal(await router.forgetDesktopControl("stable-command"), true);
    assert.deepEqual(await router.handleDesktopControl(request), { effect: 2 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop receipts persist a bounded projection and hydrate a lost result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-bounded-receipt-"));
  const receiptFile = path.join(root, "receipts.json");
  let effects = 0;
  let snapshots = 0;
  const router = createDesktopControlRouter({
    handlers: {
      mutate: async () => ({
        accepted: true,
        snapshot: { tasks: [{ output: "x".repeat(100_000) }] },
      }),
      snapshot: async () => ({ apiVersion: 3, tasks: [], selected: { threadId: "fresh" }, sequence: ++snapshots }),
    },
    mutationActions: ["mutate"],
    receiptFile,
  });
  const request = {
    action: "mutate",
    params: {},
    context: { source: "desktop-control", commandId: "bounded-command" },
  };

  const first = await router.handleDesktopControl({
    ...request,
    params: { effect: ++effects },
  });
  assert.equal(first.snapshot.tasks[0].output.length, 100_000);
  const replay = await router.handleDesktopControl({
    ...request,
    params: { effect: effects },
  });
  assert.equal(replay.accepted, true);
  assert.equal(replay.snapshot.selected.threadId, "fresh");
  assert.equal(snapshots, 1);
  assert.ok(Buffer.byteLength(await readFile(receiptFile, "utf8")) < 2_000);
  await rm(root, { recursive: true, force: true });
});

test("desktop receipt policy can bypass safe repeatable mutations", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-desktop-repeatable-"));
  const receiptFile = path.join(root, "receipts.json");
  let effects = 0;
  const router = createDesktopControlRouter({
    handlers: { navigate: async () => ({ effect: ++effects }) },
    mutationActions: ["navigate"],
    receiptActions: [],
    receiptFile,
  });
  const request = {
    action: "navigate",
    params: {},
    context: { source: "desktop-control", commandId: "repeatable-command" },
  };
  assert.deepEqual(await router.handleDesktopControl(request), { effect: 1 });
  assert.deepEqual(await router.handleDesktopControl(request), { effect: 2 });
  await assert.rejects(readFile(receiptFile, "utf8"), /ENOENT/u);
  await rm(root, { recursive: true, force: true });
});

test("desktop control router applies transport-specific response limits", async () => {
  const received = [];
  const router = createDesktopControlRouter({
    handlers: {
      snapshot: async (params) => {
        received.push(params);
        return params;
      },
    },
    mutationActions: [],
    miniAppLimits: {
      sources: ["telegram-mini-app", "trusted-device", "local-mini-app"],
      limit: 10,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
    },
    desktopMaxResponseBytes: 3_500_000,
  });

  await router.handleDesktopControl({
    action: "snapshot",
    params: {
      limit: 50,
      before: 17,
      maxAnswerChars: 999_999,
      maxResponseBytes: 9_000_000,
    },
    context: { source: "telegram-mini-app" },
  });
  await router.handleDesktopControl({
    action: "snapshot",
    params: { maxResponseBytes: 9_000_000 },
    context: { source: "trusted-device" },
  });
  await router.handleDesktopControl({
    action: "snapshot",
    params: { maxResponseBytes: 9_000_000 },
    context: { source: "local-mini-app" },
  });
  await router.handleDesktopControl({
    action: "snapshot",
    params: { maxResponseBytes: 9_000_000 },
  });

  assert.deepEqual(received, [
    {
      limit: 10,
      before: 17,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
      compactSnapshot: true,
    },
    {
      limit: 10,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
      compactSnapshot: true,
    },
    {
      limit: 10,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
      compactSnapshot: true,
    },
    { maxResponseBytes: 3_500_000 },
  ]);
});

test("Web mutations replace a large live result with a compact fresh snapshot", async () => {
  for (const source of ["telegram-mini-app", "trusted-device", "local-mini-app"]) {
    const snapshotParams = [];
    const router = createDesktopControlRouter({
      handlers: {
        mutate: async () => ({
          accepted: true,
          snapshot: { apiVersion: 3, tasks: [{ output: "x".repeat(1_100_000) }], selected: { threadId: "old" } },
        }),
        snapshot: async (params) => {
          snapshotParams.push(params);
          return { apiVersion: 3, tasks: [], selected: { threadId: "fresh" } };
        },
      },
      mutationActions: ["mutate"],
    });

    const result = await router.handleDesktopControl({
      action: "mutate",
      params: {},
      context: { source, userId: "42" },
    });

    assert.equal(result.accepted, true);
    assert.equal(result.snapshot.selected.threadId, "fresh");
    assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") < 10_000);
    assert.deepEqual(snapshotParams, [{
      limit: 10,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
      compactSnapshot: true,
    }]);
  }
});

test("desktop control router serializes mutations and continues after a failure", async () => {
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let call = 0;
  const router = createDesktopControlRouter({
    handlers: {
      mutate: async () => {
        call += 1;
        const current = call;
        events.push(`start-${current}`);
        if (current === 1) await firstGate;
        events.push(`end-${current}`);
        if (current === 2) throw new Error("expected");
        return current;
      },
    },
    mutationActions: ["mutate"],
  });

  const first = router.handleDesktopControl({ action: "mutate", params: {} });
  const second = router.handleDesktopControl({ action: "mutate", params: {} });
  const third = router.handleDesktopControl({ action: "mutate", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start-1"]);

  releaseFirst();
  assert.equal(await first, 1);
  await assert.rejects(second, /expected/);
  assert.equal(await third, 3);
  assert.deepEqual(events, [
    "start-1",
    "end-1",
    "start-2",
    "end-2",
    "start-3",
    "end-3",
  ]);
});

test("desktop control router does not serialize read actions", async () => {
  const events = [];
  let releaseRead;
  const gate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  const router = createDesktopControlRouter({
    handlers: {
      read: async ({ id }) => {
        events.push(`start-${id}`);
        if (id === 1) await gate;
        events.push(`end-${id}`);
      },
    },
    mutationActions: [],
  });

  const first = router.handleDesktopControl({ action: "read", params: { id: 1 } });
  const second = router.handleDesktopControl({ action: "read", params: { id: 2 } });
  await second;
  assert.deepEqual(events, ["start-1", "start-2", "end-2"]);
  releaseRead();
  await first;
});

test("desktop control router lets urgent mutations bypass a blocked mutation", async () => {
  const events = [];
  let releaseSlow;
  const gate = new Promise((resolve) => { releaseSlow = resolve; });
  const router = createDesktopControlRouter({
    handlers: {
      slow: async () => {
        events.push("slow-start");
        await gate;
        events.push("slow-end");
      },
      urgent: async () => { events.push("urgent"); },
    },
    mutationActions: ["slow", "urgent"],
    concurrentMutationActions: ["urgent"],
  });

  const slow = router.handleDesktopControl({ action: "slow", params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  await router.handleDesktopControl({ action: "urgent", params: {} });
  assert.deepEqual(events, ["slow-start", "urgent"]);
  releaseSlow();
  await slow;
});

test("desktop control router rejects unknown actions", async () => {
  const router = createDesktopControlRouter({
    handlers: {},
    mutationActions: [],
  });
  await assert.rejects(
    router.handleDesktopControl({ action: "missing", params: {} }),
    /Неизвестная desktop-команда: missing/,
  );
});

test("desktop control router passes authenticated client context to handlers", async () => {
  let receivedContext = null;
  const router = createDesktopControlRouter({
    handlers: {
      devices: async (_params, context) => {
        receivedContext = context;
        return { ok: true };
      },
    },
    mutationActions: [],
  });
  const context = { source: "telegram-mini-app", userId: "42" };
  assert.deepEqual(await router.handleDesktopControl({ action: "devices", params: {}, context }), { ok: true });
  assert.equal(receivedContext, context);
});
