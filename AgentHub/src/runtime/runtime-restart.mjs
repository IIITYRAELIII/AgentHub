import { spawn } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import path from "node:path";
import { stopProcessTree } from "../infrastructure/process/process-tree.mjs";
import { processIsAlive } from "../infrastructure/process/process-liveness.mjs";

const REPLACEMENT_EXITED = "REPLACEMENT_EXITED";

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

function ownedReplacementControl(child, operationId) {
  let pending = "", bytes = 0, identity = null, terminal = "", failure = null, closed = false;
  let finish;
  const completion = new Promise(resolve => { finish = resolve; });
  child.stdout?.on("data", chunk => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 4096) { failure = new Error("Owned replacement reply exceeded its bound"); return; }
    pending += chunk.toString("utf8");
    for (let index; (index = pending.indexOf("\n")) >= 0;) {
      const line = pending.slice(0, index).trim(); pending = pending.slice(index + 1);
      if (!identity) {
        try {
          const value = JSON.parse(line);
          if (value.kind !== "agent-hub-owned-replacement-v1" || value.operationId !== operationId
            || !Number.isSafeInteger(value.hostPid) || value.hostPid <= 0) throw new Error("identity");
          identity = value;
        } catch { failure = new Error("Owned replacement native identity was not confirmed"); }
      } else if (!terminal && ["AGENT_HUB_REPLACEMENT_COMMITTED", "AGENT_HUB_REPLACEMENT_ABORTED"].includes(line)) terminal = line;
      else failure = new Error("Owned replacement returned an unexpected reply");
    }
  });
  child.stdin?.on("error", error => { failure = error; });
  child.stdout?.on("error", error => { failure = error; });
  child.once("error", error => { failure = error; });
  child.once("close", code => { closed = true; finish(code); });
  async function settle(command, expected) {
    let timer;
    try {
      child.stdin?.end(command + "\n");
      const code = await Promise.race([completion, new Promise(resolve => {
        timer = setTimeout(() => resolve(null), 12000); timer.unref?.();
      })]);
      return code === 0 && terminal === expected && !failure;
    } catch { return false;
    } finally { clearTimeout(timer); }
  }
  return {
    admitted: () => identity !== null,
    failure: () => failure ?? (closed ? new Error("Owned replacement launcher closed before handoff") : null),
    commit: pid => settle(`AGENT_HUB_REPLACEMENT_READY ${pid}`, "AGENT_HUB_REPLACEMENT_COMMITTED"),
    abort: () => settle("AGENT_HUB_REPLACEMENT_ABORT", "AGENT_HUB_REPLACEMENT_ABORTED"),
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
    if (replacement.control) {
      const aborted = await replacement.control.abort();
      const confirmed = aborted && await releaseReplacementLock({ replacement, lockFile, timeoutMs,
        readFileImpl, unlinkImpl, delayImpl, isAlive });
      return { confirmed, ...replacementDetails(replacement) };
    }
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
  expectedReleaseId = "",
  expectedOperationId = "",
  failWhenExpectedOwnerExits = false,
  ownerFailure = () => null,
  ownerIsAdmitted = () => true,
  now = Date.now,
  readFileImpl = readFile,
  isAlive = processIsAlive,
  delayImpl = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    const failure = ownerFailure();
    if (failure) throw failure;
    const lock = parseReplacementLock(
      await readFileImpl(lockFile, "utf8").catch(() => ""),
    );
    const expectedProcess = expectedPid == null || lock?.pid === expectedPid;
    const expectedInstance = !expectedInstanceToken
      || lock?.instanceToken === expectedInstanceToken;
    if (
      lock
      && ownerIsAdmitted()
      && lock.pid !== currentPid
      && expectedProcess
      && expectedInstance
      && (!expectedReleaseId || lock.releaseId === expectedReleaseId)
      && (!expectedOperationId || lock.restartOperationId === expectedOperationId)
      && (!requireReady || lock.ready === true)
      && isAlive(lock.pid)
    ) return lock;
    // The awaited replacement is identified by the PID and token captured when it
    // took ownership. Once that exact process is gone it can never become ready.
    if (failWhenExpectedOwnerExits && expectedPid != null && !isAlive(expectedPid)) {
      throw Object.assign(
        new Error(`replacement bot ${expectedPid} exited before becoming ready`),
        { code: REPLACEMENT_EXITED },
      );
    }
    await delayImpl(pollMs);
  }
  return null;
}

