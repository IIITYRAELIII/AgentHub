import { DatabaseSync } from "node:sqlite";
import { runtimeDatabasePath } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeTestSelection, resolveTestSelection, verifyTestPlan } from "../../src/domain/test-selection.mjs";
import { createCandidateGeneration, createReleaseOperation, restoreReleaseOperation, effectiveReleaseTaskIds, effectiveReleaseMetadata, releaseIdentitySha256 } from "../../src/domain/release-operation.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationCommandService } from "../../src/application/release-operation-command-service.mjs";
import { focusedSteps, parseChangedArguments, runReleaseOperationCli } from "../../publish-changed.mjs";
import { releaseOperationPublicationArguments } from "../../release-operation-publication-runner.mjs";
import { runSelectedTests } from "../../test-suite.mjs";
import { discoverReleaseTestInventory } from "../../src/infrastructure/filesystem/release-test-inventory.mjs";

const selection = (mode, ids = []) => ({ mode, ids });
const generationGit = async (cwd, ...args) => String((await promisify(execFile)("git", args, { cwd, windowsHide: true })).stdout).trim();
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
    workspaceCatalog: { workspace() {}, hierarchy() {} }, taskBoard: { task() {}, releaseTasks: () => assert.fail("continuation must not read mutable Await membership") } });
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

test("standalone native-custody originals cannot be adopted or stripped by ordinary amendment", async t => {
  const f = await fixture(t);
  const database = new DatabaseSync(runtimeDatabasePath(f.root));
  const raw = JSON.parse(database.prepare("SELECT operation_json FROM release_operations WHERE operation_id=?").get("original").operation_json);
  raw.nativeOwnerRecovery = { immutable: "source-custody" };
  const bytes = JSON.stringify(raw);
  database.prepare("UPDATE release_operations SET operation_json=? WHERE operation_id=?").run(bytes, "original");
  const current = f.store.get("original");
  await assert.rejects(f.service.continue("original", { requestId: "cannot-adopt", testSelection: selection("none"),
    expectedRevision: current.revision, expectedGeneration: current.currentGeneration }), /source-owner-fenced/);
  assert.equal(database.prepare("SELECT operation_json FROM release_operations WHERE operation_id=?").get("original").operation_json, bytes);
  database.close();
});


function amendedContents(current, requestId, taskIds) {
  const contents = { requestId, selection: selection("none"), taskIds: [...taskIds].sort(),
    taskSelection: taskIds.map(taskId => ({ taskId, resultCommit: `${taskId}-accepted` })),
    priorRevision: current.revision, priorGeneration: current.currentGeneration,
    authorizationFingerprint: current.authorization.fingerprint,
    priorFailure: { state: current.state, completedAt: current.completedAt, error: current.lastError },
    priorPublicationEffects: current.publicationEffects, priorWaitReason: current.waitReason, priorResumeState: current.resumeState,
    readbacks: [{ targetId: "target", generation: current.currentGeneration, evidence: { status: "not_applied" } }],
  };
  return { ...contents, identitySha256: releaseIdentitySha256(contents) };
}

