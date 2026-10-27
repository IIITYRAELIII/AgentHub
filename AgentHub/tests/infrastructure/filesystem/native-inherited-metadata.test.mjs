import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { assertNativeTaskHistories } from "../../../src/infrastructure/filesystem/native-release-merge.mjs";
import { assertInstalledLocalSourceBaseline } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";
import { localSourceSelectionHash } from "../../../src/domain/release-base-provenance.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { defaultRuntimeRoot } from "../../../src/infrastructure/filesystem/runtime-layout.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { preparationEnvelope } from "../../helpers/release-preparation-envelope.mjs";
import { validatePreparationEnvelope } from "../../../src/application/release-preparation-admission.mjs";
import { mcpArgumentsHash } from "../../../src/domain/mcp-arguments-hash.mjs";
import { FORWARD_PREPARATION, preparationLegacyHash } from "../../../src/domain/release-preparation.mjs";
import { validatePreparationForward } from "../../../src/application/release-preparation-forward.mjs";
import { openTaskAwaitCutoverRuntime } from "../../../task-await-cutover.mjs";

const exec = promisify(execFile), sha = b => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-installed-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitAt = async (cwd, args, options = {}) => {
    const pending = exec("git", args, { cwd, windowsHide: true, encoding: "buffer" });
    pending.child.stdin.end(options.input ?? "");
    const { stdout } = await pending;
    return options.rawOutput ? stdout : stdout.toString("utf8").trim();
  };
  const save = async (cwd, file, bytes) => {
    const p = path.join(cwd, file); await mkdir(path.dirname(p), { recursive: true }); await writeFile(p, bytes);
  };
  const commit = async (cwd, message) => {
    await gitAt(cwd, ["add", "-A"]);
    await gitAt(cwd, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", message]);
    return gitAt(cwd, ["rev-parse", "HEAD"]);
  };
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git");
  await gitAt(root, ["init", "--bare", "--initial-branch=main", origin]);
  await gitAt(root, ["clone", origin, primary]);
  await gitAt(primary, ["config", "core.autocrlf", "false"]);
  await save(primary, ".gitattributes", "* text eol=lf\n");
  await save(primary, "CHANGELOG.md", "Registered base notes\n");
  await save(primary, "package.json", JSON.stringify({ version: "1.0.0" }));
  await save(primary, "package-lock.json", JSON.stringify({ version: "1.0.0", packages: { "": { version: "1.0.0" } } }));
  await save(primary, "AgentHub/package.json", JSON.stringify({ name: "agent-hub", version: "2026.10.12" }));
  await save(primary, "AgentHub/package-lock.json", JSON.stringify({ name: "agent-hub", version: "2026.10.12",
    packages: { "": { name: "agent-hub", version: "2026.10.12" } } }));
  await save(primary, "AgentHub/server.mjs", "export const repair = 0;\n");
  const registered = await commit(primary, "registered base");
  await save(primary, "CHANGELOG.md", "Installed source notes\n");
  const published = await commit(primary, "OWN publication");
  const retained = path.join(root, "retained"), merged = path.join(root, "merged"), taskRoot = path.join(root, "task");
  await gitAt(primary, ["worktree", "add", "-b", "retained", retained, published]);
  const physical = Buffer.from("export const repair = 1;\n");
  await save(retained, "AgentHub/server.mjs", physical);
  const installedSource = await commit(retained, "installed repair");
  await save(primary, "CHANGELOG.md", "Later agreed main notes\n");
  const main = await commit(primary, "later agreed main");
  await gitAt(primary, ["push", "origin", "main"]);
  await gitAt(primary, ["worktree", "add", "-b", "merged", merged, installedSource]);
  await gitAt(merged, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-ff", "--no-edit", main]);
  const sourceBase = await gitAt(merged, ["rev-parse", "HEAD"]);
  await gitAt(primary, ["worktree", "add", "-b", "task", taskRoot, registered]);
  // Exact restored accepted metadata, not an arbitrary history-ancestor grant.
  await save(taskRoot, "CHANGELOG.md", "Installed source notes\n");
  await save(taskRoot, "AgentHub/selected.mjs", "export const selected = true;\n");
  const resultCommit = await commit(taskRoot, "accepted selected result");
  const tasks = [{ taskId: "selected", taskRevision: 2, baseCommit: registered, resultCommit }];
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "state"), XDG_STATE_HOME: path.join(root, "state") };
  const runtimeRoot = defaultRuntimeRoot({ environment }), release = path.join(runtimeRoot, "releases", "installed");
  const manifest = { releaseId: "installed", version: "2026.10.12", releaseVersion: "2026.10.12.1",
    sourceRoot: path.join(retained, "AgentHub"), publicationRevision: installedSource,
    files: [{ path: "server.mjs", bytes: physical.length, sha256: sha(physical) }] };
  const bytes = Buffer.from(JSON.stringify(manifest));
  await save(release, "server.mjs", physical); await save(release, "runtime-manifest.json", bytes);
  await save(runtimeRoot, "current.json", JSON.stringify({ current: "installed" }));
  await save(runtimeRoot, "publication-state.json", JSON.stringify({ repositories: [{ root: primary, revision: published }] }));
  const provenance = { schemaVersion: 1, kind: "installed-local-source-v1", publishedBaseCommit: published,
    agreedMainCommit: main, sourceBaseCommit: sourceBase, sourceBaseTree: await gitAt(primary, ["rev-parse", sourceBase + "^{tree}"]),
    sourcePatchSha256: sha(await gitAt(primary, ["diff", "--binary", "--full-index", "--no-renames", published, sourceBase], { rawOutput: true })),
    installedReleaseId: "installed", installedManifestSha256: sha(bytes), planRevision: "metadata",
    selectionHash: localSourceSelectionHash(tasks), approvedOriginMainCommit: main, adoptions: [] };
  const git = (args, options) => gitAt(primary, args, options);
  const verify = (p = provenance) => assertInstalledLocalSourceBaseline({ provenance: p, git, repositoryRoot: primary,
    primaryMainCommit: main, publishedRevision: published, planRevision: "metadata", tasks, runtimeRoot });
  return { root, primary, retained, taskRoot, tasks, sourceBase, installedSource, manifest, release,
    provenance, environment, git, gitAt, save, commit, verify };
}

