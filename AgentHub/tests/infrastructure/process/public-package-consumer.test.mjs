import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPublicRuntimeInstaller, readPublishedRuntimePackage, releaseTargetExecutionRoot } from "../../../src/infrastructure/process/public-runtime-installer.mjs";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { publicationRunStore } from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { packageBindingDigest } from "../../../src/infrastructure/filesystem/runtime-package-target.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const writeJson = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, JSON.stringify(value)); };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-public-package-consumer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = path.join(root, "data");
  const target = { targetId: "production", kind: "agent-hub-publication", environment: "production", repositoryRoot: root };
  const publicTarget = { ...target, targetId: "agent-hub-github-release", environment: "github-release" };
  const operation = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", authorization: {
    runtimeInstallation: "public-package-v1", approvedTargets: [target, publicTarget],
  } };
  const candidate = { repositoryRoot: root, releaseRoot: path.join(root, "frozen"), commit: "a".repeat(40), manifest: { publication: {
    head: "a".repeat(40), releaseVersion: "2.1.6", runtimeReleaseVersion: "2.1.6+build.29901175",
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
  const f = await fixture(t);
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
  maintenance.transition(original.operationId, { status: "running", phase: "package-installing" }, { expectedRevision: original.revision });
  maintenance.settle(original.operationId, { succeeded: true });
  await assert.rejects(readback(), /current pointer differs/u);
  current = input.target.releaseId;
  ready = false;
  await assert.rejects(readback(), /actual Ready/u);
  ready = true; manifestValid = false;
  await assert.rejects(readback(), /whole payload/u);
  manifestValid = true;
  const complete = await readback();
  assert.equal(complete.status, "partial");
  assert.equal(complete.source, "public-installer-ready");
  const result = { status: "applied", operationId: operation.operationId, generation: generation.generation,
    targetId: target.targetId, candidate: generation.identitySha256, revision: identity.revision, tool,
    publicRuntimeInstaller: complete.publicRuntimeInstaller };
  await writeJson(path.join(localRoot, "result.json"), result);
  assert.deepEqual(await readback(), result);
  f.ref.object.sha = "0".repeat(40);
  await assert.rejects(readback(), /tag or release changed/u);
  assert.equal(children, 1); assert.equal(joined, 1);
});
