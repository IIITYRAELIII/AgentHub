import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { claimCustodyFixture } from "../fixtures/claim-custody-public-fixture.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskReleasePlanService } from "../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { cloneJournalToTestContour } from "../../src/infrastructure/persistence/test-contour-data-clone.mjs";

async function fixture(t) {
  const f = await claimCustodyFixture(t);
  f.prepare.claim_custody.admission = "isolated-source-v1";
  f.runtime.capture = () => { throw Error("Isolation must not invent a historical cohort"); };
  f.runtime.assertRetired = f.runtime.capture;
  return f;
}

test("public isolated custody preserves UNKNOWN and full Git/WIP, with no old prepare replay", { timeout: 60000 }, async t => {
  let legacy;
  t.after(() => legacy?.close());
  const f = await fixture(t);
  legacy = new DatabaseSync(path.join(f.root, "hub.sqlite"));
  const late = legacy.prepare("UPDATE hub_board_tasks SET stream_id='foreign' WHERE id=?");
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  assert.throws(() => late.run(f.prior.id), /namespace authority/);
  const claimed = await f.hub.call("hub_task_claim", f.consume);
  const physical = claimed.gitWorkspace.projectRoot;
  assert.notEqual(physical, f.source.projectRoot);
  assert.equal(claimed.streamId, f.successor.id);
  assert.equal(f.prepares(), 0);
  assert.equal(await f.git(physical, "rev-parse", "HEAD"), f.source.headCommit);
  const custody = f.catalog.claimCustodyNamespaceForTask(f.prior.id);
  assert.equal(await f.git(physical, "rev-parse", `${custody.namespace.refPrefix}/source`), f.source.headCommit);
  await assert.rejects(f.workspaces.cleanupPreview(f.prior.id), /artifact owner's verified retirement/);
  assert.equal(await f.git(physical, "rev-parse", "--absolute-git-dir"), path.join(physical, ".git").replaceAll("\\", "/"));
  await assert.rejects(access(path.join(physical, ".git/objects/info/alternates")));
  assert.equal(await readFile(path.join(physical, "WIP/useful.txt"), "utf8"), "unfinished evidence\n");
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  // A supported old child can still mutate its OLD source; those bytes are
  // deliberately not successor authority, and the old root is not immutable.
  await writeFile(path.join(f.source.projectRoot, "source.txt"), "late old child\n");
  await writeFile(path.join(f.source.projectRoot, "WIP/useful.txt"), "late old WIP\n");
  assert.equal(await readFile(path.join(physical, "source.txt"), "utf8"), "accepted source\n");
  assert.equal(await readFile(path.join(physical, "WIP/useful.txt"), "utf8"), "unfinished evidence\n");
  assert.deepEqual(await f.hub.call("hub_task_claim", f.consume), JSON.parse(JSON.stringify(claimed)));
  const reopened = await f.open();
  assert.equal(reopened.tasks.task(f.prior.id).streamId, f.successor.id);
  assert.deepEqual(reopened.catalog.mcpOperation(f.original.requestId), f.original);
});

for (const command of ["init", "fetch", "snapshot"]) {
  test(`private staging reopens the exact intent after crash following ${command}`, { timeout: 60000 }, async t => {
    const f = await fixture(t);
    const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
    let fault = true;
    if (command === "snapshot") {
      const stage = f.workspaces.stageIndependentClaimNamespaceOwned.bind(f.workspaces);
      f.workspaces.stageIndependentClaimNamespaceOwned = async args => {
        const result = await stage(args);
        if (fault) { fault = false; throw Error("crash following snapshot"); }
        return result;
      };
    } else {
      const run = f.workspaces.runCommand;
      f.workspaces.runCommand = async (args, options) => {
        const result = await run(args, options);
        if (fault && args[0] === command && options.cwd.includes("task-custody")) {
          fault = false; throw Error(`crash following ${command}`);
        }
        return result;
      };
    }
    await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /crash following/);
    assert.equal(f.catalog.claimCustodyForOriginal(f.original.requestId), null);
    await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
    const result = await f.hub.call("hub_task_claim", f.consume);
    assert.equal(result.revision, f.prior.revision + 1);
    assert.equal(f.prepares(), 0);
    assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  });
}

