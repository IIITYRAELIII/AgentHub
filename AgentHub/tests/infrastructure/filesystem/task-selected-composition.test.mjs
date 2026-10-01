import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { releaseTaskNetProjections } from "../../../src/infrastructure/filesystem/release-task-net-projection.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

const exec = promisify(execFile);
const TASK_ID = "367ffe17-f69f-4886-b9be-901558ecace2";

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "selected-owner-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repository");
  const remote = path.join(temp, "remote.git");
  const dataDir = path.join(temp, "data");
  await git(temp, "init", "--bare", "-q", remote);
  await git(temp, "init", "-q", "-b", "main", root);
  await git(root, "remote", "add", "origin", remote);
  const commit = async (cwd, message, { forced = null } = {}) => {
    await git(cwd, "add", "-A");
    if (forced) await git(cwd, "add", "-f", forced);
    await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  await writeFile(path.join(root, ".gitignore"), "feature.txt\n");
  await writeFile(path.join(root, "conflict.txt"), "base\n");
  const base = await commit(root, "base");
  const service = new TaskGitWorkspaceService({ dataDir,
    readPublication: async () => ({ generation: "generation-1",
      repositories: [{ root, revision: published }] }) });
  // The closure above is first used after the published commit is initialized.
  const taskWorkspace = await service.prepare({ taskId: TASK_ID, projectRoot: root });
  const devWorkspace = await service.prepareDev(root);
  await git(root, "switch", "-q", "-c", "published");
  await writeFile(path.join(root, "conflict.txt"), "published\n");
  const published = await commit(root, "published");
  await git(root, "push", "-q", "origin", `${published}:refs/heads/main`);
  await git(root, "switch", "-q", "main");
  await writeFile(path.join(root, "local.txt"), "approved local\n");
  const local = await commit(root, "local");
  await git(taskWorkspace.projectRoot, "merge", "--ff-only", local);
  await git(devWorkspace.projectRoot, "merge", "--ff-only", local);
  await writeFile(path.join(taskWorkspace.projectRoot, "feature.txt"), "selected feature\n");
  await commit(taskWorkspace.projectRoot, "Task feature", { forced: "feature.txt" });
  await git(taskWorkspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "-m", "published side", published);
  const task = await git(taskWorkspace.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(devWorkspace.projectRoot, "conflict.txt"), "dev\n");
  await writeFile(path.join(devWorkspace.projectRoot, "unselected.txt"), "unselected\n");
  const dev = await commit(devWorkspace.projectRoot, "dev unselected");
  const baselineOutput = await runTaskGitCommand(["merge-tree", "--write-tree", dev, task], {
    cwd: root, acceptableExitCodes: [1],
  });
  const baselineTree = baselineOutput.split(/\r?\n/u)[0];
  assert.match(baselineTree, /^[0-9a-f]{40}$/u);
  await writeFile(path.join(root, "resolution.txt"), "reviewed\n");
  const resolvedBlob = await git(root, "hash-object", "-w", "resolution.txt");
  await unlink(path.join(root, "resolution.txt"));
  const index = path.join(temp, "proof.index");
  const indexGit = async (...args) => (await exec("git", args, {
    cwd: root, env: { ...process.env, GIT_INDEX_FILE: index },
  })).stdout.trim();
  await indexGit("read-tree", baselineTree);
  await indexGit("update-index", "--add", "--cacheinfo", "100644", resolvedBlob, "conflict.txt");
  const tree = await indexGit("write-tree");
  const proof = (await exec("git", ["commit-tree", tree, "-p", dev, "-p", task,
    "-m", "reviewed selected composition"], {
    cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  })).stdout.trim();
  await git(root, "update-ref", "refs/review/selected", proof);
  const bundle = path.join(temp, "review.bundle");
  await git(root, "bundle", "create", bundle, "refs/review/selected");
  const bundleSha256 = createHash("sha256").update(await readFile(bundle)).digest("hex");
  assert.equal(await git(root, "rev-parse", "main"), local);
  assert.equal(await git(root, "rev-parse", "dev"), dev);
  return { root, remote, dataDir, service, taskWorkspace, devWorkspace,
    base, local, published, task, dev, proof, tree, bundle, bundleSha256 };
}

