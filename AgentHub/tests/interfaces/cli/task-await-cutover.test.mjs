import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  executeTaskAwaitCutover,
  openTaskAwaitCutoverRuntime,
  parseTaskAwaitCutoverArguments,
} from "../../../task-await-cutover.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";

const execFileAsync = promisify(execFile);

async function git(cwd, ...args) {
  return String((await execFileAsync("git", args, { cwd, windowsHide: true })).stdout).trim();
}

async function gitCommit(cwd, message) {
  await git(cwd, "add", "-A");
  await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message);
  return git(cwd, "rev-parse", "HEAD");
}

const sha = "a".repeat(40);
const projectorSha = "b".repeat(64);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
}

function operationArgumentsHash(value) {
  return createHash("sha256").update(JSON.stringify(canonicalValue(value)), "utf8").digest("hex");
}

function withPrepareAwaitAcceptance(releasePreflight) {
  return {
    ...releasePreflight,
    async prepareAwaitAcceptance(options) {
      const validation = await releasePreflight.validateAwaitAcceptance(options);
      let committedResult;
      await releasePreflight.prepareAwaitSet({
        ...options,
        commitPrepared: async (prepared) => {
          committedResult = await options.commitPrepared({ ...prepared, task: validation.task });
          return committedResult;
        },
      });
      return committedResult;
    },
  };
}

function argumentsFixture() {
  return [
    "--workspace", "workspace-1",
    "--stream", "stream-1",
    "--provider", "codex",
    "--thread", "thread-1",
    "--task", "task-1",
    "--request", "cutover-1",
    "--repository", process.cwd(),
    "--expected-task-revision", "18",
    "--expected-source-commit", sha,
    "--expected-projector-sha256", projectorSha,
    "--confirm-cutover",
  ];
}

function crossTaskArgumentsFixture() {
  return [
    ...argumentsFixture().slice(0, -1),
    "--source-task", "source-task",
    "--expected-source-task-revision", "27",
    "--confirm-cutover",
  ];
}

function squashBootstrapArgumentsFixture({ confirm = false } = {}) {
  return [
    ...crossTaskArgumentsFixture().slice(0, -1),
    "--squash-bootstrap",
    "--baseline-result-commit", "c".repeat(40),
    "--new-result-commit", sha,
    "--dev-after-tree", "d".repeat(40),
    "--expected-source-tree", "e".repeat(40),
    "--expected-main-commit", "f".repeat(40),
    "--expected-dev-commit", "0".repeat(40),
    "--expected-preserved-tree", "1".repeat(40),
    "--source-zip", "source.zip", "--source-zip-sha256", "2".repeat(64),
    "--bundle", "source.bundle", "--bundle-sha256", "3".repeat(64),
    "--manifest", "manifest.json", "--manifest-sha256", "4".repeat(64),
    "--files", "files.json", "--files-sha256", "5".repeat(64),
    ...(confirm ? [
      "--proof-request", "bootstrap-preview",
      "--expected-transfer-hash", "6".repeat(64),
      "--expected-cutover-hash", "7".repeat(64),
      "--confirm-cutover",
    ] : []),
  ];
}

test("Await cutover requires immutable source, Task CAS and explicit confirmation", () => {
  const parsed = parseTaskAwaitCutoverArguments(argumentsFixture());
  assert.equal(parsed.expectedTaskRevision, 18);
  assert.equal(parsed.expectedSourceCommit, sha);
  assert.equal(parsed.expectedProjectorSha256, projectorSha);
  assert.equal(parsed.confirm, true);
  assert.throws(
    () => parseTaskAwaitCutoverArguments(argumentsFixture().slice(0, -1)),
    /confirm-cutover is required/u,
  );
});

test("Await cutover binds a separate source Task as an all-or-none identity", () => {
  const parsed = parseTaskAwaitCutoverArguments(crossTaskArgumentsFixture());
  assert.equal(parsed.sourceTaskId, "source-task");
  assert.equal(parsed.expectedSourceTaskRevision, 27);
  assert.throws(
    () => parseTaskAwaitCutoverArguments([
      ...argumentsFixture().slice(0, -1), "--source-task", "source-task", "--confirm-cutover",
    ]),
    /source-task.*expected-source-task-revision/u,
  );
});

test("squash bootstrap parser separates preview and confirmed execution receipts", () => {
  const preview = parseTaskAwaitCutoverArguments(squashBootstrapArgumentsFixture());
  assert.equal(preview.squashBootstrap, true);
  assert.equal(preview.confirm, false);
  assert.equal(preview.expectedSourceTree, "e".repeat(40));
  const confirmed = parseTaskAwaitCutoverArguments(squashBootstrapArgumentsFixture({ confirm: true }));
  assert.equal(confirmed.confirm, true);
  assert.equal(confirmed.proofRequestId, "bootstrap-preview");
  assert.throws(() => parseTaskAwaitCutoverArguments([
    ...squashBootstrapArgumentsFixture(), "--proof-request", "bootstrap-preview",
  ]), /confirmation requires/u);
});

