import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskClaimExecutorBusyError } from "../../src/domain/task-board-task.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-claim-refusal-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const opened = [];
  const open = async () => {
    const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
    await rawCatalog.load();
    const rawTasks = new TaskBoardStore({ databaseFile });
    opened.push({ rawCatalog, rawTasks });
    const { workspaceCatalogStore: catalog, taskBoardStore } = createPersistenceMutationCapabilities({
      rawWorkspaceCatalogStore: rawCatalog, rawTaskBoardStore: rawTasks,
    });
    return { rawCatalog, rawTasks, catalog, tasks: new TaskBoardService({ store: taskBoardStore, workspaceCatalog: catalog }) };
  };
  t.after(async () => {
    for (const s of opened) { s.rawTasks.close(); s.rawCatalog.close(); }
    await rm(root, { recursive: true, force: true });
  });
  const current = await open();
  const workspace = await current.catalog.createWorkspace({ name: "Fixture", settings: { workingDirectory: root } });
  const owner = await current.catalog.createStream({ workspaceId: workspace.id, name: "Owner" });
  const caller = await current.catalog.createStream({ workspaceId: workspace.id, name: "Caller" });
  await current.catalog.bindThread({ streamId: owner.id, provider: "codex", threadId: "owner-thread", projectRoot: root });
  await current.catalog.bindThread({ streamId: caller.id, provider: "codex", threadId: "caller-thread", projectRoot: root });
  const created = await current.tasks.create({ text: "Handoff fixture", bucket: "workspace", workspaceId: workspace.id });
  await current.tasks.claim({ id: created.id, workspaceId: workspace.id, streamId: owner.id,
    provider: "codex", threadId: "owner-thread", turnId: "initial-turn", operationId: "initial-claim" });
  const prior = current.tasks.task(created.id);
  const callerRun = { id: "caller-run", streamId: caller.id, provider: "codex", threadId: "caller-thread", turnId: "caller-turn", status: "running" };
  let runs = [callerRun];
  let queued = [];
  let prepares = 0;
  let partial = false;
  const git = { async prepare() { prepares += 1; if (partial) throw partial === "typed"
    ? new TaskClaimExecutorBusyError() : new Error("partial prepare effect"); return null; } };
  const service = (stores = current, startup = false) => {
    const hub = new HubMcpService({ workspaceCatalog: stores.catalog, taskBoard: stores.tasks,
      taskGitWorkspaces: git, workLog: { threadTurns: async () => [] }, secret: "fixture-secret",
      attachmentDirectory: root, reconcilePendingOnStartup: startup,
      taskLifecycle: {},
      releasePreflight: { async preflight() { return {}; } },
      releasePlanner: { async plan() { return { ready: [] }; } },
      releaseCompleter: { async completeRelease() { return {}; } } });
    hub.setActiveRuns(() => runs);
    hub.setDeferredInputs(() => queued);
    return hub;
  };
  const hub = service();
  const token = hub.contextToken({ provider: "codex", threadId: "caller-thread" });
  const input = { context_token: token, request_id: "claim-original", task_id: prior.id, dependency_mode: "ensure" };
  return { ...current, open, service, hub, token, input, prior, workspace, owner, caller, databaseFile,
    busy() { runs = [callerRun, { id: "owner-run", streamId: owner.id, provider: "codex", threadId: "owner-thread", turnId: "owner-turn", status: "running" }]; },
    queue(byThread = false) { queued = [{ id: "owner-queued", ...(byThread ? {} : { streamId: owner.id }), provider: "codex", threadId: "owner-thread" }]; },
    idle() { runs = [callerRun]; queued = []; }, partial(typed = false) { partial = typed ? "typed" : true; }, prepares: () => prepares };
}

