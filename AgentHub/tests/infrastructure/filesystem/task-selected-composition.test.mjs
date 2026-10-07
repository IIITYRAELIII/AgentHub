import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { TaskGitWorkspaceService, runTaskGitCommand } from "../../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { releaseTaskNetProjections } from "../../../src/infrastructure/filesystem/release-task-net-projection.mjs";
import { TaskLifecycleService } from "../../../src/application/task-lifecycle-service.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { HubMcpService } from "../../../src/application/hub-mcp-service.mjs";
import { ordinaryPublishedResolutionFixture } from "../../fixtures/ordinary-published-resolution-fixture.mjs";

const exec = promisify(execFile);
const TASK_ID = "367ffe17-f69f-4886-b9be-901558ecace2";

async function git(cwd, ...args) {
  return (await exec("git", args, { cwd })).stdout.trim();
}

async function fixture(t, { ordinary = false } = {}) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "selected-owner-"));
  const closeDependencies = [];
  t.after(async () => {
    for (const close of closeDependencies) close();
    await rm(temp, { recursive: true, force: true });
  });
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
  let taskWorkspace;
  let devWorkspace;
  if (!ordinary) {
    taskWorkspace = await service.prepare({ taskId: TASK_ID, projectRoot: root });
    devWorkspace = await service.prepareDev(root);
  }
  await git(root, "switch", "-q", "-c", "published");
  await writeFile(path.join(root, "conflict.txt"), "published\n");
  const published = await commit(root, "published");
  await git(root, "push", "-q", "origin", `${published}:refs/heads/main`);
  await git(root, "switch", "-q", "main");
  await writeFile(path.join(root, "local.txt"), "approved local\n");
  const local = await commit(root, "local");
  if (ordinary) {
    taskWorkspace = await service.prepare({ taskId: TASK_ID, projectRoot: root });
    devWorkspace = await service.prepareDev(root);
  }
  await git(taskWorkspace.projectRoot, "merge", "--ff-only", local);
  await git(devWorkspace.projectRoot, "merge", "--ff-only", local);
  await writeFile(path.join(taskWorkspace.projectRoot, "feature.txt"), "selected feature\n");
  if (ordinary) await writeFile(path.join(taskWorkspace.projectRoot, "conflict.txt"), "own\n");
  await commit(taskWorkspace.projectRoot, "Task feature", { forced: "feature.txt" });
  if (!ordinary) await git(taskWorkspace.projectRoot, "-c", "user.name=Test", "-c", "user.email=test@example.invalid",
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
    base, local, published, task, dev, proof, tree, bundle, bundleSha256, closeDependencies };
}

