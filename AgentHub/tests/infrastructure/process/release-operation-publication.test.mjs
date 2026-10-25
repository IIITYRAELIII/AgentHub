import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { releaseOperationPublicationArguments, releaseOperationRuntimePublicationInput } from "../../../release-operation-publication-runner.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { agentHubCalendarVersion } from "../../../src/infrastructure/filesystem/release-version.mjs";
import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";

const execute = promisify(execFile);

test("runtime receipt wiring preserves original generation and refuses a mismatched frozen candidate", () => {
  const operation = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe" };
  const generation = { operationId: operation.operationId, generation: 2 };
  const candidate = { commit: "a".repeat(40), manifest: { publication: {
    head: "a".repeat(40), releaseVersion: "2026.8.24", runtimeReleaseVersion: "2026.8.24.8",
  } } };
  assert.deepEqual(releaseOperationRuntimePublicationInput({ operation, generation, candidate }), {
    operationId: operation.operationId, generation: 2, sourceCommit: candidate.commit, version: "2026.8.24.8",
  });
  for (const changed of [
    { ...candidate, commit: "b".repeat(40) },
    { ...candidate, manifest: { publication: { ...candidate.manifest.publication, runtimeReleaseVersion: "2026.8.25.8" } } },
    { ...candidate, manifest: { publication: { ...candidate.manifest.publication, runtimeReleaseVersion: ["2026.8.24.8"] } } },
  ]) assert.throws(() => releaseOperationRuntimePublicationInput({ operation, generation, candidate: changed }), /binding differs/u);
  assert.throws(() => releaseOperationRuntimePublicationInput({ operation,
    generation: { ...generation, operationId: "other" }, candidate }), /binding differs/u);
  assert.equal(releaseOperationRuntimePublicationInput({ operation, generation,
    candidate: { commit: candidate.commit, manifest: { publication: { releaseVersion: "2026.8.24" } } } }), null);
});

async function git(cwd, ...args) {
  return (await execute("git", args, { cwd, encoding: "utf8", windowsHide: true })).stdout.trim();
}

