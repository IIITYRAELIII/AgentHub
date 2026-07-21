import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  botReplacementInvocation,
  independentWindowsLauncherInvocation,
} from "./runtime-restart.mjs";

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
  assert.match(result.args.at(-1), /Invoke-CimMethod/);
  assert.match(result.options.env.TELEGRAM_RUNTIME_TARGET_COMMAND, /C:\\Runtime\\launch\.ps1/);
  assert.equal(result.options.cwd, path.resolve("C:\\Runtime"));
});

test("independent Windows launch is delegated to WMI instead of the exiting parent tree", () => {
  const result = independentWindowsLauncherInvocation({
    environment: { SystemRoot: "C:\\Windows" },
    launcher: "C:\\Runtime Path\\launch.ps1",
  });
  assert.match(result.options.env.TELEGRAM_RUNTIME_TARGET_COMMAND, /"C:\\Runtime Path\\launch\.ps1"/);
  assert.equal(result.options.detached, true);
});

test("Windows WMI launcher survives completion of its helper process", {
  skip: process.platform !== "win32",
}, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-wmi-launch-"));
  const launcher = path.join(directory, "launch.ps1");
  const marker = path.join(directory, "started.txt");
  await writeFile(
    launcher,
    `$ErrorActionPreference='Stop'\nSet-Content -LiteralPath '${marker.replaceAll("'", "''")}' -Value 'started' -Encoding UTF8\n`,
    "utf8",
  );
  const invocation = independentWindowsLauncherInvocation({
    environment: process.env,
    launcher,
  });
  const options = { ...invocation.options };
  delete options.detached;
  const result = spawnSync(invocation.command, invocation.args, options);
  assert.equal(result.status, 0);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      assert.match(await readFile(marker, "utf8"), /started/);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.fail("WMI-launched process did not create its marker");
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