test("squash bootstrap enters the supported cutover with exact artifact identity", async () => {
  const input = parseTaskAwaitCutoverArguments(squashBootstrapArgumentsFixture());
  const inspected = {
    sourceRoot: process.cwd(), headCommit: sha, headTree: input.expectedSourceTree,
    projectorRelativePath: "projector.mjs", projectorSha256: projectorSha,
    artifacts: input.expectedArtifacts,
  };
  const tasks = new Map([
    [input.taskId, { id: input.taskId, workspaceId: input.workspaceId, streamId: input.streamId,
      revision: input.expectedTaskRevision, workflowStatus: "in_progress", gitReferences: [] }],
    [input.sourceTaskId, { id: input.sourceTaskId, workspaceId: input.workspaceId, streamId: input.streamId,
      revision: input.expectedSourceTaskRevision, workflowStatus: "testing", gitReferences: [] }],
  ]);
  let mutation;
  const result = await executeTaskAwaitCutover(input, {
    inspectSource: async () => inspected,
    openRuntime: async () => ({
      service: {
        contextToken: () => "token",
        async call(name) {
          assert.equal(name, "hub_context_get");
          return { workspaceId: input.workspaceId, streamId: input.streamId };
        },
        async callTaskStatusCutover(args, { verifySource }) {
          mutation = args;
          assert.deepEqual(await verifySource(), inspected);
          return { confirmationRequired: true, transferHash: "6".repeat(64), cutoverHash: "7".repeat(64) };
        },
      },
      taskBoard: { task: (id) => tasks.get(id) },
      workspaceCatalog: {
        workspace: () => ({ id: input.workspaceId, settings: { workingDirectory: input.repositoryRoot } }),
        stream: () => ({ id: input.streamId, workspaceId: input.workspaceId, settings: {} }),
      },
      close() {},
    }),
  });
  assert.equal(result.result.cutoverHash, "7".repeat(64));
  assert.equal(mutation.status, "testing");
  assert.equal(mutation.expected_workflow_status, "in_progress");
  assert.equal(mutation.squash_source_task_id, input.sourceTaskId);
  assert.equal(mutation.squash_cutover_files_sha256, input.expectedArtifacts.filesSha256);
  assert.equal("expected_squash_transfer_hash" in mutation, false);
});

test("Await cutover default CLI runtime composes canonical release validation", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-await-default-preflight-"));
  let runtime = null;
  context.after(async () => {
    runtime?.close();
    await rm(root, { recursive: true, force: true });
  });
  const lease = { signal: null, async assertOwned() {} };
  const taskGitWorkspaces = {
    withTaskLock: (_taskId, operation) => operation(lease),
    prepareOwned: async () => { throw new Error("construction must not prepare Git"); },
    snapshotAndMergeOwned: async () => { throw new Error("construction must not snapshot Git"); },
    cleanupOwned: async () => { throw new Error("construction must not clean Git"); },
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], deleting: [] }),
    releaseEvidence: async () => [],
    assertExplicitUpstreamAdoption: async () => {},
    releaseIntegrationEvidence: async () => [],
  };
  const releaseGitWorkspaces = {
    assertPrimaryInvariant: async () => { throw new Error("construction must not inspect primary Git"); },
    inspectMainChanges: async () => { throw new Error("construction must not inspect main"); },
    prepareCandidate: async () => { throw new Error("construction must not prepare a candidate"); },
    withAwaitTransition: async (_workspaceId, operation) => operation(),
  };
  runtime = await openTaskAwaitCutoverRuntime({
    config: {
      dataDir: root,
      projectRoot: root,
      taskBoard: { autoPlaceConfidence: 0.82 },
      releaseValidation: { repositories: [] },
    },
    taskGitWorkspaces,
    releaseGitWorkspaces,
  });
  assert.ok(runtime.service);
});

test("Await cutover sends a separate source Task through the supported locked cutover", async () => {
  const input = parseTaskAwaitCutoverArguments(crossTaskArgumentsFixture());
  const calls = [];
  const sourceTask = {
    id: input.sourceTaskId, workspaceId: input.workspaceId, streamId: input.streamId,
    revision: input.expectedSourceTaskRevision, workflowStatus: "testing",
    gitReferences: [{ projectRoot: input.repositoryRoot, resultCommit: sha }],
  };
  const targetTask = {
    id: input.taskId, workspaceId: input.workspaceId, streamId: input.streamId,
    revision: input.expectedTaskRevision, workflowStatus: "testing",
    gitReferences: [{ projectRoot: input.repositoryRoot, resultCommit: "c".repeat(40) }],
  };
  const service = {
    contextToken() { return "token"; },
    async call(name) {
      assert.equal(name, "hub_context_get");
      return { workspaceId: input.workspaceId, streamId: input.streamId };
    },
    async callTaskStatusCutover(args, options) {
      calls.push({ args, options });
      assert.deepEqual(await options.verifySource(), { headCommit: sha, projectorSha256: projectorSha });
      return { id: input.taskId, revision: 19, workflowStatus: "awaiting_implementation" };
    },
  };
  const result = await executeTaskAwaitCutover(input, {
    inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
    openRuntime: async () => ({
      service,
      taskBoard: { task: (id) => id === sourceTask.id ? sourceTask : targetTask },
      workspaceCatalog: {
        workspace: () => ({ id: input.workspaceId, settings: { workingDirectory: input.repositoryRoot } }),
        stream: () => ({ id: input.streamId, workspaceId: input.workspaceId, settings: {} }),
      },
      close() {},
    }),
  });
  assert.equal(result.result.workflowStatus, "awaiting_implementation");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].args.cutover_source_task_id, sourceTask.id);
  assert.equal(calls[0].args.cutover_source_task_revision, sourceTask.revision);
  assert.equal(calls[0].args.task_id, targetTask.id);
});

test("Await cutover executes one canonical status mutation without startup replay", async () => {
  const input = parseTaskAwaitCutoverArguments(argumentsFixture());
  const calls = [];
  let closed = 0;
  const task = {
    id: input.taskId,
    workspaceId: input.workspaceId,
    streamId: input.streamId,
    revision: input.expectedTaskRevision,
    workflowStatus: "testing",
    gitReferences: [{ projectRoot: input.repositoryRoot, resultCommit: sha }],
  };
  const service = {
    contextToken(identity) { calls.push(["token", identity]); return "token"; },
    async call(name, args) {
      calls.push([name, args]);
      if (name === "hub_context_get") return { workspaceId: input.workspaceId, streamId: input.streamId };
      return { id: input.taskId, revision: 19, workflowStatus: "awaiting_implementation" };
    },
  };
  const result = await executeTaskAwaitCutover(input, {
    inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
    openRuntime: async () => ({
      service,
      taskBoard: { task: () => task },
      workspaceCatalog: {
        workspace: () => ({ id: input.workspaceId, settings: { workingDirectory: input.repositoryRoot } }),
        stream: () => ({ id: input.streamId, workspaceId: input.workspaceId, settings: {} }),
      },
      close() { closed += 1; },
    }),
  });
  assert.equal(result.result.workflowStatus, "awaiting_implementation");
  assert.deepEqual(calls.at(-1), ["hub_task_status_update", {
    context_token: "token",
    request_id: input.requestId,
    task_id: input.taskId,
    status: "awaiting_implementation",
    expected_task_revision: 18,
    expected_workflow_status: "testing",
    cutover_source_commit: sha,
    cutover_projector_sha256: projectorSha,
  }]);
  assert.equal(closed, 1);
});

