import assert from "node:assert/strict";
import test from "node:test";
import { contextualCallback } from "./src/interfaces/telegram/callback-context.mjs";
import { TelegramCallbackController } from "./src/interfaces/telegram/telegram-callback-controller.mjs";

test("callback controller blocks stale UI before dispatch", async () => {
  const calls = [];
  const controller = new TelegramCallbackController({
    currentContextToken: () => "bbbbbbbbbbbb",
    telegram: async (method, body) => calls.push([method, body]),
    dispatch: async () => calls.push(["dispatch"]),
  });
  await controller.handle({
    id: "1",
    data: contextualCallback("thread:new", "aaaaaaaaaaaa"),
  });
  assert.equal(calls[0][0], "answerCallbackQuery");
  assert.equal(calls.some(([kind]) => kind === "dispatch"), false);
});

test("callback controller sends a typed route to domain dispatch", async () => {
  let routed;
  const controller = new TelegramCallbackController({
    currentContextToken: () => "aaaaaaaaaaaa",
    telegram: async () => {},
    dispatch: async (_callback, route) => { routed = route; },
  });
  await controller.handle({ id: "1", data: "tasks-page:2" });
  assert.equal(routed.kind, "task-page");
  assert.equal(routed.page, 2);
});
