import assert from "node:assert/strict";
import test from "node:test";
import { ApprovalController } from "../../../src/interfaces/telegram/approval-controller.mjs";
import * as approvalProtocol from "../../../src/providers/codex/codex-approvals.mjs";

function fixture({
  auto = false,
  mcpAdmissionCoordinator = null,
  transportGeneration = null,
} = {}) {
  const responses = [];
  const responseOptions = [];
  const calls = [];
  const controller = new ApprovalController({
    approvalProtocol,
    autoApprove: () => auto,
    respond: (id, value, options) => {
      responses.push([id, value]);
      responseOptions.push(options);
    },
    send: async (_text, extra) => {
      calls.push(["send", extra]);
      return { message_id: 11 };
    },
    sendForRun: async () => ({ message_id: 12 }),
    runExists: () => true,
    setProgressStage: () => {},
    telegram: async (method, body) => calls.push([method, body]),
    currentChatId: () => 9,
    mcpAdmissionCoordinator,
    transportGeneration,
  });
  return { controller, responses, responseOptions, calls };
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

test("desktop sees and resolves the same pending approval", async () => {
  const { controller, responses, calls } = fixture();
  await controller.request("rpc", "commandExecution", { command: "echo ok" }, "Разрешить echo ok?");
  const [pending] = controller.snapshot();
  assert.equal(pending.text, "Разрешить echo ok?");
  assert.equal(pending.canAllowSession, true);
  const result = await controller.resolveFromDesktop(pending.key, "once");
  assert.equal(result.decision, "allowed");
  assert.equal(controller.snapshot().length, 0);
  assert.equal(responses.length, 1);
  assert.ok(calls.some(([method]) => method === "editMessageReplyMarkup"));
});

test("approval for a Desktop-started run stays in HUB and does not message Telegram", async () => {
  const { controller, calls } = fixture();
  await controller.request(
    "rpc",
    "commandExecution",
    { command: "echo ok" },
    "Разрешить echo ok?",
    { id: "run-1", telegramDeliveryRequested: false },
  );

  assert.equal(controller.snapshot().length, 1);
  assert.equal(calls.length, 0);
});

test("structured user input waits even in auto mode and resolves from Desktop", async () => {
  const { controller, responses, calls } = fixture({ auto: true });
  await controller.requestUserInput("rpc-input", {
    isBlocking: true,
    questions: [{ id: "choice", header: "Выбор", question: "Как продолжить?", options: null }],
  }, { id: "run-1", telegramDeliveryRequested: false });
  const [pending] = controller.snapshot();
  assert.equal(pending.kind, "user-input");
  assert.equal(pending.questions[0].id, "choice");
  assert.equal(calls.length, 0);
  const result = await controller.resolveFromDesktop(pending.key, "submit", {
    answers: { choice: ["Продолжить"] },
  });
  assert.equal(result.decision, "submitted");
  assert.deepEqual(responses, [["rpc-input", {
    answers: { choice: { answers: ["Продолжить"] } },
  }]]);
});

test("URL MCP elicitation stays explicit and disappears after Desktop consent", async () => {
  const { controller, responses, calls } = fixture({ auto: true });
  await controller.requestMcp("rpc-url", {
    mode: "url",
    url: "https://example.test/sign-in",
    message: "Войдите в сервис",
  });

  const [pending] = controller.snapshot();
  assert.equal(pending.canAccept, true);
  assert.equal(pending.canAllowSession, false);
  assert.equal(pending.url, "https://example.test/sign-in");
  const keyboard = calls[0][1].reply_markup.inline_keyboard;
  assert.equal(keyboard[0][0].url, "https://example.test/sign-in");
  assert.match(keyboard[1][0].callback_data, /:once$/);
  assert.equal(responses.length, 0, "URL consent must never be automatic");

  await controller.resolveFromDesktop(pending.key, "once");
  assert.deepEqual(responses, [["rpc-url", { action: "accept" }]]);
  assert.equal(controller.snapshot().length, 0);
});

test("safe MCP auto approval is tracked until exact operation admission", async () => {
  const admissions = [];
  const coordinator = { begin: (value) => admissions.push(value) };
  let generation = 7;
  const { controller, responses, responseOptions } = fixture({
    auto: true,
    mcpAdmissionCoordinator: coordinator,
    transportGeneration: () => generation,
  });
  const run = { id: "run-1", threadId: "thread-1", turnId: "turn-1" };
  await controller.requestMcp("rpc-claim", {
    serverName: "agent_hub",
    toolCall: { toolName: "hub_task_claim", arguments: { request_id: "claim-1" } },
    mode: "form",
    requestedSchema: {
      type: "object",
      properties: { accept: { type: "boolean" } },
      required: ["accept"],
    },
  }, run);

  assert.equal(responses.length, 0, "coordinator owns the initial response and any retry");
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].rpcId, "rpc-claim");
  assert.equal(admissions[0].runId, "run-1");
  assert.equal(admissions[0].threadId, "thread-1");
  assert.equal(admissions[0].turnId, "turn-1");
  assert.equal(admissions[0].transportGeneration, 7);
  assert.equal(admissions[0].currentTransportGeneration(), 7);
  admissions[0].respond(admissions[0].rpcId, admissions[0].response);
  assert.deepEqual(responses, [["rpc-claim", { action: "accept", content: { accept: true } }]]);
  assert.deepEqual(responseOptions, [{ expectedGeneration: 7 }]);
  generation = 8;
  assert.equal(admissions[0].currentTransportGeneration(), 8);
});
