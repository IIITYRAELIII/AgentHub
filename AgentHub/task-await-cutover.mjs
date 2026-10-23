import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { HubMcpService } from "./src/application/hub-mcp-service.mjs";
import { createNativeMergeReviewVerifier } from "./src/application/native-merge-review.mjs";
import { measureTaskOperation } from "./src/infrastructure/process/task-operation-timing.mjs";
import { TaskBoardService } from "./src/application/task-board-service.mjs";
import { TaskLifecycleService } from "./src/application/task-lifecycle-service.mjs";
import { TaskReleasePlanService } from "./src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "./src/application/workspace-release-preflight-service.mjs";
import { resolveReleaseValidationSource } from "./src/composition/infrastructure-composition.mjs";
import { createPersistenceMutationCapabilities } from "./src/composition/persistence-mutation-composition.mjs";
import { taskProjectRoot } from "./src/domain/task-project-root.mjs";
import { normalizedInitialNativeTest, taskGitIdentityHash } from "./src/domain/task-git-reference.mjs";
import { runtimeLayout, runtimeReleaseDirectory } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { verifyRuntimeManifest } from "./src/infrastructure/filesystem/runtime-manifest-verifier.mjs";
import { runtimeStatus } from "./src/runtime/runtime-manager.mjs";
import { loadConfig, samePath } from "./src/infrastructure/filesystem/config.mjs";
import { ReleaseGitWorkspaceService } from "./src/infrastructure/filesystem/release-git-workspace.mjs";
import { TaskGitWorkspaceService } from "./src/infrastructure/filesystem/task-git-workspace.mjs";
import { readPublicationState } from "./src/infrastructure/persistence/publication-state.mjs";
import { createRepositoryProductionValidationAdapter } from "./src/infrastructure/process/repository-production-validation.mjs";
import { openTaskOperationReconciliationStores } from "./src/interfaces/cli/task-operation-reconciliation-runtime.mjs";

const execFileAsync = promisify(execFile);
const moduleFile = fileURLToPath(import.meta.url);
const agentHubRoot = path.dirname(moduleFile);
const workspaceRoot = path.dirname(agentHubRoot);
const projectorRelativePath = "AgentHub/src/infrastructure/filesystem/release-order-preserving-union.mjs";
const shaPattern = /^[a-f0-9]{40,64}$/u;

function required(input, name) {
  const value = String(input[name] ?? "").trim();
  if (!value) throw new Error(`Missing value for --${name}`);
  return value;
}

