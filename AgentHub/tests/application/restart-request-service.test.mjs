import assert from "node:assert/strict";
import test from "node:test";

import { RestartRequestService } from "../../src/application/restart-request-service.mjs";

function fixture({ blockingCount = 0, processingId = null } = {}) {
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

test("Telegram restart waits for the current update and active work", async () => {
  const state = fixture({ blockingCount: 2, processingId: 40 });
  const result = await state.service.fromTelegram();
  assert.equal(result.waiting, true);
  assert.equal(state.request().minimumUpdateOffset, 41);
  assert.equal(state.request().notifyTelegram, true);
  assert.equal(state.events.includes("restart"), false);
});
