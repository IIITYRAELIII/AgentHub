import assert from "node:assert/strict";
import test from "node:test";

import {
  LifecycleOperationTimeoutError,
  settleNamedOperations,
} from "../../src/runtime/lifecycle-coordinator.mjs";

test("lifecycle operations all run even when one close fails", async () => {
  const visited = [];
  const logged = [];
  const result = await settleNamedOperations([
    { name: "first", run: async () => { visited.push("first"); } },
    { name: "broken", run: async () => { visited.push("broken"); throw new Error("boom"); } },
    { name: "last", run: async () => { visited.push("last"); } },
  ], {
    logError: (name, error) => logged.push(`${name}:${error.message}`),
  });
  assert.deepEqual(visited, ["first", "broken", "last"]);
  assert.equal(result.ok, false);
  assert.deepEqual(logged, ["broken:boom"]);
});

test("lifecycle timeout stops the phase before later operations start", async () => {
  const completed = [];
  const result = await settleNamedOperations([
    { name: "stuck", run: () => new Promise(() => {}) },
    { name: "healthy", run: async () => completed.push("healthy") },
  ], { timeoutMs: 5 });

  assert.deepEqual(completed, []);
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].name, "stuck");
  assert.equal(result.failures[0].error instanceof LifecycleOperationTimeoutError, true);
});
