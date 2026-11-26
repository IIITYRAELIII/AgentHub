import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskIntegrationGitService } from "../../src/infrastructure/filesystem/task-integration-git.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { withInterprocessLocks } from "../../src/infrastructure/process/interprocess-lock.mjs";
import { taskOperationExecutionStorage, taskOperationInterrupted } from "../../src/ports/task-operation-execution-context.mjs";

async function fixture(t, settings, withGit = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-ordinary-task-"));
  const raw = new TaskBoardStore({ databaseFile: path.join(root, "journal.sqlite") });
  t.after(async () => { raw.close(); await rm(root, { recursive: true, force: true }); });
  const workspace = { id: "ordinary", name: "Ordinary", settings, streams: [] };
  const workspaceCatalog = {
    hierarchy: () => [workspace], workspace: () => workspace,
    stream: () => { throw new Error("Stream context must not be required"); },
  };
  const events = [];
  const taskBoard = new TaskBoardService({ store: raw, workspaceCatalog,
    recordEvent: (...args) => events.push(args) });
  const task = raw.create({ text: "Database-only task", bucket: "workspace", workspaceId: workspace.id });
  const forbidden = () => { throw new Error("Git/release machinery must not run"); };
  const service = new TaskLifecycleService({ taskBoard, workspaceCatalog,
    taskGitWorkspaces: withGit ? {
      withTaskLock: forbidden, prepareOwned: forbidden, snapshotAndMergeOwned: forbidden,
      cleanupOwned: forbidden, cleanupPreview: forbidden,
    } : null,
    releasePreflight: { withAwaitTransition: forbidden, prepareAwaitSet: forbidden },
  });
  return { service, taskBoard, task, events };
}

for (const settings of [{ releaseWorkflowEnabled: false }, { releaseWorkflowEnabled: false, autoReviewEnabled: true }, {}, undefined]) {
  for (const withGit of [true, false]) test(`ordinary Task statuses need only SQLite (${JSON.stringify(settings)}, Git service ${withGit})`, async (t) => {
    const { service, taskBoard, task, events } = await fixture(t, settings, withGit);
    assert.equal(task.streamId, null);
    for (const status of ["testing", "awaiting_implementation", "done"]) {
      const before = taskBoard.task(task.id);
      const operationId = `ordinary-${status}`;
      const updated = await service.updateWorkflowStatus({ taskId: task.id, status, operationId });
      assert.equal(updated.workflowStatus, status);
      assert.equal(updated.revision, before.revision + 1);
      assert.deepEqual(updated.gitReferences, before.gitReferences);
      assert.equal(taskBoard.task(task.id).workflowStatus, status);
      assert.equal(taskBoard.lifecycleOutcome(operationId).result.task.workflowStatus, status);
    }
    assert.equal(events.length, 3);
    assert.deepEqual(events.map(([event]) => event.type), Array(3).fill("task.workflow-status.updated"));
  });
}

test("release-enabled Task still requires release preflight before changing status", async (t) => {
  const { service, taskBoard, task } = await fixture(t, { releaseWorkflowEnabled: true });
  await assert.rejects(service.updateWorkflowStatus({ taskId: task.id, status: "testing", operationId: "release" }),
    /Git\/release machinery must not run/u);
  assert.equal(taskBoard.task(task.id).workflowStatus, task.workflowStatus);
  assert.equal(taskBoard.lifecycleOutcome("release"), null);
});

test("workflow cutover CAS rejects a stale revision or status before lifecycle effects", async (t) => {
  const { service, taskBoard, task } = await fixture(t, { releaseWorkflowEnabled: false }, false);
  await assert.rejects(service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "stale-revision",
    expectedRevision: task.revision + 1,
    expectedWorkflowStatus: task.workflowStatus,
  }), /revision changed/u);
  await assert.rejects(service.updateWorkflowStatus({
    taskId: task.id,
    status: "awaiting_implementation",
    operationId: "stale-status",
    expectedRevision: task.revision,
    expectedWorkflowStatus: "testing",
  }), /status changed/u);
  assert.equal(taskBoard.task(task.id).revision, task.revision);
  assert.equal(taskBoard.lifecycleOutcome("stale-revision"), null);
  assert.equal(taskBoard.lifecycleOutcome("stale-status"), null);
});

