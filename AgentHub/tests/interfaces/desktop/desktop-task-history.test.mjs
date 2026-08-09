import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopTaskHistoryFactory,
  mergeDurableTaskHistory,
} from "../../../src/interfaces/desktop/desktop-task-history.mjs";
import { mergeCompletedTaskHistory } from "../../../src/application/task-history.mjs";
import {
  CODEX_CONTEXT_PROBE_PROMPT,
  CODEX_CONTEXT_PROBE_RESPONSE,
} from "../../../src/domain/codex-context-probe.mjs";

function fixture(overrides = {}) {
  const calls = {
    binding: null,
    merged: null,
    fit: null,
    attachments: [],
    refreshes: 0,
  };
  const entries = [{
    workspaceName: "Agent HUB",
    streamName: "Themes",
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    title: "Задача",
  }];
  const sourceHistory = Array.from({ length: 4 }, (_, index) => ({
    id: `turn-${index + 1}`,
    prompt: `Вопрос ${index + 1}`,
    answer: `Ответ ${index + 1}`,
    status: index === 3 ? "running" : "completed",
    active: index === 3,
    completed: index < 3,
    startedAt: `2026-07-30T10:0${index}:00.000Z`,
    completedAt: `2026-07-30T10:0${index}:30.000Z`,
    activities: Array.from({ length: 105 }, (__, activity) => activity),
    messages: [
      {
        itemId: `user-${index + 1}`,
        clientUserMessageId: `client-${index + 1}`,
        role: "user",
        text: `Сообщение ${index + 1}`,
      },
      {
        itemId: `agent-${index + 1}`,
        role: "agent",
        phase: "final",
        text: `Ответ агента ${index + 1}`,
      },
      { role: "tool", text: "Скрыто" },
    ],
  }));
  const state = {
    activeProvider: "codex",
    threadId: "thread-1",
    chatId: 42,
    entries,
    history: sourceHistory,
    run: {
      id: "run-1",
      turnId: "turn-live",
      promptPreview: "Текущий вопрос",
      responseText: "Текущий ответ",
      clientUserMessageId: "client-live",
      responseItemId: "response-live",
      activities: [{ type: "reasoning" }],
      startedAt: "2026-07-30T11:00:00.000Z",
      messageAttachments: [{ id: "live.png", name: "live.png", type: "image/png" }],
    },
    catalogRefresh: null,
    ...overrides,
  };
  if (!state.refresh) {
    state.refresh = async () => ({ history: structuredClone(state.history) });
  }
  const desktopTaskHistory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: {
      entries: () => state.entries,
      refresh: async () => state.catalogRefresh ? state.catalogRefresh() : state.entries,
    },
    historyReader: {
      read: async (binding) => {
        calls.binding = binding;
        return { history: structuredClone(state.history) };
      },
      refresh: async (binding) => {
        calls.refreshes += 1;
        return state.refresh(binding);
      },
    },
    runs: {
      forTask: () => state.run,
    },
    historyMerger: {
      mergeActive: (history, active) => {
        calls.merged = active;
        history.push({ id: active.turnId, ...active });
      },
    },
    receipts: {
      forMessage: (message) => ({
        ...message,
        createdAt: "2026-07-30T09:59:00.000Z",
        result: {
          attachments: [{ id: `${message.clientUserMessageId}.png`, type: "image/png" }],
        },
      }),
      forTurn: () => null,
    },
    responseBudget: {
      fit: (payload, options) => {
        calls.fit = options;
        return payload;
      },
    },
    attachmentImporter: async (sources) => {
      calls.attachments.push(sources);
      return sources.map((item) => ({
        id: item.value.split("/").at(-1),
        type: "image/png",
      }));
    },
  });
  return { desktopTaskHistory, state, calls };
}

test("durable history merges equivalent synthetic final-answer copies", () => {
  const history = mergeDurableTaskHistory([{
    id: "turn-1",
    messages: [{
      itemId: "turn-1:rollout-agent:final",
      role: "agent",
      text: "Готово",
    }],
  }], [{
    id: "turn-1",
    messages: [
      { itemId: "turn-1:agent:live", role: "agent", text: "Готово" },
      { itemId: "turn-1:agent:final", role: "agent", text: "Готово" },
    ],
  }]);

  assert.equal(history[0].messages.length, 1);
  assert.equal(history[0].messages[0].text, "Готово");
});

