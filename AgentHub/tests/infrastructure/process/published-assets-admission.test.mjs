import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { HubMcpService } from "../../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { ReleaseOperationService } from "../../../src/application/release-operation-service.mjs";
import { ReleaseOperationStore } from "../../../src/infrastructure/persistence/release-operation-store.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { publicationRunStore } from "../../../src/infrastructure/persistence/publication-run-store.mjs";
import { ReleaseOperationPublication } from "../../../src/infrastructure/process/release-operation-publication.mjs";
import { readReleaseToolPackage } from "../../../src/infrastructure/process/release-tool-package.mjs";
import { executeRelease } from "../../../release.mjs";

const sha = value => createHash("sha256").update(value).digest("hex");
const execute = promisify(execFile);
const names = ["AgentHub-win32-x64.zip", "AgentHub-win32-x64.zip.json", "install_release.py", "SHA256SUMS"];
const save = async (file, value) => {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
};

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ah-assets-admission-"));
  let catalog, boardStore, operations;
  t.after(async () => {
    await operations?.drainAddressed({ operationId: "fefefefe-fefe-4efe-8efe-fefefefefefe" });
    boardStore?.close();
    catalog?.close();
    await rm(root, { recursive: true, force: true });
  });
  const dataDir = path.join(root, "data");
  const runtimeRoot = path.join(root, "runtime");
  const repositoryRoot = path.join(root, "primary");
  const releaseRoot = path.join(root, "frozen", "repository");
  await mkdir(releaseRoot, { recursive: true });
  await mkdir(repositoryRoot);
  const git = async (...args) => (await execute("git", args, { cwd: releaseRoot, windowsHide: true })).stdout.trim();
  await git("init", "-b", "main");
  await save(path.join(releaseRoot, "AgentHub", "app.mjs"), "export const frozen = true;\n");
  await git("add", ".");
  await git("-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", "frozen fixture");
  const commit = await git("rev-parse", "HEAD");
  const tree = await git("rev-parse", "HEAD^{tree}");
  await save(path.join(releaseRoot, ".git", "agent-hub-release-clone.json"), {
    schemaVersion: 1, kind: "agent-hub-owned-release-clone", releaseRoot,
    releaseGitCommonDir: path.join(releaseRoot, ".git"), primaryRoot: repositoryRoot,
    primaryGitCommonDir: path.join(repositoryRoot, ".git"),
  });
  const databaseFile = path.join(root, "catalog.sqlite");
  catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  boardStore = new TaskBoardStore({ databaseFile });
  const board = new TaskBoardService({ store: boardStore, workspaceCatalog: catalog });
  const workspace = catalog.createWorkspace({ name: "Published assets" });
  const rmStream = catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } });
  const ordinary = catalog.createStream({ workspaceId: workspace.id, name: "ordinary" });
  for (const [stream, threadId] of [[rmStream, "rm-thread"], [ordinary, "ordinary-thread"]]) {
    catalog.bindThread({ provider: "codex", threadId, streamId: stream.id });
  }
  const selected = boardStore.create({ text: "Published source", workspaceId: workspace.id, bucket: "workspace" });
  const operationId = "fefefefe-fefe-4efe-8efe-fefefefefefe";
  const store = new ReleaseOperationStore({ dataDir, idFactory: () => operationId });
  const originalTarget = { targetId: "production", kind: "agent-hub-publication", environment: "production", repositoryRoot };
  const target = { ...originalTarget, targetId: "agent-hub-github-release", environment: "github-release" };
  const frozen = { operationId, generation: 1, sourceCommit: commit, version: "2.1.5+build.100" };
  const tool = await readReleaseToolPackage();
  const toolIdentity = { name: tool.name, version: tool.version, sha256: tool.sha256 };
  const parentRoot = path.join(dataDir, "release-operation-executions", sha(`${operationId}:1:production`));
  const packageFile = path.join(parentRoot, "distribution", frozen.version, "result.json");
  const assetsRoot = path.join(path.dirname(packageFile), "assets");
  const assets = [];
  for (const name of names) {
    const value = `actual fixture asset ${name}`;
    await save(path.join(assetsRoot, name), value);
    assets.push({ name, bytes: Buffer.byteLength(value), sha256: sha(value) });
  }
  const runtimeManifest = { publicationRevision: commit, releaseVersion: frozen.version };
  const preparedRelease = path.join(runtimeRoot, "releases", "publication-fixture");
  await save(path.join(preparedRelease, "runtime-manifest.json"), runtimeManifest);
  const receiptFile = path.join(root, "prepared-runtime.json");
  const prepared = { schema: 1, phase: "PREPARED", ...frozen, releaseId: "publication-fixture",
    releaseRoot: preparedRelease, manifestSha256: sha(JSON.stringify(runtimeManifest)) };
  await save(receiptFile, prepared);
  const packaged = { schema: 1, phase: "PACKAGED", inputIdentity: "c".repeat(64),
    inputs: { ...frozen, repository: "IIITYRAELIII/AgentHub", publicVersion: "2.1.5",
      preparedReceiptSha256: sha(JSON.stringify(prepared)), tool: toolIdentity }, assets };
  await save(packageFile, packaged);
  const state = { release: null, tag: null, writes: [], loseCreate: false, loseUpload: false, dropUpload: false, deliveries: 0 };
  const api = async (method, route, options = {}) => {
    const base = "/repos/IIITYRAELIII/AgentHub";
    if (method !== "GET") state.writes.push([method, route]);
    if (route === base) return { id: 1428402643, owner: { id: 95281881 }, private: false };
    if (route.startsWith(`${base}/releases?`)) return state.release ? [structuredClone(state.release)] : [];
    if (route === `${base}/git/ref/tags/2.1.5`) return state.tag;
    if (route === `${base}/git/refs`) return state.tag = { object: { type: "commit", sha: options.body.sha } };
    if (route === `${base}/releases` && method === "POST") {
      state.release = { id: 70, ...options.body, assets: [] };
      if (state.loseCreate) { state.loseCreate = false; throw new Error("lost create response"); }
      return structuredClone(state.release);
    }
    if (route === `${base}/releases/70`) {
      if (method === "PATCH") Object.assign(state.release, { draft: false, published_at: "2026-11-09T00:00:00Z" });
      return structuredClone(state.release);
    }
    if (route.startsWith(`${base}/releases/70/assets?name=`)) {
      const name = decodeURIComponent(route.split("name=")[1]);
      const bytes = await readFile(options.file);
      if (!state.dropUpload) state.release.assets.push({ id: state.release.assets.length + 1,
        name, size: bytes.length, digest: `sha256:${sha(bytes)}`, state: "uploaded" });
      if (state.loseUpload) { state.loseUpload = false; throw new Error("lost upload response"); }
      return {};
    }
    throw new Error(`Unexpected fixture request ${method} ${route}`);
  };
  const publication = new ReleaseOperationPublication({ dataDir, runtimeRoot,
    distributionApi: api,
    distributionCapture: async command => command === "git"
      ? "https://github.com/IIITYRAELIII/AgentHub.git\n" : JSON.stringify(packaged),
    createArtifactSteps: () => ({ preparedRuntimeReceipt: async () => ({
      receipt: prepared, receiptFile, receiptSha256: sha(JSON.stringify(prepared)),
    }) }),
  });
  const callbacks = [];
  operations = new ReleaseOperationService({ store, schedule: fn => callbacks.push(fn),
    processAlive: pid => pid === process.pid,
    compose: async () => ({ repositoryBases: [{ repositoryRoot, baseCommit: commit }],
      selectedResults: [{ taskId: selected.id, resultCommit: commit, tree, acceptanceRevision: 1 }],
      candidates: [{ repositoryRoot, releaseRoot, commit, tree, manifestHash: "a".repeat(64),
        manifest: { publication: { runtimeReleaseVersion: frozen.version } } }] }),
    validate: async () => ({ status: "passed" }),
    publishTarget: async () => ({ status: "applied", revision: commit }),
    readTarget: async () => ({ status: "not_applied" }),
    finalize: async () => ({ closed: [selected.id] }),
    publishPreparedAssets: input => { state.deliveries++; return publication.publishPreparedAssets(input); },
  });
  const ack = operations.start({ requestId: "original-production", workspaceId: workspace.id,
    streamId: rmStream.id, threadId: "rm-thread", authorization: {
      taskIds: [selected.id], approvedTargets: [originalTarget], validationMode: "full",
    } });
  await callbacks.shift()();
  const original = await operations.drain(ack.operationId);
  assert.equal(original.operation.state, "done");
  const generation = original.generations[0];
  await save(path.join(parentRoot, "runner.json"), { schemaVersion: 1, operationId, generation: 1,
    candidate: generation.identitySha256, targetId: "production", tool: toolIdentity,
    status: "exited", pid: 99999999, exitCode: 1, completedAt: "2026-11-08T00:00:00Z" });
  const parentJournal = publicationRunStore({ runtimeRoot: parentRoot });
  await parentJournal.start({ revision: commit, worktreeRoot: releaseRoot, runtimeRoot }, []);
  await parentJournal.finish("failed", new Error("controlled legacy completion failure"));
  const parentBytes = await readFile(path.join(parentRoot, "publication-status.json"));
  const hub = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, taskLifecycle: {},
    workLog: { threadTurns: () => [] }, attachmentDirectory: path.join(root, "attachments"), secret: "synthetic-assets",
    releasePreflight: { preflight: () => assert.fail("no preparation") },
    releaseCompleter: { completeRelease: () => assert.fail("no legacy completion") }, releaseOperations: operations,
    reconcilePendingOnStartup: false });
  const token = hub.contextToken({ provider: "codex", threadId: "rm-thread" });
  const ordinaryToken = hub.contextToken({ provider: "codex", threadId: "ordinary-thread" });
  let sequence = 0;
  const request = () => ({ context_token: token, operation_id: operationId, request_id: `assets-${++sequence}`,
    expected_revision: original.operation.revision, expected_generation: 1,
    assets_publication: { target: structuredClone(target), inputIdentity: packaged.inputIdentity,
      preparedReceiptSha256: sha(JSON.stringify(prepared)), packageResultSha256: sha(JSON.stringify(packaged)),
      toolSha256: tool.sha256 } });
  const unchanged = async () => {
    const actual = operations.get(operationId);
    assert.deepEqual(actual.operation, original.operation);
    assert.deepEqual(actual.generations, original.generations);
    assert.deepEqual(actual.receipts.filter(item => !item.stepId.startsWith("publish-assets:")), original.receipts);
    assert.deepEqual(await readFile(path.join(parentRoot, "publication-status.json")), parentBytes);
  };
  return { hub, operations, store, state, publication, original, packageFile, request, ordinaryToken, unchanged,
    root, rmStream, token, receiptFile };
}

