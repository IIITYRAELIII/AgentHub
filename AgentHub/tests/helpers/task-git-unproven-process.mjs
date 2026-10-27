import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { watch } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import {
  runTaskGitCommand,
  TaskGitWorkspaceService,
} from "../../src/infrastructure/filesystem/task-git-workspace.mjs";

const execFileAsync = promisify(execFile);

export async function initializeTaskGitRepository(root) {
  await mkdir(root, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root, windowsHide: true });
  await execFileAsync("git", ["config", "core.autocrlf", "false"], { cwd: root, windowsHide: true });
  await writeFile(path.join(root, "app.txt"), "main\n", "utf8");
  await execFileAsync("git", ["add", "app.txt"], { cwd: root, windowsHide: true });
  await execFileAsync("git", [
    "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "main",
  ], { cwd: root, windowsHide: true });
}

export async function unprovenProcessTaskGit({ context, root, dataDir, taskId,
  abortWhenReady = true, removeProcessGuard,
  readSystemBootIdentity = () => ({
    source: "Win32_OperatingSystem.LastBootUpTime",
    executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    bootTime: "2100-01-01T00:00:00.000Z",
  }),
}) {
  const parentScript = path.join(root, "guard-parent.mjs");
  const childScript = path.join(root, "guard-child.mjs");
  const pidFile = path.join(root, "guard-child.pid");
  const staleMutation = path.join(root, "stale-descendant-mutation.txt");
  const releaseMutation = path.join(root, "release-stale-mutation");
  const watchers = new Set();
  const readPublishedFile = (file) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      watcher.close();
      watchers.delete(watcher);
      if (error) reject(error); else resolve(value);
    };
    const check = () => readFile(file, "utf8").then(
      value => finish(null, value),
      error => { if (error.code !== "ENOENT") finish(error); },
    );
    const watcher = watch(path.dirname(file), (_event, name) => {
      if (String(name) === path.basename(file)) void check();
    });
    watchers.add(watcher);
    watcher.once("error", error => finish(error));
    void check();
  });
  await writeFile(childScript, `
    import { existsSync, renameSync, watch, writeFileSync } from "node:fs";
    import path from "node:path";
    const release = process.argv[3];
    const watcher = watch(path.dirname(release), (_event, name) => {
      if (String(name) !== path.basename(release) || !existsSync(release)) return;
      watcher.close();
      writeFileSync(process.argv[2] + ".tmp", "stale mutation attempted");
      renameSync(process.argv[2] + ".tmp", process.argv[2]);
    });
    process.send({ ready: true });
    setInterval(() => {}, 1000);
  `, "utf8");
  await writeFile(parentScript, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, [process.argv[2], process.argv[4], process.argv[5]], {
      detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    child.unref();
    writeFileSync(process.argv[3], String(child.pid));
    child.once("message", message => {
      if (message?.ready !== true) return;
      process.stdout.write("guard-child-ready:" + child.pid + "\\n");
    });
    child.once("error", error => { console.error(error); process.exit(1); });
    setInterval(() => {}, 1000);
  `, "utf8");
  const interruptWhenReady = new AbortController();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  // The command failure may be observed before cleanup consumes readiness.
  ready.catch(() => {});
  const failingTaskkillSpawn = (executable, args, options) => {
    if (String(executable).toLowerCase() === "taskkill") {
      const killer = new EventEmitter();
      killer.kill = () => {};
      queueMicrotask(() => killer.emit("close", 1));
      return killer;
    }
    const child = spawn(executable, args, options);
    if (executable === process.execPath && args[0] === parentScript) {
      let output = "";
      child.stdout.on("data", chunk => {
        output += chunk.toString("utf8");
        const match = /guard-child-ready:(\d+)\n/u.exec(output);
        if (!match || descendantPid != null) return;
        descendantPid = Number(match[1]);
        readyResolve(descendantPid);
        if (abortWhenReady) interruptWhenReady.abort();
      });
      child.once("error", readyReject);
      child.once("close", () => {
        if (descendantPid == null) readyReject(new Error("parent exited before descendant readiness"));
      });
    }
    return child;
  };
  let intercepted = false;
  let guardSeenBeforeSpawn = false;
  let descendantPid = null;
  let descendantStopped = false;
  const service = new TaskGitWorkspaceService({
    dataDir,
    readSystemBootIdentity,
    removeProcessGuard,
    runCommand: async (args, options) => {
      if (!intercepted && args[0] === "worktree" && args[1] === "add") {
        intercepted = true;
        const guardDirectory = path.join(dataDir, "task-process-tree-guards", taskId);
        const guards = await readdir(guardDirectory).catch(() => []);
        guardSeenBeforeSpawn = guards.some((name) => name.endsWith(".json"));
        return runTaskGitCommand([parentScript, childScript, pidFile, staleMutation, releaseMutation], {
          cwd: root,
          executable: process.execPath,
          spawnProcess: failingTaskkillSpawn,
          signal: options.signal ? AbortSignal.any([options.signal, interruptWhenReady.signal]) : interruptWhenReady.signal,
          timeoutMs: options.timeoutMs,
        });
      }
      return runTaskGitCommand(args, options);
    },
  });
  async function readDescendantPid() {
    const pid = await ready;
    if (Number(await readFile(pidFile, "utf8")) !== pid) throw new Error("descendant readiness identity changed");
    return pid;
  }
  async function proveAndRecover() {
    await stopDescendant();
    return service.recoverProcessTreeGuard(taskId, {
      repositoryRoot: root,
      guardId: JSON.parse(await readFile(path.join(
        dataDir, "task-process-tree-guards", taskId,
        (await readdir(path.join(dataDir, "task-process-tree-guards", taskId)))[0],
      ), "utf8")).guardId,
      proof: {
        kind: "system-restart-after-guard",
        confirmed: true,
        summary: "test fixture boot boundary",
      },
    });
  }
  async function stopDescendant() {
    if (descendantStopped) return;
    if (descendantPid == null && intercepted) descendantPid = await readDescendantPid().catch(async () => (
      Number(await readFile(pidFile, "utf8").catch(() => "")) || null
    ));
    if (descendantPid) {
      // Await this owned child's actual termination, rather than sleeping and
      // racing the caller's recursive fixture cleanup on Windows.
      await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
        `try { $p = [System.Diagnostics.Process]::GetProcessById(${descendantPid}) } catch [System.ArgumentException] { exit 0 }; try { $p.Kill(); $p.WaitForExit() } catch [System.InvalidOperationException] {} finally { $p.Dispose() }`,
      ], { windowsHide: true });
    }
    descendantStopped = true;
    descendantPid = null;
  }
  async function close() {
    for (const watcher of watchers) watcher.close();
    watchers.clear();
    await stopDescendant();
  }
  context.after(close);
  return {
    service,
    ownedCommand: {
      args: [parentScript, childScript, pidFile, staleMutation, releaseMutation],
      spawnProcess: failingTaskkillSpawn,
      ready: () => descendantPid != null,
    },
    guardSeen: () => guardSeenBeforeSpawn,
    staleMutation,
    close,
    waitForStaleMutation: async () => {
      await readDescendantPid();
      const published = readPublishedFile(staleMutation);
      await writeFile(releaseMutation, "release", "utf8");
      return published;
    },
    proveAndRecover,
  };
}
