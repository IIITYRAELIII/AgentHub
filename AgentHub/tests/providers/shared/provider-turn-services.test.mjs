import assert from "node:assert/strict";
import test from "node:test";
import {
  CODEX_TURN_START_UNCONFIRMED,
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
    developerInstructions: async () => null,
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

test("Codex turn service refreshes a stale registered turn before steering", async () => {
  const run = { turnId: "turn-old" };
  const reindexed = [];
  let saves = 0;
  const service = codexTurnService({
    readThread: async () => ({
      thread: { turns: [{ id: "turn-current", status: "inProgress" }] },
    }),
    sendRpc: async (method, params) => {
      assert.equal(method, "turn/steer");
      assert.equal(params.expectedTurnId, "turn-current");
      return { turnId: params.expectedTurnId };
    },
    reindexRun: (value, previous) => reindexed.push({ value, previous }),
    saveState: async () => { saves += 1; },
  });

  const result = await service.steer({
    run,
    target: { threadId: "thread-1" },
    input: "Use the current turn",
    clientUserMessageId: "message-current",
  });

  assert.deepEqual(result, { turnId: "turn-current" });
  assert.equal(run.turnId, "turn-current");
  assert.deepEqual(reindexed, [{ value: run, previous: { turnId: "turn-old" } }]);
  assert.equal(saves, 1);
});

test("Codex turn service never steers user input into a context probe", async () => {
  let steerCalls = 0;
  const service = codexTurnService({
    readThread: async () => ({
      thread: {
        turns: [{
          id: "probe-turn",
          status: "inProgress",
          items: [{
            type: "userMessage",
            clientId: "agent-hub-context-probe:test",
          }],
        }],
      },
    }),
    sendRpc: async () => {
      steerCalls += 1;
      return { turnId: "probe-turn" };
    },
  });

  await assert.rejects(
    service.steer({
      run: { turnId: "probe-turn" },
      target: { threadId: "thread-1" },
      input: "Обычное пользовательское сообщение",
      clientUserMessageId: "message-user",
    }),
    /сообщение осталось в очереди/u,
  );
  assert.equal(steerCalls, 0);
});

test("Codex turn service recognizes the tracked probe turn when Thread read omits its client id", async () => {
  let steerCalls = 0;
  const service = codexTurnService({
    isContextProbeTurn: (threadId, turnId) => threadId === "thread-1" && turnId === "probe-turn",
    readThread: async () => ({
      thread: {
        turns: [{
          id: "probe-turn",
          status: "inProgress",
          items: [{ type: "userMessage" }],
        }],
      },
    }),
    sendRpc: async () => {
      steerCalls += 1;
      return { turnId: "probe-turn" };
    },
  });

  await assert.rejects(
    service.steer({
      run: { turnId: "probe-turn" },
      target: { threadId: "thread-1" },
      input: "Обычное пользовательское сообщение",
      clientUserMessageId: "message-user",
    }),
    /сообщение осталось в очереди/u,
  );
  assert.equal(steerCalls, 0);
});

test("Codex turn service recognizes probe text when Thread read omits its client id", async () => {
  let steerCalls = 0;
  const service = codexTurnService({
    readThread: async () => ({
      thread: {
        turns: [{
          id: "probe-turn",
          status: "inProgress",
          items: [{
            type: "userMessage",
            content: [{
              type: "input_text",
              text: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
            }],
          }],
        }],
      },
    }),
    sendRpc: async () => {
      steerCalls += 1;
      return { turnId: "probe-turn" };
    },
  });

  await assert.rejects(
    service.steer({
      run: { turnId: "probe-turn" },
      target: { threadId: "thread-1" },
      input: "Обычное пользовательское сообщение",
      clientUserMessageId: "message-user",
    }),
    /сообщение осталось в очереди/u,
  );
  assert.equal(steerCalls, 0);
});

test("Codex turn service steers the user turn while a tracked context probe is also active", async () => {
  const steerRequests = [];
  const service = codexTurnService({
    isContextProbeTurn: (threadId, turnId) => threadId === "thread-1" && turnId === "probe-turn",
    readThread: async () => ({
      thread: {
        turns: [{
          id: "user-turn",
          status: "inProgress",
          items: [{ type: "userMessage" }],
        }, {
          id: "probe-turn",
          status: "inProgress",
          items: [{ type: "userMessage" }],
        }],
      },
    }),
    sendRpc: async (method, params) => {
      assert.equal(method, "turn/steer");
      steerRequests.push(params);
      return { turnId: params.expectedTurnId };
    },
  });

  const result = await service.steer({
    run: { turnId: "user-turn" },
    target: { threadId: "thread-1" },
    input: "Добавить в текущий ход",
    clientUserMessageId: "message-user",
  });

  assert.deepEqual(result, { turnId: "user-turn" });
  assert.equal(steerRequests.length, 1);
  assert.equal(steerRequests[0].expectedTurnId, "user-turn");
});

test("Codex turn service retries one active-turn transition with the same message identity", async () => {
  const activeTurns = ["turn-first", "turn-second"];
  const steerRequests = [];
  let reads = 0;
  const service = codexTurnService({
    readThread: async () => ({
      thread: {
        turns: [{ id: activeTurns[Math.min(reads++, activeTurns.length - 1)], status: "inProgress" }],
      },
    }),
    sendRpc: async (method, params) => {
      assert.equal(method, "turn/steer");
      steerRequests.push(params);
      if (steerRequests.length === 1) {
        throw new Error("expected active turn id 'turn-first' but found 'turn-second'");
      }
      return { turnId: params.expectedTurnId };
    },
  });

  const result = await service.steer({
    run: {},
    target: { threadId: "thread-1" },
    input: "Do not duplicate me",
    clientUserMessageId: "message-stable",
  });

  assert.deepEqual(result, { turnId: "turn-second" });
  assert.deepEqual(steerRequests.map(({ expectedTurnId }) => expectedTurnId), [
    "turn-first",
    "turn-second",
  ]);
  assert.deepEqual(steerRequests.map(({ clientUserMessageId }) => clientUserMessageId), [
    "message-stable",
    "message-stable",
  ]);
});

test("Codex turn service resumes a recycled app-server thread and retries the same steer identity", async () => {
  const calls = [];
  let steerAttempts = 0;
  const service = codexTurnService({
    sendRpc: async (method, params) => {
      calls.push({ method, params });
      if (method === "turn/steer" && ++steerAttempts === 1) {
        throw new Error("thread not found: thread-1");
      }
      return method === "turn/steer" ? { turnId: params.expectedTurnId } : { thread: { id: params.threadId } };
    },
  });

  const result = await service.steer({
    run: { turnId: "turn-1" },
    target: { threadId: "thread-1" },
    input: [{ type: "text", text: "Retry without duplication" }],
    clientUserMessageId: "message-1",
  });

  assert.deepEqual(calls.map((call) => call.method), ["turn/steer", "thread/resume", "turn/steer"]);
  assert.strictEqual(calls[0].params, calls[2].params);
  assert.deepEqual(calls[0].params, {
    threadId: "thread-1",
    expectedTurnId: "turn-1",
    input: [{ type: "text", text: "Retry without duplication" }],
    clientUserMessageId: "message-1",
  });
  assert.deepEqual(calls[1].params, {
    threadId: "thread-1",
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  });
  assert.deepEqual(result, { turnId: "turn-1" });
});

test("Codex turn service persists the exact receipt before background materialization", async () => {
  const scheduled = [];
  const turnTokenUsage = new Map();
  const service = codexTurnService({
    scheduleObservedRun: (run) => scheduled.push(run.turnId),
    turnTokenUsage,
    developerInstructions: async () => "<workspace_instructions>Work carefully</workspace_instructions>",
    resolvedSkillNames: async () => ["openai-docs"],
  });
  const run = {
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
  };

  await service.launch(run, [
    { type: "text", text: "Queued user message" },
    { type: "localImage", path: "screen.png" },
    { type: "localFile", path: "notes.txt" },
  ]);

  assert.equal(run.turnId, "turn-1");
  assert.equal(run.providerStart.state, "accepted-awaiting-first-event");
  assert.deepEqual(scheduled, ["turn-1"]);
  assert.deepEqual(
    turnTokenUsage.get("turn-1").contextBreakdown.categories.map((entry) => [entry.id, entry.count]),
    [["workspace", 0], ["messages", 1], ["images", 1], ["files", 1], ["skills", 1]],
  );
});

test("Codex turn service does not wait for Thread projection before returning the accepted run", async () => {
  let finishRead;
  const readPending = new Promise((resolve) => { finishRead = resolve; });
  const scheduled = [];
  const service = codexTurnService({
    readThread: () => readPending,
    scheduleObservedRun: (run) => scheduled.push(run.turnId),
  });
  const run = {
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
  };

  await service.launch(run, "Start immediately");

  assert.equal(run.providerStart.state, "accepted-awaiting-first-event");
  assert.deepEqual(scheduled, ["turn-1"]);
  finishRead({
    thread: { turns: [{ id: "turn-1", items: [{ type: "userMessage" }] }] },
  });
});

test("a provider event observed before the RPC response never regresses to awaiting", async () => {
  const run = {
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
  };
  const service = codexTurnService({
    sendRpc: async () => {
      run.turnId = "turn-1";
      run.providerStart = {
        ...run.providerStart,
        state: "observed",
        turnId: "turn-1",
        acceptedAt: "2026-08-15T00:00:00.000Z",
        firstEventAt: "2026-08-15T00:00:01.000Z",
        firstEventMethod: "item/started",
      };
      return { turn: { id: "turn-1" } };
    },
  });

  await service.launch(run, "Already producing events");

  assert.equal(run.providerStart.state, "observed");
  assert.equal(run.providerStart.firstEventMethod, "item/started");
});

test("an exact provider event prevents retry when the RPC response is lost", async () => {
  const completed = [];
  const scheduled = [];
  const run = {
    id: "run-1",
    threadId: "thread-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
    status: "running",
    displayRequested: true,
  };
  const service = codexTurnService({
    sendRpc: async () => {
      run.turnId = "turn-1";
      run.providerStart = {
        state: "observed",
        turnId: "turn-1",
        acceptedAt: "2026-08-15T00:00:00.000Z",
        firstEventAt: "2026-08-15T00:00:01.000Z",
        firstEventMethod: "item/started",
      };
      throw Object.assign(new Error("response channel closed after turn/started"), {
        code: "ECONNRESET",
        deliveryOutcome: "unknown",
        uncertain: true,
      });
    },
    completeRun: async (value) => completed.push(value.id),
    scheduleObservedRun: (value) => scheduled.push(value.turnId),
  });

  await service.launch(run, "Already accepted");

  assert.deepEqual(completed, []);
  assert.deepEqual(scheduled, ["turn-1"]);
  assert.equal(run.status, "running");
});

test("an ambiguous turn start adopts only the exact client message receipt", async () => {
  const completed = [];
  const scheduled = [];
  const run = {
    id: "run-1",
    threadId: "thread-1",
    clientUserMessageId: "message-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
    status: "running",
  };
  const service = codexTurnService({
    sendRpc: async () => {
      throw Object.assign(new Error("response channel closed"), {
        deliveryOutcome: "unknown",
        uncertain: true,
      });
    },
    readThread: async () => ({
      thread: {
        turns: [
          { id: "old-turn", items: [{ type: "userMessage", clientId: "old-message" }] },
          { id: "turn-1", items: [{ type: "userMessage", clientId: "message-1" }] },
        ],
      },
    }),
    completeRun: async (value) => completed.push(value.id),
    scheduleObservedRun: (value) => scheduled.push(value.turnId),
  });

  await service.launch(run, "Ambiguous but accepted");

  assert.equal(run.turnId, "turn-1");
  assert.equal(run.providerStart.state, "accepted-awaiting-first-event");
  assert.deepEqual(completed, []);
  assert.deepEqual(scheduled, ["turn-1"]);
});

test("Codex turn service finds a persisted turn only by the exact client message id", async () => {
  const service = codexTurnService({
    readThread: async () => ({
      thread: {
        turns: [
          { id: "turn-same-text", items: [{ type: "userMessage", clientId: "other-message" }] },
          { id: "turn-exact", items: [{ type: "userMessage", clientId: "message-exact" }] },
        ],
      },
    }),
  });

  assert.deepEqual(
    await service.findByClientMessage({ threadId: "thread-1" }, "message-exact"),
    { id: "turn-exact", items: [{ type: "userMessage", clientId: "message-exact" }] },
  );
  assert.equal(
    await service.findByClientMessage({ threadId: "thread-1" }, "missing-message"),
    null,
  );
});

test("an unconfirmed turn start is never retried automatically", async () => {
  const completed = [];
  const run = {
    id: "run-1",
    threadId: "thread-1",
    clientUserMessageId: "message-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
    status: "running",
  };
  const service = codexTurnService({
    sendRpc: async () => {
      throw Object.assign(new Error("response channel closed"), {
        deliveryOutcome: "unknown",
        uncertain: true,
      });
    },
    readThread: async () => ({
      thread: { turns: [{ id: "old-turn", items: [{ type: "userMessage", clientId: "old-message" }] }] },
    }),
    completeRun: async (value) => completed.push(value.id),
  });

  await assert.rejects(
    service.launch(run, "Do not duplicate"),
    (error) => error.code === CODEX_TURN_START_UNCONFIRMED,
  );
  assert.deepEqual(completed, ["run-1"]);
  assert.equal(run.providerStart.state, "unconfirmed");
});

test("a terminal provider event cannot be resurrected by a late RPC response", async () => {
  const reindexed = [];
  const scheduled = [];
  const run = {
    id: "run-1",
    threadId: "thread-1",
    clientUserMessageId: "message-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
    status: "running",
  };
  const service = codexTurnService({
    sendRpc: async () => {
      run.status = "completed";
      run.admissionReleased = true;
      return { turn: { id: "turn-1" } };
    },
    reindexRun: (value) => reindexed.push(value.id),
    scheduleObservedRun: (value) => scheduled.push(value.turnId),
  });

  await service.launch(run, "Already completed");

  assert.deepEqual(reindexed, []);
  assert.deepEqual(scheduled, []);
  assert.equal(run.turnId, undefined);
});

test("Codex turn service resolves developer instructions for every turn start", async () => {
  const starts = [];
  const resolved = [];
  let instructions = "Workspace rules";
  const service = codexTurnService({
    developerInstructions: async (target) => (resolved.push(target), instructions),
    sendRpc: async (method, params) => {
      if (method === "turn/start") starts.push(params);
      return { turn: { id: `turn-${starts.length}` } };
    },
    readThread: async () => ({
      thread: {
        turns: [{ id: `turn-${starts.length}`, status: "inProgress", items: [{ type: "userMessage" }] }],
      },
    }),
  });
  const run = {
    threadId: "thread-1",
    streamId: "stream-1",
    projectRoot: "D:\\Work",
    modelId: "gpt-5.6-codex",
    reasoningId: "medium",
    collaborationMode: "default",
  };

  await service.launch(run, "First");
  instructions = "Updated rules";
  await service.launch(run, "Second");

  assert.deepEqual(starts.map((call) => (
    call.collaborationMode.settings.developer_instructions
  )), ["Workspace rules", "Updated rules"]);
  assert.deepEqual(resolved, [
    { provider: "codex", threadId: "thread-1", streamId: "stream-1" },
    { provider: "codex", threadId: "thread-1", streamId: "stream-1" },
  ]);
});

test("Codex turn service never rejects or repeats an acknowledged turn with a delayed Thread projection", async () => {
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

  await service.launch(run, "Message that must remain queued");

  assert.equal(run.turnId, "turn-1");
  assert.equal(run.providerStart.state, "accepted-awaiting-first-event");
  assert.deepEqual(scheduled, ["turn-1"]);
  assert.deepEqual(completed, []);
});
