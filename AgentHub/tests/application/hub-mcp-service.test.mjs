import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { createHash } from "node:crypto";
import { createReleaseOperation } from "../../src/domain/release-operation.mjs";
import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";

import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { measureTaskOperation, withTaskOperationTiming } from "../../src/infrastructure/process/task-operation-timing.mjs";
import { TaskIntegrationConflictError, TaskIntegrationRejectedError, TaskAwaitIntegrationError, TaskWithdrawalBusyError } from "../../src/application/task-lifecycle-service.mjs";
import { ReleaseCandidateFrozenError, TaskAbsorptionCompositionError } from "../../src/domain/task-board-task.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TASK_TITLE_MAX_LENGTH, TaskDependencyPendingError } from "../../src/domain/task-board-task.mjs";
import { incomingLedgerRecord } from "../../src/application/work-log-usage-projection.mjs";
import { createInterstreamMessage } from "../../src/domain/interstream-message.mjs";
import { AsyncSqliteMutationQueue } from "../../src/infrastructure/persistence/async-sqlite-mutation-queue.mjs";
import {
  initializeTaskGitRepository,
  unprovenProcessTaskGit,
} from "../helpers/task-git-unproven-process.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { normalizedTaskSquashTransfer } from "../../src/domain/task-squash-transfer.mjs";
import { canonicalPath } from "../../src/infrastructure/filesystem/config.mjs";
import { taskRepositoryKey } from "../../src/domain/task-git-reference.mjs";

import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { DeferredInputController } from "../../src/application/deferred-input-controller.mjs";
import { DeferredInputService } from "../../src/application/deferred-input-service.mjs";
import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";
import { MessageCommandLedgerStore } from "../../src/infrastructure/persistence/message-command-ledger-store.mjs";
import { messageRequestFingerprint } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { CommandTraceSpanStore } from "../../src/infrastructure/persistence/command-trace-span-store.mjs";

async function releaseDeliveryFixture(t) {
  let deliver;
  const traces = [];
  const { service } = await fixture(t, {
    releaseOperations: { setEventDelivery(value) { deliver = value; } },
    recordCommandTrace: value => traces.push(value),
  });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-release-delivery-"));
  let ledger = new MessageCommandLedgerStore({ dataDir });
  const store = new DeferredInputStore();
  const receipts = new Map();
  const providerReceipts = new Map();
  const providerCalls = [];
  const admissions = [];
  const active = { id: "event-run", provider: "codex", streamId: "stream-1",
    threadId: "thread-1", turnId: "event-turn", status: "running", executionOwner: "hub" };
  let run = active;
  let blocked = false;
  let providerBehavior = async () => {};
  const trace = {
    recordBestEffort: value => traces.push(value),
    startBestEffortSpan: value => ({ finish: result => traces.push({ ...value, ...result }) }),
  };
  const persist = async () => ledger.projectSnapshot({
    pendingInputs: [...store.pending.values()], queuedInputs: [...store.queued.values()],
    desktopMessageReceipts: [...receipts.values()],
    activeRuns: run ? [run] : [],
  });
  const intake = new DeferredInputService({
    store, persist, removeFiles: async () => {}, notify: async () => null, commandTrace: trace,
    persistIntake: async (item, destination, receipt) => {
      const result = ledger.accept({ item, destination, receipt });
      if (!result.duplicate && receipt) receipts.set(item.clientUserMessageId, receipt);
      return result;
    },
  });
  const coordinator = new RunCoordinator({
    taskRuns: { forTask: () => run && ["running", "finishing"].includes(run.status) ? run : null },
    providers: { call: async (_provider, method, request) => {
      assert.equal(method, "steerTurn");
      providerCalls.push({ method, id: request.clientUserMessageId, turnId: request.run.turnId, input: request.input });
      await providerBehavior(request);
      const result = { accepted: true, steered: true, runId: request.run.id,
        threadId: request.target.threadId, turnId: request.run.turnId,
        clientUserMessageId: request.clientUserMessageId };
      providerReceipts.set(request.clientUserMessageId, result);
      return { turnId: result.turnId };
    } },
    externalActivity: async () => ({ state: "inactive" }), repositoryConflict: async () => null,
    deferInput: (...args) => intake.defer(...args),
    beginRun: async (_input, target) => ({ ...target, id: "idle-run", status: "running", executionOwner: "hub" }),
    rollbackAdmission: async () => {},
    launchTurn: async (next, input) => {
      providerCalls.push({ method: "startTurn", id: next.clientUserMessageId, input });
      next.turnId = "idle-turn";
      next.providerStart = { turnId: next.turnId, state: "accepted-awaiting-first-event" };
      run = next;
    },
    isRestartPending: () => blocked,
  });
  const controller = new DeferredInputController({
    pendingInputs: store.pending, queuedInputs: store.queued,
    isBlocked: async () => Boolean(coordinator.activeRun(active)) || blocked,
    occupancy: target => coordinator.deferredOccupancy(target),
    isSteerDispatchBlocked: async () => blocked,
    steer: item => coordinator.steer({ input: item.input, target: item, clientUserMessageId: item.clientUserMessageId }),
    start: item => coordinator.startDeferred(item),
    findSteered: async item => providerReceipts.get(item.clientUserMessageId) ?? null,
    persist, updateMessage: async () => {}, pendingKeyboard: () => ({}), notifyReturned: async () => {},
    onStateChange: (item, state, result) => {
      const prior = receipts.get(item.clientUserMessageId);
      if (!prior) return;
      if (state === "steered") receipts.set(item.clientUserMessageId, { ...prior, result });
      if (state === "started") receipts.set(item.clientUserMessageId, { ...prior,
        result: { accepted: true, runId: result.id, turnId: result.turnId, providerAccepted: true } });
    },
    commandTrace: trace, setTimeoutImpl: () => 0, clearTimeoutImpl: () => {},
  });
  service.setStreamMessenger(async (params, context) => {
    admissions.push({ params: structuredClone(params), context: structuredClone(context) });
    const target = { provider: "codex", streamId: params.streamId, threadId: run?.threadId ?? "thread-1",
      clientSource: context.source, telegramDeliveryRequested: false, messageOrigin: context.messageOrigin };
    return coordinator.acceptClientInput({ input: params.text, target,
      clientUserMessageId: params.clientUserMessageId, followUpMode: params.followUpMode,
      messageFingerprint: await messageRequestFingerprint(params) });
  });
  t.after(async () => { ledger.close(); await rm(dataDir, { recursive: true, force: true }); });
  const event = { operationId: "release-original", revision: 7, eventKind: "operation.progress",
    createdAt: new Date().toISOString(),
    streamId: "stream-1", threadId: "thread-1", payload: { state: "validate", nextAction: "validate candidate" } };
  return { event, active, store, controller, coordinator, service, providerCalls, providerReceipts, admissions, traces,
    deliver: (value = event) => deliver(value),
    ledger: () => ledger,
    setRun: value => { run = value; }, setBlocked: value => { blocked = value; },
    setProvider: value => { providerBehavior = value; },
    reopen: () => {
      ledger.close(); ledger = new MessageCommandLedgerStore({ dataDir });
      const restored = ledger.overlay({ pendingInputs: [], queuedInputs: [] });
      store.pending.clear(); store.queued.clear();
      for (const item of restored.pendingInputs) store.pending.set(item.id, item);
      for (const item of restored.queuedInputs) store.queued.set(item.id, item);
    },
  };
}

test("release notifications steer the active turn through durable intake before provider acceptance", async t => {
  const f = await releaseDeliveryFixture(t);
  const ack = await f.deliver();
  assert.equal(ack.steerPending, true);
  assert.equal(ack.queued, false);
  assert.equal(f.providerCalls.length, 0, "intake acknowledgement is not provider acceptance");
  assert.equal(f.ledger().get(ack.clientUserMessageId).state, "queued");
  let release;
  f.setProvider(() => new Promise(resolve => { release = resolve; }));
  const dispatch = f.controller.process(ack.id);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.providerCalls.length, 1, "active turn need not finish before provider dispatch");
  assert.equal(f.ledger().get(ack.clientUserMessageId).state, "dispatching");
  assert.equal(f.providerReceipts.has(ack.clientUserMessageId), false);
  release(); await dispatch;
  const receipt = f.ledger().get(ack.clientUserMessageId);
  assert.equal(receipt.state, "completed");
  assert.equal(receipt.result.steered, true);
  assert.equal(receipt.result.turnId, f.active.turnId);
  assert.equal(f.active.status, "running");
  assert.equal(f.providerCalls[0].id, "release:release-original:7:operation.progress");
  assert.equal(f.providerCalls[0].input, f.admissions[0].params.text);
  assert.equal(f.admissions[0].context.source, "release-operation");
  assert.deepEqual(f.admissions[0].context.messageOrigin, { kind: "release-operation", sourceThreadId: "thread-1" });
  assert.deepEqual(JSON.parse(f.admissions[0].params.text.split("\n")[1]), {
    operationId: f.event.operationId, revision: 7, eventKind: f.event.eventKind, ...f.event.payload,
  });
  assert.ok(f.traces.some(value => value.commandId === ack.clientUserMessageId && value.stage === "durable-intake-enqueue"));
  assert.ok(f.traces.some(value => value.commandId === ack.clientUserMessageId && value.stage === "dispatch" && value.outcome === "succeeded"));
  assert.ok(f.traces.some(value => value.commandId === ack.clientUserMessageId && value.stage === "release-event-created"
    && value.observedAtMs === Date.parse(f.event.createdAt)));
  assert.ok(f.traces.some(value => value.stage === "release-event-intake" && value.outcome === "succeeded"
    && value.metadata.intakeAccepted && !value.metadata.providerAccepted && value.metadata.steerPending));
  await f.deliver(); await f.controller.process(ack.id);
  assert.equal(f.providerCalls.length, 1, "outbox duplicate must retain original provider effect");
});

test("release notifications keep outcome and content privacy when diagnostics or intake fail", async t => {
  const f = await releaseDeliveryFixture(t);
  const failure = Object.assign(new Error("private event body must not be logged"), { code: "EVENT_TEST_FAILURE" });
  f.service.setStreamMessenger(async () => { throw failure; });
  await assert.rejects(f.deliver(), error => error === failure);
  const result = f.traces.find(value => value.stage === "release-event-intake" && value.outcome === "unknown");
  assert.equal(result.commandId, "release:release-original:7:operation.progress");
  assert.equal(result.metadata.errorCode, failure.code);
  assert.equal(JSON.stringify(f.traces).includes(failure.message), false);
  assert.equal(JSON.stringify(f.traces).includes(f.event.payload.nextAction), false);
  f.service.recordCommandTrace = () => { throw new Error("diagnostic sink unavailable"); };
  await assert.rejects(f.deliver(), error => error === failure);
  const receipt = { accepted: true, steerPending: true, providerAccepted: false };
  f.service.setStreamMessenger(async () => receipt);
  assert.equal(await f.deliver(), receipt);
});

test("release notifications persist creation, intake and provider dispatch under the original event ID", async t => {
  const f = await releaseDeliveryFixture(t);
  const ack = await f.deliver();
  await f.controller.process(ack.id);
  const failure = Object.assign(new Error("private transport failure"), { code: "EVENT_DELIVERY_FAILED" });
  f.service.setStreamMessenger(async () => { throw failure; });
  await assert.rejects(f.deliver(), error => error === failure);
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-event-trace-"));
  let traceStore = new CommandTraceSpanStore({ databaseFile: path.join(directory, "traces.sqlite") });
  try {
    await traceStore.appendMany(f.traces);
    await traceStore.close();
    traceStore = new CommandTraceSpanStore({ databaseFile: path.join(directory, "traces.sqlite") });
    const rows = await traceStore.readCommandTimeline(ack.clientUserMessageId);
    assert.ok(rows.some(row => row.stage === "release-event-created" && row.observedAtMs === Date.parse(f.event.createdAt)));
    assert.ok(rows.some(row => row.stage === "release-event-intake" && row.metadata.steerPending && !row.metadata.providerAccepted));
    assert.ok(rows.some(row => row.stage === "dispatch" && row.outcome === "succeeded"));
    assert.ok(rows.some(row => row.stage === "release-event-intake" && row.outcome === "unknown"
      && row.metadata.errorCode === failure.code));
    assert.equal(JSON.stringify(rows).includes(failure.message), false);
    assert.equal(JSON.stringify(rows).includes(f.event.payload.nextAction), false);
    assert.ok(rows.every(row => row.commandId === ack.clientUserMessageId));
  } finally { await traceStore.close(); await rm(directory, { recursive: true, force: true }); }
});

test("release notifications retain exact pending steer through reconnect and refuse a completed or rotated target", async t => {
  for (const rotated of [false, true]) {
    const f = await releaseDeliveryFixture(t);
    const ack = await f.deliver();
    assert.equal(ack.steerPending, true);
    f.reopen();
    f.setRun(rotated ? { ...f.active, id: "later-run", threadId: "later-thread", turnId: "later-turn" } : null);
    await f.controller.process(ack.id);
    assert.equal(f.providerCalls.length, 0);
    assert.equal(f.store.pending.get(ack.id).lastErrorCode, "ERR_PROVIDER_STEER_NOT_DELIVERED");
    assert.equal(f.store.pending.get(ack.id).clientUserMessageId, ack.clientUserMessageId);
    assert.equal(f.store.pending.get(ack.id).steerTargetTurnId, "event-turn");
  }
});

test("release notifications wait behind restart without losing steer and idle delivery keeps ordinary admission", async t => {
  const active = await releaseDeliveryFixture(t);
  active.setBlocked(true);
  const ack = await active.deliver();
  assert.equal(ack.steerPending, true);
  await active.controller.process(ack.id);
  assert.equal(active.providerCalls.length, 0);
  active.reopen(); active.setBlocked(false);
  await active.controller.process(ack.id);
  assert.equal(active.providerCalls.length, 1);
  assert.equal(active.ledger().get(ack.clientUserMessageId).result.steered, true);

  const idle = await releaseDeliveryFixture(t);
  idle.setRun(null);
  const idleAck = await idle.deliver();
  assert.equal(idleAck.queued, true);
  assert.equal(idle.providerCalls.length, 0);
  await idle.controller.process(idleAck.id);
  assert.equal(idle.providerCalls[0].method, "startTurn");
  assert.equal(idle.ledger().get(idleAck.clientUserMessageId).result.turnId, "idle-turn");
});

test("release notifications reconcile a lost accepted steer reply without replay across reopen", async t => {
  const f = await releaseDeliveryFixture(t);
  const ack = await f.deliver();
  f.setProvider(request => {
    f.providerReceipts.set(request.clientUserMessageId, { accepted: true, steered: true,
      clientUserMessageId: request.clientUserMessageId, runId: f.active.id,
      threadId: f.active.threadId, turnId: f.active.turnId });
    throw Object.assign(new Error("lost provider reply"), { uncertain: true });
  });
  await f.controller.process(ack.id);
  assert.equal(f.providerCalls.length, 1);
  assert.equal(f.ledger().get(ack.clientUserMessageId).state, "dispatching");
  f.reopen();
  await f.controller.process(ack.id);
  assert.equal(f.providerCalls.length, 1);
  assert.equal(f.ledger().get(ack.clientUserMessageId).state, "completed");
  assert.equal(f.ledger().get(ack.clientUserMessageId).result.steered, true);
  await f.deliver();
  assert.equal(f.providerCalls.length, 1);
});

test("release notifications preserve every event while ordinary explicit queue remains queued", async t => {
  const f = await releaseDeliveryFixture(t);
  const user = await f.coordinator.acceptClientInput({ input: "user next turn",
    target: f.active, clientUserMessageId: "user-explicit-queue", followUpMode: "queue" });
  assert.equal(user.queued, true);
  for (const [offset, eventKind] of ["operation.progress", "operation.waiting", "operation.completed"].entries()) {
    const event = { ...f.event, revision: 10 + offset, eventKind };
    const ack = await f.deliver(event);
    assert.equal(ack.steerPending, true);
    await f.controller.process(ack.id);
    assert.equal(f.ledger().get(ack.clientUserMessageId).result.steered, true);
  }
  assert.equal(f.providerCalls.length, 3);
  assert.equal(f.store.queued.get(user.id).clientUserMessageId, "user-explicit-queue");
  assert.deepEqual(f.providerCalls.map(call => call.id), [
    "release:release-original:10:operation.progress", "release:release-original:11:operation.waiting",
    "release:release-original:12:operation.completed",
  ]);
});

function claimOnlyTaskGit(overrides = {}) {
  const service = {
    withTaskLock: async (_taskId, operation) => operation({
      signal: new AbortController().signal,
      async assertOwned() {},
      async beginProcessTreeGuard() { throw new Error("unexpected test guard"); },
    }),
    withTaskRepositoryRecoveryLock: async (_taskId, _projectRoot, taskLease, operation) => operation(taskLease),
    prepareOwned: async (params) => service.prepare(params),
    snapshotAndMergeOwned: async () => { throw new Error("unexpected test snapshot"); },
    cleanupOwned: async () => { throw new Error("unexpected test cleanup"); },
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], dirty: false, unpublished: [] }),
    ...overrides,
  };
  return service;
}

import { readPreparationSourceClosure, ReleasePreparationRejectedError } from "../../src/application/release-preparation-admission.mjs";
import { preparationEnvelope } from "../helpers/release-preparation-envelope.mjs";

