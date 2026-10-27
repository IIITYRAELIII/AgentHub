import { normalizeReleaseTaskIds } from "./src/domain/release-operation.mjs";
import { normalizeTestSelection, resolveTestSelection, verifyTestPlan } from "./src/domain/test-selection.mjs";
import { discoverReleaseTestInventory, RELEASE_CHECK_IDS } from "./src/infrastructure/filesystem/release-test-inventory.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { freezePreparedPublication } from "./src/composition/publication-freeze.mjs";
export { freezePreparedPublication };

import { callDesktopControl } from "./desktop-control.mjs";
import { publicationRuntimeStatus } from "./src/runtime/runtime-publication-start.mjs";
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
import { assertReleaseCloneForPublication } from "./src/infrastructure/filesystem/release-git-workspace.mjs";
import { withPublicationLock } from "./src/infrastructure/process/publication-lock.mjs";
import { runPublicationSteps } from "./src/infrastructure/persistence/publication-checkpoint.mjs";
import { completePublication } from "./src/infrastructure/persistence/publication-completion.mjs";
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

function invocationRepositoryRoot() {
  const cwd = path.resolve(process.cwd());
  return path.basename(cwd).toLowerCase() === "agenthub" ? path.dirname(cwd) : cwd;
}

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

export function focusedSteps(plan, {
  fullTestCheckpointId = "",
  testContour = false,
  workerChangedFiles = null,
  quick = false,
  visualTests = false,
  testPlan = null,
} = {}) {
  if (testPlan != null) return selectedPublicationSteps(plan, testPlan, { fullTestCheckpointId, workerChangedFiles });
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

export function selectedPublicationSteps(plan, testPlan, { fullTestCheckpointId = "", workerChangedFiles = null } = {}) {
  verifyTestPlan(testPlan);
  const selected = new Set(testPlan.selectedIds);
  const files = testPlan.selectedIds.filter(id => !RELEASE_CHECK_IDS.includes(id));
  const checks = [];
  if (selected.has("check:release-candidate")) checks.push(npmStep(RELEASE_CANDIDATE_CONTOUR_LABEL,
    ["run", "contour:verify", "--", "--require-installed", "--release-candidate"]));
  if (selected.has("check:contour")) checks.push(npmStep("Тестовый контур Agent Hub", ["run", "contour:verify", "--", "--require-installed"]));
  if (files.length) checks.push({ label: "Выбранные тесты Agent Hub", command: process.execPath,
    args: ["test-suite.mjs", "selected", `--selection=${JSON.stringify({ mode: "include", ids: files })}`],
    timeoutMs: null, idleTimeoutMs: 10 * 60 * 1000,
    env: { AGENT_HUB_FULL_TEST_CHECKPOINT_ID: `${fullTestCheckpointId}:selection:${testPlan.identitySha256}` } });
  const deployment = focusedSteps({ ...plan, fullTests: false }, { quick: true, workerChangedFiles })
    .filter(step => step.label !== "Проверка синтаксиса Agent Hub"
      && (step.label !== "Проверка Mini App Worker" || selected.has("check:worker")));
  // Explicit worker verification is a selected check even on an unchanged worker.
  if (selected.has("check:worker") && !deployment.some(step => step.label === "Проверка Mini App Worker")) {
    deployment.push(npmStep("Проверка Mini App Worker", ["run", "worker:verify"]));
  }
  return [...checks, ...deployment];
}

export function needsVisualPublicationTests(files) {
  return files.some((raw) => {
    const file = raw.replaceAll("\\", "/");
    return file.startsWith("AgentHub/assets/web-app/") || file.startsWith("AgentHub/VSCodeExtension/")
      || ["AgentHub/theme-registry.cjs", "AgentHub/client-assets.cjs", "AgentHub/work-log.css",
        "AgentHub/src/application/work-log-usage-projection.mjs"].includes(file);
  });
}

async function contentFingerprint(namespace, files, repositoryRoot = REPOSITORY_ROOT) {
  const hash = createHash("sha256").update(`publication-step-v1\0${namespace}\0`);
  for (const file of files.toSorted()) {
    hash.update(file).update("\0");
    try {
      hash.update(await readFile(path.resolve(repositoryRoot, file)));
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

async function withStepFingerprints(steps, files, repositoryRoot = REPOSITORY_ROOT) {
  return Promise.all(steps.map(async (step) => ({
    ...step,
    fingerprint: await contentFingerprint(
      JSON.stringify({ label: step.label, command: step.command, args: step.args, env: step.env ?? {} }),
      filesForStep(step.label, files),
      repositoryRoot,
    ),
  })));
}

export function parseChangedArguments(args, { requireOperationId = false } = {}) {
  let from = "";
  let skipRestart = false;
  let fullTests = false;
  let testContour = false;
  let quick = false;
  let resume = false;
  let status = false;
  let operationId = "";
  let workspaceId = "";
  let streamId = "";
  let threadId = "";
  let testSelection = null;
  let testPlan = null;
  let taskIds = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--skip-restart") skipRestart = true;
    else if (args[index] === "--full-tests") fullTests = true;
    else if (args[index] === "--test-contour") testContour = true;
    else if (args[index] === "--quick" || args[index] === "--validation=quick") quick = true;
    else if (args[index] === "--validation=full") fullTests = true;
    else if (args[index].startsWith("--task-ids=")) taskIds = normalizeReleaseTaskIds(JSON.parse(args[index].slice(11)));
    else if (args[index] === "--validation=none") testSelection = normalizeTestSelection({ mode: "none", ids: [] });
    else if (args[index].startsWith("--test-selection=")) testSelection = normalizeTestSelection(JSON.parse(args[index].slice(17)));
    else if (args[index].startsWith("--test-plan=")) testPlan = verifyTestPlan(JSON.parse(args[index].slice(12)));
    else if (args[index] === "--validation=focused") { /* default validation */ }
    else if (args[index] === "--resume") resume = true;
    else if (args[index] === "--status") status = true;
    else if (args[index] === "--operation" && args[index + 1]) operationId = args[++index];
    else if (args[index] === "--workspace" && args[index + 1]) workspaceId = args[++index];
    else if (args[index] === "--stream" && args[index + 1]) streamId = args[++index];
    else if (args[index] === "--thread" && args[index + 1]) threadId = args[++index];
    else if (args[index] === "--bootstrap-mcp-context") {
      throw new Error("--bootstrap-mcp-context is obsolete; publication reads the release plan from the candidate runtime");
    }
    else if (args[index] === "--from" && args[index + 1]) from = args[++index];
    else throw new Error(`Неизвестный аргумент: ${args[index]}`);
  }
  if ((testSelection || testPlan) && (quick || fullTests || testContour) || testSelection && testPlan) throw new Error("Choose one explicit test policy");
  if (quick && fullTests) throw new Error("Choose either quick or full validation");
  if (resume && status) throw new Error("Choose either --resume or --status");
  if (requireOperationId && (resume || status) && !operationId) {
    throw new Error("--resume and --status require the original --operation id");
  }
  if (operationId && !resume && !status) throw new Error("--operation requires --resume or --status");
  return { from, skipRestart, fullTests, testContour, quick, resume, status, operationId,
    workspaceId, streamId, threadId, ...(taskIds ? { taskIds } : {}), ...(testSelection ? { testSelection } : {}), ...(testPlan ? { testPlan } : {}) };
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
  repositoryRoot = process.cwd(),
  deploymentProfile = "installed-runtime",
} = {}) {
  if (!["installed-runtime", "github-release"].includes(deploymentProfile)) throw new Error("Unsupported publication deployment profile");
  const publicationRoot = path.resolve(repositoryRoot);
  return exclusive(async () => {
    const options = parseChangedArguments(args);
    const inventory = options.testPlan || options.testSelection ? await discoverReleaseTestInventory(path.join(publicationRoot, "AgentHub")) : null;
    let testPlan = options.testPlan ? verifyTestPlan(options.testPlan, inventory)
      : options.testSelection ? resolveTestSelection(options.testSelection, inventory) : null;
    // Finalization may synchronize repository refs before its reply reaches the
    // publisher. Explicit resume owns the saved run and must not prepare or
    // deploy another candidate.
    const pending = options.resume ? await journal?.read?.() : null;
    if (pending && (pending.identity?.deploymentProfile ?? "installed-runtime") !== deploymentProfile) {
      throw new Error("Resume deployment profile differs from the original publication");
    }
    if (pending?.progress?.publicationState) {
      const identity = pending.identity;
      if (!testPlan && identity.testPlan) testPlan = verifyTestPlan(identity.testPlan, await discoverReleaseTestInventory(path.join(publicationRoot, "AgentHub")));
      if (JSON.stringify(testPlan) !== JSON.stringify(identity.testPlan ?? null)) throw new Error("Resume test selection differs from saved publication");
      if (identity?.worktreeRoot !== publicationRoot || identity?.runtimeRoot !== runtimeRoot) {
        throw new Error("No matching publication candidate to resume");
      }
      if (options.from && options.from !== identity.from) throw new Error("Resume source revision differs from the saved publication");
      const explicitMode = args.some((arg) => arg === "--full-tests" || arg === "--quick" || arg.startsWith("--validation="));
      const requestedMode = testPlan ? testPlan.selection.mode : options.fullTests ? "full" : options.quick ? "quick" : "focused";
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
    const head = await revision({ cwd: publicationRoot });
    const saved = await journal?.read?.() ?? await checkpoint?.read?.();
    const savedIdentity = saved?.identity;
    const sameCandidate = savedIdentity?.revision === head && savedIdentity?.worktreeRoot === publicationRoot
      && savedIdentity?.runtimeRoot === runtimeRoot;
    if (sameCandidate && (savedIdentity.deploymentProfile ?? "installed-runtime") !== deploymentProfile) {
      throw new Error("Candidate deployment profile differs from the original publication");
    }
    if (options.resume && !sameCandidate) throw new Error("No matching publication candidate to resume");
    if (options.resume && options.from && options.from !== savedIdentity.from) {
      throw new Error("Resume source revision differs from the saved publication");
    }
    if (sameCandidate && !testPlan && !options.testSelection && !args.some(arg => arg === "--full-tests" || arg === "--quick" || arg.startsWith("--validation=")) && savedIdentity.testPlan) {
      testPlan = verifyTestPlan(savedIdentity.testPlan, await discoverReleaseTestInventory(path.join(publicationRoot, "AgentHub")));
    }
    if (options.resume && JSON.stringify(testPlan) !== JSON.stringify(savedIdentity.testPlan ?? null)) throw new Error("Resume test selection differs from saved publication");
    if (sameCandidate && !options.workspaceId) options.workspaceId = savedIdentity.workspaceId ?? "";
    const explicitValidation = args.some((arg) => arg === "--full-tests" || arg === "--quick" || arg.startsWith("--validation="));
    if (sameCandidate && !testPlan && !explicitValidation && savedIdentity.validationMode) {
      options.fullTests = savedIdentity.validationMode === "full";
      options.quick = savedIdentity.validationMode === "quick";
      options.testContour ||= savedIdentity.testContour === true;
    }
    const state = await readState();
    const requestedMode = testPlan ? testPlan.selection.mode : options.fullTests ? "full" : options.quick ? "quick" : "focused";
    if (sameCandidate && ["succeeded", "published"].includes(saved.status)
      && state?.revision === head && savedIdentity.validationMode === requestedMode
      && JSON.stringify(savedIdentity.testPlan ?? null) === JSON.stringify(testPlan)
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
    const files = await diff(from, { cwd: publicationRoot });
    const plan = classifyPublicationChanges(files);
    if (deploymentProfile === "github-release") {
      // The explicit approved distribution target prepares a runtime for its
      // archive. It never installs/restarts the publisher or deploys providers.
      Object.assign(plan, { runtime: true, runtimeRestart: false, worker: false, android: false, vscode: false });
    }
    if (!testPlan && options.fullTests) plan.fullTests = true;
    if (!testPlan && plan.unknown.length && !options.quick) plan.fullTests = true;
    if (!testPlan && plan.unknown.length) console.warn(`Неизвестные пути требуют публикации всех компонентов${options.quick ? " с выбранной quick-проверкой" : " с полными тестами"}: ${plan.unknown.join(", ")}`);
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
      testPlan,
    }), files, publicationRoot);
    const candidateRoot = path.join(publicationRoot, "AgentHub");
    steps = steps.map((step) => ({ ...step, cwd: step.cwd ?? candidateRoot }));
    const identity = {
      mode: "changed", from, revision: head, worktreeRoot: publicationRoot, runtimeRoot, files,
      validationMode: testPlan ? testPlan.selection.mode : plan.fullTests ? "full" : options.quick ? "quick" : "focused",
      ...(testPlan ? { testPlan } : {}),
      testContour: options.testContour,
      workspaceId: options.workspaceId,
      labels: steps.map((step) => step.label),
      ...(deploymentProfile === "github-release" ? { deploymentProfile } : {}),
    };
    steps = await prepareArtifactSteps(steps, identity);
    identity.labels = steps.map((step) => step.label);
    if (publishGit) {
      const firstDeployment = steps.findIndex((step) => ["Сборка runtime-релиза", "Установка runtime-релиза", "Развёртывание Mini App Worker", "Активация runtime-релиза", "Установка расширения VS Code", "Публикация GitHub Release"].includes(step.label));
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
      && JSON.stringify(savedIdentity.testPlan ?? null) === JSON.stringify(testPlan)
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
          ...(testPlan ? { testPlan } : {}),
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
          ...(testPlan ? { testPlan } : {}),
        },
        journal, checkpoint, needsRestart: plan.runtimeRestart, skipRestart: options.skipRestart,
        readRuntimeStatus, verifyRestart, writeState, finalizePublication,
        requestRestart: (verification) => restartRuntimeAndVerify(restart, verifyRestart, runtimeRoot, verification),
      });
      console.log(`\nПубликация: ${completion.status}; ${files.length} изменённых файлов.`);
      if (completion.handoff?.action === "yield_current_turn") {
        console.log("Safe restart подготовлен: завершите текущий агентский ход без новых операций.");
      }
      return { files, plan, revision: head, ...(testPlan ? { testPlan } : {}), ...completion };
    } catch (error) {
      await journal?.finish("failed", error);
      throw error;
    }
  });
}