test("installed manifest preserves accepted metadata through the actual native candidate owner", async t => {
  const f = await fixture(t), verified = await f.verify();
  assert.deepEqual(verified.metadataBases, [f.sourceBase, f.installedSource]);
  const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "release-data"), environment: f.environment });
  await assert.rejects(service.prepareCandidate({ projectRoot: f.primary, workspaceId: "fixture", planRevision: "metadata",
    frozenTasks: f.tasks, approvedBaseCommit: f.sourceBase, baseProvenance: f.provenance }),
  error => error.code === "RELEASE_NATIVE_MERGE_CONFLICT" && error.conflicts.includes("CHANGELOG.md"));
  assert.equal(await f.git(["status", "--porcelain=v1"]), "");
  assert.equal(await readFile(path.join(f.primary, "CHANGELOG.md"), "utf8"), "Later agreed main notes\n");
});

test("installed metadata authority refuses source HEAD drift, dirty capture and manifest drift", async t => {
  const f = await fixture(t);
  await f.save(f.retained, "untracked.txt", "foreign\n");
  await assert.rejects(f.verify(), /retained installed source identity changed/);
  await rm(path.join(f.retained, "untracked.txt"));
  await f.gitAt(f.retained, ["checkout", "--detach", f.manifest.publicationRevision + "^"]);
  await assert.rejects(f.verify(), /retained installed source identity changed/);
  await f.gitAt(f.retained, ["checkout", "--detach", f.installedSource]);
  await f.save(f.release, "runtime-manifest.json", JSON.stringify({ ...f.manifest, publicationRevision: f.sourceBase }));
  await assert.rejects(f.verify(), /installed manifest changed/);
  await f.save(f.retained, "AgentHub/README.md", "Foreign later source\n");
  const foreign = await f.commit(f.retained, "not an ancestor of approved source");
  const foreignBytes = Buffer.from(JSON.stringify({ ...f.manifest, publicationRevision: foreign }));
  await f.save(f.release, "runtime-manifest.json", foreignBytes);
  await assert.rejects(f.verify({ ...f.provenance, installedManifestSha256: sha(foreignBytes) }), /merge-base/);
});

