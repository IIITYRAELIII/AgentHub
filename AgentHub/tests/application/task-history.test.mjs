import assert from "node:assert/strict";
import test from "node:test";
import { createInterstreamMessage } from "../../src/domain/interstream-message.mjs";
import { messageWithTaskReferences } from "../../src/domain/task-board-task.mjs";
import { codexRolloutHistory } from "../../src/interfaces/telegram/task-view-controller.mjs";
import { parseCodexRolloutActivity } from "../../src/providers/codex/codex-rollout-activity.mjs";
import {
  codexExplicitFinalTurnAnswer,
  codexFinalTurnAnswer,
  codexSubagentNotificationDetails,
  codexTurnHasExplicitFinalAnswer,
  claudeTranscriptHistory,
  codexThreadHistory,
  codexTurnActivityGroups,
  codexTurnActivities,
  displayUserPrompt,
  exactTurnReceiptBindings,
  isEmptyTurnCompletionPlaceholder,
  mergeSyntheticRolloutUsers,
  responseAnnotationDetails,
  mergeActiveTaskHistory,
  mergeCompletedTaskHistory,
  visibleTaskHistory,
  withoutMisclassifiedSubagentUsers,
} from "../../src/application/task-history.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../src/domain/codex-context-probe.mjs";

test("subagent occurrence repair fails closed without unique unbound source evidence", () => {
  const sourceOccurrenceId = `codex-rollout:${"b".repeat(64)}`;
  const oldUser = { role: "user", itemId: "old-id", text: "Old text", sourceOccurrenceId };
  const subagent = {
    role: "agent", kind: "subagent", agentThreadId: "child", itemId: "new-id", text: "New text", sourceOccurrenceId,
  };
  assert.deepEqual(withoutMisclassifiedSubagentUsers([oldUser], [subagent]), []);
  for (const [current, observed] of [
    [[{ ...oldUser, sourceOccurrenceId: "" }], [subagent]],
    [[oldUser], [{ ...subagent, sourceOccurrenceId: `codex-rollout:${"c".repeat(64)}` }]],
    [[{ ...oldUser, sourceOccurrenceId: "provider-controlled" }], [{ ...subagent, sourceOccurrenceId: "provider-controlled" }]],
    [[{ ...oldUser, clientUserMessageId: "user-client" }], [subagent]],
    [[{ ...oldUser, origin: { requestId: "retained-origin" } }], [subagent]],
    [[oldUser], [{ ...subagent, clientUserMessageId: "other-client" }]],
    [[oldUser], [{ ...subagent, agentThreadId: "" }]],
    [[oldUser], [{ ...subagent, kind: "" }]],
    [[oldUser, { ...oldUser }], [subagent]],
    [[oldUser], [subagent, { ...subagent }]],
  ]) {
    assert.deepEqual(withoutMisclassifiedSubagentUsers(current, observed), current);
  }
});

