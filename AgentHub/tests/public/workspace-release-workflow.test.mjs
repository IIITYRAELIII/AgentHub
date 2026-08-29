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
  assert.match(text, /Task создаётся только для работы с изменениями/iu);
  assert.match(text, /краткий содержательный заголовок.*запрос сохраняется в описании/iu);
  assert.match(text, /диагностики.*ответов без изменений Task не создаётся/iu);
  assert.match(text, /после диагностики нужны изменения.*до первой правки/iu);
  assert.match(text, /Текущий Stream сразу назначается исполнителем/iu);
  assert.match(text, /конце каждого хода.*work log.*изменённые файлы.*статус/iu);
  assert.match(text, /без diff.*не создаёт запись файла или evidence/iu);
  assert.match(text, /исправление.*К применению.*terminal evidence/iu);
  assert.match(text, /Архитектор Workspace.*ожидающие Tasks.*видимый результат/iu);
  assert.match(text, /проверенного релиза.*Tasks.*Готово.*закрываются/iu);
});
