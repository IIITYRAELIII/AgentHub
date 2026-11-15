import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import test from "node:test";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { runTaskGitCommand } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
function cancel(f, original = f.original, overrides = {}) {
  return f.hub.call("hub_task_operation_cancel", {
    context_token: f.managerToken, request_id: `explicit-cancellation-${f.cancelSequence = (f.cancelSequence ?? 0) + 1}`, task_id: f.prior.id,
    operation_request_id: original.requestId, expected_arguments_hash: original.argumentsHash,
    expected_task_revision: f.tasks.task(f.prior.id).revision, confirm_cancel: true,
    original_arguments: f.originalArgs, ...overrides,
  });
}
function historical(row) { const { taskExecution, ...original } = row; return original; }

test("historical UNKNOWN stays intact; confirmed retirement unlocks dirty work and cannot revive after reopen", async t => {
  const f = await claimCustodyFixture(t);
  const dirty = path.join(f.source.projectRoot, "source.txt");
  const bytes = Buffer.from("unfinished user edit\r\n"); await writeFile(dirty, bytes);
  assert.equal((await cancel(f)).phase, "requested");
  assert.deepEqual(historical(f.catalog.mcpOperation(f.original.requestId)), f.original);
  f.retire();
  const stopped = await cancel(f);
  assert.equal(stopped.phase, "stopped"); assert.equal(stopped.effects, "retained_unknown");
  assert.deepEqual(await cancel(f), stopped);
  const repeat = { context_token: f.managerToken, request_id: "same-cancel-command", task_id: f.prior.id,
    operation_request_id: f.original.requestId, expected_arguments_hash: f.original.argumentsHash,
    expected_task_revision: f.tasks.task(f.prior.id).revision, confirm_cancel: true };
  assert.deepEqual(await f.hub.call("hub_task_operation_cancel", repeat), stopped);
  assert.deepEqual(await f.hub.call("hub_task_operation_cancel", repeat), stopped);
  assert.deepEqual(historical(f.catalog.mcpOperation(f.original.requestId)), f.original);
  await assert.rejects(f.catalog.completeUnknownMcpOperation(f.original.requestId, {
    workspaceId: f.original.workspaceId, toolName: f.original.toolName,
    result: { invented: true }, reconciliation: { invented: true },
  }), /immutable/);
  const reopened = await f.open(); const hub = f.service(reopened, true);
  await assert.rejects(hub.call("hub_task_claim", { ...f.originalArgs,
    context_token: hub.contextToken({ provider: "codex", threadId: `${f.successor.id}-thread` }) }), /explicitly interrupted/);
  assert.deepEqual(historical(reopened.catalog.mcpOperation(f.original.requestId)), f.original);
  const next = await hub.call("hub_task_claim", { context_token: hub.contextToken({ provider: "codex",
    threadId: `${f.successor.id}-thread` }), request_id: "new-explicit-action", task_id: f.prior.id, dependency_mode: "skip" });
  assert.equal(next.id, f.prior.id);
  assert.deepEqual(await readFile(dirty), bytes);
});

for (const remote of [false, true]) test(`running claim stops its actual child before stopped (other incarnation=${remote})`, async t => {
  const f = await claimCustodyFixture(t);
  const started = deferred(); let child;
  f.workspaces.prepareOwned = async ({ lease }) => {
    return runTaskGitCommand(["-e", "setInterval(()=>{},1000)"], { cwd: f.source.projectRoot,
      executable: process.execPath, signal: lease.signal,
      spawnProcess(exe, args, options) { child = spawn(exe, args, options); child.once("spawn", started.resolve); return child; } });
  };
  const args = { context_token: f.successorToken, request_id: "live-claim", task_id: f.prior.id, dependency_mode: "skip" };
  const pending = f.hub.call("hub_task_claim", args); const rejection = assert.rejects(pending, /explicitly interrupted/);
  await started.promise;
  const original = f.catalog.mcpOperation(args.request_id);
  const peer = remote ? f.service() : f.hub;
  if (remote) f.runtime.capture = async () => assert.fail("An aware worker must use its execution fence, not guess a legacy cohort");
  const stopped = await cancel({ ...f, hub: peer, managerToken: peer.contextToken({ provider: "codex", threadId: `${f.manager.id}-thread` }) },
    original, { original_arguments: args });
  await rejection;
  assert.equal(stopped.phase, "stopped"); assert.notEqual(child.exitCode, undefined);
  assert.ok(child.exitCode !== null || child.signalCode !== null);
  const after = f.catalog.mcpOperation(args.request_id);
  assert.equal(after.status, "failed");
  assert.deepEqual(after.taskExecution.cancellation.original, original);
  assert.equal(f.catalog.pendingMcpOperations().some(row => row.requestId === args.request_id), false);
  assert.equal(f.tasks.task(f.prior.id).streamId, f.prior.streamId);
});