test("historical reviewed-main membership survives actual Store amendment/reopen and a later reviewed-main recovery", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "351-historical-main-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ReleaseOperationStore({ dataDir: root });
  const createdAt = "2026-10-26T00:00:00.000Z";
  const authorization = { taskIds: ["task"], validationMode: "full",
    approvedTargets: [{ targetId: "target", kind: "agent-hub-publication", repositoryRoot: "synthetic-repo" }] };
  const original = createReleaseOperation({ operationId: "historical", requestId: "historical-start", workspaceId: "workspace",
    streamId: "stream", threadId: "thread", runnerVersion: "test", createdAt, state: "waiting", currentGeneration: 2,
    resumeState: "compose", waitReason: { code: "validation_failed" }, lastError: { message: "retained failure" }, authorization });
  const approvedRepositories = [{ projectRoot: "synthetic-repo", approvedLocalMainCommit: "a".repeat(40), approvedOriginMainCommit: "a".repeat(40) }];
  const proofContents = { requestId: "old-reviewed-main", authorizationFingerprint: original.authorization.fingerprint,
    priorRevision: 2, priorGeneration: 1, priorFailure: { completedAt: createdAt, error: { message: "original stale main" } },
    planRevision: "old-plan", selectedResults: [{ taskId: "task", resultCommit: "task-accepted" }], preparedCandidates: [], approvedRepositories,
    readbacks: [{ targetId: "target", generation: 1, evidence: { status: "not_applied" } }] };
  const proof = { ...proofContents, identitySha256: releaseIdentitySha256(proofContents) };
  store.create({ ...original, reviewedMain: proof });
  for (let i = 0; i < 5; i++) {
    const current = store.get("historical");
    assert.equal(store.transition("historical", { nextAction: "historical progression" }, { expectedRevision: current.revision }).applied, true);
  }
  let current = store.get("historical");
  assert.ok(current.revision > proof.priorRevision);
  const result = store.transition("historical", { state: "compose", currentStep: "compose", lastError: null, publicationEffects: {} },
    { expectedRevision: current.revision, testSelectionAmendment: amendedContents(current, "add-board", ["board", "task"]) });
  assert.equal(result.applied, true);
  current = store.get("historical");
  assert.ok(current, "committed operation must remain readable");
  assert.deepEqual(current.reviewedMain, proof);
  assert.deepEqual(current.authorization, original.authorization);
  assert.deepEqual(new ReleaseOperationStore({ dataDir: root }).get("historical"), current);
  assert.deepEqual(restoreReleaseOperation(JSON.parse(JSON.stringify(current))), current);
  store.putGeneration({ ...generationInput, operationId: "historical", generation: 2, runnerVersion: "test", createdAt });
  const lease = store.acquire("historical", "fixture-owner", { processId: process.pid }).operation.owner;
  const cause = Object.assign(new Error("explicit reviewed-main approval is stale for synthetic-repo"), { code: "RELEASE_MAIN_APPROVAL_STALE" });
  for (const [generation, stepId] of [[3, "compose"], [2, "publish:target"]]) {
    const receipt = store.beginStep({ operationId: "historical", generation, stepId, input: {}, expectedOwner: lease }).receipt;
    store.finishStep(receipt, { status: "failed", error: cause, effect: { status: "not_applied" }, expectedOwner: lease });
  }
  current = store.get("historical");
  const failed = store.transition("historical", { state: "failed", currentStep: "compose",
    lastError: { message: cause.message, code: cause.code, step: "compose" } }, { expectedRevision: current.revision, expectedOwner: lease }).operation;
  const service = new ReleaseOperationService({ store, processAlive: () => false, schedule: () => {},
    compose: async () => assert.fail("no composition"), validate: async () => {}, publishTarget: async () => assert.fail("no publication"),
    readTarget: async () => ({ status: "not_applied" }), finalize: async () => {},
    withReviewedMainRecovery: async ({ commit }) => commit({ planRevision: "new-plan", approvedRepositories,
      selectedResults: ["board", "task"].map(taskId => ({ taskId, resultCommit: `${taskId}-accepted` })), preparedCandidates: [] }, async () => {}),
  });
  assert.equal((await service.continue("historical", { requestId: "new-reviewed-main", reviewedMain: { expectedRevision: failed.revision, approvedRepositories } })).accepted, true);
  current = store.get("historical");
  const laterProof = current.reviewedMain;
  assert.deepEqual(laterProof.selectedResults.map(item => item.taskId), ["board", "task"]);
  assert.equal(laterProof.previousBinding, proof.identitySha256);
  current = store.transition("historical", { state: "waiting", resumeState: "compose", waitReason: { code: "validation_failed" } },
    { expectedRevision: current.revision }).operation;
  assert.equal(store.transition("historical", { state: "compose", currentStep: "compose", lastError: null, publicationEffects: {} },
    { expectedRevision: current.revision, testSelectionAmendment: amendedContents(current, "remove-board", ["task"]) }).applied, true);
  current = new ReleaseOperationStore({ dataDir: root }).get("historical");
  assert.deepEqual(current.reviewedMain, laterProof, "later membership cannot retarget its earlier proof");
  assert.deepEqual(effectiveReleaseTaskIds(current), ["task"]);
  assert.equal(restoreReleaseOperation({ ...current, reviewedMain: { ...laterProof, identitySha256: "0".repeat(64) } }), null);
  const { identitySha256, ...drift } = laterProof;
  drift.selectedResults = [{ taskId: "task", resultCommit: "task-accepted" }];
  assert.equal(restoreReleaseOperation({ ...current, reviewedMain: { ...drift, identitySha256: releaseIdentitySha256(drift) } }), null,
    "even a recomputed digest cannot replace historical membership with today's set");
  assert.equal(restoreReleaseOperation({ ...current, reviewedMain: { ...laterProof, approvedRepositories: [] } }), null);
});

