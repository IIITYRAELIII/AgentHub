import assert from "node:assert/strict";
import test from "node:test";
import { CodexTaskSnapshotService } from "./codex-task-snapshot-service.mjs";

test("Codex snapshot service reports an exact rollout observer", async () => {
  const service = new CodexTaskSnapshotService({
    knownRolloutPath: async () => "rollout.jsonl",
    readRolloutActivity: async () => ({ activeTurnIds: ["turn-1"], activityAtMsByTurnId: {}, running: true }),
    rolloutTurnState: () => ({
      turnId: "turn-1", active: true, completed: false, latestAnswer: "Now", finalAnswer: "",
      userMessages: [{ text: "Do" }], startedAt: "2026-08-04T10:00:00.000Z",
    }),
    capturedOwner: () => null, runtimeActive: async () => true, resolveOwner: async () => "vscode-app-server",
    readThread: async () => ({ thread: {} }), selectTurn: () => null, turnSnapshot: () => ({}),
    turnStartedAt: () => null, describeItem: () => "stage", hubOwner: () => "agent-hub",
    agentHubPid: () => 42,
  });
  const snapshot = await service.read({ observer: true, threadId: "thread-1", exactTurnObserver: true });
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.answer, "Now");
  assert.equal(snapshot.executionOwner, "vscode-app-server");
});

