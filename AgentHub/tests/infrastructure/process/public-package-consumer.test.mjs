import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPublicRuntimeInstaller, readPublishedRuntimePackage, releaseTargetExecutionRoot } from "../../../src/infrastructure/process/public-runtime-installer.mjs";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { publicationRunStore } from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { packageBindingDigest } from "../../../src/infrastructure/filesystem/runtime-package-target.mjs";
import { captureRuntimeReleaseBinding } from "../../../src/infrastructure/filesystem/runtime-installation-custody.mjs";
import { PUBLIC_INSTALLER_HANDOFF } from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { EventEmitter } from "node:events";
import { releaseIdentitySha256 } from "../../../src/domain/release-operation.mjs";
import { resolveTestSelection } from "../../../src/domain/test-selection.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const writeJson = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };

async function unstartedPublicationOwnerFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-zero-"));
  t.after(async () => { assert.equal(path.dirname(root), os.tmpdir()); await rm(root, { recursive: true, force: true }); });
  const primary = path.join(root, "primary"), frozen = path.join(root, "frozen"), runtimeRoot = path.join(root, "runtime");
  const git = async (cwd, ...args) => (await promisify(execFile)("git", args,
    { cwd, windowsHide: true, encoding: "utf8" })).stdout.trim();
  await mkdir(path.join(primary, "AgentHub"), { recursive: true });
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "AgentHub/package.json"), '{"name":"fixture","version":"2.1.6"}\n');
  await git(primary, "add", "-A");
  await git(primary, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "base");
  const base = await git(primary, "rev-parse", "HEAD");
  await git(primary, "remote", "add", "origin", "https://github.com/IIITYRAELIII/AgentHub.git");
  await git(root, "clone", "--no-local", primary, frozen);
  await writeFile(path.join(frozen, "AgentHub/package.json"), '{"name":"fixture","version":"2.1.7"}\n');
  await git(frozen, "add", "-A");
  await git(frozen, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "candidate");
  const commit = await git(frozen, "rev-parse", "HEAD"), tree = await git(frozen, "rev-parse", "HEAD^{tree}");
  await writeJson(path.join(frozen, ".git/agent-hub-release-clone.json"), {
    schemaVersion: 1, kind: "agent-hub-owned-release-clone", primaryRoot: primary,
    primaryGitCommonDir: path.join(primary, ".git"), releaseRoot: frozen, releaseGitCommonDir: path.join(frozen, ".git"),
  });
  const oldRoot = path.join(runtimeRoot, "releases", "old-runtime");
  await writeJson(path.join(oldRoot, "runtime-manifest.json"), { releaseId: "old-runtime", publicationRevision: base, files: [] });
  const pointer = { current: "old-runtime", runtimeRetention: { current: await captureRuntimeReleaseBinding(oldRoot, "old-runtime") } };
  await writeJson(path.join(runtimeRoot, "current.json"), pointer);
  const publicTarget = { targetId: "agent-hub-github-release", kind: "agent-hub-publication", environment: "github-release", repositoryRoot: primary,
    approvedLocalMainCommit: base, approvedOriginMainCommit: base };
  const localTarget = { ...publicTarget, targetId: "local", environment: "production" };
  const operation = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", authorization: {
    fingerprint: "a".repeat(64), runtimeInstallation: "public-package-v1", approvedTargets: [publicTarget, localTarget],
  }, lastError: { step: "publish", message: "External release tool requires AGENT_HUB_RELEASE_TOOLS_ROOT and its SHA256 pin" } };
  const candidate = { repositoryRoot: primary, releaseRoot: frozen, baseCommit: base, commit, tree,
    manifest: { baseCommit: base, publication: { head: commit, releaseVersion: "2.1.7", runtimeReleaseVersion: "2.1.7+build.29905213" } } };
  const generation = { operationId: operation.operationId, generation: 1, identitySha256: "b".repeat(64), candidates: [candidate] };
  const dataDir = path.join(root, "data");
  const firstRoot = releaseTargetExecutionRoot(dataDir, operation, generation, publicTarget);
  await mkdir(firstRoot, { recursive: true });
  const tool = { name: "fixture-tool", version: "0.1.2", sha256: "c".repeat(64), root: path.join(root, "tool") };
  tool.location = { schema: 1, name: tool.name, version: tool.version, sha256: tool.sha256, root: tool.root };
  const environment = { AGENT_HUB_RELEASE_TOOLS_ROOT: tool.root, AGENT_HUB_RELEASE_TOOLS_SHA256: tool.sha256 };
  let remoteHead = base, publicObject = null, releaseObject = null, publications = 0;
  const requests = [];
  const publication = new ReleaseOperationPublication({ dataDir, runtimeRoot, environment,
    spawnImpl: () => { publications++; assert.fail("recovery admission must not spawn a publisher or installer"); },
    readPublicationStateImpl: async () => ({ revision: base }), gitRemoteHeadImpl: async () => remoteHead,
    readToolPackage: async input => {
      assert.equal(input.root, tool.root);
      if (input.expectedSha256 !== tool.sha256) throw Error("exact tool pin still missing");
      return { ...tool, assertUnchanged: async () => {}, module: async name => {
        assert.equal(name, "src/publication-artifacts.mjs"); return { publicInstallerHandoffProtocol: PUBLIC_INSTALLER_HANDOFF };
      } };
    },
    distributionApi: async (method, route) => {
      assert.equal(method, "GET"); requests.push(route);
      if (route.endsWith("/git/ref/tags/2.1.7")) return publicObject;
      if (route.endsWith("/releases/tags/2.1.7")) return releaseObject;
      assert.equal(route, "/repos/IIITYRAELIII/AgentHub");
      return { id: 1428402643, full_name: "IIITYRAELIII/AgentHub", private: false, owner: { id: 95281881 } };
    },
  });
  return { root, publication, operation, generation, publicTarget, firstRoot, environment, tool, runtimeRoot, pointer, requests,
    setRemote: value => { remoteHead = value; }, setTag: value => { publicObject = value; }, setRelease: value => { releaseObject = value; },
    publications: () => publications, boundary: { kind: "not-applied-publication-recovery-v1" } };
}

