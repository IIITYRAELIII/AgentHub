import { releasePublicationPlatform } from "../../../src/composition/release-tooling-composition.mjs";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";
import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationService } from "../../../src/application/release-operation-service.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
const execute = promisify(execFile);
const sha = body => createHash("sha256").update(body).digest("hex");
const runner = fileURLToPath(new URL("../../../release-operation-publication-runner.mjs", import.meta.url));

// A controlled second product, not another platform branch or an application
// runtime substitute. It produces a real file and addressed receipt through
// the exact same pinned-recipe loader and existing publication runner CLI.
const recipeBody = `import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export const releaseRecipeApiVersion = 1;
export const metadataPaths = [];
export const inspectMetadata = async () => ({ version: "1.0.0", writes: [], changed: false });
export const prepareAuthorization = value => ({recipe:{apiVersion:1,id:"tiny-project",configuration:{environments:value.approvedTargets.map(target=>target.environment)},targetOrder:value.approvedTargets.map(target=>target.targetId)}});
export async function executePublication(input, platform) {
  if (platform.apiVersion !== 1) throw new Error("platform differs");
  const target = input.operation.authorization.approvedTargets.find(target=>target.targetId===input.targetId);
  if (target?.kind !== "tiny-project") throw new Error("foreign product");
  const body = await readFile(path.join(input.candidate.releaseRoot, "project.txt"));
  const digest = createHash("sha256").update(body).digest("hex");
  const effect = {status:"applied",operationId:input.operation.operationId,generation:input.generation.generation,
    targetId:input.targetId,candidate:input.generation.identitySha256,revision:input.candidate.commit,sha256:digest};
  const file=path.join(input.executionRoot,"result.json");
  const saved=await readFile(file,"utf8").catch(error=>{if(error.code==="ENOENT")return null;throw error;});
  if(saved){if(JSON.stringify(JSON.parse(saved))!==JSON.stringify(effect))throw new Error("original differs");return JSON.parse(saved);}
  await writeFile(path.join(input.executionRoot,"artifact.txt"),body,{flag:"wx"});
  await writeFile(file,JSON.stringify(effect),{flag:"wx"});
  return effect;
}
export function createPublicationOwner(options,platform){return{
  publish:input=>executePublication({...input,executionRoot:options.executionRoot,targetId:input.target.targetId},platform),
  readback:()=>readFile(path.join(options.executionRoot,"result.json"),"utf8").then(JSON.parse),
};}
`;

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-recipe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const toolRoot = path.join(root, "tool"), candidate = path.join(root, "candidate"), executionRoot = path.join(root, "execution");
  for (const directory of [toolRoot, candidate, executionRoot]) await mkdir(directory);
  await writeFile(path.join(candidate, "project.txt"), "controlled game-like project output\n");
  const files = ["package.json", "export-manifest.json", "recipe.mjs"];
  await writeFile(path.join(toolRoot, "package.json"), JSON.stringify({ name: "controlled-project-recipe", version: "1.0.0", type: "module",
    releaseRecipe: { apiVersion: 1, module: "recipe.mjs" } }));
  await writeFile(path.join(toolRoot, "export-manifest.json"), JSON.stringify({ apiVersion: 1, files }));
  await writeFile(path.join(toolRoot, "recipe.mjs"), recipeBody);
  const rows = [];
  for (const file of [...files].sort()) { const bytes = await readFile(path.join(toolRoot, file)); rows.push({ path: file, bytes: bytes.length, sha256: sha(bytes) }); }
  const pin = sha(JSON.stringify(rows));
  const environment = { ...process.env, AGENT_HUB_RELEASE_TOOLS_ROOT: toolRoot, AGENT_HUB_RELEASE_TOOLS_SHA256: pin };
  const target = { targetId: "project-output", kind: "tiny-project", repositoryRoot: candidate, environment: "controlled-artifact" };
  return { root, toolRoot, candidate, executionRoot, pin, environment, target };
}

