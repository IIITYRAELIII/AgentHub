import assert from "node:assert/strict";
import test from "node:test";

import { DeferredInputPresentationService } from "../../../src/interfaces/desktop/deferred-input-presentation-service.mjs";
import { MessageReceiptRegistry } from "../../../src/infrastructure/persistence/message-receipts.mjs";

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
  setup.value.updateDesktopReceipt(item, "started", {
    id: "run-1",
    turnId: "turn-1",
    startedAt: "2026-08-13T01:31:00.000Z",
  });
  assert.equal(setup.updates[0].result.deferred, false);
  assert.equal(setup.updates[0].result.dispatching, false);
  assert.equal(setup.updates[0].result.steered, false);
  assert.equal(setup.updates[0].result.runId, "run-1");
  assert.equal(setup.updates[0].result.deliveredAt, "2026-08-13T01:31:00.000Z");
  assert.deepEqual(setup.updates[0].result.attachments, [{ path: "shot.png" }]);
});

test("deferred state transitions never regress an existing durable acceptance", () => {
  const setup = fixture();
  setup.value.updateDesktopReceipt(item, "dispatching");
  setup.value.updateDesktopReceipt(item, "reconciling");
  setup.value.updateDesktopReceipt(item, "pending");
  assert.deepEqual(setup.updates.map(({ result }) => ({
    overwritesAccepted: Object.hasOwn(result, "accepted"),
    deferred: result.deferred,
    queued: result.queued,
    dispatching: result.dispatching,
    reason: result.reason,
  })), [
    { overwritesAccepted: false, deferred: true, queued: true, dispatching: true, reason: "task-running" },
    { overwritesAccepted: false, deferred: true, queued: true, dispatching: true, reason: "provider-start-unconfirmed" },
    { overwritesAccepted: false, deferred: true, queued: false, dispatching: false, reason: "launch-failed" },
  ]);
  assert.match(setup.updates[1].result.message, /без повторной отправки/u);
});

test("durable acceptance stays true through provider-start reconciliation", () => {
  const receipts = new MessageReceiptRegistry();
  const identity = {
    provider: item.provider,
    threadId: item.threadId,
    clientUserMessageId: item.clientUserMessageId,
  };
  receipts.reserve(identity, "fingerprint", { accepted: true, deferred: true, queued: true });
  const service = new DeferredInputPresentationService({
    telegram: async () => {},
    receipts,
    describeAttachments: () => [],
  });

  service.updateDesktopReceipt(item, "dispatching");
  service.updateDesktopReceipt(item, "reconciling");
  service.updateDesktopReceipt(item, "pending");

  assert.equal(receipts.get(identity).result.accepted, true);
  assert.equal(receipts.get(identity).result.reason, "launch-failed");
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