test("unstarted publication owner proves both absent effects and repeats exact proof without INSTALL", async t => {
  const f = await unstartedPublicationOwnerFixture(t), before = await readFile(path.join(f.runtimeRoot, "current.json"));
  let admissions = 0;
  await f.publication.withPublicationRecovery({ ...f, commit: async (evidence, validate) => {
    assert.deepEqual(evidence.readbacks.map(row => [row.targetId, row.evidence.status]), [["agent-hub-github-release", "not_applied"], ["local", "not_applied"]]);
    assert.equal(evidence.targets[0].namespace.kind, "empty-directory");
    assert.equal(evidence.targets[1].namespace.kind, "absent");
    await validate(); admissions++;
  } });
  assert.equal(admissions, 1); assert.equal(f.publications(), 0);
  assert.equal(f.requests.length, 6);
  assert.deepEqual(await readFile(path.join(f.runtimeRoot, "current.json")), before);
});

test("failed selected public validation proves both targets unapplied before an installer exists", async t => {
  const f = await unstartedPublicationOwnerFixture(t);
  Object.assign(f.operation, { workspaceId: "workspace", state: "waiting", currentStep: "validate",
    currentGeneration: 1, owner: null, waitReason: { code: "validation_failed" } });
  const candidate = f.generation.candidates[0];
  const plan = resolveTestSelection({ mode: "include", ids: ["tests/required.test.mjs"] }, ["tests/required.test.mjs"]);
  f.generation.testPlans = [{ repositoryRoot: candidate.repositoryRoot, plan }];
  const labels = ["Проверка release candidate в изолированном контуре", "Выбранные тесты Agent Hub",
    "Подготовка артефактов публикации", "Упаковка установочного архива", "Публикация Git", "Публикация GitHub Release"];
  const identity = { mode: "changed", from: candidate.baseCommit, revision: candidate.commit,
    worktreeRoot: candidate.releaseRoot, runtimeRoot: f.runtimeRoot, validationMode: "include", testPlan: plan,
    deploymentProfile: "github-release", workspaceId: f.operation.workspaceId, artifactProtocol: 1, labels,
    release: { workspaceId: f.operation.workspaceId, primaryRoot: candidate.repositoryRoot, preReleaseHead: candidate.commit } };
  const journal = publicationRunStore({ runtimeRoot: f.firstRoot });
  await journal.start(identity, labels.map(label => ({ label })));
  await journal.stepStarted(labels[0]); await journal.stepFinished(labels[0], { status: "completed" });
  await journal.stepStarted(labels[1]); await journal.stepFinished(labels[1], { status: "failed", error: "validation failed" });
  await journal.finish("failed", "validation failed");
  const checkpoint = { identity, checkpointScope: { mode: "changed", from: identity.from,
    runtimeRoot: identity.runtimeRoot, validationMode: identity.validationMode, testPlan: plan },
    completedLabels: [labels[0]], completedFingerprints: { [labels[0]]: "exact-contour" } };
  await writeJson(path.join(f.firstRoot, "publication-checkpoint.json"), checkpoint);
  const runner = { status: "exited", exitCode: 1, completedAt: new Date().toISOString(), pid: 2147483647,
    operationId: f.operation.operationId, generation: 1, targetId: f.publicTarget.targetId,
    candidate: f.generation.identitySha256, tool: { name: f.tool.name, version: f.tool.version, sha256: f.tool.sha256 } };
  await writeJson(path.join(f.firstRoot, "runner.json"), runner);
  const local = f.operation.authorization.approvedTargets[1];
  const beforePointer = await readFile(path.join(f.runtimeRoot, "current.json"));
  const beforeRun = await readFile(path.join(f.firstRoot, "publication-status.json"));
  const readback = () => f.publication.readback({ operation: f.operation, generation: f.generation, target: local });
  const result = await readback();
  assert.equal(result.status, "not_applied");
  assert.equal(result.source, "failed-prepublication-validation-owner-v1");
  assert.deepEqual(result.evidence.readbacks.map(item => item.evidence.status), ["not_applied", "not_applied"]);
  assert.equal(result.evidence.targets[0].namespace.kind, "failed-prepublication-validation");
  assert.equal(result.evidence.targets[1].namespace.kind, "absent");
  assert.equal(f.publications(), 0);
  assert.deepEqual(await readFile(path.join(f.runtimeRoot, "current.json")), beforePointer);
  assert.deepEqual(await readFile(path.join(f.firstRoot, "publication-status.json")), beforeRun);
  for (const [mutate, stage] of [
    [() => f.setTag({ object: { sha: candidate.commit } }), "public-tag-release"],
    [() => f.setRelease({ id: 1 }), "public-tag-release"],
    [() => f.setRemote(candidate.commit), "remote-main"],
  ]) {
    mutate();
    const refused = await readback();
    assert.equal(refused.status, "partial");
    assert.equal(refused.cursor.proofStage, stage);
    assert.equal(refused.cursor.proofTarget, f.publicTarget.targetId);
    f.setTag(null); f.setRelease(null); f.setRemote(candidate.baseCommit);
  }
  await writeFile(path.join(f.firstRoot, "foreign.bin"), "unclassified");
  assert.equal((await readback()).status, "partial"); await rm(path.join(f.firstRoot, "foreign.bin"));
  await writeJson(path.join(f.firstRoot, "publication-checkpoint.json"), { ...checkpoint, completedLabels: [...labels] });
  assert.equal((await readback()).status, "partial");
  await writeJson(path.join(f.firstRoot, "publication-checkpoint.json"), checkpoint);
  await writeJson(path.join(f.firstRoot, "publication-checkpoint.json"), { ...checkpoint,
    checkpointScope: { ...checkpoint.checkpointScope, testPlan: { ...plan, selection: { mode: "none", ids: [] } } } });
  assert.equal((await readback()).status, "partial");
  await writeJson(path.join(f.firstRoot, "publication-checkpoint.json"), checkpoint);
  for (const pid of [undefined, process.pid]) {
    await writeJson(path.join(f.firstRoot, "runner.json"), { ...runner, pid });
    assert.equal((await readback()).status, "partial");
  }
  await writeJson(path.join(f.firstRoot, "runner.json"), runner);
  const changed = JSON.parse(beforeRun);
  changed.progress.githubDistribution = { createStarted: true };
  await writeJson(path.join(f.firstRoot, "publication-status.json"), changed);
  assert.equal((await readback()).status, "partial");
  await writeFile(path.join(f.firstRoot, "publication-status.json"), beforeRun);
  f.operation.waitReason = { code: "external_effect_readback" };
  assert.equal((await readback()).status, "partial");
  assert.equal(f.publications(), 0);
});

