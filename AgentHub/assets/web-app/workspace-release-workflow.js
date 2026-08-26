(function workspaceReleaseWorkflowModule(global) {
  "use strict";

  const tooltip = [
    "Этот Workspace использует многопоточный релизный процесс.",
    "Эти правила являются специальной политикой Workspace и имеют приоритет над конфликтующими правилами репозитория, включая общие указания автоматически выполнять commit или push.",
    "Не запускать тесты и сборку, не создавать commit, не выполнять push и не развёртывать в production, пока пользователь явно не запросит это действие или релиз в текущей задаче.",
    "Разрешение на релиз относится только к явно запрошенному релизу. После его завершения оно не разрешает последующие commit, push, тесты, сборку или deployment; для них нужен новый явный запрос пользователя.",
  ];

  function pendingCount(registry) {
    if (Number.isFinite(Number(registry?.pendingTotal))) return Math.max(0, Number(registry.pendingTotal));
    return Math.max(0, Number(registry?.total) || 0) + Math.max(0, Number(registry?.changeSetTotal) || 0);
  }

  function requiresDiscardConfirmation({ enabled, registry, discardConfirmed = false } = {}) {
    return enabled !== true && discardConfirmed !== true && pendingCount(registry) > 0;
  }

  function discardConfirmationText() {
    return "Отключить релизный процесс и удалить все зарегистрированные изменения? Выпущенная история останется сохранена.";
  }

  function createDiscardConfirmation({ dialog, cancelButton, confirmButton, message } = {}) {
    let pending = null;

    function close(confirmed = false) {
      const current = pending;
      pending = null;
      if (dialog?.open) dialog.close?.();
      dialog?.removeAttribute?.("open");
      current?.resolve(confirmed === true);
    }

    function request(details = {}) {
      if (pending) return pending.promise;
      if (!dialog) return Promise.resolve(false);
      if (message) message.textContent = details.text || discardConfirmationText();
      const promise = new Promise((resolve) => { pending = { promise: null, resolve }; });
      pending.promise = promise;
      dialog.showModal?.();
      if (!dialog.open) dialog.setAttribute?.("open", "");
      cancelButton?.focus?.();
      return promise;
    }

    cancelButton?.addEventListener?.("click", () => close(false));
    confirmButton?.addEventListener?.("click", () => close(true));
    dialog?.addEventListener?.("cancel", (event) => {
      event.preventDefault?.();
      close(false);
    });

    return Object.freeze({ request, close });
  }

  global.AgentHubWorkspaceReleaseWorkflow = Object.freeze({
    tooltip: Object.freeze(tooltip.slice()),
    pendingCount,
    requiresDiscardConfirmation,
    discardConfirmationText,
    createDiscardConfirmation,
  });
})(window);
