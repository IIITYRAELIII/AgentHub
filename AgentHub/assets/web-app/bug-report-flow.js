"use strict";

(() => {
  function pending() {
    return {
      sending: true,
      formHidden: false,
      expanded: true,
      status: "Создаём отчёт и отправляем его в Git…",
      statusState: "pending",
      focus: false,
    };
  }

  function complete(result = {}) {
    if (result.error) {
      return {
        sending: false,
        formHidden: false,
        expanded: true,
        status: String(result.error),
        statusState: "error",
        focus: true,
      };
    }
    return {
      sending: false,
      formHidden: true,
      expanded: false,
      status: "",
      statusState: "",
      focus: false,
    };
  }

  window.AgentHubBugReportFlow = { pending, complete };
})();
