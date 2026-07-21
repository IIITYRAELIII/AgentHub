import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { botReplacementInvocation } from "./runtime-restart.mjs";

test("runtime restart follows the external launcher to the newest release", () => {
  const result = botReplacementInvocation({
    environment: {
      SystemRoot: "C:\\Windows",
      TELEGRAM_INTEGRATION_LAUNCHER: "C:\\Runtime\\launch.ps1",
    },
    platform: "win32",
    nodeExecutable: "node.exe",
    botFile: "C:\\Old\\bot.mjs",
    integrationRoot: "C:\\Old",
  });
  assert.equal(result.command, path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.equal(result.args.at(-1), path.resolve("C:\\Runtime\\launch.ps1"));
  assert.equal(result.options.cwd, path.resolve("C:\\Runtime"));
});

test("legacy restart keeps the current bot entry point", () => {
  const result = botReplacementInvocation({
    environment: {},
    platform: "win32",
    nodeExecutable: "node.exe",
    botFile: "C:\\Integration\\bot.mjs",
    integrationRoot: "C:\\Integration",
  });
  assert.equal(result.command, "node.exe");
  assert.deepEqual(result.args, [path.resolve("C:\\Integration\\bot.mjs")]);
});
