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

  window.AgentHubConnectionBanner = Object.freeze({ restartWaitingMessage, transientFailureDecision });
})();
