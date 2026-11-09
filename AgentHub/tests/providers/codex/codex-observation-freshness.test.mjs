import assert from "node:assert/strict";
import test from "node:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TaskObservationService } from "../../../src/application/task-observation-service.mjs";
import { createObservedTaskRun } from "../../../src/domain/task-runs.mjs";
import { codexAssistantResponseProjection } from "../../../src/domain/codex-response-annotation.mjs";
import { appendCodexAgentMessageDelta, completeCodexAgentMessage,
  hydrateCodexAgentMessages, startCodexAgentMessage } from "../../../src/providers/codex/codex-agent-message-reducer.mjs";
import { parseCodexRolloutActivity, readCodexRolloutActivity } from "../../../src/providers/codex/codex-rollout-activity.mjs";
import { message, observer, start, turnId } from "./codex-rollout-answer.fixture.mjs";

const binding = { provider: "codex", threadId: "thread-one", turnId,
  observer: true, exactTurnObserver: true };
const readOptions = { threadResult: { thread: { path: "synthetic-rollout", status: { type: "active" }, turns: [] } } };
const parseActivity = (text) => parseCodexRolloutActivity(text, {
  sourceObservationGeneration: "synthetic-same-rollout",
});

function publisher(codex) {
  const states = [];
  const service = new TaskObservationService({
    providers: { call(_provider, method, ...args) {
      if (method === "applyActiveSnapshot") return codex.applyActive(...args);
      if (method === "applyObservedSnapshot") return codex.applyObserved(...args);
      assert.fail(`Unexpected provider hook ${method}`);
    } },
    syncTaskRun: (_run, state) => states.push(structuredClone(state)),
    noteRunActivity: () => {}, scheduleProgressUpdate: () => {},
    markProgressHeartbeat: () => false, progressHeartbeatState: () => "active",
  });
  return { service, states };
}

test("same-item events during an observation read retain their body through both publication paths", async () => {
  for (const external of [false, true]) {
    const original = start() + message("same-final", "final_answer", "Final start");
    let activity = parseActivity(original);
    let held = false;
    let releaseRead;
    let signalRead;
    const readStarted = new Promise((resolve) => { signalRead = resolve; });
    const codex = observer(async () => {
      if (!held) return activity;
      signalRead();
      return new Promise((resolve) => { releaseRead = resolve; });
    });
    const initial = await codex.read(binding);
    const run = createObservedTaskRun(binding, initial);
    run.observer = external;
    const publication = publisher(codex);
    held = true;
    const pending = codex.read(run, readOptions);
    await readStarted;
    completeCodexAgentMessage(run, { turnId, item: {
      id: "same-final", type: "agentMessage", phase: "final_answer",
      text: "Final start with the complete newer ending",
    } });
    releaseRead(activity);
    const stale = await pending;
    await publication.service.applyActive(run, stale);
    assert.equal(run.responseText, "Final start with the complete newer ending");
    assert.equal(run.responseItemId, "same-final");
    assert.equal(publication.states.at(-1).answer, run.responseText);

    held = false;
    activity = parseActivity(original + message("same-final", "final_answer", "Shorter authoritative update"));
    const fresh = await codex.read(run, readOptions);
    await publication.service.applyActive(run, fresh);
    assert.equal(run.responseText, "Shorter authoritative update");
    assert.equal(publication.states.at(-1).answer, run.responseText);
  }
});