export async function launchReplacementAndWait({
  invocation,
  fallbackInvocation = null,
  lockFile,
  currentPid = process.pid,
  expectedReleaseId = "",
  expectedOperationId = "",
  measure = (_stage, action) => action(),
  now = Date.now,
  attempts = 1,
  ownershipTimeoutMs = 120_000,
  readinessTimeoutMs = 120_000,
  spawnImpl = spawn,
  readFileImpl = readFile,
  unlinkImpl = unlink,
  stopTree = stopProcessTree,
  delayImpl,
  isAlive = processIsAlive,
} = {}) {
  // One owned launcher per durable operation. Timeout never authorizes another start.
  const primaryAttempts = 1;
  const invocations = [invocation];
  let lastError = null;
  for (let index = 0; index < invocations.length; index += 1) {
    const current = invocations[index];
    let replacement = null;
    let exited = null;
    try {
      const child = spawnImpl(current.command, current.args, current.options);
      replacement = { child, launchedPid: processId(child?.pid), ownerPid: null, instanceToken: "" };
      if (current.ownedHostProtocol) replacement.control = ownedReplacementControl(child,
        current.options?.env?.AGENT_HUB_RESTART_OPERATION_ID);
      child.once?.("error", (error) => { exited = error; });
      if (!replacement.control) child.once?.("exit", (code) => { exited = new Error(`Owned launcher exited before lock (code ${code})`); });
      if (current.options?.detached) child.unref?.();
    } catch (error) {
      lastError = error;
    }
    const owner = await measure("launcher-to-lock", () => waitForReplacementLock({
      lockFile,
      currentPid,
      timeoutMs: ownershipTimeoutMs,
      requireReady: false,
      expectedReleaseId, expectedOperationId, now,
      ownerFailure: () => replacement?.control?.failure() ?? exited ?? lastError,
      ownerIsAdmitted: () => replacement?.control?.admitted() ?? true,
      readFileImpl,
      delayImpl,
      isAlive,
    })).catch((error) => { lastError = error; return null; });
    if (owner) {
      replacement ??= { child: null, launchedPid: null, ownerPid: null, instanceToken: "" };
      replacement.ownerPid = owner.pid;
      replacement.instanceToken = owner.instanceToken;
      let exited = null;
      const lock = owner.ready === true ? owner : await measure("lock-to-ready", () => waitForReplacementLock({
        lockFile,
        currentPid,
        timeoutMs: readinessTimeoutMs,
        expectedPid: owner.pid,
        expectedReleaseId, expectedOperationId, now,
        expectedInstanceToken: owner.instanceToken,
        ownerFailure: () => replacement.control?.failure() ?? null,
        failWhenExpectedOwnerExits: true,
        readFileImpl,
        delayImpl,
        isAlive,
      }).catch((error) => {
        if (error?.code !== REPLACEMENT_EXITED && !replacement.control) throw error;
        exited = error;
        return null;
      }));
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
          exited?.message ?? `replacement bot ${owner.pid} acquired ${lockFile} but did not become ready`,
          replacementCleanup,
        );
      }
      if (replacement.control && !await measure("launcher-handoff", () => replacement.control.commit(owner.pid))) {
        throw replacementFailure("Owned replacement ready handoff remains unknown",
          { confirmed: false, ...replacementDetails(replacement) });
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
    const target = directWindowsLauncherInvocation({ environment, launcher });
    return { ...target, args: ["--spawn-replacement"], ownedHostProtocol: true,
      options: { ...target.options, detached: false, stdio: ["pipe", "pipe", "ignore"] } };
  }
  return {
    command: nodeExecutable,
    args: [path.resolve(botFile)],
    options: {
      cwd: path.resolve(agentHubRoot),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: { ...environment },
    },
  };
}
