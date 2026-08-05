import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";

function windowsLauncherCommand({ environment, launcher }) {
  const configuredLauncher = path.resolve(launcher);
  const resolvedLauncher = path.extname(configuredLauncher).toLowerCase() === ".exe"
    ? configuredLauncher
    : path.join(path.dirname(configuredLauncher), "AgentHub.RuntimeHost.exe");
  return {
    resolvedLauncher,
    command: resolvedLauncher,
    args: [],
  };
}

export function directWindowsLauncherInvocation({
  environment = process.env,
  launcher,
} = {}) {
  const target = windowsLauncherCommand({ environment, launcher });
  return {
    command: target.command,
    args: target.args,
    options: {
      cwd: path.dirname(target.resolvedLauncher),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...environment },
    },
  };
}

export function independentWindowsLauncherInvocation({
  environment = process.env,
  launcher,
} = {}) {
  const target = windowsLauncherCommand({ environment, launcher });
  return {
    command: target.command,
    args: ["--spawn-independent"],
    options: {
      cwd: path.dirname(target.resolvedLauncher),
      stdio: "ignore",
      windowsHide: true,
      env: { ...environment },
    },
  };
}

function parseReplacementLock(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? "").trim());
    return Number.isSafeInteger(parsed?.pid) && parsed.pid > 0 && parsed.instanceToken
      ? parsed
      : null;
  } catch {
    return null;
  }
}

export async function waitForReplacementLock({
  lockFile,
  currentPid = process.pid,
  timeoutMs = 15_000,
  pollMs = 100,
  readFileImpl = readFile,
  isAlive = processIsAlive,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = parseReplacementLock(
      await readFileImpl(lockFile, "utf8").catch(() => ""),
    );
    if (lock?.ready === true && lock.pid !== currentPid && isAlive(lock.pid)) return lock;
    await delayImpl(pollMs);
  }
  return null;
}

export async function launchReplacementAndWait({
  invocation,
  fallbackInvocation = null,
  lockFile,
  currentPid = process.pid,
  attempts = 2,
  readinessTimeoutMs = 15_000,
  spawnImpl = spawn,
  readFileImpl = readFile,
  delayImpl,
  isAlive = processIsAlive,
} = {}) {
  const primaryAttempts = Math.max(1, attempts);
  const invocations = [
    ...Array.from({ length: primaryAttempts }, () => invocation),
    ...(fallbackInvocation ? [fallbackInvocation] : []),
  ];
  let lastError = null;
  for (let index = 0; index < invocations.length; index += 1) {
    const current = invocations[index];
    try {
      const replacement = spawnImpl(current.command, current.args, current.options);
      replacement.once?.("error", (error) => { lastError = error; });
      if (current.options?.detached) replacement.unref?.();
    } catch (error) {
      lastError = error;
    }
    const lock = await waitForReplacementLock({
      lockFile,
      currentPid,
      timeoutMs: readinessTimeoutMs,
      readFileImpl,
      delayImpl,
      isAlive,
    });
    if (lock) {
      return {
        lock,
        attempt: index + 1,
        usedFallback: index >= primaryAttempts,
      };
    }
  }
  throw new Error(
    `replacement bot did not acquire ${lockFile}`
      + `${lastError ? `: ${lastError.message}` : ""}`,
  );
}

export function botReplacementInvocation({
  environment = process.env,
  platform = process.platform,
  nodeExecutable = process.execPath,
  botFile,
  agentHubRoot,
} = {}) {
  const launcher = String(environment.AGENT_HUB_LAUNCHER ?? "").trim();
  if (platform === "win32" && launcher) {
    return independentWindowsLauncherInvocation({ environment, launcher });
  }
  return {
    command: nodeExecutable,
    args: [path.resolve(botFile)],
    options: {
      cwd: path.resolve(agentHubRoot),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    },
  };
}
