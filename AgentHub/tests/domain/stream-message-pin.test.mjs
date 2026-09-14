import assert from "node:assert/strict";
import test from "node:test";

import {
  durableMessageMetadata,
  durableUserCommandItemId,
  indexedDurableMessageMetadata,
  indexedDurableMessageMetadataWithEvidence,
  streamMessagePinPreview,
  withDurableMessageMetadata,
} from "../../src/domain/stream-message-pin.mjs";

test("only durable user messages and the final parent agent response are pinnable", () => {
  const turn = withDurableMessageMetadata({
    id: "turn-1",
    status: "completed",
    completed: true,
    messages: [
      { itemId: "user-1", role: "user", clientUserMessageId: "command-1", text: "Запрос" },
      { itemId: "agent-thinking", role: "agent", phase: "commentary", text: "Думаю" },
      { itemId: "subagent", role: "agent", kind: "subagent", text: "Подзадача" },
      { itemId: "agent-final", role: "agent", text: "Готово" },
    ],
  }, { provider: "codex", threadId: "thread-1" });

  assert.equal(turn.messages[0].pinEligible, true);
  assert.equal(turn.messages[1].pinEligible, false);
  assert.equal(turn.messages[2].pinEligible, false);
  assert.equal(turn.messages[3].pinEligible, true);
  assert.match(turn.messages[0].messageKey, /^message:v1:/u);
  assert.notEqual(turn.messages[0].messageKey, turn.messages[3].messageKey);
});

test("live and active messages never receive a pinnable identity", () => {
  const metadata = durableMessageMetadata({
    provider: "codex",
    threadId: "thread-1",
    turn: { id: "turn-live", status: "in_progress", active: true },
    message: { itemId: "agent-live", role: "agent" },
    finalAgentIndex: 0,
  });
  assert.equal(metadata.pinEligible, false);
  assert.equal(metadata.messageKey, "");
});

test("receipt-backed user messages use their exact command identity when provider item id is absent", () => {
  const turn = withDurableMessageMetadata({
    id: "turn-receipts",
    status: "completed",
    messages: [
      { itemId: "", role: "user", clientUserMessageId: "command-root", text: "Одинаково" },
      { itemId: "", role: "user", clientUserMessageId: "command-steer", text: "Одинаково" },
      { itemId: "answer", role: "agent", text: "Готово" },
    ],
  }, { provider: "codex", threadId: "thread-1" });

  assert.deepEqual(turn.messages.slice(0, 2).map((message) => message.itemId), [
    durableUserCommandItemId("command-root"),
    durableUserCommandItemId("command-steer"),
  ]);
  assert.equal(turn.messages[0].pinEligible, true);
  assert.equal(turn.messages[1].pinEligible, true);
  assert.notEqual(turn.messages[0].messageKey, turn.messages[1].messageKey);
  assert.notEqual(turn.messages[0].sourceAlias, turn.messages[1].sourceAlias);
});

test("command-owned locators never overwrite an existing provider item identity", () => {
  const commandId = "command-collision";
  const providerItemId = durableUserCommandItemId(commandId);
  const turn = withDurableMessageMetadata({
    id: "turn-collision",
    completed: true,
    messages: [
      { itemId: providerItemId, role: "user", text: "Provider occurrence" },
      { itemId: "", clientUserMessageId: commandId, role: "user", text: "Hub command" },
    ],
  }, { provider: "codex", threadId: "thread-1" });

  assert.equal(turn.messages[0].itemId, providerItemId);
  assert.equal(turn.messages[0].semanticSlot, "provider-item");
  assert.equal(turn.messages[0].pinEligible, true);
  assert.equal(turn.messages[1].itemId, "");
  assert.equal(turn.messages[1].pinEligible, false);
});

test("indexed durable metadata accepts only exact persisted or server-owned identity evidence", () => {
  const [first, second] = withDurableMessageMetadata({
    id: "turn-indexed",
    completed: true,
    messages: [
      { role: "user", clientUserMessageId: "command-a", text: "Одинаково" },
      { role: "user", clientUserMessageId: "command-b", text: "Одинаково" },
    ],
  }, { provider: "codex", threadId: "thread-1" }).messages;
  const indexed = (message) => ({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-indexed",
    itemId: message.itemId,
    role: message.role,
    clientUserMessageId: message.clientUserMessageId,
    messageKey: message.messageKey,
    sourceAlias: message.sourceAlias,
    semanticSlot: message.semanticSlot,
  });

  assert.equal(indexedDurableMessageMetadata(indexed(first)).pinEligible, true);
  assert.notEqual(first.messageKey, second.messageKey);
  assert.equal(indexedDurableMessageMetadata({
    ...indexed(first),
    clientUserMessageId: second.clientUserMessageId,
  }).pinEligible, false);
  assert.equal(indexedDurableMessageMetadata({
    ...indexed(first),
    sourceAlias: second.sourceAlias,
  }).pinEligible, false);

  const legacyRow = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-indexed",
    itemId: first.itemId,
    role: "user",
  };
  assert.equal(indexedDurableMessageMetadata(legacyRow).pinEligible, false);
  assert.equal(indexedDurableMessageMetadataWithEvidence(legacyRow, indexed(first)).pinEligible, true);
  assert.equal(indexedDurableMessageMetadataWithEvidence(legacyRow, {
    ...indexed(first),
    itemId: second.itemId,
  }).pinEligible, false);
});

test("message identity is stable across presentation changes and preview is bounded plain text", () => {
  const base = {
    provider: "codex",
    threadId: "thread-1",
    turn: { id: "turn-1", completed: true },
    messageIndex: 0,
    finalAgentIndex: 0,
  };
  const first = durableMessageMetadata({
    ...base,
    message: { itemId: "answer-1", role: "agent", text: "**Первая версия**" },
  });
  const second = durableMessageMetadata({
    ...base,
    message: { itemId: "answer-2", role: "agent", text: "Обновлённый текст" },
  });
  assert.equal(first.messageKey, second.messageKey);
  const preview = streamMessagePinPreview({ text: `# Заголовок\n[ссылка](https://example.test) ${"а".repeat(400)}` });
  assert.equal(preview.length, 320);
  assert.equal(preview.includes("https://"), false);
  assert.equal(preview.endsWith("…"), true);
});