test("desktop task history resolves selection and merges the active run", async () => {
  const { desktopTaskHistory, calls } = fixture();
  const result = await desktopTaskHistory({ limit: 2 });

  assert.deepEqual(calls.binding, {
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    taskTitle: "Agent HUB - Themes",
    chatId: 42,
  });
  assert.deepEqual(calls.merged, {
    active: true,
    turnId: "turn-live",
    prompt: "Текущий вопрос",
    answer: "Текущий ответ",
    clientUserMessageId: "client-live",
    responseItemId: "response-live",
    activities: [{ type: "reasoning" }],
    startedAt: "2026-07-30T11:00:00.000Z",
    attachments: [{ id: "live.png", name: "live.png", type: "image/png" }],
  });
  assert.equal(result.total, 5);
  assert.equal(result.title, "Agent HUB - Themes");
  assert.equal(result.start, 3);
  assert.equal(result.end, 5);
  assert.equal(result.nextBefore, 3);
  assert.deepEqual(result.items.map((item) => item.id), ["turn-4", "turn-live"]);
  assert.equal(result.items[0].messages[0].time, "2026-07-30T09:59:00.000Z");
  assert.deepEqual(result.items[0].messages[0].attachments, [{
    id: "client-4.png",
    type: "image/png",
  }]);
  assert.deepEqual(calls.fit, { maxBytes: 3_500_000 });
  assert.match(result.version, /^[A-Za-z0-9_-]{22}$/u);
});

test("desktop task history removes an already persisted context probe turn", async () => {
  const { desktopTaskHistory } = fixture({
    run: null,
    history: [{
      id: "real-turn",
      prompt: "Рабочий запрос",
      answer: "Рабочий ответ",
      completed: true,
      messages: [],
    }, {
      id: "probe-turn",
      prompt: CODEX_CONTEXT_PROBE_PROMPT,
      answer: "Рабочий ответ",
      completed: true,
      messages: [{
        itemId: "probe-user",
        role: "user",
        text: CODEX_CONTEXT_PROBE_PROMPT,
      }, {
        itemId: "probe-answer",
        role: "agent",
        text: CODEX_CONTEXT_PROBE_RESPONSE,
      }],
    }],
  });

  const result = await desktopTaskHistory({ includeActive: false, limit: 10 });

  assert.deepEqual(result.items.map((item) => item.id), ["real-turn"]);
});

test("desktop task history hides an empty maintenance completion after restart", async () => {
  const { state } = fixture({ run: null });
  state.history = [{
    id: "real-turn",
    prompt: "Рабочий запрос",
    answer: "Рабочий ответ",
    completed: true,
    messages: [],
  }, {
    id: "empty-maintenance-turn",
    prompt: "",
    answer: "Ход завершён без текстового ответа.",
    completed: true,
    messages: [{ role: "agent", text: "Ход завершён без текстового ответа." }],
  }];
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: { entries: () => state.entries },
    historyReader: { read: async () => ({ history: structuredClone(state.history) }) },
    runs: { forTask: () => null },
    latestMessage: () => ({
      turnId: "empty-maintenance-turn",
      text: "Ход завершён без текстового ответа.",
      updatedAt: "2026-08-08T19:28:32.000Z",
    }),
    historyMerger: {
      mergeActive() {},
      mergeCompleted: mergeCompletedTaskHistory,
    },
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({ includeActive: false, limit: 10 });

  assert.deepEqual(result.items.map((item) => item.id), ["real-turn"]);
});

test("desktop task history hides a stale auto-compaction transfer after rotation", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history = [{
    id: "real-turn",
    prompt: "Рабочий запрос",
    answer: "Финальный ответ",
    completed: true,
    messages: [],
  }, {
    id: "auto-compact-0",
    prompt: "Сообщение с вложением",
    answer: "Полный цикл commentary предыдущего хода",
    completed: false,
    messages: [{ role: "agent", text: "Полный цикл commentary предыдущего хода" }],
  }];

  const result = await desktopTaskHistory({ includeActive: false, limit: 10 });

  assert.deepEqual(result.items.map((item) => item.id), ["real-turn"]);
});

