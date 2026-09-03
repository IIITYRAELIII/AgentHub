import path from "node:path";

import { CodexExecutableUpdateService } from "../infrastructure/process/codex-executable-update-service.mjs";
import { unavailableLocalMcpOverrides } from "../infrastructure/process/local-mcp-preflight.mjs";
import { CodexAppServerLifecycle } from "../providers/codex/codex-app-server-lifecycle.mjs";
import { CodexLifecycleController } from "../providers/codex/codex-lifecycle-controller.mjs";
import { agentHubRuntimeHealth } from "../application/runtime-health.mjs";
import { runCodexAppServerCompatibilityCanary } from "./codex-app-server-canary.mjs";

export function createCodexLifecycleComposition({
  config,
  hubMcpServer,
  rpcTimeoutMs,
  runtimeDependencies,
  controllerDependencies,
}) {
  const executableUpdates = new CodexExecutableUpdateService({
    stateFile: path.join(config.dataDir, "codex-executable-state.json"),
    requestedExecutable: config.codexExecutable,
    autoUpdateEnabled: config.codexExecutableAutoUpdate,
    versionPin: config.codexExecutableVersionPin,
    activeRuns: runtimeDependencies.activeRuns,
    runCanary: (candidate) => runCodexAppServerCompatibilityCanary(candidate, {
      dataDir: config.dataDir,
      executableArgs: config.codexExecutableArgs,
      model: config.codexModel,
      logger: runtimeDependencies.logger ?? console,
    }),
  });
  const runtime = new CodexAppServerLifecycle({
    resolveExecutable: () => executableUpdates.selectForStart(),
    onStartupSuccess: () => executableUpdates.markStartupSuccess(),
    onStartupFailure: (error) => executableUpdates.markStartupFailure(error),
    unavailableMcpOverrides: async () => {
      const existing = await unavailableLocalMcpOverrides();
      return { ...existing, args: [...existing.args, ...hubMcpServer.codexArgs()] };
    },
    executableArgs: config.codexExecutableArgs,
    projectRoot: runtimeDependencies.getActiveProjectRoot,
    stopProcessTree: runtimeDependencies.stopProcessTree,
    onMessage: runtimeDependencies.handleMessage,
    rpcTimeoutMs,
    isStopping: runtimeDependencies.isStopping,
    providerSelected: runtimeDependencies.providerSelected,
    activeRuns: runtimeDependencies.activeRuns,
    setStage: runtimeDependencies.setStage,
    recoverRuns: runtimeDependencies.recoverRuns,
    startTyping: runtimeDependencies.startTyping,
    attachSelectedThread: runtimeDependencies.attachSelectedThread,
    scheduleRetry: (operation, delayMs) => setTimeout(() => void operation(), delayMs),
    logger: runtimeDependencies.logger ?? console,
  });
  const transport = runtime.transport;
  agentHubRuntimeHealth.setDiagnosticSource("codexAppServer", () => ({
    ...transport.diagnostics(),
    hubOwnedProcessTrees: transport.running ? 1 : 0,
  }));
  agentHubRuntimeHealth.setDiagnosticSource("codexExecutableUpdate", () => executableUpdates.diagnostics());

  async function start() {
    await runtime.start();
  }

  async function stop() {
    await runtime.stop();
  }

  async function restartAfterCrash() {
    return runtime.restartAfterCrash();
  }

  function sendRpc(method, params = {}, options = {}) {
    return transport.request(method, params, {
      ...options,
      timeoutMs: options.timeoutMs ?? rpcTimeoutMs,
    });
  }

  function invalidateThreadRead(threadId) {
    transport.invalidateThreadRead(threadId);
  }

  function readThread(threadId, options = {}) {
    return transport.readThread(threadId, options);
  }

  function sendNotification(method, params = {}) {
    transport.notify(method, params);
  }

  function respondRpc(id, result, options = {}) {
    return transport.respond(id, result, options);
  }

  function transportGeneration() {
    return transport.generation;
  }

  async function initialize(options = {}) {
    return runtime.initialize(options);
  }

  const controller = new CodexLifecycleController({
    ...controllerDependencies,
    config,
    ensureCodexTransport: async () => {
      if (!transport.running) {
        await start();
        await initialize({ attachSelectedThread: false });
      }
    },
    readCodexThread: readThread,
  });

  return {
    runtime,
    transport,
    controller,
    executableUpdates,
    start,
    stop,
    restartAfterCrash,
    sendRpc,
    invalidateThreadRead,
    readThread,
    sendNotification,
    respondRpc,
    transportGeneration,
    initialize,
  };
}
