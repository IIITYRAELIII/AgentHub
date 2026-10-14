import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { WorkspaceCatalogStore } from "../../src/infrastructure/persistence/workspace-catalog-store.mjs";
import { TaskMetadataStore } from "../../src/application/task-metadata-store.mjs";
import { createHubThreadNamingService, workspaceProviderThreadTitle } from "../../src/application/hub-thread-naming-service.mjs";
import { CodexProviderTaskService } from "../../src/providers/provider-task-service.mjs";
import { ClaudeProviderTaskService } from "../../src/providers/provider-task-service.mjs";
import { CodexTurnService } from "../../src/providers/provider-turn-services.mjs";
import { StreamContextMaintenanceService } from "../../src/application/stream-context-maintenance-service.mjs";
import { StreamMaintenanceRegistry } from "../../src/application/stream-maintenance-registry.mjs";
import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";
import { ContextCompactionTracker } from "../../src/providers/codex/context-compaction-tracker.mjs";
import { createWorkspaceCatalogMutationOwner } from "../../src/application/sqlite-mutation-owner.mjs";
import { createHash } from "node:crypto";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub-thread-naming-"));
  const catalog = new WorkspaceCatalogStore({ databaseFile: path.join(root, "journal.sqlite") });
  await catalog.load();
  const metadata = new TaskMetadataStore();
  const names = new Map();
  const calls = [];
  const closeables = [];
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
  t.after(async () => { closeables.forEach((close) => close()); catalog.close(); await rm(root, { recursive: true, force: true }); });
  return { catalog, metadata, names, calls, rpc, naming, root, closeables };
}

test("created Codex provider thread is named from its durable Workspace and Stream before its first message", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  for (const explicitName of [null, "Кролик"]) {
    const stream = f.catalog.createStream({ workspaceId: workspace.id, name: explicitName });
    const state = { streamId: stream.id };
    const service = new CodexProviderTaskService({
      selection: { get streamId() { return state.streamId; },
        get threadId() { return state.threadId; },
        setThread: (id) => { state.threadId = id; }, setTitle: (title) => { state.title = title; } },
      transportRunning: () => true, startTransport: async () => {}, initialize: async () => {}, sendRpc: f.rpc,
      bindCreatedThread: (value) => f.catalog.bindThread({ ...value, source: "created" }),
      nameCreatedThread: f.naming.nameCreatedThread, activeProjectRoot: () => f.root,
      sandboxMode: () => "workspace-write", invalidateCatalog: () => {}, restoreSettings: () => {},
      updateSettings: async () => {}, clearLatestDiff: () => {}, saveState: async () => {},
    });
    const result = await service.createTask();
    const expected = explicitName ? "Проект - Кролик 1" : "Проект - Поток 1 1";
    assert.equal(result.title, expected);
    assert.equal(f.names.get(result.threadId), expected);
    assert.equal(f.metadata.pinnedTitle({ provider: "codex", threadId: result.threadId }), expected);
    assert.equal(state.title, expected);
    assert.equal(f.calls.some((call) => call.method === "turn/start"), false);
    assert.equal(f.calls.some((call) => call.method === "thread/name/set" && /Telegram|AGENT_HUB_CONTEXT_PROBE/u.test(call.params.name)), false);
  }
  assert.equal(workspaceProviderThreadTitle(workspace, { id: "opaque-stream-uuid", ordinal: 3 }, 4), "Проект - Поток 3 4");
  assert.equal(workspaceProviderThreadTitle(workspace, { id: "explicit", name: "Stream 7", ordinal: 3 }, 4), "Проект - Stream 7 4");
});

