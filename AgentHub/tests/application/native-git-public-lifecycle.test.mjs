import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { HubMcpService } from "../../src/application/hub-mcp-service.mjs";
import { TaskBoardService } from "../../src/application/task-board-service.mjs";
import { TaskLifecycleService } from "../../src/application/task-lifecycle-service.mjs";
import { TaskReleasePlanService } from "../../src/application/task-release-plan-service.mjs";
import { WorkspaceReleasePreflightService } from "../../src/application/workspace-release-preflight-service.mjs";
import { TaskBoardStore } from "../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskGitWorkspaceService } from "../../src/infrastructure/filesystem/task-git-workspace.mjs";
import { ReleaseGitWorkspaceService } from "../../src/infrastructure/filesystem/release-git-workspace.mjs";
import { ReleaseOperationService } from "../../src/application/release-operation-service.mjs";
import { WorkspaceReleaseOperationAdapter } from "../../src/application/workspace-release-operation-adapter.mjs";
import { ReleaseOperationStore } from "../../src/infrastructure/persistence/release-operation-store.mjs";
import { ReleaseOperationCommandService } from "../../src/application/release-operation-command-service.mjs";
import { createNativeMergeReviewVerifier } from "../../src/application/native-merge-review.mjs";
import { e2eFailureArtifactDirectory } from "../../e2e/telegram-harness.mjs";

