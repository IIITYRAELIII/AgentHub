import assert from "node:assert/strict";
import test from "node:test";

import {
  messageReceiptKey,
  messageRequestFingerprint,
  MessageReceiptRegistry,
} from "./message-receipts.mjs";

const identity = {
  provider: "codex",
  threadId: "thread-1",
  clientUserMessageId: "client-1",
};

test("message receipts survive persistence and reject changed content", async () => {
  const firstFingerprint = await messageRequestFingerprint({
    text: "Проверь",
    attachments: ["first.png"],
    followUpMode: "steer",
  }, { readAttachment: async () => Buffer.from("same-image") });
  const restoredFingerprint = await messageRequestFingerprint({
    text: "Проверь",
    attachments: ["another-upload-name.png"],
    followUpMode: "steer",
  }, { readAttachment: async () => Buffer.from("same-image") });
  assert.equal(firstFingerprint, restoredFingerprint);

  const registry = new MessageReceiptRegistry();
  registry.remember(identity, firstFingerprint, {
    accepted: true,
    turnId: "turn-1",
  });
  const restored = new MessageReceiptRegistry();
  restored.restore(registry.snapshot());
  assert.deepEqual(restored.find(identity, restoredFingerprint), {
    accepted: true,
    turnId: "turn-1",
  });

  const changedFingerprint = await messageRequestFingerprint({ text: "Другой текст" });
  assert.throws(
    () => restored.find(identity, changedFingerprint),
    (error) => error.code === "MESSAGE_RECEIPT_FINGERPRINT_MISMATCH",
  );
});

test("message receipt identity includes provider and thread", () => {
  assert.notEqual(
    messageReceiptKey(identity),
    messageReceiptKey({ ...identity, threadId: "thread-2" }),
  );
});
