import assert from "node:assert/strict";
import test from "node:test";

import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";
import { retargetTelegramClientSelections } from "../../src/application/client-task-selection-service.mjs";
import {
  contextUsagePercent,
  StreamContextMaintenanceService,
} from "../../src/application/stream-context-maintenance-service.mjs";
import { StreamMaintenanceRegistry } from "../../src/application/stream-maintenance-registry.mjs";
import { ContextCompactionTracker } from "../../src/providers/codex/context-compaction-tracker.mjs";
import { CodexContextMaintenanceService } from "../../src/providers/codex/codex-context-maintenance-service.mjs";

async function waitFor(predicate, attempts = 200) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("ожидаемое состояние не наступило");
}

function fixture({
  beforePercent = 80,
  afterPercent = 18,
  rotate = true,
  externalCompacting = false,
  estimateAvailable = true,
  rotationFails = false,
  autoCompact = true,
  observedCompaction = false,
  observedAfterPercent = null,
  sourceIdle = true,
} = {}) {
  const events = [];
  const registry = new StreamMaintenanceRegistry();
  const deferredInputs = new DeferredInputStore();
  const clientSelections = new Map([
    ["telegram:42", {
      streamId: "stream-1", provider: "codex", projectRoot: "D:/Work", threadId: "thread-old", taskTitle: "Workspace",
    }],
    ["telegram:43", {
      streamId: "stream-2", provider: "codex", projectRoot: "D:/Work", threadId: "thread-other", taskTitle: "Other",
    }],
    ["desktop:7", {
      streamId: "stream-1", provider: "codex", projectRoot: "D:/Work", threadId: "thread-old", taskTitle: "Workspace",
    }],
  ]);
  const sessionState = {
    clientTaskSelectionsSnapshot: () => [...clientSelections.entries()].map(([key, value]) => [key, structuredClone(value)]),
    setClientTaskSelection: (clientId, value) => clientSelections.set(clientId, structuredClone(value)),
  };
  const source = {
    provider: "codex",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "thread-old",
    taskTitle: "Workspace",
    status: "finishing",
    turnId: "turn-1",
  };
  const tracker = new ContextCompactionTracker();
  const newCompaction = (origin = "automatic", percent = null) => {
    const record = tracker.begin(source.threadId, { origin, turnId: source.turnId });
    tracker.complete(source.threadId, { turnId: source.turnId });
    if (percent !== null) tracker.observeContext({
      threadId: source.threadId, turnId: source.turnId, usedTokens: percent,
      modelContextWindow: 100, provisional: true, updatedAt: new Date().toISOString(),
    });
    return record.id;
  };
  if (observedCompaction) newCompaction("automatic", observedAfterPercent);
  const provider = {
    compactions: {
      isRunning: (threadId) => externalCompacting && threadId === source.threadId,
      get: (threadId) => tracker.get(threadId),
      observeContext: (context) => tracker.observeContext(context),
      annotate: (...args) => { events.push(["annotate", ...args]); return tracker.annotate(...args); },
      waitForSettlement: async (...args) => {
        events.push(["settled", ...args, registry.isActive(source)]);
        tracker.complete(args[0], { turnId: source.turnId });
        return tracker.get(args[0]);
      },
    },
    start: async (...args) => {
      events.push(["compact", ...args, registry.isActive(source)]);
      const record = tracker.begin(source.threadId, { origin: "automatic", turnId: source.turnId });
      return { accepted: true, compactionId: record.id };
    },
    startManual: async () => {
      const record = tracker.begin(source.threadId, { origin: "manual", turnId: source.turnId });
      return { accepted: true, compactionId: record.id };
    },
    waitForTurnIdle: async (...args) => {
      events.push(["turn-idle", ...args, registry.isActive(source)]);
      return sourceIdle;
    },
    rotate: async () => ({ compactionId: "manual-1", thread: { id: "thread-new" } }),
    rotateCompacted: async (...args) => {
      events.push([
        "rotate",
        ...args,
        registry.isActive(source),
        registry.entry(source)?.reason,
      ]);
      if (rotationFails) throw new Error("new Thread readiness failed");
      return {
        accepted: true,
        sourceThreadId: "thread-old",
        compactionId: "compact-1",
        thread: { id: "thread-new" },
      };
    },
    discardCompactionTransfer: (...args) => events.push(["discard", ...args]),
  };
  const selectionStore = {
    threadId: "thread-old",
    setThread: (...args) => events.push(["select", ...args]),
  };
  const workspaceCatalog = {
    thread: ({ threadId }) => threadId === "thread-old"
      ? { provider: "codex", threadId, streamId: "stream-1", projectRoot: "D:/Work" }
      : null,
    stream: (id) => id === "stream-1" ? { id, workspaceId: "workspace-1" } : null,
    workspace: (id) => id === "workspace-1" ? { id, name: "Workspace" } : null,
    bindThread: (value) => events.push(["bind", value]),
  };
  const service = new StreamContextMaintenanceService({
    registry,
    provider,
    latestContextUsage: () => ({
      usedTokens: beforePercent,
      modelContextWindow: 100,
      updatedAt: "2026-08-07T10:00:00.000Z",
    }),
    waitForContextUpdate: async (...args) => {
      events.push(["usage", ...args]);
      return estimateAvailable ? {
        threadId: source.threadId, turnId: source.turnId, usedTokens: afterPercent,
        modelContextWindow: 100, provisional: true, updatedAt: new Date().toISOString(),
      } : null;
    },
    workspaceCatalog,
    selectionStore,
    deferredInputs,
    invalidateCatalog: () => events.push(["invalidate"]),
    retargetClientSelections: (binding) => retargetTelegramClientSelections(sessionState, binding),
    saveState: async () => events.push(["save"]),
    scheduleDeferred: (item) => events.push(["wake", item.id]),
    autoCompactEnabled: () => autoCompact,
    autoCompactThreshold: () => 75,
    autoRotateEnabled: () => rotate,
    autoRotateThreshold: () => 20,
  });
  return { clientSelections, deferredInputs, events, registry, service, source, tracker };
}

