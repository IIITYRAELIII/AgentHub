import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { ReleaseOperationCommandService } from "../../src/application/release-operation-command-service.mjs";
import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { ReleaseOperationPublication } from "../../src/infrastructure/process/release-operation-publication.mjs";
import { buildArtifact } from "../../src/infrastructure/process/publication-artifacts.mjs";
import { nextRuntimeReleaseVersion } from "../../src/infrastructure/filesystem/runtime-release-version.mjs";
import { createReleaseOperation, createCandidateGeneration, releaseIdentitySha256 } from "../../src/domain/release-operation.mjs";
import * as releaseDomain from "../../src/domain/release-operation.mjs";
import { resolveTestSelection } from "../../src/domain/test-selection.mjs";

const execute = promisify(execFile);
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const git = async (cwd, ...args) => (await execute("git", args, { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();
const json = async file => JSON.parse(await readFile(file, "utf8"));
const writeJson = (file, value) => writeFile(file, `${JSON.stringify(value)}\n`);
const collision = "Original frozen runtime version is no longer available";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-retained-generation-"));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const runtimeRoot = path.join(root, "runtime");
  const previousRuntime = process.env.AGENT_HUB_RUNTIME_ROOT;
  process.env.AGENT_HUB_RUNTIME_ROOT = runtimeRoot;
  t.after(() => {
    if (previousRuntime === undefined) delete process.env.AGENT_HUB_RUNTIME_ROOT;
    else process.env.AGENT_HUB_RUNTIME_ROOT = previousRuntime;
  });
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary);
  await git(primary, "init", "--initial-branch=main");
  await git(primary, "config", "core.autocrlf", "false");
  await mkdir(path.join(primary, "AgentHub"));
  await writeFile(path.join(primary, ".gitattributes"), "* text eol=lf\n");
  await writeFile(path.join(primary, "CHANGELOG.md"), "old\n");
  await writeJson(path.join(primary, "AgentHub/package.json"), { name: "agent-hub", version: "2.1.4" });
  await writeJson(path.join(primary, "AgentHub/package-lock.json"), { name: "agent-hub", version: "2.1.4", packages: { "": { name: "agent-hub", version: "2.1.4" } } });
  await git(primary, "add", "-A");
  await git(primary, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "tiny accepted input");
  const origin = path.join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin);
  await git(primary, "push", "--set-upstream", "origin", "main");
  const baseCommit = await git(primary, "rev-parse", "HEAD");
  const operationId = randomUUID(), generationNumber = 7;
  const notes = Buffer.from("one immutable consolidated release entry\n");
  const notesFile = path.join(root, "notes.md");
  await writeFile(notesFile, notes);
  const metadata = { sourcePath: notesFile, byteLength: notes.length, rawSha256: sha(notes), canonicalSha256: sha(notes) };
  const selected = [{ taskId: "accepted-task", resultCommit: baseCommit, acceptanceRevision: 3 }];
  const frozenTasks = [{ taskId: "accepted-task", resultCommit: baseCommit, taskRevision: 3 }];
  const releaseGit = new ReleaseGitWorkspaceService({ dataDir, environment: process.env });
  await releaseGit.prepareCandidate({ projectRoot: primary, workspaceId: "workspace", planRevision: "plan", approvedBaseCommit: baseCommit, frozenTasks });
  const frozen = await releaseGit.prepareGeneration({ operationId, generation: generationNumber, workspaceId: "workspace",
    projectRoot: primary, planRevision: "plan", approvedBaseCommit: baseCommit, frozenTasks,
    releaseVersion: "2.1.5", changelogContent: notes });
  const target = { targetId: "publication", kind: "agent-hub-publication", repositoryRoot: primary, environment: "production" };
  const testPlan = resolveTestSelection({ mode: "none", ids: [] }, ["tiny-core", "check:worker", "check:release-candidate"]);
  const authorization = { taskIds: ["accepted-task"], taskScope: "all_await", approvedTargets: [target], validationMode: "full",
    testSelection: { mode: "none", ids: [] }, releaseVersion: "2.1.5", releaseMetadata: metadata };
  const seed = createReleaseOperation({ operationId, requestId: "original", workspaceId: "workspace", streamId: "rm", threadId: "rm-thread",
    authorization, runnerVersion: "test", createdAt: new Date().toISOString() });
  const amendmentContents = { requestId: "saved-generation7-amendment", priorRevision: 1, priorGeneration: 6,
    authorizationFingerprint: seed.authorization.fingerprint, selection: { mode: "none", ids: [] }, taskIds: ["accepted-task"],
    taskScope: "all_await", taskSelection: selected, releaseMetadata: metadata,
    readbacks: [{ targetId: target.targetId, generation: 6, evidence: { status: "not_applied" } }] };
  const amendment = { ...amendmentContents, identitySha256: releaseIdentitySha256(amendmentContents) };
  const candidate = { repositoryRoot: primary, releaseRoot: frozen.releaseRoot, commit: frozen.preReleaseHead, tree: frozen.tree,
    generationRoot: frozen.generationRoot, manifestHash: frozen.manifestHash, manifest: frozen.manifest,
    planRevision: frozen.planRevision, baseCommit, frozenTasks };
  const generation = createCandidateGeneration({ operationId, generation: generationNumber, supersedesGeneration: 6,
    repositoryBases: [{ repositoryRoot: primary, baseCommit }],
    selectedResults: selected, candidates: [candidate], runnerVersion: "test", createdAt: new Date().toISOString(),
    authorizedTaskIds: ["accepted-task"], testPlans: [{ repositoryRoot: primary, plan: testPlan }], testSelectionAmendmentId: amendment.identitySha256 });
  await mkdir(path.join(root, "journal"));
  const store = new ReleaseOperationStore({ dataDir: path.join(root, "journal"), idFactory: () => operationId });
  store.create({ ...seed, state: "publish", currentGeneration: 7, selectedResults: selected, testSelectionAmendments: [amendment] });
  store.putGeneration(generation);
  const finish = (stepId, input, status, effect, error) => {
    const receipt = store.beginStep({ operationId, generation: 7, stepId, input }).receipt;
    store.finishStep(receipt, { status, effect, error });
  };
  finish("compose", { authorization: seed.authorization, authorizedTaskIds: ["accepted-task"], priorGeneration: 6,
    testSelection: { mode: "none", ids: [] }, amendment: amendment.identitySha256 }, "applied", { identitySha256: generation.identitySha256 });
  finish("validate", { candidate: generation.identitySha256, mode: "full", testPlans: generation.testPlans }, "applied", { status: "ready" });
  finish(`publish:${target.targetId}`, { candidate: generation.identitySha256, target }, "failed", { status: "not_applied" }, "extension planning failed");
  store.transition(operationId, { state: "waiting", currentStep: "publish", resumeState: "validate", waitReason: { code: "validation_failed" } });
  const runtimePublication = { operationId, generation: 7, sourceCommit: candidate.commit, version: frozen.manifest.publication.runtimeReleaseVersion };
  const artifactIdentity = { revision: candidate.commit, sourceRoot: path.join(candidate.releaseRoot, "AgentHub"), runtimeRoot, protocol: 1, runtimePublication };
  const key = sha(JSON.stringify(artifactIdentity)).slice(0, 32), releaseId = `publication-${key}`;
  const body = path.join(runtimeRoot, "releases", releaseId);
  await mkdir(body, { recursive: true });
  const packageBytes = Buffer.from(JSON.stringify({ name: "agent-hub", version: "2.1.5" }));
  await writeFile(path.join(body, "package.json"), packageBytes);
  const buildNumber = Number(runtimePublication.version.split("+build.")[1]);
  const runtimeManifest = { releaseId, version: "2.1.5", releaseVersion: runtimePublication.version,
    versionScheme: "semver-build-v1", publicVersion: "2.1.5", buildNumber, sourceRoot: artifactIdentity.sourceRoot,
    publicationRevision: candidate.commit, files: [{ path: "package.json", bytes: packageBytes.length, sha256: sha(packageBytes) }] };
  await writeJson(path.join(body, "runtime-manifest.json"), runtimeManifest);
  const manifestHash = sha(await readFile(path.join(body, "runtime-manifest.json")));
  const receipt = { schema: 1, phase: "PREPARED", ...runtimePublication, releaseId, releaseRoot: body, manifestSha256: manifestHash };
  const artifact = await buildArtifact(path.join(runtimeRoot, "publication-artifacts", key, "runtime"), artifactIdentity,
    async output => { await writeJson(path.join(output, "prepared-runtime.json"), receipt); return { releaseId, manifestHash }; });
  const execution = path.join(dataDir, "release-operation-executions", sha(`${operationId}:7:${target.targetId}`));
  await mkdir(execution, { recursive: true });
  const tool = { name: "fixture-tool", version: "0.1.1", sha256: "a".repeat(64) };
  const runner = { operationId, generation: 7, targetId: target.targetId, candidate: generation.identitySha256,
    status: "exited", exitCode: 1, pid: 123456789, tool };
  await writeJson(path.join(execution, "runner.json"), runner);
  const run = { status: "failed", identity: { revision: candidate.commit, worktreeRoot: candidate.releaseRoot, runtimeRoot, testPlan },
    progress: { artifactHashes: { runtime: sha(JSON.stringify(artifact)) } },
    steps: [{ label: "Подготовка артефактов публикации", status: "failed" }, { label: "Публикация Git", status: "pending" },
      { label: "Установка runtime-релиза", status: "pending" }] };
  await writeJson(path.join(execution, "publication-status.json"), run);
  const runnerFile = path.join(root, "controlled-publication-runner.mjs");
  const installationModule = new URL("../../src/infrastructure/filesystem/runtime-installation-custody.mjs", import.meta.url).href;
  await writeFile(runnerFile, `import {writeFile} from 'node:fs/promises';
    import path from 'node:path';
    import {withRuntimeInstallationLease} from ${JSON.stringify(installationModule)};
    await withRuntimeInstallationLease(process.env.AGENT_HUB_RUNTIME_ROOT,async()=>{
      await writeFile(path.join(process.env.AGENT_HUB_RELEASE_EXECUTION_ROOT,'result.json'),JSON.stringify({
        operationId:process.env.AGENT_HUB_RELEASE_OPERATION_ID,generation:Number(process.env.AGENT_HUB_RELEASE_GENERATION),
        targetId:process.env.AGENT_HUB_RELEASE_TARGET_ID,candidate:process.env.AGENT_HUB_RELEASE_CANDIDATE_IDENTITY,
        status:'applied',leaseVerified:true,revision:${JSON.stringify(candidate.commit)},tool:${JSON.stringify(tool)}}));
    });`);
  let selectedResults = selected, readback = "not_applied", publications = 0, compositions = 0;
  let childJoined = Promise.resolve();
  const publication = new ReleaseOperationPublication({ dataDir, runtimeRoot,
    runnerFile, readPublicationStateImpl: async () => null, gitRemoteHeadImpl: async () => baseCommit,
    spawnImpl: (...args) => {
      const [command, argsList, options] = args;
      const child = spawn(command, argsList, { ...options, timeout: 30_000 });
      childJoined = new Promise(resolve => child.once("close", resolve));
      return child;
    },
    processAliveImpl: () => false, readToolPackage: async () => ({ ...tool, assertUnchanged: async () => {} }),
    publicationRunStoreFactory: () => ({ read: () => json(path.join(execution, "publication-status.json")) }) });
  const preflight = { releaseGitWorkspaces: releaseGit, withAwaitTransition: async (_id, callback) => callback(),
    operationSelection: async () => selectedResults, prepareOperationGeneration: async () => assert.fail("no new Git generation"),
    validateOperationGeneration: async () => ({ status: "ready" }) };
  const adapter = new WorkspaceReleaseOperationAdapter({ releasePreflight: preflight, publication, finalization: { finalize() {} } });
  const service = new ReleaseOperationService({ store, processAlive: () => false,
    resolveTestPlans: async () => generation.testPlans,
    withTaskSelection: input => adapter.withTaskSelection(input), withRetainedGeneration: input => adapter.withRetainedGeneration(input),
    reservePublication: input => adapter.reservePublication(input),
    compose: async () => {
      compositions++;
      const allocated = await nextRuntimeReleaseVersion({ releasesDir: path.join(runtimeRoot, "releases"), packageVersion: "2.1.5", allocationFloor: buildNumber - 1 });
      assert.notEqual(allocated, runtimePublication.version, "real retained body occupies the frozen allocation");
      throw new Error(collision);
    }, validate: async () => assert.fail("the original applied validation is reused"),
    readTarget: async () => typeof readback === "function" ? readback() : { status: readback },
    publishTarget: async input => {
      const effect = await publication.publish(input);
      await childJoined;
      publications++;
      return effect;
    }, finalize: async () => ({ status: "complete" }) });
  const command = new ReleaseOperationCommandService({ releaseOperations: service,
    workspaceCatalog: { workspace() {}, hierarchy() {} }, taskBoard: { task() {}, releaseTasks() {} } });
  const amendmentAck = await command.continue({ operationId, requestId: "failed-next-compose", expectedGeneration: 7,
    expectedRevision: store.get(operationId).revision, taskScope: "all_await", taskIds: ["accepted-task"],
    testSelection: { mode: "none", ids: [] }, releaseMetadata: metadata });
  assert.equal(amendmentAck.accepted, true);
  await service.drain(operationId);
  assert.equal(store.get(operationId).state, "failed");
  assert.equal(store.get(operationId).lastError.message, collision);
  assert.equal(compositions, 1);
  const request = { operationId, requestId: "addressed-retained-recovery", expectedGeneration: 7, expectedRevision: store.get(operationId).revision };
  return { root, primary, notesFile, body, execution, candidate, generation, store, command, service, request,
    publication, adapter, run, runner, selected, releaseId, metadata, releaseGit,
    setSelection: value => { selectedResults = value; }, setReadback: value => { readback = value; },
    counts: () => ({ publications, compositions }) };
}