for (const omitted of ["taskIds", "testSelection"]) test(`original replay retains omitted ${omitted} after a later effective selection`, async t => {
  const f = await fixture(t, { withTaskSelection: async ({ taskIds, commit }) => commit(taskIds.map(taskId => ({ taskId, resultCommit: `${taskId}-accepted` }))) });
  const initial = f.store.get("original");
  const first = { requestId: `original-omitted-${omitted}`, expectedRevision: initial.revision, expectedGeneration: 1,
    ...(omitted === "taskIds" ? { testSelection: selection("none") } : { taskIds: ["task"] }) };
  const accepted = await f.service.continue("original", first);
  f.scheduled.shift()();
  await f.service.drain("original");
  const boundary = f.store.get("original");
  assert.equal((await f.service.continue("original", { requestId: `later-${omitted}`, expectedRevision: boundary.revision, expectedGeneration: 2,
    testSelection: selection("all"), taskIds: ["board", "task"] })).accepted, true);
  const before = f.store.snapshot("original");
  const scheduled = f.scheduled.length;
  const replay = await f.service.continue("original", first);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, accepted.revision);
  assert.deepEqual(replay.amendment, accepted.amendment);
  assert.deepEqual(f.store.snapshot("original"), before);
  assert.equal(f.scheduled.length, scheduled);
  // Supplying a previously omitted value is a different captured request,
  // even when its value equals the original outcome.
  await assert.rejects(f.service.continue("original", { ...first,
    [omitted]: omitted === "taskIds" ? ["task"] : selection("all") }), /identity changed/);
  await assert.rejects(f.service.continue("original", { ...first,
    ...(omitted === "taskIds" ? { testSelection: selection("include", ["tests/a.test.mjs"]) } : { taskIds: ["board", "task"] }) }), /identity changed/);
  assert.deepEqual(f.store.snapshot("original"), before);
  assert.equal(f.scheduled.length, scheduled);
});


test("original replay of a retained amendment without request capture uses only its saved boundary", async t => {
  const f = await fixture(t, { withTaskSelection: async ({ taskIds, commit }) => commit(taskIds.map(taskId => ({ taskId, resultCommit: `${taskId}-accepted` }))) });
  const initial = f.store.get("original");
  const first = { requestId: "retained-before-request-capture", testSelection: selection("none"), expectedRevision: initial.revision, expectedGeneration: 1 };
  const retained = amendedContents(initial, first.requestId, ["task"]);
  assert.equal(retained.requestArguments, undefined);
  assert.equal(f.store.transition("original", { state: "compose", currentStep: "compose", lastError: null, publicationEffects: {} },
    { expectedRevision: initial.revision, testSelectionAmendment: retained }).applied, true);
  f.service.continue("original");
  f.scheduled.shift()();
  await f.service.drain("original");
  const current = f.store.get("original");
  assert.equal((await f.service.continue("original", { requestId: "later-captured-membership", testSelection: selection("all"), taskIds: ["board", "task"],
    expectedRevision: current.revision, expectedGeneration: 2 })).accepted, true);
  const before = f.store.snapshot("original");
  const pending = f.scheduled.length;
  const replay = await f.service.continue("original", first);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(replay.amendment, retained, "readback neither enriches nor rewrites the retained original");
  assert.deepEqual(f.store.snapshot("original"), before);
  assert.equal(f.scheduled.length, pending);
});

test("release metadata amendment preserves failed history, reopens and replays its exact original payload identity", async t => {
  const f = await fixture(t);
  const before = f.store.snapshot("original");
  const metadata = { sourcePath: "new-notes.md", byteLength: 42, rawSha256: "a".repeat(64), canonicalSha256: "b".repeat(64) };
  const first = { requestId: "new-release-notes", releaseMetadata: metadata,
    testSelection: selection("none"), expectedRevision: before.operation.revision, expectedGeneration: 1 };
  const accepted = await f.service.continue("original", first);
  assert.equal(accepted.accepted, true);
  assert.deepEqual(f.store.get("original").authorization, before.operation.authorization);
  assert.deepEqual(f.store.generation("original", 1), before.generations[0]);
  const reopened = new ReleaseOperationStore({ dataDir: f.root });
  const restored = restoreReleaseOperation(JSON.parse(JSON.stringify(reopened.get("original"))));
  assert.deepEqual(effectiveReleaseMetadata(restored), metadata);
  const altered = structuredClone(restored);
  altered.testSelectionAmendments[0].releaseMetadata.rawSha256 = "c".repeat(64);
  assert.equal(restoreReleaseOperation(altered), null, "a changed metadata identity cannot restore with the old amendment digest");
  f.scheduled.shift()();
  await f.service.drain("original");
  const current = f.store.get("original");
  const later = { requestId: "later-selection-only", testSelection: selection("all"), expectedRevision: current.revision, expectedGeneration: 2 };
  assert.equal((await f.service.continue("original", later)).accepted, true);
  assert.deepEqual(effectiveReleaseMetadata(f.store.get("original")), metadata, "omission retains the prior notes rather than the initial artifact");
  const snapshot = f.store.snapshot("original"), scheduled = f.scheduled.length;
  assert.equal((await f.service.continue("original", first)).duplicate, true);
  await assert.rejects(f.service.continue("original", { ...first, releaseMetadata: { ...metadata, rawSha256: "c".repeat(64) } }), /identity changed/);
  await assert.rejects(f.service.continue("original", { ...first, releaseMetadata: undefined }), /identity changed/);
  await assert.rejects(f.service.continue("original", { ...later, releaseMetadata: metadata }), /identity changed/);
  assert.deepEqual(f.store.snapshot("original"), snapshot);
  assert.equal(f.scheduled.length, scheduled);
});

