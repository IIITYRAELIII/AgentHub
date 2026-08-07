import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(
  new URL("../../assets/mini-app/message-lifecycle.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context);
const lifecycle = context.AgentHubMessageLifecycle;
const hubClientSource = await readFile(
  new URL("../../assets/mini-app/hub-client.js", import.meta.url),
  "utf8",
);
const miniAppSource = await readFile(
  new URL("../../assets/mini-app/app.js", import.meta.url),
  "utf8",
);
const compositionDirectory = new URL("../../src/composition/", import.meta.url);
const serverSource = (await Promise.all(
  (await readdir(compositionDirectory))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => readFile(new URL(name, compositionDirectory), "utf8")),
)).join("\n");
const codexEventSource = await readFile(
  new URL("../../src/providers/codex/codex-event-service.mjs", import.meta.url),
  "utf8",
);
const codexContextMaintenanceSource = await readFile(
  new URL("../../src/providers/codex/codex-context-maintenance-service.mjs", import.meta.url),
  "utf8",
);

function message(itemId, text) {
  return {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    clientUserMessageId: itemId,
    role: "user",
    text,
  };
}

test("chat history fallback preserves the reader position after prepending a page", () => {
  assert.match(miniAppSource, /scrollHeight:\s*chatScroll\.scrollHeight/u);
  assert.match(
    miniAppSource,
    /addedHeight\s*=\s*Math\.max\(0, chatScroll\.scrollHeight - anchor\.scrollHeight\)/u,
  );
  assert.match(miniAppSource, /chatScroll\.scrollTop\s*=\s*anchor\.scrollTop \+ addedHeight/u);
});

test("message lifecycle reconciles user messages by the official client id", () => {
  const first = message("client-1", "Первое уточнение");
  const second = message("client-2", "Второе уточнение");
  const server = [
    { ...first, itemId: "server-item-1", text: "Серверное первое" },
    { ...second, itemId: "server-item-2", text: "Серверное второе" },
  ];
  const result = lifecycle.reconcile(server, [first, second]);
  assert.deepEqual([...result.matchedIds], ["client-1", "client-2"]);
  assert.equal(result.matches[0].local.clientUserMessageId, "client-1");
  assert.equal(result.matches[1].local.clientUserMessageId, "client-2");
});

test("response annotation envelopes become structured user messages", () => {
  const raw = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([
      { text: "Первая цитата", annotation: "Первый комментарий" },
      { text: "Вторая цитата", annotation: "" },
    ]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "Общий вопрос",
  ].join("\n");
  const normalized = lifecycle.normalizedUserMessage({ role: "user", text: raw });
  assert.equal(normalized.text, "Общий вопрос");
  assert.equal(normalized.responseAnnotationRequest, "Общий вопрос");
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.responseAnnotations)),
    [
      { text: "Первая цитата", annotation: "Первый комментарий" },
      { text: "Вторая цитата", annotation: "" },
    ],
  );
  assert.doesNotMatch(normalized.text, /response-annotations|My request for Codex/iu);
});

test("message lifecycle removes a replayed server echo before optimistic reconciliation", () => {
  const local = message("client-1", "Сообщение отправлено один раз");
  const server = lifecycle.deduplicateConversationMessages([
    { ...local, itemId: "server-item-first" },
    { ...local, itemId: "server-item-replayed" },
  ]);
  assert.equal(server.length, 1);
  const result = lifecycle.reconcile(server, [local]);
  assert.equal(result.matches.length, 1);
  assert.deepEqual([...result.matchedIds], ["client-1"]);
});

test("accepted optimistic message and rebound server echo render as one card", () => {
  const clientUserMessageId = "b40b178a-6f2d-4c1c-8922-558ab1070c06";
  const server = {
    provider: "codex",
    threadId: "canonical-thread",
    turnId: "turn-1",
    itemId: "server-user-item",
    clientUserMessageId,
    role: "user",
    text: "Одно сообщение",
    time: "2026-08-05T06:00:11.049Z",
  };
  const optimistic = {
    provider: "codex",
    threadId: "temporary-thread-alias",
    turnId: "turn-1",
    itemId: "receipt-1",
    clientUserMessageId,
    role: "user",
    text: "Одно сообщение",
    deliveryState: "accepted",
    delivery: "Принято",
    failed: false,
  };

  const reconciled = lifecycle.reconcile([server], [optimistic]);
  assert.equal(reconciled.matches.length, 1);
  assert.equal(reconciled.matches[0].local, optimistic);

  const visible = lifecycle.deduplicateConversationMessages([server, optimistic]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].clientUserMessageId, clientUserMessageId);
  assert.equal(visible[0].deliveryState, "accepted");
  assert.equal(visible[0].delivery, "Принято");
});

