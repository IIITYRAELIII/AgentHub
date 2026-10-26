import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeTestSelection, resolveTestSelection, verifyTestPlan } from "../../src/domain/test-selection.mjs";
import { createCandidateGeneration, restoreReleaseOperation, effectiveReleaseTaskIds } from "../../src/domain/release-operation.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationCommandService } from "../../src/application/release-operation-command-service.mjs";
import { focusedSteps, parseChangedArguments, runReleaseOperationCli } from "../../publish-changed.mjs";
import { releaseOperationPublicationArguments } from "../../release-operation-publication-runner.mjs";
import { runSelectedTests } from "../../test-suite.mjs";
import { discoverReleaseTestInventory } from "../../src/infrastructure/filesystem/release-test-inventory.mjs";

const selection = (mode, ids = []) => ({ mode, ids });
const inventory = ["syntax-check.mjs", "install_test.py", "tests/a.test.mjs", "VSCodeExtension/render.test.js", "check:worker", "check:release-candidate", "check:contour"];
const generationInput = {
  repositoryBases: [{ repositoryRoot: "repo", baseCommit: "base" }], selectedResults: [{ taskId: "task", resultCommit: "result" }],
  candidates: [{ repositoryRoot: "repo", releaseRoot: "candidate", commit: "commit", tree: "tree", manifestHash: "manifest", baseCommit: "base" }],
};

test("selection resolves all/include/exclude/none and refuses ambiguous or unknown selectors", () => {
  assert.equal(resolveTestSelection(selection("all"), inventory).selectedIds.length, inventory.length);
  assert.deepEqual(resolveTestSelection(selection("include", ["tests/a.test.mjs"]), inventory).selectedIds, ["tests/a.test.mjs"]);
  assert.equal(resolveTestSelection(selection("exclude", ["tests/a.test.mjs"]), inventory).selectedIds.length, inventory.length - 1);
  const none = resolveTestSelection(selection("none"), inventory);
  assert.deepEqual(none.selectedIds, []);
  assert.equal(none.notSelectedIds.length, inventory.length);
  assert.throws(() => resolveTestSelection(selection("include", ["unknown"]), inventory), /Unknown/);
  for (const invalid of [{ mode: "focused", ids: [] }, selection("none", ["a"]), selection("include", ["a", "a"]), { mode: "all" }]) {
    assert.throws(() => normalizeTestSelection(invalid));
  }
  assert.throws(() => verifyTestPlan({ ...none, selectedIds: ["tests/a.test.mjs"] }), /changed/);
});

test("explicit none starts no dependency/accounting/child and reports not-selected instead of PASS", async () => {
  const events = [];
  const result = await runSelectedTests(selection("none"), { inventory: inventory.map(id => ({ id, suite: "unit" })),
    prepareDependencies: () => assert.fail("dependency owner"), createAdmission: () => assert.fail("accounting owner"),
    execute: () => assert.fail("child"), report: value => events.push(value), onFile: value => events.push(value) });
  assert.equal(result.status, "not-selected");
  assert.equal(events.filter(value => value.status === "not-selected").length, inventory.length);
  assert.equal(events.some(value => value.status === "passed"), false);
  await assert.rejects(runSelectedTests(selection("include", ["unknown"]), { inventory: [], prepareDependencies: () => assert.fail("dependency before invalid selection") }), /Unknown/);
});

test("selected runner retains canonical cwd/isolation and starts only selected commands", async () => {
  const calls = [];
  const available = [
    { id: "tests/a.test.mjs", file: "tests/a.test.mjs", suite: "unit", isolation: true },
    { id: "VSCodeExtension/render.test.js", file: "render.test.js", directory: "VSCodeExtension", suite: "vscode", isolation: false },
    { id: "install_test.py", file: "install_test.py", suite: "installer" },
  ];
  await runSelectedTests(selection("exclude", ["install_test.py"]), { inventory: available,
    prepareDependencies: async () => {}, createAdmission: async () => null,
    execute: async (command, args, options) => calls.push({ command, args, options }), report: () => {}, onFile: () => {} });
  assert.equal(calls.length, 2);
  assert.equal(calls.find(call => call.args.at(-1) === "tests/a.test.mjs").args.includes("--test-isolation=none"), true);
  const vscode = calls.find(call => call.args.at(-1) === "render.test.js");
  assert.equal(path.basename(vscode.options.cwd), "VSCodeExtension");
  assert.equal(vscode.args.includes("--test-isolation=none"), false);
});