test("unstarted publication owner refuses missing pin, namespace, remote, public and current drift", async t => {
  const f = await unstartedPublicationOwnerFixture(t);
  const refuse = pattern => assert.rejects(f.publication.withPublicationRecovery({ ...f,
    commit: () => assert.fail("no unproved admission") }), pattern);
  f.environment.AGENT_HUB_RELEASE_TOOLS_SHA256 = "0".repeat(64);
  await refuse(/tool pin still missing/u); f.environment.AGENT_HUB_RELEASE_TOOLS_SHA256 = f.tool.sha256;
  for (const name of ["runner.json", "publication-status.json", "foreign.bin"]) {
    const file = path.join(f.firstRoot, name); await writeFile(file, "retained evidence");
    await refuse(/positively unstarted/u); await rm(file);
  }
  f.setRemote(f.generation.candidates[0].commit); await refuse(/remote effect/u);
  f.setRemote(f.pointer.runtimeRetention.current.manifestSha256); await refuse(/remote effect/u);
  const base = f.generation.candidates[0].baseCommit; f.setRemote(base);
  f.setTag({ object: { sha: f.generation.candidates[0].commit } }); await refuse(/release or tag already exists/u); f.setTag(null);
  f.setRelease({ id: 1 }); await refuse(/release or tag already exists/u); f.setRelease(null);
  const pointerFile = path.join(f.runtimeRoot, "current.json"), before = await readFile(pointerFile);
  await writeJson(pointerFile, { ...f.pointer, runtimeRetention: {} }); await refuse(/current runtime custody/u);
  await writeFile(pointerFile, before);
  await assert.rejects(f.publication.withPublicationRecovery({ ...f, commit: async (_evidence, validate) => {
    f.setTag({ id: "late foreign tag" }); await validate();
  } }), /release or tag already exists/u);
  assert.equal(f.publications(), 0);
});

