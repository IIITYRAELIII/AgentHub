import assert from "node:assert/strict";
import test from "node:test";
import { createProviderStartupComposition } from "../../../src/composition/provider-startup-composition.mjs";
import { startCodexTurnWithRecovery, steerCodexTurnWithRecovery,
  interruptCodexTurnWithRecovery } from "../../../src/providers/codex/codex-recovery.mjs";

const noop = async () => {};
function savedRun() {
  return JSON.parse(JSON.stringify({ id: "original-run", provider: "codex", observer: false,
    threadId: "saved-thread", turnId: "original-turn", projectRoot: "D:/fixture",
    executionOwner: "hub", status: "running", clientUserMessageId: "original-input",
    responseText: "retained partial answer", progressMessageIds: [],
    providerStart: { state: "observed", turnId: "original-turn" },
    promptPreview: "original input must never be replayed" }));
}
test("explicit saved Thread metadata read does not resume provider execution", async () => {
  const rpc = [];
  const service = createProviderStartupComposition({ config: { codexSandboxMode: "workspace-write" },
    selectionStore: { setTitle() {}, setThread() {} }, taskRuns: { values: () => [savedRun()] },
    agentProviders: { call: async () => assert.fail("No replacement Thread") },
    getProvider: () => "codex", getProjectRoot: () => "D:/fixture", getThreadId: () => "saved-thread",
    sendRpc: async (method) => { rpc.push(method); return { thread: { id: "saved-thread", cwd: "D:/fixture" } }; },
    resolveResumedCodexThreadTitle: async () => "Saved", applyCodexThreadSettings() {},
    saveState: noop, logger: { error() {}, warn() {} },
  });
  await service.attachCodexThread();
  assert.equal(rpc.includes("thread/resume"), false);
  assert.equal(rpc.includes("turn/start"), false);
});

test("new input cannot erase the interrupted tail or silently retry after a broken tool result", async () => {
  let starts = 0;
  let rollbacks = 0;
  await assert.rejects(startCodexTurnWithRecovery({ threadId: "saved-thread",
    startTurn: async () => { starts++; throw new Error("Custom tool call output is missing for call id: old"); },
    resume: noop, rollback: async () => { rollbacks++; },
  }), /Custom tool call output/);
  assert.equal(starts, 1);
  assert.equal(rollbacks, 0);
});

test("Stop and steer never reload an unloaded old turn as an automatic recovery", async () => {
  for (const operation of [interruptCodexTurnWithRecovery, steerCodexTurnWithRecovery]) {
    const calls = [];
    const effect = async () => { calls.push("request"); throw new Error("thread not found: saved-thread"); };
    await assert.rejects(operation({ threadId: "saved-thread", turnId: "original-turn",
      interrupt: effect, steer: effect, resume: async () => calls.push("resume"),
    }), /thread not found/);
    assert.deepEqual(calls, ["request"]);
  }
});
