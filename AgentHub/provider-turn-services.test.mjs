import assert from "node:assert/strict";
import test from "node:test";
import { CodexTurnService, unsupportedProviderSteer } from "./src/providers/provider-turn-services.mjs";

test("Codex turn service steers one exact active turn", async () => {
  const calls = [];
  const noop = async () => {};
  const service = new CodexTurnService({
    sendRpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { turns: [{ id: "turn-1", status: "inProgress" }] } };
      return { turnId: params.expectedTurnId };
    },
    sandboxMode: () => "workspace-write",
    compactionRecycle: () => null,
    resolvedSkillNames: async () => [],
    reindexRun: () => {},
    saveState: noop,
    startTyping: () => {},
    scheduleObservedRun: () => {},
    finishProgress: noop,
    completeRun: noop,
    readThread: async () => ({ thread: { turns: [{ id: "turn-1", status: "inProgress" }] } }),
    speechButtons: new Map(), temporaryFiles: new Map(), turnTokenUsage: new Map(),
  });
  assert.deepEqual(await service.steer({ run: {}, target: { threadId: "thread-1" }, input: "More" }), { turnId: "turn-1" });
  assert.equal(calls.at(-1).method, "turn/steer");
  assert.throws(() => unsupportedProviderSteer(), /недоступна/u);
});
