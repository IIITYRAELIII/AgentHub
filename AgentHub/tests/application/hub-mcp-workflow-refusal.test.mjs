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
import { mcpArgumentsHash } from "../../src/domain/mcp-arguments-hash.mjs";

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(context, { releaseWorkflowEnabled = true, configuredRoot = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-workflow-refusal-"));
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
    const tasks = new TaskBoardService({ store: taskBoardStore, workspaceCatalog: catalog });
    return { rawCatalog, rawTasks, catalog, tasks };
  };
  context.after(async () => {
    for (const item of opened) { item.rawTasks.close(); item.rawCatalog.close(); }
    await rm(root, { recursive: true, force: true });
  });
  const current = await open();
  const workspace = await current.catalog.createWorkspace({
    name: "Fixture", settings: { releaseWorkflowEnabled, ...(configuredRoot ? { workingDirectory: root } : {}) },
  });
  const stream = await current.catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } });
  await current.catalog.bindThread({ streamId: stream.id, provider: "codex", threadId: "fixture-thread", projectRoot: root });
  const task = await current.tasks.create({ text: "Fixture Task", bucket: "workspace", workspaceId: workspace.id });
  await current.tasks.setWorkflowStatus({ id: task.id, status: "testing" });
  while (current.tasks.task(task.id).revision < 17) {
    await current.tasks.update({ id: task.id, title: task.title, description: `fixture ${current.tasks.task(task.id).revision}` });
  }
  const entered = deferred();
  const release = deferred();
  context.after(() => release.resolve());
  let pause = false;
  let pauseOwnership = false;
  let leaseLost = false;
  let partialLeaseLoss = false;
  let effects = 0;
  let recoveryLocks = 0;
  const lease = () => ({ async assertOwned() {
    if (pauseOwnership) { pauseOwnership = false; entered.resolve(); await release.promise; }
    if (leaseLost) throw new Error("lease lost");
  }, signal: null });
  const git = {
    async withTaskRecoveryLock(_id, operation) { recoveryLocks += 1; return operation({ async assertOwned() {}, signal: null }); },
    async withTaskRepositoryRecoveryLock(_id, _root, lease, operation) { return operation(lease); },
    async withTaskLock(_id, operation) {
      if (pause) { pause = false; entered.resolve(); await release.promise; }
      return operation(lease());
    },
    async prepareOwned() { effects += 1; if (partialLeaseLoss) leaseLost = true; throw new Error("unexpected prepare effect"); },
    async snapshotAndMergeOwned() { effects += 1; if (partialLeaseLoss) leaseLost = true; throw new Error("partial snapshot effect"); },
    async withdrawResultOwned() { effects += 1; throw new Error("unexpected withdrawal effect"); },
    async cleanupOwned() { effects += 1; },
    async cleanupPreview() { return {}; },
  };
  const service = (stores = current, startup = false) => new HubMcpService({
    workspaceCatalog: stores.catalog, taskBoard: stores.tasks,
    taskGitWorkspaces: git, workLog: { threadTurns: async () => [] },
    secret: "fixture-secret", attachmentDirectory: root, reconcilePendingOnStartup: startup,
    releasePlanner: { async plan() { return { ready: [] }; } },
    releaseCompleter: { async completeRelease() { return {}; } },
    releasePreflight: { async preflight() { return {}; }, async prepareAwaitSet() { return {}; },
      async withAwaitTransition(_id, operation) { return operation(); } },
  });
  const hub = service();
  const token = hub.contextToken({ provider: "codex", threadId: "fixture-thread" });
  const input = { context_token: token, request_id: "workflow-original", task_id: task.id,
    status: "in_progress", expected_task_revision: 17, expected_workflow_status: "testing" };
  return { ...current, root, open, hub, service, token, input, task, workspace, stream,
    entered, release, pause() { pause = true; }, pauseOwnership() { pauseOwnership = true; },
    loseLease() { leaseLost = true; }, partialLeaseLoss() { partialLeaseLoss = true; },
    effects() { return effects; }, recoveryLocks() { return recoveryLocks; } };
}