function identity(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

test("stable publication runner preserves the initiating Stream and Thread for start and resume", () => {
  const operation = {
    workspaceId: "workspace-1",
    streamId: "stream-initiator",
    threadId: "thread-initiator",
    authorization: { validationMode: "full" },
  };
  const candidate = { baseCommit: "base-commit" };
  assert.deepEqual(releaseOperationPublicationArguments({ operation, candidate, saved: null }), [
    "--workspace", "workspace-1",
    "--stream", "stream-initiator",
    "--thread", "thread-initiator",
    "--from", "base-commit",
    "--full-tests",
  ]);
  assert.deepEqual(releaseOperationPublicationArguments({
    operation: { ...operation, authorization: { validationMode: "focused" } },
    candidate,
    saved: { status: "failed" },
  }), [
    "--resume",
    "--workspace", "workspace-1",
    "--stream", "stream-initiator",
    "--thread", "thread-initiator",
    "--from", "base-commit",
    "--validation=focused",
  ]);
  assert.deepEqual(releaseOperationPublicationArguments({
    operation: { ...operation, authorization: { validationMode: "quick" } },
    candidate,
  }), [
    "--workspace", "workspace-1",
    "--stream", "stream-initiator",
    "--thread", "thread-initiator",
    "--from", "base-commit",
    "--quick",
  ]);
});

test("stable runner refuses publication when the exact generation lacks the required contour", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-runner-process-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const remote = path.join(root, "origin.git");
  const primary = path.join(root, "primary");
  const taskRoot = path.join(root, "task");
  await git(root, "init", "--bare", "--initial-branch=main", remote);
  await git(root, "clone", remote, primary);
  await git(primary, "config", "user.name", "Agent Hub Test");
  await git(primary, "config", "user.email", "agent-hub@example.invalid");
  await mkdir(path.join(primary, "AgentHub"), { recursive: true });
  const releaseVersion = agentHubCalendarVersion();
  await writeFile(path.join(primary, "AgentHub", "package.json"), `${JSON.stringify({
    name: "agent-hub", version: releaseVersion, private: true,
    scripts: { check: "node -e \"process.exit(0)\"" },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(primary, "AgentHub", "package-lock.json"), `${JSON.stringify({
    name: "agent-hub",
    version: releaseVersion,
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "agent-hub", version: releaseVersion } },
  }, null, 2)}\n`, "utf8");
  await writeFile(path.join(primary, "CHANGELOG.md"), "base notes\n", "utf8");
  await git(primary, "add", ".");
  await git(primary, "commit", "-m", "base");
  await git(primary, "push", "-u", "origin", "main");
  const baseCommit = await git(primary, "rev-parse", "HEAD");
  await git(primary, "worktree", "add", "-b", "HUB-runner-process", taskRoot, "main");
  await writeFile(path.join(taskRoot, "AgentHub", "task.txt"), "Task result\n", "utf8");
  await git(taskRoot, "add", "AgentHub/task.txt");
  await git(taskRoot, "commit", "-m", "task result");
  const resultCommit = await git(taskRoot, "rev-parse", "HEAD");
  const generationWorkspaces = new ReleaseGitWorkspaceService({ dataDir: path.join(root, "generation-data") });
  const frozenTasks = [{ taskId: "task-process", taskRevision: 3, baseCommit, resultCommit,
    integrations: [{ commit: resultCommit, parent: baseCommit, order: 1 }] }];
  const prepared = await generationWorkspaces.prepareCandidate({ planRevision: "plan-process",
    projectRoot: primary, workspaceId: "workspace-process", approvedBaseCommit: baseCommit, frozenTasks });
  const changelogContent = Buffer.from("release notes\n");
  await writeFile(path.join(prepared.releaseRoot, "CHANGELOG.md"), changelogContent);
  await git(prepared.releaseRoot, "add", "CHANGELOG.md");
  const candidate = await generationWorkspaces.prepareGeneration({
    operationId: "operation-process",
    generation: 1,
    planRevision: "plan-process",
    projectRoot: primary,
    workspaceId: "workspace-process",
    approvedBaseCommit: baseCommit,
    frozenTasks,
    changelogContent,
  });
  const dataDir = path.join(root, "operation-data");
  await mkdir(dataDir, { recursive: true });
  const store = new ReleaseOperationStore({ dataDir, idFactory: () => "operation-process" });
  const target = { targetId: "production", kind: "agent-hub-publication", repositoryRoot: primary };
  const operation = store.create({
    requestId: "runner-process-request",
    workspaceId: "workspace-process",
    streamId: "stream-process",
    threadId: "thread-process",
    authorization: { taskIds: ["task-process"], approvedTargets: [target], validationMode: "focused" },
    runnerVersion: "runner-process",
  }).operation;
  const generation = store.putGeneration({
    operationId: operation.operationId,
    generation: 1,
    repositoryBases: [{ repositoryRoot: primary, baseCommit }],
    selectedResults: [{
      taskId: "task-process", resultCommit, tree: await git(taskRoot, "rev-parse", `${resultCommit}^{tree}`),
      acceptanceRevision: 3,
    }],
    candidates: [{
      repositoryRoot: primary,
      releaseRoot: candidate.releaseRoot,
      generationRoot: candidate.generationRoot,
      commit: candidate.preReleaseHead,
      tree: candidate.tree,
      manifestHash: candidate.manifestHash,
      planRevision: candidate.planRevision,
      baseCommit: candidate.baseCommit,
      frozenTasks: candidate.frozenTasks,
      manifest: candidate.manifest,
    }],
    sourceFingerprint: "runner-process-source",
    runnerVersion: "runner-process",
    createdAt: "2026-09-23T00:00:00.000Z",
  }).generation;
  const publication = new ReleaseOperationPublication({
    dataDir,
    runtimeRoot: path.join(root, "runtime"),
    environment: { ...process.env, LOCALAPPDATA: path.join(root, "local-app-data") },
    runnerFile: path.resolve("release-operation-publication-runner.mjs"),
  });
  await assert.rejects(publication.publish({ operation, generation, target }), {
    code: "RELEASE_VALIDATION_FAILED",
  });
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), baseCommit);
  const effect = await publication.readback({ operation, generation, target });
  assert.equal(effect.status, "not_applied");
  assert.equal(effect.revision, baseCommit);
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "HEAD"), candidate.preReleaseHead);
  assert.equal(await git(candidate.releaseRoot, "status", "--porcelain", "--untracked-files=no"), "");
});

test("publication launches the stable owner runner and reads its exact generation effect", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-publication-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  await mkdir(path.join(candidateRoot, "AgentHub"), { recursive: true });
  const operation = { operationId: "operation-1" };
  const generation = {
    generation: 2,
    identitySha256: "candidate-sha",
    candidates: [{
      repositoryRoot: candidateRoot,
      releaseRoot: candidateRoot,
      commit: "published-commit",
      baseCommit: "base-commit",
    }],
  };
  const target = { targetId: "production", kind: "agent-hub-publication", repositoryRoot: candidateRoot };
  const runnerFile = path.join(root, "stable-owner", "release-operation-publication-runner.mjs");
  const executionRoot = path.join(root, "data", "release-operation-executions", identity("operation-1:2:production"));
  const spawnCalls = [];
  const publication = new ReleaseOperationPublication({
    dataDir: path.join(root, "data"),
    runtimeRoot: path.join(root, "runtime"),
    runnerFile,
    environment: { AGENT_HUB_RESTART_OPERATION_ID: "completed-parent-restart",
      AGENT_HUB_RESTART_LAUNCHER_PID: "123", SYNTHETIC_KEEP: "retained" },
    readPublicationStateImpl: async () => null,
    gitRemoteHeadImpl: async () => "base-commit",
    processAliveImpl: () => false,
    publicationRunStoreFactory: () => ({ read: async () => null }),
    spawnImpl: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      const child = new EventEmitter();
      child.pid = 321;
      child.unref = () => {};
      queueMicrotask(async () => {
        await writeFile(path.join(executionRoot, "result.json"), `${JSON.stringify({
          operationId: operation.operationId,
          generation: generation.generation,
          targetId: target.targetId,
          candidate: generation.identitySha256,
          status: "applied",
          revision: "published-commit",
        })}\n`, "utf8");
        child.emit("exit", 0);
      });
      return child;
    },
  });

  const result = await publication.publish({ operation, generation, target });
  assert.equal(result.status, "applied");
  assert.equal(spawnCalls.length, 1);
  assert.equal(path.resolve(spawnCalls[0].args[0]), path.resolve(runnerFile));
  assert.notEqual(path.dirname(spawnCalls[0].args[0]), path.join(candidateRoot, "AgentHub", "src", "runtime"));
  assert.equal(spawnCalls[0].options.cwd, path.join(candidateRoot, "AgentHub"));
  assert.equal(spawnCalls[0].options.detached, true);
  assert.equal(spawnCalls[0].options.windowsHide, true);
  assert.equal(spawnCalls[0].options.env.AGENT_HUB_RESTART_OPERATION_ID, undefined);
  assert.equal(spawnCalls[0].options.env.AGENT_HUB_RESTART_LAUNCHER_PID, undefined);
  assert.equal(spawnCalls[0].options.env.SYNTHETIC_KEEP, "retained");
});

test("publication readback stays unknown while the exact runner is alive", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-publication-running-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  await mkdir(candidateRoot, { recursive: true });
  const operation = { operationId: "operation-running" };
  const generation = {
    generation: 1,
    identitySha256: "candidate-running",
    candidates: [{ repositoryRoot: candidateRoot, releaseRoot: candidateRoot, commit: "next", baseCommit: "base" }],
  };
  const target = { targetId: "production", kind: "agent-hub-publication", repositoryRoot: candidateRoot };
  const executionRoot = path.join(root, "data", "release-operation-executions", identity("operation-running:1:production"));
  await mkdir(executionRoot, { recursive: true });
  await writeFile(path.join(executionRoot, "runner.json"), `${JSON.stringify({
    pid: 987, candidate: generation.identitySha256,
  })}\n`, "utf8");
  const publication = new ReleaseOperationPublication({
    dataDir: path.join(root, "data"), runtimeRoot: path.join(root, "runtime"),
    readPublicationStateImpl: async () => null,
    gitRemoteHeadImpl: async () => "base",
    processAliveImpl: (pid) => pid === 987,
    publicationRunStoreFactory: () => ({ read: async () => null }),
  });
  assert.deepEqual(await publication.readback({ operation, generation, target }), {
    status: "unknown", cursor: { pid: 987, stateFile: path.join(executionRoot, "runner.json") },
  });
});

test("publication readback keeps an unsettled spawn-to-pid window unknown without a time cutoff", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-publication-launching-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  await mkdir(candidateRoot, { recursive: true });
  const operation = { operationId: "operation-launching" };
  const generation = {
    generation: 1,
    identitySha256: "candidate-launching",
    candidates: [{ repositoryRoot: candidateRoot, releaseRoot: candidateRoot, commit: "next", baseCommit: "base" }],
  };
  const target = { targetId: "production", kind: "agent-hub-publication", repositoryRoot: candidateRoot };
  const executionRoot = path.join(root, "data", "release-operation-executions", identity("operation-launching:1:production"));
  await mkdir(executionRoot, { recursive: true });
  await writeFile(path.join(executionRoot, "runner.json"), `${JSON.stringify({
    status: "launching",
    pid: null,
    candidate: generation.identitySha256,
    startedAt: "2026-09-22T00:00:00.000Z",
  })}\n`, "utf8");
  const publication = new ReleaseOperationPublication({
    dataDir: path.join(root, "data"),
    runtimeRoot: path.join(root, "runtime"),
    now: () => "2026-09-22T01:00:05.000Z",
    launchGraceMs: 30_000,
    readPublicationStateImpl: async () => null,
    gitRemoteHeadImpl: async () => "base",
    processAliveImpl: () => false,
    publicationRunStoreFactory: () => ({ read: async () => null }),
  });
  assert.deepEqual(await publication.readback({ operation, generation, target }), {
    status: "unknown",
    cursor: { phase: "launching", stateFile: path.join(executionRoot, "runner.json") },
  });
});

for (const [event, value] of [["exit", 1], ["error", new Error("spawn failed immediately")]]) {
  test(`publication observes an immediate runner ${event} before persisting its pid`, async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), `release-operation-publication-early-${event}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const candidateRoot = path.join(root, "candidate");
    await mkdir(path.join(candidateRoot, "AgentHub"), { recursive: true });
    const operation = { operationId: `operation-early-${event}` };
    const generation = {
      generation: 1,
      identitySha256: `candidate-early-${event}`,
      candidates: [{ repositoryRoot: candidateRoot, releaseRoot: candidateRoot, commit: "next", baseCommit: "base" }],
    };
    const target = { targetId: "production", kind: "agent-hub-publication", repositoryRoot: candidateRoot };
    const publication = new ReleaseOperationPublication({
      dataDir: path.join(root, "data"), runtimeRoot: path.join(root, "runtime"),
      runnerFile: path.join(root, "runner.mjs"),
      readPublicationStateImpl: async () => null,
      gitRemoteHeadImpl: async () => "base",
      processAliveImpl: () => false,
      publicationRunStoreFactory: () => ({ read: async () => null }),
      spawnImpl: () => {
        const child = new EventEmitter();
        child.pid = 4321;
        child.unref = () => {};
        queueMicrotask(() => child.emit(event, value));
        return child;
      },
    });
    await assert.rejects(publication.publish({ operation, generation, target }), event === "error"
      ? /spawn failed immediately/u
      : /runner exited 1/u);
  });
}

