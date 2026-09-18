(function workspaceReleasePrimaryGuardModule(global) {
  "use strict";

  const current = global.AgentHubWorkspaceReleaseWorkflow;
  if (!current?.tooltip) return;
  const primaryRule = "The registered primary Workspace is never a release checkout: do not detach, switch, checkout, reset, stash, clean, or otherwise mutate its HEAD, index, or working tree. Build and publish the frozen release only from releaseCandidates[].releaseRoot in the Agent Hub-owned standalone clone; never create or reuse a legacy linked release worktree.";
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

  global.AgentHubWorkspaceReleaseWorkflow = Object.freeze({
    ...current,
    tooltip,
    primaryRule,
    renderTooltip,
  });
})(window);