test("Await cutover closes stores and performs no mutation after stale Task readback", async () => {
  const input = parseTaskAwaitCutoverArguments(argumentsFixture());
  const calls = [];
  let closed = 0;
  await assert.rejects(executeTaskAwaitCutover(input, {
    inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
    openRuntime: async () => ({
      service: {
        contextToken: () => "token",
        async call(name) { calls.push(name); return { workspaceId: input.workspaceId, streamId: input.streamId }; },
      },
      taskBoard: { task: () => ({
        id: input.taskId, workspaceId: input.workspaceId, streamId: input.streamId,
        revision: 19, workflowStatus: "testing",
      }) },
      workspaceCatalog: {},
      close() { closed += 1; },
    }),
  }), /revision or status changed/u);
  assert.deepEqual(calls, ["hub_context_get"]);
  assert.equal(closed, 1);
});

test("Await cutover rejects missing, mismatched or ambiguous Task result authority before mutation", async () => {
  const input = parseTaskAwaitCutoverArguments(argumentsFixture());
  for (const gitReferences of [
    [],
    [{ projectRoot: input.repositoryRoot, resultCommit: "c".repeat(40) }],
    [
      { projectRoot: input.repositoryRoot, resultCommit: sha },
      { projectRoot: input.repositoryRoot, resultCommit: sha },
    ],
  ]) {
    const calls = [];
    await assert.rejects(executeTaskAwaitCutover(input, {
      inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
      openRuntime: async () => ({
        service: {
          contextToken: () => "token",
          async call(name) {
            calls.push(name);
            return { workspaceId: input.workspaceId, streamId: input.streamId };
          },
        },
        taskBoard: { task: () => ({
          id: input.taskId, workspaceId: input.workspaceId, streamId: input.streamId,
          revision: input.expectedTaskRevision, workflowStatus: "testing", gitReferences,
        }) },
        workspaceCatalog: {
          workspace: () => ({ id: input.workspaceId, settings: { workingDirectory: input.repositoryRoot } }),
          stream: () => ({ id: input.streamId, workspaceId: input.workspaceId, settings: {} }),
        },
        close() {},
      }),
    }), /unique authoritative Task result/u);
    assert.deepEqual(calls, ["hub_context_get"]);
  }
});

