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

  function approvalOptions(approval = {}) {
    if (approval.kind === "user-input") {
      return [{ id: "decline", label: "Отменить", kind: "danger" }];
    }
    const url = String(approval.url ?? "").trim();
    return [
      ...(url
        ? [{ id: "once", label: "Открыть и продолжить", kind: "primary", href: url }]
        : approval.canAccept === false
          ? []
          : [{ id: "once", label: "Разрешить", kind: "primary" }]),
      ...(approval.canAllowSession === false ? [] : [{ id: "session", label: "На сессию" }]),
      { id: "decline", label: "Отклонить", kind: "danger" },
    ];
  }

  window.AgentHubApprovalForm = Object.freeze({ approvalContainer, approvalOptions, collectAnswers });
})();