async function fixture(context, {
  releaseWorkflowEnabled = false,
  taskGitWorkspacesFactory = null,
  taskOperationReconciliation = null,
  releaseOperations = null,
  measureOperation = measureTaskOperation,
  recordCommandTrace = () => {},
  beforeRemoveDirectory = async () => {},
} = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mcp-"));
  context.after(async () => {
    await beforeRemoveDirectory();
    await rm(directory, { recursive: true, force: true });
  });
  const projectRoot = path.join(directory, "project");
  const streamWorkingDirectory = path.join(directory, "stream-working-directory");
  const workspaceWorkingDirectory = path.join(directory, "workspace-working-directory");
  const targetWorkingDirectory = path.join(directory, "target-working-directory");
  const foreignWorkspaceWorkingDirectory = path.join(directory, "foreign-workspace-working-directory");
  const foreignStreamWorkingDirectory = path.join(directory, "foreign-stream-working-directory");
  const attachmentDirectory = path.join(directory, "attachments");
  await mkdir(projectRoot, { recursive: true });
  const tasks = new Map([
    ["task-current", {
      id: "task-current", title: "Current", description: "", bucket: "workspace",
      status: "open", workflowStatus: "new", workspaceId: "workspace-1", streamId: null, boardOrder: 0, revision: 1,
    }],
    ["task-foreign", {
      id: "task-foreign", title: "Foreign", description: "", bucket: "workspace",
      status: "open", workflowStatus: "new", workspaceId: "workspace-2", streamId: null, boardOrder: 0, revision: 1,
    }],
  ]);
  const workspaceCatalog = {
    resolveThread: ({ provider, threadId }) => {
      if (provider !== "codex" || !["thread-1", "thread-2", "thread-3"].includes(threadId)) return null;
      const streamId = threadId === "thread-1" ? "stream-1" : threadId === "thread-2" ? "stream-2" : "stream-3";
      const foreign = streamId === "stream-3";
      return {
        workspaceId: foreign ? "workspace-2" : "workspace-1",
        workspaceName: foreign ? "Foreign Workspace" : "Agent Hub",
        streamId,
        streamDisplayName: streamId === "stream-1" ? "MCP" : streamId === "stream-2" ? "Themes" : "Foreign Stream",
        thread: { projectRoot: foreign ? foreignStreamWorkingDirectory : projectRoot },
      };
    },
    stream: (id) => ({
      "stream-1": {
        id, workspaceId: "workspace-1", displayName: "MCP", settings: { project: projectRoot },
        threads: [{ provider: "codex", threadId: "thread-1" }],
      },
      "stream-2": {
        id, workspaceId: "workspace-1", displayName: "Themes", settings: { workingDirectory: targetWorkingDirectory },
        threads: [{ provider: "codex", threadId: "thread-2" }],
      },
      "stream-3": {
        id, workspaceId: "workspace-2", displayName: "Foreign Stream", settings: { workingDirectory: foreignStreamWorkingDirectory },
        threads: [{ provider: "codex", threadId: "thread-3" }],
      },
    }[id] ?? null),
    activeThread: () => null,
    workspace: (id) => ({
      "workspace-1": { id, name: "Agent Hub", settings: { releaseWorkflowEnabled, workingDirectory: workspaceWorkingDirectory } },
      "workspace-2": { id, name: "Foreign Workspace", settings: { releaseWorkflowEnabled, workingDirectory: foreignWorkspaceWorkingDirectory } },
    }[id] ?? null),
    hierarchy: () => [{
      id: "workspace-1", name: "Agent Hub",
      settings: { releaseWorkflowEnabled, workingDirectory: workspaceWorkingDirectory },
      streams: [
        { id: "stream-1", displayName: "MCP", settings: { releaseManager: true, workingDirectory: streamWorkingDirectory }, threads: [{ provider: "codex", threadId: "thread-1" }] },
        { id: "stream-2", displayName: "Themes", settings: { workingDirectory: targetWorkingDirectory }, threads: [{ provider: "codex", threadId: "thread-2" }] },
      ],
    }, {
      id: "workspace-2", name: "Foreign Workspace",
      settings: { releaseWorkflowEnabled, workingDirectory: foreignWorkspaceWorkingDirectory },
      streams: [
        { id: "stream-3", displayName: "Foreign Stream", settings: { workingDirectory: foreignStreamWorkingDirectory }, threads: [{ provider: "codex", threadId: "thread-3" }] },
      ],
    }],
    workspaceEvents: (workspaceId, { afterSequence }) => [{
      sequence: afterSequence + 1, workspaceId, streamId: workspaceId === "workspace-2" ? "stream-3" : "stream-1",
      type: "run.completed", subjectId: "turn-1", payload: {}, createdAtMs: 1,
    }],
    developerRulesForStream: (streamId) => ({
      workspace: { revision: 1, content: streamId === "stream-3" ? "Foreign Workspace rule" : "Workspace rule" },
      stream: { revision: 2, content: streamId === "stream-3" ? "Foreign Stream rule" : "Stream rule" },
    }),
    updateWorkspaceDeveloperRules: (id, content) => ({ workspaceId: id, revision: 2, content }),
    updateStreamDeveloperRules: (id, content) => ({ streamId: id, revision: 3, content }),
  };
  const operations = new Map();
  const taskEvidenceCalls = [];
  const legacyAdoptionCalls = [];
  const taskClaimCalls = [];
  const taskClaimBindings = new Map();
  const checklistCalls = [];
  const checklistResults = new Map();
  workspaceCatalog.beginMcpOperation = (operation) => {
    const existing = operations.get(operation.requestId);
    if (existing) {
      if (existing.argumentsHash !== operation.argumentsHash) {
        throw new Error("MCP request_id was already used for another operation");
      }
      return { ...existing, replayed: true };
    }
    const created = {
      ...operation, status: "pending", operationStatus: "pending", receiptState: "pending",
      result: null, error: "", replayed: false,
    };
    operations.set(operation.requestId, created);
    return created;
  };
  workspaceCatalog.bindMcpOperationInterstreamContentHash = (requestId, contentHash) => {
    const operation = operations.get(requestId);
    if (operation.interstreamContentHash && operation.interstreamContentHash !== contentHash) {
      throw new Error("MCP interstream content does not match the original admission");
    }
    operation.interstreamContentHash = contentHash;
    return operation;
  };
  workspaceCatalog.completeMcpOperation = (requestId, result, { validate = null } = {}) => {
    validate?.();
    const operation = operations.get(requestId);
    if (["hub_stream_message_send", "hub_task_start", "hub_task_reassign"].includes(operation.toolName)
      && !operation.interstreamContentHash) {
      throw new Error("MCP interstream operation has no admitted content hash");
    }
    Object.assign(operations.get(requestId), {
      status: "succeeded", operationStatus: "succeeded", receiptState: "succeeded", result,
    });
    return operations.get(requestId);
  };
  workspaceCatalog.failMcpOperation = (requestId, error) => {
    Object.assign(operations.get(requestId), {
      status: "failed", operationStatus: "failed", receiptState: "failed", error: error.message,
    });
  };
  workspaceCatalog.markMcpOperationUnknown = (requestId, error) => {
    Object.assign(operations.get(requestId), {
      status: "unknown", operationStatus: "pending", receiptState: "unknown", error: error.message,
    });
  };
  workspaceCatalog.mcpOperation = (requestId) => operations.get(requestId) ?? null;
  workspaceCatalog.completeUnknownMcpOperation = (requestId, { result }) => {
    const operation = operations.get(requestId);
    Object.assign(operation, { status: "succeeded", operationStatus: "succeeded", receiptState: "succeeded", result });
    return operation;
  };
  workspaceCatalog.failUnknownMcpOperation = (requestId, {
    workspaceId, toolName, error, reconciliation,
  }) => {
    const operation = operations.get(requestId);
    if (operation.workspaceId !== workspaceId || operation.toolName !== toolName) {
      throw new Error("Unknown MCP operation identity does not match");
    }
    Object.assign(operation, {
      status: "failed",
      operationStatus: "failed",
      receiptState: "failed",
      error: error.message,
      result: { operatorReconciliation: reconciliation },
    });
    return operation;
  };
  workspaceCatalog.mcpOperation = (requestId) => operations.get(requestId) ?? null;
  workspaceCatalog.mcpOperations = () => [...operations.values()];
  const workspaceMutations = new AsyncSqliteMutationQueue();
  workspaceCatalog.runMutation = (operation, options) => workspaceMutations.run(operation, options);
  workspaceCatalog.mutationDiagnostics = () => workspaceMutations.diagnostics();
  const taskBoard = {
    selectedCompositionForRelease: () => null,
    snapshot: () => [...tasks.values()].map((task) => ({ ...task, attachments: task.attachments ?? [] })),
    task: (id) => tasks.get(id) ?? null,
    create: ({ text, sourceDetails = {}, bucket = "backlog", workspaceId = null }) => {
      const task = {
        id: "created", title: text, description: "", bucket,
        status: "open", workflowStatus: "new", workspaceId, sourceDetails,
      };
      tasks.set(task.id, task);
      return task;
    },
    move: ({ id, bucket, workspaceId = null }) => Object.assign(tasks.get(id), { bucket, workspaceId }),
    update: ({ id, title, description }) => Object.assign(tasks.get(id), { title, description }),
    updateChecklist: async ({ id, operation, text, completed, itemId, requestId }) => {
      checklistCalls.push({ id, operation, text, completed, itemId, requestId });
      const task = tasks.get(id);
      const checklist = [...(task.checklist ?? [])];
      if (operation === "add") checklist.push({ id: "item-1", text, completed: false, linkedTaskId: null });
      if (operation === "toggle") {
        const item = checklist.find((candidate) => candidate.id === itemId);
        if (item) item.completed = completed;
      }
      Object.assign(task, { checklist, revision: Number(task.revision ?? 1) + 1 });
      const result = { task, itemId: itemId ?? "item-1", createdTask: null, replayed: false };
      checklistResults.set(requestId, result);
      return result;
    },
    checklistRequestResult: ({ requestId }) => {
      const result = checklistResults.get(requestId);
      return result ? { ...result, replayed: true } : null;
    },
    markStarted: ({ id, workspaceId, streamId }) => Object.assign(tasks.get(id), {
      status: "started", workflowStatus: "in_progress", workspaceId, streamId,
    }),
    fencePreparedStartCancellation: ({ id }) => tasks.get(id),
    completePreparedStartCancellation: ({ id }) => Object.assign(tasks.get(id), {
      status: "open", streamId: null, startRequestId: null,
    }),
    claim: ({ id, streamId, turnId, operationId, operationKind, gitBaseline }) => {
      taskClaimCalls.push({ id, turnId, operationId, operationKind });
      taskClaimBindings.set(operationId, { taskId: id, operationId, operationKind });
      return Object.assign(tasks.get(id), {
        status: "started", workflowStatus: "in_progress", streamId, claimedTurnId: turnId, gitBaseline,
      });
    },
    claimBindingForOperation: (operationId) => taskClaimBindings.get(operationId) ?? null,
    requestWorkflowStatus: ({ id, status, turnId }) => Object.assign(tasks.get(id), {
      workflowStatus: status, requestedWorkflowStatus: status, requestedTurnId: turnId,
    }),
    beginLifecycleTransition: ({ id, operationId, targetWorkflowStatus, expectedRevision, kind }) => {
      const task = tasks.get(id);
      if (task.revision !== expectedRevision) throw new Error("revision conflict");
      task.lifecycleOperation = { operationId, targetWorkflowStatus, kind };
      return { task, replayed: false };
    },
    lifecycleTransition: (operationId) => {
      const task = [...tasks.values()].find((item) => item.lifecycleOperation?.operationId === operationId);
      return task ? {
        operationId, taskId: task.id, kind: task.lifecycleOperation.kind,
        phase: task.lifecycleOperation.kind === "workflow" ? "pending_git" : "cleanup",
      } : null;
    },
    lifecycleOutcome: () => null,
    failLifecycleTransition: (operationId) => {
      for (const task of tasks.values()) {
        if (task.lifecycleOperation?.operationId === operationId) delete task.lifecycleOperation;
      }
    },
    commitWorkflowTransition: ({ operationId, gitReferences = [], replaceGitReferences = true }) => {
      const task = [...tasks.values()].find((item) => item.lifecycleOperation?.operationId === operationId);
      task.workflowStatus = task.lifecycleOperation.targetWorkflowStatus;
      if (replaceGitReferences) task.gitReferences = gitReferences;
      task.revision += 1;
      delete task.lifecycleOperation;
      return task;
    },
    rollbackWorkflowOutcome: () => {
      throw new Error("unexpected workflow rollback");
    },
    finalizeCleanupTransition: (operationId, { deleteTask = false } = {}) => {
      const task = [...tasks.values()].find((item) => item.lifecycleOperation?.operationId === operationId);
      delete task.lifecycleOperation;
      if (deleteTask) {
        tasks.delete(task.id);
        return { deleted: true, task };
      }
      task.status = "done";
      return task;
    },
    recordTaskTurn: ({ taskId, operationId, changedFiles, branch, resultSnapshot }) => {
      taskEvidenceCalls.push({ taskId, operationId, changedFiles, branch, resultSnapshot });
      return Object.assign(tasks.get(taskId), {
        gitReferences: [{ projectRoot, branch, resultCommit: resultSnapshot.tree }],
      });
    },
    recordTaskGitReference: ({ taskId, projectRoot: root, branch, resultSnapshot }) => {
      taskEvidenceCalls.push({ taskId, projectRoot: root, branch, resultSnapshot });
      return Object.assign(tasks.get(taskId), {
        gitReferences: [{ projectRoot: root, branch, resultCommit: resultSnapshot.tree }],
      });
    },
    adoptLegacyGitReference: (options) => {
      legacyAdoptionCalls.push(options);
      const task = tasks.get(options.taskId);
      return Object.assign(task, {
        revision: Number(task.revision) + 1,
        gitReferences: [{
          projectRoot: options.projectRoot,
          branch: options.branch,
          resultCommit: options.mainResultCommit,
        }],
        gitAdoptions: [{ evidenceTurnId: options.evidenceTurnId, patchId: options.patchId }],
      });
    },
    releaseTasks: () => [],
    setWorkflowStatus: ({ id, status }) => Object.assign(tasks.get(id), {
      workflowStatus: status,
    }),
    complete: ({ id }) => Object.assign(tasks.get(id), { status: "done", workflowStatus: "done" }),
    remove: ({ id }) => tasks.delete(id),
    addAttachment: ({ id, attachment }) => {
      const task = tasks.get(id);
      task.attachments = [{ id: path.basename(attachment), name: "evidence.txt", type: "text/plain" }];
      return task;
    },
  };
  const historyRecordsByThread = new Map([["thread-1", [{
      provider: "codex", threadId: "thread-1", turnId: "turn-1", title: "Done",
      prompt: [{ type: "text", text: "Initial prompt" }], body: "Result", status: "completed",
    }]], ["thread-3", [{
      provider: "codex", threadId: "thread-3", turnId: "turn-foreign-done", title: "Foreign Done",
      prompt: "Foreign prompt", body: "Foreign result", status: "completed",
      completedAt: "2026-09-01T12:00:00.000Z",
    }]]]);
  const workLog = {
    threadTurns: async (identities, { limit = 20 } = {}) => identities
      .flatMap((identity) => historyRecordsByThread.get(identity.threadId) ?? [])
      .slice(0, limit),
  };
  const releaseCalls = [];
  const preflightCalls = [];
  const releasePlanWorkspaceIds = [];
  const taskGitPrepareCalls = [];
  const defaultTaskGitWorkspaces = {
    prepare: async ({ taskId, projectRoot: selectedProjectRoot, dependencyMode, dependencyOverrideReason }) => {
      taskGitPrepareCalls.push({ taskId, projectRoot: selectedProjectRoot, dependencyMode,
        ...(dependencyOverrideReason ? { dependencyOverrideReason } : {}) });
      return {
        taskId,
        branch: `agenthub/task/${taskId}/repo`,
        projectRoot: path.join(directory, "task-worktree", taskId),
        repositoryRoot: selectedProjectRoot,
        baseCommit: "a".repeat(40),
        headCommit: "a".repeat(40),
        gitBaseline: { repoRoot: selectedProjectRoot, tree: "a".repeat(40) },
      };
    },
    prepareOwned: async (params) => defaultTaskGitWorkspaces.prepare(params),
    snapshotAndMerge: async ({ taskId }) => {
      const selectedProjectRoot = [...taskGitPrepareCalls]
        .reverse()
        .find((call) => call.taskId === taskId)?.projectRoot;
      return {
        snapshot: {
          taskId,
          branch: `agenthub/task/${taskId}/repo`,
          projectRoot: path.join(directory, "task-worktree", taskId),
          repositoryRoot: selectedProjectRoot,
          baseCommit: "a".repeat(40),
          headCommit: "a".repeat(40),
          gitBaseline: { repoRoot: selectedProjectRoot, tree: "a".repeat(40) },
          resultSnapshot: { repoRoot: selectedProjectRoot, tree: "a".repeat(40) },
          changedFiles: [{ projectRoot: selectedProjectRoot, path: "result.mjs", operation: "modified" }],
        },
        integration: {
          integrated: true,
          resultProved: true,
          outcome: "integrated",
          alreadyIntegrated: true,
          dev: { branch: "dev", headCommit: "a".repeat(40) },
        },
      };
    },
    adoptLegacyResult: async ({
      taskId, taskNumber, projectRoot: selectedProjectRoot, reportedResultCommit, mainResultCommit,
    }) => ({
      taskId,
      projectRoot: selectedProjectRoot,
      branch: taskNumber,
      baseCommit: "0".repeat(40),
      reportedResultCommit,
      resultCommit: mainResultCommit,
      mainCommit: mainResultCommit,
      patchId: "f".repeat(40),
      changedFiles: [{ projectRoot: selectedProjectRoot, path: "AgentHub/app.js", operation: "modified" }],
    }),
    snapshotAndMergeOwned: async (params) => {
      await defaultTaskGitWorkspaces.prepare(params);
      return defaultTaskGitWorkspaces.snapshotAndMerge(params);
    },
    withTaskLock: async (_taskId, operation) => operation({
      signal: new AbortController().signal,
      async assertOwned() {},
    }),
    withTaskRepositoryRecoveryLock: async (_taskId, _projectRoot, taskLease, operation) => operation(taskLease),
    cleanupPreview: async (taskId, { gitReferences = [] } = {}) => ({
      taskId, workspaces: [], gitReferences, dirty: false,
      unpublished: gitReferences.filter((item) => item.published === false), deleting: [],
    }),
    cleanup: async () => ({ removed: 1 }),
    cleanupOwned: async (...args) => defaultTaskGitWorkspaces.cleanup(...args),
  };
  const taskGitWorkspaces = taskGitWorkspacesFactory
    ? await taskGitWorkspacesFactory({
        context, directory, projectRoot, streamWorkingDirectory, workspaceWorkingDirectory,
      })
    : defaultTaskGitWorkspaces;
  const service = new HubMcpService({
    measureOperation,
    recordCommandTrace,
    workspaceCatalog, taskBoard, workLog, attachmentDirectory, secret: "secret",
    taskGitWorkspaces, taskOperationReconciliation, releaseOperations,
    releasePlanner: {
      plan: async (workspaceId) => {
        releasePlanWorkspaceIds.push(workspaceId);
        return { workspaceId, revision: "plan-1", candidates: [], ready: [], draft: [], blocked: [], conflicts: [] };
      },
    },
    releasePreflight: {
      withAwaitTransition: async (_workspaceId, operation) => operation(),
      prepareAwaitAcceptance: async ({ acceptingTask, commitPrepared }) => {
        const task = taskBoard.task(acceptingTask.id);
        return commitPrepared({
          planRevision: `plan-${task.revision}`,
          task: {
            taskId: task.id,
            resultCommit: task.gitReferences[0].resultCommit,
            taskRevision: task.revision,
          },
        });
      },
      validateAwaitAcceptance: async ({ acceptingTask }) => {
        const task = taskBoard.task(acceptingTask.id);
        return {
          planRevision: `plan-${task.revision}`,
          task: { taskId: task.id, resultCommit: task.gitReferences[0].resultCommit },
        };
      },
      prepareAwaitSet: async (options) => {
        const result = { releaseCandidates: [] };
        if (options.commitPrepared) await options.commitPrepared(result);
        return result;
      },
      preflight: async (options) => {
        preflightCalls.push(options);
        return { ...options, releaseCandidates: [{ preReleaseHead: "prepared-head", reused: true }] };
      },
      reconcilePreflight: async (options) => ({
        ...options,
        status: "candidate_snapshot_only",
        originalOutcome: "unknown",
        replayed: false,
        releaseCandidates: [{ projectRoot: options.expectedRepositories[0]?.projectRoot, preReleaseHead: options.expectedRepositories[0]?.revision }],
      }),
    },
    releaseCompleter: {
      completeRelease: async (options) => {
        releaseCalls.push(options);
        return { ...options, released: [] };
      },
    },
  });
  const taskLaunchCalls = [];
  service.setTaskLauncher(async ({ id, workspaceId, streamId, ...options }, launchContext) => {
    taskLaunchCalls.push({ id, workspaceId, streamId, ...options });
    await launchContext.bindInterstreamAuditContent(createInterstreamMessage({
      ...launchContext.messageOrigin,
      text: options.message || "Task launch",
    }));
    const selectedProjectRoot = streamId === "stream-3"
      ? foreignStreamWorkingDirectory
      : streamId === "stream-2" ? targetWorkingDirectory
      : streamId === null ? workspaceWorkingDirectory : streamWorkingDirectory;
    const gitWorkspace = await taskGitWorkspaces.prepare({ taskId: id, projectRoot: selectedProjectRoot });
    const task = taskBoard.markStarted({ id, workspaceId, streamId });
    return { task, target: { streamId, provider: "codex", threadId: "thread-1" }, gitWorkspace };
  });
  const sentMessages = [];
  service.setStreamMessenger(async (params, messageContext) => {
    sentMessages.push({ params, context: messageContext });
    return { accepted: false, queued: true, id: "queued-1" };
  });
  const activeRun = {
    id: "run-1", provider: "codex", threadId: "thread-1", turnId: "turn-live",
    projectRoot, status: "running", progressStage: "Editing files", model: "Sol",
    modelId: "gpt-5.6-sol", reasoningId: "high",
  };
  service.setActiveRuns(() => [activeRun]);
  service.setDeferredInputs(() => []);
  return {
    service,
    token: service.contextToken({ provider: "codex", threadId: "thread-1" }),
    attachmentDirectory,
    projectRoot,
    streamWorkingDirectory,
    workspaceWorkingDirectory,
    targetWorkingDirectory,
    foreignWorkspaceWorkingDirectory,
    foreignStreamWorkingDirectory,
    workspaceCatalog,
    taskBoard,
    tasks,
    operations,
    taskEvidenceCalls,
    legacyAdoptionCalls,
    taskClaimCalls,
    taskClaimBindings,
    checklistCalls,
    taskGitPrepareCalls,
    taskLaunchCalls,
    releaseCalls,
    preflightCalls,
    releasePlanWorkspaceIds,
    taskGitWorkspaces,
    sentMessages,
    historyRecordsByThread,
    activeRun,
  };
}

