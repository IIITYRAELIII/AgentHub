import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";
import { createExternalPublicationTools } from "../../../src/composition/release-tooling-composition.mjs";
import { publicationCheckpointStore } from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { publicRuntimeInstallerBinding, releaseTargetExecutionRoot } from "../../../src/infrastructure/process/public-runtime-installer.mjs";

async function publicationFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-public-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const target = { targetId: "production", kind: "agent-hub-publication", environment: "production",
    repositoryRoot: path.join(root, "primary") };
  const operation = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe",
    authorization: { runtimeInstallation: "public-package-v1", approvedTargets: [target,
      { ...target, targetId: "agent-hub-github-release", environment: "github-release" }] } };
  const candidate = { repositoryRoot: target.repositoryRoot, releaseRoot: path.join(root, "frozen"),
    commit: "a".repeat(40), tree: "b".repeat(40), baseCommit: "c".repeat(40),
    manifest: { publication: { head: "a".repeat(40), releaseVersion: "2.1.6", runtimeReleaseVersion: "2.1.6+build.29901175" } } };
  const generation = { operationId: operation.operationId, generation: 1,
    identitySha256: "d".repeat(64), candidates: [candidate] };
  const publication = new ReleaseOperationPublication({ dataDir: path.join(root, "data"), runtimeRoot: path.join(root, "runtime"),
    readPublicationStateImpl: async () => ({ revision: candidate.commit }),
    gitRemoteHeadImpl: async () => candidate.commit,
  });
  return { operation, generation, target, publication, dataDir: path.join(root, "data") };
}

test("public production installation requires its consumer proof beyond a published revision", async t => {
  const fixture = await publicationFixture(t);
  const result = await fixture.publication.readback(fixture);
  assert.equal(result.status, "partial");
  assert.equal(result.cursor?.reason, "public-installer-required");
});

test("historical installed-runtime generations retain their original publication readback", async t => {
  const fixture = await publicationFixture(t);
  delete fixture.operation.authorization.runtimeInstallation;
  const result = await fixture.publication.readback(fixture);
  assert.equal(result.status, "applied");
  assert.equal(result.source, "publication-state-readback");
});

test("canonical completed public consumer remains historical truth after later caller or runtime changes", async t => {
  const f = await publicationFixture(t);
  const result = { status: "applied", operationId: f.operation.operationId, generation: f.generation.generation,
    targetId: f.target.targetId, candidate: f.generation.identitySha256, revision: f.generation.candidates[0].commit,
    publicRuntimeInstaller: { status: "ready", binding: publicRuntimeInstallerBinding(f) } };
  f.operation.state = "done";
  f.operation.publicationEffects = { generation: f.generation.generation, targets: { [f.target.targetId]: result } };
  const execution = releaseTargetExecutionRoot(f.dataDir, f.operation, f.generation, f.target);
  await mkdir(execution, { recursive: true });
  await writeFile(path.join(execution, "result.json"), JSON.stringify(result));
  assert.deepEqual(await f.publication.readback(f), result);
  f.operation.publicationEffects.targets[f.target.targetId] = { ...result, candidate: "0".repeat(64) };
  assert.equal((await f.publication.readback(f)).status, "partial");
});

for (const route of ["changed", "full"]) {
  test(`${route} publication returns its pending installer handoff after releasing the enclosing lock`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ah-installer-route-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const tools = await createExternalPublicationTools();
    assert.equal(tools.publicInstallerHandoffProtocol, "public-runtime-installer-handoff-v1");
    const binding = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", generation: 2,
      candidate: "a".repeat(64), targetId: "production" };
    const handoff = { kind: tools.publicInstallerHandoffProtocol, status: "waiting", binding };
    const journal = publicationRunStore({ runtimeRoot: root });
    const checkpoint = publicationCheckpointStore(path.join(root, "checkpoint.json"));
    let held = false;
    const calls = [];
    const options = { journal, checkpoint, runtimeRoot: root,
      exclusive: async action => { held = true; try { return await action(); } finally { held = false; } },
      revision: async () => "b".repeat(40), readState: async () => ({ revision: "c".repeat(40) }),
      diff: async () => ["AgentHub/src/runtime/runtime-manager.mjs"], ensureWorkerDependency: async () => {},
      prepareVersion: async () => {},
      prepareArtifactSteps: async (_steps, identity) => {
        identity.publicInstallerBinding = binding;
        return [
          { label: "Validated prefix", fingerprint: "prefix", execute: () => { assert.equal(held, true); calls.push("prefix"); } },
          { label: "Установка runtime-релиза", publicInstallerBinding: binding, execute: () => {
            assert.equal(held, true); calls.push("handoff"); return handoff;
          } },
          { label: "Remaining stage", execute: () => assert.fail("pending installer cannot run a later deployment") },
        ];
      },
      run: () => assert.fail("a private runtime deployment cannot replace the public handoff"),
      verifyArtifacts: () => assert.fail("pending installation cannot be verified as complete"),
      writeState: () => assert.fail("pending installation cannot publish runtime state"),
      record: () => assert.fail("pending installation cannot publish runtime state"),
      finalizePublication: () => assert.fail("pending installation cannot finalize"),
    };
    const result = route === "changed"
      ? await tools.publishChanged(["--quick", "--from", "c".repeat(40)], options)
      : await tools.publishAll(["--skip-tests", "--skip-worker"], options);
    assert.equal(held, false);
    assert.equal(result.status, "awaiting_public_installer");
    assert.deepEqual(result.handoff, handoff);
    assert.deepEqual(calls, ["prefix", "handoff"]);
    assert.equal((await journal.read()).status, "awaiting_public_installer");
    assert.deepEqual((await checkpoint.read()).completedLabels, ["Validated prefix"]);
    const resumed = { ...options,
      prepareArtifactSteps: async (_steps, identity) => {
        identity.publicInstallerBinding = binding;
        return [
          { label: "Validated prefix", fingerprint: "prefix", execute: () => assert.fail("completed prefix cannot repeat") },
          { label: "Установка runtime-релиза", publicInstallerBinding: binding, execute: async () => {
            assert.equal(held, true); calls.push("installed");
            await journal.updateProgress({ expectedReleaseId: "ready-public-release" });
          } },
          { label: "Remaining stage", execute: () => calls.push("remaining") },
        ];
      },
      verifyArtifacts: async () => calls.push("verified"),
      readRuntimeStatus: async () => ({ current: "ready-public-release", runningRelease: "ready-public-release", running: true, ready: true }),
      verifyRestart: async () => calls.push("ready"),
      writeState: async () => calls.push("recorded"), record: async () => calls.push("recorded"),
      finalizePublication: async () => ({ status: "completed" }),
    };
    const completed = route === "changed"
      ? await tools.publishChanged(["--resume", "--quick", "--from", "c".repeat(40)], resumed)
      : await tools.publishAll(["--skip-tests", "--skip-worker"], resumed);
    assert.equal(["published", "succeeded"].includes(completed.status), true);
    assert.equal(held, false);
    assert.deepEqual(calls.slice(0, 5), ["prefix", "handoff", "installed", "remaining", ...(route === "changed" ? ["verified"] : ["ready"])]);
    assert.equal(calls.filter(call => call === "prefix").length, 1);
    assert.equal(calls.filter(call => call === "recorded").length, 1);
    assert.equal(await checkpoint.read(), null);
  });
}