test("one generic publication adapter executes a non-Hub product and refuses changed executor bytes", async t => {
  const f = await fixture(t);
  const operation = { operationId: "controlled-project", authorization: { approvedTargets: [f.target] } };
  const candidate = { releaseRoot: f.candidate, commit: "a".repeat(40) };
  const generation = { generation: 1, identitySha256: "b".repeat(64) };
  const owner = new ReleaseOperationPublication({ platform: releasePublicationPlatform(), environment: f.environment, executionRoot: f.executionRoot });
  const result = await owner.publish({ operation, generation, candidate, target: f.target });
  assert.equal(result.status, "applied");
  assert.equal(await readFile(path.join(f.executionRoot, "artifact.txt"), "utf8"), "controlled game-like project output\n");
  assert.deepEqual(await owner.readback({ operation, generation, target: f.target }), result);
  await writeFile(path.join(f.toolRoot, "recipe.mjs"), `${recipeBody}\n// changed executor\n`);
  await assert.rejects(owner.readback({ operation, generation, target: f.target }), /pinned version/);
});

test("the real existing runner CLI reads its canonical generation and executes a second product without AgentHub layout", async t => {
  const f = await fixture(t), dataDir = path.join(f.root, "data");
  await mkdir(dataDir);
  const store = new ReleaseOperationStore({ dataDir });
  const { operation } = store.create({ requestId: "controlled-project-original", workspaceId: "fixture-workspace",
    streamId: "fixture-stream", threadId: "fixture-thread", runnerVersion: "fixture",
    authorization: { taskIds: ["fixture-task"], validationMode: "focused", approvedTargets: [f.target] } });
  const { generation } = store.putGeneration({ operationId: operation.operationId, generation: 1, runnerVersion: "fixture",
    repositoryBases: [{ repositoryRoot: f.candidate, baseCommit: "a".repeat(40) }],
    selectedResults: [{ taskId: "fixture-task", resultCommit: "a".repeat(40), acceptanceRevision: 1 }],
    candidates: [{ repositoryRoot: f.candidate, releaseRoot: f.candidate, commit: "a".repeat(40),
      tree: "b".repeat(40), manifestHash: "c".repeat(64) }] });
  await writeFile(path.join(f.executionRoot, "runner.json"), JSON.stringify({ toolPackage: { retainedFixture: true } }));
  const env = { ...f.environment, AGENT_HUB_DATA_DIR: dataDir, AGENT_HUB_RUNTIME_ROOT: path.join(f.root, "runtime"),
    AGENT_HUB_RELEASE_OPERATION_ID: operation.operationId, AGENT_HUB_RELEASE_GENERATION: "1",
    AGENT_HUB_RELEASE_TARGET_ID: f.target.targetId, AGENT_HUB_RELEASE_EXECUTION_ROOT: f.executionRoot,
    AGENT_HUB_RELEASE_RUNNER_STARTED_AT: new Date().toISOString(), AGENT_HUB_RELEASE_CANDIDATE_IDENTITY: generation.identitySha256 };
  const result = await execute(process.execPath, ["--no-warnings", runner], { cwd: f.candidate, env, encoding: "utf8", windowsHide: true });
  assert.equal(result.stderr, "");
  const effect = JSON.parse(await readFile(path.join(f.executionRoot, "result.json"), "utf8"));
  assert.equal(effect.candidate, generation.identitySha256);
  assert.equal(effect.operationId, operation.operationId);
  assert.equal(effect.status, "applied");
  assert.deepEqual(JSON.parse(await readFile(path.join(f.executionRoot, "runner.json"), "utf8")).toolPackage, { retainedFixture: true });
  assert.equal(store.get(operation.operationId).revision, operation.revision);
  assert.deepEqual(store.generation(operation.operationId, 1), generation);
});

