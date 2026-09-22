import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";

function identity(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

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

test("publication readback waits through the spawn-to-pid crash window", async (t) => {
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
    now: () => "2026-09-22T00:00:05.000Z",
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