test("installed metadata authority does not permit authored notes, changed modes or an unbound legacy revision", async t => {
  const f = await fixture(t), verified = await f.verify();
  const history = tasks => assertNativeTaskHistories({ git: f.git, baseCommit: f.sourceBase, tasks,
    historyAuthority: { bases: [f.sourceBase], metadataBases: verified.metadataBases, adoptions: [] } });
  await history(f.tasks);
  await f.save(f.taskRoot, "CHANGELOG.md", "Task invented notes\n");
  const authored = await f.commit(f.taskRoot, "authored notes");
  await assert.rejects(history([{ ...f.tasks[0], resultCommit: authored }]), /release-owned CHANGELOG/);
  await f.gitAt(f.taskRoot, ["checkout", f.installedSource, "--", "CHANGELOG.md"]);
  await f.gitAt(f.taskRoot, ["update-index", "--chmod=+x", "CHANGELOG.md"]);
  await f.gitAt(f.taskRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "wrong mode"]);
  await assert.rejects(history([{ ...f.tasks[0], resultCommit: await f.gitAt(f.taskRoot, ["rev-parse", "HEAD"]) }]), /release-owned CHANGELOG/);
  const legacy = { ...f.manifest }; delete legacy.publicationRevision;
  const bytes = Buffer.from(JSON.stringify(legacy)); await f.save(f.release, "runtime-manifest.json", bytes);
  const checked = await f.verify({ ...f.provenance, installedManifestSha256: sha(bytes) });
  assert.deepEqual(checked.metadataBases, [f.sourceBase]);
  await assert.rejects(assertNativeTaskHistories({ git: f.git, baseCommit: f.sourceBase, tasks: f.tasks,
    historyAuthority: { bases: [f.sourceBase], metadataBases: checked.metadataBases, adoptions: [] } }), /release-owned CHANGELOG/);
  const boxed = Buffer.from(JSON.stringify({ ...f.manifest, publicationRevision: [f.installedSource] }));
  await f.save(f.release, "runtime-manifest.json", boxed);
  assert.deepEqual((await f.verify({ ...f.provenance, installedManifestSha256: sha(boxed) })).metadataBases, [f.sourceBase]);
});