test("public continue reuses the original real Git frozen allocation after a terminal later compose failure", async t => {
  const f = await fixture(t);
  const before = f.store.snapshot(f.request.operationId);
  const checkpoint = await readFile(path.join(f.candidate.releaseRoot, "..", "checkpoint.json"));
  const artifact = await readFile(path.join(f.body, "runtime-manifest.json"));
  const ack = await f.command.continue(f.request);
  assert.equal(ack.accepted, true, "parent refused terminal instead of recovering the original prepared generation");
  await f.service.drain(f.request.operationId);
  assert.equal(f.store.get(f.request.operationId).state, "done");
  assert.equal((await json(path.join(f.execution, "result.json"))).leaseVerified, true,
    "the child acquires its own real installation lease before completing");
  assert.deepEqual(f.counts(), { publications: 1, compositions: 1 });
  const after = new ReleaseOperationStore({ dataDir: path.join(f.root, "journal") }).snapshot(f.request.operationId);
  assert.deepEqual(after.generations, before.generations);
  assert.equal(after.operation.currentGeneration, 7);
  assert.equal(after.operation.retainedGenerationRecoveries.length, 1);
  for (const receipt of before.receipts) assert.deepEqual(after.receipts.find(item => item.generation === receipt.generation
    && item.stepId === receipt.stepId && item.attempt === receipt.attempt), receipt);
  assert.equal(after.receipts.filter(item => item.generation === 7 && item.stepId === "publish:publication").length, 2);
  assert.deepEqual(await readFile(path.join(f.candidate.releaseRoot, "..", "checkpoint.json")), checkpoint);
  assert.deepEqual(await readFile(path.join(f.body, "runtime-manifest.json")), artifact);
  assert.equal(await git(f.candidate.releaseRoot, "rev-parse", "HEAD"), f.candidate.commit);
  const duplicate = await f.command.continue(f.request);
  assert.equal(duplicate.duplicate, true);
  assert.deepEqual(f.counts(), { publications: 1, compositions: 1 });
  assert.throws(() => f.command.continue({ ...f.request, expectedRevision: f.request.expectedRevision + 1 }), /request changed/u);
});

