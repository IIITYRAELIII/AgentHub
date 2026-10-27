import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

export const TEST_RESOURCE_BUDGET = 0.4;

async function windowsAccounting(cpuBudget) {
  const source = fileURLToPath(new URL("./test-resource-accounting.cs", import.meta.url));
  // The path is a literal PowerShell argument, never executable source text.
  const literal = `'${source.replaceAll("'", "''")}'`;
  const command = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; Add-Type -Path ${literal}; [TestResourceAccounting]::Run(${process.pid},${Math.round(cpuBudget * 10000)})`;
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  let failure;
  let closed = false;
  let closePromise = null;
  let stderr = "";
  let pending;
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-4_096); });
  const lines = createInterface({ input: child.stdout });
  const values = [];
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line);
      if (pending) { const { resolve } = pending; pending = null; resolve(value); }
      else values.push(value);
    } catch (error) { failed(error); }
  });
  function failed(error) {
    failure = failure && failure !== error
      ? new AggregateError([failure, error], "Test resource accounting and cleanup failed", { cause: failure })
      : error;
    pending?.reject(failure);
    pending = null;
  }
  child.on("error", failed);
  child.stdin.on("error", failed);
  const exited = once(child, "close").then(([code]) => {
    if (code !== 0) failed(new Error(`Test resource accounting exited ${code}: ${stderr}`));
    else if (pending) failed(new Error("Test resource accounting closed before its sample"));
  });
  // A failed native accounting setup refuses new admission, never silently
  // substitutes Node heap or a new fixed worker limit.
  async function receive() {
    if (failure) throw failure;
    if (values.length) return values.shift();
    return new Promise((resolve, reject) => { pending = { resolve, reject }; });
  }
  try { await receive(); } catch (error) {
    try { child.stdin.end(); await exited; }
    finally { lines.close(); }
    throw failure ?? error;
  }
  return {
    sample: () => {
      if (closed) return Promise.reject(new Error("Test resource accounting is closed"));
      if (!failure) child.stdin.write("sample\n");
      return receive();
    },
    close: () => {
      if (closePromise) return closePromise;
      closed = true;
      closePromise = (async () => {
        try {
          child.stdin.end("close\n");
          await exited;
          if (failure) throw failure;
        } finally { lines.close(); }
      })();
      return closePromise;
    },
  };
}

async function linuxAccounting() {
  // Linux stat child times include reaped descendants, so short Git processes
  // are not lost between snapshots. Live descendants have their own totals.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const hz = Number((await promisify(execFile)("getconf", ["CLK_TCK"])).stdout.trim());
  const page = Number((await promisify(execFile)("getconf", ["PAGESIZE"])).stdout.trim());
  return {
    async sample() {
      const stats = [];
      for (const pid of (await readdir("/proc")).filter((value) => /^\d+$/u.test(value))) {
        try {
          const text = await readFile(`/proc/${pid}/stat`, "utf8");
          const fields = text.slice(text.lastIndexOf(")") + 2).split(" ");
          stats.push({ pid: Number(pid), parent: Number(fields[1]),
            cpu: fields.slice(11, 15).reduce((sum, value) => sum + Number(value), 0), rss: Number(fields[21]) * page });
        } catch (error) { if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error; }
      }
      const family = new Set([process.pid]);
      let prior;
      do { prior = family.size; for (const row of stats) if (family.has(row.parent)) family.add(row.pid); } while (prior !== family.size);
      const rows = stats.filter((row) => family.has(row.pid));
      return { cpuMs: rows.reduce((sum, row) => sum + row.cpu * 1000 / hz, 0),
        rssBytes: rows.reduce((sum, row) => sum + row.rss, 0), processes: rows.length };
    },
    async close() {},
  };
}

export function parsePosixProcessAccounting(text, rootPid) {
  const rows = text.trim().split("\n").filter(Boolean).map((line) => {
    const [pid, parent, cpu, rss] = line.trim().split(/\s+/u);
    const parts = cpu.split(":").map(Number);
    const seconds = parts.reduce((sum, value) => sum * 60 + value, 0);
    return { pid: Number(pid), parent: Number(parent), cpuMs: seconds * 1000, rssBytes: Number(rss) * 1024 };
  });
  const family = new Set([rootPid]);
  let prior;
  do { prior = family.size; for (const row of rows) if (family.has(row.parent)) family.add(row.pid); } while (prior !== family.size);
  const selected = rows.filter((row) => family.has(row.pid));
  if (!selected.some((row) => row.pid === rootPid)) throw new Error("Test accounting root is absent");
  if (selected.some((row) => !Number.isFinite(row.cpuMs) || !Number.isFinite(row.rssBytes))) throw new Error("Invalid ps accounting data");
  return { cpuMs: selected.reduce((sum, row) => sum + row.cpuMs, 0),
    rssBytes: selected.reduce((sum, row) => sum + row.rssBytes, 0), processes: selected.length };
}

async function posixAccounting() {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  return {
    async sample() {
      // BSD ps -S includes CPU of reaped children in their parent's time.
      const { stdout } = await promisify(execFile)("ps", ["-A", "-S", "-o", "pid=,ppid=,time=,rss="]);
      return parsePosixProcessAccounting(stdout, process.pid);
    },
    async close() {},
  };
}

function hostTimes() {
  const times = os.cpus().map((cpu) => cpu.times);
  return { total: times.reduce((sum, value) => sum + Object.values(value).reduce((a, b) => a + b, 0), 0),
    idle: times.reduce((sum, value) => sum + value.idle, 0) };
}

export async function createTestResourceMonitor({ cpuBudget = TEST_RESOURCE_BUDGET } = {}) {
  if (!Number.isFinite(cpuBudget) || cpuBudget < 0.0001 || cpuBudget > TEST_RESOURCE_BUDGET) {
    throw new RangeError("Test CPU budget must be positive and cannot exceed 40 percent");
  }
  const accounting = process.platform === "win32" ? await windowsAccounting(cpuBudget)
    : process.platform === "linux" ? await linuxAccounting()
      : await posixAccounting();
  const cores = os.cpus().length;
  let previous = { ...(await accounting.sample()), time: performance.now(), host: hostTimes() };
  return {
    async sample() {
      const current = { ...(await accounting.sample()), time: performance.now(), host: hostTimes() };
      const elapsed = current.time - previous.time;
      const hostDelta = current.host.total - previous.host.total;
      const result = { cpuFraction: Math.max(0, (current.cpuMs - previous.cpuMs) / Math.max(1, elapsed) / cores),
        hostCpuFraction: hostDelta > 0 ? 1 - (current.host.idle - previous.host.idle) / hostDelta : 0,
        rssBytes: current.rssBytes, totalMemory: os.totalmem(), freeMemory: os.freemem(),
        cores, elapsedMs: elapsed, cpuMs: current.cpuMs, processes: current.processes,
        totalProcesses: current.totalProcesses, limitFlags: current.limitFlags,
        cpuControlFlags: current.cpuControlFlags, cpuRate: current.cpuRate };
      previous = current;
      return result;
    },
    close: () => accounting.close(),
  };
}
