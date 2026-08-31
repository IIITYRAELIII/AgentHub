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
  assert.match(text, /действует только при включённой галочке/iu);
  assert.match(text, /изменяет код.*Dashboard Task/iu);
  assert.match(text, /Корень проекта.*Stream.*Workspace/iu);
  assert.match(text, /sparse worktree/iu);
  assert.match(text, /Task в Test.*в dev/iu);
  assert.match(text, /Task в Await.*PreRelease.*Await Tasks/iu);
  assert.match(text, /Test.*не должны попадать в PreRelease/iu);
  assert.match(text, /Merge-конфликт.*заблокированной/iu);
  assert.match(text, /команда пользователя «релиз».*production deployment/iu);
  assert.match(text, /только Architect/iu);
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