test("disposable public squash bootstrap reaches real Test then canonical Await candidate", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-bootstrap-admission-"));
  const repositoryRoot = path.join(root, "repository");
  const reviewedRoot = path.join(root, "reviewed");
  const originRoot = path.join(root, "origin.git");
  const dataDir = path.join(root, "data");
  const databaseFile = path.join(dataDir, "journal.sqlite");
  await mkdir(repositoryRoot); await mkdir(dataDir); await mkdir(originRoot);
  await git(repositoryRoot, "init", "-b", "main");
  await git(repositoryRoot, "config", "core.autocrlf", "false");
  await writeFile(path.join(repositoryRoot, "app.txt"), "main\n");
  const main = await gitCommit(repositoryRoot, "main");
  await git(originRoot, "init", "--bare");
  await git(repositoryRoot, "remote", "add", "origin", originRoot);
  await git(repositoryRoot, "push", "-u", "origin", "main");

  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const tasks = new TaskBoardStore({ databaseFile });
  let runtime = null;
  t.after(async () => {
    runtime?.close();
    tasks.close(); catalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({
    name: "Agent HUB", settings: { releaseWorkflowEnabled: true, workingDirectory: repositoryRoot },
  }));
  const stream = await catalog.runMutation(() => catalog.createStream({
    workspaceId: workspace.id, name: "Release Manager", settings: { releaseManager: true },
  }));
  await catalog.runMutation(() => catalog.bindThread({ streamId: stream.id, provider: "codex",
    threadId: "thread-bootstrap", projectRoot: repositoryRoot }));
  const sourceCreated = tasks.create({ text: "Source", bucket: "workspace",
    workspaceId: workspace.id, taskPrefix: "HUB" });
  const survivorCreated = tasks.create({ text: "Survivor", bucket: "workspace",
    workspaceId: workspace.id, taskPrefix: "HUB" });
  for (const [task, turn] of [[sourceCreated, "source"], [survivorCreated, "survivor"]]) {
    tasks.claim(task.id, { workspaceId: workspace.id, streamId: stream.id, provider: "codex",
      threadId: "thread-bootstrap", turnId: `turn-${turn}`, operationId: `claim-${turn}` });
  }
  tasks.close(); catalog.close();

  const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir });
  let candidateBuilds = 0;
  const releasePreflight = withPrepareAwaitAcceptance({
    withAwaitTransition: async (_workspaceId, operation) => operation(),
    validateAwaitAcceptance: async ({ acceptingTask }) => ({
      planRevision: "validated-bootstrap-plan",
      task: { taskId: acceptingTask.id, resultCommit: newResult },
    }),
    prepareAwaitSet: async ({ workspaceId, acceptingTask = null, commitPrepared = null }) => {
      candidateBuilds += 1;
      const prepared = { workspaceId, planRevision: `plan-${candidateBuilds}`,
        taskIds: [survivorCreated.id], releaseCandidates: [{ repositoryRoot,
          preReleaseHead: newResult }] };
      if (commitPrepared) await commitPrepared(prepared);
      return prepared;
    },
    preflight: async () => ({}),
  });
  runtime = await openTaskAwaitCutoverRuntime({
    config: { dataDir, projectRoot: repositoryRoot, taskBoard: { autoPlaceConfidence: 0.82 } },
    taskGitWorkspaces, releasePreflight,
  });
  const sourceWorkspace = await taskGitWorkspaces.prepare({ taskId: sourceCreated.id,
    taskNumber: sourceCreated.taskNumber, projectRoot: repositoryRoot });
  await writeFile(path.join(sourceWorkspace.projectRoot, "source.txt"), "selected\n");
  await runtime.service.call("hub_task_status_update", { context_token: runtime.service.contextToken({
    provider: "codex", threadId: "thread-bootstrap", streamId: stream.id,
  }), request_id: "source-test", task_id: sourceCreated.id, status: "testing" });
  const survivorWorkspace = await taskGitWorkspaces.prepare({ taskId: survivorCreated.id,
    taskNumber: survivorCreated.taskNumber, projectRoot: repositoryRoot });
  await writeFile(path.join(survivorWorkspace.projectRoot, "residue.txt"), "excluded\n");
  const token = runtime.service.contextToken({ provider: "codex", threadId: "thread-bootstrap", streamId: stream.id });
  await runtime.service.call("hub_task_status_update", {
    context_token: token, request_id: "survivor-test", task_id: survivorCreated.id, status: "testing",
  });
  await runtime.service.call("hub_task_status_update", {
    context_token: token, request_id: "survivor-resume", task_id: survivorCreated.id, status: "in_progress",
  });
  const sourceTask = runtime.taskBoard.task(sourceCreated.id);
  const survivorTask = runtime.taskBoard.task(survivorCreated.id);
  const priorResult = survivorTask.gitReferences[0].resultCommit;

  await git(repositoryRoot, "clone", survivorWorkspace.projectRoot, reviewedRoot);
  await git(reviewedRoot, "config", "core.autocrlf", "false");
  await git(reviewedRoot, "checkout", "--detach", priorResult);
  await rm(path.join(reviewedRoot, "residue.txt"));
  await writeFile(path.join(reviewedRoot, "source.txt"), "selected\n");
  const baseline = await gitCommit(reviewedRoot, "reviewed baseline");
  await writeFile(path.join(reviewedRoot, "combined.txt"), "combined\n");
  const newResult = await gitCommit(reviewedRoot, "reviewed result");
  const sourceTree = await git(reviewedRoot, "rev-parse", "HEAD^{tree}");
  const dev = await taskGitWorkspaces.prepareDev(repositoryRoot);
  const devBefore = await git(dev.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(dev.projectRoot, "combined.txt"), "combined\n");
  await git(dev.projectRoot, "add", "combined.txt");
  const devAfterTree = await git(dev.projectRoot, "write-tree");
  await git(dev.projectRoot, "reset", "--hard", devBefore);
  await writeFile(path.join(survivorWorkspace.projectRoot, "approved-dirty.txt"), "preserved\n");
  await git(survivorWorkspace.projectRoot, "add", "-A");
  const preservedTree = await git(survivorWorkspace.projectRoot, "write-tree");
  await git(survivorWorkspace.projectRoot, "reset");
  const artifactPaths = {};
  const artifacts = {};
  for (const [name, field] of [["source.zip", "sourceZipSha256"], ["source.bundle", "bundleSha256"],
    ["manifest.json", "manifestSha256"], ["files.json", "filesSha256"]]) {
    const file = path.join(root, name); const bytes = `${name}\n`;
    await writeFile(file, bytes); artifactPaths[field] = file;
    artifacts[field] = createHash("sha256").update(bytes).digest("hex");
  }
  const inspected = { sourceRoot: reviewedRoot, headCommit: newResult, headTree: sourceTree,
    projectorSha256: projectorSha, artifacts };
  const common = {
    context_token: token, task_id: survivorCreated.id, status: "testing",
    expected_task_revision: survivorTask.revision, expected_workflow_status: "in_progress",
    cutover_source_commit: newResult, cutover_projector_sha256: projectorSha,
    squash_source_task_id: sourceCreated.id, squash_source_task_revision: sourceTask.revision,
    squash_baseline_result_commit: baseline, squash_new_result_commit: newResult,
    squash_dev_after_tree: devAfterTree, squash_cutover_source_tree: sourceTree,
    squash_cutover_expected_main_commit: main, squash_cutover_expected_dev_commit: devBefore,
    squash_cutover_expected_preserved_tree: preservedTree,
    squash_cutover_source_zip_sha256: artifacts.sourceZipSha256,
    squash_cutover_bundle_sha256: artifacts.bundleSha256,
    squash_cutover_manifest_sha256: artifacts.manifestSha256,
    squash_cutover_files_sha256: artifacts.filesSha256,
  };
  const preview = await runtime.service.callTaskStatusCutover({ ...common,
    request_id: "bootstrap-preview" }, { verifySource: async () => inspected });
  assert.equal(preview.confirmationRequired, true);
  const confirmed = await runtime.service.callTaskStatusCutover({ ...common,
    request_id: "bootstrap-confirm", squash_proof_request_id: "bootstrap-preview",
    expected_squash_transfer_hash: preview.transferHash,
    expected_squash_cutover_hash: preview.cutoverHash,
  }, { verifySource: async () => inspected });
  assert.equal(confirmed.task.workflowStatus, "testing");
  assert.equal(confirmed.sourceTask.workflowStatus, "in_progress");
  const awaited = await runtime.service.call("hub_task_status_update", { context_token: token,
    request_id: "survivor-await", task_id: survivorCreated.id, status: "awaiting_implementation",
    expected_task_revision: confirmed.task.revision, expected_workflow_status: "testing" });
  assert.equal(awaited.workflowStatus, "awaiting_implementation");
  assert.equal(awaited.releaseCandidate.status, "prepared");
  assert.equal(awaited.gitReferences[0].resultCommit, newResult);
  assert.equal(awaited.releaseCandidate.planRevision, "plan-1");
  assert.equal(candidateBuilds, 1);
  assert.equal(await readFile(path.join(survivorWorkspace.projectRoot, "approved-dirty.txt"), "utf8")
    .catch((error) => error.code), "ENOENT");
  assert.equal(await git(repositoryRoot, "rev-parse",
    `refs/agent-hub/task-squash-cutovers/${preview.cutoverHash}/preserved^{tree}`), preservedTree);
  void artifactPaths;
});

