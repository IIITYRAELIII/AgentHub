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

test("message receipt identity survives a provider thread rebind", () => {
  assert.equal(
    messageReceiptKey(identity),
    messageReceiptKey({ ...identity, threadId: "thread-2" }),
  );
});

test("message receipts deduplicate the same client message after a thread rebind", async () => {
  const registry = new MessageReceiptRegistry();
  const fingerprint = await messageRequestFingerprint({ text: "Проверь" });
  registry.remember(identity, fingerprint, { accepted: true, turnId: "turn-1" });

  assert.deepEqual(registry.find({ ...identity, threadId: "thread-2" }, fingerprint), {
    accepted: true,
    turnId: "turn-1",
  });
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

test("message receipts keep unresolved work and reject admission when only unresolved work remains", async () => {
  const registry = new MessageReceiptRegistry({ limit: 2 });
  const fingerprint = await messageRequestFingerprint({ text: "Сообщение" });
  registry.reserve({ ...identity, clientUserMessageId: "pending-1" }, fingerprint);
  registry.reserve({ ...identity, clientUserMessageId: "pending-2" }, fingerprint);
  assert.throws(
    () => registry.reserve({ ...identity, clientUserMessageId: "pending-3" }, fingerprint),
    (error) => error.code === "MESSAGE_RECEIPT_CAPACITY_EXHAUSTED",
  );

  const restored = new MessageReceiptRegistry({ limit: 1 });
  restored.restore([
    ...registry.snapshot(),
    {
      ...identity,
      clientUserMessageId: "terminal-1",
      fingerprint,
      result: { accepted: true, turnId: "turn-1" },
    },
  ]);
  assert.equal(restored.snapshot().length, 2);
  assert.equal(restored.get({ clientUserMessageId: "pending-1" })?.result.pending, true);
  assert.equal(restored.get({ clientUserMessageId: "terminal-1" }), null);
});
