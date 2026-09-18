import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { callDesktopControl } from "./desktop-control.mjs";
import { publicationRuntimeStatus } from "./src/runtime/runtime-publication-start.mjs";
import { prepareRuntime, installPreparedRuntime, verifyInstalledRuntime } from "./src/runtime/runtime-manager.mjs";
import {
  npmStep,
  publicationRepositories,
  publicationSteps,
  restartRuntimeAndVerify,
  runStep,
  waitForRuntimeReplacement,
} from "./publish-all.mjs";
import { ensureWrangler } from "./wrangler-runner.mjs";
import { defaultRuntimeRoot } from "./src/infrastructure/filesystem/runtime-layout.mjs";
import { prepareCommittedAgentHubReleaseVersion } from "./src/infrastructure/filesystem/release-version.mjs";
import { assertReleaseCloneForPublication, ReleaseGitWorkspaceService } from "./src/infrastructure/filesystem/release-git-workspace.mjs";
import { withPublicationLock } from "./src/infrastructure/process/publication-lock.mjs";
import { createFrozenReleasePublication } from "./src/infrastructure/process/frozen-release-publication.mjs";
import { readCandidatePublicationReleasePlan } from "./src/composition/publication-release-plan-composition.mjs";
import {
  publicationCheckpointStore,
  runPublicationSteps,
} from "./src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "./src/infrastructure/persistence/publication-run-store.mjs";
import { completePublication } from "./src/infrastructure/persistence/publication-completion.mjs";
import { createPublicationArtifactSteps } from "./src/infrastructure/process/publication-artifacts.mjs";
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
  quick = false,
  visualTests = false,
} = {}) {
  const releaseCandidateContour = plan.fullTests;
  const full = publicationSteps({
    skipTests: quick && plan.unknown.length > 0,
    skipWorker: plan.unknown.length ? false : !plan.worker,
    fullTestCheckpointId,
    testContour: testContour && !releaseCandidateContour,
    workerChangedFiles,
  });
  if (releaseCandidateContour) {
    const fullTestIndex = full.findIndex((step) => step.label === "Полные тесты Agent Hub");
    full.splice(fullTestIndex < 0 ? 0 : fullTestIndex, 0, npmStep(
      RELEASE_CANDIDATE_CONTOUR_LABEL,
      ["run", "contour:verify", "--", "--require-installed", "--release-candidate"],
    ));
  }
  if (plan.unknown.length) return quick
    ? [npmStep("Проверка синтаксиса Agent Hub", ["run", "check"]), ...full]
    : full;

  const byLabel = new Map(full.map((step) => [step.label, step]));
  const steps = [];
  if (plan.fullTests) {
    steps.push(byLabel.get(RELEASE_CANDIDATE_CONTOUR_LABEL));
    steps.push(byLabel.get("Полные тесты Agent Hub"));
  } else {
    steps.push(npmStep("Проверка синтаксиса Agent Hub", ["run", "check"]));
    if (!quick && plan.unitTests) {
      steps.push(npmStep("Unit-тесты Agent Hub", ["test"]));
    } else if (!quick && (plan.runtime || plan.worker)) {
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
    if (!quick && visualTests) steps.push(npmStep("Визуальные матрицы UI Agent Hub", ["run", "test:visual"]));
    if (!quick && plan.surfaceTests) {
      steps.push(npmStep("Межповерхностные E2E Agent Hub", ["run", "test:e2e"]));
    }
  }
  if (!quick && !plan.fullTests && (plan.vscode || plan.runtime)) {
    steps.push(npmStep("Тесты расширения VS Code", ["test", "--prefix", "VSCodeExtension"]));
  }
  if (testContour) steps.push(byLabel.get("Тестовый контур Agent Hub"));
  if (plan.android) steps.push(byLabel.get("Сборка Agent Hub Mobile"));
  if (plan.runtime) steps.push(byLabel.get("Сборка runtime-релиза"));
  if (plan.worker) {
    steps.push(byLabel.get("Развёртывание Mini App Worker"));
    steps.push(byLabel.get("Проверка Mini App Worker"));
  }
  if (plan.runtime) steps.push(byLabel.get("Активация runtime-релиза"));
  if (plan.vscode) steps.push(byLabel.get("Установка расширения VS Code"));
  return steps.filter(Boolean);
}

export function needsVisualPublicationTests(files) {
  return files.some((raw) => {
    const file = raw.replaceAll("\\", "/");
    return file.startsWith("AgentHub/assets/web-app/") || file.startsWith("AgentHub/VSCodeExtension/")
      || ["AgentHub/theme-registry.cjs", "AgentHub/client-assets.cjs", "AgentHub/work-log.css",
        "AgentHub/src/application/work-log-usage-projection.mjs"].includes(file);
  });
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
  let quick = false;
  let resume = false;
  let workspaceId = "";
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--skip-restart") skipRestart = true;
    else if (args[index] === "--full-tests") fullTests = true;
    else if (args[index] === "--test-contour") testContour = true;
    else if (args[index] === "--quick" || args[index] === "--validation=quick") quick = true;
    else if (args[index] === "--validation=full") fullTests = true;
    else if (args[index] === "--validation=focused") { /* default validation */ }
    else if (args[index] === "--resume") resume = true;
    else if (args[index] === "--workspace" && args[index + 1]) workspaceId = args[++index];
    else if (args[index] === "--bootstrap-mcp-context") {
      throw new Error("--bootstrap-mcp-context is obsolete; publication reads the release plan from the candidate runtime");
    }
    else if (args[index] === "--from" && args[index + 1]) from = args[++index];
    else throw new Error(`Неизвестный аргумент: ${args[index]}`);
  }
  if (quick && fullTests) throw new Error("Choose either quick or full validation");
  return { from, skipRestart, fullTests, testContour, quick, resume, workspaceId };
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
  readRuntimeStatus = publicationRuntimeStatus,
  publishGit = null,
  finalizePublication = null,
  preparePublication = null,
  prepareArtifactSteps = async (steps) => steps,
  verifyArtifacts = async () => {},
} = {}) {
  return exclusive(async () => {
    const options = parseChangedArguments(args);
    // Finalization may synchronize repository refs before its reply reaches the
    // publisher. Explicit resume owns the saved run and must not prepare or
    // deploy another candidate.
    const pending = options.resume ? await journal?.read?.() : null;
    if (pending?.progress?.publicationState) {
      const identity = pending.identity;
      if (identity?.worktreeRoot !== REPOSITORY_ROOT || identity?.runtimeRoot !== runtimeRoot) {
        throw new Error("No matching publication candidate to resume");
      }
      if (options.from && options.from !== identity.from) throw new Error("Resume source revision differs from the saved publication");
      const explicitMode = args.some((arg) => arg === "--full-tests" || arg === "--quick" || arg.startsWith("--validation="));
      const requestedMode = options.fullTests ? "full" : options.quick ? "quick" : "focused";
      if ((explicitMode && requestedMode !== identity.validationMode)
        || (options.workspaceId && options.workspaceId !== identity.workspaceId)
        || (options.testContour && !identity.testContour)) {
        throw new Error("Resume options differ from the saved publication");
      }
      if (preparePublication) await preparePublication(identity, { completionOnly: true });
      if (["succeeded", "published"].includes(pending.status)) {
        await verifyArtifacts(identity);
        const recorded = await readState();
        if (recorded?.revision !== identity.revision
          || recorded?.generation !== pending.progress.publicationState.generation) {
          throw new Error("Recorded publication changed after completion");
        }
        if (pending.progress.expectedReleaseId) {
          await verifyRestart({ runtimeRoot, expectedReleaseId: pending.progress.expectedReleaseId, readStatus: readRuntimeStatus });
        }
        return { status: pending.status, revision: identity.revision, files: identity.files,
          plan: recorded.plan, alreadyCompleted: true, publicationOnly: pending.status === "published" };
      }
      if (!["running", "failed", "awaiting_restart", "awaiting_finalization"].includes(pending.status)) {
        throw new Error("Publication does not have a resumable completion");
      }
      if (identity.release && !finalizePublication) throw new Error("Pending Workspace release requires its finalization adapter");
      await journal.start(identity, []);
      try {
        await verifyArtifacts(identity);
        const completion = await completePublication({
          identity, publicationState: pending.progress.publicationState,
          journal, checkpoint, needsRestart: Boolean(pending.progress.publicationState.plan?.runtimeRestart),
          skipRestart: options.skipRestart, readRuntimeStatus, verifyRestart, writeState, finalizePublication,
          requestRestart: (verification) => restartRuntimeAndVerify(restart, verifyRestart, runtimeRoot, verification),
        });
        return { revision: identity.revision, files: identity.files, plan: pending.progress.publicationState.plan, ...completion };
      } catch (error) {
        await journal.finish("failed", error);
        throw error;
      }
    }
    await before();
    await prepareVersion();
    const head = await revision({ cwd: REPOSITORY_ROOT });
    const saved = await journal?.read?.() ?? await checkpoint?.read?.();
    const savedIdentity = saved?.identity;
    const sameCandidate = savedIdentity?.revision === head && savedIdentity?.worktreeRoot === REPOSITORY_ROOT
      && savedIdentity?.runtimeRoot === runtimeRoot;
    if (options.resume && !sameCandidate) throw new Error("No matching publication candidate to resume");
    if (options.resume && options.from && options.from !== savedIdentity.from) {
      throw new Error("Resume source revision differs from the saved publication");
    }
    if (sameCandidate && !options.workspaceId) options.workspaceId = savedIdentity.workspaceId ?? "";
    const explicitValidation = args.some((arg) => arg === "--full-tests" || arg === "--quick" || arg.startsWith("--validation="));
    if (sameCandidate && !explicitValidation && savedIdentity.validationMode) {
      options.fullTests = savedIdentity.validationMode === "full";
      options.quick = savedIdentity.validationMode === "quick";
      options.testContour ||= savedIdentity.testContour === true;
    }
    const state = await readState();
    const requestedMode = options.fullTests ? "full" : options.quick ? "quick" : "focused";
    if (sameCandidate && ["succeeded", "published"].includes(saved.status)
      && state?.revision === head && savedIdentity.validationMode === requestedMode
      && savedIdentity.workspaceId === options.workspaceId
      && savedIdentity.testContour === options.testContour
      && (!options.from || options.from === savedIdentity.from)) {
      await verifyArtifacts(savedIdentity);
      if (saved.progress?.expectedReleaseId) {
        await verifyRestart({ runtimeRoot, expectedReleaseId: saved.progress.expectedReleaseId, readStatus: readRuntimeStatus });
      }
      return { status: saved.status, revision: head, files: savedIdentity.files ?? [],
        plan: state.plan, alreadyCompleted: true, publicationOnly: saved.status === "published" };
    }
    const from = options.from || (sameCandidate ? savedIdentity.from : null) || state?.revision;
    if (!from) throw new Error("Нет исходной точки публикации. Сначала выполните npm run publish:all или укажите --from <commit>.");
    const files = await diff(from, { cwd: REPOSITORY_ROOT });
    const plan = classifyPublicationChanges(files);
    if (options.fullTests) plan.fullTests = true;
    if (plan.unknown.length && !options.quick) plan.fullTests = true;
    if (plan.unknown.length) console.warn(`Неизвестные пути требуют публикации всех компонентов${options.quick ? " с выбранной quick-проверкой" : " с полными тестами"}: ${plan.unknown.join(", ")}`);
    if (plan.worker) await ensureWorkerDependency();
    const fullTestCheckpointId = createHash("sha256")
      .update(JSON.stringify({ mode: "changed", from }))
      .digest("hex");
    const workerChangedFiles = files.filter((file) => workerDeploymentFile(file)
      || file === "AgentHub/cloudflare-worker/verify-deployment.mjs");
    let steps = await withStepFingerprints(focusedSteps(plan, {
      fullTestCheckpointId,
      testContour: options.testContour,
      workerChangedFiles,
      quick: options.quick,
      visualTests: needsVisualPublicationTests(files),
    }), files);
    const identity = {
      mode: "changed", from, revision: head, worktreeRoot: REPOSITORY_ROOT, runtimeRoot, files,
      validationMode: plan.fullTests ? "full" : options.quick ? "quick" : "focused",
      testContour: options.testContour,
      workspaceId: options.workspaceId,
      labels: steps.map((step) => step.label),
    };
    steps = await prepareArtifactSteps(steps, identity);
    identity.labels = steps.map((step) => step.label);
    if (publishGit) {
      const firstDeployment = steps.findIndex((step) => ["Сборка runtime-релиза", "Установка runtime-релиза", "Развёртывание Mini App Worker", "Активация runtime-релиза", "Установка расширения VS Code"].includes(step.label));
      steps.splice(firstDeployment < 0 ? steps.length : firstDeployment, 0, {
        label: "Публикация Git", reusable: false, execute: () => publishGit(identity),
      });
      identity.labels = steps.map((step) => step.label);
    }
    if (sameCandidate && savedIdentity.release) identity.release = savedIdentity.release;
    const completionOnly = sameCandidate && Boolean(saved.progress?.publicationState)
      && savedIdentity.from === identity.from
      && JSON.stringify(savedIdentity.files) === JSON.stringify(identity.files)
      && JSON.stringify(savedIdentity.labels) === JSON.stringify(identity.labels)
      && savedIdentity.validationMode === identity.validationMode
      && savedIdentity.workspaceId === identity.workspaceId
      && savedIdentity.testContour === identity.testContour;
    if (preparePublication) identity.release = await preparePublication(identity, {
      completionOnly,
    });
    try {
      if (completionOnly) await journal?.start(identity, steps);
      else await runPublicationSteps(steps, {
        run: (step) => step.execute ? step.execute() : run(step),
        checkpoint,
        checkpointScope: {
          mode: "changed",
          from,
          runtimeRoot,
          validationMode: identity.validationMode,
        },
        identity,
        journal,
      });
      await verifyArtifacts(identity);
      const completion = await completePublication({
        identity, publicationState: {
          revision: head,
          repositories: publicationRepositories(identity, head),
          files,
          plan,
          validationMode: identity.validationMode,
        },
        journal, checkpoint, needsRestart: plan.runtimeRestart, skipRestart: options.skipRestart,
        readRuntimeStatus, verifyRestart, writeState, finalizePublication,
        requestRestart: (verification) => restartRuntimeAndVerify(restart, verifyRestart, runtimeRoot, verification),
      });
      console.log(`\nПубликация: ${completion.status}; ${files.length} изменённых файлов.`);
      if (completion.handoff?.action === "yield_current_turn") {
        console.log("Safe restart подготовлен: завершите текущий агентский ход без новых операций.");
      }
      return { files, plan, revision: head, ...completion };
    } catch (error) {
      await journal?.finish("failed", error);
      throw error;
    }
  });
}

