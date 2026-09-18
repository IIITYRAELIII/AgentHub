export const RELEASE_PRIMARY_WORKSPACE_RULE = "The registered primary Workspace is never a release checkout: do not detach, switch, checkout, reset, stash, clean, or otherwise mutate its HEAD, index, or working tree. Build and publish the frozen release only from releaseCandidates[].releaseRoot in the Agent Hub-owned standalone clone; never create or reuse a legacy linked release worktree.";

export const RELEASE_MANAGER_RELEASE_PRIMARY_WORKSPACE_RULE = "As Release Manager, use releaseCandidates[].releaseRoot as the only checkout for the frozen release. Never detach, switch, checkout, reset, stash, clean, or otherwise mutate the registered primary Workspace, and never create or reuse a legacy linked release worktree.";

function appendRule(content, rule) {
  const source = String(content ?? "");
  if (!source) return rule;
  return `${source}\n${rule}`;
}

export function withReleasePrimaryWorkspaceRule(content, settings) {
  return settings?.releaseWorkflowEnabled === true
    ? appendRule(content, RELEASE_PRIMARY_WORKSPACE_RULE)
    : String(content ?? "");
}

export function withReleaseManagerReleasePrimaryWorkspaceRule(content, settings) {
  return settings?.releaseManager === true
    ? appendRule(content, RELEASE_MANAGER_RELEASE_PRIMARY_WORKSPACE_RULE)
    : String(content ?? "");
}
