import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startCodexAgentMessage, completeCodexAgentMessage, hydrateCodexAgentMessages, codexAgentMessageSourceText } from "../../../src/providers/codex/codex-agent-message-reducer.mjs";
import { upsertRunReasoningBlock, replaceRunActivityGroups, preserveRunActivityAnnotationTargets } from "../../../src/domain/run-activity.mjs";
import { parseCodexRolloutActivity } from "../../../src/providers/codex/codex-rollout-activity.mjs";
import { assistantTraceAnnotationPresentation } from "../../../src/domain/codex-response-annotation.mjs";
import { LocalTaskSyncStore } from "../../../src/infrastructure/persistence/task-sync-store.mjs";
import { codexRolloutHistory } from "../../../src/interfaces/telegram/task-view-controller.mjs";
import { observer, row, message, start, turnId } from "./codex-rollout-answer.fixture.mjs";

const a = { role: "user", itemId: "user-A", clientUserMessageId: "client-A", responseAnnotations: [{ text: "same source", annotation: "Comment A" }] };
const b = { ...a, itemId: "user-B", clientUserMessageId: "client-B", responseAnnotations: [{ text: "same source", annotation: "Comment B" }] };
const user = value => row("response_item", { type: "message", role: "user", id: value.itemId,
  internal_chat_message_metadata_passthrough: { turn_id: turnId },
  content: [{ type: "input_text", text: `<response-annotations>${JSON.stringify(value.responseAnnotations)}</response-annotations>` }] });
const text = 'Answer A. :agent-annotation{index="1"}';
function nativeRun() {
  const run = { id: "run", provider: "codex", threadId: "thread-a", turnId, status: "running", observer: true, exactTurnObserver: true, userMessages: [a], responseItems: [] };
  startCodexAgentMessage(run, { turnId, item: { id: "answer-A", type: "agentMessage", phase: "commentary" } });
  run.userMessages.push(b);
  const item = completeCodexAgentMessage(run, { turnId, item: { id: "answer-A", type: "agentMessage", phase: "commentary", text } });
  upsertRunReasoningBlock(run, { id: item.id, sourceItemId: item.id, kind: "commentary", text: codexAgentMessageSourceText(item), responseAnnotationTarget: item.responseAnnotationTarget });
  return run;
}

test("late completion observation and terminal hydration retain the exact native item target", async () => {
  const run = nativeRun();
  const activity = parseCodexRolloutActivity(start() + user(a) + user(b) + message("answer-A", "commentary", text));
  const service = observer(async () => activity);
  const incoming = await service.read(run);
  assert.equal(incoming.activityGroups[0].responseAnnotationTarget.itemId, "user-B", "completion order alone cannot reproduce the captured start");
  service.applyObserved(run, incoming);
  assert.equal(run.activityGroups[0].responseAnnotationTarget.clientUserMessageId, "client-A");
  const projected = assistantTraceAnnotationPresentation(run.activityGroups[0]);
  assert.equal(projected.responseAnnotationPresentation.responseAnnotationReferences[0].target.clientUserMessageId, "client-A");
  hydrateCodexAgentMessages(run, [{ id: "answer-A", type: "agentMessage", phase: "commentary", text,
    responseAnnotationTarget: incoming.activityGroups[0].responseAnnotationTarget }], { turnId });
  replaceRunActivityGroups(run, incoming.activityGroups);
  assert.equal(run.responseItems[0].responseAnnotationTarget.clientUserMessageId, "client-A");
  assert.equal(run.activityGroups[0].responseAnnotationTarget.clientUserMessageId, "client-A");
  const later = completeCodexAgentMessage(run, { turnId, item: { id: "answer-B", type: "agentMessage", phase: "final_answer", text: 'Answer B. :agent-annotation{index="1"}' } });
  assert.equal(later.responseAnnotationReferences[0].target.clientUserMessageId, "client-B");
});

test("captured targets never transfer to a foreign owner or changed native item", () => {
  const run = nativeRun();
  const incoming = [{ ...run.activityGroups[0], responseAnnotationTarget: { itemId: "user-B" } }];
  for (const owner of [{ provider: "claude" }, { threadId: "foreign" }, { turnId: "foreign" }]) {
    assert.deepEqual(preserveRunActivityAnnotationTargets(run, incoming, owner), incoming);
  }
  const changed = [{ ...incoming[0], sourceItemId: "different-native-item" }];
  assert.deepEqual(preserveRunActivityAnnotationTargets(run, changed), changed);
  hydrateCodexAgentMessages(run, [{ id: "answer-A", type: "agentMessage", text,
    responseAnnotationTarget: { itemId: "user-B" } }], { turnId: "different-turn" });
  assert.equal(run.responseItems[0].responseAnnotationTarget.itemId, "user-B");
  assert.equal(run.responseItems[0].responseAnnotationTarget.origin, undefined);
});

