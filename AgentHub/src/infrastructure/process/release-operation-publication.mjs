import { ownedGitArguments } from "../filesystem/preparation-git-isolation.mjs";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, lstat, writeFile, realpath, readdir } from "node:fs/promises";
import path from "node:path";

import { processIsAlive } from "./process-liveness.mjs";
import { readPublicationState } from "../persistence/publication-state.mjs";
import { publicationRunStore, failedFrozenPublicationEvidence } from "../persistence/publication-run-store.mjs";
import { PUBLIC_INSTALLER_HANDOFF, readPublicationCheckpoint } from "../persistence/publication-checkpoint.mjs";
import { PUBLIC_RUNTIME_INSTALLATION } from "../../domain/public-runtime-installation.mjs";
import { releaseIdentitySha256 } from "../../domain/release-operation.mjs";
import { releasePublicationBaseCommit } from "../../domain/release-base-provenance.mjs";
import { readReleaseToolPackage } from "./release-tool-package.mjs";
import { readArtifact, createPublicationArtifactSteps } from "./publication-artifacts.mjs";
import { withPublicationLock } from "./publication-lock.mjs";
import { artifactVersionIdentity } from "../../domain/agent-hub-version.mjs";
import { parseGitHubRemote } from "../persistence/github-publication-baseline.mjs";
import { assertReleaseCloneForPublication } from "../filesystem/release-git-workspace.mjs";
import { measureTaskOperation } from "./task-operation-timing.mjs";
import { verifyRuntimeManifest } from "../filesystem/runtime-manifest-verifier.mjs";
import { withRuntimeInstallationLease, readRuntimePointer, captureRuntimeReleaseBinding } from "../filesystem/runtime-installation-custody.mjs";
import { createPublicRuntimeInstaller, publicRuntimeInstallerBinding, readPublishedRuntimePackage } from "./public-runtime-installer.mjs";

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

function distributionIntentReadback(saved, candidate) {
  if (!saved || saved.identity?.revision !== candidate.commit
    || !saved.progress || typeof saved.progress !== "object" || Array.isArray(saved.progress)) {
    return { status: "unknown", cursor: { reason: "distribution journal is missing or does not bind the candidate" } };
  }
  if (!Object.hasOwn(saved.progress, "githubDistribution")) return null;
  const intent = saved.progress.githubDistribution;
  if (!intent || typeof intent !== "object" || Array.isArray(intent)
    || !/^[a-f0-9]{64}$/u.test(intent.inputIdentity ?? "")
    || typeof intent.createStarted !== "boolean"
    || !intent.uploads || typeof intent.uploads !== "object" || Array.isArray(intent.uploads)) {
    return { status: "unknown", cursor: { reason: "distribution intent is incomplete" } };
  }
  if (intent.tagStarted || intent.createStarted || intent.releaseId != null
    || Object.keys(intent.uploads).length || Object.hasOwn(intent, "status") || Object.hasOwn(intent, "result")) {
    return { status: "partial", revision: candidate.commit, publicationStatus: saved.status,
      source: "original-github-distribution-intent" };
  }
  const fields = new Set(["inputIdentity", "createStarted", "uploads", "tagStarted", "releaseId"]);
  if (Object.keys(intent).some(key => !fields.has(key))
    || intent.tagStarted !== undefined && intent.tagStarted !== false) {
    return { status: "unknown", cursor: { reason: "distribution pre-effect intent is not recognized" } };
  }
  return null;
}

