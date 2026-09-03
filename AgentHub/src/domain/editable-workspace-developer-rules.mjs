import {
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
  LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
} from "./workspace-release-workflow.mjs";

export const LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1 = [
  "Правила Agent Hub",
  "Dashboard Task создаётся только для работы, которая изменяет код, конфигурацию, данные, документацию или другой поставляемый результат.",
  "Для диагностики, чтения, исследования, объяснений и ответов без изменений Task не создаётся.",
  "Если после диагностики нужны изменения, до первой правки создай или назначь Task текущему Stream и точному ходу через hub_task_claim.",
  "Название Task должно кратко описывать ожидаемый результат; исходный запрос пользователя сохраняй в описании.",
  "После завершения реализации переводи Task в Test. В Await — только после принятия результата; Done — только после подтверждённой публикации.",
].join("\n");

const LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V2 = [
  "Релизный процесс — действует только при включённой галочке",
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
].join("\n");

const GENERATED_WORKSPACE_RULE_PREFIXES = [
  LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1,
  LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V2,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
];

export function editableWorkspaceDeveloperRules(content) {
  let remaining = String(content ?? "").replace(/\r\n?/gu, "\n").replace(/^\n+/u, "");
  while (remaining) {
    const prefix = GENERATED_WORKSPACE_RULE_PREFIXES.find((candidate) => (
      remaining === candidate || (remaining.startsWith(candidate) && remaining[candidate.length] === "\n")
    ));
    if (!prefix) break;
    remaining = remaining.slice(prefix.length).replace(/^\n+/u, "");
  }
  return remaining;
}
