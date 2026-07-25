import assert from "node:assert/strict";
import test from "node:test";
import { routeCodexFinalDelivery } from "./codex-final-delivery.mjs";

test("registered end-of-turn message exclusively owns Codex final delivery", async () => {
  const calls = [];
  const completion = { message: { category: "done", text: "Готово" } };
  const delivery = await routeCodexFinalDelivery({
    completion,
    deliverRegistered: async (value) => {
      calls.push(["registered", value]);
      return "notification";
    },
    deliverStandard: async () => {
      calls.push(["standard"]);
      return "answer";
    },
  });

  assert.deepEqual(delivery, { mode: "registered", result: "notification" });
  assert.deepEqual(calls, [["registered", completion]]);
});

test("standard Codex final is delivered when no end-of-turn message was registered", async () => {
  const calls = [];
  const delivery = await routeCodexFinalDelivery({
    completion: { message: null },
    deliverRegistered: async () => {
      calls.push("registered");
      return "notification";
    },
    deliverStandard: async () => {
      calls.push("standard");
      return "answer";
    },
  });

  assert.deepEqual(delivery, { mode: "standard", result: "answer" });
  assert.deepEqual(calls, ["standard"]);
});