async function publicFixture(f) {
  const databaseFile = path.join(path.dirname(f.root), "ordinary-public.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const workspace = catalog.hierarchy().find((entry) => entry.name === "Ordinary Test")
    ?? await catalog.runMutation(() => catalog.createWorkspace({ name: "Ordinary Test",
      settings: { workingDirectory: f.root, releaseWorkflowEnabled: true } }));
  const store = new TaskBoardStore({ databaseFile, idFactory: () => TASK_ID });
  if (!catalog.stream("rm")) await catalog.runMutation(() => catalog.createStream({
    id: "rm", workspaceId: workspace.id, name: "RM",
    settings: { releaseManager: true, workingDirectory: f.root },
  }));
  const workspaceCatalog = {
    workspace: () => workspace,
    hierarchy: () => [{ ...workspace, streams: [{ id: "rm", workspaceId: workspace.id,
      settings: { releaseManager: true, workingDirectory: f.root } }] }],
    resolveThread: () => ({ workspaceId: workspace.id, workspaceName: workspace.name,
      streamId: "rm", streamDisplayName: "RM", thread: { projectRoot: f.root } }),
    stream: () => ({ id: "rm", workspaceId: workspace.id, settings: { workingDirectory: f.root } }),
    activeThread: () => null, workspaceEvents: () => [],
    developerRulesForStream: () => ({}),
    updateWorkspaceDeveloperRules: () => { throw new Error("unused metadata mutation"); },
    updateStreamDeveloperRules: () => { throw new Error("unused metadata mutation"); },
  };
  for (const name of ["beginMcpOperation", "bindMcpOperationInterstreamContentHash",
    "completeMcpOperation", "failMcpOperation", "markMcpOperationUnknown", "mcpOperations",
    "mcpOperation", "pendingMcpOperations", "completeUnknownMcpOperation", "failUnknownMcpOperation",
    "markMcpOperationReconciling"]) {
    if (typeof catalog[name] === "function") workspaceCatalog[name] = catalog[name].bind(catalog);
  }
  const taskBoard = new TaskBoardService({ store, workspaceCatalog });
  if (!store.task(TASK_ID)) {
    store.create({ text: "Ordinary own Test", bucket: "workspace", workspaceId: workspace.id });
    store.setWorkflowStatus(TASK_ID, "in_progress");
  }
  const releasePreflight = { preflight: async () => ({}),
    withAwaitTransition: (_id, action) => action() };
  const lifecycle = new TaskLifecycleService({ taskBoard, workspaceCatalog,
    taskGitWorkspaces: f.service, releasePreflight });
  const mcp = new HubMcpService({ workspaceCatalog, taskBoard,
    workLog: { threadTurns: () => [] }, attachmentDirectory: path.join(f.dataDir, "attachments"),
    secret: "isolated-test-secret", releasePreflight,
    releaseCompleter: { completeRelease: async () => { throw new Error("no publication"); } },
    taskGitWorkspaces: f.service, taskLifecycle: lifecycle, reconcilePendingOnStartup: false });
  const args = { context_token: mcp.contextToken({ provider: "codex", threadId: "test-thread" }),
    task_id: TASK_ID, status: "testing",
    expected_task_revision: taskBoard.task(TASK_ID).revision, expected_workflow_status: "in_progress",
    selected_proof_bundle_path: f.bundle, selected_proof_bundle_sha256: f.bundleSha256,
    selected_proof_commit: f.proof };
  let closed = false;
  const close = () => {
    if (!closed) { closed = true; store.close(); catalog.close(); }
  };
  f.closeDependencies.push(close);
  return { mcp, args, catalog, taskBoard, lifecycle, close };
}

async function publishedFixture(f) {
  return ordinaryPublishedResolutionFixture(f, {
    taskId: TASK_ID, repositoryKey: path.basename(f.taskWorkspace.projectRoot),
    taskBaseCommit: f.local, acceptedLocalMainCommit: f.local, taskCommit: f.task, devCommit: f.dev,
    proofCommit: f.proof, publishedCommit: f.published, publicationGeneration: "generation-1",
    remoteCommit: f.published, bundleSha256: f.bundleSha256,
  });
}

test("ordinary own Test passes public preview and confirmation with real Git and durable SQLite", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t, { ordinary: true });
  const p = await publicFixture(f);
  t.after(p.close);
  const preview = await p.mcp.call("hub_task_status_update", { ...p.args, request_id: "ordinary-preview" });
  assert.equal(preview.confirmationRequired, true);
  assert.equal(preview.selectedComposition.proofRoute, "ordinary-own-conflict-v1");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  assert.equal(p.taskBoard.task(TASK_ID).workflowStatus, "in_progress");
  assert.equal(p.taskBoard.lifecycleTransition("ordinary-preview"), null);
  const confirmArgs = { ...p.args, request_id: "ordinary-confirm",
    selected_preview_request_id: "ordinary-preview", expected_selected_preview_hash: preview.previewHash };
  const completed = await p.mcp.call("hub_task_status_update", confirmArgs);
  assert.equal(completed.task.workflowStatus, "testing");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await git(f.root, "rev-parse", "main"), f.local);
  assert.equal(await git(f.taskWorkspace.projectRoot, "rev-parse", "HEAD"), f.task);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "unselected.txt"), "utf8"), "unselected\n");
  assert.equal(p.catalog.mcpOperation("ordinary-confirm").status, "succeeded");
  const replay = await p.mcp.call("hub_task_status_update", confirmArgs);
  assert.equal(replay.task.revision, completed.task.revision);
  p.close();
  const reopened = await publicFixture(f);
  t.after(reopened.close);
  assert.equal(reopened.catalog.mcpOperation("ordinary-confirm").status, "succeeded");
  assert.equal(reopened.taskBoard.task(TASK_ID).workflowStatus, "testing");
  const afterReopen = await reopened.mcp.call("hub_task_status_update", {
    ...confirmArgs, context_token: reopened.args.context_token });
  assert.equal(afterReopen.task.revision, completed.task.revision);
});

test("ordinary published resolution persists through public preview confirmation and reload", { timeout: 90_000 }, async (t) => {
  const f = await fixture(t, { ordinary: true });
  const p = await publicFixture(f);
  const input = { taskId: TASK_ID, repositoryKey: path.basename(f.taskWorkspace.projectRoot),
    taskBaseCommit: f.local, acceptedLocalMainCommit: f.local, taskCommit: f.task, devCommit: f.dev,
    proofCommit: f.proof, publishedCommit: f.published, publicationGeneration: "generation-1",
    remoteCommit: f.published, bundleSha256: f.bundleSha256 };
  const published = await ordinaryPublishedResolutionFixture(f, input);
  const args = { ...p.args, selected_published_resolution: published.input };
  const preview = await p.mcp.call("hub_task_status_update", { ...args, request_id: "published-preview" });
  assert.equal(preview.selectedComposition.selectedReleaseTree, published.tree);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  assert.equal(p.taskBoard.lifecycleTransition("published-preview"), null);
  const confirm = { ...args, request_id: "published-confirm", selected_preview_request_id: "published-preview",
    expected_selected_preview_hash: preview.previewHash };
  const done = await p.mcp.call("hub_task_status_update", confirm);
  assert.equal(done.task.workflowStatus, "testing");
  const durable = p.taskBoard.lifecycleOutcome("published-confirm").result.evidence.selectedComposition;
  assert.equal(durable.selectedReleaseTree, published.tree);
  assert.equal(durable.publishedResolution.resolutionCommit, published.commit);
  p.close();
  const reopened = await publicFixture(f);
  const replay = await reopened.mcp.call("hub_task_status_update", { ...confirm, context_token: reopened.args.context_token });
  assert.equal(replay.task.revision, done.task.revision);
  const evidence = await f.service.releaseIntegrationEvidence({ projectRoot: f.root,
    tasks: [{ taskId: TASK_ID, taskRevision: done.task.revision, projectRoot: f.root,
      branch: f.taskWorkspace.branch, resultCommit: f.task }] });
  assert.equal(evidence.tasks[0].selectedComposition.selectedReleaseTree, published.tree);
  const project = await releaseTaskNetProjections({ tasks: evidence.tasks, baseCommit: f.published,
    git: (a, o) => runTaskGitCommand(a, { ...o, cwd: f.root }) });
  assert.equal(project.get(TASK_ID).commit, published.commit);
  assert.equal(await git(f.root, "rev-parse", "main"), f.local);
  assert.equal(await git(f.taskWorkspace.projectRoot, "rev-parse", "HEAD"), f.task);
});