test("rollout history retains subagent authors and real users through the catalog adapter", () => {
  const turnId = "turn-subagent-history";
  const notification = `<subagent_notification>${JSON.stringify({
    agent_path: "child-history", model: "gpt-5.6-terra", status: { completed: "Отчёт" },
  })}</subagent_notification>`;
  const activity = parseCodexRolloutActivity([
    { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
    { type: "response_item", payload: {
      type: "message", id: "msg-provider-child", role: "user",
      content: [{ type: "input_text", text: notification }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } },
  ].map((entry) => JSON.stringify(entry)).join("\n"));
  activity.userMessages[turnId].push({
    itemId: "real-user", role: "user", clientUserMessageId: "real-client", text: "Отчёт",
  });
  const [history] = codexRolloutHistory(activity);
  assert.deepEqual(history.messages.map(({ role, kind, author, text }) => ({ role, kind, author, text })), [
    { role: "agent", kind: "subagent", author: "Субагент (Terra)", text: "Отчёт" },
    { role: "user", kind: undefined, author: undefined, text: "Отчёт" },
  ]);
  assert.equal(history.messages[0].itemId, "msg-provider-child");
  assert.equal(history.messages[0].agentThreadId, "child-history");
  assert.equal(history.messages[1].clientUserMessageId, "real-client");
  const [notificationOnly] = codexRolloutHistory({
    userMessages: { [turnId]: [activity.userMessages[turnId][0]] },
  });
  assert.equal(notificationOnly.prompt, "");
  assert.equal(notificationOnly.userMessagesObserved, false);
  assert.equal(notificationOnly.messages.length, 1);
});

test("rollout history preserves image sources and strips only trusted interstream wrappers", () => {
  const origin = {
    kind: "interstream", workspaceId: "hub", workspaceName: "Agent HUB",
    streamId: "themes", streamName: "Themes", provider: "codex", model: "gpt-5.6-terra",
    sourceThreadId: "themes-thread", requestId: "design-review",
  };
  const wrapper = createInterstreamMessage({ ...origin, text: "Проверь дизайн" });
  const images = ["first.png", "second.png"].map((name) => ({ type: "path", value: `attachments/${name}` }));
  const [history] = codexRolloutHistory({ userMessages: { "turn-images": [
    { role: "user", itemId: "image-user", clientUserMessageId: "client-image", text: "Проверь", attachmentSources: images },
    { role: "user", itemId: "trusted", clientUserMessageId: "mcp:design-review", origin, text: wrapper },
    { role: "user", itemId: "literal", clientUserMessageId: "literal-client", text: wrapper },
    { role: "user", itemId: "image-only", text: "", attachmentSources: images },
    { role: "user", itemId: "conflicting", clientUserMessageId: "mcp:design-review", origin,
      text: createInterstreamMessage({ ...origin, sourceThreadId: "foreign-thread", text: "Keep literal" }) },
  ] } });
  assert.deepEqual(history.messages[0].attachmentSources, images);
  assert.equal(history.messages[1].text, "Проверь дизайн");
  assert.deepEqual(history.messages[1].origin, origin);
  assert.equal(history.messages[1].author, "Agent HUB - Themes (Terra)");
  assert.equal(history.messages[2].text, wrapper);
  assert.equal(history.messages[2].author, undefined);
  assert.deepEqual(history.messages[3].attachmentSources, images);
  assert.ok(history.messages[4].text.startsWith("<agent-hub-stream-message>"));
});

test("completed history overlay replaces a stale live answer immediately", () => {
  const history = [{
    id: "turn-1",
    active: true,
    completed: false,
    status: "inProgress",
    answer: "Промежуточный текст",
    messages: [{
      itemId: "turn-1:agent:live",
      role: "agent",
      text: "Промежуточный текст",
    }],
  }];

  mergeCompletedTaskHistory(history, {
    turnId: "turn-1",
    answer: "Финальный ответ",
    completedAt: "2026-08-03T12:00:00.000Z",
    terminalRevision: 2,
  });

  assert.equal(history[0].active, false);
  assert.equal(history[0].completed, true);
  assert.equal(history[0].status, "completed");
  assert.equal(history[0].answer, "Финальный ответ");
  assert.equal(history[0].messages[0].text, "Финальный ответ");
  assert.equal(history[0].messages[0].phase, "final");
  assert.equal(history[0].terminalRevision, 2);
});

test("completed history overlay preserves the live activity trace", () => {
  const activities = [{ id: "tool-1", type: "command" }];
  const activityGroups = [{ id: "group-1", reasoning: "Проверяю.", activities }];
  const history = [{
    id: "turn-1",
    active: true,
    answer: "Промежуточный текст",
    activities,
    activityGroups,
    messages: [{ itemId: "turn-1:agent:live", role: "agent", text: "Промежуточный текст" }],
  }];

  mergeCompletedTaskHistory(history, { turnId: "turn-1", answer: "Финальный ответ" });

  assert.deepEqual(history[0].activities, activities);
  assert.deepEqual(history[0].activityGroups, activityGroups);
});

test("completed history keeps independent turns with identical answers", () => {
  const history = [{
    id: "turn-user",
    prompt: "Вопрос",
    answer: "Готово",
    completed: true,
    messages: [{ role: "agent", text: "Готово" }],
  }];

  mergeCompletedTaskHistory(history, {
    turnId: "turn-second",
    answer: "Готово",
  });

  assert.equal(history.length, 2);
  assert.equal(history[0].id, "turn-user");
  assert.equal(history[1].id, "turn-second");
});

test("empty completion placeholder is recognized only without user input", () => {
  assert.equal(isEmptyTurnCompletionPlaceholder({
    prompt: "",
    answer: "Ход завершён без текстового ответа.",
    messages: [{ role: "agent", text: "Ход завершён без текстового ответа." }],
  }), true);
  assert.equal(isEmptyTurnCompletionPlaceholder({
    prompt: "Рабочий запрос",
    answer: "Ход завершён без текстового ответа.",
  }), false);
});

test("completed history overlay preserves the canonical completion time", () => {
  const history = [{
    id: "turn-1",
    answer: "Финальный ответ",
    completed: true,
    completedAt: "2026-08-04T01:53:46.371Z",
    messages: [{
      itemId: "turn-1:agent:final",
      role: "agent",
      text: "Финальный ответ",
      time: "2026-08-04T01:53:46.371Z",
    }],
  }];

  mergeCompletedTaskHistory(history, {
    turnId: "turn-1",
    answer: "Финальный ответ",
    completedAt: "2026-08-04T03:52:00.000Z",
  });

  assert.equal(history[0].completedAt, "2026-08-04T01:53:46.371Z");
  assert.equal(history[0].messages[0].time, "2026-08-04T01:53:46.371Z");
});

test("Codex history hides the internal context probe exchange", () => {
  const turn = {
    id: "probe-turn",
    status: "completed",
    items: [
      {
        id: "probe-user",
        type: "userMessage",
        clientId: "agent-hub-context-probe:test",
        content: [{ type: "text", text: CODEX_CONTEXT_PROBE_PROMPT }],
      },
      {
        id: "probe-agent",
        type: "agentMessage",
        text: CODEX_CONTEXT_PROBE_RESPONSE,
        phase: "final_answer",
      },
    ],
  };

  assert.deepEqual(codexThreadHistory([turn]), []);
  assert.equal(codexFinalTurnAnswer(turn), "");
});

test("Codex history keeps reserved probe text for a normal client identity", () => {
  const turn = {
    id: "manual-probe-text",
    status: "completed",
    items: [{
      id: "manual-user",
      type: "userMessage",
      clientId: "client-manual-probe",
      content: [{ type: "text", text: CODEX_CONTEXT_PROBE_PROMPT }],
    }, {
      id: "manual-agent",
      type: "agentMessage",
      text: CODEX_CONTEXT_PROBE_RESPONSE,
      phase: "final_answer",
    }],
  };

  const history = codexThreadHistory([turn]);
  assert.equal(history.length, 1);
  assert.equal(history[0].prompt, CODEX_CONTEXT_PROBE_PROMPT);
  assert.equal(history[0].answer, CODEX_CONTEXT_PROBE_RESPONSE);
  assert.equal(codexFinalTurnAnswer(turn), CODEX_CONTEXT_PROBE_RESPONSE);
});

test("Codex history preserves a safe activity feed", () => {
  const activities = codexTurnActivities({
    items: [
      { id: "cmd", type: "commandExecution", command: "npm test" },
      { id: "file", type: "fileChange", changes: [{ path: "app.js" }] },
      { id: "bad-cmd", type: "commandExecution", command: "npm run broken", status: "failed", exitCode: 1 },
      { id: "bad-file", type: "fileChange", status: "failed", changes: [{ path: "bad.js" }] },
      { id: "compact", type: "contextCompaction" },
    ],
  });
  assert.deepEqual(activities.map((item) => item.type), ["command", "file", "command", "file", "compaction"]);
  assert.equal(activities[0].detail, "npm test");
  assert.equal(activities[2].status, "failed");
  assert.equal(activities[3].status, "failed");
});

test("Codex history groups tool calls between reasoning blocks", () => {
  const groups = codexTurnActivityGroups({
    items: [
      { id: "think-1", type: "reasoning", summary: ["**Проверяю проект**\n\nИщу нужный модуль."] },
      { id: "cmd-1", type: "commandExecution", command: "rg handler" },
      { id: "cmd-2", type: "commandExecution", command: "npm test" },
      { id: "think-2", type: "reasoning", summary: [{ text: "**Исправляю**\n\nПричина найдена." }] },
      { id: "file-1", type: "fileChange", changes: [{ path: "app.js" }] },
    ],
  });

  assert.deepEqual(groups.map((group) => ({
    reasoning: group.reasoning,
    activities: group.activities.map((activity) => activity.id),
  })), [{
    reasoning: "**Проверяю проект**\n\nИщу нужный модуль.",
    activities: ["item:cmd-1", "item:cmd-2"],
  }, {
    reasoning: "**Исправляю**\n\nПричина найдена.",
    activities: ["item:file-1"],
  }]);
});

test("Codex history uses visible commentary as reasoning blocks", () => {
  const groups = codexTurnActivityGroups({
    items: [
      { id: "hidden-1", type: "reasoning", summary: [] },
      { id: "comment-1", type: "agentMessage", phase: "commentary", text: "Проверяю причину." },
      { id: "cmd-1", type: "commandExecution", command: "npm test", status: "completed" },
      { id: "comment-2", type: "agentMessage", phase: "commentary", text: "Исправляю отображение." },
      { id: "cmd-2", type: "commandExecution", command: "npm run check", status: "completed" },
      { id: "final", type: "agentMessage", phase: "final_answer", text: "Готово." },
    ],
  });
  assert.deepEqual(groups.map((group) => ({
    reasoning: group.reasoning,
    activities: group.activities.map((activity) => activity.id),
  })), [{
    reasoning: "Проверяю причину.",
    activities: ["item:cmd-1"],
  }, {
    reasoning: "Исправляю отображение.",
    activities: ["item:cmd-2"],
  }]);
});

test("Codex history keeps only real subagent lifecycle events", () => {
  const activities = codexTurnActivities({
    items: [
      { id: "message", type: "agentMessage", text: "Обычный ответ" },
      { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", status: "completed" },
      { id: "started", type: "subAgentActivity", kind: "started", agentPath: "/root/check" },
      { id: "done", type: "collabAgentToolCall", tool: "wait", status: "completed", agentsStates: {
        child: { status: "completed", message: "Готово" },
      } },
    ],
  });
  assert.deepEqual(activities.map(({ label }) => label), [
    "Субагент запущен",
    "Субагент начал работу",
    "Субагент завершил работу",
  ]);
});

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
  assert.equal(codexExplicitFinalTurnAnswer({
    items: [{ type: "agentMessage", phase: "commentary", text: "Промежуточно." }],
  }), "");
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

test("completed history never overwrites a subagent with the parent final", () => {
  const history = [{
    id: "turn-1",
    active: true,
    messages: [{
      itemId: "turn-1:subagent:child-1",
      role: "agent",
      kind: "subagent",
      author: "Субагент (Terra)",
      agentThreadId: "child-1",
      model: "gpt-5.6-terra",
      text: "Найден дефект.",
    }],
  }];

  mergeCompletedTaskHistory(history, { turnId: "turn-1", answer: "Общий итог." });

  assert.equal(history[0].messages.length, 2);
  assert.equal(history[0].messages[0].text, "Найден дефект.");
  assert.equal(history[0].messages[0].kind, "subagent");
  assert.deepEqual(history[0].messages[1], {
    itemId: "turn-1:agent:final",
    role: "agent",
    phase: "final",
    text: "Общий итог.",
  });
});

test("Codex history renders subagent notifications as model-authored messages", () => {
  const notification = `<subagent_notification>\n${JSON.stringify({
    agent_path: "child-terra",
    status: { completed: "Проверка завершена.\nНайден дефект." },
  })}\n</subagent_notification>`;
  const [exchange] = codexThreadHistory([{
    id: "turn-subagent",
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Проверь архитектуру" }] },
      {
        type: "collabAgentToolCall",
        tool: "spawnAgent",
        model: "gpt-5.6-terra",
        receiverThreadIds: ["child-terra"],
      },
      { id: "subagent-result", type: "userMessage", content: [{ type: "text", text: notification }] },
      { type: "agentMessage", phase: "final_answer", text: "Объединил результаты." },
    ],
  }]);

  assert.deepEqual(exchange.messages.map(({ role, author, kind, text }) => ({ role, author, kind, text })), [{
    role: "user", author: undefined, kind: undefined, text: "Проверь архитектуру",
  }, {
    role: "agent", author: "Субагент (Terra)", kind: "subagent", text: "Проверка завершена.\nНайден дефект.",
  }, {
    role: "agent", author: undefined, kind: undefined, text: "Объединил результаты.",
  }]);
  assert.equal(displayUserPrompt(notification), "");
  assert.equal(codexSubagentNotificationDetails(notification).agentThreadId, "child-terra");
});

test("completed Codex Plan is shown as the final answer in restored history", () => {
  const turn = {
    id: "turn-plan",
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Составь план" }] },
      { id: "plan-1", type: "plan", text: "1. Анализ\n2. Реализация" },
    ],
  };
  const [exchange] = codexThreadHistory([turn]);
  assert.equal(codexFinalTurnAnswer(turn), "1. Анализ\n2. Реализация");
  assert.equal(codexTurnHasExplicitFinalAnswer(turn), true);
  assert.equal(exchange.answer, "1. Анализ\n2. Реализация");
  assert.deepEqual(exchange.messages.at(-1), {
    itemId: "plan-1",
    role: "agent",
    text: "1. Анализ\n2. Реализация",
    phase: "final_answer",
  });
});

test("displayUserPrompt unwraps Telegram replies and removes IDE context", () => {
  assert.equal(displayUserPrompt(
    "Пользователь отвечает на сообщение:\n> Старый ответ\n\nТекст пользователя:\nПродолжай",
  ), "Продолжай");
  assert.equal(displayUserPrompt("<ide_context>служебное</ide_context>\nМой вопрос"), "Мой вопрос");
});

test("Codex internal prompt envelopes never become user messages", () => {
  const internal = [
    "<skills_instructions>",
    "## Skills",
    "Service-only skill catalog.",
    "</skills_instructions>",
  ].join("\n");
  assert.equal(displayUserPrompt(internal), "");
  assert.equal(displayUserPrompt([
    '<codex_internal_context source="goal">',
    "служебное продолжение цели",
    "</codex_internal_context>",
  ].join("\n")), "");

  const [exchange] = codexThreadHistory([{
    id: "turn-with-delayed-user-item",
    status: "inProgress",
    items: [
      { type: "userMessage", content: [{ type: "input_text", text: internal }] },
      { type: "userMessage", content: [{ type: "input_text", text: "Настоящий запрос" }] },
    ],
  }]);

  assert.equal(exchange.prompt, "Настоящий запрос");
  assert.deepEqual(exchange.messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Настоящий запрос" },
  ]);
});

