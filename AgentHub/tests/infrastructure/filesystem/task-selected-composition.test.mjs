import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";
import { runtimeDatabasePath } from "../../../src/infrastructure/persistence/runtime-state-store.mjs";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { releaseTaskNetProjections } from "../../../src/infrastructure/filesystem/release-task-net-projection.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { retainedLegacySelectedPreview, retainLegacySelectedOriginal } from "../../fixtures/legacy-selected-composition-fixture.mjs";

const exec = promisify(execFile);
const TASK_ID = "367ffe17-f69f-4886-b9be-901558ecace2";

test("retained selected Test proof survives its exact partial native publication but refuses foreign origin", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const preview = await retainedLegacySelectedPreview(f, { taskId: TASK_ID, expectedTaskRevision: 1,
    authority: { workspaceId: "workspace", streamId: "rm", provider: "codex", threadId: "thread", proofRequestId: "retained-published" } });
  await retainLegacySelectedOriginal(f, preview, "retained-published");
  await f.service.withTaskLock(TASK_ID, lease => f.service.applySelectedCompositionOwned(preview, { operationId: "retained-published", lease }));
  const tasks = [{ taskId: TASK_ID, taskRevision: 2, projectRoot: f.root,
    branch: f.taskWorkspace.branch, resultCommit: f.task,
    selectedCompositionRequired: true, selectedComposition: preview }];
  const evidence = () => f.service.releaseIntegrationEvidence({ projectRoot: f.root, tasks });
  await evidence();
  await git(f.root, "push", "-q", "origin", `${f.proof}:refs/heads/main`);
  await assert.rejects(evidence(), /remote advanced/u);
  const store = new ReleaseOperationStore({ dataDir: f.dataDir });
  const operation = store.create({ operationId: "native-partial", requestId: "native-partial", workspaceId: "workspace", streamId: "rm", threadId: "thread",
    authorization: { taskIds: [TASK_ID], approvedTargets: [{ id: "production", kind: "git-runtime" }], validationMode: "full" }, runnerVersion: "test" }).operation;
  const generation = store.putGeneration({ operationId: operation.operationId, generation: 1,
    repositoryBases: [{ repositoryRoot: f.root, baseCommit: f.local }], selectedResults: tasks,
    candidates: [{ repositoryRoot: f.root, releaseRoot: f.root, commit: f.proof, tree: f.tree, manifestHash: "a".repeat(64),
      manifest: { workspaceId: "workspace", compositionPolicy: "main-selected-git-merge-v1",
        baseProvenance: { publishedBaseCommit: f.published }, tasks } }], runnerVersion: "test" }).generation;
  const validation = store.beginStep({ operationId: operation.operationId, generation: 1, stepId: "validate", input: { candidate: f.proof } }).receipt;
  store.finishStep(validation, { status: "applied" });
  const database = new DatabaseSync(runtimeDatabasePath(f.dataDir));
  f.closeResources.push(() => database.close());
  // External owner's persisted shape. The installed store has no executable
  // native capability; the proof read must preserve these rows and receipts.
  const persisted = { ...operation, state: "publish", currentGeneration: 1, selectedResults: generation.selectedResults,
    authorization: { ...operation.authorization, nativeOwnerCutover: { schemaVersion: 1, kind: "native-publication-owner-v1" } } };
  const save = value => database.prepare("UPDATE release_operations SET state=?, operation_json=? WHERE operation_id=?")
    .run(value.state, JSON.stringify(value), operation.operationId);
  save(persisted);
  const rows = () => JSON.stringify({ operation: database.prepare("SELECT * FROM release_operations").all(),
    generations: database.prepare("SELECT * FROM release_candidate_generations").all(), receipts: database.prepare("SELECT * FROM release_step_receipts").all() });
  const before = rows();
  assert.equal((await evidence()).tasks[0].selectedComposition.previewHash, preview.previewHash);
  assert.equal(rows(), before);
  for (const changed of [ { ...persisted, state: "waiting", resumeState: "compose" },
    { ...persisted, workspaceId: "foreign" },
    { ...persisted, currentGeneration: 2 }, { ...persisted, authorization: { ...persisted.authorization, taskIds: ["foreign"] } },
    { ...persisted, selectedResults: [] }, { ...persisted, authorization: { ...persisted.authorization, nativeOwnerCutover: null } } ]) {
    save(changed); await assert.rejects(evidence(), /remote advanced/u);
  }
  save(persisted);
  await git(f.root, "update-ref", "refs/heads/foreign", f.proof);
  await git(f.root, "switch", "-q", "foreign");
  await writeFile(path.join(f.root, "foreign.txt"), "foreign\n");
  await git(f.root, "add", "-f", "foreign.txt");
  await git(f.root, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-q", "-m", "foreign");
  const foreign = await git(f.root, "rev-parse", "HEAD");
  await git(f.root, "push", "-q", "origin", `${foreign}:refs/heads/main`);
  await git(f.root, "switch", "-q", "main");
  await assert.rejects(evidence(), /remote advanced/u);
  assert.equal(rows(), before);
});

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "selected-owner-"));
  const closeResources = [];
  t.after(async () => {
    for (const close of closeResources.reverse()) await close();
    await rm(temp, { recursive: true, force: true });
  });
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
  return { root, remote, dataDir, service, taskWorkspace, devWorkspace, closeResources,
    base, local, published, task, dev, proof, tree, bundle, bundleSha256 };
}

