import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createObservedTaskRun } from "../../../src/domain/task-runs.mjs";
import { TaskObservationService } from "../../../src/application/task-observation-service.mjs";
import { completeCodexAgentMessage } from "../../../src/providers/codex/codex-agent-message-reducer.mjs";
import { codexRolloutTurnState, parseCodexRolloutActivity,
  readCodexRolloutActivity } from "../../../src/providers/codex/codex-rollout-activity.mjs";
import { codexRolloutHistory } from "../../../src/interfaces/telegram/task-view-controller.mjs";
import { message, observer, row, start, turnId } from "./codex-rollout-answer.fixture.mjs";

test("rollout commentary is trace-owned and exact final items survive observer refresh", async () => {
  let activity = parseCodexRolloutActivity(start()
    + message("comment-one", "commentary", "Same visible text")
    + message("comment-two", "commentary", "Same visible text"));
  const service = observer(async () => activity);
  const binding = { provider: "codex", threadId: "thread-one", turnId,
    observer: true, exactTurnObserver: true };
  const snapshot = await service.read(binding);
  assert.equal(snapshot.answer, "");
  assert.deepEqual(snapshot.activityGroups.map((group) => group.id), [
    "commentary:comment-one", "commentary:comment-two",
  ]);
  assert.deepEqual(snapshot.activityGroups.map((group) => group.reasoning), [
    "Same visible text", "Same visible text",
  ]);
  const [history] = codexRolloutHistory(activity);
  assert.equal(history.answer, "");
  assert.equal(history.active, true);
  assert.equal(history.completed, false);
  assert.deepEqual(history.activityGroups, snapshot.activityGroups);

  const run = createObservedTaskRun(binding, snapshot);
  assert.equal(run.responseItems.at(-1).id, "comment-two");
  assert.equal(run.responseItems.at(-1).phase, "commentary");
  completeCodexAgentMessage(run, { turnId,
    item: { id: "final-one", type: "agentMessage", phase: "final_answer", text: "Same visible text" } });
  service.applyObserved(run, snapshot);
  assert.equal(run.responseText, "Same visible text", "an older observation cannot replace a newer streamed final");
  assert.equal(run.responseItemId, "final-one");

  activity = parseCodexRolloutActivity(start()
    + message("comment-one", "commentary", "Same visible text")
    + message("final-one", "final_answer", "Same visible text"));
  const final = await service.read(binding);
  assert.equal(final.answer, "Same visible text");
  assert.equal(final.active, true, "an explicit final item alone does not complete its turn");
  assert.equal(final.completed, false);
  service.applyObserved(run, final);
  assert.equal(run.responseText, "Same visible text");
  assert.equal(run.responseItems.at(-1).phase, "final_answer");
  assert.equal(codexRolloutHistory(activity)[0].messages.at(-1).itemId, "final-one");
});

test("typed questions and exact failed terminals retain their separate authorities", async () => {
  const activity = parseCodexRolloutActivity(start() + row("response_item", {
    type: "message", role: "assistant", id: "question", phase: "final_answer",
    internal_chat_message_metadata_passthrough: { turn_id: turnId },
    content: [{ type: "output_text", text: "Choose a profile" }],
    questions: [{ title: "Profile?", options: ["A", "B"] }],
  }));
  assert.equal(codexRolloutTurnState(activity, turnId, { exact: true }).latestAnswer, "");
  assert.deepEqual(codexRolloutHistory(activity), [], "the question remains owned by its asynchronous form");
  const failed = parseCodexRolloutActivity(start() + message("progress", "commentary", "Working")
    + row("event_msg", { type: "task_complete", turn_id: turnId, error: { message: "Synthetic failure" } }));
  const state = codexRolloutTurnState(failed, turnId, { exact: true });
  assert.equal(state.completed, true);
  assert.equal(state.terminalStatus, "failed");
  assert.equal(state.finalAnswer, "");
});