test("a steered optimistic message binds to one unkeyed live echo in its turn", () => {
  const optimistic = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "client-steer",
    clientUserMessageId: "client-steer",
    turnUserSlot: "steer",
    role: "user",
    text: "Пауза, расскажи результат",
    deliveryState: "accepted",
    delivery: "Принято",
  };
  const liveEcho = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "temporary-app-server-item",
    role: "user",
    text: "Пауза, расскажи результат",
  };
  const root = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "root-server-item",
    clientUserMessageId: "root-client-id",
    role: "user",
    text: "Исходный запрос",
  };
  const result = lifecycle.reconcile([root, liveEcho], [optimistic]);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[1].local, optimistic);
  assert.deepEqual([...result.matchedIds], ["client-steer"]);
});

test("a steered optimistic message never binds to the root user item", () => {
  const optimistic = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "client-steer",
    clientUserMessageId: "client-steer",
    turnUserSlot: "steer",
    role: "user",
    text: "Уточнение",
  };
  const root = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "root-server-item",
    role: "user",
    text: "Исходный запрос",
  };
  const result = lifecycle.reconcile([root], [optimistic]);
  assert.equal(result.matches[0].local, null);
  assert.deepEqual([...result.matchedIds], []);
});

test("an accepted steer binds when a partial live snapshot exposes only its unkeyed echo", () => {
  const clientUserMessageId = "client-steer";
  const optimistic = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: clientUserMessageId,
    clientUserMessageId,
    turnUserSlot: "steer",
    role: "user",
    text: "Edge заблокирован политикой - чего?..",
    deliveryState: "accepted",
    delivery: "Принято",
  };
  const live = lifecycle.mergeLiveUserMessages([], {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    prompt: "ну делай",
    clientUserMessageId: "root-client",
    userMessages: [{
      itemId: "temporary-app-server-item",
      text: "Edge заблокирован политикой - чего?..",
    }],
  });

  assert.equal(live.length, 1);
  assert.equal(live[0].turnUserSlot, "steer");
  const reconciled = lifecycle.reconcile(live, [optimistic]);
  assert.equal(reconciled.matches[0].local, optimistic);
  assert.deepEqual([...reconciled.matchedIds], [clientUserMessageId]);
});

test("temporary server echo keeps optimistic response annotations until rollout confirms them", () => {
  const local = {
    ...message("client-quote", "Это не повторится больше?"),
    responseAnnotations: [{ text: "миграция полностью завершена.", annotation: "" }],
    responseAnnotationRequest: "Это не повторится больше?",
  };
  const temporary = {
    ...local,
    itemId: "temporary-server-item",
    responseAnnotations: undefined,
    responseAnnotationRequest: undefined,
  };
  const merged = lifecycle.mergeReconciledUserMessage(temporary, local);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.responseAnnotations)), [{
    text: "миграция полностью завершена.",
    annotation: "",
  }]);
  assert.equal(lifecycle.reconciledUserMetadataConfirmed(temporary, local), false);
  assert.equal(lifecycle.reconciledUserMetadataConfirmed({
    ...temporary,
    responseAnnotations: local.responseAnnotations,
  }, local), true);
});

test("temporary and durable final ids render as one agent card", () => {
  const values = lifecycle.deduplicateConversationMessages([
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "turn-1:rollout-agent:final",
      role: "agent",
      text: "Временный финал",
    },
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "msg_official",
      role: "agent",
      text: "Сохранённый финал",
    },
  ]);
  assert.equal(values.length, 1);
  assert.equal(values[0].itemId, "msg_official");
  assert.equal(values[0].text, "Сохранённый финал");
});

test("a live user echo does not confirm an outgoing message before durable history", () => {
  const outgoing = message("client-live", "Сообщение ещё сохраняется");
  const liveEcho = {
    ...outgoing,
    itemId: "live-user",
    turnId: "turn-live",
  };
  assert.deepEqual(
    [...lifecycle.confirmedOutgoingMessageIds([], [outgoing])],
    [],
  );
  assert.deepEqual(
    [...lifecycle.confirmedOutgoingMessageIds([liveEcho], [outgoing])],
    ["client-live"],
  );
});