for (const drift of ["bundle", "last pre-CAS bundle", "generation", "preview hash"]) {
  test(`ordinary published resolution refuses fresh ${drift} drift without a Git or Task effect`,
    { timeout: 90_000 }, async (t) => {
      const f = await fixture(t, { ordinary: true });
      const p = await publicFixture(f);
      const published = await publishedFixture(f);
      const args = { ...p.args, selected_published_resolution: published.input };
      const preview = await p.mcp.call("hub_task_status_update", { ...args, request_id: "pub-drift-preview" });
      let cas = 0;
      f.service.runCommand = async (command, options) => {
        if (command[0] === "update-ref" && command[1] === "refs/heads/dev") cas += 1;
        const result = await runTaskGitCommand(command, options);
        if (drift === "last pre-CAS bundle" && command[0] === "bundle" && command[1] === "unbundle"
            && command[2].endsWith("published-review.bundle")
            && command[2].includes("pub-drift-confirm")) {
          await writeFile(published.bundle, "changed at final fence");
        }
        return result;
      };
      if (drift === "bundle") await writeFile(published.bundle, "changed review bytes");
      if (drift === "generation") f.service.readPublication = async () => ({
        generation: "generation-2", repositories: [{ root: f.root, revision: f.published }] });
      await assert.rejects(p.mcp.call("hub_task_status_update", { ...args, request_id: "pub-drift-confirm",
        selected_preview_request_id: "pub-drift-preview",
        expected_selected_preview_hash: drift === "preview hash" ? "0".repeat(64) : preview.previewHash }),
      /changed|hash|generation|identity/u);
      assert.equal(cas, 0);
      assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
      assert.equal(p.taskBoard.task(TASK_ID).workflowStatus, "in_progress");
      assert.equal(await git(f.taskWorkspace.projectRoot, "rev-parse", "HEAD"), f.task);
      assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
    });
}

for (const drift of ["Task bytes", "dev bytes", "bundle bytes", "revision", "Task result", "dev result",
  "base ref", "local main", "remote main", "publication"]) {
  test(`ordinary public confirmation refuses fresh ${drift} drift and preserves original bytes`, {
    timeout: 90_000,
  }, async (t) => {
    const f = await fixture(t, { ordinary: true });
    const p = await publicFixture(f);
    const preview = await p.mcp.call("hub_task_status_update", { ...p.args, request_id: "drift-preview" });
    if (drift === "Task bytes") await writeFile(path.join(f.taskWorkspace.projectRoot, "conflict.txt"), "private Task\n");
    if (drift === "dev bytes") await writeFile(path.join(f.devWorkspace.projectRoot, "conflict.txt"), "private dev\n");
    if (drift === "bundle bytes") await writeFile(f.bundle, "substituted bundle");
    if (drift === "revision") await p.taskBoard.update({ id: TASK_ID,
      title: p.taskBoard.task(TASK_ID).title, description: "foreign durable Task revision" });
    if (drift === "base ref") {
      const ref = (await git(f.root, "for-each-ref", "--format=%(refname)",
        `refs/agent-hub/task-bases/${TASK_ID}/`)).split(/\r?\n/u)[0];
      assert.ok(ref);
      await git(f.root, "update-ref", ref, f.published);
    }
    if (drift === "local main") await git(f.root, "update-ref", "refs/heads/main", f.published);
    if (drift === "remote main") await git(f.root, "push", "-q", "--force", "origin", `${f.local}:refs/heads/main`);
    if (drift === "publication") f.service.readPublication = async () => ({
      generation: "foreign-generation", repositories: [{ root: f.root, revision: f.published }],
    });
    if (["Task result", "dev result"].includes(drift)) {
      const cwd = drift === "Task result" ? f.taskWorkspace.projectRoot : f.devWorkspace.projectRoot;
      await writeFile(path.join(cwd, "foreign.txt"), "foreign owner\n");
      await git(cwd, "add", "foreign.txt");
      await git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "foreign result");
    }
    const devBefore = await git(f.root, "rev-parse", "dev");
    const taskBefore = await git(f.taskWorkspace.projectRoot, "rev-parse", "HEAD");
    const revisionBefore = p.taskBoard.task(TASK_ID).revision;
    const mainBefore = await git(f.root, "rev-parse", "main");
    await assert.rejects(p.mcp.call("hub_task_status_update", { ...p.args, request_id: "drift-confirm",
      selected_preview_request_id: "drift-preview", expected_selected_preview_hash: preview.previewHash }));
    assert.equal(await git(f.root, "rev-parse", "dev"), devBefore);
    assert.equal(await git(f.taskWorkspace.projectRoot, "rev-parse", "HEAD"), taskBefore);
    assert.equal(p.taskBoard.task(TASK_ID).revision, revisionBefore);
    assert.equal(await git(f.root, "rev-parse", "main"), mainBefore);
    assert.equal(p.taskBoard.lifecycleTransition("drift-confirm"), null);
    if (drift === "Task bytes") assert.equal(await readFile(path.join(f.taskWorkspace.projectRoot, "conflict.txt"), "utf8"), "private Task\n");
    if (drift === "dev bytes") assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "conflict.txt"), "utf8"), "private dev\n");
  });
}

