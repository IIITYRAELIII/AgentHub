import assert from "node:assert/strict";
import test from "node:test";

import { RestartNotificationService } from "../../../src/interfaces/telegram/restart-notification-service.mjs";

function fixture(request = { chatId: 7, messageId: null }) {
  const calls = [];
  let current = request;
  return {
    calls,
    request,
    current: () => current,
    value: new RestartNotificationService({
      getRequest: () => current,
      setRequest: (value) => { current = value; },
      isStopping: () => false,
      sendMessage: async (...args) => { calls.push(["send", ...args]); return { message_id: 8 }; },
      telegram: async (...args) => calls.push(["telegram", ...args]),
      saveState: async () => calls.push(["save"]),
      formatCompleteMessage: ({ task }) => `Complete ${task}`,
      completeMessageState: () => ({ task: "Task" }),
      menu: { keyboard: [] },
      finalizeReplacement: async (operations) => { await operations.updateMessage(); return true; },
      logger: { warn() {}, error() {} },
    }),
  };
}

test("Desktop restart announcement persists the returned Telegram message id", async () => {
  const setup = fixture();
  assert.equal(await setup.value.announceDesktop(setup.request, 2), true);
  assert.equal(setup.request.messageId, 8);
  assert.deepEqual(setup.calls.map(([kind]) => kind), ["send", "save"]);
});

test("restart completion edits the original card when it remains addressable", async () => {
  const setup = fixture({ chatId: 7, messageId: 8 });
  assert.equal(await setup.value.finalize(), true);
  assert.deepEqual(setup.calls[0], ["telegram", "editMessageText", {
    chat_id: 7,
    message_id: 8,
    text: "Complete Task",
    parse_mode: "HTML",
  }]);
});

test("restart completion sends a replacement and clears an unaddressable request", async () => {
  const setup = fixture({ chatId: 7, messageId: null });
  assert.equal(await setup.value.finalize(), true);
  assert.equal(setup.current(), null);
  assert.deepEqual(setup.calls.map(([kind]) => kind), ["send", "save"]);
});