test("hung post-turn rollout read releases maintenance and wakes the original queued input", async () => {
  const state = fixture({ beforePercent: 90 });
  const queued = { id: "queued-after-terminal", streamId: state.source.streamId,
    provider: state.source.provider, threadId: state.source.threadId,
    clientUserMessageId: "original-client-id", prompt: "next message" };
  state.deferredInputs.put(queued, "queued");
  const originalInput = structuredClone(state.deferredInputs.get(queued.id));
  let finishRead;
  let reads = 0;
  const blocked = new Promise((resolve) => { finishRead = resolve; });
  const provider = new CodexContextMaintenanceService({
    knownRolloutPath: async () => "rollout.jsonl",
    readRolloutActivity: () => { reads += 1; return blocked; },
  });
  // Use the real provider deadline and the production post-turn timeout.
  state.service.provider.waitForTurnIdle = provider.waitForTurnIdle.bind(provider);
  const errors = [];
  state.service.logger = { error: (...args) => errors.push(args) };
  assert.equal(state.service.reserveAfterTurn(state.source), true);
  const other = { ...state.source, streamId: "other-stream", threadId: "other-thread" };
  const otherReservation = state.registry.begin(other);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result.compacted, false);
  assert.match(result.error, /rollout-activity/);
  assert.equal(errors.length, 1);
  assert.equal(state.registry.isActive(state.source), false);
  assert.equal(state.registry.isActive(other), true);
  assert.deepEqual(state.deferredInputs.get(queued.id), originalInput);
  assert.equal(state.events.filter(([name, id]) => name === "wake" && id === queued.id).length, 1);
  assert.equal(state.events.some(([name]) => name === "compact" || name === "rotate"), false);
  finishRead({ running: false });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 1);
  assert.equal(state.events.some(([name]) => name === "compact" || name === "rotate"), false);
  state.registry.end(otherReservation);
});

test("cancelling preparation wakes once and late idle read cannot start work or release a replacement", async () => {
  const state = fixture();
  state.deferredInputs.put({ id: "queued-cancel", streamId: state.source.streamId,
    provider: state.source.provider, threadId: state.source.threadId, prompt: "next" }, "queued");
  let finishIdle;
  state.service.provider.waitForTurnIdle = () => new Promise((resolve) => { finishIdle = resolve; });
  assert.equal(state.service.reserveAfterTurn(state.source), true);
  const old = state.registry.entry(state.source);
  assert.equal(old.phase, "preparing");
  const maintaining = state.service.maintainAfterTurn(state.source);
  assert.equal(state.service.cancelPreparing(state.source).accepted, true);
  assert.equal(state.service.cancelPreparing(state.source), null);
  const current = state.registry.begin({ ...state.source, turnId: "turn-next" }, "automatic-post-turn");
  finishIdle(true);
  assert.equal((await maintaining).cancelled, true);
  assert.equal(state.registry.entry(state.source), current);
  assert.equal(state.events.some(([name]) => name === "compact"), false);
  assert.deepEqual(state.events.filter(([name]) => name === "wake"), [["wake", "queued-cancel"]]);
});