test("ordinary public lost receipt after Task commit settles original ID after SQLite reopen", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t, { ordinary: true });
  const p = await publicFixture(f);
  const preview = await p.mcp.call("hub_task_status_update", { ...p.args, request_id: "lost-preview" });
  const confirmArgs = { ...p.args, request_id: "lost-confirm", selected_preview_request_id: "lost-preview",
    expected_selected_preview_hash: preview.previewHash };
  const complete = p.mcp.workspaceCatalog.completeMcpOperation;
  p.mcp.workspaceCatalog.completeMcpOperation = (requestId, result) => {
    if (requestId === "lost-confirm") throw new Error("injected receipt failure after real Task commit");
    return complete(requestId, result);
  };
  await assert.rejects(p.mcp.call("hub_task_status_update", confirmArgs), /receipt reconciliation/u);
  assert.equal(p.catalog.mcpOperation("lost-confirm").status, "unknown");
  assert.equal(p.taskBoard.task(TASK_ID).workflowStatus, "testing");
  const revision = p.taskBoard.task(TASK_ID).revision;
  p.close();
  const reopened = await publicFixture(f);
  const settled = await reopened.mcp.taskOperationReconciliation.reconcileUnknownWorkflow({
    workspaceId: reopened.taskBoard.task(TASK_ID).workspaceId, taskId: TASK_ID,
    operationRequestId: "lost-confirm", projectRoot: f.root,
    expectedTaskRevision: confirmArgs.expected_task_revision, expectedWorkflowStatus: "in_progress",
    selectedBundlePath: f.bundle, selectedBundleSha256: f.bundleSha256, selectedProofCommit: f.proof,
    selectedPreviewRequestId: "lost-preview", expectedSelectedPreviewHash: preview.previewHash,
  });
  assert.equal(settled.outcome, "succeeded");
  assert.equal(reopened.catalog.mcpOperation("lost-confirm").status, "succeeded");
  const replay = await reopened.mcp.call("hub_task_status_update", {
    ...confirmArgs, context_token: reopened.args.context_token });
  assert.equal(replay.revision, revision);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
});

test("ordinary pre-CAS partial staging resumes under its original public confirmation", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t, { ordinary: true });
  const p = await publicFixture(f);
  const preview = await p.mcp.call("hub_task_status_update", { ...p.args, request_id: "partial-preview" });
  const record = path.join(f.dataDir, "task-selected-compositions", TASK_ID,
    path.basename(f.taskWorkspace.projectRoot), "partial-confirm");
  await mkdir(path.join(record, "materialization"), { recursive: true });
  await writeFile(path.join(record, "intent.json.tmp-00000000-0000-4000-8000-000000000000"), "{partial");
  await writeFile(path.join(record, "materialization", "new-0"), "partial staging");
  const result = await p.mcp.call("hub_task_status_update", { ...p.args, request_id: "partial-confirm",
    selected_preview_request_id: "partial-preview", expected_selected_preview_hash: preview.previewHash });
  assert.equal(result.task.workflowStatus, "testing");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(p.catalog.mcpOperation("partial-confirm").status, "succeeded");
});