test("completed turn becomes durable only with its prompt and exact final", () => {
  const prompt = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "user-1",
    role: "user",
    text: "Вопрос",
  };
  const final = {
    ...prompt,
    itemId: "agent-1",
    role: "agent",
    text: "Готовый ответ",
  };
  assert.equal(lifecycle.completedConversationTurnVisible([prompt], {
    turnId: "turn-1",
    answer: "Готовый ответ",
  }), false);
  assert.equal(lifecycle.completedConversationTurnVisible([final], {
    turnId: "turn-1",
    answer: "Готовый ответ",
  }), false);
  assert.equal(lifecycle.completedConversationTurnVisible([prompt, final], {
    turnId: "turn-1",
    answer: "Готовый ответ",
  }), true);
});

test("agent finals from different turns remain separate", () => {
  const values = lifecycle.deduplicateConversationMessages([
    { provider: "codex", threadId: "thread-1", turnId: "turn-1", itemId: "a", role: "agent" },
    { provider: "codex", threadId: "thread-1", turnId: "turn-2", itemId: "b", role: "agent" },
  ]);
  assert.equal(values.length, 2);
});

test("composer quote annotations retain every selected fragment for the protocol envelope", () => {
  const annotations = lifecycle.normalizedResponseAnnotations([
    { quote: "Первый выделенный фрагмент" },
    { quote: "Второй выделенный фрагмент", comment: "Сравни их" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(annotations)), [
    { text: "Первый выделенный фрагмент", annotation: "" },
    { text: "Второй выделенный фрагмент", annotation: "Сравни их" },
  ]);
  const prompt = lifecycle.responseAnnotationPrompt("Общий вопрос", [
    { quote: "Первый выделенный фрагмент" },
    { quote: "Второй выделенный фрагмент" },
  ]);
  const embedded = prompt.match(/<response-annotations>\n(?<json>.+)\n<\/response-annotations>/u);
  assert.deepEqual(JSON.parse(embedded.groups.json), [
    { text: "Первый выделенный фрагмент", annotation: "" },
    { text: "Второй выделенный фрагмент", annotation: "" },
  ]);
  assert.match(prompt, /## My request for Codex:\nОбщий вопрос$/u);
});

test("empty legacy annotation data still hides the service envelope", () => {
  const raw = "# Response annotations:\n<response-annotations>\n"
    + '[{"text":"","annotation":""}]\n</response-annotations>\n\n'
    + "## My request for Codex:\nОбычный вопрос";
  const normalized = lifecycle.normalizedUserMessage({ role: "user", text: raw });
  assert.equal(normalized.text, "Обычный вопрос");
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.responseAnnotations ?? [])), []);
});

test("confirmed outgoing messages can be removed without resurrecting after history truncation", () => {
  const outgoing = new Map();
  const local = message("client-1", "Сообщение");
  lifecycle.rememberBounded(outgoing, local, 100);
  const confirmed = lifecycle.reconcile([{
    ...local,
    itemId: "server-item-1",
  }], [...outgoing.values()]);
  for (const clientUserMessageId of confirmed.matchedIds) outgoing.delete(clientUserMessageId);
  assert.equal(outgoing.size, 0);
  const truncated = lifecycle.reconcile([], [...outgoing.values()]);
  assert.deepEqual(truncated.matches, []);
  assert.equal(truncated.matchedIds.size, 0);
});

test("message lifecycle does not fall back when a different client id is present", () => {
  const local = message("client-1", "Первое сообщение");
  const server = {
    ...local,
    itemId: "server-item-2",
    clientUserMessageId: "client-2",
    text: "Второе сообщение",
  };
  const result = lifecycle.reconcile([server], [local]);
  assert.equal(result.matches[0].local, null);
  assert.equal(result.matchedIds.size, 0);
});

test("new-turn root reconciles after App Server replaces its client id", () => {
  const local = {
    ...message("client-local", "Исходный вопрос"),
    itemId: "local-root",
    turnUserSlot: "root",
  };
  const server = {
    ...local,
    itemId: "server-root",
    clientUserMessageId: "server-generated-client",
  };
  const result = lifecycle.reconcile([server], [local]);
  assert.equal(result.matches[0].local, local);
  assert.deepEqual([...result.matchedIds], ["client-local"]);
});

