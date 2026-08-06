import assert from "node:assert/strict";
import test from "node:test";

import { DeferredInputPresentationService } from "../../../src/interfaces/desktop/deferred-input-presentation-service.mjs";

function fixture() {
  const updates = [];
  const calls = [];
  return {
    updates,
    calls,
    value: new DeferredInputPresentationService({
      telegram: async (...args) => calls.push(args),
      receipts: {
        updateResult: (identity, result) => { updates.push({ identity, result }); return true; },
      },
      describeAttachments: (files) => files.map((path) => ({ path })),
    }),
  };
}

const item = {
  id: "deferred-1",
  provider: "codex",
  threadId: "thread-1",
  clientUserMessageId: "client-1",
  chatId: 7,
  messageId: 8,
  conflictKind: "task-running",
  persistentFiles: true,
  temporaryFiles: ["shot.png"],
};

test("started deferred input becomes one accepted receipt with preserved attachments", () => {
  const setup = fixture();
  setup.value.updateDesktopReceipt(item, "started", { id: "run-1", turnId: "turn-1" });
  assert.equal(setup.updates[0].result.deferred, false);
  assert.equal(setup.updates[0].result.runId, "run-1");
  assert.deepEqual(setup.updates[0].result.attachments, [{ path: "shot.png" }]);
});

test("dispatching and pending states cannot look sent or completed", () => {
  const setup = fixture();
  setup.value.updateDesktopReceipt(item, "dispatching");
  setup.value.updateDesktopReceipt(item, "pending");
  assert.deepEqual(setup.updates.map(({ result }) => ({
    accepted: result.accepted,
    deferred: result.deferred,
    queued: result.queued,
    dispatching: result.dispatching,
    reason: result.reason,
  })), [
    { accepted: false, deferred: true, queued: true, dispatching: true, reason: "task-running" },
    { accepted: false, deferred: true, queued: false, dispatching: false, reason: "launch-failed" },
  ]);
});

test("Telegram card update keeps the exact deferred message address", async () => {
  const setup = fixture();
  await setup.value.updateTelegramMessage(item, "waiting");
  assert.deepEqual(setup.calls[0], ["editMessageText", {
    chat_id: 7,
    message_id: 8,
    text: "waiting",
    reply_markup: { inline_keyboard: [] },
  }]);
});
