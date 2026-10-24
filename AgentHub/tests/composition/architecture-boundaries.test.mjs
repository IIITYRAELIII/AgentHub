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

// This file checks package/import topology and real SQLite capabilities.
// Runtime behavior is exercised by the owning service suites and phase composition
// scenarios, not by counting constructor names or matching callback source text.
const ROOT = path.resolve(import.meta.dirname, "..", "..");
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
      if (directory === ROOT && entry.name === "tests") continue;
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
