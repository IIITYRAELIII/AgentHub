export const RELEASE_WORKFLOW_SETTING = "releaseWorkflowEnabled";

export const LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1 = [
  "This Workspace uses a multi-stream, release-oriented workflow.",
  "These rules are the specific workflow policy for this Workspace and override conflicting repository defaults, including any general instruction to commit or push by default.",
  "Do not run tests or builds, create commits, push, or deploy to production unless the user explicitly requests that action or requests a release in the current task.",
  "A release authorization applies only to the release explicitly requested by the user. Once that release is completed, it does not authorize committing, pushing, testing, building, or deploying later changes; require a new explicit user request.",
].join("\n");

export const LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2 = [
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  "For every actionable change, find a suitable Dashboard Task or create one, then immediately claim it for the exact current Stream and provider turn with hub_task_claim.",
  "Update the claimed Task at the end of every turn. A turn with no diff creates no changed-file or release evidence.",
  "A finished fix requests awaiting_implementation during that same exact claimed turn so the Hub can freeze verified evidence at terminal completion.",
  "A finished analysis Task is closed when the work is complete or the user switches topic; unfinished analysis remains open.",
  "Architect Streams collect awaiting_implementation Tasks and audit visible done Tasks. Verified release completion marks and closes only the exact frozen Tasks included in that release.",
].join("\n");

export const RELEASE_WORKFLOW_DEVELOPER_RULES = [
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  "Create or claim a Dashboard Task only when the requested work requires repository, configuration, data, or other deliverable changes.",
  "When creating a Task, write a concise descriptive title that summarizes the deliverable; keep the user's original request in the description and do not copy it verbatim as the title unless the user explicitly requests an exact title.",
  "Do not create a Task for diagnosis, read-only investigation, explanations, answers, or other work that makes no changes.",
  "If diagnosis leads to requested changes, create or claim the Task before the first change and bind it to the exact current Stream and provider turn with hub_task_claim.",
  "Update the claimed Task at the end of every turn. A turn with no diff creates no changed-file or release evidence.",
  "A finished fix requests awaiting_implementation during that same exact claimed turn so the Hub can freeze verified evidence at terminal completion.",
  "Architect Streams collect awaiting_implementation Tasks and audit visible done Tasks. Verified release completion marks and closes only the exact frozen Tasks included in that release.",
].join("\n");

export const ARCHITECT_RELEASE_DEVELOPER_RULES = "You are a Workspace systems architect.\n"
  + "You assemble, verify, and deploy releases for this Workspace.\n"
  + "Only Streams marked as Workspace Architect may integrate and publish Workspace releases.\n"
  + "Do not wait for unrelated draft or blocked changes. Release the ready set immediately, but stop if non-ready, conflicting, overlapping, or unregistered changes affect the frozen release set, build integrity, or deployment integrity.";

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
  const prefix = [
    RELEASE_WORKFLOW_DEVELOPER_RULES,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  ]
    .find((candidate) => normalized.startsWith(candidate));
  if (!prefix) {
    return { content: source, enabled: false, migrated: false };
  }
  const boundary = normalized.slice(prefix.length, prefix.length + 1);
  if (boundary && boundary !== "\n") {
    return { content: source, enabled: false, migrated: false };
  }
  return {
    content: normalized.slice(prefix.length).replace(/^\n{1,2}/u, ""),
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

export function effectiveStreamDeveloperRules(content, settings) {
  const source = String(content ?? "");
  if (settings?.architect !== true) return source;
  return [ARCHITECT_RELEASE_DEVELOPER_RULES, source]
    .filter((part) => String(part).trim())
    .join("\n\n");
}
