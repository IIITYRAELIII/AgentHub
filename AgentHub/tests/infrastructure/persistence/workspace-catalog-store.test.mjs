import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { WorkspaceCatalogStore } from "../../../src/infrastructure/persistence/workspace-catalog-store.mjs";

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

test("Other is seeded once and cannot be renamed", async (t) => {
  const store = await fixture(t);
  const first = store.ensureExperiments();
  const second = store.ensureExperiments();
  assert.equal(first.id, second.id);
  assert.equal(first.name, "Other");
  assert.equal(first.kind, "system");
  assert.throws(() => store.renameWorkspace(first.id, "Other"), /cannot be renamed/u);
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
  assert.deepEqual(updated.settings, { workingDirectory: "D:/work/AgentHub" });
  assert.deepEqual(
    store.hierarchy().find((item) => item.id === workspace.id).settings,
    updated.settings,
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