for (const [configuredRoot, suppliedRoot] of [[false, true], [false, false], [true, true]]) {
  test(`database-only ${configuredRoot ? "configured-root" : "null-root"} ${suppliedRoot ? "locator" : "no locator"} owner refusal settles original after lost receipt write`, async (context) => {
    const f = await fixture(context, { releaseWorkflowEnabled: false, configuredRoot });
    const second = await f.open();
    await f.service(second).call("hub_task_update", { context_token: f.token, request_id: "database-only-append",
      task_id: f.task.id, description: "rev18" });
    f.rawCatalog.failMcpOperation = () => { throw new Error("lost receipt write"); };
    await assert.rejects(f.hub.call("hub_task_status_update", f.input), /lost receipt write/);
    const original = f.catalog.mcpOperation(f.input.request_id);
    const outcome = f.tasks.lifecycleOutcome(f.input.request_id);
    assert.equal(original.status, "unknown");
    assert.equal(outcome.result.noEffect.projectRoot, configuredRoot ? f.root : null);
    const reopened = await f.open();
    const hub = f.service(reopened, true);
    assert.equal(reopened.catalog.mcpOperation(f.input.request_id).status, "unknown");
    const args = { context_token: f.token, request_id: "database-only-reconcile", task_id: f.task.id,
      operation_request_id: f.input.request_id, ...(suppliedRoot ? { project_root: f.root } : {}), confirm_reconcile: true,
      expected_task_revision: 17, expected_workflow_status: "testing" };
    const schema = hub.tools().find((tool) => tool.name === "hub_task_operation_reconcile").inputSchema;
    assert.equal(schema.required.includes("project_root"), false);
    for (const required of schema.required) assert.notEqual(args[required], undefined);
    if (configuredRoot) {
      const wrongRoot = { ...args, request_id: "database-only-wrong-root", project_root: path.join(f.root, "other") };
      const missingRoot = { ...args, request_id: "database-only-missing-root" };
      delete missingRoot.project_root;
      for (const invalid of [wrongRoot, missingRoot]) {
        await assert.rejects(hub.call("hub_task_operation_reconcile", invalid), /identity/);
        assert.equal(reopened.catalog.mcpOperation(invalid.request_id).status, "failed");
        assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), original);
      }
    }
    const result = await hub.call("hub_task_operation_reconcile", args);
    assert.equal(result.resolved, true);
    assert.equal(result.reconciliation.outcome, "NO_EFFECT");
    assert.equal(reopened.catalog.mcpOperation(f.input.request_id).status, "failed");
    assert.equal(reopened.catalog.mcpOperation(args.request_id).status, "succeeded");
    assert.deepEqual(await hub.call("hub_task_operation_reconcile", args), result);
    await assert.rejects(hub.call("hub_task_status_update", f.input), /revision changed/);
    assert.deepEqual(reopened.tasks.lifecycleOutcome(f.input.request_id), outcome);
    assert.equal(reopened.tasks.task(f.task.id).revision, 18);
    assert.equal(reopened.tasks.task(f.task.id).workflowStatus, "testing");
    assert.equal(f.effects(), 0);
    assert.equal(f.recoveryLocks(), 0);
  });
}