test("unstarted recovery persists its exact executor across missing ambient pin before one publisher", async t => {
  const f = await unstartedPublicationOwnerFixture(t);
  let evidence;
  await f.publication.withPublicationRecovery({ ...f, commit: async (observed, validate) => { await validate(); evidence = observed; } });
  const contents = { requestId: "same-recovery", operationId: f.operation.operationId, generation: 1,
    priorRevision: 3, authorizationFingerprint: f.operation.authorization.fingerprint,
    boundary: { ...f.boundary, candidate: f.generation.identitySha256 }, evidence };
  f.operation.publicationRecoveries = [{ ...contents, identitySha256: releaseIdentitySha256(contents) }];
  delete f.environment.AGENT_HUB_RELEASE_TOOLS_ROOT;
  delete f.environment.AGENT_HUB_RELEASE_TOOLS_SHA256;
  let children = 0;
  f.publication.spawnImpl = (_exe, _args, options) => {
    children++;
    assert.equal(options.env.AGENT_HUB_RELEASE_TOOLS_ROOT, f.tool.root);
    assert.equal(options.env.AGENT_HUB_RELEASE_TOOLS_SHA256, f.tool.sha256);
    const child = new EventEmitter(); child.pid = 1234567; child.unref = () => {};
    queueMicrotask(async () => {
      await writeJson(path.join(f.firstRoot, "result.json"), { status: "applied", operationId: f.operation.operationId,
        generation: 1, targetId: f.publicTarget.targetId, candidate: f.generation.identitySha256,
        revision: f.generation.candidates[0].commit, deploymentProfile: "github-release",
        tool: { name: f.tool.name, version: f.tool.version, sha256: f.tool.sha256 },
        distribution: { sourceCommit: f.generation.candidates[0].commit } });
      child.emit("exit", 0);
    });
    return child;
  };
  assert.equal((await f.publication.publish({ ...f, target: f.publicTarget })).status, "applied");
  assert.equal(children, 1);
  const runner = JSON.parse(await readFile(path.join(f.firstRoot, "runner.json"), "utf8"));
  assert.deepEqual(runner.toolPackage, f.tool.location);
});