async function preparationFixture(t) {
  let ledger;
  const setup = await fixture(t, { releaseWorkflowEnabled: true,
    beforeRemoveDirectory: async () => ledger?.close(),
  });
  ledger = new WorkspaceCatalogStore({ databaseFile: path.join(setup.projectRoot, "preparation.sqlite") });
  await ledger.load();
  ledger.createWorkspace({ id: "workspace-1", name: "Preparation fixture" });
  ledger.createStream({ id: "stream-1", workspaceId: "workspace-1" });
  // Exercise the actual receipt/checkpoint CAS instead of maintaining a second
  // preparation state machine in the general-purpose catalog double.
  for (const method of ["beginMcpOperation", "completeMcpOperation", "failMcpOperation",
    "markMcpOperationUnknown", "mcpOperation", "checkpointMcpPreparation", "settleMcpPreparationFailure"]) {
    setup.workspaceCatalog[method] = ledger[method].bind(ledger);
  }
  setup.operations = {
    get: ledger.mcpOperation.bind(ledger),
    get size() { return ledger.mcpOperations("workspace-1").length; },
  };
  const envelope = preparationEnvelope(setup.projectRoot);
  envelope.sourceClosureHash = (await readPreparationSourceClosure()).hash;
  setup.tasks.get("task-current").workflowStatus = "awaiting_implementation";
  let calls = 0;
  setup.service.releasePreflight.prepareCurrentAwaitSet = async ({ ownPreparation, validate, beforeCompose, commitPrepared, requestId }) => {
    calls += 1;
    assert.equal(setup.operations.get(requestId).status, "pending", "intake precedes composer");
    await ownPreparation();
    await validate();
    await beforeCompose();
    return commitPrepared({ planRevision: envelope.planRevision, taskIds: ["task-current"],
      releaseCandidates: [{ repositoryRoot: setup.projectRoot, preReleaseHead: "8".repeat(40),
        tree: envelope.repositories[0].approvedTree, baseCommit: envelope.repositories[0].approvedBaseCommit,
        manifestHash: "9".repeat(64), manifest: { preflightRequestId: requestId } }] });
  };
  return { ...setup, envelope, calls: () => calls,
    args: { context_token: setup.token, request_id: "prepare-original", preparation: envelope } };
}

test("preparation-only genuine RM admission persists exact terminal and duplicate original does not compose again", async (t) => {
  const setup = await preparationFixture(t);
  const before = structuredClone(setup.tasks.get("task-current"));
  const first = await setup.service.call("hub_release_prepare", setup.args);
  assert.equal(first.requestId, "prepare-original");
  assert.equal(first.kind, "preparation-only");
  assert.deepEqual(await setup.service.call("hub_release_prepare", setup.args), first);
  assert.equal(setup.calls(), 1);
  assert.deepEqual(setup.tasks.get("task-current"), before);
  assert.equal(setup.releaseCalls.length, 0);
  const receipt = await setup.service.call("hub_release_prepare_get", { context_token: setup.token,
    preparation_request_id: first.requestId, expected_arguments_hash: first.argumentsHash });
  assert.equal(receipt.status, "succeeded");
  assert.deepEqual(receipt.result, first);
  await assert.rejects(setup.service.call("hub_release_prepare", { ...setup.args,
    preparation: { ...setup.envelope, planRevision: "changed" } }), /another operation/);
  assert.equal(setup.calls(), 1);
});

test("preparation-only non-RM and forged caller refuse before receipt or effects", async (t) => {
  const setup = await preparationFixture(t);
  const nonRM = setup.service.contextToken({ provider: "codex", threadId: "thread-2" });
  await assert.rejects(setup.service.call("hub_release_prepare", { ...setup.args, context_token: nonRM }), /Release Manager/);
  await assert.rejects(setup.service.call("hub_release_prepare", { ...setup.args, context_token: "forged" }));
  assert.equal(setup.operations.size, 0);
  assert.equal(setup.calls(), 0);
});

for (const stale of ["row", "source"]) test(`preparation-only stale ${stale} pins refuse without composer`, async (t) => {
  const setup = await preparationFixture(t);
  if (stale === "row") setup.tasks.get("task-current").revision += 1;
  else setup.envelope.sourceClosureHash = "0".repeat(64);
  await assert.rejects(setup.service.call("hub_release_prepare", setup.args), { code: "RELEASE_PREPARATION_REJECTED" });
  assert.equal(setup.operations.get("prepare-original").status, "failed");
  assert.equal(setup.calls(), 0);
});

test("preparation-only response loss after durable terminal reads original without current checkpoint inference", async (t) => {
  const setup = await preparationFixture(t);
  const compose = setup.service.releasePreflight.prepareCurrentAwaitSet;
  setup.service.releasePreflight.prepareCurrentAwaitSet = async (request) => {
    await compose(request);
    throw new Error("transport response lost");
  };
  const result = await setup.service.call("hub_release_prepare", setup.args);
  assert.equal(setup.operations.get("prepare-original").status, "succeeded");
  assert.deepEqual(await setup.service.call("hub_release_prepare", setup.args), result);
  assert.equal(setup.calls(), 1);
  await assert.rejects(setup.service.call("hub_release_prepare_get", { context_token: setup.token,
    preparation_request_id: "prepare-original", expected_arguments_hash: "0".repeat(64) }), /identity/);
});

test("preparation-only ambiguous terminal write preserves UNKNOWN and exact readback cannot replay", async (t) => {
  const setup = await preparationFixture(t);
  setup.workspaceCatalog.completeMcpOperation = () => { throw new Error("durable write outcome unavailable"); };
  await assert.rejects(setup.service.call("hub_release_prepare", setup.args), { code: "AWAIT_ACCEPTANCE_UNKNOWN" });
  const original = setup.operations.get("prepare-original");
  assert.equal(original.status, "unknown");
  const receipt = await setup.service.call("hub_release_prepare_get", { context_token: setup.token,
    preparation_request_id: original.requestId, expected_arguments_hash: original.argumentsHash });
  assert.equal(receipt.status, "unknown");
  assert.equal(receipt.result, null);
  await assert.rejects(setup.service.call("hub_release_prepare", setup.args), /unknown/);
  assert.equal(setup.calls(), 1);
});

test("preparation-only original tracing survives rejection without arguments or secrets", async (t) => {
  const setup = await preparationFixture(t);
  const spans = [];
  setup.service.taskGitWorkspaces.withOperationTrace = (identity, operation) => (
    withTaskOperationTiming({ ...identity, record: (span) => spans.push(span) }, operation)
  );
  setup.envelope.sourceClosureHash = "0".repeat(64);
  await assert.rejects(setup.service.call("hub_release_prepare", setup.args));
  assert.ok(spans.some((span) => span.stage === "mcp:admission" && span.phase === "end"));
  assert.ok(spans.some((span) => span.stage === "preparation:pins" && span.outcome === "error"));
  assert.ok(spans.some((span) => span.stage === "trace-summary"));
  assert.ok(spans.every((span) => span.operationId === "prepare-original"));
  assert.equal(JSON.stringify(spans).includes(setup.token), false);
  assert.equal(JSON.stringify(spans).includes("sourceClosureHash"), false);
});

test("preparation-only final row CAS refusal is definitive before terminal receipt", async (t) => {
  const setup = await preparationFixture(t);
  const original = setup.workspaceCatalog.completeMcpOperation;
  setup.workspaceCatalog.completeMcpOperation = (...args) => {
    setup.tasks.get("task-current").revision += 1;
    return original(...args);
  };
  await assert.rejects(setup.service.call("hub_release_prepare", setup.args), ReleasePreparationRejectedError);
  assert.equal(setup.operations.get("prepare-original").status, "failed");
});

test("MCP admission timing injection retains one context and original receipt", async t => {
  const { service, token, operations } = await fixture(t, { measureOperation: measureTaskOperation });
  const events = [];
  const args = { context_token: token, task_id: "task-current", title: "timed", request_id: "timed-admission" };
  await withTaskOperationTiming({ operationId: args.request_id, taskId: args.task_id, record: event => events.push(event) },
    () => service.call("hub_task_update", args));
  assert.equal(operations.get(args.request_id).status, "succeeded");
  assert.ok(events.some(event => event.stage === "mcp:admission" && event.phase === "end" && event.outcome === "ok"));
  assert.ok(events.every(event => event.operationId === args.request_id && event.taskId === args.task_id));
  const prior = JSON.stringify(operations.get(args.request_id));
  await service.call("hub_task_update", args);
  assert.equal(JSON.stringify(operations.get(args.request_id)), prior);
});

test("a proved conflict is a terminal MCP failure and exact retry preserves its diagnostics", async (t) => {
  const { service, token, operations } = await fixture(t, { releaseWorkflowEnabled: true });
  let calls = 0;
  service.taskLifecycle.updateWorkflowStatus = async () => {
    calls += 1;
    throw new TaskIntegrationConflictError({ taskId: "task-current", operationId: "conflict",
      projectRoot: "task-worktree", resultCommit: "a".repeat(40), devCommit: "b".repeat(40),
      conflicts: ["app.txt"], devRestored: true });
  };
  const args = { context_token: token, task_id: "task-current", status: "testing", request_id: "conflict" };
  await assert.rejects(service.call("hub_task_status_update", args), /app.txt/);
  assert.equal(operations.get("conflict").status, "failed");
  await assert.rejects(service.call("hub_task_status_update", args), /dev unchanged/);
  assert.equal(calls, 1);
});

for (const failure of [
  new TaskIntegrationRejectedError(new Error("Sibling Task contains unapproved history")),
  new ReleaseCandidateFrozenError(),
  new TaskWithdrawalBusyError(new Error("Another Task withdrawal requires reconciliation")),
  new TaskAwaitIntegrationError(new Error("PreRelease conflict")),
]) test(`known refusal ${failure.code} is terminal and exact retry never repeats the operation`, async (t) => {
  const { service, token, operations } = await fixture(t, { releaseWorkflowEnabled: true });
  let calls = 0;
  service.taskLifecycle.updateWorkflowStatus = async () => { calls += 1; throw failure; };
  const args = { context_token: token, task_id: "task-current", status: "awaiting_implementation", request_id: failure.code };
  await assert.rejects(service.call("hub_task_status_update", args), { code: failure.code });
  assert.equal(operations.get(failure.code).status, "failed");
  await assert.rejects(service.call("hub_task_status_update", args));
  assert.equal(calls, 1);
});

test("a blocked publication wait fails admission without an unknown receipt", async (t) => {
  const { service, token, operations } = await fixture(t, { releaseWorkflowEnabled: true });
  let calls = 0;
  service.taskLifecycle.updateWorkflowStatus = async () => {
    calls += 1;
    throw new TaskDependencyPendingError("task-current", { taskId: "task-base", taskNumber: "HUB-1" });
  };
  const args = { context_token: token, task_id: "task-current", status: "in_progress", request_id: "wait" };
  await assert.rejects(service.call("hub_task_status_update", args), /HUB-1/);
  assert.equal(operations.get("wait").status, "failed");
  await assert.rejects(service.call("hub_task_status_update", args), /HUB-1/);
  assert.equal(calls, 1);
});

test("absorption composition refusal is terminal and exact retry cannot close the source", async (t) => {
  const { service, token, operations } = await fixture(t, { releaseWorkflowEnabled: true });
  let calls = 0;
  service.taskLifecycle.complete = async () => {
    calls += 1;
    throw new TaskAbsorptionCompositionError(new Error("selected Task cannot be composed"));
  };
  const args = { context_token: token, task_id: "task-current", absorbed_into_task_id: "survivor",
    request_id: "absorption-composition-refusal" };
  await assert.rejects(service.call("hub_task_complete", args), { code: "TASK_ABSORPTION_COMPOSITION_FAILED" });
  assert.equal(operations.get(args.request_id).status, "failed");
  await assert.rejects(service.call("hub_task_complete", args), /selected Task cannot be composed/);
  assert.equal(calls, 1);
});

test("Release Manager adopts exact terminal legacy evidence without accepting arbitrary HEAD", async (context) => {
  const {
    service, token, tasks, historyRecordsByThread, targetWorkingDirectory, legacyAdoptionCalls,
  } = await fixture(context, { releaseWorkflowEnabled: true });
  const reportedResultCommit = "a".repeat(40);
  const mainResultCommit = "b".repeat(40);
  tasks.set("task-legacy", {
    id: "task-legacy", taskNumber: "HUB-98", title: "Legacy", description: "",
    bucket: "workspace", status: "open", workflowStatus: "awaiting_implementation",
    workspaceId: "workspace-1", streamId: "stream-2", boardOrder: 0, revision: 12,
    gitReferences: [],
  });
  historyRecordsByThread.set("thread-2", [{
    provider: "codex",
    threadId: "thread-2",
    turnId: "turn-legacy",
    title: "HUB-98 completion",
    prompt: "Finish HUB-98",
    body: `HUB-98 moved to Await. Exact result commit: ${reportedResultCommit}`,
    status: "completed",
  }]);

  const result = await service.call("hub_task_legacy_git_adopt", {
    context_token: token,
    request_id: "adopt-legacy-1",
    task_id: "task-legacy",
    expected_task_revision: 12,
    evidence_turn_id: "turn-legacy",
    reported_result_commit: reportedResultCommit,
    main_result_commit: mainResultCommit,
    confirm_adoption: true,
  });

  assert.equal(result.gitReferences[0].resultCommit, mainResultCommit);
  assert.equal(result.gitAdoption.projectRoot, targetWorkingDirectory);
  assert.equal(result.gitAdoption.patchId, "f".repeat(40));
  assert.equal(legacyAdoptionCalls[0].evidenceTurnId, "turn-legacy");

  await assert.rejects(() => service.call("hub_task_legacy_git_adopt", {
    context_token: service.contextToken({ provider: "codex", threadId: "thread-2" }),
    request_id: "adopt-legacy-non-releaseManager",
    task_id: "task-legacy",
    expected_task_revision: 13,
    evidence_turn_id: "turn-legacy",
    reported_result_commit: reportedResultCommit,
    main_result_commit: mainResultCommit,
    confirm_adoption: true,
  }), /requires a Release Manager Stream/u);
});

test("HubMcpService lists and changes Dashboard Tasks across Workspaces", async (context) => {
  const { service, token } = await fixture(context);
  assert.equal((await service.call("hub_context_get", { context_token: token })).workspaceId, "workspace-1");
  assert.deepEqual(
    (await service.call("hub_tasks_list", { context_token: token })).tasks.map((task) => task.id),
    ["task-current", "task-foreign"],
  );
  assert.equal(
    (await service.call("hub_task_get", { context_token: token, task_id: "task-foreign" })).id,
    "task-foreign",
  );
  const updated = await service.call("hub_task_update", {
    context_token: token,
    request_id: "foreign-task-update",
    task_id: "task-foreign",
    title: "Updated from another Workspace",
  });
  assert.equal(updated.title, "Updated from another Workspace");
});

test("HubMcpService validates checklist input and reconciles an exact lost acknowledgement", async (context) => {
  const {
    service, token, workspaceCatalog, operations, checklistCalls,
  } = await fixture(context);
  const originalComplete = workspaceCatalog.completeMcpOperation;
  let loseAcknowledgement = true;
  workspaceCatalog.completeMcpOperation = (requestId, result) => {
    if (requestId === "checklist-lost-ack" && loseAcknowledgement) {
      loseAcknowledgement = false;
      throw new Error("lost outer acknowledgement");
    }
    originalComplete(requestId, result);
  };
  const input = {
    context_token: token,
    request_id: "checklist-lost-ack",
    task_id: "task-current",
    expected_task_revision: 1,
    operation: "add",
    text: "Проверить миграцию",
  };

  await assert.rejects(() => service.call("hub_task_checklist_update", input), /lost outer acknowledgement/u);
  assert.equal(operations.get(input.request_id).status, "pending");
  const replay = await service.call("hub_task_checklist_update", input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.task.checklist[0].text, "Проверить миграцию");
  assert.equal(checklistCalls.length, 1);
  assert.equal(operations.get(input.request_id).status, "succeeded");

  await assert.rejects(() => service.call("hub_task_checklist_update", {
    ...input,
    request_id: "checklist-invalid-toggle",
    operation: "toggle",
    item_id: "item-1",
    text: undefined,
  }), /explicit boolean completed/u);
  assert.equal(checklistCalls.length, 1);
});

