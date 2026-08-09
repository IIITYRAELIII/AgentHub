import assert from "node:assert/strict";
import test from "node:test";
import {
  codexFinalTurnAnswer,
  codexTurnHasExplicitFinalAnswer,
  claudeTranscriptHistory,
  codexThreadHistory,
  codexTurnActivityGroups,
  codexTurnActivities,
  displayUserPrompt,
  isEmptyTurnCompletionPlaceholder,
  responseAnnotationDetails,
  mergeActiveTaskHistory,
  mergeCompletedTaskHistory,
  visibleTaskHistory,
} from "../../src/application/task-history.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../src/domain/codex-context-probe.mjs";

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
  });

  assert.equal(history[0].active, false);
  assert.equal(history[0].completed, true);
  assert.equal(history[0].status, "completed");
  assert.equal(history[0].answer, "Финальный ответ");
  assert.equal(history[0].messages[0].text, "Финальный ответ");
  assert.equal(history[0].messages[0].phase, "final");
});

test("completed history ignores a promptless compaction echo", () => {
  const history = [{
    id: "turn-user",
    prompt: "Вопрос",
    answer: "Готово",
    completed: true,
    messages: [{ role: "agent", text: "Готово" }],
  }];

  mergeCompletedTaskHistory(history, {
    turnId: "turn-compaction",
    answer: "Готово",
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].id, "turn-user");
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

test("codex history preserves response annotations as structured prompt data", () => {
  const prompt = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([{ text: "Цитата", annotation: "Комментарий" }]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "Общий вопрос",
  ].join("\n");
  const [exchange] = codexThreadHistory([{
    id: "turn-annotated",
    status: "inProgress",
    items: [{ type: "userMessage", content: [{ type: "text", text: prompt }] }],
  }]);
  assert.deepEqual(exchange.promptAnnotations, [{ text: "Цитата", annotation: "Комментарий" }]);
  assert.equal(exchange.promptRequest, "Общий вопрос");
  assert.deepEqual(exchange.messages[0].responseAnnotations, [{ text: "Цитата", annotation: "Комментарий" }]);
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
    messages: [
      { itemId: "turn-1:user:0", role: "user", text: "Проверь" },
      { itemId: "turn-1:agent:1", role: "agent", text: "Проверил", phase: "" },
    ],
    activities: [],
  }]);
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

test("active receipt adopts the rollout user and keeps its screenshot", () => {
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
  assert.equal(users.length, 1);
  assert.equal(users[0].itemId, "official-user-item");
  assert.equal(users[0].clientUserMessageId, "client-message-id");
  assert.deepEqual(users[0].attachmentSources, [
    { type: "path", value: "C:/Temp/screenshot.png" },
  ]);
  assert.deepEqual(users[0].attachments, [
    { id: "uploaded-screenshot", type: "image/png" },
  ]);
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
    turnId: "managed-run-id",
    prompt: "Один запрос",
    answer: "Продолжение ответа",
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].id, "managed-run-id");
  assert.equal(history[0].answer, "Продолжение ответа");
});
