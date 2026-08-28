import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

async function transport() {
  const source = await readFile(
    new URL("../../assets/web-app/snapshot-transport.js", import.meta.url),
    "utf8",
  );
  const window = {};
  vm.runInNewContext(source, { window });
  return window.AgentHubSnapshotTransport;
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("snapshot transport materializes bootstrap resets and conversation naming", async () => {
  const api = await transport();
  const snapshot = api.materialize(null, {
    apiVersion: 4,
    version: "snapshot-1",
    collectionDeltas: {
      conversations: {
        version: "conversations-1",
        reset: [{ streamId: "stream-1", provider: "codex", threadId: "thread-1" }],
      },
      workspaces: { version: "workspaces-1", reset: [{ id: "workspace-1" }] },
      boardTasks: { version: "board-1", reset: [{ id: "task-1" }] },
      messageReceipts: {
        version: "receipts-1",
        reset: [{ provider: "codex", threadId: "thread-1", clientUserMessageId: "message-1" }],
      },
    },
  });

  assert.deepEqual(plain(snapshot.tasks), [{
    streamId: "stream-1",
    provider: "codex",
    threadId: "thread-1",
  }]);
  assert.deepEqual(plain(snapshot.workspaces), [{ id: "workspace-1" }]);
  assert.deepEqual(plain(snapshot.boardTasks), [{ id: "task-1" }]);
  assert.equal(snapshot.conversations, undefined);
  assert.equal(snapshot.collectionDeltas, undefined);
  assert.deepEqual({ ...api.requestParams(snapshot) }, {
    knownVersion: "snapshot-1",
    compactSnapshot: true,
    snapshotProtocol: 4,
    conversationsVersion: "conversations-1",
    workspacesVersion: "workspaces-1",
    boardTasksVersion: "board-1",
    messageReceiptsVersion: "receipts-1",
  });
});

test("snapshot transport applies ordered upserts and removals", async () => {
  const api = await transport();
  const previous = {
    tasks: [{ threadId: "old" }],
    workspaces: [{ id: "workspace-1" }, { id: "workspace-2", name: "Old" }],
    boardTasks: [{ id: "task-1" }],
    messageReceipts: [],
    collectionVersions: {
      workspaces: "workspaces-1",
      boardTasks: "board-1",
      messageReceipts: "receipts-1",
      conversations: "conversations-1",
    },
  };
  const snapshot = api.materialize(previous, {
    apiVersion: 4,
    collectionDeltas: {
      conversations: {
        baseVersion: "conversations-1",
        version: "conversations-2",
        upserts: [{ streamId: "stream-1", provider: "codex", threadId: "new" }],
        removed: ["\u0000\u0000old"],
        order: ["stream-1\u0000codex\u0000new"],
      },
      workspaces: {
        baseVersion: "workspaces-1",
        version: "workspaces-2",
        upserts: [{ id: "workspace-2", name: "New" }, { id: "workspace-3" }],
        removed: ["workspace-1"],
        order: ["workspace-3", "workspace-2"],
      },
      boardTasks: { baseVersion: "board-1", version: "board-1" },
      messageReceipts: { baseVersion: "receipts-1", version: "receipts-1" },
    },
  });

  assert.deepEqual(plain(snapshot.tasks), [{ streamId: "stream-1", provider: "codex", threadId: "new" }]);
  assert.deepEqual(plain(snapshot.workspaces), [{ id: "workspace-3" }, { id: "workspace-2", name: "New" }]);
  assert.deepEqual(plain(snapshot.boardTasks), previous.boardTasks);
  assert.deepEqual(plain(snapshot.messageReceipts), previous.messageReceipts);
});

test("snapshot transport rejects a delta without a local baseline", async () => {
  const api = await transport();
  assert.throws(() => api.materialize(null, {
    apiVersion: 4,
    collectionDeltas: {
      conversations: { version: "conversations-1", reset: [] },
      workspaces: { version: "workspaces-1" },
      boardTasks: { version: "board-1", reset: [] },
      messageReceipts: { version: "receipts-1", reset: [] },
    },
  }), /no local baseline/u);
});

test("snapshot transport rejects the wrong base and drops local ghosts by authoritative order", async () => {
  const api = await transport();
  const previous = {
    tasks: [],
    workspaces: [{ id: "workspace-1" }, { id: "ghost" }],
    boardTasks: [],
    messageReceipts: [],
    collectionVersions: {
      conversations: "conversations-1",
      workspaces: "workspaces-1",
      boardTasks: "board-1",
      messageReceipts: "receipts-1",
    },
  };
  const deltas = {
    conversations: { baseVersion: "conversations-1", version: "conversations-1" },
    workspaces: {
      baseVersion: "workspaces-1",
      version: "workspaces-2",
      upserts: [],
      removed: [],
      order: ["workspace-1"],
    },
    boardTasks: { baseVersion: "board-1", version: "board-1" },
    messageReceipts: { baseVersion: "receipts-1", version: "receipts-1" },
  };

  const repaired = api.materialize(previous, { apiVersion: 4, collectionDeltas: deltas });
  assert.deepEqual(plain(repaired.workspaces), [{ id: "workspace-1" }]);

  deltas.workspaces.baseVersion = "workspaces-old";
  assert.throws(
    () => api.materialize(previous, { apiVersion: 4, collectionDeltas: deltas }),
    (error) => api.isBaselineError(error),
  );
});

test("snapshot transport maps persisted stream UI settings into selection", async () => {
  const api = await transport();
  assert.deepEqual(plain(api.selectionFromSnapshotSettings({
    provider: "codex",
    model: "gpt-test",
    reasoning: "high",
    mode: "default",
    approvalMode: "auto",
    includeClaudeUsage: true,
    activityRecentMinutes: 60,
    streamOrderMode: "manual",
    streamCardWidthMode: "fixed",
    streamCardFixedWidth: 240,
    streamCardGapEnabled: true,
    pinnedWorkspaceStreams: { "workspace-1": ["stream-architect"] },
    quickMessages: { streams: { "stream-architect": [{ label: "Релиз", text: "релизь" }] }, workspaces: {} },
  }, {
    model: "stream-model",
  })), {
    provider: "codex",
    model: "stream-model",
    reasoning: "high",
    mode: "default",
    autoApprove: true,
    includeClaudeUsage: true,
    activityRecentMinutes: 60,
    streamOrderMode: "manual",
    streamCardWidthMode: "fixed",
    streamCardFixedWidth: 240,
    streamCardGapEnabled: true,
    pinnedWorkspaceStreams: { "workspace-1": ["stream-architect"] },
    quickMessages: { streams: { "stream-architect": [{ label: "Релиз", text: "релизь" }] }, workspaces: {} },
  });
});
