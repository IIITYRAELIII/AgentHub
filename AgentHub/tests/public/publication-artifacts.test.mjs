import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publishChanged } from "../../publish-changed.mjs";
import { releaseOperationRuntimePublicationInput } from "../../release-operation-publication-runner.mjs";
import { createPublicationArtifactSteps, artifactFiles, buildArtifact, readArtifact } from "../../src/infrastructure/process/publication-artifacts.mjs";
import { publicationCheckpointStore, runPublicationSteps } from "../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "../../src/infrastructure/persistence/publication-run-store.mjs";
import { artifactVersionIdentity } from "../../src/domain/agent-hub-version.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };

async function fixture(t, { runtimePublication = null, relocated = false } = {}) {
  const semantic = runtimePublication?.version.includes("+build.") ? artifactVersionIdentity(runtimePublication.version) : null;
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const physicalRuntimeRoot = path.join(root, "runtime");
  const runtimeRoot = relocated ? path.join(root, "runtime-alias") : physicalRuntimeRoot;
  if (relocated) {
    await mkdir(physicalRuntimeRoot);
    await symlink(physicalRuntimeRoot, runtimeRoot, process.platform === "win32" ? "junction" : "dir");
  }
  const home = path.join(root, "home");
  const pkg = { publisher: "test", name: "hub", version: "1.0.0" };
  await save(path.join(sourceRoot, "VSCodeExtension", "package.json"), JSON.stringify(pkg));
  await save(path.join(sourceRoot, "VSCodeExtension", "extension.js"), "prepared extension");
  await save(path.join(sourceRoot, "install.py"), "# fixture installer");
  await save(path.join(sourceRoot, "src/infrastructure/filesystem/git-invocation-policy.json"),
    await readFile(path.resolve(import.meta.dirname, "../../src/infrastructure/filesystem/git-invocation-policy.json")));
  await save(path.join(sourceRoot, "cloudflare-worker", "wrangler.jsonc"), JSON.stringify({ name: "fixture", main: "src/worker.mjs", assets: {}, routes: ["fixture.test/*"] }));
  const events = [];
  const state = { release: null, remoteTag: null, publication: { revision: "base" }, failBuild: false, failRuntime: false, failWorker: false, failExtension: false };
  const journalFactory = () => publicationRunStore({ runtimeRoot });
  const checkpoint = publicationCheckpointStore(path.join(runtimeRoot, "checkpoint.json"));
  const run = async (step) => {
    events.push(step.label);
    if (step.label === "Сборка Agent Hub Mobile") {
      const apk = Buffer.from("prepared APK");
      await save(path.join(sourceRoot, "assets", "mobile", "AgentHub-Mobile.apk"), apk);
      if (semantic) assert.deepEqual(step.args.slice(-2), ["-ArtifactVersion", runtimePublication.version]);
      await save(path.join(sourceRoot, "assets", "mobile", "update.json"), JSON.stringify({
        sha256: hash(apk), bytes: apk.length,
        ...(semantic ? { versionCode: semantic.buildNumber, versionName: semantic.publicVersion } : {}),
      }));
    }
    if (step.label === "Сборка Mini App Worker") {
      assert.ok(step.args.includes("--dry-run"));
      await save(path.join(step.args.at(-1), "worker.js"), "prepared bundled worker");
    }
    if (step.label === "Развёртывание Mini App Worker") {
      assert.ok(step.args.includes("--no-bundle"));
      state.remoteTag = step.args.at(-1);
      if (state.failWorker) { state.failWorker = false; throw new Error("lost Worker reply"); }
    }
    if (step.label === "Установка расширения VS Code") {
      const plan = JSON.parse(step.args.at(-1));
      const source = path.join(path.dirname(step.args[4]), "VSCodeExtension");
      const target = path.join(home, ".vscode", "extensions", plan.targetName);
      await cp(source, target, { recursive: true });
      await save(path.join(target, "package.json"), `${JSON.stringify(plan.package, null, 2)}\n`);
      await save(path.join(target, ".agent-hub-source.sha256"), `${plan.sourceFingerprint}\n`);
      await save(path.join(target, ".agent-hub-source.json"), `${JSON.stringify(plan.provenance, null, 2)}\n`);
      if (step.args[5] === "test-contour") await save(path.join(target, "extension-profile.json"), `${JSON.stringify({ profile: "test-contour" }, null, 2)}\n`);
      if (state.failExtension) { state.failExtension = false; throw new Error("lost extension reply"); }
    }
    if (step.label === "Активация runtime-релиза") await save(path.join(runtimeRoot, "active.json"), JSON.stringify({ release: state.release }));
  };
  const create = () => {
    const journal = journalFactory();
    const artifacts = createPublicationArtifactSteps({ sourceRoot, runtimeRoot, home, journal, run,
      runtimePublication,
      capture: async (_command, args) => {
        if (args.includes("deployments")) return JSON.stringify(state.remoteTag ? [{ id: "deployment", created_on: "2026-09-16", versions: [{ version_id: "version", percentage: 100 }] }] : []);
        if (args.includes("versions")) return JSON.stringify({ id: "version", annotations: { "workers/tag": state.remoteTag } });
        const revision = args.find((value) => /^[a-f0-9]{40}$/u.test(value)) ?? "a".repeat(40);
        return JSON.stringify([{ profile: "production", plan: {
          profile: "production", action: "install", package: pkg,
          provenance: { schemaVersion: 1, releaseVersion: pkg.version, sourceRevision: revision, sourceFingerprint: "f".repeat(64) },
          sourceFingerprint: "f".repeat(64), installedIdentity: "none", targetName: "test.hub-1.0.0",
        } }]);
      },
      loadWorker: async (file) => {
        if (file === "build-assets.mjs") return { buildWorkerAssets: async ({ output, mobileRoot }) => {
          events.push("worker assets");
          assert.equal(await readFile(path.join(mobileRoot, "AgentHub-Mobile.apk"), "utf8"), "prepared APK");
          await save(path.join(output, "index.html"), "prepared worker index");
        } };
        if (file === "publish-worker.mjs") return { verifyWorkerRelease: async ({ verify }) => verify({}) };
        return { verifyThemeDeployment: async ({ deployedRoot }) => {
          assert.equal(await readFile(path.join(deployedRoot, "index.html"), "utf8"), "prepared worker index");
          events.push("worker verified");
        } };
      },
      prepareRuntimeImpl: async ({ releaseId, publicationRevision, expectedReleaseVersion }) => {
        events.push("runtime build");
        state.preparedVersion = expectedReleaseVersion;
        if (state.failBuild) throw new Error("runtime build failed");
        const releaseRoot = path.join(runtimeRoot, "releases", releaseId);
        const version = semantic?.publicVersion ?? "2026.9.16";
        const bytes = JSON.stringify({ name: "agent-hub", version });
        await save(path.join(releaseRoot, "package.json"), bytes);
        const extra = relocated ? { "AgentHub.RuntimeHost.exe": "synthetic; never execute", "agent-hub-main.mjs": "export {};\n" } : {};
        for (const [name, value] of Object.entries(extra)) await save(path.join(releaseRoot, name), value);
        await save(path.join(releaseRoot, "runtime-manifest.json"), JSON.stringify({ releaseId, version,
          ...(semantic ? semantic : {}),
          ...(expectedReleaseVersion ? { releaseVersion: state.overrideRuntimeVersion ?? expectedReleaseVersion } : {}), publicationRevision, sourceRoot,
          files: [{ path: "package.json", bytes: Buffer.byteLength(bytes), sha256: hash(bytes) },
            ...Object.entries(extra).map(([name, value]) => ({ path: name, bytes: Buffer.byteLength(value), sha256: hash(value) }))] }));
        if (state.afterPrepare) await state.afterPrepare();
        if (state.losePreparedReply) { state.losePreparedReply = false; throw new Error("lost prepared reply"); }
      },
      installRuntimeImpl: async ({ releaseId }) => {
        events.push("runtime install");
        if (state.failRuntimeBefore) { state.failRuntimeBefore = false; throw new Error("runtime install rejected before effect"); }
        state.release = releaseId;
        await save(path.join(runtimeRoot, "current.json"), JSON.stringify({ current: releaseId }));
        if (state.failRuntime) { state.failRuntime = false; throw new Error("lost runtime reply"); }
      },
      verifyRuntimeImpl: async ({ releaseId }) => state.release === releaseId,
    });
    return {
      checkpoint, journal, runtimeRoot, run, artifacts, prepareArtifactSteps: artifacts.steps, verifyArtifacts: artifacts.verify,
      exclusive: async (operation) => operation(), revision: async () => "a".repeat(40),
      diff: async () => ["AgentHub/AndroidApp/app.gradle", "AgentHub/src/service.mjs", "AgentHub/VSCodeExtension/extension.js"],
      readState: async () => state.publication, writeState: async (value) => { state.publication = value; events.push("record"); },
      ensureWorkerDependency: async () => {},
      publishGit: async () => { events.push("Git"); },
      readRuntimeStatus: async () => ({ current: state.release, runningRelease: state.release, ready: true, running: true }),
      verifyRestart: async () => { events.push("ready"); },
      finalizePublication: async () => ({ status: "completed" }),
    };
  };
  return { root, sourceRoot, runtimeRoot, physicalRuntimeRoot, home, events, state, create };
}

