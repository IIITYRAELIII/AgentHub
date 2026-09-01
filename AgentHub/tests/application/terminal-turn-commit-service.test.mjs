import assert from "node:assert/strict";
import test from "node:test";

import { TerminalTurnCommitService } from "../../src/application/terminal-turn-commit-service.mjs";

test("terminal commit closes the matching message command through idempotent CAS", async () => {
  const transitions = [];
  let committed = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        committed = value;
        return ({
        terminal: {
          provider: "codex",
          threadId: "thread-1",
          turnId: "turn-1",
          terminalRevision: 3,
          status: "completed",
          payload: { history: { id: "run-1", clientUserMessageId: "message-1" } },
        },
        outbox: {},
        });
      },
      get: async () => null,
    },
    messageCommands: {
      transitionMessageCommand: async (transition) => transitions.push(transition),
    },
  });

  await service.commit({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    status: "completed",
    finalAnswer: "готово",
  }, {
    run: { id: "run-1", clientUserMessageId: "message-1" },
  });

  assert.equal(transitions.length, 1);
  assert.equal(transitions[0].clientUserMessageId, "message-1");
  assert.equal(transitions[0].state, "completed");
  assert.equal(transitions[0].result.terminalRevision, 3);
  assert.equal(committed.payload.completion.runId, "run-1");
  assert.equal(committed.payload.history.id, "run-1");
});