async function gitRemoteHead(candidate) {
  // The immutable clone deliberately has no remotes. The registered repository
  // owns origin; ls-remote only observes it and does not change primary Git state.
  return new Promise((resolve) => {
    const child = spawn("git", ownedGitArguments(["ls-remote", "--exit-code", "origin", "refs/heads/main"]), {
      cwd: candidate.repositoryRoot,
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

// A retired candidate checkout need not exist. Prove absence from the COMPLETE
// current origin ancestry, without fetching or depending on the old object.
async function candidateAbsentFromRemote(candidate, remote) {
  const git = promisify(execFile);
  const options = { encoding: "utf8", windowsHide: true, maxBuffer: Infinity };
  const args = ["--no-replace-objects", "--no-optional-locks", "-C", candidate.repositoryRoot];
  const run = async tail => (await git("git", ownedGitArguments([...args, ...tail]), options)).stdout.trim();
  try {
    if (process.env.GIT_SHALLOW_FILE || process.env.GIT_GRAFT_FILE
        || await run(["rev-parse", "--is-shallow-repository"]) !== "false") return false;
    const common = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const grafts = await lstat(path.join(common, "info", "grafts")).catch(error => {
      if (error.code === "ENOENT") return null; throw error;
    });
    if (grafts) return false;
    return await new Promise(resolve => {
      const child = spawn("git", ownedGitArguments([...args, "rev-list", "--parents", remote, "--"]), {
        windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
      });
      const commits = new Set(), missingParents = new Set();
      let pending = "", valid = true;
      const row = line => {
        const [commit, ...parents] = line.trim().split(/\s+/u);
        if (![commit, ...parents].every(oid => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(oid))
            || commits.has(commit) || !commits.size && commit !== remote) { valid = false; return; }
        commits.add(commit); missingParents.delete(commit);
        for (const parent of parents) if (!commits.has(parent)) missingParents.add(parent);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", chunk => {
        pending += chunk;
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          row(pending.slice(0, end)); pending = pending.slice(end + 1);
        }
      });
      child.once("error", () => resolve(false));
      child.once("close", code => {
        if (pending) row(pending);
        resolve(code === 0 && valid && commits.size > 0 && missingParents.size === 0 && !commits.has(candidate.commit));
      });
    });
  } catch { return false; }
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
    candidateAbsentFromRemoteImpl = candidateAbsentFromRemote,
    readPublicationCheckpointImpl = readPublicationCheckpoint,
    readToolPackage = readReleaseToolPackage,
    createArtifactSteps = createPublicationArtifactSteps,
    distributionCapture = undefined,
    distributionApi = undefined,
    publicRuntimeInstallerPorts = {},
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
    this.candidateAbsentFromRemote = candidateAbsentFromRemoteImpl;
    this.readPublicationCheckpoint = readPublicationCheckpointImpl;
    this.readToolPackage = readToolPackage;
    this.createArtifactSteps = createArtifactSteps;
    this.distributionCapture = distributionCapture;
    this.distributionApi = distributionApi;
    this.publicRuntimeInstallerPorts = publicRuntimeInstallerPorts;
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
    const recovery = operation.retainedGenerationRecoveries?.at(-1);
    const layout = this.#layout(operation, generation, target);
    // A retained launch keeps the existing installation lease through every
    // awaited prelaunch step and the final proof, then returns the child without
    // awaiting its completion so that child can acquire its own installation lease.
    let pendingLaunch = null;
    const launch = async (verifyBeforeSpawn = null) => {
      await mkdir(layout.root, { recursive: true });
      const current = await this.readback({ operation, generation, target });
      if (["applied", "already_applied"].includes(current.status)) return { result: current };
      if (current.status === "partial" && current.cursor?.consumerActive === true) {
        const error = new Error(`public installer for ${target.targetId} is still owned by its admitted consumer`);
        error.code = "RELEASE_EXTERNAL_CONDITION";
        throw error;
      }
      if (current.status === "unknown") {
        const error = new Error(`publication runner for ${target.targetId} is still active or has an unknown effect`);
        error.code = "RELEASE_EXTERNAL_EFFECT_UNKNOWN";
        throw error;
      }
      const tool = await this.readToolPackage({ root: this.environment.AGENT_HUB_RELEASE_TOOLS_ROOT,
        expectedSha256: this.environment.AGENT_HUB_RELEASE_TOOLS_SHA256 });
      if (operation.authorization?.runtimeInstallation === PUBLIC_RUNTIME_INSTALLATION) {
        const capabilities = await tool.module("src/publication-artifacts.mjs");
        if (capabilities.publicInstallerHandoffProtocol !== PUBLIC_INSTALLER_HANDOFF) {
          const error = new Error("Selected release tool does not support the original public installer policy");
          error.code = "RELEASE_EXTERNAL_CONDITION";
          throw error;
        }
      }
      const toolIdentity = { name: tool.name, version: tool.version, sha256: tool.sha256 };
      const previousRunner = await readJson(layout.stateFile);
      if (previousRunner && JSON.stringify(previousRunner.tool) !== JSON.stringify(toolIdentity)) {
        throw new Error("Original publication requires its recorded tool executor; use its retained caller without retargeting this generation");
      }
      await tool.assertUnchanged();
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
        tool: toolIdentity,
        startedAt,
      };
      let stdout;
      let stderr;
      let launchingWritten = false;
      try {
        stdout = await open(layout.stdoutFile, "a");
        stderr = await open(layout.stderrFile, "a");
        const environment = { ...this.environment };
        // This worker is a publication, not a replacement startup. A completed
        // parent restart intent must not authorize its validation child processes.
        delete environment.AGENT_HUB_RESTART_OPERATION_ID;
        delete environment.AGENT_HUB_RESTART_LAUNCHER_PID;
        await writeFile(layout.stateFile, `${JSON.stringify(runnerIdentity, null, 2)}\n`, "utf8");
        launchingWritten = true;
        if (verifyBeforeSpawn) await verifyBeforeSpawn(runnerIdentity);
        const child = this.spawnImpl(process.execPath, [runner], {
          cwd: path.join(candidate.releaseRoot, "AgentHub"),
          windowsHide: true,
          detached: true,
          stdio: ["ignore", stdout.fd, stderr.fd],
          env: {
            ...environment,
            AGENT_HUB_DEPENDENCY_ROOT: environment.AGENT_HUB_DEPENDENCY_ROOT || path.dirname(runner),
            AGENT_HUB_RELEASE_TOOLS_ROOT: tool.root,
            AGENT_HUB_RELEASE_TOOLS_SHA256: tool.sha256,
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
        pendingLaunch = { child, completion, runnerIdentity, stdout, stderr };
        await writeFile(layout.stateFile, `${JSON.stringify({ ...runnerIdentity,
          pid: child.pid, status: "running" }, null, 2)}\n`, "utf8");
        return pendingLaunch;
      } catch (error) {
        if (pendingLaunch) throw error;
        try {
          if (launchingWritten && releaseIdentitySha256(await readJson(layout.stateFile)) === releaseIdentitySha256(runnerIdentity)) {
            await writeFile(layout.stateFile, `${JSON.stringify({ ...runnerIdentity, status: "launch_failed",
              error: String(error.message), completedAt: this.now() }, null, 2)}\n`, "utf8");
          }
        } catch (persistenceError) {
          throw new AggregateError([error, persistenceError], "Publication launch refusal could not be persisted", { cause: error });
        } finally {
          await Promise.all([stdout?.close(), stderr?.close()]);
        }
        throw error;
      }
    };
    let started;
    try {
      started = recovery?.generation === generation.generation
        ? await this.withRetainedGeneration({ operation, generation, commit: async (evidence, validate) => {
          if (releaseIdentitySha256(evidence) !== releaseIdentitySha256(recovery.evidence[0]?.artifacts)) {
            throw new Error("Retained prepared runtime changed after recovery admission");
          }
          return launch(validate);
        } })
        : await launch();
    } catch (error) {
      // The lease scope has ended before joining a child whose running receipt
      // could not be written. Its actual publication outcome remains readback-owned.
      if (pendingLaunch) {
        await pendingLaunch.completion;
        pendingLaunch.child.unref();
        await Promise.all([pendingLaunch.stdout.close(), pendingLaunch.stderr.close()]);
      }
      throw error;
    }
    if (started.result) return started.result;
    const { child, completion, runnerIdentity, stdout, stderr } = started;
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
      await completion;
      child.unref();
      await Promise.all([stdout.close(), stderr.close()]);
    }
  }

  async publishPreparedAssets({ operation, generation, target, requested, validate, authorize }) {
    const candidate = candidateFor(generation, target);
    const parents = operation.authorization.approvedTargets.filter(item => item.kind === "agent-hub-publication"
      && item.environment !== "github-release" && path.resolve(item.repositoryRoot ?? "") === path.resolve(candidate.repositoryRoot));
    if (parents.length !== 1) throw new Error("Assets publication requires one original installed target");
    const parent = this.#layout(operation, generation, parents[0]);
    const layout = this.#layout(operation, generation, target);
    const tool = await this.readToolPackage({ root: this.environment.AGENT_HUB_RELEASE_TOOLS_ROOT,
      expectedSha256: this.environment.AGENT_HUB_RELEASE_TOOLS_SHA256 });
    const toolIdentity = { name: tool.name, version: tool.version, sha256: tool.sha256 };
    const runner = await readJson(parent.stateFile);
    const parentJournal = this.publicationRunStore({ runtimeRoot: parent.root, environment: this.environment });
    const originalRun = await parentJournal.read();
    if (runner?.operationId !== operation.operationId || runner.generation !== generation.generation
        || runner.candidate !== generation.identitySha256 || runner.targetId !== parents[0].targetId
        || runner.status !== "exited" || !Number.isInteger(runner.exitCode)
        || !Number.isSafeInteger(runner.pid) || runner.pid <= 0 || !runner.completedAt
        || this.processAlive(runner.pid) !== false || tool.sha256 !== requested.toolSha256
        || releaseIdentitySha256(runner.tool) !== releaseIdentitySha256(toolIdentity)
        || originalRun?.identity?.revision !== candidate.commit
        || path.resolve(originalRun.identity.runtimeRoot) !== this.runtimeRoot
        || path.resolve(originalRun.identity.worktreeRoot) !== path.resolve(candidate.releaseRoot)
        || originalRun.progress?.githubDistribution != null) {
      throw new Error("Assets publication original runner, tool or target changed");
    }
    const runtimePublication = { operationId: operation.operationId, generation: generation.generation,
      sourceCommit: candidate.commit, version: candidate.manifest?.publication?.runtimeReleaseVersion };
    const sourceRoot = path.join(candidate.releaseRoot, "AgentHub");
    const publicationIdentity = { revision: candidate.commit };
    const artifacts = this.createArtifactSteps({ sourceRoot, runtimeRoot: this.runtimeRoot,
      journal: parentJournal, runtimePublication });
    const packageFile = path.join(parent.root, "distribution", runtimePublication.version, "result.json");
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    let preparedInput;
    const inspect = async () => {
      await validate();
      const marker = await assertReleaseCloneForPublication({ repositoryRoot: candidate.releaseRoot });
      if (path.resolve(marker.primaryRoot) !== path.resolve(candidate.repositoryRoot)) throw new Error("Assets publication clone custody changed");
      const git = async args => (await measureTaskOperation("release:assets-git-command", () => promisify(execFile)("git", ownedGitArguments(args), {
        cwd: candidate.releaseRoot, encoding: "utf8", windowsHide: true,
      }), { command: args.find(value => !value.startsWith("--")) })).stdout.trim();
      const [head, dirty, branch] = await Promise.all([
        git(["rev-parse", "HEAD^{commit}", "HEAD^{tree}"]),
        git(["--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"]),
        git(["symbolic-ref", "--quiet", "HEAD"]),
      ]);
      if (head.split(/\r?\n/u).join(" ") !== `${candidate.commit} ${candidate.tree}` || dirty || branch !== "refs/heads/main") {
        throw new Error("Assets publication frozen source changed");
      }
      // Full artifact verification belongs to the existing reader and packaging
      // checkpoints. Every remote boundary rereads their immutable metadata.
      const prepared = preparedInput ??= await artifacts.preparedRuntimeReceipt(publicationIdentity);
      const preparedBytes = await readFile(prepared.receiptFile);
      const manifestBytes = await readFile(path.join(prepared.receipt.releaseRoot, "runtime-manifest.json"));
      const packageInfo = await lstat(packageFile);
      const packageBytes = await readFile(packageFile);
      const packaged = JSON.parse(packageBytes);
      if (!packageInfo.isFile() || packageInfo.isSymbolicLink()
          || digest(preparedBytes) !== prepared.receiptSha256 || digest(manifestBytes) !== prepared.receipt.manifestSha256
          || prepared.receiptSha256 !== requested.preparedReceiptSha256
          || Object.entries(runtimePublication).some(([key, value]) => prepared.receipt[key] !== value)
          || digest(packageBytes) !== requested.packageResultSha256 || packaged.phase !== "PACKAGED"
          || packaged.inputIdentity !== requested.inputIdentity || packaged.inputs?.preparedReceiptSha256 !== prepared.receiptSha256
          || releaseIdentitySha256(packaged.inputs?.tool) !== releaseIdentitySha256(toolIdentity)
          || Object.entries(runtimePublication).some(([key, value]) => packaged.inputs?.[key] !== value)) {
        throw new Error("Assets publication PREPARED or PACKAGED input changed");
      }
      if (releaseIdentitySha256(await parentJournal.read()) !== releaseIdentitySha256(originalRun)
          || releaseIdentitySha256(await readJson(parent.stateFile)) !== releaseIdentitySha256(runner)) {
        throw new Error("Assets publication original execution changed");
      }
      await tool.assertUnchanged();
      return { candidate: generation.identitySha256, sourceCommit: candidate.commit, sourceTree: candidate.tree,
        runtimePublication, tool: toolIdentity, inputIdentity: packaged.inputIdentity,
        preparedReceiptSha256: prepared.receiptSha256, packageResultSha256: digest(packageBytes),
        parentRunnerSha256: releaseIdentitySha256(runner), parentRunSha256: releaseIdentitySha256(originalRun) };
    };
    await mkdir(layout.root, { recursive: true });
    return withPublicationLock(async () => {
      const journal = this.publicationRunStore({ runtimeRoot: layout.root, environment: this.environment });
      const binding = await inspect();
      const saved = await journal.read();
      if (!saved && (await readdir(layout.root)).some(name => name !== "publication.lock" && !name.startsWith("publication.lock."))) {
        throw new Error("Assets publication execution root is occupied");
      }
      const receipt = await authorize(binding);
      const deliveryIdentity = { kind: "published-assets-v1", operationId: operation.operationId,
        generation: generation.generation, revision: candidate.commit, target,
        authorizationInputSha256: receipt.inputSha256, binding };
      if (saved && releaseIdentitySha256(saved.identity) !== releaseIdentitySha256(deliveryIdentity)) {
        throw new Error("Original assets publication journal identity changed");
      }
      const apiModule = await tool.module("src/github-publication.mjs");
      const api = apiModule.createGitHubPublicationTools({ toolRoot: tool.root,
        assertToolUnchanged: () => tool.assertUnchanged(), ownedGitArguments, artifactVersionIdentity, parseGitHubRemote });
      const transport = this.distributionApi ?? api.githubReleaseTransport();
      const distribution = api.createGitHubDistributionSteps({ sourceRoot, repositoryRoot: candidate.repositoryRoot,
        executionRoot: parent.root, runtimePublication, artifacts, journal,
        ...(this.distributionCapture ? { capture: this.distributionCapture } : {}),
        api: async (method, route, options) => {
          await validate();
          if (method !== "GET" && releaseIdentitySha256(await inspect()) !== releaseIdentitySha256(binding)) {
            throw new Error("Assets publication changed before GitHub effect");
          }
          const uploadPayloadBytes = options?.file ? (await lstat(options.file)).size : 0;
          return measureTaskOperation("release:github-request", () => transport(method, route, options),
            { method, uploadPayloadBytes });
        } });
      if (saved?.status === "succeeded") return { status: "applied", distribution: await distribution.verify(publicationIdentity) };
      const steps = distribution.steps(publicationIdentity);
      await journal.start(deliveryIdentity, steps);
      try {
        for (const step of steps) {
          await journal.stepStarted(step.label);
          await step.execute();
          await journal.stepFinished(step.label, { status: "completed" });
        }
        const effect = { status: "applied", distribution: await distribution.verify(publicationIdentity) };
        await validate();
        await journal.finish("succeeded");
        return effect;
      } catch (error) {
        await journal.finish("failed", error);
        throw error;
      }
    }, { environment: { ...this.environment }, lockTarget: path.join(layout.root, "publication") });
  }

  async withRetainedGeneration({ operation, generation, commit }) {
    return withRuntimeInstallationLease(this.runtimeRoot, async () => {
      const physicalRoot = await realpath(this.runtimeRoot);
      const originalRunners = new Map();
      const inspect = async (launchingRunner = null) => {
        const tool = await this.readToolPackage({ root: this.environment.AGENT_HUB_RELEASE_TOOLS_ROOT,
          expectedSha256: this.environment.AGENT_HUB_RELEASE_TOOLS_SHA256 });
        const toolIdentity = { name: tool.name, version: tool.version, sha256: tool.sha256 };
        const pointer = await readRuntimePointer(physicalRoot);
        const lock = await readJson(path.join(physicalRoot, "data", "bot.lock"));
        if (lock && (!Number.isSafeInteger(lock.pid) || lock.pid <= 0)) throw new Error("Retained runtime process custody is unknown");
        const evidence = [];
        for (const target of operation.authorization.approvedTargets) {
          if (target.kind !== "agent-hub-publication") throw new Error("Retained generation target is unsupported");
          const candidate = candidateFor(generation, target);
          const layout = this.#layout(operation, generation, target);
          const observedRunner = await readJson(layout.stateFile);
          let runner = observedRunner;
          if (launchingRunner?.targetId === target.targetId) {
            if (launchingRunner.operationId !== operation.operationId || launchingRunner.generation !== generation.generation
                || launchingRunner.candidate !== generation.identitySha256 || launchingRunner.status !== "launching"
                || launchingRunner.pid !== null || releaseIdentitySha256(observedRunner) !== releaseIdentitySha256(launchingRunner)) {
              throw new Error("Retained publication launch intent changed");
            }
            runner = originalRunners.get(target.targetId);
          } else if (!originalRunners.has(target.targetId)) originalRunners.set(target.targetId, observedRunner);
          const saved = await this.publicationRunStore({ runtimeRoot: layout.root, environment: this.environment }).read();
          const plan = generation.testPlans?.find(item => path.resolve(item.repositoryRoot) === path.resolve(candidate.repositoryRoot))?.plan;
          const publicationIndex = saved?.steps?.findIndex(step => step.label === "Публикация Git") ?? -1;
          const failedIndex = saved?.steps?.findIndex(step => step.status === "failed") ?? -1;
          if (runner?.operationId !== operation.operationId || runner.generation !== generation.generation
              || runner.targetId !== target.targetId || runner.candidate !== generation.identitySha256
              || runner.status !== "exited" || !Number.isInteger(runner.exitCode) || runner.exitCode === 0
              || !Number.isSafeInteger(runner.pid) || runner.pid <= 0 || this.processAlive(runner.pid) !== false
              || JSON.stringify(runner.tool) !== JSON.stringify(toolIdentity)
              || saved?.status !== "failed" || saved.identity?.revision !== candidate.commit
              || path.resolve(saved.identity?.worktreeRoot ?? "") !== path.resolve(candidate.releaseRoot)
              || path.resolve(saved.identity?.runtimeRoot ?? "") !== physicalRoot
              || !plan || releaseIdentitySha256(saved.identity.testPlan) !== releaseIdentitySha256(plan)
              || plan.selection.mode !== "none" || saved.progress?.publicationState
              || failedIndex < 0 || publicationIndex <= failedIndex
              || saved.steps.slice(publicationIndex).some(step => step.status !== "pending")) {
            throw new Error("Retained publisher has no exact terminal pre-effect failure");
          }
          const sourceRoot = path.join(candidate.releaseRoot, "AgentHub");
          const runtimePublication = { operationId: operation.operationId, generation: generation.generation,
            sourceCommit: candidate.commit, version: candidate.manifest?.publication?.runtimeReleaseVersion };
          const artifactIdentity = { revision: candidate.commit, sourceRoot, runtimeRoot: this.runtimeRoot,
            protocol: 1, runtimePublication };
          const key = identity(JSON.stringify(artifactIdentity)).slice(0, 32);
          const releaseId = `publication-${key}`;
          let directory = physicalRoot;
          for (const part of ["publication-artifacts", key, "runtime"]) {
            directory = path.join(directory, part);
            const info = await lstat(directory);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Retained artifact custody changed");
          }
          for (const [relative, isDirectory] of [["artifact.json", false], ["payload", true], ["payload/prepared-runtime.json", false]]) {
            const info = await lstat(path.join(directory, relative));
            if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile())) {
              throw new Error("Retained artifact file custody changed");
            }
          }
          const artifact = await readArtifact(directory, artifactIdentity);
          if (!artifact || identity(JSON.stringify(artifact)) !== saved.progress?.artifactHashes?.runtime) {
            throw new Error("Retained runtime artifact differs from the original publication");
          }
          const releaseRoot = path.join(physicalRoot, "releases", releaseId);
          const before = await captureRuntimeReleaseBinding(releaseRoot, releaseId);
          if ([pointer.current, pointer.previous, lock?.releaseId].includes(releaseId)
              || pointer.runtimeRetention?.retired?.some(item => item.releaseId === releaseId)) {
            throw new Error("Retained prepared runtime has installation or retirement custody");
          }
          if (artifact.result?.releaseId !== releaseId || artifact.result?.manifestHash !== before.manifestSha256) {
            throw new Error("Retained runtime manifest changed");
          }
          const manifest = await readJson(path.join(releaseRoot, "runtime-manifest.json"));
          const directories = new Set([releaseRoot]);
          for (const entry of manifest.files) {
            const parts = String(entry.path).split("/");
            let current = releaseRoot;
            for (const [index, part] of parts.entries()) {
              if (!part || part === "." || part === ".." || /[\\:]/u.test(part)) throw new Error("Retained runtime path changed");
              current = path.join(current, part);
              if (directories.has(current)) continue;
              const info = await lstat(current);
              const isDirectory = index < parts.length - 1;
              if (info.isSymbolicLink() || (isDirectory ? !info.isDirectory() : !info.isFile())) throw new Error("Retained runtime file custody changed");
              if (isDirectory) directories.add(current);
            }
          }
          await verifyRuntimeManifest(releaseRoot, releaseId);
          const receiptBytes = await readFile(path.join(directory, "payload", "prepared-runtime.json"));
          const expectedReceipt = { schema: 1, phase: "PREPARED", ...runtimePublication,
            releaseId, releaseRoot, manifestSha256: before.manifestSha256 };
          if (releaseIdentitySha256(JSON.parse(receiptBytes)) !== releaseIdentitySha256(expectedReceipt)
              || manifest.publicationRevision !== candidate.commit || manifest.sourceRoot !== sourceRoot
              || manifest.releaseVersion !== runtimePublication.version
              || JSON.stringify(await captureRuntimeReleaseBinding(releaseRoot, releaseId)) !== JSON.stringify(before)) {
            throw new Error("Retained runtime payload or prepared receipt changed");
          }
          evidence.push({ targetId: target.targetId, tool: toolIdentity, artifactSha256: releaseIdentitySha256(artifact),
            receiptSha256: identity(receiptBytes), binding: before,
            pointerSha256: releaseIdentitySha256(pointer), lockSha256: releaseIdentitySha256(lock) });
        }
        await tool.assertUnchanged();
        return evidence;
      };
      const evidence = await inspect();
      return commit(evidence, async (launchingRunner = null) => {
        if (releaseIdentitySha256(await inspect(launchingRunner)) !== releaseIdentitySha256(evidence)) {
          throw new Error("Retained runtime custody changed before recovery CAS");
        }
      });
    });
  }

  async readback({ operation, generation, target, reviewedMain = null }) {
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
    const publicBinding = publicRuntimeInstallerBinding({ operation, generation, target });
    if (publicBinding) {
      // A canonical closed target remains historical truth after a later public
      // update or caller/tool cutover. Active admission still needs fresh proof.
      if (operation.state === "done" && operation.publicationEffects?.generation === generation.generation
        && result?.status === "applied" && result.operationId === operation.operationId
        && result.generation === generation.generation && result.targetId === target.targetId
        && result.candidate === generation.identitySha256 && result.revision === candidate.commit
        && result.publicRuntimeInstaller?.status === "ready"
        && releaseIdentitySha256(result.publicRuntimeInstaller.binding) === releaseIdentitySha256(publicBinding)
        && releaseIdentitySha256(operation.publicationEffects.targets?.[target.targetId]) === releaseIdentitySha256(result)) return result;
      const journal = this.publicationRunStore({ runtimeRoot: layout.root, environment: this.environment });
      const saved = await journal.read();
      if (!saved?.progress?.publicRuntimeInstaller) return {
        status: "partial", cursor: { reason: "public-installer-required" },
      };
      if (!runner?.tool || saved.identity?.revision !== candidate.commit) return {
        status: "unknown", cursor: { reason: "public-installer-runner-binding" },
      };
      const tool = await this.readToolPackage({ root: this.environment.AGENT_HUB_RELEASE_TOOLS_ROOT,
        expectedSha256: this.environment.AGENT_HUB_RELEASE_TOOLS_SHA256 });
      const toolIdentity = { name: tool.name, version: tool.version, sha256: tool.sha256 };
      if (releaseIdentitySha256(toolIdentity) !== releaseIdentitySha256(runner.tool)) return {
        status: "unknown", cursor: { reason: "public-installer-tool-changed" },
      };
      await tool.assertUnchanged();
      const artifacts = this.createArtifactSteps({ sourceRoot: path.join(candidate.releaseRoot, "AgentHub"),
        runtimeRoot: this.runtimeRoot, journal, runtimePublication: {
          operationId: operation.operationId, generation: generation.generation,
          sourceCommit: candidate.commit, version: candidate.manifest?.publication?.runtimeReleaseVersion,
        } });
      const consumer = createPublicRuntimeInstaller({ ...this.publicRuntimeInstallerPorts, operation, generation, target, runtimeRoot: this.runtimeRoot,
        journal, tool: toolIdentity, readPublishedInput: async () => {
          const api = this.distributionApi ?? (await import("./github-release-publication.mjs")).githubReleaseTransport();
          return readPublishedRuntimePackage({ operation, generation, target, dataDir: this.dataDir,
            tool: toolIdentity, prepared: await artifacts.preparedRuntimeReceipt(saved.identity),
            api });
        } });
      let proof;
      try { proof = await consumer.readback(); } catch {
        return { status: "unknown", cursor: { reason: "public-installer-proof-refused" } };
      }
      if (proof.status !== "ready") return proof;
      if (result?.status === "applied" && result.operationId === operation.operationId
        && result.generation === generation.generation && result.targetId === target.targetId
        && result.candidate === generation.identitySha256 && result.revision === candidate.commit
        && releaseIdentitySha256(result.tool) === releaseIdentitySha256(toolIdentity)
        && releaseIdentitySha256(result.publicRuntimeInstaller) === releaseIdentitySha256(proof)) return result;
      return { status: "partial", revision: candidate.commit, source: "public-installer-ready", publicRuntimeInstaller: proof };
    }
    if (result?.operationId === operation.operationId
        && result?.generation === generation.generation
        && result?.targetId === target.targetId
        && result?.candidate === generation.identitySha256
        && result?.status === "applied"
        && (target.environment !== "github-release"
          || result.deploymentProfile === "github-release" && result.distribution?.sourceCommit === candidate.commit)) {
      if (runner?.tool && JSON.stringify(result.tool) !== JSON.stringify(runner.tool)) return {
        status: "unknown", cursor: { reason: "publication result differs from its original tool pin" },
      };
      return result;
    }
    const publication = await this.readPublicationState().catch(() => null);
    const published = publication?.revision === candidate.commit
      || publication?.repositories?.some((repository) => (
        path.resolve(repository.root) === path.resolve(candidate.repositoryRoot)
          && repository.revision === candidate.commit
      ));
    if (published && target.environment !== "github-release") return {
      status: "applied",
      revision: candidate.commit,
      source: "publication-state-readback",
    };
    const journal = this.publicationRunStore({ runtimeRoot: layout.root, environment: this.environment });
    let saved;
    try { saved = await journal.read(); } catch {
      if (target.environment === "github-release") return {
        status: "unknown", cursor: { reason: "original distribution journal cannot be read" },
      };
      saved = null;
    }
    if (target.environment === "github-release" && (saved || runner)) {
      const distribution = distributionIntentReadback(saved, candidate);
      if (distribution) return distribution;
    }
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
    const approval = reviewedMain?.approvedRepositories?.find(entry =>
      path.resolve(entry.projectRoot) === path.resolve(candidate.repositoryRoot));
    if (approval && remote === approval.approvedOriginMainCommit
        && runner?.operationId === operation.operationId && runner.generation === generation.generation
        && runner.targetId === target.targetId && runner.candidate === generation.identitySha256
        && runner.status === "exited" && Number.isInteger(runner.exitCode) && runner.exitCode !== 0
        && runner.completedAt && saved?.identity?.revision === candidate.commit) {
      try {
        const checkpoint = await this.readPublicationCheckpoint(path.join(layout.root, "publication-checkpoint.json"));
        const preEffect = failedFrozenPublicationEvidence(saved, checkpoint, { expectedRunId: saved.runId });
        if (await this.candidateAbsentFromRemote(candidate, remote)) return {
          status: "not_applied", revision: remote, source: "original-pre-effect-failure-current-reviewed-origin",
          evidence: { ...preEffect, runnerHash: releaseIdentitySha256(runner), journalHash: releaseIdentitySha256(saved),
            checkpointHash: releaseIdentitySha256(checkpoint), candidateAbsentFromRemote: true },
        };
      } catch {
        // Missing, foreign or contradictory original evidence is UNKNOWN.
      }
    }
    return { status: "unknown", cursor: { remote, runner: runner?.pid ?? null, journalStatus: saved?.status ?? null } };
  }
}
