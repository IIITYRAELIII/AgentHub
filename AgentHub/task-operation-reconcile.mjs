import path from "node:path";
import { readFile } from "node:fs/promises";

import { TaskBoardService } from "./src/application/task-board-service.mjs";
import { TaskLifecycleService } from "./src/application/task-lifecycle-service.mjs";
import { TaskOperationReconciliationService } from "./src/application/task-operation-reconciliation-service.mjs";
import { TaskReleasePlanService } from "./src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "./src/application/workspace-release-preflight-service.mjs";
import { resolveReleaseValidationSource } from "./src/composition/infrastructure-composition.mjs";
import { createPersistenceMutationCapabilities } from "./src/composition/persistence-mutation-composition.mjs";
import { loadConfig } from "./src/infrastructure/filesystem/config.mjs";
import { ReleaseGitWorkspaceService } from "./src/infrastructure/filesystem/release-git-workspace.mjs";
import { TaskGitWorkspaceService } from "./src/infrastructure/filesystem/task-git-workspace.mjs";
import { readPublicationState } from "./src/infrastructure/persistence/publication-state.mjs";
import { createRepositoryProductionValidationAdapter } from "./src/infrastructure/process/repository-production-validation.mjs";
import { openTaskOperationReconciliationStores } from "./src/interfaces/cli/task-operation-reconciliation-runtime.mjs";

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

const input = options(process.argv.slice(2));
if (input["cancel-arguments"]) {
  const { openTaskAwaitCutoverRuntime } = await import("./task-await-cutover.mjs");
  const { createClaimCustodyRuntime } = await import("./src/infrastructure/process/claim-custody-runtime.mjs");
  const command = JSON.parse(await readFile(path.resolve(input["cancel-arguments"]), "utf8"));
  if (command.context_token != null) throw new Error("Cancellation arguments must not contain a context capability");
  const runtime = await openTaskAwaitCutoverRuntime();
  try {
    runtime.service.taskOperationInterruption.runtime = createClaimCustodyRuntime({ dataDir: runtime.config.dataDir });
    const token = runtime.service.contextToken({ provider: input.provider, threadId: input.thread, streamId: input.stream });
    const result = await runtime.service.call("hub_task_operation_cancel", { ...command, context_token: token });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } finally { runtime.close(); }
} else {
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
    resolveReleaseValidationSource,
    readPublicationState,
    validateProductionCandidate: createRepositoryProductionValidationAdapter({
      policies: config.releaseValidation?.repositories ?? [],
      dataDir: path.join(config.dataDir, "release-validation"),
    }),
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
    selectedBundlePath: input["selected-proof-bundle-path"],
    selectedBundleSha256: input["selected-proof-bundle-sha256"],
    selectedProofCommit: input["selected-proof-commit"],
    selectedPreviewRequestId: input["selected-preview-request-id"],
    expectedSelectedPreviewHash: input["expected-selected-preview-hash"],
    selectedPublishedResolution: input["selected-published-resolution"]
      ? JSON.parse(await readFile(path.resolve(input["selected-published-resolution"]), "utf8")) : null,
    selectedAbsorptionHandoff: input["selected-absorption-handoff"]
      ? JSON.parse(await readFile(path.resolve(input["selected-absorption-handoff"]), "utf8")) : null,
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

}
