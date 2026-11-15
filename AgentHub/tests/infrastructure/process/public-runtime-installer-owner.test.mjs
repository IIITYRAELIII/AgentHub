import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPublicRuntimeInstaller, releaseTargetExecutionRoot } from "../../../src/infrastructure/process/public-runtime-installer.mjs";
import { packageBindingDigest, packageFile } from "../../../src/infrastructure/filesystem/runtime-package-target.mjs";
import { publicationRunStore } from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";

async function fixture(t, { childExit = 0, initiallyStopped = false, firstInstall = false, lostStartReply = false } = {}) {
  const area = await mkdtemp(path.join(os.tmpdir(), "ah-public-install-owner-"));
  t.after(() => rm(area, { recursive: true, force: true }));
  const runtimeRoot = path.join(area, "runtime");
  await mkdir(path.join(runtimeRoot, "data"), { recursive: true });
  if (!firstInstall) await writeFile(path.join(runtimeRoot, "config.json"), JSON.stringify({ projectRoot: area, projects: [{ path: area, name: "fixture" }] }));
  const installerFile = path.join(area, "published-install_release.py");
  await writeFile(installerFile, "# public versioned fixture\n");
  const target = { targetId: "production", kind: "agent-hub-publication", environment: "production", repositoryRoot: area };
  const publicTarget = { ...target, targetId: "agent-hub-github-release", environment: "github-release" };
  const operation = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", authorization: {
    runtimeInstallation: "public-package-v1", approvedTargets: [target, publicTarget],
  } };
  const candidate = { repositoryRoot: area, commit: "a".repeat(40), manifest: { publication: {
    head: "a".repeat(40), releaseVersion: "2.1.6", runtimeReleaseVersion: "2.1.6+build.29901175",
  } } };
  const generation = { operationId: operation.operationId, generation: 1, identitySha256: "b".repeat(64), candidates: [candidate] };
  const journal = publicationRunStore({ runtimeRoot: path.join(area, "execution") });
  const publicationIdentity = { revision: candidate.commit, labels: ["Установка runtime-релиза"] };
  await journal.start(publicationIdentity, [{ label: "Установка runtime-релиза" }]);
  const maintenance = new MaintenanceOperationStore({ dataDir: path.join(runtimeRoot, "data") });
  maintenance.get("fixture-schema-initialization");
  let input = { inputIdentity: "c".repeat(64), target: { tag: "2.1.6", releaseId: "new-public-runtime",
    repository: "IIITYRAELIII/AgentHub", packageManifestSha256: "e".repeat(64),
    sourceCommit: candidate.commit, version: "2.1.6+build.29901175", installer: await packageFile(installerFile),
    descriptor: { sha256: "a".repeat(64), bytes: 64, file: path.join(area, "descriptor.json") },
    archive: { sha256: "d".repeat(64), bytes: 64, file: path.join(area, "archive.zip") } },
    prepared: { receipt: { releaseId: "new-public-runtime" }, receiptSha256: "e".repeat(64) } };
  let status = { current: firstInstall ? null : "old-runtime", running: !initiallyStopped, ready: !initiallyStopped };
  let held = false, outerHeld = false, children = 0, joined = 0, verified = 0, readyChecks = 0, starts = 0;
  const invocations = [];
  let duringInput = async () => {};
  const options = { operation, generation, target, runtimeRoot, journal,
    tool: { name: "release-tools", version: "0.1.2", sha256: "f".repeat(64) },
    readPublishedInput: async () => { await duringInput(); return structuredClone(input); },
    readStatus: async () => structuredClone(status), readMaintenance: id => maintenance.getReadonly(id),
    verifyInstalled: async (root, selected) => { assert.equal(root, runtimeRoot); assert.deepEqual(selected, input); verified++; },
    verifyReady: async ({ expectedReleaseId }) => {
      assert.equal(held, false); assert.equal(expectedReleaseId, input.target.releaseId);
      assert.equal(status.running, true); assert.equal(status.ready, true); readyChecks++;
    },
    startRuntime: async ({ expectedReleaseId }) => {
      assert.equal(held, false); assert.equal(outerHeld, false); assert.equal(expectedReleaseId, input.target.releaseId); starts++;
      if (lostStartReply) throw new Error("cold start reply lost");
      status = { current: expectedReleaseId, running: true, ready: true };
    },
    withInstallationLease: async (root, action) => {
      assert.equal(root, runtimeRoot); assert.equal(held, false); held = true;
      try { return await action({ assertOwned: async () => assert.equal(held, true) }); }
      finally { held = false; }
    },
    assertOutsidePublicationLock: () => { assert.equal(outerHeld, false, "installer cannot launch under outer publication lock"); },
    spawnImpl: (command, args, spawnOptions) => {
      children++;
      invocations.push({ command, args, options: spawnOptions });
      assert.equal(held, true, "the original proof remains leased through synchronous spawn");
      const initialConfig = firstInstall ? `import {initialRuntimeProjectConfiguration as selectProject} from ${JSON.stringify(new URL("../../../src/infrastructure/filesystem/config.mjs", import.meta.url).href)};
        import {writeFile} from 'node:fs/promises';
        await writeFile(${JSON.stringify(path.join(runtimeRoot, "config.json"))},JSON.stringify(selectProject({projects:[]},${JSON.stringify(area)})),{flag:'wx'});` : "";
      const child = spawn(process.execPath, ["--input-type=module", "-e", `${initialConfig}process.exit(${childExit})`], { windowsHide: true, stdio: "ignore" });
      child.once("close", code => {
        assert.equal(held, false, "the public child must receive its own installation lease"); joined++;
        if (initiallyStopped && code === 0) status = { current: input.target.releaseId, running: false, ready: false };
      });
      return child;
    },
  };
  const owner = createPublicRuntimeInstaller(options);
  async function succeed() {
    const saved = (await journal.read()).progress.publicRuntimeInstaller;
    const binding = { operationId: saved.owner.operationId, runtimeRoot, dataDir: path.join(runtimeRoot, "data"),
      roots: { runtime: saved.runtime }, old: { releaseId: "old-runtime" }, target: input.target };
    const original = maintenance.create({ operationId: binding.operationId, kind: "restart", streamId: "fixture", threadId: "fixture",
      metadata: { packageHandoff: { schema: 1, binding, sha256: packageBindingDigest(binding) } } });
    maintenance.transition(original.operationId, { status: "running", phase: "package-installing" }, { expectedRevision: original.revision });
    maintenance.settle(original.operationId, { succeeded: true });
    status = { current: input.target.releaseId, running: true, ready: true };
    return maintenance.getReadonly(original.operationId);
  }
  return { area, runtimeRoot, operation, generation, target, journal, owner, options, publicationIdentity, maintenance,
    state: () => ({ held, children, joined, verified, readyChecks, starts }), invocations, succeed,
    setStatus: value => { status = value; },
    input: () => input, changeInput: value => { input = value; },
    outer: value => { outerHeld = value; }, duringInput: action => { duringInput = action; } };
}