async function historicalFixture(t) {
  const f = await fixture(t), runtimeRoot = defaultRuntimeRoot({ environment: f.environment });
  const oldBytes = await readFile(path.join(f.release, "runtime-manifest.json"));
  const nextManifest = { ...f.manifest, releaseId: "newer", releaseVersion: "2026.10.12.2",
    sourceRoot: path.join(f.root, "merged", "AgentHub"), publicationRevision: f.sourceBase };
  const nextBytes = Buffer.from(JSON.stringify(nextManifest));
  await f.save(path.join(runtimeRoot, "releases", "newer"), "runtime-manifest.json", nextBytes);
  await f.save(path.join(runtimeRoot, "releases", "newer"), "server.mjs", await readFile(path.join(f.release, "server.mjs")));
  const binding = (releaseId, bytes) => ({ releaseId, manifestSha256: sha(bytes), root: { dev: "1", ino: "2", birthFileTime: "3" } });
  const pointer = { current: "newer", previous: "installed", runtimeRetention: { version: 1,
    current: binding("newer", nextBytes), previous: binding("installed", oldBytes), retired: [] } };
  await f.save(runtimeRoot, "current.json", JSON.stringify(pointer));
  const original = preparationEnvelope(f.primary);
  original.planRevision = f.provenance.planRevision;
  original.tasks = f.tasks.map(task => ({ ...task, rowRevision: 1, projectRoot: f.primary }));
  Object.assign(original.repositories[0], { approvedBaseCommit: f.provenance.sourceBaseCommit,
    publishedRevision: f.provenance.publishedBaseCommit, primaryMainCommit: f.provenance.agreedMainCommit,
    originMainCommit: f.provenance.approvedOriginMainCommit, localSourceBaseline: f.provenance });
  validatePreparationEnvelope(original);
  const requestId = "retained-original", argumentsHash = mcpArgumentsHash({ request_id: requestId, preparation: original });
  const entry = await f.git(["ls-tree", f.installedSource, "--", "CHANGELOG.md"]);
  const historicalChangelog = { requestId, argumentsHash, installedReleaseId: "installed", installedManifestSha256: sha(oldBytes),
    sourceCommit: f.installedSource, sourceTree: await f.git(["rev-parse", f.installedSource + "^{tree}"]),
    taskId: f.tasks[0].taskId, taskRevision: f.tasks[0].taskRevision, resultCommit: f.tasks[0].resultCommit,
    path: "CHANGELOG.md", mode: "100644", blob: entry.split(/\s/u)[2] };
  const provenance = { ...f.provenance, installedReleaseId: "newer", installedManifestSha256: sha(nextBytes), historicalChangelog };
  const authority = { requestId, argumentsHash, originalPreparation: original };
  await mkdir(path.join(f.root, "release-data"));
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(f.root, "release-data", "journal.sqlite") });
  await catalog.load();
  try {
    const { workspace, stream } = catalog.createWorkspaceWithStream({ name: "Historical original" });
    const identity = { workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "fixture", argumentsHash };
    catalog.beginMcpOperation({ ...identity, requestId, toolName: "hub_release_prepare" });
    catalog.markMcpOperationUnknown(requestId, new Error("retained legacy uncertainty"));
    const legacy = catalog.mcpOperation(requestId);
    catalog.checkpointMcpPreparationForward(requestId, { identity, expectedRevision: 0, legacyHash: preparationLegacyHash(legacy), transfer: true,
      validate: () => {}, state: { schemaVersion: 2, kind: FORWARD_PREPARATION, revision: 1, epoch: 1, ownerId: "fixture-owner",
        phase: "checking", legacy, originalPreparation: original, envelope: { ...original, repositories: [{ ...original.repositories[0], localSourceBaseline: provenance }] },
        sourceRoot: f.root, sourceRootIdentity: "fixture", events: [{ phase: "checking", ownerId: "fixture-owner" }] } });
  } catch (error) { catalog.close(); throw error; }
  const verify = (p = provenance, a = authority, tasks = f.tasks) => assertInstalledLocalSourceBaseline({ provenance: p, originalAuthority: a,
    git: f.git, repositoryRoot: f.primary, primaryMainCommit: f.provenance.agreedMainCommit,
    publishedRevision: f.provenance.publishedBaseCommit, planRevision: "metadata", tasks, runtimeRoot });
  const history = async (p = provenance, tasks = f.tasks, a = authority) => {
    const proof = await verify(p, a, tasks);
    return assertNativeTaskHistories({ git: f.git, baseCommit: f.sourceBase, tasks,
      historyAuthority: { bases: [f.sourceBase], metadataBases: proof.metadataBases, changelogEntries: proof.changelogEntries } });
  };
  const boundResult = resultCommit => {
    const tasks = f.tasks.map(task => ({ ...task, resultCommit })), selectionHash = localSourceSelectionHash(tasks);
    const value = structuredClone(original); value.tasks[0].resultCommit = resultCommit;
    value.repositories[0].localSourceBaseline.selectionHash = selectionHash;
    const argumentsHash = mcpArgumentsHash({ request_id: requestId, preparation: value });
    return { tasks, provenance: { ...provenance, selectionHash, historicalChangelog: { ...historicalChangelog, argumentsHash, resultCommit } },
      authority: { requestId, argumentsHash, originalPreparation: value } };
  };
  return { ...f, catalog, original, provenance, authority, pointer, oldBytes, nextBytes, runtimeRoot, verifyHistorical: verify, history, boundResult };
}