test("production cutover composer writes the canonical receipt and leaves unrelated pending work untouched", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-await-cutover-"));
  const repositoryRoot = path.join(root, "repository");
  const databaseFile = path.join(root, "journal.sqlite");
  const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
  await rawCatalog.load();
  const rawTasks = new TaskBoardStore({ databaseFile });
  let readCatalog = null;
  let readTasks = null;
  t.after(async () => {
    readTasks?.close();
    readCatalog?.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await rawCatalog.runMutation(() => rawCatalog.createWorkspace({
    name: "Agent HUB",
    settings: { releaseWorkflowEnabled: true, workingDirectory: repositoryRoot },
  }));
  const stream = await rawCatalog.runMutation(() => rawCatalog.createStream({
    workspaceId: workspace.id, name: "Release owner",
  }));
  await rawCatalog.runMutation(() => rawCatalog.bindThread({
    streamId: stream.id, provider: "codex", threadId: "thread-cutover", projectRoot: repositoryRoot,
  }));
  const created = rawTasks.create({
    text: "Release cutover", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  rawTasks.claim(created.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread-cutover", turnId: "turn-cutover", operationId: "claim-cutover",
  });
  const referenced = rawTasks.recordTaskGitReference({
    taskId: created.id,
    projectRoot: repositoryRoot,
    branch: "HUB-216",
    resultSnapshot: { repoRoot: repositoryRoot, tree: sha },
  });
  const testing = rawTasks.setWorkflowStatus(referenced.id, "testing");
  rawCatalog.beginMcpOperation({
    requestId: "unrelated-pending",
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cutover",
    toolName: "hub_task_update",
    argumentsHash: "d".repeat(64),
  });
  rawTasks.close();
  rawCatalog.close();

  const lease = { signal: null, async assertOwned() {} };
  const taskGitWorkspaces = {
    releaseEvidence: async () => [],
    withTaskLock: async (_taskId, operation) => operation(lease),
    withTaskRecoveryLock: async (_taskId, operation) => operation(lease),
    withTaskRepositoryRecoveryLock: async (_taskId, _projectRoot, _taskLease, operation) => operation(lease),
    prepareOwned: async () => ({ projectRoot: repositoryRoot }),
    snapshotAndMergeOwned: async () => ({
      snapshot: {
        branch: "HUB-216", projectRoot: repositoryRoot,
        repositoryRoot, baseCommit: "e".repeat(40), headCommit: sha,
      },
      integration: {
        outcome: "integrated", resultProved: true, integrated: true,
        dev: { branch: "dev", headCommit: "f".repeat(40) },
      },
    }),
    cleanupOwned: async () => {},
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], deleting: [] }),
  };
  const releasePreflight = withPrepareAwaitAcceptance({
    preflight: async () => ({}),
    withAwaitTransition: async (_workspaceId, operation) => operation(),
    validateAwaitAcceptance: async ({ acceptingTask }) => ({
      planRevision: "validated-cutover-plan",
      task: { taskId: acceptingTask.id, resultCommit: sha },
    }),
    prepareAwaitSet: async (options) => {
      const prepared = { workspaceId: workspace.id, planRevision: "plan-after-cutover", taskIds: [created.id], releaseCandidates: [] };
      await options.commitPrepared(prepared);
      return prepared;
    },
  });
  const input = {
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cutover",
    taskId: created.id,
    requestId: "exact-await-cutover",
    repositoryRoot,
    expectedSourceCommit: sha,
    expectedProjectorSha256: projectorSha,
    expectedTaskRevision: testing.revision,
    confirm: true,
  };
  const result = await executeTaskAwaitCutover(input, {
    inspectSource: async () => ({ headCommit: sha, projectorSha256: projectorSha }),
    openRuntime: () => openTaskAwaitCutoverRuntime({
      config: { dataDir: root, projectRoot: repositoryRoot, taskBoard: { autoPlaceConfidence: 0.82 } },
      taskGitWorkspaces,
      releasePreflight,
    }),
  });
  assert.equal(result.result.workflowStatus, "awaiting_implementation");
  assert.equal(result.result.releaseCandidate.status, "prepared");
  assert.equal(result.result.releaseCandidate.planRevision, "plan-after-cutover");

  readCatalog = new WorkspaceCatalogStore({ databaseFile });
  await readCatalog.load();
  readTasks = new TaskBoardStore({ databaseFile });
  assert.equal(readCatalog.mcpOperation("unrelated-pending").status, "pending");
  const receipt = readCatalog.mcpOperation(input.requestId);
  assert.equal(receipt.status, "succeeded");
  assert.equal(receipt.receiptState, "succeeded");
  assert.equal(receipt.toolName, "hub_task_status_update");
  assert.equal(readTasks.task(created.id).workflowStatus, "awaiting_implementation");
  assert.equal(readTasks.lifecycleOutcome(input.requestId).result.task.workflowStatus, "awaiting_implementation");
});