test("public installer intent survives journal resume and launches one exact public CLI outside locks", async t => {
  const f = await fixture(t);
  assert.deepEqual(await f.owner.readback(), { status: "partial", cursor: { reason: "public-installer-required" } });
  const pending = await f.owner.prepare();
  assert.equal(pending.kind, "public-runtime-installer-handoff-v1");
  const saved = (await f.journal.read()).progress.publicRuntimeInstaller;
  assert.equal(path.dirname(saved.scratch.directory), f.area);
  assert.equal(path.relative(f.runtimeRoot, saved.scratch.directory).startsWith(".."), true);
  assert.equal(await readFile(saved.installer.file, "utf8"), "# public versioned fixture\n");
  await f.journal.finish("awaiting_public_installer");
  await f.journal.start(f.publicationIdentity, [{ label: "Установка runtime-релиза" }]);
  assert.deepEqual((await f.journal.read()).progress.publicRuntimeInstaller, saved);
  const result = await f.owner.dispatch();
  assert.equal(result.status, "unknown");
  assert.equal(result.cursor.reason, "public-installer-original-missing");
  assert.equal(f.state().children, 1); assert.equal(f.state().joined, 1);
  const invocation = f.invocations[0];
  assert.match(invocation.command, /python/u);
  assert.deepEqual(invocation.args.slice(0, 4), ["-B", "-X", "utf8", saved.installer.file]);
  assert.equal(invocation.args[invocation.args.indexOf("--release") + 1], "2.1.6");
  assert.equal(invocation.args[invocation.args.indexOf("--sha256") + 1], f.input().target.archive.sha256);
  assert.equal(invocation.args[invocation.args.indexOf("--operation-id") + 1], saved.owner.operationId);
  assert.equal(invocation.args.includes("--prepare-update"), true);
  await f.owner.dispatch();
  assert.equal(f.state().children, 1, "a lost original reply never admits a replacement child");
  await f.succeed();
  assert.equal((await f.owner.readback()).status, "ready");
  assert.equal(await f.owner.verify(), true);
  assert.equal(f.state().verified, 2); assert.equal(f.state().readyChecks, 2);
});

test("changed package or physical installer refuses before spawn and outer lock cannot invoke dispatch", async t => {
  const f = await fixture(t);
  await f.owner.prepare();
  f.outer(true);
  await assert.rejects(f.owner.dispatch(), /outer publication lock/u);
  f.outer(false);
  const old = f.input(); f.changeInput({ ...old, inputIdentity: "0".repeat(64) });
  await assert.rejects(f.owner.dispatch(), /package changed/u);
  f.changeInput(old);
  const saved = (await f.journal.read()).progress.publicRuntimeInstaller;
  await writeFile(saved.installer.file, "changed public bootstrap");
  await assert.rejects(f.owner.dispatch(), /physical custody changed/u);
  assert.equal(f.state().children, 0);
  assert.equal((await f.journal.read()).progress.publicRuntimeInstaller.phase, "prepared");
});