for (const mutation of ["payload", "pointer"]) {
  test(`retained publication rejects late ${mutation} mutation before spawning its child`, async t => {
    const f = await fixture(t);
    const before = f.store.snapshot(f.request.operationId);
    let changed = false;
    let spawned = 0;
    const originalReadback = f.publication.readback.bind(f.publication);
    const originalSpawn = f.publication.spawnImpl;
    f.publication.spawnImpl = (...args) => { spawned++; return originalSpawn(...args); };
    f.publication.readback = async input => {
      if (!changed) {
        changed = true;
        if (mutation === "payload") await writeFile(path.join(f.body, "package.json"), "changed during prelaunch readback\n");
        else await writeJson(path.join(path.dirname(f.body), "..", "current.json"), { current: f.releaseId });
      }
      return originalReadback(input);
    };
    const ack = await f.command.continue(f.request);
    assert.equal(ack.accepted, true);
    await f.service.drain(f.request.operationId);
    assert.equal(changed, true);
    assert.equal(spawned, 0, "the final retained proof refuses before spawn");
    const after = f.store.snapshot(f.request.operationId);
    assert.notEqual(after.operation.state, "done");
    assert.equal(after.operation.currentGeneration, 7);
    assert.deepEqual(after.generations, before.generations);
    for (const receipt of before.receipts) assert.deepEqual(after.receipts.find(item => item.generation === receipt.generation
      && item.stepId === receipt.stepId && item.attempt === receipt.attempt), receipt);
    assert.equal((await json(path.join(f.execution, "runner.json"))).status, "launch_failed");
    assert.equal((await originalReadback({ operation: after.operation, generation: f.generation,
      target: after.operation.authorization.approvedTargets[0] })).status, "not_applied");
    assert.equal(after.receipts.filter(item => item.stepId === "publish:publication").at(-1).status, "failed");
  });
}

