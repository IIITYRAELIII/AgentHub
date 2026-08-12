import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function editorApi() {
  const source = await readFile(
    new URL("../../assets/mini-app/pre-turn-instructions-editor.js", import.meta.url),
    "utf8",
  );
  const window = {};
  const document = { querySelector: () => null };
  vm.runInNewContext(source, { CustomEvent, document, TextEncoder, window });
  return window.AgentHubPreTurnInstructionsEditor;
}

test("Global pre-turn editor enables save only for valid UTF-8 changes", async () => {
  const { editorState, utf8Bytes } = await editorApi();
  assert.equal(utf8Bytes("я"), 2);
  assert.deepEqual(
    { ...editorState({ content: "same", savedContent: "same", maximumBytes: 8 }) },
    { bytes: 4, changed: false, tooLarge: false, saveDisabled: true },
  );
  assert.deepEqual(
    { ...editorState({ content: "новое", savedContent: "", maximumBytes: 20 }) },
    { bytes: 10, changed: true, tooLarge: false, saveDisabled: false },
  );
});
