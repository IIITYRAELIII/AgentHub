import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { taskRepositoryKey } from "../../../src/domain/task-git-reference.mjs";
import { verifySelectedCompositionObjects } from "../../../src/infrastructure/filesystem/selected-composition-proof.mjs";
const exec = promisify(execFile);
const TASK_ID = "367ffe17-f69f-4886-b9be-901558ecace2";

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture(t) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "selected-owner-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, "repository");
  const remote = path.join(temp, "remote.git");
  const dataDir = path.join(temp, "data");
  await git(temp, "init", "--bare", "-q", remote);
  await git(temp, "init", "-q", "-b", "main", root);
  await git(root, "remote", "add", "origin", remote);
  const commit = async (cwd, message, { forced = null } = {}) => {
    await git(cwd, "add", "-A");
    if (forced) await git(cwd, "add", "-f", forced);
    await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "-q", "-m", message);
    return git(cwd, "rev-parse", "HEAD");
  };
  await writeFile(path.join(root, ".gitignore"), "feature.txt\n");
  await writeFile(path.join(root, "conflict.txt"), "base\n");
  const base = await commit(root, "base");
  const service = new TaskGitWorkspaceService({ dataDir,
    readPublication: async () => ({ generation: "generation-1",
      repositories: [{ root, revision: published }] }) });
  // The closure above is first used after the published commit is initialized.
  const taskWorkspace = await service.prepare({ taskId: TASK_ID, projectRoot: root });
  const devWorkspace = await service.prepareDev(root);
  await git(root, "switch", "-q", "-c", "published");
  await writeFile(path.join(root, "conflict.txt"), "published\n");
  const published = await commit(root, "published");
  await git(root, "push", "-q", "origin", `${published}:refs/heads/main`);
  await git(root, "switch", "-q", "main");
  await writeFile(path.join(root, "local.txt"), "approved local\n");
  const local = await commit(root, "local");
  await git(taskWorkspace.projectRoot, "merge", "--ff-only", local);
  await git(devWorkspace.projectRoot, "merge", "--ff-only", local);
  await writeFile(path.join(taskWorkspace.projectRoot, "feature.txt"), "selected feature\n");
  await commit(taskWorkspace.projectRoot, "Task feature", { forced: "feature.txt" });
  await git(taskWorkspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
    "merge", "--no-ff", "-m", "published side", published);
  const task = await git(taskWorkspace.projectRoot, "rev-parse", "HEAD");
  await writeFile(path.join(devWorkspace.projectRoot, "conflict.txt"), "dev\n");
  await writeFile(path.join(devWorkspace.projectRoot, "unselected.txt"), "unselected\n");
  const dev = await commit(devWorkspace.projectRoot, "dev unselected");
  const baselineOutput = await runTaskGitCommand(["merge-tree", "--write-tree", dev, task], {
    cwd: root, acceptableExitCodes: [1],
  });
  const baselineTree = baselineOutput.split(/\r?\n/u)[0];
  assert.match(baselineTree, /^[0-9a-f]{40}$/u);
  await writeFile(path.join(root, "resolution.txt"), "reviewed\n");
  const resolvedBlob = await git(root, "hash-object", "-w", "resolution.txt");
  await unlink(path.join(root, "resolution.txt"));
  const index = path.join(temp, "proof.index");
  const indexGit = async (...args) => (await exec("git", args, {
    cwd: root, env: { ...process.env, GIT_INDEX_FILE: index },
  })).stdout.trim();
  await indexGit("read-tree", baselineTree);
  await indexGit("update-index", "--add", "--cacheinfo", "100644", resolvedBlob, "conflict.txt");
  const tree = await indexGit("write-tree");
  const proof = (await exec("git", ["commit-tree", tree, "-p", dev, "-p", task,
    "-m", "reviewed selected composition"], {
    cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.invalid",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.invalid" },
  })).stdout.trim();
  await git(root, "update-ref", "refs/review/selected", proof);
  const bundle = path.join(temp, "review.bundle");
  await git(root, "bundle", "create", bundle, "refs/review/selected");
  const bundleSha256 = createHash("sha256").update(await readFile(bundle)).digest("hex");
  assert.equal(await git(root, "rev-parse", "main"), local);
  assert.equal(await git(root, "rev-parse", "dev"), dev);
  return { root, remote, dataDir, service, taskWorkspace, devWorkspace,
    base, local, published, task, dev, proof, tree, bundle, bundleSha256 };
}


