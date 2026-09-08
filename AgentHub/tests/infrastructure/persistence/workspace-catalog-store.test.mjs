import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DEVELOPER_RULES_MAX_BYTES,
  WORKSPACE_ARCHIVE_RETENTION_MS,
  WorkspaceCatalogStore,
} from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import {
  LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
  LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
  RELEASE_WORKFLOW_DEVELOPER_RULES,
} from "../../../src/domain/workspace-release-workflow.mjs";
import {
  LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1,
} from "../../../src/domain/editable-workspace-developer-rules.mjs";

async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspaces-"));
  let id = 0;
  const store = new WorkspaceCatalogStore({
    databaseFile: path.join(directory, "journal.sqlite"),
    now: () => 1_700_000_000_000 + id,
    idFactory: () => `id-${++id}`,
  });
  await store.load();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return store;
}

test("Workspace archive hides hierarchy, restores intact, and purges after three days", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspace-archive-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let nowMs = 1_700_000_000_000;
  let id = 0;
  const store = new WorkspaceCatalogStore({
    databaseFile,
    now: () => nowMs,
    idFactory: () => `archive-id-${++id}`,
  });
  await store.load();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const workspace = store.createWorkspace({ name: "Удалённый проект" });
  const stream = store.createStream({ workspaceId: workspace.id, name: "Основной" });
  store.bindThread({ provider: "codex", threadId: "thread-1", streamId: stream.id });

  const archived = store.archiveWorkspace(workspace.id);
  assert.equal(archived.archivedAtMs, nowMs);
  assert.equal(archived.purgeAfterMs, nowMs + WORKSPACE_ARCHIVE_RETENTION_MS);
  assert.equal(store.hierarchy().some((item) => item.id === workspace.id), false);
  assert.deepEqual(store.archivedWorkspaces().map((item) => ({
    id: item.id,
    streamCount: item.streamCount,
    threadCount: item.threadCount,
  })), [{ id: workspace.id, streamCount: 1, threadCount: 1 }]);
  assert.equal(store.assignCatalogEntries([{
    provider: "codex",
    threadId: "thread-1",
    title: "Скрытый чат",
  }]).length, 0);

  nowMs += WORKSPACE_ARCHIVE_RETENTION_MS - 1;
  assert.equal(store.restoreWorkspace(workspace.id).archivedAtMs, null);
  assert.equal(store.hierarchy().find((item) => item.id === workspace.id).streams[0].threads.length, 1);

  store.archiveWorkspace(workspace.id);
  nowMs += WORKSPACE_ARCHIVE_RETENTION_MS;
  assert.equal(store.archivedWorkspaces().length, 0);
  assert.equal(store.workspace(workspace.id), null);
  assert.equal(store.stream(stream.id), null);
  assert.equal(store.thread({ provider: "codex", threadId: "thread-1" }), null);
});

test("system Workspace cannot be archived", async (t) => {
  const store = await fixture(t);
  assert.throws(() => store.archiveWorkspace(store.ensureExperiments().id), /cannot be archived/u);
});

test("workspace catalog revision is O(1) state that changes after a write", async (t) => {
  const store = await fixture(t);
  const initial = store.revision;

  store.hierarchy();
  assert.equal(store.revision, initial);
  store.createWorkspace({ name: "Revision boundary" });
  assert.ok(store.revision > initial);
});

test("workspace catalog read-only mode exposes hierarchy without running migrations", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspaces-read-only-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let writer;
  let reader;
  try {
    writer = new WorkspaceCatalogStore({ databaseFile, now: () => 100 });
    await writer.load();
    const workspace = writer.createWorkspace({ name: "Read model" });
    const stream = writer.createStream({ workspaceId: workspace.id, name: "Queue" });
    writer.bindThread({
      provider: "codex",
      threadId: "10000000-0000-4000-8000-000000000020",
      streamId: stream.id,
      projectRoot: "D:/work",
    });
    writer.close();
    writer = null;

    reader = new WorkspaceCatalogStore({ databaseFile, readOnly: true });
    await reader.load();
    assert.equal(reader.revision, 0);
    assert.equal(
      reader.hierarchy().find((item) => item.id === workspace.id).streams[0].threads[0].threadId,
      "10000000-0000-4000-8000-000000000020",
    );
    assert.throws(
      () => reader.createWorkspace({ name: "Forbidden" }),
      /read.?only|attempt to write/iu,
    );
  } finally {
    writer?.close();
    reader?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("workspace catalog fails closed on a corrupt shared database", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspaces-corrupt-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  await writeFile(databaseFile, "not a sqlite database", "utf8");
  try {
    const store = new WorkspaceCatalogStore({ databaseFile });
    await assert.rejects(store.load(), /not a database/iu);
    assert.equal(await readFile(databaseFile, "utf8"), "not a sqlite database");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Other is seeded once and cannot be renamed", async (t) => {
  const store = await fixture(t);
  const first = store.ensureExperiments();
  const second = store.ensureExperiments();
  assert.equal(first.id, second.id);
  assert.equal(first.name, "Other");
  assert.equal(first.kind, "system");
  assert.throws(() => store.renameWorkspace(first.id, "Other"), /cannot be renamed/u);
});

test("Workspace folder rename updates every member atomically and preserves settings", async (t) => {
  const store = await fixture(t);
  const first = store.createWorkspace({
    name: "Первый",
    settings: { catalogFolder: "Клиенты", workingDirectory: "first", taskPrefix: "ONE" },
  });
  const second = store.createWorkspace({
    name: "Второй",
    settings: { catalogFolder: "Клиенты", workingDirectory: "second" },
  });
  const untouched = store.createWorkspace({
    name: "Другой",
    settings: { catalogFolder: "Внутренние" },
  });
  store.archiveWorkspace(second.id);

  assert.deepEqual(store.renameWorkspaceFolder(" Клиенты ", " Заказчики "), {
    fromFolderName: "Клиенты",
    toFolderName: "Заказчики",
    workspaceCount: 2,
  });
  assert.equal(store.workspace(first.id).settings.catalogFolder, "Заказчики");
  assert.equal(store.workspace(first.id).settings.workingDirectory, "first");
  assert.equal(store.workspace(first.id).settings.taskPrefix, "ONE");
  assert.equal(store.workspace(second.id).settings.catalogFolder, "Заказчики");
  assert.equal(store.workspace(second.id).settings.workingDirectory, "second");
  assert.equal(store.workspace(untouched.id).settings.catalogFolder, "Внутренние");
  assert.throws(() => store.renameWorkspaceFolder("", "Новая"), /names are required/u);
});

test("Workspace folder move preserves settings updated after a stale client snapshot", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({
    name: "Concurrent",
    settings: {
      catalogFolder: "Старая",
      workingDirectory: "old",
      taskPrefix: "RACE",
      releaseWorkflowEnabled: true,
    },
  });
  const staleClientSnapshot = structuredClone(workspace);

  store.updateWorkspaceSettings(workspace.id, {
    ...workspace.settings,
    workingDirectory: "new-authoritative",
    concurrentMarker: "must-survive",
  });
  const moved = store.moveWorkspaceToFolder(staleClientSnapshot.id, " Клиенты ");

  assert.deepEqual(moved.settings, {
    catalogFolder: "Клиенты",
    workingDirectory: "new-authoritative",
    taskPrefix: "RACE",
    releaseWorkflowEnabled: true,
    concurrentMarker: "must-survive",
  });
  const ungrouped = store.moveWorkspaceToFolder(staleClientSnapshot.id, "");
  assert.deepEqual(ungrouped.settings, {
    workingDirectory: "new-authoritative",
    taskPrefix: "RACE",
    releaseWorkflowEnabled: true,
    concurrentMarker: "must-survive",
  });
});

test("legacy Experiments name migrates to Other without replacing its Workspace", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspaces-other-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let store = new WorkspaceCatalogStore({ databaseFile, idFactory: () => "system-workspace" });
  await store.load();
  const originalId = store.ensureExperiments().id;
  store.close();

  const database = new DatabaseSync(databaseFile);
  database.prepare("UPDATE hub_workspaces SET name = 'Experiments' WHERE id = ?").run(originalId);
  database.close();

  store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const migrated = store.ensureExperiments();
  assert.equal(migrated.id, originalId);
  assert.equal(migrated.name, "Other");
});

