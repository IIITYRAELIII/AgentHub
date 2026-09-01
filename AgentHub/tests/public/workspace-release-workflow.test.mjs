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
  assert.notEqual(text, RELEASE_WORKFLOW_DEVELOPER_RULES);
  assert.doesNotMatch(text, /Release workflow|Keep the Task title/iu);
  assert.match(text, /действует только при включённой галочке/iu);
  assert.match(text, /изменяет код.*Dashboard Task/iu);
  assert.match(text, /Название Task.*36 символов.*невозможно сохранить/iu);
  assert.match(text, /Корень проекта.*Stream.*Workspace/iu);
  assert.match(text, /sparse worktree/iu);
  assert.match(text, /переходе Task в Test.*влей.*dev/iu);
  assert.match(text, /Переход Task в Await.*не пересобирает.*PreRelease/iu);
  assert.match(text, /явном старте релиза Architect.*выбранных готовых Await Tasks.*замораживает/iu);
  assert.match(text, /после заморозки.*не должны попадать.*текущий замороженный релиз/iu);
  assert.match(text, /Merge-конфликты.*блокируют релиз.*не.*статус Task/iu);
  assert.match(text, /явная команда пользователя.*production deployment/iu);
  assert.match(text, /только Architect/iu);
  assert.doesNotMatch(RELEASE_WORKFLOW_DEVELOPER_RULES, /[А-Яа-яЁё]/u);
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