test("forward original scopes retained CHANGELOG authority without granting package versions or merge sides", async t => {
  const f = await historicalFixture(t);
  try {
    const unbound = { ...f.provenance }; delete unbound.historicalChangelog;
    await assert.rejects(f.history(unbound), /release-owned CHANGELOG/);
    const proof = await f.verifyHistorical();
    assert.deepEqual(proof.metadataBases, [f.sourceBase]);
    assert.deepEqual(proof.changelogEntries, [{ taskId: f.tasks[0].taskId, resultCommit: f.tasks[0].resultCommit,
      path: "CHANGELOG.md", mode: "100644", blob: f.provenance.historicalChangelog.blob }]);
    await f.history();
    const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "release-data"), environment: f.environment,
      readPreparationOriginal: id => f.catalog.mcpOperation(id) });
    await assert.rejects(service.prepareCandidate({ projectRoot: f.primary, workspaceId: "fixture", planRevision: "metadata",
      frozenTasks: f.tasks, approvedBaseCommit: f.sourceBase, baseProvenance: f.provenance }),
    error => error.code === "RELEASE_NATIVE_MERGE_CONFLICT" && error.conflicts.includes("CHANGELOG.md"));
    await f.save(f.taskRoot, "package.json", JSON.stringify({ version: "9.9.9" }));
    const version = await f.commit(f.taskRoot, "unbound package version");
    const versionBinding = f.boundResult(version);
    await f.verifyHistorical(versionBinding.provenance, versionBinding.authority, versionBinding.tasks);
    await assert.rejects(f.history(versionBinding.provenance, versionBinding.tasks, versionBinding.authority), /package-version/);
    await assert.rejects(assertNativeTaskHistories({ git: f.git, baseCommit: f.sourceBase,
      tasks: [{ ...f.tasks[0], taskId: "unselected" }], historyAuthority: { bases: [f.sourceBase],
        metadataBases: proof.metadataBases, changelogEntries: proof.changelogEntries } }), /release-owned CHANGELOG/);
    await f.gitAt(f.taskRoot, ["checkout", "--detach", f.tasks[0].resultCommit]);
    const foreignRoot = path.join(f.root, "foreign");
    await f.git(["worktree", "add", "-b", "unselected-side", foreignRoot, f.tasks[0].baseCommit]);
    await f.save(foreignRoot, "foreign.txt", "unselected work\n");
    const foreign = await f.commit(foreignRoot, "unselected merge side");
    await f.gitAt(f.taskRoot, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "merge", "--no-ff", "--no-edit", foreign]);
    const side = f.boundResult(await f.gitAt(f.taskRoot, ["rev-parse", "HEAD"]));
    await f.verifyHistorical(side.provenance, side.authority, side.tasks);
    await assert.rejects(f.history(side.provenance, side.tasks, side.authority), /unselected|unowned|merge side/);
    assert.equal(await f.git(["status", "--porcelain=v1"]), "");
  } finally { f.catalog.close(); }
});