test("Workspace comment is a persisted catalog property", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", comment: "Сервер и клиенты" });
  assert.equal(workspace.comment, "Сервер и клиенты");
  assert.equal(store.updateWorkspaceComment(workspace.id, "Дашборд и интеграции").comment, "Дашборд и интеграции");
  assert.equal(store.hierarchy().find((item) => item.id === workspace.id).comment, "Дашборд и интеграции");
});

test("Workspace working directory is persisted in settings", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const updated = store.updateWorkspaceSettings(workspace.id, {
    workingDirectory: "D:/work/AgentHub",
  });
  assert.deepEqual(updated.settings, {
    workingDirectory: "D:/work/AgentHub",
    taskPrefix: "",
    releaseWorkflowEnabled: false,
  });
  assert.deepEqual(
    store.hierarchy().find((item) => item.id === workspace.id).settings,
    updated.settings,
  );
});

test("Workspace Task prefix is persisted and validated", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  assert.equal(store.updateWorkspaceSettings(workspace.id, { taskPrefix: "HUB" }).settings.taskPrefix, "HUB");
  assert.throws(
    () => store.updateWorkspaceSettings(workspace.id, { taskPrefix: "-HUB" }),
    /Префикс Workspace/u,
  );
});

test("an empty Stream persists the settings for its future Thread", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const stream = store.createStream({
    workspaceId: workspace.id,
    settings: { provider: "codex", model: "gpt-5", project: "D:/later" },
  });
  assert.deepEqual(stream.settings, { provider: "codex", model: "gpt-5", project: "D:/later" });
  const updated = store.updateStreamSettings(stream.id, {
    provider: "claude", model: "sonnet", autoApprove: false,
  });
  assert.deepEqual(updated.settings, { provider: "claude", model: "sonnet", autoApprove: false });
  assert.deepEqual(
    store.hierarchy().find((item) => item.id === workspace.id).streams[0].settings,
    updated.settings,
  );
});

test("Astra Stream settings survive a SQLite store restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-astra-stream-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let store;
  try {
    store = new WorkspaceCatalogStore({ databaseFile });
    await store.load();
    const workspace = store.createWorkspace({ name: "Astra" });
    const stream = store.createStream({ workspaceId: workspace.id });
    store.updateStreamSettings(stream.id, {
      provider: "codex",
      model: "gpt-6-astra",
      reasoning: "high",
    });
    store.close();

    store = new WorkspaceCatalogStore({ databaseFile });
    await store.load();
    assert.deepEqual(store.stream(stream.id).settings, {
      provider: "codex",
      model: "gpt-6-astra",
      reasoning: "high",
    });
  } finally {
    store?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("archiving a Stream hides it without losing its Thread history", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const stream = store.createStream({ workspaceId: workspace.id, name: "Old" });
  store.bindThread({ provider: "codex", threadId: "thread-old", streamId: stream.id });

  const archived = store.archiveStream(stream.id);

  assert.ok(archived.archivedAtMs);
  assert.deepEqual(store.threadsForStream(stream.id).map((thread) => thread.threadId), ["thread-old"]);
  assert.equal(
    store.hierarchy().find((item) => item.id === workspace.id).streams.length,
    0,
  );
  assert.deepEqual(store.assignCatalogEntries([{
    provider: "codex", threadId: "thread-old", projectRoot: "D:/work",
  }]), []);
  assert.equal(store.archiveStream(stream.id).archivedAtMs, archived.archivedAtMs);
});

test.skip("retired Workspace release registry ownership model", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", settings: { releaseWorkflowEnabled: true } });
  const firstStream = store.createStream({ workspaceId: workspace.id, name: "One" });
  const secondStream = store.createStream({ workspaceId: workspace.id, name: "Two" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: firstStream.id });
  store.bindThread({ provider: "codex", threadId: "two", streamId: secondStream.id });
  const first = store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", summary: "First",
    changedFiles: ["AgentHub/app.js", "AgentHub/server.mjs"], diffHash: "first",
  });
  const repeated = store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", summary: "First updated",
    changedFiles: ["AgentHub/app.js"], diffHash: "updated", status: "ready",
  });
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.status, "ready");
  assert.equal(store.releaseChanges(workspace.id).length, 1);
  store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", summary: "Observed again",
    changedFiles: ["AgentHub/app.js"], diffHash: "again",
  });
  assert.equal(store.releaseChange({ provider: "codex", threadId: "one", turnId: "turn-one" }).status, "ready");
  const second = store.recordReleaseChange({
    provider: "codex", threadId: "two", turnId: "turn-two", summary: "Second",
    changedFiles: ["AgentHub/app.js"], diffHash: "second",
  });
  assert.deepEqual(second.files, []);
  assert.deepEqual(second.observedFiles, ["AgentHub/app.js"]);
  store.updateReleaseChangeFiles(second.id, ["AgentHub/app.js"]);
  const plan = store.releasePlan(workspace.id);
  assert.equal(plan.ready.length, 1);
  const registry = store.releaseRegistry(workspace.id, { limit: 1 });
  assert.equal(registry.total, 2);
  assert.equal(registry.changes.length, 1);
  assert.deepEqual(registry.counts, { draft: 1, ready: 1, blocked: 0, released: 0, discarded: 0 });
  assert.deepEqual(plan.conflicts, [{
    projectRoot: "",
    file: "AgentHub/app.js",
    changes: [
      { id: first.id, streamId: firstStream.id, status: "ready" },
      { id: second.id, streamId: secondStream.id, status: "draft" },
    ],
  }]);
  store.recordReleaseChange({
    provider: "codex", threadId: "two", turnId: "turn-two", summary: "Second isolated",
    changedFiles: ["AgentHub/other.js"], diffHash: "isolated",
  });
  store.updateReleaseChangeFiles(second.id, ["AgentHub/other.js"]);
  store.updateReleaseChangeStatus(second.id, "ready");
  assert.equal(store.releasePlan(workspace.id).conflicts.length, 0);
  assert.throws(() => store.updateReleaseChangeStatus(first.id, "released"), /reserved/u);
  const completed = store.completeRelease(workspace.id);
  assert.equal(completed.released.length, 2);
  assert.deepEqual(store.releaseChanges(workspace.id), []);
});

