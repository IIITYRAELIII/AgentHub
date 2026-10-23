import { ReleaseOperationService } from "../application/release-operation-service.mjs";
import { ReleaseOperationCommandService } from "../application/release-operation-command-service.mjs";
import { ReleaseOperationFinalization } from "../application/release-operation-finalization.mjs";
import { WorkspaceReleaseOperationAdapter } from "../application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationStore } from "../infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationPublication } from "../infrastructure/process/release-operation-publication.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";

// Both normal consumers use the same existing durable owner and publication
// adapter. Construction does not recover/wake unrelated operations.
export function createReleaseOperationServices({
  dataDir, runtimeRoot, releasePreflight, taskBoard, taskLifecycle,
  workspaceCatalog, taskGitWorkspaces, releaseGitWorkspaces,
  runnerVersion, requestCorrection,
  store = new ReleaseOperationStore({ dataDir }),
  publication = new ReleaseOperationPublication({ dataDir, runtimeRoot }),
  finalization = new ReleaseOperationFinalization({ taskBoard, releaseGitWorkspaces, taskGitWorkspaces }),
} = {}) {
  const adapter = new WorkspaceReleaseOperationAdapter({ releasePreflight, publication, finalization });
  const operations = new ReleaseOperationService({
    store,
    compose: input => adapter.compose(input),
    validate: input => adapter.validate(input),
    publishTarget: input => adapter.publishTarget(input),
    readTarget: input => adapter.readTarget(input),
    finalize: input => adapter.finalize(input),
    reservePublication: input => adapter.reservePublication(input),
    withReviewedMainRecovery: input => adapter.withReviewedMainRecovery(input),
    requestCorrection,
    cleanupGeneration: input => adapter.cleanupGeneration(input),
    processAlive: processIsAlive,
    runnerVersion,
  });
  const commands = new ReleaseOperationCommandService({ releaseOperations: operations, workspaceCatalog, taskBoard });
  taskLifecycle.setReleaseOperationWake(taskId => operations.wakeForTask(taskId));
  taskLifecycle.setReleaseOperationPrepare(taskId => operations.prepareForTaskAcceptance(taskId));
  return { store, operations, commands };
}
