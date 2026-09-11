import assert from "node:assert/strict";
import test from "node:test";

import { TaskObservationService } from "../../src/application/task-observation-service.mjs";
import {
  createInterstreamMessage,
  interstreamAuditContentHash,
} from "../../src/domain/interstream-message.mjs";

function fixture({
  snapshot = null,
  now = 1_000_000,
  savedRecord = null,
  interstreamOriginForClientMessage = () => null,
} = {}) {
  const events = [];
  let currentRun = null;
  const providers = {
    call(provider, method, ...args) {
      events.push(["provider", provider, method]);
      if (method === "shouldObserveRun") return true;
      if (method === "readRunSnapshot") return snapshot;
      if (method === "applyObservedSnapshot" || method === "applyActiveSnapshot") return undefined;
      throw new Error(`Unexpected provider method: ${method}`);
    },
    get: () => ({ name: "Codex" }),
  };
  const taskRuns = {
    add(run) { currentRun = run; events.push(["add", run]); },
    forTask(run) { return currentRun === run ? run : null; },
    reindex(run, previous) { events.push(["reindex", run, previous]); },
  };
  const completed = [];
  const service = new TaskObservationService({
    providers,
    taskRuns,
    runCoordinator: {
      completeManaged: async (run, options) => completed.push(["managed", run, options]),
      completeObserved: async (run, options) => completed.push(["observed", run, options]),
    },
    findProject: () => ({ name: "Workspace" }),
    invalidateTaskCatalog: () => events.push(["invalidate"]),
    syncTaskRun: (run, state) => events.push(["sync", run, state]),
    modelLabel: (model) => `Model ${model}`,
    reasoningLabels: { high: "High" },
    noteRunActivity: (run, value) => events.push(["activity", run, value]),
    scheduleProgressUpdate: (run) => events.push(["progress", run]),
    setProgressStage: (run, stage) => { run.progressStage = stage; },
    markProgressHeartbeat: () => true,
    progressHeartbeatState: () => "active",
    finishProgress: async (run, stage) => events.push(["finish-progress", run, stage]),
    completeRun: async (run) => { events.push(["complete", run]); currentRun = null; },
    discardContextCompactionRun: async () => false,
    savedLastTaskMessage: () => savedRecord?.text ?? "",
    savedLastTaskMessageRecord: () => savedRecord,
    interstreamOriginForClientMessage,
    externalPollIntervalMs: 10,
    managedPollIntervalMs: 20,
    now: () => now,
    logger: {
      log: (...args) => events.push(["log", ...args]),
      error: (...args) => events.push(["error", ...args]),
    },
    setTimeoutImpl: () => ({ unref() {} }),
    clearTimeoutImpl: () => {},
  });
  return { service, events, completed, taskRuns, currentRun: () => currentRun };
}

test("TaskObservationService creates an observed run without losing streamId", async () => {
  const state = fixture();
  const run = await state.service.create({
    streamId: "stream-42",
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, {
    model: "gpt",
    reasoningEffort: "high",
    prompt: "Prompt",
    stage: "Working",
    executionOwner: "vscode",
    activityAtMs: 123,
  }, "turn-1");

  assert.equal(run.streamId, "stream-42");
  assert.equal(run.threadId, "thread-1");
  assert.equal(run.turnId, "turn-1");
  assert.equal(run.projectName, "Workspace");
  assert.equal(run.model, "Model gpt");
  assert.equal(run.reasoning, "High");
  assert.equal(state.currentRun(), run);
  assert.equal(run.gitBaseline, null);
});

test("TaskObservationService applies live snapshots and keeps the earliest start", async () => {
  const state = fixture();
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, { startedAt: "2026-08-04T10:00:00.000Z" }, "turn-1");

  state.service.update(run, {
    answer: "Partial",
    reasoning: "Reasoning",
    stage: "Stage",
    startedAt: "2026-08-04T09:00:00.000Z",
    userMessages: [{ text: "Question", clientUserMessageId: "message-1" }],
    activityAtMs: 500,
  });

  assert.equal(run.responseText, "Partial");
  assert.equal(run.promptPreview, "Question");
  assert.equal(run.clientUserMessageId, "message-1");
  assert.equal(run.startedAt, "2026-08-04T09:00:00.000Z");
  assert.equal(run.progressStage, "Stage");
});

