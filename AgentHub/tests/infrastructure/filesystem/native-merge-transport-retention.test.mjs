import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { StorageRetentionService } from "../../../src/application/storage-retention-service.mjs";
import { MaintenanceOperationStore } from "../../../src/infrastructure/persistence/maintenance-operation-store.mjs";
import { NativeMergeTransportRetention } from "../../../src/infrastructure/filesystem/native-merge-transport-retention.mjs";

function gitAt(cwd, args, { input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [], stderr = [];
    child.stdout.on("data", b => stdout.push(b)); child.stderr.on("data", b => stderr.push(b));
    child.on("error", reject);
    child.on("close", code => code === 0 ? resolve(Buffer.concat(stdout).toString("utf8").trim())
      : reject(new Error(Buffer.concat(stderr).toString("utf8"))));
    child.stdin.end(input);
  });
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(source); await mkdir(dataDir);
  await gitAt(source, ["init", "-b", "main"]);
  await writeFile(path.join(source, "text"), "valuable tracked data");
  await gitAt(source, ["add", "."]);
  await gitAt(source, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]);
  const commit = await gitAt(source, ["rev-parse", "HEAD"]);
  const blob = await gitAt(source, ["rev-parse", "HEAD:text"]);
  await gitAt(source, ["update-ref", "refs/agent-hub/fixture-evidence", blob]);
  await gitAt(source, ["update-ref", "refs/remotes/origin/main", commit]);
  const taskId = "11111111-1111-4111-8111-111111111111";
  const identity = { policy: "native-dev-merge-v1", taskId, resultCommit: commit, before: commit, mainCommit: commit };
  const id = createHash("sha256").update(JSON.stringify(identity)).digest("hex").slice(0, 24);
  const capture = path.join(dataDir, "task-native-merges", id); await mkdir(capture, { recursive: true });
  const bundle = path.join(capture, "source.bundle"), repository = path.join(capture, "repository");
  await gitAt(source, ["bundle", "create", bundle, "--all"]);
  await gitAt(capture, ["clone", "--no-local", "--no-hardlinks", bundle, repository]);
  const stateFile = path.join(capture, "merge.json");
  const state = { version: 1, identity, next: 1, head: commit,
    merges: [{ taskId, resultCommit: commit, commit }], conflict: null };
  await writeFile(stateFile, JSON.stringify(state));
  let publication = { revision: commit, generation: "published-generation" };
  const taskGitWorkspaces = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication });
  const task = { id: taskId, revision: 9, workflowStatus: "done", status: "done", completedAt: "2026-10-20T00:00:00Z",
    gitReferences: [{ projectRoot: source, resultCommit: commit, branch: "" }] };
  const owner = taskGitWorkspaces.storageRetentionOwner({ taskBoard: { task: () => task }, isStopping: () => false });
  const candidate = { id, cursor: id };
  return { owner, candidate, root, source, dataDir, taskGitWorkspaces, bundle, repository, stateFile, state, task, commit,
    setPublication: value => { publication = value; } };
}

test("published completed capture retires only independent transport, repeat observes absence", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const originalState = await readFile(f.stateFile), originalRefs = await gitAt(f.source, ["show-ref"]);
  const preview = await f.owner.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  assert.ok(preview.binding.heads.some(h => h.endsWith("refs/agent-hub/fixture-evidence")), "advertised ref names survive in the durable binding");
  const bytes = (await lstat(f.bundle)).size;
  const result = await f.owner.prune({ candidate: f.candidate, binding: preview.binding });
  assert.equal(result.status, "removed"); assert.equal(result.logicalBytes, bytes);
  assert.match(result.freeAfterBytes, /^\d+$/u);
  await assert.rejects(readFile(f.bundle), { code: "ENOENT" });
  assert.equal((await f.owner.reconcile({ candidate: f.candidate, binding: preview.binding })).status, "already-removed");
  assert.equal((await f.owner.preview({ candidate: f.candidate })).reason, "transport-absent");
  assert.deepEqual(await readFile(f.stateFile), originalState);
  assert.equal(await gitAt(f.source, ["show-ref"]), originalRefs);
  assert.equal(await gitAt(f.repository, ["rev-parse", "HEAD"]), f.commit);
  assert.equal(await readFile(path.join(f.repository, "text"), "utf8"), "valuable tracked data");
});

test("configured logical root alias retires only the verified physical transport", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const alias = path.join(f.root, "logical-data"); await symlink(f.dataDir, alias, "junction");
  const owner = new NativeMergeTransportRetention({ dataDir: alias, taskBoard: { task: () => f.task },
    taskGitWorkspaces: f.taskGitWorkspaces, gitAt });
  const preview = await owner.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible", JSON.stringify(preview));
  assert.equal((await owner.prune({ candidate: f.candidate, binding: preview.binding })).status, "removed");
  await assert.rejects(readFile(f.bundle), { code: "ENOENT" });
  assert.equal(await readFile(path.join(f.repository, "text"), "utf8"), "valuable tracked data");
});

test("active/unpublished/dirty captures and changed admission are retained", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  f.task.status = "started";
  assert.equal((await f.owner.preview({ candidate: f.candidate })).reason, "task-not-completed");
  f.task.status = "done"; f.setPublication(null);
  assert.equal((await f.owner.preview({ candidate: f.candidate })).reason, "publication-or-work-pinned");
  f.setPublication({ revision: f.commit, generation: "published-generation" });
  await writeFile(path.join(f.repository, "WIP.txt"), "useful unfinished work");
  assert.equal((await f.owner.preview({ candidate: f.candidate })).reason, "capture-work-pinned");
  await rm(path.join(f.repository, "WIP.txt"));
  const preview = await f.owner.preview({ candidate: f.candidate });
  assert.equal(preview.status, "eligible");
  f.task.revision++;
  assert.equal((await f.owner.prune({ candidate: f.candidate, binding: preview.binding })).reason, "preview-changed");
  assert.ok((await lstat(f.bundle)).size > 0);
  f.state.conflict = { unresolved: true }; await writeFile(f.stateFile, JSON.stringify(f.state));
  assert.equal((await f.owner.reconcile({ candidate: f.candidate, binding: preview.binding })).status, "unknown");
  assert.ok((await lstat(f.bundle)).size > 0);
});

test("lost native deletion reply reconciles the original intent without a second deletion", { skip: process.platform !== "win32" }, async t => {
  const f = await fixture(t);
  const dataDir = path.join(f.root, "maintenance");
  await mkdir(dataDir);
  const store = new MaintenanceOperationStore({ dataDir });
  const actualDelete = f.owner.deleteTransport;
  let attempts = 0;
  f.owner.deleteTransport = async (...args) => { attempts++; await actualDelete(...args); throw new Error("lost owner reply"); };
  const make = () => new StorageRetentionService({ store: new MaintenanceOperationStore({ dataDir }), owners: [f.owner],
    withLease: async fn => fn({ assertOwned: async () => {} }), readContext: async () => ({ ready: true, releaseId: "updated" }) });
  await make().runOnce();
  const original = store.get("storage-retention:v1").metadata.pending[0].operationId;
  assert.equal(store.get(original).status, "reconciling");
  await assert.rejects(readFile(f.bundle), { code: "ENOENT" });
  const recovered = make(); await recovered.runOnce();
  assert.equal(store.get(original).status, "succeeded");
  assert.equal(store.get(original).metadata.result.status, "already-removed");
  assert.equal(attempts, 1);
  assert.equal(recovered.status().removed, 0);
  assert.equal(recovered.status().alreadyRemoved, 1);
});