for (const stage of ["first-state-save", "settings"]) {
test(`bound Thread is named when ${stage} fails, without masking that failure`, async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "S8" });
  const state = { streamId: stream.id };
  const failure = new Error(`${stage} rejected`);
  let saves = 0;
  const service = new CodexProviderTaskService({
    selection: { get streamId() { return state.streamId; },
      get threadId() { return state.threadId; },
      setThread: (id) => { state.threadId = id; }, setTitle: (title) => { state.title = title; } },
    transportRunning: () => true, startTransport: async () => {}, initialize: async () => {}, sendRpc: f.rpc,
    bindCreatedThread: (value) => f.catalog.bindThread({ ...value, source: "created" }),
    nameCreatedThread: f.naming.nameCreatedThread, activeProjectRoot: () => f.root,
    sandboxMode: () => "workspace-write", invalidateCatalog: () => {}, restoreSettings: () => {},
    updateSettings: async () => { if (stage === "settings") throw failure; }, clearLatestDiff: () => {},
    saveState: async () => { if (++saves === 1 && stage === "first-state-save") throw failure; },
  });
  await assert.rejects(service.createTask(), (error) => error === failure);
  assert.equal(f.names.get(state.threadId), "Проект - S8 1");
  assert.equal(state.title, "Проект - S8 1");
  assert.equal(f.catalog.threadsForStream(stream.id).length, 1);
});
}

test("setup and naming failures remain separately observable on the exact bound Thread", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "S8" });
  const setupError = new Error("settings rejected");
  const namingError = new Error("name unavailable");
  const state = { streamId: stream.id };
  const service = new CodexProviderTaskService({
    selection: { get streamId() { return state.streamId; }, get threadId() { return state.threadId; },
      setThread: (id) => { state.threadId = id; }, setTitle() {} },
    transportRunning: () => true, startTransport: async () => {}, initialize: async () => {}, sendRpc: f.rpc,
    bindCreatedThread: (value) => f.catalog.bindThread({ ...value, source: "created" }),
    nameCreatedThread: async () => { throw namingError; }, activeProjectRoot: () => f.root,
    sandboxMode: () => "workspace-write", invalidateCatalog() {}, restoreSettings() {},
    updateSettings: async () => { throw setupError; }, clearLatestDiff() {}, saveState: async () => {},
  });
  await assert.rejects(service.createTask(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [setupError, namingError]);
    return true;
  });
  assert.equal(f.catalog.threadNaming({ provider: "codex", threadId: state.threadId }).status, "pending");
  assert.equal(f.catalog.threadsForStream(stream.id).length, 1);
});

test("rotation still names its bound target after projection save fails and reports that exact failure", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "S8" });
  const source = { provider: "codex", threadId: "source", streamId: stream.id };
  f.catalog.bindThread(source);
  const failure = new Error("projection save rejected");
  const selected = { threadId: source.threadId, setThread(id, options) { this.threadId = id; this.title = options.title; } };
  const service = new StreamContextMaintenanceService({
    registry: new StreamMaintenanceRegistry(), workspaceCatalog: f.catalog, selectionStore: selected,
    nameCreatedThread: f.naming.nameCreatedThread, deferredInputs: new DeferredInputStore(),
    saveState: async () => { throw failure; },
    provider: { start: async () => assert.fail("manual rotation must not compact"),
      rotateCompacted: async () => assert.fail("manual rotation must not use automatic rotation"),
      rotate: async () => ({ thread: { id: "target" } }) },
    invalidateCatalog() {}, logger: { error() {} },
  });
  await assert.rejects(service.rotate(source), (error) => error === failure);
  assert.equal(f.names.get("target"), "Проект - S8 2");
  assert.equal(selected.title, "Проект - S8 2");
  assert.equal(f.catalog.threadNaming({ provider: "codex", threadId: "target" }).status, "complete");
  assert.equal(f.catalog.threadsForStream(stream.id).length, 2);
});

test("lost name reply recovers the exact pending binding after reopen, without new start or number", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "S8" });
  const ref = { provider: "codex", threadId: "lost-reply", streamId: stream.id, source: "created" };
  f.catalog.bindThread(ref);
  let offline = true;
  let sets = 0;
  const rpc = async (method, params) => {
    if (method === "thread/name/set") { sets += 1; f.names.set(params.threadId, params.name); throw new Error("lost reply"); }
    if (offline) throw new Error("offline read");
    return f.rpc(method, params);
  };
  const naming = createHubThreadNamingService({ workspaceCatalog: f.catalog, taskMetadata: f.metadata,
    sendRpc: rpc, saveTitles: async () => {}, saveState: async () => {} });
  await assert.rejects(naming.nameCreatedThread(ref), /lost reply/);
  f.catalog.close();
  await f.catalog.load();
  offline = false;
  const reopened = createHubThreadNamingService({ workspaceCatalog: f.catalog, taskMetadata: new TaskMetadataStore(),
    sendRpc: rpc, saveTitles: async () => {}, saveState: async () => {} });
  assert.equal(await reopened.recoverThreadNaming(ref), "Проект - S8 1");
  assert.equal(await reopened.recoverThreadNaming(ref), null);
  assert.equal(sets, 1);
  assert.equal(f.catalog.thread(ref).position, 1);
  assert.equal(f.catalog.threadsForStream(stream.id).length, 1);
  assert.equal(f.calls.some((call) => call.method === "thread/start"), false);
});

