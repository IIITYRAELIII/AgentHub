import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const root = new URL("../../assets/web-app/", import.meta.url);
const source = await readFile(new URL("hub-client.js", root), "utf8");
const lifecycle = await readFile(new URL("messages/lifecycle.js", root), "utf8");
const projection = await readFile(new URL("messages/projection.js", root), "utf8");

// Execute the actual client reconciliation functions, with rendering and file
// cleanup replaced by sinks. Assertions concern state transitions, not source text.
function harness() {
  const context = vm.createContext({ queueMicrotask, console });
  context.window = context;
  vm.runInContext(lifecycle, context);
  vm.runInContext(projection, context);
  vm.runInContext(`
    const { conversationTaskId, outgoingTaskId, queueHistoryReceiptProjection,
      normalizedResponseAnnotations, providerAcceptedHistoryClientUserMessageIds,
      messageAwaitsProviderAcceptance, rememberBounded: rememberBoundedMessage } = AgentHubMessageLifecycle;
    const outgoingByTask = new Map();
    const historyByTask = new Map();
    const acknowledgedQueueCancels = new Set();
    const optimisticDeferredClientUserMessageIds = new Set();
    let deferredClientUserMessageIds = new Set();
    const MAX_OUTGOING_MESSAGES_PER_TASK = 100;
    const renderTaskMessages = () => {};
    const confirmedCardOrigin = () => null;
    const attachmentViews = (values) => values ?? [];
    const nonEmptyAttachmentPatch = () => ({});
    const traceEvents = [];
    const commandTrace = { record(...args) { traceEvents.push(args); } };
  `, context);
  for (const name of ["exactSnapshotTaskId", "outgoingMessages", "rememberOutgoing", "deliveryPatch",
    "retireAcceptedOutgoingQueue", "updateOutgoing", "patchOutgoing", "optimisticDeferredEntries", "applyMessageReceipts"]) {
    const start = source.indexOf(`function ${name}(`);
    const next = source.slice(start + 1).search(/\n(?:async )?function /u);
    vm.runInContext(source.slice(start, next < 0 ? undefined : start + 1 + next), context);
  }
  return (code) => vm.runInContext(code, context);
}

const receipt = {
  provider: "codex", threadId: "thread-old", streamId: "stream-one",
  clientUserMessageId: "confirmed-command", accepted: true, providerAccepted: true,
  pending: false, deferred: false, queued: false, clientProjectionIntent: "conversation",
  runId: "run-original", turnId: "turn-original",
};

function seed(run, message = {}) {
  run(`rememberOutgoing("stream-one", ${JSON.stringify({
    role: "user", provider: "codex", threadId: "thread-old", streamId: "stream-one",
    clientUserMessageId: "confirmed-command", text: "Accepted source message",
    providerAccepted: false, projectionState: "queued", deliveryState: "accepted", ...message,
  })}); optimisticDeferredClientUserMessageIds.add("confirmed-command");
    deferredClientUserMessageIds.add("confirmed-command");`);
}

function apply(run, value = receipt, tasks = [{ provider: "codex", threadId: "thread-new", streamId: "stream-one" }]) {
  run(`applyMessageReceipts(${JSON.stringify({ tasks, messageReceipts: [value] })})`);
}

test("old Thread receipt retires an existing exact command after rotation without history in the window", () => {
  const run = harness(); seed(run);
  assert.equal(run('optimisticDeferredEntries("stream-one").length'), 1);
  apply(run);
  assert.equal(run('optimisticDeferredEntries("stream-one").length'), 0);
  assert.equal(run('deferredClientUserMessageIds.has("confirmed-command")'), false);
  assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").turnId'), "turn-original");
  assert.equal(run('outgoingMessages("stream-one").size'), 1, "canonical user entity is retained");
});

test("a proven provider acceptance cannot return to the queue on a late intake response", () => {
  const run = harness(); seed(run);
  apply(run, receipt, [{ provider: "codex", threadId: "thread-old", streamId: "stream-one" }]);
  run(`optimisticDeferredClientUserMessageIds.add("confirmed-command");
    deferredClientUserMessageIds.add("confirmed-command");
    updateOutgoing("stream-one", "confirmed-command", {
      providerAccepted: false, projectionState: "queued", turnId: "", deliveryState: "queued"
    });`);
  assert.equal(run('optimisticDeferredEntries("stream-one").length'), 0);
  assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").providerAccepted'), true);
  assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").turnId'), "turn-original");
});