test("metadata-only amendment retains effect/CAS guards and never upgrades a legacy original", async t => {
  const f = await fixture(t);
  const current = f.store.get("original");
  const metadata = { sourcePath: "new-notes.md", byteLength: 42, rawSha256: "a".repeat(64), canonicalSha256: "b".repeat(64) };
  const options = { requestId: "metadata-only", releaseMetadata: metadata, expectedRevision: current.revision, expectedGeneration: 1 };
  assert.equal((await f.service.continue("original", { ...options, expectedRevision: current.revision - 1 })).reason, "stale-revision");
  f.service.readTarget = async () => ({ status: "unknown" });
  await assert.rejects(f.service.continue("original", options), /publication effect/);
  assert.deepEqual(f.store.get("original"), current);
  f.service.readTarget = async () => ({ status: "not_applied" });
  const retained = amendedContents(current, "legacy-no-metadata", ["task"]);
  assert.equal(f.store.transition("original", { state: "compose", currentStep: "compose", lastError: null, publicationEffects: {} },
    { expectedRevision: current.revision, testSelectionAmendment: retained }).applied, true);
  await assert.rejects(f.service.continue("original", { ...options, requestId: retained.requestId }), /identity changed/);
  assert.equal(effectiveReleaseMetadata(f.store.get("original")), null);
});

test("metadata-only replay is recognized before ordinary/reviewed continuation dispatch", async t => {
  const observed = [];
  const f = await fixture(t, { observeOperation: id => observed.push(id) });
  const command = new ReleaseOperationCommandService({ releaseOperations: f.service,
    workspaceCatalog: { workspace: () => ({}), hierarchy: () => [] }, taskBoard: { task: () => null, releaseTasks: () => assert.fail("continuation must not read mutable Await membership") } });
  const original = f.store.get("original");
  const args = { operationId: "original", requestId: "metadata-only-dispatch",
    releaseMetadata: { sourcePath: "notes.md", byteLength: 42, rawSha256: "a".repeat(64), canonicalSha256: "b".repeat(64) },
    expectedRevision: original.revision, expectedGeneration: original.currentGeneration };
  const accepted = await command.continue(args);
  assert.equal(accepted.accepted, true);
  f.scheduled.shift()();
  await f.service.drain("original");
  const before = f.store.snapshot("original"), queued = f.scheduled.length, observations = observed.length;
  await assert.rejects(command.continue({ ...args, releaseMetadata: undefined }), /identity changed/);
  await assert.rejects(command.continue({ operationId: args.operationId, requestId: args.requestId,
    expectedRevision: args.expectedRevision, expectedGeneration: args.expectedGeneration }), /identity changed/);
  await assert.rejects(command.continue({ operationId: args.operationId, requestId: args.requestId }), /identity changed/);
  await assert.rejects(command.continue({ ...args, releaseMetadata: undefined,
    reviewedMain: { expectedRevision: before.operation.revision, approvedRepositories: [] } }), /separate original amendments/);
  const replay = await command.continue(args);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.revision, accepted.revision);
  assert.deepEqual(f.store.snapshot("original"), before);
  assert.equal(f.scheduled.length, queued);
  assert.equal(observed.length, observations, "changed/exact replay cannot observe or schedule the operation");
  const unamended = command.continue({ operationId: "original" });
  assert.equal(unamended.accepted, false, "another failed validation retains its amendment boundary");
  assert.equal(unamended.reason, "test-selection-required");
  assert.equal(f.scheduled.length, queued);
  assert.equal(observed.length, observations + 1, "ordinary continue can observe without resuming");
  assert.deepEqual(f.store.snapshot("original"), before);
});


