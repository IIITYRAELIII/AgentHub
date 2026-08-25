(() => {
  "use strict";

  function restartWaitingMessage(blockingCount) {
    const count = Math.max(0, Number(blockingCount) || 0);
    return count
      ? `Agent Hub ожидает завершения блокирующей работы: ${count}.`
      : "Agent Hub ожидает завершения блокирующей работы.";
  }

  function transientFailureDecision({
    hasSnapshot = false,
    failureCount = 0,
    elapsedMs = 0,
    offlineFailures = 3,
    graceMs = 6_000,
  } = {}) {
    if (Number(failureCount) >= Number(offlineFailures) || Number(elapsedMs) >= Number(graceMs)) {
      return "offline";
    }
    return hasSnapshot ? "hold" : "connecting";
  }

  function snapshotConnectionState(snapshot, idleStatus = "online") {
    const hasDetailedCount = snapshot?.restartBlockingCount != null;
    const blockingCount = Math.max(
      0,
      Number(hasDetailedCount ? snapshot.restartBlockingCount : snapshot?.activeCount) || 0,
    );
    const waiting = Boolean(snapshot?.restartPending) && (
      snapshot?.restartWaiting === true || blockingCount > 0
    );
    return {
      status: waiting ? "restart-waiting" : snapshot?.restartPending ? "restarting" : idleStatus,
      blockingCount,
    };
  }

  window.AgentHubConnectionBanner = Object.freeze({
    restartWaitingMessage,
    snapshotConnectionState,
    transientFailureDecision,
  });
})();