test("desktop task history combines sequential provider Threads from one Stream", async () => {
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => "codex",
      threadId: () => "thread-2",
      chatId: () => 42,
    },
    catalog: {
      entries: () => [{
        streamId: "stream-1",
        provider: "codex",
        projectRoot: "D:/work",
        threadId: "thread-2",
        title: "Workspace",
      }],
      threadsForStream: () => [
        { provider: "codex", threadId: "thread-1", projectRoot: "D:/work" },
        { provider: "codex", threadId: "thread-2", projectRoot: "D:/work" },
      ],
    },
    historyReader: {
      read: async ({ threadId }) => ({
        history: [{ id: `turn-${threadId}`, prompt: threadId, answer: `answer-${threadId}` }],
      }),
    },
    runs: { forTask: () => null },
    historyMerger: { mergeActive() {}, mergeCompleted() {} },
    responseBudget: { fit: (payload) => payload },
  });
  const result = await factory({ streamId: "stream-1", provider: "codex", threadId: "thread-2" });
  assert.equal(result.streamId, "stream-1");
  assert.deepEqual(result.items.map((item) => item.id), ["turn-thread-1", "turn-thread-2"]);
});

test("desktop task history returns a compact marker for an unchanged completed page", async () => {
  const { desktopTaskHistory, calls } = fixture();
  const first = await desktopTaskHistory({ limit: 2, includeActive: false });
  const unchanged = await desktopTaskHistory({
    limit: 2,
    includeActive: false,
    knownVersion: first.version,
  });

  assert.equal(calls.merged, null);
  assert.deepEqual(unchanged, {
    provider: "codex",
    threadId: "thread-1",
    notModified: true,
    version: first.version,
  });
});

test("desktop task history overlays a saved final before provider hydration catches up", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: { entries: () => state.entries },
    historyReader: {
      read: async () => ({ history: structuredClone(state.history) }),
    },
    runs: { forTask: () => null },
    latestMessage: () => ({
      turnId: "turn-4",
      text: "Сохранённый финальный ответ",
      updatedAt: "2026-07-30T10:04:45.000Z",
    }),
    historyMerger: {
      mergeActive() {},
      mergeCompleted: mergeCompletedTaskHistory,
    },
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({ limit: 1, includeActive: false });

  assert.equal(result.items[0].answer, "Сохранённый финальный ответ");
  assert.equal(result.items[0].messages.at(-1).text, "Сохранённый финальный ответ");
  assert.equal(result.items[0].completed, true);
  assert.equal(typeof desktopTaskHistory, "function");
});

test("desktop task history never assigns an old final to an unrelated active turn", async () => {
  const state = fixture({ run: null }).state;
  state.history = [{
    id: "maintenance-turn",
    prompt: "",
    answer: "",
    status: "inProgress",
    active: true,
    completed: false,
    startedAt: "2026-08-08T17:09:19.000Z",
    messages: [],
  }];
  const factory = createDesktopTaskHistoryFactory({
    selection: {
      activeProvider: () => state.activeProvider,
      threadId: () => state.threadId,
      chatId: () => state.chatId,
    },
    catalog: { entries: () => state.entries },
    historyReader: { read: async () => ({ history: structuredClone(state.history) }) },
    runs: { forTask: () => null },
    latestMessage: () => ({
      turnId: "previous-user-turn",
      text: "Релиз завершён",
      updatedAt: "2026-08-08T14:21:46.000Z",
    }),
    historyMerger: {
      mergeActive() {},
      mergeCompleted: mergeCompletedTaskHistory,
    },
    responseBudget: { fit: (payload) => payload },
  });

  const result = await factory({ limit: 10, includeActive: false });

  assert.equal(result.items[0].id, "maintenance-turn");
  assert.equal(result.items[0].answer, "");
  assert.deepEqual(result.items[0].messages, []);
});

test("desktop task history returns durable history while provider hydration is still blocked", async () => {
  let releaseRefresh;
  const blockedRefresh = new Promise((resolve) => { releaseRefresh = resolve; });
  const { desktopTaskHistory, calls } = fixture({
    run: null,
    refresh: async () => blockedRefresh,
    catalogRefresh: async () => new Promise(() => {}),
  });

  const result = await Promise.race([
    desktopTaskHistory({ limit: 1 }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("durable history did not return promptly")), 100)),
  ]);
  assert.equal(result.total, 4);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.refreshes, 1);
  releaseRefresh({ history: [] });
});