test("ordinary published resolution CLI settles only the bound original receipt after restart",
  { timeout: 90_000 }, async (t) => {
    const f = await fixture(t, { ordinary: true });
    const p = await publicFixture(f);
    const published = await publishedFixture(f);
    const args = { ...p.args, selected_published_resolution: published.input };
    const preview = await p.mcp.call("hub_task_status_update", { ...args, request_id: "cli-pub-preview" });
    const workspaceId = p.taskBoard.task(TASK_ID).workspaceId;
    const complete = p.mcp.workspaceCatalog.completeMcpOperation;
    p.mcp.workspaceCatalog.completeMcpOperation = (id, result) => {
      if (id === "cli-pub-confirm") throw new Error("injected receipt loss after real Task commit");
      return complete(id, result);
    };
    await assert.rejects(p.mcp.call("hub_task_status_update", { ...args, request_id: "cli-pub-confirm",
      selected_preview_request_id: "cli-pub-preview", expected_selected_preview_hash: preview.previewHash }),
    /receipt reconciliation/u);
    assert.equal(p.catalog.mcpOperation("cli-pub-confirm").status, "unknown");
    const revision = p.taskBoard.task(TASK_ID).revision;
    p.close();
    // Only the synthetic closed fixture database is copied into its isolated CLI data root.
    const databaseFile = path.join(f.dataDir, "journal.sqlite");
    await copyFile(path.join(path.dirname(f.root), "ordinary-public.sqlite"), databaseFile);
    const configFile = path.join(f.dataDir, "cli-config.json");
    const envelopeFile = path.join(f.dataDir, "published-input.json");
    await writeFile(configFile, JSON.stringify({ projectRoot: f.root, dataDir: f.dataDir,
      components: { telegram: false } }));
    const command = [fileURLToPath(new URL("../../../task-operation-reconcile.mjs", import.meta.url)),
      "--workspace", workspaceId, "--task", TASK_ID, "--operation", "cli-pub-confirm",
      "--repository", f.root, "--expected-task-revision", String(args.expected_task_revision),
      "--expected-workflow-status", "in_progress", "--selected-proof-bundle-path", f.bundle,
      "--selected-proof-bundle-sha256", f.bundleSha256, "--selected-proof-commit", f.proof,
      "--selected-preview-request-id", "cli-pub-preview", "--expected-selected-preview-hash", preview.previewHash,
      "--selected-published-resolution", envelopeFile];
    const options = { env: { ...process.env, AGENT_HUB_CONFIG: configFile, CODEX_PROJECT_ROOT: f.root,
      LOCALAPPDATA: f.dataDir, XDG_STATE_HOME: f.dataDir, AI_PROVIDER: "codex" },
      windowsHide: true, timeout: 15_000 };
    await writeFile(envelopeFile, JSON.stringify({ ...published.input, resolutionCommit: f.task }));
    await assert.rejects(exec(process.execPath, command, options), /identity|arguments|hash|match/u);
    await writeFile(envelopeFile, JSON.stringify(published.input));
    const { stdout } = await exec(process.execPath, command, options);
    assert.equal(JSON.parse(stdout).outcome, "succeeded");
    const catalog = new WorkspaceCatalogStore({ databaseFile });
    await catalog.load();
    const store = new TaskBoardStore({ databaseFile });
    f.closeDependencies.push(() => { store.close(); catalog.close(); });
    assert.equal(catalog.mcpOperation("cli-pub-confirm").status, "succeeded");
    assert.equal(store.task(TASK_ID).revision, revision);
    assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  });

test("ordinary worker hard death", { skip: !process.env.H295_HARD_DEATH_SNAPSHOT }, async (t) => {
  const f = await fixture(t, { ordinary: true });
  const p = await publicFixture(f);
  const published = process.env.H295_PUBLISHED_DEATH ? await publishedFixture(f) : null;
  if (published) p.args.selected_published_resolution = published.input;
  const preview = await p.mcp.call("hub_task_status_update", { ...p.args, request_id: "death-preview" });
  await writeFile(process.env.H295_HARD_DEATH_SNAPSHOT, JSON.stringify({
    root: f.root, remote: f.remote, dataDir: f.dataDir, published: f.published,
    taskWorkspace: f.taskWorkspace, devWorkspace: f.devWorkspace, task: f.task,
    dev: f.dev, proof: f.proof, bundle: f.bundle, bundleSha256: f.bundleSha256,
    revision: p.args.expected_task_revision, previewHash: preview.previewHash, publishedResolution: published,
  }));
  const complete = p.mcp.workspaceCatalog.completeMcpOperation;
  p.mcp.workspaceCatalog.completeMcpOperation = (id, value) => {
    if (id === "death-confirm") process.kill(process.pid, "SIGKILL");
    return complete(id, value);
  };
  await p.mcp.call("hub_task_status_update", { ...p.args, request_id: "death-confirm",
    selected_preview_request_id: "death-preview", expected_selected_preview_hash: preview.previewHash });
  assert.fail("worker must die before outer receipt");
});