test("provider history preserves a literal inter-Stream envelope without durable identity", () => {
  const prompt = [
    "<agent-hub-stream-message>",
    JSON.stringify({
      workspaceId: "workspace-1",
      workspaceName: "Agent Hub",
      streamId: "stream-1",
      streamName: "Architect",
      provider: "codex",
    }),
    "</agent-hub-stream-message>",
    "Release the ready changes.",
  ].join("\n");
  const [exchange] = codexThreadHistory([{
    id: "turn-stream-message",
    status: "inProgress",
    items: [{ type: "userMessage", content: [{ type: "text", text: prompt }] }],
  }]);
  assert.equal(displayUserPrompt(prompt), prompt);
  assert.equal(exchange.prompt, prompt);
  assert.equal(exchange.messages[0].author, undefined);
});

test("legacy envelope shape alone does not assign an inter-Stream author", () => {
  const prompt = [
    "<agent-hub-stream-message>",
    JSON.stringify({
      workspaceId: "workspace-1",
      workspaceName: "Agent Hub",
      streamId: "stream-1",
      streamName: "Architect",
    }),
    "</agent-hub-stream-message>",
    "Legacy message.",
  ].join("\n");
  const [exchange] = codexThreadHistory([{
    id: "turn-legacy-stream-message",
    status: "completed",
    items: [{ type: "userMessage", content: [{ type: "text", text: prompt }] }],
  }]);
  assert.equal(exchange.prompt, prompt);
  assert.equal(exchange.messages[0].author, undefined);
});

test("Codex abort marker never replaces the user's original prompt", () => {
  const marker = [
    "<turn_aborted>",
    "The user interrupted the previous turn on purpose.",
    "</turn_aborted>",
  ].join("\n");
  assert.equal(displayUserPrompt(marker), "");

  const [exchange] = codexThreadHistory([{
    id: "turn-aborted",
    status: "interrupted",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Исходный текст пользователя" }] },
      { type: "userMessage", content: [{ type: "text", text: marker }] },
    ],
  }]);

  assert.equal(exchange.prompt, "Исходный текст пользователя");
  assert.deepEqual(exchange.messages.map((message) => message.text), ["Исходный текст пользователя"]);
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
  assert.deepEqual(responseAnnotationDetails(wrapper([
    { text: "Первый фрагмент", annotation: "Первый комментарий" },
    { text: "", annotation: "" },
    { text: "Второй фрагмент", annotation: "" },
  ], "Общий вопрос")), {
    items: [
      { text: "Первый фрагмент", annotation: "Первый комментарий" },
      { text: "Второй фрагмент", annotation: "" },
    ],
    request: "Общий вопрос",
    displayText: "Первый комментарий\n\nОбщий вопрос",
  });
});

test("displayUserPrompt retains a complete long user message", () => {
  const prompt = "Полный текст ".repeat(2_000);
  assert.equal(displayUserPrompt(prompt), prompt.trim());
});