async function lifecycleFixture(f) {
  const databaseFile = path.join(path.dirname(f.root), "task-board.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile, idFactory: () => TASK_ID });
  f.closeResources.push(() => { store.close(); catalog.close(); });
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
  const retainTransition = async (operationId) => {
    const preview = await retainedLegacySelectedPreview(f, input);
    await retainLegacySelectedOriginal(f, preview, operationId);
    // This is the durable pending transition from the pre-cutover original.
    // Recovery consumes it; the current fresh selected API remains closed.
    taskBoard.beginLifecycleTransition({ id: TASK_ID, operationId, kind: "workflow",
      targetWorkflowStatus: "testing", expectedRevision: revision,
      evidence: { selectedComposition: preview } });
    return preview;
  };
  const recover = operationId => f.service.withTaskRecoveryLock(TASK_ID, taskLease => (
    f.service.withTaskRepositoryRecoveryLock(TASK_ID, f.root, taskLease, lease => (
      lifecycle.reconcileUnknownWorkflowStatusOwned({ taskId: TASK_ID,
        operationId, projectRoot: f.root, guardId: null, lease })
    ))
  ));
  return { taskBoard, lifecycle, input, retainTransition, recover,
    close: () => { store.close(); catalog.close(); } };
}

test("retained v1 original completes after cutover while fresh preview and missing original refuse", { timeout: 90000 }, async (t) => {
  const f = await fixture(t);
  const input = { taskId: TASK_ID, expectedTaskRevision: 1, authority: {
    workspaceId: "workspace", streamId: "rm", provider: "codex",
    threadId: "thread", proofRequestId: "historical-preview",
  } };
  const preview = await retainedLegacySelectedPreview(f, input);
  await assert.rejects(f.service.withTaskLock(TASK_ID, lease => f.service.previewSelectedCompositionOwned({
    ...input, projectRoot: f.root, proofCommit: f.proof, bundlePath: f.bundle,
    bundleSha256: f.bundleSha256, lease,
  })), { code: "TASK_NATIVE_GIT_REQUIRED" });
  await assert.rejects(f.service.withTaskLock(TASK_ID, lease => f.service.applySelectedCompositionOwned(preview, {
    operationId: "missing-original", lease,
  })), { code: "TASK_NATIVE_GIT_REQUIRED" });
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  await retainLegacySelectedOriginal(f, preview, "retained-v1");
  const completed = await f.service.withTaskLock(TASK_ID, lease => f.service.applySelectedCompositionOwned(preview, {
    operationId: "retained-v1", lease,
  }));
  assert.equal(completed.status, "applied");
  const reopened = new TaskGitWorkspaceService({ dataDir: f.dataDir,
    readPublication: f.service.readPublication });
  const readback = await reopened.withTaskLock(TASK_ID, lease => reopened.readSelectedCompositionOwned(preview, {
    operationId: "retained-v1", lease,
  }));
  assert.equal(readback.status, "applied");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
});

test("retained v2 completion keeps its seal and refuses paired downgrade", { timeout: 90000 }, async t => {
  const f = await fixture(t);
  const preview = await retainedLegacySelectedPreview(f, { taskId: TASK_ID, expectedTaskRevision: 1,
    authority: { workspaceId: "workspace", streamId: "rm", provider: "codex", threadId: "thread", proofRequestId: "retained-v2" } });
  const operationId = "retained-v2";
  await retainLegacySelectedOriginal(f, preview, operationId, { version: 2 });
  await f.service.withTaskLock(TASK_ID, lease => f.service.applySelectedCompositionOwned(preview, { operationId, lease }));
  const root = path.join(f.dataDir, "task-selected-compositions", TASK_ID,
    path.basename(f.taskWorkspace.projectRoot), operationId);
  const files = ["intent.json", "completed.json", "materialization/record.json"].map(name => path.join(root, name));
  const bytes = await Promise.all(files.map(file => readFile(file)));
  const [intent, receipt, record] = bytes.map(value => JSON.parse(value));
  assert.deepEqual([intent.version, receipt.version, record.version], [2, 2, 2]);
  const head = await git(f.root, "rev-parse", "dev");
  const evidence = () => f.service.releaseIntegrationEvidence({ projectRoot: f.root,
    tasks: [{ taskId: TASK_ID, taskRevision: 1, projectRoot: f.root,
      branch: f.taskWorkspace.branch, resultCommit: f.task }] });
  const restore = () => Promise.all(files.map((file, index) => writeFile(file, bytes[index])));
  const write = values => Promise.all(files.map((file, index) => writeFile(file, JSON.stringify(values[index]))));
  await evidence();
  try {
    const tampered = structuredClone(record);
    tampered.files[0].newSha256 = "0".repeat(64);
    await write([intent, receipt, tampered]);
    await assert.rejects(evidence(), /historical materialization binding changed/u);
    await restore();
    const { materializationHash: _seal, ...unsealed } = receipt;
    for (const values of [[{ ...intent, version: 1 }, { ...receipt, version: 1 }, record],
      [{ ...intent, version: 1 }, { ...unsealed, version: 1 }, { ...record, version: 1 }]]) {
      await write(values);
      await assert.rejects(evidence(), /historical materialization version changed/u);
      await restore();
    }
    // A captured v2 physical serialization cannot be relabelled as v1. The
    // independent retained-v1 case exercises actual v1 data through its owner.
    await write([{ ...intent, version: 1 }, { ...unsealed, version: 1 },
      { ...record, version: 1, files: record.files.map(file => ({ ...file, oldSerialization: "raw" })) }]);
    await assert.rejects(evidence(), /historical materialization version changed/u);
  } finally { await restore(); }
  await evidence();
  assert.equal(await git(f.root, "rev-parse", "dev"), head);
  assert.equal(await git(f.root, "status", "--porcelain"), "");
});

test("retained selected proof has no live effect; late ignored collision preserves bytes and original op recovers", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const authority = { workspaceId: "workspace", streamId: "rm", provider: "codex",
    threadId: "thread", proofRequestId: "preview-1" };
  const preview = await retainedLegacySelectedPreview(f, {
    taskId: TASK_ID, expectedTaskRevision: 1, authority,
  });
  await retainLegacySelectedOriginal(f, preview, "confirm-1");
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

test("one selected operation recovers crashes before journal and completion publication", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const preview = await retainedLegacySelectedPreview(f, {
    taskId: TASK_ID, expectedTaskRevision: 1, authority: { workspaceId: "workspace", streamId: "rm",
      provider: "codex", threadId: "thread", proofRequestId: "preview-crash" },
  });
  const operationId = "confirm-crash";
  await retainLegacySelectedOriginal(f, preview, operationId);
  const root = path.join(f.dataDir, "task-selected-compositions", TASK_ID,
    path.basename(f.taskWorkspace.projectRoot), operationId);
  const journal = path.join(root, "materialization");
  await mkdir(journal, { recursive: true });
  await writeFile(path.join(root, "intent.json.tmp-00000000-0000-4000-8000-000000000000"), "{partial");
  await writeFile(path.join(journal, "new-0"), "partial staged bytes");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  const applied = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId, lease })
  ));
  assert.equal(applied.status, "applied");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  // Simulate a process ending after all exact Git effects but before the
  // atomic completed.json link becomes visible. A partial temp is not proof.
  await unlink(path.join(root, "completed.json"));
  await writeFile(path.join(root,
    "completed.json.tmp-00000000-0000-4000-8000-000000000000"), "{partial");
  const pending = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.readSelectedCompositionOwned(preview, { operationId, lease })
  ));
  assert.equal(pending.status, "after_cas");
  const recovered = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId, lease })
  ));
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.receipt.operationId, operationId);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
});