test("production cross-Task cutover stays in Test after candidate composition fails", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-await-cutover-rollback-"));
  const repositoryRoot = path.join(root, "repository");
  const databaseFile = path.join(root, "journal.sqlite");
  const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
  await rawCatalog.load();
  const rawTasks = new TaskBoardStore({ databaseFile });
  let runtime = null;
  t.after(async () => {
    runtime?.close();
    rawTasks.close();
    rawCatalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await rawCatalog.runMutation(() => rawCatalog.createWorkspace({
    name: "Agent HUB",
    settings: { releaseWorkflowEnabled: true, workingDirectory: repositoryRoot },
  }));
  const stream = await rawCatalog.runMutation(() => rawCatalog.createStream({
    workspaceId: workspace.id, name: "Release Manager", settings: { releaseManager: true },
  }));
  await rawCatalog.runMutation(() => rawCatalog.bindThread({
    streamId: stream.id, provider: "codex", threadId: "thread-cutover-rollback", projectRoot: repositoryRoot,
  }));
  const created = rawTasks.create({
    text: "Release cutover rollback", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  const sourceCreated = rawTasks.create({
    text: "Release cutover source", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  rawTasks.claim(created.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread-cutover-rollback", turnId: "turn-cutover-rollback", operationId: "claim-cutover-rollback",
  });
  const referenced = rawTasks.recordTaskGitReference({
    taskId: created.id,
    projectRoot: repositoryRoot,
    branch: "HUB-217",
    resultSnapshot: { repoRoot: repositoryRoot, tree: "c".repeat(40) },
  });
  const testing = rawTasks.setWorkflowStatus(referenced.id, "testing");
  rawTasks.claim(sourceCreated.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread-cutover-rollback", turnId: "turn-cutover-source", operationId: "claim-cutover-source",
  });
  const sourceReferenced = rawTasks.recordTaskGitReference({
    taskId: sourceCreated.id,
    projectRoot: repositoryRoot,
    branch: "HUB-216",
    resultSnapshot: { repoRoot: repositoryRoot, tree: sha },
  });
  const sourceTesting = rawTasks.setWorkflowStatus(sourceReferenced.id, "testing");
  rawTasks.close();
  rawCatalog.close();

  let snapshotCalls = 0;
  let multiLockDepth = 0;
  let sourceInspections = 0;
  const lease = { signal: null, async assertOwned() {} };
  const taskGitWorkspaces = {
    releaseEvidence: async () => [],
    withTaskLock: async () => { throw new Error("cross-Task cutover must not re-lock the target Task"); },
    withTaskLocks: async (taskIds, operation, options) => {
      assert.deepEqual(taskIds, [sourceCreated.id, created.id]);
      assert.equal(options.guardTaskId, created.id);
      multiLockDepth += 1;
      try { return await operation(lease); } finally { multiLockDepth -= 1; }
    },
    withTaskRecoveryLock: async (_taskId, operation) => operation(lease),
    withTaskRepositoryRecoveryLock: async (_taskId, _projectRoot, _taskLease, operation) => operation(lease),
    prepareOwned: async () => ({ projectRoot: repositoryRoot }),
    snapshotAndMergeOwned: async () => { snapshotCalls += 1; throw new Error("Await must reuse Test result"); },
    cleanupOwned: async () => {},
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], deleting: [] }),
  };
  const releasePreflight = withPrepareAwaitAcceptance({
    preflight: async () => ({}),
    withAwaitTransition: async (_workspaceId, operation) => operation(),
    validateAwaitAcceptance: async () => { throw new Error("injected PreRelease validation failure"); },
    prepareAwaitSet: async () => { throw new Error("injected PreRelease rebuild failure"); },
  });
  const openRuntime = () => openTaskAwaitCutoverRuntime({
    config: { dataDir: root, projectRoot: repositoryRoot, taskBoard: { autoPlaceConfidence: 0.82 } },
    taskGitWorkspaces,
    releasePreflight,
  });
  const requestId = "exact-await-cutover-rollback";
  const input = {
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-cutover-rollback",
    taskId: created.id,
    requestId,
    repositoryRoot,
    expectedSourceCommit: sha,
    expectedProjectorSha256: projectorSha,
    expectedTaskRevision: testing.revision,
    sourceTaskId: sourceCreated.id,
    expectedSourceTaskRevision: sourceTesting.revision,
    confirm: true,
  };
  await assert.rejects(executeTaskAwaitCutover(input, {
    inspectSource: async () => {
      sourceInspections += 1;
      if (sourceInspections === 2) assert.equal(multiLockDepth, 1);
      return { headCommit: sha, projectorSha256: projectorSha };
    },
    openRuntime,
  }), { code: "TASK_AWAIT_INTEGRATION_FAILED" });
  assert.equal(sourceInspections, 2);

  runtime = await openRuntime();
  assert.deepEqual(runtime.taskBoard.lifecycleTransition(requestId).evidence.cutoverSource, {
    taskId: sourceCreated.id,
    revision: sourceTesting.revision,
    workflowStatus: "testing",
    resultCommit: sha,
    projectorSha256: projectorSha,
    projectRoot: repositoryRoot,
  });
  assert.equal(runtime.workspaceCatalog.mcpOperation(requestId).receiptState, "failed");
  assert.equal(runtime.taskBoard.task(input.taskId).workflowStatus, "testing");
  assert.equal(runtime.taskBoard.task(sourceCreated.id).workflowStatus, "testing");
  assert.equal(runtime.taskBoard.lifecycleOutcome(requestId), null);
  assert.equal(snapshotCalls, 0);
});