test("response annotations never expose inline attachment service markup", () => {
  const prompt = [
    "<response-annotations>",
    JSON.stringify([{ text: "Ветка обязательна", annotation: "сделал?" }]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "ДА СКОЛЬКО МОЖНО ДУБЛЕЙ!?!?!?!?!?",
    '<image name=[Image #1] path="C:/AgentHub/attachments/screenshot.png">',
    "</image>",
  ].join("\n");

  assert.equal(responseAnnotationDetails(prompt).request, "ДА СКОЛЬКО МОЖНО ДУБЛЕЙ!?!?!?!?!?");
  assert.equal(displayUserPrompt(prompt), "сделал?\n\nДА СКОЛЬКО МОЖНО ДУБЛЕЙ!?!?!?!?!?");
});

test("exact turn receipts never bind an unidentified provider occurrence by count", () => {
  const messages = [{
    role: "user",
    clientUserMessageId: "root-client",
    text: "Корневой запрос",
  }, {
    role: "agent",
    text: "Промежуточный ответ",
  }, {
    role: "user",
    clientUserMessageId: "first-steer",
    text: "Первое уточнение",
  }, {
    role: "user",
    text: "Второе уточнение",
  }];
  const receipts = ["root-client", "first-steer", "second-steer"].map((clientUserMessageId) => ({
    clientUserMessageId,
  }));

  const bindings = exactTurnReceiptBindings(messages, receipts);
  assert.equal(bindings.get(0).clientUserMessageId, "root-client");
  assert.equal(bindings.get(2).clientUserMessageId, "first-steer");
  assert.equal(bindings.has(3), false);
  assert.equal(bindings.size, 2);
});

test("displayUserPrompt keeps Task instructions private while preserving the user's request", () => {
  const reference = {
    kind: "task",
    taskId: "board-1",
    taskNumber: null,
    title: "Исправить Dashboard",
    workflowStatus: "new",
    intent: "context",
  };

  assert.equal(displayUserPrompt(messageWithTaskReferences("Сравни с текущим решением", [reference])),
    "Сравни с текущим решением");
  assert.equal(displayUserPrompt(messageWithTaskReferences("", [reference])), "");
  assert.equal(displayUserPrompt([
    "# Attached Agent Hub Tasks",
    "",
    "- [Dashboard Task: Исправить Dashboard](agent-hub://task/board-1) · status: new · intent: context",
    "",
    "Открой актуальное содержимое Task командой MCP `hub_task_get` по `taskId` из ссылки.",
    "",
    "# My request",
    "",
    "Учти прикреплённые Dashboard Task как контекст; само прикрепление не является просьбой выполнять их.",
  ].join("\n")), "");
});

test("Codex history retains a Task-only turn as a structured attachment", () => {
  const reference = {
    kind: "task",
    taskId: "board-1",
    taskNumber: null,
    title: "Исправить Dashboard",
    workflowStatus: "new",
    workspaceId: null,
    intent: "context",
  };
  const [exchange] = codexThreadHistory([{
    id: "turn-task-only",
    status: "completed",
    items: [{
      id: "user-task-only",
      type: "userMessage",
      content: [{ type: "text", text: messageWithTaskReferences("", [reference]) }],
    }, {
      id: "answer-task-only",
      type: "agentMessage",
      phase: "final_answer",
      text: "Принято",
    }],
  }]);

  assert.equal(exchange.prompt, "");
  assert.equal(exchange.messages[0].text, "");
  assert.deepEqual(exchange.messages[0].attachments, [reference]);
});

test("codex history preserves response annotations as structured prompt data", () => {
  const source = {
    version: 1,
    provider: "codex",
    threadId: "thread-source",
    turnId: "turn-source",
    itemId: "item-source",
    role: "agent",
    messageKey: "provider\u001fcodex\u001fthread-source\u001fturn-source\u001fitem-source\u001fagent",
    surfaceKind: "message-body",
    surfaceIndex: 0,
    start: 0,
    end: 6,
    contentHash: `sha256:${"a".repeat(64)}`,
    surfaceHash: `sha256:${"b".repeat(64)}`,
    selectionHash: `sha256:${"c".repeat(64)}`,
  };
  const prompt = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([{ text: "Цитата", annotation: "Комментарий", source }]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "Общий вопрос",
  ].join("\n");
  const [exchange] = codexThreadHistory([{
    id: "turn-annotated",
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: prompt }] },
      { type: "agentMessage", phase: "final_answer", text: ':codex-annotation{index="1"} Готово' },
    ],
  }]);
  assert.deepEqual(exchange.promptAnnotations, [{ text: "Цитата", annotation: "Комментарий", source }]);
  assert.equal(exchange.promptRequest, "Общий вопрос");
  assert.deepEqual(exchange.messages[0].responseAnnotations, [{ text: "Цитата", annotation: "Комментарий", source }]);
  assert.equal(exchange.messages[1].text, "Цитата 1\nГотово");
  assert.deepEqual(exchange.messages[1].responseAnnotationReferences, [{ index: 1 }]);
});

test("codexThreadHistory returns user and assistant pairs", () => {
  const history = codexThreadHistory([{
    id: "turn-1",
    status: "completed",
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Проверь" }] },
      { type: "agentMessage", text: "Проверил" },
    ],
  }]);
  assert.match(history[0].messages[0].sourceOccurrenceId, /^codex-app-server:[0-9a-f]{64}$/u);
  delete history[0].messages[0].sourceOccurrenceId;
  assert.deepEqual(history, [{
    id: "turn-1",
    userMessageSnapshotAuthority: "complete",
    prompt: "Проверь",
    answer: "Проверил",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      { itemId: "turn-1:user:0", role: "user", text: "Проверь" },
      { itemId: "turn-1:agent:1", role: "agent", text: "Проверил", phase: "" },
    ],
    activities: [],
  }]);
});

test("codexThreadHistory attributes a subagent prompt to its parent agent", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-subagent",
    status: "completed",
    items: [
      { id: "prompt", type: "userMessage", content: [{ type: "text", text: "Проверь реализацию" }] },
      { id: "answer", type: "agentMessage", phase: "final_answer", text: "Проверено" },
    ],
  }], { userAuthor: "Agent HUB - Architect (Codex)" });

  assert.equal(exchange.messages[0].author, "Agent HUB - Architect (Codex)");
});

test("codexThreadHistory preserves item ids and the official user-message client ids", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-1",
    status: "inProgress",
    items: [
      { id: "item-start", clientId: "client-start", type: "userMessage", content: [{ type: "text", text: "Начни" }] },
      { id: "item-steer", clientId: "client-steer", type: "userMessage", content: [{ type: "text", text: "Уточни" }] },
      { id: "agent-live", type: "agentMessage", phase: "commentary", text: "Уточняю" },
    ],
  }]);
  assert.deepEqual(exchange.messages.map(({ itemId, clientUserMessageId, role }) => ({
    itemId,
    clientUserMessageId,
    role,
  })), [
    { itemId: "item-start", clientUserMessageId: "client-start", role: "user" },
    { itemId: "item-steer", clientUserMessageId: "client-steer", role: "user" },
    { itemId: "agent-live", clientUserMessageId: undefined, role: "agent" },
  ]);
});