const frozenRuntime = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", generation: 2,
  sourceCommit: "a".repeat(40), version: "2026.9.16.7" };

test("relocated artifact owner supplies physical receipt and body to the unchanged Python packager", async t => {
  const f = await fixture(t, { runtimePublication: frozenRuntime, relocated: true });
  const owner = f.create();
  await publishChanged(["--full-tests"], owner);
  const identity = (await owner.journal.read()).identity;
  const prepared = await owner.artifacts.preparedRuntimeReceipt(identity);
  const original = await readFile(prepared.receiptFile);
  const license = path.join(f.root, "LICENSE"), notices = path.join(f.root, "NOTICES");
  await writeFile(license, "synthetic license"); await writeFile(notices, "synthetic notices");
  const script = "import sys; from pathlib import Path; sys.path.insert(0, sys.argv[1]); import build_release as b; i,p,r=b._inputs(Path(sys.argv[2]),sys.argv[3],sys.argv[4],sys.argv[5],Path(sys.argv[6]),Path(sys.argv[7])); print(i['preparedReceiptSha256'])";
  const checkInput = () => promisify(execFile)(process.platform === "win32" ? "python.exe" : "python3", [
    "-X", "utf8", "-c", script, path.resolve(import.meta.dirname, "../../distribution"), prepared.receiptFile,
    prepared.receiptSha256, frozenRuntime.sourceCommit, frozenRuntime.version, license, notices,
  ], { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
  const { stdout } = await checkInput();
  assert.equal(stdout.trim(), prepared.receiptSha256);
  assert.equal(prepared.receipt.releaseRoot, path.join(await realpath(f.physicalRuntimeRoot), "releases", f.state.release));
  assert.equal(prepared.receiptFile, await realpath(prepared.receiptFile));
  assert.deepEqual(await f.create().artifacts.preparedRuntimeReceipt(identity), prepared);
  assert.deepEqual(await readFile(prepared.receiptFile), original);
  assert.equal(f.events.filter(x => x === "runtime build").length, 1);
  // Resolving the configured root must not erase an unexpected body junction.
  const retainedBody = `${prepared.receipt.releaseRoot}-retained`;
  await rename(prepared.receipt.releaseRoot, retainedBody);
  await symlink(retainedBody, prepared.receipt.releaseRoot, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await owner.artifacts.preparedRuntimeReceipt(identity)).receipt.releaseRoot, prepared.receipt.releaseRoot);
  await assert.rejects(checkInput(), /Reparse checkpoint path refused/u);
  await unlink(prepared.receipt.releaseRoot); await rename(retainedBody, prepared.receipt.releaseRoot);
  const receiptNamespace = path.dirname(path.dirname(prepared.receiptFile));
  const retainedNamespace = `${receiptNamespace}-retained`;
  await rename(receiptNamespace, retainedNamespace);
  await symlink(retainedNamespace, receiptNamespace, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(checkInput(), /Reparse checkpoint path refused/u);
  await unlink(receiptNamespace); await rename(retainedNamespace, receiptNamespace);
  const foreign = path.join(f.root, "foreign"); await mkdir(foreign);
  await unlink(f.runtimeRoot);
  await symlink(foreign, f.runtimeRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(owner.artifacts.preparedRuntimeReceipt(identity), /runtime root changed/u);
  assert.deepEqual(await readdir(foreign), []);
  assert.deepEqual(await readFile(prepared.receiptFile), original);
});

test("physical runtime root replacement and old alias receipts refuse without rewriting their originals", async t => {
  const f = await fixture(t, { runtimePublication: frozenRuntime, relocated: true });
  const owner = f.create(); await publishChanged(["--full-tests"], owner);
  const identity = (await owner.journal.read()).identity;
  const prepared = await owner.artifacts.preparedRuntimeReceipt(identity);
  // Construct the old producer's exact lexical receipt shape in this own fixture.
  const legacy = Buffer.from(`${JSON.stringify({ ...prepared.receipt,
    releaseRoot: path.join(f.runtimeRoot, "releases", prepared.receipt.releaseId) }, null, 2)}\n`);
  await writeFile(prepared.receiptFile, legacy);
  const artifactFile = path.join(path.dirname(path.dirname(prepared.receiptFile)), "artifact.json");
  const artifact = JSON.parse(await readFile(artifactFile));
  artifact.files.find(file => file.path === "prepared-runtime.json").sha256 = hash(legacy);
  await writeFile(artifactFile, `${JSON.stringify(artifact, null, 2)}\n`);
  const old = await owner.journal.read();
  await owner.journal.updateProgress({ artifactHashes: { ...old.progress.artifactHashes, runtime: hash(JSON.stringify(artifact)) } });
  const originalArtifact = await readFile(artifactFile);
  await assert.rejects(f.create().artifacts.preparedRuntimeReceipt(identity), /receipt differs from the original/u);
  assert.deepEqual(await readFile(prepared.receiptFile), legacy);
  assert.deepEqual(await readFile(artifactFile), originalArtifact);
  // A same-spelling physical directory replacement is also drift, not just a
  // different realpath. Keep the original directory alive to prevent inode reuse.
  const retained = `${f.physicalRuntimeRoot}-retained`;
  await rename(f.physicalRuntimeRoot, retained); await mkdir(f.physicalRuntimeRoot);
  await assert.rejects(owner.artifacts.preparedRuntimeReceipt(identity), /runtime root changed/u);
  assert.deepEqual(await readdir(f.physicalRuntimeRoot), []);
  assert.deepEqual(await readFile(path.join(retained, path.relative(f.physicalRuntimeRoot, prepared.receiptFile))), legacy);
});

test("runtime alias drift during preparation preserves the body and refuses before issuing a receipt", async t => {
  const f = await fixture(t, { runtimePublication: frozenRuntime, relocated: true });
  const owner = f.create(), identity = { revision: frozenRuntime.sourceCommit };
  const steps = await owner.artifacts.steps([{ label: "Сборка runtime-релиза" }], identity);
  await owner.journal.start(identity, steps);
  const foreign = path.join(f.root, "foreign"); await mkdir(foreign);
  f.state.afterPrepare = async () => {
    await unlink(f.runtimeRoot);
    await symlink(foreign, f.runtimeRoot, process.platform === "win32" ? "junction" : "dir");
  };
  await assert.rejects(steps.find(step => step.label === "Подготовка артефактов публикации").execute(), /runtime root changed/u);
  assert.equal(f.events.filter(x => x === "runtime build").length, 1);
  assert.equal(f.events.includes("Git"), false);
  assert.equal(f.events.includes("runtime install"), false);
  assert.deepEqual(await readdir(foreign), []);
  const [releaseId] = await readdir(path.join(f.physicalRuntimeRoot, "releases"));
  assert.equal(JSON.parse(await readFile(path.join(f.physicalRuntimeRoot, "releases", releaseId, "runtime-manifest.json"))).publicationRevision, frozenRuntime.sourceCommit);
  const [namespace] = await readdir(path.join(f.physicalRuntimeRoot, "publication-artifacts"));
  assert.deepEqual(await readdir(path.join(f.physicalRuntimeRoot, "publication-artifacts", namespace)), []);
});

test("semantic artifact freeze keeps original build and Android identity after lost prepare reply", async t => {
  const runtimePublication = { ...frozenRuntime, version: "2.0.0+build.30000001" };
  const f = await fixture(t, { runtimePublication });
  f.state.losePreparedReply = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /lost prepared reply/u);
  assert.equal(f.events.includes("Git"), false);
  await publishChanged(["--resume"], f.create());
  const owner = f.create(), identity = (await owner.journal.read()).identity;
  const first = await owner.artifacts.preparedRuntimeReceipt(identity);
  assert.equal(first.receipt.version, runtimePublication.version);
  assert.equal(Object.keys(first.receipt).length, 9);
  const original = await readFile(first.receiptFile);
  const repeated = await f.create().artifacts.preparedRuntimeReceipt(identity);
  assert.deepEqual(repeated, first);
  assert.deepEqual(await readFile(first.receiptFile), original);
  assert.equal(f.events.filter(x => x === "runtime build").length, 1);
  assert.equal(f.events.filter(x => x === "Сборка Agent Hub Mobile").length, 1);
});

test("frozen publication string fields reject coerced arrays and boxed strings before preparation", () => {
  let preparations = 0;
  for (const field of ["operationId", "sourceCommit", "version"]) {
    for (const value of [[frozenRuntime[field]], Object(frozenRuntime[field])]) {
      assert.throws(() => createPublicationArtifactSteps({
        sourceRoot: path.join(os.tmpdir(), "hub-frozen-type-source"),
        runtimeRoot: path.join(os.tmpdir(), "hub-frozen-type-runtime"),
        runtimePublication: { ...frozenRuntime, [field]: value },
        prepareRuntimeImpl: async () => { preparations++; },
      }), /Invalid frozen runtime publication input/u);
    }
  }
  assert.equal(preparations, 0);
});

test("original artifact checkpoint yields the exact packager receipt and reuses before allocation", async t => {
  const runtimePublication = releaseOperationRuntimePublicationInput({
    operation: { operationId: frozenRuntime.operationId },
    generation: { operationId: frozenRuntime.operationId, generation: frozenRuntime.generation },
    candidate: { commit: frozenRuntime.sourceCommit, manifest: { publication: {
      head: frozenRuntime.sourceCommit, releaseVersion: "2026.9.16", runtimeReleaseVersion: frozenRuntime.version,
    } } },
  });
  const f = await fixture(t, { runtimePublication });
  await publishChanged(["--full-tests"], f.create());
  const owner = f.create();
  const identity = (await owner.journal.read()).identity;
  const first = await owner.artifacts.preparedRuntimeReceipt(identity);
  const bytes = await readFile(first.receiptFile);
  assert.equal(first.receiptSha256, hash(bytes));
  assert.deepEqual(first.receipt, { schema: 1, phase: "PREPARED", operationId: frozenRuntime.operationId,
    generation: 2, sourceCommit: frozenRuntime.sourceCommit, releaseId: f.state.release,
    version: frozenRuntime.version, releaseRoot: path.join(f.runtimeRoot, "releases", f.state.release),
    manifestSha256: hash(await readFile(path.join(f.runtimeRoot, "releases", f.state.release, "runtime-manifest.json"))) });
  assert.equal(f.state.preparedVersion, frozenRuntime.version);
  await publishChanged(["--resume"], f.create());
  const repeated = await f.create().artifacts.preparedRuntimeReceipt(identity);
  assert.deepEqual(repeated, first);
  assert.deepEqual(await readFile(first.receiptFile), bytes);
  assert.equal(f.events.filter(x => x === "runtime build").length, 1);
  assert.equal(f.events.filter(x => x === "Полные тесты Agent Hub").length, 1);
  await assert.rejects(owner.artifacts.preparedRuntimeReceipt({ ...identity, revision: "b".repeat(40) }), /source differs/u);
  await writeFile(first.receiptFile, "changed receipt");
  await assert.rejects(owner.artifacts.preparedRuntimeReceipt(identity), /artifact bytes changed/u);
});

test("a frozen runtime version mismatch cannot reach publication or installation", async t => {
  const f = await fixture(t, { runtimePublication: frozenRuntime });
  f.state.overrideRuntimeVersion = "2026.9.16.8";
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /differs from the frozen/u);
  assert.equal(f.events.includes("Git"), false);
  assert.equal(f.events.includes("runtime install"), false);
});

test("prepared body survives a lost build reply and resumes before another allocation", async t => {
  const f = await fixture(t, { runtimePublication: frozenRuntime });
  f.state.losePreparedReply = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /lost prepared reply/u);
  assert.equal(f.events.includes("Git"), false);
  await publishChanged(["--resume"], f.create());
  assert.equal(f.events.filter(x => x === "runtime build").length, 1);
  const owner = f.create();
  const result = await owner.artifacts.preparedRuntimeReceipt((await owner.journal.read()).identity);
  assert.equal(result.receipt.version, frozenRuntime.version);
});