test("production cross-Task pending recovery preserves its immutable source evidence", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-await-cutover-pending-"));
  const repositoryRoot = path.join(root, "repository");
  const databaseFile = path.join(root, "journal.sqlite");
  const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
  await rawCatalog.load();
  const rawTasks = new TaskBoardStore({ databaseFile });
  let runtime = null;
  t.after(async () => {
    runtime?.close();
    rawTasks.close();
    rawCatalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await rawCatalog.runMutation(() => rawCatalog.createWorkspace({
    name: "Agent HUB", settings: { releaseWorkflowEnabled: true, workingDirectory: repositoryRoot },
  }));
  const stream = await rawCatalog.runMutation(() => rawCatalog.createStream({
    workspaceId: workspace.id, name: "Release Manager", settings: { releaseManager: true },
  }));
  await rawCatalog.runMutation(() => rawCatalog.bindThread({
    streamId: stream.id, provider: "codex", threadId: "thread-cutover-pending", projectRoot: repositoryRoot,
  }));
  const targetCreated = rawTasks.create({
    text: "Pending recovery target", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  const sourceCreated = rawTasks.create({
    text: "Pending recovery source", bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB",
  });
  rawTasks.claim(targetCreated.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread-cutover-pending", turnId: "turn-target", operationId: "claim-target",
  });
  const targetReferenced = rawTasks.recordTaskGitReference({
    taskId: targetCreated.id, projectRoot: repositoryRoot, branch: "HUB-203",
    resultSnapshot: { repoRoot: repositoryRoot, tree: "c".repeat(40) },
  });
  const targetTesting = rawTasks.setWorkflowStatus(targetReferenced.id, "testing");
  rawTasks.claim(sourceCreated.id, {
    workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread-cutover-pending", turnId: "turn-source", operationId: "claim-source",
  });
  const sourceReferenced = rawTasks.recordTaskGitReference({
    taskId: sourceCreated.id, projectRoot: repositoryRoot, branch: "HUB-216",
    resultSnapshot: { repoRoot: repositoryRoot, tree: sha },
  });
  const sourceTesting = rawTasks.setWorkflowStatus(sourceReferenced.id, "testing");
  const requestId = "exact-cross-cutover-pending";
  const operationArguments = {
    request_id: requestId,
    task_id: targetCreated.id,
    status: "awaiting_implementation",
    expected_task_revision: targetTesting.revision,
    expected_workflow_status: "testing",
    cutover_source_commit: sha,
    cutover_projector_sha256: projectorSha,
    cutover_source_task_id: sourceCreated.id,
    cutover_source_task_revision: sourceTesting.revision,
  };
  await rawCatalog.runMutation(() => rawCatalog.beginMcpOperation({
    requestId, workspaceId: workspace.id, streamId: stream.id, provider: "codex",
    threadId: "thread-cutover-pending", toolName: "hub_task_status_update",
    argumentsHash: operationArgumentsHash(operationArguments),
  }));
  await rawCatalog.runMutation(() => rawCatalog.markMcpOperationUnknown(
    requestId, new Error("process tree stop is unproven"),
  ));
  const cutoverSource = {
    taskId: sourceCreated.id,
    revision: sourceTesting.revision,
    workflowStatus: "testing",
    resultCommit: sha,
    projectorSha256: projectorSha,
    projectRoot: repositoryRoot,
  };
  rawTasks.beginLifecycleTransition(targetCreated.id, {
    operationId: requestId,
    kind: "workflow",
    targetWorkflowStatus: "awaiting_implementation",
    expectedRevision: targetTesting.revision,
    evidence: { cutoverSource },
  });
  rawTasks.setWorkflowStatus(sourceCreated.id, "in_progress");
  rawTasks.close();
  rawCatalog.close();

  let recoverCalls = 0;
  let snapshotCalls = 0;
  const lease = { signal: null, async assertOwned() {}, repositoryLockKeys: new Set(["repository"]) };
  const taskGitWorkspaces = {
    releaseEvidence: async () => [],
    withTaskLock: async () => { throw new Error("pending recovery must retain its existing locks"); },
    withTaskRecoveryLock: async (_taskId, operation) => operation(lease),
    withTaskRepositoryRecoveryLock: async (_taskId, _root, _taskLease, operation) => operation(lease),
    recoverProcessTreeGuard: async (_taskId, options) => {
      recoverCalls += 1;
      assert.equal(options.guardId, "guard-pending-cross");
      return { recovered: true, proof: { kind: options.proof.kind, verifiedAt: "2026-09-12T13:23:40.000Z" } };
    },
    prepareOwned: async () => ({ projectRoot: repositoryRoot, branch: "HUB-203" }),
    snapshotAndMergeOwned: async () => { snapshotCalls += 1; throw new Error("Await recovery must reuse Test result"); },
    cleanupOwned: async () => {},
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], deleting: [] }),
  };
  runtime = await openTaskAwaitCutoverRuntime({
    config: { dataDir: root, projectRoot: repositoryRoot, taskBoard: { autoPlaceConfidence: 0.82 } },
    taskGitWorkspaces,
    releasePreflight: withPrepareAwaitAcceptance({
      preflight: async () => ({}),
      withAwaitTransition: async (_workspaceId, operation) => operation(),
      validateAwaitAcceptance: async ({ acceptingTask }) => ({
        planRevision: "pending-cross-validation",
        task: { taskId: acceptingTask.id, resultCommit: "c".repeat(40) },
      }),
      prepareAwaitSet: async (options) => {
        const prepared = { planRevision: "pending-cross-plan" };
        await options.commitPrepared(prepared);
        return prepared;
      },
    }),
  });
  const token = runtime.service.contextToken({
    provider: "codex", threadId: "thread-cutover-pending", streamId: stream.id,
  });
  const reconcile = {
    context_token: token,
    request_id: "reconcile-pending-cross",
    task_id: targetCreated.id,
    operation_request_id: requestId,
    project_root: repositoryRoot,
    guard_id: "guard-pending-cross",
    proof_kind: "system-restart-after-guard",
    proof_summary: "trusted boot is later than the exact guard",
    expected_task_revision: targetTesting.revision,
    expected_workflow_status: "testing",
    cutover_source_commit: sha,
    cutover_projector_sha256: projectorSha,
    cutover_source_task_id: sourceCreated.id,
    cutover_source_task_revision: sourceTesting.revision,
    confirm_reconcile: true,
  };
  await assert.rejects(runtime.service.call("hub_task_operation_reconcile", {
    ...reconcile,
    request_id: "reconcile-pending-cross-tampered",
    cutover_source_task_revision: sourceTesting.revision + 1,
  }), /identity.*CAS does not match/u);
  assert.equal(recoverCalls, 0);
  assert.equal(snapshotCalls, 0);

  const result = await runtime.service.call("hub_task_operation_reconcile", reconcile);
  assert.equal(result.outcome, "succeeded");
  assert.equal(runtime.workspaceCatalog.mcpOperation(requestId).receiptState, "succeeded");
  assert.equal(runtime.taskBoard.task(targetCreated.id).workflowStatus, "awaiting_implementation");
  assert.equal(runtime.taskBoard.task(sourceCreated.id).workflowStatus, "in_progress");
  assert.deepEqual(runtime.taskBoard.lifecycleOutcome(requestId).result.evidence.cutoverSource, cutoverSource);
  assert.equal(recoverCalls, 1);
  assert.equal(snapshotCalls, 0);
});