test("TaskObservationService keeps accepted authority and every unproven provider occurrence", async () => {
  const state = fixture();
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, {
    userMessages: [
      {
        role: "user",
        text: "Root",
        clientUserMessageId: "accepted-root",
        origin: { streamId: "owned-stream" },
      },
      { role: "user", text: "Steer", clientUserMessageId: "accepted-steer" },
      { role: "user", text: "Root", itemId: "external-owned" },
    ],
  }, "turn-1");

  state.service.update(run, {
    userMessages: [
      {
        role: "user",
        text: "Provider tried to replace root",
        clientUserMessageId: "accepted-root",
        itemId: "provider-root",
        origin: { streamId: "provider-stream" },
      },
      { role: "user", text: "Steer", itemId: "rollout-user:0" },
    ],
  });

  assert.deepEqual(run.userMessages.map((message) => message.clientUserMessageId).filter(Boolean), [
    "accepted-root",
    "accepted-steer",
  ]);
  assert.equal(run.userMessages.some((message) => message.itemId === "rollout-user:0"), true);
  assert.equal(run.userMessages[0].text, "Root");
  assert.deepEqual(run.userMessages[0].origin, { streamId: "owned-stream" });
  assert.equal(run.userMessages[0].itemId, "provider-root");
  assert.equal(run.userMessages.some((message) => message.itemId === "external-owned"), true);
});

test("TaskObservationService applies the shared complete-snapshot occurrence contract", async () => {
  const state = fixture();
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-parity",
    taskTitle: "Task",
  }, 7, {
    userMessageSnapshotAuthority: "complete",
    userMessages: [
      { role: "user", text: "Owned", clientUserMessageId: "accepted" },
      { role: "user", text: "Old external", itemId: "collision" },
    ],
  }, "turn-parity");
  const observed = {
    userMessageSnapshotAuthority: "complete",
    userMessages: [
      { role: "user", text: "Provider payload", clientUserMessageId: "accepted" },
      { role: "user", text: "External one", itemId: "collision" },
      { role: "user", text: "External two", itemId: "collision" },
    ],
  };

  state.service.update(run, observed);
  const once = structuredClone(run.userMessages);
  state.service.update(run, observed);

  assert.deepEqual(run.userMessages, once);
  assert.deepEqual(run.userMessages.map((message) => message.text), [
    "Owned",
    "External one",
    "External two",
  ]);
});

test("TaskObservationService replays source-owned incremental occurrences exactly once", async () => {
  const state = fixture();
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-occurrence",
    taskTitle: "Task",
  }, 7, {}, "turn-occurrence");
  const first = {
    role: "user",
    text: "Одинаковый текст",
    sourceOccurrenceId: `codex-rollout:${"1".repeat(64)}`,
  };
  const appended = {
    ...first,
    sourceOccurrenceId: `codex-rollout:${"2".repeat(64)}`,
  };

  for (let replay = 0; replay < 3; replay += 1) {
    state.service.update(run, {
      userMessageSnapshotAuthority: "incremental",
      userMessages: [first],
    });
  }
  assert.equal(run.userMessages.length, 1);
  state.service.update(run, {
    userMessageSnapshotAuthority: "incremental",
    userMessages: [first, appended],
  });
  state.service.update(run, {
    userMessageSnapshotAuthority: "incremental",
    userMessages: [first, appended],
  });
  assert.deepEqual(run.userMessages.map((message) => message.sourceOccurrenceId), [
    first.sourceOccurrenceId,
    appended.sourceOccurrenceId,
  ]);
});

