import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { mcpArgumentsHash } from "../../../src/domain/mcp-arguments-hash.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { runOwnedGit } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { prepareOwnedWindowsTaskProcess } from "../../../src/infrastructure/process/windows-task-process-owner.mjs";
import { claimCustodyFixture } from "../../fixtures/claim-custody-public-fixture.mjs";

const worker = fileURLToPath(new URL("../../fixtures/task-git-windows-job-child.mjs", import.meta.url));
const run = promisify(execFile);
const windows = process.platform === "win32";
async function waitFor(check, description) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const match = await check();
    if (match) return match;
    await delay(25);
  }
  assert.fail(description);
}
async function optionalFile(file) {
  return readFile(file, "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
}

for (const mode of ["running", "completed"]) {
  test("Windows Task Git records " + mode + " Job across worker termination and settles only the original requested cancellation",
    { skip: !windows, timeout: 45_000 }, async t => {
    const f = await claimCustodyFixture(t, { unassigned: true });
    const repositoryRoot = f.source.repositoryRoot;
    const taskId = f.prior.id;
    const dataDir = path.join(f.root, "data");
    const operationId = "windows-interrupted-test-" + mode;
    const args = { request_id: operationId, task_id: taskId, status: "testing",
      expected_task_revision: f.prior.revision, expected_workflow_status: f.prior.workflowStatus };
    const actor = { workspaceId: f.prior.workspaceId, streamId: f.manager.id, provider: "codex",
      threadId: f.manager.id + "-thread", releaseManager: true };
    const argumentsHash = mcpArgumentsHash(args);
    await f.catalog.beginMcpOperation({ requestId: operationId, ...actor, toolName: "hub_task_status_update", argumentsHash,
      taskExecution: { version: 1, protocol: "task-operation-interruption-v1", ownerId: "killed-test-worker",
        taskId, taskWorkspaceId: f.prior.workspaceId, arguments: args } });
    await f.tasks.beginLifecycleTransition({ id: taskId, operationId, kind: "workflow",
      targetWorkflowStatus: "testing", expectedRevision: f.prior.revision });
    const resultRef = "refs/agent-hub/task-results/" + taskId + "/" + taskRepositoryKey(repositoryRoot);
    await f.git(repositoryRoot, "update-ref", resultRef, f.source.headCommit);
    // A private persisted intent matching the actual test ref transaction.
    const nativeDir = path.join(dataDir, "task-native-integrations", taskId, taskRepositoryKey(repositoryRoot));
    await mkdir(nativeDir, { recursive: true });
    const key = createHash("sha256").update(operationId, "utf8").digest("hex");
    await writeFile(path.join(nativeDir, key + ".json"), JSON.stringify({
      version: 1, kind: "native-task-integration-v1", phase: "pending", operationId,
      target: f.source.headCommit, snapshot: { taskId, repositoryRoot, headCommit: f.source.headCommit },
    }));
    const running = path.join(f.root, "running");
    const late = path.join(f.root, "late");
    const child = spawn(process.execPath, [worker, "hub", dataDir, repositoryRoot, taskId, operationId, f.source.headCommit], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HUB_JOB_FIXTURE_MODE: mode, HUB_JOB_RUNNING: running, HUB_JOB_LATE: late },
    });
    const joined = once(child, "close");
    t.after(async () => { if (child.exitCode == null && child.signalCode == null) child.kill(); await joined; });
    let stdout = "", stderr = "";
    child.stdout.on("data", bytes => { stdout += bytes; });
    child.stderr.on("data", bytes => { stderr += bytes; });
    await waitFor(async () => {
      assert.equal(child.exitCode, null, stderr);
      return mode === "completed" ? stdout.includes("completed-held") : optionalFile(running);
    }, "Fixture did not reach the interruption point");
    const directory = path.join(dataDir, "task-process-tree-guards", taskId);
    const entries = await readdir(directory);
    assert.equal(entries.length, 1);
    const guardFile = path.join(directory, entries[0]);
    const guard = JSON.parse(await readFile(guardFile, "utf8"));
    assert.equal(guard.version, 2);
    assert.equal(guard.operationId, operationId);
    const evidenceDir = path.join(dataDir, "task-process-tree-recoveries", taskId);
    const proofFile = path.join(evidenceDir, createHash("sha256").update("native-" + guard.guardId).digest("hex") + ".json.finished");
    assert.equal(await f.git(repositoryRoot, "rev-parse", "refs/heads/dev"), f.source.headCommit);
    const original = await f.catalog.requestTaskOperationInterruption(operationId, { taskId, targetWorkspaceId: f.prior.workspaceId,
      expectedArgumentsHash: argumentsHash, expectedTaskRevision: f.prior.revision, actor, arguments: args,
      cancellationRequestId: "already-requested-" + mode, requestedAtMs: Date.now() });
    assert.equal(child.kill(), true);
    await joined;
    const proof = JSON.parse(await waitFor(() => optionalFile(proofFile), "Native Job never wrote a completion"));
    assert.equal(proof.reason, mode === "completed" ? "completed" : "owner-ended");
    assert.equal(proof.activeProcesses, 0);
    const reopened = await f.open();
    const hub = f.service(reopened, true);
    const token = hub.contextToken({ provider: "codex", threadId: actor.threadId });
    const reconcile = step => hub.call("hub_task_operation_reconcile", {
      context_token: token, request_id: "reconcile-" + mode + "-" + step, task_id: taskId, operation_request_id: operationId,
      expected_arguments_hash: argumentsHash, expected_task_revision: f.prior.revision,
      expected_workflow_status: f.prior.workflowStatus, project_root: repositoryRoot, confirm_reconcile: true,
    });
    // Absence of a receipt, even after the processes are gone, cannot clear this guard.
    await rename(proofFile, proofFile + ".held");
    const pending = await reconcile("missing");
    assert.equal(pending.resolved, false);
    assert.equal(pending.cancellation.waitingFor, "windows-owned-job-retirement");
    assert.deepEqual(JSON.parse(await readFile(guardFile, "utf8")), guard);
    assert.equal(reopened.catalog.mcpOperation(operationId).taskExecution.cancellation.phase, "requested");
    await rename(proofFile + ".held", proofFile);
    const settled = await reconcile("available");
    assert.equal(settled.resolved, true);
    assert.equal(settled.cancellation.effects, "retained_unknown");
    assert.equal(settled.cancellation.requestedAtMs, original.requestedAtMs);
    const stopped = reopened.catalog.mcpOperation(operationId);
    assert.equal(stopped.status, "failed");
    assert.equal(stopped.taskExecution.cancellation.phase, "stopped");
    assert.equal(stopped.taskExecution.cancellation.cancellationRequestId, original.cancellationRequestId);
    assert.deepEqual(stopped.taskExecution.cancellation.retirement.retiredWindowsGuardIds, [guard.guardId]);
    assert.equal(stopped.taskExecution.cancellation.retirement.gitReadback.matchesIntent, true);
    assert.equal(reopened.tasks.lifecycleTransition(operationId).phase, "failed");
    assert.equal(reopened.tasks.lifecycleOutcome(operationId), null);
    assert.deepEqual(reopened.tasks.task(taskId), f.prior);
    assert.equal(await f.git(repositoryRoot, "rev-parse", resultRef), f.source.headCommit);
    assert.equal(await optionalFile(guardFile), null);
    assert.equal((await f.workspaces.recoverProcessTreeGuard(taskId, {
      repositoryRoot, guardId: guard.guardId, operationId,
    })).reused, true);
    assert.equal(await f.workspaces.withTaskLock(taskId, lease =>
      runOwnedGit(["rev-parse", "refs/heads/dev"], { cwd: repositoryRoot, lease })), f.source.headCommit);
    const repeated = await hub.call("hub_task_operation_cancel", { context_token: token, request_id: "repeat-stop-" + mode,
      task_id: taskId, operation_request_id: operationId, expected_arguments_hash: argumentsHash,
      expected_task_revision: f.prior.revision, confirm_cancel: true });
    assert.deepEqual(repeated, settled.cancellation);
    if (mode === "running") {
      await delay(4100);
      assert.equal(await optionalFile(late), null);
    }
  });
}

