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

test("provider release instructions retain their English language contract", () => {
  assert.ok(RELEASE_WORKFLOW_DEVELOPER_RULES.trim());
  assert.doesNotMatch(RELEASE_WORKFLOW_DEVELOPER_RULES, /[А-Яа-яЁё]/u);
});

test("release workflow renders every rule as a visible tooltip paragraph", async () => {
  const workflow = await workflowApi();
  let children = [{ textContent: "Stale tooltip" }];
  const container = {
    ownerDocument: {
      createElement: (tagName) => ({ tagName, textContent: "" }),
    },
    replaceChildren: (...values) => { children = values; },
  };
  assert.ok(workflow.tooltip.length > 0);
  assert.equal(workflow.renderTooltip(container), true);
  assert.deepEqual(children.map((item) => item.textContent), [...workflow.tooltip]);
  assert.ok(children.every((item) => item.tagName === "p"));
  assert.equal(workflow.renderTooltip(container), true);
  assert.deepEqual(children.map((item) => item.textContent), [...workflow.tooltip]);
});
