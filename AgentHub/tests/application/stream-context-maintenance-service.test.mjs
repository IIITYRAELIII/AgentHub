import assert from "node:assert/strict";
import test from "node:test";

import { DeferredInputStore } from "../../src/application/deferred-input-store.mjs";
import { retargetTelegramClientSelections } from "../../src/application/client-task-selection-service.mjs";
import {
  contextUsagePercent,
  StreamContextMaintenanceService,
} from "../../src/application/stream-context-maintenance-service.mjs";
import { StreamMaintenanceRegistry } from "../../src/application/stream-maintenance-registry.mjs";
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
  preliminaryProvisional = false,
  probePercent = afterPercent,
  probeFails = false,
  rotationProbePercent = 6,
  rotationProbeFails = false,
  rotationProbeNotStarted = false,
  rotationCompletionStatus = "completed",
  rotationCompletionMissing = false,
  autoCompact = true,
  observedCompaction = false,
  observedAfterPercent = null,
  observedMeasurementStatus = "",
  sourceIdle = true,
  probeIdle = true,
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
  let compaction = observedCompaction ? {
    id: "compact-observed",
    origin: "automatic",
    status: "completed",
    turnId: source.turnId,
    completedAt: "2026-08-07T09:59:00.000Z",
    ...(observedAfterPercent !== null ? {
      afterPercent: observedAfterPercent,
      measurementStatus: "completed",
    } : {}),
    ...(observedMeasurementStatus ? { measurementStatus: observedMeasurementStatus } : {}),
  } : null;
  const provider = {
    compactions: {
      isRunning: (threadId) => externalCompacting && threadId === source.threadId,
      get: (threadId) => threadId === source.threadId ? compaction : null,
      annotate: (...args) => {
        events.push(["annotate", ...args]);
        if (compaction?.id === args[1]) compaction = { ...compaction, ...args[2] };
      },
      waitForSettlement: async (...args) => {
        events.push(["settled", ...args, registry.isActive(source)]);
        return { status: "completed" };
      },
    },
    start: async (...args) => {
      events.push(["compact", ...args, registry.isActive(source)]);
      return { accepted: true, compactionId: "compact-1" };
    },
    startManual: async () => ({ accepted: true, compactionId: "manual-1" }),
    probeContext: async (...args) => {
      events.push(["probe", ...args, registry.isActive(source)]);
      const target = args[0];
      const afterRotation = target?.threadId === "thread-new";
      if (afterRotation && rotationProbeNotStarted) {
        throw Object.assign(new Error("probe never started"), { code: "CODEX_CONTEXT_PROBE_NOT_STARTED" });
      }
      if (probeFails || (afterRotation && rotationProbeFails)) throw new Error("probe timed out");
      return {
        threadId: target.threadId,
        turnId: afterRotation ? "rotation-probe-1" : "probe-1",
        status: "completed",
      };
    },
    waitForContextProbeIdle: async (...args) => {
      events.push(["probe-idle", ...args, registry.isActive(source)]);
      return args[1] === source.turnId ? sourceIdle : probeIdle;
    },
    rotate: async () => ({ compactionId: "manual-1", thread: { id: "thread-new" } }),
    rotateCompacted: async (...args) => {
      events.push([
        "rotate",
        ...args,
        registry.isActive(source),
        registry.entry(source)?.reason,
      ]);
      return {
        accepted: true,
        sourceThreadId: "thread-old",
        compactionId: "compact-1",
        thread: { id: "thread-new" },
      };
    },
    discardCompactionTransfer: (...args) => events.push(["discard", ...args]),
    discardRotationTarget: async (...args) => events.push(["discard-target", ...args]),
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
      const probeTarget = events.filter(([name]) => name === "probe").at(-1)?.[1];
      const probeStarted = Boolean(probeTarget);
      const afterRotation = probeTarget?.threadId === "thread-new";
      events.push(["usage", ...args]);
      return {
        usedTokens: afterRotation ? rotationProbePercent : probeStarted ? probePercent : afterPercent,
        modelContextWindow: 100,
        provisional: probeStarted ? false : preliminaryProvisional,
        updatedAt: probeStarted
          ? "2026-08-07T10:02:00.000Z"
          : "2026-08-07T10:01:00.000Z",
      };
    },
    waitForTurnCompletion: async (...args) => {
      events.push(["turn-completed", ...args]);
      if (args[0] === "rotation-probe-1") {
        if (rotationCompletionMissing) return null;
        return { turnId: args[0], status: rotationCompletionStatus };
      }
      return { turnId: args[0], status: "completed" };
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
  return { clientSelections, deferredInputs, events, registry, service, source };
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
  state.service.provider.waitForContextProbeIdle = provider.waitForContextProbeIdle.bind(provider);
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
  state.service.provider.waitForContextProbeIdle = () => new Promise((resolve) => { finishIdle = resolve; });
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
  assert.equal(state.events.some(([name]) => name === "probe" || name === "rotate"), false);
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
    probeContext: async () => {
      events.push(["claude-probe"]);
      return { turnId: "probe-1" };
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
    probeContext: async () => {
      events.push(["codex-probe"]);
      return { turnId: "probe-1" };
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
      // Предварительное значение ненадёжно, поэтому провайдер без собственного
      // замера обязан продолжить скрытым ходом.
      return { usedTokens: 10, modelContextWindow: 100, provisional: !measuresContextItself };
    },
    waitForTurnCompletion: async () => ({ status: "completed" }),
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

test("Claude reports its own context after compaction, so no hidden probe runs", async () => {
  const { events, registry, service, target } = claudeFixture();
  await service.compact(target);
  while (registry.isActive(target)) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some(([name]) => name === "claude-probe"), false);
  assert.equal(events.some(([name]) => name === "codex-probe"), false);
  assert.equal(events.some(([name]) => name === "context-update"), false);
});

test("a provider without its own measurement still gets the hidden probe", async () => {
  const { events, registry, service, target } = claudeFixture({ measuresContextItself: false });
  await service.compact(target);
  while (registry.isActive(target)) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some(([name]) => name === "claude-probe"), true);
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
  assert.equal(state.events.some(([name]) => name === "probe"), false);
});

