import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { RunJournalService } from "../../../src/application/run-journal-service.mjs";
import { createStreamAgentSettingsService } from "../../../src/application/stream-agent-settings-service.mjs";
import { StreamHandoffService } from "../../../src/application/stream-handoff-service.mjs";
import { TaskBoardService } from "../../../src/application/task-board-service.mjs";
import { WorkspaceReleaseService } from "../../../src/application/workspace-release-service.mjs";
import { taskReleasePlan } from "../../../src/domain/task-release-snapshot.mjs";
import { ProviderTaskCatalogBuilder } from "../../../src/providers/provider-task-catalog-builder.mjs";
import { CodexSparkTaskClassifier } from "../../../src/providers/codex/codex-spark-task-classifier.mjs";
import {
  isTaskBoardMutationOwner,
  isWorkspaceCatalogMutationOwner,
} from "../../../src/application/sqlite-mutation-owner.mjs";
import { createPersistenceMutationCapabilities } from "../../../src/composition/persistence-mutation-composition.mjs";
import { TaskBoardStore } from "../../../src/infrastructure/persistence/task-board-store.mjs";
import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

async function fixture(context) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-hub-mutation-owner-"));
  const databaseFile = path.join(root, "hub.sqlite");
  const rawWorkspace = new WorkspaceCatalogStore({ databaseFile });
  await rawWorkspace.load();
  const workspace = await rawWorkspace.runMutation(() => rawWorkspace.createWorkspace({ name: "Agent HUB" }));
  const stream = await rawWorkspace.runMutation(() => rawWorkspace.createStream({
    workspaceId: workspace.id,
    name: "Hotfixer",
    settings: { provider: "codex", model: "old", reasoning: "low", mode: "default" },
  }));
  const rawTasks = new TaskBoardStore({ databaseFile });
  const {
    workspaceCatalogStore: workspaceOwner,
    taskBoardStore: taskOwner,
  } = createPersistenceMutationCapabilities({
    rawWorkspaceCatalogStore: rawWorkspace,
    rawTaskBoardStore: rawTasks,
  });
  const taskBoard = new TaskBoardService({ store: taskOwner, workspaceCatalog: workspaceOwner });
  context.after(async () => {
    rawTasks.close();
    rawWorkspace.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    root, databaseFile, rawWorkspace, workspaceOwner, rawTasks, taskOwner, taskBoard, workspace, stream,
  };
}

async function underContention(databaseFile, operation) {
  const blocker = new DatabaseSync(databaseFile);
  blocker.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
  let timerFired = false;
  const release = setTimeout(() => {
    timerFired = true;
    blocker.exec("COMMIT");
  }, 60);
  try {
    const result = await operation();
    assert.equal(timerFired, true);
    return result;
  } finally {
    clearTimeout(release);
    try { blocker.close(); } catch {}
  }
}

test("production Workspace owner hides raw transaction access and queues handoff meta", async (context) => {
  const { databaseFile, rawWorkspace, workspaceOwner, stream } = await fixture(context);
  assert.equal(workspaceOwner.runMutation, undefined);
  assert.equal(workspaceOwner.transaction, undefined);
  assert.equal(isWorkspaceCatalogMutationOwner(workspaceOwner), true);
  assert.throws(() => workspaceOwner.load, /not classified for production access/u);
  const handoff = new StreamHandoffService({
    workspaceCatalog: workspaceOwner,
    workLog: { threadTurns: async () => [] },
  });
  const first = await underContention(databaseFile, () => handoff.request({
    streamId: stream.id,
    targetProvider: "claude",
    sourceProvider: "codex",
    sourceThreadId: "thread-old",
  }));
  const second = await handoff.request({
    streamId: stream.id,
    targetProvider: "claude",
    sourceProvider: "codex",
    sourceThreadId: "thread-old",
  });
  assert.equal(first.streamId, second.streamId);
  assert.equal(rawWorkspace.meta(`stream-handoff:${stream.id}`) !== null, true);
  assert.ok(rawWorkspace.mutationDiagnostics().retries > 0);
});

test("permanent Workspace deletion is classified on the canonical mutation owner", async (context) => {
  const { rawWorkspace, workspaceOwner, workspace } = await fixture(context);
  await workspaceOwner.archiveWorkspace(workspace.id);
  assert.deepEqual(await workspaceOwner.deleteArchivedWorkspace(workspace.id, workspace.name), {
    id: workspace.id,
    name: workspace.name,
    deleted: true,
  });
  assert.equal(rawWorkspace.workspace(workspace.id), null);
});