test("canonical intake evaluates the loaded recipe on fresh SQL authority and replays the original without another policy load", async t => {
  const f = await fixture(t), dataDir = path.join(f.root, "data"); await mkdir(dataDir);
  const store = new ReleaseOperationStore({ dataDir }), scheduled = [];
  const publication = new ReleaseOperationPublication({ platform: releasePublicationPlatform(), environment: f.environment, executionRoot: f.executionRoot });
  let loads = 0, freshTarget = f.target;
  const noEffect = () => assert.fail("intake fixture must not execute a release effect");
  const service = new ReleaseOperationService({ store, compose: noEffect, validate: noEffect,
    publishTarget: noEffect, readTarget: noEffect, finalize: noEffect, processAlive: () => false,
    schedule: action => scheduled.push(action), loadAuthorizationPolicy: async () => {
      loads++; freshTarget = { ...f.target, targetId: "fresh-output", environment: "fresh-approved-environment" };
      return publication.loadAuthorizationPolicy();
    } });
  const authorization = { taskIds: ["fixture-task"], validationMode: "focused", approvedTargets: [f.target] };
  const args = { requestId: "same-project-original", workspaceId: "fixture-workspace", streamId: "fixture-stream",
    threadId: "fixture-thread", authorization,
    resolveAuthorization: original => original?.authorization ?? { ...authorization, approvedTargets: [freshTarget] } };
  const result = await service.start(args), saved = store.get(result.operationId);
  assert.deepEqual(saved.authorization.recipe.targetOrder, ["fresh-output"]);
  assert.deepEqual(saved.authorization.recipe.configuration.environments, ["fresh-approved-environment"]);
  assert.equal(saved.authorization.recipe.id, "tiny-project");
  assert.equal(saved.authorization.recipe.executor.sha256, f.pin);
  assert.equal(loads, 1); assert.equal(scheduled.length, 1);
  await writeFile(path.join(f.toolRoot, "recipe.mjs"), "changed executor must not be loaded on original readback");
  const replay = await service.start(args);
  assert.equal(replay.operationId, result.operationId); assert.equal(replay.created, false);
  assert.equal(loads, 1); assert.equal(scheduled.length, 1);
  assert.deepEqual(store.get(result.operationId), saved);
});

test("a recipe policy refusal leaves canonical intake and scheduling untouched", async t => {
  const f = await fixture(t), dataDir = path.join(f.root, "data"); await mkdir(dataDir);
  const store = new ReleaseOperationStore({ dataDir }), scheduled = [];
  const noEffect = () => assert.fail("refused intake cannot execute an effect");
  const service = new ReleaseOperationService({ store, compose: noEffect, validate: noEffect,
    publishTarget: noEffect, readTarget: noEffect, finalize: noEffect, processAlive: () => false,
    schedule: action => scheduled.push(action), loadAuthorizationPolicy: async () => () => { throw new Error("foreign recipe authority"); } });
  await assert.rejects(service.start({ requestId: "refused-original", workspaceId: "fixture-workspace", streamId: "stream", threadId: "thread",
    authorization: { taskIds: ["fixture-task"], validationMode: "focused", approvedTargets: [f.target] } }), /foreign recipe authority/);
  assert.equal(store.getByRequest("fixture-workspace", "refused-original"), null);
  assert.deepEqual(scheduled, []);
});