test("exact probe terminal settlement wins over lagging activity state", async () => {
  const state = fixture({
    beforePercent: 86,
    afterPercent: 55,
    preliminaryProvisional: true,
    probePercent: 7,
    probeIdle: false,
    rotate: false,
  });
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);

  assert.equal(Math.round(result.afterPercent), 7);
  assert.equal(state.events.filter(([name]) => name === "probe").length, 1);
  assert.equal(state.events.find(([name]) => name === "probe").at(-1), true);
  assert.equal(state.events.filter(([name]) => name === "turn-completed").length, 1);
  assert.equal(state.events.some(([name, _target, turnId]) => (
    name === "probe-idle" && turnId === "probe-1"
  )), false);
  assert.equal(
    state.events.filter(([name]) => name === "usage").at(-1).at(-1).turnId,
    "probe-1",
  );
  assert.deepEqual(state.events.filter(([name]) => name === "annotate").at(-1).at(-1), {
    afterPercent: 7,
    measurementStatus: "completed",
  });
});

test("zero-token probe measurement remains unknown", async () => {
  const state = fixture({
    beforePercent: 86,
    afterPercent: 55,
    preliminaryProvisional: true,
    probePercent: 0,
    rotate: false,
  });
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);

  assert.equal(result.afterPercent, null);
  assert.deepEqual(state.events.filter(([name]) => name === "annotate").at(-1).at(-1), {
    afterPercent: null,
    measurementStatus: "failed",
  });
});

test("failed post-compaction measurement stays unknown and prevents rotation", async () => {
  const state = fixture({
    beforePercent: 80,
    afterPercent: 55,
    preliminaryProvisional: true,
    probeFails: true,
  });
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);

  assert.equal(result.compacted, true);
  assert.equal(result.rotated, false);
  assert.equal(result.afterPercent, null);
  assert.equal(state.events.some(([name]) => name === "rotate"), false);
  assert.deepEqual(state.events.filter(([name]) => name === "annotate").at(-1).at(-1), {
    afterPercent: null,
    measurementStatus: "failed",
  });
});