test("none publication never expands unknown/full changes to syntax/RC/full/worker verification", () => {
  const plan = { runtime: true, android: true, worker: true, vscode: true, fullTests: true, unknown: ["new-file"], runtimeRestart: true };
  const steps = focusedSteps(plan, { testPlan: resolveTestSelection(selection("none"), inventory) });
  assert.deepEqual(steps.map(step => step.label), ["Сборка Agent Hub Mobile", "Сборка runtime-релиза", "Развёртывание Mini App Worker", "Активация runtime-релиза", "Установка расширения VS Code"]);
  const included = focusedSteps(plan, { testPlan: resolveTestSelection(selection("include", ["tests/a.test.mjs"]), inventory) });
  const command = included.find(step => step.label === "Выбранные тесты Agent Hub");
  assert.equal(command.command, process.execPath);
  assert.equal(command.args[0], "test-suite.mjs");
  assert.equal(command.args.some(arg => arg.includes('"tests/a.test.mjs"')), true);
  assert.equal(included.some(step => step.label.includes("Полные") || step.label === "Проверка синтаксиса Agent Hub"), false);
  assert.equal(focusedSteps({ ...plan, unknown: [] }).some(step => step.label === "Полные тесты Agent Hub"), true, "default unchanged");
});

async function fixture(t, overrides = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "test-selection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReleaseOperationStore({ dataDir: root, idFactory: () => "original" });
  const scheduled = [];
  const service = new ReleaseOperationService({ store, processAlive: () => false, schedule: callback => scheduled.push(callback),
    compose: async () => generationInput, validate: async () => { throw Object.assign(new Error("original validation failed"), { code: "RELEASE_VALIDATION_FAILED" }); },
    publishTarget: async () => assert.fail("publication"), readTarget: async () => ({ status: "not_applied" }), finalize: async () => {},
    resolveTestPlans: async (candidates, value) => candidates.map(candidate => ({ repositoryRoot: candidate.repositoryRoot, plan: resolveTestSelection(value, inventory) })),
    ...overrides,
  });
  const ack = service.start({ requestId: "original-request", workspaceId: "workspace", streamId: "stream", threadId: "thread",
    authorization: { taskIds: ["task"], validationMode: "full", approvedTargets: [{ targetId: "target", kind: "git" }] } });
  scheduled.shift()();
  await service.drain(ack.operationId);
  return { root, store, service, scheduled };
}

test("same owner CAS amendment preserves failed generation/auth, survives reopen and binds next immutable plan", async t => {
  const f = await fixture(t);
  const before = f.store.snapshot("original");
  const original = before.operation;
  assert.equal(original.state, "waiting");
  const options = { requestId: "amend-none", testSelection: selection("none"), expectedRevision: original.revision, expectedGeneration: 1 };
  const amended = await f.service.continue("original", options);
  assert.equal(amended.accepted, true);
  assert.deepEqual(f.store.generation("original", 1), before.generations[0]);
  assert.deepEqual(f.store.get("original").authorization, original.authorization);
  assert.deepEqual(restoreReleaseOperation(JSON.parse(JSON.stringify(f.store.get("original")))), f.store.get("original"));
  const reopened = new ReleaseOperationStore({ dataDir: f.root });
  assert.equal(reopened.get("original").testSelectionAmendments[0].requestId, "amend-none");
  assert.equal((await f.service.continue("original", options)).duplicate, true);
  await assert.rejects(f.service.continue("original", { ...options, testSelection: selection("all") }), /identity changed/);
  f.scheduled.shift()();
  await f.service.drain("original");
  const next = f.store.generation("original", 2);
  assert.deepEqual(next.testPlans[0].plan.selectedIds, []);
  assert.equal(next.testSelectionAmendmentId, amended.amendment.identitySha256);
  assert.equal(createCandidateGeneration(next).identitySha256, next.identitySha256);
  assert.deepEqual(f.store.latestStep("original", 1, "validate"), before.receipts.find(step => step.generation === 1 && step.stepId === "validate"));
  assert.equal(f.store.latestStep("original", 2, "validate").input.testPlans[0].plan.selection.mode, "none");
});

