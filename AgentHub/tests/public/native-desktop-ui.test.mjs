import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../../DesktopApp/AgentHubWindow.cs", import.meta.url);

test("native Desktop renders a copy action below every textual user bubble", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /shell\.Children\.Add\(border\);[\s\S]*actions\.Children\.Add\(UserMessageCopyButton\(text\)\)/u);
  assert.match(source, /Clipboard\.SetText\(text\);[\s\S]*ShowToast\("Сообщение скопировано"\)/u);
  assert.match(source, /button\.BorderBrush = outlined \? Theme\.Solid\(Theme\.Codex\) : Brushes\.Transparent/u);
});

test("native Desktop stream tabs fit longer titles and use vertical separators", async () => {
  const source = await readFile(sourceUrl, "utf8");
  assert.match(source, /HorizontalScrollBarVisibility = ScrollBarVisibility\.Auto/u);
  assert.match(source, /TextWrapping = TextWrapping\.NoWrap/u);
  assert.match(source, /MaxWidth = 360/u);
  assert.match(source, /Width = 1,[\s\S]*Background = Theme\.Solid\(Theme\.Border\)/u);
});
