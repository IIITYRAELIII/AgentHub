import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { publishChanged } from "../../publish-changed.mjs";
import { createPublicationArtifactSteps, artifactFiles, buildArtifact, readArtifact } from "../../src/infrastructure/process/publication-artifacts.mjs";
import { publicationCheckpointStore, runPublicationSteps } from "../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { publicationRunStore } from "../../src/infrastructure/persistence/publication-run-store.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const save = async (file, value) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, value); };

async function fixture(t, { runtimePublication = null } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source");
  const runtimeRoot = path.join(root, "runtime");
  const home = path.join(root, "home");
  const pkg = { publisher: "test", name: "hub", version: "1.0.0" };
  await save(path.join(sourceRoot, "VSCodeExtension", "package.json"), JSON.stringify(pkg));
  await save(path.join(sourceRoot, "VSCodeExtension", "extension.js"), "prepared extension");
  await save(path.join(sourceRoot, "install.py"), "# fixture installer");
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
      await save(path.join(sourceRoot, "assets", "mobile", "update.json"), JSON.stringify({ sha256: hash(apk), bytes: apk.length }));
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
        const bytes = JSON.stringify({ name: "agent-hub", version: "2026.9.16" });
        await save(path.join(releaseRoot, "package.json"), bytes);
        await save(path.join(releaseRoot, "runtime-manifest.json"), JSON.stringify({ releaseId, version: "2026.9.16",
          ...(expectedReleaseVersion ? { releaseVersion: state.overrideRuntimeVersion ?? expectedReleaseVersion } : {}), publicationRevision, sourceRoot,
          files: [{ path: "package.json", bytes: Buffer.byteLength(bytes), sha256: hash(bytes) }] }));
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
  return { root, sourceRoot, runtimeRoot, home, events, state, create };
}

const frozenRuntime = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", generation: 2,
  sourceCommit: "a".repeat(40), version: "2026.9.16.7" };

test("original artifact checkpoint yields the exact packager receipt and reuses before allocation", async t => {
  const f = await fixture(t, { runtimePublication: frozenRuntime });
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