export function parseTaskAwaitCutoverArguments(argv) {
  const input = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`Unexpected argument: ${name}`);
    if (name === "--confirm-cutover" || name === "--squash-bootstrap" || name === "--initial-native-test" || name === "--returned-native-test") {
      input[name.slice(2)] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    input[name.slice(2)] = value;
    index += 1;
  }
  const parsed = {
    workspaceId: required(input, "workspace"),
    streamId: required(input, "stream"),
    provider: required(input, "provider"),
    threadId: required(input, "thread"),
    taskId: required(input, "task"),
    requestId: required(input, "request"),
    repositoryRoot: path.resolve(required(input, "repository")),
    expectedSourceCommit: required(input, "expected-source-commit").toLowerCase(),
    expectedProjectorSha256: input["initial-native-test"] || input["returned-native-test"] ? null : required(input, "expected-projector-sha256").toLowerCase(),
    expectedTaskRevision: Number(required(input, "expected-task-revision")),
    sourceTaskId: String(input["source-task"] ?? "").trim() || null,
    expectedSourceTaskRevision: input["expected-source-task-revision"] == null
      ? null
      : Number(input["expected-source-task-revision"]),
    confirm: input.confirm === true,
    squashBootstrap: input["squash-bootstrap"] === true,
    initialNativeTest: input["initial-native-test"] === true || input["returned-native-test"] === true,
  };
  parsed.confirm = input["confirm-cutover"] === true;
  if (!Number.isInteger(parsed.expectedTaskRevision) || parsed.expectedTaskRevision < 1) {
    throw new Error("--expected-task-revision must be a positive integer");
  }
  if (!shaPattern.test(parsed.expectedSourceCommit)) throw new Error("invalid expected source commit");
  if (!parsed.initialNativeTest && !/^[a-f0-9]{64}$/u.test(parsed.expectedProjectorSha256)) throw new Error("invalid expected projector SHA-256");
  if (parsed.initialNativeTest) {
    const allowed = new Set(["workspace", "stream", "provider", "thread", "task", "request", "repository",
      "expected-task-revision", "initial-native-test", "confirm-cutover", "expected-source-commit",
      "expected-source-tree", "expected-source-branch", "expected-main-commit", "expected-dev-commit",
      "expected-publication-sha256", "expected-candidate-sha256", "expected-plan-revision", "expected-runtime-sha256"]);
    allowed.add("native-resolution-review-file");
    if (input["native-resolution-review-file"]) parsed.nativeResolutionReviewFile = path.resolve(input["native-resolution-review-file"]);
    if (input["returned-native-test"]) {
      if (input["initial-native-test"]) throw new Error("Returned native Test and initial native Test are distinct admissions");
      allowed.add("returned-native-test"); allowed.add("expected-returned-result-commit");
      parsed.expectedReturnedResultCommit = required(input, "expected-returned-result-commit");
    }
    if (Object.keys(input).some(key => !allowed.has(key))) throw new Error("Initial native Test is a distinct confirmed same-Task admission");
    if (parsed.squashBootstrap || parsed.sourceTaskId || input["expected-projector-sha256"] || !parsed.confirm) {
      throw new Error("Initial native Test is a distinct confirmed same-Task admission");
    }
    for (const [property, argument] of Object.entries({ expectedSourceTree: "expected-source-tree",
      expectedSourceBranch: "expected-source-branch", expectedMainCommit: "expected-main-commit",
      expectedDevCommit: "expected-dev-commit", expectedPublicationHash: "expected-publication-sha256",
      expectedCandidateHash: "expected-candidate-sha256", expectedPlanRevision: "expected-plan-revision",
      expectedRuntimeHash: "expected-runtime-sha256" })) parsed[property] = required(input, argument);
    normalizedInitialNativeTest({ sourceRoot: workspaceRoot, sourceCommit: parsed.expectedSourceCommit,
      sourceTree: parsed.expectedSourceTree, sourceBranch: parsed.expectedSourceBranch,
      mainCommit: parsed.expectedMainCommit, devCommit: parsed.expectedDevCommit,
      publicationHash: parsed.expectedPublicationHash, candidateHash: parsed.expectedCandidateHash,
      planRevision: parsed.expectedPlanRevision, runtimeHash: parsed.expectedRuntimeHash,
      ...(parsed.expectedReturnedResultCommit ? { returnedResultCommit: parsed.expectedReturnedResultCommit } : {}) });
  }
  if ((parsed.sourceTaskId == null) !== (parsed.expectedSourceTaskRevision == null)
      || (parsed.sourceTaskId && (!Number.isInteger(parsed.expectedSourceTaskRevision)
        || parsed.expectedSourceTaskRevision < 1))) {
    throw new Error("--source-task and --expected-source-task-revision must be provided together");
  }
  if (parsed.squashBootstrap) {
    const commit = (name) => required(input, name).toLowerCase();
    const sha256 = (name) => required(input, name).toLowerCase();
    Object.assign(parsed, {
      proofRequestId: String(input["proof-request"] ?? "").trim() || null,
      squashBaselineResultCommit: commit("baseline-result-commit"),
      squashNewResultCommit: commit("new-result-commit"),
      squashDevAfterTree: commit("dev-after-tree"),
      expectedSourceTree: commit("expected-source-tree"),
      expectedMainCommit: commit("expected-main-commit"),
      expectedDevCommit: commit("expected-dev-commit"),
      expectedPreservedTree: commit("expected-preserved-tree"),
      artifactFiles: {
        sourceZip: path.resolve(required(input, "source-zip")),
        bundle: path.resolve(required(input, "bundle")),
        manifest: path.resolve(required(input, "manifest")),
        files: path.resolve(required(input, "files")),
      },
      expectedArtifacts: {
        sourceZipSha256: sha256("source-zip-sha256"),
        bundleSha256: sha256("bundle-sha256"),
        manifestSha256: sha256("manifest-sha256"),
        filesSha256: sha256("files-sha256"),
      },
      expectedTransferHash: String(input["expected-transfer-hash"] ?? "").trim().toLowerCase() || null,
      expectedCutoverHash: String(input["expected-cutover-hash"] ?? "").trim().toLowerCase() || null,
    });
    if (!parsed.sourceTaskId || parsed.sourceTaskId === parsed.taskId) {
      throw new Error("--squash-bootstrap requires a distinct --source-task");
    }
    if (![parsed.squashBaselineResultCommit, parsed.squashNewResultCommit,
      parsed.squashDevAfterTree, parsed.expectedSourceTree, parsed.expectedMainCommit,
      parsed.expectedDevCommit, parsed.expectedPreservedTree]
      .every((value) => /^[a-f0-9]{40}$/u.test(value))
        || !Object.values(parsed.expectedArtifacts).every((value) => /^[a-f0-9]{64}$/u.test(value))) {
      throw new Error("invalid squash bootstrap commit, tree or artifact SHA-256");
    }
    const confirmationIdentity = [parsed.proofRequestId, parsed.expectedTransferHash, parsed.expectedCutoverHash];
    if (parsed.confirm !== confirmationIdentity.every(Boolean)
        || (!parsed.confirm && confirmationIdentity.some(Boolean))) {
      throw new Error("squash bootstrap confirmation requires --confirm-cutover, --proof-request and both expected hashes");
    }
  } else if (!parsed.confirm) throw new Error("--confirm-cutover is required");
  return parsed;
}