test("stale CAS, live ownership and UNKNOWN/applied effects refuse without amendment", async t => {
  const f = await fixture(t);
  const current = f.store.get("original");
  const options = { requestId: "amend", testSelection: selection("none"), expectedRevision: current.revision, expectedGeneration: 1 };
  assert.equal((await f.service.continue("original", { ...options, expectedRevision: current.revision - 1 })).reason, "stale-revision");
  for (const status of ["unknown", "partial", "applied"]) {
    f.service.readTarget = async () => ({ status });
    await assert.rejects(f.service.continue("original", options), /publication effect/);
    assert.deepEqual(f.store.get("original"), current);
  }
  f.service.readTarget = async () => {
    f.store.transition("original", { nextAction: "concurrent change" }, { expectedRevision: current.revision });
    return { status: "not_applied" };
  };
  assert.equal((await f.service.continue("original", options)).reason, "stale-revision");
  assert.equal(f.store.get("original").testSelectionAmendments, undefined);
  const held = f.store.acquire("original", "other-owner", { processId: process.pid, leaseMs: 30_000 }).operation;
  assert.equal((await f.service.continue("original", { ...options, expectedRevision: held.revision })).reason, "ineligible");
  f.store.release("original", held.owner);
});

test("runner consumes generation-bound selection; unknown legacy policy cannot fall back to focused", () => {
  const operation = { workspaceId: "workspace", streamId: "stream", threadId: "thread", authorization: { validationMode: "full" } };
  const candidate = generationInput.candidates[0];
  const plan = resolveTestSelection(selection("none"), inventory);
  const args = releaseOperationPublicationArguments({ operation, candidate, generation: { testPlans: [{ repositoryRoot: "repo", plan }] } });
  assert.equal(args.includes("--full-tests"), false);
  assert.deepEqual(parseChangedArguments(args).testPlan, plan);
  assert.throws(() => releaseOperationPublicationArguments({ operation: { ...operation, authorization: { validationMode: "bad" } }, candidate }), /Unsupported/);
});

test("CLI amendment addresses same original and forwards exact CAS/request; command bridge retains it", async () => {
  const calls = [];
  let reads = 0;
  const operation = { operationId: "original", workspaceId: "workspace", streamId: "stream", threadId: "thread", revision: 25, currentGeneration: 14,
    state: "waiting", authorization: { approvedTargets: [{ kind: "agent-hub-publication", repositoryRoot: path.resolve("primary") }] } };
  const result = await runReleaseOperationCli(["--resume", "--operation", "original", "--validation=none"], {
    repositoryRoot: path.resolve("candidate"), assertClone: async () => ({ primaryRoot: path.resolve("primary") }),
    control: async (action, params) => {
      calls.push({ action, params });
      return action === "release-operation-get" ? { operation: { ...operation, state: ++reads === 1 ? "waiting" : "done" } } : { accepted: true };
    }, wait: async () => {},
  });
  assert.equal(result.operation.operationId, "original");
  const amendment = calls.find(call => call.action === "release-operation-continue").params;
  assert.equal(amendment.expectedRevision, 25);
  assert.equal(amendment.expectedGeneration, 14);
  assert.deepEqual(amendment.testSelection, selection("none"));
  assert.match(amendment.requestId, /^release-tests-/);
  assert.equal(calls.some(call => call.action === "release-operation-run"), false);
  let received;
  const bridge = new ReleaseOperationCommandService({ releaseOperations: { start() {}, get() {}, continue: (...args) => { received = args; } },
    workspaceCatalog: { workspace() {}, hierarchy() {} }, taskBoard: { task() {} } });
  bridge.continue(amendment);
  assert.deepEqual(received, ["original", Object.fromEntries(Object.entries(amendment).filter(([key]) => key !== "operationId"))]);
});

