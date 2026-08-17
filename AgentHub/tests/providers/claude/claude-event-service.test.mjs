import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeEventService } from "../../../src/providers/claude/claude-event-service.mjs";

test("Claude event service binds the provider session without changing logical task identity", () => {
  const selected = [];
  const retargeted = [];
  let catalogInvalidations = 0;
  const service = new ClaudeEventService({
    isSelectedRun: () => true, reindexRun: () => {}, setSelectedThread: (...args) => selected.push(args),
    invalidateCatalog: () => { catalogInvalidations += 1; },
    retargetClientSelection: (...args) => retargeted.push(args),
    runTitle: (run) => run.taskTitle, bindRunMessage: async () => {}, saveState: async () => {},
    noteActivity: () => {}, scheduleProgress: () => {}, appendReasoning: () => {}, setStage: () => {},
    appendActivity: () => {}, trackContextUsage: () => {},
  });
  const run = { streamId: "stream-1", threadId: null, taskTitle: "Новая задача Claude", progressMessageIds: [] };
  service.handle(run, { sessionId: "session-12345678" });
  assert.equal(run.streamId, "stream-1");
  assert.equal(run.threadId, "session-12345678");
  assert.deepEqual(selected, [["session-12345678", "Сессия Claude · session-"]]);
  assert.deepEqual(retargeted, [[run, "session-12345678", "Сессия Claude · session-"]]);
  assert.equal(catalogInvalidations, 1);
});

test("Claude event service publishes live context usage from the observed model", () => {
  const tracked = [];
  const service = new ClaudeEventService({
    isSelectedRun: () => false, reindexRun: () => {}, setSelectedThread: () => {},
    invalidateCatalog: () => {}, retargetClientSelection: () => {}, runTitle: () => "Task",
    bindRunMessage: async () => {}, saveState: async () => {}, noteActivity: () => {},
    scheduleProgress: () => {}, appendReasoning: () => {}, setStage: () => {},
    appendActivity: () => {}, trackContextUsage: (...args) => tracked.push(args),
  });
  const run = { threadId: "session-1", turnId: "turn-1", progressMessageIds: [] };

  service.handle(run, { event: {
    type: "stream_event",
    event: {
      type: "message_start",
      message: {
        model: "claude-opus-5",
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 1_000,
          cache_read_input_tokens: 2_000,
          output_tokens: 5,
        },
      },
    },
  } });
  service.handle(run, { event: {
    type: "stream_event",
    event: {
      type: "message_delta",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 1_000,
        cache_read_input_tokens: 2_000,
        output_tokens: 100,
      },
    },
  } });

  assert.equal(run.claudeObservedModel, "claude-opus-5");
  assert.deepEqual(tracked.map(([, usage]) => usage), [
    { model: "claude-opus-5", modelContextWindow: 1_000_000, usedTokens: 3_007 },
    { model: "claude-opus-5", modelContextWindow: 1_000_000, usedTokens: 3_102 },
  ]);
});