export async function runReleaseOperationCli(args = process.argv.slice(2), {
  repositoryRoot = invocationRepositoryRoot(),
  runtimeRoot = defaultRuntimeRoot(),
  control = callDesktopControl,
  read = readFile,
  assertClone = assertReleaseCloneForPublication,
  wait = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)),
  pollMs = 1_000,
} = {}) {
  const options = parseChangedArguments(args, { requireOperationId: true });
  if (options.taskIds && !options.resume) throw new Error("Task membership amendment addresses an original operation with --resume");
  if (options.testPlan) throw new Error("Frozen test plan belongs to the generation runner; use --test-selection");
  if (options.skipRestart || options.testContour) {
    throw new Error("ReleaseOperation owns restart and contour policy; legacy publication overrides are not supported");
  }
  const root = path.resolve(repositoryRoot);
  const marker = await assertClone({ repositoryRoot: root });
  if (options.resume || options.status) {
    const snapshot = await control("release-operation-get", { operationId: options.operationId }, { runtimeRoot });
    const operation = snapshot?.operation;
    if (!operation || operation.operationId !== options.operationId) {
      throw new Error("release operation readback identity changed");
    }
    const publicationTarget = operation.authorization?.approvedTargets?.find((target) => (
      target.kind === "agent-hub-publication"
      && path.resolve(String(target.repositoryRoot ?? "")) === path.resolve(marker.primaryRoot)
    ));
    if (!publicationTarget || (options.workspaceId && operation.workspaceId !== options.workspaceId)
      || (options.streamId && operation.streamId !== options.streamId)
      || (options.threadId && operation.threadId !== options.threadId)) {
      throw new Error("release operation does not belong to this release clone or initiator");
    }
    if (options.status || operation.state === "done") return snapshot;
    if (operation.state === "failed" && !options.testSelection && !options.taskIds) {
      const error = new Error(operation.lastError?.message ?? "release operation failed");
      error.code = operation.lastError?.code ?? "RELEASE_OPERATION_FAILED";
      throw error;
    }
    const amendment = options.testSelection || options.taskIds ? {
      ...(options.testSelection ? { testSelection: options.testSelection } : {}),
      ...(options.taskIds ? { taskIds: options.taskIds } : {}), expectedRevision: operation.revision, expectedGeneration: operation.currentGeneration,
      requestId: `release-tests-${createHash("sha256").update(JSON.stringify({ operationId: operation.operationId, revision: operation.revision,
        generation: operation.currentGeneration, selection: options.testSelection ?? null, taskIds: options.taskIds ?? null })).digest("hex")}`,
    } : {};
    const continued = await control("release-operation-continue", { operationId: options.operationId, ...amendment }, { runtimeRoot, ...(amendment.requestId ? { commandId: amendment.requestId } : {}) });
    if (continued?.accepted === false) throw new Error(`Release continuation refused: ${continued.reason}`);
    let lastRevision = -1;
    for (;;) {
      const current = await control("release-operation-get", { operationId: options.operationId }, { runtimeRoot });
      const value = current?.operation;
      if (!value || value.operationId !== options.operationId) {
        throw new Error("release operation readback identity changed");
      }
      if (value.revision !== lastRevision) {
        console.log(`Release operation ${options.operationId}: ${value.state}${value.currentStep ? `/${value.currentStep}` : ""}`);
        lastRevision = value.revision;
      }
      if (value.state === "done") return current;
      if (value.state === "failed") {
        const error = new Error(value.lastError?.message ?? "release operation failed");
        error.code = value.lastError?.code ?? "RELEASE_OPERATION_FAILED";
        throw error;
      }
      await wait(Math.max(100, Number(pollMs) || 1_000));
    }
  }
  const checkpoint = JSON.parse(await read(path.join(root, "..", "checkpoint.json"), "utf8"));
  if (!/^[a-f0-9]{64}$/u.test(String(checkpoint.manifestHash ?? ""))) {
    throw new Error("prepared release manifest is missing");
  }
  const manifest = JSON.parse(await read(
    path.join(root, "..", "evidence", `${checkpoint.manifestHash}.json`),
    "utf8",
  ));
  const workspaceId = String(options.workspaceId || manifest.workspaceId || "").trim();
  if (!workspaceId) throw new Error("release operation requires its Workspace");
  const streamId = String(options.streamId || "").trim();
  const threadId = String(options.threadId || "").trim();
  if (!streamId || !threadId) throw new Error("release operation requires --stream and --thread initiator identity");
  if (options.from && options.from !== manifest.baseCommit) {
    throw new Error("release operation source revision differs from the prepared candidate");
  }
  const taskIds = [...new Set((manifest.tasks ?? []).map((task) => String(task?.taskId ?? "").trim()))]
    .filter(Boolean).sort();
  if (!taskIds.length) throw new Error("prepared release has no selected Tasks");
  const target = {
    targetId: `agent-hub-publication-${createHash("sha256").update(path.resolve(marker.primaryRoot)).digest("hex").slice(0, 16)}`,
    kind: "agent-hub-publication",
    repositoryRoot: marker.primaryRoot,
    ...(manifest.baseProvenance?.approvedLocalMainCommit
      ? { approvedLocalMainCommit: manifest.baseProvenance.approvedLocalMainCommit } : {}),
    ...(manifest.baseProvenance?.approvedOriginMainCommit
      ? { approvedOriginMainCommit: manifest.baseProvenance.approvedOriginMainCommit } : {}),
  };
  const validationMode = options.fullTests ? "full" : options.quick ? "quick" : "focused";
  const changelogBytes = await read(path.join(root, "CHANGELOG.md"));
  const changelogBuffer = Buffer.isBuffer(changelogBytes) ? changelogBytes : Buffer.from(changelogBytes);
  const releaseMetadata = {
    sourcePath: path.join(root, "CHANGELOG.md"),
    byteLength: changelogBuffer.length,
    rawSha256: createHash("sha256").update(changelogBuffer).digest("hex"),
    canonicalSha256: createHash("sha256").update(changelogBuffer.toString("utf8").replace(/\r\n/gu, "\n")).digest("hex"),
  };
  const requestIdentity = {
    workspaceId, streamId, threadId,
    planRevision: manifest.planRevision,
    taskIds,
    target,
    validationMode,
    releaseMetadata,
    ...(options.testSelection ? { testSelection: options.testSelection } : {}),
  };
  const requestId = `release-cli-${createHash("sha256").update(JSON.stringify(requestIdentity)).digest("hex")}`;
  const acknowledgement = await control("release-operation-run", {
    requestId, workspaceId, streamId, threadId, taskIds, approvedTargets: [target], validationMode, releaseMetadata,
    ...(options.testSelection ? { testSelection: options.testSelection } : {}),
  }, { runtimeRoot, commandId: requestId });
  const operationId = String(acknowledgement?.operationId ?? "").trim();
  if (!operationId) throw new Error("release operation acknowledgement has no operation id");
  let lastRevision = -1;
  for (;;) {
    const snapshot = await control("release-operation-get", { operationId }, { runtimeRoot });
    const operation = snapshot?.operation;
    if (!operation || operation.operationId !== operationId) {
      throw new Error("release operation readback identity changed");
    }
    if (operation.revision !== lastRevision) {
      console.log(`Release operation ${operationId}: ${operation.state}${operation.currentStep ? `/${operation.currentStep}` : ""}`);
      lastRevision = operation.revision;
    }
    if (operation.state === "done") return snapshot;
    if (operation.state === "failed") {
      const error = new Error(operation.lastError?.message ?? "release operation failed");
      error.code = operation.lastError?.code ?? "RELEASE_OPERATION_FAILED";
      throw error;
    }
    await wait(Math.max(100, Number(pollMs) || 1_000));
  }
}

const invokedFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedFile === fileURLToPath(import.meta.url)) {
  runReleaseOperationCli(process.argv.slice(2)).catch((error) => {
    console.error(`\nПубликация остановлена: ${error.message}`);
    process.exitCode = 1;
  });
}
