import assert from "node:assert/strict";
import { CodexTaskSnapshotService } from "../../../src/providers/codex/codex-task-snapshot-service.mjs";
import { codexRolloutTurnState } from "../../../src/providers/codex/codex-rollout-activity.mjs";

export const turnId = "ordinary-turn";
export const row = (type, payload) => `${JSON.stringify({ timestamp: new Date().toISOString(), type, payload })}\n`;
export const start = () => row("event_msg", { type: "task_started", turn_id: turnId });
export const message = (id, phase, text) => row("response_item", {
  type: "message", role: "assistant", id, phase,
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
  content: [{ type: "output_text", text }],
});

export function observer(readActivity) {
  return new CodexTaskSnapshotService({
    knownRolloutPath: async () => "synthetic-rollout",
    readRolloutActivity: readActivity,
    rolloutTurnState: codexRolloutTurnState,
    capturedOwner: () => null, runtimeActive: async () => true,
    resolveOwner: async () => "vscode-app-server",
    readThread: async () => assert.fail("Rollout observation must not call the provider"),
    selectTurn: () => null, turnSnapshot: () => ({}), turnStartedAt: () => null,
    describeItem: () => "stage", hubOwner: () => "agent-hub", agentHubPid: () => 1,
    modelLabel: (value) => value, runtimeLabel: (value) => value,
    delay: async () => {}, reindexRun: () => {},
  });
}
