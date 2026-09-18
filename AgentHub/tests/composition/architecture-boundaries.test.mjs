import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { relativeModuleSpecifiers } from "../../src/infrastructure/filesystem/module-import-specifiers.mjs";
import { WorkspaceReleaseService } from "../../src/application/workspace-release-service.mjs";
import {
  isTaskBoardMutationOwner,
  isWorkspaceCatalogMutationOwner,
} from "../../src/application/sqlite-mutation-owner.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const COMPOSITION_ROOT = path.join(ROOT, "src", "composition", "agent-hub-composition.mjs");
const IGNORED_DIRECTORIES = new Set(["node_modules", "build", "dist", ".wrangler", "WIP"]);
const SOURCE_LAYERS = new Set([
  "application",
  "composition",
  "domain",
  "infrastructure",
  "interfaces",
  "ports",
  "providers",
  "runtime",
]);
const LAYER_DEPENDENCIES = new Map([
  ["domain", new Set(["domain"])],
  ["ports", new Set(["domain", "ports"])],
  ["application", new Set(["application", "domain", "ports", "legacy-root"])],
  ["providers", new Set(["application", "domain", "infrastructure", "ports", "providers", "legacy-root"])],
  ["interfaces", new Set(["application", "domain", "infrastructure", "interfaces", "ports", "legacy-root"])],
  ["runtime", new Set(["application", "domain", "infrastructure", "ports", "runtime", "legacy-root"])],
  ["infrastructure", new Set(["domain", "infrastructure", "ports", "legacy-root"])],
  ["composition", new Set([...SOURCE_LAYERS, "legacy-root", "public-root"])],
]);

async function compositionSource() {
  const directory = path.join(ROOT, "src", "composition");
  const files = (await readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".mjs"))
    .map((entry) => path.join(directory, entry.name));
  return (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
}

async function migrationInventory() {
  return JSON.parse(await readFile(path.join(ROOT, "architecture-migration-inventory.json"), "utf8"));
}

function inventoryModules(inventory) {
  return Object.values(inventory.migrationTargets).flat();
}

async function rootProductionModuleNames() {
  return (await readdir(ROOT, { withFileTypes: true }))
    .filter((entry) => (
      entry.isFile()
      && entry.name.endsWith(".mjs")
      && !entry.name.endsWith(".test.mjs")
      && !entry.name.endsWith(".e2e.test.mjs")
      && entry.name !== "syntax-check.mjs"
    ))
    .map((entry) => entry.name)
    .sort();
}

async function rootTestModuleNames() {
  return (await readdir(ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
    .map((entry) => entry.name)
    .sort();
}

async function testsOutsideMirroredTree(directory = ROOT) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(ROOT, absolute);
    if (entry.isDirectory()) {
      if (relative === "tests" || IGNORED_DIRECTORIES.has(entry.name)) continue;
      result.push(...await testsOutsideMirroredTree(absolute));
    } else if (entry.name.endsWith(".test.mjs") || entry.name.endsWith(".e2e.test.mjs")) {
      result.push(relative);
    }
  }
  return result.toSorted();
}

function sourceLayer(file) {
  const relative = path.relative(path.join(ROOT, "src"), file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return relative.split(path.sep)[0];
}

function dependencyLayer(target, inventory) {
  const layer = sourceLayer(target);
  if (layer) return layer;
  if (path.dirname(target) !== ROOT) return null;
  if (inventoryModules(inventory).includes(path.basename(target))) return "legacy-root";
  if (inventory.publicRootModules.includes(path.basename(target))) return "public-root";
  return null;
}

async function productionModules(directory = ROOT) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) result.push(...await productionModules(path.join(directory, entry.name)));
    } else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".test.mjs")) {
      result.push(path.join(directory, entry.name));
    }
  }
  return result;
}

function relativeImports(source) {
  return relativeModuleSpecifiers(source);
}

