import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ReleaseOperationCommandService } from "../../src/application/release-operation-command-service.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";

test("release command service binds the public request to a real initiating Thread", () => {
  const calls = [];
  const workspace = {
    id: "workspace-1",
    streams: [{ id: "stream-1", threads: [{ threadId: "thread-old" }] }],
  };
  const service = new ReleaseOperationCommandService({
    releaseOperations: {
      start: ({ resolveAuthorization, ...input }) => {
        calls.push(["start", { ...input, authorization: resolveAuthorization(null) }]);
        return { accepted: true, operationId: "operation-1" };
      },
      get: (operationId) => { calls.push(["get", operationId]); return { operationId }; },
      continue: (operationId) => { calls.push(["continue", operationId]); return { operationId }; },
    },
    workspaceCatalog: {
      workspace: (workspaceId) => workspaceId === workspace.id ? workspace : null,
      hierarchy: () => [workspace],
      activeThread: (streamId) => streamId === "stream-1"
        ? { threadId: "thread-active" } : null,
    },
    taskBoard: {
      task: (taskId) => ({ id: taskId, workspaceId: workspace.id, streamId: "stream-1" }),
      releaseTasks: () => ["task-a", "task-b"].map(id => ({ id, status: "open", workflowStatus: "awaiting_implementation" })),
    },
  });

  const result = service.start({
    requestId: "release-request",
    workspaceId: workspace.id,
    streamId: "stream-1",
    threadId: "thread-old",
    taskIds: ["task-b", "task-a", "task-b"],
    validationMode: "full",
    approvedTargets: [{ targetId: "production", kind: "agent-hub-publication" }],
  });
  assert.equal(result.operationId, "operation-1");
  assert.deepEqual(calls[0], ["start", {
    requestId: "release-request",
    workspaceId: workspace.id,
    streamId: "stream-1",
    threadId: "thread-old",
    authorization: {
      taskIds: ["task-a", "task-b"],
      taskScope: "all_await",
      validationMode: "full",
      approvedTargets: [{ targetId: "production", kind: "agent-hub-publication" }],
    },
  }]);
  assert.deepEqual(service.get({ operationId: "operation-1" }), { operationId: "operation-1" });
  assert.deepEqual(service.continue({ operationId: "operation-1" }), { operationId: "operation-1" });
  service.start({ requestId: "manual-version", workspaceId: workspace.id, streamId: "stream-1", threadId: "thread-old",
    taskIds: ["task-a", "task-b"], validationMode: "full", approvedTargets: [{ targetId: "production", kind: "agent-hub-publication" }],
    releaseVersion: "3.7.9" });
  assert.equal(calls.at(-1)[1].authorization.releaseVersion, "3.7.9");
});

test("release command service fails before admission without a real Thread", () => {
  let starts = 0;
  const service = new ReleaseOperationCommandService({
    releaseOperations: {
      start: () => { starts += 1; }, get: () => null, continue: () => null,
    },
    workspaceCatalog: {
      workspace: () => ({ id: "workspace-1" }),
      hierarchy: () => [{ id: "workspace-1", streams: [] }],
      activeThread: () => null,
    },
    taskBoard: {
      task: (taskId) => ({ id: taskId, workspaceId: "workspace-1" }),
      releaseTasks: () => [{ id: "task-a", status: "open", workflowStatus: "awaiting_implementation" }],
    },
  });
  assert.throws(() => service.start({
    requestId: "release-request",
    workspaceId: "workspace-1",
    streamId: "stream-1",
    threadId: "thread-missing",
    taskIds: ["task-a"],
    validationMode: "full",
    approvedTargets: [{ targetId: "production", kind: "agent-hub-publication" }],
  }), /exact initiating Stream and Thread/u);
  assert.equal(starts, 0);
});

test("whole prepared command preserves an optional version at the existing authorization owner port", () => {
  let captured;
  const service = new ReleaseOperationCommandService({
    releaseOperations: { start: ({ resolveAuthorization, ...input }) => {
      captured = { ...input, authorization: resolveAuthorization(null) }; return captured;
    }, get() {}, continue() {} },
    workspaceCatalog: { workspace: () => ({ id: "workspace" }), hierarchy: () => [{ id: "workspace",
      streams: [{ id: "stream", threads: [{ threadId: "thread" }] }] }] },
    taskBoard: { task: id => ({ id, workspaceId: "workspace" }),
      releaseTasks: () => [{ id: "accepted", status: "open", workflowStatus: "awaiting_implementation" }] },
  });
  service.start({ requestId: "version-forward", workspaceId: "workspace", streamId: "stream", threadId: "thread",
    validationMode: "full", approvedTargets: [{ targetId: "runtime", kind: "runtime" }], releaseVersion: "3.7.9" });
  assert.equal(captured.authorization.releaseVersion, "3.7.9");
  assert.equal(captured.authorization.taskScope, "all_await");
  assert.deepEqual(captured.authorization.taskIds, ["accepted"]);
});

