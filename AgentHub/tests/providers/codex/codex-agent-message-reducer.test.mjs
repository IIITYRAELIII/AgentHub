import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCodexAgentMessageDelta,
  completeCodexAgentMessage,
  hydrateCodexAgentMessages,
  startCodexAgentMessage,
} from "../../../src/providers/codex/codex-agent-message-reducer.mjs";

test("async question metadata cannot select a final response or steal a real final", () => {
  const run = { responseText: "", responseItems: [] };
  const question = { id: "question", type: "agentMessage", phase: "final_answer",
    text: "Choose", questions: [{ title: "Profile?", options: ["A", "B"] }] };
  startCodexAgentMessage(run, { turnId: "turn", item: question });
  appendCodexAgentMessageDelta(run, { turnId: "turn", itemId: "question", delta: " now" });
  completeCodexAgentMessage(run, { turnId: "turn", item: question });
  assert.equal(run.responseText, "");
  assert.equal(run.responseItemId, null);
  assert.deepEqual(run.responseItems[0].questions, question.questions);
  completeCodexAgentMessage(run, { turnId: "turn", item: {
    id: "answer", type: "agentMessage", phase: "final_answer", text: "Choose",
  } });
  completeCodexAgentMessage(run, { turnId: "turn", item: question });
  assert.equal(run.responseText, "Choose");
  assert.equal(run.responseItemId, "answer");
});

test("late question metadata removes the same provisional answer without dropping another item", () => {
  const run = { responseItems: [] };
  const item = { id: "question", type: "agentMessage", phase: "final_answer", text: "Choose" };
  startCodexAgentMessage(run, { turnId: "turn", item });
  assert.equal(run.responseText, "Choose");
  completeCodexAgentMessage(run, { turnId: "turn", item: {
    ...item, questions: [{ title: "Profile?", options: null }],
  } });
  assert.equal(run.responseText, "");
  hydrateCodexAgentMessages(run, [{ ...item, questions: [{ title: "Profile?", options: null }] }], { turnId: "turn" });
  assert.equal(run.responseText, "");
  assert.equal(run.responseItemId, null);
});

test("Codex agent messages remain separated by item identity", () => {
  const run = { responseText: "", responseItems: [] };
  startCodexAgentMessage(run, {
    turnId: "turn-1",
    item: { id: "commentary-1", type: "agentMessage", phase: "commentary" },
  });
  appendCodexAgentMessageDelta(run, {
    turnId: "turn-1", itemId: "commentary-1", delta: "Проверяю.",
  });
  startCodexAgentMessage(run, {
    turnId: "turn-1",
    item: { id: "answer-1", type: "agentMessage", phase: "final_answer" },
  });
  appendCodexAgentMessageDelta(run, {
    turnId: "turn-1", itemId: "answer-1", delta: "Готово.",
  });

  assert.deepEqual(run.responseItems.map(({ id, text }) => ({ id, text })), [
    { id: "commentary-1", text: "Проверяю." },
    { id: "answer-1", text: "Готово." },
  ]);
  assert.equal(run.responseItemId, "answer-1");
  assert.equal(run.responseText, "Готово.");
  assert.equal(run.responseItems[1].turnId, "turn-1");
});

test("later commentary replaces an earlier final until a newer final arrives", () => {
  const run = { responseText: "", responseItems: [] };
  completeCodexAgentMessage(run, {
    turnId: "turn-1",
    item: { id: "answer-1", type: "agentMessage", phase: "final_answer", text: "Старый итог." },
  });
  startCodexAgentMessage(run, {
    turnId: "turn-1",
    item: { id: "commentary-2", type: "agentMessage", phase: "commentary" },
  });
  appendCodexAgentMessageDelta(run, {
    turnId: "turn-1", itemId: "commentary-2", delta: "Продолжаю работу.",
  });

  assert.equal(run.responseItemId, "commentary-2");
  assert.equal(run.responseText, "Продолжаю работу.");

  completeCodexAgentMessage(run, {
    turnId: "turn-1",
    item: { id: "answer-2", type: "agentMessage", phase: "final_answer", text: "Новый итог." },
  });
  assert.equal(run.responseItemId, "answer-2");
  assert.equal(run.responseText, "Новый итог.");
});

test("Codex completed agent message replaces streamed text with canonical text", () => {
  const run = { responseText: "", responseItems: [] };
  appendCodexAgentMessageDelta(run, { turnId: "turn-1", itemId: "answer-1", delta: "Гото" });
  completeCodexAgentMessage(run, {
    turnId: "turn-1",
    item: { id: "answer-1", type: "agentMessage", phase: "final_answer", text: "Готово." },
  });
  assert.equal(run.responseText, "Готово.");
  assert.equal(run.responseItems[0].status, "completed");
});

test("Codex completed Plan becomes the final response", () => {
  const run = { responseText: "", responseItems: [] };
  completeCodexAgentMessage(run, {
    turnId: "turn-plan",
    item: { id: "plan-1", type: "plan", text: "1. Проверить\n2. Исправить" },
  });
  assert.equal(run.responseText, "1. Проверить\n2. Исправить");
  assert.equal(run.responseItemId, "plan-1");
  assert.deepEqual(run.responseItems[0], {
    id: "plan-1",
    type: "plan",
    text: "1. Проверить\n2. Исправить",
    phase: "final_answer",
    status: "completed",
    turnId: "turn-plan",
  });
});