test("partial existing prepared body is preserved without another preparation", async t => {
  const f = await fixture(t, { runtimePublication: frozenRuntime });
  const artifactIdentity = { revision: frozenRuntime.sourceCommit, sourceRoot: f.sourceRoot,
    runtimeRoot: f.runtimeRoot, protocol: 1, runtimePublication: frozenRuntime };
  const releaseId = `publication-${hash(JSON.stringify(artifactIdentity)).slice(0, 32)}`;
  const partial = path.join(f.runtimeRoot, "releases", releaseId, "partial");
  await save(partial, "original incomplete output");
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /Existing prepared runtime is incomplete/u);
  assert.equal(await readFile(partial, "utf8"), "original incomplete output");
  assert.equal(f.events.includes("runtime build"), false);
  assert.equal(f.events.includes("Git"), false);
});

test("artifact pipeline builds all selected products before Git and applies the prepared bytes", async (t) => {
  const f = await fixture(t);
  const result = await publishChanged(["--full-tests"], f.create());
  assert.equal(result.status, "succeeded");
  const git = f.events.indexOf("Git");
  for (const label of ["Полные тесты Agent Hub", "Сборка Agent Hub Mobile", "worker assets", "Сборка Mini App Worker", "runtime build"]) assert.ok(f.events.indexOf(label) < git, label);
  for (const label of ["runtime install", "Развёртывание Mini App Worker", "Установка расширения VS Code", "ready", "record"]) assert.ok(f.events.indexOf(label) > git, label);
  assert.equal(f.events.filter((event) => event === "Полные тесты Agent Hub").length, 1);
  assert.equal((await f.create().journal.read()).identity.artifactProtocol, 1);
});