async function lifecycleFixture(f) {
  const databaseFile = path.join(path.dirname(f.root), "task-board.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile, idFactory: () => TASK_ID });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({
    name: "Selected composition", settings: { workingDirectory: f.root,
      releaseWorkflowEnabled: true },
  }));
  const workspaceCatalog = { workspace: () => workspace, stream: () => null,
    hierarchy: () => [workspace] };
  const taskBoard = new TaskBoardService({ store, workspaceCatalog });
  store.create({ text: "Selected release Task", bucket: "workspace", workspaceId: workspace.id });
  store.setWorkflowStatus(TASK_ID, "in_progress");
  const revision = taskBoard.task(TASK_ID).revision;
  const lifecycle = new TaskLifecycleService({ taskBoard, workspaceCatalog,
    taskGitWorkspaces: f.service,
    releasePreflight: { withAwaitTransition: (_id, action) => action() },
  });
  const input = { taskId: TASK_ID, expectedTaskRevision: revision, projectRoot: f.root,
    bundlePath: f.bundle, bundleSha256: f.bundleSha256, proofCommit: f.proof,
    authority: { workspaceId: workspace.id, streamId: "rm", provider: "codex",
      threadId: "thread", proofRequestId: "selected-preview" },
  };
  return { taskBoard, lifecycle, input, close: () => { store.close(); catalog.close(); } };
}

test("selected owner preview has no live effect; late ignored collision preserves bytes and original op recovers", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const authority = { workspaceId: "workspace", streamId: "rm", provider: "codex",
    threadId: "thread", proofRequestId: "preview-1" };
  const preview = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.previewSelectedCompositionOwned({
      taskId: TASK_ID, projectRoot: f.root, proofCommit: f.proof,
      bundlePath: f.bundle, bundleSha256: f.bundleSha256,
      expectedTaskRevision: 1, authority, lease,
    })
  ));
  assert.equal(preview.proofTree, f.tree);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  assert.equal(await git(f.root, "rev-parse", "main"), f.local);
  let inject = true;
  f.service.runCommand = async (args, options) => {
    const result = await runTaskGitCommand(args, options);
    if (inject && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
      inject = false;
      await writeFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "private ignored\n", { flag: "wx" });
    }
    return result;
  };
  await assert.rejects(f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId: "confirm-1", lease })
  )), /EEXIST|foreign bytes/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "utf8"),
    "private ignored\n");
  const pending = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.readSelectedCompositionOwned(preview, { operationId: "confirm-1", lease })
  ));
  assert.equal(pending.status, "after_cas");
  await unlink(path.join(f.devWorkspace.projectRoot, "feature.txt"));
  const completed = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId: "confirm-1", lease })
  ));
  assert.equal(completed.status, "applied");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "unselected.txt"), "utf8"),
    "unselected\n");
  assert.equal(await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId: "confirm-1", lease })
  )).then((value) => value.status), "applied");
  const evidence = await f.service.releaseIntegrationEvidence({ projectRoot: f.root,
    tasks: [{ taskId: TASK_ID, taskRevision: 2, projectRoot: f.root,
      branch: f.taskWorkspace.branch, resultCommit: f.task }],
  });
  assert.equal(evidence.tasks[0].selectedComposition.previewHash, preview.previewHash);
  const projections = await releaseTaskNetProjections({ tasks: evidence.tasks,
    baseCommit: f.published,
    git: (args, options) => runTaskGitCommand(args, { ...options, cwd: f.root }),
  });
  const selected = projections.get(TASK_ID);
  assert.equal(selected.parent, f.published);
  assert.equal(selected.commit, f.task);
  assert.ok(selected.paths.includes("feature.txt"));
  assert.ok(!selected.paths.includes("unselected.txt"));
  const candidate = path.join(path.dirname(f.root), "selected-release-candidate");
  await git(path.dirname(f.root), "clone", "--quiet", "--no-checkout", f.root, candidate);
  await git(candidate, "checkout", "--quiet", "--detach", f.published);
  const patch = await runTaskGitCommand(["diff", "--binary", "--full-index",
    selected.parent, selected.commit, "--", ".", ":(exclude,glob)**/CHANGELOG.md",
    ":(exclude)CHANGELOG.md"], { cwd: candidate, rawOutput: true });
  await runTaskGitCommand(["apply", "--index", "--whitespace=nowarn", "-"], {
    cwd: candidate, input: patch,
  });
  assert.equal((await readFile(path.join(candidate, "feature.txt"), "utf8"))
    .replace(/\r\n/gu, "\n"), "selected feature\n");
  await assert.rejects(readFile(path.join(candidate, "unselected.txt")), { code: "ENOENT" });
});