test("partial generation amendment freezes a fresh identity and preserves both old generations and the failed partial", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-partial-generation-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git"), sourceData = path.join(root, "source"), sqlData = path.join(root, "sql");
  await mkdir(sqlData);
  await generationGit(root, "init", "--bare", "--initial-branch=main", origin);
  await generationGit(root, "clone", origin, primary);
  await generationGit(primary, "config", "core.autocrlf", "false");
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  const pkg = { name: "agent-hub", version: "2.1.1" };
  await writeFile(path.join(primary, "AgentHub/package.json"), JSON.stringify(pkg)+"\n");
  await writeFile(path.join(primary, "AgentHub/package-lock.json"), JSON.stringify({ ...pkg, packages: { "": pkg } })+"\n");
  await writeFile(path.join(primary, "app.txt"), "base\n");
  const commit = async message => {
    await generationGit(primary, "add", "-A");
    await generationGit(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message);
    return generationGit(primary, "rev-parse", "HEAD");
  };
  const base = await commit("main");
  await generationGit(primary, "push", "origin", "main");
  await generationGit(primary, "checkout", "-b", "HUB-partial-fixture");
  await writeFile(path.join(primary, "feature.txt"), "accepted source\n");
  const resultCommit = await commit("accepted result");
  await generationGit(primary, "checkout", "main");
  const frozenTasks = [{ taskId: "task", taskRevision: 3, resultCommit }];
  const gitOwner = new ReleaseGitWorkspaceService({ dataDir: sourceData });
  const preparedInput = { projectRoot: primary, workspaceId: "workspace", planRevision: "prepared-plan", approvedBaseCommit: base, frozenTasks };
  await gitOwner.prepareCandidate(preparedInput);
  const metadata = async (name, text) => {
    const sourcePath = path.join(root, name), bytes = Buffer.from(text);
    await writeFile(sourcePath, bytes);
    const hash = createHash("sha256").update(bytes).digest("hex");
    return { sourcePath, byteLength: bytes.length, rawSha256: hash, canonicalSha256: hash };
  };
  const oldMetadata = await metadata("old-notes.md", "# 2.1.1\n\nOriginal selected release notes.\n");
  const nextMetadata = await metadata("next-notes.md", "# 2.1.1\n\nComplete accepted release notes after explicit amendment.\n");
  let failCapture = false;
  const scheduled = [];
  const adapter = new WorkspaceReleaseOperationAdapter({
    releasePreflight: {
      async prepareOperationGeneration({ operationId, generation, changelogContent, releaseVersion }) {
        const candidate = await gitOwner.prepareGeneration({ ...preparedInput, operationId, generation, changelogContent, releaseVersion,
          validateBeforeCommit: async () => {
            if (!failCapture) return;
            const key = createHash("sha256").update(`${operationId}:${generation}:${primary}`).digest("hex").slice(0, 24);
            const identity = JSON.parse(await readFile(path.join(sourceData, "release-gens", key, "identity.json"), "utf8"));
            if (identity.preparedCandidate) throw new Error("retained terminal pre-checkpoint compose failure");
          } });
        return { planRevision: preparedInput.planRevision, releaseCandidates: [candidate] };
      },
      validateOperationGeneration() {}, operationSelection() {}, withAwaitTransition() {},
    },
    publication: { publish: () => assert.fail("no publication"), readback() {} }, finalization: { finalize() {} },
  });
  const store = new ReleaseOperationStore({ dataDir: sqlData });
  const service = new ReleaseOperationService({ store, schedule: callback => scheduled.push(callback), processAlive: () => false,
    compose: input => adapter.compose(input),
    validate: async () => { throw Object.assign(new Error("fixture stops before publication"), { code: "RELEASE_VALIDATION_FAILED" }); },
    publishTarget: () => assert.fail("no publication"), finalize: async () => {},
    readTarget: async () => ({ status: (await generationGit(primary, "ls-remote", "origin", "refs/heads/main")).split(/\s+/u)[0] === base ? "not_applied" : "unknown", revision: base }),
    resolveTestPlans: async candidates => candidates.map(candidate => ({ repositoryRoot: candidate.repositoryRoot, plan: resolveTestSelection(selection("none"), []) })),
  });
  const run = async () => { assert.equal(scheduled.length, 1); await scheduled.shift()(); await service.drain(ack.operationId); };
  const ack = service.start({ requestId: "same-original", workspaceId: "workspace", streamId: "manager", threadId: "thread",
    authorization: { taskIds: ["task"], testSelection: selection("none"), validationMode: "full", releaseMetadata: oldMetadata, releaseVersion: "2.1.1",
      approvedTargets: [{ targetId: "origin", kind: "git", repositoryRoot: primary }] } });
  await run();
  assert.equal(store.get(ack.operationId).currentGeneration, 1);
  service.continue(ack.operationId); await run();
  assert.equal(store.get(ack.operationId).currentGeneration, 2);
  const oldGenerations = store.snapshot(ack.operationId).generations;
  failCapture = true; service.continue(ack.operationId); await run(); failCapture = false;
  const failed = store.snapshot(ack.operationId);
  assert.equal(failed.operation.state, "failed");assert.equal(failed.operation.currentGeneration, 2);
  assert.equal(store.generation(ack.operationId, 3), null);
  assert.equal(store.latestStep(ack.operationId, 3, "compose").status, "failed");
  const key = createHash("sha256").update(`${ack.operationId}:3:${primary}`).digest("hex").slice(0, 24);
  const partial = path.join(sourceData, "release-gens", key), identity = await readFile(path.join(partial, "identity.json"));
  assert.ok(JSON.parse(identity).preparedCandidate.inputHash);
  assert.equal((await readdir(partial, { recursive: true })).some(name => path.basename(name) === "checkpoint.json"), false);
  const oldBundle = await readFile(path.join(partial, "source.bundle"));
  await writeFile(path.join(partial, "retained.keep"), "useful partial evidence\n");
  const options = { requestId: "explicit-corrected-metadata", expectedRevision: failed.operation.revision, expectedGeneration: 2,
    releaseMetadata: nextMetadata, testSelection: selection("none") };
  const amendment = await service.continue(ack.operationId, options);assert.equal(amendment.accepted, true);
  assert.deepEqual((await service.continue(ack.operationId, options)).amendment, amendment.amendment);
  const reopened = new ReleaseOperationStore({ dataDir: sqlData });
  assert.deepEqual(reopened.get(ack.operationId).testSelectionAmendments, store.get(ack.operationId).testSelectionAmendments);
  await run();
  const after = store.snapshot(ack.operationId);
  assert.equal(after.operation.currentGeneration, 4, `changed metadata needs a new honest generation: ${after.operation.lastError?.message}`);
  assert.equal(after.operation.state, "waiting");assert.equal(after.operation.waitReason.code, "validation_failed");
  assert.deepEqual(after.generations.slice(0, 2), oldGenerations);
  assert.deepEqual(after.receipts.filter(item => item.generation <= 3), failed.receipts);
  assert.deepEqual(after.operation.authorization, failed.operation.authorization);
  assert.equal(after.operation.operationId, ack.operationId);assert.equal(store.generation(ack.operationId, 3), null);
  assert.deepEqual(await readFile(path.join(partial, "identity.json")), identity);
  assert.deepEqual(await readFile(path.join(partial, "source.bundle")), oldBundle);
  assert.equal(await readFile(path.join(partial, "retained.keep"), "utf8"), "useful partial evidence\n");
  const candidate = store.generation(ack.operationId, 4).candidates[0];
  assert.notEqual(candidate.generationRoot, partial);
  assert.equal(await generationGit(candidate.releaseRoot, "show", `${candidate.commit}:CHANGELOG.md`), (await readFile(nextMetadata.sourcePath, "utf8")).trim());
  assert.equal(JSON.parse(await generationGit(candidate.releaseRoot, "show", `${candidate.commit}:AgentHub/package.json`)).version, "2.1.1");
  assert.equal(await generationGit(primary, "status", "--porcelain"), "");
  assert.equal(await generationGit(primary, "rev-parse", "HEAD"), base);
});

