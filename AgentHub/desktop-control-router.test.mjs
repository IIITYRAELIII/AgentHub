import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopControlRouter } from "./desktop-control-router.mjs";

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
      source: "telegram-mini-app",
      limit: 10,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
    },
    desktopMaxResponseBytes: 3_500_000,
  });

  await router.handleDesktopControl({
    action: "snapshot",
    params: { limit: 50, maxAnswerChars: 999_999, maxResponseBytes: 9_000_000 },
    context: { source: "telegram-mini-app" },
  });
  await router.handleDesktopControl({
    action: "snapshot",
    params: { maxResponseBytes: 9_000_000 },
  });

  assert.deepEqual(received, [
    {
      limit: 10,
      maxAnswerChars: 75_000,
      maxResponseBytes: 850_000,
    },
    { maxResponseBytes: 3_500_000 },
  ]);
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