test("the same prepared and frozen owner accepts another product without Hub package metadata", async t => {
  const f = await fixture(t);
  const git = async (cwd, ...args) => (await execute("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8" })).stdout.trim();
  const origin = path.join(f.root, "origin.git");
  await git(f.root, "init", "--bare", "--initial-branch=main", origin);
  await git(f.candidate, "init", "--initial-branch=main");
  await writeFile(path.join(f.candidate, "CHANGELOG.md"), "previous project notes\n");
  await git(f.candidate, "add", ".");
  await git(f.candidate, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "tiny project");
  await git(f.candidate, "remote", "add", "origin", origin); await git(f.candidate, "push", "-u", "origin", "main");
  const owner = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "generic-data") });
  const prepared = await owner.prepareCandidate({ projectRoot: f.candidate, workspaceId: "tiny-workspace",
    planRevision: "tiny-plan", frozenTasks: [], approvedBaseCommit: await git(f.candidate, "rev-parse", "HEAD") });
  const before = { root: process.env.AGENT_HUB_RELEASE_TOOLS_ROOT, pin: process.env.AGENT_HUB_RELEASE_TOOLS_SHA256 };
  process.env.AGENT_HUB_RELEASE_TOOLS_ROOT = f.toolRoot; process.env.AGENT_HUB_RELEASE_TOOLS_SHA256 = f.pin;
  try {
    const notes = Buffer.from("controlled tiny project notes\n");
    await writeFile(path.join(prepared.releaseRoot, "CHANGELOG.md"), notes);
    const input = { projectRoot: f.candidate, workspaceId: "tiny-workspace", expectedPlanRevision: "tiny-plan",
      expectedPreparedHead: prepared.preReleaseHead, changelogContent: notes, expectedVersion: "1.0.0",
      runtimeRoot: path.join(f.root, "unused-product-runtime") };
    const policy = await new ReleaseOperationPublication({ platform: releasePublicationPlatform(), environment: f.environment }).loadAuthorizationPolicy();
    const expectedRecipeExecutor = policy({ approvedTargets: [f.target] }).recipe.executor;
    await assert.rejects(owner.freezePublicationCandidate({ ...input,
      expectedRecipeExecutor: { ...expectedRecipeExecutor, sha256: "0".repeat(64) } }), /original authority/);
    const frozen = await owner.freezePublicationCandidate({ ...input, expectedRecipeExecutor });
    const manifest = JSON.parse(await readFile(frozen.manifestFile, "utf8"));
    assert.equal(manifest.publication.releaseVersion, "1.0.0");
    assert.equal(manifest.publication.runtimeReleaseVersion, null);
    assert.deepEqual(manifest.publication.recipeExecutor, expectedRecipeExecutor);
    assert.equal(await readFile(path.join(frozen.releaseRoot, "project.txt"), "utf8"), "controlled game-like project output\n");
    const retained = await readFile(frozen.manifestFile);
    await assert.rejects(owner.freezePublicationCandidate({ ...input, expectedVersion: "2.0.0" }), /original frozen intent/);
    assert.deepEqual(await readFile(frozen.manifestFile), retained);
    const changed = await fixture(t);
    process.env.AGENT_HUB_RELEASE_TOOLS_ROOT = changed.toolRoot;
    process.env.AGENT_HUB_RELEASE_TOOLS_SHA256 = changed.pin;
    await assert.rejects(owner.freezePublicationCandidate({ ...input, expectedRecipeExecutor }), /original authority/);
    assert.deepEqual(await readFile(frozen.manifestFile), retained);
  } finally {
    for (const [key, value] of [["AGENT_HUB_RELEASE_TOOLS_ROOT", before.root], ["AGENT_HUB_RELEASE_TOOLS_SHA256", before.pin]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Agent Hub recipe keeps public-package target ordering and refuses missing or foreign authority at canonical intake", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-recipe-intake-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data"); await mkdir(dataDir);
  const store = new ReleaseOperationStore({ dataDir }), scheduled = [];
  const publication = new ReleaseOperationPublication({ platform: releasePublicationPlatform(), dataDir, runtimeRoot: path.join(root, "runtime") });
  const noEffect = () => assert.fail("policy intake must not run a publication");
  const service = new ReleaseOperationService({ store, compose: noEffect, validate: noEffect,
    publishTarget: noEffect, readTarget: noEffect, finalize: noEffect, processAlive: () => false,
    schedule: action => scheduled.push(action), loadAuthorizationPolicy: () => publication.loadAuthorizationPolicy() });
  const local = { targetId: "local", kind: "agent-hub-publication", repositoryRoot: root, environment: "production" };
  const remote = { ...local, targetId: "agent-hub-github-release", environment: "github-release" };
  const args = { workspaceId: "recipe-workspace", streamId: "stream", threadId: "thread" };
  await assert.rejects(service.start({ ...args, requestId: "missing-public", authorization: {
    taskIds: ["task"], validationMode: "focused", approvedTargets: [local],
  } }), /public package target/);
  await assert.rejects(service.start({ ...args, requestId: "foreign-product", authorization: {
    taskIds: ["task"], validationMode: "focused", approvedTargets: [{ ...local, kind: "other-product" }],
  } }), /supported publication target kind/);
  assert.equal(store.getByRequest(args.workspaceId, "missing-public"), null);
  assert.equal(store.getByRequest(args.workspaceId, "foreign-product"), null);
  assert.deepEqual(scheduled, []);
  const admitted = await service.start({ ...args, requestId: "paired-original", authorization: {
    taskIds: ["task"], validationMode: "focused", approvedTargets: [local, remote],
  } });
  const saved = store.get(admitted.operationId);
  assert.equal(saved.authorization.recipe.configuration.runtimeInstallation, "public-package-v1");
  assert.deepEqual(saved.authorization.recipe.targetOrder, ["agent-hub-github-release", "local"]);
  assert.equal(saved.authorization.runtimeInstallation, undefined);
  assert.equal(scheduled.length, 1);
});

