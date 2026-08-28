import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECT_RELEASE_DEVELOPER_RULES,
  effectiveStreamDeveloperRules,
  effectiveWorkspaceDeveloperRules,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
} from "../../src/domain/workspace-release-workflow.mjs";

test("legacy v1 policy is stripped once and replaced by Task workflow rules", () => {
  const rules = effectiveWorkspaceDeveloperRules(
    `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1}\n\nCustom rule`,
    { releaseWorkflowEnabled: true },
  );
  assert.equal(rules, `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`);
  assert.match(rules, /hub_task_claim/u);
  assert.match(rules, /no changed-file or release evidence/u);
});

test("Architect rules use only explicit settings.architect and allow multiple Streams", () => {
  assert.equal(effectiveStreamDeveloperRules("Stream rule", { releaseRole: "architect" }), "Stream rule");
  assert.equal(effectiveStreamDeveloperRules("Stream rule", {}), "Stream rule");
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { architect: true }),
    `${ARCHITECT_RELEASE_DEVELOPER_RULES}\n\nStream rule`,
  );
});