async function originalAdmissionFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-original-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scheduled = [];
  const never = () => assert.fail("Admission-only fixture must not execute release work");
  const store = new ReleaseOperationStore({ dataDir: root });
  const operations = new ReleaseOperationService({ store, processAlive: pid => pid === process.pid,
    schedule: callback => scheduled.push(callback), compose: never, validate: never,
    publishTarget: never, readTarget: never, finalize: never, reservePublication: never });
  let awaiting = ["a", "b"], membershipReads = 0;
  const command = new ReleaseOperationCommandService({ releaseOperations: operations,
    workspaceCatalog: { workspace: id => id === "workspace" ? { id } : null,
      hierarchy: () => [{ id: "workspace", streams: [
        { id: "stream", threads: [{ threadId: "thread" }, { threadId: "other-thread" }] },
        { id: "other-stream", threads: [{ threadId: "other-thread" }] },
      ] }] },
    taskBoard: { task: id => ({ id, workspaceId: "workspace" }),
      releaseTasks: () => { membershipReads++; return awaiting.map(id => ({ id, status: "open", workflowStatus: "awaiting_implementation" })); } },
  });
  const request = { requestId: "original", workspaceId: "workspace", streamId: "stream", threadId: "thread",
    validationMode: "full", approvedTargets: [{ targetId: "fixture", kind: "runtime" }] };
  return { store, command, operations, request, scheduled, setAwait: ids => { awaiting = ids; }, reads: () => membershipReads };
}

for (const explicit of [true, false]) test(`release original ${explicit ? "explicit" : "omitted"} membership replays after Await addition and removal`, async t => {
  const f = await originalAdmissionFixture(t);
  const request = { ...f.request, ...(explicit ? { taskIds: ["a", "b"] } : {}) };
  const first = f.command.start(request);
  const bytes = JSON.stringify(f.store.snapshot(first.operationId));
  const reads = f.reads(), callbacks = f.scheduled.length;
  for (const ids of [["a", "b", "c"], ["a"], []]) {
    f.setAwait(ids);
    const replay = f.command.start(request);
    assert.equal(replay.created, false);
    assert.equal(replay.operationId, first.operationId);
    assert.equal(JSON.stringify(f.store.snapshot(first.operationId)), bytes);
    assert.equal(f.reads(), reads, "an original must not read mutable membership again");
    assert.equal(f.scheduled.length, callbacks, "a replay must not duplicate scheduled work");
  }
  assert.equal(f.store.active().length, 1);
});

test("release original rejects changed caller, options, targets and membership while new subset still refuses", async t => {
  const f = await originalAdmissionFixture(t);
  const request = { ...f.request, taskIds: ["a", "b"] };
  const first = f.command.start(request), bytes = JSON.stringify(f.store.snapshot(first.operationId));
  f.setAwait(["a", "b", "c"]);
  for (const patch of [
    { threadId: "other-thread" }, { streamId: "other-stream", threadId: "other-thread" },
    { validationMode: "focused" }, { approvedTargets: [{ targetId: "different", kind: "runtime" }] },
    { taskIds: ["a", "b", "c"] }, { testSelection: { mode: "none", ids: [] } },
    { releaseMetadata: { sourcePath: "notes", byteLength: 1, rawSha256: "1".repeat(64), canonicalSha256: "2".repeat(64) } },
  ]) assert.throws(() => f.command.start({ ...request, ...patch }), /request identity conflict/u);
  assert.throws(() => f.command.start({ ...request, workspaceId: "foreign" }), /Workspace not found/u);
  assert.throws(() => f.command.start({ ...request, threadId: "missing" }), /exact initiating Stream and Thread/u);
  assert.throws(() => f.command.start({ ...request, requestId: "new-subset" }), /whole current Await set/u);
  assert.equal(JSON.stringify(f.store.snapshot(first.operationId)), bytes);
  assert.equal(f.store.active().length, 1);
  assert.equal(f.scheduled.length, 1);
});

test("release original command replay preserves a legacy admission without adding whole-set authority", async t => {
  const f = await originalAdmissionFixture(t);
  const authorization = { validationMode: "full", approvedTargets: f.request.approvedTargets };
  const first = f.operations.start({ ...f.request, authorization: { ...authorization, taskIds: ["a", "b"] } });
  const bytes = JSON.stringify(f.store.snapshot(first.operationId));
  f.setAwait(["a", "b", "c"]);
  const replay = f.command.start({ ...f.request, taskIds: ["a", "b"] });
  assert.equal(replay.operationId, first.operationId);
  assert.equal(replay.created, false);
  assert.equal(JSON.stringify(f.store.snapshot(first.operationId)), bytes);
  assert.equal(Object.hasOwn(f.store.get(first.operationId).authorization, "taskScope"), false);
  assert.equal(f.reads(), 0);
});
