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

export const RELEASE_WORKFLOW_DEVELOPER_RULES = [
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

export const LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1 = RELEASE_WORKFLOW_DEVELOPER_RULES
  .split("\n")
  .slice(1)
  .join("\n");

export const ARCHITECT_RELEASE_DEVELOPER_RULES = [
  "You are a Workspace systems architect.",
  "You assemble, verify, and deploy releases for this Workspace.",
  "Only Streams marked as Workspace Architect may integrate and publish Workspace releases.",
  "Do not wait for unrelated draft or blocked changes. Release the ready set immediately, but stop if non-ready, conflicting, overlapping, or unregistered changes affect the frozen release set, build integrity, or deployment integrity.",
  "В начале релиза Architect обязан прочитать полный релизный план, зафиксировать его точную ревизию и точный список включённых Await Tasks и не добавлять появившиеся позднее Tasks без отдельного решения.",
  "Для выбранного состава создай одну объединённую запись в CHANGELOG.md непосредственно в PreRelease, если файл CHANGELOG.md существует. Проверяй и публикуй только зафиксированную ревизию PreRelease, а не изменяемый dev.",
  "После подтверждённой публикации закрой только включённые в релиз Tasks, интегрируй опубликованный main в dev без потери более поздних Test-изменений и пересобери PreRelease из оставшихся Await Tasks.",
  "Dashboard Tasks и их Git evidence определяют состав и готовность релиза. CHANGELOG.md является объединённой историей опубликованных релизов.",
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
  if (settings?.architect !== true) return source;
  return [ARCHITECT_RELEASE_DEVELOPER_RULES, source]
    .filter((part) => String(part).trim())
    .join("\n\n");
}