test("a build failure never pushes; resume reuses confirmed build products and successful tests", async (t) => {
  const f = await fixture(t); f.state.failBuild = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /runtime build failed/);
  assert.equal(f.events.includes("Git"), false);
  assert.equal(f.state.release, null);
  f.state.failBuild = false;
  await publishChanged(["--resume"], f.create());
  for (const label of ["Полные тесты Agent Hub", "Сборка Agent Hub Mobile", "worker assets", "Сборка Mini App Worker"]) assert.equal(f.events.filter((value) => value === label).length, 1, label);
});

for (const [flag, message, label] of [["failRuntime", "lost runtime reply", "runtime install"], ["failWorker", "lost Worker reply", "Развёртывание Mini App Worker"], ["failExtension", "lost extension reply", "Установка расширения VS Code"]]) {
  test(`lost ${flag} response is reconciled after process recreation without reapplying`, async (t) => {
    const f = await fixture(t); f.state[flag] = true;
    await assert.rejects(publishChanged(["--full-tests"], f.create()), new RegExp(message));
    await publishChanged(["--resume"], f.create());
    assert.equal(f.events.filter((value) => value === label).length, 1);
    if (flag === "failExtension") assert.equal(f.events.filter((value) => value === "worker verified").length, 1);
  });
}

test("unknown Worker result cannot blindly upload again", async (t) => {
  const f = await fixture(t); f.state.failWorker = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /lost Worker reply/);
  f.state.remoteTag = "another deployment";
  await assert.rejects(publishChanged(["--resume"], f.create()), /refusing blind replay/);
  assert.equal(f.events.filter((value) => value === "Развёртывание Mini App Worker").length, 1);
});

