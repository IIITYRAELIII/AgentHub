import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEASE_PRIMARY_WORKSPACE_RULE,
  RELEASE_MANAGER_RELEASE_PRIMARY_WORKSPACE_RULE,
  withReleasePrimaryWorkspaceRule,
  withReleaseManagerReleasePrimaryWorkspaceRule,
} from "../../src/domain/release-primary-workspace-policy.mjs";
import {
  AUTO_REVIEW_DEVELOPER_RULES,
  EXPLICIT_USER_WORKFLOW_EXCEPTION,
  RELEASE_MANAGER_RELEASE_DEVELOPER_RULES,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
  TEAM_LEAD_DEVELOPER_RULES,
  effectiveStreamDeveloperRules,
  effectiveWorkspaceDeveloperRules,
} from "../../src/domain/workspace-release-workflow.mjs";

test("primary checkout protection appends its rule without rewriting old authored instructions", () => {
  const authored = [
    "After updating main, freeze the exact release set. Custom continuation.",
    "At the start of the release, update local main from origin. My instruction.",
    "  Trailing spaces  ",
  ].join("\r\n");
  for (const [append, setting, rule] of [
    [withReleasePrimaryWorkspaceRule, "releaseWorkflowEnabled", RELEASE_PRIMARY_WORKSPACE_RULE],
    [withReleaseManagerReleasePrimaryWorkspaceRule, "releaseManager", RELEASE_MANAGER_RELEASE_PRIMARY_WORKSPACE_RULE],
  ]) {
    assert.equal(append(authored, {}), authored);
    assert.equal(append(authored, { [setting]: true }), authored + "\n" + rule);
    assert.equal(append(rule, { [setting]: true }), rule + "\n" + rule);
  }
});

test("composition preserves copied policies and authored whitespace across checkbox settings", () => {
  for (const [compose, flags, policies] of [
    [effectiveWorkspaceDeveloperRules,
      ["releaseWorkflowEnabled", "autoReviewEnabled"],
      [RELEASE_WORKFLOW_DEVELOPER_RULES, AUTO_REVIEW_DEVELOPER_RULES]],
    [effectiveStreamDeveloperRules,
      ["releaseManager", "teamLead"],
      [RELEASE_MANAGER_RELEASE_DEVELOPER_RULES, TEAM_LEAD_DEVELOPER_RULES]],
  ]) {
    const copied = [...policies, ...policies, "Custom rule"].join("\n\n");
    for (const authored of ["", " \r\n\t ", copied, "\r\n" + copied.replace(/\n/gu, "\r\n")]) {
      for (const first of [false, true]) {
        for (const second of [false, true]) {
          const settings = { [flags[0]]: first, [flags[1]]: second };
          const expected = [first ? policies[0] : "", second ? policies[1] : "", authored]
            .filter((part) => part !== "").join("\n\n");
          assert.equal(compose(authored, settings), expected);
          assert.equal(compose(authored, settings), expected);
          assert.equal(compose(authored, {}), authored);
          assert.equal(compose(authored, { [flags[0]]: "true", [flags[1]]: "true" }), authored);
        }
      }
    }
    assert.equal(compose(null, {}), "");
  }
});

