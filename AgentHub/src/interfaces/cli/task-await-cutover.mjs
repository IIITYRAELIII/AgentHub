import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { HubMcpService } from "../../application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../application/task-board-service.mjs";
import { TaskLifecycleService } from "../../application/task-lifecycle-service.mjs";
import { TaskReleasePlanService } from "../../application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../application/workspace-release-preflight-service.mjs";
import { createPersistenceMutationCapabilities } from "../../composition/persistence-mutation-composition.mjs";
import { taskProjectRoot } from "../../domain/task-project-root.mjs";
import { loadConfig, samePath } from "../../infrastructure/filesystem/config.mjs";
import { ReleaseGitWorkspaceService } from "../../infrastructure/filesystem/release-git-workspace.mjs";
import { TaskGitWorkspaceService } from "../../infrastructure/filesystem/task-git-workspace.mjs";
import { readPublicationState } from "../../infrastructure/persistence/publication-state.mjs";
import { readTestContourStatus, startTestContour } from "../../runtime/test-contour-manager.mjs";
import { openTaskOperationReconciliationStores } from "./task-operation-reconciliation-runtime.mjs";

const execFileAsync = promisify(execFile);
const moduleFile = fileURLToPath(import.meta.url);
const agentHubRoot = path.resolve(path.dirname(moduleFile), "../../..");
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
    if (name === "--confirm-cutover") {
      input.confirm = true;
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
    expectedProjectorSha256: required(input, "expected-projector-sha256").toLowerCase(),
    expectedTaskRevision: Number(required(input, "expected-task-revision")),
    sourceTaskId: String(input["source-task"] ?? "").trim() || null,
    expectedSourceTaskRevision: input["expected-source-task-revision"] == null
      ? null
      : Number(input["expected-source-task-revision"]),
    confirm: input.confirm === true,
  };
  if (!Number.isInteger(parsed.expectedTaskRevision) || parsed.expectedTaskRevision < 1) {
    throw new Error("--expected-task-revision must be a positive integer");
  }
  if (!shaPattern.test(parsed.expectedSourceCommit)) throw new Error("invalid expected source commit");
  if (!/^[a-f0-9]{64}$/u.test(parsed.expectedProjectorSha256)) throw new Error("invalid expected projector SHA-256");
  if ((parsed.sourceTaskId == null) !== (parsed.expectedSourceTaskRevision == null)
      || (parsed.sourceTaskId && (!Number.isInteger(parsed.expectedSourceTaskRevision)
        || parsed.expectedSourceTaskRevision < 1))) {
    throw new Error("--source-task and --expected-source-task-revision must be provided together");
  }
  if (!parsed.confirm) throw new Error("--confirm-cutover is required");
  return parsed;
}

async function git(args) {
  const result = await execFileAsync("git", ["-C", workspaceRoot, ...args], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  return String(result.stdout ?? "").trim();
}

export async function inspectTaskAwaitCutoverSource({
  expectedSourceCommit, expectedProjectorSha256,
} = {}) {
  const headCommit = (await git(["rev-parse", "HEAD"])).toLowerCase();
  if (headCommit !== expectedSourceCommit) throw new Error("Task Await cutover source commit changed");
  if (await git(["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("Task Await cutover source checkout is dirty");
  }
  const projectorFile = path.join(workspaceRoot, ...projectorRelativePath.split("/"));
  const projectorSha256 = createHash("sha256").update(await readFile(projectorFile)).digest("hex");
  if (projectorSha256 !== expectedProjectorSha256) {
    throw new Error("Task Await cutover projector hash changed");
  }
  return { sourceRoot: workspaceRoot, headCommit, projectorRelativePath, projectorSha256 };
}

async function resolveTestContourSource(repositories) {
  for (const repository of repositories) {
    const sourceRoot = path.join(repository.worktreeRoot, "AgentHub");
    try {
      await access(path.join(sourceRoot, "test-contour.mjs"));
      return { ...repository, sourceRoot };
    } catch {}
  }
  throw new Error("release preflight could not locate AgentHub in an integrated dev worktree");
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
  const taskGitWorkspaces = suppliedTaskGitWorkspaces
    ?? new TaskGitWorkspaceService({ dataDir: config.dataDir });
  const releaseGitWorkspaces = suppliedReleaseGitWorkspaces
    ?? new ReleaseGitWorkspaceService({ dataDir: config.dataDir });
  const releasePlanner = new TaskReleasePlanService({ taskBoard, taskGitWorkspaces });
  const releasePreflight = suppliedReleasePreflight ?? new WorkspaceReleasePreflightService({
    releasePlanner,
    taskGitWorkspaces,
    releaseGitWorkspaces,
    resolveTestContourSource,
    refreshTestContour: ({ sourceRoot, ...options }) => startTestContour({
      refresh: true, sourceRoot, entryFile: path.join(sourceRoot, "test-contour.mjs"), ...options,
    }),
    readTestContourStatus,
    readPublicationState,
  });
  const taskLifecycle = new TaskLifecycleService({
    taskBoard, workspaceCatalog: workspaceCatalogStore, taskGitWorkspaces, releasePreflight,
  });
  const service = new HubMcpService({
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
    if (before.revision !== input.expectedTaskRevision || before.workflowStatus !== "testing") {
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
    if (!crossTask && (matchingReferences.length !== 1
        || String(matchingReferences[0].resultCommit ?? "").toLowerCase() !== source.headCommit)) {
      throw new Error("Task Await cutover source is not the unique authoritative Task result");
    }
    const mutation = {
      context_token: token,
      request_id: input.requestId,
      task_id: input.taskId,
      status: "awaiting_implementation",
      expected_task_revision: input.expectedTaskRevision,
      expected_workflow_status: "testing",
      cutover_source_commit: source.headCommit,
      cutover_projector_sha256: source.projectorSha256,
      ...(crossTask ? {
        cutover_source_task_id: input.sourceTaskId,
        cutover_source_task_revision: input.expectedSourceTaskRevision,
      } : {}),
    };
    const result = crossTask
      ? await runtime.service.callTaskStatusCutover(mutation, {
        verifySource: async () => {
          const verified = await inspectSource(input);
          if (verified.headCommit !== source.headCommit
              || verified.projectorSha256 !== source.projectorSha256) {
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

if (path.resolve(process.argv[1] ?? "") === path.resolve(moduleFile)) {
  executeTaskAwaitCutover(parseTaskAwaitCutoverArguments(process.argv.slice(2)))
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`${error.stack || error.message}\n`);
      process.exitCode = 1;
    });
}
