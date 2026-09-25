import { mkdir, open, readFile, readlink, readdir, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { processIsAlive } from "../../infrastructure/process/process-liveness.mjs";
import { stopProcessTree } from "../../infrastructure/process/process-tree.mjs";

export { processIsAlive, stopProcessTree };

const WINDOWS_CLAUDE_WORKER = path.join(import.meta.dirname, "claude-windows-worker.mjs");

// Claude Code запускается отдельным CLI-процессом и раньше отдавал stream-json
// в pipe: при перезапуске бота поток обрывался вместе с родителем и ход
// приходилось помечать прерванным. Теперь вывод пишется в файл хода, а бот
// читает его хвостом — это позволяет переподключиться к живому процессу после
// перезапуска так же, как Codex переподключается к своему App Server.

export function claudeRunDirectory(dataDir) {
  return path.join(String(dataDir ?? ""), "claude-runs");
}

export function claudeRunOutputPath(dataDir, turnId) {
  return path.join(claudeRunDirectory(dataDir), `${turnId}.jsonl`);
}

export function claudeRunErrorPath(dataDir, turnId) {
  return path.join(claudeRunDirectory(dataDir), `${turnId}.err.log`);
}

export function claudeRunOwnerPath(dataDir, turnId) {
  return path.join(claudeRunDirectory(dataDir), `${turnId}.owner.json`);
}

export async function openClaudeRunOutput(dataDir, turnId) {
  const outputPath = claudeRunOutputPath(dataDir, turnId);
  const errorPath = claudeRunErrorPath(dataDir, turnId);
  const ownerPath = claudeRunOwnerPath(dataDir, turnId);
  await mkdir(claudeRunDirectory(dataDir), { recursive: true });
  const [outputHandle, errorHandle] = await Promise.all([
    open(outputPath, "w"),
    open(errorPath, "w"),
  ]);
  return { outputPath, errorPath, ownerPath, outputHandle, errorHandle };
}

const WINDOWS_PROVIDER_OWNER_WRAPPER = String.raw`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const spec = JSON.parse(process.argv[1]);
const startedAtMs = Date.now();
let child;
const persist = (extra = {}) => {
  writeFileSync(spec.ownerPath, JSON.stringify({
    token: spec.ownerToken,
    pid: child?.pid ?? null,
    startedAtMs,
    ...extra,
  }), "utf8");
};
try {
  child = spawn(spec.command, spec.args, {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  persist();
} catch (error) {
  persist({ exitedAtMs: Date.now(), spawnError: String(error?.message ?? error) });
  process.exit(127);
}
child.once("error", (error) => {
  persist({ exitedAtMs: Date.now(), spawnError: String(error?.message ?? error) });
  process.exit(127);
});
child.once("exit", (code) => {
  persist({ exitedAtMs: Date.now(), exitCode: Number.isInteger(code) ? code : 1 });
  process.exit(Number.isInteger(code) ? code : 1);
});
`;

export function providerOwnershipLaunch({ command, args = [], ownerPath, ownerToken }) {
  if (process.platform !== "win32" || !ownerPath || !ownerToken) return { command, args };
  return {
    command: process.execPath,
    args: ["-e", WINDOWS_PROVIDER_OWNER_WRAPPER, JSON.stringify({ command, args, ownerPath, ownerToken })],
  };
}

// Обработчики подписываются в том же тике, что и spawn. Ошибка запуска (нет CLI,
// нет прав) приходит следующим тиком, поэтому любой await между запуском и
// подпиской превращает её в uncaughtException и роняет весь бот.
export function spawnClaudeWorker({
  command,
  args = [],
  cwd,
  env,
  stdin = "ignore",
  stdout = "ignore",
  stderr = "ignore",
  onError = () => {},
  onExit = () => {},
}) {
  // A detached console process receives its own Windows console. `windowsHide`
  // hides that initial window, but a console descendant started by the provider
  // can show it again. Keep the durable detached root as a Node shim and launch
  // the actual provider below it without detaching, so the provider and its
  // descendants stay attached to the shim's hidden console while the shim still
  // survives an Agent Hub restart.
  const windows = process.platform === "win32";
  const worker = spawn(windows ? process.execPath : command, windows
    ? [WINDOWS_CLAUDE_WORKER, command, ...args]
    : args, {
    cwd,
    env,
    stdio: [stdin, stdout, stderr],
    windowsHide: true,
    detached: true,
  });
  worker.on("error", onError);
  worker.on("exit", onExit);
  worker.unref();
  return worker;
}

export async function removeClaudeRunOutput({ outputPath, errorPath, ownerPath } = {}) {
  await Promise.all([outputPath, errorPath, ownerPath]
    .filter(Boolean)
    .map((file) => unlink(file).catch(() => {})));
}

export async function cleanupOrphanedClaudeRunOutputs(dataDir, activePaths = []) {
  const directory = claudeRunDirectory(dataDir);
  const normalize = (file) => {
    const resolved = path.resolve(String(file));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const normalizedActivePaths = new Set(activePaths
    .filter(Boolean)
    .map(normalize));
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const removed = [];
  for (const entry of entries) {
    if (!entry.isFile() || (!entry.name.endsWith(".jsonl")
      && !entry.name.endsWith(".err.log")
      && !entry.name.endsWith(".owner.json"))) continue;
    const file = path.join(directory, entry.name);
    if (normalizedActivePaths.has(normalize(file))) continue;
    try {
      await unlink(file);
      removed.push(file);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return removed;
}

// Читает дописанные строки файла хода, сохраняя незавершённый хвост до тех пор,
// пока CLI не допишет перевод строки.
export class ClaudeOutputReader {
  #path;
  #offset;
  #decoder = new StringDecoder("utf8");
  #trailingText = "";

  constructor(filePath, { offset = 0 } = {}) {
    this.#path = String(filePath ?? "");
    this.#offset = Number.isFinite(Number(offset)) ? Math.max(0, Number(offset)) : 0;
  }

  get offset() {
    return this.#offset;
  }

  async read({ maximumBytes = 1024 * 1024 } = {}) {
    if (!this.#path) return [];
    let handle;
    try {
      handle = await open(this.#path, "r");
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const lines = [];
    try {
      const info = await handle.stat();
      // Файл хода только дописывается; уменьшение размера означает пересоздание.
      if (info.size < this.#offset) {
        this.#offset = 0;
        this.#decoder = new StringDecoder("utf8");
        this.#trailingText = "";
      }
      while (this.#offset < info.size) {
        const length = Math.min(maximumBytes, info.size - this.#offset);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, this.#offset);
        if (!bytesRead) break;
        this.#offset += bytesRead;
        this.#trailingText += this.#decoder.write(buffer.subarray(0, bytesRead));
        const parts = this.#trailingText.split(/\r?\n/);
        this.#trailingText = parts.pop() ?? "";
        for (const part of parts) {
          if (part.trim()) lines.push(part);
        }
      }
    } finally {
      await handle.close();
    }
    return lines;
  }
}

function normalizedFingerprintText(value, { lowerCase = false } = {}) {
  const normalized = String(value ?? "").replace(/\0/g, " ").replace(/\s+/g, " ").trim();
  return lowerCase ? normalized.toLowerCase() : normalized;
}

export function processFingerprintMatches(expected, actual, { platform = process.platform } = {}) {
  if (!expected || !actual) return false;
  const expectedPid = Number(expected.pid);
  const actualPid = Number(actual.pid);
  if (!Number.isInteger(expectedPid) || expectedPid <= 0 || expectedPid !== actualPid) return false;
  const expectedCreation = normalizedFingerprintText(expected.creationTime);
  const actualCreation = normalizedFingerprintText(actual.creationTime);
  if (!expectedCreation || !actualCreation || expectedCreation !== actualCreation) return false;
  const lowerCasePaths = platform === "win32";
  for (const field of ["executablePath", "commandLine"]) {
    const expectedValue = normalizedFingerprintText(expected[field], {
      lowerCase: field === "executablePath" && lowerCasePaths,
    });
    if (!expectedValue) continue;
    const actualValue = normalizedFingerprintText(actual[field], {
      lowerCase: field === "executablePath" && lowerCasePaths,
    });
    if (!actualValue || actualValue !== expectedValue) return false;
  }
  return true;
}

function normalizedProcessRecord(value) {
  const pid = Number(value?.pid);
  const parentPid = Number(value?.parentPid);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(parentPid) || parentPid < 0) return null;
  return {
    pid,
    parentPid,
    creationTime: normalizedFingerprintText(value?.creationTime),
    executablePath: normalizedFingerprintText(value?.executablePath),
    commandLine: normalizedFingerprintText(value?.commandLine),
  };
}

function captureCommand(command, args, {
  spawnImpl = spawn,
  timeoutMs = 3_000,
  maximumOutputBytes = 1_000_000,
} = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(command, args, {
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      resolve(null);
      return;
    }
    let settled = false;
    let output = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill?.();
      finish(null);
    }, timeoutMs);
    timer.unref?.();
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      output += chunk;
      if (output.length > maximumOutputBytes) {
        child.kill?.();
        finish(null);
      }
    });
    child.once("error", () => finish(null));
    child.once("exit", (code) => finish(code === 0 ? output : null));
  });
}

async function readWindowsProcessTable(options) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "$items=@(Get-CimInstance -Query 'SELECT ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine FROM Win32_Process' | ForEach-Object {$created=if($null -eq $_.CreationDate){''}else{$_.CreationDate.ToUniversalTime().ToString('O')};[pscustomobject]@{pid=[int]$_.ProcessId;parentPid=[int]$_.ParentProcessId;creationTime=$created;executablePath=[string]$_.ExecutablePath;commandLine=[string]$_.CommandLine}})",
    "$items|ConvertTo-Json -Compress",
  ].join(";");
  const output = await (options.captureCommandImpl ?? captureCommand)(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { maximumOutputBytes: 16_000_000, ...options },
  );
  if (!output) return null;
  try {
    const value = JSON.parse(output);
    return (Array.isArray(value) ? value : [value]).map(normalizedProcessRecord).filter(Boolean);
  } catch {
    return null;
  }
}