async function fixture(t, { realFrozen = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-public-package-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const frozenRoot = path.join(root, "frozen");
  let commit = "a".repeat(40), tree = null;
  if (realFrozen) {
    const git = async (...args) => (await promisify(execFile)("git", args,
      { cwd: frozenRoot, windowsHide: true, encoding: "utf8" })).stdout.trim();
    await mkdir(path.join(frozenRoot, "AgentHub"), { recursive: true });
    await git("init", "--initial-branch=main");
    await writeFile(path.join(frozenRoot, "AgentHub/package.json"), '{"name":"fixture","version":"2.1.6"}\n');
    await git("add", "-A");
    await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "tiny frozen source");
    commit = await git("rev-parse", "HEAD"); tree = await git("rev-parse", "HEAD^{tree}");
    await writeJson(path.join(frozenRoot, ".git/agent-hub-release-clone.json"), {
      schemaVersion: 1, kind: "agent-hub-owned-release-clone", primaryRoot: root,
      primaryGitCommonDir: path.join(root, "primary.git"), releaseRoot: frozenRoot,
      releaseGitCommonDir: path.join(frozenRoot, ".git"),
    });
  }
  const target = { targetId: "production", kind: "agent-hub-publication", environment: "production", repositoryRoot: root };
  const publicTarget = { ...target, targetId: "agent-hub-github-release", environment: "github-release" };
  const operation = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", authorization: {
    runtimeInstallation: "public-package-v1", approvedTargets: [target, publicTarget],
  } };
  const candidate = { repositoryRoot: root, releaseRoot: frozenRoot, commit, tree, manifest: { publication: {
    head: commit, releaseVersion: "2.1.6", runtimeReleaseVersion: "2.1.6+build.29901175",
  } } };
  const generation = { operationId: operation.operationId, generation: 2, identitySha256: "b".repeat(64), candidates: [candidate] };
  const tool = { name: "release-tools", version: "0.1.2", sha256: "c".repeat(64) };
  const prepared = { receiptSha256: "d".repeat(64), receipt: { schema: 1, phase: "PREPARED",
    operationId: operation.operationId, generation: 2, sourceCommit: candidate.commit,
    version: "2.1.6+build.29901175", releaseId: "publication-fixture", releaseRoot: path.join(root, "prepared"),
    manifestSha256: "e".repeat(64) } };
  const execution = releaseTargetExecutionRoot(dataDir, operation, generation, publicTarget);
  const namespace = path.join(execution, "distribution", prepared.receipt.version);
  const assets = path.join(namespace, "assets");
  await mkdir(assets, { recursive: true });
  const archive = Buffer.from("tiny controlled archive input; extraction is covered by public installer tests");
  const descriptor = { schema: 1, repository: "IIITYRAELIII/AgentHub", platform: "win32-x64", asset: "AgentHub-win32-x64.zip",
    sha256: hash(archive), bytes: archive.length, packageManifestSha256: "f".repeat(64), sourceCommit: candidate.commit,
    releaseId: prepared.receipt.releaseId, publicVersion: "2.1.6", versionScheme: "semver-build-v1", buildNumber: 29901175,
    version: prepared.receipt.version };
  const bodies = { "AgentHub-win32-x64.zip": archive, "AgentHub-win32-x64.zip.json": Buffer.from(JSON.stringify(descriptor)),
    "install_release.py": Buffer.from("# exact versioned public fixture\n"), "SHA256SUMS": Buffer.from("controlled checksums\n") };
  const inventory = [];
  for (const [name, body] of Object.entries(bodies)) {
    await writeFile(path.join(assets, name), body);
    inventory.push({ name, bytes: body.length, sha256: hash(body) });
  }
  const packaged = { schema: 1, phase: "PACKAGED", inputIdentity: "1".repeat(64), inputs: {
    ...Object.fromEntries(["operationId", "generation", "sourceCommit", "version"].map(key => [key, prepared.receipt[key]])),
    preparedReceiptSha256: prepared.receiptSha256, preparedManifestSha256: prepared.receipt.manifestSha256,
    publicVersion: "2.1.6", tool,
  }, assets: inventory };
  const distribution = { releaseId: 17, releaseTag: "2.1.6", sourceCommit: candidate.commit,
    inputIdentity: packaged.inputIdentity, assets: inventory, publishedAt: "2026-11-09T00:00:00Z" };
  const effect = { status: "applied", operationId: operation.operationId, generation: 2, targetId: publicTarget.targetId,
    candidate: generation.identitySha256, revision: candidate.commit, deploymentProfile: "github-release", tool, distribution };
  operation.publicationEffects = { generation: 2, targets: { [publicTarget.targetId]: effect } };
  await writeJson(path.join(execution, "result.json"), effect);
  const journal = { identity: { revision: candidate.commit }, progress: { githubDistribution: {
    inputIdentity: packaged.inputIdentity, status: "applied", result: distribution,
  } } };
  await writeJson(path.join(execution, "publication-status.json"), journal);
  await writeJson(path.join(namespace, "result.json"), packaged);
  const metadata = { id: 17, tag_name: "2.1.6", draft: false, prerelease: false, published_at: distribution.publishedAt,
    assets: inventory.map(row => ({ name: row.name, state: "uploaded", size: row.bytes, digest: `sha256:${row.sha256}`,
      browser_download_url: `https://github.com/IIITYRAELIII/AgentHub/releases/download/2.1.6/${row.name}` })) };
  const ref = { object: { type: "commit", sha: candidate.commit } };
  const requests = [];
  const options = { operation, generation, target, dataDir, tool, prepared, api: async (method, route) => {
    assert.equal(method, "GET"); requests.push(route);
    return structuredClone(route.includes("/git/ref/") ? ref : route.includes("/releases/") ? metadata
      : { id: 1428402643, owner: { id: 95281881 }, private: false });
  } };
  return { root, options, execution, namespace, assets, metadata, ref, effect, packaged, prepared, requests, bodies };
}

