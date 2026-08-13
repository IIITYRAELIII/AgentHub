import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { callDesktopControl } from "./desktop-control.mjs";
import { ensureWrangler } from "./wrangler-runner.mjs";
import {
  publicationCheckpointStore,
  runPublicationSteps,
} from "./src/infrastructure/persistence/publication-checkpoint.mjs";
import { withPublicationLock } from "./src/infrastructure/process/publication-lock.mjs";
import {
  assertCleanPublicationTree,
  assertCurrentPublicationRevision,
  currentRevision,
  writePublicationState,
} from "./src/infrastructure/persistence/publication-state.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(ROOT, "..");
const python = process.platform === "win32" ? "python.exe" : "python3";
const powershell = process.platform === "win32" ? "powershell.exe" : "pwsh";

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
} = {}) {
  return [
    ...(!skipTests ? [
      npmStep("Полные тесты Agent Hub", ["run", "test:all"]),
      npmStep("Тесты расширения VS Code", ["test", "--prefix", "VSCodeExtension"]),
      {
        label: "Сборка и smoke-проверка Agent Hub Desktop",
        command: powershell,
        args: [
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          path.join("ci", "desktop-smoke.ps1"),
        ],
      },
    ] : []),
    npmStep("Сборка Agent Hub Mobile", ["run", "android:build"]),
    ...(!skipWorker ? [
      npmStep("Публикация Mini App Worker", ["run", "worker:deploy"]),
    ] : []),
    npmStep("Сборка runtime-релиза", ["run", "runtime:deploy"]),
    npmStep("Активация runtime-релиза", ["run", "runtime:activate"]),
    {
      label: "Установка расширения VS Code",
      command: python,
      args: ["install.py", "--extension-only"],
    },
  ];
}

export function runStep({ label, command, args }) {
  const startedAt = Date.now();
  console.log(`\n==> ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: { ...process.env, PYTHONUTF8: "1" },
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        console.log(`<== ${label}: ${((Date.now() - startedAt) / 1_000).toFixed(1)} с`);
        resolve();
      }
      else reject(new Error(`${label}: процесс завершён с ${signal ?? `кодом ${code}`}`));
    });
  });
}

export function parseArguments(args) {
  const known = new Set(["--skip-tests", "--skip-worker", "--skip-restart"]);
  const unknown = args.filter((item) => !known.has(item));
  if (unknown.length) throw new Error(`Неизвестные аргументы: ${unknown.join(", ")}`);
  return {
    skipTests: args.includes("--skip-tests"),
    skipWorker: args.includes("--skip-worker"),
    skipRestart: args.includes("--skip-restart"),
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
  checkpoint = null,
} = {}) {
  return exclusive(async () => {
    await before();
    const options = parseArguments(args);
    const head = checkpoint ? await revision({ cwd: REPOSITORY_ROOT }) : null;
    if (!options.skipWorker) await ensureWorkerDependency();
    const steps = publicationSteps(options);
    await runPublicationSteps(steps, {
      run,
      checkpoint,
      identity: {
        mode: "full",
        revision: head,
        labels: steps.map((step) => step.label),
      },
    });
    await record();
    if (checkpoint) await checkpoint.clear();
    if (!options.skipRestart) {
      console.log("\n==> Запрос безопасного перезапуска Agent Hub");
      const result = await restart("restart-server");
      console.log(result?.message ?? "Перезапуск запрошен");
    }
    console.log("\nПубликация завершена. Интерфейс VS Code подхватит runtime после переоткрытия панели или команды «Обновить Agent Hub»; Reload Window нужен только при изменении моста расширения.");
  });
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  publishAll(process.argv.slice(2), {
    checkpoint: publicationCheckpointStore(),
    before: async () => {
      await assertCleanPublicationTree({ cwd: REPOSITORY_ROOT });
      await assertCurrentPublicationRevision({ cwd: REPOSITORY_ROOT });
    },
  }).catch((error) => {
    console.error(`\nПубликация остановлена: ${error.message}`);
    process.exitCode = 1;
  });
}
