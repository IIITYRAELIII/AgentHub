import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { findVscodeCodexExecutable, resolveCodexExecutable } from "./codex-invocation.mjs";

function directory(name) {
  return { name, isDirectory: () => true };
}

test("Codex executable resolution prefers the newest VS Code extension binary", async () => {
  const home = path.resolve("C:/Users/test");
  const executable = await findVscodeCodexExecutable({
    environment: { USERPROFILE: home },
    platform: "win32",
    readdirImpl: async (root) => root.includes(".vscode-insiders")
      ? [directory("openai.chatgpt-new")]
      : [directory("openai.chatgpt-old")],
    existsImpl: () => true,
    statImpl: async (file) => ({ mtimeMs: file.includes("new") ? 20 : 10 }),
  });
  assert.match(executable, /openai\.chatgpt-new.*codex\.exe$/i);
});

test("explicit Codex executable remains authoritative", async () => {
  assert.equal(await resolveCodexExecutable({
    requested: "D:/Tools/codex.exe",
    platform: "win32",
    environment: { USERPROFILE: "C:/Users/test" },
  }), "D:/Tools/codex.exe");
});