test("publication classifies a failed pre-effect pipeline step as validation failure", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-operation-publication-validation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidateRoot = path.join(root, "candidate");
  await mkdir(path.join(candidateRoot, "AgentHub"), { recursive: true });
  const operation = { operationId: "operation-validation" };
  const generation = {
    generation: 1,
    identitySha256: "candidate-validation",
    candidates: [{ repositoryRoot: candidateRoot, releaseRoot: candidateRoot, commit: "next", baseCommit: "base" }],
  };
  const target = { targetId: "production", kind: "agent-hub-publication", repositoryRoot: candidateRoot };
  const saved = {
    status: "failed",
    error: "contract test failed",
    currentStep: null,
    progress: {},
    steps: [
      { label: "Контракт интерфейсов Agent Hub", status: "failed" },
      { label: "Публикация Git", status: "pending" },
    ],
  };
  const publication = new ReleaseOperationPublication({
    dataDir: path.join(root, "data"),
    runtimeRoot: path.join(root, "runtime"),
    runnerFile: path.join(root, "runner.mjs"),
    readPublicationStateImpl: async () => null,
    gitRemoteHeadImpl: async () => "base",
    processAliveImpl: () => false,
    publicationRunStoreFactory: () => ({ read: async () => saved }),
    spawnImpl: () => {
      const child = new EventEmitter();
      child.pid = 654;
      child.unref = () => {};
      setTimeout(() => child.emit("exit", 1), 10);
      return child;
    },
  });
  await assert.rejects(
    publication.publish({ operation, generation, target }),
    (error) => error.code === "RELEASE_VALIDATION_FAILED"
      && error.message === "contract test failed"
      && error.failedStep === "Контракт интерфейсов Agent Hub",
  );
});