test("completed observation keeps a native final target only for the exact turn and item", async () => {
  const run = { provider: "codex", threadId: "thread-a", turnId, observer: true, exactTurnObserver: true, userMessages: [a], responseItems: [] };
  startCodexAgentMessage(run, { turnId, item: { id: "final-A", type: "agentMessage", phase: "final_answer" } });
  run.userMessages.push(b);
  completeCodexAgentMessage(run, { turnId, item: { id: "final-A", type: "agentMessage", phase: "final_answer", text } });
  const activity = parseCodexRolloutActivity(start() + user(a) + user(b) + message("final-A", "final_answer", text)
    + row("event_msg", { type: "task_complete", turn_id: turnId, last_agent_message: text }));
  const service = observer(async () => activity);
  const snapshot = await service.read(run);
  assert.equal(snapshot.active, false);
  assert.equal(snapshot.responseAnnotationReferences[0].target.itemId, "user-B");
  service.applyObserved(run, snapshot);
  assert.equal(run.responseAnnotationReferences[0].target.clientUserMessageId, "client-A");
  service.applyObserved(run, { ...snapshot, responseItemId: "different-item" });
  assert.equal(run.responseAnnotationReferences[0].target.itemId, "user-B");
  service.applyObserved(run, { ...snapshot, turnId: "different-turn" });
  assert.equal(run.responseAnnotationReferences[0].target.itemId, "user-B");
});

test("SQLite retains native capture over late history and accepts stronger native capture after an inferred target", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub469-observed-target-"));
  const task = { provider: "codex", threadId: "thread-a", projectRoot: directory };
  const filePath = path.join(directory, "tasks.json"); let store;
  const run = nativeRun();
  const finalText = 'Answer B. :agent-annotation{index="1"}';
  startCodexAgentMessage(run, { turnId, item: { id: "answer-B", type: "agentMessage", phase: "final_answer" } });
  completeCodexAgentMessage(run, { turnId, item: { id: "answer-B", type: "agentMessage", phase: "final_answer", text: finalText } });
  const activity = parseCodexRolloutActivity(start() + user(a) + user(b) + message("answer-A", "commentary", text)
    + message("answer-B", "final_answer", finalText));
  const inferred = codexRolloutHistory(activity);
  const captured = [{ ...inferred[0], activityGroups: run.activityGroups, messages: [a, b, { role: "agent", itemId: "answer-B", phase: "final_answer", text: run.responseText,
    responseAnnotationReferences: run.responseAnnotationReferences }] }];
  try {
    store = new LocalTaskSyncStore({ filePath }); await store.load();
    await store.recordHistory(task, inferred);
    await store.recordHistory(task, captured);
    await store.recordHistory(task, inferred);
    const partial = structuredClone(inferred);
    partial[0].messages.find(value => value.itemId === "answer-B").responseAnnotationReferences[0].target = { itemId: "user-A" };
    await store.recordHistory(task, partial);
    store.close(); store = new LocalTaskSyncStore({ filePath }); await store.load();
    const saved = store.history(task)[0];
    assert.equal(saved.activityGroups[0].responseAnnotationTarget.clientUserMessageId, "client-A");
    assert.equal(saved.messages.find(value => value.itemId === "answer-B").responseAnnotationReferences[0].target.clientUserMessageId, "client-B");
    const foreign = { ...task, threadId: "foreign-thread" };
    await store.recordHistory(foreign, inferred);
    assert.equal(store.history(foreign)[0].activityGroups[0].responseAnnotationTarget.itemId, "user-B");
    const changed = structuredClone(inferred); changed[0].activityGroups[0].sourceItemId = "different-native-item";
    await store.recordHistory(task, changed);
    assert.equal(store.history(task)[0].activityGroups[0].responseAnnotationTarget.itemId, "user-B");
  } finally { store?.close(); await rm(directory, { recursive: true, force: true }); }
});