const exec = promisify(execFile);
async function git(cwd, ...args) {
  return String((await exec("git", args, { cwd, windowsHide: true })).stdout).trim();
}
async function commit(root, message) {
  await git(root, "add", ".");
  return git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "-m", message);
}
async function fixture(t, { releaseMetadata = false, compatibilityFiles = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-native-public-"));
  const primary = path.join(root, "primary"), origin = path.join(root, "origin.git");
  await mkdir(primary);
  await git(primary, "init", "--initial-branch=main");
  await writeFile(path.join(primary, "shared.txt"), "main\n");
  if (compatibilityFiles) for (const file of ["test-one.js", "test-two.js"]) {
    await writeFile(path.join(primary, file), "// header\n\n// middle\n\n// footer\n");
  }
  if (releaseMetadata) {
    await mkdir(path.join(primary, "AgentHub"));
    const pkg = { name: "agent-hub", version: "2026.9.25", type: "module" };
    await writeFile(path.join(primary, "AgentHub", "package.json"), JSON.stringify(pkg));
    await writeFile(path.join(primary, "AgentHub", "package-lock.json"), JSON.stringify({
      ...pkg, lockfileVersion: 3, packages: { "": pkg },
    }));
  }
  await commit(primary, "main");
  const base = await git(primary, "rev-parse", "HEAD");
  await git(root, "init", "--bare", "--initial-branch=main", origin);
  await git(primary, "remote", "add", "origin", origin);
  await git(primary, "push", "origin", "main");
  const databaseFile = path.join(root, "hub.sqlite"), dataDir = path.join(root, "data");
  let catalog, store, board, taskGit, releaseGit, preflight, lifecycle, service, token;
  let releaseStore, releaseOperations;
  const ownedReleases = [];
  const retainRelease = (owner, store, operationId) => {
    if (!ownedReleases.some(item => item.owner === owner && item.operationId === operationId)) {
      ownedReleases.push({ owner, store, operationId });
    }
  };
  const joinReleases = async () => {
    if (!ownedReleases.length) return;
    // Preserve bounded original identities before a cancelled case can close
    // the stores beneath its already admitted release work.
    try {
      const observations = ownedReleases.map(item => {
        try {
          const current = item.store.get(item.operationId);
          return { operationId: item.operationId, state: current?.state,
            step: current?.step, generation: current?.currentGeneration,
            owner: current?.owner ? { processId: current.owner.processId, epoch: current.owner.epoch } : null };
        } catch (error) { return { operationId: item.operationId, readError: error?.code ?? error?.name }; }
      });
      const directory = e2eFailureArtifactDirectory(path.resolve(import.meta.dirname, "../.."), root);
      await mkdir(directory, { recursive: true });
      const file = path.join(directory, "native-public-release-drain.json");
      await writeFile(file, JSON.stringify({ stage: "join-owned-releases-before-store-close",
        observedAt: new Date().toISOString(), observations }), "utf8");
      t.diagnostic(`Preserved native public release identities: ${file}`);
    } catch { /* optional diagnostics never change the original outcome */ }
    for (const item of ownedReleases) await item.owner.drain(item.operationId);
  };
  let workspace, stream;
  const publication = { generation: "fixture", repositories: [{ root: primary, revision: base }] };
  const open = async () => {
    catalog = new WorkspaceCatalogStore({ databaseFile }); await catalog.load();
    store = new TaskBoardStore({ databaseFile });
    if (!workspace) {
      workspace = await catalog.runMutation(() => catalog.createWorkspace({ name: "Native", settings: {
        workingDirectory: primary, releaseWorkflowEnabled: true, taskPrefix: "NAT",
      } }));
      stream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id,
        name: "RM", settings: { releaseManager: true, workingDirectory: primary } }));
      await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "fixture-thread", streamId: stream.id }));
    }
    board = new TaskBoardService({ store, workspaceCatalog: catalog });
    const verifyNativeResolutionReview = createNativeMergeReviewVerifier({ workspaceCatalog: catalog, taskBoard: board });
    taskGit = new TaskGitWorkspaceService({ dataDir, readPublication: async () => publication, recordTiming: () => {}, verifyNativeResolutionReview });
    releaseGit = new ReleaseGitWorkspaceService({ dataDir, verifyNativeResolutionReview });
    preflight = new WorkspaceReleasePreflightService({
      releasePlanner: new TaskReleasePlanService({ taskBoard: board, taskGitWorkspaces: taskGit }),
      taskGitWorkspaces: taskGit, releaseGitWorkspaces: releaseGit,
      readPublicationState: async () => publication,
      resolveReleaseValidationSource: () => assert.fail("Await must not refresh a shared Contour"),
      validateProductionCandidate: () => assert.fail("Await must not publish or run broad validation"),
    });
    lifecycle = new TaskLifecycleService({ taskBoard: board, workspaceCatalog: catalog, taskGitWorkspaces: taskGit, releasePreflight: preflight });
    await mkdir(path.join(root, "release-operations"), { recursive: true });
    releaseStore = new ReleaseOperationStore({ dataDir: path.join(root, "release-operations") });
    const adapter = new WorkspaceReleaseOperationAdapter({ releasePreflight: preflight,
      publication: { publish: () => assert.fail("Fixture never publishes"), readback: () => assert.fail("Fixture never reads production") },
      finalization: { finalize: () => assert.fail("Fixture never finalizes publication") } });
    releaseOperations = new ReleaseOperationService({ store: releaseStore,
      processAlive: pid => pid === process.pid, compose: input => adapter.compose(input),
      validate: async () => { throw Object.assign(new Error("Fixture stops at validation boundary"), { code: "RELEASE_VALIDATION_FAILED" }); },
      publishTarget: input => adapter.publishTarget(input), readTarget: input => adapter.readTarget(input),
      finalize: input => adapter.finalize(input) });
    service = new HubMcpService({ workspaceCatalog: catalog, taskBoard: board, workLog: { threadTurns: () => [] },
      taskGitWorkspaces: taskGit, taskLifecycle: lifecycle, releasePreflight: preflight,
      releaseOperations,
      releaseCompleter: { completeRelease: () => assert.fail("No publication") },
      attachmentDirectory: path.join(root, "attachments"), secret: "synthetic-native-fixture", reconcilePendingOnStartup: false });
    service.setStreamMessenger(async () => ({ accepted: true, pending: false, deliveryId: "synthetic-handoff" }));
    token = service.contextToken({ provider: "codex", threadId: "fixture-thread" });
  };
  await open();
  t.after(async () => { await joinReleases(); store.close(); catalog.close(); await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return {
    root, primary, base, workspace,
    get board() { return board; }, get taskGit() { return taskGit; }, get lifecycle() { return lifecycle; }, get catalog() { return catalog; },
    get preflight() { return preflight; },
    async continueRelease(operationId) {
      retainRelease(releaseOperations, releaseStore, operationId);
      await service.call("hub_release_continue", { context_token: token, operation_id: operationId, request_id: "prepared-release-continue" });
      return releaseOperations.drain(operationId);
    },
    get publication() { return publication; },
    get releaseGit() { return releaseGit; },
    get store() { return store; },
    get dataDir() { return dataDir; },
    async reviewResolution(binding, requestId) {
      let reviewer = catalog.hierarchy().flatMap(w => w.streams ?? []).find(s => s.name === "Reviewer");
      if (!reviewer) {
        reviewer = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id,
          name: "Reviewer", settings: { model: "gpt-6.1-sol" } }));
        await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: "reviewer-thread", streamId: reviewer.id }));
      }
      const text = `<native-merge-review>${JSON.stringify({ kind: "native-merge-review-v1", verdict: "ACCEPT", binding })}</native-merge-review>`;
      await service.call("hub_stream_message_send", {
        context_token: service.contextToken({ provider: "codex", threadId: "reviewer-thread" }),
        request_id: requestId, stream_id: stream.id, text, mode: "queue", confirm_send: true,
      });
      return { requestId, text };
    },
    async absorption({ priorSource = null, priorSurvivor = null } = {}) {
      const source = store.create({ text: "Saved source\n\nOriginal requirements and unfinished regression", bucket: "workspace", workspaceId: workspace.id });
      const survivor = store.create({ text: "Survivor\n\nCombined requirements", bucket: "workspace", workspaceId: workspace.id });
      board.assignWorkspaceTaskNumbers(workspace.id);
      const sourceStream = await catalog.runMutation(() => catalog.createStream({ workspaceId: workspace.id,
        name: "Source", settings: { workingDirectory: primary } }));
      const sourceThread = `source-${source.id}`;
      await catalog.runMutation(() => catalog.bindThread({ provider: "codex", threadId: sourceThread, streamId: sourceStream.id }));
      await board.claim({ id: source.id, workspaceId: workspace.id, streamId: sourceStream.id,
        provider: "codex", threadId: sourceThread, turnId: "saved-turn", operationId: `source-claim-${source.id}` });
      await board.claim({ id: survivor.id, workspaceId: workspace.id, streamId: stream.id,
        provider: "codex", threadId: "fixture-thread", turnId: "survivor-turn", operationId: `survivor-claim-${survivor.id}` });
      store.updatePresentation(survivor.id, { title: "Survivor", description: `Combined requirements\n\n${board.task(source.id).description}` });
      await board.updateChecklist({ id: survivor.id, operation: "add", text: "Complete transferred requirements",
        expectedRevision: board.task(survivor.id).revision, requestId: "transfer-add" });
      const item = board.task(survivor.id).checklist[0];
      await board.updateChecklist({ id: survivor.id, operation: "link", itemId: item.id, linkedTaskId: source.id,
        expectedRevision: board.task(survivor.id).revision, requestId: "transfer-link" });
      const sourceWorkspace = await taskGit.prepare({ taskId: source.id, taskNumber: board.task(source.id).taskNumber, projectRoot: primary });
      const survivorWorkspace = await taskGit.prepare({ taskId: survivor.id, taskNumber: board.task(survivor.id).taskNumber, projectRoot: primary });
      source.root = sourceWorkspace.projectRoot; survivor.root = survivorWorkspace.projectRoot;
      await writeFile(path.join(source.root, "source.txt"), "saved source\n"); await commit(source.root, "saved source");
      await writeFile(path.join(survivor.root, "survivor.txt"), "survivor\n"); await commit(survivor.root, "survivor");
      const prior = [];
      for (const [task, priorStatus, threadId] of [[source, priorSource, sourceThread],
        [survivor, priorSurvivor, "fixture-thread"]]) {
        if (!priorStatus) continue;
        const context_token = service.contextToken({ provider: "codex", threadId });
        const status = async (target, request_id) => service.call("hub_task_status_update", {
          context_token, task_id: task.id, status: target, request_id,
          expected_task_revision: board.task(task.id).revision,
          expected_workflow_status: board.task(task.id).workflowStatus });
        const testId = `prior-test-${task.id}`, returnId = `prior-return-${task.id}`;
        assert.equal((await status("testing", testId)).workflowStatus, "testing");
        if (priorStatus === "await") assert.equal((await status("awaiting_implementation", `prior-await-${task.id}`))
          .workflowStatus, "awaiting_implementation");
        const refs = board.task(task.id).gitReferences;
        assert.equal((await status("in_progress", returnId)).workflowStatus, "in_progress");
        assert.deepEqual(board.task(task.id).gitReferences, refs);
        prior.push({ task, refs, testId, returnId, testOutcome: JSON.stringify(board.lifecycleOutcome(testId)),
          returnOutcome: JSON.stringify(board.lifecycleOutcome(returnId)) });
        await writeFile(path.join(task.root, task === source ? "source-correction.txt" : "survivor-correction.txt"),
          `${task === source ? "source" : "survivor"} correction\n`);
        await commit(task.root, "correction after normal return");
      }
      const sourceCommit = await git(source.root, "rev-parse", "HEAD");
      const survivorParentCommit = await git(survivor.root, "rev-parse", "HEAD");
      await git(survivor.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid",
        "merge", "--no-ff", "--no-edit", sourceCommit);
      const declaration = { version: 1, kind: "task-absorption-handoff-v1", workspaceId: workspace.id,
        sourceTaskId: source.id, sourceTaskRevision: board.task(source.id).revision, survivorTaskId: survivor.id,
        baseCommit: base, sourceCommit, sourceTree: await git(source.root, "rev-parse", "HEAD^{tree}"),
        survivorParentCommit, absorptionCommit: await git(survivor.root, "rev-parse", "HEAD"), saved: true, stopped: true };
      const handoff = async (requestId, delta = {}) => {
        const text = JSON.stringify({ ...declaration, ...delta });
        const sourceToken = service.contextToken({ provider: "codex", threadId: sourceThread });
        await service.call("hub_stream_message_send", { context_token: sourceToken, request_id: requestId,
          stream_id: stream.id, text, mode: "queue", confirm_send: true });
        return { requestId, text };
      };
      return { source, survivor, declaration, handoff, sourceStream, sourceThread, itemId: item.id, prior };
    },
    async closeCombined(source, survivor, prefix = "combined") {
      const args = { context_token: token, task_id: source.id, absorbed_into_task_id: survivor.id,
        request_id: `${prefix}-preview` };
      const preview = await service.call("hub_task_complete", args);
      assert.equal(preview.confirmationRequired, true);
      return service.call("hub_task_complete", { ...args, request_id: `${prefix}-confirm`,
        confirm_cleanup: true, expected_cleanup_token: preview.cleanupToken });
    },
    async release(task, originMain = base, requestId = "native-release-original", releaseMetadata = null) {
      const args = { context_token: token, request_id: requestId, task_ids: (Array.isArray(task) ? task : [task]).map(item => item.id),
        validation_mode: "focused", approved_targets: [{ targetId: "fixture", kind: "git", repositoryRoot: primary,
          approvedLocalMainCommit: base, approvedOriginMainCommit: originMain }] };
      const commands = new ReleaseOperationCommandService({ releaseOperations, workspaceCatalog: catalog, taskBoard: board });
      const admit = () => releaseMetadata ? commands.start({ requestId, workspaceId: workspace.id,
        streamId: stream.id, threadId: "fixture-thread", taskIds: args.task_ids, validationMode: args.validation_mode,
        approvedTargets: args.approved_targets, releaseMetadata }) : service.call("hub_release_run", args);
      const ack = await admit();
      retainRelease(releaseOperations, releaseStore, ack.operationId);
      const snapshot = await releaseOperations.drain(ack.operationId);
      const replay = await admit();
      assert.equal(replay.operationId, ack.operationId);
      const read = await service.call("hub_release_get", { context_token: token, operation_id: ack.operationId });
      assert.equal(read.operation.operationId, ack.operationId);
      return snapshot;
    },
    async reopen() { await joinReleases(); store.close(); catalog.close(); await open(); },
    async create(name) {
      const task = store.create({ text: name, bucket: "workspace", workspaceId: workspace.id });
      const prepared = await taskGit.prepare({ taskId: task.id, taskNumber: task.taskNumber, projectRoot: primary });
      return { id: task.id, root: prepared.projectRoot };
    },
    async status(task, status, request, overrides = {}) {
      const current = board.task(task.id);
      return service.call("hub_task_status_update", { context_token: token, request_id: request,
        task_id: task.id, status, expected_task_revision: current.revision,
        expected_workflow_status: current.workflowStatus, ...overrides });
    },
    async reconcile(task, request, original, revision, workflowStatus, overrides = {}) {
      return service.call("hub_task_operation_reconcile", { context_token: token, request_id: request,
        task_id: task.id, operation_request_id: original, project_root: primary,
        confirm_reconcile: true,
        expected_task_revision: revision, expected_workflow_status: workflowStatus, ...overrides });
    },
  };
}