test("catalog high-water survives rebind/removal and restart, while binding replay consumes nothing", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "S8" });
  const target = f.catalog.createStream({ workspaceId: workspace.id, name: "Other" });
  const bind = (id) => f.catalog.bindThread({ provider: "codex", threadId: id, streamId: stream.id, source: "created" });
  bind("one"); bind("two");
  f.catalog.rebindThread({ provider: "codex", threadId: "two" }, { streamId: target.id });
  f.catalog.close(); await f.catalog.load();
  assert.equal(bind("three").position, 3);
  assert.equal(bind("three").position, 3);
  assert.equal(bind("four").position, 4);
  assert.deepEqual(f.catalog.threadsForStream(stream.id).map((item) => item.position), [1, 3, 4]);
});

test("known legacy baseline, split and rollback preserve catalog numbering without renaming legacy rows", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "Sirius" });
  const one = { provider: "codex", threadId: "legacy-one", streamId: stream.id, position: 1 };
  const last = { provider: "codex", threadId: "legacy-last", streamId: stream.id, position: 53 };
  f.catalog.bindThread(one); f.catalog.bindThread(last);
  f.catalog.deleteMeta(`thread-position-high-water:${createHash("sha256").update(stream.id).digest("hex")}`);
  f.catalog.moveThreadToNewStream(last, { workspaceId: workspace.id });
  assert.equal(f.catalog.threadNaming(last), null);
  assert.equal(await f.naming.recoverThreadNaming(one), null);
  const reference = { provider: "codex", threadId: "next", streamId: stream.id, source: "created" };
  const setMeta = f.catalog.setMeta.bind(f.catalog);
  f.catalog.setMeta = (key, value) => {
    if (key.startsWith("thread-naming-v1:")) throw new Error("intent write rejected");
    return setMeta(key, value);
  };
  assert.throws(() => f.catalog.bindThread(reference), /intent write rejected/);
  assert.equal(f.catalog.thread(reference), null);
  assert.equal(f.catalog.threadNaming(reference), null);
  f.catalog.setMeta = setMeta;
  assert.equal(f.catalog.bindThread(reference).position, 54);
  assert.equal(f.catalog.threadNaming(reference).title, "Проект - Sirius 54");
  f.catalog.rebindThread(reference, { streamId: f.catalog.thread(last).streamId });
  assert.equal(f.catalog.threadNaming(reference).status, "superseded");
  assert.equal(await f.naming.recoverThreadNaming(reference), null);
  assert.equal(f.calls.length, 0);
});