for (const state of ["legacy", "admitted", "foreign", "corrupt"]) {
  test(`database-only ${state} evidence cannot gain rootless NO_EFFECT authority`, async (context) => {
    const f = await fixture(context, { releaseWorkflowEnabled: false, configuredRoot: false });
    if (state === "foreign" || state === "corrupt") {
      await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
      f.rawCatalog.failMcpOperation = () => { throw new Error("lost receipt write"); };
      await assert.rejects(f.hub.call("hub_task_status_update", f.input), /lost receipt write/);
      if (state === "corrupt") {
        // Fault injection affects only this disposable fixture's durable proof.
        const db = new DatabaseSync(path.join(f.root, "hub.sqlite"));
        try {
          const proof = f.tasks.lifecycleOutcome(f.input.request_id).result;
          proof.noEffect.argumentsHash = "0".repeat(64);
          db.prepare("UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?")
            .run(JSON.stringify(proof), f.input.request_id);
        } finally { db.close(); }
      }
    } else {
      await f.catalog.beginMcpOperation({ requestId: f.input.request_id, workspaceId: f.workspace.id, streamId: f.stream.id,
        provider: "codex", threadId: "fixture-thread", toolName: "hub_task_status_update", argumentsHash: mcpArgumentsHash(f.input) });
      if (state === "admitted") await f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: f.input.request_id,
        expectedRevision: 17, targetWorkflowStatus: "in_progress" });
      await f.catalog.markMcpOperationUnknown(f.input.request_id, new Error("revision changed"));
    }
    const original = f.catalog.mcpOperation(f.input.request_id);
    const reopened = await f.open();
    const hub = f.service(reopened, true);
    const args = { context_token: f.token, request_id: `database-only-${state}-reconcile`, task_id: f.task.id,
      operation_request_id: f.input.request_id, confirm_reconcile: true, expected_task_revision: state === "foreign" ? 18 : 17,
      expected_workflow_status: "testing" };
    await assert.rejects(hub.call("hub_task_operation_reconcile", args), /identity/);
    assert.equal(reopened.catalog.mcpOperation(args.request_id).status, "failed");
    assert.equal(reopened.catalog.mcpOperation(args.request_id).result.outcome, "NO_EFFECT");
    assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), original);
    assert.equal(f.effects(), 0);
    assert.equal(f.recoveryLocks(), 0);
  });
}

test("database-only ordinary admitted state cannot bypass release owner through the refusal branch", async (context) => {
  const f = await fixture(context, { releaseWorkflowEnabled: false });
  await f.catalog.beginMcpOperation({ requestId: f.input.request_id, workspaceId: f.workspace.id, streamId: f.stream.id,
    provider: "codex", threadId: "fixture-thread", toolName: "hub_task_status_update", argumentsHash: mcpArgumentsHash(f.input) });
  await f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: f.input.request_id,
    expectedRevision: 17, targetWorkflowStatus: "in_progress" });
  await f.catalog.markMcpOperationUnknown(f.input.request_id, new Error("ambiguous worker"));
  const original = f.catalog.mcpOperation(f.input.request_id);
  const args = { context_token: f.token, request_id: "disabled-workflow-reconcile", task_id: f.task.id,
    operation_request_id: f.input.request_id, project_root: f.root, confirm_reconcile: true,
    expected_task_revision: 17, expected_workflow_status: "testing" };
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", args), /enabled release workflow/);
  assert.equal(f.catalog.mcpOperation(args.request_id).status, "failed");
  assert.equal(f.catalog.mcpOperation(args.request_id).result.outcome, "NO_EFFECT");
  assert.deepEqual(f.catalog.mcpOperation(f.input.request_id), original);
  assert.equal(f.tasks.lifecycleOutcome(f.input.request_id), null);
  assert.equal(f.effects(), 0);
  assert.equal(f.recoveryLocks(), 0);
});

test("SQL refusal settlement failure cannot certify the reconciler's own receipt as NO_EFFECT", async (context) => {
  const f = await fixture(context, { releaseWorkflowEnabled: false, configuredRoot: false });
  await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
  f.rawCatalog.failMcpOperation = () => { throw new Error("lost receipt write"); };
  await assert.rejects(f.hub.call("hub_task_status_update", f.input), /lost receipt write/);
  const original = f.catalog.mcpOperation(f.input.request_id);
  const reopened = await f.open();
  reopened.rawCatalog.failUnknownMcpOperation = () => { throw new Error("ambiguous settlement write"); };
  const args = { context_token: f.token, request_id: "lost-sql-settlement", task_id: f.task.id,
    operation_request_id: f.input.request_id, confirm_reconcile: true,
    expected_task_revision: 17, expected_workflow_status: "testing" };
  await assert.rejects(f.service(reopened).call("hub_task_operation_reconcile", args), /ambiguous settlement write/);
  assert.equal(reopened.catalog.mcpOperation(args.request_id).status, "unknown");
  assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), original);
  assert.equal(f.effects(), 0);
  assert.equal(f.recoveryLocks(), 0);
});

