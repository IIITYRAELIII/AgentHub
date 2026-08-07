import assert from "node:assert/strict";
import test from "node:test";
import { HubSessionState } from "../../src/runtime/hub-session-state.mjs";

test("hub session state restores transport state and owns mutable host flags", () => {
  const state = new HubSessionState({ autoApprove: true });
  const restartRequest = { waitingForRuns: true };

  state.restore({ chatId: 42, updateOffset: 17, restartRequest });
  state.setLatestDiff("diff");
  state.setProcessingUpdateId(19);
  state.setAutoApprove(false);
  state.setRestartWaiting(false);

  assert.equal(state.chatId, 42);
  assert.equal(state.updateOffset, 17);
  assert.equal(state.latestDiff, "diff");
  assert.equal(state.processingUpdateId, 19);
  assert.equal(state.autoApprove, false);
  assert.equal(state.restartRequest, restartRequest);
  assert.equal(state.restartRequest.waitingForRuns, false);
});

test("hub session state admits stopping only once", () => {
  const state = new HubSessionState();

  assert.equal(state.beginStopping(), true);
  assert.equal(state.beginStopping(), false);
  state.setStopping(false);
  assert.equal(state.beginStopping(), true);
});

test("hub session state rejects restart mutation without a request", () => {
  const state = new HubSessionState();
  assert.throws(() => state.setRestartWaiting(true), /restart request is not active/);
  state.restore({ updateOffset: -1 });
  assert.equal(state.updateOffset, 0);
});

test("hub session state keeps durable task selection per client", () => {
  const state = new HubSessionState();
  state.setClientTaskSelection("telegram:42", {
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "telegram-thread",
  });
  state.setClientTaskSelection("desktop:one", {
    provider: "codex",
    projectRoot: "D:/Work",
    threadId: "desktop-thread",
  });

  const read = state.clientTaskSelection("telegram:42");
  read.threadId = "mutated-copy";
  assert.equal(state.clientTaskSelection("telegram:42").threadId, "telegram-thread");

  const restored = new HubSessionState();
  restored.restore({ clientTaskSelections: state.clientTaskSelectionsSnapshot() });
  assert.equal(restored.clientTaskSelection("telegram:42").threadId, "telegram-thread");
  assert.equal(restored.clientTaskSelection("desktop:one").threadId, "desktop-thread");
});