for (const move of ["rebind", "split"]) {
  for (const boundary of ["initial recovery read", "name acknowledgement", "final name readback"]) {
    test(`${move} during ${boundary} fences superseded naming effects`, async (t) => {
      const f = await fixture(t);
      const catalog = createWorkspaceCatalogMutationOwner(f.catalog);
      const workspace = await catalog.createWorkspace({ name: "Проект" });
      const source = await catalog.createStream({ workspaceId: workspace.id, name: "A" });
      const target = await catalog.createStream({ workspaceId: workspace.id, name: "B" });
      const reference = { provider: "codex", threadId: "moving", streamId: source.id, source: "created" };
      await catalog.bindThread(reference);
      // Keep source alive so its next allocation proves the move retained high-water.
      await catalog.bindThread({ provider: "codex", threadId: "source-keeper", streamId: source.id });
      f.metadata.pinTitle(reference, "custom title");
      f.metadata.expectTitle(reference, "custom expectation");
      const before = f.metadata.snapshot();
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const effects = [];
      const naming = createHubThreadNamingService({ workspaceCatalog: catalog, taskMetadata: f.metadata,
        sendRpc: async (method, params) => {
          if (method === "thread/read") {
            assert.notEqual(boundary, "name acknowledgement", "supersession must fence the next metadata dispatch");
            entered.resolve();
            await release.promise;
            return { thread: { id: params.threadId, name: f.names.get(params.threadId) ?? "" } };
          }
          effects.push({ method, params });
          const result = await f.rpc(method, params);
          if (boundary === "name acknowledgement") {
            entered.resolve();
            await release.promise;
          }
          return result;
        },
        saveTitles: async () => effects.push({ saveTitles: f.metadata.pinnedTitlesSnapshot() }),
        saveState: async () => effects.push({ saveState: true }),
      });
      const pending = boundary === "initial recovery read"
        ? naming.recoverThreadNaming(reference) : naming.nameCreatedThread(reference);
      // Attach rejection before releasing the deliberately delayed RPC.
      const outcome = pending.then(() => null, (error) => error);
      await entered.promise;
      if (move === "rebind") await catalog.rebindThread(reference, { streamId: target.id });
      else await catalog.moveThreadToNewStream(reference, { workspaceId: workspace.id, streamName: "Split" });
      assert.equal(catalog.threadNaming(reference).status, "superseded");
      assert.notEqual(catalog.thread(reference).streamId, source.id);
      const dispatchedBeforeMove = effects.length;
      release.resolve();
      const error = await outcome;
      assert.equal(effects.length, dispatchedBeforeMove);
      assert.equal(effects.filter((effect) => effect.method === "thread/name/set").length,
        boundary === "initial recovery read" ? 0 : 1);
      assert.deepEqual(f.metadata.snapshot(), before);
      assert.equal(error?.code, "HUB_THREAD_NAMING_SUPERSEDED");
      assert.equal(await naming.recoverThreadNaming(reference), null);
      assert.equal(catalog.threadNaming(reference).status, "superseded");
      assert.equal((await catalog.bindThread({ provider: "codex", threadId: "next", streamId: source.id })).position, 3);
    });
  }
}

test("two catalog mutation owners serialize competing allocations and exact replay under a SQLite writer", async (t) => {
  const f = await fixture(t);
  const second = new WorkspaceCatalogStore({ databaseFile: path.join(f.root, "journal.sqlite") });
  await second.load(); f.closeables.push(() => second.close());
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id });
  const owners = [createWorkspaceCatalogMutationOwner(f.catalog), createWorkspaceCatalogMutationOwner(second)];
  const { DatabaseSync } = await import("node:sqlite");
  const writer = new DatabaseSync(path.join(f.root, "journal.sqlite"));
  writer.exec("BEGIN IMMEDIATE");
  const bindings = Array.from({ length: 8 }, (_, index) => ({ provider: "codex",
    threadId: `concurrent-${index}`, streamId: stream.id, source: "created" }));
  const pending = bindings.map((binding, index) => owners[index % 2].bindThread(binding));
  await new Promise((resolve) => setImmediate(resolve));
  writer.exec("COMMIT"); writer.close();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map((item) => item.position).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  const repeated = await owners[1].bindThread(bindings[0]);
  assert.equal(repeated.position, results[0].position);
  assert.equal(f.catalog.threadsForStream(stream.id).length, 8);
  assert.ok(f.catalog.mutationDiagnostics().retries + second.mutationDiagnostics().retries > 0);
});

