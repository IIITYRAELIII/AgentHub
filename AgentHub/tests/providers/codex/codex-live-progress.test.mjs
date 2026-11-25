import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CodexAppServerTransport } from "../../../src/providers/codex/codex-app-server-transport.mjs";
import { markProviderTurnEvent } from "../../../src/domain/task-runs.mjs";
import { appendCodexAgentMessageDelta, completeCodexAgentMessage } from "../../../src/providers/codex/codex-agent-message-reducer.mjs";
import { currentLiveProgress } from "../../fixtures/current-live-progress.mjs";

test("the current exact live Codex turn regains its desktop progress after a failed read", async () => {
  const f = currentLiveProgress();
  await f.poll();
  assert.equal(f.project().running, true);
  f.fail(); await f.poll();
  assert.equal(f.run.activityUnknown, true);
  assert.equal(f.project().running, false);
  f.resume(); await f.poll();
  assert.equal(f.run.activityUnknown, false, "fresh exact live evidence must restore the current run display");
  assert.equal(f.project().running, true);
  assert.equal(f.project().run.turnId, "turn-live");
  assert.equal(f.taskRuns.forTask(f.run), f.run);
  assert.equal(f.completed.length, 0);
  assert.equal(f.reads.at(-1).fresh, true);
  assert.equal(f.reads.at(-1).includeTurns, true);
  assert.equal(f.reads.at(-1).turnLimit, 1);
  assert.equal(f.reads.at(-1).turnPageSize, 1);
});

test("current confirmation uses the real transport's latest exact turn page without history pagination", async t => {
  const child = new EventEmitter();
  Object.assign(child, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
  const requests = [];
  child.stdin.on("data", buffer => {
    const request = JSON.parse(String(buffer).trim()); requests.push(request);
    const result = request.method === "thread/read"
      ? { thread: { id: "thread-a", path: "controlled-rollout", status: { type: "active" } } }
      : { data: [{ id: "turn-live", status: "inProgress", items: [] }], nextCursor: "unrequested-older-history" };
    queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id, result }) + "\n"));
  });
  const transport = new CodexAppServerTransport({ spawnProcess: async () => child,
    stopProcessTree: async () => true, onMessage() {}, onExit() {}, onStderr() {} });
  await transport.start(); t.after(() => transport.stop());
  const f = currentLiveProgress({ readThread: (id, options) => transport.readThread(id, options) });
  f.run.activityUnknown = true;
  await f.poll();
  assert.equal(f.project().running, true);
  assert.deepEqual(requests.map(request => request.method), ["thread/read", "thread/turns/list"]);
  assert.deepEqual(requests[1].params, { threadId: "thread-a", limit: 1, sortDirection: "desc", itemsView: "full" });
  assert.equal(f.completed.length, 0);
});

test("a retained start, missing exact native turn and interrupted projection remain unknown", async () => {
  for (const status of ["interrupted", "completed", "missing"]) {
    const f = currentLiveProgress();
    f.run.activityUnknown = true;
    if (status === "missing") f.turn.id = "another-turn";
    else f.turn.status = status;
    await f.poll();
    assert.equal(f.run.activityUnknown, true);
    assert.equal(f.project().running, false);
    assert.equal(f.taskRuns.forTask(f.run), f.run);
    assert.equal(f.completed.length, 0);
  }
});

test("idle, missing and foreign native Thread metadata cannot confirm a retained inProgress turn", async () => {
  for (const metadata of [
    { id: "thread-a", status: { type: "idle" } },
    { id: "thread-a", status: { type: "notLoaded" } },
    { id: "thread-a" },
    { status: { type: "active" } },
    { id: "foreign-thread", status: { type: "active" } },
  ]) {
    const f = currentLiveProgress({ readThread: async () => ({ thread: {
      ...metadata, path: "controlled-rollout", turns: [{ id: "turn-live", status: "inProgress", items: [] }],
    } }) });
    f.run.activityUnknown = true;
    await f.poll();
    assert.equal(f.project().running, false);
    assert.equal(f.run.activityUnknown, true);
    assert.equal(f.taskRuns.forTask(f.run), f.run);
    assert.equal(f.completed.length, 0);
  }
});

