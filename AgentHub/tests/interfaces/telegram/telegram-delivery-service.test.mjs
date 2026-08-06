import assert from "node:assert/strict";
import test from "node:test";

import { TelegramDeliveryService } from "../../../src/interfaces/telegram/telegram-delivery-service.mjs";

function service(overrides = {}) {
  const events = overrides.events ?? [];
  const bindings = [];
  const run = {
    provider: "codex",
    threadId: "thread-1",
    projectRoot: "D:/repo",
    chatId: 7,
    turnId: "turn-1",
    progressMessageIds: [],
  };
  return {
    events,
    bindings,
    run,
    value: new TelegramDeliveryService({
      dataDir: "data",
      messageLimit: 20,
      appendBindings: async (_dir, values) => bindings.push(...values),
      readBindings: async () => bindings,
      removeBindings: async (_dir, predicate) => {
        for (let index = bindings.length - 1; index >= 0; index -= 1) {
          if (predicate(bindings[index])) bindings.splice(index, 1);
        }
      },
      pendingApprovalMessageIds: () => [],
      runTaskTitle: () => "Task",
      samePath: (left, right) => left === right,
      taskRuns: { forTask: () => run },
      telegram: async (method, body) => {
        events.push(["telegram", method, body]);
        return { message_id: 11 };
      },
      sendMessageTo: async () => ({ message_id: 12 }),
      deliveryOutbox: {
        discard: async (value) => events.push(["discard", value]),
        enqueue: async (value) => { events.push(["enqueue", value]); return { id: "queued-1" }; },
      },
      scheduleDeliveryFlush: (delay) => events.push(["flush", delay]),
      taskRunKey: () => "run-key",
      randomId: () => "group-1",
      progressHeading: () => "Heading",
      rememberSpeechText: () => null,
      taskViewCallbackData: () => "diff:1",
      completeRun: async () => events.push(["complete"]),
      rememberLastMessage: (_run, text) => events.push(["remember", text]),
      rememberLastSeenTurn: (_run, turnId) => events.push(["seen", turnId]),
      refreshTaskDiff: async () => events.push(["diff"]),
      selectedTask: () => run,
      activeTaskTitle: () => "Task",
      activeProjectName: () => "Project",
      showProject: () => false,
      taskSwitchSettings: () => ({ provider: "Codex" }),
      showLastMessageReplyMarkup: () => ({ inline_keyboard: [] }),
      formatTaskSwitchMessage: ({ task }) => `Switch ${task}`,
      formatTaskAlreadySelectedMessage: ({ task }) => `Current ${task}`,
      getProgressController: () => ({ schedule: (target) => events.push(["schedule", target]) }),
      saveState: async () => events.push(["save"]),
      now: () => new Date("2026-08-05T00:00:00.000Z"),
      logger: { error() {}, warn() {} },
      ...overrides,
    }),
  };
}

test("reliable delivery queues a retryable Telegram failure with a stable binding", async () => {
  const setup = service({
    telegram: async () => { const error = new Error("offline"); error.retryable = true; throw error; },
  });
  const result = await setup.value.sendReliableRunMessage(
    setup.run,
    "answer",
    {},
    { kind: "final" },
    { supersedeKey: "progress:run-key" },
  );

  assert.deepEqual(result, { queued: true, outboxId: "queued-1" });
  assert.equal(setup.events.find((event) => event[0] === "enqueue")[1].binding.taskTitle, "Task");
  assert.ok(setup.events.some((event) => event[0] === "flush" && event[1] === 0));
});

test("final delivery persists the answer and outbox parts before completing the run", async () => {
  const setup = service();
  await setup.value.finalizeRunDelivery(setup.run, { answer: "done" });

  const names = setup.events.map((event) => event[0]);
  assert.ok(names.indexOf("remember") < names.indexOf("enqueue"));
  assert.ok(names.indexOf("enqueue") < names.indexOf("complete"));
  assert.equal(setup.run.finalizing, true);
});

test("final delivery for a non-Telegram run updates state without messaging Telegram", async () => {
  const setup = service();
  setup.run.telegramDeliveryRequested = false;
  await setup.value.finalizeRunDelivery(setup.run, { answer: "done" });

  const names = setup.events.map((event) => event[0]);
  assert.equal(names.includes("enqueue"), false);
  assert.ok(names.includes("remember"));
  assert.ok(names.includes("complete"));
});

test("delivered progress is rebound to the exact active run", async () => {
  const setup = service();
  await setup.value.recordDeliveredOutbox({
    id: "outbox-1",
    binding: { ...setup.run, kind: "progress" },
    body: { chat_id: 7, text: "working" },
  }, { message_id: 42 });

  assert.deepEqual(setup.run.progressMessageIds, [42]);
  assert.equal(setup.bindings[0].messageId, 42);
  assert.ok(setup.events.some((event) => event[0] === "schedule"));
  assert.ok(setup.events.some((event) => event[0] === "save"));
});

test("task cleanup preserves pending approvals and clears run progress state", async () => {
  const setup = service({ pendingApprovalMessageIds: () => [2] });
  setup.bindings.push(
    { ...setup.run, messageId: 1, createdAt: "2026-08-04T23:00:00.000Z" },
    { ...setup.run, messageId: 2, createdAt: "2026-08-04T23:00:00.000Z" },
  );
  setup.run.progressMessageIds = [1, 2];

  assert.equal(await setup.value.deleteTaskMessages(setup.run, 7), 1);
  assert.deepEqual(setup.run.progressMessageIds, [2]);
  assert.deepEqual(setup.bindings.map((binding) => binding.messageId), [2]);
});
