export const RELEASE_PRIMARY_WORKSPACE_RULE = "The registered primary Workspace is never a release checkout: do not detach, switch, checkout, reset, stash, clean, or otherwise mutate its HEAD, index, or working tree. Build and publish the frozen release only from releaseCandidates[].releaseRoot in the Agent Hub-owned standalone clone; never create or reuse a legacy linked release worktree.";

export const ARCHITECT_RELEASE_PRIMARY_WORKSPACE_RULE = "As release Architect, use releaseCandidates[].releaseRoot as the only checkout for the frozen release. Never detach, switch, checkout, reset, stash, clean, or otherwise mutate the registered primary Workspace, and never create or reuse a legacy linked release worktree.";

function appendRule(content, rule) {
  const source = String(content ?? "").trim();
  if (!source) return rule;
  if (source.includes(rule)) return source;
  return `${source}\n${rule}`;
}

export function withReleasePrimaryWorkspaceRule(content, settings) {
  return settings?.releaseWorkflowEnabled === true
    ? appendRule(content, RELEASE_PRIMARY_WORKSPACE_RULE)
    : String(content ?? "");
}

export function withArchitectReleasePrimaryWorkspaceRule(content, settings) {
  if (settings?.architect !== true) return String(content ?? "");
  const withoutLinkedCheckoutInstructions = String(content ?? "")
    .split("\n")
    .filter((line) => !line.startsWith("After updating main, freeze the exact release set."))
    .map((line) => line.startsWith("At the start of the release, update local main from origin")
      ? ARCHITECT_RELEASE_PRIMARY_WORKSPACE_RULE
      : line)
    .join("\n");
  return appendRule(withoutLinkedCheckoutInstructions, ARCHITECT_RELEASE_PRIMARY_WORKSPACE_RULE);
}
