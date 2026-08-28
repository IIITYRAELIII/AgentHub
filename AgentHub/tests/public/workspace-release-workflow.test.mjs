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
  assert.equal(workflow.tooltip.length, 8);
  const text = workflow.tooltip.join("\n");
  assert.match(text, /найти существующую Dashboard Task или создать/iu);
  assert.match(text, /Текущий Stream сразу назначается исполнителем/iu);
  assert.match(text, /конце каждого хода.*work log.*изменённые файлы.*статус/iu);
  assert.match(text, /без diff.*не создаёт запись файла или evidence/iu);
  assert.match(text, /исправление.*К применению.*terminal evidence/iu);
  assert.match(text, /анализ.*смены темы.*незавершённый остаётся открытым/iu);
  assert.match(text, /Архитектор Workspace.*ожидающие Tasks.*видимый результат/iu);
  assert.match(text, /проверенного релиза.*Tasks.*Готово.*закрываются/iu);
});