test("retained selected lifecycle enters Test only after exact Git CAS and durable Task result", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const { taskBoard, lifecycle, input, retainTransition, recover, close } = await lifecycleFixture(f);
  await assert.rejects(lifecycle.selectedComposition({ ...input, operationId: "fresh-preview" }),
    { code: "TASK_NATIVE_GIT_REQUIRED" });
  await retainTransition("selected-confirm");
  assert.equal(taskBoard.task(TASK_ID).workflowStatus, "in_progress");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  const { result: confirmed } = await recover("selected-confirm");
  assert.equal(confirmed.task.workflowStatus, "testing");
  assert.equal(confirmed.task.gitReferences[0].resultCommit, f.task);
  assert.equal(confirmed.gitReceipt.devCommit, f.proof);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
});

test("interrupted selected Test retains pending lifecycle and reconciles the same operation", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const { taskBoard, retainTransition, recover, close } = await lifecycleFixture(f);
  await retainTransition("selected-confirm");
  let inject = true;
  f.service.runCommand = async (args, options) => {
    const result = await runTaskGitCommand(args, options);
    if (inject && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
      inject = false;
      await writeFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "late private\n", { flag: "wx" });
    }
    return result;
  };
  await assert.rejects(recover("selected-confirm"), /EEXIST|foreign bytes/u);
  assert.equal(taskBoard.task(TASK_ID).workflowStatus, "in_progress");
  assert.equal(taskBoard.lifecycleTransition("selected-confirm").phase, "pending_git");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "utf8"),
    "late private\n");
  await unlink(path.join(f.devWorkspace.projectRoot, "feature.txt"));
  const recovered = await recover("selected-confirm");
  assert.equal(recovered.result.task.workflowStatus, "testing");
  assert.equal(recovered.result.task.gitReferences[0].resultCommit, f.task);
  assert.equal(taskBoard.lifecycleTransition("selected-confirm"), null);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
});

test("publication generation drift before CAS leaves dev and Task result untouched", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const preview = await retainedLegacySelectedPreview(f, {
    taskId: TASK_ID, expectedTaskRevision: 1, authority: { workspaceId: "workspace", streamId: "rm",
      provider: "codex", threadId: "thread", proofRequestId: "preview-drift" },
  });
  await retainLegacySelectedOriginal(f, preview, "confirm-drift");
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
