(function workspaceReleasePrimaryGuardModule(global) {
  "use strict";

  const current = global.AgentHubWorkspaceTaskWorkflow;
  if (!current?.tooltip) return;
  const primaryRule = "Операции claim, Test и Await используют свои управляемые checkout и сохраняют HEAD, индекс и рабочие файлы основного репозитория Workspace.";
  const tooltip = Object.freeze([
    ...current.tooltip,
    ...(current.tooltip.includes(primaryRule) ? [] : [primaryRule]),
  ]);

  function renderTooltip(container) {
    const document = container?.ownerDocument;
    if (!container || !document?.createElement) return false;
    container.replaceChildren(...tooltip.map((text) => {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      return paragraph;
    }));
    return true;
  }

  global.AgentHubWorkspaceTaskWorkflow = Object.freeze({
    ...current,
    tooltip,
    primaryRule,
    renderTooltip,
  });
})(window);