for (const withPublished of [false, true]) test(`ordinary ${withPublished ? "published resolution " : ""}hard death after real Task commit reopens and settles without a second Git CAS`, {
  timeout: 90_000,
}, async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "ordinary-death-"));
  const snapshot = path.join(temp, "snapshot.json");
  let f = null;
  t.after(async () => {
    if (f) {
      for (const close of f.closeDependencies) close();
      await rm(path.dirname(f.root), { recursive: true, force: true });
    }
    await rm(temp, { recursive: true, force: true });
  });
  const workerEnv = { ...process.env, H295_HARD_DEATH_SNAPSHOT: snapshot,
    H295_PUBLISHED_DEATH: withPublished ? "1" : "" };
  delete workerEnv.NODE_TEST_CONTEXT;
  await assert.rejects(exec(process.execPath, ["--test", "--test-name-pattern=ordinary worker hard death",
    fileURLToPath(import.meta.url)], { env: workerEnv }));
  f = JSON.parse(await readFile(snapshot, "utf8"));
  f.closeDependencies = [];
  f.service = new TaskGitWorkspaceService({ dataDir: f.dataDir,
    readPublication: async () => ({ generation: "generation-1", repositories: [{ root: f.root, revision: f.published }] }),
    runCommand: async (args, options) => {
      assert.ok(!(args[0] === "update-ref" && args[1] === "refs/heads/dev"), "terminal settlement must not repeat CAS");
      return runTaskGitCommand(args, options);
    } });
  const p = await publicFixture(f);
  assert.equal(p.catalog.mcpOperation("death-confirm").status, "pending");
  assert.equal(p.taskBoard.task(TASK_ID).workflowStatus, "testing");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  // The existing startup owner settles the committed durable outcome directly.
  // A pending receipt must not be mislabeled UNKNOWN to use another route.
  const settled = await p.mcp.reconcilePendingMcpOperations();
  assert.equal(settled.reconciled, 1);
  assert.equal(p.catalog.mcpOperation("death-confirm").status, "succeeded");
  assert.equal(await git(f.taskWorkspace.projectRoot, "rev-parse", "HEAD"), f.task);
  if (withPublished) {
    const evidence = await f.service.releaseIntegrationEvidence({ projectRoot: f.root,
      tasks: [{ taskId: TASK_ID, taskRevision: p.taskBoard.task(TASK_ID).revision, projectRoot: f.root,
        branch: f.taskWorkspace.branch, resultCommit: f.task }] });
    const projection = await releaseTaskNetProjections({ tasks: evidence.tasks, baseCommit: f.published,
      git: (a, o) => runTaskGitCommand(a, { ...o, cwd: f.root }) });
    assert.equal(projection.get(TASK_ID).commit, f.publishedResolution.commit);
  }
});

for (const withPublished of [false, true]) test(`ordinary ${withPublished ? "published resolution " : ""}post-CAS ambiguity preserves private bytes and recovers the same original operation`, {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t, { ordinary: true });
  const p = await publicFixture(f);
  if (withPublished) p.args.selected_published_resolution = (await publishedFixture(f)).input;
  const preview = await p.mcp.call("hub_task_status_update", { ...p.args, request_id: "private-preview" });
  let casCount = 0;
  f.service.runCommand = async (args, options) => {
    const result = await runTaskGitCommand(args, options);
    if (args[0] === "update-ref" && args[1] === "refs/heads/dev") {
      casCount += 1;
      await writeFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "private ignored\n", { flag: "wx" });
    }
    return result;
  };
  const confirmArgs = { ...p.args, request_id: "private-confirm", selected_preview_request_id: "private-preview",
    expected_selected_preview_hash: preview.previewHash };
  await assert.rejects(p.mcp.call("hub_task_status_update", confirmArgs), /unknown/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(p.taskBoard.task(TASK_ID).workflowStatus, "in_progress");
  assert.equal(p.catalog.mcpOperation("private-confirm").status, "unknown");
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "utf8"), "private ignored\n");
  const args = { ...confirmArgs, request_id: "private-reconcile-blocked",
    operation_request_id: "private-confirm", project_root: f.root, confirm_reconcile: true };
  if (withPublished) {
    for (const [name, changed] of [["missing", null], ["altered", {
      ...p.args.selected_published_resolution, resolutionCommit: f.task }]]) {
      await assert.rejects(p.mcp.call("hub_task_operation_reconcile", { ...args,
        request_id: `private-reconcile-${name}`, selected_published_resolution: changed }),
      /identity|arguments|hash|match/u);
      assert.equal(casCount, 1);
      assert.equal(p.taskBoard.task(TASK_ID).workflowStatus, "in_progress");
    }
  }
  const blocked = await p.mcp.call("hub_task_operation_reconcile", args);
  assert.equal(blocked.outcome, "unknown");
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "utf8"), "private ignored\n");
  p.close();
  // Remove only the test-created private collision to exercise supported resume.
  await unlink(path.join(f.devWorkspace.projectRoot, "feature.txt"));
  f.service.runCommand = runTaskGitCommand;
  const reopened = await publicFixture(f);
  const settled = await reopened.mcp.call("hub_task_operation_reconcile", { ...args,
    request_id: "private-reconcile-resume", context_token: reopened.args.context_token });
  assert.equal(settled.outcome, "succeeded");
  assert.equal(reopened.catalog.mcpOperation("private-confirm").status, "succeeded");
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  assert.equal(casCount, 1);
  assert.equal(await git(f.taskWorkspace.projectRoot, "rev-parse", "HEAD"), f.task);
});

