import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const asset = (name) => readFile(new URL(`../../assets/web-app/${name}`, import.meta.url), "utf8");

test("workspace card is available from Dialogs and Dashboard context menus", async () => {
  const [html, app] = await Promise.all([asset("index.html"), asset("app.js")]);
  assert.match(html, /data-workspace-card-modal/u);
  assert.match(html, /data-workspace-card-name/u);
  assert.match(html, /data-workspace-card-comment/u);
  assert.match(html, /data-workspace-card-working-directory/u);
  assert.match(html, /data-workspace-card-order/u);
  assert.match(app, /\[data-workspace-heading\], \[data-board-workspace-id\]/u);
  assert.match(app, /emit\("workspace:update"/u);
});

test("Dialog settings replace the legacy Project picker with a Stream working directory", async () => {
  const [html, app] = await Promise.all([asset("index.html"), asset("app.js")]);
  assert.match(html, /data-dialog-working-directory/u);
  assert.doesNotMatch(html, /data-dialog-options="project"/u);
  assert.doesNotMatch(app, /command: "\/projects"/u);
  assert.doesNotMatch(app, /renderTaskProjectGroup/u);
  assert.match(app, /addEventListener\("directorycommit"/u);
  assert.match(app, /workingDirectory: directory\.value\.trim\(\)/u);
});

test("Workspace and Stream use the shared breadcrumb directory field", async () => {
  const [html, app, component] = await Promise.all([
    asset("index.html"), asset("app.js"), asset("directory-field.js"),
  ]);
  assert.equal((html.match(/data-directory-field/gu) ?? []).length, 2);
  assert.match(html, /src="\/directory-field\.js"/u);
  assert.equal((html.match(/class="[^"]*directory-field-setting/gu) ?? []).length, 2);
  assert.match(app, /AgentHubDirectoryField\?\.create/u);
  assert.match(app, /emit\("directory:browse"/u);
  assert.match(component, /directory-field-breadcrumbs/u);
  assert.match(component, /event\.key === "Enter"/u);
  assert.match(component, /event\.key === "Escape"/u);
});

test("Dashboard renders only non-empty comments without inline editing", async () => {
  const board = await asset("task-board.js");
  assert.doesNotMatch(board, /task-board-comment-edit|editingCommentColumnId|Без комментария|Нет комментария/u);
  assert.match(board, /if \(String\(subtitle \?\? ""\)\.trim\(\)\)/u);
});

test("Dashboard renders and opens Task attachments", async () => {
  const [html, board, app] = await Promise.all([
    asset("index.html"), asset("task-board.js"), asset("app.js"),
  ]);
  assert.match(html, /data-task-card-attachments/u);
  assert.match(board, /board-task-attachment/u);
  assert.match(board, /agenthub:attachment-open/u);
  assert.match(app, /emit\("attachment:open"/u);
});

test("workspace card saves through existing workspace and board commands", async () => {
  const client = await asset("hub-client.js");
  assert.match(client, /agentHub\.on\("workspace:update"/u);
  assert.match(client, /control\("rename-workspace"/u);
  assert.match(client, /control\("board-column-comment"/u);
  assert.match(client, /control\("update-workspace-settings"/u);
  assert.match(client, /control\("board-column-move"/u);
});

test("workspace card no longer exposes the legacy release registry", async () => {
  const html = await asset("index.html");
  assert.doesNotMatch(html, /data-workspace-release-registry|Изменения к релизу/u);
});
