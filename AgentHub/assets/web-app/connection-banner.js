(() => {
  "use strict";

  function restartWaitingMessage(blockingCount) {
    const count = Math.max(0, Number(blockingCount) || 0);
    return count
      ? `Agent Hub ожидает завершения блокирующей работы: ${count}.`
      : "Agent Hub ожидает завершения блокирующей работы.";
  }

  window.AgentHubConnectionBanner = Object.freeze({ restartWaitingMessage });
})();
