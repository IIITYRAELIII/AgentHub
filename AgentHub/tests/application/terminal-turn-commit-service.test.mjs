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

test("terminal commit keeps live citation refs when completion tracking is empty", async () => {
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

  await service.commit({
    provider: "codex",
    threadId: "thread-annotation",
    turnId: "turn-annotation",
    status: "completed",
    finalAnswer: "Цитата 1\nСвязь сохранена",
    responseAnnotationReferences: [],
  }, {
    run: {
      id: "run-annotation",
      responseItemId: "provider-final-item",
      responseAnnotationReferences: [{ index: 1 }],
    },
  });

  assert.deepEqual(stored.payload.history.responseAnnotationReferences, [{ index: 1 }]);
});

test("terminal commit persists raw prompt and drops oversized provider message identity", async () => {
  let stored = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        stored = value;
        return {
          terminal: {
            provider: value.provider,
            threadId: value.threadId,
            turnId: value.turnId,
            terminalRevision: 1,
            status: value.status,
            payload: value.payload,
          },
          outbox: {},
        };
      },
      get: async () => null,
    },
  });
  const oversized = "x".repeat(201);

  await service.commit({
    provider: "codex",
    threadId: "thread-bounded",
    turnId: "turn-bounded",
    status: "completed",
    finalAnswer: "Done",
    clientUserMessageId: oversized,
  }, {
    run: {
      id: "run-bounded",
      rawPrompt: "raw transport prompt",
      promptPreview: "display body",
      clientUserMessageId: oversized,
      userMessages: [{ role: "user", text: "display body", clientUserMessageId: oversized }],
    },
  });

  assert.equal(stored.payload.history.promptPreview, "raw transport prompt");
  assert.equal(stored.payload.history.clientUserMessageId, null);
  assert.equal(stored.payload.history.userMessages[0].clientUserMessageId, undefined);
  assert.equal(stored.payload.completion.clientUserMessageId, undefined);
});

test("terminal commit drops conflicting top-level and root interstream identity", async () => {
  let stored = null;
  const service = new TerminalTurnCommitService({
    store: {
      commit: async (value) => {
        stored = value;
        return { terminal: { ...value, terminalRevision: 1, payload: value.payload }, outbox: {} };
      },
      get: async () => null,
    },
  });
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-1",
    streamName: "Architect",
    provider: "codex",
    sourceThreadId: "thread-source",
    requestId: "request-a",
  };

  await service.commit({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    turnId: "turn-conflict",
    status: "completed",
    finalAnswer: "Done",
    clientUserMessageId: "mcp:request-a",
    messageOrigin: origin,
    userMessages: [{
      role: "user",
      text: "raw",
      clientUserMessageId: "mcp:request-b",
      origin: { ...origin, requestId: "request-b" },
    }],
  }, {
    run: {
      id: "run-conflict",
      rawPrompt: "raw",
      clientUserMessageId: "mcp:request-a",
      messageOrigin: origin,
      userMessages: [{
        role: "user",
        text: "raw",
        clientUserMessageId: "mcp:request-b",
        origin: { ...origin, requestId: "request-b" },
      }],
    },
  });

  assert.equal(stored.payload.completion.clientUserMessageId, undefined);
  assert.equal(stored.payload.completion.messageOrigin, undefined);
  assert.equal(stored.payload.completion.userMessages[0].clientUserMessageId, undefined);
  assert.equal(stored.payload.history.clientUserMessageId, null);
  assert.equal(stored.payload.history.messageOrigin, undefined);
  assert.equal(stored.payload.history.userMessages[0].clientUserMessageId, undefined);
});