test("retained recovery refuses changed current inputs, payload, tool, effect, receipts and CAS", async t => {
  const f = await fixture(t);
  const original = f.store.snapshot(f.request.operationId);
  const unchanged = async action => {
    await assert.rejects(action);
    assert.deepEqual(f.store.snapshot(f.request.operationId), original);
    assert.equal(f.counts().publications, 0);
  };
  assert.equal((await f.command.continue({ ...f.request, expectedRevision: f.request.expectedRevision - 1 })).accepted, false);
  f.setSelection([{ ...f.selected[0], resultCommit: "f".repeat(40) }]);
  await unchanged(() => f.command.continue(f.request));
  f.setSelection(f.selected);
  for (const effect of ["unknown", "partial", "applied"]) {
    f.setReadback(effect);
    await unchanged(() => f.command.continue(f.request));
  }
  f.setReadback("not_applied");
  const pointerFile = path.join(path.dirname(f.body), "..", "current.json");
  f.setReadback(async () => {
    await writeJson(pointerFile, { previous: f.releaseId });
    return { status: "not_applied" };
  });
  await unchanged(() => f.command.continue(f.request));
  await rm(pointerFile);
  f.setReadback("not_applied");
  const packageFile = path.join(f.body, "package.json"), packageBytes = await readFile(packageFile);
  await writeFile(packageFile, "changed");
  await unchanged(() => f.command.continue(f.request));
  await writeFile(packageFile, packageBytes);
  await writeFile(f.notesFile, "changed notes");
  await unchanged(() => f.command.continue(f.request));
  await writeFile(f.notesFile, "one immutable consolidated release entry\n");
  const runnerFile = path.join(f.execution, "runner.json");
  await writeJson(runnerFile, { ...f.runner, tool: { ...f.runner.tool, sha256: "b".repeat(64) } });
  await unchanged(() => f.command.continue(f.request));
  await writeJson(runnerFile, f.runner);
  await writeFile(path.join(f.candidate.releaseRoot, "foreign-work.txt"), "retain");
  await unchanged(() => f.command.continue(f.request));
  await rm(path.join(f.candidate.releaseRoot, "foreign-work.txt"));
  await writeJson(path.join(path.dirname(f.body), "..", "current.json"), { current: f.releaseId });
  await unchanged(() => f.command.continue(f.request));
  await rm(path.join(path.dirname(f.body), "..", "current.json"));
  const changed = structuredClone(original);
  changed.receipts.find(item => item.generation === 8).status = "unknown";
  assert.equal(releaseDomain.retainedGenerationRecovery(changed), null);
  changed.receipts.find(item => item.generation === 8).status = "failed";
  changed.generations.push({ ...changed.generations[0], generation: 8 });
  assert.equal(releaseDomain.retainedGenerationRecovery(changed), null);
  for (const mutate of [
    value => { value.operation.owner = { ownerId: "live" }; },
    value => { value.operation.testSelectionAmendments.at(-1).selection = { mode: "all", ids: [] }; },
    value => { value.operation.testSelectionAmendments.at(-1).releaseMetadata.rawSha256 = "f".repeat(64); },
    value => { value.receipts.find(item => item.stepId === "publish:publication").effect.status = "partial"; },
  ]) {
    const refused = structuredClone(original);
    mutate(refused);
    assert.equal(releaseDomain.retainedGenerationRecovery(refused), null);
  }
  const boundary = releaseDomain.retainedGenerationRecovery(original);
  assert.ok(boundary);
  const late = f.store.beginStep({ operationId: f.request.operationId, generation: 8, stepId: "compose", input: { changed: true } }).receipt;
  f.store.finishStep(late, { status: "unknown", error: "ambiguous original" });
  const contents = { requestId: "forged-stale-proof", operationId: f.request.operationId, priorRevision: original.operation.revision,
    generation: 7, authorizationFingerprint: original.operation.authorization.fingerprint, boundary, evidence: [],
    priorFailure: { completedAt: original.operation.completedAt, error: original.operation.lastError } };
  assert.throws(() => f.store.transition(f.request.operationId, { state: "publish" }, {
    expectedRevision: original.operation.revision, retainedRecovery: { ...contents, identitySha256: releaseIdentitySha256(contents) },
  }), /failed receipts/u);
});