test("consumer joins canonical applied target, original PACKAGED/PREPARED and fresh public tag and asset digests", async t => {
  const f = await fixture(t);
  const before = await readFile(path.join(f.execution, "publication-status.json"));
  const selected = await readPublishedRuntimePackage(f.options);
  assert.equal(selected.target.sourceCommit, f.options.generation.candidates[0].commit);
  assert.equal(selected.target.version, f.prepared.receipt.version);
  assert.equal(selected.inputIdentity, f.packaged.inputIdentity);
  assert.deepEqual(selected.prepared, f.prepared);
  assert.equal(f.requests.length, 3);
  assert.deepEqual(await readFile(path.join(f.execution, "publication-status.json")), before);
});

test("foreign public target, candidate, executor and PREPARED binding refuse", async t => {
  const f = await fixture(t);
  for (const patch of [{ tool: { ...f.options.tool, sha256: "0".repeat(64) } },
    { generation: { ...f.options.generation, identitySha256: "0".repeat(64) } },
    { prepared: { ...f.prepared, receiptSha256: "0".repeat(64) } }]) {
    await assert.rejects(readPublishedRuntimePackage({ ...f.options, ...patch }), /exact public target|PREPARED/u);
  }
  const original = f.options.operation.publicationEffects;
  f.options.operation.publicationEffects = { ...original, generation: 1 };
  await assert.rejects(readPublishedRuntimePackage(f.options), /exact public target/u);
  assert.equal(f.requests.length, 0);
});