async function lifecycleFixture(f) {
  const databaseFile = path.join(path.dirname(f.root), "task-board.sqlite");
  const catalog = new WorkspaceCatalogStore({ databaseFile });
  await catalog.load();
  const store = new TaskBoardStore({ databaseFile, idFactory: () => TASK_ID });
  const workspace = await catalog.runMutation(() => catalog.createWorkspace({
    name: "Selected composition", settings: { workingDirectory: f.root,
      releaseWorkflowEnabled: true },
  }));
  const workspaceCatalog = { workspace: () => workspace, stream: () => null,
    hierarchy: () => [workspace] };
  const taskBoard = new TaskBoardService({ store, workspaceCatalog });
  store.create({ text: "Selected release Task", bucket: "workspace", workspaceId: workspace.id });
  store.setWorkflowStatus(TASK_ID, "in_progress");
  const revision = taskBoard.task(TASK_ID).revision;
  const lifecycle = new TaskLifecycleService({ taskBoard, workspaceCatalog,
    taskGitWorkspaces: f.service,
    releasePreflight: { withAwaitTransition: (_id, action) => action() },
  });
  const input = { taskId: TASK_ID, expectedTaskRevision: revision, projectRoot: f.root,
    bundlePath: f.bundle, bundleSha256: f.bundleSha256, proofCommit: f.proof,
    authority: { workspaceId: workspace.id, streamId: "rm", provider: "codex",
      threadId: "thread", proofRequestId: "selected-preview" },
  };
  return { taskBoard, lifecycle, input, close: () => { store.close(); catalog.close(); } };
}

test("selected owner preview has no live effect; late ignored collision preserves bytes and original op recovers", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const authority = { workspaceId: "workspace", streamId: "rm", provider: "codex",
    threadId: "thread", proofRequestId: "preview-1" };
  const preview = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.previewSelectedCompositionOwned({
      taskId: TASK_ID, projectRoot: f.root, proofCommit: f.proof,
      bundlePath: f.bundle, bundleSha256: f.bundleSha256,
      expectedTaskRevision: 1, authority, lease,
    })
  ));
  assert.equal(preview.proofTree, f.tree);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  assert.equal(await git(f.root, "rev-parse", "main"), f.local);
  let inject = true;
  f.service.runCommand = async (args, options) => {
    const result = await runTaskGitCommand(args, options);
    if (inject && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
      inject = false;
      await writeFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "private ignored\n", { flag: "wx" });
    }
    return result;
  };
  await assert.rejects(f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId: "confirm-1", lease })
  )), /EEXIST|foreign bytes/u);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "utf8"),
    "private ignored\n");
  const pending = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.readSelectedCompositionOwned(preview, { operationId: "confirm-1", lease })
  ));
  assert.equal(pending.status, "after_cas");
  await unlink(path.join(f.devWorkspace.projectRoot, "feature.txt"));
  const completed = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId: "confirm-1", lease })
  ));
  assert.equal(completed.status, "applied");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "unselected.txt"), "utf8"),
    "unselected\n");
  assert.equal(await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId: "confirm-1", lease })
  )).then((value) => value.status), "applied");
  const evidence = await f.service.releaseIntegrationEvidence({ projectRoot: f.root,
    tasks: [{ taskId: TASK_ID, taskRevision: 2, projectRoot: f.root,
      branch: f.taskWorkspace.branch, resultCommit: f.task }],
  });
  assert.equal(evidence.tasks[0].selectedComposition.previewHash, preview.previewHash);
  const projections = await releaseTaskNetProjections({ tasks: evidence.tasks,
    baseCommit: f.published,
    git: (args, options) => runTaskGitCommand(args, { ...options, cwd: f.root }),
  });
  const selected = projections.get(TASK_ID);
  assert.equal(selected.parent, f.published);
  assert.equal(selected.commit, f.task);
  assert.ok(selected.paths.includes("feature.txt"));
  assert.ok(!selected.paths.includes("unselected.txt"));
  const candidate = path.join(path.dirname(f.root), "selected-release-candidate");
  await git(path.dirname(f.root), "clone", "--quiet", "--no-checkout", f.root, candidate);
  await git(candidate, "checkout", "--quiet", "--detach", f.published);
  const patch = await runTaskGitCommand(["diff", "--binary", "--full-index",
    selected.parent, selected.commit, "--", ".", ":(exclude,glob)**/CHANGELOG.md",
    ":(exclude)CHANGELOG.md"], { cwd: candidate, rawOutput: true });
  await runTaskGitCommand(["apply", "--index", "--whitespace=nowarn", "-"], {
    cwd: candidate, input: patch,
  });
  assert.equal((await readFile(path.join(candidate, "feature.txt"), "utf8"))
    .replace(/\r\n/gu, "\n"), "selected feature\n");
  await assert.rejects(readFile(path.join(candidate, "unselected.txt")), { code: "ENOENT" });
});