for (const scenario of [
  { name: "survivor Test", priorSurvivor: "test" },
  { name: "source Await", priorSource: "await" },
  { name: "both Await and UNKNOWN reopen", priorSource: "await", priorSurvivor: "await", unknown: true },
]) {
  test(`public returned native absorption preserves ${scenario.name} prior results`, async t => {
    const f = await fixture(t), a = await f.absorption(scenario);
    const input = await a.handoff("returned-saved-stopped"), before = f.board.task(a.survivor.id);
    const sql = (query, method, ...args) => {
      const db = new DatabaseSync(path.join(f.root, "hub.sqlite"));
      try { return db.prepare(query)[method](...args); } finally { db.close(); }
    };
    const devBefore = await git(f.primary, "rev-parse", "dev");
    const foreign = a.prior[0].task === a.source ? a.declaration.survivorParentCommit : a.declaration.sourceCommit;
    sql("UPDATE hub_task_git_references SET result_commit = ? WHERE task_id = ?", "run", foreign, a.prior[0].task.id);
    await assert.rejects(f.status(a.survivor, "testing", "foreign-prior-test", { selected_absorption_handoff: input }),
      /prior result|normal return/u);
    sql("UPDATE hub_task_git_references SET result_commit = ? WHERE task_id = ?", "run",
      a.prior[0].refs[0].resultCommit, a.prior[0].task.id);
    assert.equal(await git(f.primary, "rev-parse", "dev"), devBefore);
    assert.equal(f.board.task(a.survivor.id).revision, before.revision);
    const original = "returned-absorption-test";
    if (scenario.unknown) {
      f.board.commitWorkflowTransition = () => { throw new Error("lost returned absorption terminal"); };
      await assert.rejects(f.status(a.survivor, "testing", original, { selected_absorption_handoff: input }));
      const dev = await git(f.primary, "rev-parse", "dev"), reflog = await git(f.primary, "reflog", "show", "--format=%H", "dev");
      assert.equal(f.catalog.mcpOperation(original).status, "unknown");
      await f.reopen();
      const row = sql("SELECT result_json FROM hub_task_lifecycle_outcomes WHERE operation_id = ?", "get", a.prior[0].returnId);
      const stale = JSON.parse(row.result_json); stale.evidence.acceptedResult.taskRevision--;
      sql("UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?", "run",
        JSON.stringify(stale), a.prior[0].returnId);
      const refused = await f.reconcile(a.survivor, "stale-prior-reconcile", original, before.revision, "in_progress", {
        selected_absorption_handoff: input });
      assert.equal(refused.outcome, "unknown");
      assert.equal(f.board.lifecycleOutcome(original), null);
      assert.deepEqual(f.board.task(a.survivor.id).gitReferences, before.gitReferences);
      sql("UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?", "run", row.result_json, a.prior[0].returnId);
      const testRow = sql("SELECT result_json FROM hub_task_lifecycle_outcomes WHERE operation_id = ?", "get", a.prior[0].testId);
      const foreignTest = JSON.parse(testRow.result_json); foreignTest.evidence.devHeadCommit = f.base;
      sql("UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?", "run", JSON.stringify(foreignTest), a.prior[0].testId);
      assert.equal((await f.reconcile(a.survivor, "foreign-test-prior-reconcile", original, before.revision, "in_progress", {
        selected_absorption_handoff: input })).outcome, "unknown");
      sql("UPDATE hub_task_lifecycle_outcomes SET result_json = ? WHERE operation_id = ?", "run", testRow.result_json, a.prior[0].testId);
      const resumed = await f.reconcile(a.survivor, "restored-prior-reconcile", original, before.revision, "in_progress", {
        selected_absorption_handoff: input });
      assert.equal(resumed.outcome, "succeeded");
      assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
      assert.equal(await git(f.primary, "reflog", "show", "--format=%H", "dev"), reflog);
    } else assert.equal((await f.status(a.survivor, "testing", original, { selected_absorption_handoff: input })).workflowStatus, "testing");
    const proof = f.board.selectedCompositionForRelease({ taskId: a.survivor.id, projectRoot: f.primary,
      resultCommit: a.declaration.absorptionCommit }).selectedComposition;
    assert.equal(proof.operationId, original);
    assert.equal(proof.absorptionInput.priorResults.length, a.prior.length);
    for (const prior of a.prior) {
      const binding = proof.absorptionInput.priorResults.find(entry => entry.taskId === prior.task.id);
      assert.equal(binding.resultCommit, prior.refs[0].resultCommit);
      assert.equal(binding.testOperationId, prior.testId); assert.equal(binding.returnOperationId, prior.returnId);
      assert.equal(JSON.stringify(f.board.lifecycleOutcome(prior.testId)), prior.testOutcome);
      assert.equal(JSON.stringify(f.board.lifecycleOutcome(prior.returnId)), prior.returnOutcome);
    }
    assert.equal((await f.status(a.survivor, "awaiting_implementation", "returned-absorption-await")).workflowStatus, "awaiting_implementation");
    const candidate = (await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id })).releaseCandidates[0];
    assert.equal(candidate.manifest.tasks.find(task => task.taskId === a.survivor.id).selectedComposition.descriptorHash, proof.descriptorHash);
    assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:source.txt"), "saved source");
    assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:survivor.txt"), "survivor");
    for (const prior of a.prior) assert.equal(await git(candidate.releaseRoot, "show",
      `PreRelease:${prior.task === a.source ? "source" : "survivor"}-correction.txt`),
    `${prior.task === a.source ? "source" : "survivor"} correction`);
    const sourcePrior = a.prior.find(prior => prior.task === a.source);
    if (sourcePrior) {
      sql("UPDATE hub_task_git_references SET result_commit = ? WHERE task_id = ?", "run", f.base, a.source.id);
      await assert.rejects(f.closeCombined(a.source, a.survivor, "foreign-closure"), /prior source result/u);
      assert.equal(f.board.task(a.source.id).status, "started");
      sql("UPDATE hub_task_git_references SET result_commit = ? WHERE task_id = ?", "run", sourcePrior.refs[0].resultCommit, a.source.id);
    }
    assert.equal((await f.closeCombined(a.source, a.survivor)).status, "done");
    if (sourcePrior) assert.deepEqual(f.board.task(a.source.id).gitReferences, sourcePrior.refs);
    for (const prior of a.prior) {
      assert.equal(JSON.stringify(f.board.lifecycleOutcome(prior.testId)), prior.testOutcome);
      assert.equal(JSON.stringify(f.board.lifecycleOutcome(prior.returnId)), prior.returnOutcome);
    }
  });
}

