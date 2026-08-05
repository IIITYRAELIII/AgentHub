import assert from "node:assert/strict";
import test from "node:test";

import { settleNamedOperations } from "./src/runtime/lifecycle-coordinator.mjs";

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
  assert.deepEqual(visited.sort(), ["broken", "first", "last"]);
  assert.equal(result.ok, false);
  assert.deepEqual(logged, ["broken:boom"]);
});
