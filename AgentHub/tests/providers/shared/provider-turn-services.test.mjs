import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_TURN_NOT_MATERIALIZED,
  CodexTurnService,
  unsupportedProviderSteer,
} from "../../../src/providers/provider-turn-services.mjs";

function codexTurnService(overrides = {}) {
  const noop = async () => {};
  return new CodexTurnService({
    sendRpc: async () => ({ turn: { id: "turn-1" } }),
    sandboxMode: () => "workspace-write",
    compactionRecycle: () => null,
    resolvedSkillNames: async () => [],
    reindexRun: () => {},
    saveState: noop,
    startTyping: () => {},
    scheduleObservedRun: () => {},
    finishProgress: noop,
    completeRun: noop,
    readThread: async () => ({
      thread: {
        turns: [{ id: "turn-1", status: "inProgress", items: [{ type: "userMessage" }] }],
      },
    }),
    speechButtons: new Map(),
    temporaryFiles: new Map(),
    turnTokenUsage: new Map(),
    turnMaterializationTimeoutMs: 1,
    turnMaterializationPollMs: 1,
    sleep: noop,
    ...overrides,
  });
}

test("Codex turn service steers one exact active turn", async () => {
  const calls = [];
  const service = codexTurnService({
    sendRpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "thread/read") return { thread: { turns: [{ id: "turn-1", status: "inProgress" }] } };
      return { turnId: params.expectedTurnId };
    },
  });
  assert.deepEqual(await service.steer({ run: {}, target: { threadId: "thread-1" }, input: "More" }), { turnId: "turn-1" });
  assert.equal(calls.at(-1).method, "turn/steer");
  assert.throws(() => unsupportedProviderSteer(), /недоступна/u);
});

test("Codex turn service schedules a run only after its exact turn materializes", async () => {
  const scheduled = [];
  const service = codexTurnService({ scheduleObservedRun: (run) => scheduled.push(run.turnId) });
  const run = {
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
  };

  await service.launch(run, "Queued user message");

  assert.equal(run.turnId, "turn-1");
  assert.deepEqual(scheduled, ["turn-1"]);
});

test("Codex turn service rejects an acknowledged turn without its user input", async () => {
  const completed = [];
  const scheduled = [];
  const service = codexTurnService({
    readThread: async () => ({
      thread: {
        turns: [
          { id: "turn-1", status: "inProgress", items: [] },
          { id: "probe-turn", status: "inProgress", items: [{ type: "userMessage" }] },
        ],
      },
    }),
    completeRun: async (run) => completed.push(run.id),
    scheduleObservedRun: (run) => scheduled.push(run.turnId),
  });
  const run = {
    id: "run-1",
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
  };

  await assert.rejects(
    service.launch(run, "Message that must remain queued"),
    (error) => error.code === CODEX_TURN_NOT_MATERIALIZED,
  );

  assert.equal(run.turnId, undefined);
  assert.deepEqual(scheduled, []);
  assert.deepEqual(completed, ["run-1"]);
});
