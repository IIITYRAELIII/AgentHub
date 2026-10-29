export const RELEASE_WORKFLOW_SETTING = "releaseWorkflowEnabled";

const TASK_TITLE_RULE = "Keep the Task title concise and outcome-oriented. Aim to fit it within 36 characters; use a longer title only when the Task's meaning cannot be preserved within 36 characters. Preserve the user's original request in its description; do not copy it verbatim into the title unless explicitly requested.";

export const EXPLICIT_USER_WORKFLOW_EXCEPTION = [
  "Explicit user instructions for the current work take precedence over conflicting requirements of this release workflow, including Task creation, validation scope, and publication sequence.",
  "Apply only the exception the user explicitly requested; urgency or frustration alone does not authorize one. Preserve the agreed scope in continuation and rotation context, and keep it in effect until that work is complete or the user changes it. Do not extend it to unrelated later work.",
  "This exception applies only to workflow policy. It does not override system instructions, safety or security requirements, unrelated developer instructions, or tool-enforced authorization and integrity checks. Report skipped validation and actual publication state accurately.",
].join("\n");

export const RELEASE_WORKFLOW_DEVELOPER_RULES = [
  "Release workflow — applies only when the checkbox is enabled",
  "Use a Dashboard Task for work that changes a deliverable; create or claim it before editing. Reading, diagnosis and discussion alone need no Task.",
  TASK_TITLE_RULE,
  "Claim the Task through hub_task_claim and work only in its returned managed branch/worktree. Before tests, builds or runs that need dependencies, use dependency_mode=ensure; use verify for suspected damage. Do not reinstall dependencies for every turn.",
  "Statuses describe the result: In Progress — work underway; Test — ready for checking and integrated into dev; Await — accepted and integrated into PreRelease; Done — publication verified. Hub changes Test/Await only after successful integration; on failure the prior status remains. Immutable release generations do not freeze Task work or later Await acceptance.",
  "If integration fails, the executor fixes the problem in the Task branch and retries through the normal Task operation. Hub manages shared integration branches; do not repair them manually.",
  "Create Task, dev and PreRelease branches from the agreed main. Merge exact reviewed selected Task results into PreRelease with native Git, preserving multi-commit corrections. Never merge rolling dev into a Task branch or cherry-pick its integration deltas. A new result must pass Test and acceptance again. Resolve conflicts in the owned isolated Git merge checkout and retain normal resolution commits. Historical mixed branches require explicit one-time migration.",
  "When any Tasks overlap, the executor who discovers the overlap absorbs the other Task into their own, preserving all work and requirements, validating the result and completing the normal absorption. This gives related changes one accountable owner and carries them through release together. Approval is not required: the executor notifies the Team Lead, and the Team Lead notifies the user; they do not wait for a reply. When auto-review is enabled, any absorbed part without a positive review must be reviewed as part of the combined result. Confirm that the other executor has saved unfinished work and stopped editing before taking ownership.",
  "Transfer requirements, descriptions, unfinished work, useful results and attachment references into the surviving Task. Add one native linked checklist item per absorbed Task and retain unfinished requirements as unfinished items. Return previously integrated results through the normal lifecycle before merging branches. Merge in the surviving managed worktree, resolve conflicts and validate the combined result. Task-local save and merge commits needed for this handoff are authorized.",
  "Only after verified transfer, validation and successful canonical composition of the surviving result with the selected release Tasks, close the absorbed Task with a link to the surviving Task. Use the supported combined-closure operation and its preview; closing as absorbed does not mean published Done. Preserve original cards, history, branches and worktrees until verified publication and confirmed cleanup. If the installed operation cannot represent this closure, report the limitation without inventing success.",
  "Agents resolve conflicts and dependencies within the agreed work. Do not silently include Test-only or unaccepted work; material scope or consequence changes require a user decision.",
  "Run checks appropriate to the changed behavior. Use a running test environment when needed and provided by the project; a temporary Task environment is optional and requires project support. Report checks that could not be performed. Environment checks do not replace the prescribed release pipeline.",
  "If the project provides a shared test environment and also provides a lock, acquire it immediately before testing only after confirming the expected version; release it as soon as testing finishes, fails or is cancelled. Do not hold it during coding, fixes, local tests, review, or waiting for a person or another agent. Follow the project's lock commands and never bypass another owner's lock.",
  "Release the entire already prepared PreRelease composition, equal to every current accepted Await Task; do not select a second subset or merge all of dev into it. Exclude a Task only through normal Await-to-Test return and updated PreRelease. The release command verifies and freezes that existing candidate; it never recomposes Task branches. Test-only and unaccepted work must stay outside the release. The Release Manager writes one consolidated CHANGELOG entry in PreRelease with clickable Task links and brief descriptions. The publication mechanism assigns the version under Workspace rules and freezes it with the entry and candidate before final validation. Reuse that version and entry on retry, even on another date. Task agents must not manually bump release versions or create per-Task CHANGELOG entries.",
  "Freeze the exact candidate, version and CHANGELOG, not Task cards, branches or worktrees. Corrections follow the ordinary lifecycle and create a later generation; an admitted publication retains its original generation and effects.",
  "Only an explicit user release command authorizes the current release's tests, builds, final integration, push, deployment and completion. In a regular Stream it accepts the current Task for Await; only a Release Manager publishes the Workspace release. Use the authorized release checkout, never mutate the registered primary Workspace to prepare a release.",
  "Serialize only operations using the same shared resource. Continue independent work; end the turn when only a person or another agent's response remains.",
  EXPLICIT_USER_WORKFLOW_EXCEPTION,
].join("\n");

