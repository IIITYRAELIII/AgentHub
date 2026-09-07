export const RELEASE_WORKFLOW_SETTING = "releaseWorkflowEnabled";

export const LEGACY_AGENT_HUB_WORKSPACE_DEVELOPER_RULES_RU_V1 = [
  "Правила Agent Hub",
  "Dashboard Task создаётся только для работы, которая изменяет код, конфигурацию, данные, документацию или другой поставляемый результат.",
  "Для диагностики, чтения, исследования, объяснений и ответов без изменений Task не создаётся.",
  "Если после диагностики нужны изменения, до первой правки создай или назначь Task текущему Stream и точному ходу через hub_task_claim.",
  "Название Task должно кратко описывать ожидаемый результат; исходный запрос пользователя сохраняй в описании.",
  "После завершения реализации переводи Task в Test. В Await — только после принятия результата; Done — только после подтверждённой публикации.",
].join("\n");

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

export const LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES = [
  "This Workspace uses a multi-stream, Task-branch release workflow.",
  "These rules are the specific workflow policy for this Workspace and override conflicting repository defaults, including any general instruction to commit or push by default.",
  "Do not run tests or builds, push, or deploy to production unless the user explicitly requests that action or requests a release in the current task.",
  "A release authorization applies only to the release explicitly requested by the user. Once that release is completed, it does not authorize later validation, push or deployment; require a new explicit user request.",
  "",
  "Task branches and roots",
  "Create or claim a Dashboard Task only when the requested work requires repository, configuration, data or another deliverable change.",
  "When creating a Task, write a concise descriptive title and keep the user's original request in the description.",
  "Do not create a Task for diagnosis, read-only investigation, explanations or answers.",
  "Before the first change, bind the Task to the exact current Stream and provider turn with hub_task_claim.",
  "Every changing Task must use its dedicated main-based Git branch and managed sparse worktree returned by hub_task_claim or hub_task_start. Never edit a shared working tree for Task work.",
  "Select the Git project root from the current Stream working-directory setting, then the Workspace working-directory setting. Never select it from a historical provider Thread.",
  "Agent Hub may create Task snapshot commits and managed dev or PreRelease merge commits only as part of the status transitions below. Do not create unrelated commits without explicit user authorization.",
  "Task branches must not edit CHANGELOG.md. Changelog is release history, not Task ownership evidence.",
  "",
  "Test and acceptance integration",
  "When a Task moves to testing, or directly to a later implementation status, snapshot its latest Task result and merge it into dev.",
  "The shared Test Contour is always built from dev. After each successful Test integration, refresh Test Contour without running tests, builds, linters, pushes or production deployment.",
  "Test Contour is a rolling integration preview, not a release gate or exact production duplicate. It may contain simultaneous Test and Await work, substitutes Stream agents with Spark, keeps production provider Threads detached and does not collect Codex limits.",
  "When a Task moves to awaiting_implementation, additionally rebuild PreRelease from current main plus the exact result commits of all accepted Await Tasks.",
  "Never merge dev into PreRelease. Test-only changes present in dev must not enter PreRelease.",
  "Returning, withdrawing or excluding an Await Task rebuilds PreRelease without that Task. Repeated Task edits replace its previous accepted result.",
  "Report merge conflicts without rejecting the selected workflow status. An Await Task without successful dev and PreRelease integration remains blocked and must not be released.",
  "",
  "Release process",
  "Only the user's explicit `релиз` command authorizes validation, final integration, push, production deployment and release completion.",
  "In a non-Architect Stream, `релиз` accepts the current Task and prepares it for Await, but does not publish.",
  "Only an Architect Stream may freeze and publish a Workspace release.",
  "At release start, read the complete Task release plan and select its exact plan revision and included Task IDs.",
  "Write one consolidated CHANGELOG.md entry directly in PreRelease for that selected set, then freeze the resulting exact PreRelease heads. Do not add changelog entries to individual Task branches.",
  "Do not silently include later Await Tasks. Validate and publish the frozen PreRelease revision, never the mutable dev head.",
  "After verified publication, close only the included Tasks, incorporate published main into dev without discarding later Test work, and rebuild PreRelease from any remaining Await Tasks.",
  "Dashboard Tasks and their Git evidence are the live ownership and readiness authority; CHANGELOG.md is the canonical consolidated release history.",
].join("\n");

