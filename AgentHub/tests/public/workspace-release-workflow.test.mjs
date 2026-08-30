import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

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
  assert.equal(workflow.tooltip.length, 10);
  const text = workflow.tooltip.join("\n");
  assert.match(text, /изменения.*созданной и назначенной Dashboard Task/iu);
  assert.match(text, /Диагностика.*без изменений не требуют Task/iu);
  assert.match(text, /Git-корень.*Stream или Workspace/iu);
  assert.match(text, /отдельную ветку от main.*sparse worktree/iu);
  assert.match(text, /Test.*в dev/iu);
  assert.match(text, /Await.*PreRelease.*Await Tasks/iu);
  assert.match(text, /Test-only.*не попадают в PreRelease/iu);
  assert.match(text, /Конфликт.*блокирует выпуск/iu);
  assert.match(text, /команда «релиз».*production deployment/iu);
  assert.match(text, /только Architect/iu);
});
