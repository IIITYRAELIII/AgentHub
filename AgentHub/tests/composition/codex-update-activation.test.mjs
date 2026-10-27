import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createCodexLifecycleComposition } from "../../src/composition/codex-lifecycle-composition.mjs";
import { AgentHubStartupCoordinator } from "../../src/application/agent-hub-startup-coordinator.mjs";
import { createRuntimeHealth } from "../../src/application/runtime-health.mjs";
import { createProviderStartupComposition } from "../../src/composition/provider-startup-composition.mjs";

test("real lifecycle composition automatically settles a prior provider failure after actual controlled child initialize", async context => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hub348-composition-"));
  const health = createRuntimeHealth();
  let stopping = false, recoveries = 0, metadata = 0;
  let startup;
  const lifecycle = createCodexLifecycleComposition({ config: { dataDir: root, codexExecutable: process.execPath,
    codexExecutableArgs: [path.resolve(import.meta.dirname, "../fixtures/codex-bundle-app-server.mjs")],
    codexExecutableAutoUpdate: true, codexExecutableVersionPin: "", projects: [] }, rpcTimeoutMs: 3000,
    hubMcpServer: { codexArgs: () => [] }, controllerDependencies: {}, runtimeDependencies: {
      getActiveProjectRoot: () => root, stopProcessTree: async processId => {
        const child = lifecycle.transport.child;
        const closed = new Promise(resolve => child.once("close", resolve));
        process.kill(processId); await closed;
      },
      handleMessage() {}, isStopping: () => stopping, providerSelected: () => true, activeRuns: () => [],
      setStage() {}, recoverRuns: async () => { recoveries += 1; }, startTyping() {},
      attachSelectedThread: options => startup.attachCodexThread(options),
      logger: { log() {}, error() {} },
    } });
  let creates = 0, selections = 0;
  startup = createProviderStartupComposition({ config: { codexSandboxMode: "workspace-write" },
    selectionStore: { setTitle() {}, setThread() { selections += 1; } },
    taskRuns: { values: () => [], forTask: () => null }, getThreadId: () => "selected-thread", getProjectRoot: () => root,
    sendRpc: lifecycle.sendRpc, resolveResumedCodexThreadTitle: async () => "selected", applyCodexThreadSettings() {},
    saveState: async () => {}, agentProviders: { call: async () => { creates += 1; } },
    logger: { warn() {}, error() {} },
  });
  const service = new AgentHubStartupCoordinator({ telegramEnabled: false, health, waitForever: async () => {},
    startMiniApp: async () => null, startDesktopControl: async () => {}, startRuntimeCommand: async () => {},
    startHubMcp: async () => {}, sanitizeRollouts: async () => {}, initializeProvider: async () => { throw new Error("original missing executable"); },
    providerIsRunning: () => lifecycle.runtime.running, backfillProviderMetadata: async () => { metadata += 1; },
    recoverRuns: async () => {}, retryTerminalProjections: async () => {}, retryNotifications: async () => {},
    restoreBackgroundJobs: async () => {}, startTimers() {}, hasPendingRestart: () => false, markReady: async () => {},
    log() {}, logError() {},
  });
  context.after(async () => { stopping = true; await lifecycle.stop(); await service.waitForBackgroundWork();
    await rm(root, { recursive: true, force: true }); });
  await service.start(); assert.equal(health.snapshot().ready, false);
  await lifecycle.start(); await lifecycle.initialize();
  await service.waitForBackgroundWork();
  assert.equal(health.snapshot().ready, true);
  assert.equal(health.snapshot().startup.operations.find(operation => operation.id === "provider").state, "completed");
  assert.equal(recoveries, 0); assert.equal(metadata, 1);
  assert.deepEqual(await lifecycle.sendRpc("thread/list", { limit: 1 }), {});
  // This uses the actual production attach owner through the same RPC facade:
  // a private direct port prevents the idle-update fence from waiting on itself.
  assert.equal(await lifecycle.runtime.applyPreparedUpdate(), true);
  assert.equal(creates, 0); assert.equal(selections, 0); assert.equal(recoveries, 0);
});