test("already admitted genuine v1 completes and reopens; new legacy admission is closed", { timeout: 120000 }, async t => {
  const f=await fixture(t), repositoryKey=taskRepositoryKey(f.root), operationId="pre-cutover-v1-original";
  const proof=await verifySelectedCompositionObjects({
    git:(args,options)=>runTaskGitCommand(args,{...options,cwd:f.root}), taskId:TASK_ID, repositoryKey,
    taskBaseCommit:f.base, acceptedLocalMainCommit:f.local, taskCommit:f.task,
    devCommit:f.dev, proofCommit:f.proof, publishedCommit:f.published,
    publicationGeneration:"generation-1", remoteCommit:f.published, bundleSha256:f.bundleSha256,
  });
  const binding={...proof,repositoryRoot:f.root,taskRoot:f.taskWorkspace.projectRoot,
    devRoot:f.devWorkspace.projectRoot, branch:f.taskWorkspace.branch, remoteUrl:f.remote,
    bundlePath:f.bundle,resultRefBefore:null,expectedTaskRevision:1,
    authority:{workspaceId:"fixture",streamId:"rm",provider:"codex",threadId:"fixture",proofRequestId:"old-preview"}};
  const preview={...binding,previewHash:createHash("sha256").update(JSON.stringify(binding)).digest("hex")};
  const root=path.join(f.dataDir,"task-selected-compositions",TASK_ID,repositoryKey,operationId);
  await mkdir(root,{recursive:true});
  // Existing original capture is the fixture input, not a new admission route.
  await writeFile(path.join(root,"intent.json"),JSON.stringify({version:1,kind:"selected-task-composition-v1",operationId,preview}));
  await assert.rejects(f.service.withTaskLock(TASK_ID,lease=>f.service.previewSelectedCompositionOwned({taskId:TASK_ID,lease})),{code:"TASK_NATIVE_GIT_REQUIRED"});
  const result=await f.service.withTaskLock(TASK_ID,lease=>f.service.applySelectedCompositionOwned(preview,{operationId,lease}));
  assert.equal(result.status,"applied");
  assert.equal(result.receipt.version,1);
  assert.equal(Object.hasOwn(result.receipt,"materializationHash"),false);
  const originalHead=await git(f.root,"rev-parse","dev");
  const recordFile=path.join(root,"materialization","record.json");
  const record=await readFile(recordFile);
  assert.equal(JSON.parse(record).version,1);
  const reopened=new TaskGitWorkspaceService({dataDir:f.dataDir,readPublication:f.service.readPublication});
  const same=await reopened.withTaskLock(TASK_ID,lease=>reopened.applySelectedCompositionOwned(preview,{operationId,lease}));
  assert.equal(same.status,"applied");
  assert.equal(await git(f.root,"rev-parse","dev"),originalHead);
  const altered=JSON.parse(record); altered.version=2; altered.checkout={};
  await writeFile(recordFile,JSON.stringify(altered));
  await assert.rejects(reopened.withTaskLock(TASK_ID,lease=>reopened.readSelectedCompositionOwned(preview,{operationId,lease})),/version changed/u);
  await writeFile(recordFile,record);
  assert.equal((await reopened.withTaskLock(TASK_ID,lease=>reopened.readSelectedCompositionOwned(preview,{operationId,lease}))).status,"applied");
  await assert.rejects(reopened.withTaskLock(TASK_ID,lease=>reopened.applySelectedCompositionOwned(preview,{operationId:"new-original",lease})),{code:"TASK_NATIVE_GIT_REQUIRED"});
  assert.equal(await git(f.root,"rev-parse","dev"),originalHead);
});

test("sealed v2 recovery rejects paired header downgrade and physical capture tamper", { timeout: 120000 }, async t => {
  const f = await fixture(t), repositoryKey = taskRepositoryKey(f.root), operationId = "pre-cutover-v2-original";
  const proof = await verifySelectedCompositionObjects({
    git: (args, options) => runTaskGitCommand(args, { ...options, cwd: f.root }), taskId: TASK_ID, repositoryKey,
    taskBaseCommit: f.base, acceptedLocalMainCommit: f.local, taskCommit: f.task,
    devCommit: f.dev, proofCommit: f.proof, publishedCommit: f.published,
    publicationGeneration: "generation-1", remoteCommit: f.published, bundleSha256: f.bundleSha256,
  });
  const binding = { ...proof, repositoryRoot: f.root, taskRoot: f.taskWorkspace.projectRoot,
    devRoot: f.devWorkspace.projectRoot, branch: f.taskWorkspace.branch, remoteUrl: f.remote,
    bundlePath: f.bundle, resultRefBefore: null, expectedTaskRevision: 1,
    authority: { workspaceId: "fixture", streamId: "rm", provider: "codex", threadId: "fixture", proofRequestId: "old-preview" } };
  const preview = { ...binding, previewHash: createHash("sha256").update(JSON.stringify(binding)).digest("hex") };
  const root = path.join(f.dataDir, "task-selected-compositions", TASK_ID, repositoryKey, operationId);
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, "intent.json"), JSON.stringify({ version: 2, kind: "selected-task-composition-v1", operationId, preview }));
  const result = await f.service.withTaskLock(TASK_ID, lease => f.service.applySelectedCompositionOwned(preview, { operationId, lease }));
  assert.equal(result.status, "applied");
  assert.equal(result.receipt.version, 2);
  const recordFile = path.join(root, "materialization", "record.json");
  const intentFile = path.join(root, "intent.json"), receiptFile = path.join(root, "completed.json");
  const record = await readFile(recordFile), intentBytes = await readFile(intentFile), receiptBytes = await readFile(receiptFile);
  assert.equal(JSON.parse(record).version, 2);
  const originalHead = await git(f.root, "rev-parse", "dev");
  const reopened = new TaskGitWorkspaceService({ dataDir: f.dataDir, readPublication: f.service.readPublication });
  const read = () => reopened.withTaskLock(TASK_ID, lease => reopened.readSelectedCompositionOwned(preview, { operationId, lease }));
  assert.equal((await read()).status, "applied");
  const intent = JSON.parse(intentBytes), receipt = JSON.parse(receiptBytes);
  intent.version = 1; receipt.version = 1;
  await writeFile(intentFile, JSON.stringify(intent)); await writeFile(receiptFile, JSON.stringify(receipt));
  await assert.rejects(read(), /version changed/u);
  const altered = JSON.parse(record); altered.files[0].newSha256 = "0".repeat(64);
  await writeFile(recordFile, JSON.stringify(altered));
  await assert.rejects(read(), /version changed/u);
  await writeFile(intentFile, intentBytes); await writeFile(receiptFile, receiptBytes);
  await assert.rejects(read(), /staged bytes changed/u);
  await writeFile(recordFile, record);
  assert.equal((await read()).status, "applied");
  assert.equal(await git(f.root, "rev-parse", "dev"), originalHead);
});