test("public CAS refusal is durable NO_EFFECT after concurrent append 17 to 18 and same-ID reopen", async (context) => {
  const f = await fixture(context);
  f.pause();
  const original = f.hub.call("hub_task_status_update", f.input);
  const rejection = assert.rejects(original, /revision changed/);
  await f.entered.promise;
  const second = await f.open();
  const other = f.service(second);
  const appended = await other.call("hub_task_update", {
    context_token: f.token, request_id: "concurrent-description-append", task_id: f.task.id, description: "rev18 append",
  });
  assert.equal(appended.revision, 18);
  f.release.resolve();
  await rejection;
  const receipt = f.catalog.mcpOperation(f.input.request_id);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.result.outcome, "NO_EFFECT");
  const outcome = f.tasks.lifecycleOutcome(f.input.request_id);
  assert.equal(outcome.result.noEffect.code, "WORKFLOW_REVISION_CHANGED");
  assert.equal(f.tasks.lifecycleTransition(f.input.request_id), null);
  assert.equal(f.tasks.task(f.task.id).revision, 18);
  assert.equal(f.tasks.task(f.task.id).workflowStatus, "testing");
  const reopened = await f.open();
  await assert.rejects(f.service(reopened, true).call("hub_task_status_update", f.input), /revision changed/);
  assert.deepEqual(reopened.catalog.mcpOperation(f.input.request_id), receipt);
  assert.deepEqual(reopened.tasks.lifecycleOutcome(f.input.request_id), outcome);
  assert.equal(f.effects(), 0);
});

test("public reconciler pre-effect refusal fails its own receipt but leaves ambiguous original UNKNOWN", async (context) => {
  const f = await fixture(context);
  await f.catalog.beginMcpOperation({ requestId: "legacy", workspaceId: f.workspace.id, streamId: f.stream.id,
    provider: "codex", threadId: "fixture-thread", toolName: "hub_task_status_update", argumentsHash: "legacy-hash" });
  await f.catalog.markMcpOperationUnknown("legacy", new Error("Task workflow cutover revision changed"));
  const original = f.catalog.mcpOperation("legacy");
  const args = { context_token: f.token, request_id: "refused-reconcile", task_id: f.task.id,
    operation_request_id: "legacy", project_root: f.root, confirm_reconcile: true };
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", args), /identity/);
  const receipt = f.catalog.mcpOperation(args.request_id);
  assert.equal(receipt.status, "failed");
  assert.equal(receipt.result.outcome, "NO_EFFECT");
  assert.deepEqual(f.catalog.mcpOperation("legacy"), original);
  const reopened = await f.open();
  await assert.rejects(f.service(reopened, true).call("hub_task_operation_reconcile", args), /identity/);
  assert.deepEqual(reopened.catalog.mcpOperation("legacy"), original);
  assert.equal(f.effects(), 0);
});