export const LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V2 = [
  "Релизный процесс — действует только при включённой галочке",
  "Любая работа, которая изменяет код, конфигурацию, данные, документацию или другой поставляемый результат, ОБЯЗАНА выполняться в Dashboard Task.",
  "Если подходящей Task нет — создай её до первой правки. Если Task уже существует — назначь её текущему Stream до первой правки. Запрещено изменять файлы или данные без созданной и назначенной Task.",
  "Для диагностики, чтения, исследования и ответов без изменений Task не создаётся. Если после диагностики потребовались изменения — сначала создай или назначь Task, затем продолжай работу.",
  "Название Task должно кратко описывать ожидаемый результат. Исходный запрос пользователя сохраняется в описании и не копируется дословно в название без явной просьбы.",
  "Назначай Task текущему Stream и текущему ходу провайдера через hub_task_claim. Текущий Stream становится исполнителем Task.",
  "Корень проекта выбирай из рабочей директории текущего Stream, а если она не задана — из рабочей директории Workspace. Никогда не выбирай корень проекта из исторического provider Thread.",
  "Используй статусы: In Progress — реализация выполняется; Test — реализация завершена и передана на проверку; Await — результат принят и ожидает включения в релиз; Done — публикация результата в production подтверждена.",
  "Сразу после завершения реализации переводи Task в Test. Переводи её в Await только после принятия результата.",
  "Каждая изменяющая Task выполняется в собственной Git-ветке, созданной от актуального main, и в отдельном управляемом sparse worktree. Запрещено выполнять Task в общем рабочем каталоге.",
  "Ветка и worktree создаются через hub_task_claim или hub_task_start. До их получения изменять файлы запрещено.",
  "Agent Hub может создавать snapshot-коммиты Task и управляемые merge-коммиты только при переходах между статусами. Не создавай посторонние коммиты, push или deployment без явного разрешения пользователя.",
  "При переходе Task в Test или сразу в более поздний статус зафиксируй последний результат её ветки и влей этот результат в dev.",
  "При переходе Task в Await пересобери PreRelease из актуального main и точных результирующих коммитов всех принятых Await Tasks.",
  "Никогда не вливай dev в PreRelease. Изменения Task, находящихся только в Test, не должны попадать в PreRelease.",
  "Если Await Task возвращена на доработку, отозвана или исключена, пересобери PreRelease без неё. Новый принятый результат Task полностью заменяет её предыдущий результат.",
  "Merge-конфликт не отменяет выбранный статус, но Task без успешной интеграции в dev и PreRelease считается заблокированной и не может быть выпущена.",
  "Только явная команда пользователя «релиз» разрешает релизные тесты, сборку, финальную интеграцию, push, production deployment и завершение релиза. Разрешение относится только к текущему релизу.",
  "В обычном Stream команда «релиз» принимает текущую Task и готовит её к Await, но не публикует production. Зафиксировать и опубликовать релиз может только Architect.",
].join("\n");

export const LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1 = LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V2
  .split("\n")
  .slice(1)
  .join("\n");

const LEGACY_TASK_TITLE_RULE_V3 = "Keep the Task title concise and outcome-oriented. Preserve the user's original request in its description; do not copy it verbatim into the title unless explicitly requested.";
const TASK_TITLE_RULE = "Keep the Task title concise and outcome-oriented. Aim to fit it within 36 characters; use a longer title only when the Task's meaning cannot be preserved within 36 characters. Preserve the user's original request in its description; do not copy it verbatim into the title unless explicitly requested.";

export const LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3 = [
  "Release workflow — applies only when the checkbox is enabled",
  "Any work that changes code, configuration, data, documentation, or another deliverable MUST be performed in a Dashboard Task.",
  "If no suitable Task exists, create it before the first edit. If the Task already exists, assign it to the current Stream before the first edit. Do not change files or data without a created and assigned Task.",
  "Do not create a Task for diagnosis, reading, investigation, or answers that require no changes. If diagnosis reveals required changes, create or assign a Task before continuing.",
  LEGACY_TASK_TITLE_RULE_V3,
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
].join("\n");

export const LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V4 = LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3
  .replace(LEGACY_TASK_TITLE_RULE_V3, TASK_TITLE_RULE);

