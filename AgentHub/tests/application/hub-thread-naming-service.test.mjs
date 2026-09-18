import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskMetadataStore } from "../../src/application/task-metadata-store.mjs";
import { createHubThreadNamingService, workspaceProviderThreadTitle } from "../../src/application/hub-thread-naming-service.mjs";
import { CodexProviderTaskService } from "../../src/providers/provider-task-service.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-thread-naming-"));
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(root, "journal.sqlite") });
  await catalog.load();
  const metadata = new TaskMetadataStore();
  const names = new Map();
  const calls = [];
  let created = 0;
  const rpc = async (method, params, options) => {
    calls.push({ method, params, options });
    if (method === "thread/start") return { thread: { id: `thread-${++created}` } };
    if (method === "thread/read") return { thread: { id: params.threadId, name: names.get(params.threadId) ?? "" } };
    if (method === "thread/name/set") names.set(params.threadId, params.name);
    return {};
  };
  const naming = createHubThreadNamingService({
    workspaceCatalog: catalog, taskMetadata: metadata, sendRpc: rpc,
    saveTitles: async () => calls.push({ savedTitles: structuredClone(metadata.pinnedTaskTitles) }),
    saveState: async () => {},
  });
  t.after(async () => { catalog.close(); await rm(root, { recursive: true, force: true }); });
  return { catalog, metadata, names, calls, rpc, naming, root };
}

test("created Codex provider thread is named from its durable Workspace and Stream before its first message", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  for (const explicitName of [null, "Кролик"]) {
    const stream = f.catalog.createStream({ workspaceId: workspace.id, name: explicitName });
    const state = { streamId: stream.id };
    const service = new CodexProviderTaskService({
      selection: { get streamId() { return state.streamId; },
        setThread: (id) => { state.threadId = id; }, setTitle: (title) => { state.title = title; } },
      transportRunning: () => true, startTransport: async () => {}, initialize: async () => {}, sendRpc: f.rpc,
      bindCreatedThread: (value) => f.catalog.bindThread({ ...value, source: "created" }),
      nameCreatedThread: f.naming.nameCreatedThread, activeProjectRoot: () => f.root,
      sandboxMode: () => "workspace-write", invalidateCatalog: () => {}, restoreSettings: () => {},
      updateSettings: async () => {}, clearLatestDiff: () => {}, saveState: async () => {},
    });
    const result = await service.createTask();
    const expected = explicitName ? "Проект — Кролик" : "Проект — Поток 1";
    assert.equal(result.title, expected);
    assert.equal(f.names.get(result.threadId), expected);
    assert.equal(f.metadata.pinnedTitle({ provider: "codex", threadId: result.threadId }), expected);
    assert.equal(state.title, expected);
    assert.equal(f.calls.some((call) => call.method === "turn/start"), false);
    assert.equal(f.calls.some((call) => call.method === "thread/name/set" && /Telegram|AGENT_HUB_CONTEXT_PROBE/u.test(call.params.name)), false);
  }
  assert.equal(workspaceProviderThreadTitle(workspace, { id: "opaque-stream-uuid", ordinal: 3 }), "Проект — Поток 3");
  assert.equal(workspaceProviderThreadTitle(workspace, { id: "explicit", name: "Stream 7", ordinal: 3 }), "Проект — Stream 7");
});