test("fresh and refreshed observed finals retain their complete citation projection and raw delta base", async () => {
  for (const external of [false, true]) {
    let raw = ':codex-annotation{index="1"} Original final';
    let activity = parseActivity(start() + message("same-final", "final_answer", raw));
    const codex = observer(async () => activity);
    const initial = await codex.read(binding);
    const expectedInitial = structuredClone(initial.responseItem.responseAnnotationReferences);
    assert.equal(expectedInitial[0].index, 1);
    const seeded = createObservedTaskRun(binding, initial);
    appendCodexAgentMessageDelta(seeded, { turnId, itemId: "same-final", delta: " More" });
    assert.deepEqual(seeded.responseAnnotationReferences,
      codexAssistantResponseProjection(raw + " More").responseAnnotationReferences);
    const run = createObservedTaskRun(binding, initial);
    run.observer = external;
    const publication = publisher(codex);
    await publication.service.applyActive(run, initial);
    assert.deepEqual(run.responseAnnotationReferences, expectedInitial);
    assert.equal(publication.states.at(-1).answer, run.responseText);

    raw = ':codex-annotation{index="2"} Changed final';
    const refreshedRollout = start() + message("same-final", "final_answer", raw);
    activity = parseActivity(refreshedRollout);
    const fresh = await codex.read(run, readOptions);
    const expectedRefresh = structuredClone(fresh.responseItem.responseAnnotationReferences);
    assert.equal(expectedRefresh[0].index, 2);
    await publication.service.applyActive(run, fresh);
    assert.deepEqual(run.responseAnnotationReferences, expectedRefresh);
    assert.equal(run.responseText, fresh.responseItem.text);

    const delta = ' :codex-annotation{index="3"} Next part';
    appendCodexAgentMessageDelta(run, { turnId, itemId: "same-final", delta });
    const expectedDelta = codexAssistantResponseProjection(raw + delta);
    assert.deepEqual(run.responseAnnotationReferences.map((reference) => reference.index), [2, 3]);
    assert.deepEqual(run.responseAnnotationReferences, expectedDelta.responseAnnotationReferences);
    assert.equal(run.responseText, expectedDelta.text);
    await publication.service.applyActive(run, fresh);
    assert.equal(run.responseText, expectedDelta.text);
    assert.deepEqual(run.responseAnnotationReferences, expectedDelta.responseAnnotationReferences);
    assert.equal(publication.states.at(-1).answer, expectedDelta.text.trim());

    activity = parseActivity(refreshedRollout + message("same-final", "final_answer", "Plain final"));
    await publication.service.applyActive(run, await codex.read(run, readOptions));
    assert.equal(run.responseText, "Plain final");
    assert.deepEqual(run.responseAnnotationReferences, []);
  }
});

test("native start and hydration also supersede an earlier same-item observation", async () => {
  for (const nativeUpdate of [
    (run, item) => startCodexAgentMessage(run, { turnId, item }),
    (run, item) => hydrateCodexAgentMessages(run, [item], { turnId }),
  ]) {
    const activity = parseCodexRolloutActivity(start() + message("same-final", "final_answer", "Old"));
    const codex = observer(async () => activity);
    const snapshot = await codex.read(binding);
    const run = createObservedTaskRun(binding, snapshot);
    nativeUpdate(run, { id: "same-final", type: "agentMessage", phase: "final_answer", text: "Native update" });
    codex.applyObserved(run, snapshot);
    assert.equal(run.responseText, "Native update");
    assert.equal(run.responseItemId, "same-final");
  }
});

test("the existing bounded rollout preview preserves a complete same-item native response", async () => {
  const original = "Original prefix " + "x".repeat(200_100) + " Original ending";
  let activity = parseCodexRolloutActivity(start() + message("same-final", "final_answer", original));
  const codex = observer(async () => activity);
  const initial = await codex.read(binding);
  assert.equal(initial.responseItem.textComplete, false);
  const run = createObservedTaskRun(binding, initial);
  const publication = publisher(codex);
  const changed = original + " Updated preview";
  activity = parseCodexRolloutActivity(start() + message("same-final", "final_answer", changed));
  const freshPreview = await codex.read(run);
  await publication.service.applyActive(run, freshPreview);
  assert.equal(run.responseText, freshPreview.answer, "an observed preview keeps its normal refresh");
  completeCodexAgentMessage(run, { turnId, item: {
    id: "same-final", type: "agentMessage", phase: "final_answer", text: changed,
  } });
  await publication.service.applyActive(run, await codex.read(run));
  assert.equal(run.responseText, changed);
  assert.equal(publication.states.at(-1).answer, changed);
});