test("fresh public tag, release, asset set and local package bytes remain strict", async t => {
  const f = await fixture(t);
  f.ref.object.sha = "0".repeat(40);
  await assert.rejects(readPublishedRuntimePackage(f.options), /tag or release changed/u);
  f.ref.object.sha = f.options.generation.candidates[0].commit;
  f.metadata.id = 18;
  await assert.rejects(readPublishedRuntimePackage(f.options), /tag or release changed/u);
  f.metadata.id = 17;
  f.metadata.assets.push({ ...f.metadata.assets[0], name: "foreign.zip" });
  await assert.rejects(readPublishedRuntimePackage(f.options), /asset set changed/u);
  f.metadata.assets.pop();
  await writeFile(path.join(f.assets, "install_release.py"), "changed bootstrap");
  await assert.rejects(readPublishedRuntimePackage(f.options), /published asset/u);
  await writeFile(path.join(f.assets, "install_release.py"), f.bodies["install_release.py"]);
  await writeFile(path.join(f.assets, "SHA256SUMS"), "changed sums");
  await assert.rejects(readPublishedRuntimePackage(f.options), /checksum asset changed/u);
});

test("a changed original target journal or PACKAGED input cannot be adopted by the consumer", async t => {
  const f = await fixture(t);
  const original = await readFile(path.join(f.execution, "publication-status.json"));
  await writeJson(path.join(f.execution, "publication-status.json"), { identity: { revision: f.effect.revision }, progress: {} });
  await assert.rejects(readPublishedRuntimePackage(f.options), /receipt changed/u);
  await writeFile(path.join(f.execution, "publication-status.json"), original);
  await writeJson(path.join(f.namespace, "result.json"), { ...f.packaged, inputs: { ...f.packaged.inputs, sourceCommit: "0".repeat(40) } });
  await assert.rejects(readPublishedRuntimePackage(f.options), /PREPARED/u);
  assert.equal(f.requests.length, 0);
});