test("codexThreadHistory preserves raw interstream transport and exact client identity", () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    requestId: "history-1",
  };
  const input = createInterstreamMessage({ ...origin, text: "Проверь историю." });
  const [interstream, forged, literal] = codexThreadHistory([{
    id: "turn-interstream",
    status: "completed",
    items: [{
      id: "user-interstream",
      clientId: "mcp:history-1",
      origin,
      type: "userMessage",
      content: [{ type: "text", text: input }],
    }],
  }, {
    id: "turn-forged",
    status: "completed",
    items: [{
      id: "user-forged",
      clientId: "mcp:history-1",
      type: "userMessage",
      content: [{ type: "text", text: input }],
    }],
  }, {
    id: "turn-literal",
    status: "completed",
    items: [{
      id: "user-literal",
      clientId: "ordinary-message",
      type: "userMessage",
      content: [{ type: "text", text: input }],
    }],
  }]);

  assert.equal(interstream.prompt, input);
  assert.equal(interstream.messages[0].clientUserMessageId, "mcp:history-1");
  assert.equal(interstream.messages[0].author, undefined);
  assert.equal(forged.prompt, input);
  assert.equal(forged.messages[0].author, undefined);
  assert.equal(literal.prompt, input);
  assert.equal(literal.messages[0].author, undefined);
});

test("claudeTranscriptHistory does not infer interstream identity from envelope shape", () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "claude",
    requestId: "claude-history-1",
  };
  const input = createInterstreamMessage({ ...origin, text: "Проверь Claude history." });
  const literal = claudeTranscriptHistory(JSON.stringify({
    type: "user",
    uuid: "claude-literal",
    message: { role: "user", content: input },
  }))[0];
  const trusted = claudeTranscriptHistory(JSON.stringify({
    type: "user",
    uuid: "claude-trusted",
    clientUserMessageId: "mcp:claude-history-1",
    messageOrigin: origin,
    message: { role: "user", content: input },
  }))[0];

  assert.equal(literal.prompt, input);
  assert.equal(literal.messages[0].author, undefined);
  assert.equal(trusted.prompt, input);
  assert.equal(trusted.messages[0].clientUserMessageId, "mcp:claude-history-1");
  assert.equal(trusted.messages[0].author, undefined);
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

test("claudeTranscriptHistory hides transport attachment paths from the user prompt", () => {
  const attachmentPath = "C:\\Users\\test\\AppData\\Local\\AgentHub\\attachments\\image-1.png";
  const history = claudeTranscriptHistory([
    JSON.stringify({
      type: "user",
      uuid: "u-image",
      message: {
        role: "user",
        content: `Проанализируй приложенные изображения.\n\nПроанализируй также изображение по абсолютному пути: ${attachmentPath}`,
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Готово" }], stop_reason: "end_turn" },
    }),
  ].join("\n"));

  assert.equal(history[0].prompt, "Проанализируй приложенные изображения.");
  assert.equal(history[0].messages[0].text, "Проанализируй приложенные изображения.");
  assert.deepEqual(history[0].messages[0].attachmentSources, [{ type: "path", value: attachmentPath }]);
});

test("claudeTranscriptHistory hides the headless resume prelude", () => {
  const line = (value) => JSON.stringify(value);
  const history = claudeTranscriptHistory([
    line({ type: "user", uuid: "u1", message: { role: "user", content: "Первый" } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Ошибка" }] } }),
    line({ type: "user", uuid: "resume", message: { role: "user", content: "Continue from where you left off." } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "No response requested." }], stop_reason: "stop_sequence" } }),
    line({ type: "user", uuid: "u2", message: { role: "user", content: "Второй" } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Готово" }], stop_reason: "end_turn" } }),
  ].join("\n"));

  assert.deepEqual(history.map((turn) => turn.prompt), ["Первый", "Второй"]);
  assert.equal(history[0].answer, "Ошибка");
  assert.equal(history[1].answer, "Готово");
});

test("claudeTranscriptHistory hides service records of Claude Code", () => {
  const line = (value) => JSON.stringify(value);
  const history = claudeTranscriptHistory([
    line({ type: "user", uuid: "u1", message: { role: "user", content: "Первый" } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Один" }], stop_reason: "end_turn" } }),
    line({
      type: "user",
      uuid: "compact",
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      message: {
        role: "user",
        content: "This session is being continued from a previous conversation that ran out of context.",
      },
    }),
    line({
      type: "user",
      uuid: "caveat",
      isMeta: true,
      message: { role: "user", content: "<local-command-caveat>Caveat: ...</local-command-caveat>" },
    }),
    line({
      type: "user",
      uuid: "command",
      message: {
        role: "user",
        content: "<command-name>/compact</command-name>\n<command-message>compact</command-message>",
      },
    }),
    line({ type: "user", uuid: "u2", message: { role: "user", content: "Второй" } }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Два" }], stop_reason: "end_turn" } }),
  ].join("\n"));

  assert.deepEqual(history.map((turn) => turn.prompt), ["Первый", "Второй"]);
  assert.equal(history.every((turn) => turn.messages.every((message) => (
    !String(message.text ?? "").startsWith("This session is being continued")
    && !String(message.text ?? "").startsWith("<")
  ))), true);
});

test("claudeTranscriptHistory folds a steer after an interrupt into the same turn", () => {
  const line = (value) => JSON.stringify(value);
  const history = claudeTranscriptHistory([
    line({ type: "user", uuid: "u1", timestamp: "2026-08-27T10:00:00.000Z", message: { role: "user", content: "Считай до ста" } }),
    line({ type: "assistant", uuid: "a1", message: { role: "assistant", content: [{ type: "text", text: "1, 2, 3" }], stop_reason: "tool_use" } }),
    line({ type: "user", uuid: "stop", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] } }),
    line({ type: "user", uuid: "u2", timestamp: "2026-08-27T10:00:09.000Z", message: { role: "user", content: "Хватит, ответь одним словом" } }),
    line({ type: "assistant", uuid: "a2", message: { role: "assistant", content: [{ type: "text", text: "Прерван" }], stop_reason: "end_turn" } }),
    line({ type: "user", uuid: "u3", timestamp: "2026-08-27T10:05:00.000Z", message: { role: "user", content: "Следующий вопрос" } }),
    line({ type: "assistant", uuid: "a3", message: { role: "assistant", content: [{ type: "text", text: "Ответ" }], stop_reason: "end_turn" } }),
  ].join("\n"));

  assert.deepEqual(history.map((turn) => turn.id), ["u1", "u3"]);
  assert.equal(history[0].completed, true);
  // Ответ хода — всё, что модель сказала до и после прерывания.
  assert.equal(history[0].answer, ["1, 2, 3", "", "Прерван"].join(String.fromCharCode(10)));
  assert.deepEqual(
    history[0].messages.map((message) => [message.role, message.text, message.turnUserSlot ?? ""]),
    [
      ["user", "Считай до ста", ""],
      ["agent", "1, 2, 3", ""],
      ["user", "Хватит, ответь одним словом", "steer"],
      ["agent", "Прерван", ""],
    ],
  );
  assert.equal(history[0].messages.some((message) => /interrupted/u.test(message.text)), false);
});

test("claudeTranscriptHistory keeps a prompt that only mentions a command", () => {
  const line = (value) => JSON.stringify(value);
  const history = claudeTranscriptHistory([
    line({
      type: "user",
      uuid: "u1",
      message: { role: "user", content: "<command-name>/compact</command-name> и сверни контекст" },
    }),
    line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Готово" }], stop_reason: "end_turn" } }),
  ].join("\n"));

  assert.equal(history.length, 1);
  assert.match(history[0].prompt, /сверни контекст/u);
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
    prompt: "",
    answer: "Текущий частичный ответ",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [
      { itemId: "live-turn:agent:live", role: "agent", text: "Текущий частичный ответ" },
    ],
  }]);
});