test("detached Test permits same-repo Claim, rejects stale dev and preserves terminal ownership", {
  timeout: 240_000,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-test-lock-scopes-"));
  const raw = new TaskBoardStore({ databaseFile: path.join(root, "journal.sqlite") });
  t.after(async () => { raw.close(); await rm(root, { recursive: true, force: true }); });
  const run = promisify(execFile);
  const git = async (cwd, ...args) => (await run("git", args, { cwd, windowsHide: true })).stdout.trim();
  const commit = (cwd, message) => git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "commit", "-m", message);
  async function repository(name) {
    const dir = path.join(root, name);
    await mkdir(dir);
    await git(dir, "init", "-b", "main");
    await git(dir, "config", "core.autocrlf", "false");
    await writeFile(path.join(dir, "main.txt"), "base\n");
    await git(dir, "add", "main.txt");
    await commit(dir, "baseline");
    return dir;
  }

  const one = await repository("one");
  const two = await repository("two");
  const workspace = { id: "scoped", name: "Scoped", settings: { releaseWorkflowEnabled: true } };
  const catalog = { workspace: () => workspace, stream: () => null, hierarchy: () => [workspace] };
  const board = new TaskBoardService({ store: raw, workspaceCatalog: catalog });
  const timing = [];
  const firstStageStarted = Promise.withResolvers();
  const cancelledStageStarted = Promise.withResolvers();
  const workspaces = new TaskGitWorkspaceService({ dataDir: root, runtimeRoot: path.join(root, "runtime"),
    readPublication: async () => null, recordTiming: event => {
      timing.push(event);
      if (event.stage === "test-detached-stage" && event.phase === "start") {
        if (event.operationId === "first.txt") firstStageStarted.resolve();
        if (event.operationId === "cancelled.txt") cancelledStageStarted.resolve();
      }
    } });
  const release = new TaskIntegrationGitService({ dataDir: root, environment: {} });
  const service = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog,
    taskGitWorkspaces: workspaces,
    releasePreflight: { withAwaitTransition: () => assert.fail("Ordinary Test queued behind a held Await") },
  });
  async function prepare(file, projectRoot) {
    const task = raw.create({ text: file, bucket: "workspace", workspaceId: workspace.id });
    const checkout = await workspaces.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot });
    await writeFile(path.join(checkout.projectRoot, file), file + "\n");
    await git(checkout.projectRoot, "add", file);
    await commit(checkout.projectRoot, file);
    return { taskId: task.id, projectRoot, operationId: file, status: "testing", expectedRevision: task.revision };
  }
  const first = await prepare("first.txt", one);
  const same = await prepare("same.txt", one);
  const other = await prepare("other.txt", two);
  const cancelled = await prepare("cancelled.txt", one);
  const releaseHeld = Promise.withResolvers();
  const releaseFinish = Promise.withResolvers();
  const firstReachedTerminal = Promise.withResolvers();
  const firstCanCommit = Promise.withResolvers();
  const sameAdmitted = Promise.withResolvers();
  const active = [];
  const begin = board.beginLifecycleTransition.bind(board);
  board.beginLifecycleTransition = async request => {
    const result = await begin(request);
    if (request.operationId === same.operationId) sameAdmitted.resolve();
    return result;
  };
  const nativeTerminal = workspaces.withNativeIntegrationTerminalOwned.bind(workspaces);
  workspaces.withNativeIntegrationTerminalOwned = async (snapshot, options, callback) => {
    if (options.operationId === first.operationId) {
      firstReachedTerminal.resolve();
      await firstCanCommit.promise;
    }
    return nativeTerminal(snapshot, options, callback);
  };
  const awaitOwner = release.withAwaitTransition(workspace.id, async () => {
    releaseHeld.resolve();
    await releaseFinish.promise;
  });
  const poolHeld = Promise.withResolvers();
  const poolFinish = Promise.withResolvers();
  const poolOwner = withInterprocessLocks([path.join(root, "native-git-objects")], async () => {
    poolHeld.resolve();
    await poolFinish.promise;
  });
  const start = request => {
    const pending = service.updateWorkflowStatus(request);
    active.push(pending);
    pending.catch(error => {
      if (request === first) {
        firstStageStarted.reject(error);
        firstReachedTerminal.reject(error);
      }
      if (request === same) sameAdmitted.reject(error);
    });
    return pending;
  };
  try {
    await Promise.all([releaseHeld.promise, poolHeld.promise]);
    const firstTest = start(first);
    await firstStageStarted.promise;
    const before = await git(one, "rev-parse", "refs/heads/dev");
    const claimTask = raw.create({ text: "Same-repo Claim", bucket: "workspace", workspaceId: workspace.id });
    const checkout = await workspaces.prepare({ taskId: claimTask.id, projectRoot: one });
    assert.equal(checkout.headCommit, await git(one, "rev-parse", "refs/heads/main"));
    assert.equal(await git(one, "rev-parse", "refs/heads/dev"), before);
    assert.equal(board.lifecycleOutcome(first.operationId), null);
    assert.equal(timing.some(event => event.operationId === first.operationId
      && event.stage === "test-detached-stage" && event.phase === "end"), false);

    const controller = new AbortController();
    const cancellation = taskOperationExecutionStorage.run({
      operationId: cancelled.operationId, taskId: cancelled.taskId, signal: controller.signal,
      assertExecuting: () => controller.signal.throwIfAborted(),
    }, () => start(cancelled));
    const interruption = assert.rejects(cancellation, { code: "TASK_OPERATION_INTERRUPTED" });
    await Promise.race([cancelledStageStarted.promise, interruption.then(() => assert.fail("Cancelled Test never reached staging"))]);
    controller.abort(taskOperationInterrupted());
    await interruption;
    assert.equal(await git(one, "rev-parse", "refs/heads/dev"), before);
    assert.equal(board.lifecycleOutcome(cancelled.operationId), null);
    assert.equal(board.task(cancelled.taskId).revision, cancelled.expectedRevision);

    const devRoot = (await git(one, "worktree", "list", "--porcelain")).split(/\r?\n\r?\n/u)
      .find(entry => entry.includes("branch refs/heads/dev")).split(/\r?\n/u)[0].slice(9);
    // Advance the exact shared target with its repository owner while the
    // first stage is still pinned to the old commit.
    const advanced = await workspaces.withTaskLock(claimTask.id, lease =>
      workspaces.withTaskRepositoryRecoveryLock(claimTask.id, one, lease, async () => {
        await writeFile(path.join(devRoot, "intervening.txt"), "new dev\n");
        await git(devRoot, "add", "intervening.txt");
        await commit(devRoot, "intervening owned dev result");
        return git(devRoot, "rev-parse", "HEAD");
      }));
    poolFinish.resolve();
    await firstReachedTerminal.promise;
    const firstDev = await git(one, "rev-parse", "refs/heads/dev");
    const [firstParent] = (await git(one, "show", "-s", "--format=%P", firstDev)).split(" ");
    assert.equal(firstParent, advanced);
    assert.equal(timing.filter(event => event.operationId === first.operationId
      && event.stage === "test-detached-stage-stale").length, 1);
    const sameTest = start(same);
    await sameAdmitted.promise;
    const otherTest = await start(other);
    assert.equal(otherTest.task.workflowStatus, "testing");
    assert.equal(await git(one, "rev-parse", "refs/heads/dev"), firstDev);
    assert.equal(board.lifecycleOutcome(first.operationId), null);
    assert.equal(board.lifecycleOutcome(same.operationId), null);
    firstCanCommit.resolve();
    assert.equal((await firstTest).gitIntegration.devHeadCommit, firstDev);
    const then = await sameTest;
    assert.equal(then.task.workflowStatus, "testing");
    assert.equal(await git(one, "rev-parse", "refs/heads/dev"), then.gitIntegration.devHeadCommit);
    await git(one, "merge-base", "--is-ancestor", firstDev, then.gitIntegration.devHeadCommit);
    assert.equal(await git(one, "show", "dev:first.txt"), "first.txt");
    assert.equal(await git(one, "show", "dev:same.txt"), "same.txt");
    assert.equal(await git(two, "show", "dev:other.txt"), "other.txt");
    for (const request of [first, same, other]) {
      const events = timing.filter(event => event.operationId === request.operationId);
      const owned = events.filter(event => event.stage === "test-dev-owned" && event.phase === "end");
      const elapsed = events.find(event => event.stage === "workflow" && event.phase === "end");
      const wait = events.find(event => event.stage === "lock-acquired" && event.lockKind === "repository");
      const inputs = events.filter(event => event.stage === "test-dev-inputs" && event.phase === "end");
      const stages = events.filter(event => event.stage === "test-detached-stage" && event.phase === "end");
      const attempts = request === first ? 2 : 1;
      assert.equal(owned.length, attempts);
      assert.equal(inputs.length, attempts);
      assert.equal(stages.length, attempts);
      assert.equal(Number.isFinite(wait?.waitMs), true);
      assert.equal(events.some(event => event.stage === "await-transition"), false);
      const aliasSpans = events.filter(event => event.stage === "native:object-aliases" && event.phase === "end");
      assert.equal(aliasSpans.length, attempts);
      for (const event of aliasSpans) {
        assert.ok(stages.some(stage => stage.spanId < event.spanId));
        assert.ok(!owned.some(owner => owner.spanId < event.spanId && owner.at > event.at));
      }
      const aliasesOwner = events.find(event => event.stage === "trace-summary").stageAggregates
        .find(group => group.stage === "native:object-alias-owner");
      assert.ok(aliasesOwner.count > 0);
      assert.equal(board.lifecycleOutcome(request.operationId).result.task.workflowStatus, "testing");
      t.diagnostic(JSON.stringify({ operationId: request.operationId, elapsedMs: elapsed?.durationMs,
        repositoryWaitsMs: events.filter(event => event.stage === "lock-acquired" && event.lockKind === "repository")
          .map(event => event.waitMs),
        repositoryInputsMs: inputs.map(event => event.durationMs), detachedStagesMs: stages.map(event => event.durationMs),
        repositoryFinalMs: owned.map(event => event.durationMs), aliasesMs: aliasSpans.map(event => event.durationMs),
        aliasOwnerMs: aliasesOwner.inclusiveMs, aliases: aliasesOwner.count }));
    }
  } finally {
    firstCanCommit.resolve();
    releaseFinish.resolve();
    poolFinish.resolve();
    await Promise.allSettled([awaitOwner, poolOwner, ...active]);
  }
});
