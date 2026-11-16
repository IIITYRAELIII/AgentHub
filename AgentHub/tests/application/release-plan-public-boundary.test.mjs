import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import test from "node:test";
import { openTaskAwaitCutoverRuntime } from "../../task-await-cutover.mjs";
import { HubMcpServer } from "../../src/interfaces/mcp/hub-mcp-server.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { readReleaseToolPackage } from "../../src/infrastructure/process/release-tool-package.mjs";

const execute = promisify(execFile);
async function git(root, ...args) {
  return (await execute("git", args, { cwd: root, windowsHide: true })).stdout.trim();
}
async function commit(root, message) {
  await git(root, "add", ".");
  await git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

test("PUBLIC default CLI and external HTTP accept twenty results with six fresh union scans", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-plan-pair-"));
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary); await mkdir(dataDir);
  const previous = { LOCALAPPDATA: process.env.LOCALAPPDATA, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.LOCALAPPDATA = path.join(root, "state");
  process.env.XDG_STATE_HOME = process.env.LOCALAPPDATA;
  let runtime, server, catalog, store;
  t.after(async () => {
    await server?.close();
    runtime?.close(); store?.close(); catalog?.close();
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "base.txt"), "agreed main\n");
  const base = await commit(primary, "agreed main");
  const origin = path.join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin); await git(primary, "push", "origin", "main");
  await mkdir(path.join(process.env.LOCALAPPDATA, "AgentHub"), { recursive: true });
  await writeFile(path.join(process.env.LOCALAPPDATA, "AgentHub/publication-state.json"), JSON.stringify({
    generation: "private-fixture", repositories: [{ root: primary, revision: base }],
  }));
  const databaseFile = path.join(dataDir, "journal.sqlite");
  catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  store = new TaskBoardStore({ databaseFile });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Private plan fixture",
    settings: { workingDirectory: primary, releaseWorkflowEnabled: true } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "RM",
    settings: { workingDirectory: primary, releaseManager: true } }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "plan-pair-fixture", streamId: stream.id }));
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  runtime = await openTaskAwaitCutoverRuntime({ config: { dataDir, taskBoard: { autoPlaceConfidence: 0.8 } } });
  const service = runtime.service, taskGit = service.taskGitWorkspaces;
  const context = { provider: "codex", threadId: "plan-pair-fixture", streamId: stream.id };
  const context_token = service.contextToken(context);
  const selected = [];
  // Prior results are real normal Test outcomes. Only their already accepted
  // Await status is fixture setup; native composition and final acceptance are real.
  for (let index = 0; index < 20; index++) {
    const row = store.create({ text: `Selected ${index}`, bucket: "workspace", workspaceId: workspace.id });
    await board.claim({ id: row.id, workspaceId: workspace.id, streamId: stream.id,
      provider: "codex", threadId: context.threadId, turnId: `fixture-${index}`, operationId: `claim-${index}` });
    const managed = await taskGit.prepare({ taskId: row.id, taskNumber: board.task(row.id).taskNumber, projectRoot: primary });
    await writeFile(path.join(managed.projectRoot, `selected-${index}.txt`), `result-${index}\n`);
    const resultCommit = await commit(managed.projectRoot, `selected result ${index}`);
    const current = board.task(row.id);
    const result = await service.call("hub_task_status_update", { context_token, request_id: `normal-test-${index}`,
      task_id: row.id, status: "testing", expected_task_revision: current.revision,
      expected_workflow_status: current.workflowStatus });
    assert.equal(result.workflowStatus, "testing");
    if (index < 19) store.setWorkflowStatus(row.id, "awaiting_implementation");
    selected.push({ taskId: row.id, resultCommit });
  }
  const preflight = service.releasePreflight;
  await preflight.prepareAwaitSet({ workspaceId: workspace.id });
  const releaseGit = preflight.releaseGitWorkspaces;
  const before = await releaseGit.frozenCandidate(primary);
  assert.equal(before.manifest.tasks.length, 19);
  const primaryHead = await git(primary, "rev-parse", "HEAD");
  const primaryIndex = await git(primary, "write-tree");
  const planner = preflight.releasePlanner;
  const counts = { passes: 0, evidence: 0, canonicalReads: 0, selectedReads: 0 };
  let planning = 0;
  // Observers call the genuine bodies unchanged, including on the parent run.
  for (const name of ["plan", "planAcceptance"]) if (typeof planner[name] === "function") {
    const original = planner[name].bind(planner);
    planner[name] = async (...args) => {
      counts.passes++; planning++;
      try { return await original(...args); } finally { planning--; }
    };
  }
  const originalEvidence = planner.taskGitWorkspaces.releaseEvidence.bind(planner.taskGitWorkspaces);
  planner.taskGitWorkspaces.releaseEvidence = async (...args) => {
    if (planning) counts.evidence++;
    return originalEvidence(...args);
  };
  const originalRead = planner.taskBoard.releaseTasks.bind(planner.taskBoard);
  planner.taskBoard.releaseTasks = (...args) => { counts.canonicalReads++; return originalRead(...args); };
  const originalSelected = planner.taskBoard.selectedCompositionForRelease.bind(planner.taskBoard);
  planner.taskBoard.selectedCompositionForRelease = (...args) => { counts.selectedReads++; return originalSelected(...args); };
  server = new HubMcpServer({ service, secret: "synthetic-private-http", logger: { log() {}, error() {} } });
  await server.start();
  const tool = await readReleaseToolPackage();
  const { HubClient, executeRelease } = await tool.module("src/hub-client.mjs");
  const client = new HubClient({ url: server.url, contextToken: context_token });
  const current = board.task(selected[19].taskId);
  const business = { request_id: "same-ordinary-await-20", task_id: current.id,
    status: "awaiting_implementation", expected_task_revision: current.revision, expected_workflow_status: "testing" };
  const start = performance.now();
  let reply;
  try { reply = await executeRelease(client, "accept", business); }
  finally { await service.joinSubmittedTaskOperation({ context_token, ...business }); }
  const elapsedMs = performance.now() - start;
  const receipt = await client.readTaskOriginal(business);
  assert.equal(receipt.taskOperation.status, "succeeded", JSON.stringify(reply));
  assert.equal(board.task(current.id).workflowStatus, "awaiting_implementation");
  const after = await releaseGit.frozenCandidate(primary);
  assert.equal(after.manifest.tasks.length, 20);
  for (const value of selected) await git(after.releaseRoot, "merge-base", "--is-ancestor", value.resultCommit, after.preReleaseHead);
  for (let index = 0; index < 20; index++) {
    assert.equal(await readFile(path.join(after.releaseRoot, `selected-${index}.txt`), "utf8"), `result-${index}\n`);
  }
  assert.equal(await git(primary, "rev-parse", "HEAD"), primaryHead);
  assert.equal(await git(primary, "write-tree"), primaryIndex);
  assert.equal(await git(primary, "status", "--porcelain=v1", "--untracked-files=all"), "");
  const reflog = await git(after.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  await executeRelease(client, "accept", business);
  assert.equal(await git(after.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  assert.equal(counts.passes, 6);
  assert.equal(counts.evidence, 120);
  assert.equal(counts.canonicalReads, 12, "fresh canonical reread is retained without a second Git pass");
  t.diagnostic(JSON.stringify({ counts, elapsedMs, source: "default CLI runtime / external HTTP / real SQLite and Git",
    fullResults: 20, primaryPreserved: true, sameOriginalReadback: true }));
});