test("message lifecycle never merges two steer messages by turn and role fallback", () => {
  const first = { ...message("", "Одинаковый ход 1"), itemId: "" };
  const second = { ...message("", "Одинаковый ход 2"), itemId: "" };
  const server = [{ ...message("", "Сервер"), itemId: "", clientUserMessageId: undefined }];
  const result = lifecycle.reconcile(server, [first, second]);
  assert.equal(result.matches[0].local, null);
  assert.equal(result.matchedIds.size, 0);
});

test("message lifecycle bounds optimistic state for a long-lived tab", () => {
  const messages = new Map();
  for (let index = 0; index < 105; index += 1) {
    lifecycle.rememberBounded(messages, {
      clientUserMessageId: `client-${index}`,
    }, 100);
  }
  assert.equal(messages.size, 100);
  assert.equal(messages.has("client-0"), false);
  assert.equal(messages.has("client-104"), true);
});

test("new-turn root reconciles when Codex history temporarily omits client id", () => {
  const local = {
    ...message("client-root", "Новый вопрос"),
    itemId: "local-client-root",
    turnUserSlot: "root",
  };
  const server = [
    {
      ...local,
      itemId: "codex-user-item",
      clientUserMessageId: "",
    },
    {
      ...local,
      itemId: "codex-steer-item",
      clientUserMessageId: "",
      text: "Уточнение в том же ходе",
    },
  ];
  const result = lifecycle.reconcile(server, [local]);
  assert.equal(result.matches[0].local, local);
  assert.equal(result.matches[1].local, null);
  assert.deepEqual([...result.matchedIds], ["client-root"]);
});

test("live message falls back to the exact active turn while history catches up", () => {
  const visibleHistory = [{
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "temporary-history-item",
    role: "agent",
    text: "Старый промежуточный текст",
  }];
  const live = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "official-response-item",
    role: "agent",
  };
  assert.equal(lifecycle.liveMessageMatch(visibleHistory, live), visibleHistory[0]);
});

test("live message never falls back across turns or ambiguous agent messages", () => {
  const live = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "official-response-item",
    role: "agent",
  };
  const otherTurn = [{
    ...live,
    turnId: "turn-2",
    itemId: "history-item",
  }];
  assert.equal(lifecycle.liveMessageMatch(otherTurn, live), null);

  const ambiguous = [
    { ...live, itemId: "history-item-1" },
    { ...live, itemId: "history-item-2" },
  ];
  assert.equal(lifecycle.liveMessageMatch(ambiguous, live), null);
});

test("deferred outgoing messages stay only in the deferred queue", () => {
  const deferred = message("client-deferred", "Будет отправлено после хода");
  const visible = lifecycle.visibleConversationMessages([deferred], {
    deferredClientUserMessageIds: ["client-deferred"],
  });
  assert.deepEqual(visible, []);
});

test("active agent response is rendered only by the live card after task switching", () => {
  const user = message("client-live", "Текущий вопрос");
  const agent = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "agent-live",
    role: "agent",
    text: "Ответ формируется",
  };
  const visible = lifecycle.visibleConversationMessages([user, agent], {
    liveProbe: {
      ...agent,
      text: undefined,
    },
  });
  assert.deepEqual(visible, [user]);
});

test("all commentary fragments from the active VSC turn stay in the live card", () => {
  const previousAgent = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-previous",
    itemId: "previous-answer",
    role: "agent",
    text: "Предыдущий завершённый ответ",
  };
  const activeCommentary = [
    {
      ...previousAgent,
      turnId: "turn-active",
      itemId: "commentary-1",
      text: "Первый промежуточный фрагмент",
    },
    {
      ...previousAgent,
      turnId: "turn-active",
      itemId: "commentary-2",
      text: "Второй промежуточный фрагмент",
    },
  ];
  const visible = lifecycle.visibleConversationMessages(
    [previousAgent, ...activeCommentary],
    {
      liveProbe: {
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-active",
        itemId: "",
        role: "agent",
      },
    },
  );
  assert.deepEqual(visible, [previousAgent]);
});

test("an external live turn contributes its missing VSC user messages", () => {
  const previous = [{
    ...message("previous-client", "Предыдущий вопрос"),
    turnId: "previous-turn",
  }];
  const merged = lifecycle.mergeLiveUserMessages(previous, {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    userMessages: [
      {
        itemId: "live-user-1",
        clientUserMessageId: "live-client-1",
        text: "Текущий вопрос из VSC",
      },
      {
        itemId: "live-user-2",
        clientUserMessageId: "live-client-2",
        text: "Уточнение в том же ходе",
      },
    ],
  });
  assert.deepEqual(
    merged.map((item) => item.text),
    ["Предыдущий вопрос", "Текущий вопрос из VSC", "Уточнение в том же ходе"],
  );
});

