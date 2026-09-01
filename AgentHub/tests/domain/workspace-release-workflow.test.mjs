import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECT_RELEASE_DEVELOPER_RULES,
  effectiveStreamDeveloperRules,
  effectiveWorkspaceDeveloperRules,
  legacyReleaseWorkflowRules,
  LEGACY_AGENT_HUB_WORKSPACE_DEVELOPER_RULES_RU_V1,
  LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
} from "../../src/domain/workspace-release-workflow.mjs";

test("legacy v1 policy is stripped once and replaced by Task workflow rules", () => {
  const rules = effectiveWorkspaceDeveloperRules(
    `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1}\n\nCustom rule`,
    { releaseWorkflowEnabled: true },
  );
  assert.equal(
    rules,
    `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`,
  );
  assert.match(rules, /hub_task_claim/u);
  assert.match(rules, /sparse worktree/u);
  assert.match(rules, /результат.*в dev/u);
  assert.match(rules, /диагностики.*без изменений Task не создаётся/u);
  assert.match(rules, /Название Task.*запрос пользователя сохраняется в описании/u);
  assert.match(rules, /PreRelease.*Await Tasks/u);
});

test("legacy v2 Task policy is stripped before the change-only policy is injected", () => {
  const rules = effectiveWorkspaceDeveloperRules(
    `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2}\n\nCustom rule`,
    { releaseWorkflowEnabled: true },
  );
  assert.equal(
    rules,
    `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`,
  );
});

test("known system and release prefixes are removed from editable Workspace rules", () => {
  const migrated = legacyReleaseWorkflowRules([
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
    LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
    LEGACY_AGENT_HUB_WORKSPACE_DEVELOPER_RULES_RU_V1,
    "Custom rule",
  ].join("\n\n"));
  assert.deepEqual(migrated, { content: "Custom rule", enabled: true, migrated: true });
});

test("release-disabled effective rules contain only editable Workspace rules", () => {
  assert.equal(
    effectiveWorkspaceDeveloperRules(
      `${LEGACY_AGENT_HUB_WORKSPACE_DEVELOPER_RULES_RU_V1}\n\nCustom rule`,
      { releaseWorkflowEnabled: false },
    ),
    "Custom rule",
  );
});

test("Architect rules use only explicit settings.architect and allow multiple Streams", () => {
  assert.equal(effectiveStreamDeveloperRules("Stream rule", { releaseRole: "architect" }), "Stream rule");
  assert.equal(effectiveStreamDeveloperRules("Stream rule", {}), "Stream rule");
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { architect: true }),
    `${ARCHITECT_RELEASE_DEVELOPER_RULES}\n\nStream rule`,
  );
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /точную ревизию.*Await Tasks/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /CHANGELOG\.md существует/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /опубликованный main в dev/u);
});