test("selected composition enters Test only after exact Git CAS and durable Task result", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const { taskBoard, lifecycle, input, close } = await lifecycleFixture(f);
  const preview = await lifecycle.selectedComposition({ ...input, operationId: "selected-preview" });
  assert.equal(preview.confirmationRequired, true);
  assert.equal(taskBoard.task(TASK_ID).workflowStatus, "in_progress");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  const confirmed = await lifecycle.selectedComposition({ ...input, operationId: "selected-confirm",
    expectedPreviewHash: preview.previewHash });
  assert.equal(confirmed.task.workflowStatus, "testing");
  assert.equal(confirmed.task.gitReferences[0].resultCommit, f.task);
  assert.equal(confirmed.gitReceipt.devCommit, f.proof);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  close();
});

test("interrupted selected Test retains pending lifecycle and reconciles the same operation", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const { taskBoard, lifecycle, input, close } = await lifecycleFixture(f);
  const preview = await lifecycle.selectedComposition({ ...input, operationId: "selected-preview" });
  let inject = true;
  f.service.runCommand = async (args, options) => {
    const result = await runTaskGitCommand(args, options);
    if (inject && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
      inject = false;
      await writeFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "late private\n", { flag: "wx" });
    }
    return result;
  };
  await assert.rejects(lifecycle.selectedComposition({ ...input, operationId: "selected-confirm",
    expectedPreviewHash: preview.previewHash }), { code: "TASK_SELECTED_COMPOSITION_UNKNOWN" });
  assert.equal(taskBoard.task(TASK_ID).workflowStatus, "in_progress");
  assert.equal(taskBoard.lifecycleTransition("selected-confirm").phase, "pending_git");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "utf8"),
    "late private\n");
  await unlink(path.join(f.devWorkspace.projectRoot, "feature.txt"));
  const recovered = await f.service.withTaskRecoveryLock(TASK_ID, (taskLease) => (
    f.service.withTaskRepositoryRecoveryLock(TASK_ID, f.root, taskLease, (lease) => (
      lifecycle.reconcileUnknownWorkflowStatusOwned({ taskId: TASK_ID,
        operationId: "selected-confirm", projectRoot: f.root, guardId: null, lease })
    ))
  ));
  assert.equal(recovered.result.task.workflowStatus, "testing");
  assert.equal(recovered.result.task.gitReferences[0].resultCommit, f.task);
  assert.equal(taskBoard.lifecycleTransition("selected-confirm"), null);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  close();
});

test("publication generation drift before CAS leaves dev and Task result untouched", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const preview = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.previewSelectedCompositionOwned({ taskId: TASK_ID, projectRoot: f.root,
      proofCommit: f.proof, bundlePath: f.bundle, bundleSha256: f.bundleSha256,
      expectedTaskRevision: 1, authority: { workspaceId: "workspace", streamId: "rm",
        provider: "codex", threadId: "thread", proofRequestId: "preview-drift" }, lease })
  ));
  f.service.readPublication = async () => ({ generation: "generation-2",
    repositories: [{ root: f.root, revision: f.published }] });
  await assert.rejects(f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId: "confirm-drift", lease })
  )), { code: "SELECTED_COMPOSITION_NO_EFFECT" });
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  assert.equal(await git(f.root, "for-each-ref", "--format=%(refname)",
    "refs/agent-hub/task-results/"), "");
});