test("runtime drift after a lost response cannot overwrite another installed release", async (t) => {
  const f = await fixture(t); f.state.failRuntime = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /lost runtime reply/);
  f.state.release = "another-release";
  await assert.rejects(publishChanged(["--resume"], f.create()), /refusing blind replay/);
  assert.equal(f.state.release, "another-release");
  assert.equal(f.events.filter((value) => value === "runtime install").length, 1);
});

test("a definitive runtime rejection with unchanged pointer and stable files can retry", async (t) => {
  const f = await fixture(t); f.state.failRuntimeBefore = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /rejected before effect/);
  assert.equal(f.state.release, null);
  const record = await f.create().journal.read();
  assert.equal(record.progress.artifactEffects["Установка runtime-релиза"].status, "not_applied");
  await publishChanged(["--resume"], f.create());
  assert.equal(f.events.filter((value) => value === "runtime install").length, 2);
  assert.equal(f.events.filter((value) => value === "runtime build").length, 1);
});

test("a no-effect receipt cannot authorize overwriting later runtime changes", async (t) => {
  const f = await fixture(t); f.state.failRuntimeBefore = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /rejected before effect/);
  f.state.release = "later-release";
  await save(path.join(f.runtimeRoot, "current.json"), JSON.stringify({ current: "later-release" }));
  await assert.rejects(publishChanged(["--resume"], f.create()), /changed after the confirmed rejection/);
  assert.equal(f.state.release, "later-release");
  assert.equal(f.events.filter((value) => value === "runtime install").length, 1);
});

