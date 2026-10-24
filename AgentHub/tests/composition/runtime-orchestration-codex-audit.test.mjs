import assert from "node:assert/strict";
import test from "node:test";
import { importCompositionWithPorts, boundPort } from "../helpers/composition-ports.fixture.mjs";
import { providerApplicationFixture } from "../helpers/provider-application.fixture.mjs";

test("runtime orchestration actually schedules and persists Codex terminal audit", async () => {
  const jobs = [];
  const events = [];
  const timers = { schedule: (_name, callback) => { jobs.push(callback); return true; } };
  const wiring = await importCompositionWithPorts(
    new URL("../../src/composition/provider-runtime-wiring-composition.mjs", import.meta.url), {
      "./run-observation-composition.mjs": { createRunObservationComposition: () => ({}) },
    });
  const { createRuntimeOrchestrationComposition } = await importCompositionWithPorts(
    new URL("../../src/composition/runtime-orchestration-composition.mjs", import.meta.url), {
      "./provider-runtime-wiring-composition.mjs": { createProviderRuntimeWiring: wiring.createProviderRuntimeWiring },
      "./runtime-timers-composition.mjs": { createRuntimeTimersComposition: () => ({}) },
      "./task-interaction-wiring-composition.mjs": { createTaskInteractionWiring: () => ({}) },
      "./runtime-restart-wiring-composition.mjs": { createRuntimeRestartWiring: () => ({ runtimeResources: {} }) },
    });
  const providerRuntime = boundPort();
  const hostState = { stopping: false };
  createRuntimeOrchestrationComposition({
    config: { components: {} }, constants: { terminalAuditIntervalMs: 30_000 },
    state: { hostState, saveState: async () => events.push("persist") },
    runtime: { runtimeTimers: timers },
    provider: { hubThreadNaming: {}, codexTransport: { running: true },
      codexTerminalAudit: { persistsProgress: false, hasPendingHistoricalMaintenance: () => false,
        run: async () => { events.push("audit"); return true; } } },
    tasks: {}, clients: {}, persistence: { workLogUsageStore: { recordAutomaticBatchAndProject() {} } }, lifecycle: {},
    ports: { providerRuntime, taskInteraction: boundPort(), runtimeRestart: boundPort() },
  });
  providerRuntime.value.scheduleCodexTerminalAudit(0);
  assert.equal(jobs.length, 1, "terminal audit must be enabled by the real orchestration defaults");
  await jobs.shift()();
  assert.deepEqual(events, ["audit", "persist"]);
  hostState.stopping = true;
  await jobs.shift()();
  assert.deepEqual(events, ["audit", "persist"], "stopping must prevent another provider audit");
});

test("historical accounting backfill is idle only with no active run and no deferred message", async (t) => {
  const f = await providerApplicationFixture(t);
  const readIdle = f.inputs.createCodexObservabilityComposition.isHistoricalBackfillIdle;
  assert.equal(readIdle(), true);
  f.runs.push({ id: "active-run", status: "running", provider: "codex" });
  assert.equal(readIdle(), false);
  f.runs.length = 0;
  f.deferred.push({ id: "queued-original" });
  assert.equal(readIdle(), false);
  f.deferred.length = 0;
  assert.equal(readIdle(), true);
  await f.inputs.createCodexObservabilityComposition.saveState();
  assert.deepEqual(f.events, [["save"]]);
});

test("observability checkpoints await the shared state save and propagate its failure", async () => {
  const gate = Promise.withResolvers();
  let writes = 0;
  const { createCodexObservabilityComposition } = await importCompositionWithPorts(
    new URL("../../src/composition/codex-observability-composition.mjs", import.meta.url), {
      "../providers/codex/codex-terminal-audit.mjs": { CodexTerminalAudit: class {
        constructor(options) { this.checkpoint = () => options.persistProgress?.(); }
      } },
    });
  const observer = createCodexObservabilityComposition({
    config: { codexRolloutContext: { scanIntervalSeconds: 1 } },
    saveState: async () => { writes += 1; await gate.promise; throw new Error("state write rejected"); },
  });
  let settled = false;
  const checkpoint = Promise.resolve(observer.terminalAudit.checkpoint());
  void checkpoint.then(() => { settled = true; }, () => { settled = true; });
  try {
    await Promise.resolve();
    assert.equal(writes, 1);
    assert.equal(settled, false, "audit checkpoint must not acknowledge before the state owner settles");
  } finally { gate.resolve(); }
  await assert.rejects(checkpoint, /state write rejected/u);
});
