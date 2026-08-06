import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

test("Experiments is seeded once and cannot be renamed", async (t) => {
  const store = await fixture(t);
  const first = store.ensureExperiments();
  const second = store.ensureExperiments();
  assert.equal(first.id, second.id);
  assert.equal(first.name, "Experiments");
  assert.equal(first.kind, "system");
  assert.throws(() => store.renameWorkspace(first.id, "Other"), /cannot be renamed/u);
});

test("unknown Threads receive separate Streams in Experiments", async (t) => {
  const store = await fixture(t);
  const first = store.assignUnknownThread({ provider: "codex", threadId: "one" });
  const repeated = store.assignUnknownThread({ provider: "codex", threadId: "one" });
  const second = store.assignUnknownThread({ provider: "claude", threadId: "two" });
  assert.equal(first.streamId, repeated.streamId);
  assert.notEqual(first.streamId, second.streamId);
  assert.equal(first.workspaceName, "Experiments");
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

test("catalog enrichment is idempotent and exposes Workspace and Stream IDs", async (t) => {
  const store = await fixture(t);
  const input = [{ provider: "codex", threadId: "one", title: "Task" }];
  const first = store.assignCatalogEntries(input);
  const second = store.assignCatalogEntries(input);
  assert.deepEqual(first, second);
  assert.equal(first[0].workspaceName, "Experiments");
  assert.match(first[0].streamId, /^id-\d+$/u);
  assert.equal(store.hierarchy().find((item) => item.name === "Experiments").streams.length, 1);
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

test("rebindThread can replace an automatic Experiments assignment during migration", async (t) => {
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