test("public fresh native absorption binds authenticated handoff through Test Await and combined closure", async t => {
  const f = await fixture(t, { releaseMetadata: true }), { source, survivor, handoff, declaration, itemId } = await f.absorption();
  const input = await handoff("saved-stopped");
  await assert.rejects(f.status(survivor, "testing", "missing-handoff"), { code: "RELEASE_NATIVE_HISTORY_REQUIRED" });
  assert.equal(await git(f.primary, "rev-parse", "dev"), f.base);
  await assert.rejects(f.status(survivor, "testing", "changed-handoff", {
    selected_absorption_handoff: { ...input, text: JSON.stringify({ ...declaration, sourceCommit: f.base }) },
  }), /binding changed/u);
  const wrongParents = await handoff("wrong-parents", { survivorParentCommit: f.base });
  await assert.rejects(f.status(survivor, "testing", "wrong-parent-test", { selected_absorption_handoff: wrongParents }),
    /absorbed history differs/u);
  const wrongSource = await handoff("wrong-source", { sourceCommit: f.base });
  await assert.rejects(f.status(survivor, "testing", "wrong-source-test", { selected_absorption_handoff: wrongSource }),
    /source HEAD\/base\/branch/u);
  const stale = await handoff("stale-source", { sourceTaskRevision: declaration.sourceTaskRevision + 1 });
  await assert.rejects(f.status(survivor, "testing", "stale-source-test", { selected_absorption_handoff: stale }),
    /current Task state changed/u);
  const transferredDescription = f.board.task(survivor.id).description;
  f.store.updatePresentation(survivor.id, { title: "Survivor", description: "Transfer omitted" });
  await assert.rejects(f.status(survivor, "testing", "missing-transfer-test", { selected_absorption_handoff: input }),
    /current Task state changed/u);
  f.store.updatePresentation(survivor.id, { title: "Survivor", description: transferredDescription });
  const before = f.board.task(survivor.id);
  await writeFile(path.join(source.root, "source.txt"), "resumed source\n");
  await assert.rejects(f.status(survivor, "testing", "dirty-source-test", { selected_absorption_handoff: input }),
    /saved cleanliness/u);
  assert.equal(await readFile(path.join(source.root, "source.txt"), "utf8"), "resumed source\n");
  await git(source.root, "restore", "source.txt");
  assert.equal(f.board.task(survivor.id).revision, before.revision);
  const tested = await f.status(survivor, "testing", "native-absorbed-test", { selected_absorption_handoff: input });
  assert.equal(tested.workflowStatus, "testing");
  const proof = f.board.selectedCompositionForRelease({ taskId: survivor.id, projectRoot: f.primary,
    resultCommit: declaration.absorptionCommit });
  assert.equal(proof.selectedCompositionRequired, true);
  assert.equal(proof.selectedComposition.kind, "native-task-integration-v1");
  assert.equal(proof.selectedComposition.operationId, "native-absorbed-test");
  assert.equal(proof.selectedComposition.absorptionInput.requestId, input.requestId);
  assert.equal(proof.selectedComposition.expectedTaskRevision, before.revision);
  const accepted = await f.status(survivor, "awaiting_implementation", "native-absorbed-await");
  assert.equal(accepted.workflowStatus, "awaiting_implementation");
  assert.equal(accepted.releaseCandidate.status, "prepared", accepted.releaseCandidate.reason);
  const candidate = (await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id })).releaseCandidates[0];
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:source.txt"), "saved source");
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:survivor.txt"), "survivor");
  assert.equal(candidate.manifest.tasks[0].selectedComposition.descriptorHash, proof.selectedComposition.descriptorHash);
  assert.equal((await f.closeCombined(source, survivor)).status, "done");
  assert.equal(f.board.task(survivor.id).checklist.find(item => item.id === itemId).completed, true);
  assert.equal(await git(source.root, "rev-parse", "HEAD"), declaration.sourceCommit);
  assert.equal(await git(survivor.root, "rev-parse", "HEAD"), declaration.absorptionCommit);
  const originalDescriptor = JSON.stringify(proof.selectedComposition);
  assert.equal((await f.status(survivor, "in_progress", "native-absorbed-return")).workflowStatus, "in_progress");
  await writeFile(path.join(survivor.root, "survivor.txt"), "corrected survivor\n");
  assert.equal((await f.status(survivor, "testing", "native-absorbed-correction")).workflowStatus, "testing");
  const correctedResult = f.board.task(survivor.id).gitReferences[0].resultCommit;
  const correctedProof = f.board.selectedCompositionForRelease({ taskId: survivor.id, projectRoot: f.primary,
    resultCommit: correctedResult });
  assert.equal(correctedProof.selectedComposition.absorptionHistory.descriptorHash, proof.selectedComposition.descriptorHash);
  assert.equal(JSON.stringify(f.board.selectedCompositionForRelease({ taskId: survivor.id, projectRoot: f.primary,
    resultCommit: declaration.absorptionCommit }).selectedComposition), originalDescriptor);
  assert.equal((await f.status(survivor, "testing", "native-absorbed-reused-test")).workflowStatus, "testing");
  const correctedAwait = await f.status(survivor, "awaiting_implementation", "native-absorbed-corrected-await");
  assert.equal(correctedAwait.workflowStatus, "awaiting_implementation");
  assert.equal(correctedAwait.releaseCandidate.status, "prepared", correctedAwait.releaseCandidate.reason);
  const correctedCandidate = (await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id })).releaseCandidates[0];
  assert.equal(await git(correctedCandidate.releaseRoot, "show", "PreRelease:survivor.txt"), "corrected survivor");
  assert.equal(await git(correctedCandidate.releaseRoot, "show", "PreRelease:source.txt"), "saved source");
  assert.equal(f.board.task(source.id).status, "done");
  const frozen = await f.release(survivor);
  assert.equal(frozen.operation.state, "waiting", JSON.stringify(frozen.operation.lastError));
  assert.equal(frozen.generations.length, 1);
  assert.equal(frozen.generations[0].selectedResults[0].selectedComposition.descriptorHash,
    correctedProof.selectedComposition.descriptorHash);
  assert.equal(frozen.generations[0].candidates[0].manifest.tasks[0].selectedComposition.absorptionHistory.descriptorHash,
    proof.selectedComposition.descriptorHash);
});

