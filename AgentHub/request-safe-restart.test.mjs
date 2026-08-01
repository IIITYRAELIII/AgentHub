import assert from "node:assert/strict";
import test from "node:test";

import { requestSafeRestart } from "./request-safe-restart.mjs";

test("safe restart helper uses authenticated desktop control", async () => {
  const events = [];
  const result = await requestSafeRestart({
    restart: async (action) => {
      events.push(action);
      return { message: "scheduled" };
    },
    log: (message) => events.push(message),
  });

  assert.deepEqual(events, ["restart-server", "scheduled"]);
  assert.deepEqual(result, { message: "scheduled" });
});
