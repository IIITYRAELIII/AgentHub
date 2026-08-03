import assert from "node:assert/strict";
import test from "node:test";
import { codexRolloutHistory, TaskViewController } from "./task-view-controller.mjs";

function controller(overrides = {}) {
  return new TaskViewController({
    findMessageBinding: async () => null,
    findCatalogEntry: async () => null,
    selectedTask: () => null,
    activeThreadTitle: () => "Current",
    ...overrides,
  });
}

test("task view binding resolves exact catalog identity", async () => {
  const entry = {
    provider: "codex",
    threadId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    projectRoot: "C:/repo",
    title: "Task",
  };
  const view = controller({ findCatalogEntry: async () => entry });
  const binding = await view.resolveBinding(entry, 9, 12);
  assert.equal(binding.taskTitle, "Task");
  assert.equal(binding.messageId, 12);
});

test("legacy task view uses its stored message binding", async () => {
  const stored = { provider: "claude", threadId: "session", taskTitle: "Saved" };
  const view = controller({ findMessageBinding: async () => stored });
  assert.equal(await view.resolveBinding(null, 9, 12), stored);
});

test("cached task history does not wait for the provider", async () => {
  const cached = [{
    id: "turn-cached",
    prompt: "Сохранённый запрос",
    answer: "Сохранённый ответ",
    completed: true,
  }];
  let providerReads = 0;
  const view = controller({
    ensureCodex: async () => { providerReads += 1; },
    readCodexThread: async () => { providerReads += 1; return { thread: { turns: [] } }; },
    taskSyncStore: {
      history: () => structuredClone(cached),
      snapshot: () => ({ active: false }),
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    threadId: "thread-cached",
    projectRoot: "C:/repo",
    title: "Cached task",
    chatId: 1,
  }, { cachedOnly: true });

  assert.deepEqual(result.history, cached);
  assert.deepEqual(result.snapshot, { active: false });
  assert.equal(providerReads, 0);
});

test("Codex history refresh reads the rollout directly without blocking App Server", async () => {
  let providerReads = 0;
  let snapshotInput = null;
  const view = controller({
    findCodexRolloutPath: async () => "C:/rollout.jsonl",
    ensureCodex: async () => { providerReads += 1; },
    readCodexThread: async () => { providerReads += 1; return null; },
    readCodexRolloutActivity: async () => ({
      activeTurnIds: ["turn-live"],
      userMessages: { "turn-live": [{ text: "Новый запрос" }] },
      latestMessages: { "turn-live": "Промежуточный ответ" },
      finalMessages: {},
    }),
    readCodexSnapshot: async (input) => {
      snapshotInput = input;
      return { active: true, turnId: "turn-live" };
    },
    taskSyncStore: {
      history: () => [{ id: "turn-old", prompt: "Старый", completed: true }],
      recordHistory: () => {},
      save: async () => {},
    },
  });
  const result = await view.readHistory({
    provider: "codex",
    threadId: "thread-shared",
    projectRoot: "C:/repo",
    title: "Shared",
    chatId: 1,
  });
  assert.equal(providerReads, 0);
  assert.equal(snapshotInput.rolloutPath, "C:/rollout.jsonl");
  assert.deepEqual(result.history.map((item) => item.id), ["turn-old", "turn-live"]);
});

test("missing Claude transcript keeps the managed exchange in durable history", async () => {
  const cached = [{
    id: "turn-1",
    prompt: "Сообщение пользователя",
    answer: "",
    status: "inProgress",
    active: true,
    completed: false,
    messages: [{ itemId: "user-1", role: "user", text: "Сообщение пользователя" }],
  }];
  let recorded = null;
  const task = {
    provider: "claude",
    threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    projectRoot: "C:/repo",
    title: "Claude task",
  };
  const view = controller({
    readClaudeSnapshot: async () => null,
    savedLastTaskMessage: () => "Ошибка Claude Code: сессия отсутствует",
    taskRuns: { forTask: () => null },
    taskSyncStore: {
      history: () => structuredClone(cached),
      recordHistory: (_task, history) => { recorded = structuredClone(history); },
      save: async () => {},
    },
  });
  const result = await view.readHistory({ ...task, chatId: 1 });
  assert.equal(result.history[0].prompt, "Сообщение пользователя");
  assert.equal(result.history[0].active, false);
  assert.equal(result.history[0].completed, true);
  assert.equal(recorded[0].status, "failed");
  assert.equal(recorded[0].answer, "Ошибка Claude Code: сессия отсутствует");
  assert.equal(recorded[0].messages.at(-1).role, "agent");
});

test("rollout history restores a completed turn missing from Codex App Server", async () => {
  const oldTurnId = "019fbe53-7a2b-7d12-92bc-88b062536f7f";
  const missingTurnId = "019fbe58-a7d6-7e93-9f8e-1ff6ec61e0bc";
  let recorded = null;
  const task = {
    provider: "codex",
    threadId: "019f75bd-3fd4-7e32-9dc9-0177a261a117",
    projectRoot: "C:/repo",
    title: "Agent HUB - Sol",
  };
  const view = controller({
    ensureCodex: async () => {},
    readCodexThread: async () => ({ thread: {
      path: "C:/rollout.jsonl",
      turns: [{
        id: oldTurnId,
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Старый запрос" }] },
          { type: "agentMessage", text: "Старый ответ", phase: "final_answer" },
        ],
      }],
    } }),
    readCodexRolloutActivity: async () => ({
      activeTurnIds: [],
      userMessages: {
        [missingTurnId]: [{ itemId: "image", role: "user", text: "Изображение" }],
      },
      latestMessages: { [missingTurnId]: "Новый ответ" },
      finalMessages: { [missingTurnId]: "Новый ответ" },
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => [],
      recordHistory: (_task, history) => { recorded = structuredClone(history); },
      save: async () => {},
    },
  });
  const result = await view.readHistory({ ...task, chatId: 1 });
  assert.deepEqual(result.history.map((item) => item.id), [oldTurnId, missingTurnId]);
  assert.equal(result.history.at(-1).answer, "Новый ответ");
  assert.equal(result.history.at(-1).completed, true);
  assert.equal(recorded.at(-1).id, missingTurnId);
});

test("rollout history represents a final image-only turn", () => {
  const [exchange] = codexRolloutHistory({
    finalMessages: { "turn-1": "Ответ на скриншот" },
  });
  assert.equal(exchange.prompt, "Сообщение с вложением");
  assert.equal(exchange.answer, "Ответ на скриншот");
  assert.equal(exchange.completed, true);
});

test("rollout history attaches generated images to the final assistant message", () => {
  const [exchange] = codexRolloutHistory({
    userMessages: { "turn-image": [{ text: "Нарисуй фон" }] },
    finalMessages: { "turn-image": "Кадр выше." },
    generatedImageSources: {
      "turn-image": [{ type: "generated-path", value: "C:/Users/test/.codex/generated_images/thread/call.png" }],
    },
  });
  const assistant = exchange.messages.find((message) => message.role === "agent");
  assert.equal(assistant.text, "Кадр выше.");
  assert.deepEqual(assistant.attachmentSources, [{
    type: "generated-path",
    value: "C:/Users/test/.codex/generated_images/thread/call.png",
  }]);
});

test("rollout fallback keeps response annotations structured", () => {
  const prompt = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([
      { text: "Первая цитата", annotation: "Первый комментарий" },
      { text: "Вторая цитата", annotation: "Второй комментарий" },
    ]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "Общий вопрос",
  ].join("\n");
  const [exchange] = codexRolloutHistory({
    userMessages: { "turn-1": [{ text: prompt }] },
    finalMessages: { "turn-1": "Ответ" },
  });
  assert.equal(exchange.promptRequest, "Общий вопрос");
  assert.deepEqual(exchange.promptAnnotations, [
    { text: "Первая цитата", annotation: "Первый комментарий" },
    { text: "Вторая цитата", annotation: "Второй комментарий" },
  ]);
  assert.doesNotMatch(exchange.prompt, /response-annotations|My request for Codex/iu);
});

test("rollout enriches an already completed cached turn with response annotations", async () => {
  const turnId = "019fc8c5-ed6c-72d3-9f37-02cb9a797790";
  const prompt = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([{ text: "миграция полностью завершена.", annotation: "" }]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "Это не повторится больше?",
  ].join("\n");
  const view = controller({
    findCodexRolloutPath: async () => "C:/rollout.jsonl",
    readCodexRolloutActivity: async () => ({
      userMessages: { [turnId]: [{ itemId: "rollout-user", role: "user", text: prompt }] },
      finalMessages: { [turnId]: "Нет, при обычных запусках не повторится." },
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => [{
        id: turnId,
        prompt: "Это не повторится больше?",
        answer: "Нет, при обычных запусках не повторится.",
        completed: true,
        messages: [{ itemId: "temporary-user", role: "user", text: "Это не повторится больше?" }],
      }],
      recordHistory: () => {},
      save: async () => {},
    },
  });
  const result = await view.readHistory({
    provider: "codex",
    threadId: "019f75bd-3fd4-7e32-9dc9-0177a261a117",
    projectRoot: "C:/repo",
    title: "Agent HUB 1",
    chatId: 1,
  });
  assert.deepEqual(result.history[0].promptAnnotations, [{
    text: "миграция полностью завершена.",
    annotation: "",
  }]);
  assert.deepEqual(result.history[0].messages[0].responseAnnotations, [{
    text: "миграция полностью завершена.",
    annotation: "",
  }]);
});