test("desktop task history exposes a new durable completion before hydration refresh", async () => {
  const blockedRefresh = new Promise(() => {});
  const { desktopTaskHistory, state } = fixture({
    run: null,
    refresh: async () => blockedRefresh,
  });
  await desktopTaskHistory({ limit: 1, includeActive: false });
  state.history.push({
    id: "turn-new",
    prompt: "Новый вопрос",
    answer: "Новый финальный ответ",
    status: "completed",
    active: false,
    completed: true,
    messages: [
      { itemId: "turn-new:user", role: "user", text: "Новый вопрос" },
      { itemId: "turn-new:agent", role: "agent", phase: "final", text: "Новый финальный ответ" },
    ],
  });

  const result = await desktopTaskHistory({ limit: 1, includeActive: false });

  assert.equal(result.items[0].id, "turn-new");
  assert.equal(result.items[0].messages[0].text, "Новый вопрос");
  assert.equal(result.items[0].messages[1].text, "Новый финальный ответ");
});

test("desktop task history imports private screenshot references for the visible page", async () => {
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  state.history[3].messages[0].attachmentSources = [{
    type: "path",
    value: "C:/Temp/codex-clipboard-test.png",
  }];

  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(calls.attachments, [[{
    type: "path",
    value: "C:/Temp/codex-clipboard-test.png",
  }]]);
  assert.deepEqual(result.items[0].messages[0].attachments, [{
    id: "codex-clipboard-test.png",
    type: "image/png",
  }]);
});

test("desktop task history hides Codex image transport tags but keeps the attachment", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  const imageTag = [
    "Посмотри",
    '<image name="[Image #1]" path="C:\\Temp\\screen.png">',
    "</image>",
  ].join("\n");
  state.history[3].prompt = imageTag;
  state.history[3].messages[0].text = imageTag;
  state.history[3].messages[0].attachments = [{
    id: "screen.png",
    name: "screen.png",
    type: "image/png",
  }];
  state.history[3].messages[1].text = "Пример <image path=\"public.png\"></image>";

  const result = await desktopTaskHistory({ limit: 1 });

  assert.equal(result.items[0].prompt, "Посмотри");
  assert.equal(result.items[0].messages[0].text, "Посмотри");
  assert.deepEqual(result.items[0].messages[0].attachments, [{
    id: "screen.png",
    name: "screen.png",
    type: "image/png",
  }]);
  assert.equal(
    result.items[0].messages[1].text,
    'Пример <image path="public.png"></image>',
  );
});

test("image-only durable messages keep a visible attachment label", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history[3].messages[0].text = [
    '<image name="[Image #1]" path="C:\\Temp\\screen.png">',
    "</image>",
  ].join("\n");
  state.history[3].messages[0].attachments = [{ id: "screen.png", type: "image/png" }];

  const result = await desktopTaskHistory({ limit: 1 });

  assert.equal(result.items[0].messages[0].text, "Изображение");
  assert.equal(result.items[0].messages[0].attachments.length, 1);
});

test("desktop task history imports generated images attached to an assistant message", async () => {
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  state.history[3].messages[1].attachmentSources = [{
    type: "generated-path",
    value: "C:/Users/test/.codex/generated_images/thread/call.png",
  }];

  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(calls.attachments, [[{
    type: "generated-path",
    value: "C:/Users/test/.codex/generated_images/thread/call.png",
  }]]);
  assert.deepEqual(result.items[0].messages[1].attachments, [{
    id: "call.png",
    type: "image/png",
  }]);
});

test("desktop task history restores screenshot sources lost from the durable cache", async () => {
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  const providerHistory = structuredClone(state.history);
  providerHistory[3].messages[0].attachmentSources = [{
    type: "data",
    value: "data:image/png;base64,aGVsbG8=",
  }];
  state.history[3].messages[0].attachments = [];
  state.refresh = async () => ({ history: providerHistory });

  const initial = await desktopTaskHistory({ limit: 1 });
  assert.deepEqual(initial.items[0].messages[0].attachments, []);
  await new Promise((resolve) => setImmediate(resolve));
  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(calls.attachments, [[{
    type: "data",
    value: "data:image/png;base64,aGVsbG8=",
  }]]);
  assert.deepEqual(result.items[0].messages[0].attachments, [{
    id: "png;base64,aGVsbG8=",
    type: "image/png",
  }]);
});