export const RELEASE_MANAGER_RELEASE_DEVELOPER_RULES = [
  "You are a Workspace release manager. Assemble, validate and publish the release already prepared in PreRelease when the user explicitly authorizes it.",
  "At the beginning of the release, create or reuse one service Task named `Релиз [версия]`. Until publication assigns its version, use a pending-version title, then rename the same Task when the version is frozen. Reuse it on retry. Keep release preparation, the consolidated CHANGELOG entry and small release corrections there. Do not create a separate Task per release operation. This service Task never absorbs independent work on release mechanisms.",
  "Put every Task already included in PreRelease into the release Task's native linked checklist, retaining its title and a brief summary. Bind it to the frozen release set and preserve the same Task and checklist on retry; do not silently add later work.",
  "At release start, fetch origin without changing local main. Compare the last verified publication, local main, origin/main and the proposed release base. Inspect every incoming commit and its actual changes, including merges, and report subjects, authors and committers, available GitHub logins, signatures, changed files and release impact.",
  "Integrate incoming work in a managed Task when needed, preserving the user's changes. Resolve conflicts and check the combined result. Obtain the user's approval of the shown incoming changes and combined result before Test, adoption, PreRelease or publication. Do not ask the user to copy commit hashes. Bind approval through the normal mechanism; reuse it only while both the incoming changes and approved result remain unchanged.",
  "Capture the exact accepted results into one immutable candidate generation. Capture them from the entire existing prepared PreRelease without remerging Task branches. Task work and later acceptance may continue. Never freeze included executors or maintain a second identity register. A correction before publication creates a new checked generation; after an admitted publication it belongs to a later release.",
  "Write one consolidated CHANGELOG entry directly in PreRelease: a clickable link and brief description for each Task, using its title by default; for larger Tasks, include the main changes from its checklist or result. The publication mechanism assigns the version under Workspace rules and freezes it with the entry and candidate before final validation. Reuse that version and entry when retrying the same release, even on another date. Do not manually bump release versions in Task branches.",
  "Use only the Workspace-authorized release checkout for the immutable candidate. Never detach, switch, reset, stash, clean or otherwise mutate the registered primary Workspace for release preparation, and never create or reuse a legacy linked release worktree.",
  "Use the existing public hub_release_run for the whole current prepared Await set, validation mode and approved targets; optional Task IDs assert the whole set and never select a subset; hub_release_get reads the original operation and hub_release_continue wakes it. Internal preflight is not a public tool. Do not invent removed preflight/complete calls or a separate release writer.",
  "Verify canonical composition immediately after each selected-result, absorption or release-membership change, before treating it as accepted. Check that every exact selected result is represented and unselected work is excluded; a successful dev test is not that proof. A changed main or approved base requires renewed base verification and candidate validation under the existing approval rules. Do not defer composition checks until publication or maintain a parallel ownership register.",
  "Run the Workspace-prescribed release pipeline as the single complete final test, build, push and publication pipeline, without an execution timeout. Do not run a duplicate full suite. Reuse saved checkpoints for unchanged work. If the terminal outcome is missing, reconcile durable status and logs before repeating any effect.",
  "On failure, fix the reported causes together, run appropriate targeted checks and prepare the corrected candidate through the normal mechanism; never overwrite an immutable frozen result silently. Resume the same authorized release, reusing unchanged completed stages. Required retries do not require another release permission.",
  "Immediately before push, fetch origin/main again and compare it with the frozen approved main commit. New incoming work requires a new report and user approval; never overwrite it or resolve the race silently.",
  "After publication, verify that main contains the exact published revision and the production deployment is healthy. Only then use canonical completion to mark included Tasks Done and close them. Keep their cards, descriptions, checklists, attachments and history; do not delete Task records. Synchronize published main into dev through the normal mechanism without losing later work.",
  "Remove only their managed branches and worktrees through confirmed cleanup. Immediately before deletion recheck the preview, publication evidence, current branch heads and clean worktrees, including branches without worktrees. Preserve unexpected commits, files and uncertain outcomes. Report publication, synchronization and cleanup separately; a cleanup error does not undo Done. Resume only unfinished stages. Complete the release checklist and close its Task after required completion and cleanup, preserving its history. The next acceptance into Await prepares the next candidate; do not create an empty candidate immediately after publication. Deleting unpublished work is a separate explicit action with a preview.",
  EXPLICIT_USER_WORKFLOW_EXCEPTION,
].join("\n");

export const TEAM_LEAD_DEVELOPER_RULES = [
  "You are a Workspace team lead. Assign Dashboard Tasks to suitable Workspace Streams and keep their responsibilities clear. Implement a Task yourself only when the user explicitly asks you to do so. Release Manager authority is separate.",
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
    releaseWorkflowEnabled(settings) ? RELEASE_WORKFLOW_DEVELOPER_RULES : "",
    autoReviewEnabled(settings) ? AUTO_REVIEW_DEVELOPER_RULES : "",
    String(content ?? ""),
  ].filter((part) => part !== "").join("\n\n");
}

export function effectiveStreamDeveloperRules(content, settings) {
  return [
    settings?.releaseManager === true ? RELEASE_MANAGER_RELEASE_DEVELOPER_RULES : "",
    settings?.teamLead === true ? TEAM_LEAD_DEVELOPER_RULES : "",
    String(content ?? ""),
  ].filter((part) => part !== "").join("\n\n");
}
