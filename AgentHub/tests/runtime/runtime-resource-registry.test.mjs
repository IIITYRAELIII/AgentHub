import assert from "node:assert/strict";
import test from "node:test";
import { RuntimeResourceRegistry } from "../../src/runtime/runtime-resource-registry.mjs";

test("runtime resources execute only the requested lifecycle phase", async () => {
  const events = [];
  const resources = new RuntimeResourceRegistry({
    flush: [{ name: "writes", run: async () => events.push("flush") }],
    suspend: [{ name: "server", run: async () => events.push("suspend") }],
    finalize: [{ name: "database", run: async () => events.push("finalize") }],
  });
  assert.equal((await resources.flush()).ok, true);
  assert.deepEqual(events, ["flush"]);
  await resources.suspend();
  await resources.finalize();
  assert.deepEqual(events, ["flush", "suspend", "finalize"]);
});

test("runtime resources isolate failures inside a phase", async () => {
  const events = [];
  const errors = [];
  const resources = new RuntimeResourceRegistry({
    suspend: [
      { name: "broken", run: async () => { throw new Error("boom"); } },
      { name: "healthy", run: async () => events.push("healthy") },
    ],
    logger: { error: (...args) => errors.push(args.join(" ")) },
  });
  const result = await resources.suspend({ label: "Restart close failed" });
  assert.equal(result.ok, false);
  assert.deepEqual(events, ["healthy"]);
  assert.deepEqual(errors, ["Restart close failed (broken): boom"]);
});

test("runtime resources reject malformed registration and unknown phases", async () => {
  assert.throws(() => new RuntimeResourceRegistry({ flush: [{ name: "bad" }] }), /run/u);
  const resources = new RuntimeResourceRegistry();
  await assert.rejects(() => resources.run("restart"), /unsupported/u);
});
