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