test("HubMcpService supports the first Stream turn before provider Thread assignment", async (context) => {
  const { service } = await fixture(context);
  const developerContext = service.developerContext({ provider: "claude", streamId: "stream-1" });
  const token = /Required MCP arguments: (\{.+\})/u.exec(developerContext)?.[1];
  const { context_token: contextToken } = JSON.parse(token);
  assert.match(developerContext, /pending first Thread/u);
  assert.match(developerContext, /Do not search environment variables/u);
  assert.equal((await service.call("hub_context_get", { context_token: contextToken })).streamId, "stream-1");
});

test("HubMcpService falls back to Stream context while a rotated Thread is not bound yet", async (context) => {
  const { service } = await fixture(context);
  const developerContext = service.developerContext({
    provider: "codex",
    threadId: "rotated-thread-not-bound-yet",
    streamId: "stream-1",
  });
  const token = /Required MCP arguments: (\{.+\})/u.exec(developerContext)?.[1];
  const { context_token: contextToken } = JSON.parse(token);

  assert.match(developerContext, /Workspace: Agent Hub \(workspace-1\)/u);
  assert.equal((await service.call("hub_context_get", { context_token: contextToken })).streamId, "stream-1");
});

test("HubMcpService starts the current Workspace task in the current Stream", async (context) => {
  const {
    service, token, operations, streamWorkingDirectory, taskGitPrepareCalls, taskLaunchCalls,
  } = await fixture(context);
  const task = await service.call("hub_task_start", {
    context_token: token, request_id: "start-task", task_id: "task-current", confirm_launch: true,
  });
  assert.equal(task.task.status, "started");
  assert.equal(task.task.workflowStatus, "in_progress");
  assert.equal(task.target.streamId, "stream-1");
  assert.equal(taskGitPrepareCalls[0].projectRoot, streamWorkingDirectory);
  assert.equal("workingDirectory" in taskLaunchCalls[0], false);
  assert.match(task.gitWorkspace.projectRoot, /task-worktree[\\/]task-current$/u);
  assert.equal(operations.get("start-task").status, "succeeded");
  assert.match(operations.get("start-task").interstreamContentHash, /^[a-f0-9]{64}$/u);
});

test("HubMcpService starts a Task from the target Stream working directory", async (context) => {
  const { service, token, targetWorkingDirectory, taskGitPrepareCalls } = await fixture(context);
  await service.call("hub_task_start", {
    context_token: token,
    request_id: "start-target-task",
    task_id: "task-current",
    stream_id: "stream-2",
    confirm_launch: true,
  });
  assert.equal(taskGitPrepareCalls[0].projectRoot, targetWorkingDirectory);
});

test("HubMcpService uses the Workspace working directory for a new Stream", async (context) => {
  const { service, token, workspaceWorkingDirectory, taskGitPrepareCalls, taskLaunchCalls } = await fixture(context);
  await service.call("hub_task_start", {
    context_token: token,
    request_id: "start-new-stream-task",
    task_id: "task-current",
    new_stream_name: "New Stream",
    confirm_launch: true,
  });
  assert.equal(taskGitPrepareCalls[0].projectRoot, workspaceWorkingDirectory);
  assert.deepEqual(taskLaunchCalls[0].settings, {
    provider: "codex", model: "gpt-5.6-sol", reasoning: "high",
  });
});

test("HubMcpService reports Stream availability from active turns and queued input", async (context) => {
  const { service, token } = await fixture(context);
  service.setDeferredInputs(() => [{
    id: "queued-1", provider: "codex", threadId: "thread-2",
    clientUserMessageId: "client-queued-1", state: "dispatching",
    conflictKind: "message-intake", dispatchingAt: "2026-09-03T15:29:50.062Z",
  }]);

  const result = await service.call("hub_parallel_streams_list", { context_token: token });
  const active = await service.call("hub_active_runs_list", { context_token: token });
  const current = result.streams.find((stream) => stream.id === "stream-1");
  const queued = result.streams.find((stream) => stream.id === "stream-2");
  assert.equal(current.activeRuns.length, 1);
  assert.equal(current.queuedInputCount, 0);
  assert.equal(current.available, false);
  assert.equal(queued.activeRuns.length, 0);
  assert.equal(queued.queuedInputCount, 1);
  assert.equal(queued.stalledDeferredInputCount, 1);
  assert.equal(queued.deferredInputs[0].state, "dispatching");
  assert.equal(queued.deferredInputs[0].clientUserMessageId, "client-queued-1");
  assert.equal(active.deferredInputs[0].stalled, true);
  assert.equal(queued.available, false);
});

test("HubMcpService reassigns a started Task and preserves assignment context", async (context) => {
  const { service, token, operations, tasks, taskLaunchCalls } = await fixture(context);
  Object.assign(tasks.get("task-current"), {
    status: "started", workflowStatus: "in_progress", streamId: "stream-1",
  });
  service.setActiveRuns(() => []);

  const result = await service.call("hub_task_reassign", {
    context_token: token,
    request_id: "reassign-task",
    task_id: "task-current",
    stream_id: "stream-2",
    message: "Пришли результат в Release Manager.",
    confirm_launch: true,
  });

  assert.equal(result.previousStreamId, "stream-1");
  assert.equal(result.task.streamId, "stream-2");
  assert.equal(taskLaunchCalls[0].reassign, true);
  assert.equal(taskLaunchCalls[0].message, "Пришли результат в Release Manager.");
  assert.equal(operations.get("reassign-task").status, "succeeded");
  assert.match(operations.get("reassign-task").interstreamContentHash, /^[a-f0-9]{64}$/u);
});

test("HubMcpService blocks reassignment while the current executor is busy", async (context) => {
  const { service, token, tasks, taskLaunchCalls } = await fixture(context);
  Object.assign(tasks.get("task-current"), {
    status: "started", workflowStatus: "in_progress", streamId: "stream-1",
  });

  await assert.rejects(() => service.call("hub_task_reassign", {
    context_token: token,
    request_id: "reassign-busy-task",
    task_id: "task-current",
    stream_id: "stream-2",
    confirm_launch: true,
  }), /active turn or queued input/u);
  assert.equal(taskLaunchCalls.length, 0);
});

test("HubMcpService blocks reassignment while the current executor has queued input", async (context) => {
  const { service, token, tasks, taskLaunchCalls } = await fixture(context);
  Object.assign(tasks.get("task-current"), {
    status: "started", workflowStatus: "in_progress", streamId: "stream-1",
  });
  service.setActiveRuns(() => []);
  service.setDeferredInputs(() => [{ id: "queued-current", streamId: "stream-1" }]);

  await assert.rejects(() => service.call("hub_task_reassign", {
    context_token: token,
    request_id: "reassign-queued-task",
    task_id: "task-current",
    stream_id: "stream-2",
    confirm_launch: true,
  }), /active turn or queued input/u);
  assert.equal(taskLaunchCalls.length, 0);
});

test("HubMcpService keeps workflow Done visible until explicit completion", async (context) => {
  const { service, token } = await fixture(context, { releaseWorkflowEnabled: true });
  const testing = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-testing",
    task_id: "task-current",
    status: "testing",
  });
  const done = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-done",
    task_id: "task-current",
    status: "done",
  });
  const completePreview = await service.call("hub_task_complete", {
    context_token: token,
    request_id: "task-complete",
    task_id: "task-current",
  });
  const completed = await service.call("hub_task_complete", {
    context_token: token,
    request_id: "task-complete-confirmed",
    task_id: "task-current",
    confirm_cleanup: true,
    expected_cleanup_token: completePreview.cleanupToken,
  });

  assert.equal(testing.workflowStatus, "testing");
  assert.equal(done.workflowStatus, "done");
  assert.notEqual(done.status, "done");
  assert.equal(completed.workflowStatus, "done");
  assert.equal(completed.status, "done");
});

test("release-enabled Task statuses accept only the Test-owned result", async (context) => {
  const { service, token, workspaceCatalog } = await fixture(context);
  workspaceCatalog.workspace = (id) => id === "workspace-1" ? {
    id, name: "Agent Hub", settings: { releaseWorkflowEnabled: true },
  } : null;

  const firstTesting = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-testing-before-await",
    task_id: "task-current",
    status: "testing",
  });
  const awaiting = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-awaiting-direct",
    task_id: "task-current",
    status: "awaiting_implementation",
  });
  const testing = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-awaiting-rollback",
    task_id: "task-current",
    status: "testing",
  });
  const done = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-done-direct",
    task_id: "task-current",
    status: "done",
  });

  assert.equal(firstTesting.workflowStatus, "testing");
  assert.equal(awaiting.workflowStatus, "awaiting_implementation");
  assert.equal(testing.workflowStatus, "testing");
  assert.equal(done.workflowStatus, "done");
});

test("Test status and old evidence remain unchanged when the Task branch conflicts with dev", async (context) => {
  const { service, token, tasks, taskGitWorkspaces, taskEvidenceCalls } = await fixture(context, { releaseWorkflowEnabled: true });
  taskGitWorkspaces.snapshotAndMerge = async ({ taskId }) => ({
    snapshot: {
      taskId,
      branch: `agenthub/task/${taskId}/repo`,
      projectRoot: "D:/task",
      repositoryRoot: "D:/repo",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      gitBaseline: { repoRoot: "D:/repo", tree: "a".repeat(40) },
      resultSnapshot: { repoRoot: "D:/repo", tree: "b".repeat(40) },
      changedFiles: [{ projectRoot: "D:/repo", path: "app.mjs", operation: "modified" }],
    },
    integration: {
      integrated: false,
      resultProved: false,
      outcome: "conflict",
      conflicts: ["app.mjs"],
      error: "merge conflict",
      dev: { branch: "dev", headCommit: "c".repeat(40) },
    },
  });

  await assert.rejects(() => service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-testing-conflict",
    task_id: "task-current",
    status: "testing",
  }), /merge conflict/u);

  assert.equal(tasks.get("task-current").workflowStatus, "new");
  assert.equal(taskEvidenceCalls.length, 0);
});

test("Test transition rejects an empty Task diff as no_result and preserves workflow state", async (context) => {
  const { service, token, tasks, taskGitWorkspaces } = await fixture(context, { releaseWorkflowEnabled: true });
  taskGitWorkspaces.snapshotAndMerge = async ({ taskId }) => ({
    snapshot: {
      taskId, branch: "HUB-empty", projectRoot: "D:/task", repositoryRoot: "D:/repo",
      baseCommit: "a".repeat(40), headCommit: "a".repeat(40), changedFiles: [],
    },
    integration: {
      integrated: false, alreadyIntegrated: true, resultProved: false,
      outcome: "no_result", error: "Task has no result relative to its immutable base",
    },
  });

  await assert.rejects(() => service.call("hub_task_status_update", {
    context_token: token, request_id: "empty-result", task_id: "task-current", status: "testing",
  }), /no result/u);
  assert.equal(tasks.get("task-current").workflowStatus, "new");
  assert.deepEqual(tasks.get("task-current").gitReferences ?? [], []);
});

test("Task status integration uses its executor Stream root without reassigning it", async (context) => {
  const {
    service, token, tasks, targetWorkingDirectory, taskGitPrepareCalls, taskGitWorkspaces, taskEvidenceCalls,
  } = await fixture(context, { releaseWorkflowEnabled: true });
  Object.assign(tasks.get("task-current"), { streamId: "stream-2", workflowStatus: "in_progress" });
  taskGitWorkspaces.snapshotAndMerge = async ({ taskId, projectRoot }) => ({
    snapshot: {
      taskId,
      branch: `agenthub/task/${taskId}/repo`,
      projectRoot,
      repositoryRoot: targetWorkingDirectory,
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      gitBaseline: { repoRoot: targetWorkingDirectory, tree: "a".repeat(40) },
      resultSnapshot: { repoRoot: targetWorkingDirectory, tree: "b".repeat(40) },
      changedFiles: [{ projectRoot: targetWorkingDirectory, path: "app.mjs", operation: "modified" }],
    },
    integration: {
      integrated: true,
      resultProved: true,
      outcome: "integrated",
      dev: { branch: "dev", headCommit: "b".repeat(40) },
    },
  });

  const result = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "task-testing-executor-root",
    task_id: "task-current",
    status: "testing",
  });

  assert.equal(taskGitPrepareCalls.at(-1).projectRoot, targetWorkingDirectory);
  assert.equal(tasks.get("task-current").streamId, "stream-2");
  assert.equal(result.gitIntegration.integrated, true);
  assert.equal(tasks.get("task-current").gitReferences[0].projectRoot, targetWorkingDirectory);
});

test("Task status integration resolves an executor root in another Workspace", async (context) => {
  const { service, token, tasks, foreignStreamWorkingDirectory, taskGitPrepareCalls } = await fixture(context, { releaseWorkflowEnabled: true });
  Object.assign(tasks.get("task-foreign"), {
    status: "started", workflowStatus: "in_progress", streamId: "stream-3",
  });

  const result = await service.call("hub_task_status_update", {
    context_token: token,
    request_id: "foreign-task-testing",
    task_id: "task-foreign",
    status: "testing",
  });

  assert.equal(taskGitPrepareCalls.at(-1).projectRoot, foreignStreamWorkingDirectory);
  assert.equal(result.workflowStatus, "testing");
  assert.equal(result.gitIntegration.integrated, true);
});

test("HubMcpService resumes an interrupted pending task start with the same request id", async (context) => {
  const { service, token, operations, tasks } = await fixture(context);
  let launches = 0;
  service.setTaskLauncher(async ({ id, workspaceId, streamId, launchRequestId }, launchContext) => {
    launches += 1;
    if (launches === 1) {
      Object.assign(tasks.get(id), { status: "starting", startRequestId: launchRequestId, streamId });
      throw new Error("interrupted before MCP receipt completion");
    }
    await launchContext.bindInterstreamAuditContent(createInterstreamMessage({
      ...launchContext.messageOrigin,
      text: "Task launch",
    }));
    return {
      task: { id, status: "started" },
      target: { streamId, provider: "codex", threadId: "thread-1", workspaceId },
    };
  });
  const input = {
    context_token: token,
    request_id: "interrupted-start",
    task_id: "task-current",
    confirm_launch: true,
  };

  await assert.rejects(() => service.call("hub_task_start", input), /interrupted before MCP receipt completion/u);
  assert.equal(operations.get("interrupted-start").status, "pending");

  const resumed = await service.call("hub_task_start", input);
  assert.equal(resumed.task.status, "started");
  assert.equal(launches, 2);
  assert.equal(operations.get("interrupted-start").status, "succeeded");
});

test("Task create validation stores a failed receipt without entering the Task owner and retries the same failure", async (context) => {
  const { service, token, taskBoard, workspaceCatalog, operations } = await fixture(context);
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-create-validation-"));
  const store = new TaskBoardStore({ databaseFile: path.join(directory, "tasks.sqlite") });
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const owner = new TaskBoardService({ store, workspaceCatalog });
  let calls = 0;
  taskBoard.create = (payload) => {
    calls += 1;
    return owner.create(payload);
  };
  const invalid = [
    { title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1), description: "", error: /Заголовок Task длиннее 160/u },
  ];
  for (const [index, { error, ...payload }] of invalid.entries()) {
    const input = { context_token: token, request_id: `invalid-create-${index}`, ...payload };
    await assert.rejects(service.call("hub_task_create", input), error);
    assert.equal(operations.get(input.request_id).status, "failed");
    assert.match(operations.get(input.request_id).error, error);
    await assert.rejects(service.call("hub_task_create", input), error);
    await assert.rejects(service.call("hub_task_create", { ...input, title: "Corrected" }), /already used for another operation/u);
  }
  assert.equal(calls, 0);
  assert.equal(store.list().length, 0);

  const input = {
    context_token: token, request_id: "valid-create-at-boundary", title: "Task",
    description: "Подробности 🚀\n".repeat(5_000).trim(),
  };
  const created = await service.call("hub_task_create", input);
  assert.equal(created.title, "Task");
  assert.equal(store.task(created.id).rawText, `${input.title}\n\n${input.description}`);
  assert.equal(store.list().length, 1);
  assert.equal(operations.get(input.request_id).status, "succeeded");
  assert.deepEqual(await service.call("hub_task_create", input), created);
  assert.equal(calls, 1);

  const createSchema = service.tools().find((tool) => tool.name === "hub_task_create").inputSchema.properties;
  const updateSchema = service.tools().find((tool) => tool.name === "hub_task_update").inputSchema.properties;
  for (const schema of [createSchema, updateSchema]) {
    assert.equal(schema.title.maxLength, TASK_TITLE_MAX_LENGTH);
    assert.equal(schema.description.maxLength, undefined);
  }
});

test("long Task descriptions survive MCP update, exact read, replay and SQLite reopen", async (context) => {
  const { service, token, workspaceCatalog } = await fixture(context);
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-long-description-"));
  const databaseFile = path.join(directory, "tasks.sqlite");
  let store = new TaskBoardStore({ databaseFile });
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  service.taskBoard = new TaskBoardService({ store, workspaceCatalog });
  const created = await service.call("hub_task_create", {
    context_token: token, request_id: "long-description-create", title: "Описание",
    description: "Исходный текст ".repeat(3_000),
  });
  const description = "Подробности 🚀\n".repeat(5_000).trim();
  const input = { context_token: token, request_id: "long-description-update",
    task_id: created.id, description };
  const updated = await service.call("hub_task_update", input);
  assert.equal(updated.description, description);
  assert.deepEqual(await service.call("hub_task_update", input), updated);
  store.close();
  store = new TaskBoardStore({ databaseFile });
  service.taskBoard = new TaskBoardService({ store, workspaceCatalog });
  const read = await service.call("hub_task_get", { context_token: token, task_id: created.id });
  assert.equal(read.description, description);
});

test("Task status and unknown-operation schemas expose the exact squash transfer identity", async (context) => {
  const { service } = await fixture(context);
  const status = service.tools().find((tool) => tool.name === "hub_task_status_update").inputSchema.properties;
  const reconcile = service.tools().find((tool) => tool.name === "hub_task_operation_reconcile").inputSchema.properties;
  for (const fields of [status, reconcile]) {
    assert.equal(fields.squash_source_task_revision.minimum, 1);
    assert.equal(fields.squash_baseline_result_commit.pattern, "^[0-9a-f]{40}$");
    assert.equal(fields.squash_new_result_commit.pattern, "^[0-9a-f]{40}$");
    assert.equal(fields.squash_dev_after_tree.pattern, "^[0-9a-f]{40}$");
    assert.equal(fields.squash_proof_request_id.type, "string");
    assert.equal(fields.expected_squash_transfer_hash.pattern, "^[0-9a-f]{64}$");
  }
});

