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
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
  TEAM_LEAD_DEVELOPER_RULES,
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
  assert.match(rules, /fit it within 36 characters.*only when.*cannot be preserved/iu);
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

test("the previous Task policy is stripped after the title guidance changes", () => {
  const rules = effectiveWorkspaceDeveloperRules(
    `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3}\n\nCustom rule`,
    { releaseWorkflowEnabled: true },
  );
  assert.equal(rules, `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`);
  assert.match(rules, /fit it within 36 characters/iu);
  assert.equal((rules.match(/Release workflow — applies only/gu) ?? []).length, 1);
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
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /Workspace release architect/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /freeze the exact release set/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /Workspace-prescribed preflight/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /immutable candidate/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /production deployment is healthy/u);
  assert.doesNotMatch(
    ARCHITECT_RELEASE_DEVELOPER_RULES,
    /hub_release_preflight|TestContour|Await Tasks|PreRelease|CHANGELOG\.md/u,
  );
});

test("Team Lead rules are independent and compose after Architect rules", () => {
  assert.equal(effectiveStreamDeveloperRules("Stream rule", { teamLead: false }), "Stream rule");
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { teamLead: true }),
    `${TEAM_LEAD_DEVELOPER_RULES}\n\nStream rule`,
  );
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { architect: true, teamLead: true }),
    `${ARCHITECT_RELEASE_DEVELOPER_RULES}\n\n${TEAM_LEAD_DEVELOPER_RULES}\n\nStream rule`,
  );
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /Prefer delegating/u);
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /Architect release actions/u);
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /hub_parallel_streams_list/u);
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /queuedInputCount is zero/u);
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /hub_task_reassign/u);
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /Never use subagents/u);
  assert.match(
    TEAM_LEAD_DEVELOPER_RULES,
    /Review the result of every Task.*does not pass review.*return the same Task.*review the corrected result again/iu,
  );
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /highest number.*S<number>.*add one.*name the new Stream S2/iu);
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /provider, model, and reasoning/u);
});
