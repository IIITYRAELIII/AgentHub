import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { callDesktopControl } from "./desktop-control.mjs";
import {
  npmStep,
  publicationSteps,
  restartRuntimeAndVerify,
  runStep,
  waitForRuntimeReplacement,
} from "./publish-all.mjs";
import { ensureWrangler } from "./wrangler-runner.mjs";
import { defaultRuntimeRoot } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { withPublicationLock } from "./src/infrastructure/process/publication-lock.mjs";
import {
  publicationCheckpointStore,
  runPublicationSteps,
} from "./src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "./src/infrastructure/persistence/publication-run-store.mjs";
import {
  assertCleanPublicationTree,
  assertCurrentPublicationRevision,
  changedFiles,
  currentRevision,
  readPublicationState,
  writePublicationState,
} from "./src/infrastructure/persistence/publication-state.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(ROOT, "..");

const emptyPlan = () => ({
  runtime: false,
  runtimeRestart: false,
  worker: false,
  android: false,
  vscode: false,
  unitTests: false,
  surfaceTests: false,
  fullTests: false,
  unknown: [],
});

export function classifyPublicationChanges(files) {
  const plan = emptyPlan();
  for (const rawFile of files) {
    const file = rawFile.replaceAll("\\", "/");
    if (file === "AgentHub/AGENT_HUB_GUIDE.md") {
      plan.runtime = true;
      plan.runtimeRestart = true;
      plan.unitTests = true;
      plan.surfaceTests = true;
      continue;
    }
    if (file === "CHANGELOG.md"
      || file === "AgentHub/config.example.json"
      || file === "AgentHub/architecture-migration-inventory.json"
      || file.endsWith(".md")
      || file.startsWith(".team/")) continue;
    if (!file.startsWith("AgentHub/")) continue;
    const relative = file.slice("AgentHub/".length);
    if (/\.test\.(?:mjs|js)$/u.test(relative) || relative.startsWith("e2e/") || relative.startsWith("ci/")) continue;
    if (relative.startsWith("assets/web-app/") || relative === "work-log.css") {
      plan.runtime = true;
      plan.runtimeRestart = true;
      plan.worker = true;
      plan.unitTests = true;
      plan.surfaceTests = true;
      continue;
    }
    if (relative.startsWith("assets/mobile/")) {
      plan.worker = true;
      continue;
    }
    if (relative.startsWith("cloudflare-worker/")) {
      plan.worker = true;
      plan.unitTests = true;
      plan.surfaceTests = true;
      continue;
    }
    if (relative.startsWith("AndroidApp/")) {
      plan.android = true;
      plan.worker = true;
      continue;
    }
    if (relative.startsWith("RuntimeHost/")) {
      plan.runtime = true;
      plan.runtimeRestart = true;
      plan.unitTests = true;
      plan.surfaceTests = true;
      continue;
    }
    if (relative.startsWith("VSCodeExtension/")) {
      plan.vscode = true;
      continue;
    }
    if (relative === "package.json" || relative.endsWith(".mjs") || relative.endsWith(".cjs") || relative.endsWith(".ps1") || relative.endsWith(".vbs") || relative.endsWith(".py")) {
      plan.runtime = true;
      plan.runtimeRestart = true;
      plan.unitTests = true;
      plan.surfaceTests = true;
      continue;
    }
    plan.runtime = true;
    plan.runtimeRestart = true;
    plan.unknown.push(file);
  }
  return plan;
}

function focusedSteps(plan, {
  fullTestCheckpointId = "",
  fullTestSourceFingerprint = "",
  testContour = false,
} = {}) {
  if (plan.unknown.length) {
    return publicationSteps({ fullTestCheckpointId, fullTestSourceFingerprint, testContour });
  }
  const full = publicationSteps({
    skipWorker: !plan.worker,
    fullTestCheckpointId,
    fullTestSourceFingerprint,
    testContour,
  });
  const byLabel = new Map(full.map((step) => [step.label, step]));
  const steps = [];
  if (plan.fullTests) {
    steps.push(byLabel.get("Полные тесты Agent Hub"));
  } else {
    steps.push(npmStep("Проверка синтаксиса Agent Hub", ["run", "check"]));
    if (plan.unitTests) {
      steps.push(npmStep("Unit-тесты Agent Hub", ["test"]));
    } else if (plan.runtime || plan.worker) {
      steps.push({
        label: "Контракт интерфейсов Agent Hub",
        command: process.execPath,
        args: [
          "--test",
          "tests/composition/message-lifecycle.test.mjs",
          "tests/interfaces/web/mini-app-server.test.mjs",
          "tests/interfaces/web/worker/worker.test.mjs",
          "tests/public/client-assets.test.mjs",
          "tests/public/worker-assets.test.mjs",
        ],
      });
    }
    if (plan.surfaceTests) {
      steps.push(npmStep("Межповерхностные E2E Agent Hub", ["run", "test:e2e"]));
    }
  }
  if (!plan.fullTests && (plan.vscode || plan.runtime)) {
    steps.push(npmStep("Тесты расширения VS Code", ["test", "--prefix", "VSCodeExtension"]));
  }
  if (testContour) steps.push(byLabel.get("Тестовый контур Agent Hub"));
  if (plan.android) steps.push(byLabel.get("Сборка Agent Hub Mobile"));
  if (plan.worker) steps.push(byLabel.get("Публикация Mini App Worker"));
  if (plan.runtime) {
    steps.push(byLabel.get("Сборка runtime-релиза"));
    steps.push(byLabel.get("Активация runtime-релиза"));
  }
  if (plan.vscode) steps.push(byLabel.get("Установка расширения VS Code"));
  return steps.filter(Boolean);
}

