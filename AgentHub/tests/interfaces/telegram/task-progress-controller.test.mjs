import assert from "node:assert/strict";
import test from "node:test";

import { TaskProgressController } from "../../../src/interfaces/telegram/task-progress-controller.mjs";

function run(overrides = {}) {
  return {
    id: "run-1",
    status: "running",
    startedAt: "2026-07-22T10:00:00.000Z",
    lastMeaningfulProgressAt: "2026-07-22T10:00:00.000Z",
    progressMessageIds: [],
    progressStage: "Старт",
    progressReasoning: "",
    lastProgressText: "",
    progressStartTimer: null,
    progressTimer: null,
    progressUpdateInFlight: false,
    progressUpdatePending: false,
    ...overrides,
  };
}

function fixture(overrides = {}) {
  const edits = [];
  const deleted = [];
  const bindings = [];
  let persists = 0;
  const controller = new TaskProgressController({
    isCurrentRun: () => true,
    render: (item, done) => `${done ? "done" : "live"}:${item.progressStage}:${item.progressReasoning}`,
    sendInitial: async () => ({ message_id: 41 }),
    deleteMessage: async (_run, id) => deleted.push(id),
    removeBindings: async (_run, ids) => bindings.push(...ids),
    editMessage: async (_run, id, text) => edits.push({ id, text }),
    persist: async () => { persists += 1; },
    retainAfterEditError: () => false,
    ...overrides,
  });
  return { bindings, controller, deleted, edits, persists: () => persists };
}

test("TaskProgressController creates, updates and finishes one progress card", async () => {
  const item = run();
  const { controller, edits, persists } = fixture();
  await controller.start(item);
  assert.deepEqual(item.progressMessageIds, [41]);
  controller.setStage(item, "Работаю");
  controller.appendReasoning(item, "шаг");
  controller.cancelUpdate(item);
  await controller.flush(item);
  assert.deepEqual(edits, [{ id: 41, text: "live:Работаю:шаг" }]);
  await controller.finish(item, "Готово");
  assert.equal(item.status, "finishing");
  assert.deepEqual(item.progressMessageIds, []);
  assert.deepEqual(item.finishedProgressMessageIds, [41]);
  assert.equal(item.progressReasoning, "");
  assert.equal(persists(), 3);
});

test("TaskProgressController removes stale cards and their bindings", async () => {
  const item = run({ progressMessageIds: [11, 12], lastProgressText: "old" });
  const { bindings, controller, deleted } = fixture();
  await controller.clear(item);
  assert.deepEqual(deleted, [11, 12]);
  assert.deepEqual(bindings, [11, 12]);
  assert.deepEqual(item.progressMessageIds, []);
});

test("TaskProgressController retains a card and schedules retry after a transient edit error", async () => {
  const timers = [];
  const item = run({ progressMessageIds: [77], progressStage: "Новый этап", lastProgressText: "old" });
  const error = Object.assign(new Error("temporary"), { retryable: true });
  const { controller } = fixture({
    editMessage: async () => { throw error; },
    retainAfterEditError: () => true,
    setTimeoutImpl: (callback, delay) => {
      timers.push({ callback, delay });
      return timers.length;
    },
    clearTimeoutImpl: () => {},
  });
  await controller.flush(item);
  assert.deepEqual(item.progressMessageIds, [77]);
  assert.equal(item.lastProgressText, "old");
  assert.equal(timers.at(-1).delay, 1_500);
});

test("TaskProgressController detects stalled activity", () => {
  const { controller } = fixture();
  const item = run();
  assert.equal(controller.heartbeatState(item, Date.parse("2026-07-22T10:02:00.000Z"), 60_000), "stalled");
  controller.noteActivity(item, Date.parse("2026-07-22T10:01:30.000Z"));
  assert.equal(controller.heartbeatState(item, Date.parse("2026-07-22T10:02:00.000Z"), 60_000), "active");
});
