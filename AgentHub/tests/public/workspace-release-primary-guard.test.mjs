import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { RELEASE_PRIMARY_WORKSPACE_RULE } from "../../src/domain/release-primary-workspace-policy.mjs";

async function guardedWorkflowApi() {
  const base = await readFile(new URL(
    "../../assets/web-app/workspace-release-workflow.js",
    import.meta.url,
  ), "utf8");
  const guard = await readFile(new URL(
    "../../assets/web-app/workspace-release-primary-guard.js",
    import.meta.url,
  ), "utf8");
  const window = {};
  vm.runInNewContext(`${base}\n${guard}`, { window });
  return window.AgentHubWorkspaceReleaseWorkflow;
}

test("release tooltip adds the primary invariant without replacing the current workflow", async () => {
  const workflow = await guardedWorkflowApi();
  assert.equal(workflow.primaryRule, RELEASE_PRIMARY_WORKSPACE_RULE);
  assert.equal(workflow.tooltip.at(-1), RELEASE_PRIMARY_WORKSPACE_RULE);
  assert.equal(workflow.tooltip.filter((item) => item === RELEASE_PRIMARY_WORKSPACE_RULE).length, 1);
  assert.match(workflow.primaryRule, /releaseCandidates\[\]\.releaseRoot.*standalone clone/u);
  assert.match(workflow.primaryRule, /never create or reuse a legacy linked release worktree/u);
});

test("web shell loads the primary guard after the current release tooltip", async () => {
  const html = await readFile(new URL("../../assets/web-app/index.html", import.meta.url), "utf8");
  const workflowIndex = html.indexOf("/workspace-release-workflow.js");
  const guardIndex = html.indexOf("/workspace-release-primary-guard.js");
  assert.ok(workflowIndex >= 0);
  assert.ok(guardIndex > workflowIndex);
});