async function changedSourceFingerprint(files) {
  const sourceFiles = files.filter((file) => {
    const normalized = file.replaceAll("\\", "/");
    return normalized.startsWith("AgentHub/")
      && !normalized.startsWith("AgentHub/tests/")
      && !normalized.startsWith("AgentHub/e2e/")
      && !/\.test\.(?:mjs|js)$/u.test(normalized)
      && normalized !== "AgentHub/install_test.py";
  }).toSorted();
  const hash = createHash("sha256").update("release-source-v1\0");
  for (const file of sourceFiles) {
    hash.update(file).update("\0");
    try {
      hash.update(await readFile(path.resolve(REPOSITORY_ROOT, file)));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      hash.update("<deleted>");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function parseChangedArguments(args) {
  let from = "";
  let skipRestart = false;
  let fullTests = false;
  let testContour = false;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--skip-restart") skipRestart = true;
    else if (args[index] === "--full-tests") fullTests = true;
    else if (args[index] === "--test-contour") testContour = true;
    else if (args[index] === "--from" && args[index + 1]) from = args[++index];
    else throw new Error(`Неизвестный аргумент: ${args[index]}`);
  }
  return { from, skipRestart, fullTests, testContour };
}

export async function publishChanged(args = process.argv.slice(2), {
  run = runStep,
  restart = callDesktopControl,
  before = async () => {},
  exclusive = withPublicationLock,
  readState = readPublicationState,
  writeState = writePublicationState,
  revision = currentRevision,
  diff = changedFiles,
  ensureWorkerDependency = ensureWrangler,
  checkpoint = null,
  journal = null,
  runtimeRoot = defaultRuntimeRoot(),
  verifyRestart = restart === callDesktopControl ? waitForRuntimeReplacement : async () => {},
} = {}) {
  return exclusive(async () => {
    await before();
    const options = parseChangedArguments(args);
    const state = await readState();
    const from = options.from || state?.revision;
    if (!from) throw new Error("Нет исходной точки публикации. Сначала выполните npm run publish:all или укажите --from <commit>.");
    const files = await diff(from, { cwd: REPOSITORY_ROOT });
    const plan = classifyPublicationChanges(files);
    if (options.fullTests) plan.fullTests = true;
    if (plan.unknown.length) console.warn(`Неизвестные пути требуют полной публикации: ${plan.unknown.join(", ")}`);
    const head = await revision({ cwd: REPOSITORY_ROOT });
    if (plan.worker) await ensureWorkerDependency();
    const fullTestCheckpointId = createHash("sha256")
      .update(JSON.stringify({ mode: "changed", from }))
      .digest("hex");
    const fullTestSourceFingerprint = await changedSourceFingerprint(files);
    const steps = focusedSteps(plan, {
      fullTestCheckpointId,
      fullTestSourceFingerprint,
      testContour: options.testContour,
    });
    try {
      await runPublicationSteps(steps, {
        run,
        checkpoint,
        identity: {
          mode: "changed",
          from,
          revision: head,
          worktreeRoot: REPOSITORY_ROOT,
          runtimeRoot,
          files,
          labels: steps.map((step) => step.label),
        },
        journal,
      });
      if (plan.runtimeRestart && !options.skipRestart) {
        const result = await restartRuntimeAndVerify(restart, verifyRestart, runtimeRoot);
        if (result?.deferred) {
          console.log(`${result?.message ?? "Перезапуск запрошен"}. Готовность подтвердится после завершения активного хода.`);
        }
      }
      await writeState({ revision: head, publishedAt: new Date().toISOString(), files, plan });
      if (checkpoint) await checkpoint.clear();
      await journal?.finish("succeeded");
    } catch (error) {
      await journal?.finish("failed", error);
      throw error;
    }
    console.log(`\nВыборочная публикация завершена: ${files.length} изменённых файлов.`);
    return { files, plan, revision: head };
  });
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  publishChanged(process.argv.slice(2), {
    checkpoint: publicationCheckpointStore(),
    journal: publicationRunStore(),
    before: async () => {
      await assertCleanPublicationTree({ cwd: REPOSITORY_ROOT });
      await assertCurrentPublicationRevision({ cwd: REPOSITORY_ROOT });
    },
  }).catch((error) => {
    console.error(`\nПубликация остановлена: ${error.message}`);
    process.exitCode = 1;
  });
}