test("the real rollout reader orders unchanged records and later appends against native updates", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub430-record-order-"));
  try {
    for (const external of [false, true]) {
      const file = path.join(directory, `${external}.jsonl`);
      const original = start() + message("same-final", "final_answer", "Old final");
      await writeFile(file, original);
      const codex = observer(() => readCodexRolloutActivity(file));
      const initial = await codex.read(binding);
      const run = createObservedTaskRun(binding, initial);
      run.observer = external;
      const publication = publisher(codex);
      const native = "The complete newer native ending";
      completeCodexAgentMessage(run, { turnId, item: {
        id: "same-final", type: "agentMessage", phase: "final_answer", text: native,
      } });

      const unchanged = await codex.read(run, readOptions);
      assert.deepEqual(unchanged.responseItem.rolloutRecord, initial.responseItem.rolloutRecord);
      await publication.service.applyActive(run, unchanged);
      assert.equal(run.responseText, native);
      assert.equal(publication.states.at(-1).answer, native);

      // File growth without another record for this item supplies no ordering.
      await appendFile(file, "\n");
      await publication.service.applyActive(run, await codex.read(run, readOptions));
      assert.equal(run.responseText, native);

      await appendFile(file, message("same-final", "final_answer", "Fresh shorter"));
      const later = await codex.read(run, readOptions);
      assert.equal(later.responseItem.rolloutRecord.generation, initial.responseItem.rolloutRecord.generation);
      assert.ok(later.responseItem.rolloutRecord.position > initial.responseItem.rolloutRecord.position);
      await publication.service.applyActive(run, later);
      assert.equal(run.responseText, "Fresh shorter");
      assert.equal(publication.states.at(-1).answer, "Fresh shorter");

      completeCodexAgentMessage(run, { turnId, item: {
        id: "same-final", type: "agentMessage", phase: "final_answer", text: native,
      } });
      await writeFile(file, original);
      const rewritten = await codex.read(run, readOptions);
      assert.notEqual(rewritten.responseItem.rolloutRecord.generation, later.responseItem.rolloutRecord.generation);
      await publication.service.applyActive(run, rewritten);
      assert.equal(run.responseText, native);
      assert.equal(publication.states.at(-1).answer, native);

      const unanchored = { ...binding, responseItems: [] };
      completeCodexAgentMessage(unanchored, { turnId, item: {
        id: "same-final", type: "agentMessage", phase: "final_answer", text: native,
      } });
      codex.applyObserved(unanchored, await codex.read(unanchored));
      assert.equal(unanchored.responseText, native);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("selected native items reject unseen older IDs and admit proven later distinct items", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub430-selection-order-"));
  try {
    for (const external of [false, true]) {
      const file = path.join(directory, `${external}.jsonl`);
      await writeFile(file, start() + message("old-final", "final_answer", "Old final"));
      const codex = observer(() => readCodexRolloutActivity(file));
      const run = createObservedTaskRun(binding, { answer: "" });
      run.observer = external;
      completeCodexAgentMessage(run, { turnId, item: {
        id: "new-final", type: "agentMessage", phase: "final_answer", text: "New final",
      } });
      const publication = publisher(codex);
      await publication.service.applyActive(run, await codex.read(run, readOptions));
      assert.equal(run.responseItemId, "new-final");
      assert.equal(run.responseText, "New final");
      assert.equal(publication.states.at(-1).answer, "New final");
      assert.deepEqual(run.responseItems.map((item) => item.id), ["new-final"]);

      const equal = "Distinct items retain equal text";
      await writeFile(file, start() + message("first", "final_answer", equal));
      const initial = await codex.read(binding);
      const anchored = createObservedTaskRun(binding, initial);
      anchored.observer = external;
      completeCodexAgentMessage(anchored, { turnId, item: {
        id: "first", type: "agentMessage", phase: "final_answer", text: equal,
      } });
      await appendFile(file, message("second", "final_answer", equal));
      await publication.service.applyActive(anchored, await codex.read(anchored, readOptions));
      assert.equal(anchored.responseItemId, "second");
      assert.equal(anchored.responseText, equal);
      assert.equal(publication.states.at(-1).answer, equal);
      assert.deepEqual(anchored.responseItems.map((item) => item.id), ["first", "second"]);

      // A new record for a retained ID carries new source order too.
      await appendFile(file, message("first", "final_answer", "Later short"));
      await publication.service.applyActive(anchored, await codex.read(anchored, readOptions));
      assert.equal(anchored.responseItemId, "first");
      assert.equal(anchored.responseText, "Later short");
      assert.equal(publication.states.at(-1).answer, "Later short");
      assert.equal(anchored.responseItems.length, 2);

      completeCodexAgentMessage(anchored, { turnId, item: {
        id: "first", type: "agentMessage", phase: "final_answer", text: "Newer native",
      } });
      await writeFile(file, start() + message("unseen", "final_answer", "Earlier unseen"));
      await publication.service.applyActive(anchored, await codex.read(anchored, readOptions));
      assert.equal(anchored.responseItemId, "first");
      assert.equal(anchored.responseText, "Newer native");
      assert.equal(publication.states.at(-1).answer, "Newer native");
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
