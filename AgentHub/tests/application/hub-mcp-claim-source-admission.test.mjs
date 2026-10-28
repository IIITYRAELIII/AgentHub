import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { createPersistenceMutationCapabilities } from "../../src/composition/persistence-mutation-composition.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";

const execute = promisify(execFile);
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "claim-source-"));
  const repo = path.join(root, "repo"), invalid = path.join(root, "installed-runtime");
  const dataDir = path.join(root, "data"), databaseFile = path.join(root, "hub.sqlite"), opened = [];
  await mkdir(repo); await mkdir(invalid);
  const git = async (cwd, ...args) => (await execute("git", args, { cwd, windowsHide: true })).stdout.trim();
  await git(repo, "init", "--initial-branch=main");
  await writeFile(path.join(repo, "theme.css"), "accepted\n");
  await git(repo, "add", ".");
  await git(repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "main");
  const open = async () => {
    const rawCatalog = new WorkspaceCatalogStore({ databaseFile }); await rawCatalog.load();
    const rawTasks = new TaskBoardStore({ databaseFile }); opened.push({ rawCatalog, rawTasks });
    const caps = createPersistenceMutationCapabilities({ rawWorkspaceCatalogStore: rawCatalog, rawTaskBoardStore: rawTasks });
    return { rawCatalog, catalog: caps.workspaceCatalogStore,
      tasks: new TaskBoardService({ store: caps.taskBoardStore, workspaceCatalog: caps.workspaceCatalogStore }) };
  };
  t.after(async () => {
    for (const s of opened) { s.rawTasks.close(); s.rawCatalog.close(); }
    await rm(root, { recursive: true, force: true });
  });
  const current = await open();
  const workspace = await current.catalog.createWorkspace({ name: "Source fixture", settings: { workingDirectory: repo } });
  const caller = await current.catalog.createStream({ workspaceId: workspace.id, name: "Caller" });
  const manager = await current.catalog.createStream({ workspaceId: workspace.id, name: "RM", settings: { releaseManager: true } });
  for (const s of [caller, manager]) await current.catalog.bindThread({ streamId: s.id, provider: "codex", threadId: s.id, projectRoot: repo });
  const task = await current.tasks.create({ text: "Preserved dirty source", bucket: "workspace", workspaceId: workspace.id });
  const taskGit = new TaskGitWorkspaceService({ dataDir, recordTiming: () => {},
    prepareDependencies: () => assert.fail("Fixture has no lockfile and must not run dependency preparation") });
  const service = (stores = current) => {
    const hub = new HubMcpService({ workspaceCatalog: stores.catalog, taskBoard: stores.tasks, taskGitWorkspaces: taskGit,
      workLog: { threadTurns: async () => [] }, secret: "fixture-secret", attachmentDirectory: root,
      reconcilePendingOnStartup: false, taskLifecycle: {}, releasePreflight: { preflight: async () => ({}) },
      releasePlanner: { plan: async () => ({ ready: [] }) }, releaseCompleter: { completeRelease: async () => ({}) } });
    hub.setActiveRuns(() => [{ id: "caller-run", provider: "codex", threadId: caller.id, streamId: caller.id,
      turnId: "caller-turn", status: "running" }]); hub.setDeferredInputs(() => []); return hub;
  };
  const hub = service(), token = hub.contextToken({ provider: "codex", threadId: caller.id });
  const args = { context_token: token, task_id: task.id, request_id: "initial-valid", dependency_mode: "ensure" };
  const initial = await hub.call("hub_task_claim", args);
  const managed = initial.gitWorkspace.projectRoot, dirty = Buffer.from("saved unsent theme bytes\r\n");
  await writeFile(path.join(managed, "theme.css"), dirty);
  const prior = current.tasks.task(task.id), refs = await git(repo, "show-ref"), status = await git(managed, "status", "--porcelain");
  const route = async value => {
    const w = current.catalog.workspace(workspace.id);
    await current.catalog.updateWorkspaceSettings(w.id, { ...w.settings, workingDirectory: value });
  };
  const unchanged = async () => {
    assert.deepEqual(current.tasks.task(task.id), prior);
    assert.deepEqual(await readFile(path.join(managed, "theme.css")), dirty);
    assert.equal(await git(repo, "show-ref"), refs);
    assert.equal(await git(managed, "status", "--porcelain"), status);
  };
  const reconcile = (h, id, original, rootLocator = invalid) => h.call("hub_task_operation_reconcile", {
    context_token: h.contextToken({ provider: "codex", threadId: manager.id }), request_id: id,
    task_id: task.id, operation_request_id: original, project_root: rootLocator, confirm_reconcile: true });
  return { ...current, hub, service, open, args, taskGit, task, caller, workspace, repo, invalid, managed, dirty, git, route, unchanged, reconcile };
}

