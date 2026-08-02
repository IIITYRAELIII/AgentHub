import { spawn } from "node:child_process";
import path from "node:path";

import {
  codexObservedExecutionOwner,
  TASK_EXECUTION_OWNERS,
} from "./task-catalog.mjs";

const OWNER_PROBE_CACHE_MS = 5_000;
const OWNER_PROBE_TIMEOUT_MS = 5_000;
const ownerProbeCache = new Map();
const ownerProbeInFlight = new Map();

function normalizedProcessName(value) {
  return String(value ?? "").trim().toLowerCase().replace(/\.exe$/, "");
}

function processAncestry(processId, byId) {
  const result = [];
  const seen = new Set();
  let current = Number(processId);
  while (Number.isInteger(current) && current > 0 && !seen.has(current) && result.length < 32) {
    seen.add(current);
    const process = byId.get(current);
    if (!process) break;
    result.push(process);
    current = Number(process.parentProcessId);
  }
  return result;
}

export function classifyCodexHookProcess(snapshot) {
  const rootProcessId = Number(snapshot?.rootProcessIds?.[0]);
  const byId = new Map((snapshot?.processes ?? []).map((item) => [Number(item.processId), item]));
  const ancestry = processAncestry(rootProcessId, byId);
  const names = ancestry.map((item) => normalizedProcessName(item.name));
  const commandLines = ancestry.map((item) => String(item.commandLine ?? "").toLowerCase());
  if (names.includes("code")) return TASK_EXECUTION_OWNERS.VSCODE;
  if (names.some((name) => name === "chatgpt" || name.includes("openai") || name === "codex desktop")) {
    return TASK_EXECUTION_OWNERS.DESKTOP;
  }
  if (commandLines.some((line) => line.includes("agent-hub-server.mjs"))) {
    return TASK_EXECUTION_OWNERS.HUB;
  }
  if (names.includes("codex")) return TASK_EXECUTION_OWNERS.CLI;
  return TASK_EXECUTION_OWNERS.EXTERNAL;
}

export function classifyCodexRolloutProcesses(snapshot, { agentHubPid = null } = {}) {
  const roots = [...new Set((snapshot?.rootProcessIds ?? [])
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0 && value !== Number(agentHubPid)))];
  const byId = new Map((snapshot?.processes ?? []).map((process) => [
    Number(process.processId),
    process,
  ]));
  if (!roots.length) return TASK_EXECUTION_OWNERS.EXTERNAL;

  const owners = roots.map((processId) => {
    const ancestry = processAncestry(processId, byId);
    const names = ancestry.map((process) => normalizedProcessName(process.name));
    if (names.includes("code")) return TASK_EXECUTION_OWNERS.VSCODE;
    if (names.some((name) => name === "chatgpt" || name.includes("openai") || name === "codex desktop")) {
      return TASK_EXECUTION_OWNERS.DESKTOP;
    }
    const root = ancestry[0];
    const rootName = normalizedProcessName(root?.name);
    const commandLine = String(root?.commandLine ?? "").toLowerCase();
    if (rootName === "codex" && !/(^|\s)app-server(?:\s|$)/.test(commandLine)) {
      return TASK_EXECUTION_OWNERS.CLI;
    }
    return TASK_EXECUTION_OWNERS.EXTERNAL;
  });
  const distinct = new Set(owners);
  return distinct.size === 1 && !distinct.has(TASK_EXECUTION_OWNERS.EXTERNAL)
    ? owners[0]
    : TASK_EXECUTION_OWNERS.EXTERNAL;
}

function powershellExecutable(environment = process.env) {
  const systemRoot = environment.SystemRoot || environment.WINDIR || "C:\\Windows";
  return path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function readWindowsRolloutProcesses(rolloutPath, {
  agentHubPid = null,
  spawnImpl = spawn,
  environment = process.env,
  timeoutMs = OWNER_PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(powershellExecutable(environment), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(import.meta.dirname, "codex-rollout-processes.ps1"),
      "-RolloutPath", rolloutPath,
      "-AgentHubPid", String(Number(agentHubPid) || 0),
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex runtime owner probe timed out"));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Codex runtime owner probe exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (error) {
        reject(new Error(`Invalid Codex runtime owner probe output: ${error.message}`));
      }
    });
  });
}

export function readWindowsProcessAncestry(processId, {
  spawnImpl = spawn,
  environment = process.env,
  timeoutMs = OWNER_PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(powershellExecutable(environment), [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-File", path.join(import.meta.dirname, "codex-process-ancestry.ps1"),
      "-ProcessId", String(Number(processId) || 0),
    ], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Codex hook owner probe timed out"));
    }, timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `Codex hook owner probe exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim() || "{}"));
      } catch (error) {
        reject(new Error(`Invalid Codex hook owner probe output: ${error.message}`));
      }
    });
  });
}

export async function detectCodexHookExecutionOwner({
  platform = process.platform,
  processId = process.pid,
  probe = readWindowsProcessAncestry,
} = {}) {
  if (platform !== "win32") return TASK_EXECUTION_OWNERS.EXTERNAL;
  try {
    return classifyCodexHookProcess(await probe(processId));
  } catch {
    return TASK_EXECUTION_OWNERS.EXTERNAL;
  }
}

export async function resolveCodexObservedExecutionOwner(activity = {}, {
  turnId = null,
  rolloutPath = null,
  capturedOwner = null,
  agentHubPid = null,
  platform = process.platform,
  nowMs = Date.now(),
  probe = readWindowsRolloutProcesses,
} = {}) {
  if (Object.values(TASK_EXECUTION_OWNERS).includes(capturedOwner)
    && capturedOwner !== TASK_EXECUTION_OWNERS.EXTERNAL) return capturedOwner;
  const direct = codexObservedExecutionOwner(activity, turnId);
  if (!activity.running) return direct;
  if (platform !== "win32" || !rolloutPath) return direct;

  const cacheKey = `${path.resolve(rolloutPath)}\0${String(turnId ?? "")}\0${Number(agentHubPid) || 0}`;
  const cached = ownerProbeCache.get(cacheKey);
  if (cached && nowMs - cached.checkedAtMs < OWNER_PROBE_CACHE_MS) {
    return cached.owner === TASK_EXECUTION_OWNERS.EXTERNAL ? direct : cached.owner;
  }
  if (ownerProbeInFlight.has(cacheKey)) {
    const owner = await ownerProbeInFlight.get(cacheKey);
    return owner === TASK_EXECUTION_OWNERS.EXTERNAL ? direct : owner;
  }
  const pending = (async () => {
    let owner = TASK_EXECUTION_OWNERS.EXTERNAL;
    try {
      const snapshot = await probe(rolloutPath, { agentHubPid });
      owner = classifyCodexRolloutProcesses(snapshot, { agentHubPid });
    } catch {
      owner = TASK_EXECUTION_OWNERS.EXTERNAL;
    }
    ownerProbeCache.set(cacheKey, { owner, checkedAtMs: nowMs });
    if (ownerProbeCache.size > 100) ownerProbeCache.delete(ownerProbeCache.keys().next().value);
    return owner;
  })();
  ownerProbeInFlight.set(cacheKey, pending);
  try {
    const owner = await pending;
    return owner === TASK_EXECUTION_OWNERS.EXTERNAL ? direct : owner;
  } finally {
    ownerProbeInFlight.delete(cacheKey);
  }
}