for (const mode of ["manual", "automatic"]) {
  test(`${mode} rotation uses canonical naming and recovers lost reply on the same target`, async (t) => {
    const f = await fixture(t);
    const workspace = f.catalog.createWorkspace({ name: "Проект" });
    const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "S8" });
    const source = { provider: "codex", threadId: "old", streamId: stream.id, status: "finishing", turnId: "old-turn" };
    f.catalog.bindThread(source);
    const compactions = new ContextCompactionTracker();
    const record = compactions.begin("old", { origin: "automatic", turnId: source.turnId });
    compactions.complete("old", { turnId: source.turnId });
    compactions.annotate("old", record.id, { afterPercent: 34, measurementStatus: "completed", measurementKind: "estimated" });
    let offline = true;
    const naming = createHubThreadNamingService({ workspaceCatalog: f.catalog, taskMetadata: f.metadata,
      sendRpc: async (method, params) => {
        if (method === "thread/name/set") { await f.rpc(method, params); throw new Error("lost name reply"); }
        if (offline) throw new Error("offline metadata");
        return f.rpc(method, params);
      }, saveState: async () => {}, saveTitles: async () => {} });
    let rotations = 0;
    const rotate = async () => { rotations += 1; return { thread: (await f.rpc("thread/start", {})).thread, compactionId: record.id }; };
    const selected = { threadId: "old", setThread(id, options) { this.threadId = id; this.title = options.title; } };
    const deferred = new DeferredInputStore();
    deferred.put({ id: "queued", streamId: stream.id, threadId: "old", prompt: "unchanged" }, "queued");
    const service = new StreamContextMaintenanceService({
      registry: new StreamMaintenanceRegistry(), workspaceCatalog: f.catalog, selectionStore: selected,
      nameCreatedThread: naming.nameCreatedThread, deferredInputs: deferred, saveState: async () => {},
      provider: { compactions, start: async () => assert.fail("already compacted"), rotate, rotateCompacted: rotate,
        waitForTurnIdle: async () => true, discardCompactionTransfer() {} },
      autoRotateEnabled: () => true, autoRotateThreshold: () => 20, latestContextUsage: () => null,
      invalidateCatalog() {}, logger: { error() {} },
    });
    if (mode === "manual") await assert.rejects(service.rotate(source), /lost name reply/);
    else { assert.equal(service.reserveAfterTurn(source), true); assert.equal((await service.maintainAfterTurn(source)).rotated, false); }
    const target = f.catalog.activeThread(stream.id);
    assert.equal(target.position, 2);
    assert.equal(selected.threadId, target.threadId);
    assert.equal(selected.title, "Проект - S8 2");
    assert.equal(deferred.get("queued").taskTitle, "Проект - S8 2");
    assert.equal(f.catalog.threadNaming(target).status, "pending");
    offline = false;
    if (mode === "manual") await service.rotate(source);
    else await naming.recoverThreadNaming(target);
    assert.equal(rotations, 1);
    assert.equal(f.names.get(target.threadId), "Проект - S8 2");
    assert.equal(f.catalog.threadNaming(target).providerRename, "confirmed");
    assert.equal(f.catalog.threadsForStream(stream.id).length, 2);
  });
}

for (const input of ["first user message", '{"kind":"interstream"}', "attached Task first input"]) {
  test(`first input cannot bypass pending native naming: ${input}`, async (t) => {
    const f = await fixture(t);
    const workspace = f.catalog.createWorkspace({ name: "Проект" });
    const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "S8" });
    const ref = { provider: "codex", threadId: "pending-first-input", streamId: stream.id, source: "created" };
    f.catalog.bindThread(ref);
    let launches = 0;
    const service = new CodexTurnService({
      ensureThreadNamed: f.naming.recoverThreadNaming,
      sendRpc: async (_method, params) => { assert.equal(f.names.get(params.threadId), "Проект - S8 1"); launches += 1; return { turn: { id: "turn" } }; },
      sandboxMode: () => "workspace-write", compactionRecycle: () => null, resolvedSkillNames: async () => [],
      reindexRun() {}, saveState: async () => {}, startTyping() {}, scheduleObservedRun() {},
      finishProgress: async () => {}, completeRun: async () => {}, developerInstructions: async () => null,
      readThread: async () => ({ thread: { turns: [{ id: "turn", items: [{ type: "userMessage" }] }] } }),
      speechButtons: new Map(), temporaryFiles: new Map(), turnTokenUsage: new Map(),
    });
    const run = { ...ref, projectRoot: f.root, status: "running", clientUserMessageId: "original-message", collaborationMode: "default", modelId: "fixture-model", reasoningId: "medium" };
    await service.launch(run, input);
    assert.equal(launches, 1);
    assert.equal(run.taskTitle, "Проект - S8 1");
    assert.equal(f.catalog.thread(ref).position, 1);
    assert.equal(f.catalog.threadNaming(ref).status, "complete");
  });
}

