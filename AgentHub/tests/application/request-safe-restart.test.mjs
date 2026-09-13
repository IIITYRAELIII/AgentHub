import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { requestSafeRestart } from "../../request-safe-restart.mjs";

const previousLocalAppData = process.env.LOCALAPPDATA;
const fixtureLocalAppData = fs.mkdtempSync(path.join(os.tmpdir(), "agent-hub-safe-restart-lock-"));
process.env.LOCALAPPDATA = fixtureLocalAppData;
test.after(() => {
  if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocalAppData;
  fs.rmSync(fixtureLocalAppData, { recursive: true, force: true });
});

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
