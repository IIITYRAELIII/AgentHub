import { releasePublicationPlatform } from "./release-tooling-composition.mjs";
import { ReleaseOperationService } from "../application/release-operation-service.mjs";
import { ReleaseOperationCommandService } from "../application/release-operation-command-service.mjs";
import { ReleaseOperationFinalization } from "../application/release-operation-finalization.mjs";
import { WorkspaceReleaseOperationAdapter } from "../application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationStore } from "../infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationPublication } from "../infrastructure/process/release-operation-publication.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";
import { createReleaseProgressObserver } from "../infrastructure/process/release-progress-monitor.mjs";

// Both normal consumers use the same existing durable owner and publication
// adapter. Construction does not recover/wake unrelated operations.
export function createReleaseOperationServices({
  dataDir, runtimeRoot, releasePreflight, taskBoard, taskLifecycle,
  workspaceCatalog, taskGitWorkspaces, releaseGitWorkspaces,
  runnerVersion, requestCorrection,
  recordCommandTrace = () => false,
  observeOperation = createReleaseProgressObserver({ runtimeRoot }),
  store = new ReleaseOperationStore({ dataDir }),
  publication = new ReleaseOperationPublication({ dataDir, runtimeRoot, platform: releasePublicationPlatform() }),
  finalization = new ReleaseOperationFinalization({ taskBoard, releaseGitWorkspaces, taskGitWorkspaces }),
} = {}) {
  store.recordPersistence = diagnostic => {
    const { operationId, outcome, elapsedMs, queueWaitMs, ...metadata } = diagnostic;
    return recordCommandTrace({ commandId: operationId, stage: "release-persistence", outcome,
      transport: "release-owner", monotonicDurationMs: elapsedMs, lockWaitMs: queueWaitMs, metadata });
  };
  const measure = releasePreflight.measureOperation?.bind(releasePreflight) ?? ((_stage, run) => run());
  const adapter = new WorkspaceReleaseOperationAdapter({ releasePreflight, publication, finalization, measureOperation: measure });
  const operations = new ReleaseOperationService({
    loadAuthorizationPolicy: () => publication.loadAuthorizationPolicy(),
    resolveTestPlans: (candidates, selection, operation) => taskGitWorkspaces.withOperationTrace({
      operationId: operation.testSelectionAmendments?.at(-1)?.requestId ?? operation.requestId ?? operation.operationId,
      releaseOperationId: operation.operationId, generation: operation.currentGeneration + 1,
      ownerEpoch: operation.owner?.epoch,
    }, () => measure("release:resolve-test-plans", () => publication.resolveTestPlans(candidates, selection, operation))),
    withTaskSelection: input => taskGitWorkspaces.withOperationTrace({
      operationId: input.requestId ?? input.operation.operationId, releaseOperationId: input.operation.operationId,
      generation: input.operation.currentGeneration + 1,
    }, () => measure("release:amendment", () => adapter.withTaskSelection(input))),
    store,
    compose: input => taskGitWorkspaces.withOperationTrace({
      operationId: input.operation.operationId, generation: input.generation,
    }, () => adapter.compose(input)),
    validate: input => adapter.validate(input),
    publishTarget: input => adapter.publishTarget(input),
    readTarget: input => adapter.readTarget(input),
    finalize: input => adapter.finalize(input),
    synchronizePublishedDev: input => finalization.synchronizePublishedDev(input),
    publishPreparedAssets: input => taskGitWorkspaces.withOperationTrace({ operationId: input.requestId,
      generation: input.generation.generation }, () => releasePreflight.measureOperation("release:published-assets",
      () => publication.publishPreparedAssets(input))),
    reservePublication: input => adapter.reservePublication(input),
    withReviewedMainRecovery: input => adapter.withReviewedMainRecovery(input),
    inspectFirstCompose: input => adapter.inspectFirstCompose(input),
    recoverFirstCompose: input => taskGitWorkspaces.withOperationTrace({
      operationId: input.recovery.requestId ?? input.operation.requestId ?? input.operation.operationId,
      releaseOperationId: input.operation.operationId,
      generation: input.generation, ownerEpoch: input.operation.owner?.epoch,
    }, () => measure("release:recovery", () => adapter.recoverFirstCompose(input))),
    withRetainedGeneration: input => taskGitWorkspaces.withOperationTrace({
      operationId: input.operation.operationId, generation: input.generation.generation,
    }, () => releasePreflight.measureOperation("release:retained-generation-recovery", () => adapter.withRetainedGeneration(input))),
    withPublicationRecovery: input => adapter.withPublicationRecovery(input),
    requestCorrection,
    cleanupGeneration: input => adapter.cleanupGeneration(input),
    processAlive: processIsAlive,
    runnerVersion,
    observeOperation,
  });
  const commands = new ReleaseOperationCommandService({ releaseOperations: operations, workspaceCatalog, taskBoard });
  taskLifecycle.setReleaseOperationWake(taskId => operations.wakeForTask(taskId, { workspaceId: taskBoard.task(taskId)?.workspaceId }));
  taskLifecycle.setReleaseOperationPrepare(taskId => operations.prepareForTaskAcceptance(taskId, { workspaceId: taskBoard.task(taskId)?.workspaceId }));
  return { store, operations, commands };
}