test("production modules never depend on the Agent Hub composition root", async () => {
  const offenders = [];
  for (const file of await productionModules()) {
    if (["agent-hub-server.mjs", "agent-hub-main.mjs"].includes(path.basename(file))) continue;
    const source = await readFile(file, "utf8");
    if (relativeImports(source).some((value) => value.endsWith("/agent-hub-server.mjs"))) {
      offenders.push(path.relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, []);
});

test("Agent Hub executable entrypoint contains bootstrap only", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-main.mjs"), "utf8");
  const imports = relativeImports(source);
  assert.deepEqual(imports, ["./agent-hub-server.mjs"]);
  assert.equal(source.includes("startAgentHub()"), true);
  assert.equal(source.includes("shutdownAgentHub("), true);
  assert.doesNotMatch(source, /TelegramClient|AgentProviderRegistry|TaskRunRegistry|loadConfig/u);
});

test("unit tests live under the mirrored tests tree instead of the package root", async () => {
  const inventory = await migrationInventory();
  const rootTests = await rootTestModuleNames();
  assert.equal(rootTests.length, inventory.baseline.rootTestModules);
  assert.deepEqual(rootTests, []);
  assert.deepEqual(await testsOutsideMirroredTree(), []);
});

test("production module graph remains acyclic", async () => {
  const files = await productionModules();
  const known = new Set(files.map((file) => path.normalize(file)));
  const graph = new Map();
  for (const file of files) {
    const source = await readFile(file, "utf8");
    graph.set(file, relativeImports(source)
      .map((value) => path.normalize(path.resolve(path.dirname(file), value)))
      .filter((value) => known.has(value)));
  }
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];
  function visit(file) {
    if (visiting.has(file)) {
      cycles.push([...stack.slice(stack.indexOf(file)), file].map((item) => path.relative(ROOT, item)));
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
  assert.deepEqual(cycles, []);
});

test("composition root uses one resource registry instead of ad-hoc settling", async () => {
  const source = await compositionSource();
  assert.equal(source.includes("settleNamedOperations"), false);
  assert.equal((source.match(/new RuntimeResourceRegistry\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/new RuntimeRestartController\s*\(/g) ?? []).length, 1);
});

test("persistent mutable state has one composition owner per responsibility", async () => {
  const source = await compositionSource();
  const uniqueOwners = [
    "TaskSelectionStore",
    "TaskRunRegistry",
    "DeferredInputStore",
    "AgentPreferencesStore",
    "TaskMetadataStore",
    "RuntimeTimerCoordinator",
    "HubRuntimeStateCoordinator",
    "RunCoordinator",
    "RunJournalService",
    "RuntimeStateStore",
    "TaskReadStateStore",
    "TurnEndNotificationRegistry",
    "RateLimitHistoryStore",
    "TrustedDeviceStore",
  ];
  for (const owner of uniqueOwners) {
    const count = (source.match(new RegExp(`new ${owner}\\s*\\(`, "gu")) ?? []).length;
    assert.equal(count, 1, `${owner} must have exactly one composition owner`);
  }
  assert.equal((source.match(/createApplicationCommandService\s*\(/gu) ?? []).length, 1);
  assert.equal((source.match(/new MiniAppServer\s*\(/gu) ?? []).length, 2);
});

test("composition root changes selected task only through TaskSelectionStore", async () => {
  const source = await compositionSource();
  const rootSource = await readFile(COMPOSITION_ROOT, "utf8");
  for (const field of ["activeProvider", "activeProjectRoot", "threadId", "activeThreadTitle"]) {
    assert.equal(new RegExp(`^\\s*(?:let|var)\\s+${field}\\b`, "mu").test(rootSource), false, field);
    assert.equal(new RegExp(`^\\s*${field}\\s*=`, "mu").test(rootSource), false, field);
    assert.equal(rootSource.includes(`selectionStore.${field}`), true, field);
  }
  assert.equal(/^let\s+/mu.test(rootSource), false, "composition root must not own mutable module state");
  assert.equal(rootSource.includes("threadIdsByProvider"), false);
  assert.equal((source.match(/new TaskSelectionStore\s*\(/g) ?? []).length, 1);
});

test("provider discovery and catalog merge have one application owner", async () => {
  const source = await compositionSource();
  assert.equal((source.match(/new ProviderTaskCatalogBuilder\s*\(/g) ?? []).length, 1);
  assert.equal(/Promise\.allSettled\(\s*\[\s*listAllCodexThreads/u.test(source), false);
});

test("provider operations resolve through one AgentProvider registry", async () => {
  const source = await compositionSource();
  const adapters = await readFile(path.join(ROOT, "src", "providers", "provider-adapters.mjs"), "utf8");
  const coordinator = await readFile(path.join(ROOT, "src", "application", "run-coordinator.mjs"), "utf8");
  const observation = await readFile(path.join(ROOT, "src", "application", "task-observation-service.mjs"), "utf8");
  const recovery = await readFile(path.join(ROOT, "src", "application", "run-recovery-coordinator.mjs"), "utf8");
  const providerCallOwners = `${source}\n${coordinator}\n${adapters}\n${observation}\n${recovery}`;
  assert.equal((source.match(/createAgentProviderRegistry\s*\(/g) ?? []).length, 1);
  assert.equal((adapters.match(/new AgentProviderRegistry\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/new TaskObservationService\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("sources: agentProviders.catalogSources()"), true);
  for (const operation of [
    "createTask",
    "launchTurn",
    "steerTurn",
    "cancelRun",
    "readTaskActivity",
    "readRunSnapshot",
    "completeObservedRun",
    "completeManagedRun",
    "recoverRun",
    "readRecoverySnapshot",
    "prepareRecovery",
    "shouldObserveRun",
    "applyObservedSnapshot",
    "applyActiveSnapshot",
    "blocksRuntimeRestart",
    "stopManagedRunForShutdown",
  ]) {
    assert.equal(
      providerCallOwners.includes(`.call(`) && providerCallOwners.includes(`"${operation}"`),
      true,
      operation,
    );
  }
  const sharedObservedCompletion = observation.slice(
    observation.indexOf("async finish(run, snapshot)"),
    observation.indexOf("async finishUnknown(run, snapshot)"),
  );
  const sharedRecovery = recovery.slice(
    recovery.indexOf("async recover(run)"),
    recovery.indexOf("async finishInterrupted(run)"),
  );
  for (const sharedLifecycle of [sharedObservedCompletion, sharedRecovery]) {
    assert.doesNotMatch(sharedLifecycle, /provider\s*[!=]==?\s*["'](?:codex|claude)["']/u);
  }
});

test("run admission and provider terminal dispatch have one coordinator", async () => {
  const source = await compositionSource();
  const admission = await readFile(
    path.join(ROOT, "src", "composition", "run-admission-composition.mjs"),
    "utf8",
  );
  const observation = await readFile(path.join(ROOT, "src", "application", "task-observation-service.mjs"), "utf8");
  assert.equal((source.match(/new RunCoordinator\s*\(/g) ?? []).length, 1);
  const startTurn = admission.slice(
    admission.indexOf("async function startTurn"),
    admission.indexOf("async function cleanupDeferredFiles"),
  );
  assert.equal(startTurn.includes("runCoordinator.start("), true);
  assert.doesNotMatch(startTurn, /externalActivity\.state|activeRepositoryConflict|beginRun\(/u);
  assert.equal(admission.includes("start: (item) => runCoordinator.startDeferred(item)"), true);
  assert.equal(source.includes("runCoordinator.completeManaged("), true);
  assert.equal(observation.includes("this.runCoordinator.completeObserved("), true);
  const recovery = await readFile(path.join(ROOT, "src", "application", "run-recovery-coordinator.mjs"), "utf8");
  assert.equal(recovery.includes("d.runCoordinator.recoverProviderRun("), true);
});

test("journal projection and last-message state have one application owner", async () => {
  const source = await compositionSource();
  const journal = await readFile(path.join(ROOT, "src/application/run-journal-service.mjs"), "utf8");
  assert.equal((source.match(/new RunJournalService\s*\(/g) ?? []).length, 1);
  for (const operation of [
    "recordAutomaticAndProject(",
    "recordAndProject(",
    "mergeTurnTexts(",
    "retireLegacyStorage(",
  ]) {
    assert.equal(source.includes(operation), false, operation);
    assert.equal(journal.includes(operation), true, operation);
  }
  assert.equal(source.includes("const lastTaskMessages = new Map()"), false);
});

test("turn-end projection and retry policy have one delivery owner", async () => {
  const source = await compositionSource();
  const delivery = await readFile(path.join(ROOT, "src/application/turn-end-delivery-service.mjs"), "utf8");
  assert.equal((source.match(/new TurnEndDeliveryService\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("const deliveringTurnEndKeys = new Set()"), false);
  assert.equal(delivery.includes("this.delivering = new Set()"), true);
  assert.equal(delivery.includes("async retryPending("), true);
  assert.equal(delivery.includes("async retryPendingProjections("), true);
  assert.equal(delivery.includes("async retryPendingTelegram("), true);
  assert.equal(delivery.includes("async waitForCompletion("), true);
});

test("Codex completion bookkeeping has one finalization owner", async () => {
  const source = await compositionSource();
  const finalizer = await readFile(path.join(ROOT, "src/providers/codex/codex-run-finalizer.mjs"), "utf8");
  const terminalCommit = await readFile(path.join(ROOT, "src/application/terminal-turn-commit-service.mjs"), "utf8");
  assert.equal((source.match(/new CodexRunFinalizer\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("routeCodexFinalDelivery("), false);
  assert.equal(finalizer.includes("async finalize("), true);
  assert.equal(finalizer.includes("this.notifications.recordCompletion("), true);
  assert.equal(finalizer.includes("await this.commitTerminal("), true);
  assert.equal(finalizer.includes("await this.markRunCompleted(run)"), true);
  assert.equal(finalizer.includes("await this.deliverTerminal("), true);
  assert.equal(finalizer.includes("await this.completeRun(run)"), true);
  assert.equal(terminalCommit.includes("export class TerminalTurnCommitService"), true);
  assert.equal(terminalCommit.includes("async commit("), true);
});

test("Codex token and context state have one bounded owner", async () => {
  const source = await compositionSource();
  const tracker = await readFile(path.join(ROOT, "src/providers/codex/codex-usage-tracker.mjs"), "utf8");
  assert.equal((source.match(/new CodexUsageTracker\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("const threadTokenTotals = new Map()"), false);
  assert.equal(source.includes("const threadContextUsage = new Map()"), false);
  assert.equal(tracker.includes("this.threadTotals = new Map()"), true);
  assert.equal(tracker.includes("this.contexts = new Map()"), true);
  assert.equal(tracker.includes("restore(snapshot = {})"), true);
  assert.equal(tracker.includes("snapshot()"), true);
});

test("Codex compaction and rollout sanitation have one maintenance owner", async () => {
  const source = await compositionSource();
  const maintenance = await readFile(
    path.join(ROOT, "src/providers/codex/codex-context-maintenance-service.mjs"),
    "utf8",
  );
  assert.equal((source.match(/new CodexContextMaintenanceService\s*\(/g) ?? []).length, 1);
  for (const operation of [
    "recycleCodexCompactionTransport",
    "scheduleInGroup(\"codex-compaction-cleanup\"",
    "runForRollout(rolloutPath)",
    "runOnce()",
  ]) {
    assert.equal(source.includes(operation), false, operation);
    assert.equal(maintenance.includes(operation), true, operation);
  }
  assert.equal(source.includes("codexCompactionRecycleInFlight"), false);
  assert.equal(maintenance.includes("this.recycleInFlight"), true);
});

test("Codex terminal reconciliation has one application owner", async () => {
  const source = await compositionSource();
  const reconciliation = await readFile(
    path.join(ROOT, "src/providers/codex/codex-terminal-reconciliation-service.mjs"),
    "utf8",
  );
  assert.equal((source.match(/new CodexTerminalReconciliationService\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("const reconcilingCodexTerminalTurns = new Set()"), false);
  assert.equal(reconciliation.includes("this.reconciling = new Set()"), true);
  for (const operation of [
    "hasDelivered(identity)",
    "recordCompletion({",
    "takePendingMessage(identity)",
    "Accounted historical Codex turn",
  ]) {
    assert.equal(source.includes(operation), false, operation);
    assert.equal(reconciliation.includes(operation), true, operation);
  }
});

test("task catalog provider and Telegram concerns have explicit owners", async () => {
  const claude = await readFile(
    path.join(ROOT, "src", "providers", "claude", "claude-task-activity.mjs"),
    "utf8",
  );
  const codex = await readFile(
    path.join(ROOT, "src", "providers", "codex", "codex-rollout-activity.mjs"),
    "utf8",
  );
  const titles = await readFile(
    path.join(ROOT, "src", "domain", "task-catalog-titles.mjs"),
    "utf8",
  );
  const projection = await readFile(
    path.join(ROOT, "src", "application", "task-catalog-projection.mjs"),
    "utf8",
  );
  const presentation = await readFile(
    path.join(ROOT, "src", "interfaces", "telegram", "task-catalog-presentation.mjs"),
    "utf8",
  );
  const executionOwner = await readFile(
    path.join(ROOT, "src", "domain", "task-execution-owner.mjs"),
    "utf8",
  );
  assert.match(claude, /^export function claudeSnapshotActivityAtMs/mu);
  assert.match(codex, /^export function readCodexRolloutActivity/mu);
  assert.match(titles, /^export function preferredCodexTaskTitle/mu);
  assert.match(projection, /^export function mergeTaskCatalog/mu);
  assert.match(presentation, /^export function runningTaskReplyMarkup/mu);
  assert.match(executionOwner, /^export const TASK_EXECUTION_OWNERS/mu);
});

test("work log projection and subagent identity have explicit owners", async () => {
  const projection = await readFile(
    path.join(ROOT, "src", "application", "work-log-usage-projection.mjs"),
    "utf8",
  );
  const store = await readFile(
    path.join(ROOT, "src", "application", "work-log-usage-store.mjs"),
    "utf8",
  );
  const repository = await readFile(
    path.join(ROOT, "src", "infrastructure", "persistence", "work-log-usage-repository.mjs"),
    "utf8",
  );
  const subagentIdentity = await readFile(
    path.join(ROOT, "src", "domain", "subagent-turn-identity.mjs"),
    "utf8",
  );

  assert.match(projection, /^export function projectWorkLogUsage/mu);
  assert.match(projection, /^export function buildWorkLogUsageHistory/mu);
  assert.match(store, /^export function createWorkLogUsageStore/mu);
  assert.match(store, /^export class WorkLogUsageStore/mu);
  assert.match(repository, /^export class WorkLogUsageRepository/mu);
  assert.match(subagentIdentity, /^export function uuidV7TimestampMs/mu);
  assert.match(subagentIdentity, /^export function isInheritedSubagentTurn/mu);
});

test("root production modules match the frozen migration inventory", async () => {
  const inventory = await migrationInventory();
  assert.equal(inventory.schemaVersion, 1);
  const migration = inventoryModules(inventory);
  const combined = [...inventory.publicRootModules, ...migration];
  assert.equal(new Set(combined).size, combined.length, "migration inventory contains duplicate modules");
  assert.equal(combined.length, inventory.baseline.rootProductionModules);
  assert.deepEqual(await rootProductionModuleNames(), combined.toSorted());
  for (const target of Object.keys(inventory.migrationTargets)) {
    assert.match(target, /^src\/(?:application|domain|providers\/(?:codex|claude)|interfaces\/(?:telegram|desktop|web)|runtime|infrastructure\/(?:persistence|filesystem|process|network|telegram|cloudflare))$/u);
  }
});

test("Desktop shell owns read, command and run-router assembly", async () => {
  const root = await readFile(COMPOSITION_ROOT, "utf8");
  const shell = await readFile(
    path.join(ROOT, "src", "composition", "desktop-shell-composition.mjs"),
    "utf8",
  );
  const runRouter = await readFile(
    path.join(ROOT, "src", "composition", "desktop-run-router-wiring-composition.mjs"),
    "utf8",
  );
  for (const factory of [
    "createDesktopReadSystemWiring",
    "createDesktopCommandWiring",
    "createDesktopRunRouterWiring",
  ]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(shell.includes(factory), true, `${factory} is not owned by the Desktop shell`);
  }
  const runRouterStart = shell.indexOf("const desktopRunRouter = createDesktopRunRouterWiring");
  const runRouterServicesEnd = shell.indexOf("\n    desktop: {", runRouterStart);
  const runRouterServices = shell.slice(runRouterStart, runRouterServicesEnd);
  assert.match(runRouterServices, /\n      taskBoard,/u);
  assert.match(runRouterServices, /\n      workspaceCatalog: workspaceCatalogStore,/u);
  assert.match(runRouter, /rollbackAdmission: services\.rollbackAdmission/u);
  assert.equal((shell.match(/desktopCommandsPort\.bind\s*\(/gu) ?? []).length, 1);
  assert.equal(shell.includes("trustedDeviceUserId: desktopReadSystem.trustedDeviceUserId"), true);
});

test("runtime orchestration owns observation, timers, interaction and restart", async () => {
  const root = await readFile(COMPOSITION_ROOT, "utf8");
  const orchestration = await readFile(
    path.join(ROOT, "src", "composition", "runtime-orchestration-composition.mjs"),
    "utf8",
  );
  const bootstrap = await readFile(
    path.join(ROOT, "src", "composition", "execution-bootstrap-phase-composition.mjs"),
    "utf8",
  );
  const restartWiring = await readFile(
    path.join(ROOT, "src", "composition", "runtime-restart-wiring-composition.mjs"),
    "utf8",
  );
  for (const factory of [
    "createProviderRuntimeWiring",
    "createRuntimeTimersComposition",
    "createTaskInteractionWiring",
    "createRuntimeRestartWiring",
  ]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(orchestration.includes(factory), true, `${factory} is not owned by runtime orchestration`);
  }
  assert.equal(orchestration.includes("updateRestartMessage: (message)"), true);
  assert.equal(bootstrap.includes("usageSyncAuto: provider.usageSyncAuto"), true);
  assert.match(orchestration, /streamMaintenance,/u);
  assert.match(restartWiring, /streamMaintenance\.activeCount\(\)/u);
});

test("run shell owns presentation, admission and diff persistence", async () => {
  const root = await readFile(COMPOSITION_ROOT, "utf8");
  const shell = await readFile(
    path.join(ROOT, "src", "composition", "run-shell-composition.mjs"),
    "utf8",
  );
  for (const factory of ["createRunPresentationComposition", "createRunAdmissionComposition"]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(shell.includes(factory), true, `${factory} is not owned by the run shell`);
  }
  assert.equal(root.includes("const captured = await taskGitDiff("), false);
  assert.equal(shell.includes("async function refreshTaskDiff(run)"), true);
});

test("Telegram runtime owns shell and controller assembly", async () => {
  const root = await readFile(COMPOSITION_ROOT, "utf8");
  const runtime = await readFile(
    path.join(ROOT, "src", "composition", "telegram-runtime-composition.mjs"),
    "utf8",
  );
  for (const factory of ["createTelegramShellWiring", "createTelegramControllerComposition"]) {
    assert.equal(root.includes(factory), false, `${factory} leaked into the composition root`);
    assert.equal(runtime.includes(factory), true, `${factory} is not owned by Telegram runtime`);
  }
  assert.equal(runtime.includes("ports.telegramShell.bind("), true);
});

test("state persistence has one bounded composition owner", async () => {
  const root = await readFile(COMPOSITION_ROOT, "utf8");
  const persistence = await readFile(
    path.join(ROOT, "src", "composition", "state-persistence-composition.mjs"),
    "utf8",
  );
  assert.equal(root.includes("function saveState()"), false);
  assert.equal(root.includes("function savePinnedTaskTitles()"), false);
  assert.equal(persistence.includes("selectionStore.rememberCurrentThread()"), true);
  assert.equal(persistence.includes("taskMetadata.pinnedTitlesSnapshot()"), true);
});

test("src modules obey the architectural dependency matrix", async () => {
  const inventory = await migrationInventory();
  const sourceRoot = path.join(ROOT, "src");
  const files = await productionModules(sourceRoot);
  const violations = [];
  for (const file of files) {
    const owner = sourceLayer(file);
    assert.equal(SOURCE_LAYERS.has(owner), true, `unknown source layer: ${path.relative(ROOT, file)}`);
    for (const specifier of relativeImports(await readFile(file, "utf8"))) {
      const target = path.normalize(path.resolve(path.dirname(file), specifier));
      const dependency = dependencyLayer(target, inventory);
      if (dependency && !LAYER_DEPENDENCIES.get(owner).has(dependency)) {
        violations.push(`${path.relative(ROOT, file)} -> ${specifier} (${owner} -> ${dependency})`);
      }
    }
  }
  assert.deepEqual(violations, []);
});

test("provider activity and selected external watch have explicit owners", async () => {
  const source = await compositionSource();
  const activity = await readFile(
    path.join(ROOT, "src", "application", "provider-task-activity-service.mjs"),
    "utf8",
  );
  const watch = await readFile(
    path.join(ROOT, "src", "application", "selected-task-watch-service.mjs"),
    "utf8",
  );
  assert.equal((source.match(/new ProviderTaskActivityService\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/new SelectedTaskWatchService\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("async function readCodexTaskActivity"), false);
  assert.equal(source.includes("async function readClaudeTaskActivity"), false);
  assert.equal(source.includes("selectedTaskWatchInFlight"), false);
  assert.equal(activity.includes("async readCodex(target)"), true);
  assert.equal(activity.includes("async readClaude(target)"), true);
  assert.equal(watch.includes("this.inFlight = false"), true);
  assert.equal(watch.includes("const current = this.#candidates()"), true);
  assert.equal(watch.includes("const currentRun = this.taskRuns.forTask(task)"), true);
});

test("rate-limit probing and periodic persistence have one telemetry owner", async () => {
  const source = await compositionSource();
  const telemetry = await readFile(
    path.join(ROOT, "src", "application", "rate-limit-telemetry-service.mjs"),
    "utf8",
  );
  assert.equal((source.match(/new RateLimitTelemetryService\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("async function readClaudeRateLimits"), false);
  assert.equal(source.includes("function scheduleRateLimitPoll"), false);
  assert.equal(source.includes("async function pollRateLimits"), false);
  assert.equal(telemetry.includes("async readClaude()"), true);
  assert.equal(telemetry.includes("poll()"), true);
  assert.equal(telemetry.includes("this.pollInFlight"), true);
});

test("shared task mutations enter through one application command bus", async () => {
  const source = await compositionSource();
  const commands = await readFile(path.join(ROOT, "src/application/application-command-service.mjs"), "utf8");
  assert.equal((source.match(/createApplicationCommandService\s*\(/g) ?? []).length, 1);
  assert.equal((commands.match(/new ApplicationCommandBus\s*\(/g) ?? []).length, 1);
  for (const command of [
    "task.select",
    "task.create",
    "task.rename",
    "task.archive",
    "settings.update",
    "run.cancel",
    "approval.resolve",
  ]) {
    assert.equal(commands.includes(`.register("${command}"`), true, command);
  }
  assert.equal(source.includes("clientId: `telegram:"), true);
});

test("production persistence composition exposes only branded fail-closed capabilities", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-composed-capabilities-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const rawWorkspaceCatalogStore = new WorkspaceCatalogStore({ databaseFile });
  await rawWorkspaceCatalogStore.load();
  const workspace = await rawWorkspaceCatalogStore.runMutation(() => (
    rawWorkspaceCatalogStore.createWorkspace({ name: "Composition" })
  ));
  const rawTaskBoardStore = new TaskBoardStore({ databaseFile });
  context.after(async () => {
    rawTaskBoardStore.close();
    rawWorkspaceCatalogStore.close();
    await rm(root, { recursive: true, force: true });
  });

  const { workspaceCatalogStore, taskBoardStore } = createPersistenceMutationCapabilities({
    rawWorkspaceCatalogStore,
    rawTaskBoardStore,
  });
  assert.equal(isWorkspaceCatalogMutationOwner(workspaceCatalogStore), true);
  assert.equal(isTaskBoardMutationOwner(taskBoardStore), true);
  assert.equal(workspaceCatalogStore.runMutation, undefined);
  assert.equal(taskBoardStore.transaction, undefined);
  assert.throws(() => workspaceCatalogStore.load, /not classified for production access/u);

  const taskBoard = new TaskBoardService({ store: taskBoardStore, workspaceCatalog: workspaceCatalogStore });
  const task = await taskBoard.create({
    text: "composed capability", source: "test", bucket: "workspace", workspaceId: workspace.id,
  });
  assert.equal(taskBoard.task(task.id).id, task.id);

  const releaseDependencies = {
    releasePlanner: { plan: async () => ({}) },
    releaseGitWorkspaces: {
      frozenCandidate: async () => ({}),
      synchronizePublishedPrimary: async () => ({}),
    },
    taskGitWorkspaces: { synchronizeMainIntoDev: async () => ({}) },
    releasePreflight: {
      prepareAwaitSet: async () => ({}),
      withAwaitTransition: async (_workspaceId, operation) => operation(),
    },
    verifyPublication: async () => ({}),
  };
  assert.throws(
    () => new WorkspaceReleaseService({ store: rawTaskBoardStore, ...releaseDependencies }),
    /requires the Task mutation owner facade/u,
  );
  assert.doesNotThrow(
    () => new WorkspaceReleaseService({ store: taskBoardStore, ...releaseDependencies }),
  );
});
