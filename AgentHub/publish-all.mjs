import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { callDesktopControl, readDesktopControlEndpoint } from "./desktop-control.mjs";
import { ensureWrangler } from "./wrangler-runner.mjs";
import { defaultRuntimeRoot } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { publicationRuntimeStatus, startInstalledPublicationRuntime } from "./src/runtime/runtime-publication-start.mjs";
import { prepareCommittedAgentHubReleaseVersion } from "./src/infrastructure/filesystem/release-version.mjs";
import { assertReleaseCloneForPublication } from "./src/infrastructure/filesystem/release-git-workspace.mjs";
import {
  publicationCheckpointStore,
  runPublicationSteps,
} from "./src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "./src/infrastructure/persistence/publication-run-store.mjs";
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
const RESTART_READINESS_TIMEOUT_MS = 90_000;
const RESTART_REQUEST_TIMEOUT_MS = 30_000;

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
  logFile = "",
}, {
  spawnImpl = spawn,
  stopTree = stopProcessTree,
} = {}) {
  const startedAt = Date.now();
  console.log(`\n==> ${label}`);
  return new Promise((resolve, reject) => {
    let settled = false;
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
      stdio: log ? ["inherit", "pipe", "pipe"] : "inherit",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    child.stdout?.on("data", (chunk) => {
      process.stdout.write(chunk);
      log.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      process.stderr.write(chunk);
      log.write(chunk);
    });
    const finish = (operation, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log?.end();
      operation(value);
    };
    const timer = setTimeout(() => {
      void Promise.resolve(child.pid ? stopTree(child.pid) : false)
        .catch(() => child.kill?.("SIGKILL"))
        .finally(() => finish(reject, new Error(`${label}: превышен таймаут ${timeoutMs} мс`)));
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
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

export async function waitForRuntimeReplacement({
  previousEndpointId = null,
  runtimeRoot = defaultRuntimeRoot(),
  expectedReleaseId,
  timeoutMs = RESTART_READINESS_TIMEOUT_MS,
  readEndpoint = readDesktopControlEndpoint,
  readStatus = publicationRuntimeStatus,
  probe = callDesktopControl,
  delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now = Date.now,
} = {}) {
  if (!expectedReleaseId) throw new Error("Expected publication release is required for readiness verification");
  const deadline = now() + timeoutMs;
  let lastError = null;
  while (now() < deadline) {
    try {
      const endpoint = await readEndpoint(runtimeRoot);
      if (!previousEndpointId || endpoint.endpointId !== previousEndpointId) {
        const snapshot = await probe("snapshot", {}, { runtimeRoot, timeoutMs: Math.min(10_000, timeoutMs) });
        const status = await readStatus({ runtimeRoot });
        if (status.current !== expectedReleaseId || status.runningRelease !== expectedReleaseId
          || status.running !== true || status.ready !== true
          || snapshot?.server?.process?.releaseId !== expectedReleaseId
          || snapshot?.server?.process?.pid !== status.pid) {
          throw new Error(`Expected ready runtime ${expectedReleaseId}; current=${status.current}, running=${status.runningRelease}`);
        }
        return endpoint;
      }
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`Agent Hub Runtime не подтвердил готовность после перезапуска: ${lastError?.message ?? "timeout"}`);
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
    try {
      await runPublicationSteps(steps, {
        run,
        checkpoint,
        identity: {
          mode: "full",
          revision: head,
          worktreeRoot: REPOSITORY_ROOT,
          runtimeRoot,
          labels: steps.map((step) => step.label),
        },
        journal,
      });
      if (!options.skipRestart) {
        console.log("\n==> Запрос безопасного перезапуска Agent Hub");
        const result = await restartRuntimeAndVerify(restart, verifyRestart, runtimeRoot, { readStatus: readRuntimeStatus });
        console.log(result?.deferred
          ? `${result?.message ?? "Перезапуск запрошен"}. Готовность подтвердится после завершения активного хода.`
          : result?.message ?? "Перезапуск запрошен");
      }
      await record();
      if (checkpoint) await checkpoint.clear();
      await journal?.finish("succeeded");
    } catch (error) {
      await journal?.finish("failed", error);
      throw error;
    }
    console.log("\nПубликация завершена. Интерфейс VS Code подхватит runtime после переоткрытия панели или команды «Обновить Agent Hub»; Reload Window нужен только при изменении моста расширения.");
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
