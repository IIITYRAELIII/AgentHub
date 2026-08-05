import { spawn, spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "./src/infrastructure/process/main-module.mjs";
import { activateRuntime } from "./runtime-manager.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "./runtime-layout.mjs";
import { independentWindowsLauncherInvocation } from "./src/runtime/runtime-restart.mjs";

export function runtimeStateIsIdle(value) {
  return Array.isArray(value?.activeRuns) && value.activeRuns.length === 0;
}

function parseLockPid(value) {
  try {
    const lock = JSON.parse(String(value ?? "").trim());
    return Number.isSafeInteger(lock) ? lock : Number.isSafeInteger(lock?.pid) ? lock.pid : null;
  } catch {
    const pid = Number.parseInt(String(value ?? "").trim(), 10);
    return Number.isSafeInteger(pid) ? pid : null;
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForIdle(stateFile, { timeoutMs = 60 * 60 * 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let consecutive = 0;
  while (Date.now() < deadline) {
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    consecutive = runtimeStateIsIdle(state) ? consecutive + 1 : 0;
    if (consecutive >= 2) return;
    await delay(2_000);
  }
  throw new Error("Timed out waiting for Agent Hub to become idle");
}

async function waitForExit(pid, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      await delay(250);
    } catch {
      return;
    }
  }
  throw new Error(`Old Agent Hub process ${pid} did not exit`);
}

function stopOldProcessTree(pid) {
  if (process.platform === "win32") {
    const result = spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    if (result.status !== 0) throw new Error(`Cannot stop old Agent Hub process ${pid}`);
    return;
  }
  process.kill(pid, "SIGTERM");
}

function launchRuntime(launcherFile) {
  if (process.platform === "win32") {
    const invocation = independentWindowsLauncherInvocation({
      environment: process.env,
      launcher: launcherFile,
    });
    const options = { ...invocation.options };
    delete options.detached;
    const result = spawnSync(invocation.command, invocation.args, options);
    if (result.status !== 0) throw new Error("Cannot launch Agent Hub through WMI");
    return;
  }
  const child = spawn(launcherFile, [], {
    cwd: path.dirname(launcherFile),
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

function installRuntimeAutostart(runtimeRoot) {
  if (process.platform !== "win32") return;
  const launcher = runtimeLayout(runtimeRoot).launcherFile;
  const result = spawnSync(launcher, ["--install-autostart"], {
    cwd: runtimeRoot,
    windowsHide: true,
    stdio: "ignore",
  });
  if (result.status !== 0) throw new Error("Cannot update the Agent Hub autostart shortcut");
}

export async function cutoverRuntime({
  sourceRoot = path.resolve(import.meta.dirname),
  runtimeRoot = defaultRuntimeRoot(),
} = {}) {
  const sourceData = path.join(sourceRoot, "data");
  const stateFile = path.join(sourceData, "state.json");
  const lockFile = path.join(sourceData, "bot.lock");
  const logFile = path.join(runtimeRoot, "cutover.log");
  const log = async (message) => appendFile(logFile, `${new Date().toISOString()} ${message}\n`, "utf8");
  await log("Waiting for the legacy bot to become idle");
  await waitForIdle(stateFile);
  const pid = parseLockPid(await readFile(lockFile, "utf8"));
  if (!pid) throw new Error("Cannot determine the legacy bot PID");
  await log(`Stopping legacy bot PID ${pid}`);
  stopOldProcessTree(pid);
  await waitForExit(pid);
  await log("Copying final state and activating external runtime");
  const result = await activateRuntime({
    sourceRoot,
    runtimeRoot,
    retireLegacyConfig: true,
    replaceData: true,
  });
  installRuntimeAutostart(runtimeRoot);
  launchRuntime(result.layout.launcherFile);
  await log(`External runtime launched: ${result.releaseId}`);
}

export async function main(args = process.argv.slice(2)) {
  let runtimeRoot = defaultRuntimeRoot();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--runtime-root" && args[index + 1]) runtimeRoot = path.resolve(args[++index]);
    else throw new Error(`Unknown argument: ${args[index]}`);
  }
  await cutoverRuntime({ runtimeRoot });
}

if (isMainModule(import.meta.url)) {
  main().catch(async (error) => {
    const logFile = path.join(runtimeLayout().root, "cutover.log");
    await appendFile(logFile, `${new Date().toISOString()} ERROR ${error.stack ?? error.message}\n`, "utf8").catch(() => {});
    process.exitCode = 1;
  });
}
