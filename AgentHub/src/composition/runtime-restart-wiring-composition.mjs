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
    const result = await runtimeRestartController.perform();
    if (result.status === "failed") process.exitCode = 1;
    return result;
  }

  function scheduleDeferredRestartIfReady() {
    if (getRestartRequest()?.waitingForRuns && !restartHasBlockingWork() && !isStopping()) {
      setTimeout(() => void performRestart(), 0).unref?.();
    }
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
