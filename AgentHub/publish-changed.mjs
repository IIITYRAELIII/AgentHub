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
import { prepareCommittedAgentHubReleaseVersion } from "./src/infrastructure/filesystem/release-version.mjs";
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
export const RELEASE_CANDIDATE_CONTOUR_LABEL = "Проверка release candidate в изолированном контуре";

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
    if (relative === "client-assets.cjs" || relative === "theme-registry.cjs") {
      plan.runtime = true;
      plan.runtimeRestart = true;
      plan.worker = true;
      plan.unitTests = true;
      plan.surfaceTests = true;
      continue;
    }
    if (relative === "package.json" || relative === "package-lock.json" || relative.endsWith(".mjs") || relative.endsWith(".cjs") || relative.endsWith(".ps1") || relative.endsWith(".vbs") || relative.endsWith(".py")) {
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
  testContour = false,
  workerChangedFiles = null,
} = {}) {
  const releaseCandidateContour = plan.fullTests;
  const full = publicationSteps({
    skipWorker: plan.unknown.length ? false : !plan.worker,
    fullTestCheckpointId,
    testContour: testContour && !releaseCandidateContour,
    workerChangedFiles,
  });
  if (releaseCandidateContour) {
    const fullTestIndex = full.findIndex((step) => step.label === "Полные тесты Agent Hub");
    full.splice(fullTestIndex < 0 ? 0 : fullTestIndex + 1, 0, npmStep(
      RELEASE_CANDIDATE_CONTOUR_LABEL,
      ["run", "contour:verify", "--", "--require-installed", "--model", "fake-codex"],
    ));
  }
  if (plan.unknown.length) return full;
  const byLabel = new Map(full.map((step) => [step.label, step]));
  const steps = [];
  if (plan.fullTests) {
    steps.push(byLabel.get("Полные тесты Agent Hub"));
    steps.push(byLabel.get(RELEASE_CANDIDATE_CONTOUR_LABEL));
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
  if (plan.worker) {
    steps.push(byLabel.get("Развёртывание Mini App Worker"));
    steps.push(byLabel.get("Проверка Mini App Worker"));
  }
  if (plan.runtime) {
    steps.push(byLabel.get("Сборка runtime-релиза"));
    steps.push(byLabel.get("Активация runtime-релиза"));
  }
  if (plan.vscode) steps.push(byLabel.get("Установка расширения VS Code"));
  return steps.filter(Boolean);
}

async function contentFingerprint(namespace, files) {
  const hash = createHash("sha256").update(`publication-step-v1\0${namespace}\0`);
  for (const file of files.toSorted()) {
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

function workerDeploymentFile(file) {
  return file.startsWith("AgentHub/assets/web-app/")
    || file.startsWith("AgentHub/assets/mobile/")
    || file.startsWith("AgentHub/AndroidApp/")
    || file === "AgentHub/client-assets.cjs"
    || file === "AgentHub/theme-registry.cjs"
    || (file.startsWith("AgentHub/cloudflare-worker/")
      && file !== "AgentHub/cloudflare-worker/verify-deployment.mjs");
}

function runtimeFile(file) {
  return file.startsWith("AgentHub/")
    && !file.startsWith("AgentHub/tests/")
    && !file.startsWith("AgentHub/e2e/")
    && !file.startsWith("AgentHub/cloudflare-worker/")
    && !file.startsWith("AgentHub/AndroidApp/")
    && !file.startsWith("AgentHub/VSCodeExtension/");
}

function filesForStep(label, files) {
  if (label === "Развёртывание Mini App Worker") return files.filter(workerDeploymentFile);
  if (label === "Проверка Mini App Worker") {
    return files.filter((file) => workerDeploymentFile(file)
      || file === "AgentHub/cloudflare-worker/verify-deployment.mjs");
  }
  if (label === "Сборка Agent Hub Mobile") {
    return files.filter((file) => file.startsWith("AgentHub/AndroidApp/")
      || file.startsWith("AgentHub/assets/mobile/"));
  }
  if (label === "Установка расширения VS Code") {
    return files.filter((file) => file.startsWith("AgentHub/VSCodeExtension/"));
  }
  if (label === "Сборка runtime-релиза" || label === "Активация runtime-релиза") {
    return files.filter(runtimeFile);
  }
  return files;
}

async function withStepFingerprints(steps, files) {
  return Promise.all(steps.map(async (step) => ({
    ...step,
    fingerprint: await contentFingerprint(
      JSON.stringify({ label: step.label, command: step.command, args: step.args, env: step.env ?? {} }),
      filesForStep(step.label, files),
    ),
  })));
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
  prepareVersion = async () => ({ changed: false }),
  checkpoint = null,
  journal = null,
  runtimeRoot = defaultRuntimeRoot(),
  verifyRestart = restart === callDesktopControl ? waitForRuntimeReplacement : async () => {},
} = {}) {
  return exclusive(async () => {
    const options = parseChangedArguments(args);
    await before();
    await prepareVersion();
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
    const workerChangedFiles = files.filter((file) => workerDeploymentFile(file)
      || file === "AgentHub/cloudflare-worker/verify-deployment.mjs");
    const steps = await withStepFingerprints(focusedSteps(plan, {
      fullTestCheckpointId,
      testContour: options.testContour,
      workerChangedFiles,
    }), files);
    try {
      await runPublicationSteps(steps, {
        run,
        checkpoint,
        checkpointScope: {
          mode: "changed",
          from,
          runtimeRoot,
        },
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
    prepareVersion: prepareCommittedAgentHubReleaseVersion,
  }).catch((error) => {
    console.error(`\nПубликация остановлена: ${error.message}`);
    process.exitCode = 1;
  });
}
