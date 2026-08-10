(() => {
  "use strict";

  function approvalContainer(trigger) {
    return trigger?.closest?.(".approval") ?? null;
  }

  function collectAnswers(trigger) {
    const answers = {};
    const approval = approvalContainer(trigger);
    for (const field of approval?.querySelectorAll?.("[data-approval-question]") ?? []) {
      const id = String(field?.dataset?.approvalQuestion ?? "").trim();
      if (!id) continue;
      const selected = field.querySelector?.("input[type='radio']:checked")?.value ?? "";
      const other = field.querySelector?.("[data-approval-other]")?.value?.trim() ?? "";
      answers[id] = [other || selected].filter(Boolean);
    }
    return answers;
  }

  window.AgentHubApprovalForm = Object.freeze({ approvalContainer, collectAnswers });
})();
