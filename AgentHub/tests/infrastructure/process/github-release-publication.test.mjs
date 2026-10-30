import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { publishChanged } from "../../../publish-changed.mjs";
import { distributionArtifactAdapter, releaseOperationDeploymentProfile } from "../../../release-operation-publication-runner.mjs";
import { createGitHubDistributionSteps, githubReleaseTransport } from "../../../src/infrastructure/process/github-release-publication.mjs";
import { publicationRunStore } from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { publicationCheckpointStore } from "../../../src/infrastructure/persistence/publication-checkpoint.mjs";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const names = ["AgentHub-win32-x64.zip", "AgentHub-win32-x64.zip.json", "install_release.py", "SHA256SUMS"];

async function fixture(t, { relocated = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-gh-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, "source", "AgentHub");
  await mkdir(sourceRoot, { recursive: true });
  const physicalExecutionRoot = path.join(root, "execution");
  const executionRoot = relocated ? path.join(root, "execution-alias") : physicalExecutionRoot;
  if (relocated) {
    await mkdir(physicalExecutionRoot);
    await symlink(physicalExecutionRoot, executionRoot, process.platform === "win32" ? "junction" : "dir");
  }
  const runtimeRoot = path.join(root, "runtime");
  const frozen = { operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe", generation: 1,
    sourceCommit: "a".repeat(40), version: "2.0.1+build.100" };
  const state = { release: null, tag: null, uploads: [], writes: [], events: [], packs: 0,
    publication: { revision: "b".repeat(40) }, failUpload: null, dropUpload: false, failCreate: false };
  const assetsRoot = path.join(executionRoot, "distribution", frozen.version, "assets");
  let result;
  const capture = async (command, args) => {
    if (command === "git") return "https://github.com/IIITYRAELIII/AgentHub.git\n";
    assert.ok(command.startsWith("python"));
    assert.equal(args[args.indexOf("--source-commit") + 1], frozen.sourceCommit);
    assert.equal(args[args.indexOf("--version") + 1], frozen.version);
    if (relocated) {
      const output = args[args.indexOf("--output-root") + 1];
      assert.equal(output, path.join(await realpath(physicalExecutionRoot), "distribution"));
      await promisify(execFile)(command, ["-X", "utf8", "-c",
        "import sys; from pathlib import Path; sys.path.insert(0,sys.argv[1]); import build_release as b; b._plain_chain(Path(sys.argv[2]))",
        path.resolve(import.meta.dirname, "../../../distribution"), output],
      { encoding: "utf8", windowsHide: true, env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    }
    if (!result) {
      state.events.push("package"); state.packs += 1;
      await mkdir(assetsRoot, { recursive: true });
      const assets = [];
      for (const name of names) {
        const bytes = Buffer.from(`synthetic fixture ${name}`);
        await writeFile(path.join(assetsRoot, name), bytes);
        assets.push({ name, bytes: bytes.length, sha256: hash(bytes) });
      }
      result = { phase: "PACKAGED", inputIdentity: "c".repeat(64), inputs: {
        repository: "IIITYRAELIII/AgentHub", ...frozen, publicVersion: "2.0.1",
      }, assets };
    }
    return JSON.stringify(result);
  };
  const api = async (method, route, options = {}) => {
    if (method !== "GET") state.writes.push({ method, route });
    const base = "/repos/IIITYRAELIII/AgentHub";
    if (route === base) return { id: 1428402643, owner: { id: 95281881 }, private: false };
    if (route.startsWith(`${base}/releases?`)) return state.release ? [structuredClone(state.release)] : [];
    if (route === `${base}/git/ref/tags/2.0.1`) return state.tag;
    if (route === `${base}/git/refs`) { state.tag = { object: { type: "commit", sha: options.body.sha } }; return state.tag; }
    if (route === `${base}/releases` && method === "POST") {
      state.events.push("github");
      state.release = { id: 70, ...options.body, assets: [] };
      if (state.failCreate) { state.failCreate = false; throw new Error("lost create reply"); }
      return structuredClone(state.release);
    }
    if (route === `${base}/releases/70`) {
      if (method === "PATCH") { state.release.draft = false; state.release.published_at = "2026-10-27T00:00:00Z"; }
      return structuredClone(state.release);
    }
    if (route.startsWith(`${base}/releases/70/assets?name=`)) {
      const name = decodeURIComponent(route.split("name=")[1]);
      const bytes = await readFile(options.file);
      state.uploads.push(name);
      if (!state.dropUpload) state.release.assets.push({ name, id: state.uploads.length, state: "uploaded",
        size: bytes.length, digest: `sha256:${hash(bytes)}` });
      if (state.failUpload === name) { state.failUpload = null; throw new Error("lost upload reply"); }
      return {};
    }
    throw new Error(`Unexpected fixture request ${method} ${route}`);
  };
  const journal = publicationRunStore({ runtimeRoot: executionRoot });
  const artifacts = {
    async steps(steps) {
      return [...steps.filter(step => step.label !== "Сборка runtime-релиза"),
        { label: "Подготовка артефактов публикации", reusable: false, execute: async () => state.events.push("prepare") },
        { label: "Установка runtime-релиза", execute: () => assert.fail("publisher runtime installation") }];
    },
    async preparedRuntimeReceipt() {
      return { receipt: { ...frozen }, receiptFile: path.join(root, "prepared.json"), receiptSha256: "d".repeat(64) };
    },
  };
  const distribution = createGitHubDistributionSteps({ sourceRoot, repositoryRoot: path.dirname(sourceRoot),
    executionRoot, runtimePublication: frozen, artifacts, journal, capture, api });
  const adapter = distributionArtifactAdapter(artifacts, distribution);
  const run = (resume = false, deploymentProfile = "github-release") => publishChanged(["--from", "b".repeat(40), "--quick", ...(resume ? ["--resume"] : [])], {
    repositoryRoot: path.dirname(sourceRoot), runtimeRoot, deploymentProfile,
    exclusive: fn => fn(), before: async () => {}, revision: async () => frozen.sourceCommit,
    diff: async () => ["AgentHub/src/runtime/example.mjs", "AgentHub/assets/web-app/example.js"],
    readState: async () => state.publication, writeState: async value => { state.publication = value; },
    ensureWorkerDependency: () => assert.fail("Worker dependency preparation"),
    restart: () => assert.fail("publisher restart"), readRuntimeStatus: () => assert.fail("publisher runtime probe"),
    run: async step => { assert.equal(step.label, "Проверка синтаксиса Agent Hub"); state.events.push("validation"); },
    checkpoint: publicationCheckpointStore(path.join(executionRoot, "checkpoint.json")), journal,
    prepareArtifactSteps: adapter.steps, verifyArtifacts: adapter.verify,
    publishGit: async () => state.events.push("git"),
  });
  return { root, executionRoot, state, frozen, journal, artifacts, distribution, run, assetsRoot, capture, api };
}

test("distribution resolves only its execution root and refuses actual alias retarget before packaging", async t => {
  const f = await fixture(t, { relocated: true });
  await f.run();
  assert.equal(f.state.packs, 1);
  const foreign = path.join(f.root, "foreign"); await mkdir(foreign);
  const output = path.dirname(path.dirname(f.assetsRoot));
  const retained = `${output}-retained`;
  await rename(output, retained);
  await symlink(foreign, output, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.distribution.steps({ revision: f.frozen.sourceCommit })[0].execute(), /Reparse checkpoint path refused/u);
  assert.deepEqual(await readdir(foreign), []);
  await unlink(output); await rename(retained, output);
  await unlink(f.executionRoot);
  await symlink(foreign, f.executionRoot, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(f.distribution.steps({ revision: f.frozen.sourceCommit })[0].execute(), /execution root changed/u);
  assert.equal(f.state.packs, 1);
  assert.deepEqual(await readdir(foreign), []);
});

test("approved GitHub target uses the existing publication journal: prepare/package/Git/assets, repeat has no effects", async t => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.status, "published");
  assert.deepEqual(f.state.events, ["validation", "prepare", "package", "git", "github"]);
  assert.deepEqual(f.state.uploads, names);
  assert.equal(f.state.publication.plan.runtimeRestart, false);
  const saved = await f.journal.read();
  assert.equal(saved.progress.githubDistribution.status, "applied");
  assert.equal(saved.identity.deploymentProfile, "github-release");
  const writes = structuredClone(f.state.writes), events = [...f.state.events];
  assert.equal((await f.run()).alreadyCompleted, true);
  assert.deepEqual(f.state.writes, writes);
  assert.deepEqual(f.state.events, events);
  assert.equal((await f.journal.read()).runId, saved.runId);
  assert.equal(f.state.packs, 1);
});

test("lost successful asset reply resumes by exact digest without a second upload or version", async t => {
  const f = await fixture(t); f.state.failUpload = names[0];
  await assert.rejects(f.run(), /lost upload reply/u);
  const first = await f.journal.read();
  assert.equal((await f.run(true)).status, "published");
  assert.deepEqual(f.state.uploads, names);
  assert.equal((await f.journal.read()).runId, first.runId);
  assert.equal(f.state.packs, 1);
});

test("lost draft creation reply reads the original marker and never creates a second release", async t => {
  const f = await fixture(t); f.state.failCreate = true;
  await assert.rejects(f.run(), /lost create reply/u);
  assert.equal((await f.run(true)).status, "published");
  assert.equal(f.state.writes.filter(row => row.method === "POST" && row.route.endsWith("/releases")).length, 1);
});

test("saved distribution cannot resume as an installed target or accept another prepared source", async t => {
  const f = await fixture(t); await f.run();
  await assert.rejects(f.run(true, "installed-runtime"), /deployment profile differs/u);
  const writes = [...f.state.writes];
  f.artifacts.preparedRuntimeReceipt = async () => ({ receipt: { ...f.frozen, sourceCommit: "e".repeat(40) } });
  await assert.rejects(f.run(), /PREPARED receipt changed/u);
  assert.deepEqual(f.state.writes, writes);
});

test("unconfirmed asset absence preserves original uncertainty and refuses a blind second upload", async t => {
  const f = await fixture(t); f.state.failUpload = names[0]; f.state.dropUpload = true;
  await assert.rejects(f.run(), /lost upload reply/u);
  await assert.rejects(f.run(true), /unconfirmed; refusing replay/u);
  assert.deepEqual(f.state.uploads, [names[0]]);
  assert.equal(f.state.release.draft, true);
});

test("foreign release and moved tag refuse without replacing remote assets", async t => {
  for (const kind of ["foreign-release", "moved-tag"]) {
    const f = await fixture(t);
    if (kind === "foreign-release") f.state.release = { id: 70, tag_name: "2.0.1", body: "foreign", prerelease: false, assets: [] };
    else f.state.tag = { object: { type: "commit", sha: "e".repeat(40) } };
    await assert.rejects(f.run(), kind === "foreign-release" ? /foreign or changed/u : /another source/u);
    assert.deepEqual(f.state.writes, []);
  }
});

test("changed packaged asset refuses before a completed release can be reused", async t => {
  const f = await fixture(t); await f.run();
  await writeFile(path.join(f.assetsRoot, names[0]), "foreign");
  const writes = [...f.state.writes];
  await assert.rejects(f.run(), /PACKAGED asset changed/u);
  assert.deepEqual(f.state.writes, writes);
});

test("only the original explicit target environment selects distribution", () => {
  const operation = { authorization: { approvedTargets: [{ targetId: "public", kind: "agent-hub-publication", environment: "github-release" },
    { targetId: "installed", kind: "agent-hub-publication", environment: "production" }] } };
  assert.equal(releaseOperationDeploymentProfile(operation, "public"), "github-release");
  assert.equal(releaseOperationDeploymentProfile(operation, "installed"), "installed-runtime");
  assert.throws(() => releaseOperationDeploymentProfile(operation, "foreign"), /not authorized/u);
});

test("publisher transport refuses foreign routes and authenticated redirects", async () => {
  const requests = [];
  const api = githubReleaseTransport({ run: async () => ({ stdout: "synthetic-token\n" }),
    request: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => ({}) }; } });
  await assert.rejects(api("GET", "/repos/foreign/repository/releases"), /Foreign/u);
  assert.equal(requests.length, 0);
  await api("GET", "/repos/IIITYRAELIII/AgentHub/releases");
  assert.equal(requests[0].options.redirect, "error");
  assert.equal(requests[0].options.headers.Authorization, "Bearer synthetic-token");
});