test("an older rollout commentary cannot retarget a newer final citation", async () => {
  const activity = parseCodexRolloutActivity(start()
    + message("comment", "commentary", ':codex-annotation{index="2"} Working'));
  const service = observer(async () => activity);
  const binding = { provider: "codex", threadId: "thread-one", turnId,
    observer: true, exactTurnObserver: true };
  const stale = await service.read(binding);
  const run = createObservedTaskRun(binding, stale);
  completeCodexAgentMessage(run, { turnId, item: {
    id: "final", type: "agentMessage", phase: "final_answer",
    text: ':codex-annotation{index="1"} Final answer',
  } });
  service.applyObserved(run, stale);
  assert.equal(run.responseItemId, "final");
  assert.deepEqual(run.responseAnnotationReferences, [{ index: 1 }]);
});

test("managed and observed publication use the same selected native item after a stale read", async () => {
  const activity = parseCodexRolloutActivity(start() + message("old-final", "final_answer", "Old final"));
  const codex = observer(async () => activity);
  for (const external of [false, true]) {
    const binding = { provider: "codex", threadId: "thread-one", turnId,
      observer: true, exactTurnObserver: true };
    const stale = await codex.read(binding);
    const run = createObservedTaskRun(binding, stale);
    run.observer = external;
    completeCodexAgentMessage(run, { turnId, item: {
      id: "new-final", type: "agentMessage", phase: "final_answer", text: "New final",
    } });
    let published;
    const observation = new TaskObservationService({
      providers: { call(_provider, method, ...args) {
        if (method === "applyActiveSnapshot") return codex.applyActive(...args);
        if (method === "applyObservedSnapshot") return codex.applyObserved(...args);
        assert.fail(`Unexpected provider hook ${method}`);
      } },
      syncTaskRun: (_run, state) => { published = state; },
      noteRunActivity: () => {}, scheduleProgressUpdate: () => {},
      markProgressHeartbeat: () => false, progressHeartbeatState: () => "active",
    });
    await observation.applyActive(run, stale);
    assert.equal(run.responseText, "New final", `runtime owner external=${external}`);
    assert.equal(run.responseItemId, "new-final");
    assert.equal(published.answer, "New final", `published owner external=${external}`);
  }
});

test("phased rollout answers retain cache, append, rewrite and legacy recovery boundaries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub-rollout-answer-"));
  const file = path.join(directory, "rollout.jsonl");
  try {
    await writeFile(file, start() + message("comment", "commentary", "Current progress"));
    const initial = await readCodexRolloutActivity(file);
    assert.equal(codexRolloutTurnState(initial, turnId, { exact: true }).latestAnswer, "");
    const unchanged = await readCodexRolloutActivity(file);
    assert.equal(codexRolloutTurnState(unchanged, turnId, { exact: true }).latestAnswer, "");
    const finalText = ("Full final\n" + "long answer ".repeat(4_000)).trim();
    await appendFile(file, message("final", "final_answer", finalText));
    const appended = await readCodexRolloutActivity(file);
    assert.equal(codexRolloutTurnState(appended, turnId, { exact: true }).latestAnswer, finalText);
    assert.equal(appended.latestMessages[turnId].includes("Current progress"), true,
      "the separate existing interrupted-recovery representation remains retained");
    await appendFile(file, row("event_msg", {
      type: "task_complete", turn_id: turnId, last_agent_message: finalText,
    }));
    const terminal = codexRolloutTurnState(await readCodexRolloutActivity(file), turnId, { exact: true });
    assert.equal(terminal.completed, true);
    assert.equal(terminal.finalAnswer, finalText);
    await writeFile(file, start() + row("event_msg", { type: "agent_message", message: "Legacy answer" }));
    const rewritten = await readCodexRolloutActivity(file);
    assert.equal(codexRolloutTurnState(rewritten, turnId, { exact: true }).latestAnswer, "Legacy answer");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
