(function workspaceReleaseWorkflowModule(global) {
  "use strict";

  const tooltip = [
    "Release workflow — applies only when the checkbox is enabled",
    "Any work that changes code, configuration, data, documentation, or another deliverable MUST be performed in a Dashboard Task.",
    "If no suitable Task exists, create it before the first edit. If the Task already exists, assign it to the current Stream before the first edit. Do not change files or data without a created and assigned Task.",
    "Do not create a Task for diagnosis, reading, investigation, or answers that require no changes. If diagnosis reveals required changes, create or assign a Task before continuing.",
    "Keep the Task title concise and outcome-oriented. Preserve the user's original request in its description; do not copy it verbatim into the title unless explicitly requested.",
    "Assign the Task to the current Stream and current provider turn with hub_task_claim. The current Stream becomes the Task executor.",
    "Select the project root from the current Stream working directory, then fall back to the Workspace working directory. Never select it from a historical provider Thread.",
    "Use statuses as follows: In Progress — implementation is underway; Test — implementation is complete and submitted for verification; Await — the result is accepted and awaiting inclusion in a release; Done — publication to production is verified.",
    "Move a Task to Test as soon as implementation is complete. Move it to Await only after the result is accepted.",
    "Every changing Task must use its own Git branch created from current main and a separate managed sparse worktree. Never perform Task work in a shared working tree.",
    "Create the branch and worktree through hub_task_claim or hub_task_start. Do not change files before they are available.",
    "Agent Hub may create Task snapshot commits and managed merge commits only during workflow-status transitions. Do not create unrelated commits, push, or deploy without explicit user authorization.",
    "When a Task moves to Test, or directly to a later status, snapshot its latest branch result and merge that result into dev.",
    "When a Task moves to Await, rebuild PreRelease from current main and the exact result commits of all accepted Await Tasks.",
    "Never merge dev into PreRelease. Changes belonging only to Tasks in Test must not enter PreRelease.",
    "If an Await Task is returned for revision, withdrawn, or excluded, rebuild PreRelease without it. A newly accepted Task result completely replaces its previous result.",
    "A merge conflict does not cancel the selected status, but a Task without successful dev and PreRelease integration is blocked and cannot be released.",
    "Only the user's explicit release command authorizes release tests, builds, final integration, push, production deployment, and release completion. The authorization applies only to the current release.",
    "In a regular Stream, the release command accepts the current Task and prepares it for Await but does not publish production. Only an Architect may freeze and publish the release.",
  ];

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
    tooltip: Object.freeze(tooltip.slice()),
    renderTooltip,
  });
})(window);