async function git(args, root = workspaceRoot) {
  const result = await execFileAsync("git", ["-C", root, ...args], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  return String(result.stdout ?? "").trim();
}

export async function inspectTaskAwaitCutoverSource({
  expectedSourceCommit, expectedProjectorSha256, squashBootstrap = false,
  expectedSourceTree = null, artifactFiles = null, expectedArtifacts = null,
  initialNativeTest = false, expectedSourceBranch = null,
} = {}, { sourceRoot = workspaceRoot } = {}) {
  const sourceGit = args => git(args, sourceRoot);
  const headCommit = (await sourceGit(["rev-parse", "HEAD"])).toLowerCase();
  if (headCommit !== expectedSourceCommit) throw new Error("Task Await cutover source commit changed");
  if (await sourceGit(["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Task Await cutover source checkout is dirty");
  }
  const headTree = (await sourceGit(["rev-parse", "HEAD^{tree}"])).toLowerCase();
  if (initialNativeTest) {
    const branch = await sourceGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (headTree !== expectedSourceTree || branch !== expectedSourceBranch) throw new Error("Initial native Test source tree or branch changed");
    return { sourceRoot: path.resolve(sourceRoot), headCommit, headTree, branch };
  }
  const projectorFile = path.join(workspaceRoot, ...projectorRelativePath.split("/"));
  const projectorSha256 = createHash("sha256").update(await readFile(projectorFile)).digest("hex");
  if (projectorSha256 !== expectedProjectorSha256) {
    throw new Error("Task Await cutover projector hash changed");
  }
  if (!squashBootstrap) {
    return { sourceRoot: workspaceRoot, headCommit, headTree, projectorRelativePath, projectorSha256 };
  }
  if (headTree !== expectedSourceTree) throw new Error("Task squash cutover source tree changed");
  const artifacts = {
    sourceZipSha256: createHash("sha256").update(await readFile(artifactFiles.sourceZip)).digest("hex"),
    bundleSha256: createHash("sha256").update(await readFile(artifactFiles.bundle)).digest("hex"),
    manifestSha256: createHash("sha256").update(await readFile(artifactFiles.manifest)).digest("hex"),
    filesSha256: createHash("sha256").update(await readFile(artifactFiles.files)).digest("hex"),
  };
  if (JSON.stringify(artifacts) !== JSON.stringify(expectedArtifacts)) {
    throw new Error("Task squash cutover artifact hash changed");
  }
  return { sourceRoot: workspaceRoot, headCommit, headTree, projectorRelativePath, projectorSha256, artifacts };
}

export async function inspectInstalledNativeTestOwner({ runtimeRoot } = {}) {
  const layout = runtimeLayout(runtimeRoot);
  const status = await runtimeStatus({ runtimeRoot: layout.root, requireProcessEvidence: true });
  const manifest = status.current ? await readFile(path.join(runtimeReleaseDirectory(layout.root, status.current), "runtime-manifest.json")) : null;
  const parsed = manifest ? JSON.parse(manifest.toString("utf8")) : null;
  if (parsed && parsed.releaseId !== status.current) throw new Error("Installed runtime manifest identity changed");
  let available = false;
  if (status.ready && status.runningRelease === status.current
      && parsed?.files?.some(entry => entry.path === "src/infrastructure/filesystem/native-release-merge.mjs")) {
    const releaseRoot = runtimeReleaseDirectory(layout.root, status.current);
    await verifyRuntimeManifest(releaseRoot, status.current);
    const owner = await import(pathToFileURL(path.join(releaseRoot, "src/application/hub-mcp-service.mjs")).href);
    available = owner.HubMcpService?.nativeTaskStatusVersion === 1;
  }
  return { available, hash: taskGitIdentityHash({ status, manifestSha256: manifest
    ? createHash("sha256").update(manifest).digest("hex") : null }) };
}

export async function openTaskAwaitCutoverRuntime({
  config: suppliedConfig = null,
  openStores = openTaskOperationReconciliationStores,
  taskGitWorkspaces: suppliedTaskGitWorkspaces = null,
  releaseGitWorkspaces: suppliedReleaseGitWorkspaces = null,
  releasePreflight: suppliedReleasePreflight = null,
} = {}) {
  const config = suppliedConfig ?? await loadConfig();
  const databaseFile = path.join(config.dataDir, "journal.sqlite");
  const raw = await openStores({ databaseFile });
  const { workspaceCatalogStore, taskBoardStore } = createPersistenceMutationCapabilities({
    rawWorkspaceCatalogStore: raw.workspaceCatalogStore,
    rawTaskBoardStore: raw.taskBoardStore,
  });
  const taskBoard = new TaskBoardService({
    store: taskBoardStore,
    workspaceCatalog: workspaceCatalogStore,
    classify: null,
    autoPlaceConfidence: config.taskBoard.autoPlaceConfidence,
    recordEvent: (event) => workspaceCatalogStore.recordWorkspaceEvent(event),
  });
  const verifyNativeResolutionReview = createNativeMergeReviewVerifier({ workspaceCatalog: workspaceCatalogStore, taskBoard });
  const taskGitWorkspaces = suppliedTaskGitWorkspaces
    ?? new TaskGitWorkspaceService({ dataDir: config.dataDir, verifyNativeResolutionReview });
  const releaseGitWorkspaces = suppliedReleaseGitWorkspaces
    ?? new ReleaseGitWorkspaceService({ dataDir: config.dataDir, verifyNativeResolutionReview });
  const releasePlanner = new TaskReleasePlanService({ taskBoard, taskGitWorkspaces });
  const releasePreflight = suppliedReleasePreflight ?? new WorkspaceReleasePreflightService({
    measureOperation: measureTaskOperation,
    releasePlanner,
    taskGitWorkspaces,
    releaseGitWorkspaces,
    resolveReleaseValidationSource,
    validateProductionCandidate: createRepositoryProductionValidationAdapter({
      policies: config.releaseValidation?.repositories ?? [],
      dataDir: path.join(config.dataDir, "release-validation"),
    }),
    readPublicationState,
  });
  const taskLifecycle = new TaskLifecycleService({
    taskBoard, workspaceCatalog: workspaceCatalogStore, taskGitWorkspaces, releasePreflight,
  });
  const service = new HubMcpService({
    measureOperation: measureTaskOperation,
    workspaceCatalog: workspaceCatalogStore,
    taskBoard,
    taskLifecycle,
    workLog: { threadTurns: async () => [] },
    attachmentDirectory: path.join(config.dataDir, "attachments"),
    secret: randomBytes(32).toString("base64url"),
    releasePlanner,
    releasePreflight,
    releaseCompleter: { completeRelease: async () => { throw new Error("release completion is unavailable in Await cutover"); } },
    taskGitWorkspaces,
    releaseGitWorkspaces,
    reconcilePendingOnStartup: false,
  });
  return {
    service,
    taskBoard,
    workspaceCatalog: workspaceCatalogStore,
    inspectInstalledNativeOwner: () => inspectInstalledNativeTestOwner({ runtimeRoot: path.dirname(config.dataDir) }),
    close() {
      raw.taskBoardStore.close();
      raw.workspaceCatalogStore.close();
    },
  };
}

export async function executeTaskAwaitCutover(input, {
  inspectSource = inspectTaskAwaitCutoverSource,
  openRuntime = openTaskAwaitCutoverRuntime,
} = {}) {
  const source = await inspectSource(input);
  const nativeResolutionReview = input.nativeResolutionReviewFile
    ? JSON.parse(await readFile(input.nativeResolutionReviewFile, "utf8")) : null;
  const runtime = await openRuntime();
  try {
    const token = runtime.service.contextToken({
      provider: input.provider, threadId: input.threadId, streamId: input.streamId,
    });
    const context = await runtime.service.call("hub_context_get", { context_token: token });
    if (context.workspaceId !== input.workspaceId || context.streamId !== input.streamId) {
      throw new Error("Task Await cutover caller identity changed");
    }
    const before = runtime.taskBoard.task(input.taskId);
    if (!before || before.workspaceId !== input.workspaceId) throw new Error("Task Await cutover Task identity changed");
    if (input.initialNativeTest) {
      const workspace = runtime.workspaceCatalog.workspace(before.workspaceId);
      const stream = runtime.workspaceCatalog.stream(before.streamId);
      if (!workspace || !stream || !samePath(taskProjectRoot({ workspace, stream }), input.repositoryRoot)) {
        throw new Error("Initial native Test canonical repository changed");
      }
      const identity = normalizedInitialNativeTest({ sourceRoot: source.sourceRoot, sourceCommit: source.headCommit,
        sourceTree: source.headTree, sourceBranch: source.branch, mainCommit: input.expectedMainCommit,
        devCommit: input.expectedDevCommit, publicationHash: input.expectedPublicationHash,
        candidateHash: input.expectedCandidateHash, planRevision: input.expectedPlanRevision,
        runtimeHash: input.expectedRuntimeHash,
        ...(input.expectedReturnedResultCommit ? { returnedResultCommit: input.expectedReturnedResultCommit } : {}) });
      const result = await runtime.service.callTaskStatusCutover({ context_token: token,
        request_id: input.requestId, task_id: input.taskId, status: "testing",
        expected_task_revision: input.expectedTaskRevision, expected_workflow_status: "in_progress",
        initial_native_test: identity,
        ...(nativeResolutionReview ? { native_resolution_review: nativeResolutionReview } : {}) }, {
        verifySource: () => inspectSource(input),
        inspectInstalledNativeOwner: runtime.inspectInstalledNativeOwner,
      });
      return { source, before: { id: before.id, revision: before.revision, workflowStatus: before.workflowStatus }, result };
    }
    const expectedBeforeStatus = input.squashBootstrap ? "in_progress" : "testing";
    if (before.revision !== input.expectedTaskRevision || before.workflowStatus !== expectedBeforeStatus) {
      throw new Error("Task Await cutover Task revision or status changed");
    }
    const workspace = runtime.workspaceCatalog.workspace(before.workspaceId);
    const stream = runtime.workspaceCatalog.stream(before.streamId);
    if (!workspace || !stream || !samePath(taskProjectRoot({ workspace, stream }), input.repositoryRoot)) {
      throw new Error("Task Await cutover repository identity changed");
    }
    const matchingReferences = (before.gitReferences ?? []).filter((reference) => (
      samePath(reference.projectRoot, input.repositoryRoot)
    ));
    const crossTask = input.sourceTaskId && input.sourceTaskId !== input.taskId;
    if (input.squashBootstrap) {
      const sourceTask = runtime.taskBoard.task(input.sourceTaskId);
      if (!sourceTask || sourceTask.workspaceId !== input.workspaceId
          || sourceTask.revision !== input.expectedSourceTaskRevision
          || sourceTask.workflowStatus !== "testing") {
        throw new Error("Task squash cutover source Task revision or status changed");
      }
    }
    if (!crossTask && (matchingReferences.length !== 1
        || String(matchingReferences[0].resultCommit ?? "").toLowerCase() !== source.headCommit)) {
      throw new Error("Task Await cutover source is not the unique authoritative Task result");
    }
    const mutation = {
      context_token: token,
      request_id: input.requestId,
      task_id: input.taskId,
      status: input.squashBootstrap ? "testing" : "awaiting_implementation",
      expected_task_revision: input.expectedTaskRevision,
      expected_workflow_status: expectedBeforeStatus,
      cutover_source_commit: source.headCommit,
      cutover_projector_sha256: source.projectorSha256,
      ...(crossTask && !input.squashBootstrap ? {
        cutover_source_task_id: input.sourceTaskId,
        cutover_source_task_revision: input.expectedSourceTaskRevision,
      } : {}),
      ...(input.squashBootstrap ? {
        squash_source_task_id: input.sourceTaskId,
        squash_source_task_revision: input.expectedSourceTaskRevision,
        squash_baseline_result_commit: input.squashBaselineResultCommit,
        squash_new_result_commit: input.squashNewResultCommit,
        squash_dev_after_tree: input.squashDevAfterTree,
        squash_cutover_source_tree: input.expectedSourceTree,
        squash_cutover_expected_main_commit: input.expectedMainCommit,
        squash_cutover_expected_dev_commit: input.expectedDevCommit,
        squash_cutover_expected_preserved_tree: input.expectedPreservedTree,
        squash_cutover_source_zip_sha256: input.expectedArtifacts.sourceZipSha256,
        squash_cutover_bundle_sha256: input.expectedArtifacts.bundleSha256,
        squash_cutover_manifest_sha256: input.expectedArtifacts.manifestSha256,
        squash_cutover_files_sha256: input.expectedArtifacts.filesSha256,
        ...(input.confirm ? {
          squash_proof_request_id: input.proofRequestId,
          expected_squash_transfer_hash: input.expectedTransferHash,
          expected_squash_cutover_hash: input.expectedCutoverHash,
        } : {}),
      } : {}),
    };
    const result = crossTask
      ? await runtime.service.callTaskStatusCutover(mutation, {
        verifySource: async () => {
          const verified = await inspectSource(input);
          if (JSON.stringify(verified) !== JSON.stringify(source)) {
            throw new Error("Task Await cutover source checkout changed");
          }
          return verified;
        },
      })
      : await runtime.service.call("hub_task_status_update", mutation);
    return { source, before: { id: before.id, revision: before.revision, workflowStatus: before.workflowStatus }, result };
  } finally {
    runtime.close();
  }
}

// Source-only preparation recovery consumes the same default factory and
// genuine caller capabilities as the existing local native cutover consumer.
// An ordinary serialized MCP call cannot supply this terminal observer.
export async function executePreparationForward(input, {
  openRuntime = openTaskAwaitCutoverRuntime, inspectOriginalExecution,
} = {}) {
  if (typeof inspectOriginalExecution !== "function") throw new TypeError("Original invocation terminal observer is required");
  const runtime = await openRuntime();
  try {
    const token = runtime.service.contextToken({ provider: input.provider, threadId: input.threadId, streamId: input.streamId });
    return await runtime.service.callPreparationForward({ context_token: token, request_id: input.requestId,
      expected_arguments_hash: input.expectedArgumentsHash, expected_preparation_revision: input.expectedPreparationRevision,
      original_preparation: input.originalPreparation, preparation: input.preparation }, { inspectOriginalExecution });
  } finally { runtime.close(); }
}

if (path.resolve(process.argv[1] ?? "") === path.resolve(moduleFile)) {
  executeTaskAwaitCutover(parseTaskAwaitCutoverArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
