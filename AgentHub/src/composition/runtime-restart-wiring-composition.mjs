import process from "node:process";

import { createRuntimeRestartComposition } from "./runtime-restart-composition.mjs";

export function createRuntimeRestartWiring({
  taskRuns,
  runCoordinator,
  agentProviders,
  backgroundJobs,
  streamMaintenance,
  getRestartRequest,
  isStopping,
  restartRequestService,
  runtimeRestart,
}) {
  if (typeof runCoordinator?.hasPendingAdmission !== "function") {
    throw new TypeError("restart wiring requires the pending-admission owner");
  }
  let runtimeRestartController;
  let restartScheduled = false;
  let lastReadinessTrace = "";

  function restartBlockingRuns() {
    return taskRuns.values().filter((run) => (
      agentProviders.call(run.provider, "blocksRuntimeRestart", run)
    ));
  }

  function restartHasBlockingWork() {
    return restartBlockingWorkCount() > 0;
  }

  function restartBlockingWorkCount() {
    const runs = restartBlockingRuns();
    const backgroundCount = backgroundJobs.activeSize ?? backgroundJobs.size;
    const maintenanceCount = streamMaintenance.activeCount();
    const admissionPending = runCoordinator.hasPendingAdmission(() => true) === true;
    const count = runs.length + backgroundCount + maintenanceCount + Number(admissionPending);
    const request = getRestartRequest();
    const blockingRunIds = runs.slice(0, 20).map((run) => String(run.id ?? "").slice(0, 200));
    const key = JSON.stringify([request?.operationId, blockingRunIds, count,
      backgroundCount, maintenanceCount, admissionPending, isStopping()]);
    if (request?.operationId && key !== lastReadinessTrace) {
      try {
        const recorded = runtimeRestart.commandTrace?.recordBestEffort?.({
          commandId: request.operationId, stage: "restart-readiness", transport: "runtime",
          outcome: count ? "waiting" : isStopping() ? "stopping" : "ready",
          metadata: { blockingRunIds, blockersTruncated: runs.length > 20,
            blockingRunCount: runs.length, backgroundCount, maintenanceCount, admissionPending,
            requestedAt: request.requestedAt ?? null },
        });
        if (recorded !== false) lastReadinessTrace = key;
      } catch { /* Diagnostics cannot alter the synchronous admission/cutover decision. */ }
    }
    return count;
  }

  async function performRestart() {
    if (!restartRequestService.canPerform(getRestartRequest()?.operationId)) {
      return { status: "reconciling" };
    }
    const result = await runtimeRestartController.perform();
    if (result.status === "failed") process.exitCode = 1;
    return result;
  }

  function scheduleDeferredRestartIfReady() {
    const request = getRestartRequest();
    if (!request || !restartRequestService.canPerform(request.operationId)
      || restartHasBlockingWork() || isStopping() || restartScheduled) return false;
    restartScheduled = true;
    setTimeout(() => {
      restartScheduled = false;
      void restartRequestService.performScheduled(request.operationId);
    }, 0).unref?.();
    return true;
  }

  const composition = createRuntimeRestartComposition({
    ...runtimeRestart,
    hasBlockingWork: restartHasBlockingWork,
  });
  runtimeRestartController = composition.runtimeRestart;

  return {
    ...composition,
    restartBlockingRuns,
    restartBlockingWorkCount,
    restartHasBlockingWork,
    scheduleDeferredRestartIfReady,
    performRestart,
    restartBot: () => restartRequestService.fromTelegram(),
    restartMessageIsEditable: (...args) => composition.restartNotifications.editable(...args),
    announceDesktopRestart: (...args) => composition.restartNotifications.announceDesktop(...args),
    updateRestartMessage: (...args) => composition.restartNotifications.update(...args),
    finalizeRestartMessage: (...args) => composition.restartNotifications.finalize(...args),
  };
}
