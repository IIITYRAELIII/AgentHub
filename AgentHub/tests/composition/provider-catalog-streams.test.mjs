import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  currentStreamEntries,
  currentWorkspaceThreadEntries,
  createProviderCatalogComposition,
} from "../../src/composition/provider-catalog-composition.mjs";
import { createTaskCatalogFinalizationComposition } from "../../src/composition/task-catalog-finalization-composition.mjs";
import { TaskRunRegistry } from "../../src/domain/task-runs.mjs";
import { createWorkspaceCatalogMutationOwner } from "../../src/application/sqlite-mutation-owner.mjs";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { AgentProviderRegistry } from "../../src/providers/agent-provider-registry.mjs";

async function startupCatalog(t, discover) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-hub-cold-catalog-"));
  const store = new WorkspaceCatalogStore({ databaseFile: path.join(directory, "journal.sqlite") });
  t.after(async () => {
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  await store.load();
  const workspace = store.createWorkspace({ name: "Startup workspace" });
  const rows = [];
  for (let streamIndex = 0; streamIndex < 9; streamIndex += 1) {
    const stream = store.createStream({ workspaceId: workspace.id });
    for (let threadIndex = 0; threadIndex < 9; threadIndex += 1) {
      const row = {
        provider: "codex",
        threadId: `thread-${streamIndex}-${threadIndex}`,
        projectRoot: directory,
        title: `Thread ${streamIndex}-${threadIndex}`,
        updatedAtMs: 1,
        running: true,
        turnId: `cached-${streamIndex}-${threadIndex}`,
      };
      store.bindThread({ ...row, streamId: stream.id, source: "created" });
      rows.push(row);
    }
  }
  const archived = store.createStream({ workspaceId: workspace.id });
  const archivedRow = { ...rows[0], threadId: "archived-thread" };
  store.bindThread({ ...archivedRow, streamId: archived.id, source: "created" });
  store.archiveStream(archived.id);
  rows.push(archivedRow);
  const emptyHead = store.createStream({ workspaceId: workspace.id });
  store.bindThread({ provider: "claude", threadId: "empty-head", projectRoot: directory, streamId: emptyHead.id, source: "created" });
  const taskRuns = new TaskRunRegistry();
  const workspaceCatalogStore = createWorkspaceCatalogMutationOwner(store);
  const assignments = t.mock.method(store, "assignCatalogEntries");
  const initialRevision = store.revision;
  const taskSyncStore = { catalog: () => structuredClone(rows), recordCatalog: () => {}, save: async () => {} };
  const { finalize } = createTaskCatalogFinalizationComposition({
    projects: [],
    taskRuns,
    savedLastTaskMessageRecord: () => null,
    deferredTaskMessageAtMs: () => 0,
    selectedTask: () => ({}),
    taskSyncStore,
    saveState: async () => {},
  });
  t.mock.method(AgentProviderRegistry.prototype, "catalogSources", () => [{
    name: "Codex", provider: "codex", discover, toEntries: (entries) => entries,
  }]);
  const noop = () => null;
  const { taskCatalogService } = createProviderCatalogComposition({
    taskSyncStore,
    workspaceCatalogStore,
    taskRuns,
    taskCatalogCacheMs: 0,
    runProject: () => ({ name: "Test" }),
    finalizeTaskCatalog: finalize,
    findProject: () => ({ name: "Test", path: directory }),
    saveState: noop,
    readCodexTaskSnapshot: noop,
    applyCodexObservedSnapshot: noop,
    applyCodexActiveSnapshot: noop,
    claudeTaskSnapshots: { applyManagedCancellation: noop },
    claudeRuntimeOwner: { state: noop },
    claudeRunAdmission: { consumeLaunch: noop },
    backfillWorkLogPricingMetadata: noop,
    readCodexThreadTitleHistories: noop,
    rememberCodexRolloutPath: noop,
    capturedCodexExecutionOwner: noop,
    codexObservedRuntimeActive: noop,
    codexTransportPid: noop,
    resolveCodexObservedExecutionOwner: noop,
    codexModelLabel: noop,
    codexThreadResponseTitle: noop,
    pendingTaskTitle: noop,
    clearExpectedTitle: noop,
    pinnedTaskTitle: noop,
    reconcilePinnedTitle: noop,
    savePinnedTaskTitles: noop,
    auditClaudeTranscriptSnapshots: noop,
  });
  return { taskCatalogService, taskRuns, store, rows, emptyHead, assignments, initialRevision };
}

test("cold composition publishes canonical Stream identities before delayed provider discovery", async (t) => {
  const discovery = Promise.withResolvers();
  const discoveryStarted = Promise.withResolvers();
  let discoveries = 0;
  const state = await startupCatalog(t, () => {
    discoveries += 1;
    discoveryStarted.resolve();
    return discovery.promise;
  });
  const entries = state.taskCatalogService.entries;
  assert.equal(discoveries, 0);
  assert.equal(state.assignments.mock.callCount(), 0);
  assert.equal(state.store.revision, state.initialRevision);
  assert.equal(entries.length, 82);
  assert.equal(new Set(entries.map((entry) => entry.streamId)).size, 10);
  assert.equal(new Set(entries.map((entry) => `${entry.provider}:${entry.threadId}`)).size, entries.length);
  assert.ok(entries.every((entry) => entry.streamId && entry.workspaceId && entry.running === false));
  assert.ok(entries.filter((entry) => entry.provider === "codex").every((entry) => entry.activityUnknown));
  assert.equal(entries.find((entry) => entry.threadId === "thread-0-0").title, "Thread 0-0");
  assert.equal(entries.find((entry) => entry.threadId === "thread-0-8").threadPosition, 9);
  assert.equal(entries.find((entry) => entry.threadId === "empty-head").streamId, state.emptyHead.id);
  assert.ok(!entries.some((entry) => entry.threadId === "archived-thread"));
  const before = structuredClone(entries);
  const refresh = state.taskCatalogService.refresh({ force: true });
  await discoveryStarted.promise;
  assert.equal(discoveries, 1);
  assert.deepEqual(entries, before);
  discovery.resolve([]);
  await refresh;
  assert.equal(state.assignments.mock.callCount(), 2);
  assert.equal(state.taskCatalogService.entries, entries);
  assert.deepEqual(entries.map((entry) => `${entry.streamId}:${entry.threadId}`).sort(), before.map((entry) => `${entry.streamId}:${entry.threadId}`).sort());
  assert.ok(entries.every((entry) => entry.running === false));
});

test("failed discovery keeps historical activity unknown while exact parallel managed turns stay active", async (t) => {
  t.mock.method(console, "error", () => {});
  const state = await startupCatalog(t, async () => { throw new Error("provider starting"); });
  for (const threadId of ["thread-0-0", "thread-0-8"]) {
    const entry = state.taskCatalogService.entries.find((value) => value.threadId === threadId);
    state.taskRuns.add({ ...entry, id: `run-${threadId}`, turnId: `live-${threadId}`, status: "running", observer: false });
  }
  await state.taskCatalogService.refresh({ force: true });
  const entries = state.taskCatalogService.entries;
  assert.equal(new Set(entries.map((entry) => entry.streamId)).size, 10);
  assert.deepEqual(entries.filter((entry) => entry.running).map((entry) => entry.threadId).sort(), ["thread-0-0", "thread-0-8"]);
  assert.ok(entries.filter((entry) => entry.provider === "codex" && !entry.running).every((entry) => entry.activityUnknown));
  assert.equal(state.taskRuns.values().length, 2);
});

test("catalog exposes one current provider Thread per Stream", () => {
  const entries = currentStreamEntries([
    { streamId: "stream-1", threadId: "old", threadPosition: 1, running: false },
    { streamId: "stream-1", threadId: "new", threadPosition: 2, running: false },
    { streamId: "stream-2", threadId: "other", threadPosition: 1, running: false },
  ]);
  assert.deepEqual(entries.map((entry) => entry.threadId), ["new", "other"]);
});

test("an active older Thread remains visible until its terminal event", () => {
  const [entry] = currentStreamEntries([
    { streamId: "stream-1", threadId: "old", threadPosition: 1, running: true },
    { streamId: "stream-1", threadId: "new", threadPosition: 2, running: false },
  ]);
  assert.equal(entry.threadId, "old");
});

test("a rotated empty Thread remains visible as the current Stream entry", () => {
  const entries = currentWorkspaceThreadEntries({
    hierarchy: () => [{
      id: "workspace-1",
      name: "Agent HUB",
      kind: "user",
      streams: [{
        id: "stream-1",
        ordinal: 2,
        name: null,
        displayName: "Stream 2",
        threads: [
          { provider: "codex", threadId: "old-thread", position: 1, projectRoot: "D:\\Repo" },
          { provider: "codex", threadId: "new-thread", position: 2, projectRoot: "D:\\Repo" },
        ],
      }],
    }],
  });

  assert.deepEqual(entries, [{
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    workspaceKind: "user",
    streamId: "stream-1",
    streamName: null,
    streamDisplayName: "Stream 2",
    streamOrdinal: 2,
    threadPosition: 2,
    provider: "codex",
    threadId: "new-thread",
    projectRoot: "D:\\Repo",
    projectName: "Repo",
    title: "",
    model: null,
    updatedAtMs: 0,
    running: false,
  }]);
});