async function readLinuxProcessTable({
  readDirectoryImpl = readdir,
  readFileImpl = readFile,
  readlinkImpl = readlink,
} = {}) {
  let entries;
  let bootId;
  try {
    [entries, bootId] = await Promise.all([
      readDirectoryImpl("/proc", { withFileTypes: true }),
      readFileImpl("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
  } catch {
    return null;
  }
  const records = await Promise.all(entries
    .filter((entry) => entry.isDirectory() && /^\d+$/u.test(entry.name))
    .map(async (entry) => {
      const pid = Number(entry.name);
      try {
        const statText = await readFileImpl(`/proc/${pid}/stat`, "utf8");
        const closingParenthesis = statText.lastIndexOf(")");
        if (closingParenthesis < 0) return null;
        const fields = statText.slice(closingParenthesis + 1).trim().split(/\s+/u);
        const parentPid = Number(fields[1]);
        const startTicks = normalizedFingerprintText(fields[19]);
        const [executablePath, commandLine] = await Promise.all([
          readlinkImpl(`/proc/${pid}/exe`).catch(() => ""),
          readFileImpl(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
        ]);
        return normalizedProcessRecord({
          pid,
          parentPid,
          creationTime: `linux:${normalizedFingerprintText(bootId)}:${startTicks}`,
          executablePath,
          commandLine,
        });
      } catch {
        return null;
      }
    }));
  return records.filter(Boolean);
}

async function readDarwinProcessTable(options) {
  const output = await (options.captureCommandImpl ?? captureCommand)(
    "ps",
    ["-axo", "pid=,ppid=,lstart=,comm=,command="],
    options,
  );
  if (!output) return null;
  return output.split(/\r?\n/u).map((line) => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.{24})\s+(\S+)\s*(.*)$/u);
    if (!match) return null;
    return normalizedProcessRecord({
      pid: match[1],
      parentPid: match[2],
      creationTime: match[3],
      executablePath: match[4],
      commandLine: match[5],
    });
  }).filter(Boolean);
}

export async function readProcessTable({ platform = process.platform, ...options } = {}) {
  if (platform === "win32") return readWindowsProcessTable(options);
  if (platform === "linux") return readLinuxProcessTable(options);
  if (platform === "darwin") return readDarwinProcessTable(options);
  return null;
}

export function ownedProcessTreeFromSnapshot(rootFingerprint, knownFingerprints = [], snapshot = [], {
  platform = process.platform,
  rootExited = false,
  rootHandleOwned = false,
  diagnostics = null,
} = {}) {
  const rootPid = Number(rootFingerprint?.pid);
  if (!Number.isInteger(rootPid) || rootPid <= 0) return null;
  const byId = new Map(snapshot.map(normalizedProcessRecord).filter(Boolean).map((item) => [item.pid, item]));
  const expectedById = new Map([rootFingerprint, ...knownFingerprints]
    .filter(Boolean)
    .map((item) => [Number(item.pid), item]));
  const currentRoot = byId.get(rootPid);
  const hasExactRoot = Boolean(normalizedFingerprintText(rootFingerprint?.creationTime));
  if (!hasExactRoot && !rootHandleOwned && !rootExited) return null;
  const rootReused = hasExactRoot && currentRoot
    && !processFingerprintMatches(rootFingerprint, currentRoot, { platform });
  if (rootReused && !rootExited) return null;
  const rootStartedAtMs = Number(rootFingerprint?.startedAtMs);
  const rootExitedAtMs = Number(rootFingerprint?.exitedAtMs);
  const rootCreatedAtMs = Date.parse(rootFingerprint?.creationTime);
  const earliestRootAtMs = Number.isFinite(rootCreatedAtMs) ? rootCreatedAtMs : rootStartedAtMs;
  // A process born before this run cannot become its descendant merely because
  // Windows retained a numeric parent PID which a later process reused. This
  // also fences exact fingerprints captured from an earlier, foreign tree.
  const predatesRun = (item) => {
    const createdAtMs = Date.parse(item?.creationTime);
    return Number.isFinite(earliestRootAtMs) && earliestRootAtMs > 0
      && Number.isFinite(createdAtMs) && createdAtMs < earliestRootAtMs - 1_000;
  };
  const liveParentChronology = (item) => {
    // Windows may retain a numeric parent PID after its original holder exits.
    // A live child created before the current parent cannot be its descendant,
    // even if both processes were created during this run.
    if (platform !== "win32") return "valid";
    const parent = byId.get(item.parentPid);
    if (!parent) return "valid";
    const childAtMs = Date.parse(item.creationTime);
    const parentAtMs = Date.parse(parent.creationTime);
    if (!Number.isFinite(childAtMs) || !Number.isFinite(parentAtMs)) return "unknown";
    return childAtMs < parentAtMs ? "foreign" : "valid";
  };
  const hasBoundedRootLifetime = Number.isFinite(rootStartedAtMs) && rootStartedAtMs > 0
    && Number.isFinite(rootExitedAtMs) && rootExitedAtMs > 0;

  const withinOwnerWindow = (owner, item) => {
    const createdAtMs = Date.parse(item?.creationTime);
    const startedAtMs = Number(owner?.startedAtMs);
    const exitedAtMs = Number(owner?.exitedAtMs);
    return Number.isFinite(createdAtMs)
      && (!Number.isFinite(startedAtMs) || createdAtMs >= startedAtMs - 1_000)
      && (!Number.isFinite(exitedAtMs) || createdAtMs <= exitedAtMs);
  };

  const ownedIds = new Set();
  const historicalAnchors = new Map();
  // PIDs that would anchor ancestry but cannot prove it now, with their bounded
  // historical identity (null when no closed lifetime was recorded). Unknown
  // processes below them may leave the tree unresolved, never an empty terminal tree.
  const ambiguousAnchors = new Map();
  const result = [];
  if (currentRoot && !rootReused) {
    if (hasExactRoot && !processFingerprintMatches(rootFingerprint, currentRoot, { platform })) return null;
    if (!hasExactRoot && !rootHandleOwned) return null;
    ownedIds.add(rootPid);
    result.push(currentRoot);
  } else if (rootReused) {
    // A current holder proves the root PID was reused. Exit times are recorded
    // after the real exit, so an earlier holder may have left children inside
    // the recorded window: unknown children there have no provable ancestry.
    ambiguousAnchors.set(rootPid, hasBoundedRootLifetime ? rootFingerprint : null);
  } else if (rootExited && hasBoundedRootLifetime) {
    ownedIds.add(rootPid);
    historicalAnchors.set(rootPid, rootFingerprint);
  } else if (!rootExited) {
    // A disappeared numeric root without a terminal lifetime is ambiguous:
    // PID reuse may already have happened and no later child can be attributed
    // to the original launch from its parentPid alone.
    return null;
  } else {
    // No durable lifetime was recorded for this exited root: fail closed.
    ambiguousAnchors.set(rootPid, null);
  }
  for (const [pid, expected] of expectedById) {
    if (pid === rootPid) continue;
    const current = byId.get(pid);
    if (current && predatesRun(current)) continue;
    if (current && processFingerprintMatches(expected, current, { platform })) {
      ownedIds.add(pid);
      result.push(current);
      continue;
    }
    // Only an exact fingerprint admits a live process. A closed lifetime is a
    // historical ancestry anchor solely while its PID is absent: a current
    // holder proves reuse, and an earlier holder may already have left
    // children inside the recorded interval. Such an anchor is ambiguous and
    // is not traversed; exact captured descendants still match on their own.
    const boundedHistoricalIdentity = Number.isFinite(Number(expected?.startedAtMs))
      && Number(expected?.startedAtMs) > 0
      && Number.isFinite(Number(expected?.exitedAtMs))
      && Number(expected?.exitedAtMs) > 0;
    if (!boundedHistoricalIdentity) continue;
    if (current) {
      ambiguousAnchors.set(pid, expected);
      continue;
    }
    ownedIds.add(pid);
    historicalAnchors.set(pid, expected);
  }
  let chronologyUnresolved = null;
  let changed = true;
  while (changed) {
    changed = false;
    for (const current of byId.values()) {
      if (ownedIds.has(current.pid) || !ownedIds.has(current.parentPid)) continue;
      if (predatesRun(current)) continue;
      const chronology = liveParentChronology(current);
      if (chronology === "foreign") continue;
      if (chronology === "unknown") {
        chronologyUnresolved ??= `parent-chronology-unavailable:${current.parentPid}:child=${current.pid}`;
        continue;
      }
      const historicalParent = historicalAnchors.get(current.parentPid);
      if (historicalParent && !withinOwnerWindow(historicalParent, current)) continue;
      if (!hasExactRoot && current.parentPid === rootPid) {
        const childAtMs = Date.parse(current.creationTime);
        const startedAtMs = Number(rootFingerprint?.startedAtMs);
        const exitedAtMs = Number(rootFingerprint?.exitedAtMs);
        if (!Number.isFinite(childAtMs)
          || (Number.isFinite(startedAtMs) && childAtMs < startedAtMs - 1_000)
          || (rootExited && Number.isFinite(exitedAtMs) && childAtMs > exitedAtMs)) continue;
      }
      const expected = expectedById.get(current.pid);
      if (expected && !processFingerprintMatches(expected, current, { platform })) continue;
      ownedIds.add(current.pid);
      result.push(current);
      changed = true;
    }
  }
  const owned = [...new Map(result.map((item) => [item.pid, item])).values()];
  const admitted = new Set(owned.map((item) => item.pid));
  let unresolved = chronologyUnresolved;
  for (const item of byId.values()) {
    if (admitted.has(item.pid) || ambiguousAnchors.has(item.pid)) continue;
    if (!ambiguousAnchors.has(item.parentPid)) continue;
    const anchor = ambiguousAnchors.get(item.parentPid);
    const childCreatedAtMs = Date.parse(item.creationTime);
    // A known creation time outside the anchor's closed lifetime cannot belong
    // to the original process: the recorded exit follows the real exit.
    if (anchor && Number.isFinite(childCreatedAtMs) && !withinOwnerWindow(anchor, item)) continue;
    // Inside the lifetime, a child created at or after the current holder's
    // creation was spawned by that holder and is proven foreign. Any earlier
    // child may belong to the original process or to an earlier holder.
    const holderCreatedAtMs = Date.parse(byId.get(item.parentPid)?.creationTime);
    if (Number.isFinite(holderCreatedAtMs) && Number.isFinite(childCreatedAtMs)
      && childCreatedAtMs >= holderCreatedAtMs) continue;
    unresolved ??= anchor
      ? `ambiguous-anchor:${item.parentPid}:child=${item.pid}`
      : `anchor-lifetime-missing:${item.parentPid}:child=${item.pid}`;
  }
  if (diagnostics) diagnostics.unresolved = unresolved;
  if (!unresolved) return owned;
  // Exact targets stay actionable, but they never prove the whole tree ended.
  if (!owned.length) return null;
  Object.defineProperty(owned, "unresolved", { value: true });
  return owned;
}

export async function readOwnedProcessTree(rootFingerprint, knownFingerprints = [], options = {}) {
  const snapshot = await (options.processTableLookup ?? readProcessTable)(options);
  if (!snapshot) return null;
  return ownedProcessTreeFromSnapshot(rootFingerprint, knownFingerprints, snapshot, options);
}

async function readWindowsProcessFingerprint(pid, options) {
  const script = [
    "$ErrorActionPreference='Stop'",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
    "if ($null -eq $p) { exit 3 }",
    "[pscustomobject]@{pid=[int]$p.ProcessId;creationTime=$p.CreationDate.ToUniversalTime().ToString('O');executablePath=[string]$p.ExecutablePath;commandLine=[string]$p.CommandLine}|ConvertTo-Json -Compress",
  ].join(";");
  const output = await (options.captureCommandImpl ?? captureCommand)(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    options,
  );
  if (!output) return null;
  try {
    const value = JSON.parse(output);
    return {
      pid: Number(value.pid),
      creationTime: normalizedFingerprintText(value.creationTime),
      executablePath: normalizedFingerprintText(value.executablePath),
      commandLine: normalizedFingerprintText(value.commandLine),
    };
  } catch {
    return null;
  }
}

async function readLinuxProcessFingerprint(pid, {
  readFileImpl = readFile,
  readlinkImpl = readlink,
} = {}) {
  try {
    const statText = await readFileImpl(`/proc/${pid}/stat`, "utf8");
    const closingParenthesis = statText.lastIndexOf(")");
    if (closingParenthesis < 0) return null;
    const fieldsAfterName = statText.slice(closingParenthesis + 1).trim().split(/\s+/);
    const startTicks = normalizedFingerprintText(fieldsAfterName[19]);
    if (!startTicks) return null;
    const [bootId, executablePath, commandLine] = await Promise.all([
      readFileImpl("/proc/sys/kernel/random/boot_id", "utf8").catch(() => ""),
      readlinkImpl(`/proc/${pid}/exe`).catch(() => ""),
      readFileImpl(`/proc/${pid}/cmdline`, "utf8").catch(() => ""),
    ]);
    return {
      pid,
      creationTime: `linux:${normalizedFingerprintText(bootId)}:${startTicks}`,
      executablePath: normalizedFingerprintText(executablePath),
      commandLine: normalizedFingerprintText(commandLine),
    };
  } catch {
    return null;
  }
}

async function readDarwinProcessFingerprint(pid, options) {
  const run = options.captureCommandImpl ?? captureCommand;
  const [creationTime, executablePath, commandLine] = await Promise.all([
    run("ps", ["-p", String(pid), "-o", "lstart="], options),
    run("ps", ["-p", String(pid), "-o", "comm="], options),
    run("ps", ["-p", String(pid), "-o", "command="], options),
  ]);
  const normalizedCreation = normalizedFingerprintText(creationTime);
  if (!normalizedCreation) return null;
  return {
    pid,
    creationTime: normalizedCreation,
    executablePath: normalizedFingerprintText(executablePath),
    commandLine: normalizedFingerprintText(commandLine),
  };
}

export async function readProcessFingerprint(pid, {
  platform = process.platform,
  ...options
} = {}) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return null;
  if (platform === "win32") return readWindowsProcessFingerprint(value, options);
  if (platform === "linux") return readLinuxProcessFingerprint(value, options);
  if (platform === "darwin") return readDarwinProcessFingerprint(value, options);
  return null;
}
