import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalController } from "./approval-controller.mjs";

function fixture({ auto = false } = {}) {
  const responses = [];
  const calls = [];
  const controller = new ApprovalController({
    autoApprove: () => auto,
    respond: (id, value) => responses.push([id, value]),
    send: async (_text, extra) => {
      calls.push(["send", extra]);
      return { message_id: 11 };
    },
    sendForRun: async () => ({ message_id: 12 }),
    runExists: () => true,
    setProgressStage: () => {},
    telegram: async (method, body) => calls.push([method, body]),
    currentChatId: () => 9,
  });
  return { controller, responses, calls };
}

test("auto approval responds without creating Telegram prompt", async () => {
  const { controller, responses, calls } = fixture({ auto: true });
  await controller.request("rpc", "commandExecution", { command: "echo ok" }, "confirm");
  assert.equal(controller.pending.size, 0);
  assert.equal(responses.length, 1);
  assert.equal(calls.length, 0);
});

test("manual approval uses unique callback and resolves only its prompt", async () => {
  const { controller, responses, calls } = fixture();
  await controller.request("rpc", "commandExecution", { command: "echo ok" }, "confirm");
  const keyboard = calls[0][1].reply_markup.inline_keyboard;
  const callbackData = keyboard[0][0].callback_data;
  assert.match(callbackData, /^a:[0-9a-f-]+:once$/i);
  await controller.handleCallback({
    id: "callback",
    data: callbackData,
    message: { chat: { id: 9 }, message_id: 11 },
  });
  assert.equal(controller.pending.size, 0);
  assert.equal(responses.length, 1);
});

test("stale approval button is consumed without responding to RPC", async () => {
  const { controller, responses, calls } = fixture();
  const handled = await controller.handleCallback({
    id: "callback",
    data: "a:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa:once",
    message: { chat: { id: 9 }, message_id: 11 },
  });
  assert.equal(handled, true);
  assert.equal(responses.length, 0);
  assert.equal(calls.at(-1)[1].text, "Запрос уже закрыт");
});
