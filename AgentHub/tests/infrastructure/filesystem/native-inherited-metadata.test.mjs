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

const exec = promisify(execFile), sha = b => createHash("sha256").update(b).digest("hex");
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-installed-notes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gitAt = async (cwd, args, options = {}) => {
    const { stdout } = await exec("git", args, { cwd, windowsHide: true, encoding: "buffer" });
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
  const manifest = { releaseId: "installed", sourceRoot: path.join(retained, "AgentHub"), publicationRevision: installedSource,
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
