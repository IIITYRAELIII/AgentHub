import assert from "node:assert/strict";
import test from "node:test";

import {
  ARCHITECT_RELEASE_DEVELOPER_RULES,
  EXPLICIT_USER_WORKFLOW_EXCEPTION,
  effectiveStreamDeveloperRules,
  effectiveWorkspaceDeveloperRules,
  LEGACY_AGENT_HUB_WORKSPACE_DEVELOPER_RULES_RU_V1,
  LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V2,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V4,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V5,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V6,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V7,
  LEGACY_ARCHITECT_RELEASE_DEVELOPER_RULES_V1,
  LEGACY_ARCHITECT_RELEASE_DEVELOPER_RULES_V2,
  LEGACY_ARCHITECT_RELEASE_DEVELOPER_RULES_V3,
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
  assert.match(rules, /Do not create a Task for diagnosis/u);
  assert.match(rules, /preserve the user's original request in its description/iu);
  assert.match(rules, /Moving a Task to Await.*does not build, rebuild or mutate PreRelease/iu);
  assert.match(rules, /Test is the sole snapshot and dev-integration gate.*Await and Done reuse/iu);
  assert.doesNotMatch(rules, /directly to a later status/iu);
  assert.match(rules, /explicit release start.*effective first-parent dev integration deltas/iu);
  assert.match(rules, /Never merge dev into PreRelease.*never publish a broad dominating Task snapshot/iu);
  assert.match(rules, /fit it within 36 characters.*only when.*cannot be preserved/iu);
  assert.doesNotMatch(rules, /[А-Яа-яЁё]/u);
});

test("previous release policies are stripped after title and freeze guidance changes", () => {
  for (const legacyRules of [
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V4,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V5,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V6,
    LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V7,
  ]) {
    const rules = effectiveWorkspaceDeveloperRules(
      `${legacyRules}\n\nCustom rule`,
      { releaseWorkflowEnabled: true },
    );
    assert.equal(rules, `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nCustom rule`);
    assert.equal((rules.match(/Release workflow — applies only/gu) ?? []).length, 1);
  }
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

test("both generated policies grant a scoped explicit user exception", () => {
  for (const output of [
    effectiveWorkspaceDeveloperRules("", { releaseWorkflowEnabled: true }),
    effectiveStreamDeveloperRules("", { architect: true }),
  ]) {
    assert.equal(output.split(EXPLICIT_USER_WORKFLOW_EXCEPTION).length - 1, 1);
    assert.match(output, /Explicit user instructions for the current work take precedence/u);
    assert.match(output, /Task creation, validation scope, and publication sequence/u);
    assert.match(output, /urgency or frustration alone does not authorize/u);
    assert.match(output, /continuation and rotation context.*until that work is complete/u);
    assert.match(output, /does not override system instructions, safety or security requirements/u);
    assert.match(output, /tool-enforced authorization and integrity checks/u);
  }
});

test("generated Architect prefixes are replaced once while authored edits survive", () => {
  for (const prefix of [
    LEGACY_ARCHITECT_RELEASE_DEVELOPER_RULES_V1,
    LEGACY_ARCHITECT_RELEASE_DEVELOPER_RULES_V2,
    LEGACY_ARCHITECT_RELEASE_DEVELOPER_RULES_V3,
    ARCHITECT_RELEASE_DEVELOPER_RULES,
  ]) {
    const stored = `${prefix}\n\n${prefix}\n\nCustom rule`.replace(/\n/gu, "\r\n");
    const output = effectiveStreamDeveloperRules(stored, { architect: true });
    assert.equal(output, `${ARCHITECT_RELEASE_DEVELOPER_RULES}\n\nCustom rule`);
    assert.equal(effectiveStreamDeveloperRules(output, { architect: true }), output);
    assert.equal(effectiveStreamDeveloperRules(stored, { architect: false }), "Custom rule");
  }
  const authored = LEGACY_ARCHITECT_RELEASE_DEVELOPER_RULES_V1.replace(
    "You assemble, validate, and deploy releases.", "Custom validation and publication rule.",
  );
  assert.equal(effectiveStreamDeveloperRules(authored, {}), authored);
  assert.equal(effectiveStreamDeveloperRules(authored, { architect: true }), `${ARCHITECT_RELEASE_DEVELOPER_RULES}\n\n${authored}`);
});

test("Workspace legacy exception cutover is idempotent and preserves authored variants", () => {
  const settings = { releaseWorkflowEnabled: true };
  const stored = `${LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V6}\n\nCustom rule`;
  const effective = effectiveWorkspaceDeveloperRules(stored, settings);
  assert.equal(effectiveWorkspaceDeveloperRules(effective, settings), effective);
  assert.equal(effectiveWorkspaceDeveloperRules(stored, {}), "Custom rule");
  const authored = LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V6.replace(
    "Any work that changes code", "Custom policy for work that changes code",
  );
  assert.equal(effectiveWorkspaceDeveloperRules(authored, {}), authored);
});

test("Architect rules use only explicit settings.architect and allow multiple Streams", () => {
  assert.equal(effectiveStreamDeveloperRules("Stream rule", { releaseRole: "architect" }), "Stream rule");
  assert.equal(effectiveStreamDeveloperRules("Stream rule", {}), "Stream rule");
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { architect: true }),
    `${ARCHITECT_RELEASE_DEVELOPER_RULES}\n\nStream rule`,
  );
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /Workspace release architect/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /frozen release set/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /fetch origin without changing local main/iu);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /authors and committers.*GitHub logins.*signatures.*changed files/iu);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /Immediately before push.*frozen approved main commit/iu);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /invalidate the old candidate.*later explicit release preparation/iu);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /Workspace-prescribed preflight/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /immutable candidate/u);
  assert.match(ARCHITECT_RELEASE_DEVELOPER_RULES, /production deployment is healthy/u);
  assert.doesNotMatch(
    ARCHITECT_RELEASE_DEVELOPER_RULES,
    /hub_release_preflight|TestContour|CHANGELOG\.md/u,
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
    /exact result.*independent review by another Workspace Stream.*must not review its own work/iu,
  );
  assert.match(
    TEAM_LEAD_DEVELOPER_RULES,
    /review request.*Task requirements.*actual diff.*consequences of the changes/iu,
  );
  assert.match(
    TEAM_LEAD_DEVELOPER_RULES,
    /fail its requirements.*cause or worsen any real regression.*unnecessary functionality that must be removed/iu,
  );
  assert.match(
    TEAM_LEAD_DEVELOPER_RULES,
    /Pre-existing unrelated defects.*artificial edge cases.*unsupported findings.*out-of-scope issues must not block/iu,
  );
  assert.match(
    TEAM_LEAD_DEVELOPER_RULES,
    /Initial review may use any suitable independent Stream.*After a RETURN.*corrected result must go back to the same reviewer.*RETURN remains open until that reviewer confirms/iu,
  );
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /highest number.*S<number>.*add one.*name the new Stream S2/iu);
  assert.match(TEAM_LEAD_DEVELOPER_RULES, /provider, model, and reasoning/u);
});

