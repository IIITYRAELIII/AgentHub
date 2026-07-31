import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const source = await readFile(
  new URL("./assets/mini-app/message-lifecycle.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
vm.runInContext(source, context);
const lifecycle = context.AgentHubMessageLifecycle;

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