for (const boundary of ["unknown", "pending"]) {
  test(`outcome survives failed receipt write and ${boundary === "unknown" ? "canonical original-ID reconciliation" : "startup"} settles without effects`, async (context) => {
    const f = await fixture(context);
    await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
    const fail = f.rawCatalog.failMcpOperation.bind(f.rawCatalog);
    f.rawCatalog.failMcpOperation = () => { throw new Error("receipt settlement unavailable"); };
    if (boundary === "pending") f.rawCatalog.markMcpOperationUnknown = () => null;
    await assert.rejects(f.hub.call("hub_task_status_update", f.input), /settlement unavailable/);
    assert.equal(f.catalog.mcpOperation(f.input.request_id).status, boundary);
    const outcome = f.tasks.lifecycleOutcome(f.input.request_id);
    assert.equal(outcome.result.noEffect.code, "WORKFLOW_REVISION_CHANGED");
    f.rawCatalog.failMcpOperation = fail;
    const reopened = await f.open();
    const hub = f.service(reopened, boundary === "pending");
    if (boundary === "unknown") {
      const args = { context_token: f.token, request_id: "settle-original-refusal", task_id: f.task.id,
        operation_request_id: f.input.request_id, project_root: f.root, confirm_reconcile: true,
        expected_task_revision: 17, expected_workflow_status: "testing" };
      const result = await hub.call("hub_task_operation_reconcile", args);
      assert.equal(result.resolved, true);
      assert.equal(result.reconciliation.outcome, "NO_EFFECT");
      assert.deepEqual(await hub.call("hub_task_operation_reconcile", args), result);
    }
    await assert.rejects(hub.call("hub_task_status_update", f.input), /revision changed/);
    assert.equal(reopened.catalog.mcpOperation(f.input.request_id).status, "failed");
    assert.deepEqual(reopened.tasks.lifecycleOutcome(f.input.request_id), outcome);
    assert.equal(reopened.tasks.task(f.task.id).revision, 18);
    assert.equal(f.effects(), 0);
    await assert.rejects(reopened.tasks.beginLifecycleTransition({ id: f.task.id, operationId: f.input.request_id,
      expectedRevision: 18, targetWorkflowStatus: "in_progress" }), /terminal outcome/);
    assert.equal(reopened.tasks.lifecycleTransition(f.input.request_id), null);
  });
}

test("status-only refusal retains exact argument shape and wrong selection cannot settle it", async (context) => {
  const f = await fixture(context);
  const input = { ...f.input, expected_workflow_status: "in_progress" };
  delete input.expected_task_revision;
  f.rawCatalog.failMcpOperation = () => { throw new Error("lost receipt write"); };
  await assert.rejects(f.hub.call("hub_task_status_update", input), /lost receipt write/);
  assert.equal(f.tasks.lifecycleOutcome(input.request_id).result.noEffect.code, "WORKFLOW_STATUS_CHANGED");
  const reopened = await f.open();
  const hub = f.service(reopened);
  const args = { context_token: f.token, request_id: "wrong-refusal-selection", task_id: f.task.id,
    operation_request_id: input.request_id, project_root: f.root, confirm_reconcile: true,
    expected_task_revision: 17, expected_workflow_status: "in_progress" };
  await assert.rejects(hub.call("hub_task_operation_reconcile", args), /identity/);
  assert.equal(reopened.catalog.mcpOperation(input.request_id).status, "unknown");
  assert.equal(reopened.catalog.mcpOperation(args.request_id).status, "failed");
  const exact = { ...args, request_id: "exact-refusal-selection" };
  delete exact.expected_task_revision;
  assert.equal((await hub.call("hub_task_operation_reconcile", exact)).resolved, true);
  assert.equal(f.effects(), 0);
});

for (const state of ["admitted", "legacy", "foreign"]) {
  test(`${state} receipt cannot acquire a retroactive admission refusal certificate`, async (context) => {
    const f = await fixture(context);
    await f.catalog.beginMcpOperation({ requestId: f.input.request_id, workspaceId: f.workspace.id, streamId: f.stream.id,
      provider: "codex", threadId: "fixture-thread", toolName: "hub_task_status_update", argumentsHash: mcpArgumentsHash(f.input) });
    if (state === "admitted") await f.tasks.beginLifecycleTransition({ id: f.task.id, operationId: f.input.request_id,
      expectedRevision: 17, targetWorkflowStatus: "in_progress" });
    await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
    if (state !== "admitted") await f.catalog.markMcpOperationUnknown(f.input.request_id, new Error("revision changed"));
    const input = state === "foreign" ? { ...f.input, expected_task_revision: 18 } : f.input;
    await assert.rejects(f.hub.call("hub_task_status_update", input));
    assert.equal(f.tasks.lifecycleOutcome(f.input.request_id), null);
    assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
    assert.equal(f.effects(), 0);
  });
}

