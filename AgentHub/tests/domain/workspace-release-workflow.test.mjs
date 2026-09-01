import assert from "node:assert/strict";
import test from "node:test";

import {
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
  assert.match(rules, /merge that result into dev/u);
  assert.match(rules, /Do not create a Task for diagnosis/u);
  assert.match(rules, /preserve the user's original request in its description/iu);
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
    `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`,
  );
});

test("explicit user rules matching the former hidden English block are preserved", () => {
  const explicitRules = [
    "Agent Hub rules",
    "Create a Dashboard Task only for work that changes code, configuration, data, documentation, or another deliverable.",
  ].join("\n");
  assert.equal(effectiveWorkspaceDeveloperRules(explicitRules, {}), explicitRules);
  assert.equal(
    effectiveWorkspaceDeveloperRules(explicitRules, { releaseWorkflowEnabled: true }),
    `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\n${explicitRules}`,
  );
});

test("release-disabled Workspace injects no hidden rules", () => {
  assert.equal(
    effectiveWorkspaceDeveloperRules("Custom rule", { releaseWorkflowEnabled: false }),
    "Custom rule",
  );
  assert.equal(effectiveWorkspaceDeveloperRules("", { releaseWorkflowEnabled: false }), "");
});

test("Architect rules use only explicit settings.architect and allow multiple Streams", () => {
  assert.equal(effectiveStreamDeveloperRules("Stream rule", { releaseRole: "architect" }), "Stream rule");
  assert.equal(effectiveStreamDeveloperRules("Stream rule", {}), "Stream rule");
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { architect: true }),
    `${ARCHITECT_RELEASE_DEVELOPER_RULES}\n\nStream rule`,
  );
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /точную ревизию.*Await Tasks/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /hub_release_preflight/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /TestContour\.source\.headCommit равным dev HEAD/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /Task result commit является предком dev/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /CHANGELOG\.md существует/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /опубликованный main в dev/u);
});