test("Claude reserves and names one bound UUID with explicit unsupported native rename", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "C1" });
  const selection = { streamId: stream.id, setThread(id, options) { this.threadId = id; this.title = options.title; } };
  const service = new ClaudeProviderTaskService({ selection, activeProjectRoot: () => f.root,
    bindCreatedThread: (reference) => f.catalog.bindThread({ ...reference, source: "created" }),
    nameCreatedThread: f.naming.nameCreatedThread, saveState: async () => {}, clearLatestDiff() {} });
  const created = await service.createTask();
  assert.equal(created.title, "Проект - C1 1");
  assert.equal(selection.title, created.title);
  assert.equal(f.catalog.threadNaming(created).status, "complete");
  assert.equal(f.catalog.threadNaming(created).providerRename, "unsupported");
  assert.equal(f.calls.length, 1); // Only local pinned-title persistence, never a provider RPC.
  assert.equal(f.calls[0].method, undefined);
});

test("pending creation resumes its bound target instead of issuing another thread/start", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Проект" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "S8" });
  let offline = true;
  const naming = createHubThreadNamingService({ workspaceCatalog: f.catalog, taskMetadata: f.metadata,
    sendRpc: async (method, params) => {
      if (method === "thread/read" && offline) throw new Error("offline name readback");
      return f.rpc(method, params);
    }, saveTitles: async () => {}, saveState: async () => {} });
  const state = { streamId: stream.id };
  const createService = () => new CodexProviderTaskService({
    selection: { get streamId() { return state.streamId; }, get threadId() { return state.threadId; },
      setThread: (id) => { state.threadId = id; }, setTitle: (title) => { state.title = title; } },
    transportRunning: () => true, startTransport: async () => {}, initialize: async () => {}, sendRpc: f.rpc,
    pendingCreatedThread: () => { const active = f.catalog.activeThread(stream.id);
      return active && f.catalog.threadNaming(active)?.status === "pending" ? active : null; },
    bindCreatedThread: (value) => f.catalog.bindThread({ ...value, source: "created" }),
    nameCreatedThread: naming.nameCreatedThread, activeProjectRoot: () => f.root,
    sandboxMode: () => "workspace-write", invalidateCatalog() {}, restoreSettings() {},
    updateSettings: async () => {}, clearLatestDiff() {}, saveState: async () => {},
  });
  await assert.rejects(createService().createTask(), /offline name readback/);
  const original = state.threadId;
  f.catalog.close(); await f.catalog.load();
  state.threadId = null; offline = false;
  const recovered = await createService().createTask();
  assert.equal(recovered.threadId, original);
  assert.equal(recovered.title, "Проект - S8 1");
  assert.equal(f.calls.filter((call) => call.method === "thread/start").length, 1);
  assert.equal(f.catalog.threadsForStream(stream.id).length, 1);
  assert.equal(f.calls.filter((call) => call.method === "thread/name/set").length, 1);
  assert.equal((await createService().createTask()).title, "Проект - S8 2");
});

test("bounded legacy correction preview is read-only, exact, and does not claim native title evidence", async (t) => {
  const f = await fixture(t);
  const workspace = f.catalog.createWorkspace({ name: "Agent HUB" });
  const stream = f.catalog.createStream({ workspaceId: workspace.id, name: "Sirius" });
  const ref = { provider: "codex", threadId: "existing", streamId: stream.id, position: 53 };
  f.catalog.bindThread(ref);
  const revision = f.catalog.revision;
  const [preview] = f.naming.previewThreadNaming([ref]);
  assert.equal(preview.title, "Agent HUB - Sirius 53");
  assert.equal(preview.nativeTitleVerified, false);
  assert.equal(preview.requiresApproval, true);
  assert.deepEqual(preview.command, { name: "task.rename", params: {
    provider: "codex", threadId: "existing", streamId: stream.id, title: "Agent HUB - Sirius 53",
  } });
  assert.equal(f.catalog.revision, revision);
  assert.equal(f.catalog.threadNaming(ref), null);
  assert.equal(f.calls.length, 0);
  assert.throws(() => f.naming.previewThreadNaming(Array(21).fill(ref)), /limited to 20/);
  assert.match(workspaceProviderThreadTitle({ name: "W".repeat(200) }, { id: "s", name: "S".repeat(200) }, 54), / - S+ 54$/);
});