test("catalog assignment and provider rebind use the mandatory Workspace owner", async (context) => {
  const { root, databaseFile, rawWorkspace, workspaceOwner, stream } = await fixture(context);
  const builder = new ProviderTaskCatalogBuilder({
    durableEntries: () => workspaceOwner.assignCatalogEntries([
      { provider: "codex", threadId: "catalog-thread", title: "Catalog" },
    ]),
    sources: [],
    managedRuns: () => [],
    merge: (entries) => entries,
  });
  const entries = await underContention(databaseFile, () => builder.build());
  assert.equal(entries.filter((entry) => entry.threadId === "catalog-thread").length, 1);

  const classifier = new CodexSparkTaskClassifier({
    projectRoot: root,
    workspaceCatalog: workspaceOwner,
    streamId: stream.id,
    resolveExecutable: async () => "codex",
    runProcess: async (_command, args) => {
      const outputFile = args[args.indexOf("--output-last-message") + 1];
      await writeFile(outputFile, JSON.stringify({
        title: "Task", description: "", correctedText: "Task", category: "task",
        workspaceId: null, confidence: 0.5, reason: "test",
      }), "utf8");
      return {
        code: 0,
        stdout: `${JSON.stringify({ type: "thread.started", thread_id: "provider-thread" })}\n`,
        stderr: "",
      };
    },
  });
  await underContention(databaseFile, () => classifier.classify({ text: "Task", workspaces: [] }));
  await classifier.classify({ text: "Task", workspaces: [] });
  assert.equal(rawWorkspace.resolveThread({ provider: "codex", threadId: "provider-thread" }).streamId, stream.id);
  assert.equal(rawWorkspace.threadsForStream(stream.id)
    .filter((thread) => thread.threadId === "provider-thread").length, 1);
});

test("settings and journal events retry through the mandatory Workspace owner", async (context) => {
  const { root, databaseFile, rawWorkspace, workspaceOwner, stream } = await fixture(context);
  await workspaceOwner.bindThread({
    provider: "codex", threadId: "journal-thread", streamId: stream.id, projectRoot: root,
  });
  const settings = createStreamAgentSettingsService({
    workspaceCatalog: workspaceOwner,
    selectionStore: { streamId: stream.id, activeProvider: "codex" },
    agentPreferences: {
      current: () => ({ model: "gpt-test", reasoningEffort: "high", collaborationMode: "default" }),
    },
  });
  await underContention(databaseFile, () => settings.remember(stream.id));
  assert.equal(rawWorkspace.stream(stream.id).settings.model, "gpt-test");

  const journal = new RunJournalService({
    usageStore: {
      recordAutomaticAndProject: async () => ({ recorded: true }),
      recordAndProject: async () => ({ recorded: true }),
    },
    workspaceCatalogStore: workspaceOwner,
    findProject: () => ({ path: root, name: "Agent HUB" }),
    defaultProjectRoot: root,
    projectionProjectRoots: [root],
    logger: { error() {} },
  });
  const completion = {
    provider: "codex", threadId: "journal-thread", turnId: "turn-owner",
    projectRoot: root, status: "completed",
  };
  await underContention(databaseFile, () => journal.projectTurn(completion, { body: "done" }));
  await journal.projectTurn(completion, { body: "done" });
  assert.equal(rawWorkspace.workspaceEvents(stream.workspaceId, { limit: 10 })
    .filter((event) => event.subjectId === "turn-owner").length, 1);
});

test("opposite Task to Workspace and Workspace to Task sequences cannot deadlock", async (context) => {
  const { databaseFile, rawWorkspace, workspaceOwner, taskBoard, workspace } = await fixture(context);
  const taskThenWorkspace = async () => {
    const task = await taskBoard.create({
      text: "cross-order", source: "test", sourceKey: "cross-order", bucket: "workspace", workspaceId: workspace.id,
    });
    await workspaceOwner.setMeta("cross-order-task-first", task.id);
    return task;
  };
  const workspaceThenTask = async () => {
    await workspaceOwner.setMeta("cross-order-workspace-first", "started");
    await taskBoard.setCaptureEnabled(777, true);
  };
  const [task] = await underContention(databaseFile, () => Promise.all([
    taskThenWorkspace(), workspaceThenTask(),
  ]));
  const replay = await taskThenWorkspace();
  assert.equal(replay.id, task.id);
  assert.equal(taskBoard.snapshot().filter((item) => item.sourceKey === "cross-order").length, 1);
  assert.equal(rawWorkspace.meta("cross-order-task-first"), task.id);
  assert.equal(taskBoard.captureEnabled(777), true);
});

