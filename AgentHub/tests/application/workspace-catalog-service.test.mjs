import assert from "node:assert/strict";
import test from "node:test";

import { WorkspaceCatalogService } from "../../src/application/workspace-catalog-service.mjs";

function fixture() {
  const calls = [];
  const store = {
    hierarchy: () => [{ id: "workspace-1" }],
    transaction: (run) => run(),
    createWorkspace: (value) => (calls.push(["createWorkspace", value]), { id: "workspace-1", ...value }),
    createStream: (value) => (calls.push(["createStream", value]), { id: "stream-1", ...value }),
    renameWorkspace: (...args) => calls.push(["renameWorkspace", ...args]),
    mergeWorkspaces: (...args) => calls.push(["mergeWorkspaces", ...args]),
    renameStream: (...args) => calls.push(["renameStream", ...args]),
    updateStreamSettings: (...args) => (calls.push(["updateStreamSettings", ...args]), { settings: args[1] }),
    moveStream: (...args) => calls.push(["moveStream", ...args]),
    bindThread: (value) => (calls.push(["bindThread", value]), value),
    activeThread: (streamId) => ({ streamId }),
    resolveThread: (value) => value,
  };
  return { calls, service: new WorkspaceCatalogService({ store }) };
}

test("createWorkspace creates its first Stream atomically", () => {
  const { service, calls } = fixture();
  const result = service.createWorkspace({ name: "Agent HUB", streamName: "Themes" });
  assert.equal(result.workspace.id, "workspace-1");
  assert.equal(result.stream.id, "stream-1");
  assert.deepEqual(calls, [
    ["createWorkspace", { name: "Agent HUB" }],
    ["createStream", { workspaceId: "workspace-1", name: "Themes" }],
  ]);
});

test("createWorkspaceFromStream creates the destination and moves the existing Stream atomically", () => {
  const { service, calls } = fixture();
  const result = service.createWorkspaceFromStream({ streamId: "stream-old", name: "Destination" });
  assert.equal(result.workspace.id, "workspace-1");
  assert.deepEqual(calls, [
    ["createWorkspace", { name: "Destination" }],
    ["moveStream", "stream-old", "workspace-1"],
  ]);
});

test("bindThread links a replacement provider Thread to an existing Stream", () => {
  const { service } = fixture();
  assert.deepEqual(service.bindThread({
    streamId: "stream-1", provider: "codex", threadId: "thread-2",
  }), {
    streamId: "stream-1", provider: "codex", threadId: "thread-2",
    projectRoot: "", source: "rebirth",
  });
});

test("Stream settings are stored independently from its future Thread", () => {
  const { service, calls } = fixture();
  const settings = { provider: "claude", model: "sonnet", project: "D:/later" };
  service.createStream({ workspaceId: "workspace-1", name: "Draft", settings });
  assert.deepEqual(service.updateStreamSettings({ streamId: "stream-1", settings }), { settings });
  assert.deepEqual(calls.slice(-2), [
    ["createStream", { workspaceId: "workspace-1", name: "Draft", settings }],
    ["updateStreamSettings", "stream-1", settings],
  ]);
});
