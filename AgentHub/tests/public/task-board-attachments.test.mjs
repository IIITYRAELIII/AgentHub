import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function loadBoardView() {
  const source = await readFile(new URL("../../assets/web-app/task-board.js", import.meta.url), "utf8");
  const window = {};
  vm.runInNewContext(source, {
    document: { querySelector: () => null },
    window,
  });
  return window.AgentHubTaskBoardView;
}

async function asset(name) {
  return readFile(new URL(`../../assets/web-app/${name}`, import.meta.url), "utf8");
}

test("Dashboard Task preview summarizes attachments without exposing file names", async () => {
  const view = await loadBoardView();
  const attachments = ["01.oga", "02.oga", "03.oga", "05.oga", "04.oga", "06.oga", "transcripts.json"]
    .map((name) => ({ name }));

  const label = view.taskAttachmentCountLabel(attachments);

  assert.equal(label, "7 вложений");
  assert.doesNotMatch(label, /01\.oga|transcripts\.json/u);
  assert.equal(view.taskAttachmentCountLabel([]), "");
});

test("Dashboard Task attachment picker accepts every file type within the existing size limit", async () => {
  const view = await loadBoardView();
  const executable = { name: "utility.exe", type: "application/vnd.microsoft.portable-executable", size: 1024 };
  const archive = { name: "data.7z", type: "application/x-7z-compressed", size: 2048 };
  const oversized = { name: "large.bin", type: "application/octet-stream", size: 20 * 1024 * 1024 + 1 };

  const selection = view.taskAttachmentFiles([executable, archive, oversized]);

  assert.deepEqual(Array.from(selection.accepted, (file) => file.name), ["utility.exe", "data.7z"]);
  assert.equal(selection.oversized, 1);
  assert.equal(selection.truncated, 0);
});

test("Task card exposes paste and unrestricted file picking while image viewer owns a modal top layer", async () => {
  const [html, board, app] = await Promise.all([
    asset("index.html"), asset("task-board.js"), asset("app.js"),
  ]);

  assert.match(html, /data-task-card-attachment-add/u);
  assert.match(html, /<input type="file" data-task-card-attachment-input multiple hidden>/u);
  assert.doesNotMatch(html, /data-task-card-attachment-input[^>]+accept=/u);
  assert.match(html, /<dialog class="attachment-viewer"/u);
  assert.match(board, /taskCardModal\?\.addEventListener\("paste"/u);
  assert.match(board, /emit\("attachment-add"/u);
  assert.match(app, /attachmentViewer\.showModal\(\)/u);
});