test("legacy deployment cannot silently acquire new artifact evidence", async () => {
  const previous = { identity: { revision: "old" }, steps: [{ label: "Публикация Git", status: "completed" }], progress: {} };
  const artifacts = createPublicationArtifactSteps({ sourceRoot: "source", runtimeRoot: "runtime",
    journal: { read: async () => previous }, run: () => assert.fail("cannot publish") });
  await assert.rejects(artifacts.steps([{ label: "Сборка runtime-релиза" }], { revision: "old" }), /original executor/);
  assert.deepEqual(previous.progress, {});
  await artifacts.verify({ revision: "old", labels: [] });
});

test("changed extension after a lost response cannot be mistaken for completion", async (t) => {
  const f = await fixture(t); f.state.failExtension = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /lost extension reply/);
  await writeFile(path.join(f.home, ".vscode", "extensions", "test.hub-1.0.0", "extension.js"), "unexpected");
  await assert.rejects(publishChanged(["--resume"], f.create()), /refusing blind replay/);
});

test("completed publication readback rejects missing prepared evidence and never redeploys", async (t) => {
  const f = await fixture(t);
  await publishChanged(["--full-tests"], f.create());
  const before = f.events.length;
  const [key] = await readdir(path.join(f.runtimeRoot, "publication-artifacts"));
  await rm(path.join(f.runtimeRoot, "publication-artifacts", key, "extension"), { recursive: true });
  await assert.rejects(publishChanged(["--resume"], f.create()), /artifact.*missing|evidence is missing/);
  assert.equal(f.events.length, before);
});