test("detached historical Threads remain resolvable but cannot become active", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspaces-detached-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  try {
    let store = new WorkspaceCatalogStore({ databaseFile, now: () => 100 });
    await store.load();
    const workspace = store.createWorkspace({ name: "Test Contour history" });
    const stream = store.createStream({ workspaceId: workspace.id });
    store.bindThread({
      provider: "codex",
      threadId: "production-thread",
      streamId: stream.id,
      projectRoot: "D:/production",
      source: "created",
    });
    store.close();

    const database = new DatabaseSync(databaseFile);
    database.prepare("UPDATE hub_threads SET detached_at_ms = ?").run(200);
    database.close();

    store = new WorkspaceCatalogStore({ databaseFile, now: () => 300 });
    await store.load();
    assert.equal(store.activeThread(stream.id), null);
    assert.equal(store.resolveThread({
      provider: "codex",
      threadId: "production-thread",
    }).thread.detachedAtMs, 200);
    store.bindThread({
      provider: "codex",
      threadId: "contour-thread",
      streamId: stream.id,
      projectRoot: "D:/contour",
      source: "rebirth",
    });
    assert.equal(store.activeThread(stream.id).threadId, "contour-thread");
    assert.deepEqual(
      store.threadsForStream(stream.id).map((thread) => thread.threadId),
      ["production-thread", "contour-thread"],
    );
    store.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test.skip("retired Workspace release registry completion model", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", settings: { releaseWorkflowEnabled: true } });
  const firstStream = store.createStream({ workspaceId: workspace.id, name: "One" });
  const secondStream = store.createStream({ workspaceId: workspace.id, name: "Two" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: firstStream.id });
  store.bindThread({ provider: "codex", threadId: "two", streamId: secondStream.id });
  store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", changedFiles: ["AgentHub/app.js"], status: "ready",
  });
  store.recordReleaseChange({
    provider: "codex", threadId: "two", turnId: "turn-two", changedFiles: ["AgentHub/app.js"], status: "ready",
  });
  const plan = store.releasePlan(workspace.id);
  const evidence = {
    planRevision: plan.revision,
    expectedRevision: "abc",
    verificationSummary: "Integrated overlap verified",
    conflictsResolved: true,
  };
  assert.throws(
    () => store.completeRelease(workspace.id, { expectedPlanRevision: plan.revision, verificationEvidence: evidence }),
    /overlapping files/u,
  );
  assert.throws(
    () => store.completeRelease(workspace.id, { conflictsResolved: true }),
    /revision-bound verification evidence/u,
  );
  const completed = store.completeRelease(workspace.id, {
    expectedPlanRevision: plan.revision,
    verificationEvidence: evidence,
    conflictsResolved: true,
  });
  assert.equal(completed.released.length, 2);
});

test("Workspace events are ordered, cursor-based and idempotent by dedupe key", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const stream = store.createStream({ workspaceId: workspace.id, name: "Events" });
  const first = store.recordWorkspaceEvent({
    workspaceId: workspace.id,
    streamId: stream.id,
    type: "task.updated",
    subjectId: "task-1",
    payload: { title: "First" },
    dedupeKey: "task-1:first",
  });
  const replay = store.recordWorkspaceEvent({
    workspaceId: workspace.id,
    streamId: stream.id,
    type: "task.updated",
    subjectId: "task-1",
    payload: { title: "Ignored replay" },
    dedupeKey: "task-1:first",
  });
  const second = store.recordWorkspaceEvent({
    workspaceId: workspace.id,
    type: "release.completed",
    payload: { changeIds: [] },
  });
  assert.equal(replay.sequence, first.sequence);
  assert.deepEqual(
    store.workspaceEvents(workspace.id, { afterSequence: first.sequence, limit: 10 })
      .map((event) => event.sequence),
    [second.sequence],
  );
});

test("MCP mutation audit is idempotent and scoped to its Workspace", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const otherWorkspace = store.createWorkspace({ name: "Other project" });
  const stream = store.createStream({ workspaceId: workspace.id, name: "MCP" });
  const operation = {
    requestId: "request-1",
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-1",
    toolName: "hub_task_update",
    argumentsHash: "hash-1",
  };

  assert.equal(store.beginMcpOperation(operation).replayed, false);
  assert.equal(store.beginMcpOperation(operation).replayed, true);
  store.completeMcpOperation(operation.requestId, { taskId: "task-1" });
  assert.deepEqual(store.beginMcpOperation(operation).result, { taskId: "task-1" });
  assert.equal(store.mcpOperation(operation.requestId).status, "succeeded");
  assert.equal(store.mcpOperation("missing-request"), null);
  assert.equal(store.mcpOperations(workspace.id).length, 1);
  assert.equal(store.mcpOperations(otherWorkspace.id).length, 0);
  assert.throws(
    () => store.beginMcpOperation({ ...operation, argumentsHash: "hash-2" }),
    /already used/u,
  );
});