test("queued claim is cancelled without entering prepare; another Task lock owner is preserved", async t => {
  const f = await claimCustodyFixture(t);
  const held = deferred(), release = deferred(), queued = deferred(), requested = deferred(); let prepared = 0;
  const lock = f.workspaces.withTaskLock(f.prior.id, async () => { held.resolve(); await release.promise; });
  await held.promise;
  const realLock = f.workspaces.withTaskLock.bind(f.workspaces);
  f.workspaces.withTaskLock = (...args) => { queued.resolve(); return realLock(...args); };
  f.workspaces.prepareOwned = async () => { prepared++; throw new Error("Cancelled queue entered prepare"); };
  const request = f.rawCatalog.requestTaskOperationInterruption.bind(f.rawCatalog);
  f.rawCatalog.requestTaskOperationInterruption = (...args) => { const result = request(...args); requested.resolve(); return result; };
  const args = { context_token: f.successorToken, request_id: "queued-claim", task_id: f.prior.id };
  const pending = f.hub.call("hub_task_claim", args); const rejection = assert.rejects(pending, /explicitly interrupted/);
  await queued.promise;
  const stopping = cancel(f, f.catalog.mcpOperation(args.request_id), { original_arguments: args });
  await requested.promise; await rejection;
  assert.equal(prepared, 0);
  release.resolve(); await lock;
  assert.equal((await stopping).phase, "stopped");
});

test("foreign actor/Task/argument binding refuses before cancellation or native observation", async t => {
  const f = await claimCustodyFixture(t);
  const before = f.catalog.mcpOperation(f.original.requestId);
  await assert.rejects(cancel(f, f.original, { expected_arguments_hash: "0".repeat(64) }), /identity/);
  await assert.rejects(cancel(f, f.original, { original_arguments: { ...f.originalArgs, dependency_mode: "skip" } }), /original Task arguments/);
  const token = f.hub.contextToken({ provider: "codex", threadId: `${f.prior.streamId}-thread` });
  await assert.rejects(cancel(f, f.original, { context_token: token }), /identity or authority/);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), before);
});

test("completed claim wins cancellation race without changing its result", async t => {
  const f = await claimCustodyFixture(t);
  const args = { context_token: f.successorToken, request_id: "completed-claim", task_id: f.prior.id, dependency_mode: "skip" };
  const result = await f.hub.call("hub_task_claim", args);
  const original = f.catalog.mcpOperation(args.request_id);
  assert.equal(original.argumentsHash, mcpArgumentsHash(args));
  assert.equal((await cancel(f, original)).phase, "already_terminal");
  assert.deepEqual(f.catalog.mcpOperation(args.request_id), original);
  assert.equal(result.id, f.prior.id);
});

for (const status of ["testing", "awaiting_implementation"]) test(`${status} cancellation retains lifecycle evidence and permits the next ordinary transition`, async t => {
  const f = await claimCustodyFixture(t);
  if (status === "awaiting_implementation") {
    await f.tasks.setWorkflowStatus({ id: f.prior.id, status: "testing" });
    const repoRoot = f.catalog.workspace(f.original.workspaceId).settings.workingDirectory;
    await f.tasks.recordTaskGitReference({ taskId: f.prior.id, projectRoot: repoRoot,
      branch: f.source.branch, resultSnapshot: { repoRoot, tree: f.source.headCommit } });
  }
  const workspace = f.catalog.workspace(f.original.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id, { ...workspace.settings, releaseWorkflowEnabled: true });
  const started = deferred();
  const hold = async lease => {
    started.resolve();
    await new Promise((_, reject) => {
      if (lease.signal.aborted) reject(lease.signal.reason);
      else lease.signal.addEventListener("abort", () => reject(lease.signal.reason), { once: true });
    });
  };
  f.workspaces.snapshotAndMergeOwned = async ({ lease }) => hold(lease);
  const preflight = { withAwaitTransition: async (_id, operation) => operation(),
    prepareAwaitAcceptance: async ({ lease }) => hold(lease) };
  f.hub.taskLifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog,
    taskGitWorkspaces: f.workspaces, releasePreflight: preflight });
  const before = f.tasks.task(f.prior.id);
  const args = { context_token: f.managerToken, request_id: `held-${status}`, task_id: f.prior.id, status,
    expected_task_revision: before.revision, expected_workflow_status: before.workflowStatus };
  const pending = f.hub.call("hub_task_status_update", args);
  const rejection = assert.rejects(pending, /explicitly interrupted/);
  await started.promise;
  assert.equal(f.tasks.lifecycleTransition(args.request_id).phase, "pending_git");
  const stopped = await cancel(f, f.catalog.mcpOperation(args.request_id), { original_arguments: args });
  await rejection;
  assert.equal(stopped.phase, "stopped");
  assert.equal(f.tasks.lifecycleTransition(args.request_id).phase, "failed");
  assert.deepEqual(f.tasks.task(f.prior.id), before);
  assert.equal(f.tasks.lifecycleOutcome(args.request_id), null);
  const next = await f.hub.call("hub_task_status_update", { context_token: f.managerToken,
    request_id: `next-after-${status}`, task_id: f.prior.id, status: "blocked",
    expected_task_revision: before.revision, expected_workflow_status: before.workflowStatus });
  assert.equal(next.workflowStatus, "blocked");
});