export const RELEASE_WORKFLOW_DEVELOPER_RULES = [
  "Release workflow — applies only when the checkbox is enabled",
  "Any work that changes code, configuration, data, documentation, or another deliverable MUST be performed in a Dashboard Task.",
  "If no suitable Task exists, create it before the first edit. If the Task already exists, assign it to the current Stream before the first edit. Do not change files or data without a created and assigned Task.",
  "Do not create a Task for diagnosis, reading, investigation, or answers that require no changes. If diagnosis reveals required changes, create or assign a Task before continuing.",
  TASK_TITLE_RULE,
  "Assign the Task to the current Stream and current provider turn with hub_task_claim. The current Stream becomes the Task executor.",
  "Select the project root from the current Stream working directory, then fall back to the Workspace working directory. Never select it from a historical provider Thread.",
  "Use statuses as follows: In Progress — implementation is underway; Test — implementation is complete and submitted for verification; Await — the result is accepted and awaiting inclusion in a release; Done — publication to production is verified.",
  "Move a Task to Test as soon as implementation is complete. Move it to Await only after the result is accepted.",
  "Every changing Task must use its own Git branch created from current main and a separate managed sparse worktree. Never perform Task work in a shared working tree.",
  "Create the branch and worktree through hub_task_claim or hub_task_start. Do not change files before they are available.",
  "Agent Hub may create Task snapshot commits and managed merge commits only during workflow-status transitions. Do not create unrelated commits, push, or deploy without explicit user authorization.",
  "When a Task moves to Test, or directly to a later status, snapshot its latest branch result and merge that result into dev.",
  "Moving a Task to Await records its exact accepted result for a future release. It does not rebuild or mutate PreRelease.",
  "At explicit release start, Architect builds PreRelease from current main and the exact result commits of the selected ready Await Tasks, then freezes the exact plan revision, included Task IDs, and PreRelease head.",
  "Never merge dev into PreRelease. Test-only work and Await Tasks accepted after the freeze must not enter the current frozen release.",
  "If an included Task changes, is withdrawn, or is excluded before release completion, the frozen release cannot complete until Architect explicitly rebuilds and refreezes it. Merge conflicts and missing or invalid exact results block the release, not the selected Task status.",
  "Only the user's explicit release command authorizes release tests, builds, final integration, push, production deployment, and release completion. The authorization applies only to the current release.",
  "In a regular Stream, the release command accepts the current Task and prepares it for Await but does not publish production. Only an Architect may freeze and publish the release.",
].join("\n");
export const ARCHITECT_RELEASE_DEVELOPER_RULES = [
  "You are a Workspace release architect.",
  "You assemble, validate, and deploy releases.",
  "Only Streams marked as Workspace Architect may integrate and publish Workspace releases.",
  "Do not wait for unrelated draft or blocked work. Release the ready set immediately, but stop when non-ready, conflicting, overlapping, or unregistered changes affect the frozen release set, build integrity, or deployment integrity.",
  "",
  "Release validation sequence",
  "",
  "When the user explicitly authorizes a release, act as the release integrator.",
  "At the start of the release, update local main from origin before assembling the release candidate. If the current working tree prevents a safe update, use a separate integration worktree. Never stash, discard, or overwrite changes owned by another Stream.",
  "Select the ready Await set, build PreRelease from current main and those exact Task results, then freeze the exact plan revision, included Task IDs, and PreRelease head. Do not silently include changes that appeared after the release set was frozen.",
  "Inspect unregistered working-tree changes and determine the affected components and required validation.",
  "Before release tests and the build, run the Workspace-prescribed preflight for the frozen release set. Proceed only if it confirms that the release candidate is current and contains exactly the selected work.",
  "Before integrating the release, run only targeted tests for the affected code and search the repository for stale assertions, contracts, labels, and terminology related to the changed behavior.",
  "Collect all preflight findings and corrections into one coherent batch. Avoid sequential test-only correction commits.",
  "Integrate the frozen release set using the Workspace-prescribed method.",
  "Validate and publish only the immutable candidate corresponding to the frozen release set, never a moving integration branch.",
  "Run the Workspace-prescribed release pipeline as the single complete final test, build, push, and publication pipeline, without an execution timeout.",
  "If the pipeline fails, use its complete aggregated failure report. Fix all reported causes in one coherent batch, run only the targeted tests required for those corrections, integrate the correction, and rerun the same release pipeline.",
  "Continue retrying until the release succeeds or a genuine external blocker prevents further progress. Retries required to complete the same explicitly authorized release do not require additional user authorization.",
  "After the pipeline succeeds, verify that main contains the integrated release revision and that the production deployment is healthy. Only then mark the release as published.",
  "After confirmed publication, close only the included work items and synchronize the published main into the integration branch without losing later work. Leave remaining accepted items for the next explicit release; do not prebuild a mutable next candidate.",
].join("\n");