test("MCP audit resolves only exact successful interstream message provenance", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const stream = store.createStream({ workspaceId: workspace.id, name: "Architect" });
  const operation = {
    requestId: "assignment-1",
    workspaceId: workspace.id,
    streamId: stream.id,
    provider: "codex",
    threadId: "thread-architect",
    toolName: "hub_task_start",
    argumentsHash: "hash-assignment-1",
  };
  store.beginMcpOperation(operation);
  assert.equal(store.interstreamOriginForClientMessage("mcp:assignment-1"), null);
  store.completeMcpOperation(operation.requestId, { task: { id: "task-1" } });

  assert.deepEqual(store.interstreamOriginForClientMessage("mcp:assignment-1"), {
    kind: "interstream",
    workspaceId: workspace.id,
    workspaceName: "Agent HUB",
    streamId: stream.id,
    streamName: "Architect",
    provider: "codex",
    sourceThreadId: "thread-architect",
    requestId: "assignment-1",
  });
  assert.equal(store.interstreamOriginForClientMessage("assignment-1"), null);
  assert.equal(store.interstreamOriginForClientMessage("mcp:missing"), null);
});

test.skip("retired release registry same-Stream overlap model", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", settings: { releaseWorkflowEnabled: true } });
  const stream = store.createStream({ workspaceId: workspace.id, name: "One" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: stream.id });
  for (const turnId of ["turn-one", "turn-two"]) {
    const change = store.recordReleaseChange({
      provider: "codex", threadId: "one", turnId,
      changedFiles: ["AgentHub/app.js"],
    });
    store.updateReleaseChangeStatus(change.id, "ready");
  }
  assert.deepEqual(store.releasePlan(workspace.id).conflicts, []);
});

test.skip("retired release registry changelog ownership model", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", settings: { releaseWorkflowEnabled: true } });
  const firstStream = store.createStream({ workspaceId: workspace.id, name: "One" });
  const secondStream = store.createStream({ workspaceId: workspace.id, name: "Two" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: firstStream.id });
  store.bindThread({ provider: "codex", threadId: "two", streamId: secondStream.id });
  for (const [threadId, turnId, source] of [
    ["one", "turn-one", "AgentHub/one.mjs"],
    ["two", "turn-two", "AgentHub/two.mjs"],
  ]) {
    store.recordReleaseChange({
      provider: "codex",
      threadId,
      turnId,
      projectRoot: "D:/VSC_Tyrael",
      changedFiles: [source, "Utilities/CHANGELOG.md"],
      status: "ready",
    });
  }

  assert.deepEqual(store.releasePlan(workspace.id).conflicts, []);
});

test.skip("retired release registry path conflict model", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", settings: { releaseWorkflowEnabled: true } });
  const firstStream = store.createStream({ workspaceId: workspace.id, name: "One" });
  const secondStream = store.createStream({ workspaceId: workspace.id, name: "Two" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: firstStream.id });
  store.bindThread({ provider: "codex", threadId: "two", streamId: secondStream.id });
  store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", projectRoot: "D:/VSC_Tyrael",
    changedFiles: ["Utilities/AgentHub/src/../src/app.mjs"], status: "ready",
  });
  store.recordReleaseChange({
    provider: "codex", threadId: "two", turnId: "turn-two", projectRoot: "d:\\vsc_tyrael\\utilities",
    changedFiles: ["AgentHub\\src\\app.mjs"], status: "ready",
  });

  assert.equal(store.releasePlan(workspace.id).conflicts.length, 1);
});

test.skip("retired release registry immutable payload model", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", settings: { releaseWorkflowEnabled: true } });
  const stream = store.createStream({ workspaceId: workspace.id, name: "One" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: stream.id });
  const draft = store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", summary: "Draft",
    changedFiles: ["AgentHub/first.mjs"], diffHash: "first",
  });
  assert.deepEqual(draft.files, []);
  assert.deepEqual(draft.observedFiles, ["AgentHub/first.mjs"]);
  assert.throws(() => store.updateReleaseChangeStatus(draft.id, "ready"), /explicit file selection/u);
  store.updateReleaseChangeFiles(draft.id, ["AgentHub/first.mjs"]);
  const ready = store.updateReleaseChangeStatus(draft.id, "ready");
  const observed = store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", summary: "Changed after ready",
    changedFiles: ["AgentHub/second.mjs"], diffHash: "second",
  });
  assert.deepEqual(observed.files, ["AgentHub/first.mjs"]);
  assert.equal(observed.summary, "Draft");
  assert.equal(observed.diffHash, "first");
  assert.equal(observed.revision, ready.revision);

  const plan = store.releasePlan(workspace.id);
  store.completeRelease(workspace.id, {
    expectedPlanRevision: plan.revision,
    verificationEvidence: {
      planRevision: plan.revision,
      expectedRevision: "abc",
      verificationSummary: "Published and smoke-tested",
    },
  });
  assert.throws(() => store.updateReleaseChangeStatus(draft.id, "draft"), /immutable/u);
  const released = store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", summary: "Changed after release",
    changedFiles: ["AgentHub/third.mjs"], diffHash: "third",
  });
  assert.equal(released.status, "released");
  assert.deepEqual(released.files, ["AgentHub/first.mjs"]);
});

test.skip("retired release registry plan CAS model", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", settings: { releaseWorkflowEnabled: true } });
  const stream = store.createStream({ workspaceId: workspace.id, name: "One" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: stream.id });
  const first = store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-one", changedFiles: ["AgentHub/first.mjs"], status: "ready",
  });
  const verifiedPlan = store.releasePlan(workspace.id);
  store.recordReleaseChange({
    provider: "codex", threadId: "one", turnId: "turn-two", changedFiles: ["AgentHub/second.mjs"], status: "ready",
  });

  assert.throws(
    () => store.completeRelease(workspace.id, {
      expectedPlanRevision: verifiedPlan.revision,
      verificationEvidence: {
        planRevision: verifiedPlan.revision,
        expectedRevision: "abc",
        verificationSummary: "Published and smoke-tested",
      },
    }),
    /revision conflict/u,
  );
  assert.equal(store.releaseChange({ provider: "codex", threadId: "one", turnId: "turn-one" }).status, "ready");
  assert.equal(first.status, "ready");
});

