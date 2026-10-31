import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { installedNativeHistoryBaseline } from "../../../src/infrastructure/filesystem/local-source-baseline.mjs";
import { defaultRuntimeRoot } from "../../../src/infrastructure/filesystem/runtime-layout.mjs";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (cwd, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn("git", args, { cwd, windowsHide: true,
    stdio: ["pipe", options.stdoutFd ?? "pipe", "pipe"] });
  const stdout = [], stderr = [];
  child.stdout?.on("data", bytes => stdout.push(bytes));
  child.stderr.on("data", bytes => stderr.push(bytes));
  child.on("error", reject);
  child.on("close", code => code === 0
    ? resolve(options.rawOutput ? Buffer.concat(stdout) : Buffer.concat(stdout).toString("utf8").trim())
    : reject(new Error(Buffer.concat(stderr).toString("utf8"))));
  child.stdin.end(options.input ?? "");
});
async function save(root, name, bytes) {
  await mkdir(path.dirname(path.join(root, name)), { recursive: true });
  await writeFile(path.join(root, name), bytes);
}
async function commit(root, message) {
  await git(root, ["add", "-A"]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-installed-transport-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git"), retained = path.join(root, "retained");
  await git(root, ["init", "--bare", "--initial-branch=main", origin]);
  await git(root, ["clone", origin, primary]);
  await git(primary, ["config", "core.autocrlf", "false"]);
  await save(primary, ".gitattributes", "* text eol=lf\n");
  await save(primary, "README.md", "agreed repository metadata\n");
  await save(primary, "AgentHub/package.json", '{"name":"agent-hub","version":"2.0.0"}\n');
  await save(primary, "AgentHub/package-lock.json", '{"name":"agent-hub","version":"2.0.0"}\n');
  await save(primary, "AgentHub/server.mjs", "export const repair = 0;\n");
  const main = await commit(primary, "agreed published main");
  await git(primary, ["push", "origin", "main"]);
  await git(root, ["clone", "--no-local", primary, retained]);
  await save(retained, "AgentHub/server.mjs", "export const repair = 1;\n");
  const source = await commit(retained, "installed repair");
  const sourceTree = await git(retained, ["rev-parse", "HEAD^{tree}"]);
  await git(retained, ["checkout", "-b", "unrelated"]);
  await save(retained, "unrelated.txt", "unselected data\n");
  const unrelated = await commit(retained, "unrelated source branch");
  await git(retained, ["checkout", "main"]);
  const environment = { ...process.env, LOCALAPPDATA: path.join(root, "state"), XDG_STATE_HOME: path.join(root, "state") };
  const runtimeRoot = defaultRuntimeRoot({ environment }), releaseId = "installed-repair";
  const physical = await readFile(path.join(retained, "AgentHub/server.mjs"));
  await save(runtimeRoot, `releases/${releaseId}/server.mjs`, physical);
  const manifest = Buffer.from(JSON.stringify({ releaseId, publicationRevision: source,
    sourceRoot: path.join(retained, "AgentHub"), files: [{ path: "server.mjs", bytes: physical.length, sha256: sha(physical) }] }));
  await save(runtimeRoot, `releases/${releaseId}/runtime-manifest.json`, manifest);
  await save(runtimeRoot, "current.json", JSON.stringify({ current: releaseId }));
  const publication = { generation: "own-publication", repositories: [{ root: primary, revision: main }] };
  await save(runtimeRoot, "publication-state.json", JSON.stringify(publication));
  const tasks = [{ taskId: "selected", taskRevision: 2, baseCommit: main, resultCommit: main }];
  const input = { git: (args, options) => git(primary, args, options), sourceGit: git, repositoryRoot: primary,
    primaryMainCommit: main, publishedRevision: main, tasks, runtimeRoot, planRevision: "exact-plan" };
  const dataDir = path.join(runtimeRoot, "data");
  const owner = new ReleaseGitWorkspaceService({ dataDir, environment });
  const request = { projectRoot: primary, publishedRevision: main, tasks, planRevision: "exact-plan" };
  const state = async () => ({ head: await git(primary, ["rev-parse", "HEAD"]),
    refs: await git(primary, ["for-each-ref", "--format=%(refname) %(objectname)"]),
    config: sha(await readFile(path.join(primary, ".git/config"))),
    index: sha(await readFile(path.join(primary, ".git/index"))),
    fetchHead: await readFile(path.join(primary, ".git/FETCH_HEAD")).then(sha, e => { if (e.code === "ENOENT") return null; throw e; }),
    status: await git(primary, ["status", "--porcelain=v1", "--untracked-files=all"]),
    readme: sha(await readFile(path.join(primary, "README.md"))),
    source: sha(await readFile(path.join(primary, "AgentHub/server.mjs"))) });
  assert.notEqual(await git(primary, ["rev-parse", "--git-common-dir"]), retained);
  assert.equal(await git(primary, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${source}\n` }), `${source} missing`);
  return { root, primary, retained, main, source, sourceTree, unrelated, runtimeRoot, releaseId,
    manifest, physical, input, dataDir, publication, owner, request, state };
}

test("ordinary installed baseline transports exact retained history between separate Git stores", async t => {
  const f = await fixture(t), before = await f.state();
  const p = await f.owner.deriveInstalledLocalSourceBaselineForSelection(f.request);
  assert.equal(p.sourceBaseCommit, f.source);
  assert.equal(p.sourceBaseTree, f.sourceTree);
  assert.equal((await f.owner.validateLocalSourceBaseline({ ...f.request, provenance: p })).runtimeFiles, 1);
  assert.deepEqual(await f.state(), before);
  assert.equal(await git(f.primary, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: `${f.unrelated}\n` }), `${f.unrelated} missing`);
  assert.deepEqual(await readFile(path.join(f.runtimeRoot, `releases/${f.releaseId}/runtime-manifest.json`)), f.manifest);
  assert.equal(await git(f.retained, ["status", "--porcelain=v1"]), "");
  // Availability alone grants no runtime authority.
  await save(f.runtimeRoot, `releases/${f.releaseId}/server.mjs`, "foreign installed bytes\n");
  await assert.rejects(f.owner.validateLocalSourceBaseline({ ...f.request, provenance: p }), /installed bytes changed/u);
  assert.deepEqual(await f.state(), before);
});

test("installed history transport refuses source, pointer and outside-metadata drift", async t => {
  const f = await fixture(t), before = await f.state();
  await save(f.retained, "AgentHub/server.mjs", "dirty retained source\n");
  await assert.rejects(installedNativeHistoryBaseline(f.input), /checkout changed/u);
  await save(f.retained, "AgentHub/server.mjs", f.physical);
  let changed = false;
  await assert.rejects(installedNativeHistoryBaseline({ ...f.input, git: async (args, options) => {
    const result = await f.input.git(args, options);
    if (args[0] === "bundle" && args[1] === "unbundle") {
      changed = true;
      await save(f.runtimeRoot, "current.json", JSON.stringify({ current: "replacement" }));
    }
    return result;
  } }), /installed release changed/u);
  assert.equal(changed, true);
  await save(f.runtimeRoot, "current.json", JSON.stringify({ current: f.releaseId }));
  await save(f.retained, "README.md", "unaccepted repository metadata\n");
  const foreign = await commit(f.retained, "foreign root metadata");
  const manifest = { ...JSON.parse(f.manifest), publicationRevision: foreign };
  await save(f.runtimeRoot, `releases/${f.releaseId}/runtime-manifest.json`, JSON.stringify(manifest));
  await assert.rejects(installedNativeHistoryBaseline(f.input), /repository files differ from agreed main/u);
  assert.deepEqual(await f.state(), before);
});

test("native Task Test imports installed history through its existing owned Git lane", async t => {
  const f = await fixture(t);
  const owner = new TaskGitWorkspaceService({ dataDir: f.dataDir, readPublication: async () => f.publication, recordTiming: () => {} });
  const task = await owner.prepare({ taskId: "11111111-1111-4111-8111-111111111111", taskNumber: "HUB-1", projectRoot: f.primary });
  const before = await f.state();
  await save(task.projectRoot, "AgentHub/feature.mjs", "export const selected = true;\n");
  await commit(task.projectRoot, "selected main-based feature");
  const snapshot = await owner.snapshot({ taskId: task.taskId, taskNumber: "HUB-1", projectRoot: task.projectRoot });
  const integrated = await owner.mergeIntoDev(snapshot);
  assert.equal(integrated.integrated, true);
  // History context does not add installed repair content to an unrelated Task.
  assert.equal(await git(integrated.dev.projectRoot, ["show", "HEAD:AgentHub/server.mjs"]), "export const repair = 0;");
  assert.equal(await git(integrated.dev.projectRoot, ["show", "HEAD:AgentHub/feature.mjs"]), "export const selected = true;");
  assert.equal(await git(f.primary, ["rev-parse", `${f.source}^{tree}`]), f.sourceTree);
  const after = await f.state();
  // Task prepare/Test own their normal refs; primary checkout/config/index do not change.
  assert.deepEqual({ ...after, refs: before.refs }, before);
});

test("distribution install documentation needs no runtime payload but executable source still does", async t => {
  const f = await fixture(t), before = await f.state();
  await save(f.retained, "AgentHub/distribution/INSTALL.md", "Reviewed source installation instructions.\n");
  const source = await commit(f.retained, "installation documentation");
  await save(f.runtimeRoot, `releases/${f.releaseId}/runtime-manifest.json`,
    JSON.stringify({ ...JSON.parse(f.manifest), publicationRevision: source }));
  assert.equal((await f.owner.deriveInstalledLocalSourceBaselineForSelection(f.request)).sourceBaseCommit, source);
  await save(f.retained, "AgentHub/distribution/install_release.py", "print('uninstalled executable')\n");
  const executable = await commit(f.retained, "uninstalled distribution executable");
  await save(f.runtimeRoot, `releases/${f.releaseId}/runtime-manifest.json`,
    JSON.stringify({ ...JSON.parse(f.manifest), publicationRevision: executable }));
  await assert.rejects(f.owner.deriveInstalledLocalSourceBaselineForSelection(f.request), /carry path is absent from the installed runtime/u);
  assert.deepEqual(await f.state(), before);
});
