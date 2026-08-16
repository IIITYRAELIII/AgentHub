import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { stopProcessTree } from "../infrastructure/process/process-tree.mjs";
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

function processId(value) {
  const pid = Number(value);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function replacementDetails(replacement) {
  return {
    launchedPid: replacement?.launchedPid ?? null,
    ownerPid: replacement?.ownerPid ?? null,
    instanceToken: replacement?.instanceToken ?? "",
  };
}

async function terminateReplacement({ replacement, stopTree }) {
  const pids = [replacement?.ownerPid, replacement?.launchedPid]
    .map(processId)
    .filter((pid, index, values) => pid !== null && values.indexOf(pid) === index);
  for (const pid of pids) {
    const stopped = await stopTree(pid);
    if (stopped !== true) throw new Error(`Cannot terminate replacement process tree ${pid}`);
  }
}

async function releaseReplacementLock({
  replacement,
  lockFile,
  timeoutMs,
  readFileImpl,
  unlinkImpl,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  isAlive,
}) {
  const ownerPid = processId(replacement?.ownerPid ?? replacement?.launchedPid);
  if (!ownerPid) return true;
  const expectedToken = String(replacement?.instanceToken ?? "");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = parseReplacementLock(await readFileImpl(lockFile, "utf8").catch(() => ""));
    const ownsLock = lock?.pid === ownerPid
      && (!expectedToken || lock.instanceToken === expectedToken);
    if (!isAlive(ownerPid)) {
      if (ownsLock) await unlinkImpl(lockFile).catch(() => {});
      const current = parseReplacementLock(await readFileImpl(lockFile, "utf8").catch(() => ""));
      const stillOwnsLock = current?.pid === ownerPid
        && (!expectedToken || current.instanceToken === expectedToken);
      if (!stillOwnsLock) return true;
    }
    await delayImpl(100);
  }
  return false;
}

async function cleanUpReplacement({
  replacement,
  lockFile,
  timeoutMs,
  stopTree,
  readFileImpl,
  unlinkImpl,
  delayImpl,
  isAlive,
}) {
  if (!replacement) return { confirmed: true, ...replacementDetails(replacement) };
  try {
    await terminateReplacement({ replacement, stopTree });
    const released = await releaseReplacementLock({
      replacement,
      lockFile,
      timeoutMs,
      readFileImpl,
      unlinkImpl,
      delayImpl,
      isAlive,
    });
    return { confirmed: released, ...replacementDetails(replacement) };
  } catch (error) {
    return { confirmed: false, error, ...replacementDetails(replacement) };
  }
}

function replacementFailure(message, replacementCleanup) {
  const error = new Error(message);
  error.replacementCleanup = replacementCleanup;
  return error;
}

export async function waitForReplacementLock({
  lockFile,
  currentPid = process.pid,
  timeoutMs = 15_000,
  pollMs = 100,
  requireReady = true,
  expectedPid = null,
  expectedInstanceToken = "",
  readFileImpl = readFile,
  isAlive = processIsAlive,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lock = parseReplacementLock(
      await readFileImpl(lockFile, "utf8").catch(() => ""),
    );
    const expectedProcess = expectedPid == null || lock?.pid === expectedPid;
    const expectedInstance = !expectedInstanceToken
      || lock?.instanceToken === expectedInstanceToken;
    if (
      lock
      && lock.pid !== currentPid
      && expectedProcess
      && expectedInstance
      && (!requireReady || lock.ready === true)
      && isAlive(lock.pid)
    ) return lock;
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
  ownershipTimeoutMs = 15_000,
  readinessTimeoutMs = 120_000,
  spawnImpl = spawn,
  readFileImpl = readFile,
  unlinkImpl = unlink,
  stopTree = stopProcessTree,
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
    let replacement = null;
    try {
      const child = spawnImpl(current.command, current.args, current.options);
      replacement = { child, launchedPid: processId(child?.pid), ownerPid: null, instanceToken: "" };
      child.once?.("error", (error) => { lastError = error; });
      if (current.options?.detached) child.unref?.();
    } catch (error) {
      lastError = error;
    }
    const owner = await waitForReplacementLock({
      lockFile,
      currentPid,
      timeoutMs: ownershipTimeoutMs,
      requireReady: false,
      readFileImpl,
      delayImpl,
      isAlive,
    });
    if (owner) {
      replacement ??= { child: null, launchedPid: null, ownerPid: null, instanceToken: "" };
      replacement.ownerPid = owner.pid;
      replacement.instanceToken = owner.instanceToken;
      const lock = owner.ready === true ? owner : await waitForReplacementLock({
        lockFile,
        currentPid,
        timeoutMs: readinessTimeoutMs,
        expectedPid: owner.pid,
        expectedInstanceToken: owner.instanceToken,
        readFileImpl,
        delayImpl,
        isAlive,
      });
      if (!lock) {
        const replacementCleanup = await cleanUpReplacement({
          replacement,
          lockFile,
          timeoutMs: ownershipTimeoutMs,
          stopTree,
          readFileImpl,
          unlinkImpl,
          delayImpl,
          isAlive,
        });
        throw replacementFailure(
          `replacement bot ${owner.pid} acquired ${lockFile} but did not become ready`,
          replacementCleanup,
        );
      }
      return {
        lock,
        attempt: index + 1,
        usedFallback: index >= primaryAttempts,
      };
    }
    const replacementCleanup = await cleanUpReplacement({
      replacement,
      lockFile,
      timeoutMs: ownershipTimeoutMs,
      stopTree,
      readFileImpl,
      unlinkImpl,
      delayImpl,
      isAlive,
    });
    if (!replacementCleanup.confirmed) {
      throw replacementFailure(`replacement bot did not acquire ${lockFile}`, replacementCleanup);
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