for (const mode of ["active", "queued-stream", "queued-thread"]) {
  test(`busy executor ${mode} is a durable typed NO_EFFECT with no Task/Git effects`, async t => {
    const f = await fixture(t);
    if (mode === "active") f.busy(); else f.queue(mode === "queued-thread");
    await assert.rejects(f.hub.call("hub_task_claim", f.input), e => e.code === "TASK_CLAIM_EXECUTOR_BUSY");
    const receipt = f.catalog.mcpOperation(f.input.request_id);
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.receiptState, "failed");
    assert.equal(receipt.result.outcome, "NO_EFFECT");
    assert.equal(receipt.result.evidence.busyReason, mode === "active" ? "active" : "queued");
    assert.equal(receipt.result.evidence.ownerStreamId, f.owner.id);
    assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
    assert.equal(f.tasks.claimBindingForOperation(f.input.request_id), null);
    assert.equal(f.prepares(), 0);
    f.idle();
    await assert.rejects(f.hub.call("hub_task_claim", f.input), e => e.code === "TASK_CLAIM_EXECUTOR_BUSY");
    assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), receipt);
    assert.equal(f.prepares(), 0);
  });
}

test("pending refusal after process loss before either terminal write is recovered at startup", async t => {
  const f = await fixture(t);
  f.busy();
  f.rawCatalog.failMcpOperation = () => { throw new Error("simulated process loss"); };
  f.rawCatalog.markMcpOperationUnknown = () => { throw new Error("process already lost"); };
  await assert.rejects(f.hub.call("hub_task_claim", f.input), /simulated process loss/);
  const pending = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(pending.status, "pending");
  assert.equal(pending.result.outcome, "NO_EFFECT");
  f.idle();
  const second = await f.open();
  await assert.rejects(f.service(second, true).call("hub_task_claim", f.input), e => e.code === "TASK_CLAIM_EXECUTOR_BUSY");
  assert.equal(second.catalog.mcpOperation(f.input.request_id).status, "failed");
  assert.deepEqual(second.catalog.mcpOperation(f.input.request_id).result, pending.result);
  assert.deepEqual(second.tasks.task(f.prior.id), f.prior);
  assert.equal(f.prepares(), 0);
});

test("durable refusal fences even a later direct claim writer for the same operation", async t => {
  const f = await fixture(t);
  f.busy();
  await assert.rejects(f.hub.call("hub_task_claim", f.input));
  f.idle();
  await assert.rejects(f.tasks.claim({ id: f.prior.id, workspaceId: f.workspace.id, streamId: f.caller.id,
    provider: "codex", threadId: "caller-thread", turnId: "late-turn", operationId: f.input.request_id }), /durably refused/);
  assert.deepEqual(f.tasks.task(f.prior.id), f.prior);
});

test("a typed busy error after prepare is insufficient without a sealed pre-admission proof", async t => {
  const f = await fixture(t);
  f.partial(true);
  await assert.rejects(f.hub.call("hub_task_claim", f.input), e => e.code === "TASK_CLAIM_EXECUTOR_BUSY");
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
  assert.equal(f.catalog.mcpOperation(f.input.request_id).result, null);
  assert.equal(f.prepares(), 1);
});

test("existing admitted claim binding prevents sealing a retroactive busy refusal", async t => {
  const f = await fixture(t);
  const begin = f.rawCatalog.beginMcpOperation.bind(f.rawCatalog);
  f.rawCatalog.beginMcpOperation = options => {
    const receipt = begin(options);
    f.rawTasks.claim(f.prior.id, { workspaceId: f.workspace.id, streamId: f.owner.id,
      provider: "codex", threadId: "admitted-thread", turnId: "admitted-turn", operationId: options.requestId });
    return receipt;
  };
  f.busy();
  await assert.rejects(f.hub.call("hub_task_claim", f.input), /cannot overwrite admitted/);
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
  assert.equal(f.catalog.mcpOperation(f.input.request_id).result, null);
  assert.equal(f.prepares(), 0);
});

test("another authenticated caller cannot reuse a refused claim identity", async t => {
  const f = await fixture(t);
  f.busy();
  await assert.rejects(f.hub.call("hub_task_claim", f.input));
  const prior = f.catalog.mcpOperation(f.input.request_id);
  const foreignToken = f.hub.contextToken({ provider: "codex", threadId: "owner-thread" });
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.input, context_token: foreignToken }), /already used for another operation/);
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), prior);
  assert.equal(f.prepares(), 0);
});