test("a replacement artifact manifest cannot override the journal's pinned digest", async (t) => {
  const f = await fixture(t); f.state.failBuild = true;
  await assert.rejects(publishChanged(["--full-tests"], f.create()), /runtime build failed/);
  const [key] = await readdir(path.join(f.runtimeRoot, "publication-artifacts"));
  const worker = path.join(f.runtimeRoot, "publication-artifacts", key, "worker");
  await writeFile(path.join(worker, "payload", "bundle", "worker.js"), "replacement");
  const manifest = JSON.parse(await readFile(path.join(worker, "artifact.json"), "utf8"));
  manifest.files = await artifactFiles(path.join(worker, "payload"));
  await writeFile(path.join(worker, "artifact.json"), JSON.stringify(manifest));
  await assert.rejects(publishChanged(["--resume"], f.create()), /Pinned worker artifact changed/);
  assert.equal(f.events.includes("Git"), false);
});

test("artifact readback detects missing, extra and changed payload files", async (t) => {
  const f = await fixture(t); const dir = path.join(f.root, "artifact"); const identity = { revision: "one" };
  await buildArtifact(dir, identity, async (payload) => { await writeFile(path.join(payload, "result"), "one"); return {}; });
  await readArtifact(dir, identity);
  await writeFile(path.join(dir, "payload", "extra"), "two");
  await assert.rejects(readArtifact(dir, identity), /bytes changed/);
  await rm(path.join(dir, "payload", "extra"));
  await writeFile(path.join(dir, "payload", "result"), "changed");
  await assert.rejects(readArtifact(dir, identity), /bytes changed/);
  await rm(path.join(dir, "payload", "result"));
  await assert.rejects(readArtifact(dir, identity), /bytes changed/);
});

test("checkpoint reuse checks the actual result before skipping a saved stage", async () => {
  let saved; let exists = true; let runs = 0;
  const checkpoint = { read: async () => saved, write: async (value) => { saved = value; } };
  const steps = [{ label: "build", fingerprint: "same", verifyReuse: async () => exists }];
  const options = { checkpoint, identity: { head: "same" }, run: async () => { runs += 1; exists = true; } };
  await runPublicationSteps(steps, options);
  await runPublicationSteps(steps, options);
  assert.equal(runs, 1);
  exists = false;
  await runPublicationSteps(steps, options);
  assert.equal(runs, 2);
});

test("prepared extension is applied and reconciled by the real Python installer in an isolated home", async (t) => {
  const f = await fixture(t);
  await cp(path.resolve(import.meta.dirname, "../../install.py"), path.join(f.sourceRoot, "install.py"));
  await save(path.join(f.sourceRoot, "package.json"), JSON.stringify({ version: "2026.9.18" }));
  const legacy = path.join(f.home, ".vscode/extensions/test.hub-1.0.0");
  await save(path.join(legacy, "package.json"), JSON.stringify({ publisher: "test", name: "hub", version: "1.0.0" }));
  await save(path.join(legacy, "extension.js"), "legacy extension");
  const invoke = async (command, args) => (await promisify(execFile)(command, args, { encoding: "utf8", windowsHide: true,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, LOCALAPPDATA: path.join(f.home, "AppData", "Local"), PYTHONUTF8: "1" },
  })).stdout;
  let installations = 0;
  const run = async (step) => {
    if (step.label === "Установка расширения VS Code") {
      installations += 1;
      await invoke(step.command, step.args);
      throw new Error("installer reply lost after actual swap");
    }
  };
  const journal = publicationRunStore({ runtimeRoot: f.runtimeRoot });
  const artifacts = createPublicationArtifactSteps({ sourceRoot: f.sourceRoot, runtimeRoot: f.runtimeRoot, home: f.home, journal, run, capture: invoke });
  const identity = { revision: "a".repeat(40), files: ["AgentHub/VSCodeExtension/extension.js"], labels: [] };
  const steps = await artifacts.steps([{ label: "Установка расширения VS Code" }], identity);
  identity.labels = steps.map((step) => step.label);
  await journal.start(identity, steps);
  await steps[0].execute();
  const [artifactId] = await readdir(path.join(f.runtimeRoot, "publication-artifacts"));
  const extensionArtifact = path.join(f.runtimeRoot, "publication-artifacts", artifactId, "extension");
  const gitPolicy = "src/infrastructure/filesystem/git-invocation-policy.json";
  const policyBytes = await readFile(path.join(f.sourceRoot, gitPolicy));
  const preparedPolicy = path.join(extensionArtifact, "payload", gitPolicy);
  assert.deepEqual(await readFile(preparedPolicy), policyBytes);
  const manifest = await readArtifact(extensionArtifact, {
    revision: identity.revision, sourceRoot: f.sourceRoot, runtimeRoot: f.runtimeRoot, protocol: 1,
  });
  assert.equal(manifest.files.find((file) => file.path === gitPolicy)?.sha256, hash(policyBytes));
  await writeFile(preparedPolicy, "{}");
  await assert.rejects(steps[1].execute(), /Publication artifact bytes changed or are missing/);
  assert.equal(installations, 0, "changed installer policy must refuse before application");
  await writeFile(preparedPolicy, policyBytes);
  await assert.rejects(steps[1].execute(), /installer reply lost/);
  await steps[1].execute();
  assert.equal(installations, 1);
  assert.equal(await readFile(path.join(f.home, ".vscode/extensions/test.hub-1.0.1/extension.js"), "utf8"), "prepared extension");
  assert.equal(JSON.parse(await readFile(path.join(f.home, ".vscode/extensions/test.hub-1.0.1/.agent-hub-source.json"), "utf8")).releaseVersion, "2026.9.18");
});

