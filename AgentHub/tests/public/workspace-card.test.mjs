import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const asset = (name) => readFile(new URL(`../../assets/mini-app/${name}`, import.meta.url), "utf8");

test("workspace card is available from Dialogs and Dashboard context menus", async () => {
  const [html, app] = await Promise.all([asset("index.html"), asset("app.js")]);
  assert.match(html, /data-workspace-card-modal/u);
  assert.match(html, /data-workspace-card-name/u);
  assert.match(html, /data-workspace-card-comment/u);
  assert.match(html, /data-workspace-card-order/u);
  assert.match(app, /\[data-workspace-heading\], \[data-board-workspace-id\]/u);
  assert.match(app, /emit\("workspace:update"/u);
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
  assert.match(client, /control\("board-column-move"/u);
});
