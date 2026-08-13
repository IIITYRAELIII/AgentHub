import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function rootAgentsEditorApi() {
  const source = await readFile(
    new URL("../../assets/web-app/root-agents-editor.js", import.meta.url),
    "utf8",
  );
  const window = {};
  const document = { querySelector: () => null };
  vm.runInNewContext(source, { CustomEvent, document, TextEncoder, window });
  return window.AgentHubRootAgentsEditor;
}

test("root AGENTS editor counts UTF-8 bytes and enables save only for valid changes", async () => {
  const { editorState, utf8Bytes } = await rootAgentsEditorApi();
  assert.equal(utf8Bytes("я"), 2);
  assert.deepEqual(
    { ...editorState({ content: "same", savedContent: "same", maximumBytes: 8 }) },
    { bytes: 4, changed: false, tooLarge: false, saveDisabled: true },
  );
  assert.deepEqual(
    { ...editorState({ content: "новое", savedContent: "", maximumBytes: 20 }) },
    { bytes: 10, changed: true, tooLarge: false, saveDisabled: false },
  );
  assert.equal(editorState({ content: "яя", savedContent: "", maximumBytes: 3 }).tooLarge, true);
});