test("late inherited callbacks cannot write Task SQL after the worker joined", async t => {
  const f = await claimCustodyFixture(t);
  const entered = deferred(), late = deferred(); let lateWrite;
  f.workspaces.prepareOwned = async ({ lease }) => {
    lateWrite = late.promise.then(() => f.tasks.claim({ id: f.prior.id, workspaceId: f.prior.workspaceId,
      streamId: f.successor.id, provider: "codex", threadId: `${f.successor.id}-thread`,
      turnId: "late", operationId: "late-sql", gitBaseline: f.source.gitBaseline }));
    entered.resolve();
    await new Promise((_, reject) => lease.signal.addEventListener("abort", () => reject(lease.signal.reason), { once: true }));
  };
  const args = { context_token: f.successorToken, request_id: "inherited-callback", task_id: f.prior.id };
  const pending = f.hub.call("hub_task_claim", args); const rejection = assert.rejects(pending, /explicitly interrupted/);
  await entered.promise;
  await cancel(f, f.catalog.mcpOperation(args.request_id), { original_arguments: args }); await rejection;
  const rejected = assert.rejects(lateWrite, /explicitly interrupted/); late.resolve(); await rejected;
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
});

for (const backlog of [false, true]) test(`global Task target remains distinct from original caller Workspace (Backlog=${backlog})`, async t => {
  const f = await claimCustodyFixture(t);
  const destination = backlog ? null : await f.catalog.createWorkspace({ name: "Other target" });
  await f.tasks.move({ id: f.prior.id, bucket: backlog ? "backlog" : "workspace", workspaceId: destination?.id ?? null });
  const task = f.tasks.task(f.prior.id); f.retire();
  assert.equal((await cancel(f)).phase, "stopped");
  assert.deepEqual(f.tasks.task(f.prior.id), task);
  assert.deepEqual(historical(f.catalog.mcpOperation(f.original.requestId)), f.original);
});

test("an unresolved real process guard is retained and cancellation cannot declare stopped", async t => {
  const f = await claimCustodyFixture(t);
  await f.workspaces.withTaskLock(f.prior.id, async lease => {
    const guard = await lease.beginProcessTreeGuard({ args: ["fixture"], cwd: f.source.projectRoot });
    guard.markUnresolved(new Error("Unproven prior child tree"));
  });
  f.retire();
  await assert.rejects(cancel(f), /unresolved process-tree guard/);
  assert.equal(f.catalog.mcpOperation(f.original.requestId).taskExecution.cancellation.phase, "requested");
  assert.deepEqual(historical(f.catalog.mcpOperation(f.original.requestId)), f.original);
});

test("legacy native owner cannot admit an unusable retirement plan without its existing retained witness", async t => {
  const f = await claimCustodyFixture(t);
  f.runtime.requiresRetainedWitness = true;
  f.runtime.capture = async () => assert.fail("Missing native witness must refuse before capture/admission");
  await assert.rejects(cancel(f), /retained native runtime witness/);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

test("a cancellation-aware UNKNOWN reopens under its durable fence without inventing legacy retirement", async t => {
  const f = await claimCustodyFixture(t);
  f.workspaces.prepareOwned = async () => { throw new Error("opaque interrupted owner result"); };
  const args = { context_token: f.successorToken, request_id: "aware-unknown", task_id: f.prior.id };
  await assert.rejects(f.hub.call("hub_task_claim", args), /opaque interrupted/);
  const original = f.catalog.mcpOperation(args.request_id);
  assert.equal(original.status, "unknown");
  const reopened = await f.open(); const peer = f.service(reopened, true);
  f.runtime.capture = async () => assert.fail("Aware UNKNOWN uses durable protocol fencing");
  const stopped = await cancel({ ...f, ...reopened, hub: peer,
    managerToken: peer.contextToken({ provider: "codex", threadId: `${f.manager.id}-thread` }) }, original);
  assert.equal(stopped.phase, "stopped");
  assert.deepEqual(historical(reopened.catalog.mcpOperation(args.request_id)), historical(original));
});
