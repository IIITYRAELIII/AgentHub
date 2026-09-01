import assert from "node:assert/strict";
import test from "node:test";

import {
  editableWorkspaceDeveloperRules,
  LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1,
} from "../../src/domain/editable-workspace-developer-rules.mjs";
import {
  LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
} from "../../src/domain/workspace-release-workflow.mjs";

test("editable Workspace rules remove generated Russian and release prefixes", () => {
  assert.equal(
    editableWorkspaceDeveloperRules([
      LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1,
      LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V3,
      RELEASE_WORKFLOW_DEVELOPER_RULES,
      LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
      "Custom rule",
    ].join("\n\n")),
    "Custom rule",
  );
});

test("editable Workspace rules preserve manually entered English rules", () => {
  assert.equal(
    editableWorkspaceDeveloperRules([
      LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1,
      "Agent Hub rules",
      "Custom English rules",
    ].join("\n\n")),
    "Agent Hub rules\n\nCustom English rules",
  );
});