test("inventory exposes exact file, special, VS Code and profile IDs without running them", async () => {
  const available = await discoverReleaseTestInventory(path.resolve(import.meta.dirname, "../.."));
  for (const id of ["syntax-check.mjs", "install_test.py", "VSCodeExtension/render.test.js", "check:release-candidate", "check:worker",
    "tests/e2e/agent-hub-server.e2e.test.mjs", "profile:stress:tests/public/stream-tabs-controller.test.mjs"]) {
    assert.ok(available.some(entry => entry.id === id), id);
  }
  assert.equal(new Set(available.map(entry => entry.id)).size, available.length);
});

test("same amendment binds only explicit accepted Task membership and preserves original membership/G1", async t => {
  const accepted = new Map(["task", "board", "feature"].map(taskId => [taskId, { taskId, resultCommit: `${taskId}-accepted`, acceptanceRevision: 3 }]));
  const preflight = { prepareOperationGeneration() {}, validateOperationGeneration() {},
    withAwaitTransition: async (_workspace, callback) => callback(),
    operationSelection: async ({ taskIds }) => taskIds.flatMap(id => accepted.has(id) ? [accepted.get(id)] : []),
  };
  const adapter = new WorkspaceReleaseOperationAdapter({ releasePreflight: preflight, publication: { publish() {}, readback() {} }, finalization: { finalize() {} } });
  const f = await fixture(t, { withTaskSelection: input => adapter.withTaskSelection(input),
    compose: async ({ operation }) => ({ ...generationInput, selectedResults: effectiveReleaseTaskIds(operation).map(taskId => ({ taskId, resultCommit: `${taskId}-accepted`, acceptanceRevision: 3 })) }),
  });
  const before = f.store.snapshot("original");
  const options = { requestId: "explicit-set", testSelection: selection("none"), taskIds: ["feature", "board", "task"],
    expectedRevision: before.operation.revision, expectedGeneration: 1 };
  await assert.rejects(f.service.continue("original", { ...options, taskIds: ["unknown"] }), /unaccepted/);
  assert.deepEqual(f.store.snapshot("original"), before);
  const amended = await f.service.continue("original", options);
  assert.equal(amended.accepted, true);
  assert.deepEqual(amended.amendment.taskIds, ["board", "feature", "task"]);
  assert.deepEqual(f.store.get("original").authorization, before.operation.authorization);
  assert.equal(f.store.forTask("board")[0].operationId, "original");
  f.scheduled.shift()();
  await f.service.drain("original");
  const next = f.store.generation("original", 2);
  assert.deepEqual(next.authorizedTaskIds, ["board", "feature", "task"]);
  assert.deepEqual(next.selectedResults.map(item => item.taskId), next.authorizedTaskIds);
  assert.deepEqual(f.store.generation("original", 1), before.generations[0]);
  assert.equal((await f.service.continue("original", options)).duplicate, true);
  await assert.rejects(f.service.continue("original", { ...options, taskIds: ["task"] }), /identity changed/);
  let captures = 0;
  preflight.operationSelection = async ({ taskIds }) => taskIds.map(taskId => ({ ...accepted.get(taskId), resultCommit: `drift-${++captures}` }));
  const current = f.store.get("original");
  await assert.rejects(f.service.continue("original", { ...options, requestId: "drift", expectedRevision: current.revision, expectedGeneration: 2 }), /changed before amendment/);
  assert.deepEqual(f.store.get("original"), current);
});