test("Windows Job admission refuses a mismatched parent creation time at the same PID",
  { skip: !windows, timeout: 20_000 }, async t => {
  const f = await claimCustodyFixture(t, { unassigned: true });
  const recordBase = path.join(f.root, "receipt");
  const marker = path.join(f.root, "must-not-execute");
  const command = await prepareOwnedWindowsTaskProcess({ guardId: randomUUID(), recordBase }, process.execPath,
    ["-e", "require('node:fs').writeFileSync(process.argv[1], 'ran')", marker], { timeoutMs: 1000 });
  command.args[4] = (BigInt(command.args[4]) - 1n).toString();
  await assert.rejects(run(command.executable, command.args, { cwd: f.root, windowsHide: true }),
    error => error.code === 1 && /Task Job evidence unavailable/.test(error.stderr));
  assert.equal(await optionalFile(marker), null);
  assert.equal(await optionalFile(recordBase + ".admitted"), null);
  assert.equal(await optionalFile(recordBase + ".finished"), null);
});

test("Live MCP cancellation drains its Windows Job with an already applied Git ref",
  { skip: !windows, timeout: 120_000 }, async t => {
  const f = await claimCustodyFixture(t);
  const repositoryRoot = f.source.repositoryRoot;
  const workspace = f.catalog.workspace(f.prior.workspaceId);
  await f.catalog.updateWorkspaceSettings(workspace.id, { ...workspace.settings, releaseWorkflowEnabled: true });
  const running = path.join(f.root, "running");
  const late = path.join(f.root, "late");
  const integrate = f.workspaces.snapshotAndMergeOwned.bind(f.workspaces);
  f.workspaces.snapshotAndMergeOwned = async ({ lease }) => runOwnedGit([
    worker, "git-and-descendant", repositoryRoot, running, late, f.source.headCommit,
  ], { cwd: repositoryRoot, lease, executable: process.execPath });
  f.hub.taskLifecycle = new TaskLifecycleService({
    taskBoard: f.tasks, workspaceCatalog: f.catalog, taskGitWorkspaces: f.workspaces,
    releasePreflight: { withAwaitTransition: (_id, operation) => operation() },
  });
  const requestId = "live-native-test";
  const before = f.tasks.task(f.prior.id);
  const args = { context_token: f.managerToken, request_id: requestId, task_id: before.id,
    status: "testing", expected_task_revision: before.revision, expected_workflow_status: before.workflowStatus };
  const mutation = assert.rejects(f.hub.call("hub_task_status_update", args), /explicitly interrupted/);
  await waitFor(() => optionalFile(running), "The live Git descendant was never started");
  assert.equal(await f.git(repositoryRoot, "rev-parse", "refs/heads/dev"), f.source.headCommit);
  const cancellation = await f.hub.call("hub_task_operation_cancel", {
    context_token: f.managerToken, request_id: "live-native-cancel", task_id: before.id,
    operation_request_id: requestId, expected_arguments_hash: f.catalog.mcpOperation(requestId).argumentsHash,
    expected_task_revision: before.revision, confirm_cancel: true,
  });
  await mutation;
  assert.equal(cancellation.phase, "stopped");
  assert.equal(cancellation.effects, "retained_unknown");
  assert.equal(f.tasks.lifecycleTransition(requestId).phase, "failed");
  assert.deepEqual(f.tasks.task(before.id), before);
  assert.equal(await f.git(repositoryRoot, "rev-parse", "refs/heads/dev"), f.source.headCommit);
  await delay(4100);
  assert.equal(await optionalFile(late), null);

  f.workspaces.snapshotAndMergeOwned = integrate;
  await writeFile(path.join(f.source.projectRoot, "source.txt"), "independently tested work\n");
  const next = await f.hub.call("hub_task_status_update", { ...args, request_id: "ordinary-test-after-stop" });
  assert.equal(next.workflowStatus, "testing");
  assert.equal(f.catalog.mcpOperation(args.request_id).taskExecution.cancellation.phase, "stopped");
  assert.equal(f.catalog.mcpOperation("ordinary-test-after-stop").status, "succeeded");
});
