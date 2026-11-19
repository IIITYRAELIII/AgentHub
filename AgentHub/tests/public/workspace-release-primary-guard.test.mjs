import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";



async function guardedWorkflowApi() {
  const base = await readFile(new URL(
    "../../assets/web-app/workspace-task-workflow.js",
    import.meta.url,
  ), "utf8");
  const guard = await readFile(new URL(
    "../../assets/web-app/workspace-task-primary-guard.js",
    import.meta.url,
  ), "utf8");
  const window = {};
  vm.runInNewContext(`${base}\n${guard}`, { window });
  return window.AgentHubWorkspaceTaskWorkflow;
}



test("web shell loads the primary guard after the current release tooltip", async () => {
  const html = await readFile(new URL("../../assets/web-app/index.html", import.meta.url), "utf8");
  const workflowIndex = html.indexOf("/workspace-task-workflow.js");
  const guardIndex = html.indexOf("/workspace-task-primary-guard.js");
  assert.ok(workflowIndex >= 0);
  assert.ok(guardIndex > workflowIndex);
});

test("release guard preserves independent auto-review tooltip rendering", async () => {
  const workflow = await guardedWorkflowApi();
  let rendered;
  const container = {
    ownerDocument: { createElement: () => ({ textContent: "" }) },
    replaceChildren: (...children) => { rendered = children; },
  };
  assert.equal(workflow.renderAutoReviewTooltip(container), true);
  assert.deepEqual(rendered.map((node) => node.textContent), Array.from(workflow.autoReviewTooltip));
  assert.ok(rendered.some((node) => node.textContent.includes("напрямую")));
});