test.skip("retired release registry schema migration", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspaces-legacy-release-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE hub_workspaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, system_key TEXT UNIQUE,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, settings_json TEXT NOT NULL DEFAULT '{}'
    ) WITHOUT ROWID;
    CREATE TABLE hub_streams (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, ordinal INTEGER NOT NULL, name TEXT,
      created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL, archived_at_ms INTEGER
    ) WITHOUT ROWID;
    CREATE TABLE hub_release_changes (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, stream_id TEXT NOT NULL, provider TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, project_root TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '', files_json TEXT NOT NULL DEFAULT '[]', diff_hash TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL,
      UNIQUE (provider, provider_thread_id, turn_id)
    ) WITHOUT ROWID;
    INSERT INTO hub_workspaces VALUES ('workspace', 'Legacy', 'user', NULL, 1, 1, '{}');
    INSERT INTO hub_streams VALUES ('stream', 'workspace', 1, 'Legacy', 1, 1, NULL);
    INSERT INTO hub_release_changes VALUES (
      'change', 'workspace', 'stream', 'codex', 'thread', 'turn', 'D:/repo', 'Legacy',
      '["AgentHub/app.mjs"]', 'hash', 'ready', 1, 1
    );
  `);
  database.close();
  const store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });

  assert.equal(store.releasePlan("workspace").ready[0].revision, 1);
  assert.equal(store.releasePlan("workspace").ready[0].status, "ready");
  assert.deepEqual(store.changeSets("workspace"), []);
});

test("release workflow is opt-in and injects policy without changing editable rules", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const stream = store.createStream({
    workspaceId: workspace.id, name: "Architect", settings: { architect: true },
  });
  store.bindThread({ provider: "codex", threadId: "thread", streamId: stream.id });
  assert.equal(store.developerRulesForStream(stream.id).workspace.content, "");
  store.updateWorkspaceDeveloperRules(workspace.id, "Fast Test Contour workflow");

  assert.equal(store.releaseWorkflowEnabledForThread({ provider: "codex", threadId: "thread" }), false);
  assert.equal(
    store.developerRulesForStream(stream.id).workspace.content,
    "Fast Test Contour workflow",
  );
  assert.equal(store.developerRulesForStream(stream.id).stream, null);
  store.updateWorkspaceSettings(workspace.id, { releaseWorkflowEnabled: true });

  assert.equal(store.releaseWorkflowEnabledForThread({ provider: "codex", threadId: "thread" }), true);
  assert.equal(
    store.workspaceDeveloperRules(workspace.id).content,
    "Fast Test Contour workflow",
  );
  const injected = store.developerRulesForStream(stream.id);
  assert.ok(injected.workspace.content.includes(RELEASE_WORKFLOW_DEVELOPER_RULES));
  assert.match(injected.workspace.content, /releaseCandidates\[\]\.releaseRoot.*standalone clone/u);
  assert.match(injected.workspace.content, /Fast Test Contour workflow\nThe registered primary Workspace/u);
  assert.match(injected.stream.content, /Workspace release architect/u);
  assert.match(injected.stream.content, /releaseCandidates\[\]\.releaseRoot.*only checkout/u);
  assert.doesNotMatch(injected.stream.content, /update local main|separate integration worktree/u);
});

test.skip("retired destructive release registry discard", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB", settings: { releaseWorkflowEnabled: true } });
  const stream = store.createStream({ workspaceId: workspace.id, name: "S1" });
  store.bindThread({ provider: "codex", threadId: "thread", streamId: stream.id });
  store.recordReleaseChange({
    provider: "codex", threadId: "thread", turnId: "turn", changedFiles: ["AgentHub/app.js"],
  });
  store.recordChangeSetObservation({
    workspaceId: workspace.id,
    ownerStreamId: stream.id,
    generatedChangeSetId: "change-set",
    provider: "codex",
    threadId: "thread",
    turnId: "turn",
    files: ["AgentHub/app.js"],
  });

  const guarded = store.updateWorkspaceSettings(workspace.id, { releaseWorkflowEnabled: false });
  assert.equal(guarded.releaseWorkflowUpdate.requiresDiscardConfirmation, true);
  assert.equal(store.workspace(workspace.id).settings.releaseWorkflowEnabled, true);
  assert.equal(store.releaseRegistry(workspace.id).pendingTotal, 2);

  const disabled = store.updateWorkspaceSettings(
    workspace.id,
    { releaseWorkflowEnabled: false },
    { discardReleaseEntries: true },
  );
  assert.equal(disabled.settings.releaseWorkflowEnabled, false);
  assert.deepEqual(disabled.releaseWorkflowUpdate.discarded, {
    legacyCount: 1,
    changeSetCount: 1,
    total: 2,
  });
  assert.equal(store.releaseRegistry(workspace.id).pendingTotal, 0);
  assert.equal(store.releaseChange({ provider: "codex", threadId: "thread", turnId: "turn" }).status, "discarded");
  assert.equal(store.changeSet("change-set").status, "discarded");
  assert.equal(
    store.changeSetEvents("change-set").at(-1).payload.authorizationSource,
    "workspace-release-workflow",
  );
});

test("persisted system prefixes are removed from every editable Workspace rule", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-release-workflow-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  let sequence = 0;
  let store = new WorkspaceCatalogStore({
    databaseFile,
    idFactory: () => `legacy-${++sequence}`,
  });
  await store.load();
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const regularWorkspace = store.createWorkspace({ name: "Regular" });
  store.close();
  const database = new DatabaseSync(databaseFile);
  database.prepare("UPDATE hub_workspaces SET settings_json = ? WHERE id = ?")
    .run(JSON.stringify({ releaseWorkflowEnabled: true }), workspace.id);
  database.prepare("UPDATE hub_workspaces SET settings_json = ? WHERE id = ?")
    .run(JSON.stringify({ releaseWorkflowEnabled: false }), regularWorkspace.id);
  const revision = Number(database.prepare(`
    SELECT COALESCE(MAX(revision), 0) + 1 AS value
    FROM hub_developer_rule_revisions WHERE scope_type = 'workspace' AND scope_id = ?
  `).get(workspace.id).value);
  database.prepare(`
    INSERT INTO hub_developer_rule_revisions
      (scope_type, scope_id, revision, content, created_at_ms)
    VALUES ('workspace', ?, ?, ?, ?)
  `).run(
    workspace.id,
    revision,
    [
      LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_RU_V1,
      LEGACY_TASK_BRANCH_RELEASE_WORKFLOW_DEVELOPER_RULES,
      LEGACY_RELEASE_WORKFLOW_DEVELOPER_RULES_V2,
      LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1,
      "Agent Hub rules",
      "Custom English rules",
    ].join("\n\n"),
    Date.now(),
  );
  database.prepare(`
    INSERT INTO hub_developer_rule_revisions
      (scope_type, scope_id, revision, content, created_at_ms)
    VALUES ('workspace', ?, 2, ?, ?)
  `).run(
    regularWorkspace.id,
    LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1,
    Date.now(),
  );
  database.prepare(
    "INSERT OR REPLACE INTO hub_workspace_catalog_meta (key, value) VALUES ('workspace_agent_hub_rules_migrated_v1', 'completed')",
  ).run();
  database.prepare(
    "DELETE FROM hub_workspace_catalog_meta WHERE key = 'workspace_system_rules_removed_v2'",
  ).run();
  database.close();

  store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(store.workspace(workspace.id).settings.releaseWorkflowEnabled, true);
  assert.equal(
    store.workspaceDeveloperRules(workspace.id).content,
    "Agent Hub rules\n\nCustom English rules",
  );
  assert.equal(store.workspace(regularWorkspace.id).settings.releaseWorkflowEnabled, false);
  assert.equal(store.workspaceDeveloperRules(regularWorkspace.id).content, "");
});

test("Architect role migrates once from legacy role or exact name without runtime fallback", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-architect-role-migration-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  t.after(() => rm(directory, { recursive: true, force: true }));
  let store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const byName = store.createStream({ workspaceId: workspace.id, name: "Architect" });
  const byRole = store.createStream({ workspaceId: workspace.id, name: "Release" });
  const regular = store.createStream({ workspaceId: workspace.id, name: "S1" });
  store.close();

  const database = new DatabaseSync(databaseFile);
  database.prepare("DELETE FROM hub_workspace_catalog_meta WHERE key = 'architect_stream_settings_migrated_v1'").run();
  database.prepare("UPDATE hub_streams SET settings_json = ? WHERE id = ?")
    .run(JSON.stringify({ releaseRole: "architect" }), byRole.id);
  database.close();

  store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  assert.equal(store.stream(byName.id).settings.architect, true);
  assert.equal(store.stream(byRole.id).settings.architect, true);
  assert.equal("releaseRole" in store.stream(byRole.id).settings, false);
  assert.equal(store.stream(regular.id).settings.architect, undefined);
  const laterName = store.createStream({ workspaceId: workspace.id, name: "Architect" });
  assert.equal(laterName.settings.architect, undefined);
  store.close();
});

test("Workspace and Stream developer rules keep versioned revisions", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const stream = store.createStream({ workspaceId: workspace.id, name: "Rules" });

  assert.equal(store.workspaceDeveloperRules(workspace.id).content, "");
  assert.equal(store.updateWorkspaceDeveloperRules(workspace.id, "First").revision, 2);
  assert.equal(store.updateWorkspaceDeveloperRules(workspace.id, "Second").revision, 3);
  assert.equal(store.updateWorkspaceDeveloperRules(workspace.id, "Second").revision, 3);
  assert.equal(store.updateWorkspaceDeveloperRules(workspace.id, "").revision, 4);
  assert.equal(store.updateWorkspaceDeveloperRules(workspace.id, "").revision, 4);
  assert.equal(store.updateStreamDeveloperRules(stream.id, "Stream rule").revision, 1);
  assert.equal(store.workspaceDeveloperRules(workspace.id).content, "");
  assert.equal(store.streamDeveloperRules(stream.id).content, "Stream rule");
});

test("developer rules enforce a 32 KiB UTF-8 limit for each scope", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Limits" });
  const stream = store.createStream({ workspaceId: workspace.id });
  const allowed = "я".repeat(DEVELOPER_RULES_MAX_BYTES / 2);

  assert.equal(store.updateWorkspaceDeveloperRules(workspace.id, allowed).content, allowed);
  assert.equal(
    store.updateWorkspaceDeveloperRules(
      workspace.id,
      `${LEGACY_PERSISTED_AGENT_HUB_WORKSPACE_RULES_RU_V1}\n\n${allowed}`,
    ).content,
    allowed,
  );
  assert.throws(
    () => store.updateWorkspaceDeveloperRules(workspace.id, `${allowed}я`),
    /exceed/u,
  );
  assert.throws(
    () => store.updateStreamDeveloperRules(stream.id, `${allowed}я`),
    /exceed/u,
  );
});

test("moving a Stream changes inherited Workspace developer rules", async (t) => {
  const store = await fixture(t);
  const firstWorkspace = store.createWorkspace({ name: "First" });
  const secondWorkspace = store.createWorkspace({ name: "Second" });
  const moving = store.createStream({ workspaceId: firstWorkspace.id, name: "Moving" });
  store.createStream({ workspaceId: firstWorkspace.id, name: "Keep source" });
  store.bindThread({ provider: "codex", threadId: "thread-1", streamId: moving.id });
  store.updateWorkspaceDeveloperRules(firstWorkspace.id, "First workspace");
  store.updateWorkspaceDeveloperRules(secondWorkspace.id, "Second workspace");
  store.updateStreamDeveloperRules(moving.id, "Stream rule");

  assert.equal(
    store.developerRulesForStream(moving.id).workspace.content,
    "First workspace",
  );
  const inherited = store.developerRulesForThread({ provider: "codex", threadId: "thread-1" });
  assert.equal(inherited.workspace.content, "First workspace");
  assert.deepEqual(inherited.stream, store.streamDeveloperRules(moving.id));
  store.moveStream(moving.id, secondWorkspace.id);
  const effective = store.developerRulesForThread({ provider: "codex", threadId: "thread-1" });
  assert.equal(
    effective.workspace.content,
    "Second workspace",
  );
  assert.equal(effective.stream.content, "Stream rule");
});

test("hierarchy exposes current developer rules to clients", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Rules" });
  const stream = store.createStream({ workspaceId: workspace.id, name: "Inherited" });
  store.updateWorkspaceDeveloperRules(workspace.id, "Workspace rule");
  store.updateStreamDeveloperRules(stream.id, "Stream rule");

  const hierarchy = store.hierarchy();
  assert.equal(hierarchy[0].developerRules.content, "Workspace rule");
  assert.equal(hierarchy[0].streams[0].developerRules.content, "Stream rule");
});

test("a Stream can be pinned first without replacing its siblings", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Ordered" });
  const first = store.createStream({ workspaceId: workspace.id, name: "First" });
  const pinned = store.createStream({ workspaceId: workspace.id, name: "Pinned" });
  const last = store.createStream({ workspaceId: workspace.id, name: "Last" });

  assert.equal(store.moveStreamToStart(pinned.id).ordinal, 1);
  assert.deepEqual(
    store.hierarchy().find((item) => item.id === workspace.id).streams.map((stream) => stream.id),
    [pinned.id, first.id, last.id],
  );
});

test("Stream order is persisted as contiguous server ordinals", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Ordered" });
  const first = store.createStream({ workspaceId: workspace.id, name: "First" });
  const second = store.createStream({ workspaceId: workspace.id, name: "Second" });
  const third = store.createStream({ workspaceId: workspace.id, name: "Third" });

  store.transaction(() => store.reorderStream(third.id, second.id));
  assert.deepEqual(
    store.hierarchy().find((item) => item.id === workspace.id).streams
      .map((stream) => [stream.id, stream.ordinal]),
    [[first.id, 1], [third.id, 2], [second.id, 3]],
  );

  store.transaction(() => store.reorderStream(first.id, null));
  assert.deepEqual(
    store.hierarchy().find((item) => item.id === workspace.id).streams
      .map((stream) => [stream.id, stream.ordinal]),
    [[third.id, 1], [second.id, 2], [first.id, 3]],
  );
});

test("Stream order cannot reference another Workspace", async (t) => {
  const store = await fixture(t);
  const firstWorkspace = store.createWorkspace({ name: "First" });
  const secondWorkspace = store.createWorkspace({ name: "Second" });
  const stream = store.createStream({ workspaceId: firstWorkspace.id });
  const foreign = store.createStream({ workspaceId: secondWorkspace.id });

  assert.throws(
    () => store.transaction(() => store.reorderStream(stream.id, foreign.id)),
    /before stream not found in workspace/u,
  );
  assert.equal(store.stream(stream.id).ordinal, 1);
});

test("legacy Workspace catalog gains the comment property without losing data", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspaces-legacy-comment-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const database = new DatabaseSync(databaseFile);
  database.exec(`
    CREATE TABLE hub_workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      system_key TEXT UNIQUE,
      created_at_ms INTEGER NOT NULL,
      updated_at_ms INTEGER NOT NULL,
      settings_json TEXT NOT NULL DEFAULT '{}'
    ) WITHOUT ROWID;
    INSERT INTO hub_workspaces
      (id, name, kind, system_key, created_at_ms, updated_at_ms, settings_json)
    VALUES ('legacy', 'Legacy', 'user', NULL, 1, 1, '{}');
  `);
  database.close();
  const store = new WorkspaceCatalogStore({ databaseFile });
  await store.load();
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  assert.equal(store.workspace("legacy").comment, "");
  assert.equal(store.updateWorkspaceComment("legacy", "После миграции").comment, "После миграции");
});

test("unknown Threads receive separate Streams in Other", async (t) => {
  const store = await fixture(t);
  const first = store.assignUnknownThread({ provider: "codex", threadId: "one" });
  const repeated = store.assignUnknownThread({ provider: "codex", threadId: "one" });
  const second = store.assignUnknownThread({ provider: "claude", threadId: "two" });
  assert.equal(first.streamId, repeated.streamId);
  assert.notEqual(first.streamId, second.streamId);
  assert.equal(first.workspaceName, "Other");
  assert.equal(second.streamOrdinal, 2);
});

test("a Stream keeps stable streamId across sequential provider Threads", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Agent HUB" });
  const stream = store.createStream({ workspaceId: workspace.id, name: "Themes" });
  store.bindThread({ provider: "codex", threadId: "old", streamId: stream.id, source: "migration" });
  store.bindThread({ provider: "codex", threadId: "new", streamId: stream.id, source: "rebirth" });
  const oldThread = store.resolveThread({ provider: "codex", threadId: "old" });
  const newThread = store.resolveThread({ provider: "codex", threadId: "new" });
  assert.equal(oldThread.streamId, stream.id);
  assert.equal(newThread.streamId, stream.id);
  assert.equal(oldThread.threadPosition, 1);
  assert.equal(newThread.threadPosition, 2);
});

test("moving a Thread creates a new Stream and removes its empty old Stream", async (t) => {
  const store = await fixture(t);
  const firstWorkspace = store.createWorkspace({ name: "First" });
  const secondWorkspace = store.createWorkspace({ name: "Second" });
  const stream = store.createStream({ workspaceId: firstWorkspace.id });
  store.bindThread({ provider: "codex", threadId: "one", streamId: stream.id });
  const moved = store.moveThreadToNewStream(
    { provider: "codex", threadId: "one" },
    { workspaceId: secondWorkspace.id, streamName: "Moved" },
  );
  assert.equal(moved.workspaceId, secondWorkspace.id);
  assert.equal(moved.streamName, "Moved");
  assert.equal(store.stream(stream.id), null);
});

test("catalog discovery keeps unbound Threads in separate Other Streams", async (t) => {
  const store = await fixture(t);
  const input = [{ provider: "codex", threadId: "one", title: "Task" }];
  const first = store.assignCatalogEntries(input);
  const second = store.assignCatalogEntries(input);
  assert.deepEqual(first, second);
  assert.equal(first[0].workspaceName, "Other");
  assert.equal(first[0].workspaceKind, "system");
  assert.equal(first[0].streamName, null);
  assert.equal(first[0].streamDisplayName, "");
  assert.match(first[0].streamId, /^id-\d+$/u);
  assert.equal(store.hierarchy().some((item) => item.name === "Task"), false);
  assert.equal(store.hierarchy().find((item) => item.name === "Other").streams.length, 1);
});

test("catalog enrichment preserves automatic Other bindings", async (t) => {
  const store = await fixture(t);
  const automatic = store.assignUnknownThread({ provider: "codex", threadId: "one" });
  const [resolved] = store.assignCatalogEntries([{ provider: "codex", threadId: "one", title: "Old task" }]);
  assert.equal(resolved.workspaceName, "Other");
  assert.equal(resolved.workspaceKind, "system");
  assert.equal(resolved.streamId, automatic.streamId);
  assert.equal(store.hierarchy().find((item) => item.name === "Other").streams.length, 1);
});

test("catalog enrichment preserves explicit Other placement", async (t) => {
  const store = await fixture(t);
  const experiments = store.ensureExperiments();
  const stream = store.createStream({ workspaceId: experiments.id, name: "Intentional" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: stream.id, source: "migration" });
  const [resolved] = store.assignCatalogEntries([{ provider: "codex", threadId: "one", title: "Task" }]);
  assert.equal(resolved.workspaceId, experiments.id);
  assert.equal(resolved.streamName, "Intentional");
});

test("catalog enrichment keeps user Workspace names stable after discovery", async (t) => {
  const store = await fixture(t);
  const workspace = store.createWorkspace({ name: "Original" });
  const stream = store.createStream({ workspaceId: workspace.id });
  store.bindThread({ provider: "codex", threadId: "one", streamId: stream.id, source: "created" });
  store.renameWorkspace(workspace.id, "Personal name");
  const [second] = store.assignCatalogEntries([{ provider: "codex", threadId: "one", title: "Provider changed" }]);
  assert.equal(second.workspaceName, "Personal name");
});

test("legacy task data survives the default one-Workspace-per-Thread upgrade", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-workspaces-legacy-"));
  const databaseFile = path.join(directory, "journal.sqlite");
  const legacy = new DatabaseSync(databaseFile);
  legacy.exec(`
    CREATE TABLE task_read_model_tasks (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_root TEXT NOT NULL,
      title TEXT NOT NULL,
      PRIMARY KEY(provider, thread_id)
    ) WITHOUT ROWID;
    CREATE TABLE journal_records (
      provider TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      record_json TEXT NOT NULL,
      PRIMARY KEY(provider, thread_id, turn_id)
    ) WITHOUT ROWID;
  `);
  legacy.prepare("INSERT INTO task_read_model_tasks VALUES (?, ?, ?, ?)")
    .run("codex", "old-one", "D:/repo", "Old one");
  legacy.prepare("INSERT INTO task_read_model_tasks VALUES (?, ?, ?, ?)")
    .run("claude", "old-two", "D:/repo", "Old two");
  legacy.prepare("INSERT INTO journal_records VALUES (?, ?, ?, ?)")
    .run("codex", "old-one", "turn-1", '{"answer":"preserved"}');
  legacy.close();

  let id = 0;
  const store = new WorkspaceCatalogStore({
    databaseFile,
    idFactory: () => `legacy-id-${++id}`,
  });
  await store.load();
  const assigned = store.assignCatalogEntries([
    { provider: "codex", threadId: "old-one", title: "Old one", projectRoot: "D:/repo" },
    { provider: "claude", threadId: "old-two", title: "Old two", projectRoot: "D:/repo" },
  ]);
  assert.deepEqual(assigned.map((item) => [item.workspaceName, item.streamName]), [
    ["Other", null],
    ["Other", null],
  ]);
  assert.equal(store.hierarchy().filter((item) => item.kind === "user").length, 0);
  assert.equal(store.hierarchy().find((item) => item.name === "Other").streams.length, 2);
  store.close();

  const verified = new DatabaseSync(databaseFile, { readOnly: true });
  assert.equal(verified.prepare("SELECT COUNT(*) AS count FROM task_read_model_tasks").get().count, 2);
  assert.equal(
    verified.prepare("SELECT record_json FROM journal_records WHERE turn_id = ?").get("turn-1").record_json,
    '{"answer":"preserved"}',
  );
  verified.close();
  await rm(directory, { recursive: true, force: true });
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test("merging Workspaces preserves Streams and compacts their ordinals", async (t) => {
  const store = await fixture(t);
  const source = store.createWorkspace({ name: "Source" });
  const target = store.createWorkspace({ name: "Target" });
  const first = store.createStream({ workspaceId: source.id, name: "One" });
  const second = store.createStream({ workspaceId: source.id, name: "Two" });
  store.bindThread({ provider: "codex", threadId: "one", streamId: first.id });
  store.bindThread({ provider: "claude", threadId: "two", streamId: second.id });
  store.mergeWorkspaces(source.id, target.id);
  assert.equal(store.workspace(source.id), null);
  assert.deepEqual(
    store.hierarchy().find((item) => item.id === target.id).streams.map((item) => item.name),
    ["One", "Two"],
  );
});

test("rebindThread can replace an automatic Other assignment during migration", async (t) => {
  const store = await fixture(t);
  const automatic = store.assignUnknownThread({ provider: "codex", threadId: "one" });
  const workspace = store.createWorkspace({ name: "Real" });
  const stream = store.createStream({ workspaceId: workspace.id });
  const rebound = store.rebindThread(
    { provider: "codex", threadId: "one" },
    { streamId: stream.id, source: "migration" },
  );
  assert.equal(rebound.streamId, stream.id);
  assert.equal(store.stream(automatic.streamId), null);
});

test("moving the last Stream removes its empty user Workspace but preserves Other", async (t) => {
  const store = await fixture(t);
  const source = store.createWorkspace({ name: "Source" });
  const target = store.createWorkspace({ name: "Target" });
  const sourceStream = store.createStream({ workspaceId: source.id });
  const experiments = store.ensureExperiments();
  const experimentStream = store.createStream({ workspaceId: experiments.id });
  store.moveStream(sourceStream.id, target.id);
  store.moveStream(experimentStream.id, target.id);
  assert.equal(store.workspace(source.id), null);
  assert.equal(store.workspace(experiments.id)?.name, "Other");
});
