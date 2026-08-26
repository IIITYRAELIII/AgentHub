import assert from "node:assert/strict";
import test from "node:test";

import {
  effectiveWorkspaceDeveloperRules,
  legacyReleaseWorkflowRules,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
  releaseWorkflowEnabled,
  workspaceSettingsWithReleaseWorkflow,
} from "../../src/domain/workspace-release-workflow.mjs";

test("release workflow is opt-in and contributes its policy only when enabled", () => {
  assert.equal(releaseWorkflowEnabled({}), false);
  const settings = workspaceSettingsWithReleaseWorkflow({ workingDirectory: "D:/work" }, true);
  assert.equal(releaseWorkflowEnabled(settings), true);
  assert.equal(
    effectiveWorkspaceDeveloperRules("Workspace-specific rule", settings),
    `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nWorkspace-specific rule`,
  );
  assert.equal(effectiveWorkspaceDeveloperRules("Workspace-specific rule", {}), "Workspace-specific rule");
});

test("legacy exact policy prefix migrates without consuming following Workspace rules", () => {
  const migrated = legacyReleaseWorkflowRules(
    `${RELEASE_WORKFLOW_DEVELOPER_RULES}\n\nFast Test Contour workflow`,
  );
  assert.deepEqual(migrated, {
    content: "Fast Test Contour workflow",
    enabled: true,
    migrated: true,
  });
  assert.equal(legacyReleaseWorkflowRules("A similar policy").migrated, false);
});