test("desktop task history exposes structured response annotations", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history[3].promptAnnotations = [{ text: "Цитата", annotation: "Комментарий" }];
  state.history[3].promptRequest = "Общий вопрос";
  state.history[3].messages[0].responseAnnotations = state.history[3].promptAnnotations;
  state.history[3].messages[0].responseAnnotationRequest = state.history[3].promptRequest;

  const result = await desktopTaskHistory({ limit: 1 });

  assert.deepEqual(result.items[0].promptAnnotations, [{ text: "Цитата", annotation: "Комментарий" }]);
  assert.equal(result.items[0].promptRequest, "Общий вопрос");
  assert.deepEqual(result.items[0].messages[0].responseAnnotations, [{
    text: "Цитата",
    annotation: "Комментарий",
  }]);
});

test("desktop task history preserves pagination, field limits and response budget", async () => {
  const longAnswer = "я".repeat(2_000);
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  state.history[1].answer = longAnswer;
  state.history[1].messages[1].text = longAnswer;

  const result = await desktopTaskHistory({
    provider: "codex",
    threadId: "thread-1",
    before: 3,
    limit: 2,
    maxAnswerChars: 1_000,
    maxResponseBytes: 1,
  });

  assert.equal(result.start, 1);
  assert.equal(result.end, 3);
  assert.equal(result.nextBefore, 1);
  assert.equal(result.items[0].answer.length, 1_000);
  assert.equal(result.items[0].messages[1].text.length, 1_000);
  assert.equal(result.items[0].activities.length, 105);
  assert.equal(result.items[0].messages.some((message) => message.role === "tool"), false);
  assert.deepEqual(calls.fit, { maxBytes: 64 * 1_024 });
});

test("desktop task history can await provider hydration for a completed image response", async () => {
  const { desktopTaskHistory, state, calls } = fixture({ run: null });
  const providerHistory = structuredClone(state.history);
  providerHistory[3].active = false;
  providerHistory[3].completed = true;
  providerHistory[3].status = "completed";
  providerHistory[3].messages[1].attachmentSources = [{
    type: "generated-path",
    value: "C:/Users/test/.codex/generated_images/thread/generated.png",
  }];
  state.refresh = async () => ({ history: providerHistory });

  const result = await desktopTaskHistory({
    limit: 1,
    includeActive: false,
    refreshSource: true,
  });

  assert.equal(calls.refreshes, 1);
  assert.deepEqual(result.items[0].messages[1].attachments, [{
    id: "generated.png",
    type: "image/png",
  }]);
});

test("desktop task history returns the preceding page for a supplied cursor", async () => {
  const { desktopTaskHistory, state } = fixture({ run: null });
  state.history = Array.from({ length: 27 }, (_, index) => ({
    id: `turn-${index + 1}`,
    prompt: `Вопрос ${index + 1}`,
    answer: `Ответ ${index + 1}`,
    status: "completed",
    completed: true,
    startedAt: `2026-07-30T10:${String(index).padStart(2, "0")}:00.000Z`,
    completedAt: `2026-07-30T10:${String(index).padStart(2, "0")}:30.000Z`,
    messages: [
      { itemId: `user-${index + 1}`, role: "user", text: `Сообщение ${index + 1}` },
      { itemId: `agent-${index + 1}`, role: "agent", phase: "final", text: `Ответ ${index + 1}` },
    ],
  }));

  const newest = await desktopTaskHistory({ limit: 10 });
  const older = await desktopTaskHistory({ before: newest.nextBefore, limit: 10 });

  assert.deepEqual(newest.items.map((item) => item.id), [
    "turn-18", "turn-19", "turn-20", "turn-21", "turn-22",
    "turn-23", "turn-24", "turn-25", "turn-26", "turn-27",
  ]);
  assert.equal(newest.nextBefore, 17);
  assert.deepEqual(older.items.map((item) => item.id), [
    "turn-8", "turn-9", "turn-10", "turn-11", "turn-12",
    "turn-13", "turn-14", "turn-15", "turn-16", "turn-17",
  ]);
  assert.equal(older.start, 7);
  assert.equal(older.end, 17);
  assert.equal(older.nextBefore, 7);
});

test("desktop task history rejects invalid and missing tasks", async () => {
  const { desktopTaskHistory, state } = fixture();
  await assert.rejects(
    desktopTaskHistory({ provider: "other", threadId: "thread-1" }),
    /Укажите корректную задачу/,
  );
  state.entries = [];
  await assert.rejects(
    desktopTaskHistory({ provider: "codex", threadId: "missing" }),
    /Задача не найдена/,
  );
});
