import assert from "node:assert/strict";
import test from "node:test";

import {
  durableMessageMetadata,
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
