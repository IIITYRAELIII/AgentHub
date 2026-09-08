import { execFile, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as wait } from "node:timers/promises";
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

export async function unprovenProcessTaskGit({ context, root, dataDir, taskId }) {
  const parentScript = path.join(root, "guard-parent.mjs");
  const childScript = path.join(root, "guard-child.mjs");
  const pidFile = path.join(root, "guard-child.pid");
  const staleMutation = path.join(root, "stale-descendant-mutation.txt");
  await writeFile(childScript, `
    import { writeFileSync } from "node:fs";
    setTimeout(() => writeFileSync(process.argv[2], "stale mutation attempted"), 350);
    setInterval(() => {}, 1000);
  `, "utf8");
  await writeFile(parentScript, `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const child = spawn(process.execPath, [process.argv[2], process.argv[4]], { detached: true, stdio: "ignore" });
    child.unref();
    writeFileSync(process.argv[3], String(child.pid));
    setInterval(() => {}, 1000);
  `, "utf8");
  const failingTaskkillSpawn = (executable, args, options) => {
    if (String(executable).toLowerCase() === "taskkill") {
      const killer = new EventEmitter();
      killer.kill = () => {};
      queueMicrotask(() => killer.emit("close", 1));
      return killer;
    }
    return spawn(executable, args, options);
  };
  let intercepted = false;
  let guardSeenBeforeSpawn = false;
  let descendantPid = null;
  const service = new TaskGitWorkspaceService({
    dataDir,
    runCommand: async (args, options) => {
      if (!intercepted && args[0] === "worktree" && args[1] === "add") {
        intercepted = true;
        const guardDirectory = path.join(dataDir, "task-process-tree-guards", taskId);
        const guards = await readdir(guardDirectory).catch(() => []);
        guardSeenBeforeSpawn = guards.some((name) => name.endsWith(".json"));
        return runTaskGitCommand([parentScript, childScript, pidFile, staleMutation], {
          cwd: root,
          executable: process.execPath,
          spawnProcess: failingTaskkillSpawn,
          signal: options.signal,
          timeoutMs: 120,
        });
      }
      return runTaskGitCommand(args, options);
    },
  });
  async function readDescendantPid() {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const value = await readFile(pidFile, "utf8").catch(() => "");
      if (Number(value)) return Number(value);
      await wait(20);
    }
    throw new Error("detached descendant PID was not recorded");
  }
  async function proveAndRecover() {
    descendantPid ??= await readDescendantPid();
    try { process.kill(descendantPid, "SIGKILL"); } catch {}
    descendantPid = null;
    await wait(100);
    return service.recoverProcessTreeGuard(taskId, {
      repositoryRoot: root,
      operatorProof: "confirmed-no-descendants",
    });
  }
  context.after(async () => {
    if (descendantPid == null) descendantPid = await readDescendantPid().catch(() => null);
    if (descendantPid) try { process.kill(descendantPid, "SIGKILL"); } catch {}
  });
  return {
    service,
    guardSeen: () => guardSeenBeforeSpawn,
    staleMutation,
    waitForStaleMutation: async () => {
      await wait(500);
      return readFile(staleMutation, "utf8");
    },
    proveAndRecover,
  };
}