export async function freezePreparedPublication({
  workspaceId = "",
  repositoryRoot = REPOSITORY_ROOT,
  readPlan = readCandidatePublicationReleasePlan,
  read = readFile,
  assertClone = assertReleaseCloneForPublication,
  assertCleanTree = assertCleanPublicationTree,
  assertCurrentRevision = assertCurrentPublicationRevision,
  createReleaseWorkspace = (options) => new ReleaseGitWorkspaceService(options),
} = {}) {
  const marker = await assertClone({ repositoryRoot });
  const checkpoint = JSON.parse(await read(path.join(repositoryRoot, "..", "checkpoint.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/u.test(checkpoint.manifestHash ?? "")) throw new Error("invalid prepared manifest hash");
  const manifest = JSON.parse(await read(
    path.join(repositoryRoot, "..", "evidence", `${checkpoint.manifestHash}.json`),
    "utf8",
  ));
  const selectedWorkspace = String(workspaceId || manifest.workspaceId || "").trim();
  if (!selectedWorkspace) throw new Error("publication freeze requires its Workspace");
  const changelogContent = await read(path.join(repositoryRoot, "CHANGELOG.md")).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  const releaseWorkspace = createReleaseWorkspace({ dataDir: path.dirname(marker.managedRoot) });
  const frozen = await releaseWorkspace.freezePublicationCandidate({
    projectRoot: marker.primaryRoot, workspaceId: selectedWorkspace,
    expectedPlanRevision: checkpoint.planRevision, expectedPreparedHead: checkpoint.preReleaseHead,
    changelogContent,
    validateBeforeCommit: async () => {
      const plan = await readPlan(selectedWorkspace);
      if (plan.revision !== checkpoint.planRevision) {
        throw new Error("release plan changed before publication freeze");
      }
    },
  });
  const frozenManifest = JSON.parse(await read(frozen.manifestFile, "utf8"));
  const releaseVersion = String(frozenManifest.publication?.releaseVersion ?? "");
  if (!releaseVersion) throw new Error("frozen release version is missing from the immutable manifest");
  await assertCleanTree({ cwd: repositoryRoot });
  await assertCurrentRevision({ cwd: repositoryRoot });
  return releaseVersion;
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  let frozenReleaseVersion = "";
  const control = callDesktopControl;
  const readPlan = (workspaceId) => readCandidatePublicationReleasePlan(workspaceId);
  const adapter = createFrozenReleasePublication({
    repositoryRoot: REPOSITORY_ROOT, runtimeRoot: defaultRuntimeRoot(), control, readPlan,
  });
  const journal = publicationRunStore();
  const artifacts = createPublicationArtifactSteps({
    sourceRoot: ROOT,
    runtimeRoot: defaultRuntimeRoot(),
    journal,
    run: runStep,
    prepareRuntimeImpl: prepareRuntime,
    installRuntimeImpl: installPreparedRuntime,
    verifyRuntimeImpl: verifyInstalledRuntime,
  });
  publishChanged(process.argv.slice(2), {
    preparePublication: adapter.prepare,
    publishGit: adapter.publishGit,
    finalizePublication: adapter.finalizePublication,
    checkpoint: publicationCheckpointStore(),
    journal,
    prepareArtifactSteps: artifacts.steps,
    verifyArtifacts: artifacts.verify,
    before: async () => {
      frozenReleaseVersion = await freezePreparedPublication({
        workspaceId: parseChangedArguments(process.argv.slice(2)).workspaceId,
        repositoryRoot: REPOSITORY_ROOT,
        readPlan,
      });
    },
    prepareVersion: () => prepareCommittedAgentHubReleaseVersion({ expectedVersion: frozenReleaseVersion }),
  }).catch((error) => {
    console.error(`\nПубликация остановлена: ${error.message}`);
    process.exitCode = 1;
  });
}
