import assert from "node:assert/strict";
import test from "node:test";
import { codexRolloutHistory, TaskViewController } from "../../../src/interfaces/telegram/task-view-controller.mjs";

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

test("stored task view binding is enriched with its stable Stream", async () => {
  const stored = {
    provider: "codex",
    threadId: "thread-1",
    projectRoot: "C:/repo",
    taskTitle: "Saved",
  };
  const view = controller({
    findMessageBinding: async () => stored,
    findCatalogEntry: async () => ({
      ...stored,
      streamId: "stream-1",
      workspaceName: "Agent HUB",
      streamName: "Themes",
      title: "Workspace",
    }),
  });

  assert.deepEqual(await view.resolveBinding({
    provider: "codex",
    threadId: "thread-1",
  }, 9, 12), {
    ...stored,
    streamId: "stream-1",
    taskTitle: "Agent HUB - Themes",
  });
});

test("cached task history does not wait for the provider", async () => {
  const cached = [{
    id: "turn-cached",
    prompt: "Сохранённый запрос",
    answer: "Сохранённый ответ",
    completed: true,
    messages: [],
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

test("rollout history carries commentary groups into completed turns", () => {
  const [exchange] = codexRolloutHistory({
    userMessages: { "turn-trace": [{ text: "Проверь проект" }] },
    finalMessages: { "turn-trace": "Готово" },
    activityGroups: {
      "turn-trace": [{
        id: "comment-1",
        reasoning: "Сначала изучаю структуру.",
        activities: [{ id: "item:tool-1", type: "command", label: "Команда выполнена" }],
      }],
    },
  });

  assert.equal(exchange.activityGroups[0].reasoning, "Сначала изучаю структуру.");
  assert.equal(exchange.activities[0].id, "item:tool-1");
});

test("rollout history hides Codex auto-compaction transfer turns", () => {
  const history = codexRolloutHistory({
    latestMessages: {
      "auto-compact-0": "Полный цикл commentary предыдущего хода",
    },
  });

  assert.deepEqual(history, []);
});

test("cached task history hides stale Codex auto-compaction turns", async () => {
  const view = controller({
    taskSyncStore: {
      history: () => [
        { id: "real-turn", prompt: "Запрос", answer: "Ответ", completed: true },
        { id: "auto-compact-0", prompt: "Сообщение с вложением", answer: "Commentary" },
      ],
      snapshot: () => null,
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-rotated",
    chatId: 1,
  }, { cachedOnly: true });

  assert.deepEqual(result.history.map((item) => item.id), ["real-turn"]);
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

test("rollout fallback keeps annotations normalized by the activity parser", () => {
  const [exchange] = codexRolloutHistory({
    userMessages: {
      "turn-1": [{
        text: "Аннотация 1: Почему?\nАннотация 2: Что это?",
        responseAnnotations: [
          { text: "Первая цитата", annotation: "Почему?" },
          { text: "Вторая цитата", annotation: "Что это?" },
        ],
        responseAnnotationRequest: "",
      }],
    },
    finalMessages: { "turn-1": "Ответ" },
  });

  assert.deepEqual(exchange.promptAnnotations, [
    { text: "Первая цитата", annotation: "Почему?" },
    { text: "Вторая цитата", annotation: "Что это?" },
  ]);
  assert.deepEqual(exchange.messages[0].responseAnnotations, exchange.promptAnnotations);
  assert.equal(exchange.messages[0].responseAnnotationRequest, "");
});

test("rollout history replaces a stale inherited answer after Thread rotation", async () => {
  const turnId = "019fdbb2-0304-7d32-a5bc-76fb3ff9c0d3";
  let recorded = null;
  const view = controller({
    ensureCodex: async () => {},
    readCodexThread: async () => ({ thread: {
      path: "C:/rotated-rollout.jsonl",
      turns: [{
        id: turnId,
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Проведи аудит Hub" }] },
          { type: "agentMessage", text: "Старый ответ про VPN", phase: "final_answer" },
        ],
      }],
    } }),
    readCodexRolloutActivity: async () => ({
      activeTurnIds: [],
      userMessages: { [turnId]: [{ text: "Проведи аудит Hub" }] },
      latestMessages: { [turnId]: "Аудит Hub остановлен после анализа архитектуры" },
      finalMessages: {},
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => [{
        id: turnId,
        prompt: "Проведи аудит Hub",
        answer: "Старый ответ про VPN",
        status: "completed",
        active: false,
        completed: true,
        messages: [
          { itemId: `${turnId}:user`, role: "user", text: "Проведи аудит Hub" },
          { itemId: `${turnId}:agent`, role: "agent", text: "Старый ответ про VPN" },
        ],
      }],
      recordHistory: (_task, history) => { recorded = structuredClone(history); },
      save: async () => {},
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    threadId: "rotated-thread",
    projectRoot: "C:/repo",
    title: "DevOps",
    chatId: 1,
  });

  assert.equal(result.history[0].answer, "Аудит Hub остановлен после анализа архитектуры");
  assert.equal(result.history[0].status, "stopped");
  assert.equal(result.history[0].completed, false);
  assert.equal(result.history[0].messages.filter((message) => message.role === "agent").length, 1);
  assert.equal(result.history[0].messages.at(-1).text, "Аудит Hub остановлен после анализа архитектуры");
  assert.deepEqual(recorded, result.history);
});

test("generated images replace inspected inputs on the final assistant message", async () => {
  const turnId = "019fc8f4-258f-72d3-9f37-02cb9a797790";
  let recorded = null;
  let importedSources = null;
  const view = controller({
    ensureCodex: async () => {},
    readCodexThread: async () => ({ thread: {
      path: "C:/rollout.jsonl",
      turns: [{
        id: turnId,
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Покажи варианты" }] },
          { type: "agentMessage", text: "Три варианта показаны", phase: "final_answer" },
        ],
      }],
    } }),
    readCodexRolloutActivity: async () => ({
      activeTurnIds: [],
      userMessages: { [turnId]: [{ text: "Покажи варианты" }] },
      finalMessages: { [turnId]: "Три варианта показаны" },
      generatedImageSources: {
        [turnId]: [
          { type: "view-path", value: "C:/viewed/reference.jpg" },
          { type: "view-path", value: "C:/viewed/screenshot-one.png" },
          { type: "view-path", value: "C:/viewed/screenshot-two.png" },
          { type: "generated-path", value: "C:/generated/one.png" },
          { type: "generated-path", value: "C:/generated/two.png" },
          { type: "generated-path", value: "C:/generated/three.png" },
        ],
      },
    }),
    readCodexSnapshot: async () => ({ active: false }),
    attachmentImporter: async (sources) => {
      importedSources = structuredClone(sources);
      return sources.map((source) => ({
        id: `codex-generated-${source.value.split("/").at(-1)}`,
        name: "Изображение",
        type: "image/png",
      }));
    },
    taskSyncStore: {
      history: () => [{
        id: turnId,
        prompt: "Покажи варианты",
        answer: "Промежуточный ответ",
        active: true,
        completed: false,
        messages: [
          { itemId: `${turnId}:user`, role: "user", text: "Покажи варианты" },
          {
            itemId: `${turnId}:agent:live`,
            role: "agent",
            text: "Промежуточный ответ",
            attachments: [
              { id: "codex-viewed-reference.jpg", type: "image/jpeg" },
              { id: "codex-viewed-screenshot-one.png", type: "image/png" },
              { id: "codex-viewed-screenshot-two.png", type: "image/png" },
              { id: "codex-generated-one.png", type: "image/png" },
              { id: "codex-generated-two.png", type: "image/png" },
              { id: "codex-generated-three.png", type: "image/png" },
            ],
          },
        ],
      }],
      recordHistory: (_task, history) => { recorded = structuredClone(history); },
      save: async () => {},
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    threadId: "thread-images",
    projectRoot: "C:/repo",
    title: "Images",
    chatId: 1,
  });
  const agents = result.history[0].messages.filter((message) => message.role === "agent");
  assert.equal(agents.length, 1);
  assert.equal(agents[0].text, "Три варианта показаны");
  assert.deepEqual(agents[0].attachments.map((attachment) => attachment.id), [
    "codex-generated-one.png",
    "codex-generated-two.png",
    "codex-generated-three.png",
  ]);
  assert.deepEqual(importedSources, [
    { type: "generated-path", value: "C:/generated/one.png" },
    { type: "generated-path", value: "C:/generated/two.png" },
    { type: "generated-path", value: "C:/generated/three.png" },
  ]);
  assert.equal("attachmentSources" in agents[0], false);
  assert.deepEqual(recorded, result.history);
});

test("inspected images stay internal when a turn has no generated output", () => {
  const history = codexRolloutHistory({
    generatedImageSources: {
      "turn-view-only": [{ type: "view-path", value: "C:/viewed/result.png" }],
    },
  });
  assert.deepEqual(history, []);
});

test("rollout history keeps an image-only assistant result visible", () => {
  const [exchange] = codexRolloutHistory({
    generatedImageSources: {
      "turn-image-only": [{ type: "generated-path", value: "C:/generated/image.png" }],
    },
  });
  assert.equal(exchange.messages.at(-1).role, "agent");
  assert.equal(exchange.messages.at(-1).text, "Изображение");
  assert.equal(exchange.messages.at(-1).attachmentSources.length, 1);
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