test("active policy freezes candidate only and retains conditional test lock and renamed role", () => {
  const role = effectiveStreamDeveloperRules("", { releaseManager: true });
  assert.doesNotMatch(role, /architect/iu);
  assert.match(role, /At the beginning.*create or reuse one service Task/u);
  assert.match(role, /every Task already included in PreRelease.*native linked checklist/u);
  assert.match(role, /Capture the exact accepted results into one immutable candidate generation/u);
  assert.match(role, /Task work and later acceptance may continue/u);
  assert.doesNotMatch(role, /Freeze the included Tasks/u);
  assert.match(role, /do not delete Task records/u);
  assert.match(role, /Remove only their managed branches and worktrees/u);
  const workspace = effectiveWorkspaceDeveloperRules("", { releaseWorkflowEnabled: true });
  assert.doesNotMatch(workspace, /architect/iu);
  assert.match(workspace, /If the project provides a shared test environment/iu);
  assert.match(workspace, /also provides a lock.*acquire it immediately before testing only after confirming.*expected version/iu);
  assert.match(workspace, /release it as soon as testing finishes, fails or is cancelled/iu);
  assert.match(workspace, /Do not hold it during coding, fixes, local tests, review, or waiting/iu);
  assert.doesNotMatch(workspace, /coordinate replacement with checks using that environment/iu);
  assert.equal(effectiveStreamDeveloperRules("", { architect: true }), "");
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
    effectiveStreamDeveloperRules("", { releaseManager: true }),
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

test("Release Manager rules use only explicit settings.releaseManager and allow multiple Streams", () => {
  assert.equal(effectiveStreamDeveloperRules("Stream rule", { releaseRole: "releaseManager" }), "Stream rule");
  assert.equal(effectiveStreamDeveloperRules("Stream rule", {}), "Stream rule");
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { releaseManager: true }),
    `${RELEASE_MANAGER_RELEASE_DEVELOPER_RULES}\n\nStream rule`,
  );
  assert.match(RELEASE_MANAGER_RELEASE_DEVELOPER_RULES, /Workspace release manager/u);
  assert.match(RELEASE_MANAGER_RELEASE_DEVELOPER_RULES, /frozen release set/u);
  assert.match(RELEASE_MANAGER_RELEASE_DEVELOPER_RULES, /fetch origin without changing local main/iu);
  assert.match(RELEASE_MANAGER_RELEASE_DEVELOPER_RULES, /authors and committers.*GitHub logins.*signatures.*changed files/iu);
  assert.match(RELEASE_MANAGER_RELEASE_DEVELOPER_RULES, /Immediately before push.*frozen approved main commit/iu);
  for (const command of ["hub_release_run", "hub_release_get", "hub_release_continue"]) {
    assert.ok(RELEASE_MANAGER_RELEASE_DEVELOPER_RULES.includes(command));
  }
  assert.match(RELEASE_MANAGER_RELEASE_DEVELOPER_RULES, /immutable candidate/u);
  assert.match(RELEASE_MANAGER_RELEASE_DEVELOPER_RULES, /production deployment is healthy/u);
  assert.doesNotMatch(
    RELEASE_MANAGER_RELEASE_DEVELOPER_RULES,
    /hub_release_preflight|TestContour/u,
  );
});

test("Team Lead rules are independent and compose after Release Manager rules", () => {
  assert.equal(effectiveStreamDeveloperRules("Stream rule", { teamLead: false }), "Stream rule");
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { teamLead: true }),
    `${TEAM_LEAD_DEVELOPER_RULES}\n\nStream rule`,
  );
  assert.equal(
    effectiveStreamDeveloperRules("Stream rule", { releaseManager: true, teamLead: true }),
    `${RELEASE_MANAGER_RELEASE_DEVELOPER_RULES}\n\n${TEAM_LEAD_DEVELOPER_RULES}\n\nStream rule`,
  );
});

test("Release Manager role requires one service Task per release and keeps the rest", () => {
  const issued = effectiveStreamDeveloperRules("", { releaseManager: true });
  assert.match(issued, /Релиз \[версия\]/u);
  assert.match(issued, /Do not create a\s+separate Task per release operation/u);
  // Служебные шаги одного выпуска не поглощают самостоятельные доработки механизмов.
  assert.match(issued, /never absorbs independent work on release mechanisms/u);
  // Прочие инструкции роли сохранены.
  assert.match(issued, /You are a Workspace release manager/u);
  assert.ok(issued.includes(EXPLICIT_USER_WORKFLOW_EXCEPTION));
});

test("the release-Task rule belongs to the Release Manager role only", () => {
  assert.doesNotMatch(effectiveStreamDeveloperRules("", { teamLead: true }), /Релиз \[версия\]/u);
  assert.doesNotMatch(effectiveWorkspaceDeveloperRules("", { releaseWorkflow: true }), /Релиз \[версия\]/u);
});

test("issued rules require selected composition and retained absorption sources", () => {
  const workspace = effectiveWorkspaceDeveloperRules("Authored suffix", { releaseWorkflowEnabled: true });
  const manager = effectiveStreamDeveloperRules("Authored suffix", { releaseManager: true });
  assert.match(workspace, /Never merge rolling dev into a Task branch/u);
  assert.match(workspace, /A new result must pass Test and acceptance again/u);
  assert.match(workspace, /successful canonical composition of the surviving result with the selected release Tasks/u);
  assert.match(workspace, /Preserve original cards, history, branches and worktrees until verified publication/u);
  assert.match(manager, /immediately after each selected-result, absorption or release-membership change/u);
  assert.match(manager, /A changed main or approved base requires renewed base verification/u);
  assert.ok(workspace.endsWith("Authored suffix"));
  assert.ok(manager.endsWith("Authored suffix"));
});