test("cross-Task cutover atomically rejects a settings race without changing the target", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-await-cutover-settings-race-"));
  const repositoryRoot = path.join(root, "repository");
  const databaseFile = path.join(root, "journal.sqlite");
  const rawCatalog = new WorkspaceCatalogStore({ databaseFile });
  await rawCatalog.load();
  const rawTasks = new TaskBoardStore({ databaseFile });
  let runtime = null;
  t.after(async () => {
    runtime?.close();
    rawTasks.close();
    rawCatalog.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspace = await rawCatalog.runMutation(() => rawCatalog.createWorkspace({
    name: "Agent HUB", settings: { releaseWorkflowEnabled: true, workingDirectory: repositoryRoot },
  }));
  const targetStream = await rawCatalog.runMutation(() => rawCatalog.createStream({
    workspaceId: workspace.id, name: "Release Manager", settings: { releaseManager: true },
  }));
  const sourceStream = await rawCatalog.runMutation(() => rawCatalog.createStream({
    workspaceId: workspace.id, name: "Release owner", settings: {},
  }));
  await rawCatalog.runMutation(() => rawCatalog.bindThread({
    streamId: targetStream.id, provider: "codex", threadId: "thread-settings-race", projectRoot: repositoryRoot,
  }));
  const tasks = [];
  for (const [title, branch, resultCommit, ownerStream] of [
    ["Race target", "HUB-203", "c".repeat(40), targetStream],
    ["Race source", "HUB-216", sha, sourceStream],
  ]) {
    const created = rawTasks.create({ text: title, bucket: "workspace", workspaceId: workspace.id, taskPrefix: "HUB" });
    rawTasks.claim(created.id, {
      workspaceId: workspace.id, streamId: ownerStream.id, provider: "codex",
      threadId: "thread-settings-race", turnId: `turn-${branch}`, operationId: `claim-${branch}`,
    });
    const referenced = rawTasks.recordTaskGitReference({
      taskId: created.id, projectRoot: repositoryRoot, branch,
      resultSnapshot: { repoRoot: repositoryRoot, tree: resultCommit },
    });
    tasks.push(rawTasks.setWorkflowStatus(referenced.id, "testing"));
  }
  rawTasks.close();
  rawCatalog.close();
  const [target, source] = tasks;
  const lease = { signal: null, async assertOwned() {} };
  const taskGitWorkspaces = {
    releaseEvidence: async () => [],
    withTaskLock: async () => { throw new Error("cross-Task cutover must not use one Task lock"); },
    withTaskLocks: async (_ids, operation) => operation(lease),
    prepareOwned: async () => { throw new Error("settings race must fail before Git preparation"); },
    snapshotAndMergeOwned: async () => { throw new Error("settings race must fail before Git snapshot"); },
    cleanupOwned: async () => {},
    cleanupPreview: async () => ({ workspaces: [], gitReferences: [], deleting: [] }),
  };
  const openRuntime = () => openTaskAwaitCutoverRuntime({
    config: { dataDir: root, projectRoot: repositoryRoot, taskBoard: { autoPlaceConfidence: 0.82 } },
    taskGitWorkspaces,
    releasePreflight: {
      preflight: async () => ({}),
      withAwaitTransition: async (_workspaceId, operation) => operation(),
      prepareAwaitSet: async () => ({ planRevision: "unexpected" }),
    },
  });
  let inspections = 0;
  await assert.rejects(executeTaskAwaitCutover({
    workspaceId: workspace.id,
    streamId: targetStream.id,
    provider: "codex",
    threadId: "thread-settings-race",
    taskId: target.id,
    requestId: "cross-cutover-settings-race",
    repositoryRoot,
    expectedSourceCommit: sha,
    expectedProjectorSha256: projectorSha,
    expectedTaskRevision: target.revision,
    sourceTaskId: source.id,
    expectedSourceTaskRevision: source.revision,
    confirm: true,
  }, {
    inspectSource: async () => {
      inspections += 1;
      if (inspections === 2) {
        const mutator = new WorkspaceCatalogStore({ databaseFile });
        await mutator.load();
        await mutator.runMutation(() => mutator.updateStreamSettings(sourceStream.id, {
          workingDirectory: path.join(root, "moved-repository"),
        }));
        mutator.close();
      }
      return { headCommit: sha, projectorSha256: projectorSha };
    },
    openRuntime,
  }), /release context changed/u);
  runtime = await openRuntime();
  assert.equal(runtime.taskBoard.task(target.id).workflowStatus, "testing");
  assert.equal(runtime.taskBoard.task(target.id).revision, target.revision);
  assert.equal(runtime.taskBoard.lifecycleTransition("cross-cutover-settings-race"), null);
});
