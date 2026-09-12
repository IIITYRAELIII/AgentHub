import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { callDesktopControl, readDesktopControlEndpoint } from "./desktop-control.mjs";
import { ensureWrangler } from "./wrangler-runner.mjs";
import { defaultRuntimeRoot } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { publicationRuntimeStatus, startInstalledPublicationRuntime } from "./src/runtime/runtime-publication-start.mjs";
import { waitForRuntimeReplacement } from "./src/runtime/publication-readiness.mjs";
export { waitForRuntimeReplacement } from "./src/runtime/publication-readiness.mjs";
import { prepareCommittedAgentHubReleaseVersion } from "./src/infrastructure/filesystem/release-version.mjs";
import { assertReleaseCloneForPublication } from "./src/infrastructure/filesystem/release-git-workspace.mjs";
import {
  publicationCheckpointStore,
  runPublicationSteps,
} from "./src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "./src/infrastructure/persistence/publication-run-store.mjs";
import { completePublication } from "./src/infrastructure/persistence/publication-completion.mjs";
import { withPublicationLock } from "./src/infrastructure/process/publication-lock.mjs";
import { stopProcessTree } from "./src/infrastructure/process/process-tree.mjs";
import {
  assertCleanPublicationTree,
  assertCurrentPublicationRevision,
  currentRevision,
  writePublicationState,
} from "./src/infrastructure/persistence/publication-state.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(ROOT, "..");
const python = process.platform === "win32" ? "python.exe" : "python3";
const DEFAULT_STEP_TIMEOUT_MS = 15 * 60 * 1_000;
export const FULL_TEST_BUDGET = Object.freeze({
  timeoutMs: 2 * 60 * 60 * 1_000,
  idleTimeoutMs: 10 * 60 * 1_000,
});
const RESTART_REQUEST_TIMEOUT_MS = 30_000;

export function publicationRepositories(identity, revision) {
  if (identity?.release) {
    return [{
      root: identity.release.primaryRoot,
      revision,
      planRevision: identity.release.planRevision,
      manifestHash: identity.release.manifestHash,
      baseCommit: identity.release.baseCommit,
      preReleaseHead: identity.release.preReleaseHead,
    }];
  }
  return [{ root: identity?.worktreeRoot ?? REPOSITORY_ROOT, revision }];
}

export function npmStep(label, args) {
  const npmCli = String(process.env.npm_execpath ?? "").trim();
  if (npmCli) {
    return { label, command: process.execPath, args: [npmCli, ...args] };
  }
  if (process.platform === "win32") {
    return {
      label,
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", "npm", ...args],
    };
  }
  return { label, command: "npm", args };
}

export function publicationSteps({
  skipTests = false,
  skipWorker = false,
  testContour = false,
  fullTestCheckpointId = "",
  workerChangedFiles = null,
} = {}) {
  return [
    ...(!skipTests ? [
      {
        ...npmStep("Полные тесты Agent Hub", ["run", "test:all"]),
        ...FULL_TEST_BUDGET,
        ...(fullTestCheckpointId ? {
          env: {
            AGENT_HUB_FULL_TEST_CHECKPOINT_ID: fullTestCheckpointId,
          },
        } : {}),
      },
    ] : []),
    ...(!skipTests && testContour
      ? [npmStep("Тестовый контур Agent Hub", ["run", "contour:verify", "--", "--require-installed"])]
      : []),
    npmStep("Сборка Agent Hub Mobile", ["run", "android:build"]),
    npmStep("Сборка runtime-релиза", ["run", "runtime:deploy"]),
    ...(!skipWorker ? [
      npmStep("Развёртывание Mini App Worker", ["run", "worker:deploy"]),
      {
        ...npmStep("Проверка Mini App Worker", ["run", "worker:verify"]),
        ...(Array.isArray(workerChangedFiles) ? {
          env: { AGENT_HUB_WORKER_CHANGED_FILES: JSON.stringify(workerChangedFiles) },
        } : {}),
      },
    ] : []),
    npmStep("Активация runtime-релиза", ["run", "runtime:activate"]),
    {
      label: "Установка расширения VS Code",
      command: python,
      args: ["install.py", "--extension-only"],
    },
  ];
}

export function runStep({
  label,
  command,
  args,
  env = {},
  timeoutMs = DEFAULT_STEP_TIMEOUT_MS,
  idleTimeoutMs = 0,
  logFile = "",
}, {
  spawnImpl = spawn,
  stopTree = stopProcessTree,
  schedule = setTimeout,
  unschedule = clearTimeout,
} = {}) {
  const startedAt = Date.now();
  console.log(`\n==> ${label}`);
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopping = false;
    let timer = null;
    let idleTimer = null;
    const log = logFile ? (() => {
      mkdirSync(path.dirname(logFile), { recursive: true });
      const stream = createWriteStream(logFile, { flags: "a" });
      stream.write(`\n==> ${label}\n`);
      return stream;
    })() : null;
    const child = spawnImpl(command, args, {
      cwd: ROOT,
      env: { ...process.env, ...env, PYTHONUTF8: "1" },
      shell: false,
      stdio: log || idleTimeoutMs ? ["inherit", "pipe", "pipe"] : "inherit",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      unschedule(timer);
      unschedule(idleTimer);
      log?.end();
      operation(value);
    };
    const stop = (reason) => {
      if (settled || stopping) return;
      stopping = true;
      void Promise.resolve(child.pid ? stopTree(child.pid) : false)
        .then((stopped) => { if (stopped === false) child.kill?.("SIGKILL"); })
        .catch(() => child.kill?.("SIGKILL"))
        .finally(() => finish(reject, new Error(`${label}: ${reason}`)));
    };
    const progress = () => {
      if (!idleTimeoutMs || settled || stopping) return;
      unschedule(idleTimer);
      idleTimer = schedule(() => stop(`нет вывода ${idleTimeoutMs} мс; проверьте последний тест в журнале`), idleTimeoutMs);
      idleTimer.unref?.();
    };
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      log?.write(chunk);
      progress();
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      log?.write(chunk);
      progress();
    });
    timer = schedule(() => stop(`превышен таймаут ${timeoutMs} мс`), timeoutMs);
    timer.unref?.();
    progress();
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      if (stopping) return;
      if (code === 0) {
        const completed = `<== ${label}: ${((Date.now() - startedAt) / 1_000).toFixed(1)} с`;
        console.log(completed);
        log?.write(`${completed}\n`);
        finish(resolve);
      }
      else {
        const error = new Error(`${label}: процесс завершён с ${signal ?? `кодом ${code}`}`);
        log?.write(`${error.message}\n`);
        finish(reject, error);
      }
    });
  });
}

