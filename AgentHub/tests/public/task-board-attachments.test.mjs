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

test("Dashboard Task preview summarizes attachments without exposing file names", async () => {
  const view = await loadBoardView();
  const attachments = ["01.oga", "02.oga", "03.oga", "05.oga", "04.oga", "06.oga", "transcripts.json"]
    .map((name) => ({ name }));

  const label = view.taskAttachmentCountLabel(attachments);

  assert.equal(label, "7 вложений");
  assert.doesNotMatch(label, /01\.oga|transcripts\.json/u);
  assert.equal(view.taskAttachmentCountLabel([]), "");
});