test("receipt ownership cannot be guessed from an accepted label or foreign identity", () => {
  for (const patch of [
    { streamId: "stream-foreign" }, { provider: "claude" }, { threadId: "thread-foreign" },
    { streamId: "" }, { clientUserMessageId: "other-command" },
  ]) {
    const run = harness(); seed(run);
    apply(run, { ...receipt, ...patch });
    assert.equal(run('optimisticDeferredEntries("stream-one").length'), 1);
    assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").providerAccepted'), false);
  }
});

test("old receipt cannot restore a new outgoing occurrence without an exact current binding", () => {
  const run = harness(); apply(run);
  assert.equal(run('outgoingByTask.size'), 0);
});

test("two exact steers in one turn retire independently while unknown input stays queued", () => {
  const run = harness(); seed(run);
  run(`rememberOutgoing("stream-one", {role:"user",provider:"codex",threadId:"thread-old",streamId:"stream-one",
    clientUserMessageId:"second-command",text:"Second steer",providerAccepted:false,projectionState:"queued"});
    optimisticDeferredClientUserMessageIds.add("second-command"); deferredClientUserMessageIds.add("second-command");
    rememberOutgoing("stream-one", {role:"user",provider:"codex",threadId:"thread-old",streamId:"stream-one",
    clientUserMessageId:"unknown-command",text:"Unknown",providerAccepted:false,projectionState:"unknown"});
    optimisticDeferredClientUserMessageIds.add("unknown-command"); deferredClientUserMessageIds.add("unknown-command");`);
  apply(run, {...receipt,steered:true}, [{provider:"codex",threadId:"thread-old",streamId:"stream-one"}]);
  apply(run, {...receipt,steered:true,clientUserMessageId:"second-command"}, [{provider:"codex",threadId:"thread-old",streamId:"stream-one"}]);
  assert.equal(run('optimisticDeferredEntries("stream-one").length'), 1);
  assert.equal(run('outgoingMessages("stream-one").size'), 3);
  assert.equal(run('outgoingMessages("stream-one").get("second-command").turnId'), "turn-original");
  assert.equal(run('outgoingMessages("stream-one").get("unknown-command").providerAccepted'), false);
});

test("a known foreign Stream cannot retire or rewrite another Stream's same client id", () => {
  const run = harness(); seed(run);
  apply(run, {...receipt,streamId:"stream-foreign",threadId:"thread-foreign"}, [
    {provider:"codex",threadId:"thread-old",streamId:"stream-one"},
    {provider:"codex",threadId:"thread-foreign",streamId:"stream-foreign"},
  ]);
  assert.equal(run('optimisticDeferredEntries("stream-one").length'), 1);
  assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").providerAccepted'), false);
  assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").threadId'), "thread-old");
});

test("canonical acceptance in the same current Stream may rebind the submitted source Thread", () => {
  const run=harness();seed(run);
  apply(run,{...receipt,threadId:"thread-new",turnId:"turn-new"});
  assert.equal(run('optimisticDeferredEntries("stream-one").length'),0);
  assert.equal(run('outgoingMessages("stream-one").size'),1);
  assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").threadId'),"thread-new");
  assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").turnId'),"turn-new");
});

test("unknown receipt and removed Stream cannot establish acceptance", () => {
  for (const [value,tasks] of [
    [{...receipt,accepted:false,providerAccepted:false,unknown:true,turnId:""},
      [{provider:"codex",threadId:"thread-old",streamId:"stream-one"}]],
    [receipt, []],
  ]) {
    const run=harness();seed(run);apply(run,value,tasks);
    assert.equal(run('optimisticDeferredEntries("stream-one").length'),1);
    assert.equal(run('outgoingMessages("stream-one").get("confirmed-command").providerAccepted'),false);
  }
});

test("retirement records the original command identity without message contents", () => {
  const run=harness();seed(run);apply(run);
  const events=JSON.parse(run('JSON.stringify(traceEvents)'));
  assert.equal(events.length,1);
  assert.deepEqual(events[0], ["ui-snapshot","accepted-queue-retired",0,"confirmed-command", {
    provider:"codex",threadId:"thread-old",streamId:"stream-one",turnId:"turn-original",
  }]);
  assert.equal(JSON.stringify(events).includes("Accepted source message"),false);
  apply(run);
  assert.equal(run('traceEvents.length'),1,"unchanged receipts do not repeat a retirement");
});