test("public RM assets admission preserves DONE original and reuses the exact published package", async t => {
  const f = await fixture(t);
  const request = f.request();
  const result = await f.hub.call("hub_release_continue", request);
  assert.equal(result.assetsPublication?.status, "applied");
  assert.deepEqual(f.state.release.assets.map(item => item.name), names);
  assert.equal(f.state.release.draft, false);
  const receipt = f.store.latestStep(request.operation_id, 1, "publish-assets:agent-hub-github-release");
  assert.equal(receipt.status, "applied");
  assert.equal(receipt.input.authorization.requestId, request.request_id);
  assert.equal(receipt.input.target.environment, "github-release");
  const writes = f.state.writes.length;
  assert.deepEqual(await f.hub.call("hub_release_continue", request), result);
  assert.equal(f.state.writes.length, writes);
  assert.equal((await f.hub.call("hub_release_continue", f.request())).assetsPublication.status, "applied");
  assert.equal(f.state.writes.length, writes);
  await f.unchanged();
});

test("assets admission refuses foreign actor, stale CAS and changed package before remote effects", async t => {
  const f = await fixture(t);
  await assert.rejects(f.hub.call("hub_release_continue", { ...f.request(), context_token: f.ordinaryToken }), /Release Manager/u);
  await assert.rejects(f.hub.call("hub_release_continue", { ...f.request(), expected_revision: 0 }), /CAS/u);
  const otherTarget = f.request();
  otherTarget.assets_publication.target.targetId = "second-github-target";
  await assert.rejects(f.hub.call("hub_release_continue", otherTarget), /target/u);
  const changed = f.request();
  changed.assets_publication.inputIdentity = "e".repeat(64);
  await assert.rejects(f.hub.call("hub_release_continue", changed), /PACKAGED/u);
  const wrongTool = f.request();
  wrongTool.assets_publication.toolSha256 = "d".repeat(64);
  await assert.rejects(f.hub.call("hub_release_continue", wrongTool), /tool/u);
  await assert.rejects(f.hub.call("hub_release_continue", { ...f.request(), test_selection: { mode: "none", ids: [] } }), /exclusive/u);
  const latestStep = f.store.latestStep.bind(f.store);
  f.store.latestStep = (...args) => args[2] === "validate"
    ? { ...latestStep(...args), status: "unknown" } : latestStep(...args);
  await assert.rejects(f.hub.call("hub_release_continue", f.request()), /authority|CAS/u);
  f.store.latestStep = latestStep;
  assert.equal(f.state.writes.length, 0);
  await f.unchanged();
});

