import assert from "node:assert/strict";
import test from "node:test";
import {
  codexFinalTurnAnswer,
  codexTurnHasExplicitFinalAnswer,
  claudeTranscriptHistory,
  codexThreadHistory,
  displayUserPrompt,
  mergeActiveTaskHistory,
  visibleTaskHistory,
} from "./task-history.mjs";

test("completed Codex history shows only the final answer", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-1",
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Вопрос" }] },
      { type: "agentMessage", phase: "commentary", text: "Проверяю." },
      { type: "agentMessage", phase: "final_answer", text: "Финальный ответ." },
    ],
  }]);
  assert.equal(codexFinalTurnAnswer({
    items: [{ type: "agentMessage", phase: "final_answer", text: "Финальный ответ." }],
  }), "Финальный ответ.");
  assert.equal(codexTurnHasExplicitFinalAnswer({
    status: "interrupted",
    items: [{ type: "agentMessage", phase: "final_answer", text: "Финальный ответ." }],
  }), true);
  assert.equal(codexTurnHasExplicitFinalAnswer({
    status: "interrupted",
    items: [{ type: "agentMessage", phase: "commentary", text: "Промежуточно." }],
  }), false);
  assert.equal(exchange.answer, "Финальный ответ.");
});

test("displayUserPrompt unwraps Telegram replies and removes IDE context", () => {
  assert.equal(displayUserPrompt(
    "Пользователь отвечает на сообщение:\n> Старый ответ\n\nТекст пользователя:\nПродолжай",
  ), "Продолжай");
  assert.equal(displayUserPrompt("<ide_context>служебное</ide_context>\nМой вопрос"), "Мой вопрос");
});

test("displayUserPrompt extracts comments and requests from response annotations", () => {
  const wrapper = (annotations, request = "") => [
    "# Response annotations:",
    "Technical instructions that must not be shown.",
    "<response-annotations>",
    JSON.stringify(annotations),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    request,
  ].join("\n");

  assert.equal(displayUserPrompt(wrapper([{
    text: "проверяются 25 последних потоков; окно восстановления — 30 минут;",
    annotation: "думаешь, мало?",
  }])), "думаешь, мало?");
  assert.equal(displayUserPrompt(wrapper([
    { text: "Первый фрагмент", annotation: "Первый комментарий" },
    { text: "Второй фрагмент", annotation: "Второй комментарий" },
  ], "Общий вопрос")), [
    "Аннотация 1: Первый комментарий",
    "Аннотация 2: Второй комментарий",
    "",
    "Общий вопрос",
  ].join("\n"));
  assert.equal(displayUserPrompt(wrapper([
    { text: "Выбранный фрагмент" },
  ])), "Выделено: Выбранный фрагмент");
});

test("codexThreadHistory returns user and assistant pairs", () => {
  assert.deepEqual(codexThreadHistory([{
    id: "turn-1",
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Проверь" }] },
      { type: "agentMessage", text: "Проверил" },
    ],
  }]), [{
    id: "turn-1",
    prompt: "Проверь",
    answer: "Проверил",
    status: "completed",
    active: false,
    completed: true,
  }]);
});

test("claudeTranscriptHistory separates consecutive user turns", () => {
  const line = (value) => JSON.stringify(value);
  const history = claudeTranscriptHistory([
    line({ type: "user", uuid: "u1", message: { role: "user", content: "Первый" } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Один" }], stop_reason: "end_turn" } }),
    line({ type: "user", uuid: "u2", message: { role: "user", content: [{ type: "text", text: "Второй" }] } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Два" }] } }),
  ].join("\n"));
  assert.equal(history.length, 2);
  assert.equal(history[0].completed, true);
  assert.equal(history[1].active, true);
  assert.equal(history[1].answer, "Два");
});

test("visibleTaskHistory grows newest-first window without changing chronology", () => {
  const history = [1, 2, 3, 4].map((id) => ({
    id: String(id),
    prompt: `P${id}`,
    answer: `A${id}`,
    completed: true,
  }));
  assert.deepEqual(visibleTaskHistory(history, 2), {
    items: history.slice(2),
    shown: 2,
    total: 4,
    hasMore: true,
    nextCount: 3,
  });
  assert.equal(visibleTaskHistory(history, 1).nextCount, 2);
  assert.equal(visibleTaskHistory(history, 3).nextCount, 4);
});

test("an active snapshot missing from thread history replaces the stale completed tail", () => {
  const history = [{
    id: "old-turn",
    prompt: "Старый вопрос",
    answer: "Старый ответ",
    status: "completed",
    active: false,
    completed: true,
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    answer: "Текущий частичный ответ",
  });

  assert.deepEqual(visibleTaskHistory(history, 1).items, [{
    id: "live-turn",
    prompt: "Текущее сообщение",
    answer: "Текущий частичный ответ",
    status: "inProgress",
    active: true,
    completed: false,
  }]);
});

test("an active snapshot updates the matching turn without duplicating it", () => {
  const history = [{
    id: "live-turn",
    prompt: "Новый вопрос",
    answer: "",
    status: "inProgress",
    active: true,
    completed: false,
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    answer: "Ответ формируется",
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].answer, "Ответ формируется");
});