test("provider start owns maintenance before awaiting acceptance and cannot be cancelled as preparation", async () => {
  const state = fixture();
  let finishStart;
  state.service.provider.start = () => new Promise((resolve) => { finishStart = resolve; });
  state.service.reserveAfterTurn(state.source);
  const maintaining = state.service.maintainAfterTurn(state.source);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.registry.entry(state.source).phase, "starting");
  assert.equal(state.service.cancelPreparing(state.source).accepted, false);
  assert.equal(state.registry.isActive(state.source), true);
  finishStart({ accepted: false, message: "Provider rejected compaction" });
  assert.equal((await maintaining).reason, "Provider rejected compaction");
  assert.equal(state.registry.isActive(state.source), false);
});

test("provider compaction failure releases its reservation and wakes the original input", async () => {
  const state = fixture();
  state.service.logger = { error() {} };
  state.service.provider.compactions.waitForSettlement = async () => ({ status: "failed" });
  state.deferredInputs.put({ id: "queued-failure", streamId: state.source.streamId,
    provider: state.source.provider, threadId: state.source.threadId, prompt: "next" }, "queued");
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result.compacted, false);
  assert.equal(state.registry.isActive(state.source), false);
  assert.deepEqual(state.events.filter(([name]) => name === "wake"), [["wake", "queued-failure"]]);
  assert.equal(state.events.some(([name]) => name === "rotate"), false);
});

function claudeFixture({ measuresContextItself = true, settlementStatus = "completed" } = {}) {
  const events = [];
  const registry = new StreamMaintenanceRegistry();
  const target = {
    provider: "claude",
    projectRoot: "D:/Work",
    streamId: "stream-1",
    threadId: "claude-thread",
    taskTitle: "Workspace",
  };
  let running = false;
  const claude = {
    measuresContextItself,
    compactions: {
      isRunning: (threadId) => running && threadId === target.threadId,
      get: () => null,
      annotate: (...args) => events.push(["annotate", ...args]),
      waitForSettlement: async (...args) => {
        events.push(["settled", ...args]);
        return { status: settlementStatus };
      },
    },
    startManual: async (...args) => {
      events.push(["claude-compact", ...args]);
      running = true;
      return { accepted: true, compactionId: "claude-compaction-1" };
    },
  };
  const codex = {
    compactions: {
      isRunning: () => false,
      get: () => null,
      annotate: () => {},
      waitForSettlement: async () => null,
    },
    start: async () => ({ accepted: false }),
    startManual: async (...args) => {
      events.push(["codex-compact", ...args]);
      return { accepted: true, compactionId: "codex-compaction-1" };
    },
    rotate: async () => ({ thread: { id: "thread-new" } }),
    rotateCompacted: async () => ({ accepted: true }),
    discardCompactionTransfer: () => {},
  };
  const service = new StreamContextMaintenanceService({
    registry,
    provider: codex,
    providers: { claude },
    latestContextUsage: (threadId, provider) => {
      events.push(["usage-request", threadId, provider]);
      return { usedTokens: 82, modelContextWindow: 100, updatedAt: "2026-08-27T10:00:00.000Z" };
    },
    waitForContextUpdate: async () => {
      events.push(["context-update"]);
      return { usedTokens: 10, modelContextWindow: 100, provisional: !measuresContextItself };
    },
    workspaceCatalog: { thread: () => null, stream: () => null, workspace: () => null, bindThread: () => {} },
    selectionStore: { threadId: target.threadId, setThread: () => {} },
    deferredInputs: new DeferredInputStore(),
    invalidateCatalog: () => {},
    saveState: async () => {},
  });
  return { events, registry, service, target, setRunning: (value) => { running = value; } };
}

test("manual compaction of a Claude Stream goes to its own provider", async () => {
  const { events, service, target } = claudeFixture();
  const started = await service.compact(target);
  assert.equal(started.accepted, true);
  assert.equal(started.compactionId, "claude-compaction-1");
  assert.deepEqual(events.find(([name]) => name === "usage-request"), ["usage-request", "claude-thread", "claude"]);
  assert.equal(events.some(([name]) => name === "claude-compact"), true);
  assert.equal(events.some(([name]) => name === "codex-compact"), false);
});