test("invalid claim source seals a terminal refusal and a fresh corrected admission preserves dirty managed bytes", async t => {
  const f = await fixture(t); await f.route(f.invalid);
  const input = { ...f.args, request_id: "invalid-original" };
  await assert.rejects(f.hub.call("hub_task_claim", input), { code: "TASK_CLAIM_SOURCE_ADMISSION_FAILED" });
  const receipt = f.catalog.mcpOperation(input.request_id);
  assert.equal(receipt.status, "failed"); assert.equal(receipt.result.outcome, "NO_EFFECT");
  assert.equal(receipt.result.evidence.kind, "task-claim-source-admission-v1");
  assert.equal(path.resolve(receipt.result.evidence.sourceAdmission.projectRoot), path.resolve(f.invalid));
  await f.unchanged();
  await assert.rejects(f.tasks.claim({ id: f.task.id, workspaceId: f.workspace.id, streamId: f.caller.id,
    provider: "codex", threadId: f.caller.id, turnId: "late", operationId: input.request_id }), /durably refused/);
  await f.route(f.repo);
  await assert.rejects(f.hub.call("hub_task_claim", input), { code: "TASK_CLAIM_SOURCE_ADMISSION_FAILED" });
  assert.deepEqual(f.catalog.mcpOperation(input.request_id), receipt);
  const result = await f.hub.call("hub_task_claim", { ...f.args, request_id: "corrected-new-admission" });
  assert.equal(result.gitWorkspace.projectRoot, f.managed);
  assert.deepEqual(await readFile(path.join(f.managed, "theme.css")), f.dirty);
});

test("source refusal seal survives terminal-write loss and reopens with its original invalid locator", async t => {
  const f = await fixture(t); await f.route(f.invalid);
  f.rawCatalog.failMcpOperation = () => { throw Error("lost terminal reply"); };
  const input = { ...f.args, request_id: "lost-source-original" };
  await assert.rejects(f.hub.call("hub_task_claim", input), /lost terminal reply/);
  const original = f.catalog.mcpOperation(input.request_id);
  assert.equal(original.status, "unknown"); assert.equal(original.result.evidence.kind, "task-claim-source-admission-v1");
  await f.route(f.repo); const reopened = await f.open(), hub = f.service(reopened);
  await assert.rejects(f.reconcile(hub, "wrong-locator", input.request_id, f.repo), /locator/);
  const result = await f.reconcile(hub, "exact-source-reconcile", input.request_id);
  assert.equal(result.outcome, "NO_EFFECT");
  assert.equal(reopened.catalog.mcpOperation(input.request_id).status, "failed");
  await f.unchanged();
});

test("missing and bare claim roots are refused before modifying an existing managed source", async t => {
  const f = await fixture(t), bare = path.join(f.invalid, "bare.git");
  await f.git(f.invalid, "init", "--bare", bare);
  for (const [kind, root] of [["missing", path.join(f.invalid, "missing")], ["bare", bare]]) {
    await f.route(root);
    const input = { ...f.args, request_id: `invalid-${kind}` };
    await assert.rejects(f.hub.call("hub_task_claim", input), { code: "TASK_CLAIM_SOURCE_ADMISSION_FAILED" });
    const receipt = f.catalog.mcpOperation(input.request_id);
    assert.equal(receipt.status, "failed"); assert.equal(receipt.result.outcome, "NO_EFFECT");
    await f.unchanged();
  }
});

test("generic or forged discovery failures and failures after preparation never acquire source refusal evidence", async t => {
  const f = await fixture(t), prepare = f.taskGit.prepareOwned.bind(f.taskGit);
  for (const mode of ["generic", "forged", "after-prepare"]) {
    f.taskGit.prepareOwned = async args => {
      if (mode === "after-prepare") await prepare(args);
      throw mode === "generic" ? Error("fatal: not a git repository")
        : Object.assign(Error("forged source refusal"), { code: "TASK_CLAIM_SOURCE_ADMISSION_FAILED" });
    };
    const input = { ...f.args, request_id: `unsealed-${mode}` };
    await assert.rejects(f.hub.call("hub_task_claim", input));
    const receipt = f.catalog.mcpOperation(input.request_id);
    assert.equal(receipt.status, "unknown"); assert.equal(receipt.result, null);
    await assert.rejects(f.reconcile(f.hub, `refuse-${mode}`, input.request_id, f.repo), /exact durable/);
    assert.deepEqual(f.catalog.mcpOperation(input.request_id), receipt);
  }
  await f.unchanged();
});