test("live VSC user messages do not duplicate official task history", () => {
  const official = [{
    ...message("server-item", "Текущий вопрос из VSC"),
    turnId: "active-turn",
    clientUserMessageId: "live-client",
  }];
  const merged = lifecycle.mergeLiveUserMessages(official, {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    userMessages: [{
      itemId: "rollout-item",
      clientUserMessageId: "live-client",
      text: "Текущий вопрос из VSC",
    }],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].itemId, "server-item");
});

test("live root does not duplicate history when App Server changed its client id", () => {
  const official = [{
    ...message("server-item", "Текущий вопрос"),
    turnId: "active-turn",
    clientUserMessageId: "official-client",
  }];
  const merged = lifecycle.mergeLiveUserMessages(official, {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    userMessages: [{
      itemId: "rollout-item",
      clientUserMessageId: "runtime-client",
      text: "Текущий вопрос",
    }],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].itemId, "server-item");
});

test("unmatched optimistic messages keep chronological position", () => {
  const values = lifecycle.chronologicalMessages([
    { id: "server-old", time: "2026-08-02T20:49:01.000Z" },
    { id: "server-new", time: "2026-08-02T20:53:31.000Z" },
    { id: "optimistic-old", time: "2026-08-02T20:49:01.920Z" },
  ]);
  assert.deepEqual(values.map((item) => item.id), [
    "server-old",
    "optimistic-old",
    "server-new",
  ]);
});

