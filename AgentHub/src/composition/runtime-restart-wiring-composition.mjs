import process from "node:process";

import { createRuntimeRestartComposition } from "./runtime-restart-composition.mjs";

export function createRuntimeRestartWiring({
  taskRuns,
  agentProviders,
  backgroundJobs,
  streamMaintenance,
  getRestartRequest,
  isStopping,
  restartRequestService,
  runtimeRestart,
}) {
  let runtimeRestartController;
  let restartScheduled = false;

  function restartBlockingRuns() {
    return taskRuns.values().filter((run) => (
      agentProviders.call(run.provider, "blocksRuntimeRestart", run)
    ));
  }

  function restartHasBlockingWork() {
    return restartBlockingWorkCount() > 0;
  }

  function restartBlockingWorkCount() {
    return restartBlockingRuns().length
      + backgroundJobs.size
      + streamMaintenance.activeCount();
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
