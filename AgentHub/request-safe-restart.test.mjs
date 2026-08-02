import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("Desktop restart acknowledges the persisted request before Telegram notification", async () => {
  const source = await readFile(new URL("./agent-hub-server.mjs", import.meta.url), "utf8");
  const start = source.indexOf("async function desktopRestartServer()");
  const end = source.indexOf("\nasync function desktopNewTask", start);
  const body = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(body, /restartRequest = \{/u);
  assert.match(body, /await saveState\(\);[\s\S]*?void announceDesktopRestart\(request, blockingWorkCount\);/u);
  assert.doesNotMatch(body, /await sendMessage\(/u);
  assert.doesNotMatch(body, /snapshot: await desktopSnapshot\(\)/u);
});
