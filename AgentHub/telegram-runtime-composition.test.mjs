import assert from "node:assert/strict";
import test from "node:test";

import { createDeferredCompositionPort } from "./src/composition/deferred-composition-port.mjs";
import { createTelegramRuntimeComposition } from "./src/composition/telegram-runtime-composition.mjs";

test("Telegram runtime binds shell before composing the controller", async () => {
  const calls = [];
  const telegramShell = createDeferredCompositionPort("test Telegram shell", ["sendStatus"]);
  const runtime = createTelegramRuntimeComposition({
    shell: { marker: "shell" },
    controller: { currentStatusSnapshot: () => ({ id: "current" }) },
    ports: { telegramShell },
    createShell: (options) => {
      calls.push(["shell", options.marker]);
      return {
        sendStatus: async (snapshot) => {
          calls.push(["status", snapshot.id]);
          return snapshot.id;
        },
      };
    },
    createController: (options) => {
      calls.push(["controller", typeof options.sendStatus]);
      return { pollTelegram: async () => "polled" };
    },
  });

  assert.equal(await runtime.sendStatus(), "current");
  assert.equal(await runtime.pollTelegram(), "polled");
  assert.deepEqual(calls, [
    ["shell", "shell"],
    ["controller", "function"],
    ["status", "current"],
  ]);
});