test("public native absorption lost terminal reopens same original and refuses live source drift", { timeout: 240_000 }, async t => {
  const f = await fixture(t), { source, survivor, handoff, declaration } = await f.absorption();
  const input = await handoff("saved-stopped"), before = f.board.task(survivor.id);
  const original = "native-absorption-lost-terminal", terminal = f.board.commitWorkflowTransition.bind(f.board);
  f.board.commitWorkflowTransition = () => { throw new Error("lost absorbed terminal write"); };
  await assert.rejects(f.status(survivor, "testing", original, { selected_absorption_handoff: input }));
  assert.equal(f.catalog.mcpOperation(original).status, "unknown");
  assert.equal(f.board.lifecycleTransition(original).phase, "pending_git");
  const dev = await git(f.primary, "rev-parse", "dev");
  const reflog = await git(f.primary, "reflog", "show", "--format=%H", "dev");
  f.board.commitWorkflowTransition = terminal;
  await writeFile(path.join(source.root, "source.txt"), "resumed private work\n");
  await f.reopen();
  await assert.rejects(f.reconcile(survivor, "wrong-original-input", original, before.revision, "in_progress", {
    selected_absorption_handoff: { ...input, requestId: "different-original" },
  }), /identity|state|CAS/u);
  const refused = await f.reconcile(survivor, "dirty-reconcile", original, before.revision, "in_progress", {
    selected_absorption_handoff: input,
  });
  assert.equal(refused.outcome, "unknown");
  assert.equal(f.catalog.mcpOperation(original).status, "unknown");
  assert.equal(f.board.task(survivor.id).workflowStatus, "in_progress");
  assert.equal(await readFile(path.join(source.root, "source.txt"), "utf8"), "resumed private work\n");
  await git(source.root, "restore", "source.txt");
  const sourceBranch = await git(source.root, "symbolic-ref", "--short", "HEAD");
  const sourceBaseRef = await git(f.primary, "for-each-ref", "--format=%(refname)",
    `refs/agent-hub/task-bases/${source.id}`);
  assert.equal(sourceBaseRef.split(/\r?\n/u).length, 1);
  const unknown = async request => {
    const value = await f.reconcile(survivor, request, original, before.revision, "in_progress", {
      selected_absorption_handoff: input,
    });
    assert.equal(value.outcome, "unknown");
    assert.equal(f.catalog.mcpOperation(original).status, "unknown");
    assert.equal(f.board.lifecycleTransition(original).phase, "pending_git");
    assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  };
  await writeFile(path.join(source.root, "source.txt"), "new committed source\n");
  await commit(source.root, "source reopened HEAD");
  await unknown("head-reconcile");
  await git(source.root, "reset", "--hard", declaration.sourceCommit);
  await git(f.primary, "update-ref", sourceBaseRef, declaration.sourceCommit, f.base);
  await unknown("base-reconcile");
  await git(f.primary, "update-ref", sourceBaseRef, f.base, declaration.sourceCommit);
  await git(source.root, "branch", "-m", "foreign-source-branch");
  await unknown("branch-reconcile");
  await git(source.root, "branch", "-m", sourceBranch);
  await writeFile(path.join(source.root, "resumed-private.txt"), "private untracked\n");
  await unknown("untracked-reconcile");
  assert.equal(await readFile(path.join(source.root, "resumed-private.txt"), "utf8"), "private untracked\n");
  await rm(path.join(source.root, "resumed-private.txt"));
  const restored = await f.reconcile(survivor, "restored-reconcile", original, before.revision, "in_progress", {
    selected_absorption_handoff: input,
  });
  assert.equal(restored.outcome, "succeeded");
  assert.equal(f.catalog.mcpOperation(original).status, "succeeded");
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  assert.equal(await git(f.primary, "reflog", "show", "--format=%H", "dev"), reflog);
  const proof = f.board.selectedCompositionForRelease({ taskId: survivor.id, projectRoot: f.primary,
    resultCommit: declaration.absorptionCommit });
  assert.equal(proof.selectedComposition.operationId, original);
  assert.equal((await f.status(survivor, "awaiting_implementation", "restored-await")).workflowStatus, "awaiting_implementation");
});

