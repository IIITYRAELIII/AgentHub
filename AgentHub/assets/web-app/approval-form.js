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
    if (approval.kind === "async-user-input") {
      return approval.state === "dispatching" ? [] : [{ id: "decline", label: "Закрыть вопрос", kind: "danger" }];
    }
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

  function approvalsForTask(approvals, task, { serverSelected = false } = {}) {
    return (Array.isArray(approvals) ? approvals : []).filter((approval) => {
      if (approval.kind === "async-user-input") {
        return Boolean(task?.streamId) && approval.streamId === task.streamId;
      }
      if (approval.runId) return approval.runId === task?.run?.id;
      return serverSelected;
    }).map((approval) => ({
      id: approval.key ?? approval.id,
      kind: approval.kind ?? "Подтверждение",
      text: approval.text ?? approval.preview ?? approval.reason ?? "",
      questions: Array.isArray(approval.questions) ? approval.questions : null,
      state: approval.state ?? null,
      answers: approval.answers ?? null,
      options: approvalOptions(approval),
    }));
  }

  const renderedCards = new WeakMap();
  function reconcileApprovals(container, approvals, render) {
    const previous = renderedCards.get(container) ?? new Map();
    const next = new Map();
    const nodes = approvals.map((approval) => {
      const signature = JSON.stringify(approval);
      const retained = previous.get(approval.id);
      const card = retained?.signature === signature ? retained.node : render(approval);
      next.set(approval.id, { signature, node: card });
      return card;
    });
    // Reuse unchanged cards so a background update of another question cannot
    // erase a typed answer, the radio selection, caret or focus.
    for (const node of [...container.children]) {
      if (!nodes.includes(node)) node.remove();
    }
    for (const [index, node] of nodes.entries()) {
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] ?? null);
    }
    container.hidden = nodes.length === 0;
    renderedCards.set(container, next);
  }

  window.AgentHubApprovalForm = Object.freeze({
    approvalContainer, approvalOptions, collectAnswers, approvalsForTask, reconcileApprovals,
  });
})();