test("public Await forwards a complete reviewed bundle only with exact RM CAS", async context => {
  const { service, token, tasks, operations } = await fixture(context, { releaseWorkflowEnabled: true });
  const calls = [];
  service.taskLifecycle.updateWorkflowStatus = async input => {
    calls.push(input); return { task: { ...tasks.get("task-current"), workflowStatus: input.status } };
  };
  const review = { bundlePath: "owned.bundle", bundleSha256: "a".repeat(64),
    reviews: [{ requestId: "first", text: "exact first receipt" }, { requestId: "second", text: "exact second receipt" }] };
  const input = { context_token: token, task_id: "task-current", status: "awaiting_implementation",
    expected_task_revision: 1, expected_workflow_status: "testing", native_resolution_review: review };
  assert.equal((await service.call("hub_task_status_update", { ...input, request_id: "all-prefixes" })).workflowStatus,
    "awaiting_implementation");
  assert.deepEqual(calls[0].operationEvidence, { nativeResolutionReview: review });
  const foreignToken = service.contextToken({ provider: "codex", threadId: "thread-2", streamId: "stream-2" });
  for (const [suffix, patch] of [["array", { native_resolution_review: [] }],
    ["extra", { native_resolution_review: { ...review, force: true } }],
    ["duplicate", { native_resolution_review: { ...review, reviews: [review.reviews[0], review.reviews[0]] } }],
    ["cas", { expected_task_revision: null }], ["test", { status: "testing" }],
    ["foreign", { context_token: foreignToken }]]) {
    await assert.rejects(service.call("hub_task_status_update", { ...input, ...patch, request_id: `bundle-${suffix}` }));
    assert.equal(operations.get(`bundle-${suffix}`).status, "failed");
  }
  assert.equal(calls.length, 1);
});

test("Release Manager cannot reopen fresh selected-materialization preview or confirmation after native cutover", async (context) => {
  const { service, token, tasks, operations } = await fixture(context, {
    releaseWorkflowEnabled: true,
  });
  const calls = [];
  service.taskLifecycle.selectedComposition = async (options) => {
    calls.push(options);
    return { task: tasks.get("task-current"), previewHash: "f".repeat(64) };
  };
  const common = {
    context_token: token,
    task_id: "task-current",
    status: "testing",
    expected_task_revision: 1,
    expected_workflow_status: "in_progress",
    selected_proof_bundle_path: "C:/review/proof.bundle",
    selected_proof_bundle_sha256: "a".repeat(64),
    selected_proof_commit: "b".repeat(40),
  };
  const before = structuredClone(tasks.get("task-current"));
  await assert.rejects(service.call("hub_task_status_update", { ...common, request_id: "selected-preview" }),
    { code: "TASK_NATIVE_GIT_REQUIRED" });
  await assert.rejects(service.call("hub_task_status_update", { ...common, request_id: "selected-confirm",
    selected_preview_request_id: "selected-preview",
    expected_selected_preview_hash: "f".repeat(64) }), { code: "TASK_NATIVE_GIT_REQUIRED" });
  assert.equal(calls.length, 0);
  assert.deepEqual(tasks.get("task-current"), before);
  assert.equal(operations.get("selected-preview").status, "failed");
  assert.equal(operations.get("selected-confirm").status, "failed");
});

test("Release Manager forwards one complete hash-confirmed squash transfer", async (context) => {
  const { service, token, streamWorkingDirectory, tasks } = await fixture(context, { releaseWorkflowEnabled: true });
  const calls = [];
  service.taskLifecycle.squashTransfer = async (options) => {
    calls.push(options);
    return {
      task: tasks.get("task-current"),
      sourceTask: tasks.get("task-foreign"),
      squashTransfer: { transferHash: "f".repeat(64) },
    };
  };
  const common = {
    context_token: token,
    task_id: "task-current",
    status: "testing",
    expected_task_revision: 1,
    squash_source_task_id: "task-foreign",
    squash_source_task_revision: 2,
    squash_baseline_result_commit: "a".repeat(40),
    squash_new_result_commit: "b".repeat(40),
    squash_dev_after_tree: "c".repeat(40),
  };
  await assert.rejects(service.call("hub_task_status_update", {
    ...common,
    request_id: "ordinary-cutover-only-confirm",
    squash_proof_request_id: "caller-selected-preview",
    expected_squash_cutover_hash: "e".repeat(64),
  }), /only by the one-shot cutover entrypoint/u);
  assert.equal(calls.length, 0);
  await service.call("hub_task_status_update", {
    ...common,
    request_id: "squash-confirm",
    squash_proof_request_id: "squash-preview",
    expected_squash_transfer_hash: "d".repeat(64),
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    taskId: "task-current",
    sourceTaskId: "task-foreign",
    operationId: "squash-confirm",
    expectedTaskRevision: 1,
    expectedSourceTaskRevision: 2,
    baselineResultCommit: "a".repeat(40),
    newResultCommit: "b".repeat(40),
    devAfterTree: "c".repeat(40),
    expectedTransferHash: "d".repeat(64),
    projectRoot: streamWorkingDirectory,
    authority: {
      workspaceId: "workspace-1", streamId: "stream-1", provider: "codex",
      threadId: "thread-1", proofRequestId: "squash-preview",
    },
  });
});

test("one-shot cutover forwards an in-progress squash bootstrap with immutable source evidence", async (context) => {
  const { service, token, streamWorkingDirectory } = await fixture(context, { releaseWorkflowEnabled: true });
  let received;
  const verifySource = async () => ({ sourceRoot: process.cwd() });
  service.taskLifecycle.squashTransferCutover = async (options) => {
    received = options;
    return { confirmationRequired: true, transferHash: "1".repeat(64), cutoverHash: "2".repeat(64) };
  };
  const input = {
    context_token: token, request_id: "bootstrap-preview", task_id: "task-current",
    status: "testing", expected_task_revision: 1, expected_workflow_status: "in_progress",
    cutover_source_commit: "b".repeat(40), cutover_projector_sha256: "c".repeat(64),
    squash_source_task_id: "task-foreign", squash_source_task_revision: 2,
    squash_baseline_result_commit: "a".repeat(40), squash_new_result_commit: "b".repeat(40),
    squash_dev_after_tree: "d".repeat(40), squash_cutover_source_tree: "e".repeat(40),
    squash_cutover_expected_main_commit: "f".repeat(40),
    squash_cutover_expected_dev_commit: "0".repeat(40),
    squash_cutover_expected_preserved_tree: "1".repeat(40),
    squash_cutover_source_zip_sha256: "2".repeat(64),
    squash_cutover_bundle_sha256: "3".repeat(64),
    squash_cutover_manifest_sha256: "4".repeat(64),
    squash_cutover_files_sha256: "5".repeat(64),
  };
  const result = await service.callTaskStatusCutover(input, { verifySource });
  assert.equal(result.cutoverHash, "2".repeat(64));
  assert.deepEqual(received, {
    taskId: "task-current", sourceTaskId: "task-foreign", operationId: "bootstrap-preview",
    expectedTaskRevision: 1, expectedSourceTaskRevision: 2,
    baselineResultCommit: "a".repeat(40), newResultCommit: "b".repeat(40),
    devAfterTree: "d".repeat(40), expectedTransferHash: null,
    projectRoot: streamWorkingDirectory,
    authority: { workspaceId: "workspace-1", streamId: "stream-1", provider: "codex",
      threadId: "thread-1", proofRequestId: "bootstrap-preview" },
    expectedCutoverHash: null, reviewedSourceTree: "e".repeat(40),
    expectedMainCommit: "f".repeat(40), expectedDevCommit: "0".repeat(40),
    expectedPreservedTree: "1".repeat(40), projectorSha256: "c".repeat(64),
    artifacts: { sourceZipSha256: "2".repeat(64), bundleSha256: "3".repeat(64),
      manifestSha256: "4".repeat(64), filesSha256: "5".repeat(64) },
    verifySource,
  });
  await assert.rejects(service.callTaskStatusCutover({
    ...input, request_id: "bootstrap-half-confirm", squash_proof_request_id: "bootstrap-preview",
    expected_squash_transfer_hash: "1".repeat(64),
  }, { verifySource }), /both exact hashes/u);
});

test("Release Manager confirms a squash preview in a new MCP request through the real lifecycle", async (context) => {
  const state = await fixture(context, { releaseWorkflowEnabled: true });
  const { service, token, streamWorkingDirectory, tasks, taskBoard, taskGitWorkspaces, operations } = state;
  const readStream = state.workspaceCatalog.stream;
  state.workspaceCatalog.stream = (id) => {
    const stream = readStream(id);
    return id === "stream-1"
      ? { ...stream, settings: { ...stream.settings, workingDirectory: streamWorkingDirectory } }
      : stream;
  };
  const source = {
    id: "task-foreign", title: "Source", description: "", bucket: "workspace",
    status: "started", workflowStatus: "testing", workspaceId: "workspace-1",
    streamId: "stream-1", revision: 4, releaseRevision: 3,
    gitReferences: [{ projectRoot: streamWorkingDirectory, branch: "HUB-224", resultCommit: "a".repeat(40) }],
  };
  const survivor = {
    id: "task-current", title: "Survivor", description: "", bucket: "workspace",
    status: "started", workflowStatus: "testing", workspaceId: "workspace-1",
    streamId: "stream-1", revision: 7, releaseRevision: 5,
    gitReferences: [{ projectRoot: streamWorkingDirectory, branch: "HUB-235", resultCommit: "b".repeat(40) }],
  };
  tasks.set(source.id, source);
  tasks.set(survivor.id, survivor);
  const proofFor = (authority) => normalizedTaskSquashTransfer({
    version: 1,
    kind: "task-squash-transfer-v1",
    survivor: {
      taskId: survivor.id, revision: survivor.revision, releaseRevision: survivor.releaseRevision,
      resultCommit: "c".repeat(40), baseCommit: "1".repeat(40), branch: "HUB-235",
    },
    source: {
      taskId: source.id, revision: source.revision, releaseRevision: source.releaseRevision,
      resultCommit: "a".repeat(40), baseCommit: "2".repeat(40), branch: "HUB-224",
    },
    projectRoot: streamWorkingDirectory,
    previousResultCommit: "b".repeat(40),
    baselineResultCommit: "3".repeat(40),
    devBeforeCommit: "4".repeat(40),
    devAfterTree: "5".repeat(40),
    sourceWitnesses: [{
      path: "source.mjs", source: { mode: "100644", object: "6".repeat(40) },
      survivor: { mode: "100644", object: "6".repeat(40) },
    }],
    ownerWitnesses: [{
      path: "new.mjs", baseline: null, beforeDev: null,
      newResult: { mode: "100644", object: "7".repeat(40) },
      afterDev: { mode: "100644", object: "7".repeat(40) },
    }],
    authority,
  });
  const lease = { signal: null, async assertOwned() {} };
  const lifecycleGit = {
    ...taskGitWorkspaces,
    withTaskLocks: async (_ids, operation) => operation(lease),
    previewSquashTransferOwned: async ({ authority }) => proofFor(authority),
    applySquashTransferOwned: async ({ authority }) => normalizedTaskSquashTransfer({
      ...proofFor(authority), integrationCommit: "8".repeat(40),
    }),
    readSquashTransferOwned: async (proof) => ({ status: "applied", proof }),
  };
  const beginLifecycleTransition = taskBoard.beginLifecycleTransition.bind(taskBoard);
  let transitionBegins = 0;
  taskBoard.beginLifecycleTransition = (...args) => {
    transitionBegins += 1;
    return beginLifecycleTransition(...args);
  };
  taskBoard.commitSquashTransferTransition = ({ operationId, squashTransfer }) => {
    assert.equal(operationId, "squash-confirm");
    Object.assign(survivor, {
      revision: survivor.revision + 1,
      releaseRevision: survivor.releaseRevision + 1,
      gitReferences: [{ projectRoot: streamWorkingDirectory, branch: "HUB-235", resultCommit: "c".repeat(40) }],
      squashTransfer,
    });
    Object.assign(source, { revision: source.revision + 1, workflowStatus: "in_progress", squashAbsorbedBy: squashTransfer });
    delete survivor.lifecycleOperation;
    return {
      task: structuredClone(survivor), sourceTask: structuredClone(source),
      squashTransfer, evidence: { squashTransfer },
    };
  };
  service.taskLifecycle = new TaskLifecycleService({
    taskBoard,
    workspaceCatalog: state.workspaceCatalog,
    taskGitWorkspaces: lifecycleGit,
    releasePreflight: { withAwaitTransition: async (_workspaceId, operation) => operation() },
  });
  const common = {
    context_token: token,
    task_id: survivor.id,
    status: "testing",
    expected_task_revision: survivor.revision,
    squash_source_task_id: source.id,
    squash_source_task_revision: source.revision,
    squash_baseline_result_commit: "3".repeat(40),
    squash_new_result_commit: "c".repeat(40),
    squash_dev_after_tree: "5".repeat(40),
  };
  const preview = await service.call("hub_task_status_update", {
    ...common, request_id: "squash-preview",
  });
  assert.equal(preview.confirmationRequired, true);
  assert.equal(preview.squashTransfer.authority.proofRequestId, "squash-preview");
  const rejected = [{
    request_id: "squash-confirm-wrong-hash",
    expected_squash_transfer_hash: "0".repeat(64),
    expectedError: /confirmation hash changed/u,
  }, {
    request_id: "squash-confirm-stale-revision",
    expected_task_revision: survivor.revision - 1,
    expected_squash_transfer_hash: preview.transferHash,
    expectedError: /revisions or Test status changed/u,
  }];
  for (const item of rejected) {
    const input = {
      ...common,
      request_id: item.request_id,
      squash_proof_request_id: "squash-preview",
      expected_squash_transfer_hash: item.expected_squash_transfer_hash,
      ...(item.expected_task_revision == null ? {} : { expected_task_revision: item.expected_task_revision }),
    };
    await assert.rejects(service.call("hub_task_status_update", input), item.expectedError);
    assert.equal(operations.get(item.request_id).status, "failed");
    await assert.rejects(service.call("hub_task_status_update", input), item.expectedError);
    assert.equal(operations.get(item.request_id).status, "failed");
  }
  source.workflowStatus = "in_progress";
  const staleState = {
    ...common,
    request_id: "squash-confirm-stale-state",
    squash_proof_request_id: "squash-preview",
    expected_squash_transfer_hash: preview.transferHash,
  };
  await assert.rejects(service.call("hub_task_status_update", staleState), /revisions or Test status changed/u);
  assert.equal(operations.get(staleState.request_id).status, "failed");
  await assert.rejects(service.call("hub_task_status_update", staleState), /revisions or Test status changed/u);
  assert.equal(operations.get(staleState.request_id).status, "failed");
  source.workflowStatus = "testing";
  assert.equal(transitionBegins, 0);
  const confirmed = await service.call("hub_task_status_update", {
    ...common,
    request_id: "squash-confirm",
    squash_proof_request_id: "squash-preview",
    expected_squash_transfer_hash: preview.transferHash,
  });
  assert.equal(confirmed.squashTransfer.transferHash, preview.transferHash);
  assert.equal(confirmed.squashTransfer.authority.proofRequestId, "squash-preview");
  assert.equal(operations.get("squash-preview").status, "succeeded");
  assert.equal(operations.get("squash-confirm").status, "succeeded");
  assert.equal(transitionBegins, 1);
});

test("Task update field rejection is failed while an effectful create validation-looking error stays unknown", async (context) => {
  const { service, token, taskBoard, tasks, operations } = await fixture(context);
  const original = structuredClone(tasks.get("task-current"));
  const invalidUpdate = {
    context_token: token, request_id: "invalid-update-title", task_id: original.id,
    title: "x".repeat(TASK_TITLE_MAX_LENGTH + 1),
  };
  await assert.rejects(service.call("hub_task_update", invalidUpdate), /Заголовок Task длиннее 160/u);
  assert.equal(operations.get(invalidUpdate.request_id).status, "failed");
  assert.deepEqual(tasks.get(original.id), original);

  const create = taskBoard.create;
  let effects = 0;
  taskBoard.create = (payload) => {
    create(payload);
    effects += 1;
    throw new Error("Описание Task длиннее 20000 символов");
  };
  const input = { context_token: token, request_id: "effectful-create-error", title: "Created before failure" };
  await assert.rejects(service.call("hub_task_create", input), /Описание Task длиннее 20000/u);
  assert.equal(operations.get(input.request_id).status, "unknown");
  assert.equal(tasks.get("created").title, input.title);
  await assert.rejects(service.call("hub_task_create", input), /outcome is unknown/u);
  assert.equal(effects, 1);
});

test("HubMcpService keeps ownership across global columns and deletes its task", async (context) => {
  const { service, token } = await fixture(context);
  const created = await service.call("hub_task_create", {
    context_token: token, request_id: "task-create", title: "Owned task",
  });
  const notes = await service.call("hub_task_move", {
    context_token: token, request_id: "task-notes", task_id: created.id, destination: "notes",
  });
  const backlog = await service.call("hub_task_move", {
    context_token: token, request_id: "task-backlog", task_id: created.id, destination: "backlog",
  });
  const preview = await service.call("hub_task_delete", {
    context_token: token, request_id: "task-delete", task_id: created.id,
  });
  const deleted = await service.call("hub_task_delete", {
    context_token: token, request_id: "task-delete-confirmed", task_id: created.id,
    confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken,
  });

  assert.equal(notes.bucket, "notes");
  assert.equal(backlog.bucket, "backlog");
  assert.equal(deleted.deleted, true);
  await assert.rejects(
    () => service.call("hub_task_get", { context_token: token, task_id: created.id }),
    /task not found/u,
  );
});

test("confirmed Delete preserves the Task row when Git cleanup fails", async (context) => {
  const { service, token, tasks, taskGitWorkspaces } = await fixture(context);
  taskGitWorkspaces.cleanup = async () => { throw new Error("worktree removal failed"); };
  const preview = await service.call("hub_task_delete", {
    context_token: token, request_id: "delete-preview-failure", task_id: "task-current",
  });
  await assert.rejects(() => service.call("hub_task_delete", {
    context_token: token, request_id: "delete-confirm-failure", task_id: "task-current",
    confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken,
  }), /worktree removal failed/u);
  assert.equal(tasks.get("task-current").id, "task-current");
});

test("SQLite contention retry yields to timers and preserves the original request identity", async (context) => {
  const { service, token, workspaceCatalog, operations } = await fixture(context);
  const begin = workspaceCatalog.beginMcpOperation;
  let attempts = 0;
  workspaceCatalog.beginMcpOperation = (operation) => {
    attempts += 1;
    if (attempts < 4) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
    return begin(operation);
  };
  let timerObserved = false;
  setTimeout(() => { timerObserved = true; }, 0);

  const result = await service.call("hub_task_update", {
    context_token: token, request_id: "busy-retry", task_id: "task-current", title: "Retried",
  });

  assert.equal(result.title, "Retried");
  assert.equal(attempts, 4);
  assert.equal(timerObserved, true);
  assert.equal(operations.size, 1);
  assert.equal(operations.get("busy-retry").status, "succeeded");
  assert.equal(service.databaseContentionDiagnostics().retries, 3);
  assert.ok(service.databaseContentionDiagnostics().lastWaitMs >= 20);
});