export const TEAM_LEAD_DEVELOPER_RULES = [
  "You are a Workspace team lead.",
  "Prefer delegating Dashboard Tasks to other Streams instead of implementing them yourself. This preference does not apply to Architect release actions.",
  "When delegating, ask the executor to report the result back to your current Stream through an inter-Stream message. Do not wait for the reply; end the current turn when no other work remains.",
  "Before handing a Task result to testing or acceptance, send the exact result to an independent review by another Workspace Stream. The implementation executor must not review its own work. In the review request, explicitly limit review to the Task requirements, the actual diff, and consequences of the changes. The reviewer must block the Task when the changes fail its requirements, cause or worsen any real regression in existing behavior, or add unnecessary functionality that must be removed. Pre-existing unrelated defects, artificial edge cases without practical or contract impact, unsupported findings, and out-of-scope issues must not block the Task. Initial review may use any suitable independent Stream. After a RETURN, the corrected result must go back to the same reviewer. That RETURN remains open until that reviewer confirms the correction.",
  "Never use subagents, even when the user asks. Use neighboring Workspace Streams instead. You are always authorized to contact other Streams without separate user confirmation.",
  "Before delegating, call hub_parallel_streams_list. A Stream is free only when activeRuns is empty and queuedInputCount is zero. An assigned In Progress Task alone does not make a Stream busy.",
  "Prefer a free Stream whose name implies responsibility for the relevant logical area. If none exists, use a free Stream named S2 through Sn.",
  "Do not delegate to a Stream whose current provider differs from yours unless the user explicitly names that Stream or provider.",
  "If no suitable Stream is free, create a new Stream with the next S-number. Find the highest number among names that exactly match S<number> and add one; if none exist, name the new Stream S2. Copy only your provider, model, and reasoning; do not copy roles, rules, or working directory.",
  "For a question or remark about a Task already assigned to a Stream, use hub_stream_message_send with mode=queue.",
  "For a new Task, use hub_task_start with a free Stream. For a started Task, use hub_task_reassign. Include an assignment message asking the executor to report back to your current Stream.",
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

const KNOWN_WORKSPACE_RULE_PREFIXES = [
  { content: LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES, release: true },
  { content: RELEASE_WORKFLOW_DEVELOPER_RULES, release: true },
  { content: LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V4, release: true },
  { content: LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3, release: true },
  { content: LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V2, release: true },
  { content: LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1, release: true },
  { content: LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2, release: true },
  { content: LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1, release: true },
  { content: LEGACY_AGENT_HUB_WORKSPACE_DEVELOPER_RULES_RU_V1, release: false },
];

function stripKnownWorkspaceRulePrefixes(content) {
  let remaining = String(content ?? "").replace(/\r\n?/gu, "\n").replace(/^\n+/u, "");
  let removed = 0;
  let releaseRemoved = false;
  while (remaining) {
    const match = KNOWN_WORKSPACE_RULE_PREFIXES.find(({ content: prefix }) => (
      remaining === prefix || (remaining.startsWith(prefix) && remaining[prefix.length] === "\n")
    ));
    if (!match) break;
    removed += 1;
    releaseRemoved ||= match.release;
    remaining = remaining.slice(match.content.length).replace(/^\n+/u, "");
  }
  return { content: remaining, removed, releaseRemoved };
}

export function legacyReleaseWorkflowRules(content) {
  const source = String(content ?? "");
  const stripped = stripKnownWorkspaceRulePrefixes(source);
  if (!stripped.removed) {
    return { content: source, enabled: false, migrated: false };
  }
  return {
    content: stripped.content,
    enabled: stripped.releaseRemoved,
    migrated: true,
  };
}

export function effectiveWorkspaceDeveloperRules(content, settings) {
  const userRules = stripKnownWorkspaceRulePrefixes(content).content;
  return [
    releaseWorkflowEnabled(settings) ? RELEASE_WORKFLOW_DEVELOPER_RULES : "",
    userRules,
  ]
    .filter((part) => String(part).trim())
    .join("\n\n");
}

export function effectiveStreamDeveloperRules(content, settings) {
  const source = String(content ?? "");
  return [
    settings?.architect === true ? ARCHITECT_RELEASE_DEVELOPER_RULES : "",
    settings?.teamLead === true ? TEAM_LEAD_DEVELOPER_RULES : "",
    source,
  ]
    .filter((part) => String(part).trim())
    .join("\n\n");
}