test("legacy Git adoption reaches immutable CAS audit through the production Task owner", async (context) => {
  const { databaseFile, rawTasks, taskOwner, taskBoard, workspace } = await fixture(context);
  assert.throws(() => taskOwner.databaseFile, /not classified for production access/u);
  const task = await taskBoard.create({
    text: "legacy adoption", source: "test", bucket: "workspace", workspaceId: workspace.id,
  });
  const awaiting = await taskBoard.setWorkflowStatus({ id: task.id, status: "awaiting_implementation" });
  const identities = [];
  const originalRunMutation = rawTasks.runMutation.bind(rawTasks);
  rawTasks.runMutation = (operation, options) => {
    identities.push(options?.requestId);
    return originalRunMutation(operation, options);
  };
  const projectRoot = path.resolve("D:/repo");
  const adopted = await taskBoard.adoptLegacyGitReference({
    taskId: task.id,
    expectedRevision: awaiting.revision,
    projectRoot,
    branch: "HUB-98",
    reportedResultCommit: "a".repeat(40),
    mainResultCommit: "b".repeat(40),
    patchId: "c".repeat(40),
    evidenceStreamId: "stream-evidence",
    evidenceProvider: "codex",
    evidenceThreadId: "thread-evidence",
    evidenceTurnId: "turn-evidence",
    actorStreamId: "stream-release-manager",
    actorProvider: "codex",
    actorThreadId: "thread-release-manager",
    requestId: "adopt-production-owner",
  });

  assert.deepEqual(adopted.gitReferences, [{
    projectRoot,
    branch: "HUB-98",
    resultCommit: "b".repeat(40),
  }]);
  assert.equal(adopted.gitAdoptions[0].evidenceTurnId, "turn-evidence");
  assert.equal(identities.filter((value) => String(value).startsWith("task:adoptLegacyGitReference:")).length, 1);
  const inspected = new DatabaseSync(databaseFile);
  assert.equal(inspected.prepare(
    "SELECT request_id FROM hub_task_legacy_git_adoptions WHERE task_id = ? AND project_root = ?",
  ).get(task.id, projectRoot)?.request_id, "adopt-production-owner");
  assert.throws(
    () => inspected.prepare("DELETE FROM hub_task_legacy_git_adoptions WHERE task_id = ?").run(task.id),
    /legacy Git adoption audit is immutable/u,
  );
  inspected.close();
});

