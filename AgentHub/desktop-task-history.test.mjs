import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopTaskHistoryFactory } from "./desktop-task-history.mjs";
import { mergeCompletedTaskHistory } from "./task-history.mjs";

function fixture(overrides = {}) {
  const calls = {
    binding: null,
    merged: null,
    fit: null,
    attachments: [],
    refreshes: 0,
  };
  const entries = [{
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

test("desktop task history resolves selection and merges the active run", async () => {
  const { desktopTaskHistory, calls } = fixture();
  const result = await desktopTaskHistory({ limit: 2 });

  assert.deepEqual(calls.binding, {
    provider: "codex",
    projectRoot: "D:/work",
    threadId: "thread-1",
    taskTitle: "Задача",
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
  assert.equal(result.items[0].activities.length, 100);
  assert.equal(result.items[0].messages.some((message) => message.role === "tool"), false);
  assert.deepEqual(calls.fit, { maxBytes: 64 * 1_024 });
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
