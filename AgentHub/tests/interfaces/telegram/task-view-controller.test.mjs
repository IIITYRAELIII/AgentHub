import assert from "node:assert/strict";
import test from "node:test";
import {
  codexRolloutHistory,
  taskViewMessages,
  TaskViewController,
} from "../../../src/interfaces/telegram/task-view-controller.mjs";
import { createInterstreamMessage } from "../../../src/domain/interstream-message.mjs";

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

test("detached Test Contour history never probes the provider", async () => {
  const cached = [{
    id: "turn-cached",
    prompt: "Запрос",
    answer: "Ответ",
    completed: true,
    messages: [],
  }];
  let providerReads = 0;
  const view = controller({
    workspaceCatalogStore: {
      thread: () => ({ detachedAtMs: 1 }),
    },
    ensureCodex: async () => { providerReads += 1; },
    readCodexThread: async () => { providerReads += 1; return { thread: { turns: [] } }; },
    taskSyncStore: {
      history: () => structuredClone(cached),
      snapshot: () => ({ active: false }),
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    threadId: "production-thread",
    projectRoot: "C:/repo",
    title: "Historical task",
    chatId: 1,
  });

  assert.deepEqual(result.history, cached);
  assert.equal(providerReads, 0);
});

test("Codex history refresh reads the rollout directly without blocking App Server", async () => {
  let providerReads = 0;
  let snapshotInput = null;
  let rolloutOptions = null;
  const input = createInterstreamMessage({
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    requestId: "telegram-history-1",
    text: "Новый запрос",
  });
  const view = controller({
    findCodexRolloutPath: async () => "C:/rollout.jsonl",
    ensureCodex: async () => { providerReads += 1; },
    readCodexThread: async () => { providerReads += 1; return null; },
    readCodexRolloutActivity: async (_path, options) => {
      rolloutOptions = options;
      return {
        activeTurnIds: ["turn-live"],
        userMessages: {
          "turn-live": [{
            text: input,
            clientUserMessageId: "mcp:telegram-history-1",
            origin: {
              workspaceId: "workspace-1",
              workspaceName: "Agent HUB",
              streamId: "stream-architect",
              streamName: "Architect",
              provider: "codex",
              requestId: "telegram-history-1",
            },
          }],
        },
        latestMessages: { "turn-live": "Промежуточный ответ" },
        finalMessages: {},
      };
    },
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
  assert.equal(rolloutOptions.tailBytes, 16 * 1024 * 1024);
  assert.deepEqual(result.history.map((item) => item.id), ["turn-old", "turn-live"]);
  assert.equal(result.history[1].prompt, "Новый запрос");
  assert.equal(result.history[1].messages[0].text, "Новый запрос");
});

for (const directRollout of [true, false]) test(`Codex history returns committed active user chronology without losing requested detail (${directRollout ? "rollout" : "App Server"})`, async () => {
  const sourceUser = (id) => ({ role: "user", text: "same", sourceOccurrenceId: `codex-rollout:${id.repeat(64)}` });
  const ownedUser = { role: "user", text: "owned", clientUserMessageId: "owned-command" };
  const olderTurn = { id: "turn-old", prompt: "old", completed: true,
    messages: [{ role: "agent", text: "older full answer" }],
    activities: [{ type: "tool", text: "older full tool detail" }] };
  const activeTurn = { id: "turn-live", active: true, completed: false,
    messages: [sourceUser("a"), ownedUser, { role: "agent", text: "current full answer" }],
    activities: [{ type: "tool", text: "current full tool detail" }] };
  let durable = [olderTurn, activeTurn];
  const view = controller({
    findCodexRolloutPath: async () => directRollout ? "C:/rollout.jsonl" : null,
    ensureCodex: async () => {},
    readCodexThread: async () => ({ thread: { turns: [] } }),
    readCodexRolloutActivity: async () => ({ activeTurnIds: [], userMessages: {}, finalMessages: {} }),
    readCodexSnapshot: async () => ({ active: true, turnId: "turn-live" }),
    taskSyncStore: {
      history: () => structuredClone(durable),
      recordHistory: async () => {
        // Another observation won the write lane. The bounded durable page
        // owns user chronology, but does not replace the requested rich page.
        durable = [{ ...activeTurn, messages: [ownedUser, sourceUser("a"), sourceUser("c")] }];
      },
      save: async () => {},
    },
  });
  const result = await view.readHistory({ provider: "codex", threadId: "thread-shared", projectRoot: "C:/repo", chatId: 1 });
  assert.deepEqual(result.history.map((turn) => turn.id), ["turn-old", "turn-live"]);
  assert.deepEqual(result.history[0].messages, olderTurn.messages);
  assert.deepEqual(result.history[0].activities, olderTurn.activities);
  const live = result.history[1];
  assert.deepEqual(live.messages.filter((message) => message.role === "user").map((message) => message.clientUserMessageId || message.sourceOccurrenceId),
    ["owned-command", sourceUser("a").sourceOccurrenceId, sourceUser("c").sourceOccurrenceId]);
  assert.equal(live.messages.find((message) => message.role === "agent").text, "current full answer");
  assert.deepEqual(live.activities, activeTurn.activities);
});

test("Codex history removes a context probe turn identified by rollout metadata", async () => {
  const probeTurnId = "019ffc97-c47f-7de0-aea6-00e1da772d7d";
  const realTurnId = "019ffc98-65c9-7b02-a2f1-402378bf70e4";
  let recorded = null;
  const view = controller({
    ensureCodex: async () => {},
    readCodexThread: async () => ({ thread: {
      path: "C:/rollout.jsonl",
      turns: [{
        id: probeTurnId,
        status: "completed",
        items: [
          {
            type: "userMessage",
            content: [{ type: "text", text: "<recommended_plugins>service context</recommended_plugins>" }],
          },
          {
            type: "userMessage",
            content: [{ type: "text", text: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1" }],
          },
          { type: "agentMessage", phase: "final", text: "AGENT_HUB_CONTEXT_PROBE_OK_V1" },
        ],
      }, {
        id: realTurnId,
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "Почему я это вижу?" }] },
          { type: "agentMessage", phase: "final", text: "Исправлено" },
        ],
      }],
    } }),
    readCodexRolloutActivity: async () => ({
      internalTurnIds: [probeTurnId],
      userMessages: {},
      latestMessages: {},
      finalMessages: { [probeTurnId]: "Неверно привязанный ответ" },
      generatedImageSources: {
        [probeTurnId]: [{ type: "generated-path", value: "C:/generated/probe.png" }],
      },
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => [{
        id: probeTurnId,
        prompt: "<recommended_plugins>service context</recommended_plugins>",
        answer: "AGENT_HUB_CONTEXT_PROBE_OK_V1",
        completed: true,
      }],
      recordHistory: (_task, history) => { recorded = structuredClone(history); },
      save: async () => {},
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    threadId: "thread-probe",
    projectRoot: "C:/repo",
    title: "Probe",
    chatId: 1,
  });

  assert.deepEqual(result.history.map((item) => item.id), [realTurnId]);
  assert.deepEqual(recorded.map((item) => item.id), [realTurnId]);
});

test("Codex history uses persisted probe ids when the rollout tail no longer contains its prompt", async () => {
  const probeTurnId = "019ffc97-c47f-7de0-aea6-00e1da772d7d";
  const view = controller({
    findCodexRolloutPath: async () => "C:/rollout.jsonl",
    contextProbeTurnIds: () => [probeTurnId],
    readCodexRolloutActivity: async () => ({
      userMessages: {},
      latestMessages: {},
      finalMessages: { [probeTurnId]: "Старый служебный ход" },
      generatedImageSources: {
        [probeTurnId]: [{ type: "generated-path", value: "C:/generated/probe.png" }],
      },
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => [],
      recordHistory: () => {},
      save: async () => {},
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    threadId: "thread-probe",
    projectRoot: "C:/repo",
    title: "Probe",
    chatId: 1,
  });
  assert.deepEqual(result.history, []);
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

test("finished Claude turn returns from the transcript under its own identity", async () => {
  const cached = [{
    id: "hub-run-uuid",
    prompt: "123",
    answer: "",
    status: "inProgress",
    active: true,
    completed: false,
    startedAt: "2026-08-26T22:57:46.000Z",
    messages: [{
      itemId: "hub-run-uuid:user:0",
      role: "user",
      text: "123",
      clientUserMessageId: "client-1",
    }],
  }];
  let recorded = null;
  const task = {
    provider: "claude",
    threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    projectRoot: "C:/repo",
    title: "Claude task",
  };
  const view = controller({
    readClaudeSnapshot: async () => ({
      active: false,
      history: [{
        id: "transcript-uuid",
        prompt: "123",
        answer: "Готово",
        status: "completed",
        active: false,
        completed: true,
        startedAt: "2026-08-26T22:58:00.000Z",
        messages: [
          { itemId: "transcript-uuid", role: "user", text: "123" },
          { itemId: "transcript-agent", role: "agent", text: "Готово" },
        ],
      }],
    }),
    taskRuns: { forTask: () => null },
    taskSyncStore: {
      history: () => structuredClone(cached),
      recordHistory: (_task, history) => { recorded = structuredClone(history); },
      save: async () => {},
    },
  });
  const result = await view.readHistory({ ...task, chatId: 1 });
  assert.deepEqual(result.history.map((item) => item.id), ["transcript-uuid"]);
  assert.equal(result.history[0].answer, "Готово");
  assert.equal(
    result.history[0].messages.find((message) => message.role === "user").clientUserMessageId,
    "client-1",
  );
  assert.deepEqual(recorded.map((item) => item.id), ["transcript-uuid"]);
});

test("Claude turn read later than its successor keeps its place in time", async () => {
  const cached = [{
    id: "recent",
    prompt: "Новый запрос",
    answer: "Новый ответ",
    status: "completed",
    active: false,
    completed: true,
    startedAt: "2026-08-26T20:46:15.000Z",
    messages: [{ itemId: "recent", role: "user", text: "Новый запрос" }],
  }];
  const task = {
    provider: "claude",
    threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    projectRoot: "C:/repo",
    title: "Claude task",
  };
  const view = controller({
    readClaudeSnapshot: async () => ({
      active: false,
      history: [{
        id: "older",
        prompt: "Старый запрос",
        answer: "Старый ответ",
        status: "completed",
        active: false,
        completed: true,
        startedAt: "2026-08-21T19:12:32.000Z",
        messages: [{ itemId: "older", role: "user", text: "Старый запрос" }],
      }],
    }),
    taskRuns: { forTask: () => null },
    taskSyncStore: {
      history: () => structuredClone(cached),
      recordHistory: () => {},
      save: async () => {},
    },
  });
  const result = await view.readHistory({ ...task, chatId: 1 });
  assert.deepEqual(result.history.map((item) => item.id), ["older", "recent"]);
});

test("Claude turns repeating one prompt are not folded into each other", async () => {
  const cached = [];
  const task = {
    provider: "claude",
    threadId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    projectRoot: "C:/repo",
    title: "Claude task",
  };
  const view = controller({
    readClaudeSnapshot: async () => ({
      active: false,
      history: [
        {
          id: "first",
          prompt: "123",
          answer: "Первый ответ",
          status: "completed",
          active: false,
          completed: true,
          startedAt: "2026-08-13T18:00:08.000Z",
          messages: [{ itemId: "first", role: "user", text: "123" }],
        },
        {
          id: "second",
          prompt: "123",
          answer: "Второй ответ",
          status: "completed",
          active: false,
          completed: true,
          startedAt: "2026-08-26T20:46:15.000Z",
          messages: [{ itemId: "second", role: "user", text: "123" }],
        },
      ],
    }),
    taskRuns: { forTask: () => null },
    taskSyncStore: {
      history: () => structuredClone(cached),
      recordHistory: () => {},
      save: async () => {},
    },
  });
  const result = await view.readHistory({ ...task, chatId: 1 });
  assert.deepEqual(result.history.map((item) => item.id), ["first", "second"]);
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

test("subagent rollout prompt is attributed to the parent Workspace Stream agent", async () => {
  let recorded = null;
  const view = controller({
    findCodexRolloutPath: async () => "C:/child-rollout.jsonl",
    readCodexRolloutActivity: async () => ({
      parentThreadId: "parent-thread",
      activeTurnIds: [],
      userMessages: { "child-turn": [{ text: "Проверь SQLite recovery" }] },
      latestMessages: {},
      finalMessages: { "child-turn": "Проверено" },
    }),
    readCodexSnapshot: async () => null,
    workspaceCatalogStore: {
      thread: ({ threadId }) => threadId === "parent-thread" ? { streamId: "architect" } : null,
      stream: () => ({ id: "architect", workspaceId: "hub", name: "Architect" }),
      workspace: () => ({ id: "hub", name: "Agent HUB" }),
    },
    taskSyncStore: {
      history: () => [],
      recordHistory: (_task, history) => { recorded = structuredClone(history); },
      save: async () => {},
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    threadId: "child-thread",
    projectRoot: "C:/repo",
    title: "Child",
    chatId: 1,
  });

  assert.equal(result.history[0].messages[0].author, "Agent HUB - Architect (Codex)");
  assert.equal(recorded[0].messages[0].author, "Agent HUB - Architect (Codex)");
});

test("a final rollout answer cannot remain active", () => {
  const [exchange] = codexRolloutHistory({
    userMessages: { "turn-1": [{ text: "Вопрос" }] },
    finalMessages: { "turn-1": "Готово" },
    activeTurnIds: ["turn-1"],
  });

  assert.equal(exchange.completed, true);
  assert.equal(exchange.active, false);
  assert.equal(exchange.status, "completed");
});

test("task view keeps message order, authors and message-specific attachments", () => {
  const messages = taskViewMessages({
    prompt: "Устаревший prompt",
    answer: "Устаревший answer",
    messages: [
      {
        role: "user",
        author: "Agent HUB · Themes (Codex)",
        text: "Первое",
        attachments: [{ id: "first.png", name: "Первое.png" }],
      },
      { role: "user", text: "Второе", attachments: [{ id: "second.txt", name: "Второе.txt" }] },
      { role: "agent", text: "Ответ", attachments: [{ id: "answer.png", name: "Ответ.png" }] },
    ],
  });

  assert.deepEqual(messages.map((message) => message.text), ["Первое", "Второе", "Ответ"]);
  assert.equal(messages[0].author, "Agent HUB · Themes (Codex)");
  assert.deepEqual(messages.map((message) => message.attachments.map((attachment) => attachment.id)), [
    ["first.png"],
    ["second.txt"],
    ["answer.png"],
  ]);
});

test("active task view keeps a completed subagent report", () => {
  const messages = taskViewMessages({
    messages: [
      { role: "user", text: "Проверь" },
      { role: "agent", text: "Промежуточный ответ" },
      { role: "agent", kind: "subagent", author: "Субагент (Sol)", text: "Отчёт Sol" },
    ],
  }, { includeAgent: false });

  assert.deepEqual(messages.map(({ role, author, text }) => ({ role, author, text })), [{
    role: "user", author: undefined, text: "Проверь",
  }, {
    role: "agent", author: "Субагент (Sol)", text: "Отчёт Sol",
  }]);
});

test("task view renders every message and ignores a stale completed registry run", async () => {
  const sent = [];
  const view = controller({
    taskRuns: {
      forTask: () => ({
        status: "completed",
        turnId: "turn-1",
        promptPreview: "Устаревший prompt",
        responseText: "Устаревший промежуточный ответ",
      }),
    },
    deleteTaskMessages: async () => {},
    sendRunMessage: async () => {},
    runTaskTitle: () => "Задача",
    sendTaskViewText: async (...args) => sent.push(args),
  });
  view.readHistory = async () => ({
    history: [{
      id: "turn-1",
      active: false,
      completed: true,
      messages: [
        { role: "user", author: "Agent HUB · Themes (Codex)", text: "Первое", attachments: [{ id: "one.png" }] },
        { role: "agent", text: "Промежуточное", attachments: [{ id: "two.png" }] },
        { role: "user", text: "Второе", attachments: [{ id: "three.txt" }] },
        { role: "agent", phase: "final_answer", text: "Финал", attachments: [{ id: "four.png" }] },
      ],
    }],
    snapshot: null,
  });

  await view.render({ provider: "codex", projectRoot: "D:/repo", threadId: "thread-1" }, 7);

  assert.deepEqual(sent.map((call) => [call[1], call[2], call[4]?.map((item) => item.id)]), [
    ["👤 Agent HUB · Themes (Codex)", "Первое", ["one.png"]],
    ["🤖 Codex", "Промежуточное", ["two.png"]],
    ["👤 Вы", "Второе", ["three.txt"]],
    ["🤖 Codex", "Финал", ["four.png"]],
  ]);
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

test("rollout history attaches explicitly displayed local images to the final answer", () => {
  const [exchange] = codexRolloutHistory({
    userMessages: { "turn-image": [{ text: "Покажи фон" }] },
    finalMessages: { "turn-image": "Показал изображение выше." },
    generatedImageSources: {
      "turn-image": [{ type: "display-path", value: "D:/work/WIP/final.png" }],
    },
  });
  const assistant = exchange.messages.find((message) => message.role === "agent");
  assert.deepEqual(assistant.attachmentSources, [{
    type: "display-path",
    value: "D:/work/WIP/final.png",
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
  let storedHistory = [{
    id: turnId,
    prompt: "Это не повторится больше?",
    answer: "Нет, при обычных запусках не повторится.",
    completed: true,
    messages: [{
      itemId: "accepted-user",
      clientUserMessageId: "accepted-user",
      role: "user",
      text: "Managed command",
    }, {
      itemId: "temporary-user",
      role: "user",
      text: "Это не повторится больше?",
    }],
  }];
  const view = controller({
    findCodexRolloutPath: async () => "C:/rollout.jsonl",
    readCodexRolloutActivity: async () => ({
      userMessageSnapshotAuthority: "complete",
      userMessages: { [turnId]: [{
        itemId: "rollout-user",
        clientUserMessageId: "accepted-user",
        role: "user",
        text: prompt,
      }] },
      finalMessages: { [turnId]: "Нет, при обычных запусках не повторится." },
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => structuredClone(storedHistory),
      recordHistory: (_task, history) => { storedHistory = structuredClone(history); },
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
  const annotated = result.history[0].messages.find((message) => (
    message.role === "user" && message.responseAnnotations?.length
  ));
  assert.deepEqual(annotated.responseAnnotations, [{
    text: "миграция полностью завершена.",
    annotation: "",
  }]);
  assert.deepEqual(
    result.history[0].messages.filter((message) => message.role === "user")
      .map((message) => message.clientUserMessageId ?? message.itemId),
    ["accepted-user", "temporary-user"],
  );
  const repeated = await view.readHistory({
    provider: "codex",
    threadId: "019f75bd-3fd4-7e32-9dc9-0177a261a117",
    projectRoot: "C:/repo",
    title: "Agent HUB 1",
    chatId: 1,
  });
  assert.deepEqual(
    repeated.history[0].messages.filter((message) => message.role === "user"),
    result.history[0].messages.filter((message) => message.role === "user"),
  );
});

test("Telegram history replays cumulative incremental rollout occurrences exactly once", async () => {
  const turnId = "019fc8c5-ed6c-72d3-9f37-02cb9a797791";
  const first = {
    itemId: "colliding-provider-id",
    role: "user",
    text: "Одинаковый текст",
    sourceOccurrenceId: `codex-rollout:${"7".repeat(64)}`,
  };
  const appended = {
    ...first,
    sourceOccurrenceId: `codex-rollout:${"8".repeat(64)}`,
  };
  let observed = [first];
  let storedHistory = [];
  const view = controller({
    findCodexRolloutPath: async () => "C:/rollout.jsonl",
    readCodexRolloutActivity: async () => ({
      userMessageSnapshotAuthority: "incremental",
      userMessageSnapshotAuthorityByTurnId: { [turnId]: "incremental" },
      userMessages: { [turnId]: structuredClone(observed) },
      latestMessages: { [turnId]: "Working" },
      activeTurnIds: [turnId],
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => structuredClone(storedHistory),
      recordHistory: (_task, history) => { storedHistory = structuredClone(history); },
      save: async () => {},
    },
  });
  const binding = {
    provider: "codex",
    threadId: "019f75bd-3fd4-7e32-9dc9-0177a261a118",
    projectRoot: "C:/repo",
    title: "Agent HUB",
    chatId: 1,
  };

  await view.readHistory(binding);
  await view.readHistory(binding);
  await view.readHistory(binding);
  assert.equal(storedHistory[0].messages.filter((message) => message.role === "user").length, 1);

  observed = [first, appended];
  await view.readHistory(binding);
  await view.readHistory(binding);
  assert.deepEqual(
    storedHistory[0].messages.filter((message) => message.role === "user")
      .map((message) => message.sourceOccurrenceId),
    [first.sourceOccurrenceId, appended.sourceOccurrenceId],
  );
});

test("Telegram history replaces an App Server occurrence enriched with exact identity", async () => {
  const turnId = "telegram-enrichment-turn";
  const sourceOccurrenceId = `codex-app-server:${"e".repeat(64)}`;
  const initial = { role: "user", text: "Provider projection", sourceOccurrenceId };
  const enriched = {
    role: "user",
    text: "Accepted projection",
    sourceOccurrenceId,
    clientUserMessageId: "telegram-accepted",
  };
  let observed = [initial];
  let storedHistory = [];
  const view = controller({
    findCodexRolloutPath: async () => "C:/rollout.jsonl",
    readCodexRolloutActivity: async () => ({
      userMessageSnapshotAuthority: "incremental",
      userMessageSnapshotAuthorityByTurnId: { [turnId]: "incremental" },
      userMessages: { [turnId]: structuredClone(observed) },
      latestMessages: { [turnId]: "Working" },
      activeTurnIds: [turnId],
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => structuredClone(storedHistory),
      recordHistory: (_task, history) => { storedHistory = structuredClone(history); },
      save: async () => {},
    },
  });
  const binding = {
    provider: "codex",
    threadId: "telegram-enrichment-thread",
    projectRoot: "C:/repo",
    title: "Agent HUB",
    chatId: 1,
  };

  await view.readHistory(binding);
  observed = [enriched];
  await view.readHistory(binding);
  observed = [initial];
  await view.readHistory(binding);

  const users = storedHistory[0].messages.filter((message) => message.role === "user");
  assert.equal(users.length, 1);
  assert.equal(users[0].clientUserMessageId, "telegram-accepted");
});

test("Codex refresh preserves accepted identities and every unproven provider occurrence", async () => {
  const turnId = "01a068fd-a375-70c1-bc78-7bb15ab3f81c";
  const accepted = [
    {
      itemId: "local-root",
      role: "user",
      text: "Одинаковый текст",
      clientUserMessageId: "accepted-root",
      origin: { streamId: "owned-stream" },
    },
    { itemId: "local-steer-1", role: "user", text: "Одинаковый текст", clientUserMessageId: "accepted-steer-1" },
    { itemId: "external-owned", role: "user", text: "Одинаковый текст" },
    { itemId: "local-steer-2", role: "user", text: "Финальный steer", clientUserMessageId: "accepted-steer-2" },
  ];
  let recorded = null;
  const view = controller({
    findCodexRolloutPath: async () => "",
    ensureCodex: async () => {},
    readCodexThread: async () => ({ thread: {
      path: "C:/bounded-tail.jsonl",
      turns: [{
        id: turnId,
        status: "completed",
        items: [
          {
            id: "provider-root",
            type: "userMessage",
            clientId: "accepted-root",
            content: [{ type: "text", text: "Подменённый provider root" }],
          },
          { id: "provider-tail", type: "userMessage", content: [{ type: "text", text: "Финальный steer" }] },
          { id: "provider-answer", type: "agentMessage", text: "Готово", phase: "final_answer" },
        ],
      }],
    } }),
    readCodexRolloutActivity: async () => ({
      userMessages: { [turnId]: [{ itemId: "rollout-user:0", role: "user", text: "Финальный steer" }] },
      finalMessages: { [turnId]: "Готово" },
    }),
    readCodexSnapshot: async () => ({ active: false }),
    taskSyncStore: {
      history: () => [{
        id: turnId,
        prompt: "Одинаковый текст",
        completed: false,
        messages: structuredClone(accepted),
      }],
      recordHistory: (_task, history) => { recorded = structuredClone(history); },
      save: async () => {},
    },
  });

  const result = await view.readHistory({
    provider: "codex",
    threadId: "production-shaped-thread",
    projectRoot: "C:/repo",
    title: "Agent HUB",
    chatId: 1,
  });

  const users = result.history[0].messages.filter((message) => message.role === "user");
  assert.deepEqual(users.map((message) => message.clientUserMessageId).filter(Boolean), [
    "accepted-root",
    "accepted-steer-1",
    "accepted-steer-2",
  ]);
  assert.deepEqual(users.map((message) => message.text), [
    "Одинаковый текст",
    "Одинаковый текст",
    "Одинаковый текст",
    "Финальный steer",
    "Финальный steer",
    "Финальный steer",
  ]);
  assert.equal(users.some((message) => message.itemId === "provider-tail"), true);
  assert.equal(users.some((message) => message.itemId === "rollout-user:0"), true);
  assert.equal(result.history[0].messages.filter((message) => message.role === "agent").length, 1);
  assert.equal(result.history[0].prompt, "Одинаковый текст");
  assert.deepEqual(users[0].origin, { streamId: "owned-stream" });
  assert.equal(users.some((message) => message.itemId === "external-owned"), true);
  assert.deepEqual(recorded, result.history);
});