test("independent fence/assignment survive reply and event loss with a fresh Git owner", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const save = f.rawCatalog.checkpointClaimCustody.bind(f.rawCatalog);
  f.rawCatalog.checkpointClaimCustody = state => { save(state); throw Error("lost durable stage reply"); };
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  f.tasks.recordEvent = async () => { throw Error("crash after assignment before receipt"); };
  await assert.rejects(f.hub.call("hub_task_claim", f.consume), /crash after assignment/);
  const assigned = f.tasks.task(f.prior.id);
  const reopened = await f.open();
  const git = new TaskGitWorkspaceService({ dataDir: f.workspaces.dataDir, recordTiming: () => {},
    readClaimCustodyNamespace: id => reopened.catalog.claimCustodyNamespaceForTask(id),
    prepareDependencies: () => assert.fail("Recovery cannot prepare dependencies") });
  const hub = f.service(reopened, true, git);
  const token = hub.contextToken({ provider: "codex", threadId: f.original.threadId });
  const result = await hub.call("hub_task_claim", { ...f.consume, context_token: token });
  assert.equal(result.revision, assigned.revision);
  assert.equal(result.gitWorkspace.projectRoot, f.catalog.claimCustodyNamespaceForTask(f.prior.id).namespace.workspace.projectRoot);
  assert.deepEqual(reopened.tasks.task(f.prior.id), assigned);
  assert.deepEqual(reopened.catalog.mcpOperation(f.original.requestId), f.original);
});