test("unchanged extension bytes retain installed provenance across publication revisions", async (t) => {
  const f = await fixture(t);
  await cp(path.resolve(import.meta.dirname, "../../install.py"), path.join(f.sourceRoot, "install.py"));
  await save(path.join(f.sourceRoot, "package.json"), JSON.stringify({ version: "2026.9.18" }));
  const invoke = async (command, args) => (await promisify(execFile)(command, args, { encoding: "utf8", windowsHide: true,
    env: { ...process.env, HOME: f.home, USERPROFILE: f.home, LOCALAPPDATA: path.join(f.home, "AppData", "Local"), PYTHONUTF8: "1" },
  })).stdout;
  let installations = 0;
  const install = async (step) => {
    if (step.label !== "Установка расширения VS Code") return;
    installations += 1;
    await invoke(step.command, step.args);
  };
  const applyRevision = async (revision, runtimeRoot) => {
    const journal = publicationRunStore({ runtimeRoot });
    const artifacts = createPublicationArtifactSteps({ sourceRoot: f.sourceRoot, runtimeRoot, home: f.home, journal, run: install, capture: invoke });
    const identity = { revision, files: ["AgentHub/VSCodeExtension/extension.js"], labels: [] };
    const steps = await artifacts.steps([{ label: "Установка расширения VS Code" }], identity);
    identity.labels = steps.map((step) => step.label);
    await journal.start(identity, steps);
    await steps[0].execute();
    await steps[1].execute();
    await artifacts.verify(identity);
  };

  await applyRevision("a".repeat(40), f.runtimeRoot);
  await applyRevision("b".repeat(40), path.join(f.root, "runtime-second"));

  assert.equal(installations, 1, "identical extension bytes must not be installed again");
  const provenance = JSON.parse(await readFile(path.join(f.home, ".vscode/extensions/test.hub-1.0.0/.agent-hub-source.json"), "utf8"));
  assert.equal(provenance.sourceRevision, "a".repeat(40));
});

test("the pinned Wrangler builds a deployable Worker bundle before any remote effect", async (t) => {
  const f = await fixture(t);
  const sourceRoot = path.resolve(import.meta.dirname, "../..");
  const journal = publicationRunStore({ runtimeRoot: f.runtimeRoot });
  const identity = { revision: "b".repeat(40), labels: ["Развёртывание Mini App Worker"], files: [] };
  const calls = [];
  const artifacts = createPublicationArtifactSteps({ sourceRoot, runtimeRoot: f.runtimeRoot, journal,
    run: async (step) => {
      calls.push(step.args);
      assert.ok(step.args.includes("--dry-run"), "test must never upload or deploy");
      const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:CF_|CLOUDFLARE_|WRANGLER_|AGENT_HUB_PUBLICATION_)/i.test(key)));
      await promisify(execFile)(step.command, step.args, { cwd: sourceRoot, encoding: "utf8", windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024,
        env: { ...environment, HOME: f.home, USERPROFILE: f.home, LOCALAPPDATA: path.join(f.home, "AppData", "Local"),
          APPDATA: path.join(f.home, "AppData", "Roaming"), XDG_CONFIG_HOME: path.join(f.home, "config"), WRANGLER_SEND_METRICS: "false" },
      });
    },
  });
  const steps = await artifacts.steps([{ label: "Развёртывание Mini App Worker" }], identity);
  identity.labels = steps.map((step) => step.label);
  await journal.start(identity, steps);
  await steps[0].execute();
  assert.equal(calls.length, 1);
  await steps[0].execute();
  assert.equal(calls.length, 1, "verified bundle must be reused");
  assert.ok((await journal.read()).progress.artifactHashes.worker);
});