test("one selected operation recovers crashes before journal and completion publication", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const preview = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.previewSelectedCompositionOwned({ taskId: TASK_ID, projectRoot: f.root,
      proofCommit: f.proof, bundlePath: f.bundle, bundleSha256: f.bundleSha256,
      expectedTaskRevision: 1, authority: { workspaceId: "workspace", streamId: "rm",
        provider: "codex", threadId: "thread", proofRequestId: "preview-crash" }, lease })
  ));
  const operationId = "confirm-crash";
  const root = path.join(f.dataDir, "task-selected-compositions", TASK_ID,
    path.basename(f.taskWorkspace.projectRoot), operationId);
  const journal = path.join(root, "materialization");
  await mkdir(journal, { recursive: true });
  await writeFile(path.join(root, "intent.json.tmp-00000000-0000-4000-8000-000000000000"), "{partial");
  await writeFile(path.join(journal, "new-0"), "partial staged bytes");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  const applied = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId, lease })
  ));
  assert.equal(applied.status, "applied");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  // Simulate a process ending after all exact Git effects but before the
  // atomic completed.json link becomes visible. A partial temp is not proof.
  await unlink(path.join(root, "completed.json"));
  await writeFile(path.join(root,
    "completed.json.tmp-00000000-0000-4000-8000-000000000000"), "{partial");
  const pending = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.readSelectedCompositionOwned(preview, { operationId, lease })
  ));
  assert.equal(pending.status, "after_cas");
  const recovered = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId, lease })
  ));
  assert.equal(recovered.status, "applied");
  assert.equal(recovered.receipt.operationId, operationId);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
});

test("selected composition enters Test only after exact Git CAS and durable Task result", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const { taskBoard, lifecycle, input, close } = await lifecycleFixture(f);
  const preview = await lifecycle.selectedComposition({ ...input, operationId: "selected-preview" });
  assert.equal(preview.confirmationRequired, true);
  assert.equal(taskBoard.task(TASK_ID).workflowStatus, "in_progress");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  const confirmed = await lifecycle.selectedComposition({ ...input, operationId: "selected-confirm",
    expectedPreviewHash: preview.previewHash });
  assert.equal(confirmed.task.workflowStatus, "testing");
  assert.equal(confirmed.task.gitReferences[0].resultCommit, f.task);
  assert.equal(confirmed.gitReceipt.devCommit, f.proof);
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  close();
});

test("interrupted selected Test retains pending lifecycle and reconciles the same operation", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const { taskBoard, lifecycle, input, close } = await lifecycleFixture(f);
  const preview = await lifecycle.selectedComposition({ ...input, operationId: "selected-preview" });
  let inject = true;
  f.service.runCommand = async (args, options) => {
    const result = await runTaskGitCommand(args, options);
    if (inject && args[0] === "update-ref" && args[1] === "refs/heads/dev") {
      inject = false;
      await writeFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "late private\n", { flag: "wx" });
    }
    return result;
  };
  await assert.rejects(lifecycle.selectedComposition({ ...input, operationId: "selected-confirm",
    expectedPreviewHash: preview.previewHash }), { code: "TASK_SELECTED_COMPOSITION_UNKNOWN" });
  assert.equal(taskBoard.task(TASK_ID).workflowStatus, "in_progress");
  assert.equal(taskBoard.lifecycleTransition("selected-confirm").phase, "pending_git");
  assert.equal(await git(f.root, "rev-parse", "dev"), f.proof);
  assert.equal(await readFile(path.join(f.devWorkspace.projectRoot, "feature.txt"), "utf8"),
    "late private\n");
  await unlink(path.join(f.devWorkspace.projectRoot, "feature.txt"));
  const recovered = await f.service.withTaskRecoveryLock(TASK_ID, (taskLease) => (
    f.service.withTaskRepositoryRecoveryLock(TASK_ID, f.root, taskLease, (lease) => (
      lifecycle.reconcileUnknownWorkflowStatusOwned({ taskId: TASK_ID,
        operationId: "selected-confirm", projectRoot: f.root, guardId: null, lease })
    ))
  ));
  assert.equal(recovered.result.task.workflowStatus, "testing");
  assert.equal(recovered.result.task.gitReferences[0].resultCommit, f.task);
  assert.equal(taskBoard.lifecycleTransition("selected-confirm"), null);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  close();
});

test("publication generation drift before CAS leaves dev and Task result untouched", {
  timeout: 90_000,
}, async (t) => {
  const f = await fixture(t);
  const preview = await f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.previewSelectedCompositionOwned({ taskId: TASK_ID, projectRoot: f.root,
      proofCommit: f.proof, bundlePath: f.bundle, bundleSha256: f.bundleSha256,
      expectedTaskRevision: 1, authority: { workspaceId: "workspace", streamId: "rm",
        provider: "codex", threadId: "thread", proofRequestId: "preview-drift" }, lease })
  ));
  f.service.readPublication = async () => ({ generation: "generation-2",
    repositories: [{ root: f.root, revision: f.published }] });
  await assert.rejects(f.service.withTaskLock(TASK_ID, (lease) => (
    f.service.applySelectedCompositionOwned(preview, { operationId: "confirm-drift", lease })
  )), { code: "SELECTED_COMPOSITION_NO_EFFECT" });
  assert.equal(await git(f.root, "rev-parse", "dev"), f.dev);
  assert.equal(await git(f.devWorkspace.projectRoot, "status", "--porcelain"), "");
  assert.equal(await git(f.root, "for-each-ref", "--format=%(refname)",
    "refs/agent-hub/task-results/"), "");
});