test("composed release completion retries through the mandatory Task owner without duplicate effect", async (context) => {
  const { databaseFile, rawTasks, taskOwner, taskBoard, workspace } = await fixture(context);
  assert.equal(isTaskBoardMutationOwner(taskOwner), true);
  const task = await taskBoard.create({
    text: "release contention", source: "test", bucket: "workspace", workspaceId: workspace.id,
  });
  await taskBoard.recordTaskGitReference({
    taskId: task.id,
    projectRoot: "D:/repo",
    branch: "HUB-159",
    resultSnapshot: { repoRoot: "D:/repo", tree: "a".repeat(40) },
  });
  await taskBoard.setWorkflowStatus({ id: task.id, status: "awaiting_implementation" });
  const candidate = {
    ...taskBoard.task(task.id),
    changedFiles: [{ projectRoot: "D:/repo", path: "AgentHub/result.mjs", operation: "modified" }],
    gitError: null,
  };
  const plan = taskReleasePlan(workspace.id, [candidate]);
  const identities = [];
  const originalRunMutation = rawTasks.runMutation.bind(rawTasks);
  rawTasks.runMutation = (operation, options) => {
    identities.push(options?.requestId);
    return originalRunMutation(operation, options);
  };
  const release = new WorkspaceReleaseService({
    store: taskOwner,
    releasePlanner: { plan: async () => plan },
    releaseGitWorkspaces: {
      frozenCandidate: async () => ({
        planRevision: plan.revision, manifestHash: "manifest", baseCommit: "base", preReleaseHead: "published",
      }),
      synchronizePublishedPrimary: async () => ({ status: "already_current" }),
    },
    taskGitWorkspaces: {
      synchronizeMainIntoDev: async () => ({ status: "already_current", integrated: true }),
    },
    releasePreflight: {
      withAwaitTransition: async (_workspaceId, operation) => operation(),
      prepareAwaitSet: async (options) => {
        const result = { releaseCandidates: [] };
        if (options.commitPrepared) await options.commitPrepared(result);
        return result;
      },
    },
    verifyPublication: async () => ({
      repositories: [{
        root: "D:/repo", revision: "published", planRevision: plan.revision,
        manifestHash: "manifest", baseCommit: "base", preReleaseHead: "published",
      }],
      agentHubPublication: { generation: "generation-release-owner" },
    }),
  });
  const completed = await underContention(databaseFile, () => release.completeRelease({
    workspaceId: workspace.id,
    expectedRepositories: [{ projectRoot: "D:/repo", revision: "published" }],
    expectedPlanRevision: plan.revision,
    deploymentVerified: true,
    verificationSummary: "contention verified",
  }));
  assert.deepEqual(completed.released.map((item) => item.id), [task.id]);
  assert.equal(taskBoard.task(task.id).workflowStatus, "done");
  assert.equal(taskBoard.snapshot().filter((item) => item.id === task.id).length, 1);
  const completionIdentities = identities.filter((value) => String(value).startsWith("task:completeRelease:"));
  assert.equal(completionIdentities.length, 1);
  assert.equal(new Set(completionIdentities).size, 1);
  assert.ok(rawTasks.mutationDiagnostics().retries > 0);
});

test("composed checklist writes share the canonical Task owner and exact retry identity", async (context) => {
  const { databaseFile, rawTasks, taskOwner, taskBoard, workspace } = await fixture(context);
  const identities = [];
  const originalRunMutation = rawTasks.runMutation.bind(rawTasks);
  rawTasks.runMutation = (operation, options) => {
    identities.push(options?.requestId);
    return originalRunMutation(operation, options);
  };
  let parent = await taskBoard.create({
    text: "Checklist owner parent", source: "test", bucket: "workspace", workspaceId: workspace.id,
  });
  const linked = await taskBoard.create({
    text: "Checklist owner linked", source: "test", bucket: "workspace", workspaceId: workspace.id,
  });
  const added = await underContention(databaseFile, () => taskBoard.updateChecklist({
    id: parent.id,
    operation: "add",
    text: "Ship exact linked Task",
    expectedRevision: parent.revision,
    requestId: "canonical-checklist-add",
  }));
  parent = (await taskBoard.updateChecklist({
    id: parent.id,
    operation: "link",
    itemId: added.itemId,
    linkedTaskId: linked.id,
    expectedRevision: added.task.revision,
    requestId: "canonical-checklist-link",
  })).task;
  parent = (await taskBoard.updateChecklist({
    id: parent.id,
    operation: "toggle",
    itemId: added.itemId,
    completed: true,
    expectedRevision: parent.revision,
    requestId: "canonical-checklist-toggle",
  })).task;
  const payload = {
    id: parent.id,
    itemId: added.itemId,
    linkedTaskId: linked.id,
    action: "done",
    expectedTaskRevision: parent.revision,
    expectedLinkedTaskRevision: linked.revision,
    requestId: "canonical-linked-action",
  };
  const action = await underContention(databaseFile, () => taskBoard.applyChecklistLinkedTaskAction(payload));
  assert.equal(action.replayed, false);
  assert.equal(taskBoard.task(linked.id).workflowStatus, "done");
  const replay = await taskBoard.applyChecklistLinkedTaskAction(payload);
  assert.equal(replay.replayed, true);
  assert.equal(taskOwner.runMutation, undefined);
  const checklistIdentities = identities.filter((value) => String(value).startsWith("task:updateChecklist:"));
  const linkedActionIdentities = identities.filter((value) => String(value).startsWith("task:applyChecklistLinkedTaskAction:"));
  assert.equal(checklistIdentities.length, 3);
  assert.equal(linkedActionIdentities.length, 2);
  assert.equal(new Set(linkedActionIdentities).size, 1);
  assert.ok(rawTasks.mutationDiagnostics().retries > 0);
});