test("public native absorption refuses a reopened source executor at terminal Task CAS", { timeout: 180_000 }, async t => {
  const f = await fixture(t), { source, survivor, handoff, sourceStream, sourceThread } = await f.absorption();
  const input = await handoff("saved-stopped"), terminal = f.board.commitWorkflowTransition.bind(f.board);
  f.board.commitWorkflowTransition = async args => {
    await f.board.claim({ id: source.id, workspaceId: f.workspace.id, streamId: sourceStream.id,
      provider: "codex", threadId: sourceThread, turnId: "reopened-turn", operationId: "reopened-source" });
    return terminal(args);
  };
  await assert.rejects(f.status(survivor, "testing", "native-absorption-reopened", { selected_absorption_handoff: input }),
    { code: "TASK_NATIVE_INTEGRATION_UNKNOWN" });
  assert.equal(f.board.task(survivor.id).workflowStatus, "in_progress");
  assert.equal(f.board.lifecycleTransition("native-absorption-reopened").phase, "pending_git");
  assert.equal(f.board.lifecycleOutcome("native-absorption-reopened"), null);
  assert.equal(f.catalog.mcpOperation("native-absorption-reopened").status, "unknown");
  assert.equal(await readFile(path.join(source.root, "source.txt"), "utf8"), "saved source\n");
});

test("public real SQLite Test and Await merge exact full branches and exclude Test-only", { timeout: 180_000 }, async t => {
  const f = await fixture(t), a = await f.create("A"), b = await f.create("Test only");
  await assert.rejects(f.status(a, "testing", "closed-legacy-preview", { selected_proof_bundle_path: "unused.bundle" }),
    { code: "TASK_NATIVE_GIT_REQUIRED" });
  assert.equal(f.catalog.mcpOperation("closed-legacy-preview").status, "failed");
  assert.equal(f.board.lifecycleTransition("closed-legacy-preview"), null);
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
  await writeFile(path.join(a.root, "first.txt"), "first\n"); await commit(a.root, "first");
  await writeFile(path.join(a.root, "second.txt"), "second\n"); await commit(a.root, "second");
  const aResult = await git(a.root, "rev-parse", "HEAD");
  await writeFile(path.join(b.root, "excluded.txt"), "not selected\n");
  assert.equal((await f.status(a, "testing", "test-a")).workflowStatus, "testing");
  assert.equal((await f.status(b, "testing", "test-b")).workflowStatus, "testing");
  const accepted = await f.status(a, "awaiting_implementation", "await-a");
  assert.equal(accepted.workflowStatus, "awaiting_implementation");
  assert.equal(accepted.releaseCandidate.status, "prepared", accepted.releaseCandidate.reason);
  const candidate = (await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id })).releaseCandidates[0];
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:first.txt"), "first");
  assert.equal(await git(candidate.releaseRoot, "show", "PreRelease:second.txt"), "second");
  await assert.rejects(git(candidate.releaseRoot, "show", "PreRelease:excluded.txt"));
  assert.equal(await git(candidate.releaseRoot, "merge-base", "--is-ancestor", aResult, "PreRelease"), "");
  await writeFile(path.join(a.root, "first.txt"), "corrected\n");
  assert.equal((await f.status(a, "testing", "test-a-correction")).workflowStatus, "testing");
  const correctedSource = f.board.task(a.id).gitReferences[0].resultCommit;
  assert.notEqual(correctedSource, aResult);
  assert.equal((await f.status(a, "awaiting_implementation", "await-a-correction")).workflowStatus, "awaiting_implementation");
  const corrected = (await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id })).releaseCandidates[0];
  assert.equal(await git(corrected.releaseRoot, "show", "PreRelease:first.txt"), "corrected");
  assert.equal(await git(corrected.releaseRoot, "show", "PreRelease:second.txt"), "second");
  await assert.rejects(git(corrected.releaseRoot, "show", "PreRelease:excluded.txt"));
  assert.equal(await git(corrected.releaseRoot, "merge-base", "--is-ancestor", correctedSource, "PreRelease"), "");
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
});

test("public native conflict keeps dev and resumes the ordinary resolution commit", { timeout: 180_000 }, async t => {
  const f = await fixture(t), a = await f.create("A"), b = await f.create("B");
  await writeFile(path.join(a.root, "shared.txt"), "A\n"); await f.status(a, "testing", "test-a");
  const dev = await git(f.primary, "rev-parse", "dev");
  await writeFile(path.join(b.root, "shared.txt"), "B\n");
  let conflict;
  await assert.rejects(f.status(b, "testing", "test-b-conflict"), error => {
    assert.equal(error.code, "TASK_INTEGRATION_CONFLICT"); conflict = error.details; return true;
  });
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
  assert.equal(f.board.lifecycleTransition("test-b-conflict").phase, "failed");
  const source = await git(b.root, "rev-parse", "HEAD");
  assert.equal(await git(conflict.nativeConflictRoot, "rev-parse", "MERGE_HEAD"), source);
  await writeFile(path.join(conflict.nativeConflictRoot, "shared.txt"), "A+B\n");
  await commit(conflict.nativeConflictRoot, "resolve shared file");
  const resolution = await git(conflict.nativeConflictRoot, "rev-parse", "HEAD");
  assert.equal((await f.status(b, "testing", "test-b-resolved")).workflowStatus, "testing");
  assert.equal(await git(f.primary, "rev-parse", "dev"), resolution);
  assert.equal(await git(f.primary, "show", "dev:shared.txt"), "A+B");
});

