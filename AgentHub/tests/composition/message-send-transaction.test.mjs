import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(
  new URL("../../assets/web-app/messages/send-transaction.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({ window: {} });
vm.runInContext(source, context);
const transaction = context.window.AgentHubMessageSendTransaction;

test("accepted message stays accepted when card synchronization overflows", async () => {
  const calls = [];
  const result = await transaction.run({
    send: async () => ({ accepted: true, turnId: "turn-1" }),
    reject: async () => calls.push("reject"),
    receive: async () => calls.push("receive"),
    synchronize: async () => {
      calls.push("synchronize");
      throw new RangeError("Maximum call stack size exceeded");
    },
    synchronizationFailed: async (error) => calls.push(error.name),
  });

  assert.equal(result.accepted, true);
  assert.deepEqual(calls, ["receive", "synchronize", "RangeError"]);
});

test("transport failure remains retryable and is not received", async () => {
  const calls = [];
  await assert.rejects(transaction.run({
    send: async () => { throw new Error("connection lost"); },
    reject: async () => calls.push("reject"),
    receive: async () => calls.push("receive"),
    synchronize: async () => calls.push("synchronize"),
    synchronizationFailed: async () => calls.push("synchronizationFailed"),
  }), /connection lost/u);

  assert.deepEqual(calls, ["reject"]);
});

test("receipt callback failure never reclassifies a delivered transport", async () => {
  const calls = [];
  const result = await transaction.run({
    send: async () => ({ accepted: true, turnId: "turn-2" }),
    reject: async () => calls.push("reject"),
    receive: async () => {
      calls.push("receive");
      throw new RangeError("Maximum call stack size exceeded");
    },
    synchronize: async () => calls.push("synchronize"),
    synchronizationFailed: async () => calls.push("synchronizationFailed"),
  });

  assert.equal(result.turnId, "turn-2");
  assert.deepEqual(calls, ["receive", "synchronizationFailed"]);
});