test("Architect role requires one service Task per release and keeps the rest", () => {
  const issued = effectiveStreamDeveloperRules("", { architect: true });
  assert.match(issued, /Релиз \[версия\]/u);
  assert.match(issued, /Do not create a\s+separate Task per release operation/u);
  // Служебные шаги одного выпуска не поглощают самостоятельные доработки механизмов.
  assert.match(issued, /never absorbs independent work on release mechanisms/u);
  // Прочие инструкции роли сохранены.
  assert.match(issued, /You are a Workspace release architect/u);
  assert.ok(issued.includes(EXPLICIT_USER_WORKFLOW_EXCEPTION));
});

test("previously issued Architect prefix migrates to the release-Task rule once", () => {
  const authored = "Мои личные правила.";
  const migrated = effectiveStreamDeveloperRules(
    `${LEGACY_ARCHITECT_RELEASE_DEVELOPER_RULES_V2}

${authored}`,
    { architect: true },
  );
  assert.ok(migrated.startsWith(ARCHITECT_RELEASE_DEVELOPER_RULES));
  assert.ok(migrated.endsWith(authored));
  assert.equal(migrated.split("Релиз [версия]").length - 1, 1);
  assert.equal(migrated.split(EXPLICIT_USER_WORKFLOW_EXCEPTION).length - 1, 1);
});

test("the release-Task rule belongs to the Architect role only", () => {
  assert.doesNotMatch(effectiveStreamDeveloperRules("", { teamLead: true }), /Релиз \[версия\]/u);
  assert.doesNotMatch(effectiveWorkspaceDeveloperRules("", { releaseWorkflow: true }), /Релиз \[версия\]/u);
});