test("public Test and Await accept only the exact reviewed automatic compatibility cleanup", async t => {
  const f = await fixture(t, { compatibilityFiles: true, releaseMetadata: true }), a = await f.create("A"), b = await f.create("B");
  for (const file of ["test-one.js", "test-two.js"]) {
    await writeFile(path.join(a.root, file), "// header\nfunction check() {}\n// middle\n\n// footer\n");
    await writeFile(path.join(b.root, file), "// header\n\n// middle\nfunction check() {}\n// footer\n");
  }
  await writeFile(path.join(a.root, "shared.txt"), "A\n");
  await f.status(a, "testing", "compat-test-a");
  await writeFile(path.join(b.root, "shared.txt"), "B\n");
  let stage;
  await assert.rejects(f.status(b, "testing", "compat-test-b-conflict"), error => {
    assert.equal(error.code, "TASK_INTEGRATION_CONFLICT"); stage = error.details.nativeConflictRoot; return true;
  });
  const cleanup = async root => {
    for (const file of ["test-one.js", "test-two.js"]) {
      assert.equal((await readFile(path.join(root, file), "utf8")).match(/function check/gu).length, 2);
      await writeFile(path.join(root, file), "// header\nfunction check() {}\n// middle\n\n// footer\n");
    }
    await writeFile(path.join(root, "shared.txt"), "A+B\n");
    await commit(root, "reviewable compatibility cleanup");
  };
  await cleanup(stage);
  const reviewedCommit = await git(stage, "rev-parse", "HEAD");
  const beforeDev = await git(f.primary, "rev-parse", "dev");
  let binding;
  await assert.rejects(f.status(b, "testing", "compat-test-unreviewed"), error => {
    assert.equal(error.code, "RELEASE_NATIVE_REVIEW_REQUIRED"); binding = error.binding;
    assert.deepEqual(error.extraPaths, ["test-one.js", "test-two.js"]);
    assert.ok(error.diffPath); return true;
  });
  assert.equal(await git(f.primary, "rev-parse", "dev"), beforeDev);
  const review = await f.reviewResolution(binding, "compat-independent-dev-review");
  const stale = await f.reviewResolution({ ...binding, parents: [f.base, binding.parents[1]] }, "compat-stale-parents-review");
  await assert.rejects(f.status(b, "testing", "compat-stale-parents", { native_resolution_review: stale }), /review receipt.*changed/u);
  const wrongSet = await f.reviewResolution({ ...binding, identityHash: "0".repeat(64) }, "compat-stale-selection-review");
  await assert.rejects(f.status(b, "testing", "compat-stale-selection", { native_resolution_review: wrongSet }), /review receipt.*changed/u);
  await writeFile(path.join(stage, "unreviewed.txt"), "extra bytes\n");
  await git(stage, "add", ".");
  await git(stage, "-c", "user.name=Fixture", "-c", "user.email=fixture@local.invalid", "commit", "--amend", "--no-edit");
  await assert.rejects(f.status(b, "testing", "compat-after-review-change", { native_resolution_review: review }), /review receipt.*changed/u);
  assert.equal(await git(f.primary, "rev-parse", "dev"), beforeDev);
  await git(stage, "checkout", "--detach", reviewedCommit);
  await f.status(b, "testing", "compat-test-reviewed", { native_resolution_review: review });
  assert.equal(await git(f.primary, "rev-parse", "dev"), reviewedCommit);
  await f.status(a, "awaiting_implementation", "compat-await-a");
  await assert.rejects(f.status(b, "awaiting_implementation", "compat-await-conflict"), error => {
    assert.equal(error.code, "TASK_AWAIT_INTEGRATION_FAILED");
    stage = /Resolve the native Git merge for Task .+ in (.+)$/u.exec(error.message)?.[1];
    assert.ok(stage); return true;
  });
  await cleanup(stage);
  const awaitCommit = await git(stage, "rev-parse", "HEAD");
  let awaitBinding;
  await assert.rejects(f.status(b, "awaiting_implementation", "compat-await-unreviewed"), error => {
    assert.equal(error.code, "TASK_AWAIT_INTEGRATION_FAILED");
    awaitBinding = error.details.nativeResolutionBinding;
    assert.deepEqual(error.details.extraPaths, ["test-one.js", "test-two.js"]); return true;
  });
  const awaitReview = await f.reviewResolution(awaitBinding, "compat-independent-await-review");
  await f.status(b, "awaiting_implementation", "compat-await-reviewed", { native_resolution_review: awaitReview });
  const prepared = await f.releaseGit.frozenCandidate(f.primary);
  assert.equal(prepared.preReleaseHead, awaitCommit);
  for (const file of ["test-one.js", "test-two.js"]) {
    assert.equal((await git(prepared.releaseRoot, "show", `HEAD:${file}`)).match(/function check/gu).length, 1);
  }
  await f.reopen();
  assert.equal((await f.releaseGit.frozenCandidate(f.primary)).preReleaseHead, awaitCommit);
  const generation = await f.release([a, b], f.base, "compat-prepared-generation");
  assert.equal(generation.generations.length, 1);
  assert.equal(generation.operation.waitReason.code, "validation_failed");
  const captured = generation.generations[0].candidates[0];
  await git(captured.releaseRoot, "merge-base", "--is-ancestor", awaitCommit, captured.commit);
  assert.equal((await git(captured.releaseRoot, "show", "HEAD:test-one.js")).match(/function check/gu).length, 1);
});

test("public native lost terminal and source drift retain UNKNOWN through SQLite reopen", { timeout: 180_000 }, async t => {
  const f = await fixture(t), a = await f.create("A");
  await writeFile(path.join(a.root, "a.txt"), "result\n");
  const before = f.board.task(a.id), original = "test-a-lost-terminal";
  const terminal = f.board.commitWorkflowTransition.bind(f.board);
  f.board.commitWorkflowTransition = () => { throw new Error("fixture lost terminal before SQL commit"); };
  await assert.rejects(f.status(a, "testing", original));
  const dev = await git(f.primary, "rev-parse", "dev");
  assert.equal(f.board.lifecycleTransition(original).phase, "pending_git");
  f.board.commitWorkflowTransition = terminal;
  await writeFile(path.join(a.root, "a.txt"), "foreign resumed work\n");
  await f.reopen();
  const refused = await f.reconcile(a, "reconcile-dirty", original, before.revision, before.workflowStatus);
  assert.equal(refused.outcome, "unknown");
  assert.equal(f.board.task(a.id).workflowStatus, before.workflowStatus);
  assert.equal(await readFile(path.join(a.root, "a.txt"), "utf8"), "foreign resumed work\n");
  await git(a.root, "restore", "a.txt");
  const restored = await f.reconcile(a, "reconcile-restored", original, before.revision, before.workflowStatus);
  assert.equal(restored.outcome, "succeeded");
  assert.equal(f.board.task(a.id).workflowStatus, "testing");
  assert.equal(await git(f.primary, "rev-parse", "dev"), dev);
});