test("Codex hydration replay appends only the missing suffix", () => {
  const run = { responseText: "", responseItems: [] };
  hydrateCodexAgentMessages(run, [{
    id: "answer-1", type: "agentMessage", phase: "final_answer", text: "Готово",
  }], { turnId: "turn-1" });
  appendCodexAgentMessageDelta(run, {
    turnId: "turn-1",
    itemId: "answer-1",
    delta: "тово!",
    hydrationReplay: true,
  });
  assert.equal(run.responseText, "Готово!");
});

test("Codex hydration restores a completed Plan as the final response", () => {
  const run = { responseText: "", responseItems: [] };
  hydrateCodexAgentMessages(run, [{
    id: "plan-1", type: "plan", text: "Итоговый план",
  }], { turnId: "turn-plan" });
  assert.equal(run.responseText, "Итоговый план");
  assert.equal(run.responseItems[0].type, "plan");
  assert.equal(run.responseItems[0].phase, "final_answer");
});

test("Codex live response turns a split response annotation marker into a citation reference", () => {
  const run = { responseText: "", responseItems: [] };
  appendCodexAgentMessageDelta(run, {
    turnId: "turn-annotation", itemId: "answer-annotation", delta: ':codex-annotation{index="',
  });
  assert.equal(run.responseText, "");
  appendCodexAgentMessageDelta(run, {
    turnId: "turn-annotation", itemId: "answer-annotation", delta: "1\"} Исправлено",
  });
  assert.equal(run.responseText, "Цитата 1\nИсправлено");
  assert.equal(run.responseItems[0].text, "Цитата 1\nИсправлено");
  assert.deepEqual(run.responseAnnotationReferences, [{ index: 1 }]);
});

test("Codex response deduplicates repeated annotation markers at the provider boundary", () => {
  const run = { responseText: "", responseItems: [] };
  completeCodexAgentMessage(run, {
    turnId: "turn-annotation-duplicate",
    item: {
      id: "answer-annotation-duplicate",
      type: "agentMessage",
      phase: "final_answer",
      text: [
        ':codex-annotation{index="1"} Первая часть',
        ':codex-annotation{index="1"} Вторая часть',
      ].join("\n"),
    },
  });
  assert.equal(run.responseText, "Цитата 1\nПервая часть\nВторая часть");
  assert.deepEqual(run.responseAnnotationReferences, [{ index: 1 }]);
});

test("Codex response rejects unsafe and out-of-contract annotation indices", () => {
  const run = { responseText: "", responseItems: [] };
  completeCodexAgentMessage(run, {
    turnId: "turn-annotation-invalid",
    item: {
      id: "answer-annotation-invalid",
      type: "agentMessage",
      phase: "final_answer",
      text: [
        ':codex-annotation{index="21"} Нет mapping',
        ':codex-annotation{index="1000000000000000000000"} Unsafe',
      ].join("\n"),
    },
  });
  assert.equal(run.responseText, "Цитата\nНет mapping\nЦитата\nUnsafe");
  assert.deepEqual(run.responseAnnotationReferences, []);
  assert.equal(run.responseText.includes("1e+21"), false);
  assert.equal(run.responseText.includes(":codex-annotation"), false);
});

test("Codex terminal response consumes complete malformed annotation payloads", () => {
  const run = { responseText: "", responseItems: [] };
  completeCodexAgentMessage(run, {
    turnId: "turn-annotation-malformed",
    item: {
      id: "answer-annotation-malformed",
      type: "agentMessage",
      phase: "final_answer",
      text: [
        ':codex-annotation{index="abc"} Nonnumeric',
        ':codex-annotation{index="-1"} Negative',
        ':codex-annotation{index="1.5"} Fractional',
        ':codex-annotation{index=""} Empty',
      ].join("\n"),
    },
  });
  assert.equal(
    run.responseText,
    "Цитата\nNonnumeric\nЦитата\nNegative\nЦитата\nFractional\nЦитата\nEmpty",
  );
  assert.deepEqual(run.responseAnnotationReferences, []);
  assert.equal(run.responseText.includes(":codex-annotation"), false);
});

test("Codex live response buffers split malformed annotation markers", () => {
  const cases = [
    { prefix: "a", suffix: "bc", answer: "Nonnumeric" },
    { prefix: "-", suffix: "1", answer: "Negative" },
    { prefix: "1.", suffix: "5", answer: "Fractional" },
    { prefix: "", suffix: "", answer: "Empty" },
  ];
  for (const [position, value] of cases.entries()) {
    const run = { responseText: "", responseItems: [] };
    const itemId = `answer-annotation-split-${position}`;
    appendCodexAgentMessageDelta(run, {
      turnId: `turn-annotation-split-${position}`,
      itemId,
      delta: `:codex-annotation{index="${value.prefix}`,
    });
    assert.equal(run.responseText, "");
    appendCodexAgentMessageDelta(run, {
      turnId: `turn-annotation-split-${position}`,
      itemId,
      delta: `${value.suffix}"} ${value.answer}`,
    });
    assert.equal(run.responseText, `Цитата\n${value.answer}`);
    assert.deepEqual(run.responseAnnotationReferences, []);
  }
});

test("Codex response keeps annotation-looking literals inside code", () => {
  const literal = [
    "Покажи literal:",
    "```text",
    ':codex-annotation{index="1"}',
    "```",
    'И inline `:codex-annotation{index="2"}` тоже.',
  ].join("\n");
  const run = { responseText: "", responseItems: [] };
  completeCodexAgentMessage(run, {
    turnId: "turn-literal",
    item: { id: "answer-literal", type: "agentMessage", phase: "final_answer", text: literal },
  });
  assert.equal(run.responseText, literal);
});
