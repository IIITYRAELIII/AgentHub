import assert from "node:assert/strict";
import test from "node:test";

import { TerminalTurnCommitService } from "../../src/application/terminal-turn-commit-service.mjs";

test("terminal commit closes the matching message command through idempotent CAS", async () => {
  const transitions = [];
  const service = new TerminalTurnCommitService({
    store: {
      commit: async () => ({
        terminal: {
          provider: "codex",
          threadId: "thread-1",
          turnId: "turn-1",
          terminalRevision: 3,
          status: "completed",
          payload: { history: { id: "run-1", clientUserMessageId: "message-1" } },
        },
        outbox: {},
      }),
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
});

test("terminal commit keeps structured response annotations beside the canonical answer", async () => {
  let stored = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        stored = value;
        return {
          terminal: {
            provider: "codex",
            threadId: "thread-annotation",
            turnId: "turn-annotation",
            terminalRevision: 1,
            status: "completed",
            payload: value.payload,
          },
          outbox: {},
        };
      },
      get: async () => null,
    },
  });
  const responseAnnotations = [{ text: "Фрагмент", annotation: "Почему?" }];

  await service.commit({
    provider: "codex",
    threadId: "thread-annotation",
    turnId: "turn-annotation",
    status: "completed",
    finalAnswer: "Связь сохранена",
    responseAnnotationReferences: [{ index: 1 }],
  }, {
    run: {
      id: "run-annotation",
      userMessages: [{ role: "user", text: "Комментарий", responseAnnotations }],
    },
  });

  assert.equal(stored.finalAnswer, "Связь сохранена");
  assert.deepEqual(stored.payload.history.responseAnnotationReferences, [{ index: 1 }]);
  assert.deepEqual(stored.payload.history.userMessages[0].responseAnnotations, responseAnnotations);
});