test("public durable release composes native immutable generation with separately approved main history", { timeout: 180000 }, async t => {
  const f = await fixture(t, { releaseMetadata: true }), a = await f.create("A");
  await writeFile(path.join(a.root, "a.txt"), "selected\n");
  await f.status(a, "testing", "test-a");
  await f.status(a, "awaiting_implementation", "await-a");
  const source = f.board.task(a.id).gitReferences[0].resultCommit;
  const publishedRoot = path.join(f.root, "published-history");
  await git(f.primary, "worktree", "add", "-b", "published-history", publishedRoot, f.base);
  await writeFile(path.join(publishedRoot, "published-context.txt"), "separate approved history\n");
  await commit(publishedRoot, "published history");
  const published = await git(publishedRoot, "rev-parse", "HEAD");
  await git(publishedRoot, "push", "origin", `${published}:refs/heads/main`);
  f.publication.repositories[0].revision = published;
  const stale = await f.release(a, published);
  assert.equal(stale.operation.waitReason.code, "prepared_candidate_stale");
  assert.equal(stale.generations.length, 0);
  await f.preflight.prepareAwaitSet({ workspaceId: f.workspace.id, reviewedMainApprovals: {
    approvedRepositories: [{ projectRoot: f.primary, approvedLocalMainCommit: f.base, approvedOriginMainCommit: published }],
  } });
  const snapshot = await f.continueRelease(stale.operation.operationId);
  assert.equal(snapshot.operation.operationId, stale.operation.operationId);
  assert.equal(snapshot.operation.state, "waiting", JSON.stringify(snapshot.operation.lastError));
  assert.equal(snapshot.operation.waitReason.code, "validation_failed");
  assert.equal(snapshot.generations.length, 1);
  const generation = snapshot.generations[0];
  assert.equal(generation.selectedResults[0].resultCommit, source);
  const candidate = generation.candidates[0];
  assert.equal(candidate.baseCommit, f.base);
  assert.equal(candidate.manifest.compositionPolicy, "main-selected-git-merge-v1");
  assert.equal(candidate.manifest.baseProvenance.approvedOriginMainCommit, published);
  assert.equal(candidate.manifest.baseProvenance.agreedMainCommit, f.base);
  assert.equal(await git(candidate.releaseRoot, "merge-base", "--is-ancestor", source, candidate.commit), "");
  await assert.rejects(git(candidate.releaseRoot, "show", `${candidate.commit}:published-context.txt`));
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.commit}:a.txt`), "selected");
  assert.equal(await git(f.primary, "rev-parse", "main"), f.base);
  // Frozen operation bytes coexist with continued Task work. No Task freeze.
  assert.equal((await f.status(a, "in_progress", "return-a")).workflowStatus, "in_progress");
  assert.equal(await git(candidate.releaseRoot, "rev-parse", "HEAD"), candidate.commit);
});

test("public release generation retains prepared PreRelease conflict resolution", { timeout: 240_000 }, async t => {
  const f = await fixture(t, { releaseMetadata: true }), a = await f.create("A"), b = await f.create("B");
  await writeFile(path.join(a.root, "shared.txt"), "A\n");
  await f.status(a, "testing", "prepared-test-a");
  await writeFile(path.join(b.root, "shared.txt"), "B\n");
  let devConflict;
  await assert.rejects(f.status(b, "testing", "prepared-test-b-conflict"), error => {
    assert.equal(error.code, "TASK_INTEGRATION_CONFLICT"); devConflict = error.details; return true;
  });
  await writeFile(path.join(devConflict.nativeConflictRoot, "shared.txt"), "dev resolution\n");
  await commit(devConflict.nativeConflictRoot, "resolve dev preview");
  await f.status(b, "testing", "prepared-test-b-resolved");
  await f.status(a, "awaiting_implementation", "prepared-await-a");
  let awaitConflict;
  await assert.rejects(f.status(b, "awaiting_implementation", "prepared-await-b-conflict"), error => {
    assert.equal(error.code, "TASK_AWAIT_INTEGRATION_FAILED");
    awaitConflict = /Resolve the native Git merge for Task .+ in (.+)$/u.exec(error.message)?.[1];
    assert.ok(awaitConflict, error.message); return true;
  });
  await writeFile(path.join(awaitConflict, "shared.txt"), "accepted PreRelease resolution\n");
  await commit(awaitConflict, "resolve accepted PreRelease");
  const resolution = await git(awaitConflict, "rev-parse", "HEAD");
  await f.status(b, "awaiting_implementation", "prepared-await-b-resolved");
  const prepared = await f.releaseGit.frozenCandidate(f.primary);
  assert.equal(prepared.preReleaseHead, resolution);
  const subset = await f.release(a, f.base, "prepared-stale-selection");
  assert.equal(subset.operation.state, "waiting");
  assert.equal(subset.operation.waitReason.code, "prepared_candidate_stale");
  assert.equal(subset.operation.lastError.code, "RELEASE_PREPARED_CANDIDATE_STALE");
  assert.equal(subset.generations.length, 0);
  const notes = Buffer.from("authorized prepared release notes\n");
  const notesPath = path.join(f.root, "authorized-CHANGELOG.md");
  await writeFile(notesPath, notes);
  const notesHash = createHash("sha256").update(notes).digest("hex");
  const releaseMetadata = { sourcePath: notesPath, byteLength: notes.length,
    rawSha256: notesHash, canonicalSha256: notesHash };
  assert.equal(await git(prepared.releaseRoot, "status", "--porcelain"), "");
  const prepareGeneration = f.preflight.prepareOperationGeneration.bind(f.preflight);
  let lost = null;
  f.preflight.prepareOperationGeneration = async input => {
    const value = await prepareGeneration(input);
    if (!lost) {
      lost = value.releaseCandidates[0];
      throw Object.assign(new Error("lost generation response after metadata freeze"), { code: "RELEASE_EXTERNAL_CONDITION" });
    }
    return value;
  };
  const interrupted = await f.release([a, b], f.base, "native-release-original", releaseMetadata);
  assert.equal(interrupted.operation.state, "waiting", JSON.stringify(interrupted.operation));
  assert.equal(interrupted.operation.waitReason.code, "external_condition");
  assert.equal(interrupted.generations.length, 0);
  const reflog = await git(lost.releaseRoot, "reflog", "show", "--format=%H", "PreRelease");
  const snapshot = await f.continueRelease(interrupted.operation.operationId);
  assert.equal(snapshot.operation.state, "waiting", JSON.stringify(snapshot.operation));
  assert.equal(snapshot.operation.waitReason?.code, "validation_failed", JSON.stringify(snapshot.operation.lastError));
  assert.equal(snapshot.generations.length, 1);
  const candidate = snapshot.generations[0].candidates[0];
  assert.equal(snapshot.operation.operationId, interrupted.operation.operationId);
  assert.equal(candidate.commit, lost.preReleaseHead);
  assert.equal(await git(candidate.releaseRoot, "reflog", "show", "--format=%H", "PreRelease"), reflog);
  assert.equal(candidate.manifest.preparedCandidate.commit, resolution);
  assert.equal(candidate.manifest.preparedCandidate.tree, prepared.tree);
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.commit}:shared.txt`), "accepted PreRelease resolution");
  assert.equal(await git(candidate.releaseRoot, "show", `${candidate.commit}:CHANGELOG.md`), notes.toString().trim());
  assert.equal(await git(candidate.releaseRoot, "merge-base", "--is-ancestor", resolution, candidate.commit), "");
  const metadata = new Set(["CHANGELOG.md", "AgentHub/package.json", "AgentHub/package-lock.json"]);
  assert.ok((await git(candidate.releaseRoot, "diff", "--name-only", resolution, candidate.commit))
    .split(/\r?\n/u).filter(Boolean).every(file => metadata.has(file)));
  assert.equal(await git(prepared.releaseRoot, "rev-parse", "HEAD"), resolution);
  assert.equal(await git(prepared.releaseRoot, "status", "--porcelain"), "");
  assert.deepEqual(await readFile(notesPath), notes);
});
