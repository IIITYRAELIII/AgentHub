import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { executeTaskAwaitCutover, inspectTaskAwaitCutoverSource, inspectInstalledNativeTestOwner, openTaskAwaitCutoverRuntime,
  parseTaskAwaitCutoverArguments } from "../../../task-await-cutover.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskReleasePlanService } from "../../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../../src/application/workspace-release-preflight-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { openTaskOperationReconciliationStores } from "../../../src/interfaces/cli/task-operation-reconciliation-runtime.mjs";

const exec = promisify(execFile);
const hash = "b".repeat(64);
const wire = value => JSON.parse(JSON.stringify(value));
async function git(cwd, ...args) {
  return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
}
async function commit(cwd, message) {
  await git(cwd, "add", ".");
  await git(cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-initial-native-"));
  const primary = path.join(root, "primary"), dataDir = path.join(root, "data");
  await mkdir(primary); await mkdir(dataDir);
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "base.txt"), "main\n"); await commit(primary, "main");
  const main = await git(primary, "rev-parse", "HEAD");
  const origin = path.join(root, "origin.git");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin); await git(primary, "push", "origin", "main");
  const databaseFile = path.join(dataDir, "journal.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
  const store = new TaskBoardStore({ databaseFile });
  t.after(async () => { store.close(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Native fixture",
    settings: { workingDirectory: primary, releaseWorkflowEnabled: true } }));
  const stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id, name: "Owner" }));
  await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "fixture-thread", streamId: stream.id }));
  const publication = { generation: "fixture", repositories: [{ root: primary, revision: main }] };
  const board = new TaskBoardService({ store, workspaceCatalog: catalog });
  const taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication, recordTiming: () => {} });
  const releaseGit = new ReleaseGitWorkspaceService({ dataDir });
  const preflight = new WorkspaceReleasePreflightService({
    releasePlanner: new TaskReleasePlanService({ taskBoard: board, taskGitWorkspaces: taskGit }),
    taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit, readPublicationState: async () => publication,
    resolveReleaseValidationSource: () => assert.fail("Cutover never refreshes a shared Contour"),
    validateProductionCandidate: () => assert.fail("Cutover never publishes"),
  });
  await taskGit.prepareDev(primary);
  let installed = { available: false, hash };
  const open = async () => {
    let raw;
    const runtime = await openTaskAwaitCutoverRuntime({ config: { dataDir, taskBoard: { autoPlaceConfidence: 0.8 } },
      openStores: async options => { raw = await openTaskOperationReconciliationStores(options); return raw; },
      taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit, releasePreflight: preflight });
    runtime.inspectInstalledNativeOwner = async () => installed;
    runtime.fixtureCatalog = raw.workspaceCatalogStore;
    return runtime;
  };
  const create = async name => {
    const task = store.create({ text: name, bucket: "workspace", workspaceId: workspace.id });
    await board.claim({ id: task.id, workspaceId: workspace.id, streamId: stream.id,
      provider: "codex", threadId: "fixture-thread", turnId: `turn-${task.id}`, operationId: `claim-${task.id}` });
    const managed = await taskGit.prepare({ taskId: task.id, taskNumber: board.task(task.id).taskNumber, projectRoot: primary });
    await writeFile(path.join(managed.projectRoot, `${name}.txt`), `${name}\n`); await commit(managed.projectRoot, name);
    return { id: task.id, root: managed.projectRoot };
  };
  const input = async (task, requestId) => {
    const state = await preflight.initialNativeTestState({ workspaceId: workspace.id, projectRoot: primary });
    return { workspaceId: workspace.id, streamId: stream.id, provider: "codex", threadId: "fixture-thread",
      taskId: task.id, requestId, repositoryRoot: primary, expectedTaskRevision: board.task(task.id).revision,
      confirm: true, initialNativeTest: true,
      expectedSourceCommit: await git(task.root, "rev-parse", "HEAD"), expectedSourceTree: await git(task.root, "rev-parse", "HEAD^{tree}"),
      expectedSourceBranch: await git(task.root, "branch", "--show-current"), expectedMainCommit: main,
      expectedDevCommit: await git(primary, "rev-parse", "refs/heads/dev"),
      expectedPublicationHash: state.publicationHash, expectedCandidateHash: state.candidateHash,
      expectedPlanRevision: state.planRevision, expectedRuntimeHash: hash };
  };
  const run = (task, args, customize = null) => executeTaskAwaitCutover(args, {
    inspectSource: values => inspectTaskAwaitCutoverSource(values, { sourceRoot: task.root }),
    openRuntime: async () => { const runtime = await open(); customize?.(runtime); return runtime; },
  });
  return { root, primary, main, catalog, board, taskGit, releaseGit, preflight, publication, create, input, run, open,
    setInstalled: value => { installed = value; },
    async status(task, status, requestId) {
      const runtime = await open();
      try {
        const token = runtime.service.contextToken({ provider: "codex", threadId: "fixture-thread", streamId: stream.id });
        return await runtime.service.call("hub_task_status_update", { context_token: token, task_id: task.id,
          status, request_id: requestId, expected_task_revision: board.task(task.id).revision,
          expected_workflow_status: board.task(task.id).workflowStatus });
      } finally { runtime.close(); }
    },
  };
}

