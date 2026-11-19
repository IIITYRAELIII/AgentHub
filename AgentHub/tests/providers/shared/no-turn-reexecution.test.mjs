import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RuntimeStateStore, readRuntimeState } from "../../../src/infrastructure/persistence/runtime-state-store.mjs";
import { restorePersistedTaskRun } from "../../../src/composition/runtime-state-restoration-composition.mjs";
import { CodexRecoveryService } from "../../../src/providers/provider-recovery-services.mjs";
import { ProviderCancellationService } from "../../../src/providers/provider-turn-services.mjs";
import { TaskRunRegistry } from "../../../src/domain/task-runs.mjs";
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
function recovery(options = {}) {
  return new CodexRecoveryService({ transportRunning: () => true, readTaskSnapshot: async () => ({
    turnId: "original-turn", active: true, completed: false,
  }), startTransport: noop, initialize: noop, isCodex: () => true,
  finishInterrupted: noop, readThread: async (_id, { applySnapshot }) => applySnapshot({
    thread: { status: { type: "active", activeFlags: ["waitingOnApproval"] },
      turns: [{ id: "original-turn", status: "inProgress", items: [] }] },
  }), autoApprove: () => true, restartRequested: () => false, finishProgress: noop,
  completeRun: noop, recoveredAnswer: () => "", setProgressStage: () => {},
  launchTurn: async () => assert.fail("Old provider turn was reexecuted"),
  reindexRun: () => {}, scheduleObservedRun: () => {}, startTyping: () => {},
  saveState: noop, telegram: noop, consumeTracker: () => null, finalizeDelivery: noop,
  turnTokenUsage: new Map(), ...options });
}

test("lost approval never synthesizes a continuation of the saved input", async () => {
  const run = savedRun();
  const before = JSON.stringify(run);
  await recovery().recover(run);
  assert.equal(run.turnId, "original-turn");
  assert.equal(run.promptPreview, JSON.parse(before).promptPreview);
  assert.equal(run.responseText, "retained partial answer");
});

test("cold exact original is terminal before a new input can own its lane, without provider effects", async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "hub-cold-no-resume-"));
  const state = new RuntimeStateStore({ dataDir });
  t.after(async () => { await state.close(); await rm(dataDir, { recursive: true, force: true }); });
  await state.save({ activeRuns: [savedRun()] });
  const persisted = (await readRuntimeState(dataDir)).activeRuns[0];
  const run = restorePersistedTaskRun(persisted, 1);
  assert.equal(run.clientUserMessageId, persisted.clientUserMessageId);
  const registry = new TaskRunRegistry();
  registry.addRestored(run, structuredClone(run));
  const events = [];
  const service = new ProviderCancellationService({
    interruptCodex: async () => { events.push("interrupt"); throw new Error("no active turn"); },
    runForTask: value => registry.forTask(value),
    readCodexSnapshot: async () => ({ turnId: run.turnId, active: true, completed: false,
      answer: "retained partial answer", userMessages: [{ text: "original", clientUserMessageId: "original-input" }] }),
    taskExternalActivity: async () => ({ state: "inactive" }),
    completeManaged: async (_run, { snapshot }) => {
      assert.equal(snapshot.status, "interrupted");
      assert.equal(snapshot.answer, "retained partial answer");
      assert.equal(registry.forTask(run), run);
      events.push("durable-terminal");
      registry.remove(run);
    }, finishObserved: noop, stopClaudeRun: noop, processIsAlive: () => false,
    claudeCancellationKey: () => "", saveState: noop,
  });
  assert.equal(await service.recoverCodex(run), true);
  assert.deepEqual(events, ["durable-terminal"]);
  const next = { ...run, id: "next-run", turnId: "new-turn", clientUserMessageId: "new-input" };
  registry.add(next);
  assert.equal(registry.forTask(next), next);
  assert.equal(registry.forEvent({ provider: "codex", threadId: run.threadId, turnId: run.turnId }), null);
  assert.equal(run.clientUserMessageId, "original-input");
});

test("cold startup reads saved history without resuming a provider Thread", async () => {
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