test("actual publication readback requires same canonical maintenance, installed proof and Ready before remaining stages", async t => {
  const f = await fixture(t, { realFrozen: true });
  const { operation, generation, target, dataDir, tool } = f.options;
  const runtimeRoot = path.join(f.root, "runtime");
  await mkdir(path.join(runtimeRoot, "data"), { recursive: true });
  await writeJson(path.join(runtimeRoot, "config.json"), { projectRoot: f.root, projects: [{ name: "fixture", path: f.root }] });
  const localRoot = releaseTargetExecutionRoot(dataDir, operation, generation, target);
  const journal = publicationRunStore({ runtimeRoot: localRoot });
  const identity = { revision: generation.candidates[0].commit, labels: ["Установка runtime-релиза"] };
  await journal.start(identity, [{ label: "Установка runtime-релиза" }]);
  const maintenance = new MaintenanceOperationStore({ dataDir: path.join(runtimeRoot, "data") });
  maintenance.get("fixture-schema");
  let current = "old-runtime", ready = true, manifestValid = true, children = 0, joined = 0;
  let publicationChildren = 0;
  const ports = {
    readStatus: async () => ({ current, running: true, ready: true }),
    readMaintenance: id => maintenance.getReadonly(id),
    verifyInstalled: async () => assert.equal(manifestValid, true, "installed whole payload must match the public package"),
    verifyReady: async () => assert.equal(ready, true, "actual Ready must be verified"),
  };
  const owner = createPublicRuntimeInstaller({ operation, generation, target, runtimeRoot, journal, tool, ...ports,
    readPublishedInput: () => readPublishedRuntimePackage(f.options),
    withInstallationLease: async (_root, action) => action({ assertOwned: async () => {} }),
    spawnImpl: () => {
      children++;
      const child = spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" });
      child.once("close", () => { joined++; });
      return child;
    },
  });
  await owner.prepare();
  assert.equal((await owner.dispatch()).status, "unknown");
  assert.equal(children, 1); assert.equal(joined, 1);
  const saved = (await journal.read()).progress.publicRuntimeInstaller;
  await writeJson(path.join(localRoot, "runner.json"), { candidate: generation.identitySha256, tool, status: "exited", exitCode: 0 });
  const publication = new ReleaseOperationPublication({ dataDir, runtimeRoot,
    spawnImpl: () => { publicationChildren++; return spawn(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, stdio: "ignore" }); },
    processAliveImpl: () => false, readPublicationStateImpl: async () => ({ revision: identity.revision }),
    readToolPackage: async () => ({ ...tool, assertUnchanged: async () => {} }),
    createArtifactSteps: () => ({ preparedRuntimeReceipt: async () => f.prepared }),
    distributionApi: f.options.api, publicRuntimeInstallerPorts: ports,
  });
  const readback = () => publication.readback({ operation, generation, target });
  assert.equal((await readback()).status, "unknown");
  const input = await readPublishedRuntimePackage(f.options);
  const binding = { operationId: saved.owner.operationId, runtimeRoot, dataDir: path.join(runtimeRoot, "data"),
    roots: { runtime: saved.runtime }, old: { releaseId: "old-runtime" }, target: input.target };
  const original = maintenance.create({ operationId: binding.operationId, kind: "restart", streamId: "fixture", threadId: "fixture",
    metadata: { packageHandoff: { schema: 1, binding, sha256: packageBindingDigest(binding) } } });
  await assert.rejects(publication.publish({ operation, generation, target }), error => error.code === "RELEASE_EXTERNAL_CONDITION");
  console.log(JSON.stringify({ canonicalConsumer: original.status, publicationChildren }));
  assert.equal(publicationChildren, 0, "an admitted package consumer cannot launch another publication worker");
  assert.equal((await readback()).cursor.consumerActive, true);
  maintenance.transition(original.operationId, { status: "running", phase: "package-installing" }, { expectedRevision: original.revision });
  maintenance.settle(original.operationId, { succeeded: true });
  assert.equal((await readback()).cursor.reason, "public-installer-current-drift");
  assert.equal((await readback()).status, "unknown");
  current = input.target.releaseId;
  ready = false;
  assert.equal((await readback()).cursor.reason, "public-installer-readiness");
  assert.equal((await readback()).cursor.consumerActive, true);
  ready = true; manifestValid = false;
  assert.equal((await readback()).cursor.reason, "public-installer-installed-payload");
  assert.equal((await readback()).status, "unknown");
  manifestValid = true;
  const complete = await readback();
  assert.equal(complete.status, "partial");
  assert.equal(complete.source, "public-installer-ready");
  const result = { status: "applied", operationId: operation.operationId, generation: generation.generation,
    targetId: target.targetId, candidate: generation.identitySha256, revision: identity.revision, tool,
    publicRuntimeInstaller: complete.publicRuntimeInstaller };
  await writeJson(path.join(localRoot, "result.json"), result);
  assert.deepEqual(await readback(), result);
  await writeJson(path.join(f.execution, "runner.json"), { candidate: generation.identitySha256, tool, status: "exited", exitCode: 0 });
  operation.lastError = { step: "publish", message: "External release tool requires AGENT_HUB_RELEASE_TOOLS_ROOT and its SHA256 pin" };
  let admissions = 0;
  await publication.withPublicationRecovery({ operation, generation, commit: async (evidence, validate) => {
    assert.equal(evidence.length, 2); await validate(); admissions++;
  } });
  assert.equal(admissions, 1);
  const runner = path.join(localRoot, "runner.json"), retainedRunner = await readFile(runner);
  await writeJson(runner, { candidate: generation.identitySha256, tool, status: "launching" });
  await assert.rejects(publication.withPublicationRecovery({ operation, generation, commit: () => assert.fail("no active-runner admission") }), /positively closed/u);
  await writeFile(runner, retainedRunner);
  ready = false;
  await assert.rejects(publication.withPublicationRecovery({ operation, generation, commit: () => assert.fail("no unready admission") }), error => {
    assert.equal(error.code, "RELEASE_PUBLIC_INSTALLER_NOT_READY");
    assert.deepEqual(error.publicationRecoveryProof, { targetId: target.targetId,
      status: "partial", reason: "public-installer-readiness", installerStatus: null, sourceCommit: null });
    assert.match(error.message, /public-installer-readiness/u);
    return true;
  });
  ready = true;
  await publication.withPublicationRecovery({ operation, generation, commit: async (_evidence, validate) => {
    await validate(); admissions++;
  } });
  assert.equal(admissions, 2);
  f.ref.object.sha = "0".repeat(40);
  assert.equal((await readback()).cursor.reason, "public-installer-proof-refused");
  assert.equal((await readback()).status, "unknown");
  assert.equal(children, 1); assert.equal(joined, 1);
});
