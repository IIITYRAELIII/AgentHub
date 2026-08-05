import { access, mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "../../../main-module.mjs";
import { defaultRuntimeRoot, runtimeLayout } from "../../../runtime-layout.mjs";
import { writeTextAtomic } from "../../../state-store.mjs";
import { readRuntimeState } from "../persistence/runtime-state-store.mjs";

const HOOK_FILE_NAME = "codex-stop-hook-launcher.mjs";

function defaultCodexHome(environment = process.env) {
  return path.resolve(environment.CODEX_HOME || path.join(homedir(), ".codex"));
}

function quoteCommandArgument(value) {
  return `"${String(value).replaceAll("\"", "\\\"")}"`;
}

function handlerFor({ nodeExecutable, launcherFile }) {
  const command = `${quoteCommandArgument(nodeExecutable)} ${quoteCommandArgument(launcherFile)}`;
  return {
    type: "command",
    command,
    commandWindows: command,
    timeout: 30,
  };
}

function isOurHandler(value) {
  return value?.type === "command"
    && [value.command, value.commandWindows].some((command) => (
      typeof command === "string" && command.includes(HOOK_FILE_NAME)
    ));
}

function mergeEventHandler(result, eventName, options) {
  const groups = Array.isArray(result.hooks[eventName]) ? result.hooks[eventName] : [];
  const retained = [];
  for (const group of groups) {
    const hooks = Array.isArray(group?.hooks) ? group.hooks.filter((hook) => !isOurHandler(hook)) : [];
    if (hooks.length) retained.push({ ...group, hooks });
  }
  retained.push({ hooks: [handlerFor(options)] });
  result.hooks[eventName] = retained;
}

export function mergeCodexStopHookConfig(existing = {}, options) {
  const result = structuredClone(existing && typeof existing === "object" ? existing : {});
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) {
    result.hooks = {};
  }
  mergeEventHandler(result, "UserPromptSubmit", options);
  mergeEventHandler(result, "Stop", options);
  return result;
}

export function removeCodexStopHookConfig(existing = {}) {
  const result = structuredClone(existing && typeof existing === "object" ? existing : {});
  if (!result.hooks || typeof result.hooks !== "object" || Array.isArray(result.hooks)) return result;
  for (const eventName of ["UserPromptSubmit", "Stop"]) {
    const groups = Array.isArray(result.hooks[eventName]) ? result.hooks[eventName] : [];
    result.hooks[eventName] = groups.flatMap((group) => {
      const hooks = Array.isArray(group?.hooks) ? group.hooks.filter((hook) => !isOurHandler(hook)) : [];
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (!result.hooks[eventName].length) delete result.hooks[eventName];
  }
  if (!Object.keys(result.hooks).length) delete result.hooks;
  return result;
}

async function readConfig(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

export async function installCodexStopHook({
  hooksFile = path.join(defaultCodexHome(), "hooks.json"),
  runtimeRoot = defaultRuntimeRoot(),
  nodeExecutable = process.execPath,
} = {}) {
  const launcherFile = runtimeLayout(runtimeRoot).codexHookLauncherFile;
  await access(launcherFile);
  const current = await readConfig(hooksFile);
  const updated = mergeCodexStopHookConfig(current, { nodeExecutable, launcherFile });
  await mkdir(path.dirname(hooksFile), { recursive: true });
  await writeTextAtomic(hooksFile, `${JSON.stringify(updated, null, 2)}\n`);
  return { hooksFile, launcherFile };
}

export async function uninstallCodexStopHook({
  hooksFile = path.join(defaultCodexHome(), "hooks.json"),
} = {}) {
  const current = await readConfig(hooksFile);
  const updated = removeCodexStopHookConfig(current);
  await mkdir(path.dirname(hooksFile), { recursive: true });
  await writeTextAtomic(hooksFile, `${JSON.stringify(updated, null, 2)}\n`);
  return { hooksFile };
}

export async function codexStopHookStatus({
  hooksFile = path.join(defaultCodexHome(), "hooks.json"),
  runtimeRoot = defaultRuntimeRoot(),
} = {}) {
  const current = await readConfig(hooksFile);
  const launcherFile = runtimeLayout(runtimeRoot).codexHookLauncherFile;
  const launcherAvailable = await access(launcherFile).then(() => true, () => false);
  const events = Object.fromEntries(["UserPromptSubmit", "Stop"].map((eventName) => [
    eventName,
    (current.hooks?.[eventName] ?? []).some((group) => (
      Array.isArray(group?.hooks) && group.hooks.some(isOurHandler)
    )),
  ]));
  const dataDir = runtimeLayout(runtimeRoot).dataDir;
  const stateFile = path.join(dataDir, "state.json");
  let receipts = { start: null, stop: null };
  let activeTurnStarts = 0;
  try {
    const state = { value: await readRuntimeState(dataDir, { legacyFile: stateFile }) };
    receipts = {
      start: state.value?.codexHookReceipts?.start ?? null,
      stop: state.value?.codexHookReceipts?.stop ?? null,
    };
    activeTurnStarts = Array.isArray(state.value?.codexTurnStarts)
      ? state.value.codexTurnStarts.length
      : 0;
  } catch (error) {
    receipts = { start: null, stop: null, error: String(error?.message ?? error) };
  }
  return {
    hooksFile,
    launcherFile,
    launcherAvailable,
    configured: launcherAvailable && Object.values(events).every(Boolean),
    events,
    receipts,
    activeTurnStarts,
  };
}

export async function main(args = process.argv.slice(2)) {
  const command = args[0] ?? "status";
  if (args.length > 1) throw new Error(`Unknown argument: ${args[1]}`);
  if (command === "install") {
    console.log(JSON.stringify(await installCodexStopHook(), null, 2));
  } else if (command === "uninstall") {
    console.log(JSON.stringify(await uninstallCodexStopHook(), null, 2));
  } else if (command === "status") {
    console.log(JSON.stringify(await codexStopHookStatus(), null, 2));
  } else {
    throw new Error(`Unknown command: ${command}`);
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((error) => {
    console.error(`Codex hook configuration failed: ${error.message}`);
    process.exitCode = 1;
  });
}