test("read failure stays unknown and an exact terminal cannot be resurrected by a later read", async () => {
  const f = currentLiveProgress();
  f.fail(); await f.poll(); await f.poll();
  assert.equal(f.run.activityUnknown, true);
  f.resume(); f.terminal(); await f.poll();
  assert.deepEqual(f.completed, ["turn-live"]);
  const reads = f.reads.length;
  await f.poll();
  assert.equal(f.reads.length, reads);
  assert.equal(f.project().running, false);
});

test("completion and registry replacement while reading discard the late active result", async () => {
  for (const replace of [false, true]) {
    const f = currentLiveProgress();
    f.run.activityUnknown = true;
    let release;
    f.hold(new Promise(resolve => { release = resolve; }));
    const pending = f.poll();
    f.taskRuns.remove(f.run);
    if (replace) f.taskRuns.add({ ...f.run, id: "new-run", turnId: "new-turn", activityUnknown: false });
    else f.run.status = "completed";
    release(); await pending;
    assert.equal(f.run.activityUnknown, true);
    assert.equal(f.publications.length, 0);
    assert.equal(f.completed.length, 0);
  }
});

test("a callback for a retained previous-local execution performs no provider read or admission", async () => {
  const f = currentLiveProgress();
  f.taskRuns.remove(f.run);
  f.run.localAdmissionReleased = true;
  f.run.activityUnknown = true;
  f.taskRuns.addRestored(f.run, structuredClone(f.run));
  assert.equal(f.taskRuns.forEvent({ turnId: f.run.turnId }), f.run);
  assert.equal(f.taskRuns.forTask(f.run), null);
  await f.poll();
  assert.equal(f.reads.length, 0);
  assert.equal(f.scheduled.length, 0);
  assert.equal(f.completed.length, 0);
});

test("native progress during confirmation does not starve the live display or lose the newer body", async () => {
  const f = currentLiveProgress(); f.run.activityUnknown = true;
  let release;
  f.hold(new Promise(resolve => { release = resolve; }));
  const pending = f.poll();
  assert.equal(markProviderTurnEvent(f.run, { turnId: f.run.turnId,
    method: "item/completed", phase: "working" }), true);
  completeCodexAgentMessage(f.run, { turnId: f.run.turnId,
    item: { id: "new-native-item", type: "agentMessage", phase: "final_answer", text: "Newer native live body" } });
  release(); await pending;
  assert.equal(f.run.activityUnknown, false);
  assert.equal(f.project().running, true);
  assert.equal(f.run.responseText, "Newer native live body");
  assert.equal(f.run.responseItemId, "new-native-item");
});

test("a nonempty native confirmation without an intervening event restores its exact item", async () => {
  const f = currentLiveProgress({ readThread: async () => ({ thread: {
    id: "thread-a", path: "controlled-rollout", status: { type: "active" },
    turns: [{ id: "turn-live", status: "inProgress", items: [
      { id: "native-answer", type: "agentMessage", phase: "final_answer", text: "Observed live answer" },
    ] }],
  } }) });
  f.run.activityUnknown = true;
  await f.poll();
  assert.equal(f.project().running, true);
  assert.equal(f.run.responseText, "Observed live answer");
  assert.equal(f.run.responseItemId, "native-answer");
  assert.equal(f.publications.at(-1).answer, "Observed live answer");
});

