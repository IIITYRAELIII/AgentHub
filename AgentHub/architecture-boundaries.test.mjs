import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const ROOT = import.meta.dirname;
const IGNORED_DIRECTORIES = new Set(["node_modules", "build", "dist", ".wrangler"]);

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
  return [...source.matchAll(/(?:import[\s\S]*?from\s*|import\s*)["'](\.[^"']+)["']/g)]
    .map((match) => match[1]);
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
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  assert.equal(source.includes("settleNamedOperations"), false);
  assert.equal((source.match(/new RuntimeResourceRegistry\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/new RuntimeRestartController\s*\(/g) ?? []).length, 1);
});

test("composition root changes selected task only through TaskSelectionStore", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  for (const field of ["activeProvider", "activeProjectRoot", "threadId", "activeThreadTitle"]) {
    const directAssignments = [...source.matchAll(new RegExp(`^\\s*${field}\\s*=\\s*([^;]+);`, "gmu"))]
      .map((match) => match[0].trim());
    assert.deepEqual(directAssignments, [`${field} = selection.${field};`], field);
  }
  assert.equal(source.includes("threadIdsByProvider"), false);
  assert.equal((source.match(/new TaskSelectionStore\s*\(/g) ?? []).length, 1);
});

test("provider discovery and catalog merge have one application owner", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  assert.equal((source.match(/new ProviderTaskCatalogBuilder\s*\(/g) ?? []).length, 1);
  assert.equal(/Promise\.allSettled\(\s*\[\s*listAllCodexThreads/u.test(source), false);
});

test("provider operations resolve through one AgentProvider registry", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const adapters = await readFile(path.join(ROOT, "provider-adapters.mjs"), "utf8");
  const coordinator = await readFile(path.join(ROOT, "run-coordinator.mjs"), "utf8");
  const observation = await readFile(path.join(ROOT, "task-observation-service.mjs"), "utf8");
  const providerCallOwners = `${source}\n${coordinator}\n${adapters}\n${observation}`;
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
  const sharedRecovery = source.slice(
    source.indexOf("async function recoverTaskRun"),
    source.indexOf("async function finishInterruptedLocalRun"),
  );
  for (const sharedLifecycle of [sharedObservedCompletion, sharedRecovery]) {
    assert.doesNotMatch(sharedLifecycle, /provider\s*[!=]==?\s*["'](?:codex|claude)["']/u);
  }
});

test("run admission and provider terminal dispatch have one coordinator", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const observation = await readFile(path.join(ROOT, "task-observation-service.mjs"), "utf8");
  assert.equal((source.match(/new RunCoordinator\s*\(/g) ?? []).length, 1);
  const startTurn = source.slice(
    source.indexOf("async function startTurn"),
    source.indexOf("async function cleanupDeferredFiles"),
  );
  assert.equal(startTurn.includes("runCoordinator.start("), true);
  assert.doesNotMatch(startTurn, /externalActivity\.state|activeRepositoryConflict|beginRun\(/u);
  assert.equal(source.includes("start: (item) => runCoordinator.startDeferred(item)"), true);
  assert.equal(source.includes("runCoordinator.completeManaged("), true);
  assert.equal(observation.includes("this.runCoordinator.completeObserved("), true);
  assert.equal(source.includes("runCoordinator.recoverProviderRun("), true);
});

test("journal projection and last-message state have one application owner", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const journal = await readFile(path.join(ROOT, "run-journal-service.mjs"), "utf8");
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
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const delivery = await readFile(path.join(ROOT, "turn-end-delivery-service.mjs"), "utf8");
  assert.equal((source.match(/new TurnEndDeliveryService\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("const deliveringTurnEndKeys = new Set()"), false);
  assert.equal(delivery.includes("this.delivering = new Set()"), true);
  assert.equal(delivery.includes("async retryPending()"), true);
  assert.equal(delivery.includes("async waitForCompletion("), true);
});

test("Codex completion bookkeeping has one finalization owner", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const finalizer = await readFile(path.join(ROOT, "codex-run-finalizer.mjs"), "utf8");
  assert.equal((source.match(/new CodexRunFinalizer\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("routeCodexFinalDelivery("), false);
  assert.equal(finalizer.includes("routeCodexFinalDelivery"), true);
  assert.equal(finalizer.includes("async finalize("), true);
  assert.equal(finalizer.includes("this.notifications.recordCompletion("), true);
  assert.equal(finalizer.includes("await this.completeRun(run)"), true);
});

test("Codex token and context state have one bounded owner", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const tracker = await readFile(path.join(ROOT, "codex-usage-tracker.mjs"), "utf8");
  assert.equal((source.match(/new CodexUsageTracker\s*\(/g) ?? []).length, 1);
  assert.equal(source.includes("const threadTokenTotals = new Map()"), false);
  assert.equal(source.includes("const threadContextUsage = new Map()"), false);
  assert.equal(tracker.includes("this.threadTotals = new Map()"), true);
  assert.equal(tracker.includes("this.contexts = new Map()"), true);
  assert.equal(tracker.includes("restore(snapshot = {})"), true);
  assert.equal(tracker.includes("snapshot()"), true);
});

test("Codex compaction and rollout sanitation have one maintenance owner", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const maintenance = await readFile(
    path.join(ROOT, "codex-context-maintenance-service.mjs"),
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
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const reconciliation = await readFile(
    path.join(ROOT, "codex-terminal-reconciliation-service.mjs"),
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

test("provider activity and selected external watch have explicit owners", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const activity = await readFile(
    path.join(ROOT, "provider-task-activity-service.mjs"),
    "utf8",
  );
  const watch = await readFile(
    path.join(ROOT, "selected-task-watch-service.mjs"),
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
  assert.equal(watch.includes("const currentTask = this.selectedTask()"), true);
  assert.equal(watch.includes("const currentRun = this.taskRuns.forTask(task)"), true);
});

test("rate-limit probing and periodic persistence have one telemetry owner", async () => {
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const telemetry = await readFile(
    path.join(ROOT, "rate-limit-telemetry-service.mjs"),
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
  const source = await readFile(path.join(ROOT, "agent-hub-server.mjs"), "utf8");
  const commands = await readFile(path.join(ROOT, "application-command-service.mjs"), "utf8");
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
