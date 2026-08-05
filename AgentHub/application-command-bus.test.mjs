import assert from "node:assert/strict";
import test from "node:test";
import { ApplicationCommandBus } from "./src/application/application-command-bus.mjs";

test("command bus requires a client and an explicit target when declared", async () => {
  const bus = new ApplicationCommandBus().register("task.rename", {
    handler: ({ target, context }) => ({ target, context }),
    target: "required",
  });
  await assert.rejects(bus.dispatch({ type: "task.rename" }), /clientId is required/u);
  await assert.rejects(bus.dispatch({
    type: "task.rename",
    context: { clientId: "desktop" },
  }), /requires an explicit task target/u);
  const result = await bus.dispatch({
    type: "task.rename",
    target: { provider: "codex", threadId: "thread-1" },
    context: { clientId: "desktop" },
  });
  assert.equal(result.target.threadId, "thread-1");
  assert.equal(result.context.clientId, "desktop");
});

test("target lanes serialize one task without blocking another", async () => {
  const events = [];
  const releases = new Map();
  const bus = new ApplicationCommandBus().register("task.write", {
    mutating: true,
    target: "required",
    lane: "target",
    handler: async ({ payload, target }) => {
      events.push(`start:${payload.id}`);
      await new Promise((resolve) => releases.set(payload.id, resolve));
      events.push(`end:${payload.id}`);
      return target.threadId;
    },
  });
  const dispatch = (id, threadId) => bus.dispatch({
    type: "task.write",
    payload: { id },
    target: { provider: "codex", threadId },
    context: { clientId: "test" },
  });
  const first = dispatch("a1", "a");
  const second = dispatch("a2", "a");
  const parallel = dispatch("b1", "b");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:a1", "start:b1"]);
  releases.get("b1")();
  await parallel;
  releases.get("a1")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:a1", "start:b1", "end:b1", "end:a1", "start:a2"]);
  releases.get("a2")();
  await Promise.all([first, second]);
});

test("hubTaskId is the preferred target lane over provider thread identity", async () => {
  const events = [];
  let release;
  const bus = new ApplicationCommandBus().register("task.write", {
    mutating: true,
    target: "required",
    lane: "target",
    handler: async ({ payload }) => {
      events.push(payload.id);
      if (payload.id === "old-thread") await new Promise((resolve) => { release = resolve; });
    },
  });
  const oldThread = bus.dispatch({
    type: "task.write",
    payload: { id: "old-thread" },
    target: { hubTaskId: "hub-1", provider: "codex", threadId: "thread-1" },
    context: { clientId: "desktop" },
  });
  const newThread = bus.dispatch({
    type: "task.write",
    payload: { id: "new-thread" },
    target: { hubTaskId: "hub-1", provider: "codex", threadId: "thread-2" },
    context: { clientId: "telegram" },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["old-thread"]);
  release();
  await Promise.all([oldThread, newThread]);
  assert.deepEqual(events, ["old-thread", "new-thread"]);
});

test("global mutations recover their lane after a rejected command", async () => {
  const events = [];
  const bus = new ApplicationCommandBus().register("task.create", {
    mutating: true,
    target: "none",
    lane: "global",
    handler: async ({ payload }) => {
      events.push(payload.id);
      if (payload.fail) throw new Error("failed");
      return payload.id;
    },
  });
  await assert.rejects(bus.dispatch({
    type: "task.create",
    payload: { id: "first", fail: true },
    context: { clientId: "desktop" },
  }), /failed/u);
  assert.equal(await bus.dispatch({
    type: "task.create",
    payload: { id: "second" },
    context: { clientId: "telegram" },
  }), "second");
  assert.deepEqual(events, ["first", "second"]);
});