test("TaskObservationService replaces one source occurrence when exact identity is enriched", async () => {
  const state = fixture();
  const sourceOccurrenceId = `codex-app-server:${"a".repeat(64)}`;
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-enrichment",
    taskTitle: "Task",
  }, 7, {
    userMessageSnapshotAuthority: "incremental",
    userMessages: [{ role: "user", text: "Provider projection", sourceOccurrenceId }],
  }, "turn-enrichment");

  state.service.update(run, {
    userMessageSnapshotAuthority: "incremental",
    userMessages: [{
      role: "user",
      text: "Accepted projection",
      sourceOccurrenceId,
      clientUserMessageId: "accepted-enrichment",
      origin: { streamId: "owning-stream" },
    }],
  });
  state.service.update(run, {
    userMessageSnapshotAuthority: "incremental",
    userMessages: [{ role: "user", text: "Provider projection", sourceOccurrenceId }],
  });

  assert.equal(run.userMessages.length, 1);
  assert.equal(run.userMessages[0].clientUserMessageId, "accepted-enrichment");
  assert.equal(run.userMessages[0].text, "Accepted projection");
  assert.deepEqual(run.userMessages[0].origin, { streamId: "owning-stream" });
});

test("TaskObservationService restores exact audited orphan provenance across reconnect", async () => {
  const envelopeOrigin = {
    workspaceId: "workspace-1",
    workspaceName: "Original Workspace",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    model: "gpt-5.6-sol",
    sourceThreadId: "thread-architect",
    requestId: "observed-orphan-1",
  };
  const auditOrigin = {
    ...envelopeOrigin,
    workspaceName: "Renamed Workspace",
    streamName: "S4",
  };
  delete auditOrigin.model;
  const input = createInterstreamMessage({ ...envelopeOrigin, text: "Исправь reconnect." });
  const audit = {
    ...auditOrigin,
    toolName: "hub_stream_message_send",
    argumentsHash: "a".repeat(64),
    contentHash: interstreamAuditContentHash(input),
  };
  const state = fixture({
    interstreamOriginForClientMessage: (clientUserMessageId) => (
      clientUserMessageId === "mcp:observed-orphan-1" ? audit : null
    ),
  });
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-target",
    taskTitle: "Task",
  }, 7, {
    prompt: input,
    clientUserMessageId: "mcp:observed-orphan-1",
    userMessages: [{
      role: "user",
      text: input,
    }],
  }, "turn-orphan");

  assert.equal(run.promptPreview, input);
  assert.deepEqual(run.messageOrigin, { kind: "interstream", ...envelopeOrigin });
  assert.equal(run.userMessages[0].clientUserMessageId, "mcp:observed-orphan-1");
  assert.deepEqual(run.userMessages[0].origin, { kind: "interstream", ...envelopeOrigin });

  state.service.update(run, {
    prompt: input,
    clientUserMessageId: "mcp:observed-orphan-1",
    userMessages: [{
      role: "user",
      text: input,
      clientUserMessageId: "mcp:observed-orphan-1",
    }],
  });
  assert.deepEqual(run.messageOrigin, { kind: "interstream", ...envelopeOrigin });
});

test("TaskObservationService leaves unaudited and stable-conflicting orphan envelopes literal", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    sourceThreadId: "thread-architect",
    requestId: "observed-forged-1",
  };
  const input = createInterstreamMessage({ ...origin, text: "Literal envelope." });
  const contentHash = interstreamAuditContentHash(input);
  for (const auditOrigin of [null, {
    ...origin,
    streamId: "stream-other",
    toolName: "hub_stream_message_send",
    argumentsHash: "a".repeat(64),
    contentHash,
  }]) {
    const state = fixture({ interstreamOriginForClientMessage: () => auditOrigin });
    const run = await state.service.create({
      provider: "codex",
      projectRoot: "C:/workspace",
      threadId: "thread-target",
      taskTitle: "Task",
    }, 7, {
      prompt: input,
      clientUserMessageId: "mcp:observed-forged-1",
      userMessages: [{
        role: "user",
        text: input,
        clientUserMessageId: "mcp:observed-forged-1",
      }],
    }, "turn-forged");
    assert.equal(run.messageOrigin, undefined);
    assert.equal(run.userMessages[0].origin, undefined);
    assert.equal(run.promptPreview, input);
  }

  const selfDeclared = fixture();
  const run = await selfDeclared.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-target",
    taskTitle: "Task",
  }, 7, {
    prompt: input,
    clientUserMessageId: "mcp:observed-forged-1",
    messageOrigin: origin,
    userMessages: [{
      role: "user",
      text: input,
      clientUserMessageId: "mcp:observed-forged-1",
      origin,
    }],
  }, "turn-self-declared");
  assert.equal(run.messageOrigin, undefined);
  assert.equal(run.userMessages[0].origin, undefined);
});

