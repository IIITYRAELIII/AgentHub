import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeEventService } from "../../../src/providers/claude/claude-event-service.mjs";

test("Claude event service binds the provider session without changing logical task identity", () => {
  const selected = [];
  const retargeted = [];
  const service = new ClaudeEventService({
    isSelectedRun: () => true, reindexRun: () => {}, setSelectedThread: (...args) => selected.push(args),
    retargetClientSelection: (...args) => retargeted.push(args),
    runTitle: (run) => run.taskTitle, bindRunMessage: async () => {}, saveState: async () => {},
    noteActivity: () => {}, scheduleProgress: () => {}, appendReasoning: () => {}, setStage: () => {},
    appendActivity: () => {},
  });
  const run = { streamId: "stream-1", threadId: null, taskTitle: "Новая задача Claude", progressMessageIds: [] };
  service.handle(run, { sessionId: "session-12345678" });
  assert.equal(run.streamId, "stream-1");
  assert.equal(run.threadId, "session-12345678");
  assert.deepEqual(selected, [["session-12345678", "Сессия Claude · session-"]]);
  assert.deepEqual(retargeted, [[run, "session-12345678", "Сессия Claude · session-"]]);
});