test("an active original worker cannot be settled by a parallel reconciler", async (context) => {
  const f = await fixture(context);
  f.pause();
  const original = f.hub.call("hub_task_status_update", f.input);
  const rejected = assert.rejects(original);
  await f.entered.promise;
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", { context_token: f.token,
    request_id: "active-reconcile", task_id: f.task.id, operation_request_id: f.input.request_id,
    project_root: f.root, confirm_reconcile: true }), /active/);
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "pending");
  assert.equal(f.catalog.mcpOperation("active-reconcile").status, "failed");
  assert.equal(f.tasks.lifecycleOutcome(f.input.request_id), null);
  f.release.resolve();
  await rejected;
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
});

test("partial Git effect stays UNKNOWN through restart and refuses reconciliation without proof", async (context) => {
  const f = await fixture(context);
  f.partialLeaseLoss();
  const input = { ...f.input, status: "testing" };
  await assert.rejects(f.hub.call("hub_task_status_update", input), /unexpected prepare effect|partial snapshot effect/);
  assert.equal(f.effects(), 1);
  assert.equal(f.tasks.lifecycleOutcome(input.request_id), null);
  const original = f.catalog.mcpOperation(input.request_id);
  assert.equal(original.status, "unknown");
  const reopened = await f.open();
  const hub = f.service(reopened, true);
  await assert.rejects(hub.call("hub_task_status_update", input), /unknown/);
  await assert.rejects(hub.call("hub_task_operation_reconcile", { context_token: f.token,
    request_id: "partial-reconcile", task_id: f.task.id, operation_request_id: input.request_id,
    project_root: f.root, confirm_reconcile: true, expected_task_revision: 17,
    expected_workflow_status: "testing" }), /recoverable|guard/);
  assert.equal(reopened.catalog.mcpOperation("partial-reconcile").status, "failed");
  assert.deepEqual(reopened.catalog.mcpOperation(input.request_id), original);
  assert.equal(f.effects(), 1);
});

test("concurrent append between initial CAS and BEGIN seals the rolled-back admission refusal", async (context) => {
  const f = await fixture(context);
  f.pauseOwnership();
  const original = f.hub.call("hub_task_status_update", f.input);
  const rejected = assert.rejects(original, /revision changed/);
  await f.entered.promise;
  const second = await f.open();
  await f.service(second).call("hub_task_update", { context_token: f.token, request_id: "late-append",
    task_id: f.task.id, description: "append after initial CAS" });
  f.release.resolve();
  await rejected;
  assert.equal(f.tasks.task(f.task.id).revision, 18);
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "failed");
  assert.equal(f.catalog.mcpOperation(f.input.request_id).result.outcome, "NO_EFFECT");
  assert.equal(f.tasks.lifecycleTransition(f.input.request_id), null);
  assert.equal(f.tasks.lifecycleOutcome(f.input.request_id).result.noEffect.observedRevision, 18);
  assert.equal(f.effects(), 0);
});

test("lost lease cannot issue an admission refusal certificate", async (context) => {
  const f = await fixture(context);
  await f.tasks.update({ id: f.task.id, title: f.task.title, description: "rev18" });
  f.loseLease();
  await assert.rejects(f.hub.call("hub_task_status_update", f.input), /lease lost/);
  assert.equal(f.catalog.mcpOperation(f.input.request_id).status, "unknown");
  assert.equal(f.tasks.lifecycleOutcome(f.input.request_id), null);
  assert.equal(f.effects(), 0);
});
