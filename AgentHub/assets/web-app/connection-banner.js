(() => {
  "use strict";

  function restartWaitingMessage(blockingCount) {
    const count = Math.max(0, Number(blockingCount) || 0);
    return count
      ? `Agent Hub ожидает завершения блокирующей работы: ${count}.`
      : "Перезапуск Agent Hub запрошен; ожидается начало.";
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
      // A queued restart request (even with zero current blockers) is not
      // evidence that process replacement has started.
      status: waiting || snapshot?.restartPending ? "restart-waiting" : idleStatus,
      blockingCount,
    };
  }

  function restartFailureNotice(failure) {
    const operationId = `${failure?.operationId ?? ""}`.trim();
    if (!operationId) return null;
    const reason = `${failure?.error ?? ""}`.trim();
    return Object.freeze({
      operationId,
      message: `Перезапуск Agent Hub не выполнен: ${reason || "причина не сохранена"}.`,
    });
  }

  window.AgentHubConnectionBanner = Object.freeze({
    restartFailureNotice,
    restartWaitingMessage,
    snapshotConnectionState,
    transientFailureDecision,
  });
})();