test("authorized recipe and frozen executor bindings refuse another valid package before product effects", async t => {
  const f = await fixture(t), other = await fixture(t);
  const publication = new ReleaseOperationPublication({ platform: releasePublicationPlatform(), environment: f.environment, executionRoot: f.executionRoot });
  const policy = await publication.loadAuthorizationPolicy();
  const authorization = { approvedTargets: [f.target], ...policy({ approvedTargets: [f.target] }) };
  const candidate = { releaseRoot: f.candidate, commit: "a".repeat(40),
    manifest: { publication: { recipeExecutor: authorization.recipe.executor } } };
  const input = { operation: { operationId: "pinned-original", authorization }, candidate, target: f.target,
    generation: { generation: 1, identitySha256: "b".repeat(64), candidates: [candidate] } };
  const foreign = new ReleaseOperationPublication({ platform: releasePublicationPlatform(), environment: other.environment, executionRoot: f.executionRoot });
  await assert.rejects(foreign.publish(input), /original authority/);
  await assert.rejects(publication.publish({ ...input, generation: { ...input.generation,
    candidates: [{ ...candidate, manifest: { publication: { recipeExecutor: other.pin } } }] } }), /Frozen recipe executor/);
  await assert.rejects(readFile(path.join(f.executionRoot, "artifact.txt")), { code: "ENOENT" });
  assert.equal((await publication.publish(input)).status, "applied");
});

test("a derived recipe does not change direct original replay or grant another target", async t => {
  const f = await fixture(t), dataDir = path.join(f.root, "data"); await mkdir(dataDir);
  const store = new ReleaseOperationStore({ dataDir }), scheduled = [];
  const publication = new ReleaseOperationPublication({ platform: releasePublicationPlatform(), environment: f.environment, executionRoot: f.executionRoot });
  let loads = 0;
  const noEffect = () => assert.fail("intake must not execute a release effect");
  const service = new ReleaseOperationService({ store, compose: noEffect, validate: noEffect,
    publishTarget: noEffect, readTarget: noEffect, finalize: noEffect, processAlive: () => false,
    schedule: action => scheduled.push(action), loadAuthorizationPolicy: async () => { loads++; return publication.loadAuthorizationPolicy(); } });
  const args = { requestId: "direct-original", workspaceId: "fixture-workspace", streamId: "fixture-stream", threadId: "fixture-thread",
    authorization: { taskIds: ["fixture-task"], validationMode: "focused", approvedTargets: [f.target] } };
  const admitted = await service.start(args), before = store.get(admitted.operationId);
  await writeFile(path.join(f.toolRoot, "recipe.mjs"), "unavailable after original admission");
  assert.equal((await service.start(args)).created, false);
  assert.equal(loads, 1); assert.equal(scheduled.length, 1);
  assert.throws(() => service.start({ ...args, authorization: { ...args.authorization,
    approvedTargets: [{ ...f.target, targetId: "foreign-target" }] } }), { name: "TypeError", message: "Invalid release recipe authorization" });
  assert.deepEqual(store.get(admitted.operationId), before);
});

test("recipe policy receives a copy and cannot replace canonical release authority", async t => {
  const f = await fixture(t), dataDir = path.join(f.root, "data"); await mkdir(dataDir);
  const store = new ReleaseOperationStore({ dataDir });
  const noEffect = () => assert.fail("refused policy cannot schedule or execute");
  const authorization = { taskIds: ["fixture-task"], validationMode: "focused", approvedTargets: [f.target] };
  const before = structuredClone(authorization);
  const service = new ReleaseOperationService({ store, compose: noEffect, validate: noEffect,
    publishTarget: noEffect, readTarget: noEffect, finalize: noEffect, schedule: noEffect, processAlive: () => false,
    loadAuthorizationPolicy: async () => authority => { authority.approvedTargets[0].targetId = "foreign-target";
      return { approvedTargets: authority.approvedTargets, recipe: {} }; } });
  await assert.rejects(service.start({ requestId: "authority-refusal", workspaceId: "fixture-workspace",
    streamId: "stream", threadId: "thread", authorization }), /never grant release authority/);
  assert.deepEqual(authorization, before);
  assert.equal(store.getByRequest("fixture-workspace", "authority-refusal"), null);
});
