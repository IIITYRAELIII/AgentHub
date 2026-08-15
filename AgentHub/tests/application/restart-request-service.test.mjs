import assert from "node:assert/strict";
import test from "node:test";

import { RestartRequestService } from "../../src/application/restart-request-service.mjs";

function fixture({ blockingCount = 0, processingId = null, stopping = false } = {}) {
  let request = null;
  const events = [];
  const service = new RestartRequestService({
    getRequest: () => request,
    setRequest: (value) => { request = value; },
    blockingWorkCount: () => blockingCount,
    currentChatId: () => 101,
    updateOffset: () => 20,
    processingUpdateId: () => processingId,
    saveState: async () => events.push("save"),
    announceDesktop: async () => events.push("announce"),
    sendTelegram: async (text) => {
      events.push(text);
      return { message_id: 30 };
    },
    performRestart: async () => events.push("restart"),
    isStopping: () => stopping,
    scheduleRestart: (callback) => {
      events.push("schedule");
      callback();
    },
    nowIso: () => "2026-08-05T00:00:00.000Z",
  });
  return { service, events, request: () => request };
}

test("desktop restart persists before scheduling replacement", async () => {
  const state = fixture();
  const result = await state.service.fromDesktop();
  assert.equal(result.accepted, true);
  assert.equal(state.request().minimumUpdateOffset, 20);
  assert.equal(state.request().notifyTelegram, false);
  assert.deepEqual(state.events.slice(0, 2), ["save", "announce"]);
  assert.equal(state.events.includes("schedule"), true);
});

test("repeated desktop restart re-arms a pending request after work becomes idle", async () => {
  const state = fixture();
  await state.service.fromDesktop();
  state.events.length = 0;

  const result = await state.service.fromDesktop();

  assert.equal(result.accepted, false);
  assert.equal(result.waiting, false);
  assert.deepEqual(state.events, ["schedule", "restart"]);
});

test("repeated desktop restart does not schedule a second cutover while stopping", async () => {
  const state = fixture({ stopping: true });
  await state.service.fromDesktop();
  state.events.length = 0;

  const result = await state.service.fromDesktop();

  assert.equal(result.accepted, false);
  assert.equal(result.message, "Перезапуск уже выполняется");
  assert.deepEqual(state.events, []);
});

test("Telegram restart waits for the current update and active work", async () => {
  const state = fixture({ blockingCount: 2, processingId: 40 });
  const result = await state.service.fromTelegram();
  assert.equal(result.waiting, true);
  assert.equal(state.request().minimumUpdateOffset, 41);
  assert.equal(state.request().notifyTelegram, true);
  assert.equal(state.events.includes("restart"), false);
});
