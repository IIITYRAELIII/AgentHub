import { access } from "node:fs/promises";
import path from "node:path";

import { TaskBoardService } from "./src/application/task-board-service.mjs";
import { TaskLifecycleService } from "./src/application/task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "./src/application/task-operation-reconciliation-service.mjs";
import { TaskReleasePlanService } from "./src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "./src/application/workspace-release-preflight-service.mjs";
import { createPersistenceMutationCapabilities } from "./src/composition/persistence-mutation-composition.mjs";
import { loadConfig } from "./src/infrastructure/filesystem/config.mjs";
import { ReleaseGitWorkspaceService } from "./src/infrastructure/filesystem/release-git-workspace.mjs";
import { TaskGitWorkspaceService } from "./src/infrastructure/filesystem/task-git-workspace.mjs";
import { readPublicationState } from "./src/infrastructure/persistence/publication-state.mjs";
import { openTaskOperationReconciliationStores } from "./src/interfaces/cli/task-operation-reconciliation-runtime.mjs";
import { readTestContourStatus, startTestContour } from "./src/runtime/test-contour-manager.mjs";

function options(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (!name.startsWith("--")) throw new Error(`Unexpected argument: ${name}`);
    if (name === "--confirm-system-restart") {
      result.confirm = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
    result[name.slice(2)] = value;
    index += 1;
  }
  return result;
}

async function resolveTestContourSource(repositories) {
  for (const repository of repositories) {
    const sourceRoot = path.join(repository.worktreeRoot, "AgentHub");
    try {
      await access(path.join(sourceRoot, "test-contour.mjs"));
      return { kind: "agent-hub-test-contour", ...repository, sourceRoot };
    } catch {}
  }
  throw new Error("release preflight could not locate AgentHub in an integrated dev worktree");
}

const input = options(process.argv.slice(2));
const config = await loadConfig();
const databaseFile = path.join(config.dataDir, "journal.sqlite");
const {
  workspaceCatalogStore: rawWorkspaceCatalogStore,
  taskBoardStore: rawTaskBoardStore,
} = await openTaskOperationReconciliationStores({ databaseFile });
try {
  const { workspaceCatalogStore, taskBoardStore } = createPersistenceMutationCapabilities({
    rawWorkspaceCatalogStore,
    rawTaskBoardStore,
  });
  const taskBoard = new TaskBoardService({
    store: taskBoardStore,
    workspaceCatalog: workspaceCatalogStore,
    classify: null,
    autoPlaceConfidence: config.taskBoard.autoPlaceConfidence,
    recordEvent: (event) => workspaceCatalogStore.recordWorkspaceEvent(event),
  });
  const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir: config.dataDir });
  const releaseGitWorkspaces = new ReleaseGitWorkspaceService({ dataDir: config.dataDir });
  const releasePlanner = new TaskReleasePlanService({ taskBoard, taskGitWorkspaces });
  const releasePreflight = new WorkspaceReleasePreflightService({
    releasePlanner,
    taskGitWorkspaces,
    releaseGitWorkspaces,
    resolveTestContourSource,
    refreshTestContour: ({ sourceRoot, ...refreshOptions }) => startTestContour({
      refresh: true,
      sourceRoot,
      entryFile: path.join(sourceRoot, "test-contour.mjs"),
      ...refreshOptions,
    }),
    readTestContourStatus,
    readPublicationState,
  });
  const taskLifecycle = new TaskLifecycleService({
    taskBoard,
    workspaceCatalog: workspaceCatalogStore,
    taskGitWorkspaces,
    releasePreflight,
  });
  const reconciliation = new TaskOperationReconciliationService({
    workspaceCatalog: workspaceCatalogStore,
    taskBoard,
    taskLifecycle,
  });
  const result = await reconciliation.reconcileUnknownWorkflow({
    workspaceId: input.workspace,
    taskId: input.task,
    operationRequestId: input.operation,
    projectRoot: input.repository,
    guardId: input.guard,
    proofKind: "system-restart-after-guard",
    proofSummary: input.summary,
    expectedTaskRevision: input["expected-task-revision"],
    expectedWorkflowStatus: input["expected-workflow-status"],
    cutoverSourceCommit: input["cutover-source-commit"],
    cutoverProjectorSha256: input["cutover-projector-sha256"],
    cutoverSourceTaskId: input["cutover-source-task"],
    cutoverSourceTaskRevision: input["cutover-source-task-revision"],
    confirmed: input.confirm === true,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.resolved) process.exitCode = 2;
} finally {
  rawTaskBoardStore.close();
  rawWorkspaceCatalogStore.close();
}