test("rotation reuses the completed compaction and retargets the blocked queue", async () => {
  const state = fixture({ beforePercent: 80, afterPercent: 21 });
  state.deferredInputs.put({
    id: "queued-1",
    provider: "codex",
    streamId: "stream-1",
    threadId: "thread-old",
    projectRoot: "D:/Work",
    taskTitle: "Workspace",
  }, "queued");
  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);

  assert.equal(result.rotated, true);
  assert.equal(state.events.filter(([name]) => name === "compact").length, 1);
  assert.equal(state.events.filter(([name]) => name === "rotate").length, 1);
  assert.equal(state.events.find(([name]) => name === "rotate").at(-2), true);
  assert.equal(
    state.events.find(([name]) => name === "rotate").at(-1),
    "automatic-rotation",
  );
  const rotationProbe = state.events.find(([name, target]) => (
    name === "probe" && target.threadId === "thread-new"
  ));
  assert.equal(rotationProbe.at(-1), true);
  assert.equal(
    state.events.find(([name, threadId]) => name === "usage" && threadId === "thread-new").at(-1).turnId,
    "rotation-probe-1",
  );
  assert.equal(
    state.events.findIndex(([name]) => name === "wake")
      > state.events.findIndex(([name, target]) => name === "probe" && target.threadId === "thread-new"),
    true,
  );
  assert.equal(state.deferredInputs.get("queued-1").threadId, "thread-new");
  assert.equal(state.clientSelections.get("telegram:42").threadId, "thread-new");
  assert.equal(state.clientSelections.get("telegram:43").threadId, "thread-other");
  assert.equal(state.clientSelections.get("desktop:7").threadId, "thread-old");
  assert.equal(state.events.some(([name, id]) => name === "wake" && id === "queued-1"), true);
  assert.equal(state.registry.isActive(state.source), false);
});

test("manual rotation retargets the active Telegram task binding", async () => {
  const state = fixture();
  await state.service.rotate(state.source);
  assert.deepEqual(state.clientSelections.get("telegram:42"), {
    streamId: "stream-1",
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "thread-new",
    taskTitle: "Workspace",
  });
  assert.equal(
    state.events.some(([name, target]) => name === "probe" && target.threadId === "thread-new"),
    true,
  );
});

function queueForSource(state, id) {
  state.deferredInputs.put({
    id,
    provider: "codex",
    streamId: "stream-1",
    threadId: "thread-old",
    projectRoot: "D:/Work",
    taskTitle: "Workspace",
  }, "queued");
}

function assertSourceStaysAuthoritative(state, queuedId) {
  assert.equal(state.events.some(([name]) => name === "bind"), false, "неготовый Thread привязан к Stream");
  assert.equal(state.events.some(([name]) => name === "select"), false, "неготовый Thread стал выбранным");
  assert.equal(state.deferredInputs.get(queuedId).threadId, "thread-old", "очередь переназначена на неготовый Thread");
  assert.equal(state.clientSelections.get("telegram:42").threadId, "thread-old");
  assert.equal(state.events.some(([name, , , details]) => name === "annotate" && details?.rotated), false);
  assert.equal(state.events.some(([name, id]) => name === "wake" && id === queuedId), true, "очередь источника не разбужена");
  assert.equal(state.registry.isActive(state.source), false);
}

test("an unconfirmed post-rotation probe keeps the source authoritative and quarantines the new Thread", async () => {
  const state = fixture({ rotationProbeFails: true });
  queueForSource(state, "queued-unknown");

  await assert.rejects(state.service.rotate(state.source), /Готовность нового Thread не подтверждена/u);

  assertSourceStaysAuthoritative(state, "queued-unknown");
  assert.equal(state.events.some(([name]) => name === "discard-target"), false, "Thread с неизвестным исходом удалён");
  const settled = state.events.find(([name, , , details]) => name === "annotate" && details?.rotationStatus);
  assert.equal(settled[2], "manual-1");
  assert.equal(settled[3].rotationStatus, "unknown");
  assert.equal(settled[3].rotationQuarantineThreadId, "thread-new");
  assert.ok(Number.isFinite(Date.parse(settled[3].rotationSettledAt)));
  assert.ok(state.events.findIndex(([name]) => name === "save") > state.events.indexOf(settled));
});

