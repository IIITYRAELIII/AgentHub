import assert from "node:assert/strict";
import test from "node:test";

import { runtimeStateIsIdle } from "../../src/runtime/runtime-cutover.mjs";

test("runtime cutover waits for every managed task to finish", () => {
  assert.equal(runtimeStateIsIdle({ activeRuns: [] }), true);
  assert.equal(runtimeStateIsIdle({ activeRuns: [{ turnId: "turn-1" }] }), false);
  assert.equal(runtimeStateIsIdle({}), false);
});
