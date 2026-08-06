import assert from "node:assert/strict";
import test from "node:test";
import { CodexEventService } from "../../../src/providers/codex/codex-event-service.mjs";

function createService(run, overrides = {}) {
  const noop = () => {};
  return new CodexEventService({
    invalidateThreadRead: noop, forEvent: () => run, reindexRun: noop,
    applyThreadSettings: noop, saveState: async () => {}, trackTokenUsage: noop,
    taskKey: () => "task", isSelectedRun: () => false, setSelectedDiff: noop,
    appendActivity: noop, noteActivity: noop, scheduleProgress: noop, appendReasoning: noop,
    isCompactionItem: () => false, beginCompaction: noop, getCompaction: () => null,
    rememberRawCompactionItem: noop,
    beginCompactionCleanup: noop, setStage: noop, describeItem: () => "stage",
    itemActivity: () => null, requestApproval: async () => {}, formatCommandApproval: () => "",
    formatFileApproval: () => "", formatPermissionsApproval: () => "", requestMcpElicitation: async () => {},
    discardManualCompaction: async () => false, consumeTracker: () => null,
    finishObserved: async () => {}, turnSnapshot: () => ({}), completeManaged: async () => {},
    turnTokenUsage: new Map(), speechButtons: new Map(), temporaryFiles: new Map(),
    taskDiffs: { remember: noop }, ...overrides,
  });
}

test("Codex event service appends answer deltas to the exact run", async () => {
  const run = { responseText: "", status: "running" };
  let scheduled = false;
  const service = createService(run, { scheduleProgress: () => { scheduled = true; } });
  await service.handle({ method: "item/agentMessage/delta", params: { turnId: "t1", delta: "Ответ" } });
  assert.equal(run.responseText, "Ответ");
  assert.equal(scheduled, true);
});

test("Codex event service completes a managed run through the coordinator", async () => {
  const run = { responseText: "", status: "running", observer: false };
  const completed = [];
  const service = createService(run, { completeManaged: async (...args) => completed.push(args) });
  await service.handle({ method: "turn/completed", params: { turn: { id: "turn-1" } } });
  assert.equal(completed.length, 1);
  assert.equal(completed[0][1].completedTurnId, "turn-1");
});

test("Codex event service preserves the raw compaction item for rotation", async () => {
  const captured = [];
  const service = createService(null, {
    rememberRawCompactionItem: (...args) => captured.push(args),
  });
  const item = { type: "compaction", encrypted_content: "opaque" };
  await service.handle({
    method: "rawResponseItem/completed",
    params: { threadId: "thread-1", turnId: "turn-1", item },
  });
  assert.deepEqual(captured, [["thread-1", { turnId: "turn-1", item }]]);
});