async function failedPartialReceiptFixture(t, status = "failed") {
  const f = await fixture(t);
  const current = f.store.get("original");
  const receipt = f.store.beginStep({ operationId: "original", generation: 2, stepId: "compose",
    input: { authorization: current.authorization, priorGeneration: 1 } }).receipt;
  if (status !== "intent") f.store.finishStep(receipt, { status, error: new Error("retained compose failure") });
  const operation = f.store.get("original");
  f.store.transition("original", { state: "waiting", currentStep: "compose", resumeState: "compose",
    waitReason: { code: "prepared_candidate_stale" }, lastError: { message: "retained compose failure", step: "compose" } }, { expectedRevision: operation.revision });
  return f;
}

test("partial generation amendment does not supersede UNKNOWN, intent or applied composition", async t => {
  for (const status of ["unknown", "intent", "applied"]) await t.test(status, async t => {
    const f = await failedPartialReceiptFixture(t, status), before = f.store.snapshot("original");
    const options = { requestId: "cannot-supersede-ambiguous", testSelection: selection("none"), expectedRevision: before.operation.revision, expectedGeneration: 1 };
    await assert.rejects(f.service.continue("original", options), /original future compose/u);
    assert.deepEqual(f.store.get("original"), before.operation);
    assert.equal(f.store.get("original").currentGeneration, 1);
    assert.equal(f.store.generation("original", 3), null);
    assert.deepEqual(f.store.snapshot("original").receipts, before.receipts);
  });
});