test("nonempty stale native confirmation preserves newer completion and delta bodies and citation bindings", async () => {
  for (const event of ["same-item-completion", "same-item-delta", "new-item-completion"]) {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const old = "Old observed live body";
    const f = currentLiveProgress({ readThread: async () => { await held; return { thread: {
      id: "thread-a", path: "controlled-rollout", status: { type: "active" },
      turns: [{ id: "turn-live", status: "inProgress", items: [
        { id: "same-native-item", type: "agentMessage", phase: "final_answer", text: old },
      ] }],
    } }; } });
    f.run.userMessages[0].responseAnnotations = [{ text: "Quote A", annotation: "Comment A" }];
    completeCodexAgentMessage(f.run, { turnId: f.run.turnId, item: {
      id: "same-native-item", type: "agentMessage", phase: "final_answer", text: old,
    } });
    f.run.activityUnknown = true;
    const pending = f.poll();
    if (event === "same-item-delta") {
      appendCodexAgentMessageDelta(f.run, { turnId: f.run.turnId, itemId: "same-native-item",
        delta: ' plus newer native delta :agent-annotation{index="1"}' });
    } else {
      completeCodexAgentMessage(f.run, { turnId: f.run.turnId, item: {
        id: event === "new-item-completion" ? "new-native-item" : "same-native-item",
        type: "agentMessage", phase: "final_answer", text: 'Newer native live body :agent-annotation{index="1"}',
      } });
    }
    const expected = { text: f.run.responseText, itemId: f.run.responseItemId,
      references: structuredClone(f.run.responseAnnotationReferences) };
    assert.equal(expected.references.length, 1);
    release(); await pending;
    assert.equal(f.project().running, true, "new progress cannot starve valid same-live activity confirmation");
    assert.equal(f.run.responseText, expected.text, event);
    assert.equal(f.run.responseItemId, expected.itemId, event);
    assert.deepEqual(f.run.responseAnnotationReferences, expected.references, event);
    assert.equal(f.publications.at(-1).answer, expected.text, event);
  }
});

test("native confirmation preserves canonical final selection, legacy parts and exact citation source", async () => {
  const user = { id: "user-native", clientId: "client-native", type: "userMessage", content: [{ type: "text",
    text: '<response-annotations>[{"text":"Quote A","annotation":"Comment A"}]</response-annotations>\nContinue' }] };
  const agent = (id, text, phase) => ({ id, type: "agentMessage", text, ...(phase ? { phase } : {}) });
  for (const { items, text, ids, referenceClient } of [
    { items: [agent("part-1", "Legacy first"), agent("part-2", "Legacy second")],
      text: "Legacy first\n\nLegacy second", ids: ["part-1", "part-2"] },
    { items: [agent("old-final", "Earlier", "final_answer"), agent("final", "Selected", "final_answer"),
      agent("later-commentary", "Still working", "commentary"),
      { ...agent("question", "Pick", "final_answer"), questions: [{ title: "Choose" }] }],
      text: "Selected", ids: ["final"] },
    { items: [{ id: "plan", type: "plan", text: "Plan answer" }, agent("comment", "Working", "commentary")],
      text: "Plan answer", ids: ["plan"] },
    { items: [user, agent("annotated", 'Visible answer :agent-annotation{index="1"}', "final_answer")],
      text: "Visible answer \nЦитата 1", ids: ["annotated"], referenceClient: "client-native" },
  ]) {
    const f = currentLiveProgress({ readThread: async () => ({ thread: {
      id: "thread-a", path: "controlled-rollout", status: { type: "active" },
      turns: [{ id: "turn-live", status: "inProgress", items }],
    } }) });
    f.run.activityUnknown = true;
    await f.poll();
    assert.equal(f.project().running, true);
    assert.equal(f.run.responseText, text);
    assert.equal(f.publications.at(-1).answer, text);
    assert.deepEqual(f.run.responseItems.map(item => item.id), ids);
    if (referenceClient) {
      assert.equal(f.run.responseAnnotationReferences.length, 1);
      assert.equal(f.run.responseAnnotationReferences[0].target.clientUserMessageId, referenceClient);
    }
  }
});