test("active history keeps every steered user message by exact item and client ids", () => {
  const history = [];
  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "turn-steered",
    prompt: "Начальный запрос",
    clientUserMessageId: "client-root",
    userMessages: [
      {
        itemId: "item-root",
        clientUserMessageId: "client-root",
        role: "user",
        text: "Начальный запрос",
      },
      {
        itemId: "item-steer",
        clientUserMessageId: "client-steer",
        role: "user",
        text: "Уточнение к текущему ходу",
      },
    ],
  });

  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "turn-steered",
    userMessages: [
      {
        itemId: "item-root",
        clientUserMessageId: "client-root",
        role: "user",
        text: "Начальный запрос",
      },
      {
        itemId: "item-steer",
        clientUserMessageId: "client-steer",
        role: "user",
        text: "Уточнение к текущему ходу",
      },
    ],
  });

  assert.deepEqual(history[0].messages.filter((message) => message.role === "user"), [
    {
      itemId: "item-root",
      clientUserMessageId: "client-root",
      role: "user",
      text: "Начальный запрос",
    },
    {
      itemId: "item-steer",
      clientUserMessageId: "client-steer",
      role: "user",
      text: "Уточнение к текущему ходу",
    },
  ]);
});

test("a late active prompt fills the same turn without a placeholder message", () => {
  const history = [];
  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    answer: "Ответ формируется",
  });
  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    prompt: "Настоящий запрос",
    answer: "Ответ формируется",
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].prompt, "Настоящий запрос");
  assert.deepEqual(history[0].messages.map(({ role, text }) => ({ role, text })), [
    { role: "user", text: "Настоящий запрос" },
    { role: "agent", text: "Ответ формируется" },
  ]);
});

test("an active refresh removes a persisted legacy current-message placeholder", () => {
  const history = [{
    id: "live-turn",
    prompt: "Текущее сообщение",
    active: true,
    messages: [{
      itemId: "live-turn:user:0",
      role: "user",
      text: "Текущее сообщение",
    }],
  }];

  mergeActiveTaskHistory(history, { active: true, turnId: "live-turn" });

  assert.equal(history[0].prompt, "");
  assert.deepEqual(history[0].messages, []);
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

test("active receipt preserves an unidentified provider occurrence beside the exact command", () => {
  const history = [{
    id: "live-turn",
    prompt: "Сообщение со скрином",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [{
      itemId: "official-user-item",
      role: "user",
      text: "Сообщение со скрином",
      attachmentSources: [{ type: "path", value: "C:/Temp/screenshot.png" }],
    }],
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    prompt: "Сообщение со скрином",
    clientUserMessageId: "client-message-id",
    attachments: [{ id: "uploaded-screenshot", type: "image/png" }],
  });

  const users = history[0].messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users[0].itemId, "official-user-item");
  assert.equal(users[0].clientUserMessageId, undefined);
  assert.deepEqual(users[0].attachmentSources, [
    { type: "path", value: "C:/Temp/screenshot.png" },
  ]);
  assert.deepEqual(users[1].attachments, [
    { id: "uploaded-screenshot", type: "image/png" },
  ]);
  assert.equal(users[1].clientUserMessageId, "client-message-id");
});

test("active rollout keeps root and image steer as exact separate users", () => {
  const history = [{
    id: "live-turn",
    prompt: "ну исправляй",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [{
      itemId: "live-turn:user:0",
      role: "user",
      text: "ну исправляй",
    }],
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    prompt: "ну исправляй",
    clientUserMessageId: "root-client",
    userMessages: [{
      itemId: "provider-root",
      clientUserMessageId: "root-client",
      role: "user",
      text: "ну исправляй",
    }, {
      itemId: "provider-steer",
      clientUserMessageId: "steer-client",
      role: "user",
      text: "почему сообщение в очереди",
      attachmentSources: [{ type: "path", value: "C:/AgentHub/attachments/queue.png" }],
    }],
  });

  const users = history[0].messages.filter((message) => message.role === "user");
  assert.deepEqual(users.map((message) => ({
    itemId: message.itemId,
    clientUserMessageId: message.clientUserMessageId,
    text: message.text,
  })), [{
    itemId: "live-turn:user:0",
    clientUserMessageId: undefined,
    text: "ну исправляй",
  }, {
    itemId: "provider-root",
    clientUserMessageId: "root-client",
    text: "ну исправляй",
  }, {
    itemId: "provider-steer",
    clientUserMessageId: "steer-client",
    text: "почему сообщение в очереди",
  }]);
  assert.deepEqual(users[2].attachmentSources, [{
    type: "path",
    value: "C:/AgentHub/attachments/queue.png",
  }]);
});

test("active inter-Stream steer cannot replace an unidentified root user", () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "Sol",
    requestId: "themes-ack-1",
  };
  const history = [{
    id: "live-turn",
    prompt: "Исходное сообщение пользователя",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [{
      itemId: "live-turn:user:0",
      role: "user",
      text: "Исходное сообщение пользователя",
    }],
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    prompt: "Исходное сообщение пользователя",
    userMessages: [{
      itemId: "rollout-user:1",
      clientUserMessageId: "",
      role: "user",
      origin,
      text: "Themes → Architect. Принято.",
    }],
  });

  const users = history[0].messages.filter((message) => message.role === "user");
  assert.deepEqual(users.map(({ text, clientUserMessageId }) => ({ text, clientUserMessageId })), [{
    text: "Исходное сообщение пользователя",
    clientUserMessageId: undefined,
  }, {
    text: "Themes → Architect. Принято.",
    clientUserMessageId: "mcp:themes-ack-1",
  }]);
});

test("active inter-Stream root preserves its unidentified provider predecessor", () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    model: "gpt-5.6-sol",
    requestId: "architect-continuation-1",
  };
  const history = [{
    id: "live-turn",
    prompt: "Продолжи закрытие релиза",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [{
      itemId: "provider-root",
      role: "user",
      text: "Продолжи закрытие релиза",
    }],
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    prompt: "Продолжи закрытие релиза",
    clientUserMessageId: "mcp:architect-continuation-1",
    userMessages: [{
      clientUserMessageId: "mcp:architect-continuation-1",
      role: "user",
      origin,
      text: "Продолжи закрытие релиза",
    }],
  });

  const users = history[0].messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users[0].itemId, "provider-root");
  assert.equal(users[1].clientUserMessageId, "mcp:architect-continuation-1");
  assert.equal(users[1].author, "Agent HUB - Architect (Sol)");
  assert.deepEqual(users[1].origin, origin);
});