test("partial generation amendment requires fresh not-applied, owner/CAS and original receipt proof", async t => {
  const f = await failedPartialReceiptFixture(t), before = f.store.get("original");
  const options = { requestId: "checked-partial", testSelection: selection("none"), expectedRevision: before.revision, expectedGeneration: 1 };
  for (const status of ["unknown", "applied", "partial"]) {
    f.service.readTarget = async () => ({ status });
    await assert.rejects(f.service.continue("original", options), /publication effect/u);
    assert.deepEqual(f.store.get("original"), before);
  }
  f.service.readTarget = async () => ({ status: "not_applied" });
  const held = f.store.acquire("original", "active-original", { processId: process.pid }).operation;
  assert.equal((await f.service.continue("original", { ...options, expectedRevision: held.revision })).reason, "ineligible");
  f.store.release("original", held.owner);
  const current = f.store.get("original");
  assert.equal((await f.service.continue("original", options)).reason, "stale-revision");
  assert.equal((await f.service.continue("original", { ...options, expectedRevision: current.revision })).accepted, true);
  // Synthetic corruption after capture tests the final transactional recheck, never a live receipt edit.
  const db = new DatabaseSync(runtimeDatabasePath(f.root));
  const row = db.prepare("SELECT receipt_json FROM release_step_receipts WHERE operation_id='original' AND generation=2 AND step_id='compose'").get();
  const corrupt = JSON.parse(row.receipt_json);corrupt.input.authorization.fingerprint = "foreign";
  db.prepare("UPDATE release_step_receipts SET receipt_json=? WHERE operation_id='original' AND generation=2 AND step_id='compose'").run(JSON.stringify(corrupt));db.close();
  const saved = f.store.snapshot("original").receipts;
  await f.scheduled.shift()(); await f.service.drain("original");
  assert.equal(f.store.get("original").currentGeneration, 1);assert.equal(f.store.generation("original", 3), null);
  assert.deepEqual(f.store.snapshot("original").receipts, saved);
});

test("partial generation amendment rechecks target effects before admitting its fresh generation", async t => {
  const f = await failedPartialReceiptFixture(t), current = f.store.get("original");
  const result = await f.service.continue("original", { requestId: "fresh-target-before-compose", testSelection: selection("none"),
    expectedRevision: current.revision, expectedGeneration: 1 });
  assert.equal(result.accepted, true);assert.equal(result.amendment.composeRecovery.nextGeneration, 3);
  const receipts = f.store.snapshot("original").receipts;
  f.service.readTarget = async () => ({ status: "unknown" });
  await f.scheduled.shift()();await f.service.drain("original");
  assert.equal(f.store.get("original").currentGeneration, 1);
  assert.equal(f.store.get("original").waitReason.code, "external_effect_readback");
  assert.deepEqual(f.store.snapshot("original").receipts, receipts);
  assert.equal(f.store.generation("original", 3), null);
});


test("partial generation amendment retains an unrelated registered next slot instead of adopting it", async t => {
  const f = await failedPartialReceiptFixture(t), current = f.store.get("original");
  assert.equal((await f.service.continue("original", { requestId: "no-foreign-generation", testSelection: selection("none"),
    expectedRevision: current.revision, expectedGeneration: 1 })).accepted, true);
  const first = f.store.generation("original", 1);
  const foreign = f.store.putGeneration({ ...first, generation: 3, testSelectionAmendmentId: "foreign-amendment",
    testPlans: first.candidates.map(candidate => ({ repositoryRoot: candidate.repositoryRoot, plan: resolveTestSelection(selection("none"), inventory) })) }).generation;
  const receipts = f.store.snapshot("original").receipts;
  await f.scheduled.shift()();await f.service.drain("original");
  assert.equal(f.store.get("original").currentGeneration, 1);
  assert.deepEqual(f.store.generation("original", 3), foreign);
  assert.deepEqual(f.store.snapshot("original").receipts, receipts);
});

test("partial generation amendment recovers its exact registered candidate after a lost compose reply", async t => {
  const f = await failedPartialReceiptFixture(t), current = f.store.get("original");
  const amended = await f.service.continue("original", { requestId: "exact-registered-generation", testSelection: selection("none"),
    expectedRevision: current.revision, expectedGeneration: 1 });
  assert.equal(amended.accepted, true);
  const operation = f.store.get("original");
  const input = { authorization: operation.authorization, authorizedTaskIds: effectiveReleaseTaskIds(operation), priorGeneration: 1,
    testSelection: selection("none"), amendment: amended.amendment.identitySha256 };
  const intent = f.store.beginStep({ operationId: "original", generation: 3, stepId: "compose", input }).receipt;
  const first = f.store.generation("original", 1);
  const original = f.store.putGeneration({ ...first, generation: 3, testSelectionAmendmentId: amended.amendment.identitySha256,
    testPlans: first.candidates.map(candidate => ({ repositoryRoot: candidate.repositoryRoot, plan: resolveTestSelection(selection("none"), inventory) })) }).generation;
  assert.equal(original.testSelectionAmendmentId, amended.amendment.identitySha256);
  f.service.compose = async () => assert.fail("stored exact generation must prevent another composition");
  const reopened = new ReleaseOperationStore({ dataDir: f.root });
  assert.deepEqual(reopened.latestStep("original", 3, "compose"), intent);
  await f.scheduled.shift()();await f.service.drain("original");
  assert.equal(f.store.get("original").currentGeneration, 3);
  assert.deepEqual(f.store.generation("original", 3), original);
  assert.equal(f.store.latestStep("original", 3, "compose").status, "applied");
});

