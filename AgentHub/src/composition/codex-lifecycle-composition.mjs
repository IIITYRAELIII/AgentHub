import { unavailableLocalMcpOverrides } from "../infrastructure/process/local-mcp-preflight.mjs";
import { resolveCodexExecutable } from "../providers/codex/codex-invocation.mjs";
import { CodexAppServerLifecycle } from "../providers/codex/codex-app-server-lifecycle.mjs";
import { CodexLifecycleController } from "../providers/codex/codex-lifecycle-controller.mjs";

export function createCodexLifecycleComposition({
  config,
  rpcTimeoutMs,
  runtimeDependencies,
  controllerDependencies,
}) {
  const runtime = new CodexAppServerLifecycle({
    resolveExecutable: () => resolveCodexExecutable({ requested: config.codexExecutable }),
    unavailableMcpOverrides: unavailableLocalMcpOverrides,
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

  async function start() {
    await runtime.start();
  }

  async function stop() {
    await runtime.stop();
  }

  async function restartAfterCrash() {
    return runtime.restartAfterCrash();
  }

  function sendRpc(method, params = {}, { timeoutMs = rpcTimeoutMs } = {}) {
    return transport.request(method, params, { timeoutMs });
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

  function respondRpc(id, result) {
    transport.respond(id, result);
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
    start,
    stop,
    restartAfterCrash,
    sendRpc,
    invalidateThreadRead,
    readThread,
    sendNotification,
    respondRpc,
    initialize,
  };
}