export async function restartRuntimeAndVerify(restart, verifyRestart, runtimeRoot, {
  readStatus = publicationRuntimeStatus,
  readEndpoint = readDesktopControlEndpoint,
  startInstalled = startInstalledPublicationRuntime,
} = {}) {
  const status = await readStatus({ runtimeRoot });
  const expectedReleaseId = status.current;
  if (!expectedReleaseId) throw new Error("No published runtime is available for restart");
  const before = await readEndpoint(runtimeRoot).catch(() => null);
  if (status.running === false) {
    const launch = await startInstalled({ runtimeRoot, expectedReleaseId, readStatus });
    await verifyRestart({ runtimeRoot, expectedReleaseId, readStatus });
    return { accepted: true, started: launch.started, message: "Опубликованный runtime запущен и проверен" };
  }
  if (status.running !== true) throw new Error("Agent Hub process state is unknown");
  const result = await restart("restart-server", {}, {
    runtimeRoot,
    timeoutMs: RESTART_REQUEST_TIMEOUT_MS,
  });
  if (result?.waiting === true || result?.accepted === false) return { ...result, deferred: true };
  await verifyRestart({ previousEndpointId: before?.endpointId ?? null, runtimeRoot, expectedReleaseId, readStatus });
  return result;
}

export function parseArguments(args) {
  const known = new Set(["--skip-tests", "--skip-worker", "--skip-restart", "--test-contour"]);
  const unknown = args.filter((item) => !known.has(item));
  if (unknown.length) throw new Error(`Неизвестные аргументы: ${unknown.join(", ")}`);
  return {
    skipTests: args.includes("--skip-tests"),
    skipWorker: args.includes("--skip-worker"),
    skipRestart: args.includes("--skip-restart"),
    testContour: args.includes("--test-contour"),
  };
}

export async function publishAll(args = process.argv.slice(2), {
  run = runStep,
  restart = callDesktopControl,
  before = async () => {},
  exclusive = withPublicationLock,
  record = async () => writePublicationState({
    revision: await currentRevision({ cwd: REPOSITORY_ROOT }),
    publishedAt: new Date().toISOString(),
    mode: "full",
  }),
  revision = currentRevision,
  ensureWorkerDependency = ensureWrangler,
  prepareVersion = async () => ({ changed: false }),
  checkpoint = null,
  journal = null,
  runtimeRoot = defaultRuntimeRoot(),
  verifyRestart = restart === callDesktopControl ? waitForRuntimeReplacement : async () => {},
  readRuntimeStatus = publicationRuntimeStatus,
} = {}) {
  return exclusive(async () => {
    const options = parseArguments(args);
    await before();
    await prepareVersion();
    const head = checkpoint ? await revision({ cwd: REPOSITORY_ROOT }) : null;
    if (!options.skipWorker) await ensureWorkerDependency();
    const steps = publicationSteps({
      ...options,
      fullTestCheckpointId: head ? `full:${head}` : "",
    });
    const identity = {
      mode: "full", revision: head, worktreeRoot: REPOSITORY_ROOT, runtimeRoot,
      validationMode: options.skipTests ? "quick" : "full",
      labels: steps.map((step) => step.label),
    };
    try {
      await runPublicationSteps(steps, {
        run,
        checkpoint,
        identity,
        journal,
      });
      const completion = await completePublication({
        identity, publicationState: {
          revision: head,
          repositories: publicationRepositories(identity, head),
          mode: "full",
          validationMode: identity.validationMode,
        },
        journal, checkpoint, needsRestart: true, skipRestart: options.skipRestart,
        readRuntimeStatus, verifyRestart, writeState: record,
        requestRestart: (verification) => restartRuntimeAndVerify(restart, verifyRestart, runtimeRoot, verification),
      });
      console.log(`\nПубликация: ${completion.status}.`);
      return completion;
    } catch (error) {
      await journal?.finish("failed", error);
      throw error;
    }
  });
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  publishAll(process.argv.slice(2), {
    checkpoint: publicationCheckpointStore(),
    journal: publicationRunStore(),
    before: async () => {
      await assertReleaseCloneForPublication({ repositoryRoot: REPOSITORY_ROOT });
      await assertCleanPublicationTree({ cwd: REPOSITORY_ROOT });
      await assertCurrentPublicationRevision({ cwd: REPOSITORY_ROOT });
    },
    prepareVersion: prepareCommittedAgentHubReleaseVersion,
  }).catch((error) => {
    console.error(`\nПубликация остановлена: ${error.message}`);
    process.exitCode = 1;
  });
}
