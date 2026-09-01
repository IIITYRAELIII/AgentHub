import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { RELEASE_WORKFLOW_DEVELOPER_RULES } from "../../src/domain/workspace-release-workflow.mjs";

async function workflowApi() {
  const source = await readFile(
    new URL("../../assets/web-app/workspace-release-workflow.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubWorkspaceReleaseWorkflow;
}

test("release workflow tooltip describes the mandatory Task lifecycle", async () => {
  const workflow = await workflowApi();
  assert.equal(workflow.tooltip.length, 19);
  const text = workflow.tooltip.join("\n");
  assert.equal(text, RELEASE_WORKFLOW_DEVELOPER_RULES);
  assert.match(text, /applies only when the checkbox is enabled/iu);
  assert.match(text, /changes code.*Dashboard Task/iu);
  assert.match(text, /project root.*Stream.*Workspace/iu);
  assert.match(text, /sparse worktree/iu);
  assert.match(text, /Task moves to Test.*merge.*dev/iu);
  assert.match(text, /Task moves to Await.*PreRelease.*Await Tasks/iu);
  assert.match(text, /Test.*must not enter PreRelease/iu);
  assert.match(text, /merge conflict.*blocked/iu);
  assert.match(text, /explicit release command.*production deployment/iu);
  assert.match(text, /Only an Architect/iu);
});

test("release workflow renders every rule as a visible tooltip paragraph", async () => {
  const workflow = await workflowApi();
  const children = [];
  const container = {
    ownerDocument: {
      createElement: () => ({ textContent: "" }),
    },
    replaceChildren: (...values) => children.push(...values),
  };
  assert.equal(workflow.renderTooltip(container), true);
  assert.deepEqual(children.map((item) => item.textContent), [...workflow.tooltip]);
});
