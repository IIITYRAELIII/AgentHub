import assert from "node:assert/strict";
import test from "node:test";

import { ProviderCancellationService } from "../../src/providers/provider-turn-services.mjs";

test("Claude cancellation persists by provider session instead of stream identity", async () => {
  const cancelledClaudeTasks = new Map();
  const service = new ProviderCancellationService({
    interruptCodex: async () => {},
    runForTask: () => null,
    completeRun: async () => {},
    readCodexSnapshot: async () => null,
    finishObserved: async () => {},
    completeManaged: async () => {},
    taskExternalActivity: async () => ({ state: "inactive" }),
    stopClaudeRun: async () => true,
    processIsAlive: () => false,
    claudeCancellationKey: (task) => `${task.provider}\0${task.threadId}`,
    saveState: async () => {},
    cancelledClaudeTasks,
  });
  const run = {
    provider: "claude",
    streamId: "stream-1",
    threadId: "session-1",
    process: {},
    observer: false,
  };

  const result = await service.cancelClaude(run);

  assert.equal(result.accepted, true);
  assert.equal(cancelledClaudeTasks.has("claude\0session-1"), true);
  assert.equal([...cancelledClaudeTasks.keys()].some((key) => key.includes("stream-1")), false);
});