test("deferred queue merges the server row with its optimistic client message", () => {
  const merged = lifecycle.mergeDeferredQueueEntries([{
    id: "queue-1",
    state: "queued",
    clientUserMessageId: "client-queue-1",
    text: "",
    annotations: [],
    attachments: [],
    createdAt: "2026-08-07T00:10:01.000Z",
  }], [{
    id: "local:client-queue-1",
    state: "queued",
    requestId: "client-queue-1",
    text: "",
    annotations: [{ text: "Цитата", annotation: "Комментарий" }],
    attachments: [{ id: "screen.png", type: "image/png" }],
    createdAt: "2026-08-07T00:10:00.000Z",
    optimistic: true,
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "queue-1");
  assert.equal(merged[0].clientUserMessageId, "client-queue-1");
  assert.equal(merged[0].state, "queued");
  assert.equal(merged[0].optimistic, false);
  assert.equal(merged[0].createdAt, "2026-08-07T00:10:01.000Z");
  assert.equal(JSON.stringify(merged[0].annotations), JSON.stringify([
    { text: "Цитата", annotation: "Комментарий" },
  ]));
  assert.equal(JSON.stringify(merged[0].attachments), JSON.stringify([
    { id: "screen.png", type: "image/png" },
  ]));
});

test("live user update enriches a durable duplicate with its attachment and time", () => {
  const merged = lifecycle.mergeLiveUserMessages([{
    id: "durable-user",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    clientUserMessageId: "client-1",
    role: "user",
    text: "Со скрином",
    time: null,
    attachments: [],
  }], {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    userMessages: [{
      itemId: "item-1",
      clientUserMessageId: "client-1",
      text: "Со скрином",
      time: "2026-08-03T22:32:00.004Z",
      attachments: [{ id: "screen.png", name: "screen.png", type: "image/png" }],
    }],
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "durable-user");
  assert.equal(merged[0].time, "2026-08-03T22:32:00.004Z");
  assert.equal(JSON.stringify(merged[0].attachments), JSON.stringify([
    { id: "screen.png", name: "screen.png", type: "image/png" },
  ]));
});

test("one undated message does not leave restored history below a newer reply", () => {
  const values = lifecycle.chronologicalMessages([
    { id: "current-user", role: "user", turnId: "current", time: "2026-08-03T16:51:00.000Z" },
    { id: "current-agent", role: "agent", turnId: "current", time: "2026-08-03T16:57:00.000Z" },
    { id: "old-user", role: "user", turnId: "old", time: "2026-08-03T16:25:00.000Z" },
    { id: "old-agent-without-time", role: "agent", turnId: "old", time: null },
    { id: "older-agent", role: "agent", turnId: "older", time: "2026-08-03T15:58:00.000Z" },
  ]);
  assert.deepEqual(values.map((item) => item.id), [
    "older-agent",
    "old-user",
    "old-agent-without-time",
    "current-user",
    "current-agent",
  ]);
});

test("an undated optimistic message remains after dated history", () => {
  const values = lifecycle.chronologicalMessages([
    { id: "pending", role: "user", time: null },
    { id: "history", role: "agent", time: "2026-08-03T16:57:00.000Z" },
    { id: "undated-agent", role: "agent", time: null },
  ]);
  assert.deepEqual(values.map((item) => item.id), ["history", "pending", "undated-agent"]);
});

test("undated historical turns keep their server order between dated turns", () => {
  const values = lifecycle.chronologicalMessages([
    { id: "undated-before", role: "agent", turnId: "31", time: null, historyOrder: 31_001 },
    { id: "dated-user", role: "user", turnId: "32", time: "2026-08-02T19:00:17.902Z", historyOrder: 32_000 },
    { id: "dated-agent", role: "agent", turnId: "32", time: null, historyOrder: 32_001 },
    { id: "dated-later", role: "agent", turnId: "34", time: "2026-08-02T19:55:25.340Z", historyOrder: 34_001 },
    { id: "undated-after", role: "agent", turnId: "35", time: null, historyOrder: 35_001 },
  ]);
  assert.deepEqual(values.map((item) => item.id), [
    "undated-before",
    "dated-user",
    "dated-agent",
    "dated-later",
    "undated-after",
  ]);
});

test("interrupted turns keep their persisted partial response visible", () => {
  assert.equal(lifecycle.historicalAgentResponseVisible({
    active: false,
    completed: false,
    status: "interrupted",
  }), true);
  assert.equal(lifecycle.historicalAgentResponseVisible({
    active: true,
    completed: false,
    status: "inProgress",
  }), false);
});

test("focused execution turn does not duplicate its task history prompt", () => {
  const history = { provider: "codex", threadId: "task-thread" };
  const official = [{
    provider: "codex",
    threadId: "task-thread",
    turnId: "turn-1",
    itemId: "server-item",
    role: "user",
    text: "Исходный вопрос",
  }];
  const focusedTurn = {
    provider: "codex",
    taskThreadId: "task-thread",
    turnThreadId: "execution-thread",
    turnId: "turn-1",
    prompt: "Исходный вопрос",
  };
  assert.equal(lifecycle.focusedTurnTaskThreadId(focusedTurn), "task-thread");
  assert.equal(lifecycle.focusedTurnAlreadyVisible(history, official, focusedTurn), true);
});

test("history catch-up waits for the exact completed answer turn", () => {
  const task = {
    lastAnswer: "Готовый ответ",
    lastAnswerAt: "2026-08-02T10:00:01.000Z",
    lastAnswerTurnId: "turn-2",
  };
  const stale = {
    items: [{
      id: "turn-2",
      completed: false,
      messages: [{ role: "user", text: "Вопрос" }],
    }],
  };
  assert.equal(lifecycle.historyContainsLatestAnswer(stale, task), false);
  const answerWithoutUser = {
    items: [{
      id: "turn-2",
      completed: true,
      messages: [{ role: "agent", phase: "final", text: "Готовый ответ" }],
    }],
  };
  assert.equal(lifecycle.historyContainsLatestAnswer(answerWithoutUser, task), false);
  const caughtUp = {
    items: [{
      id: "turn-2",
      completed: true,
      messages: [
        { role: "user", text: "Вопрос" },
        { role: "agent", phase: "final", text: "Готовый ответ" },
      ],
    }],
  };
  assert.equal(lifecycle.historyContainsLatestAnswer(caughtUp, task), true);
});

test("legacy answer records without a turn id match their completed text", () => {
  const task = {
    lastAnswer: "Старый готовый ответ",
    lastAnswerAt: "2026-08-02T10:00:01.000Z",
  };
  assert.equal(lifecycle.historyContainsLatestAnswer({
    items: [{ id: "turn-legacy", completed: true, answer: "Старый готовый ответ" }],
  }, task), true);
});

test("active stage always identifies the whole turn as running", () => {
  assert.equal(lifecycle.activeStageLabel(""), "Ход выполняется");
  assert.equal(
    lifecycle.activeStageLabel("✓ Анализ завершён."),
    "Ход выполняется · ✓ Анализ завершён.",
  );
  assert.equal(
    lifecycle.activeStageLabel("Ход выполняется · проверка"),
    "Ход выполняется · проверка",
  );
});

test("remote attachment retries upload again while local VSC paths remain reusable", () => {
  const previous = ["remote-attachment:old"];
  assert.deepEqual(
    [...lifecycle.reusableAttachmentPaths(previous, 1, { remote: true })],
    [],
  );
  assert.deepEqual(
    [...lifecycle.reusableAttachmentPaths(["C:\\AgentHub\\image.png"], 1)],
    ["C:\\AgentHub\\image.png"],
  );
  assert.deepEqual([...lifecycle.reusableAttachmentPaths(previous, 2)], []);
});

test("only tagged transport failures change the Hub connection state", () => {
  const applicationError = new Error("remote attachment not found");
  assert.equal(lifecycle.isConnectionFailure(applicationError), false);
  const transportError = lifecycle.markConnectionFailure(new Error("fetch failed"));
  assert.equal(lifecycle.isConnectionFailure(transportError), true);
  assert.equal(transportError.message, "fetch failed");
});

test("remote attachment failures are shown in Russian", () => {
  assert.equal(
    lifecycle.hubErrorMessage(new Error("remote attachment not found")),
    "Вложение недоступно. Повторите отправку.",
  );
  assert.equal(lifecycle.hubErrorMessage(new Error("Другая ошибка")), "Другая ошибка");
});

test("named-pipe transport errors are recognized and hidden from the interface", () => {
  const error = new Error(
    "connect ENOENT \\\\.\\pipe\\agent-hub-desktop-" + "a".repeat(64),
  );
  assert.equal(lifecycle.looksLikeConnectionFailure(error), true);
  assert.equal(lifecycle.hubErrorMessage(error), "Нет связи с Agent Hub.");
  assert.doesNotMatch(lifecycle.hubErrorMessage(error), /pipe|ENOENT/iu);
});

test("returning to a busy task keeps live and deferred states separate", () => {
  const activeUser = {
    ...message("active-client", "Первый вопрос"),
    turnId: "active-turn",
    itemId: "active-user",
  };
  const activeAgent = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    itemId: "active-agent",
    role: "agent",
    text: "Работа продолжается",
  };
  const deferredUser = {
    ...message("deferred-client", "Следующий вопрос"),
    turnId: "",
    itemId: "",
    deliveryState: "queued",
  };
  const visible = lifecycle.visibleConversationMessages(
    [activeUser, activeAgent, deferredUser],
    {
      deferredClientUserMessageIds: ["deferred-client"],
      liveProbe: { ...activeAgent, text: undefined },
    },
  );
  assert.deepEqual(visible, [activeUser]);
});

test("context compaction start identifies the task and completion stays in chat", () => {
  assert.match(hubClientSource, /function compactionTaskTitle\(task\)/u);
  assert.match(hubClientSource, /workspaceName = String\(task\?\.workspaceName/u);
  assert.match(hubClientSource, /streamName = String\(task\?\.streamName/u);
  assert.match(hubClientSource, /return `\$\{workspaceName\} - \$\{streamName\}`/u);
  assert.match(
    hubClientSource,
    /Началась автосвёртка контекста · \$\{compactionTaskTitle\(task\)\}/u,
  );
  assert.match(
    hubClientSource,
    /visibleBeforePercent = beforePercent \?\? "\?";[\s\S]*visibleAfterPercent = afterPercent \?\? "\?";[\s\S]*text: `Свёртка завершена успешно \$\{visibleBeforePercent\}%>\$\{visibleAfterPercent\}%`/u,
  );
  assert.match(hubClientSource, /maintenanceEventStorageKey/u);
  assert.match(hubClientSource, /rememberMaintenanceEvent\(stableTaskId/u);
});

test("Hub compaction delegates targeted completion to its context maintenance owner", () => {
  assert.match(
    codexEventSource,
    /if \(d\.isCompactionItem\(params\.item\)\) \{\s*d\.beginCompactionCleanup/u,
  );
  assert.match(
    codexContextMaintenanceSource,
    /if \(result\.applied \|\| result\.reason === "below-threshold"\) \{\s*this\.compactions\.complete/u,
  );
  assert.match(serverSource, /codexContextMaintenance\.beginCompactionCleanup/u);
  assert.doesNotMatch(
    serverSource,
    /contextCompactions\.complete/u,
  );
});
