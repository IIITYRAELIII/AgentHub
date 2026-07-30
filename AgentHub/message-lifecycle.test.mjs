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
