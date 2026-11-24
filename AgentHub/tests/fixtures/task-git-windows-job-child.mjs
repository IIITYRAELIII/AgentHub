import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runOwnedGit, TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { taskOperationExecutionStorage } from "../../src/ports/task-operation-execution-context.mjs";

const script = fileURLToPath(import.meta.url);
const git = promisify(execFile);
const [mode, dataDir, cwd, taskId, operationId, target] = process.argv.slice(2);
if (mode === "descendant") {
  await writeFile(dataDir, "running");
  await delay(4000);
  await writeFile(cwd, "late");
} else if (mode === "git-and-descendant") {
  const [root, running, late, oid] = process.argv.slice(3);
  await git("git", ["update-ref", "refs/heads/dev", oid], { cwd: root, windowsHide: true });
  const child = spawn(process.execPath, [script, "descendant", running, late], { windowsHide: true, stdio: "ignore" });
  await new Promise(resolve => child.on("exit", resolve));
} else if (mode === "hub") {
  const holdCompleted = process.env.HUB_JOB_FIXTURE_MODE === "completed";
  const service = new TaskGitWorkspaceService({ dataDir });
  await taskOperationExecutionStorage.run({ taskId, operationId, signal: new AbortController().signal, assertExecuting() {} },
    () => service.withTaskLock(taskId, async lease => {
      const original = lease.beginProcessTreeGuard;
      if (holdCompleted) {
        lease.beginProcessTreeGuard = async args => {
          const guard = await original(args);
          return { ...guard, async clear() {
            process.stdout.write("completed-held\n");
            await delay(60_000);
            throw new Error("Fixture was not killed after native completion");
          } };
        };
      }
      if (holdCompleted) {
        const transaction = "start\nupdate refs/heads/dev " + target + "\nprepare\ncommit\n";
        await runOwnedGit(["update-ref", "--stdin"], { cwd, lease, input: Buffer.from(transaction) });
      } else {
        await runOwnedGit([script, "git-and-descendant", cwd, process.env.HUB_JOB_RUNNING,
          process.env.HUB_JOB_LATE, target], { cwd, lease, executable: process.execPath });
      }
    }));
}
