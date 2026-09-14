import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskMetadataStore } from "../../src/application/task-metadata-store.mjs";
import { createHubThreadNamingService, workspaceProviderThreadTitle } from "../../src/application/hub-thread-naming-service.mjs";
import { CodexProviderTaskService } from "../../src/providers/provider-task-service.mjs";
import { createCodexContextMaintenanceComposition } from "../../src/composition/codex-context-maintenance-composition.mjs";
import { CODEX_CONTEXT_PROBE_RESPONSE } from "../../src/domain/codex-context-probe.mjs";

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
    if (method === "turn/start") {
      names.set(params.threadId, CODEX_CONTEXT_PROBE_RESPONSE);
      return { turn: { id: "probe-turn" } };
    }
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

test("rotated Thread receives its Hub name before the probe and restores it after provider auto-naming", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Хаб" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id });
  f.catalog.bindThread({ provider: "codex", threadId: "rotated", streamId: stream.id, projectRoot: f.root, source: "rebirth" });
  let restored;
  const restoredTitle = new Promise((resolve) => { restored = resolve; });
  let preservation = 0;
  const service = createCodexContextMaintenanceComposition({
    config: { components: {}, codexRolloutContext: {} }, normalizeCodexModel: (value) => value,
    sendRpc: f.rpc, transportRunning: () => true, runForTask: () => null,
    knownRolloutPath: async () => "",
    preserveProbeTitle: async (target) => {
      const title = await f.naming.preserveProbeTitle(target);
      if (++preservation === 2) restored(title);
    },
  });
  await service.startContextProbe("rotated");
  const nameIndex = f.calls.findIndex((call) => call.method === "thread/name/set");
  const probeIndex = f.calls.findIndex((call) => call.method === "turn/start");
  assert.ok(nameIndex >= 0 && nameIndex < probeIndex);
  assert.equal(f.calls[nameIndex].params.name, "Хаб — Поток 1");
  assert.equal(f.names.get("rotated"), CODEX_CONTEXT_PROBE_RESPONSE);
  assert.equal(await service.waitForContextProbeIdle({ provider: "codex", threadId: "rotated" }, "probe-turn", {
    quietMs: 1, pollMs: 1, timeoutMs: 100,
  }), true);
  assert.equal(await restoredTitle, "Хаб — Поток 1");
  assert.equal(f.names.get("rotated"), "Хаб — Поток 1");
  assert.ok(f.calls.filter((call) => call.method === "thread/read")
    .every((call) => call.options.timeoutMs === 1_000));
});

// Новый Thread ротации пробуется ещё до привязки к Stream. Он получает имя из
// привязки исходного Thread раньше пробы, но ничего не закрепляет за собой:
// у Thread, который может оказаться неготовым, нет своего сохранённого имени.
test("an unbound rotation target is named from its source Stream before the probe without pinning", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Хаб" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id });
  f.catalog.bindThread({ provider: "codex", threadId: "source", streamId: stream.id, projectRoot: f.root, source: "rebirth" });
  const service = createCodexContextMaintenanceComposition({
    config: { components: {}, codexRolloutContext: {} }, normalizeCodexModel: (value) => value,
    sendRpc: f.rpc, transportRunning: () => true, runForTask: () => null,
    knownRolloutPath: async () => "",
    preserveProbeTitle: f.naming.preserveProbeTitle,
  });

  await service.startContextProbe("unbound-target", { titleSourceThreadId: "source" });

  const nameIndex = f.calls.findIndex((call) => (
    call.method === "thread/name/set" && call.params.threadId === "unbound-target"
  ));
  const probeIndex = f.calls.findIndex((call) => call.method === "turn/start");
  assert.ok(nameIndex >= 0 && nameIndex < probeIndex, "новый Thread ушёл в пробу без имени");
  assert.equal(f.calls[nameIndex].params.name, "Хаб — Поток 1");
  assert.ok(!f.metadata.pinnedTitle({ provider: "codex", threadId: "unbound-target" }));
  assert.ok(!f.catalog.thread({ provider: "codex", threadId: "unbound-target" }));

  const count = f.calls.length;
  assert.equal(await f.naming.preserveProbeTitle({ threadId: "unbound-other" }), "");
  assert.equal(await f.naming.preserveProbeTitle({ threadId: "unbound-other", titleSourceThreadId: "missing" }), "");
  assert.equal(f.calls.length, count);
});

for (const failedMethod of ["thread/read", "thread/name/set"]) {
  test(`${failedMethod} naming failure does not prevent the context probe`, async (t) => {
    const f = await fixture(t);
    const workspace = f.catalog.createWorkspace({ name: "Хаб" });
    const stream = f.catalog.createStream({ workspaceId: workspace.id });
    f.catalog.bindThread({ provider: "codex", threadId: "created", streamId: stream.id, source: "created" });
    const naming = createHubThreadNamingService({
      workspaceCatalog: f.catalog, taskMetadata: f.metadata, saveTitles: async () => {}, saveState: async () => {},
      sendRpc: async (method, params, options) => {
        if (method === failedMethod) throw new Error("Optional naming failed");
        return f.rpc(method, params, options);
      },
    });
    const service = createCodexContextMaintenanceComposition({
      config: { components: {}, codexRolloutContext: {} }, normalizeCodexModel: (value) => value,
      sendRpc: f.rpc, preserveProbeTitle: naming.preserveProbeTitle, logger: { warn: () => {} },
    });
    assert.equal((await service.startContextProbe("created")).turn.id, "probe-turn");
  });
}

test("probe naming preserves explicit names and does not rename foreign or merely discovered threads", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Хаб" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id });
  for (const [threadId, source] of [["managed", "created"], ["external", "discovered"]]) {
    f.catalog.bindThread({ provider: "codex", threadId, streamId: stream.id, projectRoot: f.root, source });
  }
  f.names.set("managed", "Моё точное название");
  assert.equal(await f.naming.preserveProbeTitle({ threadId: "managed" }), "Моё точное название");
  f.names.set("managed", CODEX_CONTEXT_PROBE_RESPONSE);
  assert.equal(await f.naming.preserveProbeTitle({ threadId: "managed" }), "Моё точное название");
  const count = f.calls.length;
  assert.equal(await f.naming.preserveProbeTitle({ threadId: "external" }), "");
  assert.equal(await f.naming.preserveProbeTitle({ threadId: "foreign" }), "");
  assert.equal(f.calls.length, count);
});