test("active inter-Stream request identity does not adopt an unidentified provider occurrence", () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    model: "gpt-5.6-sol",
    requestId: "architect-continuation-without-client-id",
  };
  const history = [{
    id: "live-turn",
    prompt: "Продолжи закрытие релиза",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [{
      itemId: "provider-root",
      role: "user",
      text: "Продолжи закрытие релиза",
    }],
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    turnId: "live-turn",
    prompt: "Продолжи закрытие релиза",
    messageOrigin: origin,
    userMessages: [{
      role: "user",
      origin,
      text: "Продолжи закрытие релиза",
    }],
  });

  const users = history[0].messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users[0].itemId, "provider-root");
  assert.equal(users[0].clientUserMessageId, undefined);
  assert.equal(users[0].author, undefined);
  assert.equal(users[1].clientUserMessageId, "mcp:architect-continuation-without-client-id");
  assert.equal(users[1].author, "Agent HUB - Architect (Sol)");
  assert.deepEqual(users[1].origin, origin);
});

test("displayUserPrompt unwraps Codex Desktop file metadata", () => {
  assert.equal(displayUserPrompt([
    "# Files mentioned by the user:",
    "",
    "## codex-clipboard-3bc5bb2d-38a9-4b34-9886-73b0b204c8d2.png: C:/Temp/codex-clipboard-3bc5bb2d-38a9-4b34-9886-73b0b204c8d2.png",
    "",
    "## My request for Codex:",
    "Почему остановился?",
  ].join("\n")), "Почему остановился?");
  assert.equal(displayUserPrompt([
    "# Files mentioned by the user:",
    "",
    "## screenshot.png: C:/Temp/screenshot.png",
    "",
    "## My request:",
    "Что видно на скрине?",
  ].join("\n")), "Что видно на скрине?");
});

test("Codex Desktop attachment without request text stays a single attachment message", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-with-empty-request",
    status: "completed",
    items: [{
      id: "official-user-item",
      clientId: "client-message-id",
      type: "userMessage",
      content: [{ type: "text", text: [
        "# Files mentioned by the user:",
        "## screenshot.png: C:/Temp/screenshot.png",
        "## My request:",
      ].join("\n") }],
    }],
  }]);

  assert.equal(exchange.prompt, "Вложение");
  assert.equal(exchange.messages.length, 1);
  assert.equal(exchange.messages[0].clientUserMessageId, "client-message-id");
  assert.deepEqual(exchange.messages[0].attachmentSources, [{
    type: "path",
    value: "C:/Temp/screenshot.png",
    name: "screenshot.png",
  }]);
});

test("raw provider history preserves an unresolved rollout alias without content guessing", () => {
  const turnId = "turn-with-rollout-root";
  const [exchange] = codexThreadHistory([{
    id: turnId,
    status: "inProgress",
    items: [{
      id: "official-user-item",
      clientId: "client-message-id",
      type: "userMessage",
      content: [
        { type: "text", text: "Проанализируй изображение" },
        { type: "localImage", path: "C:/Temp/screenshot.png" },
      ],
    }, {
      id: `${turnId}:rollout-user:0`,
      type: "userMessage",
      content: [{ type: "text", text: "Проанализируй изображение" }],
    }],
  }]);

  const users = exchange.messages.filter((message) => message.role === "user");
  assert.equal(users.length, 2);
  assert.equal(users[0].itemId, "official-user-item");
  assert.equal(users[0].clientUserMessageId, "client-message-id");
  assert.deepEqual(users[0].attachmentSources, [{
    type: "path",
    value: "C:/Temp/screenshot.png",
  }]);
  assert.equal(users[1].itemId, `${turnId}:rollout-user:0`);
  assert.equal(users[1].clientUserMessageId, undefined);
});

test("sparse canonical steer does not replace a synthetic root by ordinal", () => {
  const turnId = "turn-with-sparse-canonical-steer";
  const messages = [{
    itemId: `${turnId}:rollout-user:0`,
    role: "user",
    text: "Повторный текст",
  }, {
    itemId: `${turnId}:rollout-user:1`,
    role: "user",
    text: "Повторный текст",
    attachmentSources: [{ type: "path", value: "C:/AgentHub/attachments/legacy.png" }],
  }, {
    itemId: "canonical-steer",
    clientUserMessageId: "steer-client",
    role: "user",
    text: "Повторный текст",
  }];

  assert.deepEqual(mergeSyntheticRolloutUsers(messages, turnId), messages);
});

test("Codex Desktop screenshots are retained as private attachment references", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-with-image",
    status: "inProgress",
    items: [{
      type: "userMessage",
      content: [{ type: "text", text: [
        "# Files mentioned by the user:",
        "## codex-clipboard-3bc5bb2d-38a9-4b34-9886-73b0b204c8d2.png: C:/Temp/codex-clipboard-3bc5bb2d-38a9-4b34-9886-73b0b204c8d2.png",
        "## My request for Codex:",
        "Проверь скрин",
      ].join("\n") }],
    }],
  }]);
  assert.equal(exchange.prompt, "Проверь скрин");
  assert.deepEqual(exchange.messages[0].attachmentSources, [{
    type: "path",
    value: "C:/Temp/codex-clipboard-3bc5bb2d-38a9-4b34-9886-73b0b204c8d2.png",
    name: "codex-clipboard-3bc5bb2d-38a9-4b34-9886-73b0b204c8d2.png",
  }]);
});

test("standalone Codex image tags become attachments instead of visible service text", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-with-legacy-image-tag",
    status: "completed",
    items: [{
      type: "userMessage",
      content: [{ type: "text", text: [
        "Проанализируй приложенное изображение.",
        '<image name=[Image #1] path="C:/AgentHub/attachments/screenshot.png">',
        "</image>",
      ].join("\n") }],
    }],
  }]);
  assert.equal(exchange.prompt, "Проанализируй приложенное изображение.");
  assert.deepEqual(exchange.messages[0].attachmentSources, [{
    type: "path",
    value: "C:/AgentHub/attachments/screenshot.png",
    name: "Image #1",
  }]);
});

test("desktop prompt envelope deduplicates an image listed twice", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-with-duplicate-image-metadata",
    status: "completed",
    items: [{
      type: "userMessage",
      content: [{ type: "text", text: [
        "# Files mentioned by the user:",
        "## screenshot.png: C:/AgentHub/attachments/screenshot.png",
        "## My request for Codex:",
        "Проверь скрин",
        '<image name=[Image #1] path="C:/AgentHub/attachments/screenshot.png">',
        "</image>",
      ].join("\n") }],
    }],
  }]);
  assert.equal(exchange.prompt, "Проверь скрин");
  assert.deepEqual(exchange.messages[0].attachmentSources, [{
    type: "path",
    value: "C:/AgentHub/attachments/screenshot.png",
    name: "screenshot.png",
  }]);
});

test("Codex Desktop documents retain their display names after history reload", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-with-document",
    status: "completed",
    items: [{
      type: "userMessage",
      content: [{ type: "text", text: [
        "# Files mentioned by the user:",
        "## Требования.pdf: C:/AgentHub/attachments/document.pdf",
        "## My request for Codex:",
        "Проверь документ",
      ].join("\n") }],
    }],
  }]);
  assert.equal(exchange.prompt, "Проверь документ");
  assert.deepEqual(exchange.messages[0].attachmentSources, [{
    type: "path",
    value: "C:/AgentHub/attachments/document.pdf",
    name: "Требования.pdf",
  }]);
});

