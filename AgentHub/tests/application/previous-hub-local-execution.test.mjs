import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { HubRuntimeStateCoordinator } from "../../src/application/hub-runtime-state-coordinator.mjs";
import { ProviderRunTerminalStore } from "../../src/infrastructure/persistence/provider-run-terminal-store.mjs";
import { TaskRunRegistry, persistedLocalExecutionIdentity, serializableTaskRun } from "../../src/domain/task-runs.mjs";
import { restorePersistedTaskRun, createRuntimeStateRestorationComposition } from "../../src/composition/runtime-state-restoration-composition.mjs";
import { CodexEventService } from "../../src/providers/codex/codex-event-service.mjs";
import { RuntimeStateStore, readRuntimeState } from "../../src/infrastructure/persistence/runtime-state-store.mjs";

const savedRun = (extra = {}) => ({ id: "saved-run", provider: "codex", threadId: "original-thread",
  turnId: "original-turn", streamId: "stream", clientUserMessageId: "original-client",
  projectRoot: "D:/owned", status: "running", activityUnknown: true, executionOwner: "hub",
  responseText: "Retained partial", startedAt: "2026-11-18T10:00:00.000Z", ...extra });
const proof = () => ({ kind: "previous-hub-local-execution", source: "canonical-runtime-snapshot", restoredAt: new Date().toISOString() });

for (const extra of [{}, { provider: "claude" }, { observer: true, executionOwner: "external" }, { turnId: null, clientUserMessageId: null }]) {
  test(`previous local snapshot is retained without provider completion or admission (${JSON.stringify(extra)})`, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-local-custody-"));
    try {
      const saved = savedRun(extra);
      const identity = persistedLocalExecutionIdentity(saved);
      const store = new ProviderRunTerminalStore({ dataDir });
      const record = await store.recordLocalExecutionRetirement({ identity, proof: proof() });
      const reopened = new ProviderRunTerminalStore({ dataDir });
      assert.deepEqual(reopened.getLocalExecutionRetirement(identity), record);
      if (saved.turnId) assert.equal(reopened.get(saved), null, "local disposition cannot manufacture provider terminal");
      const registry = new TaskRunRegistry();
      const restored = restorePersistedTaskRun(saved, null, reopened);
      registry.addRestored(restored, saved);
      assert.equal(registry.size, 0);
      assert.equal(registry.forTask(saved), null);
      assert.equal(registry.retainedValues().length, 1);
      assert.equal(restored.responseText, saved.responseText);
      assert.equal(restored.providerTerminalStatus, saved.providerTerminalStatus);
      assert.equal(restored.turnId, saved.turnId);
      const current = savedRun({ provider: saved.provider, id: "fresh-run", turnId: "fresh-turn", clientUserMessageId: "fresh-client" });
      registry.add(current);
      assert.equal(registry.forTask(saved), current);
      assert.equal(registry.forEvent({ turnId: saved.turnId }), saved.turnId ? restored : null);
      assert.equal(registry.releaseLocalAdmission(current, { identity: persistedLocalExecutionIdentity(current), proof: proof() }), false);
      assert.equal(registry.forTask(current), current, "a current process run has no restored custody provenance");
      const again = await reopened.recordLocalExecutionRetirement({ identity, proof: proof() });
      assert.deepEqual(again, record, "cold replay retains exact original disposition");
      assert.throws(() => reopened.getLocalExecutionRetirement({ ...identity, threadId: "foreign" }), /identity changed/u);
    } finally { await rm(dataDir, { recursive: true, force: true }); }
  });
}

