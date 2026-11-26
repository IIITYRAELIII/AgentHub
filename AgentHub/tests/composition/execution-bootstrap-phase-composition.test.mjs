import assert from "node:assert/strict";
import test from "node:test";
import { importCompositionWithPorts, boundPort } from "../helpers/composition-ports.fixture.mjs";

test("execution phase shares recovery and Telegram with bootstrap and keeps optional backfill abortable", async () => {
  const events = [];
  let bootstrapInput;
  let runtimeInput;
  let telegramInput;
  const resources = { id: "one-resource-registry" };
  const runs = new Map();
  const sends = [];
  const health = { live: true, ready: true, degraded: true, process: { releaseId: "installed" },
    installerCutover: { admissionClosed: false } };
  const bootstrap = boundPort();
  const { createExecutionBootstrapPhase } = await importCompositionWithPorts(
    new URL("../../src/composition/execution-bootstrap-phase-composition.mjs", import.meta.url), {
      "./runtime-orchestration-composition.mjs": { createRuntimeOrchestrationComposition: (input) => {
        runtimeInput = input;
        return { runtimeResources: resources, runRecovery: {
          recoverAll: (...args) => events.push(["recover", ...args]),
        }, stopRuntimeTimers() {}, startRuntimeTimers() {} };
      } },
      "./telegram-runtime-composition.mjs": { createTelegramRuntimeComposition: (input) => {
        telegramInput = input;
        return { pollTelegram: () => events.push(["poll"]) };
      } },
      "./agent-hub-bootstrap-composition.mjs": { createAgentHubBootstrapComposition: (input) => {
        bootstrapInput = input; return { start: () => "ready" };
      } },
    });
  const input = {
    config: { dataDir: import.meta.dirname, components: { telegram: true } }, root: import.meta.dirname,
    runtimeCommandRoot: import.meta.dirname, settings: {},
    selection: { hostState: { stopping: false }, providerTitle: () => "Codex", selectedProjectRoot: () => "project" },
    infrastructure: { hubMcpService: { async call(name, args) {
      sends.push({ name, args });
      return { delivery: { accepted: true } };
    } } },
    provider: { taskRuns: runs, taskCatalog: [],
      codexProviderTasks: { discoverTasks: async () => { events.push(["discover"]); return ["thread-exact"]; } },
      backgroundJobs: { restore: () => events.push(["restore"]) } },
    clients: { codexTransport: { running: false } },
    interaction: { dispatchApplicationCommand: async () => ({}), telegramTaskActions: {}, runCoordinator: {
      startDeferred: (item) => events.push(["deferred", item]),
    } },
    deferred: { ports: { bootstrap }, api: {
      handleDesktopControl: (request) => request.action === "runtime-health" ? health : request,
      prepareStartupCommandAdmission: (options) => events.push(["admission", options.startupTraceId]),
      backfillWorkLogPricingMetadata: (threads, options) => events.push(["pricing", threads, options.propagateErrors]),
    } },
  };
  const result = createExecutionBootstrapPhase(input);
  assert.equal(result.start(), "ready");
  assert.equal(bootstrap.value.start(), "ready");
  assert.equal(bootstrapInput.runtimeResources, resources);
  assert.equal(bootstrapInput.taskRuns, runs);
  assert.equal(runtimeInput.runtime.taskRuns, runs);
  assert.equal(telegramInput.controller.taskRuns, runs);
  assert.equal(bootstrapInput.recoverRuns, undefined);
  bootstrapInput.pollTelegram();
  bootstrapInput.restoreBackgroundJobs();
  telegramInput.controller.startDeferred({ id: "original-input" });
  assert.deepEqual(events, [["poll"], ["restore"], ["deferred", { id: "original-input" }]]);
  assert.equal(bootstrapInput.providerIsRunning(), false);
  input.clients.codexTransport.running = true;
  assert.equal(bootstrapInput.providerIsRunning(), true);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(bootstrapInput.backfillProviderMetadata({ signal: abort.signal }), { name: "AbortError" });
  assert.equal(events.length, 3, "cancelled optional backfill cannot enter provider discovery");
  await bootstrapInput.backfillProviderMetadata();
  assert.deepEqual(events.slice(-2), [["discover"], ["pricing", ["thread-exact"], true]]);
  const ordinary = { action: "send-message", params: { followUpMode: "queue" } };
  assert.equal(await bootstrapInput.handleDesktopControl(ordinary), ordinary);
  const notice = { action: "release-continuation", params: {
    contextToken: "fixture-capability", requestId: "release-attempt:continue", streamId: "stream", text: "Ready",
    mode: "queue", origin: { streamId: "foreign" }, expectedReleaseId: "installed",
  } };
  for (const block of [{ ready: false }, { live: false }, { process: { releaseId: "different" } },
    { installerCutover: { admissionClosed: true } }]) {
    const previous = { ...health };
    Object.assign(health, block);
    assert.deepEqual(await bootstrapInput.handleDesktopControl(notice), { retry: true });
    Object.assign(health, previous);
  }
  input.selection.hostState.stopping = true;
  assert.deepEqual(await bootstrapInput.handleDesktopControl(notice), { retry: true });
  assert.deepEqual(sends, []);
  input.selection.hostState.stopping = false;
  assert.deepEqual(await bootstrapInput.handleDesktopControl(notice), { delivery: { accepted: true } });
  assert.deepEqual(sends, [{ name: "hub_stream_message_send", args: {
    context_token: "fixture-capability", request_id: "release-attempt:continue",
    stream_id: "stream", text: "Ready", mode: "steer", confirm_send: true,
  } }]);
  await bootstrapInput.prepareStartupCommandAdmission({ startupTraceId: "startup" });
  assert.deepEqual(events.at(-1), ["admission", "startup"]);
});
