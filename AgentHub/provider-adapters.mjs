function requiredFunction(operations, name, provider) {
  const value = operations?.[name];
  if (typeof value !== "function") {
    throw new TypeError(`${provider} provider operation is required: ${name}`);
  }
  return value;
}

function bindOperations(provider, name, operations, mapping) {
  return Object.freeze({
    id: provider,
    name,
    ...Object.fromEntries(Object.entries(mapping).map(([portName, operationName]) => [
      portName,
      requiredFunction(operations, operationName, provider),
    ])),
  });
}

const CODEX_OPERATIONS = Object.freeze({
  discoverTasks: "listAllCodexThreads",
  projectTasks: "buildCodexTaskCatalogEntries",
  createTask: "createCodexTask",
  launchTurn: "launchCodexTurn",
  steerTurn: "steerCodexTurn",
  cancelRun: "cancelCodexProviderRun",
  readTaskActivity: "readCodexTaskActivity",
  readRunSnapshot: "readCodexTaskSnapshot",
  completeObservedRun: "completeObservedCodexRun",
  completeManagedRun: "completeManagedCodexRun",
  recoverRun: "recoverCodexRun",
  readRecoverySnapshot: "readCodexRecoverySnapshot",
  prepareRecovery: "prepareCodexRecovery",
  shouldObserveRun: "shouldObserveCodexRun",
  applyObservedSnapshot: "applyCodexObservedSnapshot",
  applyActiveSnapshot: "applyCodexActiveSnapshot",
  blocksRuntimeRestart: "codexBlocksRuntimeRestart",
  stopManagedRunForShutdown: "stopManagedCodexRunForShutdown",
});

const CLAUDE_OPERATIONS = Object.freeze({
  discoverTasks: "listClaudeSessionSnapshots",
  projectTasks: "buildClaudeTaskCatalogEntries",
  createTask: "createClaudeTask",
  launchTurn: "launchClaudeTurn",
  steerTurn: "steerClaudeTurn",
  cancelRun: "cancelClaudeProviderRun",
  readTaskActivity: "readClaudeTaskActivity",
  readRunSnapshot: "readClaudeRunSnapshot",
  completeObservedRun: "completeObservedClaudeRun",
  completeManagedRun: "completeManagedClaudeRun",
  recoverRun: "recoverClaudeRun",
  readRecoverySnapshot: "readClaudeRecoverySnapshot",
  prepareRecovery: "prepareClaudeRecovery",
  shouldObserveRun: "shouldObserveClaudeRun",
  applyObservedSnapshot: "applyClaudeObservedSnapshot",
  applyActiveSnapshot: "applyClaudeActiveSnapshot",
  blocksRuntimeRestart: "claudeBlocksRuntimeRestart",
  stopManagedRunForShutdown: "stopManagedClaudeRunForShutdown",
});

export function createCodexProviderAdapter(operations) {
  return bindOperations("codex", "Codex", operations, CODEX_OPERATIONS);
}

export function createClaudeProviderAdapter(operations) {
  return bindOperations("claude", "Claude", operations, CLAUDE_OPERATIONS);
}

export function createAgentProviderRegistry({ codex, claude, taskRunIsActive }) {
  if (typeof taskRunIsActive !== "function") {
    throw new TypeError("taskRunIsActive is required");
  }
  return new AgentProviderRegistry([
    createCodexProviderAdapter({
      ...codex,
      shouldObserveCodexRun: () => true,
      codexBlocksRuntimeRestart: (run) => !run.observer && taskRunIsActive(run),
      stopManagedCodexRunForShutdown: (run) => run.process?.kill(),
    }),
    createClaudeProviderAdapter({
      ...claude,
      readClaudeRunSnapshot: (run, options) => claude.readClaudeTaskSnapshot(run.threadId, options),
      readClaudeRecoverySnapshot: (run) => claude.readClaudeTaskSnapshot(run.threadId),
      prepareClaudeRecovery: async () => {},
      shouldObserveClaudeRun: (run) => run.observer === true,
      applyClaudeObservedSnapshot: () => {},
      applyClaudeActiveSnapshot: () => {},
      claudeBlocksRuntimeRestart: () => false,
      // Detached Claude workers deliberately survive a Hub replacement.
      stopManagedClaudeRunForShutdown: () => {},
    }),
  ]);
}
import { AgentProviderRegistry } from "./agent-provider-registry.mjs";