test("failed local disposition persistence cannot manufacture provider terminal or a release proof", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-local-write-refusal-"));
  let blocker;
  try {
    const saved = savedRun();
    const store = new ProviderRunTerminalStore({ dataDir, mutationTimeoutMs: 100 });
    const identity = persistedLocalExecutionIdentity(saved);
    assert.equal(store.getLocalExecutionRetirement(identity), null);
    blocker = new DatabaseSync(path.join(dataDir, "runtime.sqlite"));
    blocker.exec("BEGIN IMMEDIATE");
    await assert.rejects(store.recordLocalExecutionRetirement({ identity, proof: proof() }), /locked|busy|timed out/iu);
    blocker.exec("ROLLBACK");
    assert.equal(store.getLocalExecutionRetirement(identity), null);
    assert.equal(store.get(saved), null);
    assert.equal(saved.responseText, "Retained partial");
  } finally { blocker?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test("a failed required local disposition aborts restoration without writing empty state", async () => {
  const saved = { activeRuns: [savedRun()], queuedInputs: [{ id: "original-queue", temporaryFiles: ["retained.png"] }] };
  let writes = 0;
  const failure = Object.assign(new Error("local disposition write refused"), { code: "ERR_LOCAL_EXECUTION_RETIREMENT" });
  const owner = new HubRuntimeStateCoordinator({
    store: { load: async () => ({ value: saved }), save: async () => { writes++; } },
    canonicalize: value => value, restoreSnapshot: async () => { throw failure; }, createSnapshot: () => ({}),
  });
  await assert.rejects(owner.restore(), error => error === failure);
  assert.equal(writes, 0);
  assert.equal(saved.activeRuns[0].id, "saved-run");
  assert.deepEqual(saved.queuedInputs[0].temporaryFiles, ["retained.png"]);
});

function eventPorts(registry, saveState) {
  const noop = () => {};
  const names = ["invalidateThreadRead", "applyThreadSettings", "trackTokenUsage", "mutateCompaction",
    "taskKey", "isSelectedRun", "setSelectedDiff", "appendActivity", "noteActivity", "scheduleProgress",
    "appendReasoning", "isCompactionItem", "upsertReasoningBlock", "replaceActivityGroups", "turnActivityGroups",
    "contextUsage", "beginCompaction", "settleCompactionTurn", "rememberRawCompactionItem", "beginCompactionCleanup",
    "setStage", "describeItem", "itemActivity", "requestApproval", "formatCommandApproval", "formatFileApproval",
    "formatPermissionsApproval", "requestMcpElicitation", "discardContextCompaction", "requestUserInput",
    "reduceLiveItemEvent", "startLiveItem", "completeLiveItem", "consumeTracker", "finishObserved", "turnSnapshot",
    "completeManaged", "observeMcpProgress", "observeHubMcpBridge"];
  return { ...Object.fromEntries(names.map(name => [name, noop])),
    forEvent: reference => registry.forEvent(reference), reindexRun: run => registry.reindex(run),
    saveState, getCompaction: () => null, turnTokenUsage: new Map() };
}

function restoreContext(taskRuns) {
  const noop = () => {};
  const owner = { restore: noop };
  return { taskRuns, selectionStore: { snapshot: () => ({ threadIds: {} }), restore: noop },
    findProject: () => null, taskMetadata: owner, preferences: owner,
    statusMediaFileIds: new Map(), runJournal: { restoreLastMessages: noop },
    lastSeenTaskTurnIds: new Map(), codexUsageTracker: owner, contextCompactions: owner,
    codexTurnStarts: new Map(), codexTerminalAudit: owner,
    turnEndNotifications: { restore: () => ({}) }, dismissedExternalTasks: owner,
    cancelledManagedClaudeTasks: new Map(), pendingInputs: new Map(), queuedInputs: new Map(),
    desktopMessageReceipts: owner, updateDeferredDesktopReceipt: noop, forwardBundles: new Map() };
}

for (const [partition, extra] of [
  ["legacy", {}],
  ["observer", { observer: true, executionOwner: "external" }],
  ["pre-ACK", { providerStart: { state: "requesting", turnId: null,
    clientUserMessageId: "original-client", requestedAt: "2026-11-18T10:00:00.000Z", acceptedAt: null } }],
  ["pre-ACK without turn", { turnId: null, providerStart: { state: "requesting", turnId: null,
    clientUserMessageId: "original-client", requestedAt: "2026-11-18T10:00:00.000Z", acceptedAt: null } }],
  ["modern", { providerStart: { state: "observed", turnId: "original-turn",
    clientUserMessageId: "original-client", requestedAt: "2026-11-18T10:00:00.000Z",
    acceptedAt: "2026-11-18T10:00:00.000Z" } }],
]) {
  test(`late exact ${partition} acceptance preserves full local custody through SQLite snapshot and reopen`, async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-local-late-"));
    const runtime = new RuntimeStateStore({ dataDir });
    try {
      await runtime.load();
      const saved = savedRun(extra);
      const original = persistedLocalExecutionIdentity(saved);
      const store = new ProviderRunTerminalStore({ dataDir });
      const disposition = await store.recordLocalExecutionRetirement({ identity: original, proof: proof() });
      const old = restorePersistedTaskRun(saved, null, store);
      const registry = new TaskRunRegistry();
      registry.addRestored(old, saved);
      const current = savedRun({ id: "fresh-run", turnId: null, clientUserMessageId: "fresh-client",
        providerStart: { state: "requesting", turnId: null, clientUserMessageId: "fresh-client",
          requestedAt: "2026-11-19T10:00:00.000Z", acceptedAt: null } });
      registry.add(current);
      const writes = [];
      const events = new CodexEventService(eventPorts(registry, () => {
        const write = runtime.save({ activeProvider: "codex", activeRuns: registry.retainedValues().map(serializableTaskRun),
          queuedInputs: [{ id: "retained-queue", clientUserMessageId: "same-original", temporaryFiles: ["retained.png"] }] });
        writes.push(write);
        return write;
      }));
      await events.handle({ method: "turn/started", params: { threadId: saved.threadId,
        turn: { id: saved.turnId ?? "late-unbound-old-turn" }, clientUserMessageId: saved.clientUserMessageId,
        startedAtMs: Date.parse("2026-11-18T10:00:00.000Z") } });
      await Promise.all(writes);
      assert.equal(registry.forTask(saved), current);
      assert.equal(current.turnId, null);
      assert.equal(old.localAdmissionReleased, true);
      assert.equal(old.providerStart.acceptedAt, saved.turnId ? "2026-11-18T10:00:00.000Z" : null,
        "retain exact late telemetry; an unbound old callback cannot acquire a turn");
      assert.deepEqual(persistedLocalExecutionIdentity(old), original);
      // The provider can refine the recorded start time after local retirement.
      old.startedAt = "2026-11-18T10:00:03.457Z";
      await runtime.save({ activeRuns: registry.retainedValues().map(serializableTaskRun),
        queuedInputs: [{ id: "retained-queue", clientUserMessageId: "same-original", temporaryFiles: ["retained.png"] }] });
      const snapshot = await readRuntimeState(dataDir);
      const captured = snapshot.activeRuns.find(run => run.id === old.id);
      assert.equal(captured.providerStart.acceptedAt, old.providerStart.acceptedAt);
      assert.deepEqual(snapshot.queuedInputs[0].temporaryFiles, ["retained.png"]);
      for (let reopen = 0; reopen < 2; reopen++) {
        const reopened = new ProviderRunTerminalStore({ dataDir });
        const identity = persistedLocalExecutionIdentity(captured);
        assert.deepEqual(identity, original);
        assert.deepEqual(await reopened.recordLocalExecutionRetirement({ identity, proof: proof() }), disposition);
        const restored = restorePersistedTaskRun(captured, null, reopened);
        const nextRegistry = new TaskRunRegistry();
        const composition = await createRuntimeStateRestorationComposition({
          config: { dataDir, deferredInputTtlHours: 24 }, projects: [], maximumDeferredInputs: 100,
          runtimeStateStore: runtime, canonicalizeProjectRoots: value => value,
          restoreContext: restoreContext(nextRegistry), snapshotContext: {},
        });
        assert.equal(composition.stateLoadFailed, false, "actual restoration accepts late snapshot");
        assert.equal(nextRegistry.size, 0);
        assert.ok(nextRegistry.retainedValues().some(run => run.id === old.id));
        assert.equal(nextRegistry.retainedValues().find(run => run.id === old.id).startedAt, old.startedAt);
        assert.equal(restored.responseText, "Retained partial");
        assert.equal(reopened.get({ ...saved, turnId: saved.turnId ?? "late-unbound-old-turn" }), null,
          "late start is not a provider terminal");
      }
      for (const key of ["id", "provider", "threadId", "turnId", "clientUserMessageId", "streamId"]) {
        const foreign = structuredClone(captured);
        foreign[key] = key === "provider" ? "claude" : "changed-binding";
        assert.throws(() => persistedLocalExecutionIdentity(foreign), /identity changed/u);
      }
      const forgedTimes = structuredClone(captured);
      forgedTimes.localExecutionRetirement.identity.startedAt = captured.startedAt;
      assert.throws(() => store.getLocalExecutionRetirement(persistedLocalExecutionIdentity(forgedTimes)), /identity changed/u);
      assert.deepEqual(store.getLocalExecutionRetirement(original), disposition);
      await runtime.save({ activeRuns: [{ ...captured, streamId: "changed-binding" }] });
      await assert.rejects(createRuntimeStateRestorationComposition({
        config: { dataDir, deferredInputTtlHours: 24 }, projects: [], maximumDeferredInputs: 100,
        runtimeStateStore: runtime, canonicalizeProjectRoots: value => value,
        restoreContext: restoreContext(new TaskRunRegistry()), snapshotContext: {},
      }), error => error.code === "ERR_LOCAL_EXECUTION_RETIREMENT");
      assert.equal((await readRuntimeState(dataDir)).activeRuns[0].streamId, "changed-binding",
        "identity refusal cannot silently overwrite the saved snapshot");

      await events.handle({ method: "turn/started", params: { threadId: current.threadId,
        turn: { id: "unknown-foreign-turn" }, clientUserMessageId: "unrelated-command" } });
      assert.equal(current.turnId, null, "an unrelated late callback cannot adopt current input");
      await events.handle({ method: "turn/started", params: { threadId: current.threadId,
        turn: { id: "fresh-turn" }, clientUserMessageId: current.clientUserMessageId,
        startedAtMs: Date.parse("2026-11-19T10:00:01.000Z") } });
      await Promise.all(writes);
      assert.equal(current.turnId, "fresh-turn");
      assert.equal(current.providerStart.acceptedAt, "2026-11-19T10:00:01.000Z");
      assert.equal(current.localAdmissionReleased, false);
      assert.equal(registry.forTask(saved), current);
      assert.equal(registry.releaseLocalAdmission(current, { identity: persistedLocalExecutionIdentity(current), proof: proof() }), false);
    } finally { await runtime.close(); await rm(dataDir, { recursive: true, force: true }); }
  });
}