test("assets admission rechecks package after durable authorization before the first remote request", async t => {
  const f = await fixture(t);
  const publish = f.operations.publishPreparedAssets;
  f.operations.publishPreparedAssets = input => publish({ ...input, authorize: async binding => {
    const receipt = await input.authorize(binding);
    await writeFile(f.packageFile, "changed after admission");
    return receipt;
  } });
  await assert.rejects(f.hub.call("hub_release_continue", f.request()), /JSON|PACKAGED/u);
  assert.equal(f.state.writes.length, 0);
  await f.unchanged();
});

test("assets publication reads back a lost create response and retains unknown uploads without replay", async t => {
  const f = await fixture(t);
  f.state.loseCreate = true;
  await assert.rejects(f.hub.call("hub_release_continue", f.request()), /lost create/u);
  const result = await f.hub.call("hub_release_continue", f.request());
  assert.equal(result.assetsPublication.status, "applied");
  assert.equal(f.state.writes.filter(([method, route]) => method === "POST" && route.endsWith("/releases")).length, 1);
  await f.unchanged();

  const unknown = await fixture(t);
  unknown.state.loseUpload = true;
  unknown.state.dropUpload = true;
  await assert.rejects(unknown.hub.call("hub_release_continue", unknown.request()), /lost upload/u);
  const writes = unknown.state.writes.length;
  await assert.rejects(unknown.hub.call("hub_release_continue", unknown.request()), /unconfirmed/u);
  assert.equal(unknown.state.writes.length, writes);
  await unknown.unchanged();
});

