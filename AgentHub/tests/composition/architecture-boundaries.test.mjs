import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readdir, readFile } from "node:fs/promises";

import path from "node:path";
import test from "node:test";

import { relativeModuleSpecifiers } from "../../src/infrastructure/filesystem/module-import-specifiers.mjs";







// This file checks package/import topology and real SQLite capabilities.
// Runtime behavior is exercised by the owning service suites and phase composition
// scenarios, not by counting constructor names or matching callback source text.
const ROOT = path.resolve(import.meta.dirname, "..", "..");
// Dependency custody can retain the same installed package beside node_modules.
// It remains third-party input, not a maintained application source layer.
const IGNORED_DIRECTORIES = new Set(["node_modules", ".agent-hub-dependency-retained", "build", "dist", ".wrangler", "WIP"]);
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

test("Agent Hub executable bootstrap starts once and routes signals and failures to its shutdown owner", async () => {
  for (const mode of ["success", "failure"]) {
    const { stdout, stderr } = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("../fixtures/bootstrap-entry-observation.mjs", import.meta.url)), mode],
      { windowsHide: true });
    assert.equal(stderr, "");
    const observed = JSON.parse(stdout);
    assert.deepEqual(observed.fatalOptions, [
      { sameShutdown: true, exitAfterShutdown: false },
      { sameShutdown: true, exitAfterShutdown: true },
    ]);
    assert.deepEqual(observed.events, [
      ["start"],
      ...(mode === "failure" ? [["fatal", "startup failed", "startup", true], ["shutdown", "startup failed"]] : []),
      ["shutdown", "SIGINT"], ["shutdown", "SIGTERM"],
      ["fatal", "unhandled rejection", "rejection", false], ["shutdown", "unhandled rejection"],
      ["fatal", "uncaught exception", "exception", false], ["shutdown", "uncaught exception"],
    ]);
  }
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
