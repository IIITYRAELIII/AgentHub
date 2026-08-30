import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECT_RELEASE_DEVELOPER_RULES,
  effectiveStreamDeveloperRules,
  effectiveWorkspaceDeveloperRules,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
} from "../../src/domain/workspace-release-workflow.mjs";

test("legacy v1 policy is stripped once and replaced by Task workflow rules", () => {
  const rules = effectiveWorkspaceDeveloperRules(
    `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1}\n\nCustom rule`,
    { releaseWorkflowEnabled: true },
  );
  assert.equal(rules, `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`);
  assert.match(rules, /hub_task_claim/u);
  assert.match(rules, /dedicated Git worktree/u);
  assert.match(rules, /merges it into dev/u);
  assert.match(rules, /Do not create a Task for diagnosis/u);
  assert.match(rules, /concise descriptive title.*original request in the description/u);
});

test("legacy v2 Task policy is stripped before the change-only policy is injected", () => {
  const rules = effectiveWorkspaceDeveloperRules(
    `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2}\n\nCustom rule`,
    { releaseWorkflowEnabled: true },
  );
  assert.equal(rules, `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`);
});

test("Architect rules use only explicit settings.architect and allow multiple Streams", () => {
  assert.equal(effectiveStreamDeveloperRules("Stream rule", { releaseRole: "architect" }), "Stream rule");
  assert.equal(effectiveStreamDeveloperRules("Stream rule", {}), "Stream rule");
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { architect: true }),
    `${ARCHITECT_RELEASE_DEVELOPER_RULES}\n\nStream rule`,
  );
});
