import assert from "node:assert/strict";
import test from "node:test";

import {
  messageReceiptKey,
  messageRequestFingerprint,
  MessageReceiptRegistry,
} from "../../../src/infrastructure/persistence/message-receipts.mjs";

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

test("message receipt result can follow a deferred message into an active run", async () => {
  const fingerprint = await messageRequestFingerprint({ text: "После хода" });
  const registry = new MessageReceiptRegistry();
  registry.remember(identity, fingerprint, {
    accepted: false,
    deferred: true,
    queued: true,
    id: "queued-1",
    attachments: [{ id: "image.png", name: "image.png", type: "image/png" }],
  });

  assert.equal(registry.updateResult(identity, {
    accepted: true,
    deferred: false,
    queued: false,
    runId: "run-1",
    turnId: "turn-1",
  }), true);
  assert.deepEqual(registry.find(identity, fingerprint), {
    accepted: true,
    runId: "run-1",
    turnId: "turn-1",
    deferred: false,
    queued: false,
    id: "queued-1",
    attachments: [{ id: "image.png", name: "image.png", type: "image/png" }],
  });
  assert.equal(registry.get(identity)?.clientUserMessageId, "client-1");
  assert.equal(registry.findByTurn({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
  })?.clientUserMessageId, "client-1");
  assert.equal(registry.findByResultId("queued-1")?.clientUserMessageId, "client-1");
  assert.equal(registry.updateResult({ ...identity, clientUserMessageId: "missing" }, {}), false);
});