test("source release entry returns the addressed assets effect instead of the old DONE snapshot", async t => {
  const f = await fixture(t);
  const { context_token, ...business } = f.request();
  const requestFile = path.join(f.root, "request.json");
  await save(requestFile, business);
  const result = await executeRelease({ action: "continue", requestFile,
    provider: "codex", threadId: "rm-thread", streamId: f.rmStream.id }, {
    openRuntime: async () => ({ service: f.hub, operations: {
      drain: () => assert.fail("assets-only admission cannot drain the old release pipeline"),
      drainAddressed: () => assert.fail("assets-only admission cannot wake pipeline work"),
    }, close() {} }),
  });
  assert.equal(result.assetsPublication?.status, "applied");
  await f.unchanged();
});

test("assets admission preserves a foreign release and refuses changed prepared bytes after admission", async t => {
  const f = await fixture(t);
  f.state.release = { id: 70, tag_name: "2.1.5", prerelease: false, draft: false, assets: [], body: "foreign owner" };
  await assert.rejects(f.hub.call("hub_release_continue", f.request()), /foreign/u);
  assert.equal(f.state.writes.length, 0);
  await f.unchanged();

  const changed = await fixture(t);
  const publish = changed.operations.publishPreparedAssets;
  changed.operations.publishPreparedAssets = input => publish({ ...input, authorize: async binding => {
    const receipt = await input.authorize(binding);
    await writeFile(changed.receiptFile, "changed prepared receipt");
    return receipt;
  } });
  await assert.rejects(changed.hub.call("hub_release_continue", changed.request()), /PREPARED/u);
  assert.equal(changed.state.writes.length, 0);
  await changed.unchanged();
});