test("Claude reports its own context after compaction without extra requests", async () => {
  const { events, registry, service, target } = claudeFixture();
  await service.compact(target);
  while (registry.isActive(target)) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some(([name]) => name === "context-update"), false);
});

test("thread rebirth stays unavailable for Claude", async () => {
  const { service, target } = claudeFixture();
  await assert.rejects(() => service.rotate(target), /недоступно для этого провайдера/u);
});

test("an active Claude compaction blocks new input for that Stream", async () => {
  const { service, target, setRunning } = claudeFixture();
  assert.equal(service.isActive(target), false);
  setRunning(true);
  assert.equal(service.isActive(target), true);
});

test("an unknown provider cannot request compaction", async () => {
  const { service } = claudeFixture();
  await assert.rejects(
    () => service.compact({ provider: "gemini", threadId: "x" }),
    /недоступна для этого провайдера/u,
  );
});

test("context usage percentage uses the current model window", () => {
  assert.equal(contextUsagePercent({ usedTokens: 75, modelContextWindow: 100 }), 75);
  assert.equal(contextUsagePercent({ usedTokens: 7, modelContextWindow: 100 }), 7);
  assert.equal(contextUsagePercent({ usedTokens: 1, modelContextWindow: 0 }), null);
});

test("external Codex compaction blocks new input before Hub owns a reservation", () => {
  const state = fixture({ externalCompacting: true });
  assert.equal(state.registry.isActive(state.source), false);
  assert.equal(state.service.isActive(state.source), true);
  assert.equal(state.service.isActive({ ...state.source, provider: "claude" }), false);
});

test("post-turn automation ignores non-terminal observation cleanup", () => {
  const state = fixture();
  state.source.status = "running";
  assert.equal(state.service.reserveAfterTurn(state.source), false);
  assert.equal(state.registry.isActive(state.source), false);
});

test("post-turn automation can reacquire ownership for a failed terminal-save retry", () => {
  const state = fixture({ beforePercent: 90 });
  state.source.status = "completed";

  assert.equal(state.service.reserveAfterTurn(state.source), true);
  assert.equal(state.registry.isActive(state.source), true);
});

test("post-turn automation does not block input below the compaction threshold", () => {
  const state = fixture({ beforePercent: 17 });

  assert.equal(state.service.reserveAfterTurn(state.source), false);
  assert.equal(state.registry.isActive(state.source), false);
});

test("post-turn automation cannot consume another run's reservation", async () => {
  const state = fixture({ beforePercent: 90 });
  state.source.id = "run-owner";
  assert.equal(state.service.reserveAfterTurn(state.source), true);

  const recoveredInternalRun = {
    ...state.source,
    id: "run-recovered",
    turnId: "turn-compaction",
  };
  assert.equal(await state.service.maintainAfterTurn(recoveredInternalRun), null);
  assert.equal(state.registry.isActive(state.source), true);
  assert.equal(state.events.some(([name]) => name === "compact"), false);

  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result.compacted, true);
  assert.equal(state.registry.isActive(state.source), false);
});

test("post-turn reservation rollback releases only its exact owner and unblocks manual rotation", async () => {
  const state = fixture({ beforePercent: 90 });
  state.source.id = "run-owner";
  assert.equal(state.service.reserveAfterTurn(state.source), true);

  assert.equal(state.service.cancelAfterTurn({ ...state.source, id: "run-other" }), false);
  assert.equal(state.registry.isActive(state.source), true);
  assert.equal(state.service.cancelAfterTurn(state.source), true);
  assert.equal(state.registry.isActive(state.source), false);

  const rotated = await state.service.rotate(state.source);
  assert.equal(rotated.thread.id, "thread-new");
  assert.equal(state.registry.isActive(state.source), false);
});

test("post-turn automation waits for the completed writer to become idle", async () => {
  const state = fixture({ beforePercent: 90, sourceIdle: false });
  state.service.reserveAfterTurn(state.source);

  const result = await state.service.maintainAfterTurn(state.source);

  assert.deepEqual(result, {
    compacted: false,
    deferred: true,
    reason: "turn-still-active",
  });
  assert.equal(state.events.some(([name]) => name === "compact"), false);
  assert.equal(state.registry.isActive(state.source), false);
});

