import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DurableApplicationCommandDispatcher } from "../../src/application/durable-application-command-dispatcher.mjs";
import { DurableCommandReceipts } from "../../src/infrastructure/persistence/durable-command-receipts.mjs";

test("Telegram application commands replay once and retire after offset persistence", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-command-dispatcher-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  let effects = 0;
  const receipts = new DurableCommandReceipts({ file: path.join(root, "receipts.json") });
  const dispatcher = new DurableApplicationCommandDispatcher({
    receipts,
    dispatch: async () => ({ sequence: ++effects }),
  });
  const commandContext = {
    source: "telegram",
    clientId: "telegram:7",
    commandId: "message:7:9",
  };
  assert.deepEqual(await dispatcher.dispatch("task.create", {}, commandContext), { sequence: 1 });
  assert.deepEqual(await dispatcher.dispatch("task.create", {}, commandContext), { sequence: 1 });
  assert.equal(effects, 1);
  assert.equal(await dispatcher.acknowledgeUpdate({ message: { chat: { id: 7 }, message_id: 9 } }), 1);
  assert.deepEqual(await dispatcher.dispatch("task.create", {}, commandContext), { sequence: 2 });
});

test("non-Telegram commands bypass Telegram receipts", async () => {
  const calls = [];
  const dispatcher = new DurableApplicationCommandDispatcher({
    receipts: { execute: async () => assert.fail("receipt must not run"), forgetPrefix: async () => 0 },
    dispatch: async (...args) => { calls.push(args); return "ok"; },
  });
  assert.equal(await dispatcher.dispatch("task.create", {}, { source: "desktop" }), "ok");
  assert.equal(calls.length, 1);
});