test("retained CHANGELOG binding refuses foreign original, selection, path, mode, manifest and source drift", async t => {
  const f = await historicalFixture(t);
  try {
    const record = f.catalog.mcpOperation(f.authority.requestId);
    const current = { ...f.original, repositories: [{ ...f.original.repositories[0], localSourceBaseline: f.provenance }] };
    const initial = { ...record, preparationState: undefined };
    assert.deepEqual(validatePreparationForward({ record: initial, requestId: record.requestId,
      originalPreparation: f.original, preparation: current }).current, current);
    const foreignCurrent = structuredClone(current); foreignCurrent.repositories[0].localSourceBaseline.historicalChangelog.requestId = "foreign";
    assert.throws(() => validatePreparationForward({ record: initial, requestId: record.requestId,
      originalPreparation: f.original, preparation: foreignCurrent }), /original or selection/);
    assert.deepEqual(f.catalog.mcpOperation(record.requestId), record);
    for (const change of [{ requestId: "foreign" }, { argumentsHash: "0".repeat(64) }, { taskId: "foreign" },
      { resultCommit: f.sourceBase }, { path: "AgentHub/CHANGELOG.md" }, { mode: "100755" }, { blob: "0".repeat(40) },
      { installedManifestSha256: "0".repeat(64) }, { sourceCommit: f.sourceBase }, { sourceTree: "0".repeat(40) }]) {
      await assert.rejects(f.verifyHistorical({ ...f.provenance, historicalChangelog: { ...f.provenance.historicalChangelog, ...change } }));
    }
    await assert.rejects(f.verifyHistorical(f.provenance, null), /original or selection/);
    await assert.rejects(f.verifyHistorical(f.provenance, { ...f.authority, originalPreparation: { ...f.original, planRevision: "foreign" } }), /original or selection/);
    await f.save(f.release, "runtime-manifest.json", JSON.stringify({ ...f.manifest, publicationRevision: [f.installedSource] }));
    await assert.rejects(f.verifyHistorical(), /historical installed manifest changed/);
    await f.save(f.release, "runtime-manifest.json", f.oldBytes);
    await rm(path.join(f.release, "runtime-manifest.json"));
    await assert.rejects(f.verifyHistorical(), /required source or installed artifact is absent/);
    await f.save(f.release, "runtime-manifest.json", f.oldBytes);
    await f.gitAt(f.retained, ["checkout", "--detach", f.installedSource + "^"]);
    await assert.rejects(f.verifyHistorical(), /historical source HEAD\/tree\/clean/);
    await f.gitAt(f.retained, ["checkout", "--detach", f.installedSource]);
    await f.save(f.retained, "untracked.txt", "foreign\n");
    await assert.rejects(f.verifyHistorical(), /historical source HEAD\/tree\/clean/);
    await rm(path.join(f.retained, "untracked.txt"));
    for (const malformed of [Object.assign([], f.provenance.historicalChangelog), { ...f.provenance.historicalChangelog, authority: true }]) {
      await assert.rejects(f.verifyHistorical({ ...f.provenance, historicalChangelog: malformed }), /historical root CHANGELOG binding/);
    }
    await f.save(f.retained, "AgentHub/README.md", "not an ancestor of current source\n");
    const foreign = await f.commit(f.retained, "nonancestor retained endpoint");
    const manifest = Buffer.from(JSON.stringify({ ...f.manifest, publicationRevision: foreign }));
    await f.save(f.release, "runtime-manifest.json", manifest);
    const original = structuredClone(f.original);
    original.repositories[0].localSourceBaseline.installedManifestSha256 = sha(manifest);
    const argumentsHash = mcpArgumentsHash({ request_id: f.authority.requestId, preparation: original });
    const p = { ...f.provenance, historicalChangelog: { ...f.provenance.historicalChangelog, argumentsHash,
      installedManifestSha256: sha(manifest), sourceCommit: foreign, sourceTree: await f.gitAt(f.retained, ["rev-parse", "HEAD^{tree}"]) } };
    await f.save(f.runtimeRoot, "current.json", JSON.stringify({ ...f.pointer,
      runtimeRetention: { ...f.pointer.runtimeRetention, previous: { ...f.pointer.runtimeRetention.previous, manifestSha256: sha(manifest) } } }));
    await assert.rejects(f.verifyHistorical(p, { ...f.authority, argumentsHash, originalPreparation: original }), /merge-base/);
    await f.save(f.release, "runtime-manifest.json", f.oldBytes);
    await f.gitAt(f.retained, ["checkout", "--detach", f.installedSource]);
    await f.save(f.runtimeRoot, "current.json", JSON.stringify({ ...f.pointer, runtimeRetention: undefined }));
    await assert.rejects(f.verifyHistorical(), /historical runtime retention/);
  } finally { f.catalog.close(); }
});