test("post-turn automation does not compact at the exact threshold", async () => {
  const state = fixture({ beforePercent: 75 });
  assert.equal(state.service.reserveAfterTurn(state.source), false);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result, null);
  assert.equal(state.events.some(([name]) => name === "compact"), false);
  assert.equal(state.registry.isActive(state.source), false);
});

test("post-turn automation compacts once and does not rotate below 20 percent", async () => {
  const state = fixture({ beforePercent: 80, afterPercent: 20 });
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result.compacted, true);
  assert.equal(result.rotated, false);
  assert.equal(state.events.filter(([name]) => name === "compact").length, 1);
  assert.equal(
    state.events.find(([name]) => name === "compact")[2].beforePercent,
    80,
  );
  assert.equal(state.events.some(([name]) => name === "rotate"), false);
  assert.equal(state.events.some(([name]) => name === "discard"), true);
});

for (const afterPercent of [0, 19, 20, 21, 34]) {
  test(`preliminary estimate ${afterPercent}% alone controls threshold rotation`, async () => {
    const state = fixture({ afterPercent });
    assert.equal(state.service.reserveAfterTurn(state.source), true);
    const result = await state.service.maintainAfterTurn(state.source);
    assert.equal(result.afterPercent, afterPercent);
    assert.equal(result.rotated, afterPercent > 20);
    assert.equal(state.events.filter(([name]) => name === "bind").length, afterPercent > 20 ? 1 : 0);
    assert.equal(state.tracker.get(state.source.threadId).measurementKind, "estimated");
    assert.equal(state.registry.isActive(state.source), false);
  });
}

test("missing estimate stays unknown and never rotates", async () => {
  const state = fixture({ estimateAvailable: false });
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result.afterPercent, null);
  assert.equal(result.rotated, false);
  assert.equal(state.tracker.get(state.source.threadId).measurementStatus, "failed");
  assert.equal(state.events.some(([name]) => name === "bind"), false);
});

test("native mid-turn estimate is retained until terminal; later usage does not control rotation", async () => {
  const state = fixture({ observedCompaction: true, observedAfterPercent: 34, beforePercent: 10 });
  state.source.status = "running";
  assert.equal(state.service.reserveAfterTurn(state.source), false);
  state.source.status = "finishing";
  assert.equal(state.service.reserveAfterTurn(state.source), true);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result.rotated, true);
  assert.equal(result.afterPercent, 34);
  assert.equal(state.events.some(([name]) => name === "compact"), false);
  assert.equal(state.events.find(([name]) => name === "rotate")[2].includeTurnId, "turn-1");
});

test("rotation failure keeps old binding and remains visible on completed compaction", async () => {
  const state = fixture({ afterPercent: 34, rotationFails: true });
  state.service.logger = { error() {} };
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);
  assert.equal(result.compacted, true);
  assert.equal(result.rotated, false);
  assert.equal(state.events.some(([name]) => name === "bind"), false);
  assert.equal(state.tracker.get(state.source.threadId).rotationStatus, "failed");
  assert.match(state.tracker.get(state.source.threadId).rotationMessage, /readiness/);
});

for (const mode of ["automatic", "manual"]) {
  test(`${mode} rotation retargets queue and clients without a measurement request on new Thread`, async () => {
    const state = fixture({ afterPercent: 34 });
    state.deferredInputs.put({ id: "pending", streamId: "stream-1", threadId: "thread-old", prompt: "continue" }, "queued");
    if (mode === "automatic") {
      state.service.reserveAfterTurn(state.source);
      await state.service.maintainAfterTurn(state.source);
    } else await state.service.rotate(state.source);
    assert.equal(state.events.filter(([name]) => name === "bind").length, 1);
    assert.equal(state.deferredInputs.get("pending").threadId, "thread-new");
    assert.equal(state.clientSelections.get("telegram:42").threadId, "thread-new");
    assert.equal(state.clientSelections.get("telegram:43").threadId, "thread-other");
    assert.equal(state.events.some(([name, id]) => name === "usage" && id === "thread-new"), false);
  });
}

test("manual compaction records preliminary estimate without a generated turn", async () => {
  const state = fixture({ afterPercent: 26 });
  await state.service.compact(state.source);
  await waitFor(() => !state.registry.isActive(state.source));
  const record = state.tracker.get(state.source.threadId);
  assert.equal(record.afterPercent, 26);
  assert.equal(record.measurementKind, "estimated");
  assert.equal(state.events.some(([name]) => name === "bind"), false);
});
