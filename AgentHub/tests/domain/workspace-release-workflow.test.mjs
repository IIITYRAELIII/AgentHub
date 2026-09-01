import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_HUB_WORKSPACE_DEVELOPER_RULES,
  ARCHITECT_RELEASE_DEVELOPER_RULES,
  effectiveStreamDeveloperRules,
  effectiveWorkspaceDeveloperRules,
  LEGACY_AGENT_HUB_WORKSPACE_DEVELOPER_RULES_RU_V1,
  LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V2,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
  storedWorkspaceDeveloperRules,
} from "../../src/domain/workspace-release-workflow.mjs";

test("legacy v1 policy is stripped once and replaced by Task workflow rules", () => {
  const rules = effectiveWorkspaceDeveloperRules(
    `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1}\n\nCustom rule`,
    { releaseWorkflowEnabled: true },
  );
  assert.equal(
    rules,
    `${AGENT_HUB_WORKSPACE_DEVELOPER_RULES}\n\n${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`,
  );
  assert.match(rules, /hub_task_claim/u);
  assert.match(rules, /sparse worktree/u);
  assert.match(rules, /merge that result into dev/u);
  assert.match(rules, /Do not create a Task for diagnosis/u);
  assert.match(rules, /preserve the user's original request in its description/u);
  assert.match(rules, /PreRelease.*Await Tasks/u);
  assert.doesNotMatch(rules, /[А-Яа-яЁё]/u);
});

test("legacy v2 Task policy is stripped before the change-only policy is injected", () => {
  const rules = effectiveWorkspaceDeveloperRules(
    `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2}\n\nCustom rule`,
    { releaseWorkflowEnabled: true },
  );
  assert.equal(
    rules,
    `${AGENT_HUB_WORKSPACE_DEVELOPER_RULES}\n\n${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`,
  );
});

test("stored Workspace rules keep one Agent Hub block and strip sequential release prefixes", () => {
  const stored = storedWorkspaceDeveloperRules([
    LEGACY_AGENT_HUB_WORKSPACE_DEVELOPER_RULES_RU_V1,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V2,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
    LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
    AGENT_HUB_WORKSPACE_DEVELOPER_RULES,
    "Custom rule",
  ].join("\n\n"));
  assert.equal(stored, `${AGENT_HUB_WORKSPACE_DEVELOPER_RULES}\n\nCustom rule`);
  assert.equal(stored.match(/Agent Hub rules/gu)?.length, 1);
  assert.doesNotMatch(stored, /Правила Agent Hub/u);
  assert.doesNotMatch(stored, /This Workspace uses a multi-stream/u);
});

test("release-disabled effective rules still expose the stored Agent Hub block", () => {
  assert.equal(
    effectiveWorkspaceDeveloperRules("Custom rule", { releaseWorkflowEnabled: false }),
    `${AGENT_HUB_WORKSPACE_DEVELOPER_RULES}\n\nCustom rule`,
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
