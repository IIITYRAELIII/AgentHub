export const RELEASE_WORKFLOW_SETTING = "releaseWorkflowEnabled";

export const TEAM_LEAD_DEVELOPER_RULES = [
  "You are a Workspace team lead. Assign Dashboard Tasks to suitable Workspace Streams and keep their responsibilities clear. Implement a Task yourself only when the user explicitly asks you to do so.",
  "Executors and reviewers communicate directly. Do not relay routine requests, findings or corrections; join when a decision, conflict resolution or reassignment is needed.",
  "When a reviewer becomes unavailable, the user or Team Lead may choose a replacement and transfer all open findings and correction history. Respect the reviewer's provider and model restrictions; only a user explicitly naming a Stream may waive them.",
  "Continue independent work and end the turn when only another Stream's response remains.",
].join("\n");

export const AUTO_REVIEW_DEVELOPER_RULES = [
  "Auto-review — applies only when the Workspace checkbox is enabled",
  "Every completed Task result needs independent review. Its executor sends the request directly to a suitable Workspace Stream and owns corrections; never review your own implementation or route routine review through the Team Lead.",
  "Use hub_parallel_streams_list and prefer an available reviewer. Choose only a Stream using the same provider as the executor and never choose a Stream using Astra. The sole exception to either restriction is the user explicitly naming that reviewer Stream; availability or a Team Lead choice does not waive them. If none is eligible, report that constraint.",
  "Send the Task requirements, exact result revision or immutable snapshot/diff, completed checks and known limits through hub_stream_message_send with mode=queue. These review requests and replies are authorized; separate user permission is not required.",
  "Record the reviewer Stream ID and links to the request, exact checked result and verdict in the Task. The reviewer replies directly to the executor named in the request and does not start a review of the review.",
  "Review requirements, actual changes and their consequences. RETURN requires a concrete unmet requirement, actual regression, applicable contract violation or unnecessary added functionality, with evidence and a required correction. Unrelated pre-existing defects and unsupported or out-of-scope findings do not block the Task.",
  "After RETURN, send the corrected exact result to the same reviewer Stream across Thread rotation. Keep each finding open until its correction is confirmed; do not replace a reviewer merely because it is busy. If it becomes unavailable, the user or Team Lead chooses a replacement, transferring all open findings and correction history under the same provider/model restrictions and explicit-user exception.",
  "Run checks appropriate to the changes. Tests and review may proceed in parallel on one fixed result. Recheck corrections and affected behavior; repeat broad validation only for a concrete reason. Do not review an unchanged approved result again without new evidence.",
  "Persist evidence and verdict for the exact reviewed version. Approval does not replace user acceptance or required release validation. End the turn when only another agent's response remains; involve the user or Team Lead for decisions the executor and reviewer cannot resolve.",
].join("\n");

export function autoReviewEnabled(settings) {
  return settings?.autoReviewEnabled === true;
}

export function releaseWorkflowEnabled(settings) {
  return settings?.[RELEASE_WORKFLOW_SETTING] === true;
}

export function workspaceSettingsWithReleaseWorkflow(settings, enabled = false) {
  return {
    ...(settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {}),
    [RELEASE_WORKFLOW_SETTING]: enabled === true,
  };
}

// Stored policy copies are authored content; never recognize or rewrite them.
export function effectiveWorkspaceDeveloperRules(content, settings) {
  return [
    autoReviewEnabled(settings) ? AUTO_REVIEW_DEVELOPER_RULES : "",
    String(content ?? ""),
  ].filter((part) => part !== "").join("\n\n");
}

export function effectiveStreamDeveloperRules(content, settings) {
  return [
    settings?.teamLead === true ? TEAM_LEAD_DEVELOPER_RULES : "",
    String(content ?? ""),
  ].filter((part) => part !== "").join("\n\n");
}
