import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeResourceRegistry } from "../../src/runtime/runtime-resource-registry.mjs";

test("runtime resources execute only the requested lifecycle phase", async () => {
  const events = [];
  const resources = new RuntimeResourceRegistry({
    drain: [{ name: "writes", run: async () => events.push("drain") }],
    close: [{ name: "server", run: async () => events.push("close") }],
    releaseLock: [{ name: "lock", run: async () => events.push("lock") }],
    finalize: [{ name: "database", run: async () => events.push("finalize") }],
  });
  resources.register("quiesce", { name: "poll", run: async () => events.push("quiesce") });
  assert.equal((await resources.quiesce()).ok, true);
  await resources.drain();
  await resources.close();
  await resources.releaseLock();
  await resources.finalize();
  assert.deepEqual(events, ["quiesce", "drain", "close", "lock", "finalize"]);
});

test("runtime resources isolate failures inside a phase", async () => {
  const events = [];
  const errors = [];
  const resources = new RuntimeResourceRegistry({
    close: [
      { name: "broken", run: async () => { throw new Error("boom"); } },
      { name: "healthy", run: async () => events.push("healthy") },
    ],
    logger: { error: (...args) => errors.push(args.join(" ")) },
  });
  const result = await resources.close({ label: "Restart close failed" });
  assert.equal(result.ok, false);
  assert.deepEqual(events, ["healthy"]);
  assert.deepEqual(errors, ["Restart close failed (broken): boom"]);
});

test("runtime resources report the concrete failed component", async () => {
  const captured = [];
  const failure = new Error("close failed");
  const resources = new RuntimeResourceRegistry({
    close: [{ name: "desktop-control", run: async () => { throw failure; } }],
    logger: { error() {} },
    captureException: (error, context) => captured.push({ error, context }),
  });
  assert.equal((await resources.close()).ok, false);
  assert.deepEqual(captured, [{
    error: failure,
    context: {
      surface: "server",
      kind: "runtime-lifecycle",
      component: "resource-registry",
      action: "close:desktop-control",
    },
  }]);
});

test("runtime restart preserves transport resources that own the public listener", async () => {
  const events = [];
  const resources = new RuntimeResourceRegistry({
    close: [
      { name: "gateway", preserveOnRestart: true, run: async () => events.push("gateway") },
      { name: "local", run: async () => events.push("local") },
    ],
  });

  await resources.close({ reason: "restart" });
  assert.deepEqual(events, ["local"]);
  await resources.close({ reason: "shutdown" });
  assert.deepEqual(events, ["local", "gateway", "local"]);
});

test("runtime resources reject malformed registration and unknown phases", async () => {
  assert.throws(() => new RuntimeResourceRegistry({ drain: [{ name: "bad" }] }), /run/u);
  const resources = new RuntimeResourceRegistry();
  await assert.rejects(() => resources.run("restart"), /unsupported/u);
});