test("Git publication state alone cannot settle a GitHub asset target", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-gh-effect-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const commit = "a".repeat(40);
  const candidate = { repositoryRoot: root, releaseRoot: path.join(root, "frozen"), commit, baseCommit: "b".repeat(40) };
  const owner = new ReleaseOperationPublication({ dataDir: root, runtimeRoot: root,
    readPublicationStateImpl: async () => ({ revision: commit }), gitRemoteHeadImpl: async () => commit });
  const result = await owner.readback({ operation: { operationId: "op" },
    generation: { generation: 1, identitySha256: "g", candidates: [candidate] },
    target: { targetId: "public", kind: "agent-hub-publication", environment: "github-release", repositoryRoot: root } });
  assert.equal(result.status, "partial");
});

test("distribution readback preserves GitHub intent/unknown evidence when origin is back at base", async t => {
  for (const kind of ["pristine", "pre-effect", "tag", "create", "upload", "result", "malformed", "read-error", "missing-after-runner", "foreign-journal"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "hub-gh-negative-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const commit = "a".repeat(40), baseCommit = "b".repeat(40);
    const candidate = { repositoryRoot: root, releaseRoot: path.join(root, "frozen"), commit, baseCommit };
    const journal = publicationRunStore({ runtimeRoot: path.join(root, "journal") });
    await journal.start({ revision: kind === "foreign-journal" ? "f".repeat(40) : commit }, []);
    const progress = { inputIdentity: "c".repeat(64), createStarted: false, uploads: {} };
    if (kind === "tag") progress.tagStarted = true;
    if (kind === "create") progress.createStarted = true;
    if (kind === "upload") Object.assign(progress, { releaseId: 70, uploads: { [names[0]]: "started" } });
    if (kind === "result") progress.result = { sourceCommit: commit };
    if (kind !== "pristine") await journal.updateProgress({ githubDistribution: kind === "malformed" ? "invalid" : progress });
    await journal.finish("failed", new Error("lost remote reply"));
    if (kind === "missing-after-runner") {
      const runner = path.join(root, "release-operation-executions", hash("original:1:public"), "runner.json");
      await mkdir(path.dirname(runner), { recursive: true });
      await writeFile(runner, JSON.stringify({ candidate: "g", status: "exited", pid: null }));
    }
    const owner = new ReleaseOperationPublication({ dataDir: root, runtimeRoot: root,
      readPublicationStateImpl: async () => ({ revision: baseCommit }), gitRemoteHeadImpl: async () => baseCommit,
      publicationRunStoreFactory: () => kind === "read-error" ? { read: async () => { throw new Error("unreadable journal"); } }
        : kind === "missing-after-runner" ? { read: async () => null } : journal });
    const result = await owner.readback({ operation: { operationId: "original" },
      generation: { generation: 1, identitySha256: "g", candidates: [candidate] },
      target: { targetId: "public", kind: "agent-hub-publication", environment: "github-release", repositoryRoot: root } });
    if (["pristine", "pre-effect"].includes(kind)) assert.equal(result.status, "not_applied", kind);
    else assert.ok(["partial", "unknown"].includes(result.status), `${kind}: Git cannot disprove distribution effects`);
    assert.equal((await journal.read()).status, "failed");
  }
});