test("HubMcpService sends attributed messages to another current-Workspace Stream", async (context) => {
  const { service, token, sentMessages } = await fixture(context);
  const result = await service.call("hub_stream_message_send", {
    context_token: token,
    request_id: "message-themes-1",
    stream_id: "stream-2",
    text: "Finish the theme.",
    mode: "queue",
    confirm_send: true,
  });
  assert.equal(result.target.streamName, "Themes");
  assert.equal(result.delivery.queued, true);
  assert.equal(sentMessages[0].params.streamId, "stream-2");
  assert.match(sentMessages[0].params.text, /"workspaceName":"Agent Hub"/u);
  assert.match(sentMessages[0].params.text, /"streamName":"MCP"/u);
  assert.match(sentMessages[0].params.text, /"provider":"codex"/u);
  assert.match(sentMessages[0].params.text, /"model":"Sol"/u);
  assert.match(sentMessages[0].params.text, /Finish the theme\.$/u);
  assert.deepEqual(sentMessages[0].context.messageOrigin, {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent Hub",
    streamId: "stream-1",
    streamName: "MCP",
    provider: "codex",
    model: "Sol",
    sourceThreadId: "thread-1",
    requestId: "message-themes-1",
  });
  assert.equal(result.source.provider, "codex");
  assert.equal(result.source.model, "Sol");
});

test("HubMcpService exposes cursor events and one durable release operation owner", async (context) => {
  const calls = [];
  const snapshots = new Map();
  const releaseOperations = {
    start: (input) => {
      calls.push(["start", input]);
      const operationId = "release-operation-1";
      snapshots.set(operationId, { operation: { operationId, workspaceId: input.workspaceId, state: "compose", revision: 1 } });
      return { accepted: true, created: true, operationId, state: "compose", revision: 1 };
    },
    get: (operationId) => snapshots.get(operationId),
    continue: (operationId) => {
      calls.push(["continue", operationId]);
      return { accepted: true, operationId, state: "publish", revision: 2 };
    },
    setEventDelivery() {},
  };
  const { service, token } = await fixture(context, { releaseOperations });
  const events = await service.call("hub_events_list", { context_token: token, after_sequence: 4 });
  assert.equal(events.events[0].sequence, 5);
  assert.equal(events.nextSequence, 5);
  const ack = await service.call("hub_release_run", {
    context_token: token,
    request_id: "release-1",
    task_ids: ["task-current"],
    validation_mode: "full",
    approved_targets: [{ targetId: "production", kind: "agent-hub-publication", repositoryRoot: "D:/repo" }],
  });
  assert.equal(ack.operationId, "release-operation-1");
  assert.equal(calls[0][1].authorization.validationMode, "full");
  assert.equal(Object.hasOwn(calls[0][1].authorization, "releaseMetadata"), false);
  const snapshot = await service.call("hub_release_get", {
    context_token: token, operation_id: ack.operationId,
  });
  assert.equal(snapshot.operation.state, "compose");
  const continued = await service.call("hub_release_continue", {
    context_token: token, request_id: "release-continue-1", operation_id: ack.operationId,
  });
  assert.equal(continued.state, "publish");
  assert.deepEqual(calls[1], ["continue", ack.operationId]);
  const tools = service.tools().map((tool) => tool.name);
  assert.equal(tools.includes("hub_release_preflight"), false);
  assert.equal(tools.includes("hub_release_complete"), false);
});

test("HubMcpService forwards original-addressed reviewed-main recovery through the same authenticated continuation", async context => {
  const calls = [];
  const { service, token } = await fixture(context, { releaseOperations: {
    get: operationId => ({ operation: { operationId, workspaceId: "workspace-1", state: "failed", revision: 699 } }),
    continue: async (...args) => { calls.push(args); return { accepted: true, operationId: args[0] }; },
    setEventDelivery() {},
  } });
  const reviewedMain = { expectedRevision: 699, approvedRepositories: [{ projectRoot: "D:/repo",
    approvedLocalMainCommit: "a".repeat(40), approvedOriginMainCommit: "a".repeat(40) }] };
  const input = { context_token: token, request_id: "original-main-rebind", operation_id: "original", reviewed_main: reviewedMain };
  assert.equal((await service.call("hub_release_continue", input)).accepted, true);
  assert.deepEqual(calls.map(([id, options]) => [id,
    Object.fromEntries(Object.entries(options).filter(([, value]) => value !== undefined)),
  ]), [["original", { requestId: input.request_id, reviewedMain }]]);
});

test("HubMcpService carries exact release metadata through the domain and byte-checking composition owner", async (context) => {
  let admitted;
  const { service, token, projectRoot } = await fixture(context, { releaseOperations: {
    start: (input) => {
      admitted = createReleaseOperation({ ...input, operationId: input.requestId,
        runnerVersion: "test", createdAt: "2026-10-18T00:00:00.000Z" });
      return { accepted: true, operationId: admitted.operationId };
    },
    get() {}, continue() {}, setEventDelivery() {},
  } });
  const bytes = Buffer.from("release notes\r\n", "utf8");
  const sourcePath = path.join(projectRoot, "CHANGELOG.md");
  await writeFile(sourcePath, bytes);
  const releaseMetadata = {
    sourcePath, byteLength: bytes.length,
    rawSha256: createHash("sha256").update(bytes).digest("hex"),
    canonicalSha256: createHash("sha256").update("release notes\n").digest("hex"),
  };
  const args = {
    context_token: token, request_id: "release-metadata", task_ids: ["task-current"],
    validation_mode: "full", approved_targets: [{ targetId: "production", kind: "agent-hub-publication" }],
    release_metadata: releaseMetadata,
  };
  const schema = service.tools().find((item) => item.name === "hub_release_run").inputSchema;
  await service.call("hub_release_run", args);
  assert.deepEqual(admitted.authorization.releaseMetadata, releaseMetadata);
  assert.deepEqual(schema.properties.release_metadata.required,
    ["sourcePath", "byteLength", "rawSha256", "canonicalSha256"]);
  assert.equal(schema.required.includes("release_metadata"), false);
  assert.equal(admitted.streamId, "stream-1");
  assert.equal(admitted.threadId, "thread-1");
  let preparations = 0;
  const adapter = new WorkspaceReleaseOperationAdapter({
    releasePreflight: {
      prepareOperationGeneration: async ({ changelogContent }) => {
        preparations += 1;
        assert.deepEqual(changelogContent, bytes);
        return { releaseCandidates: [], planRevision: "plan" };
      },
      validateOperationGeneration() {}, operationSelection() {}, withAwaitTransition() {},
    },
    publication: { publish: () => assert.fail("composition cannot publish"), readback() {} },
    finalization: { finalize: () => assert.fail("composition cannot finalize") },
  });
  await adapter.compose({ operation: admitted, generation: 1 });
  await writeFile(sourcePath, Buffer.from("RELEASE notes\r\n")); // same length, different digest
  await assert.rejects(adapter.compose({ operation: admitted, generation: 2 }), /metadata artifact identity changed/u);
  assert.equal(preparations, 1);
  await assert.rejects(service.call("hub_release_run", {
    ...args, request_id: "release-malformed-metadata",
    release_metadata: { ...releaseMetadata, rawSha256: "invalid" },
  }), /release metadata digest is invalid/u);
});

test("HubMcpService restricts release execution to Release Manager Streams", async (context) => {
  const { service, token, workspaceCatalog } = await fixture(context, { releaseOperations: {
    start: () => assert.fail("unauthorized caller must not start"), get() {}, continue() {}, setEventDelivery() {},
  } });
  const hierarchy = workspaceCatalog.hierarchy;
  workspaceCatalog.hierarchy = () => hierarchy().map((workspace) => ({
    ...workspace,
    streams: workspace.streams.map((stream) => ({
      ...stream,
      settings: { ...stream.settings, releaseManager: false },
    })),
  }));
  await assert.rejects(() => service.call("hub_release_run", {
    context_token: token,
    request_id: "release-forbidden",
    task_ids: ["task-current"], validation_mode: "full",
    approved_targets: [{ targetId: "production", kind: "agent-hub-publication" }],
  }), /requires a Release Manager Stream|release execution requires/u);
});

test("Release Manager reconciliation forwards one exact unknown operation and requires confirmation", async (context) => {
  const calls = [];
  const omittedNativeArguments = { initialNativeTest: undefined, nativeResolutionReview: undefined,
    selectedBundlePath: undefined, selectedBundleSha256: undefined, selectedPublishedResolution: undefined,
    selectedAbsorptionHandoff: undefined, selectedProofCommit: undefined, selectedPreviewRequestId: undefined,
    expectedSelectedPreviewHash: undefined };
  const { service, token } = await fixture(context, {
    taskOperationReconciliation: {
      reconcileUnknownWorkflow: async (value) => {
        calls.push(value);
        return { resolved: true, outcome: "succeeded" };
      },
    },
  });
  const args = {
    context_token: token,
    request_id: "reconcile-command-1",
    task_id: "task-current",
    operation_request_id: "original-status-request",
    project_root: "D:/VSC_Tyrael/Utilities",
    guard_id: "guard-1",
    proof_kind: "system-restart-after-guard",
    proof_summary: "Windows boot postdates the exact guard",
    confirm_reconcile: true,
  };
  assert.deepEqual(await service.call("hub_task_operation_reconcile", args), {
    resolved: true, outcome: "succeeded",
  });
  assert.deepEqual(calls, [{
    ...omittedNativeArguments,
    workspaceId: "workspace-1",
    taskId: "task-current",
    operationRequestId: "original-status-request",
    projectRoot: "D:/VSC_Tyrael/Utilities",
    guardId: "guard-1",
    proofKind: "system-restart-after-guard",
    proofSummary: "Windows boot postdates the exact guard",
    expectedTaskRevision: undefined,
    expectedWorkflowStatus: undefined,
    cutoverSourceCommit: undefined,
    cutoverProjectorSha256: undefined,
    cutoverSourceTaskId: undefined,
    cutoverSourceTaskRevision: undefined,
    confirmed: true,
  }]);
  const schema = service.tools().find((tool) => tool.name === "hub_task_operation_reconcile").inputSchema;
  assert.deepEqual(schema.required, [
    "context_token", "request_id", "task_id", "operation_request_id", "confirm_reconcile",
  ]);
  const terminalArgs = { ...args, request_id: "reconcile-command-terminal" };
  delete terminalArgs.guard_id;
  delete terminalArgs.proof_kind;
  delete terminalArgs.proof_summary;
  terminalArgs.expected_task_revision = 19;
  terminalArgs.expected_workflow_status = "testing";
  terminalArgs.cutover_source_commit = "a".repeat(40);
  terminalArgs.cutover_projector_sha256 = "b".repeat(64);
  assert.deepEqual(await service.call("hub_task_operation_reconcile", terminalArgs), {
    resolved: true, outcome: "succeeded",
  });
  assert.deepEqual(calls[1], {
    ...omittedNativeArguments,
    workspaceId: "workspace-1",
    taskId: "task-current",
    operationRequestId: "original-status-request",
    projectRoot: "D:/VSC_Tyrael/Utilities",
    guardId: undefined,
    proofKind: undefined,
    proofSummary: undefined,
    expectedTaskRevision: 19,
    expectedWorkflowStatus: "testing",
    cutoverSourceCommit: "a".repeat(40),
    cutoverProjectorSha256: "b".repeat(64),
    cutoverSourceTaskId: undefined,
    cutoverSourceTaskRevision: undefined,
    confirmed: true,
  });
  const ordinaryCasArgs = {
    ...args,
    request_id: "reconcile-command-ordinary-cas",
    expected_task_revision: 2,
    expected_workflow_status: "in_progress",
  };
  delete ordinaryCasArgs.guard_id;
  delete ordinaryCasArgs.proof_kind;
  delete ordinaryCasArgs.proof_summary;
  assert.deepEqual(await service.call("hub_task_operation_reconcile", ordinaryCasArgs), {
    resolved: true, outcome: "succeeded",
  });
  assert.deepEqual(calls[2], {
    ...omittedNativeArguments,
    workspaceId: "workspace-1",
    taskId: "task-current",
    operationRequestId: "original-status-request",
    projectRoot: "D:/VSC_Tyrael/Utilities",
    guardId: undefined,
    proofKind: undefined,
    proofSummary: undefined,
    expectedTaskRevision: 2,
    expectedWorkflowStatus: "in_progress",
    cutoverSourceCommit: undefined,
    cutoverProjectorSha256: undefined,
    cutoverSourceTaskId: undefined,
    cutoverSourceTaskRevision: undefined,
    confirmed: true,
  });
  await assert.rejects(service.call("hub_task_operation_reconcile", {
    ...args, request_id: "reconcile-command-unconfirmed", confirm_reconcile: false,
  }), /requires explicit confirmation/u);
  await assert.rejects(service.call("hub_task_operation_reconcile", {
    ...args,
    context_token: service.contextToken({ provider: "codex", threadId: "thread-2" }),
    request_id: "reconcile-command-non-releaseManager",
  }), /requires a Release Manager Stream/u);
  assert.equal(calls.length, 3);
});

test("HubMcpService binds the current turn to its dedicated Task worktree", async (context) => {
  const { service, token, tasks, streamWorkingDirectory, taskGitPrepareCalls, taskClaimCalls } = await fixture(context);
  const claimed = await service.call("hub_task_claim", {
    context_token: token,
    request_id: "claim-task-1",
    task_id: "task-current",
  });
  assert.equal(claimed.claimedTurnId, "turn-live");
  assert.equal(taskGitPrepareCalls[0].projectRoot, streamWorkingDirectory);
  assert.deepEqual(tasks.get("task-current").gitBaseline, {
    repoRoot: streamWorkingDirectory,
    tree: "a".repeat(40),
  });
  assert.match(claimed.gitWorkspace.branch, /^agenthub\/task\/task-current/u);
  assert.deepEqual(taskClaimCalls[0], {
    id: "task-current",
    turnId: "turn-live",
    operationId: "claim-task-1",
    operationKind: "claim",
  });

  const tools = service.tools();
  assert.equal(tools.some((tool) => tool.name === "hub_task_release_freeze"), false);
  assert.equal(tools.some((tool) => tool.name === "hub_release_run"), true);
  assert.equal(tools.some((tool) => tool.name === "hub_release_preflight"), false);
});

test("hub_task_claim defaults to skipping dependencies and forwards explicit ensure or verify", async (context) => {
  const { service, token, activeRun, taskGitPrepareCalls, taskClaimCalls, operations } = await fixture(context);
  for (const [index, mode] of [undefined, "ensure", "verify"].entries()) {
    const requestId = `claim-dependencies-${index}`;
    const result = await service.call("hub_task_claim", {
      context_token: token,
      request_id: requestId,
      task_id: "task-current",
      ...(mode ? { dependency_mode: mode } : {}),
    });
    assert.equal(result.claimedTurnId, activeRun.turnId);
    assert.equal(taskGitPrepareCalls.at(-1).dependencyMode, mode ?? "skip");
    assert.equal(taskClaimCalls.at(-1).operationId, requestId);
    assert.equal(operations.get(requestId).status, "succeeded");
  }
  assert.equal(taskGitPrepareCalls.length, 3);
  assert.equal(taskClaimCalls.length, 3);
});

test("claim forwards an explicit user dependency exception and complete forwards its absorption contract", async (t) => {
  const { service, token, taskGitPrepareCalls } = await fixture(t);
  const reason = "User requested consolidation before prerequisite release";
  await service.call("hub_task_claim", { context_token: token, request_id: "override-wait",
    task_id: "task-current", dependency_override_reason: reason });
  assert.equal(taskGitPrepareCalls.at(-1).dependencyOverrideReason, reason);
  let received;
  service.taskLifecycle.complete = async (args) => {
    received = args;
    return { confirmationRequired: true, task: { id: "task-current" }, cleanupToken: "preview" };
  };
  const result = await service.call("hub_task_complete", { context_token: token, request_id: "absorb-preview",
    task_id: "task-current", absorbed_into_task_id: "task-survivor",
    absorption_mode: "published_duplicate" });
  assert.equal(received.absorbedIntoTaskId, "task-survivor");
  assert.equal(received.absorptionMode, "published_duplicate");
  assert.equal(result.cleanupToken, "preview");
  const schema = service.tools().find((tool) => tool.name === "hub_task_complete").inputSchema;
  assert.deepEqual(schema.properties.absorption_mode.enum, ["published_duplicate"]);
  assert.deepEqual(schema.properties.completion_mode.enum, ["published_release_service", "published_delivery", "operational"]);
  await service.call("hub_task_complete", { context_token: token,
    request_id: "release-service-preview", task_id: "task-current",
    completion_mode: "published_release_service" });
  assert.equal(received.completionMode, "published_release_service");
  const otherToken = service.contextToken({ provider: "codex", threadId: "thread-2" });
  await assert.rejects(service.call("hub_task_complete", {
    context_token: otherToken,
    request_id: "absorb-published-non-manager",
    task_id: "task-current",
    absorbed_into_task_id: "task-survivor",
    absorption_mode: "published_duplicate",
  }), /requires a Release Manager Stream/u);
  await assert.rejects(service.call("hub_task_complete", {
    context_token: otherToken, request_id: "release-service-non-manager",
    task_id: "task-current", completion_mode: "published_release_service",
  }), /requires a Release Manager Stream/u);
});

test("HubMcpService describes exact steering and an explicit fallback decision", async (context) => {
  const { service } = await fixture(context);
  const mode = service.tools()
    .find((tool) => tool.name === "hub_stream_message_send")
    .inputSchema.properties.mode;

  assert.match(mode.description, /exact steering of the current managed run/u);
  assert.match(mode.description, /explicit retry or queue decision/u);
  assert.doesNotMatch(mode.description, /queue if steering is no longer possible/u);
});

test("HubMcpService claims the active turn while an older terminal remains retained", async (context) => {
  const { service, token, activeRun, taskClaimCalls } = await fixture(context);
  service.setActiveRuns(() => [
    { ...activeRun, id: "old-run", turnId: "old-turn", status: "completed" },
    activeRun,
    { ...activeRun, id: "observer", turnId: "external-turn", observer: true },
  ]);
  const claimed = await service.call("hub_task_claim", {
    context_token: token, request_id: "claim-after-terminal", task_id: "task-current",
  });
  assert.equal(claimed.claimedTurnId, activeRun.turnId);
  assert.equal(taskClaimCalls.length, 1);
});

test("HubMcpService keeps genuinely ambiguous active turns blocked without Task effects", async (context) => {
  const { service, token, activeRun, taskClaimCalls, taskGitPrepareCalls } = await fixture(context);
  service.setActiveRuns(() => [activeRun, { ...activeRun, id: "second", turnId: "second-turn" }]);
  await assert.rejects(service.call("hub_task_claim", {
    context_token: token, request_id: "claim-ambiguous", task_id: "task-current",
  }), /ambiguous active runs/u);
  assert.equal(taskClaimCalls.length, 0);
  assert.equal(taskGitPrepareCalls.length, 0);
});