test("initial native Test parser requires the full reviewed identity and keeps legacy families separate", () => {
  const args = ["--workspace", "workspace", "--stream", "stream", "--provider", "codex", "--thread", "thread",
    "--task", "task", "--request", "original", "--repository", ".", "--expected-task-revision", "1",
    "--initial-native-test", "--confirm-cutover", "--expected-source-commit", "a".repeat(40),
    "--expected-source-tree", "a".repeat(40), "--expected-source-branch", "HUB-1",
    "--expected-main-commit", "a".repeat(40), "--expected-dev-commit", "a".repeat(40),
    "--expected-publication-sha256", hash, "--expected-candidate-sha256", hash,
    "--expected-plan-revision", hash, "--expected-runtime-sha256", hash];
  assert.equal(parseTaskAwaitCutoverArguments(args).initialNativeTest, true);
  assert.throws(() => parseTaskAwaitCutoverArguments(args.slice(0, -2)), /Missing value/u);
  assert.throws(() => parseTaskAwaitCutoverArguments([...args, "--expected-projector-sha256", hash]), /distinct/u);
  assert.throws(() => parseTaskAwaitCutoverArguments([...args, "--squash-bootstrap"]), /distinct/u);
});

test("initial native Test closes bootstrap only for a verified ready installed native status owner", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-installed-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const releaseId = "native-fixture", release = path.join(root, "releases", releaseId);
  await mkdir(path.join(root, "data"), { recursive: true });
  await mkdir(path.join(release, "src", "application"), { recursive: true });
  await mkdir(path.join(release, "src", "infrastructure", "filesystem"), { recursive: true });
  await writeFile(path.join(root, "current.json"), JSON.stringify({ current: releaseId }));
  await writeFile(path.join(root, "data", "bot.lock"), JSON.stringify({ pid: process.pid, ready: true, releaseId }));
  const files = { "package.json": JSON.stringify({ name: "agent-hub", version: "2026.9.25", type: "module" }),
    "src/application/hub-mcp-service.mjs": "export class HubMcpService { static nativeTaskStatusVersion = 1; }\n",
    "src/infrastructure/filesystem/native-release-merge.mjs": "export const fixture = true;\n" };
  const entries = [];
  for (const [file, value] of Object.entries(files)) {
    await writeFile(path.join(release, file), value);
    entries.push({ path: file, bytes: Buffer.byteLength(value), sha256: createHash("sha256").update(value).digest("hex") });
  }
  await writeFile(path.join(release, "runtime-manifest.json"), JSON.stringify({ releaseId, version: "2026.9.25", files: entries }));
  assert.equal((await inspectInstalledNativeTestOwner({ runtimeRoot: root })).available, true);
  await writeFile(path.join(release, "src/application/hub-mcp-service.mjs"), "tampered\n");
  await assert.rejects(inspectInstalledNativeTestOwner({ runtimeRoot: root }), /mismatch/u);
});