test("a probe that never started is a definite failure: the new Thread is deleted", async () => {
  const state = fixture({ rotationProbeNotStarted: true });
  queueForSource(state, "queued-failed");

  await assert.rejects(state.service.rotate(state.source), /не прошёл проверку готовности и удалён/u);

  assertSourceStaysAuthoritative(state, "queued-failed");
  assert.deepEqual(state.events.find(([name]) => name === "discard-target"), ["discard-target", "thread-new"]);
  const settled = state.events.find(([name, , , details]) => name === "annotate" && details?.rotationStatus);
  assert.equal(settled[3].rotationStatus, "failed");
  assert.equal(settled[3].rotationQuarantineThreadId, undefined);
});

for (const [name, options, expectedStatus] of [
  ["a probe turn that ends with an error", { rotationCompletionStatus: "failed" }, "failed"],
  ["a probe turn whose completion is never observed", { rotationCompletionMissing: true }, "unknown"],
  ["a completed probe without an exact measurement", { rotationProbePercent: 0 }, "unknown"],
]) {
  test(`automatic rotation stops before switching on ${name}`, async () => {
    const state = fixture({ afterPercent: 28, ...options });
    queueForSource(state, "queued-automatic");
    assert.equal(state.service.reserveAfterTurn(state.source), true);

    const result = await state.service.maintainAfterTurn(state.source);

    assert.equal(result.compacted, true);
    assert.equal(result.rotated, false);
    assert.equal(result.rotationStatus, expectedStatus);
    assertSourceStaysAuthoritative(state, "queued-automatic");
    assert.equal(
      state.events.some(([event]) => event === "discard-target"),
      expectedStatus === "failed",
    );
  });
}

test("a compaction whose rotation already settled unsuccessfully is not rotated again", async () => {
  const state = fixture({
    observedCompaction: true,
    observedAfterPercent: 28,
    rotationProbeFails: true,
    autoCompact: false,
  });
  assert.equal(state.service.reserveAfterTurn(state.source), true);
  const first = await state.service.maintainAfterTurn(state.source);
  assert.equal(first.rotated, false);
  assert.equal(first.rotationStatus, "unknown");
  assert.equal(state.events.filter(([name]) => name === "rotate").length, 1);

  assert.equal(state.service.reserveAfterTurn(state.source), false, "неудачная ротация свёртки повторяется");
  assert.equal(state.events.filter(([name]) => name === "rotate").length, 1);
});

for (const mode of ["manual", "automatic", "observed"]) {
  test(`${mode} rotation switches once, only after a ready probe of the new Thread`, async () => {
    const state = fixture({
      afterPercent: 28,
      observedCompaction: mode === "observed",
      observedAfterPercent: 28,
    });
    let bind;
    state.service.workspaceCatalog.bindThread = (value) => {
      state.events.push(["bind", value]);
      return new Promise((resolve) => { bind = resolve; });
    };
    const snapshots = [];
    let finishSave;
    state.service.saveState = () => {
      snapshots.push({
        active: state.registry.isActive(state.source),
        annotations: structuredClone(state.events.filter(([name]) => name === "annotate")),
      });
      return snapshots.length === 1 ? new Promise((resolve) => { finishSave = resolve; }) : Promise.resolve();
    };
    if (mode !== "manual") assert.equal(state.service.reserveAfterTurn(state.source), true);
    const result = mode === "manual"
      ? state.service.rotate(state.source)
      : state.service.maintainAfterTurn(state.source);

    await waitFor(() => typeof bind === "function");
    const probeIndex = state.events.findIndex(([name, target]) => name === "probe" && target.threadId === "thread-new");
    const bindIndex = state.events.findIndex(([name]) => name === "bind");
    assert.ok(probeIndex >= 0 && probeIndex < bindIndex, "новый Thread привязан раньше проверки готовности");
    assert.equal(
      state.events.find(([name, target]) => name === "probe" && target.threadId === "thread-new")[1].titleSourceThreadId,
      "thread-old",
    );
    assert.equal(state.events.some(([name, , , details]) => name === "annotate" && details?.rotated), false);

    bind();
    await waitFor(() => typeof finishSave === "function");
    const rotations = snapshots[0].annotations.filter(([, , , details]) => details?.rotated);
    assert.equal(rotations.length, 1);
    const [, , operationId, details] = rotations[0];
    assert.equal(operationId, mode === "manual" ? "manual-1" : mode === "observed" ? "compact-observed" : "compact-1");
    assert.equal(details.rotationThreadId, "thread-new");
    assert.equal(details.rotationAfterPercent, 6);
    assert.equal(details.rotationProbeTurnId, "rotation-probe-1");
    assert.equal(details.rotationMeasuredAt, "2026-08-07T10:02:00.000Z");
    assert.ok(Number.isFinite(Date.parse(details.rotationCompletedAt)));
    assert.equal(state.registry.isActive(state.source), true);

    finishSave();
    await result;
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0].active, true);
    assert.equal(state.events.filter(([name]) => name === "bind").length, 1);
    assert.equal(state.registry.isActive(state.source), false);
  });

  test(`${mode} failed binding cannot report a completed rotation`, async () => {
    const state = fixture({ afterPercent: 28, observedCompaction: mode === "observed", observedAfterPercent: 28 });
    state.service.workspaceCatalog.bindThread = async () => { throw new Error("binding failed"); };
    state.service.logger = { error() {} };
    if (mode === "manual") {
      await assert.rejects(state.service.rotate(state.source), /binding failed/);
    } else {
      state.service.reserveAfterTurn(state.source);
      assert.equal((await state.service.maintainAfterTurn(state.source)).error, "binding failed");
    }
    assert.equal(state.events.some(([name, , , details]) => name === "annotate" && details.rotated), false);
    assert.equal(state.events.some(([name]) => name === "save"), false);
    assert.equal(state.registry.isActive(state.source), false);
  });
}

