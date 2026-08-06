import assert from "node:assert/strict";
import test from "node:test";
import { routeCodexFinalDelivery } from "../../../src/providers/codex/codex-final-delivery.mjs";

test("standard Codex final remains authoritative when legacy end-of-turn data exists", async () => {
  const calls = [];
  const completion = { message: { category: "done", text: "Готово" } };
  const delivery = await routeCodexFinalDelivery({
    completion,
    deliverStandard: async () => {
      calls.push(["standard"]);
      return "answer";
    },
  });

  assert.deepEqual(delivery, { mode: "standard", result: "answer" });
  assert.deepEqual(calls, [["standard"]]);
});

test("standard Codex final is delivered when no end-of-turn message was registered", async () => {
  const calls = [];
  const delivery = await routeCodexFinalDelivery({
    completion: { message: null },
    deliverStandard: async () => {
      calls.push("standard");
      return "answer";
    },
  });

  assert.deepEqual(delivery, { mode: "standard", result: "answer" });
  assert.deepEqual(calls, ["standard"]);
});