test("public CLI initial native Test retains the prepared accepted candidate and ordinary Await", { timeout: 180_000 }, async t => {
  const f = await fixture(t), accepted = await f.create("accepted");
  await f.status(accepted, "testing", "accepted-test"); await f.status(accepted, "awaiting_implementation", "accepted-await");
  const prepared = await f.releaseGit.initialNativeTestCandidate(f.primary);
  const task = await f.create("initial"), input = await f.input(task, "initial-original");
  const before = f.board.task(task.id);
  const result = await f.run(task, input);
  assert.equal(result.result.workflowStatus, "testing");
  assert.equal(result.result.gitIntegration.integrated, true);
  assert.equal(result.result.gitWorkspace.headCommit, input.expectedSourceCommit);
  assert.equal(f.board.task(task.id).revision, before.revision + 1);
  assert.equal(f.board.task(task.id).gitReferences[0].resultCommit, input.expectedSourceCommit);
  assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), prepared);
  const outcome = JSON.stringify(f.board.lifecycleOutcome(input.requestId));
  const dev = await git(f.primary, "rev-parse", "dev"), reflog = await git(f.primary, "reflog", "show", "--format=%H", "dev");
  f.setInstalled({ available: true, hash: "c".repeat(64) });
  assert.deepEqual((await f.run(task, input)).result, wire(result.result));
  assert.equal(JSON.stringify(f.board.lifecycleOutcome(input.requestId)), outcome);
  assert.equal(await git(f.primary, "reflog", "show", "--format=%H", "dev"), reflog);
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  const refused = await f.create("after-install"), refusal = await f.input(refused, "closed-bootstrap");
  await assert.rejects(f.run(refused, refusal), /bootstrap is closed/u);
  assert.equal(f.board.task(refused.id).workflowStatus, "in_progress");
  // Installed normal Test/Await uses the ordinary owner and has no launcher dependency.
  await f.status(refused, "testing", "ordinary-test-after-install");
  await f.status(task, "awaiting_implementation", "ordinary-await-after-cutover");
  assert.equal(f.board.task(task.id).workflowStatus, "awaiting_implementation");
  const current = await f.releaseGit.frozenCandidate(f.primary);
  assert.deepEqual(current.manifest.taskIds.sort(), [accepted.id, task.id].sort());
  assert.equal((await readFile(path.join(current.releaseRoot, "accepted.txt"), "utf8")).replaceAll("\r\n", "\n"), "accepted\n");
});

test("public CLI initial native Test refuses stale and foreign source, caller, Task and current pins", { timeout: 180_000 }, async t => {
  const f = await fixture(t), task = await f.create("guarded"), input = await f.input(task, "guard-original");
  const before = f.board.task(task.id), dev = await git(f.primary, "rev-parse", "dev");
  let opened = false;
  await assert.rejects(executeTaskAwaitCutover({ ...input, expectedSourceTree: "a".repeat(40) }, {
    inspectSource: values => inspectTaskAwaitCutoverSource(values, { sourceRoot: task.root }),
    openRuntime: () => { opened = true; assert.fail("Source must be inspected before stores"); },
  }), /tree or branch changed/u);
  assert.equal(opened, false);
  for (const [key, value] of [["expectedTaskRevision", before.revision + 1], ["expectedMainCommit", "a".repeat(40)],
    ["expectedDevCommit", "a".repeat(40)], ["expectedPublicationHash", "a".repeat(64)],
    ["expectedCandidateHash", "a".repeat(64)], ["expectedPlanRevision", "a".repeat(64)], ["expectedRuntimeHash", "a".repeat(64)]]) {
    await assert.rejects(f.run(task, { ...input, requestId: `stale-${key}`, [key]: value }));
    assert.equal(f.board.lifecycleTransition(`stale-${key}`), null);
  }
  const foreignStream = await f.catalog.runMutation(() => f.catalog.createStream({ workspaceId: input.workspaceId, name: "Foreign" }));
  await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "codex", threadId: "foreign-thread", streamId: foreignStream.id }));
  await assert.rejects(f.run(task, { ...input, requestId: "foreign-caller", streamId: foreignStream.id, threadId: "foreign-thread" }), /caller|assignment/u);
  const foreign = await f.create("foreign-source"), foreignInput = await f.input(foreign, "foreign-source-original");
  await assert.rejects(f.run(foreign, { ...foreignInput, taskId: task.id, expectedTaskRevision: before.revision }), /managed Task checkout/u);
  assert.deepEqual(f.board.task(task.id), before);
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  assert.equal(f.catalog.mcpOperation("guard-original"), null);
});

test("public CLI native Test and Await preserve primary hooks without invoking clone configuration", { timeout: 180_000 }, async t => {
  const f = await fixture(t), accepted = await f.create("accepted-before-hooks");
  await f.status(accepted, "testing", "before-hooks-test");
  await f.status(accepted, "awaiting_implementation", "before-hooks-await");
  const prepared = await f.releaseGit.initialNativeTestCandidate(f.primary);
  const task = await f.create("hooked");
  const hooks = path.join(f.root, "team-hooks"), marker = path.join(f.root, "hook-ran");
  await mkdir(hooks);
  const hook = `#!/bin/sh\nprintf ran > '${marker.replaceAll("\\", "/")}'\nexit 91\n`;
  const packHook = path.join(hooks, "pack-objects");
  await writeFile(packHook, hook, { mode: 0o755 });
  await git(f.primary, "config", "core.hooksPath", hooks);
  await git(f.primary, "config", "uploadpack.packObjectsHook", `sh '${packHook.replaceAll("\\", "/")}'`);
  const config = await readFile(path.join(f.primary, ".git", "config"));
  const input = await f.input(task, "hooked-native-original");
  const result = await f.run(task, input);
  assert.equal(result.result.workflowStatus, "testing");
  assert.equal(f.catalog.mcpOperation(input.requestId).status, "succeeded");
  assert.deepEqual(await f.releaseGit.initialNativeTestCandidate(f.primary), prepared);
  await f.status(task, "awaiting_implementation", "hooked-native-await");
  const candidate = await f.releaseGit.frozenCandidate(f.primary);
  assert.deepEqual(candidate.manifest.taskIds.sort(), [accepted.id, task.id].sort());
  await git(candidate.releaseRoot, "merge-base", "--is-ancestor", input.expectedSourceCommit, candidate.preReleaseHead);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.main);
  assert.deepEqual(await readFile(path.join(f.primary, ".git", "config")), config);
  await assert.rejects(readFile(marker), { code: "ENOENT" });
  assert.deepEqual((await f.run(task, input)).result, wire(result.result));
});