test("historical root CHANGELOG binding survives native reuse generation freeze and exact readback", async t => {
  const f = await historicalFixture(t);
  try {
    let available = true, conflict;
    const service = new ReleaseGitWorkspaceService({ dataDir: path.join(f.root, "release-data"), environment: f.environment,
      readPreparationOriginal: id => available ? f.catalog.mcpOperation(id) : null });
    const request = { projectRoot: f.primary, workspaceId: "fixture", planRevision: "metadata",
      frozenTasks: f.tasks, approvedBaseCommit: f.sourceBase, baseProvenance: f.provenance };
    try { await service.prepareCandidate(request); } catch (error) { conflict = error; }
    assert.equal(conflict?.code, "RELEASE_NATIVE_MERGE_CONFLICT");
    await f.gitAt(conflict.conflictRoot, ["checkout", "--ours", "--", "CHANGELOG.md"]);
    await f.commit(conflict.conflictRoot, "preserve current release-owned notes");
    const before = f.catalog.mcpOperation(f.authority.requestId);
    const candidate = await service.prepareCandidate(request);
    assert.deepEqual(candidate.manifest.baseProvenance.historicalChangelog, f.provenance.historicalChangelog);
    assert.equal((await service.prepareCandidate(request)).preReleaseHead, candidate.preReleaseHead);
    assert.deepEqual((await service.frozenCandidate(f.primary)).manifest.baseProvenance.historicalChangelog, f.provenance.historicalChangelog);
    const savedEnvironment = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
    let runtime;
    try {
      Object.assign(process.env, { LOCALAPPDATA: f.environment.LOCALAPPDATA, XDG_STATE_HOME: f.environment.XDG_STATE_HOME });
      runtime = await openTaskAwaitCutoverRuntime({ config: { dataDir: path.join(f.root, "release-data"), taskBoard: { autoPlaceConfidence: 0.8 } } });
      const readback = await runtime.service.releasePreflight.releaseGitWorkspaces.frozenCandidate(f.primary);
      assert.equal(readback.preReleaseHead, candidate.preReleaseHead);
      assert.deepEqual(readback.manifest.baseProvenance.historicalChangelog, f.provenance.historicalChangelog);
    } finally {
      runtime?.close();
      for (const [key, value] of Object.entries(savedEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    available = false;
    await assert.rejects(service.frozenCandidate(f.primary), /original record is unavailable/);
    available = true;
    await f.save(f.retained, "untracked.txt", "foreign\n");
    await assert.rejects(service.frozenCandidate(f.primary), /historical source HEAD\/tree\/clean/);
    await rm(path.join(f.retained, "untracked.txt"));
    const notes = Buffer.from("# Release\n\nSelected original.\n");
    await f.save(candidate.releaseRoot, "CHANGELOG.md", notes);
    const generationInput = { ...request, operationId: "historical-release", generation: 1, changelogContent: notes };
    const generation = await service.prepareGeneration(generationInput);
    assert.deepEqual(generation.manifest.baseProvenance.historicalChangelog, f.provenance.historicalChangelog);
    assert.equal((await service.prepareGeneration(generationInput)).preReleaseHead, generation.preReleaseHead);
    await service.freezePublicationCandidate({ projectRoot: f.primary, workspaceId: "fixture", expectedPlanRevision: "metadata",
      expectedPreparedHead: candidate.preReleaseHead, changelogContent: notes, releaseDate: new Date("2026-10-23T00:00:00Z") });
    assert.deepEqual((await service.frozenCandidate(f.primary)).manifest.baseProvenance.historicalChangelog, f.provenance.historicalChangelog);
    assert.deepEqual(f.catalog.mcpOperation(f.authority.requestId), before);
    assert.equal(await f.git(["status", "--porcelain=v1"]), "");
  } finally { f.catalog.close(); }
});
