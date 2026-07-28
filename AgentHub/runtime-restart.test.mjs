import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  botReplacementInvocation,
  directWindowsLauncherInvocation,
  independentWindowsLauncherInvocation,
  launchReplacementAndWait,
  waitForReplacementLock,
} from "./runtime-restart.mjs";

const WINDOWS_INTEGRATION_TIMEOUT_MS = 15_000;
const WINDOWS_CLEANUP_OPTIONS = {
  recursive: true,
  force: true,
  maxRetries: 10,
  retryDelay: 100,
};

function visualBasicFileWriter(file, contents) {
  const literal = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return [
    "Option Explicit",
    "Dim fileSystem, output",
    'Set fileSystem = CreateObject("Scripting.FileSystemObject")',
    `Set output = fileSystem.CreateTextFile(${literal(file)}, True, False)`,
    `output.Write ${literal(contents)}`,
    "output.Close",
    "",
  ].join("\r\n");
}

test("runtime restart follows the external launcher to the newest release", () => {
  const result = botReplacementInvocation({
    environment: {
      SystemRoot: "C:\\Windows",
      AGENT_HUB_LAUNCHER: "C:\\Runtime\\launch.ps1",
    },
    platform: "win32",
    nodeExecutable: "node.exe",
    botFile: "C:\\Old\\agent-hub-server.mjs",
    agentHubRoot: "C:\\Old",
  });
  assert.equal(result.command, path.join("C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  assert.match(result.args.at(-1), /Invoke-CimMethod/);
  assert.match(result.options.env.TELEGRAM_RUNTIME_TARGET_COMMAND, /C:\\Runtime\\launch\.ps1/);
  assert.equal(result.options.cwd, path.resolve("C:\\Runtime"));
});

test("independent Windows launch keeps the WMI helper attached until it creates the replacement", () => {
  const result = independentWindowsLauncherInvocation({
    environment: { SystemRoot: "C:\\Windows" },
    launcher: "C:\\Runtime Path\\launch.ps1",
  });
  assert.match(result.options.env.TELEGRAM_RUNTIME_TARGET_COMMAND, /"C:\\Runtime Path\\launch\.ps1"/);
  assert.equal(result.options.detached, undefined);
});

test("visual basic runtime launcher uses the windowless Windows script host", () => {
  const result = independentWindowsLauncherInvocation({
    environment: { SystemRoot: "C:\\Windows" },
    launcher: "C:\\Runtime Path\\launch.vbs",
  });
  assert.match(result.options.env.TELEGRAM_RUNTIME_TARGET_COMMAND, /wscript\.exe/);
  assert.match(result.options.env.TELEGRAM_RUNTIME_TARGET_COMMAND, /\/\/B \/\/Nologo/);
  assert.match(result.options.env.TELEGRAM_RUNTIME_TARGET_COMMAND, /"C:\\Runtime Path\\launch\.vbs"/);
});

test("direct visual basic fallback bypasses WMI but remains hidden", () => {
  const result = directWindowsLauncherInvocation({
    environment: { SystemRoot: "C:\\Windows" },
    launcher: "C:\\Runtime Path\\launch.vbs",
  });
  assert.equal(result.command, path.join("C:\\Windows", "System32", "wscript.exe"));
  assert.deepEqual(result.args, ["//B", "//Nologo", path.resolve("C:\\Runtime Path\\launch.vbs")]);
  assert.equal(result.options.windowsHide, true);
});

test("replacement readiness requires a new process lock", async () => {
  const locks = [
    JSON.stringify({ pid: 42, instanceToken: "old", ready: true }),
    JSON.stringify({ pid: 84, instanceToken: "new", ready: true }),
  ];
  const lock = await waitForReplacementLock({
    lockFile: "bot.lock",
    currentPid: 42,
    timeoutMs: 100,
    pollMs: 1,
    readFileImpl: async () => locks.shift() ?? "",
    delayImpl: async () => {},
    isAlive: (pid) => pid === 84,
  });
  assert.equal(lock?.pid, 84);
});

test("replacement readiness ignores a lock owned by a dead process", async () => {
  const locks = [
    JSON.stringify({ pid: 84, instanceToken: "dead", ready: true }),
    JSON.stringify({ pid: 85, instanceToken: "live", ready: true }),
  ];
  const lock = await waitForReplacementLock({
    lockFile: "bot.lock",
    currentPid: 42,
    timeoutMs: 100,
    pollMs: 1,
    readFileImpl: async () => locks.shift() ?? "",
    delayImpl: async () => {},
    isAlive: (pid) => pid === 85,
  });
  assert.equal(lock?.pid, 85);
});

test("replacement retries WMI and then uses direct fallback until a bot owns the lock", async () => {
  let launches = 0;
  const result = await launchReplacementAndWait({
    invocation: { command: "wmi", args: [], options: {} },
    fallbackInvocation: { command: "direct", args: [], options: {} },
    lockFile: "bot.lock",
    currentPid: 42,
    attempts: 2,
    readinessTimeoutMs: 1,
    spawnImpl: () => {
      launches += 1;
      return { once() {}, unref() {} };
    },
    readFileImpl: async () => launches >= 3
      ? JSON.stringify({ pid: 84, instanceToken: "ready", ready: true })
      : "",
    delayImpl: async () => {},
    isAlive: (pid) => pid === 84,
  });
  assert.equal(launches, 3);
  assert.equal(result.usedFallback, true);
  assert.equal(result.lock.pid, 84);
});

test("Windows WMI launcher survives completion of its helper process", {
  skip: process.platform !== "win32",
}, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-wmi-launch-"));
  context.after(() => rm(directory, WINDOWS_CLEANUP_OPTIONS));
  const launcher = path.join(directory, "launch.vbs");
  const marker = path.join(directory, "started.txt");
  await writeFile(
    launcher,
    visualBasicFileWriter(marker, "started"),
    "utf8",
  );
  const invocation = independentWindowsLauncherInvocation({
    environment: process.env,
    launcher,
  });
  const result = spawnSync(invocation.command, invocation.args, invocation.options);
  assert.equal(result.status, 0);
  const deadline = Date.now() + WINDOWS_INTEGRATION_TIMEOUT_MS;
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

test("Windows WMI restart is not accepted until the replacement owns bot.lock", {
  skip: process.platform !== "win32",
}, async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "telegram-wmi-ready-"));
  context.after(() => rm(directory, WINDOWS_CLEANUP_OPTIONS));
  const launcher = path.join(directory, "launch.vbs");
  const lockFile = path.join(directory, "bot.lock");
  await writeFile(
    launcher,
    visualBasicFileWriter(
      lockFile,
      '{"pid":424242,"instanceToken":"ready","ready":true}',
    ),
    "utf8",
  );
  const result = await launchReplacementAndWait({
    invocation: independentWindowsLauncherInvocation({
      environment: process.env,
      launcher,
    }),
    lockFile,
    currentPid: process.pid,
    attempts: 1,
    readinessTimeoutMs: WINDOWS_INTEGRATION_TIMEOUT_MS,
    isAlive: () => true,
  });
  assert.equal(result.lock.pid, 424242);
  assert.equal(result.usedFallback, false);
});

test("legacy restart keeps the current bot entry point", () => {
  const result = botReplacementInvocation({
    environment: {},
    platform: "win32",
    nodeExecutable: "node.exe",
    botFile: "C:\\AgentHub\\agent-hub-server.mjs",
    agentHubRoot: "C:\\AgentHub",
  });
  assert.equal(result.command, "node.exe");
  assert.deepEqual(result.args, [path.resolve("C:\\AgentHub\\agent-hub-server.mjs")]);
});