test("HubMcpService claim keeps an unproven process-tree guard before every Task effect", {
  skip: process.platform !== "win32" ? "Windows taskkill contract" : false,
}, async (context) => {
  let guarded;
  const state = await fixture(context, {
    beforeRemoveDirectory: () => guarded?.close(),
    taskGitWorkspacesFactory: async ({ directory, streamWorkingDirectory }) => {
      await initializeTaskGitRepository(streamWorkingDirectory);
      guarded = await unprovenProcessTaskGit({
        context,
        root: streamWorkingDirectory,
        dataDir: path.join(directory, "git-data"),
        taskId: "task-current",
      });
      return guarded.service;
    },
  });
  await assert.rejects(() => state.service.call("hub_task_claim", {
    context_token: state.token,
    request_id: "claim-unproven-first",
    task_id: "task-current",
  }), /process tree stop is unproven/u);
  assert.equal(guarded.guardSeen(), true);
  await assert.rejects(() => state.service.call("hub_task_claim", {
    context_token: state.token,
    request_id: "claim-unproven-replacement",
    task_id: "task-current",
  }), /unresolved process-tree guard requires operator proof/u);
  assert.equal(state.taskClaimCalls.length, 0);
  assert.equal(state.tasks.get("task-current").status, "open");
  assert.equal(await guarded.waitForStaleMutation(), "stale mutation attempted");
  await guarded.proveAndRecover();
  const claimed = await state.service.call("hub_task_claim", {
    context_token: state.token,
    request_id: "claim-after-operator-proof",
    task_id: "task-current",
  });
  assert.equal(claimed.claimedTurnId, "turn-live");
  assert.equal(state.taskClaimCalls.length, 1);
});

test("HubMcpService terminally records a repository-guard admission failure before claim effects", async (context) => {
  let guardPath;
  const state = await fixture(context, {
    taskGitWorkspacesFactory: async ({ directory, streamWorkingDirectory }) => {
      await initializeTaskGitRepository(streamWorkingDirectory);
      const dataDir = path.join(directory, "current-guard-data");
      const foreignTaskId = "51515151-5151-4151-8151-515151515151";
      guardPath = path.join(
        dataDir,
        "task-process-tree-guards",
        foreignTaskId,
        `${taskRepositoryKey(streamWorkingDirectory)}.json`,
      );
      await mkdir(path.dirname(guardPath), { recursive: true });
      await writeFile(guardPath, `${JSON.stringify({
        version: 1, repositoryRoot: canonicalPath(streamWorkingDirectory),
      })}\n`, "utf8");
      return new TaskGitWorkspaceService({ dataDir });
    },
  });
  const input = {
    context_token: state.token,
    request_id: "claim-current-guard-no-effect",
    task_id: "task-current",
  };
  await assert.rejects(state.service.call("hub_task_claim", input), /unresolved process-tree guard/u);
  assert.equal(state.operations.get(input.request_id).status, "failed");
  assert.equal(state.taskClaimCalls.length, 0);
  assert.equal(state.tasks.get("task-current").status, "open");
  assert.equal(await access(guardPath).then(() => true, () => false), true);
  await assert.rejects(state.service.call("hub_task_claim", input), /unresolved process-tree guard/u);
  assert.equal(state.taskClaimCalls.length, 0);
});

test("HubMcpService settles an exact legacy unknown guard claim without replaying Git", async (context) => {
  let prepareCalls = 0;
  let legacyVerifier;
  let legacyMessage;
  const state = await fixture(context, {
    taskGitWorkspacesFactory: async ({ directory, streamWorkingDirectory }) => {
      await initializeTaskGitRepository(streamWorkingDirectory);
      const dataDir = path.join(directory, "legacy-guard-data");
      legacyVerifier = new TaskGitWorkspaceService({ dataDir });
      const foreignTaskId = "61616161-6161-4161-8161-616161616161";
      const guardPath = path.join(
        dataDir,
        "task-process-tree-guards",
        foreignTaskId,
        `${taskRepositoryKey(streamWorkingDirectory)}.json`,
      );
      legacyMessage = `Task Git repository blocked: unresolved process-tree guard requires operator proof (${guardPath})`;
      return claimOnlyTaskGit({
        prepare: async () => {
          prepareCalls += 1;
          throw new Error(legacyMessage);
        },
        claimAdmissionNoEffectEvidence: (params) => legacyVerifier.claimAdmissionNoEffectEvidence(params),
      });
    },
  });
  const input = {
    context_token: state.token,
    request_id: "claim-legacy-guard-unknown",
    task_id: "task-current",
  };
  await assert.rejects(state.service.call("hub_task_claim", input), /unresolved process-tree guard/u);
  assert.equal(state.operations.get(input.request_id).status, "unknown");
  assert.equal(prepareCalls, 1);

  await assert.rejects(state.service.call("hub_task_claim", input), /mutation effect is not authoritatively disproved/u);
  assert.equal(state.operations.get(input.request_id).status, "failed");
  assert.equal(
    state.operations.get(input.request_id).result.operatorReconciliation.kind,
    "task-claim-admission-failed-before-effects",
  );
  assert.equal(prepareCalls, 1);
  assert.equal(state.taskClaimCalls.length, 0);
  await assert.rejects(state.service.call("hub_task_claim", input), /mutation effect is not authoritatively disproved/u);
  assert.equal(prepareCalls, 1);
  await assert.rejects(state.service.call("hub_task_claim", {
    ...input, task_id: "task-foreign",
  }), /request_id was already used/u);
});

test("HubMcpService preserves unknown when a legacy claim has any durable Task binding", async (context) => {
  let prepareCalls = 0;
  const state = await fixture(context, {
    taskGitWorkspacesFactory: async () => claimOnlyTaskGit({
      prepare: async () => {
        prepareCalls += 1;
        throw new Error("Task Git repository blocked: unresolved process-tree guard requires operator proof (C:\\guard.json)");
      },
      claimAdmissionNoEffectEvidence: async ({ error }) => (
        error instanceof Error ? null : { version: "unexpected-if-bound" }
      ),
    }),
  });
  const input = {
    context_token: state.token,
    request_id: "claim-legacy-bound-unknown",
    task_id: "task-current",
  };
  await assert.rejects(state.service.call("hub_task_claim", input), /unresolved process-tree guard/u);
  state.taskClaimBindings.set(input.request_id, { taskId: input.task_id, operationId: input.request_id });
  await assert.rejects(state.service.call("hub_task_claim", input), /outcome is unknown/u);
  assert.equal(state.operations.get(input.request_id).status, "unknown");
  assert.equal(prepareCalls, 1);
});

test("HubMcpService never reclassifies or replays a claim after its Task binding effect", async (context) => {
  const state = await fixture(context);
  const completeOperation = state.workspaceCatalog.completeMcpOperation;
  const input = {
    context_token: state.token,
    request_id: "claim-binding-before-receipt-failure",
    task_id: "task-current",
  };
  state.workspaceCatalog.completeMcpOperation = (requestId, result) => {
    if (requestId === input.request_id) throw new Error("claim receipt write failed after binding");
    return completeOperation(requestId, result);
  };

  await assert.rejects(state.service.call("hub_task_claim", input), /receipt reconciliation is required/u);
  assert.equal(state.operations.get(input.request_id).status, "unknown");
  assert.equal(state.taskClaimCalls.length, 1);
  assert.equal(state.taskGitPrepareCalls.length, 1);
  assert.equal(state.taskClaimBindings.get(input.request_id).taskId, input.task_id);
  await assert.rejects(state.service.call("hub_task_claim", input), /outcome is unknown/u);
  assert.equal(state.taskClaimCalls.length, 1);
  assert.equal(state.taskGitPrepareCalls.length, 1);
});

test("HubMcpService claim falls back to the Workspace working directory", async (context) => {
  const { service, token, workspaceCatalog, workspaceWorkingDirectory, taskGitPrepareCalls } = await fixture(context);
  const hierarchy = workspaceCatalog.hierarchy;
  workspaceCatalog.hierarchy = () => hierarchy().map((workspace) => ({
    ...workspace,
    streams: workspace.streams.map((stream) => stream.id === "stream-1"
      ? { ...stream, settings: { ...stream.settings, workingDirectory: "" } }
      : stream),
  }));

  await service.call("hub_task_claim", {
    context_token: token,
    request_id: "claim-workspace-root",
    task_id: "task-current",
  });
  assert.equal(taskGitPrepareCalls[0].projectRoot, workspaceWorkingDirectory);
});

test("HubMcpService rejects forged context capabilities", async (context) => {
  const { service, token } = await fixture(context);
  await assert.rejects(
    () => service.call("hub_context_get", { context_token: `${token}x` }),
    /invalid Agent Hub context capability/u,
  );
});

test("HubMcpService recovers a registered capability when the model damages only its payload", async (context) => {
  const { service, token } = await fixture(context);
  const separator = token.lastIndexOf(".");
  const payload = token.slice(0, separator);
  const signature = token.slice(separator + 1);
  const damagedToken = `${payload.slice(0, 40)}${payload.slice(43)}.${signature}`;

  const resolved = await service.call("hub_context_get", { context_token: damagedToken });

  assert.equal(resolved.workspaceId, "workspace-1");
  assert.equal(resolved.streamId, "stream-1");
  assert.equal(resolved.threadId, "thread-1");
});

test("HubMcpService explains how to recover from an empty context capability", async (context) => {
  const { service } = await fixture(context);
  await assert.rejects(
    () => service.call("hub_context_get", { context_token: "" }),
    /copy the exact value from the current <agent_hub_context>.*do not search environment variables/u,
  );
});

test("HubMcpService exposes bounded activity, history and effective rules", async (context) => {
  const { service, token } = await fixture(context);
  const active = await service.call("hub_active_runs_list", { context_token: token });
  const history = await service.call("hub_stream_history", { context_token: token });
  const rules = await service.call("hub_rules_get", { context_token: token });
  assert.equal(active.runs[0].streamId, "stream-1");
  assert.equal(history.state, "active");
  assert.equal(history.turns.some((turn) => turn.active === true), true);
  assert.match(history.turns.find((turn) => turn.turnId === "turn-1").prompt, /Initial prompt/u);
  assert.equal(rules.stream.content, "Stream rule");
});

test("HubMcpService performs standard reads and writes across Workspace boundaries", async (context) => {
  const {
    service, token, sentMessages, taskLaunchCalls, preflightCalls, releaseCalls,
    releasePlanWorkspaceIds, operations,
  } = await fixture(context);
  service.setActiveRuns(() => [{
    id: "run-foreign", provider: "codex", streamId: "stream-3", threadId: "thread-3",
    turnId: "turn-foreign-active", status: "running", progressStage: "Foreign active",
    startedAt: "2026-09-01T13:00:00.000Z",
  }]);

  const workspace = await service.call("hub_workspace_get", {
    context_token: token, workspace_id: "workspace-2",
  });
  const streams = await service.call("hub_parallel_streams_list", {
    context_token: token, workspace_id: "workspace-2",
  });
  const active = await service.call("hub_active_runs_list", {
    context_token: token, workspace_id: "workspace-2",
  });
  const history = await service.call("hub_stream_history", {
    context_token: token, workspace_id: "workspace-2", stream_id: "stream-3",
  });
  const rules = await service.call("hub_rules_get", {
    context_token: token, stream_id: "stream-3",
  });
  assert.equal(workspace.id, "workspace-2");
  assert.equal(workspace.currentStreamId, null);
  assert.deepEqual(streams.streams.map((stream) => stream.id), ["stream-3"]);
  assert.equal(active.runs[0].streamId, "stream-3");
  assert.equal(history.workspaceId, "workspace-2");
  assert.equal(history.turns[0].turnId, "turn-foreign-active");
  assert.equal(rules.stream.content, "Foreign Stream rule");

  const workspaceRules = await service.call("hub_workspace_rules_update", {
    context_token: token, request_id: "foreign-workspace-rules", workspace_id: "workspace-2",
    content: "Updated foreign Workspace rules",
  });
  const streamRules = await service.call("hub_stream_rules_update", {
    context_token: token, request_id: "foreign-stream-rules", stream_id: "stream-3",
    content: "Updated foreign Stream rules",
  });
  const created = await service.call("hub_task_create", {
    context_token: token, request_id: "foreign-task-create", workspace_id: "workspace-2",
    title: "Foreign task",
  });
  const moved = await service.call("hub_task_move", {
    context_token: token, request_id: "foreign-task-move", task_id: "task-current",
    destination: "workspace", workspace_id: "workspace-2",
  });
  const started = await service.call("hub_task_start", {
    context_token: token, request_id: "foreign-task-start", task_id: "task-foreign",
    workspace_id: "workspace-2", stream_id: "stream-3", confirm_launch: true,
  });
  const sent = await service.call("hub_stream_message_send", {
    context_token: token, request_id: "foreign-message", stream_id: "stream-3",
    text: "Cross Workspace message", mode: "steer", confirm_send: true,
  });
  const plan = await service.call("hub_release_plan_get", {
    context_token: token, workspace_id: "workspace-2",
  });
  const events = await service.call("hub_events_list", {
    context_token: token, workspace_id: "workspace-2", after_sequence: 2,
  });

  assert.equal(workspaceRules.workspaceId, "workspace-2");
  assert.equal(streamRules.streamId, "stream-3");
  assert.equal(created.workspaceId, "workspace-2");
  assert.equal(moved.workspaceId, "workspace-2");
  assert.equal(started.target.streamId, "stream-3");
  assert.equal(taskLaunchCalls.at(-1).workspaceId, "workspace-2");
  assert.equal(sent.target.workspaceId, "workspace-2");
  assert.equal(sentMessages.at(-1).params.streamId, "stream-3");
  assert.equal(plan.workspaceId, "workspace-2");
  assert.equal(releasePlanWorkspaceIds.at(-1), "workspace-2");
  assert.equal(events.workspaceId, "workspace-2");
  assert.equal(operations.get("foreign-workspace-rules").workspaceId, "workspace-1");
  assert.equal(operations.get("foreign-workspace-rules").streamId, "stream-1");

  await assert.rejects(() => service.call("hub_stream_history", {
    context_token: token, workspace_id: "workspace-1", stream_id: "stream-3",
  }), /outside the selected Workspace/u);
  await assert.rejects(() => service.call("hub_task_start", {
    context_token: token, request_id: "mismatched-target", task_id: "task-foreign",
    workspace_id: "workspace-1", stream_id: "stream-3", confirm_launch: true,
  }), /outside the selected Workspace/u);
});

test("release plan reads each dev ref once without preparing shared worktrees", async (context) => {
  const calls = [];
  const { service, token } = await fixture(context, {
    taskGitWorkspacesFactory: async () => claimOnlyTaskGit({
      readDev: async (projectRoot) => {
        calls.push(projectRoot);
        return { repositoryRoot: projectRoot, projectRoot: null, branch: "dev", headCommit: "a".repeat(40) };
      },
      prepareDev: async () => { throw new Error("read command attempted dev preparation"); },
    }),
  });
  service.releasePlanner.plan = async () => ({ ready: [
    { projectRoot: "D:/repo" }, { projectRoot: "D:/repo" },
  ] });
  const plan = await service.call("hub_release_plan_get", { context_token: token });
  assert.deepEqual(calls, ["D:/repo"]);
  assert.deepEqual(plan.devIntegration.repositories, [{
    projectRoot: "D:/repo", branch: "dev", headCommit: "a".repeat(40), worktreeRoot: null,
  }]);
});

test("hub_stream_history projects active content and deterministic lifecycle states", async (context) => {
  const { service, token, historyRecordsByThread } = await fixture(context);
  const visibleActivity = {
    id: "tool-1", type: "tool", label: "Используется инструмент",
    detail: "agent_hub/hub_task_get", status: "running", time: "2026-09-01T13:00:01.000Z",
  };
  const messageOrigin = {
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-release-manager",
    streamName: "Release Manager",
    provider: "codex",
    requestId: "foreign-live-1",
  };
  const firstRun = {
    id: "run-foreign-1", provider: "codex", streamId: "stream-3", threadId: "thread-3",
    turnId: "turn-foreign-1", status: "running", taskTitle: "Foreign live",
    promptPreview: createInterstreamMessage({
      ...messageOrigin,
      text: "Inspect foreign state",
    }),
    messageOrigin,
    clientUserMessageId: "mcp:foreign-live-1",
    progressStage: "Reading",
    progressReasoning: "Hub-visible progress summary", responseText: "Visible partial answer",
    activities: [visibleActivity, { ...visibleActivity, id: "tool-2", detail: "second" }],
    hiddenChainOfThought: "must never be exposed",
    startedAt: "2026-09-01T13:00:00.000Z",
  };
  service.setActiveRuns(() => [firstRun]);

  const first = await service.call("hub_stream_history", {
    context_token: token,
    workspace_id: "workspace-2",
    stream_id: "stream-3",
    limit: 2,
    include_body: true,
    max_activity_items: 1,
  });
  assert.equal(first.state, "active");
  assert.equal(first.activeRunCount, 1);
  assert.equal(first.turns[0].status, "active");
  assert.equal(first.turns[0].active, true);
  assert.equal(first.turns[0].prompt, "Inspect foreign state");
  assert.equal(first.turns[0].progress, "Hub-visible progress summary");
  assert.equal(first.turns[0].body, "Visible partial answer");
  assert.equal(first.turns[0].activities.length, 1);
  assert.equal(JSON.stringify(first).includes("must never be exposed"), false);
  assert.match(first.cursor, /^[A-Za-z0-9_-]+$/u);
  assert.match(first.revision, /^[a-f0-9]{64}$/u);

  const repeated = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor,
    limit: 2, include_body: true, max_activity_items: 1,
  });
  assert.equal(repeated.state, "active");
  assert.equal(repeated.cursor, first.cursor);
  assert.equal(repeated.revision, first.revision);

  firstRun.activityUnknown = true;
  const unknown = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor,
  });
  assert.equal(unknown.state, "unknown");
  assert.equal(unknown.turns[0].active, false);
  assert.equal(unknown.turns[0].status, "unknown");
  assert.equal(unknown.turns[0].canStop, true);
  firstRun.activityUnknown = false;

  historyRecordsByThread.set("thread-3", [{
    provider: "codex", threadId: "thread-3", turnId: "turn-foreign-1",
    title: "Persisted too early", prompt: "Inspect foreign state", body: "Persisted partial",
    status: "completed", completedAt: "2026-09-01T13:00:02.000Z",
  }]);
  const deduplicated = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor, limit: 5,
  });
  assert.equal(deduplicated.turns.filter((turn) => turn.turnId === "turn-foreign-1").length, 1);
  assert.equal(deduplicated.turns[0].active, false);

  const replacementRun = {
    ...firstRun,
    id: "run-foreign-2",
    turnId: "turn-foreign-2",
    promptPreview: "Replacement turn",
    responseText: "Replacement partial",
    startedAt: "2026-09-01T13:05:00.000Z",
  };
  service.setActiveRuns(() => [replacementRun]);
  const replaced = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor, limit: 2,
  });
  assert.equal(replaced.state, "replaced");
  assert.notEqual(replaced.cursor, first.cursor);
  assert.equal(replaced.turns[0].turnId, "turn-foreign-2");

  historyRecordsByThread.set("thread-3", [{
    provider: "codex", threadId: "thread-3", turnId: "turn-foreign-2",
    title: "Replacement turn", prompt: "Replacement turn", body: "Replacement final",
    status: "completed", completedAt: "2026-09-01T13:06:00.000Z",
  }]);
  service.setActiveRuns(() => []);
  const terminal = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: replaced.cursor, limit: 2,
  });
  assert.equal(terminal.state, "terminal");
  assert.equal(terminal.turns[0].turnId, "turn-foreign-2");
  assert.equal(terminal.turns[0].status, "completed");
  assert.equal(terminal.turns[0].active, false);

  const preTurnRun = {
    ...firstRun,
    id: "run-before-turn-id",
    turnId: null,
  };
  historyRecordsByThread.set("thread-3", []);
  service.setActiveRuns(() => [preTurnRun]);
  const beforeTurnId = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3",
  });
  historyRecordsByThread.set("thread-3", [incomingLedgerRecord({
    provider: "codex", threadId: "thread-3", turnId: "turn-assigned-at-terminal",
    runId: "run-before-turn-id", title: "Pre-turn", prompt: "Pre-turn", body: "Final",
    status: "completed", completedAt: "2026-09-01T13:07:00.000Z",
  })]);
  service.setActiveRuns(() => []);
  const terminalAfterPreTurn = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: beforeTurnId.cursor,
  });
  assert.equal(terminalAfterPreTurn.state, "terminal");
  assert.equal(terminalAfterPreTurn.turns[0].turnId, "turn-assigned-at-terminal");
  assert.equal(terminalAfterPreTurn.turns[0].runId, "run-before-turn-id");

  historyRecordsByThread.set("thread-3", []);
  const unknownCursor = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", cursor: first.cursor,
  });
  const idle = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", limit: 1,
  });
  await assert.rejects(() => service.call("hub_stream_history", {
    context_token: token, stream_id: "missing-stream", limit: 1,
  }), /Stream not found/u);
  assert.equal(unknownCursor.state, "not_found");
  assert.equal(idle.state, "idle");

  const schema = service.tools().find((tool) => tool.name === "hub_stream_history").inputSchema.properties;
  assert.equal("wait" in schema, false);
  assert.equal("timeout" in schema, false);
  assert.equal(service.tools().some((tool) => tool.name === "hub_stream_turn_snapshot"), false);
});