test("Codex inline screenshots are retained as private data references", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-with-inline-image",
    status: "inProgress",
    items: [{
      type: "userMessage",
      content: [
        { type: "text", text: "Проверь второй скрин" },
        { type: "image", url: "data:image/png;base64,AA==" },
      ],
    }],
  }]);
  assert.equal(exchange.prompt, "Проверь второй скрин");
  assert.deepEqual(exchange.messages[0].attachmentSources, [{
    type: "data",
    value: "data:image/png;base64,AA==",
  }]);
});

test("Codex input_image screenshots are retained as private data references", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-with-input-image",
    status: "inProgress",
    items: [{
      type: "userMessage",
      content: [
        { type: "input_text", text: "Проверь актуальный скрин" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
      ],
    }],
  }]);
  assert.equal(exchange.prompt, "Проверь актуальный скрин");
  assert.deepEqual(exchange.messages[0].attachmentSources, [{
    type: "data",
    value: "data:image/png;base64,AA==",
  }]);
});

test("Codex image-only messages remain visible in task history", () => {
  const [exchange] = codexThreadHistory([{
    id: "turn-with-image-only",
    status: "completed",
    items: [
      {
        type: "userMessage",
        content: [{ type: "image", url: "data:image/png;base64,AA==" }],
      },
      { type: "agentMessage", text: "Изображение проверено", phase: "final_answer" },
    ],
  }]);
  assert.equal(exchange.prompt, "Изображение");
  assert.equal(exchange.answer, "Изображение проверено");
  assert.deepEqual(exchange.messages[0].attachmentSources, [{
    type: "data",
    value: "data:image/png;base64,AA==",
  }]);
});

test("one active Claude transcript turn adopts the managed run id", () => {
  const history = [{
    id: "claude-user-message-id",
    prompt: "Один запрос",
    answer: "Начало ответа",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [{
      itemId: "claude-user-message-id",
      role: "user",
      text: "Один запрос",
    }],
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    provider: "claude",
    turnId: "managed-run-id",
    prompt: "Один запрос",
    answer: "Продолжение ответа",
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].id, "managed-run-id");
  assert.equal(history[0].answer, "Продолжение ответа");
});

test("a new active Codex turn never adopts an older interrupted turn", () => {
  const history = [{
    id: "019fe800-410a-7a20-b3c8-cbbf78ae63af",
    prompt: "Старый запрос",
    answer: "",
    status: "inProgress",
    active: true,
    completed: false,
    startedAt: "2026-08-09T19:29:18.000Z",
    messages: [{
      itemId: "old-user",
      role: "user",
      text: "Старый запрос",
      time: "2026-08-09T19:29:18.000Z",
    }],
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    provider: "codex",
    turnId: "019fe81e-b0d7-7f91-8dc9-c473b8e2c9b2",
    prompt: "Новый запрос",
    startedAt: "2026-08-09T20:02:33.000Z",
  });

  assert.equal(history.length, 2);
  assert.equal(history[0].id, "019fe800-410a-7a20-b3c8-cbbf78ae63af");
  assert.equal(history[0].startedAt, "2026-08-09T19:29:18.000Z");
  assert.equal(history[1].id, "019fe81e-b0d7-7f91-8dc9-c473b8e2c9b2");
  assert.equal(history[1].startedAt, "2026-08-09T20:02:33.000Z");
});

test("Codex App Server keeps source occurrence when client identity appears later", () => {
  const turn = {
    id: "turn-app-server-enrichment",
    status: "inProgress",
    items: [{
      id: "provider-user-item",
      type: "userMessage",
      content: [{ type: "text", text: "Accepted payload" }],
      createdAt: "2026-09-05T10:00:00.000Z",
    }],
  };
  const before = codexThreadHistory([turn])[0].messages[0];
  turn.items[0].clientId = "accepted-app-server-message";
  const after = codexThreadHistory([turn])[0].messages[0];

  assert.equal(before.sourceOccurrenceId, after.sourceOccurrenceId);
  assert.equal(after.clientUserMessageId, "accepted-app-server-message");
});

test("an active provider snapshot preserves accepted authority and its unproven occurrence", () => {
  const history = [{
    id: "turn-active",
    prompt: "Root",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [
      {
        itemId: "owned-root",
        role: "user",
        text: "Root",
        clientUserMessageId: "accepted-root",
        origin: { streamId: "owned-stream" },
      },
      { itemId: "owned-steer", role: "user", text: "Same", clientUserMessageId: "accepted-steer" },
      { itemId: "external-owned", role: "user", text: "Same" },
    ],
  }];

  mergeActiveTaskHistory(history, {
    active: true,
    provider: "codex",
    turnId: "turn-active",
    prompt: "Same",
    userMessages: [
      {
        itemId: "provider-root",
        role: "user",
        text: "Provider root",
        clientUserMessageId: "accepted-root",
        origin: { streamId: "provider-stream" },
      },
      { itemId: "provider-tail", role: "user", text: "Same" },
    ],
  });

  const users = history[0].messages.filter((message) => message.role === "user");
  assert.deepEqual(users.map((message) => message.clientUserMessageId).filter(Boolean), [
    "accepted-root",
    "accepted-steer",
  ]);
  assert.equal(history[0].prompt, "Root");
  assert.equal(users[0].text, "Root");
  assert.deepEqual(users[0].origin, { streamId: "owned-stream" });
  assert.equal(users.some((message) => message.itemId === "external-owned"), true);
  assert.equal(users.some((message) => message.itemId === "provider-tail"), true);
});

test("active history applies the shared complete-snapshot occurrence contract", () => {
  const history = [{
    id: "turn-parity",
    userMessageSnapshotAuthority: "complete",
    prompt: "Owned",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [
      { role: "user", text: "Owned", clientUserMessageId: "accepted" },
      { role: "user", text: "Old external", itemId: "collision" },
    ],
  }];
  const observed = {
    active: true,
    turnId: "turn-parity",
    userMessageSnapshotAuthority: "complete",
    userMessages: [
      { role: "user", text: "Provider payload", clientUserMessageId: "accepted" },
      { role: "user", text: "External one", itemId: "collision" },
      { role: "user", text: "External two", itemId: "collision" },
    ],
  };

  mergeActiveTaskHistory(history, observed);
  const once = structuredClone(history[0].messages);
  mergeActiveTaskHistory(history, observed);

  assert.deepEqual(history[0].messages, once);
  assert.deepEqual(history[0].messages.map((message) => message.text), [
    "Owned",
    "External one",
    "External two",
  ]);
});

test("active history replays a cumulative incremental source observation once", () => {
  const history = [];
  const first = {
    role: "user",
    text: "Одинаковый текст",
    sourceOccurrenceId: `codex-rollout:${"3".repeat(64)}`,
  };
  const appended = {
    ...first,
    sourceOccurrenceId: `codex-rollout:${"4".repeat(64)}`,
  };
  const observe = (userMessages) => mergeActiveTaskHistory(history, {
    active: true,
    provider: "codex",
    turnId: "turn-incremental-replay",
    userMessageSnapshotAuthority: "incremental",
    userMessages,
  });

  observe([first]);
  observe([first]);
  observe([first]);
  assert.equal(history[0].messages.filter((message) => message.role === "user").length, 1);
  observe([first, appended]);
  observe([first, appended]);
  assert.deepEqual(
    history[0].messages.filter((message) => message.role === "user")
      .map((message) => message.sourceOccurrenceId),
    [first.sourceOccurrenceId, appended.sourceOccurrenceId],
  );
});