test("idle owner allows one ordinary assignment and same-ID retry never prepares twice", async t => {
  const f = await fixture(t);
  const result = await f.hub.call("hub_task_claim", f.input);
  assert.equal(result.streamId, f.caller.id);
  assert.equal(result.claimedTurnId, "caller-turn");
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "succeeded");
  assert.equal(f.prepares(), 1);
  await f.hub.call("hub_task_claim", f.input);
  assert.equal(f.prepares(), 1);
});

for (const startup of [false, true]) {
  test(`durable busy refusal survives failed receipt write and ${startup ? "startup" : "same-ID"} reopen`, async t => {
    const f = await fixture(t);
    f.busy();
    f.rawCatalog.failMcpOperation = () => { throw new Error("receipt write unavailable"); };
    await assert.rejects(f.hub.call("hub_task_claim", f.input), /receipt write unavailable/);
    const unknown = f.catalog.mcpOperation(f.input.request_id);
    assert.equal(unknown.status, "unknown");
    assert.equal(unknown.result.outcome, "NO_EFFECT");
    f.idle();
    const second = await f.open();
    const reopened = f.service(second, startup);
    await assert.rejects(reopened.call("hub_task_claim", f.input), /other executor.*active and queued/i);
    const receipt = second.catalog.mcpOperation(f.input.request_id);
    assert.equal(receipt.status, "failed");
    assert.deepEqual(receipt.result.evidence ?? receipt.result.operatorReconciliation.evidence, unknown.result.evidence);
    assert.deepEqual(second.tasks.task(f.prior.id), f.prior);
    assert.equal(f.prepares(), 0);
  });
}

test("an interrupted unsealed claim is UNKNOWN even when current owner is busy", async t => {
  const f = await fixture(t);
  f.partial();
  await assert.rejects(f.hub.call("hub_task_claim", f.input), /partial prepare/);
  f.busy();
  const second = await f.open();
  await assert.rejects(f.service(second, true).call("hub_task_claim", f.input), /unknown|reconciliation/);
  assert.equal(second.catalog.mcpOperation(f.input.request_id).status, "unknown");
  assert.equal(second.catalog.mcpOperation(f.input.request_id).result, null);
  assert.equal(f.prepares(), 1);
});

test("admitted assignment with lost completion remains UNKNOWN and is not a refusal", async t => {
  const f = await fixture(t);
  f.rawCatalog.completeMcpOperation = () => { throw new Error("lost completion"); };
  await assert.rejects(f.hub.call("hub_task_claim", f.input), /receipt reconciliation/);
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
  assert.ok(f.tasks.claimBindingForOperation(f.input.request_id));
  const second = await f.open();
  await assert.rejects(f.service(second, true).call("hub_task_claim", f.input), /unknown|reconciliation/);
  assert.equal(second.catalog.mcpOperation(f.input.request_id).status, "unknown");
  assert.equal(f.prepares(), 1);
});

for (const field of ["taskId", "streamId", "argumentsHash"]) {
  test(`foreign durable refusal ${field} cannot settle an UNKNOWN claim`, async t => {
    const f = await fixture(t);
    f.busy();
    f.rawCatalog.failMcpOperation = () => { throw new Error("receipt write unavailable"); };
    await assert.rejects(f.hub.call("hub_task_claim", f.input));
    const unknown = f.catalog.mcpOperation(f.input.request_id);
    assert.ok(unknown.result?.evidence);
    const corrupt = structuredClone(unknown.result);
    corrupt.evidence[field] = "foreign";
    const db = new DatabaseSync(f.databaseFile);
    db.prepare("UPDATE hub_mcp_operations SET result_json = ? WHERE request_id = ?").run(JSON.stringify(corrupt), f.input.request_id);
    db.close();
    f.idle();
    const second = await f.open();
    await assert.rejects(f.service(second, true).call("hub_task_claim", f.input), /unknown|reconciliation/);
    assert.equal(second.catalog.mcpOperation(f.input.request_id).status, "unknown");
    assert.equal(f.prepares(), 0);
  });
}