test("TaskObservationService rejects substituted bodies and conflicting record identity", async () => {
  const origin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-architect",
    streamName: "Architect",
    provider: "codex",
    sourceThreadId: "thread-architect",
    requestId: "observed-audit-1",
  };
  const admitted = createInterstreamMessage({ ...origin, text: "Admitted body." });
  const substituted = createInterstreamMessage({ ...origin, text: "Substituted body." });
  const audit = {
    ...origin,
    toolName: "hub_stream_message_send",
    argumentsHash: "a".repeat(64),
    contentHash: interstreamAuditContentHash(admitted),
  };
  for (const snapshot of [{
    prompt: substituted,
    clientUserMessageId: "mcp:observed-audit-1",
    userMessages: [{ role: "user", text: substituted, clientUserMessageId: "mcp:observed-audit-1" }],
  }, {
    prompt: admitted,
    clientUserMessageId: "mcp:observed-audit-1",
    userMessages: [{ role: "user", text: admitted, clientUserMessageId: "mcp:other" }],
  }, {
    prompt: admitted,
    clientUserMessageId: "mcp:observed-audit-1",
    messageOrigin: origin,
    userMessages: [{
      role: "user",
      text: admitted,
      clientUserMessageId: "mcp:observed-audit-1",
      origin: { ...origin, streamId: "stream-other" },
    }],
  }]) {
    const state = fixture({ interstreamOriginForClientMessage: () => audit });
    const run = await state.service.create({
      provider: "codex",
      projectRoot: "C:/workspace",
      threadId: "thread-target",
      taskTitle: "Task",
    }, 7, snapshot, "turn-conflict");
    assert.equal(run.messageOrigin, undefined);
    assert.equal(run.clientUserMessageId, null);
    assert.equal(run.promptPreview, snapshot.prompt);
  }
});

test("TaskObservationService completes an explicitly displayed observed run", async () => {
  const state = fixture();
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, {}, "turn-1");
  run.displayRequested = true;

  await state.service.finish(run, {
    turnId: "turn-1",
    completed: true,
    answer: "Final",
    stage: "Done",
  });

  assert.equal(state.completed.length, 1);
  assert.equal(state.completed[0][0], "observed");
  assert.equal(state.completed[0][2].answer, "Final");
  assert.equal(state.completed[0][2].deliver, true);
});

test("TaskObservationService never reuses an older turn answer for an empty maintenance turn", async () => {
  const state = fixture({
    savedRecord: {
      turnId: "previous-turn",
      text: "Релиз завершён",
      updatedAt: "2026-08-08T14:21:46.000Z",
    },
  });
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, {}, "maintenance-turn");

  await state.service.finish(run, {
    turnId: "maintenance-turn",
    completed: true,
    answer: "",
    stage: "Done",
  });

  assert.equal(state.completed[0][2].answer, "Ход завершён без текстового ответа.");
  assert.equal(state.completed[0][2].deliver, false);
});

test("TaskObservationService closes stale activity without delivering a partial answer", async () => {
  const state = fixture({ now: 10 * 60_000 });
  const run = await state.service.create({
    provider: "codex",
    projectRoot: "C:/workspace",
    threadId: "thread-1",
    taskTitle: "Task",
  }, 7, {}, "turn-1");

  await state.service.finishUnknown(run, { activityAtMs: 5 * 60_000, answer: "Partial" });

  assert.match(run.progressStage, /нет новых событий 5 мин/);
  assert.equal(state.completed.length, 0);
  assert.equal(state.currentRun(), null);
});