test("public CLI initial native Test fences caller rotation in the lifecycle admission transaction", { timeout: 90_000 }, async t => {
  const f = await fixture(t), task = await f.create("sql-race"), input = await f.input(task, "sql-caller-race");
  const before = f.board.task(task.id), dev = await git(f.primary, "rev-parse", "dev");
  await assert.rejects(f.run(task, input, runtime => {
    const begin = runtime.taskBoard.beginLifecycleTransition.bind(runtime.taskBoard);
    runtime.taskBoard.beginLifecycleTransition = async options => {
      await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "codex", threadId: "rotated-thread", streamId: input.streamId }));
      return begin(options);
    };
  }), /current SQL caller/u);
  assert.equal(f.board.lifecycleTransition(input.requestId), null);
  assert.equal(f.catalog.mcpOperation(input.requestId).status, "failed");
  assert.deepEqual(f.board.task(task.id), before);
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
});

for (const failure of ["sql-terminal", "mcp-receipt"]) {
  test(`public CLI initial native Test reopens ${failure} UNKNOWN with the same original and no second dev CAS`, { timeout: 180_000 }, async t => {
    const f = await fixture(t), task = await f.create("recover"), input = await f.input(task, `lost-${failure}`);
    const before = f.board.task(task.id);
    await assert.rejects(f.run(task, input, runtime => {
      if (failure === "sql-terminal") runtime.taskBoard.commitWorkflowTransition = async () => { throw new Error("Lost SQL terminal"); };
      else runtime.fixtureCatalog.completeMcpOperation = async () => { throw new Error("Lost MCP receipt"); };
    }), /unknown|UNKNOWN|readback|reconciliation/u);
    const receipt = f.catalog.mcpOperation(input.requestId);
    assert.equal(receipt.status, "unknown");
    assert.equal(f.board.task(task.id).workflowStatus, failure === "sql-terminal" ? "in_progress" : "testing");
    const dev = await git(f.primary, "rev-parse", "dev"), reflog = await git(f.primary, "reflog", "show", "--format=%H", "dev");
    const priorOutcome = JSON.stringify(f.board.lifecycleOutcome(input.requestId));
    // Same original recovery stays available after the native installed owner appears.
    f.setInstalled({ available: true, hash: "c".repeat(64) });
    await assert.rejects(f.run(task, { ...input, expectedDevCommit: "a".repeat(40) }), /original caller or arguments|identity/u);
    const foreignStream = await f.catalog.runMutation(() => f.catalog.createStream({ workspaceId: input.workspaceId, name: "Foreign recovery" }));
    await f.catalog.runMutation(() => f.catalog.bindThread({ provider: "codex", threadId: "foreign-recovery", streamId: foreignStream.id }));
    await assert.rejects(f.run(task, { ...input, streamId: foreignStream.id, threadId: "foreign-recovery" }), /original caller or arguments/u);
    if (failure === "sql-terminal") {
      await writeFile(path.join(task.root, "recover.txt"), "foreign\n");
      await assert.rejects(f.run(task, input), /dirty/u);
      await writeFile(path.join(task.root, "recover.txt"), "recover\n");
      f.publication.generation = "foreign";
      await assert.rejects(f.run(task, input), /UNKNOWN/u);
      assert.equal(f.catalog.mcpOperation(input.requestId).status, "unknown");
      f.publication.generation = "fixture";
    }
    const result = await f.run(task, input);
    assert.equal(result.result.workflowStatus, "testing");
    assert.equal(f.catalog.mcpOperation(input.requestId).status, "succeeded");
    assert.equal(f.board.task(task.id).revision, before.revision + 1);
    assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
    assert.equal(await git(f.primary, "reflog", "show", "--format=%H", "dev"), reflog);
    if (failure === "mcp-receipt") assert.equal(JSON.stringify(f.board.lifecycleOutcome(input.requestId)), priorOutcome);
    assert.deepEqual((await f.run(task, input)).result, wire(result.result));
  });
}