test("manual rotation without a returned compaction identity never annotates another operation", async () => {
  const state = fixture({ observedCompaction: true, observedAfterPercent: 28 });
  state.service.provider.rotate = async () => ({ thread: { id: "thread-new" } });
  await state.service.rotate(state.source);
  assert.equal(state.events.some(([name]) => name === "annotate"), false);
});

test("a mid-turn compaction rotates only after completion and transfers that whole turn", async () => {
  const state = fixture({
    beforePercent: 31,
    observedCompaction: true,
    observedAfterPercent: 28,
    autoCompact: false,
  });

  assert.equal(state.service.reserveAfterTurn(state.source), true);
  const result = await state.service.maintainAfterTurn(state.source);

  assert.equal(result.compacted, true);
  assert.equal(result.rotated, true);
  assert.equal(result.deferredRotation, true);
  assert.equal(state.events.some(([name]) => name === "compact"), false);
  assert.deepEqual(state.events.find(([name]) => name === "rotate")[2], {
    compactionId: "compact-observed",
    settlement: {
      id: "compact-observed",
      origin: "automatic",
      status: "completed",
      turnId: "turn-1",
      completedAt: "2026-08-07T09:59:00.000Z",
      afterPercent: 28,
      measurementStatus: "completed",
    },
    includeTurnId: "turn-1",
  });
  assert.equal(state.events.find(([name]) => name === "rotate").at(-1), "automatic-rotation");
  assert.equal(state.service.reserveAfterTurn(state.source), false);
});

test("a mid-turn compaction does not rotate when the finished turn stays at the boundary", async () => {
  const state = fixture({
    beforePercent: 31,
    observedCompaction: true,
    observedAfterPercent: 20,
    autoCompact: false,
  });

  state.service.reserveAfterTurn(state.source);
  const result = await state.service.maintainAfterTurn(state.source);

  assert.equal(result.rotated, false);
  assert.equal(result.afterPercent, 20);
  assert.equal(state.events.some(([name]) => name === "rotate"), false);
  assert.equal(state.events.some(([name]) => name === "discard"), true);
});

test("rotation uses the compaction-end context instead of the final turn context", async () => {
  const state = fixture({
    beforePercent: 31,
    observedCompaction: true,
    observedAfterPercent: 9,
    autoCompact: false,
  });

  assert.equal(state.service.reserveAfterTurn(state.source), true);
  const result = await state.service.maintainAfterTurn(state.source);

  assert.equal(result.rotated, false);
  assert.equal(result.afterPercent, 9);
  assert.equal(state.events.some(([name]) => name === "usage"), false);
  assert.equal(state.events.some(([name]) => name === "probe"), false);
  assert.equal(state.events.some(([name]) => name === "rotate"), false);
  assert.equal(state.events.some(([name]) => name === "discard"), true);
  assert.equal(state.registry.isActive(state.source), false);
});
