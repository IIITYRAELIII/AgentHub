import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeInvocation } from "./src/providers/claude/claude-invocation.mjs";

test("Claude invocation selects the newest installed VSCode package", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "telegram-claude-invocation-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  for (const version of ["2.1.9", "2.2.1", "2.1.216"]) {
    const directory = path.join(
      root,
      ".vscode",
      "extensions",
      `anthropic.claude-code-${version}-win32-x64`,
      "resources",
      "native-binary",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "claude.exe"), "fake", "utf8");
  }
  const result = resolveClaudeInvocation({
    requested: "claude",
    platform: "win32",
    env: { USERPROFILE: root, APPDATA: path.join(root, "appdata") },
  });
  assert.equal(result.version, "2.2.1");
  assert.equal(result.source, "vscode");
});

test("explicit Claude command and arguments are never replaced by discovery", () => {
  assert.deepEqual(resolveClaudeInvocation({
    requested: "custom-claude.exe",
    prefixArgs: ["--fake"],
    platform: "win32",
  }), {
    command: "custom-claude.exe",
    prefixArgs: ["--fake"],
    version: null,
    source: "configured",
  });
});