test("two isolated intents have one winner; queued old owner and foreign calls cannot enter the namespace", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const second = structuredClone(f.prepare);
  second.request_id = "second-isolated-plan";
  second.claim_custody.successor_claim_request_id = "second-isolated-successor";
  const firstPlan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  const secondPlan = await f.hub.call("hub_task_operation_reconcile", second);
  const outcomes = await Promise.allSettled([
    f.hub.call("hub_task_operation_reconcile", f.fence(firstPlan)),
    f.hub.call("hub_task_operation_reconcile", { ...f.fence(secondPlan), request_id: "second-isolated-fence",
      claim_custody: { action: "fence", plan_request_id: second.request_id, expected_plan_hash: secondPlan.planHash } }),
  ]);
  assert.equal(outcomes.filter(x => x.status === "fulfilled").length, 1);
  const winner = outcomes.find(x => x.status === "fulfilled").value;
  const consume = { ...f.consume, request_id: winner.successorClaimRequestId, forward_custody_request_id: winner.requestId };
  f.hub.setDeferredInputs(() => [{ provider: "codex", threadId: `${f.prior.streamId}-thread` }]);
  await assert.rejects(f.hub.call("hub_task_claim", consume), /Previous executor became active/);
  f.hub.setDeferredInputs(() => []);
  await assert.rejects(f.hub.call("hub_task_claim", { ...consume, context_token: f.managerToken }), /another operation/);
  await assert.rejects(f.hub.call("hub_task_claim", { ...f.originalArgs, context_token: f.successorToken }), /future continuation was withdrawn/);
  const result = await f.hub.call("hub_task_claim", consume);
  assert.equal(result.revision, f.prior.revision + 1);
  await assert.rejects(f.hub.call("hub_task_claim", { request_id: "foreign-fresh-claim", task_id: f.prior.id,
    dependency_mode: "ensure", context_token: f.managerToken }), /Foreign claim/);
  await assert.rejects(f.hub.call("hub_task_claim", { ...consume, dependency_mode: "skip" }), /another operation/);
  assert.equal(f.prepares(), 0);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

test("an isolated contour data copy retains UNKNOWN but cannot use production namespace capability", { timeout: 60000 }, async t => {
  const f = await fixture(t);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  await f.hub.call("hub_task_claim", f.consume);
  const destination = path.join(f.root, "contour", "hub.sqlite");
  await cloneJournalToTestContour({ sourceDatabaseFile: path.join(f.root, "hub.sqlite"), destinationDatabaseFile: destination,
    projectRoot: path.join(f.root, "contour-project"), detachedGitRoot: path.join(f.root, "detached"), model: "fixture" });
  const db = new DatabaseSync(destination, { readOnly: true });
  try {
    assert.equal(db.prepare("SELECT receipt_state FROM hub_mcp_operations WHERE request_id=?").get(f.original.requestId).receipt_state, "unknown");
  } finally { db.close(); }
  const foreign = new TaskGitWorkspaceService({ dataDir: path.join(f.root, "contour-data"), recordTiming: () => {},
    readClaimCustodyNamespace: id => f.catalog.claimCustodyNamespaceForTask(id) });
  await assert.rejects(foreign.describe(f.prior.id), /data root does not own/);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});

test("a non-Task-row effect before fence changes the atomic state pin and stops takeover", { timeout: 60000 }, async t => {
  let legacy;
  t.after(() => legacy?.close());
  const f = await fixture(t);
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  legacy = new DatabaseSync(path.join(f.root, "hub.sqlite"));
  legacy.prepare("UPDATE hub_task_turn_bindings SET baseline_json=? WHERE task_id=?")
    .run('{"late":"before fence"}', f.prior.id);
  await assert.rejects(f.hub.call("hub_task_operation_reconcile", f.fence(plan)), /Task state.*changed before fence/);
  assert.equal(f.catalog.claimCustodyNamespaceForTask(f.prior.id), null);
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
  assert.equal(f.prepares(), 0);
});

test("ordinary public Test imports isolated history and result authority without returning to old Task refs", { timeout: 120000 }, async t => {
  const f = await fixture(t);
  await f.catalog.updateWorkspaceSettings(f.prior.workspaceId, { workingDirectory: f.source.repositoryRoot, releaseWorkflowEnabled: true });
  f.workspaces.readPublication = async () => null;
  const plan = await f.hub.call("hub_task_operation_reconcile", f.prepare);
  await f.hub.call("hub_task_operation_reconcile", f.fence(plan));
  const claim = await f.hub.call("hub_task_claim", f.consume);
  const root = claim.gitWorkspace.projectRoot;
  await writeFile(path.join(root, "new-result.txt"), "only successor\n");
  await f.git(root, "add", "new-result.txt");
  await f.git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "successor result");
  const result = await f.git(root, "rev-parse", "HEAD");
  let publication = null;
  const preflight = new WorkspaceReleasePreflightService({
    releasePlanner: new TaskReleasePlanService({ taskBoard: f.tasks, taskGitWorkspaces: f.workspaces }),
    taskGitWorkspaces: f.workspaces, releaseGitWorkspaces: new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "data") }),
    readPublicationState: async () => publication,
    resolveReleaseValidationSource: () => assert.fail("Task Test must not refresh a shared environment"),
    validateProductionCandidate: () => assert.fail("Task Test must not publish"),
  });
  f.hub.taskLifecycle = new TaskLifecycleService({ taskBoard: f.tasks, workspaceCatalog: f.catalog, taskGitWorkspaces: f.workspaces, releasePreflight: preflight });
  await f.hub.call("hub_task_status_update", { context_token: f.successorToken, request_id: "isolated-normal-test",
    task_id: f.prior.id, status: "testing", expected_task_revision: claim.revision, expected_workflow_status: "in_progress" });
  const task = f.tasks.task(f.prior.id);
  assert.equal(task.workflowStatus, "testing");
  assert.equal(task.gitReferences[0].resultCommit, result);
  assert.equal(task.gitReferences[0].projectRoot, f.source.repositoryRoot);
  const state = f.catalog.claimCustodyNamespaceForTask(f.prior.id);
  assert.equal(await f.git(f.source.repositoryRoot, "rev-parse", `${state.namespace.refPrefix}/result`), result);
  // A late old Git writer still sees only its old shared Task branch/result.
  await f.git(f.source.projectRoot, "update-ref", `refs/agent-hub/task-results/${f.prior.id}/${state.namespace.repositoryKey}`, f.source.baseCommit);
  const evidence = await f.workspaces.releaseEvidence({ taskId: task.id, taskNumber: task.taskNumber,
    projectRoot: f.source.repositoryRoot, branch: task.gitReferences[0].branch, resultCommit: result });
  assert.equal(evidence.resultCommit, result);
  const origin = path.join(f.root, "origin.git");
  await f.git(f.root, "init", "--bare", "--initial-branch=main", origin);
  await f.git(f.source.repositoryRoot, "remote", "add", "origin", origin);
  await f.git(f.source.repositoryRoot, "push", "origin", "main");
  publication = { generation: "isolated-fixture", repositories: [{ root: f.source.repositoryRoot, revision: f.source.baseCommit }] };
  f.workspaces.readPublication = async () => publication;
  f.hub.releasePreflight = preflight;
  await f.hub.call("hub_task_status_update", { context_token: f.successorToken, request_id: "isolated-normal-await",
    task_id: task.id, status: "awaiting_implementation", expected_task_revision: task.revision, expected_workflow_status: "testing" });
  assert.equal(f.tasks.task(task.id).workflowStatus, "awaiting_implementation");
  assert.equal(await f.git(f.source.repositoryRoot, "merge-base", "--is-ancestor", result, "dev"), "");
  assert.deepEqual(f.catalog.mcpOperation(f.original.requestId), f.original);
});
