import assert from "node:assert/strict";
import test from "node:test";

import {
  appendCodexAgentMessageDelta,
  completeCodexAgentMessage,
  hydrateCodexAgentMessages,
  startCodexAgentMessage,
} from "../../../src/providers/codex/codex-agent-message-reducer.mjs";

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
