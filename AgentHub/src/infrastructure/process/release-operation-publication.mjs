import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { processIsAlive } from "./process-liveness.mjs";
import { readPublicationState } from "../persistence/publication-state.mjs";
import { publicationRunStore } from "../persistence/publication-run-store.mjs";
import { releasePublicationBaseCommit } from "../../domain/release-base-provenance.mjs";

function identity(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function candidateFor(generation, target) {
  const repositoryRoot = String(target.repositoryRoot ?? "").trim();
  const matches = generation.candidates.filter((candidate) => (
    !repositoryRoot || path.resolve(candidate.repositoryRoot) === path.resolve(repositoryRoot)
  ));
  if (matches.length !== 1) throw new Error(`publication target ${target.targetId} has no unique candidate repository`);
  return matches[0];
}

function publicationFailure(saved, exitCode, targetId) {
  const error = new Error(
    String(saved?.error ?? "").trim()
      || `publication runner exited ${exitCode} without a complete target effect`,
  );
  const failedStep = saved?.steps?.find((step) => step.status === "failed")?.label
    ?? saved?.currentStep
    ?? null;
  const publicationIndex = saved?.steps?.findIndex((step) => step.label === "Публикация Git") ?? -1;
  const failedIndex = failedStep == null
    ? -1
    : saved?.steps?.findIndex((step) => step.label === failedStep) ?? -1;
  error.code = publicationIndex >= 0 && failedIndex >= 0 && failedIndex < publicationIndex
    ? "RELEASE_VALIDATION_FAILED"
    : "RELEASE_EXTERNAL_CONDITION";
  error.targetId = targetId;
  error.failedStep = failedStep;
  return error;
}

async function gitRemoteHead(candidate) {
  const checkout = await stat(candidate.releaseRoot).then(() => candidate.releaseRoot, error => {
    if (error.code !== "ENOENT") throw error;
    return candidate.repositoryRoot;
  });
  return new Promise((resolve) => {
    const child = spawn("git", ["ls-remote", "--exit-code", "origin", "refs/heads/main"], {
      cwd: checkout,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.once("error", () => resolve(null));
    child.once("exit", (code) => resolve(code === 0 ? stdout.trim().split(/\s/u)[0] : null));
  });
}

export class ReleaseOperationPublication {
  constructor({
    dataDir,
    runtimeRoot,
    environment = process.env,
    spawnImpl = spawn,
    readPublicationStateImpl = readPublicationState,
    publicationRunStoreFactory = publicationRunStore,
    processAliveImpl = processIsAlive,
    gitRemoteHeadImpl = gitRemoteHead,
    runnerFile = path.join(import.meta.dirname, "../../../release-operation-publication-runner.mjs"),
    now = () => new Date().toISOString(),
    launchGraceMs = 30_000,
  } = {}) {
    if (!String(dataDir ?? "").trim()) throw new TypeError("dataDir is required");
    if (!String(runtimeRoot ?? "").trim()) throw new TypeError("runtimeRoot is required");
    this.dataDir = path.resolve(dataDir);
    this.runtimeRoot = path.resolve(runtimeRoot);
    this.environment = environment;
    this.spawnImpl = spawnImpl;
    this.readPublicationState = readPublicationStateImpl;
    this.publicationRunStore = publicationRunStoreFactory;
    this.processAlive = processAliveImpl;
    this.gitRemoteHead = gitRemoteHeadImpl;
    this.runnerFile = path.resolve(runnerFile);
    this.now = now;
    this.launchGraceMs = Math.max(1_000, Number(launchGraceMs) || 30_000);
  }

  #layout(operation, generation, target) {
    const root = path.join(
      this.dataDir,
      "release-operation-executions",
      identity(`${operation.operationId}:${generation.generation}:${target.targetId}`),
    );
    return {
      root,
      stateFile: path.join(root, "runner.json"),
      resultFile: path.join(root, "result.json"),
      stdoutFile: path.join(root, "stdout.log"),
      stderrFile: path.join(root, "stderr.log"),
    };
  }

  async publish({ operation, generation, target }) {
    if (target.kind !== "agent-hub-publication") {
      const error = new Error(`unsupported release target kind: ${target.kind}`);
      error.code = "RELEASE_EXTERNAL_CONDITION";
      throw error;
    }
    const candidate = candidateFor(generation, target);
    const layout = this.#layout(operation, generation, target);
    await mkdir(layout.root, { recursive: true });
    const current = await this.readback({ operation, generation, target });
    if (["applied", "already_applied"].includes(current.status)) return current;
    if (current.status === "unknown") {
      const error = new Error(`publication runner for ${target.targetId} is still active or has an unknown effect`);
      error.code = "RELEASE_EXTERNAL_EFFECT_UNKNOWN";
      throw error;
    }
    const runner = this.runnerFile;
    const startedAt = this.now();
    const runnerIdentity = {
      schemaVersion: 1,
      pid: null,
      status: "launching",
      operationId: operation.operationId,
      generation: generation.generation,
      targetId: target.targetId,
      candidate: generation.identitySha256,
      startedAt,
    };
    await writeFile(layout.stateFile, `${JSON.stringify(runnerIdentity, null, 2)}\n`, "utf8");
    const stdout = await open(layout.stdoutFile, "a");
    const stderr = await open(layout.stderrFile, "a");
    const environment = { ...this.environment };
    // This worker is a publication, not a replacement startup. A completed
    // parent restart intent must not authorize its validation child processes.
    delete environment.AGENT_HUB_RESTART_OPERATION_ID;
    delete environment.AGENT_HUB_RESTART_LAUNCHER_PID;
    const child = this.spawnImpl(process.execPath, [runner], {
      cwd: path.join(candidate.releaseRoot, "AgentHub"),
      windowsHide: true,
      detached: true,
      stdio: ["ignore", stdout.fd, stderr.fd],
      env: {
        ...environment,
        AGENT_HUB_DATA_DIR: this.dataDir,
        AGENT_HUB_RUNTIME_ROOT: this.runtimeRoot,
        AGENT_HUB_RELEASE_OPERATION_ID: operation.operationId,
        AGENT_HUB_RELEASE_GENERATION: String(generation.generation),
        AGENT_HUB_RELEASE_TARGET_ID: target.targetId,
        AGENT_HUB_RELEASE_EXECUTION_ROOT: layout.root,
        AGENT_HUB_RELEASE_RUNNER_STARTED_AT: startedAt,
        AGENT_HUB_RELEASE_CANDIDATE_IDENTITY: generation.identitySha256,
      },
    });
    const completion = new Promise((resolve) => {
      child.once("error", (error) => resolve({ error }));
      child.once("exit", (code) => resolve({ exitCode: Number.isInteger(code) ? code : 1 }));
    });
    await writeFile(layout.stateFile, `${JSON.stringify({
      ...runnerIdentity,
      pid: child.pid,
      status: "running",
    }, null, 2)}\n`, "utf8");
    try {
      const outcome = await completion;
      await writeFile(layout.stateFile, `${JSON.stringify({
        ...runnerIdentity,
        pid: child.pid ?? null,
        status: outcome.error ? "launch_failed" : "exited",
        ...(outcome.error ? { error: outcome.error.message } : { exitCode: outcome.exitCode }),
        completedAt: this.now(),
      }, null, 2)}\n`, "utf8");
      if (outcome.error) throw outcome.error;
      const exitCode = outcome.exitCode;
      const readback = await this.readback({ operation, generation, target });
      if (["applied", "already_applied"].includes(readback.status)) return readback;
      if (readback.status === "partial") {
        const error = new Error(`publication runner for ${target.targetId} has a resumable partial effect`);
        error.code = "RELEASE_EXTERNAL_CONDITION";
        throw error;
      }
      if (readback.status === "unknown") {
        const error = new Error(`publication runner for ${target.targetId} has an unknown effect`);
        error.code = "RELEASE_EXTERNAL_EFFECT_UNKNOWN";
        throw error;
      }
      const saved = await this.publicationRunStore({
        runtimeRoot: layout.root,
        environment: this.environment,
      }).read().catch(() => null);
      throw publicationFailure(saved, exitCode, target.targetId);
    } finally {
      child.unref();
      await Promise.all([stdout.close(), stderr.close()]);
    }
  }

  async readback({ operation, generation, target }) {
    const candidate = candidateFor(generation, target);
    const layout = this.#layout(operation, generation, target);
    const runner = await readJson(layout.stateFile);
    if (runner?.candidate === generation.identitySha256 && this.processAlive(runner.pid)) {
      return { status: "unknown", cursor: { pid: runner.pid, stateFile: layout.stateFile } };
    }
    if (runner?.candidate === generation.identitySha256 && runner?.status === "launching") {
      return { status: "unknown", cursor: { phase: "launching", stateFile: layout.stateFile } };
    }
    const result = await readJson(layout.resultFile);
    if (result?.operationId === operation.operationId
        && result?.generation === generation.generation
        && result?.targetId === target.targetId
        && result?.candidate === generation.identitySha256
        && result?.status === "applied") return result;
    const publication = await this.readPublicationState().catch(() => null);
    const published = publication?.revision === candidate.commit
      || publication?.repositories?.some((repository) => (
        path.resolve(repository.root) === path.resolve(candidate.repositoryRoot)
          && repository.revision === candidate.commit
      ));
    if (published) return {
      status: "applied",
      revision: candidate.commit,
      source: "publication-state-readback",
    };
    const journal = this.publicationRunStore({ runtimeRoot: layout.root, environment: this.environment });
    const saved = await journal.read().catch(() => null);
    if (saved?.identity?.revision === candidate.commit && saved?.progress?.publicationState) {
      return { status: "partial", revision: candidate.commit, publicationStatus: saved.status };
    }
    const remote = await this.gitRemoteHead(candidate);
    if (remote === candidate.commit) return { status: "partial", revision: remote, source: "origin-readback" };
    if (candidate.manifest && candidate.manifest.baseCommit !== candidate.baseCommit) {
      throw new Error("publication candidate source base changed");
    }
    const publicationBase = releasePublicationBaseCommit({
      baseCommit: candidate.baseCommit, baseProvenance: candidate.manifest?.baseProvenance,
    });
    if (remote === publicationBase) return { status: "not_applied", revision: remote };
    return { status: "unknown", cursor: { remote, runner: runner?.pid ?? null, journalStatus: saved?.status ?? null } };
  }
}
