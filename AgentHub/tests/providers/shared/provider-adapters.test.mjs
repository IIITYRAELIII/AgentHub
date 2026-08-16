import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_PROVIDER_REQUIRED_OPERATIONS, AgentProviderRegistry } from "../../../src/providers/agent-provider-registry.mjs";
import {
  createAgentProviderRegistry,
  createClaudeProviderAdapter,
  createCodexProviderAdapter,
} from "../../../src/providers/provider-adapters.mjs";

function operations(provider) {
  const names = provider === "codex"
    ? [
        "listAllCodexThreads", "buildCodexTaskCatalogEntries", "createCodexTask",
        "launchCodexTurn", "steerCodexTurn", "findCodexTurnByClientMessage", "cancelCodexProviderRun",
        "readCodexTaskActivity", "readCodexTaskSnapshot", "completeObservedCodexRun",
        "completeManagedCodexRun", "recoverCodexRun", "readCodexRecoverySnapshot",
        "prepareCodexRecovery", "shouldObserveCodexRun", "applyCodexObservedSnapshot",
        "applyCodexActiveSnapshot", "codexBlocksRuntimeRestart", "stopManagedCodexRunForShutdown",
      ]
    : [
        "listClaudeSessionSnapshots", "buildClaudeTaskCatalogEntries", "createClaudeTask",
        "launchClaudeTurn", "steerClaudeTurn", "findClaudeTurnByClientMessage", "cancelClaudeProviderRun",
        "readClaudeTaskActivity", "readClaudeRunSnapshot", "completeObservedClaudeRun",
        "completeManagedClaudeRun", "recoverClaudeRun", "readClaudeRecoverySnapshot",
        "prepareClaudeRecovery", "shouldObserveClaudeRun", "applyClaudeObservedSnapshot",
        "applyClaudeActiveSnapshot", "claudeBlocksRuntimeRestart", "stopManagedClaudeRunForShutdown",
      ];
  const result = Object.fromEntries(names.map((name) => [name, (...args) => ({ name, args })]));
  if (provider === "claude") {
    result.readClaudeTaskSnapshot = (...args) => ({ name: "readClaudeTaskSnapshot", args });
  }
  return result;
}

test("provider adapter factories expose the complete registry contract", () => {
  const codex = createCodexProviderAdapter(operations("codex"));
  const claude = createClaudeProviderAdapter(operations("claude"));
  assert.deepEqual(AGENT_PROVIDER_REQUIRED_OPERATIONS.filter((name) => typeof codex[name] !== "function"), []);
  assert.deepEqual(AGENT_PROVIDER_REQUIRED_OPERATIONS.filter((name) => typeof claude[name] !== "function"), []);
  assert.deepEqual(new AgentProviderRegistry([codex, claude]).ids(), ["codex", "claude"]);
});

test("provider adapter factories reject incomplete wiring", () => {
  assert.throws(() => createCodexProviderAdapter({}), /codex provider operation is required: listAllCodexThreads/u);
  assert.throws(() => createClaudeProviderAdapter({}), /claude provider operation is required: listClaudeSessionSnapshots/u);
});

test("registry factory owns provider restart and shutdown policy", async () => {
  const codex = operations("codex");
  const claude = operations("claude");
  const registry = createAgentProviderRegistry({
    codex,
    claude,
    taskRunIsActive: (run) => run.status === "running",
  });
  const running = { observer: false, status: "running", process: { killed: false, kill() { this.killed = true; } } };
  assert.equal(registry.call("codex", "blocksRuntimeRestart", running), true);
  registry.call("codex", "stopManagedRunForShutdown", running);
  assert.equal(running.process.killed, true);
  assert.equal(registry.call("claude", "blocksRuntimeRestart", running), false);
  assert.equal(registry.call("claude", "shouldObserveRun", { observer: true }), true);
  assert.deepEqual(
    await registry.call("claude", "readRunSnapshot", { threadId: "session-1" }, { fresh: true }),
    { name: "readClaudeTaskSnapshot", args: ["session-1", { fresh: true }] },
  );
});