test("hub_stream_history merge-sorts active and terminal turns before applying limit", async (context) => {
  const { service, token, historyRecordsByThread } = await fixture(context);
  historyRecordsByThread.set("thread-3", [{
    provider: "codex", threadId: "thread-3", turnId: "turn-terminal-new",
    title: "Newest terminal", status: "completed", completedAt: "2026-09-01T13:06:00.000Z",
  }, {
    provider: "codex", threadId: "thread-3", turnId: "turn-terminal-old",
    title: "Older terminal", status: "completed", completedAt: "2026-09-01T13:04:00.000Z",
  }]);
  service.setActiveRuns(() => [{
    id: "run-b", provider: "codex", streamId: "stream-3", threadId: "thread-3",
    turnId: "turn-b", status: "running", startedAt: "2026-09-01T13:05:00.000Z",
  }, {
    id: "run-a", provider: "codex", streamId: "stream-3", threadId: "thread-3",
    turnId: "turn-a", status: "running", startedAt: "2026-09-01T13:05:00.000Z",
  }]);

  const result = await service.call("hub_stream_history", {
    context_token: token, stream_id: "stream-3", limit: 3,
  });

  assert.deepEqual(result.turns.map((turn) => turn.turnId), [
    "turn-terminal-new", "turn-a", "turn-b",
  ]);
  assert.equal(result.truncated, true);
  const cursor = JSON.parse(Buffer.from(result.cursor, "base64url").toString("utf8"));
  assert.equal(cursor.turnId, "turn-a");
});

test("HubMcpService replays successful mutations by request id", async (context) => {
  const { service, token, operations } = await fixture(context);
  const input = { context_token: token, request_id: "rules-1", content: "Updated" };
  const first = await service.call("hub_stream_rules_update", input);
  const second = await service.call("hub_stream_rules_update", input);
  assert.deepEqual(second, first);
  assert.equal(operations.get("rules-1").status, "succeeded");
});

test("HubMcpService coalesces concurrent mutations with the same request identity", async (context) => {
  const { service, token, operations } = await fixture(context);
  let effects = 0;
  let releaseEffect;
  const effectGate = new Promise((resolve) => { releaseEffect = resolve; });
  service.setStreamMessenger(async () => {
    effects += 1;
    await effectGate;
    return { accepted: false, queued: true, id: "queued-concurrent" };
  });
  const input = {
    context_token: token,
    request_id: "message-concurrent-1",
    stream_id: "stream-2",
    text: "One durable effect.",
    mode: "queue",
    confirm_send: true,
  };

  const first = service.call("hub_stream_message_send", input);
  const second = service.call("hub_stream_message_send", input);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(effects, 1);
  releaseEffect();

  assert.deepEqual(await second, await first);
  assert.equal(effects, 1);
  assert.equal(operations.get("message-concurrent-1").status, "succeeded");
});

test("receipt failure after a completed effect becomes unknown and cannot replay the effect", async (context) => {
  const { service, token, workspaceCatalog, operations } = await fixture(context);
  let effects = 0;
  service.setStreamMessenger(async () => {
    effects += 1;
    return { accepted: false, queued: true, id: "queued-before-receipt-crash" };
  });
  workspaceCatalog.completeMcpOperation = () => {
    throw new Error("simulated durable receipt failure after effect");
  };
  const input = {
    context_token: token,
    request_id: "message-effect-receipt-crash",
    stream_id: "stream-2",
    text: "Do not replay me.",
    mode: "queue",
    confirm_send: true,
  };

  await assert.rejects(
    service.call("hub_stream_message_send", input),
    /effect completed.*receipt reconciliation is required/u,
  );
  assert.equal(effects, 1);
  assert.equal(operations.get("message-effect-receipt-crash").status, "unknown");
  await assert.rejects(
    service.call("hub_stream_message_send", input),
    /outcome is unknown.*reconcile authoritatively/u,
  );
  assert.equal(effects, 1);
});

test("mutation throw after a possible partial effect is terminal unknown", async (context) => {
  const { service, token, taskBoard, tasks, operations } = await fixture(context);
  let effects = 0;
  taskBoard.update = ({ id, title }) => {
    effects += 1;
    tasks.get(id).title = title;
    throw new Error("crash after task row effect");
  };
  const input = {
    context_token: token,
    request_id: "task-update-partial-effect",
    task_id: "task-current",
    title: "Possibly committed",
  };
  await assert.rejects(service.call("hub_task_update", input), /crash after task row effect/u);
  assert.equal(effects, 1);
  assert.equal(operations.get(input.request_id).status, "unknown");
  await assert.rejects(service.call("hub_task_update", input), /outcome is unknown/u);
  assert.equal(effects, 1);
});

test("startup receipt reconciliation terminalizes incomplete durable lifecycle receipts", async (context) => {
  const { service, workspaceCatalog, tasks, operations } = await fixture(context);
  operations.set("orphan-pending", {
    requestId: "orphan-pending", toolName: "hub_task_update", status: "pending",
  });
  operations.set("workflow-pending", {
    requestId: "workflow-pending", toolName: "hub_task_status_update", status: "pending",
  });
  tasks.get("task-current").lifecycleOperation = {
    operationId: "workflow-pending", kind: "workflow", targetWorkflowStatus: "testing",
  };
  workspaceCatalog.pendingMcpOperations = () => [...operations.values()].filter((item) => item.status === "pending");

  await service.reconcilePendingMcpOperations();

  assert.equal(operations.get("orphan-pending").status, "unknown");
  assert.equal(operations.get("workflow-pending").status, "unknown");
});

test("startup receipt reconciliation preserves a durable workflow rollback as failure", async (context) => {
  const { service, workspaceCatalog, taskBoard, operations } = await fixture(context);
  operations.set("workflow-rolled-back", {
    requestId: "workflow-rolled-back", toolName: "hub_task_status_update", status: "pending",
  });
  taskBoard.lifecycleOutcome = () => ({
    operationId: "workflow-rolled-back",
    kind: "workflow",
    result: {
      rollback: { completed: true, reason: "Await rebuild failed" },
    },
  });
  workspaceCatalog.pendingMcpOperations = () => [...operations.values()].filter((item) => item.status === "pending");

  await service.reconcilePendingMcpOperations();

  assert.equal(operations.get("workflow-rolled-back").status, "failed");
  assert.match(operations.get("workflow-rolled-back").error, /Await rebuild failed/u);
});

test("SQLite Task attachments survive exact read, list, replay and store reopen", async (context) => {
  const { service, token, projectRoot, workspaceCatalog, attachmentDirectory } = await fixture(context);
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-task-attachment-sqlite-"));
  const databaseFile = path.join(directory, "tasks.sqlite");
  let store = new TaskBoardStore({ databaseFile });
  context.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const task = store.create({ text: "Attachment owner", bucket: "workspace", workspaceId: "workspace-1" });
  const other = store.create({ text: "Other Task", bucket: "workspace", workspaceId: "workspace-1" });
  service.taskBoard = new TaskBoardService({ store, workspaceCatalog });
  const source = path.join(projectRoot, "evidence.md");
  const body = "Точное содержимое вложения 🦊";
  await writeFile(source, body, "utf8");
  const input = { context_token: token, request_id: "sqlite-attachment-add", task_id: task.id, local_path: source };
  const added = await service.call("hub_task_attachment_add", input);
  assert.deepEqual(store.task(task.id).sourceDetails.attachments, [path.join(attachmentDirectory, added.attachment.id)]);
  assert.equal(added.task.attachments[0].id, added.attachment.id);
  assert.deepEqual(await service.call("hub_task_attachment_add", input), added);
  assert.deepEqual(await readdir(attachmentDirectory), [added.attachment.id]);
  store.close();
  store = new TaskBoardStore({ databaseFile });
  service.taskBoard = new TaskBoardService({ store, workspaceCatalog });
  const read = await service.call("hub_task_get", { context_token: token, task_id: task.id });
  const snapshot = service.taskBoard.snapshot().find((candidate) => candidate.id === task.id);
  assert.deepEqual(read.attachments, snapshot.attachments);
  assert.equal(read.attachments[0].id, added.attachment.id);
  assert.equal(JSON.stringify(read).includes(attachmentDirectory), false);
  const attachment = await service.call("hub_task_attachment_read", {
    context_token: token, task_id: task.id, attachment_id: added.attachment.id,
  });
  assert.equal(attachment.text, body);
  await assert.rejects(service.call("hub_task_attachment_read", {
    context_token: token, task_id: other.id, attachment_id: added.attachment.id,
  }), /outside the selected task/u);
});

test("attachment failure after committed linkage preserves bytes and forbids replay", async (context) => {
  const { service, token, taskBoard, projectRoot, attachmentDirectory, operations } = await fixture(context);
  const source = path.join(projectRoot, "evidence.txt");
  await writeFile(source, "committed attachment", "utf8");
  const add = taskBoard.addAttachment;
  taskBoard.addAttachment = (payload) => {
    add(payload);
    throw new Error("readback failed after attachment commit");
  };
  const input = { context_token: token, request_id: "attachment-post-commit", task_id: "task-current", local_path: source };
  await assert.rejects(service.call("hub_task_attachment_add", input), /readback failed/u);
  const files = await readdir(attachmentDirectory);
  assert.equal(files.length, 1);
  const read = await service.call("hub_task_attachment_read", { context_token: token, task_id: "task-current", attachment_id: files[0] });
  assert.equal(read.text, "committed attachment");
  assert.equal(operations.get(input.request_id).status, "unknown");
  await assert.rejects(service.call("hub_task_attachment_add", input), /outcome is unknown/u);
  assert.deepEqual(await readdir(attachmentDirectory), files);
});

test("attachment add cannot report success without persisted membership", async (context) => {
  const { service, token, taskBoard, projectRoot, operations } = await fixture(context);
  const source = path.join(projectRoot, "evidence.txt");
  await writeFile(source, "unconfirmed attachment", "utf8");
  taskBoard.addAttachment = () => {};
  const input = { context_token: token, request_id: "attachment-missing-link", task_id: "task-current", local_path: source };
  await assert.rejects(service.call("hub_task_attachment_add", input), /persistence was not confirmed/u);
  assert.equal(operations.get(input.request_id).status, "unknown");
});

test("HubMcpService copies project files into task attachments", async (context) => {
  const { service, token, projectRoot } = await fixture(context);
  const source = path.join(path.dirname(projectRoot), "outside.txt");
  await writeFile(source, "outside", "utf8");
  await assert.rejects(
    () => service.call("hub_task_attachment_add", {
      context_token: token, request_id: "outside-file", task_id: "task-current", local_path: source,
    }),
    /outside the current project/u,
  );

  const projectFile = path.join(projectRoot, "evidence.txt");
  await writeFile(projectFile, "evidence", "utf8");
  const added = await service.call("hub_task_attachment_add", {
    context_token: token, request_id: "project-file", task_id: "task-current", local_path: projectFile,
  });
  const read = await service.call("hub_task_attachment_read", {
    context_token: token, task_id: "task-current", attachment_id: added.attachment.id,
  });
  assert.equal(read.text, "evidence");
  assert.equal(read.name, "evidence.txt");
});

test("HubMcpService reads attachments of an exact Task reference after it leaves the Workspace", async (context) => {
  const { service, token, projectRoot, tasks } = await fixture(context);
  const projectFile = path.join(projectRoot, "foreign-evidence.txt");
  await writeFile(projectFile, "foreign evidence", "utf8");
  const added = await service.call("hub_task_attachment_add", {
    context_token: token,
    request_id: "foreign-attachment-add",
    task_id: "task-current",
    local_path: projectFile,
  });
  tasks.get("task-current").workspaceId = "workspace-2";

  const read = await service.call("hub_task_attachment_read", {
    context_token: token,
    task_id: "task-current",
    attachment_id: added.attachment.id,
  });

  assert.equal(read.text, "foreign evidence");
});

test("HubMcpService rejects attachment paths that escape through a link", async (context) => {
  const { service, token, attachmentDirectory, projectRoot } = await fixture(context);
  const outsideDirectory = path.join(path.dirname(projectRoot), "outside-link-target");
  const linkedDirectory = path.join(projectRoot, "linked-outside");
  await mkdir(outsideDirectory);
  await writeFile(path.join(outsideDirectory, "secret.txt"), "secret", "utf8");
  try {
    await symlink(outsideDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) {
      context.skip("creating a filesystem link is not permitted on this host");
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => service.call("hub_task_attachment_add", {
      context_token: token,
      request_id: "linked-outside-file",
      task_id: "task-current",
      local_path: path.join(linkedDirectory, "secret.txt"),
    }),
    /outside the current project|symlink|reparse/iu,
  );
  assert.deepEqual(await readdir(attachmentDirectory), []);
  assert.deepEqual(
    (await service.call("hub_task_get", { context_token: token, task_id: "task-current" })).attachments,
    [],
  );
});

test("HubMcpService rejects linked attachment paths that stay inside the project", async (context) => {
  const { service, token, projectRoot } = await fixture(context);
  const sourceDirectory = path.join(projectRoot, "source-directory");
  const linkedDirectory = path.join(projectRoot, "linked-inside");
  await mkdir(sourceDirectory);
  await writeFile(path.join(sourceDirectory, "evidence.txt"), "evidence", "utf8");
  try {
    await symlink(sourceDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EACCES", "EPERM"].includes(error.code)) {
      context.skip("creating a filesystem link is not permitted on this host");
      return;
    }
    throw error;
  }

  await assert.rejects(
    () => service.call("hub_task_attachment_add", {
      context_token: token,
      request_id: "linked-inside-file",
      task_id: "task-current",
      local_path: path.join(linkedDirectory, "evidence.txt"),
    }),
    /symlink|reparse/iu,
  );
});

test("HubMcpService rejects non-file attachment sources", async (context) => {
  const { service, token, projectRoot } = await fixture(context);
  const sourceDirectory = path.join(projectRoot, "not-a-file");
  await mkdir(sourceDirectory);

  await assert.rejects(
    () => service.call("hub_task_attachment_add", {
      context_token: token,
      request_id: "directory-source",
      task_id: "task-current",
      local_path: sourceDirectory,
    }),
    /regular file/u,
  );
});

test("HubMcpService exposes unconfirmed managed ownership as unknown and keeps the Stream reserved", async context => {
  const { service, token } = await fixture(context);
  service.setActiveRuns(() => [{ id: "uncertain", provider: "codex", threadId: "thread-1", status: "running", activityUnknown: true }]);
  const active = await service.call("hub_active_runs_list", { context_token: token });
  assert.equal(active.runs[0].status, "unknown");
  assert.equal(active.runs[0].activityUnknown, true);
  const streams = await service.call("hub_parallel_streams_list", { context_token: token });
  assert.equal(streams.streams.find(s => s.id === "stream-1").available, false);
});

test("HubMcpService forwards amended release notes with the same original selection/CAS and durable receipt", async context => {
  const calls = [];
  const { service, token } = await fixture(context, { releaseOperations: {
    get: operationId => ({ operation: { operationId, workspaceId: "workspace-1", state: "waiting", revision: 699 } }),
    continue: async (...args) => { calls.push(args); return { accepted: true, operationId: args[0] }; },
    setEventDelivery() {},
  } });
  const metadata = { sourcePath: "new-consolidated-notes.md", byteLength: 42, rawSha256: "a".repeat(64), canonicalSha256: "b".repeat(64) };
  const input = { context_token: token, request_id: "same-original-new-notes", operation_id: "original",
    expected_revision: 699, expected_generation: 14, test_selection: { mode: "none", ids: [] },
    task_ids: ["task-current"], release_metadata: metadata };
  const schema = service.tools().find(item => item.name === "hub_release_continue").inputSchema;
  assert.deepEqual(schema.properties.release_metadata.required, ["sourcePath", "byteLength", "rawSha256", "canonicalSha256"]);
  assert.equal((await service.call("hub_release_continue", input)).accepted, true);
  assert.equal((await service.call("hub_release_continue", input)).accepted, true);
  assert.equal(calls.length, 1, "same original MCP receipt does not schedule another continuation");
  assert.equal(calls[0][0], "original");
  assert.deepEqual(calls[0][1].releaseMetadata, metadata);
  assert.deepEqual(calls[0][1].testSelection, input.test_selection);
  assert.deepEqual(calls[0][1].taskIds, input.task_ids);
  assert.equal(calls[0][1].expectedRevision, 699);
  assert.equal(calls[0][1].expectedGeneration, 14);
});