async function sparseRecoveryWait(t, { registered = true } = {}) {
  const f = await failedPartialReceiptFixture(t), initial = f.store.get("original");
  const amended = await f.service.continue("original", { requestId: "sparse-first-recovery", testSelection: selection("none"),
    expectedRevision: initial.revision, expectedGeneration: 1 });
  assert.equal(amended.accepted, true);
  const operation = f.store.get("original");
  const input = { authorization: operation.authorization, authorizedTaskIds: effectiveReleaseTaskIds(operation), priorGeneration: 1,
    testSelection: selection("none"), amendment: amended.amendment.identitySha256 };
  const intent = f.store.beginStep({ operationId: "original", generation: 3, stepId: "compose", input }).receipt;
  const first = f.store.generation("original", 1);
  const candidate = registered ? f.store.putGeneration({ ...first, generation: 3, testSelectionAmendmentId: amended.amendment.identitySha256,
    testPlans: first.candidates.map(candidate => ({ repositoryRoot: candidate.repositoryRoot, plan: resolveTestSelection(selection("none"), inventory) })) }).generation : null;
  f.service.readTarget = async () => ({ status: "unknown" });
  await f.scheduled.shift()();await f.service.drain("original");
  const waiting = f.store.get("original");
  assert.equal(waiting.currentGeneration, 1);assert.equal(waiting.state, "waiting");
  assert.equal(waiting.waitReason.code, "external_effect_readback");
  assert.deepEqual(f.store.latestStep("original", 3, "compose"), intent);
  f.service.readTarget = async () => ({ status: "not_applied" });
  return { ...f, candidate, intent, waiting };
}

test("sparse recovery amendment cannot bypass a stored candidate after its target readback wait", async t => {
  const f = await sparseRecoveryWait(t), before = f.store.snapshot("original");
  let second = null, failure = null;
  try {
    second = await f.service.continue("original", { requestId: "sparse-fresh-amendment", testSelection: selection("none"),
      expectedRevision: f.waiting.revision, expectedGeneration: 1 });
  } catch (error) { failure = error; }
  if (second?.accepted) { await f.scheduled.shift()();await f.service.drain("original"); }
  assert.notEqual(f.store.get("original").currentGeneration, 2, "a fresh amendment must not bypass original candidate3/intent through failed slot2");
  assert.match(failure?.message ?? "", /immutable next generation/u);
  assert.deepEqual(f.store.snapshot("original"), before);
  assert.deepEqual(f.store.generation("original", 3), f.candidate);
  assert.deepEqual(f.store.latestStep("original", 3, "compose"), f.intent);
});

test("sparse recovery amendment cannot bypass an unresolved future intent without a candidate", async t => {
  const f = await sparseRecoveryWait(t, { registered: false }), before = f.store.snapshot("original");
  await assert.rejects(f.service.continue("original", { requestId: "sparse-unregistered-amendment", testSelection: selection("none"),
    expectedRevision: f.waiting.revision, expectedGeneration: 1 }), /original future compose/u);
  assert.deepEqual(f.store.snapshot("original"), before);
  assert.deepEqual(f.store.latestStep("original", 3, "compose"), f.intent);
});

test("sparse recovery same-original continuation settles its candidate before an ordinary later amendment", async t => {
  const f = await sparseRecoveryWait(t);
  assert.equal(f.service.continue("original").accepted, true);
  await f.scheduled.shift()();await f.service.drain("original");
  const settled = f.store.get("original"), receipt = f.store.latestStep("original", 3, "compose");
  assert.equal(settled.currentGeneration, 3);assert.equal(receipt.status, "applied");
  assert.deepEqual(f.store.generation("original", 3), f.candidate);
  const next = await f.service.continue("original", { requestId: "sparse-after-settlement", testSelection: selection("none"),
    expectedRevision: settled.revision, expectedGeneration: 3 });
  assert.equal(next.accepted, true);
  await f.scheduled.shift()();await f.service.drain("original");
  assert.equal(f.store.get("original").currentGeneration, 4);
  assert.deepEqual(f.store.generation("original", 3), f.candidate);
  assert.deepEqual(f.store.latestStep("original", 3, "compose"), receipt);
});