test("late prelaunch refusal keeps dispatch intent unknown and never repeats a child", async t => {
  const f = await fixture(t);
  await f.owner.prepare();
  f.duringInput(async () => {
    if ((await f.journal.read()).progress.publicRuntimeInstaller.phase === "dispatch_intent") throw new Error("late public payload refusal");
  });
  await assert.rejects(f.owner.dispatch(), /late public payload/u);
  f.duringInput(async () => {});
  assert.equal((await f.owner.dispatch()).status, "unknown");
  assert.equal(f.state().children, 0);
  assert.equal((await f.journal.read()).progress.publicRuntimeInstaller.phase, "dispatch_intent");
});

test("real failed public child is joined without another launch or successful installation receipt", async t => {
  const f = await fixture(t, { childExit: 9 });
  await f.owner.prepare();
  assert.equal((await f.owner.dispatch()).status, "unknown");
  assert.equal(f.state().joined, 1);
  assert.equal((await f.journal.read()).progress.publicRuntimeInstaller.exitCode, 9);
  await f.owner.dispatch();
  assert.equal(f.state().children, 1);
  assert.equal(f.state().verified, 0);
});

test("foreign original and modified durable intent cannot reuse the admitted public package", async t => {
  const f = await fixture(t);
  await f.owner.prepare();
  const other = createPublicRuntimeInstaller({ ...f.options, tool: { ...f.options.tool, sha256: "0".repeat(64) } });
  await assert.rejects(other.readback(), /intent changed/u);
  const saved = (await f.journal.read()).progress.publicRuntimeInstaller;
  await f.journal.updateProgress({ publicRuntimeInstaller: { ...saved, mode: "stopped" } });
  await assert.rejects(f.owner.dispatch(), /intent changed/u);
  assert.equal(f.state().children, 0);
});

test("execution namespace preserves the original raw-string SHA layout", () => {
  const root = releaseTargetExecutionRoot("data", { operationId: "0df0552f-5828-4a80-9027-1fe8c324fe34" },
    { generation: 7 }, { targetId: "agent-hub-publication:b41e7c634c4a" });
  assert.equal(path.basename(root), "a15a969e0a9aed67c38f2f58b4d0b3c3f138e59df572d6877917cfd6c0417ba9");
});

test("first public install selects a valid project and cold start stays outside both leases", async t => {
  const f = await fixture(t, { initiallyStopped: true, firstInstall: true });
  await f.owner.prepare();
  const result = await f.owner.dispatch();
  assert.equal(result.status, "ready");
  assert.equal(f.state().children, 1); assert.equal(f.state().joined, 1); assert.equal(f.state().starts, 1);
  const args = f.invocations[0].args;
  assert.equal(args.includes("--prepare-update"), false);
  assert.equal(args[args.indexOf("--project-root") + 1], f.area);
  const config = JSON.parse(await readFile(path.join(f.runtimeRoot, "config.json"), "utf8"));
  assert.deepEqual(config.projects, [{ name: path.basename(f.area), path: f.area }]);
  await f.owner.dispatch();
  assert.equal(f.state().children, 1); assert.equal(f.state().starts, 1);
});

test("lost cold start reply retains its launch intent and reads Ready without another start", async t => {
  const f = await fixture(t, { initiallyStopped: true, lostStartReply: true });
  await f.owner.prepare();
  await assert.rejects(f.owner.dispatch(), /cold start reply lost/u);
  assert.equal((await f.journal.read()).progress.publicRuntimeInstaller.phase, "cold_start_intent");
  f.setStatus({ current: f.input().target.releaseId, running: true, ready: true });
  assert.equal((await f.owner.dispatch()).status, "ready");
  assert.equal(f.state().children, 1); assert.equal(f.state().starts, 1);
});

test("invalid existing project configuration refuses before admitting installer or stopping", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.runtimeRoot, "config.json"), JSON.stringify({ projectRoot: f.area, projects: [] }));
  await assert.rejects(f.owner.prepare(), /non-empty/u);
  assert.equal((await f.journal.read()).progress.publicRuntimeInstaller, undefined);
  assert.equal(f.state().children, 0); assert.equal(f.state().starts, 0);
});

test("lost reply after owned scratch checkpoint resumes the same physical preparation", async t => {
  const f = await fixture(t);
  const write = f.journal.updateProgress;
  let refused = false;
  f.journal.updateProgress = async value => {
    await write(value);
    if (!refused && value.publicRuntimeInstaller?.phase === "scratch_prepared") {
      refused = true;
      throw new Error("lost scratch checkpoint reply");
    }
  };
  await assert.rejects(f.owner.prepare(), /lost scratch checkpoint/u);
  const before = (await f.journal.read()).progress.publicRuntimeInstaller;
  assert.equal(before.phase, "scratch_prepared");
  assert.equal((await f.owner.readback()).cursor.reason, "public-installer-preparing");
  await f.owner.prepare();
  const after = (await f.journal.read()).progress.publicRuntimeInstaller;
  assert.equal(after.phase, "prepared");
  assert.deepEqual(after.scratch, before.scratch);
  assert.equal(after.owner.operationId, before.owner.operationId);
  assert.equal(after.installer.sha256, f.input().target.installer.sha256);
  assert.equal(f.state().children, 0);
});
