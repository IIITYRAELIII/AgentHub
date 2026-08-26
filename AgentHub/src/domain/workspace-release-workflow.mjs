export const RELEASE_WORKFLOW_SETTING = "releaseWorkflowEnabled";

export const RELEASE_WORKFLOW_DEVELOPER_RULES = [
  "This Workspace uses a multi-stream, release-oriented workflow.",
  "These rules are the specific workflow policy for this Workspace and override conflicting repository defaults, including any general instruction to commit or push by default.",
  "Do not run tests or builds, create commits, push, or deploy to production unless the user explicitly requests that action or requests a release in the current task.",
  "A release authorization applies only to the release explicitly requested by the user. Once that release is completed, it does not authorize committing, pushing, testing, building, or deploying later changes; require a new explicit user request.",
].join("\n");

export function releaseWorkflowEnabled(settings) {
  return settings?.[RELEASE_WORKFLOW_SETTING] === true;
}

export function workspaceSettingsWithReleaseWorkflow(settings, enabled = false) {
  return {
    ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
    [RELEASE_WORKFLOW_SETTING]: enabled === true,
  };
}

export function legacyReleaseWorkflowRules(content) {
  const source = String(content ?? "");
  const normalized = source.replace(/\r\n?/gu, "\n");
  if (!normalized.startsWith(RELEASE_WORKFLOW_DEVELOPER_RULES)) {
    return { content: source, enabled: false, migrated: false };
  }
  const boundary = normalized.slice(RELEASE_WORKFLOW_DEVELOPER_RULES.length, RELEASE_WORKFLOW_DEVELOPER_RULES.length + 1);
  if (boundary && boundary !== "\n") {
    return { content: source, enabled: false, migrated: false };
  }
  return {
    content: normalized.slice(RELEASE_WORKFLOW_DEVELOPER_RULES.length).replace(/^\n{1,2}/u, ""),
    enabled: true,
    migrated: true,
  };
}

export function effectiveWorkspaceDeveloperRules(content, settings) {
  const source = String(content ?? "");
  if (!releaseWorkflowEnabled(settings)) return source;
  const legacy = legacyReleaseWorkflowRules(source);
  const userRules = legacy.migrated ? legacy.content : source;
  return [RELEASE_WORKFLOW_DEVELOPER_RULES, userRules]
    .filter((part) => String(part).trim())
    .join("\n\n");
}
