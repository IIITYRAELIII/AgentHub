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
