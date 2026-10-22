import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { createDesktopTaskHistoryFactory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { mergeActiveTaskHistory, mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";

const disclosureSource = await readFile(
  new URL("../../assets/web-app/messages/disclosure.js", import.meta.url),
  "utf8",
);
const source = await readFile(
  new URL("../../assets/web-app/messages/lifecycle.js", import.meta.url),
  "utf8",
);
const context = vm.createContext({});
context.window = context;
vm.runInContext(disclosureSource, context);
vm.runInContext(source, context);
const lifecycle = context.AgentHubMessageLifecycle;
const projectionSource = await readFile(
  new URL("../../assets/web-app/messages/projection.js", import.meta.url),
  "utf8",
);
const projectionContext = vm.createContext({});
vm.runInContext(projectionSource, projectionContext);
const projection = projectionContext.AgentHubMessageProjection;
const hubClientSource = await readFile(
  new URL("../../assets/web-app/hub-client.js", import.meta.url),
  "utf8",
);
const miniAppSource = await readFile(
  new URL("../../assets/web-app/app.js", import.meta.url),
  "utf8",
);
const streamTabsSource = await readFile(
  new URL("../../assets/web-app/stream-tabs-controller.js", import.meta.url),
  "utf8",
);
const compositionDirectory = new URL("../../src/composition/", import.meta.url);
const serverSource = (await Promise.all(
  (await readdir(compositionDirectory))
    .filter((name) => name.endsWith(".mjs"))
    .map((name) => readFile(new URL(name, compositionDirectory), "utf8")),
)).join("\n");
const codexEventSource = await readFile(
  new URL("../../src/providers/codex/codex-event-service.mjs", import.meta.url),
  "utf8",
);
const codexContextMaintenanceSource = await readFile(
  new URL("../../src/providers/codex/codex-context-maintenance-service.mjs", import.meta.url),
  "utf8",
);

function clientFunctionSource(name, nextMarker) {
  let start = hubClientSource.indexOf(`function ${name}`);
  if (hubClientSource.slice(Math.max(0, start - 6), start) === "async ") start -= 6;
  const closing = /\r?\n\}\r?\n/u.exec(hubClientSource.slice(start));
  const end = name === "applyOpened" || !nextMarker
    ? start + closing.index + closing[0].length : hubClientSource.indexOf(nextMarker, start);
  assert.notEqual(start, -1, `${name} source start`);
  assert.notEqual(end, -1, `${name} source end`);
  return hubClientSource.slice(start, end);
}

function message(itemId, text) {
  return {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    clientUserMessageId: itemId,
    role: "user",
    text,
  };
}

async function pagedActiveHistoryHarness(durableTurnCount) {
  const identity = { streamId: "stream-active", provider: "codex", threadId: "thread-active" };
  const startedAt = "2026-09-11T01:53:00Z";
  const durable = Array.from({ length: durableTurnCount }, (_, index) => ({
    id: `old-${index}`,
    completed: true,
    status: "completed",
    startedAt: new Date(Date.parse(startedAt) - (durableTurnCount - index) * 60_000).toISOString(),
    messages: [{ role: "user", itemId: `old-user-${index}`, clientUserMessageId: `old-client-${index}`, text: `Question ${index}` }],
  }));
  const run = {
    ...identity,
    id: "run-active",
    turnId: "turn-active",
    promptPreview: "Accepted question",
    responseText: "Unfinished answer",
    clientUserMessageId: "client-active",
    startedAt,
    userMessages: [{ role: "user", itemId: "user-active", clientUserMessageId: "client-active",
      text: "Accepted question", submittedAt: startedAt, time: startedAt }],
    responseItemId: "agent-active",
  };
  // Match the production SQLite readPage boundary: a live-only turn is absent
  // from the durable page even after the factory has warmed its hydrated cache.
  const backend = createDesktopTaskHistoryFactory({
    selection: { activeProvider: () => identity.provider, threadId: () => identity.threadId, chatId: () => 1 },
    catalog: { entries: () => [{ ...identity, title: "Active chat", projectRoot: "fixture" }] },
    historyReader: {
      readPage: async (_bindings, { before, limit }) => {
        const end = before == null ? durable.length : Math.min(before, durable.length);
        const start = Math.max(0, end - limit);
        return { start, end, total: durable.length, messageTotal: durable.length,
          items: durable.slice(start, end).map((turn) => ({ ...identity, turn: structuredClone(turn) })) };
      },
    },
    runs: { forTask: () => run },
    historyMerger: { mergeActive: mergeActiveTaskHistory, mergeCompleted: mergeCompletedTaskHistory },
    responseBudget: { fit: (payload) => payload },
  });
  const pending = new Map([["client-active", { ...identity, turnId: run.turnId,
    ...run.userMessages[0], submittedAt: startedAt }]]);
  const sandbox = vm.createContext({
    ...lifecycle,
    canonicalProjectionState: projection.projectionState,
    ...projection,
    Map, Set, performance,
    historyByTask: new Map(), historyWindowByTask: new Map(), focusedHistoryWindowByTask: new Map(),
    historyPageByTask: new Map(), historyLoadStates: new Map(),
    historyRequestGenerationByTask: new Map(), visibleHistoryLoads: new Set(),
    completionOverlaysByTask: new Map(), maintenanceEventsByTask: new Map(), activeMaintenanceByTask: new Map(),
    liveUserMessagesByTask: new Map(), liveProbeByTask: new Map(),
    optimisticDeferredClientUserMessageIds: new Set(), deferredClientUserMessageIds: new Set(),
    selectedTaskId: identity.streamId,
    directChatRoute: () => null,
    lastSnapshot: { tasks: [] },
    liveCardsByTask: new Map(),
    snapshotResponseIsStale: () => false,
    snapshotTask: () => null,
    traceHistoryCard: () => {},
    commandTrace: { now: () => 0, objectId: () => "", newId: () => "fixture-open", record: () => {}, afterPaint: () => {} },
    taskId: (provider, threadId, streamId) => streamId || `${provider}:${threadId}`,
    taskIdentity: () => identity,
    attachmentViews: (values) => values ?? [],
    outgoingMessages: () => pending,
    reconcileMessageLifecycle: lifecycle.reconcile,
    deliveryPatch: (deliveryState) => ({ deliveryState }),
    backgroundHttpScheduler: { run: (read) => read() },
    control: (action, params) => { assert.equal(action, "task-history"); return backend(params); },
    clearDurablyCompletedLiveCard: () => {},
    syncHistoryPagination: () => {}, renderTaskMessages: () => [], renderTaskQueue: () => {},
    updateHistoryCatchUp: () => {}, displayedFinalAcknowledgement: () => false,
  });
  sandbox.window = sandbox;
  vm.runInContext([
    clientFunctionSource("verifiedTaskHistory", "function beginNavigation"),
    clientFunctionSource("historyMessages", "function applyOpened"),
    clientFunctionSource("applyOpened", "function acknowledgeDisplayedFinal"),
    clientFunctionSource("reconciledMessages", "function deferredEntriesForTask"),
    clientFunctionSource("mergeHistoryLoadRequest", "async function loadVisibleTaskHistories"),
  ].join("\n"), sandbox);
  const opened = await backend({ ...identity, limit: 20 });
  sandbox.applyOpened({ history: opened }, { selectTask: false, skipSnapshot: true });
  return {
    pending,
    messages: () => Array.from(sandbox.reconciledMessages(identity.streamId)),
    page: () => sandbox.historyPageByTask.get(identity.streamId),
    refresh: () => sandbox.enqueueTaskHistoryLoad(identity.streamId, identity),
    loadOlder: async () => {
      const page = sandbox.historyPageByTask.get(identity.streamId);
      const older = await backend({ ...identity, before: page.start, limit: 20 });
      sandbox.historyByTask.set(identity.streamId, sandbox.prependOlderHistory(
        sandbox.historyByTask.get(identity.streamId), sandbox.historyMessages(older),
      ));
      Object.assign(page, { start: older.start, nextBefore: older.nextBefore });
    },
  };
}

test("paged background history retains an accepted active question after optimistic reconciliation", async () => {
  const harness = await pagedActiveHistoryHarness(1);
  assert.equal(harness.messages().filter((item) => item.clientUserMessageId === "client-active").length, 1);
  assert.equal(harness.pending.size, 0, "the question must no longer depend on its optimistic copy");
  assert.equal(harness.messages().filter((item) => item.role === "agent").length, 0);
  await harness.refresh();
  assert.equal(harness.messages().filter((item) => item.clientUserMessageId === "client-active").length, 1,
    "a warm paged history refresh must not erase the accepted live-only question");
  assert.equal(harness.messages().filter((item) => item.role === "agent").length, 0, "intermediate answer stays on the live surface");
  assert.equal(harness.messages().filter((item) => item.clientUserMessageId === "old-client-0").length, 1);
});

test("active history refresh preserves previously loaded older pages without duplicating the question", async () => {
  const harness = await pagedActiveHistoryHarness(25);
  harness.messages();
  await harness.loadOlder();
  const before = harness.messages().map((item) => item.clientUserMessageId);
  const previousStart = harness.page().start;
  const previousCursor = harness.page().nextBefore;
  assert.equal(before.length, 26);
  await harness.refresh();
  assert.deepEqual(harness.messages().map((item) => item.clientUserMessageId), before);
  assert.equal(harness.page().start, previousStart);
  assert.equal(harness.page().nextBefore, previousCursor);
  assert.equal(harness.messages().filter((item) => item.clientUserMessageId === "client-active").length, 1);
  assert.equal(harness.messages().filter((item) => item.role === "agent").length, 0);
});

test("latest navigation intent wins when responses settle out of order", async () => {
  const source = clientFunctionSource(
    "createLatestIntentController",
    "const navigationIntents",
  );
  const sandbox = vm.createContext({ Object });
  vm.runInContext(`${source}; globalThis.createController = createLatestIntentController;`, sandbox);
  const intents = sandbox.createController();
  const committed = [];
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  const open = async (gate, value) => {
    const intent = intents.begin();
    await gate;
    if (intents.current(intent)) committed.push(value);
  };

  const first = open(firstGate, "stream-a");
  const second = open(secondGate, "stream-b");
  releaseSecond();
  await second;
  releaseFirst();
  await first;

  assert.deepEqual(committed, ["stream-b"]);
  assert.match(hubClientSource, /if \(pendingSelectionId === id\) pendingSelectionId = "";/u);
});

test("a stale navigation failure neither commits nor shows a toast", async () => {
  const source = clientFunctionSource("runNavigation", "function outgoingMessages");
  let generation = 0;
  const committed = [];
  const toasts = [];
  let rejectFirst;
  const firstGate = new Promise((_resolve, reject) => { rejectFirst = reject; });
  const sandbox = vm.createContext({
    agentHub: { toast: (message) => toasts.push(message) },
    beginNavigation: () => ({ generation: ++generation }),
    currentNavigation: (intent) => intent.generation === generation,
    hubErrorMessage: (error) => error.message,
    isConnectionFailure: () => false,
    recordTransientConnectionFailure: () => {},
  });
  vm.runInContext(`${source}; globalThis.navigate = runNavigation;`, sandbox);

  const first = sandbox.navigate({}, () => firstGate, () => committed.push("first"));
  await sandbox.navigate({}, async () => "second", () => committed.push("second"));
  rejectFirst(new Error("late failure"));
  await first;

  assert.deepEqual(committed, ["second"]);
  assert.deepEqual(toasts, []);
});

test("every operation that selects a new task invalidates an older navigation", () => {
  assert.match(
    hubClientSource,
    /agentHub\.on\("message:send", \(request\) => \{\s*if \(request\.draftStream\) beginNavigation\(\);/u,
  );
  assert.match(
    hubClientSource,
    /agentHub\.on\("task:new",[\s\S]*?runAction\(async \(\) => \{\s*beginNavigation\(\);/u,
  );
  assert.match(
    hubClientSource,
    /agentHub\.on\("stream:rebirth",[\s\S]*?runAction\(async \(\) => \{\s*beginNavigation\(\);/u,
  );
  assert.match(
    hubClientSource,
    /agentHub\.on\("stream:continue-provider",[\s\S]*?runAction\(async \(\) => \{\s*beginNavigation\(\);/u,
  );
  assert.match(
    hubClientSource,
    /agentHub\.on\("stream:new",[\s\S]*?if \(existing\) return existing;\s*beginNavigation\(\);/u,
  );
});

test("an invalid chat hash invalidates an in-flight navigation intent", async () => {
  const source = clientFunctionSource("openRoute", "function snapshotTask");
  let invalidations = 0;
  const sandbox = vm.createContext({
    beginNavigation: () => { invalidations += 1; },
    decodeURIComponent,
    location: { hash: "#/tasks" },
  });
  vm.runInContext(`${source}; globalThis.open = openRoute;`, sandbox);

  assert.equal(await sandbox.open(), false);
  sandbox.location.hash = "#/chat/codex/%E0%A4%A";
  assert.equal(await sandbox.open(), false);
  assert.equal(invalidations, 2);
});

test("an in-flight completion refresh follows a Stream rotation and discards the old Thread", { timeout: 5000 }, async () => {
  const source = clientFunctionSource("mergeHistoryLoadRequest", "async function loadVisibleTaskHistories");
  const generations = new Map();
  const responses = [];
  const applied = [];
  let currentIdentity = { streamId: "stream-1", provider: "codex", threadId: "thread-1" };
  let releaseFirst;
  let releaseSecond;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
  let dispatchedSecond;
  const secondDispatched = new Promise((resolve) => { dispatchedSecond = resolve; });
  const sandbox = vm.createContext({
    Map,
    selectedTaskId: "stream-1",
    directChatRoute: () => null,
    performance,
    commandTrace: { newId: () => "fixture-history", record: () => {}, afterPaint: () => {} },
    syncHistoryPagination: () => {},
    historyLoadStates: new Map(),
    historyRequestGenerationByTask: generations,
    visibleHistoryLoads: new Set(),
    historyPageByTask: new Map(),
    beginHistoryRequest: (id, identity) => {
      const generation = (generations.get(id) ?? 0) + 1;
      generations.set(id, generation);
      return { id, identity, generation };
    },
    currentHistoryRequest: (request) => generations.get(request.id) === request.generation,
    stableIdentity: (identity) => ({ ...identity }),
    settleOptionalRead: async (read) => ({ status: "fulfilled", value: await read() }),
    backgroundHttpScheduler: { run: (read) => read() },
    control: async () => {
      const index = responses.length;
      const responseIdentity = { ...currentIdentity };
      responses.push(index);
      if (index === 1) dispatchedSecond();
      await (index === 0 ? firstGate : secondGate);
      return { ...responseIdentity, items: [], version: String(index + 1) };
    },
    verifiedTaskHistory: (history) => history,
    sameIdentity: (left, right) => left.streamId === right.streamId
      && left.provider === right.provider && left.threadId === right.threadId,
    taskIdentity: () => currentIdentity,
    applyOpened: ({ history }) => applied.push(history.version),
  });
  vm.runInContext(`${source}; globalThis.enqueue = enqueueTaskHistoryLoad;`, sandbox);
  const identity = { ...currentIdentity };
  const first = sandbox.enqueue("stream-1", identity);
  currentIdentity = { streamId: "stream-1", provider: "claude", threadId: "thread-2" };
  const followUp = sandbox.enqueue("stream-1", currentIdentity, { refreshSource: true });
  let dispatchDeadline;
  try {
    releaseFirst();
    await Promise.race([
      secondDispatched,
      first.then(() => assert.fail("history refresh settled before dispatching the rotated Thread")),
      new Promise((_resolve, reject) => {
        dispatchDeadline = setTimeout(() => reject(new Error("rotated history request was not dispatched")), 1000);
      }),
    ]);
    releaseSecond();
    await Promise.all([first, followUp]);
  } finally {
    clearTimeout(dispatchDeadline);
    releaseFirst();
    releaseSecond();
    await Promise.allSettled([first, followUp]);
  }

  assert.equal(responses.length, 2);
  assert.deepEqual(applied, ["2"]);
});

test("aggregated Stream history preserves each item's provider and Thread", () => {
  const source = clientFunctionSource("historyMessages", "function mergeNewestHistory");
  const sandbox = vm.createContext({
    attachmentViews: () => [],
    conversationMessageAuthor: (_message, provider) => provider,
    focusedTurnAlreadyVisible: () => true,
    focusedTurnTaskThreadId: () => "",
    canonicalProjectionState: projection.projectionState,
    historicalMessagesForDisplay: (item) => item.messages,
  });
  vm.runInContext(`${source}; globalThis.mapHistory = historyMessages;`, sandbox);
  const messages = sandbox.mapHistory({
    provider: "claude",
    threadId: "thread-current",
    start: 0,
    items: [{
      id: "turn-old",
      provider: "codex",
      threadId: "thread-old",
      messages: [{ itemId: "answer", role: "agent", text: "готово" }],
    }],
  });

  assert.equal(messages[0].provider, "codex");
  assert.equal(messages[0].threadId, "thread-old");
  assert.match(messages[0].id, /^codex:thread-old:/u);
});

test("Web history mapping preserves canonical citation references", () => {
  const source = clientFunctionSource("historyMessages", "function mergeNewestHistory");
  const normalize = (references) => references.filter((reference) => reference.index === 1);
  const sandbox = vm.createContext({
    AgentHubMessageView: { normalizedResponseAnnotationReferences: normalize },
    attachmentViews: () => [],
    conversationMessageAuthor: () => "Codex",
    focusedTurnAlreadyVisible: () => true,
    focusedTurnTaskThreadId: (turn) => turn.threadId,
    canonicalProjectionState: projection.projectionState,
    historicalMessagesForDisplay: (item) => item.messages,
  });
  vm.runInContext(`${source}; globalThis.mapHistory = historyMessages;`, sandbox);
  const [historyAgent] = sandbox.mapHistory({
    provider: "codex",
    threadId: "thread-citation",
    items: [{
      id: "turn-citation",
      messages: [{
        itemId: "turn-citation:rollout-agent:final",
        role: "agent",
        responseAnnotationReferences: [{ index: 1 }, { index: 21 }],
      }],
    }],
  });
  const [focusedAgent] = sandbox.mapHistory({ items: [] }, {
    provider: "codex",
    threadId: "thread-focused-citation",
    turnId: "turn-focused-citation",
    messages: [{
      itemId: "msg_focused_citation",
      role: "agent",
      responseAnnotationReferences: [{ index: 1 }, { index: 21 }],
    }],
  });

  assert.deepEqual(historyAgent.responseAnnotationReferences, [{ index: 1 }]);
  assert.deepEqual(focusedAgent.responseAnnotationReferences, [{ index: 1 }]);
});

test("focused completed turn cannot append commentary after its durable final", () => {
  const source = clientFunctionSource("historyMessages", "function mergeNewestHistory");
  const sandbox = vm.createContext({
    attachmentViews: () => [],
    conversationMessageAuthor: (_message, provider) => provider,
    focusedTurnAlreadyVisible: lifecycle.focusedTurnAlreadyVisible,
    focusedTurnTaskThreadId: lifecycle.focusedTurnTaskThreadId,
    canonicalProjectionState: projection.projectionState,
    historicalMessagesForDisplay: lifecycle.historicalMessagesForDisplay,
  });
  vm.runInContext(`${source}; globalThis.mapHistory = historyMessages;`, sandbox);
  const root = { itemId: "user-root", role: "user", text: "Почему?" };
  const commentary = {
    itemId: "turn-1:rollout-agent:latest",
    role: "agent",
    text: "Проверяю причину",
  };
  const final = {
    itemId: "turn-1:rollout-agent:final",
    role: "agent",
    phase: "final_answer",
    text: "Причина найдена",
  };
  const steer = { itemId: "user-steer", role: "user", text: "Где ответ?" };
  const history = {
    provider: "codex",
    threadId: "thread-1",
    start: 0,
    items: [{
      id: "turn-1",
      provider: "codex",
      threadId: "thread-1",
      completed: true,
      messages: [root, commentary, final, steer],
    }],
  };
  const messages = sandbox.mapHistory(history, {
    provider: "codex",
    taskThreadId: "thread-1",
    turnId: "turn-1",
    messages: [root, commentary, final, steer],
  });

  assert.deepEqual(
    Array.from(messages, (message) => [message.role, message.itemId, message.text]),
    [
      ["user", "user-root", "Почему?"],
      ["agent", "turn-1:rollout-agent:final", "Причина найдена"],
      ["user", "user-steer", "Где ответ?"],
    ],
  );
});

test("repeated older pages retain each exact provider entity once after a Thread rebind", () => {
  const source = clientFunctionSource("prependOlderHistory", "function applyOpened");
  const sandbox = vm.createContext({
    Set,
    projectCanonicalMessages: projection.projectCanonicalMessages,
  });
  vm.runInContext(`${source}; globalThis.prepend = prependOlderHistory;`, sandbox);
  const previous = [{
    id: "codex:thread-old:turn-15:item-18:agent",
    provider: "codex",
    threadId: "thread-old",
    turnId: "turn-15",
    // Some restored provider finals do not expose an item id. The page still
    // has one canonical parent answer for this durable turn.
    itemId: "",
    role: "agent",
    text: "Сообщение 15:18",
    historyOrder: 20_001,
  }];
  const overlappingPage = [{
    ...previous[0],
    id: "claude:thread-new:turn-15:item-18:agent",
    provider: "claude",
    threadId: "thread-new",
    historyOrder: 19_001,
  }];

  let merged = previous;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    merged = sandbox.prepend(merged, overlappingPage);
  }

  assert.equal(merged.length, 2);
  assert.deepEqual(Array.from(merged, (message) => [message.provider, message.threadId]), [
    ["claude", "thread-new"],
    ["codex", "thread-old"],
  ]);
});

test("chat history fallback preserves the reader position after prepending a page", () => {
  assert.match(miniAppSource, /scrollHeight:\s*chatScroll\.scrollHeight/u);
  assert.match(
    miniAppSource,
    /addedHeight\s*=\s*Math\.max\(0, chatScroll\.scrollHeight - anchor\.scrollHeight\)/u,
  );
  assert.match(miniAppSource, /chatScroll\.scrollTop\s*=\s*anchor\.scrollTop \+ addedHeight/u);
});

test("rotated Stream history keeps the stable Stream cache key", () => {
  const tasks = [{
    streamId: "stream-themes",
    provider: "codex",
    threadId: "thread-new",
  }];
  assert.equal(lifecycle.conversationTaskId({
    streamId: "stream-themes",
    provider: "codex",
    threadId: "thread-old",
  }, tasks), "stream-themes");
  assert.equal(lifecycle.conversationTaskId({
    provider: "codex",
    threadId: "thread-new",
  }, tasks), "stream-themes");
});

test("message lifecycle reconciles user messages by the official client id", () => {
  const first = message("client-1", "Первое уточнение");
  const second = message("client-2", "Второе уточнение");
  const server = [
    { ...first, itemId: "server-item-1", text: "Серверное первое" },
    { ...second, itemId: "server-item-2", text: "Серверное второе" },
  ];
  const result = lifecycle.reconcile(server, [first, second]);
  assert.deepEqual([...result.matchedIds], ["client-1", "client-2"]);
  assert.equal(result.matches[0].local.clientUserMessageId, "client-1");
  assert.equal(result.matches[1].local.clientUserMessageId, "client-2");
});

test("message delivery distinguishes a server rejection from an unconfirmed transport failure", () => {
  const rejected = lifecycle.markCommandRejected(new Error("Укажите корректную задачу"));
  assert.equal(lifecycle.messageSendDefinitelyRejected(rejected), true);
  assert.equal(lifecycle.messageSendDefinitelyRejected(new Error("Agent Hub не ответил вовремя")), false);
  assert.equal(lifecycle.looksLikeConnectionFailure(new Error("Desktop control request timed out")), true);
  const abort = new Error("Signal is aborted without a reason");
  abort.name = "AbortError";
  assert.equal(lifecycle.looksLikeConnectionFailure(abort), true);
  const timeout = new Error("Agent Hub не подтвердил команду за 45 с.");
  timeout.name = "TimeoutError";
  timeout.code = "AGENT_HUB_CONTROL_TIMEOUT";
  assert.equal(
    lifecycle.hubErrorMessage(timeout),
    "Agent Hub не подтвердил приём вовремя. Статус сообщения уточняется.",
  );
  assert.match(hubClientSource, /timeout\.code = "AGENT_HUB_CONTROL_TIMEOUT"/u);
  assert.equal(rejected.agentHubCommandRejected, true);
});

test("live steer timing never borrows the root timestamp and enriches from its own intake", () => {
  const input = {
    provider: "codex", threadId: "thread-1", turnId: "turn-1",
    clientUserMessageId: "root", prompt: "Root",
    submittedAt: "2026-09-09T15:51:10.190Z", time: "2026-09-09T15:51:10.190Z",
    userMessages: [{ clientUserMessageId: "steer", text: "Later clarification" }],
  };
  const sparse = lifecycle.mergeLiveUserMessages([], input);
  assert.equal(sparse[0].time, null);
  assert.equal(sparse[0].submittedAt, null);
  const ownTime = "2026-09-09T16:05:45.479Z";
  input.userMessages[0].submittedAt = ownTime;
  const enriched = lifecycle.mergeLiveUserMessages(sparse, input);
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].time, ownTime);
  assert.equal(enriched[0].submittedAt, ownTime);
  input.userMessages[0].submittedAt = "2026-09-09T16:05:47.070Z";
  const afterReceiptEviction = lifecycle.mergeLiveUserMessages(enriched, input);
  assert.equal(afterReceiptEviction[0].submittedAt, ownTime);
  assert.equal(afterReceiptEviction[0].time, ownTime);
  delete input.userMessages[0].submittedAt;
  assert.equal(lifecycle.mergeLiveUserMessages(enriched, input)[0].submittedAt, ownTime);
});

test("history and focused steers never inherit a parent turn timestamp", () => {
  const source = clientFunctionSource("historyMessages", "function mergeNewestHistory");
  const sandbox = vm.createContext({
    attachmentViews: () => [],
    conversationMessageAuthor: (_message, provider) => provider,
    focusedTurnAlreadyVisible: () => true,
    focusedTurnTaskThreadId: (turn) => turn.threadId,
    canonicalProjectionState: projection.projectionState,
    historicalMessagesForDisplay: (item) => item.messages,
  });
  vm.runInContext(`${source}; globalThis.mapHistory = historyMessages;`, sandbox);
  const messages = [
    { itemId: "root", role: "user", turnUserSlot: "root", text: "Root" },
    { itemId: "steer", role: "user", turnUserSlot: "steer", text: "Later clarification" },
  ];
  const turn = { id: "turn-1", turnId: "turn-1", provider: "codex", threadId: "thread-1",
    startedAt: "2026-09-09T15:51:11.165Z", messages };
  for (const focused of [false, true]) {
    const result = sandbox.mapHistory({ provider: "codex", threadId: "thread-1",
      items: focused ? [] : [turn] }, focused ? turn : null);
    assert.equal(result.find((m) => m.itemId === "root").time, turn.startedAt);
    assert.equal(result.find((m) => m.itemId === "steer").time, null);
    assert.equal(result.find((m) => m.itemId === "steer").submittedAt, null);
  }
});

test("focused turn without message times keeps its startedAt chronology", () => {
  const source = clientFunctionSource("historyMessages", "function mergeNewestHistory");
  const sandbox = vm.createContext({
    attachmentViews: () => [],
    conversationMessageAuthor: (_message, provider) => provider,
    focusedTurnAlreadyVisible: () => false,
    focusedTurnTaskThreadId: (turn) => turn.threadId,
    canonicalProjectionState: projection.projectionState,
    historicalMessagesForDisplay: (item) => item.messages,
  });
  vm.runInContext(`${source}; globalThis.mapHistory = historyMessages;`, sandbox);
  const current = sandbox.mapHistory({
    provider: "codex",
    threadId: "thread-1",
    start: 10,
    items: [{
      id: "turn-current",
      startedAt: "2026-08-24T11:32:05.975Z",
      messages: [{
        itemId: "current-user",
        role: "user",
        text: "Повтори",
        time: "2026-08-24T11:32:05.975Z",
      }],
    }],
  }, {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-old",
    startedAt: "2026-08-24T10:27:26.000Z",
    messages: [{ itemId: "old-user", role: "user", text: "Запусти проверку" }],
  });

  assert.deepEqual(
    lifecycle.chronologicalMessages(Array.from(current)).map((message) => message.itemId),
    ["old-user", "turn-old:focused:agent", "current-user"],
  );
});

test("VS Code message delivery retries connection failures without changing the operation", async () => {
  const attempts = [];
  const waits = [];
  const result = await lifecycle.retryConnectionFailure(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 2) throw lifecycle.markConnectionFailure(new Error("bridge unavailable"));
    return { accepted: true };
  }, {
    delaysMs: [150, 600],
    wait: async (delayMs) => { waits.push(delayMs); },
  });

  assert.deepEqual(attempts, [0, 1, 2]);
  assert.deepEqual(waits, [150, 600]);
  assert.equal(result.accepted, true);
});

test("VS Code message delivery does not retry an application rejection", async () => {
  let attempts = 0;
  const rejected = lifecycle.markCommandRejected(new Error("Укажите корректную задачу"));
  await assert.rejects(lifecycle.retryConnectionFailure(async () => {
    attempts += 1;
    throw rejected;
  }, {
    delaysMs: [0, 0],
    wait: async () => {},
  }), /корректную задачу/u);
  assert.equal(attempts, 1);
});

test("Web control retries only blank gateway failures", async () => {
  const gateway = lifecycle.httpControlError(502, {});
  const application = lifecycle.httpControlError(503, { error: "Управление Agent Hub недоступно." });
  assert.equal(gateway.code, "AGENT_HUB_HTTP_GATEWAY");
  assert.equal(lifecycle.isConnectionFailure(gateway), true);
  assert.equal(lifecycle.messageSendDefinitelyRejected(gateway), false);
  assert.equal(lifecycle.messageSendDefinitelyRejected(application), true);

  const attempts = [];
  const result = await lifecycle.retryConnectionFailure(async (attempt) => {
    attempts.push(attempt);
    if (attempt < 2) throw lifecycle.httpControlError(502, {});
    return "accepted";
  }, {
    delaysMs: [0, 0],
    wait: async () => {},
    shouldRetry: (error) => error.code === "AGENT_HUB_HTTP_GATEWAY",
  });
  assert.equal(result, "accepted");
  assert.deepEqual(attempts, [0, 1, 2]);
  const executeHttpControl = (responses) => {
    const requests = [];
    let sequence = 0;
    const sandbox = vm.createContext({
      crypto: { randomUUID: () => `command-${++sequence}` },
      performance: { now: () => requests.length },
      localSessionReady: Promise.resolve(),
      retryConnectionFailure: lifecycle.retryConnectionFailure,
      httpControlError: lifecycle.httpControlError,
      HTTP_CONTROL_RETRY_DELAYS_MS: [0, 0, 0],
      LONG_CONTROL_ACTIONS: new Set(),
      DEFAULT_CONTROL_TIMEOUT_MS: 1_000,
      window: { setTimeout: (callback) => callback() },
      authorizationHeaders: () => ({}),
      hubFetchWithin: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        const response = responses.shift();
        if (response instanceof Error) throw response;
        return { status: response.status, ok: response.status === 200, json: async () => response.payload };
      },
    });
    vm.runInContext(clientFunctionSource("httpControl", "function clientTraceSurface"), sandbox);
    return { requests, result: sandbox.httpControl("send-message", {
      text: "same message", clientUserMessageId: "original-message", clientTraceId: "trace-1",
      clientTiming: { submittedAtMs: 123 },
    }) };
  };
  const retried = executeHttpControl([
    ...[502, 503, 504].map((status) => ({ status, payload: {} })),
    { status: 200, payload: { result: { accepted: true } } },
  ]);
  assert.equal((await retried.result).accepted, true);
  assert.equal(retried.requests.length, 4);
  for (const request of retried.requests) {
    assert.equal(request.commandId, retried.requests[0].commandId);
    assert.equal(request.params.clientUserMessageId, "original-message");
    assert.equal(request.params.clientTiming.submittedAtMs, 123);
    assert.equal(request.params.text, "same message");
  }
  for (const response of [
    { status: 503, payload: { error: "Application rejected" } },
    { status: 400, payload: {} },
    lifecycle.markConnectionFailure(new Error("network disconnected")),
  ]) {
    const rejected = executeHttpControl([response]);
    await assert.rejects(rejected.result);
    assert.equal(rejected.requests.length, 1);
  }
});

test("optional history reads settle without becoming connection failures", async () => {
  const failure = lifecycle.markConnectionFailure(new Error("history timed out"));
  const rejected = await lifecycle.settleOptionalRead(async () => {
    throw failure;
  });
  const fulfilled = await lifecycle.settleOptionalRead(async () => ({ version: "history-2" }));

  assert.equal(rejected.status, "rejected");
  assert.equal(rejected.reason, failure);
  assert.equal(fulfilled.status, "fulfilled");
  assert.equal(fulfilled.value.version, "history-2");
});

test("attachment-only labels distinguish documents from images", () => {
  assert.equal(lifecycle.attachmentOnlyText([{ type: "application/pdf" }]), "Вложение");
  assert.equal(lifecycle.attachmentOnlyText([{ type: "image/png" }]), "Изображение");
  assert.equal(lifecycle.attachmentOnlyText([{ type: "image/png" }, { type: "text/plain" }]), "Вложения");
  assert.equal(lifecycle.attachmentOnlyText([{ kind: "task", taskId: "board-1" }]), "");
});

test("attachment-only Task messages count as complete conversation content", () => {
  const prompt = {
    role: "user",
    turnId: "turn-task",
    text: "",
    attachments: [{ kind: "task", taskId: "board-1" }],
  };
  const final = {
    role: "agent",
    turnId: "turn-task",
    text: "Принято",
  };

  assert.equal(lifecycle.completedConversationTurnVisible([prompt, final], {
    turnId: "turn-task",
    answer: "Принято",
  }), true);
});

test("Stop cancels the run even when pausing one queued message fails", async () => {
  const calls = [];
  const stopped = await lifecycle.stopTaskControls({
    cancel: async () => { calls.push("cancel"); return { message: "Остановлено" }; },
    pause: async (item) => {
      calls.push(`pause:${item.id}`);
      if (item.id === "bad") throw new Error("stale queue item");
    },
    queued: [{ id: "bad" }, { id: "good" }],
  });
  assert.deepEqual(calls, ["cancel", "pause:bad", "pause:good"]);
  assert.equal(stopped.pauseFailures, 1);
  assert.equal(stopped.result.message, "Остановлено");
});

test("message delivery keeps the stable Stream identity when a Thread binding is stale", () => {
  assert.match(
    hubClientSource,
    /const params = \{[\s\S]*?streamId: identity\?\.streamId \?\? request\.streamId,[\s\S]*?provider: identity\?\.provider,[\s\S]*?threadId: identity\?\.threadId,/u,
  );
});

test("completed history keeps every subagent result before the parent final", () => {
  const visible = lifecycle.historicalMessagesForDisplay({
    id: "turn-1",
    completed: true,
    messages: [
      { role: "user", text: "Проверь" },
      {
        role: "agent", kind: "subagent", agentThreadId: "terra-thread",
        author: "Субагент (Terra)", text: "Первый отчёт",
      },
      {
        role: "agent", kind: "subagent", agentThreadId: "sol-thread",
        author: "Субагент (Sol)", text: "Второй отчёт",
      },
      { role: "agent", phase: "final_answer", text: "Общий итог" },
    ],
  });
  assert.deepEqual(Array.from(visible, (message) => message.text), [
    "Проверь", "Первый отчёт", "Второй отчёт", "Общий итог",
  ]);
  const identified = visible.map((message) => ({
    ...message,
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
  }));
  const deduplicated = lifecycle.deduplicateConversationMessages(identified);
  assert.deepEqual(Array.from(deduplicated, (message) => message.text), [
    "Проверь", "Первый отчёт", "Второй отчёт", "Общий итог",
  ]);
  assert.equal(lifecycle.visibleConversationMessages(identified, {
    liveProbe: { provider: "codex", threadId: "thread-1", turnId: "turn-1", role: "agent" },
  }).some((message) => message.kind === "subagent"), true);
});

test("subagent messages never fall back to the user author", () => {
  assert.equal(lifecycle.conversationMessageAuthor({
    role: "agent",
    kind: "subagent",
  }, "codex"), "Субагент (модель неизвестна)");
  assert.equal(lifecycle.conversationMessageAuthor({
    role: "agent",
    kind: "subagent",
    author: "Субагент (Terra)",
  }, "codex"), "Субагент (Terra)");
});

test("desktop running state ignores a retained completed run object", () => {
  const window = {};
  vm.runInNewContext(streamTabsSource, { window });
  const task = { running: false, run: { operationKind: "user-turn", projectionState: "completed" } };
  assert.equal(window.AgentHubStreamTabs.isExactActiveUserTurn(task), false);
  assert.equal(window.AgentHubStreamTabs.isExactActiveUserTurn({ running: true,
    run: { operationKind: "user-turn", projectionState: "active", turnId: "turn-active" } }), true);
});

test("response annotation envelopes become structured user messages", () => {
  const raw = [
    "# Response annotations:",
    "<response-annotations>",
    JSON.stringify([
      { text: "Первая цитата", annotation: "Первый комментарий" },
      { text: "Вторая цитата", annotation: "" },
    ]),
    "</response-annotations>",
    "",
    "## My request for Codex:",
    "Общий вопрос",
  ].join("\n");
  const normalized = lifecycle.normalizedUserMessage({ role: "user", text: raw });
  assert.equal(normalized.text, "Общий вопрос");
  assert.equal(normalized.responseAnnotationRequest, "Общий вопрос");
  assert.deepEqual(
    JSON.parse(JSON.stringify(normalized.responseAnnotations)),
    [
      { text: "Первая цитата", annotation: "Первый комментарий" },
      { text: "Вторая цитата", annotation: "" },
    ],
  );
  assert.doesNotMatch(normalized.text, /response-annotations|My request for Codex/iu);
});

test("message lifecycle removes a replayed server echo before optimistic reconciliation", () => {
  const local = message("client-1", "Сообщение отправлено один раз");
  const server = lifecycle.deduplicateConversationMessages([
    { ...local, itemId: "server-item-first" },
    { ...local, itemId: "server-item-replayed" },
  ]);
  assert.equal(server.length, 1);
  const result = lifecycle.reconcile(server, [local]);
  assert.equal(result.matches.length, 1);
  assert.deepEqual([...result.matchedIds], ["client-1"]);
});

test("history identity accepts only the requested Stream", () => {
  assert.equal(lifecycle.historyMatchesIdentity({
    streamId: "stream-release-manager",
    provider: "codex",
    threadId: "thread-new",
  }, {
    streamId: "stream-release-manager",
    provider: "codex",
    threadId: "thread-old",
  }), true);
  assert.equal(lifecycle.historyMatchesIdentity({
    streamId: "stream-release-manager",
    provider: "claude",
    threadId: "thread-resolved",
  }, {
    streamId: "stream-release-manager",
    provider: "codex",
    threadId: "thread-stale-request",
  }), true);
  assert.equal(lifecycle.historyMatchesIdentity({
    streamId: "stream-themes",
    provider: "codex",
    threadId: "thread-old",
  }, {
    streamId: "stream-release-manager",
    provider: "codex",
    threadId: "thread-old",
  }), false);
});

test("message lifecycle replaces a temporary turn root after its item identity changes", () => {
  const shared = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    role: "user",
    turnUserSlot: "root",
    text: "продолжай",
    time: "2026-08-14T21:12:25.474Z",
  };
  const visible = lifecycle.deduplicateConversationMessages([
    { ...shared, itemId: "temporary-item", clientUserMessageId: "" },
    { ...shared, itemId: "durable-item", clientUserMessageId: "durable-client" },
    {
      ...shared,
      itemId: "durable-item",
      clientUserMessageId: "durable-client",
      deliveryState: "accepted",
      delivery: "Принято",
    },
    { ...shared, itemId: "steer-item", clientUserMessageId: "steer-client", turnUserSlot: "steer" },
  ]);

  assert.equal(visible.length, 2);
  assert.equal(visible[0].itemId, "temporary-item");
  assert.equal(visible[0].clientUserMessageId, "durable-client");
  assert.equal(visible[0].deliveryState, "accepted");
  assert.equal(visible[1].turnUserSlot, "steer");
});

test("historical messages classify one root and preserve distinct steers", () => {
  const visible = lifecycle.historicalMessagesForDisplay({
    id: "turn-1",
    active: true,
    messages: [
      { itemId: "root", role: "user", text: "Первое" },
      { itemId: "steer", role: "user", text: "Второе" },
    ],
  });

  assert.deepEqual(visible.map((message) => message.turnUserSlot), ["root", "steer"]);
});

test("live completion is discarded instead of promoted across a rotated Thread", () => {
  const previous = {
    provider: "codex",
    threadId: "thread-old",
    turnId: "turn-old",
  };
  const selected = { provider: "codex", threadId: "thread-new" };

  assert.equal(lifecycle.liveCompletionTransition(previous, selected, "turn-new"), "discard");
  assert.equal(
    lifecycle.liveCompletionTransition(previous, { ...selected, threadId: "thread-old" }, "turn-new"),
    "promote",
  );
  assert.equal(lifecycle.liveCompletionTransition(previous, selected, "turn-old"), "none");
});

test("accepted optimistic message and rebound server echo render as one card", () => {
  const clientUserMessageId = "b40b178a-6f2d-4c1c-8922-558ab1070c06";
  const server = {
    provider: "codex",
    threadId: "canonical-thread",
    turnId: "turn-1",
    itemId: "server-user-item",
    clientUserMessageId,
    role: "user",
    text: "Одно сообщение",
    time: "2026-08-05T06:00:11.049Z",
  };
  const optimistic = {
    provider: "codex",
    threadId: "temporary-thread-alias",
    turnId: "turn-1",
    itemId: "receipt-1",
    clientUserMessageId,
    role: "user",
    text: "Одно сообщение",
    deliveryState: "accepted",
    delivery: "Принято",
    failed: false,
  };

  const reconciled = lifecycle.reconcile([server], [optimistic]);
  assert.equal(reconciled.matches.length, 1);
  assert.equal(reconciled.matches[0].local, optimistic);

  const visible = lifecycle.deduplicateConversationMessages([server, optimistic]);
  assert.equal(visible.length, 1);
  assert.equal(visible[0].clientUserMessageId, clientUserMessageId);
  assert.equal(visible[0].deliveryState, "accepted");
  assert.equal(visible[0].delivery, "Принято");
});

test("a steered optimistic message does not bind without a stable identity", () => {
  const optimistic = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "client-steer",
    clientUserMessageId: "client-steer",
    turnUserSlot: "steer",
    role: "user",
    text: "Пауза, расскажи результат",
    deliveryState: "accepted",
    delivery: "Принято",
  };
  const liveEcho = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "temporary-app-server-item",
    role: "user",
    text: "Пауза, расскажи результат",
  };
  const root = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "root-server-item",
    clientUserMessageId: "root-client-id",
    role: "user",
    text: "Исходный запрос",
  };
  const result = lifecycle.reconcile([root, liveEcho], [optimistic]);
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[1].local, null);
  assert.deepEqual([...result.matchedIds], []);
});

test("a steered optimistic message never binds to the root user item", () => {
  const optimistic = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "client-steer",
    clientUserMessageId: "client-steer",
    turnUserSlot: "steer",
    role: "user",
    text: "Уточнение",
  };
  const root = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "root-server-item",
    role: "user",
    text: "Исходный запрос",
  };
  const result = lifecycle.reconcile([root], [optimistic]);
  assert.equal(result.matches[0].local, null);
  assert.deepEqual([...result.matchedIds], []);
});

test("an accepted steer stays optimistic when a partial live echo has no stable identity", () => {
  const clientUserMessageId = "client-steer";
  const optimistic = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: clientUserMessageId,
    clientUserMessageId,
    turnUserSlot: "steer",
    role: "user",
    text: "Edge заблокирован политикой - чего?..",
    deliveryState: "accepted",
    delivery: "Принято",
  };
  const live = lifecycle.mergeLiveUserMessages([], {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    prompt: "ну делай",
    clientUserMessageId: "root-client",
    userMessages: [{
      itemId: "temporary-app-server-item",
      text: "Edge заблокирован политикой - чего?..",
    }],
  });

  assert.equal(live.length, 1);
  assert.equal(live[0].turnUserSlot, "steer");
  const reconciled = lifecycle.reconcile(live, [optimistic]);
  assert.equal(reconciled.matches[0].local, null);
  assert.deepEqual([...reconciled.matchedIds], []);
});

test("a partial unkeyed steer neither replaces the root nor inherits its attachments", () => {
  const rootAttachment = { id: "root.png", name: "root.png", type: "image/png" };
  const root = {
    ...message("root-client", "Исходный запрос"),
    itemId: "root-item",
    turnUserSlot: "root",
    attachments: [rootAttachment],
  };
  const snapshot = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    prompt: "Исходный запрос",
    clientUserMessageId: "root-client",
    attachments: [rootAttachment],
    userMessages: [{
      itemId: "temporary-steer-item",
      text: "Уточнение в текущий ход",
    }],
  };

  const merged = lifecycle.mergeLiveUserMessages([root], snapshot);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "Исходный запрос");
  assert.deepEqual(JSON.parse(JSON.stringify(merged[0].attachments)), [rootAttachment]);
  assert.equal(merged[1].text, "Уточнение в текущий ход");
  assert.equal(merged[1].turnUserSlot, "steer");
  assert.deepEqual(JSON.parse(JSON.stringify(merged[1].attachments)), []);

  const partialOnly = lifecycle.mergeLiveUserMessages([], snapshot);
  assert.equal(partialOnly.length, 1);
  assert.equal(partialOnly[0].turnUserSlot, "steer");
  assert.deepEqual(JSON.parse(JSON.stringify(partialOnly[0].attachments)), []);
});

test("temporary server echo keeps optimistic response annotations until rollout confirms them", () => {
  const local = {
    ...message("client-quote", "Это не повторится больше?"),
    responseAnnotations: [{ text: "миграция полностью завершена.", annotation: "" }],
    responseAnnotationRequest: "Это не повторится больше?",
  };
  const temporary = {
    ...local,
    itemId: "temporary-server-item",
    responseAnnotations: undefined,
    responseAnnotationRequest: undefined,
  };
  const merged = lifecycle.mergeReconciledUserMessage(temporary, local);
  assert.deepEqual(JSON.parse(JSON.stringify(merged.responseAnnotations)), [{
    text: "миграция полностью завершена.",
    annotation: "",
  }]);
  assert.equal(lifecycle.reconciledUserMetadataConfirmed(temporary, local), false);
  assert.equal(lifecycle.reconciledUserMetadataConfirmed({
    ...temporary,
    responseAnnotations: local.responseAnnotations,
  }, local), true);
});

test("temporary and durable final ids render as one agent card", () => {
  const values = lifecycle.deduplicateConversationMessages([
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "turn-1:rollout-agent:final",
      role: "agent",
      text: "Временный финал",
    },
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "msg_official",
      role: "agent",
      text: "Сохранённый финал",
    },
  ]);
  assert.equal(values.length, 1);
  assert.equal(values[0].itemId, "msg_official");
  assert.equal(values[0].text, "Сохранённый финал");
});

test("a live user echo does not confirm an outgoing message before durable history", () => {
  const outgoing = message("client-live", "Сообщение ещё сохраняется");
  const liveEcho = {
    ...outgoing,
    itemId: "live-user",
    turnId: "turn-live",
  };
  assert.deepEqual(
    [...lifecycle.confirmedOutgoingMessageIds([], [outgoing])],
    [],
  );
  assert.deepEqual(
    [...lifecycle.confirmedOutgoingMessageIds([liveEcho], [outgoing])],
    ["client-live"],
  );
});

test("outgoing attachments remain optimistic until durable history contains them", () => {
  const outgoing = {
    ...message("client-image", "Сообщение со скриншотом"),
    attachments: [{ name: "screen.png", type: "image/png", dataUrl: "data:image/png;base64,AA==" }],
  };
  const withoutAttachment = {
    ...outgoing,
    itemId: "durable-user",
    attachments: [],
  };
  assert.equal(lifecycle.reconciledUserMetadataConfirmed(withoutAttachment, outgoing), false);
  assert.deepEqual(
    [...lifecycle.confirmedOutgoingMessageIds([withoutAttachment], [outgoing])],
    [],
  );
  const durable = {
    ...withoutAttachment,
    attachments: [{ id: "stored-screen", name: "screen.png", type: "image/png" }],
  };
  assert.equal(lifecycle.reconciledUserMetadataConfirmed(durable, outgoing), true);
  assert.deepEqual(
    [...lifecycle.confirmedOutgoingMessageIds([durable], [outgoing])],
    ["client-image"],
  );
});

test("completed mid-turn compaction is embedded into the answer trace", () => {
  const answer = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "answer-1",
    role: "agent",
    text: "Готово",
    activityGroups: [{
      id: "reasoning-1",
      reasoning: "Проверяю.",
      activities: [{ id: "compaction-item", type: "compaction", label: "Контекст свёрнут" }],
    }],
  };
  const compaction = {
    id: "maintenance:compaction:1",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    role: "system",
    kind: "maintenance",
    maintenanceType: "compaction",
    maintenanceStatus: "completed",
    maintenanceLabel: "Свёртка завершена успешно",
    maintenanceDetail: "87% → 14%",
    time: "2026-08-09T20:00:00.000Z",
  };
  const merged = lifecycle.mergeTurnMaintenanceMessages([answer, compaction]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].role, "agent");
  assert.equal(merged[0].activityGroups[0].activities.length, 1);
  assert.equal(merged[0].activityGroups[0].activities[0].label, "Свёртка завершена успешно");
  assert.equal(merged[0].activityGroups[0].activities[0].detail, "87% → 14%");

  const live = lifecycle.mergeLiveMaintenance(answer, [compaction]);
  assert.equal(live.activityGroups[0].activities[0].detail, "87% → 14%");
});

test("later successful compaction supersedes an older failure banner", () => {
  const oldFailure = {
    id: "maintenance:compaction:failed",
    threadId: "thread-1",
    role: "system",
    kind: "maintenance",
    text: "Автосвёртка контекста не завершилась",
    time: "2026-08-14T15:59:09.908Z",
  };
  const completed = {
    id: "maintenance:compaction:completed",
    threadId: "thread-1",
    role: "system",
    kind: "maintenance",
    maintenanceType: "compaction",
    maintenanceStatus: "completed",
    text: "Свёртка завершена успешно 90%>19%",
    time: "2026-08-14T16:27:16.400Z",
  };
  const latestFailure = {
    ...oldFailure,
    id: "maintenance:compaction:latest-failure",
    maintenanceStatus: "failed",
    time: "2026-08-14T16:30:00.000Z",
  };
  const unrelatedFailure = {
    ...oldFailure,
    id: "maintenance:compaction:unrelated",
    provider: "claude",
  };
  const undatedFailure = {
    ...oldFailure,
    id: "maintenance:compaction:undated",
    time: null,
  };
  const rotation = {
    id: "maintenance:rotation:1",
    threadId: "thread-1",
    role: "system",
    kind: "maintenance",
    text: "Ротация завершена успешно 90%>19%",
    time: "2026-08-14T15:30:00.000Z",
  };

  assert.deepEqual(
    lifecycle.withoutSupersededCompactionFailures([
      oldFailure,
      unrelatedFailure,
      undatedFailure,
      rotation,
      completed,
      latestFailure,
    ]),
    [unrelatedFailure, undatedFailure, rotation, completed, latestFailure],
  );
});

test("completed turn becomes durable only with its prompt and exact final", () => {
  const prompt = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "user-1",
    role: "user",
    text: "Вопрос",
  };
  const final = {
    ...prompt,
    itemId: "agent-1",
    role: "agent",
    text: "Готовый ответ",
  };
  assert.equal(lifecycle.completedConversationTurnVisible([prompt], {
    turnId: "turn-1",
    answer: "Готовый ответ",
  }), false);
  assert.equal(lifecycle.completedConversationTurnVisible([final], {
    turnId: "turn-1",
    answer: "Готовый ответ",
  }), false);
  assert.equal(lifecycle.completedConversationTurnVisible([prompt, final], {
    turnId: "turn-1",
    answer: "Готовый ответ",
  }), true);
  assert.equal(lifecycle.completedConversationTurnVisible([prompt, {
    ...final,
    text: "Готовый",
  }], {
    turnId: "turn-1",
    answer: "Готовый ответ",
  }), false);
});

test("agent finals from different turns remain separate", () => {
  const values = lifecycle.deduplicateConversationMessages([
    { provider: "codex", threadId: "thread-1", turnId: "turn-1", itemId: "a", role: "agent" },
    { provider: "codex", threadId: "thread-1", turnId: "turn-2", itemId: "b", role: "agent" },
  ]);
  assert.equal(values.length, 2);
});

test("composer quote annotations retain every selected fragment for the protocol envelope", () => {
  const annotations = lifecycle.normalizedResponseAnnotations([
    { quote: "Первый выделенный фрагмент" },
    { quote: "Второй выделенный фрагмент", comment: "Сравни их" },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(annotations)), [
    { text: "Первый выделенный фрагмент", annotation: "" },
    { text: "Второй выделенный фрагмент", annotation: "Сравни их" },
  ]);
  const prompt = lifecycle.responseAnnotationPrompt("Общий вопрос", [
    { quote: "Первый выделенный фрагмент" },
    { quote: "Второй выделенный фрагмент" },
  ]);
  const embedded = prompt.match(/<response-annotations>\n(?<json>.+)\n<\/response-annotations>/u);
  assert.deepEqual(JSON.parse(embedded.groups.json), [
    { text: "Первый выделенный фрагмент", annotation: "" },
    { text: "Второй выделенный фрагмент", annotation: "" },
  ]);
  assert.match(prompt, /## My request for Codex:\nОбщий вопрос$/u);
});

test("annotation envelopes preserve distinct exact sources for duplicate selected text", () => {
  const hash = (value) => `sha256:${value.repeat(64)}`;
  const sourceFor = (itemId, start) => ({
    version: 1,
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId,
    role: "agent",
    messageKey: `provider\u001fcodex\u001fthread-1\u001fturn-1\u001f${itemId}\u001fagent`,
    surfaceKind: "message-body",
    surfaceIndex: 0,
    start,
    end: start + 6,
    contentHash: hash("a"),
    surfaceHash: hash("b"),
    selectionHash: hash("c"),
  });
  const values = [
    { text: "повтор", annotation: "первая", source: sourceFor("item-1", 0) },
    { text: "повтор", annotation: "вторая", source: sourceFor("item-2", 10) },
  ];
  const prompt = lifecycle.responseAnnotationPrompt("Сравни", values);
  const restored = lifecycle.normalizedUserMessage({ role: "user", text: prompt });
  assert.deepEqual(JSON.parse(JSON.stringify(restored.responseAnnotations)), values);
});

test("empty legacy annotation data still hides the service envelope", () => {
  const raw = "# Response annotations:\n<response-annotations>\n"
    + '[{"text":"","annotation":""}]\n</response-annotations>\n\n'
    + "## My request for Codex:\nОбычный вопрос";
  const normalized = lifecycle.normalizedUserMessage({ role: "user", text: raw });
  assert.equal(normalized.text, "Обычный вопрос");
  assert.deepEqual(JSON.parse(JSON.stringify(normalized.responseAnnotations ?? [])), []);
});

test("confirmed outgoing messages can be removed without resurrecting after history truncation", () => {
  const outgoing = new Map();
  const local = message("client-1", "Сообщение");
  lifecycle.rememberBounded(outgoing, local, 100);
  const confirmed = lifecycle.reconcile([{
    ...local,
    itemId: "server-item-1",
  }], [...outgoing.values()]);
  for (const clientUserMessageId of confirmed.matchedIds) outgoing.delete(clientUserMessageId);
  assert.equal(outgoing.size, 0);
  const truncated = lifecycle.reconcile([], [...outgoing.values()]);
  assert.deepEqual(truncated.matches, []);
  assert.equal(truncated.matchedIds.size, 0);
});

test("message lifecycle does not fall back when a different client id is present", () => {
  const local = message("client-1", "Первое сообщение");
  const server = {
    ...local,
    itemId: "server-item-2",
    clientUserMessageId: "client-2",
    text: "Второе сообщение",
  };
  const result = lifecycle.reconcile([server], [local]);
  assert.equal(result.matches[0].local, null);
  assert.equal(result.matchedIds.size, 0);
});

test("new-turn root reconciles after App Server replaces its client id", () => {
  const local = {
    ...message("client-local", "Исходный вопрос"),
    itemId: "local-root",
    turnUserSlot: "root",
  };
  const server = {
    ...local,
    itemId: "server-root",
    clientUserMessageId: "server-generated-client",
  };
  const result = lifecycle.reconcile([server], [local]);
  assert.equal(result.matches[0].local, local);
  assert.deepEqual([...result.matchedIds], ["client-local"]);
});

test("root fallback preserves earlier steer exclusion and exact provider-thread scope", () => {
  const local = { ...message("local-root", "Root"), turnUserSlot: "root" };
  const otherThread = { ...local, threadId: "other-thread", clientUserMessageId: "other-thread-root" };
  const otherProvider = { ...local, provider: "claude", clientUserMessageId: "other-provider-root" };
  const server = [
    { ...local, itemId: "first-steer", clientUserMessageId: "", turnUserSlot: "steer" },
    { ...local, itemId: "later-root", clientUserMessageId: "" },
    { ...otherThread, itemId: "thread-root", clientUserMessageId: "" },
    { ...otherProvider, itemId: "provider-root", clientUserMessageId: "" },
    { ...local, itemId: "exact-steer", turnUserSlot: "steer" },
  ];
  const result = lifecycle.reconcile(server, [local, otherThread, otherProvider]);
  assert.deepEqual(Array.from(result.matches, (match) => match.local), [
    null, null, otherThread, otherProvider, local,
  ]);
  assert.deepEqual([...result.matchedIds], ["other-thread-root", "other-provider-root", "local-root"]);
});

test("reconciliation reads long history identities in linear work with and without outgoing roots", () => {
  let identityReads = 0;
  const history = Array.from({ length: 1000 }, (_, index) => ({
    ...message(`server-${index}`, "Root"),
    get provider() { identityReads += 1; return "codex"; },
    turnId: `turn-${index}`,
    turnUserSlot: "root",
  }));
  const local = { ...history.at(-1), clientUserMessageId: "local-root", itemId: "local-root" };
  for (const outgoing of [[], [local]]) {
    identityReads = 0;
    const result = lifecycle.reconcile(history, outgoing);
    assert.equal(result.matches.length, history.length);
    assert.ok(result.matches.every((match, index) => match.message === history[index]));
    assert.ok(identityReads <= history.length * 8, `identity reads: ${identityReads}`);
    assert.deepEqual([...result.matchedIds], outgoing.length ? ["local-root"] : []);
    assert.equal(result.matches.at(-1).local, outgoing.length ? local : null);
  }
});

test("matching text attachments and time never confirm a different stable identity", () => {
  const local = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "",
    itemId: "local-client",
    clientUserMessageId: "local-client",
    role: "user",
    text: "мимо...\nи под элементами...",
    time: "2026-08-13T16:33:04.100Z",
    attachments: [{ name: "screen.png", type: "image/png" }],
    deliveryState: "accepted",
  };
  const server = {
    ...local,
    turnId: "turn-1",
    itemId: "server-item",
    clientUserMessageId: "server-generated-client",
    time: "2026-08-13T16:33:05.000Z",
    deliveryState: undefined,
  };
  const result = lifecycle.reconcile([server], [local]);
  assert.equal(result.matches[0].local, null);
  assert.deepEqual([...result.matchedIds], []);
  assert.deepEqual([...lifecycle.confirmedOutgoingMessageIds([server], [local])], []);
});

test("identical optimistic submissions stay separate when receipt matching is ambiguous", () => {
  const first = {
    ...message("client-1", "Повтори"),
    turnId: "",
    time: "2026-08-13T16:33:04.100Z",
    deliveryState: "accepted",
  };
  const second = {
    ...first,
    itemId: "client-2",
    clientUserMessageId: "client-2",
  };
  const server = {
    ...first,
    turnId: "turn-1",
    itemId: "server-item",
    clientUserMessageId: "server-generated-client",
    deliveryState: undefined,
  };
  const result = lifecycle.reconcile([server], [first, second]);
  assert.equal(result.matches[0].local, null);
  assert.equal(result.matchedIds.size, 0);
});

test("message lifecycle never merges two steer messages by turn and role fallback", () => {
  const first = { ...message("", "Одинаковый ход 1"), itemId: "" };
  const second = { ...message("", "Одинаковый ход 2"), itemId: "" };
  const server = [{ ...message("", "Сервер"), itemId: "", clientUserMessageId: undefined }];
  const result = lifecycle.reconcile(server, [first, second]);
  assert.equal(result.matches[0].local, null);
  assert.equal(result.matchedIds.size, 0);
});

test("message lifecycle bounds optimistic state for a long-lived tab", () => {
  const messages = new Map();
  for (let index = 0; index < 105; index += 1) {
    lifecycle.rememberBounded(messages, {
      clientUserMessageId: `client-${index}`,
    }, 100);
  }
  assert.equal(messages.size, 100);
  assert.equal(messages.has("client-0"), false);
  assert.equal(messages.has("client-104"), true);
});

test("new-turn root reconciles when Codex history temporarily omits client id", () => {
  const local = {
    ...message("client-root", "Новый вопрос"),
    itemId: "local-client-root",
    turnUserSlot: "root",
  };
  const server = [
    {
      ...local,
      itemId: "codex-user-item",
      clientUserMessageId: "",
    },
    {
      ...local,
      itemId: "codex-steer-item",
      clientUserMessageId: "",
      text: "Уточнение в том же ходе",
    },
  ];
  const result = lifecycle.reconcile(server, [local]);
  assert.equal(result.matches[0].local, local);
  assert.equal(result.matches[1].local, null);
  assert.deepEqual([...result.matchedIds], ["client-root"]);
});

test("live message falls back to the exact active turn while history catches up", () => {
  const visibleHistory = [{
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "temporary-history-item",
    role: "agent",
    text: "Старый промежуточный текст",
  }];
  const live = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "official-response-item",
    role: "agent",
  };
  assert.equal(lifecycle.liveMessageMatch(visibleHistory, live), visibleHistory[0]);
});

test("live message never falls back across turns or ambiguous agent messages", () => {
  const live = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "official-response-item",
    role: "agent",
  };
  const otherTurn = [{
    ...live,
    turnId: "turn-2",
    itemId: "history-item",
  }];
  assert.equal(lifecycle.liveMessageMatch(otherTurn, live), null);

  const ambiguous = [
    { ...live, itemId: "history-item-1" },
    { ...live, itemId: "history-item-2" },
  ];
  assert.equal(lifecycle.liveMessageMatch(ambiguous, live), null);
});

test("deferred outgoing messages render only in the queue while it owns delivery", () => {
  const deferred = {
    ...message("client-deferred", "Будет отправлено после хода"),
    deliveryState: "queued",
    delivery: "В очереди",
  };
  const visible = lifecycle.visibleConversationMessages([deferred], {
    deferredClientUserMessageIds: ["client-deferred"],
  });
  assert.deepEqual(visible, []);
});

test("an item id alone never collapses an unacknowledged optimistic steer", () => {
  const values = lifecycle.deduplicateConversationMessages([
    {
      id: "codex:thread-1:turn-1:client-steer:user",
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "client-steer",
      clientUserMessageId: "",
      role: "user",
      text: "нет",
      time: "2026-08-25T08:11:00.000Z",
    },
    {
      id: "local:client-steer",
      provider: "codex",
      threadId: "thread-1",
      turnId: "",
      itemId: "client-steer",
      clientUserMessageId: "client-steer",
      role: "user",
      text: "Аннотации к ответу: 1",
      responseAnnotations: [{ text: "Скрин, похоже, из Test Contour", annotation: "нет" }],
      time: "2026-08-25T08:10:59.000Z",
      deliveryState: "sending",
    },
  ]);

  assert.equal(values.length, 2);
  assert.equal(values[1].clientUserMessageId, "client-steer");
  assert.equal(values[0].time, "2026-08-25T08:11:00.000Z");
  assert.deepEqual(JSON.parse(JSON.stringify(values[1].responseAnnotations)), [
    { text: "Скрин, похоже, из Test Contour", annotation: "нет" },
  ]);
});

test("queued outgoing messages without a client id still render only in the queue", () => {
  const queued = {
    role: "user",
    text: "Будет отправлено после хода",
    deliveryState: "queued",
    delivery: "В очереди",
  };
  assert.deepEqual(lifecycle.visibleConversationMessages([queued]), []);
});

test("empty projected messages never render as blank chat cards", () => {
  const visible = lifecycle.visibleConversationMessages([
    { id: "blank-agent", role: "agent", text: "", time: "2026-08-16T10:00:00.000Z" },
    { id: "blank-user", role: "user", text: "   ", time: "2026-08-16T10:00:01.000Z" },
    {
      id: "attachment-only",
      role: "user",
      text: "",
      attachments: [{ id: "screen.png", type: "image/png" }],
    },
    { id: "answer", role: "agent", text: "Готово" },
  ]);

  assert.deepEqual(visible.map((message) => message.id), ["attachment-only", "answer"]);
});

test("former context marker text and identifiers remain in the conversation", () => {
  const visible = lifecycle.visibleConversationMessages([
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "probe-turn",
      itemId: "probe-user",
      clientUserMessageId: "agent-hub-context-probe:probe-1",
      role: "user",
      text: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
    },
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "probe-turn",
      itemId: "probe-agent",
      role: "agent",
      text: "AGENT_HUB_CONTEXT_PROBE_OK_V1",
    },
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "ordinary-turn",
      itemId: "ordinary-user",
      clientUserMessageId: "client-ordinary",
      role: "user",
      text: "Обычный запрос",
    },
  ]);

  assert.deepEqual(visible.map((message) => message.turnId), ["probe-turn", "probe-turn", "ordinary-turn"]);
});

test("the reserved context probe phrase stays visible for a normal client operation", () => {
  const visible = lifecycle.visibleConversationMessages([
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "manual-turn",
      itemId: "manual-user",
      clientUserMessageId: "client-manual-probe",
      operationKind: "user-turn",
      role: "user",
      text: "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1",
    },
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "manual-turn",
      itemId: "manual-agent",
      operationKind: "user-turn",
      role: "agent",
      text: "AGENT_HUB_CONTEXT_PROBE_OK_V1",
    },
  ]);

  assert.deepEqual(visible.map((message) => [message.role, message.text]), [
    ["user", "Ответь строго: AGENT_HUB_CONTEXT_PROBE_OK_V1"],
    ["agent", "AGENT_HUB_CONTEXT_PROBE_OK_V1"],
  ]);

});

test("accepted browser messages refresh immediately without waiting for idle polling", () => {
  assert.match(
    hubClientSource,
    /synchronize: async \(result\) => \{\s*if \(result\?\.snapshot\) applySnapshot\(result\.snapshot\);\s*else if \(result\?\.accepted \|\| result\?\.deferred\) await refresh\(\);/u,
  );
  assert.match(
    hubClientSource,
    /if \(refreshing\) \{\s*refreshRequested = true;\s*return;\s*\}/u,
  );
  assert.match(
    hubClientSource,
    /void acknowledgeLocalControl\(commandId\)\.catch/u,
  );
});

test("partial former marker text remains visible", () => {
  const visible = lifecycle.visibleConversationMessages([{
    provider: "codex",
    threadId: "thread-1",
    turnId: "probe-turn",
    itemId: "probe-agent-live",
    role: "agent",
    text: "AGENT_HUB_CONTEXT_PROBE",
  }]);

  assert.equal(visible[0].text, "AGENT_HUB_CONTEXT_PROBE");
});

test("active agent response is rendered only by the live card after task switching", () => {
  const user = message("client-live", "Текущий вопрос");
  const agent = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "agent-live",
    role: "agent",
    text: "Ответ формируется",
  };
  const visible = lifecycle.visibleConversationMessages([user, agent], {
    liveProbe: {
      ...agent,
      text: undefined,
    },
  });
  assert.deepEqual(visible, [user]);
});

test("all commentary fragments from the active VSC turn stay in the live card", () => {
  const previousAgent = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-previous",
    itemId: "previous-answer",
    role: "agent",
    text: "Предыдущий завершённый ответ",
  };
  const activeCommentary = [
    {
      ...previousAgent,
      turnId: "turn-active",
      itemId: "commentary-1",
      text: "Первый промежуточный фрагмент",
    },
    {
      ...previousAgent,
      turnId: "turn-active",
      itemId: "commentary-2",
      text: "Второй промежуточный фрагмент",
    },
  ];
  const visible = lifecycle.visibleConversationMessages(
    [previousAgent, ...activeCommentary],
    {
      liveProbe: {
        provider: "codex",
        threadId: "thread-1",
        turnId: "turn-active",
        itemId: "",
        role: "agent",
      },
    },
  );
  assert.deepEqual(visible, [previousAgent]);
});

test("an external live turn contributes its missing VSC user messages", () => {
  const previous = [{
    ...message("previous-client", "Предыдущий вопрос"),
    turnId: "previous-turn",
  }];
  const merged = lifecycle.mergeLiveUserMessages(previous, {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    userMessages: [
      {
        itemId: "live-user-1",
        clientUserMessageId: "live-client-1",
        text: "Текущий вопрос из VSC",
      },
      {
        itemId: "live-user-2",
        clientUserMessageId: "live-client-2",
        text: "Уточнение в том же ходе",
      },
    ],
  });
  assert.deepEqual(
    merged.map((item) => item.text),
    ["Предыдущий вопрос", "Текущий вопрос из VSC", "Уточнение в том же ходе"],
  );
});

test("live inter-Stream messages preserve the source agent author", () => {
  const author = "Agent HUB - Release Manager (Codex)";
  const fromUserMessages = lifecycle.mergeLiveUserMessages([], {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    userMessages: [{
      itemId: "live-user-1",
      text: "Сообщение из другого Stream",
      author,
    }],
  });
  const fromPrompt = lifecycle.mergeLiveUserMessages([], {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    prompt: "Сообщение из другого Stream",
    promptAuthor: author,
  });

  assert.equal(fromUserMessages[0].author, author);
  assert.equal(fromPrompt[0].author, author);
});

test("inter-Stream rollout aliases the receipt without replacing the root user", () => {
  const origin = {
    kind: "interstream",
    workspaceId: "workspace-1",
    workspaceName: "Agent HUB",
    streamId: "stream-themes",
    streamName: "Themes",
    provider: "codex",
    model: "Sol",
    requestId: "themes-ack-1",
  };
  const root = {
    ...message("root-item", "Исходное сообщение пользователя"),
    turnId: "active-turn",
    clientUserMessageId: "root-client",
    turnUserSlot: "root",
  };
  const receipt = {
    ...message("receipt-item", "Themes → Release Manager. Принято."),
    turnId: "active-turn",
    clientUserMessageId: "mcp:themes-ack-1",
    turnUserSlot: "steer",
    author: "Agent HUB - Themes (Sol)",
    origin,
  };

  const merged = lifecycle.mergeLiveUserMessages([root, receipt], {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    prompt: "Исходное сообщение пользователя",
    clientUserMessageId: "root-client",
    userMessages: [{
      itemId: "rollout-user:1",
      clientUserMessageId: "",
      text: "Themes → Release Manager. Принято.",
      author: "Agent HUB - Themes (Sol)",
      origin,
    }],
  });

  assert.equal(merged.length, 2);
  assert.equal(merged[0].text, "Исходное сообщение пользователя");
  assert.equal(merged[1].clientUserMessageId, "mcp:themes-ack-1");
  assert.equal(merged[1].author, "Agent HUB - Themes (Sol)");
});

test("unattributed live updates do not overwrite a durable inter-Stream author", () => {
  const merged = lifecycle.mergeLiveUserMessages([{
    ...message("server-user", "Сообщение из другого Stream"),
    author: "Agent HUB - Release Manager (Codex)",
  }], {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    userMessages: [{
      itemId: "server-user",
      clientUserMessageId: "server-user",
      text: "Сообщение из другого Stream",
    }],
  });

  assert.equal(merged[0].author, "Agent HUB - Release Manager (Codex)");
});

test("live VSC user messages do not duplicate official task history", () => {
  const official = [{
    ...message("server-item", "Текущий вопрос из VSC"),
    turnId: "active-turn",
    clientUserMessageId: "live-client",
  }];
  const merged = lifecycle.mergeLiveUserMessages(official, {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    userMessages: [{
      itemId: "rollout-item",
      clientUserMessageId: "live-client",
      text: "Текущий вопрос из VSC",
    }],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].itemId, "server-item");
});

test("live root does not duplicate history when App Server changed its client id", () => {
  const official = [{
    ...message("server-item", "Текущий вопрос"),
    turnId: "active-turn",
    clientUserMessageId: "official-client",
  }];
  const merged = lifecycle.mergeLiveUserMessages(official, {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    userMessages: [{
      itemId: "rollout-item",
      clientUserMessageId: "runtime-client",
      text: "Текущий вопрос",
    }],
  });
  assert.equal(merged.length, 1);
  assert.equal(merged[0].itemId, "server-item");
});

test("unmatched optimistic messages keep chronological position", () => {
  const values = lifecycle.chronologicalMessages([
    { id: "server-old", time: "2026-08-02T20:49:01.000Z" },
    { id: "server-new", time: "2026-08-02T20:53:31.000Z" },
    { id: "optimistic-old", time: "2026-08-02T20:49:01.920Z" },
  ]);
  assert.deepEqual(values.map((item) => item.id), [
    "server-old",
    "optimistic-old",
    "server-new",
  ]);
});

test("durable turn order wins over an earlier queue timestamp", () => {
  const values = lifecycle.chronologicalMessages([
    {
      id: "first-user", role: "user", turnId: "first",
      time: "2026-08-09T21:20:00.000Z", historyOrder: 1_000,
    },
    {
      id: "first-agent", role: "agent", turnId: "first",
      time: "2026-08-09T21:33:00.000Z", historyOrder: 1_001,
    },
    {
      id: "queued-user", role: "user", turnId: "second",
      time: "2026-08-09T21:19:00.000Z", historyOrder: 2_000,
    },
    {
      id: "second-agent", role: "agent", turnId: "second",
      time: "2026-08-09T21:36:00.000Z", historyOrder: 2_001,
    },
  ]);
  assert.deepEqual(values.map((item) => item.id), [
    "first-user",
    "first-agent",
    "queued-user",
    "second-agent",
  ]);
});

test("focused history item identity includes its provider Thread", () => {
  const source = clientFunctionSource("historyMessages", "function mergeNewestHistory");
  const sandbox = vm.createContext({
    attachmentViews: () => [],
    conversationMessageAuthor: (_message, provider) => provider,
    focusedTurnAlreadyVisible: () => true,
    focusedTurnTaskThreadId: (turn) => turn.threadId,
    canonicalProjectionState: projection.projectionState,
    historicalMessagesForDisplay: (item) => item.messages,
  });
  vm.runInContext(`${source}; globalThis.mapHistory = historyMessages;`, sandbox);
  const turnId = "20000000-0000-4000-8000-000000000001";
  const itemId = `${turnId}:user`;
  const messages = sandbox.mapHistory({
    provider: "codex",
    threadId: "10000000-0000-4000-8000-000000000020",
    items: [{
      provider: "codex",
      threadId: "10000000-0000-4000-8000-000000000001",
      id: turnId,
      messages: [{ itemId, role: "user", text: "historical" }],
    }],
  }, {
    provider: "codex",
    threadId: "10000000-0000-4000-8000-000000000020",
    turnId,
    messages: [{ itemId, role: "user", text: "current" }],
  });

  assert.deepEqual(Array.from(messages, (message) => [message.threadId, message.text]), [
    ["10000000-0000-4000-8000-000000000001", "historical"],
    ["10000000-0000-4000-8000-000000000020", "current"],
  ]);
});

test("chronology keeps colliding turn ids isolated by provider Thread identity", () => {
  const turnId = "20000000-0000-4000-8000-000000000001";
  const source = [
    {
      id: "old-user", provider: "codex", threadId: "10000000-0000-4000-8000-000000000001",
      turnId, itemId: `${turnId}:user`, role: "user", turnUserSlot: "root",
      text: "old prompt", time: "2026-08-28T22:42:00.000Z", historyOrder: 1_000,
    },
    {
      id: "old-agent", provider: "codex", threadId: "10000000-0000-4000-8000-000000000001",
      turnId, itemId: `${turnId}:agent:final`, role: "agent", text: "old answer",
      time: "2026-08-28T22:43:00.000Z", historyOrder: 1_001,
      activities: [{ id: "old-diff", title: "Historical diff" }],
    },
    {
      id: "current-user", provider: "codex", threadId: "10000000-0000-4000-8000-000000000020",
      turnId, itemId: `${turnId}:user`, role: "user", turnUserSlot: "root",
      text: "123", time: "2026-09-01T04:05:00.000Z", historyOrder: 29_000,
    },
    {
      id: "current-agent", provider: "codex", threadId: "10000000-0000-4000-8000-000000000020",
      turnId, itemId: `${turnId}:agent:final`, role: "agent", text: "Принято",
      time: "2026-09-01T04:05:01.000Z", historyOrder: 29_001,
      activities: [],
    },
  ];

  const deduplicated = lifecycle.deduplicateConversationMessages(source);
  assert.equal(deduplicated.length, 4);
  const ordered = lifecycle.chronologicalMessages(deduplicated);
  assert.deepEqual(Array.from(ordered, (item) => item.id), [
    "old-user", "old-agent", "current-user", "current-agent",
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(
    ordered.find((item) => item.id === "old-agent").activities,
  )), [
    { id: "old-diff", title: "Historical diff" },
  ]);
  assert.equal(ordered.find((item) => item.id === "current-agent").activities.length, 0);
});

test("same-turn maintenance stays below the agent answer despite an earlier timestamp", () => {
  const values = lifecycle.chronologicalMessages([
    {
      id: "answer", role: "agent", turnId: "turn-1",
      time: "2026-08-18T14:59:10.000Z", historyOrder: 1_001,
    },
    {
      id: "measurement", role: "system", kind: "maintenance", turnId: "turn-1",
      time: "2026-08-18T14:58:00.000Z",
    },
    {
      id: "prompt", role: "user", turnId: "turn-1",
      time: "2026-08-18T14:57:00.000Z", historyOrder: 1_000,
    },
  ]);
  assert.deepEqual(values.map((item) => item.id), ["prompt", "answer", "measurement"]);
});

test("rotation completion stays between the source Thread and the new live turn", () => {
  const source = [
    {
      id: "source-user", role: "user", threadId: "thread-old", turnId: "turn-old",
      time: "2026-08-24T00:30:00.000Z", historyOrder: 1_000,
    },
    {
      id: "source-agent", role: "agent", threadId: "thread-old", turnId: "turn-old",
      time: "2026-08-24T00:34:00.000Z", historyOrder: 1_001,
    },
    {
      id: "rotation", role: "system", kind: "maintenance", threadId: "thread-new",
      sourceThreadId: "thread-old", placement: "after-source-turn",
      time: "2026-08-24T00:34:01.000Z",
    },
    {
      id: "new-user", role: "user", threadId: "thread-new", turnId: "turn-new",
      time: "2026-08-24T00:35:00.000Z", historyOrder: 2_000,
    },
    {
      id: "new-live-agent", role: "agent", threadId: "thread-new", turnId: "turn-new",
      time: "2026-08-24T00:36:00.000Z",
    },
  ];
  assert.deepEqual(
    lifecycle.chronologicalMessages(source).map((item) => item.id),
    ["source-user", "source-agent", "rotation", "new-user", "new-live-agent"],
  );
  source.at(-1).time = "2026-08-24T00:40:00.000Z";
  assert.deepEqual(
    lifecycle.chronologicalMessages(source).map((item) => item.id),
    ["source-user", "source-agent", "rotation", "new-user", "new-live-agent"],
  );
});

test("persisted maintenance history keeps only the latest event per task", () => {
  const first = {
    id: "maintenance:compaction:first",
    maintenanceStatus: "completed",
    time: "2026-08-14T16:20:00.000Z",
  };
  const latest = {
    id: "maintenance:compaction:latest",
    maintenanceStatus: "completed",
    time: "2026-08-14T16:30:00.000Z",
  };

  assert.deepEqual(lifecycle.latestMaintenanceMessages([latest, first]), [latest]);
});

test("late subagent results stay above their parent final", () => {
  const values = lifecycle.chronologicalMessages([
    {
      id: "answer", role: "agent", turnId: "turn-1",
      time: "2026-08-22T15:04:00.000Z", historyOrder: 1_001,
    },
    {
      id: "subagent-late", role: "agent", kind: "subagent", turnId: "turn-1",
      time: "2026-08-22T15:04:05.000Z",
    },
    {
      id: "prompt", role: "user", turnId: "turn-1",
      time: "2026-08-22T15:03:00.000Z", historyOrder: 1_000,
    },
  ]);
  assert.deepEqual(values.map((item) => item.id), ["prompt", "subagent-late", "answer"]);
});

test("an older focused turn keeps its timestamp instead of falling below current history", () => {
  assert.doesNotMatch(hubClientSource, /historyOrder: Number\.MAX_SAFE_INTEGER/u);
  const values = lifecycle.chronologicalMessages([
    {
      id: "current-user", role: "user", turnId: "current",
      time: "2026-08-11T09:57:33.047Z", historyOrder: 102_000,
    },
    {
      id: "current-agent", role: "agent", turnId: "current",
      time: "2026-08-11T09:57:54.524Z", historyOrder: 102_001,
    },
    {
      id: "focused-old-user", role: "user", turnId: "focused-old",
      time: "2026-08-10T21:28:10.000Z",
    },
    {
      id: "focused-old-agent", role: "agent", turnId: "focused-old",
      time: "2026-08-10T21:28:44.697Z",
    },
  ]);
  assert.deepEqual(values.map((item) => item.id), [
    "focused-old-user",
    "focused-old-agent",
    "current-user",
    "current-agent",
  ]);
});

test("deferred queue merges the server row with its optimistic client message", () => {
  const merged = lifecycle.mergeDeferredQueueEntries([{
    id: "queue-1",
    state: "queued",
    clientUserMessageId: "client-queue-1",
    text: "",
    annotations: [],
    attachments: [],
    createdAt: "2026-08-07T00:10:01.000Z",
  }], [{
    id: "local:client-queue-1",
    state: "queued",
    requestId: "client-queue-1",
    text: "",
    annotations: [{ text: "Цитата", annotation: "Комментарий" }],
    attachments: [{ id: "screen.png", type: "image/png" }],
    createdAt: "2026-08-07T00:10:00.000Z",
    optimistic: true,
  }]);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "queue-1");
  assert.equal(merged[0].clientUserMessageId, "client-queue-1");
  assert.equal(merged[0].state, "queued");
  assert.equal(merged[0].optimistic, false);
  assert.equal(merged[0].createdAt, "2026-08-07T00:10:01.000Z");
  assert.equal(JSON.stringify(merged[0].annotations), JSON.stringify([
    { text: "Цитата", annotation: "Комментарий" },
  ]));
  assert.equal(JSON.stringify(merged[0].attachments), JSON.stringify([
    { id: "screen.png", type: "image/png" },
  ]));
});

test("terminal message receipts leave the optimistic deferred queue", () => {
  assert.equal(lifecycle.receiptLeavesDeferredQueue({ deferred: true, queued: true }), false);
  assert.equal(lifecycle.receiptLeavesDeferredQueue({ deferred: true, queued: true, dispatching: true }), true);
  assert.equal(lifecycle.receiptLeavesDeferredQueue({ accepted: true, deferred: false }), true);
  assert.equal(lifecycle.receiptLeavesDeferredQueue({ steered: true }), true);
  assert.equal(lifecycle.receiptLeavesDeferredQueue({ cancelled: true }), true);
});

test("only receipts still owned by the deferred queue hide their chat card", () => {
  assert.equal(lifecycle.receiptUsesDeferredQueue({ deferred: true, queued: true }), true);
  assert.equal(lifecycle.receiptUsesDeferredQueue({ accepted: true, deferred: true, queued: true, reason: "message-intake" }), false);
  assert.equal(lifecycle.receiptUsesDeferredQueue({ deferred: true, queued: true, dispatching: true }), false);
  assert.equal(lifecycle.receiptUsesDeferredQueue({ accepted: true, deferred: false }), false);
});

test("known-idle intake stays as one optimistic conversation card for every client transport", () => {
  for (const clientSource of [
    "desktop",
    "local-vscode-webview",
    "web",
    "trusted-device",
  ]) {
    const clientUserMessageId = `client-queued-${clientSource}`;
    const receipt = {
      clientUserMessageId,
      clientSource,
      accepted: true,
      deferred: true,
      queued: true,
      reason: "message-intake",
      clientProjectionIntent: "conversation",
    };
    const deferredInput = {
      clientUserMessageId,
      clientSource,
      state: "queued",
      conflictKind: "message-intake",
      clientProjectionIntent: "conversation",
      createdAt: "2026-09-03T10:00:00.123Z",
    };
    const projection = lifecycle.queueHistoryReceiptProjection(receipt);
    assert.equal(projection.accepted, true);
    assert.equal(projection.providerAccepted, false);
    assert.equal(projection.ownsDeferredQueue, false);
    assert.equal(projection.projectionState, "optimistic");
    assert.equal(projection.deliveryState, "accepted");
    assert.equal(lifecycle.queuedCommandDeliveryState(deferredInput, [receipt]), null);
    const deferredIds = lifecycle.queuedCommandClientUserMessageIds(
      [deferredInput],
      [receipt],
    );
    assert.deepEqual(deferredIds, []);
    assert.deepEqual(
      lifecycle.visibleConversationMessages([{
        ...message(clientUserMessageId, "Исправь регрессию"),
        turnId: "",
        projectionState: projection.projectionState,
        providerAccepted: projection.providerAccepted,
        deliveryState: projection.deliveryState,
      }], { deferredClientUserMessageIds: deferredIds }).map((item) => item.clientUserMessageId),
      [clientUserMessageId],
    );
    assert.deepEqual(
      { ...lifecycle.deferredInputConversationProjection(deferredInput, [receipt]) },
      {
        clientUserMessageId,
        submissionId: clientUserMessageId,
        projectionState: "optimistic",
        providerAccepted: false,
        deliveryState: "accepted",
        clientProjectionIntent: "conversation",
        submittedAt: deferredInput.createdAt,
      },
    );
  }
});

test("server queue overrides stale idle intent with and without the bounded receipt", () => {
  const clientUserMessageId = "stale-idle-queued";
  const entry = {
    clientUserMessageId, state: "queued",
    conflictKind: "task-running", clientProjectionIntent: "conversation",
  };
  // Snapshot receipts omit reason/conflictKind.
  const receipt = {
    clientUserMessageId, accepted: false, deferred: true, queued: true,
    clientProjectionIntent: "conversation",
  };
  const projection = lifecycle.queueHistoryReceiptProjection(receipt);
  assert.equal(projection.ownsDeferredQueue, true);
  assert.equal(projection.ownsOptimisticConversation, false);
  assert.equal(projection.deliveryState, "queued");
  for (const receipts of [[receipt], []]) {
    assert.equal(lifecycle.queuedCommandUsesQueue(entry, receipts), true);
    assert.equal(lifecycle.queuedCommandDeliveryState(entry, receipts), "queued");
    assert.equal(lifecycle.deferredInputConversationProjection(entry, receipts), null);
    assert.deepEqual(lifecycle.visibleConversationMessages([{
      ...message(clientUserMessageId, "Waiting for the current turn"),
      turnId: "", providerAccepted: false, projectionState: "optimistic",
    }], {
      deferredClientUserMessageIds: lifecycle.queuedCommandClientUserMessageIds([entry], receipts),
    }), []);
  }
  const accepted = {
    ...receipt, accepted: true, deferred: false, queued: false,
    runId: "accepted-run", turnId: "accepted-turn",
  };
  assert.equal(lifecycle.queuedCommandUsesQueue(entry, [accepted]), false);
  assert.equal(lifecycle.queueHistoryReceiptProjection(accepted).providerAccepted, true);
});

test("known-busy submissions use only the queue surface", () => {
  assert.equal(lifecycle.optimisticSubmissionUsesQueue({ followUpMode: "" }), false);
  assert.equal(lifecycle.optimisticSubmissionUsesQueue({ followUpMode: "queue" }), false);
  assert.equal(lifecycle.optimisticSubmissionUsesQueue({ followUpMode: "steer" }), true);
  assert.equal(lifecycle.optimisticSubmissionUsesQueue({ deferWhileRunning: true }), true);
  assert.equal(lifecycle.optimisticSubmissionUsesQueue({
    followUpMode: "queue",
    deferWhileRunning: true,
  }), true);

  const clientUserMessageId = "client-known-busy";
  const receipt = {
    clientUserMessageId,
    accepted: false,
    deferred: true,
    queued: true,
    reason: "task-running",
    clientProjectionIntent: "queue",
  };
  const deferredInput = {
    clientUserMessageId,
    state: "queued",
    conflictKind: "task-running",
    clientProjectionIntent: "queue",
  };
  const projection = lifecycle.queueHistoryReceiptProjection(receipt);
  assert.equal(projection.ownsDeferredQueue, true);
  assert.equal(projection.deliveryState, "queued");
  assert.equal(lifecycle.queuedCommandDeliveryState(deferredInput, [receipt]), "queued");
  assert.deepEqual(
    lifecycle.visibleConversationMessages([{
      ...message(clientUserMessageId, "После текущего хода"),
      projectionState: "queued",
      providerAccepted: false,
      deliveryState: "queued",
    }], {
      deferredClientUserMessageIds: lifecycle.queuedCommandClientUserMessageIds(
        [deferredInput],
        [receipt],
      ),
    }),
    [],
  );
});

test("dispatching, rejected and ambiguous starts remain queue-only", () => {
  for (const scenario of [
    {
      state: "dispatching",
      receipt: {
        accepted: false,
        deferred: true,
        queued: true,
        dispatching: true,
        reason: "task-running",
        clientProjectionIntent: "queue",
      },
      deliveryState: "sending",
    },
    {
      state: "pending",
      receipt: {
        accepted: false,
        deferred: true,
        queued: false,
        reason: "launch-failed",
        clientProjectionIntent: "queue",
      },
      deliveryState: "deferred",
    },
    {
      state: "attention-required",
      receipt: {
        accepted: false,
        deferred: true,
        queued: false,
        reason: "launch-failed",
        clientProjectionIntent: "conversation",
        attentionRequired: true,
      },
      deliveryState: "deferred",
    },
    {
      state: "paused",
      receipt: {
        accepted: false,
        deferred: true,
        queued: true,
        reason: "task-running",
        clientProjectionIntent: "conversation",
        paused: true,
      },
      deliveryState: "queued",
    },
    {
      state: "pending",
      receipt: {
        accepted: false,
        deferred: true,
        queued: false,
        unknown: true,
        reason: "provider-start-unconfirmed",
        clientProjectionIntent: "conversation",
      },
      deliveryState: "unconfirmed",
    },
  ]) {
    const clientUserMessageId = `client-${scenario.state}-${scenario.receipt.reason ?? "active"}`;
    const receipt = { clientUserMessageId, ...scenario.receipt };
    const deferredInput = {
      clientUserMessageId,
      state: scenario.state,
      clientProjectionIntent: scenario.receipt.clientProjectionIntent,
      ...(scenario.receipt.reason === "provider-start-unconfirmed"
        ? { waitReason: "provider-start-unconfirmed" }
        : {}),
    };
    const projection = lifecycle.queueHistoryReceiptProjection(receipt);
    assert.equal(projection.providerAccepted, false);
    assert.equal(projection.ownsDeferredQueue, true);
    assert.equal(
      lifecycle.queuedCommandDeliveryState(deferredInput, [receipt]),
      scenario.deliveryState,
    );
    assert.deepEqual(
      lifecycle.visibleConversationMessages([
        message(clientUserMessageId, "Ещё не принято провайдером"),
      ], {
        deferredClientUserMessageIds: lifecycle.queuedCommandClientUserMessageIds(
          [deferredInput],
          [receipt],
        ),
      }),
      [],
    );
  }
});

test("failed pending intake remains queue-owned without a receipt or with an earlier intake ACK", () => {
  for (const clientProjectionIntent of [undefined, "conversation"]) {
    const entry = {
      id: "failed-intake",
      clientUserMessageId: "client-failed-intake",
      state: "pending",
      conflictKind: "message-intake",
      clientProjectionIntent,
      lastError: "Provider start was not confirmed",
      attempts: 15,
    };
    for (const receipts of [[], [{
      clientUserMessageId: entry.clientUserMessageId,
      accepted: true,
      deferred: true,
      queued: true,
      reason: "message-intake",
      clientProjectionIntent,
    }]]) {
      assert.equal(lifecycle.queuedCommandUsesQueue(entry, receipts), true);
      assert.equal(lifecycle.queuedCommandDeliveryState(entry, receipts), "deferred");
      assert.equal(lifecycle.deferredInputConversationProjection(entry, receipts), null);
      assert.deepEqual(lifecycle.queuedCommandClientUserMessageIds([entry], receipts), [entry.clientUserMessageId]);
    }
    const normal = { ...entry, lastError: null };
    assert.equal(lifecycle.queuedCommandUsesQueue(normal, []), false);
    assert.equal(lifecycle.deferredInputConversationProjection(normal, []).projectionState, "optimistic");
    assert.equal(lifecycle.queuedCommandUsesQueue({ ...normal, attentionRequired: true }, []), true);
  }
});

test("failed pending intake exposes decision, retry and cancel only in its exact Stream", async () => {
  const entry = {
    id: "failed-intake",
    clientUserMessageId: "client-failed-intake",
    provider: "codex",
    threadId: "thread-shared",
    streamId: "stream-2",
    state: "pending",
    attentionRequired: true,
    conflictKind: "message-intake",
    lastError: "Provider start was not confirmed",
  };
  const projectionContext = vm.createContext({
    historyByTask: new Map(),
    optimisticQueueSteerIds: new Set(),
    providerAcceptedHistoryClientUserMessageIds: lifecycle.providerAcceptedHistoryClientUserMessageIds,
    queuedCommandUsesQueue: lifecycle.queuedCommandUsesQueue,
    taskId: (provider, threadId, streamId) => lifecycle.conversationTaskId({ provider, threadId, streamId }),
  });
  vm.runInContext(clientFunctionSource("deferredEntriesForTask", "function optimisticDeferredEntries"), projectionContext);
  const snapshot = { deferredInputs: [entry], messageReceipts: [] };
  assert.deepEqual(Array.from(projectionContext.deferredEntriesForTask(snapshot, "stream-1")), []);
  const entries = projectionContext.deferredEntriesForTask(snapshot, "stream-2");
  assert.deepEqual(Array.from(entries), [entry]);

  const nodes = [];
  const renderContext = vm.createContext({
    state: { queue: new Map([["stream-2", entries]]), tasks: [] },
    el: (tag, attributes, children = []) => {
      const node = { tag, ...attributes, children };
      nodes.push(node);
      return node;
    },
  });
  vm.runInContext(await readFile(
    new URL("../../assets/web-app/message-view-controller.js", import.meta.url),
    "utf8",
  ), renderContext);
  renderContext.MessageView = renderContext.AgentHubMessageView;
  const start = miniAppSource.indexOf("function renderQueueForTask(");
  const end = miniAppSource.indexOf("function renderQueue()", start);
  vm.runInContext(miniAppSource.slice(start, end), renderContext);
  const container = { hidden: true, replaceChildren() {}, append() {} };
  renderContext.renderQueueForTask("stream-2", container);
  assert.equal(container.hidden, false);
  assert.equal(nodes.some((node) => node.class === "queue-head" && node.text === "Требуют решения: 1"), true);
  assert.equal(nodes.some((node) => node.class === "queue-error" && node.text === entry.lastError), true);
  for (const action of ["queue-retry", "queue-remove"]) {
    const button = nodes.find((node) => node["data-action"] === action);
    assert.equal(button?.["data-queue-id"], entry.id);
    assert.notEqual(button?.disabled, true);
  }
});

test("idle intake survives receipt-window loss and reload without moving to the queue", () => {
  const clientUserMessageId = "client-idle-outside-receipt-window";
  const deferredInput = {
    clientUserMessageId,
    state: "queued",
    conflictKind: "message-intake",
    clientProjectionIntent: "conversation",
  };
  const newerReceipts = Array.from({ length: 100 }, (_, index) => ({
    clientUserMessageId: `client-terminal-${index}`,
    accepted: true,
  }));
  const exposedReceipts = [{
    clientUserMessageId,
    accepted: true,
    deferred: true,
    queued: true,
    reason: "message-intake",
  }, ...newerReceipts].slice(-100);

  assert.equal(exposedReceipts.some((receipt) => (
    receipt.clientUserMessageId === clientUserMessageId
  )), false);
  assert.equal(lifecycle.queuedCommandUsesQueue(deferredInput, exposedReceipts), false);
  assert.equal(lifecycle.queuedCommandDeliveryState(deferredInput, exposedReceipts), null);
  const deferredIds = lifecycle.queuedCommandClientUserMessageIds(
    [deferredInput],
    exposedReceipts,
  );
  assert.deepEqual(deferredIds, []);
  const restored = lifecycle.deferredInputConversationProjection({
    ...deferredInput,
    createdAt: "2026-09-03T10:01:02.345Z",
  }, exposedReceipts);
  assert.equal(restored.clientUserMessageId, clientUserMessageId);
  assert.equal(restored.projectionState, "optimistic");
  assert.equal(restored.deliveryState, "accepted");
  assert.deepEqual(
    lifecycle.visibleConversationMessages([{
      ...message(clientUserMessageId, "Не исчезай после reload"),
      turnId: "",
      projectionState: restored.projectionState,
      providerAccepted: restored.providerAccepted,
      deliveryState: restored.deliveryState,
    }], { deferredClientUserMessageIds: deferredIds }).map((item) => item.clientUserMessageId),
    [clientUserMessageId],
  );
});

test("idle-to-busy race transfers the already visible exact command to the queue", () => {
  const clientUserMessageId = "client-idle-race";
  const optimistic = {
    ...message(clientUserMessageId, "Не мигай"),
    turnId: "",
    projectionState: "optimistic",
    providerAccepted: false,
    deliveryState: "sending",
    clientProjectionIntent: "conversation",
  };
  assert.deepEqual(
    lifecycle.visibleConversationMessages([optimistic]).map((item) => item.clientUserMessageId),
    [clientUserMessageId],
  );

  const deferredInput = {
    clientUserMessageId,
    state: "pending",
    conflictKind: "task-running",
    clientProjectionIntent: "conversation",
    createdAt: "2026-09-03T10:02:03.456Z",
  };
  const receipt = {
    clientUserMessageId,
    accepted: false,
    deferred: true,
    reason: "task-running",
    clientProjectionIntent: "conversation",
  };
  const deferredIds = lifecycle.queuedCommandClientUserMessageIds(
    [deferredInput],
    [receipt],
  );
  assert.deepEqual(deferredIds, [clientUserMessageId]);
  assert.deepEqual(
    lifecycle.visibleConversationMessages([optimistic], {
      deferredClientUserMessageIds: deferredIds,
    }).map((item) => item.clientUserMessageId),
    [],
  );
  assert.equal(lifecycle.deferredInputConversationProjection(deferredInput, [receipt]), null);
});

test("busy-origin intent remains queue-only when admission finds the Stream idle", () => {
  const clientUserMessageId = "client-busy-race";
  const receipt = {
    clientUserMessageId,
    accepted: true,
    deferred: true,
    queued: true,
    reason: "message-intake",
    clientProjectionIntent: "queue",
  };
  const deferredInput = {
    clientUserMessageId,
    state: "queued",
    conflictKind: "message-intake",
    clientProjectionIntent: "queue",
  };
  assert.equal(lifecycle.queueHistoryReceiptProjection(receipt).ownsDeferredQueue, true);
  assert.deepEqual(
    lifecycle.queuedCommandClientUserMessageIds([deferredInput], [receipt]),
    [clientUserMessageId],
  );
  assert.equal(lifecycle.deferredInputConversationProjection(deferredInput, [receipt]), null);
});

test("definitive rejection restores neither queue nor optimistic conversation", () => {
  const clientUserMessageId = "client-rejected";
  const receipt = {
    clientUserMessageId,
    accepted: false,
    deferred: false,
    rejected: true,
    reason: "launch-rejected",
    clientProjectionIntent: "conversation",
  };
  const deferredInput = {
    clientUserMessageId,
    state: "pending",
    conflictKind: "task-running",
    clientProjectionIntent: "conversation",
  };
  const projection = lifecycle.queueHistoryReceiptProjection(receipt);
  assert.equal(projection.ownsDeferredQueue, false);
  assert.equal(projection.ownsOptimisticConversation, false);
  assert.deepEqual(lifecycle.queuedCommandClientUserMessageIds([deferredInput], [receipt]), []);
  assert.equal(lifecycle.deferredInputConversationProjection(deferredInput, [receipt]), null);
});

test("authoritative provider acceptance moves one exact command into conversation history", () => {
  const clientUserMessageId = "client-provider-accepted";
  const deferredInput = {
    clientUserMessageId,
    state: "dispatching",
    clientProjectionIntent: "queue",
  };
  const receipt = {
    clientUserMessageId,
    accepted: true,
    deferred: false,
    queued: false,
    runId: "run-1",
    turnId: "turn-1",
    clientProjectionIntent: "queue",
  };
  const projection = lifecycle.queueHistoryReceiptProjection(receipt);
  assert.equal(projection.providerAccepted, true);
  assert.equal(projection.ownsDeferredQueue, false);
  assert.equal(projection.deliveryState, "running");
  assert.equal(lifecycle.queuedCommandUsesQueue(deferredInput, [receipt]), false);
  assert.deepEqual(
    lifecycle.queuedCommandClientUserMessageIds([deferredInput], [receipt]),
    [],
  );
  const optimistic = {
    ...message(clientUserMessageId, "Один раз"),
    itemId: clientUserMessageId,
    deliveryState: "accepted",
  };
  const canonical = {
    ...optimistic,
    id: "provider-user-item",
    itemId: "provider-user-item",
    turnId: "turn-1",
    projectionAuthority: "canonical",
  };
  const visible = lifecycle.visibleConversationMessages(
    lifecycle.deduplicateConversationMessages([canonical, optimistic]),
  );
  assert.equal(visible.length, 1);
  assert.equal(visible[0].clientUserMessageId, clientUserMessageId);
  assert.equal(visible[0].turnId, "turn-1");
});

test("active run projection requires exact provider acceptance identity", () => {
  const task = {
    running: true,
    provider: "codex",
    threadId: "thread-1",
    streamId: "stream-1",
    run: {
      id: "run-1",
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-1",
      clientUserMessageId: "client-1",
      providerStart: {
        state: "requesting",
        turnId: null,
      },
    },
  };
  assert.equal(lifecycle.runHasAuthoritativeProviderAcceptance(task.run), false);
  assert.equal(lifecycle.authoritativeActiveRunMessageReceipts([task]).length, 0);

  task.run.providerStart = {
    state: "accepted-awaiting-first-event",
    turnId: "turn-1",
  };
  const receipts = lifecycle.authoritativeActiveRunMessageReceipts([task]);
  assert.equal(receipts.length, 1);
  assert.equal(receipts[0].clientUserMessageId, "client-1");
  assert.equal(receipts[0].providerAccepted, true);
});

test("terminal history reload replaces an idle optimistic projection without a duplicate", () => {
  const clientUserMessageId = "client-terminal-reload";
  const optimistic = {
    ...message(clientUserMessageId, "После reload"),
    turnId: "",
    itemId: clientUserMessageId,
    deliveryState: "accepted",
    projectionAuthority: "optimistic",
    projectionState: "optimistic",
    providerAccepted: false,
  };
  const canonical = {
    ...optimistic,
    id: "history-user-item",
    itemId: "history-user-item",
    turnId: "turn-completed",
    deliveryState: "delivered",
    projectionAuthority: "canonical",
    projectionState: "completed",
  };
  assert.deepEqual(
    Array.from(lifecycle.providerAcceptedHistoryClientUserMessageIds([canonical])),
    [clientUserMessageId],
  );
  assert.deepEqual(
    Array.from(lifecycle.providerAcceptedHistoryClientUserMessageIds([{
      ...canonical,
      clientUserMessageId: "",
      submissionId: "",
    }])),
    [],
  );
  for (const values of [[canonical, optimistic], [optimistic, canonical]]) {
    const messages = projection.projectCanonicalMessages(values);
    assert.equal(messages.length, 1);
    assert.deepEqual(
      Array.from(lifecycle.visibleConversationMessages(messages), (item) => [
        item.id,
        item.clientUserMessageId,
        item.turnId,
      ]),
      [["history-user-item", clientUserMessageId, "turn-completed"]],
    );
  }
});

test("queued outgoing state restores the separate queue when receipt and snapshot race", () => {
  const clientUserMessageId = "client-queued-state";
  const outgoing = {
    ...message(clientUserMessageId, "Следующий вопрос"),
    turnId: "",
    itemId: clientUserMessageId,
    deliveryState: "sending",
    projectionAuthority: "optimistic",
    projectionState: "queued",
    providerAccepted: false,
  };
  assert.equal(lifecycle.messageAwaitsProviderAcceptance(outgoing), true);
  const merged = lifecycle.mergeDeferredQueueEntries([], [{
    id: `local:${clientUserMessageId}`,
    clientUserMessageId,
    state: "dispatching",
    deliveryState: outgoing.deliveryState,
    text: outgoing.text,
    optimistic: true,
  }]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].clientUserMessageId, clientUserMessageId);
  assert.equal(merged[0].state, "dispatching");
});

test("live user update enriches a durable duplicate with its attachment and time", () => {
  const merged = lifecycle.mergeLiveUserMessages([{
    id: "durable-user",
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "item-1",
    clientUserMessageId: "client-1",
    role: "user",
    text: "Со скрином",
    time: null,
    attachments: [],
  }], {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    userMessages: [{
      itemId: "item-1",
      clientUserMessageId: "client-1",
      text: "Со скрином",
      time: "2026-08-03T22:32:00.004Z",
      attachments: [{ id: "screen.png", name: "screen.png", type: "image/png" }],
    }],
  });

  assert.equal(merged.length, 1);
  assert.equal(merged[0].id, "durable-user");
  assert.equal(merged[0].time, "2026-08-03T22:32:00.004Z");
  assert.equal(JSON.stringify(merged[0].attachments), JSON.stringify([
    { id: "screen.png", name: "screen.png", type: "image/png" },
  ]));
});

test("one undated message does not leave restored history below a newer reply", () => {
  const values = lifecycle.chronologicalMessages([
    { id: "current-user", role: "user", turnId: "current", time: "2026-08-03T16:51:00.000Z" },
    { id: "current-agent", role: "agent", turnId: "current", time: "2026-08-03T16:57:00.000Z" },
    { id: "old-user", role: "user", turnId: "old", time: "2026-08-03T16:25:00.000Z" },
    { id: "old-agent-without-time", role: "agent", turnId: "old", time: null },
    { id: "older-agent", role: "agent", turnId: "older", time: "2026-08-03T15:58:00.000Z" },
  ]);
  assert.deepEqual(values.map((item) => item.id), [
    "older-agent",
    "old-user",
    "old-agent-without-time",
    "current-user",
    "current-agent",
  ]);
});

test("an undated optimistic message remains after dated history", () => {
  const values = lifecycle.chronologicalMessages([
    { id: "pending", role: "user", time: null },
    { id: "history", role: "agent", time: "2026-08-03T16:57:00.000Z" },
    { id: "undated-agent", role: "agent", time: null },
  ]);
  assert.deepEqual(values.map((item) => item.id), ["history", "pending", "undated-agent"]);
});

test("undated historical turns keep their server order between dated turns", () => {
  const values = lifecycle.chronologicalMessages([
    { id: "undated-before", role: "agent", turnId: "31", time: null, historyOrder: 31_001 },
    { id: "dated-user", role: "user", turnId: "32", time: "2026-08-02T19:00:17.902Z", historyOrder: 32_000 },
    { id: "dated-agent", role: "agent", turnId: "32", time: null, historyOrder: 32_001 },
    { id: "dated-later", role: "agent", turnId: "34", time: "2026-08-02T19:55:25.340Z", historyOrder: 34_001 },
    { id: "undated-after", role: "agent", turnId: "35", time: null, historyOrder: 35_001 },
  ]);
  assert.deepEqual(values.map((item) => item.id), [
    "undated-before",
    "dated-user",
    "dated-agent",
    "dated-later",
    "undated-after",
  ]);
});

test("interrupted turns keep their persisted partial response visible", () => {
  assert.equal(lifecycle.historicalAgentResponseVisible({
    active: false,
    completed: false,
    status: "interrupted",
  }), true);
  assert.equal(lifecycle.historicalAgentResponseVisible({
    active: true,
    completed: false,
    status: "inProgress",
  }), false);
});

test("focused execution turn does not duplicate its task history prompt", () => {
  const history = { provider: "codex", threadId: "task-thread" };
  const official = [{
    provider: "codex",
    threadId: "task-thread",
    turnId: "turn-1",
    itemId: "server-item",
    role: "user",
    text: "Исходный вопрос",
  }];
  const focusedTurn = {
    provider: "codex",
    taskThreadId: "task-thread",
    turnThreadId: "execution-thread",
    turnId: "turn-1",
    prompt: "Исходный вопрос",
  };
  assert.equal(lifecycle.focusedTurnTaskThreadId(focusedTurn), "task-thread");
  assert.equal(lifecycle.focusedTurnAlreadyVisible(history, official, focusedTurn), true);
  assert.equal(lifecycle.focusedTurnAlreadyVisible({
    provider: "claude",
    threadId: "thread-current",
  }, [{
    provider: "codex",
    threadId: "thread-old",
    turnId: "turn-old",
  }], {
    provider: "codex",
    taskThreadId: "thread-old",
    turnId: "turn-old",
  }), true);
});

test("history catch-up waits for the exact completed answer turn", () => {
  const task = {
    lastAnswer: "Готовый ответ",
    lastAnswerAt: "2026-08-02T10:00:01.000Z",
    lastAnswerTurnId: "turn-2",
  };
  const stale = {
    items: [{
      id: "turn-2",
      completed: false,
      messages: [{ role: "user", text: "Вопрос" }],
    }],
  };
  assert.equal(lifecycle.historyContainsLatestAnswer(stale, task), false);
  const answerWithoutUser = {
    items: [{
      id: "turn-2",
      completed: true,
      messages: [{ role: "agent", phase: "final", text: "Готовый ответ" }],
    }],
  };
  assert.equal(lifecycle.historyContainsLatestAnswer(answerWithoutUser, task), false);
  const caughtUp = {
    items: [{
      id: "turn-2",
      completed: true,
      messages: [
        { role: "user", text: "Вопрос" },
        { role: "agent", phase: "final", text: "Готовый ответ" },
      ],
    }],
  };
  assert.equal(lifecycle.historyContainsLatestAnswer(caughtUp, task), true);
  caughtUp.items[0].answer = "Готовый";
  caughtUp.items[0].messages[1].text = "Готовый";
  assert.equal(lifecycle.historyContainsLatestAnswer(caughtUp, task), false);
});

test("compact history catch-up rejects completed commentary until the final phase arrives", () => {
  const task = {
    provider: "codex",
    threadId: "thread-1",
    lastAnswer: "",
    lastAnswerAt: "2026-08-18T15:55:34.066Z",
    lastAnswerTurnId: "turn-2",
  };
  const commentary = {
    provider: "codex",
    threadId: "thread-1",
    items: [{
      id: "turn-2",
      completed: true,
      prompt: "Почему?",
      answer: "Проверяю причину",
      messages: [
        { role: "user", text: "Почему?" },
        { role: "agent", phase: "commentary", text: "Проверяю причину" },
      ],
    }],
  };

  assert.equal(lifecycle.historyContainsLatestAnswer(commentary, task), false);
  commentary.items[0].answer = "Причина найдена";
  commentary.items[0].messages.push({
    role: "agent",
    phase: "final_answer",
    text: "Причина найдена",
  });
  assert.equal(lifecycle.historyContainsLatestAnswer(commentary, task), true);
});

test("legacy answer records without a turn id match their completed text", () => {
  const task = {
    lastAnswer: "Старый готовый ответ",
    lastAnswerAt: "2026-08-02T10:00:01.000Z",
  };
  assert.equal(lifecycle.historyContainsLatestAnswer({
    items: [{ id: "turn-legacy", completed: true, answer: "Старый готовый ответ" }],
  }, task), true);
});

test("history catch-up ignores a matching answer from an old provider Thread", () => {
  const task = {
    provider: "claude",
    threadId: "thread-new",
    lastAnswer: "Одинаковый финал",
    lastAnswerAt: "2026-08-18T10:00:00.000Z",
  };
  assert.equal(lifecycle.historyContainsLatestAnswer({
    provider: "claude",
    threadId: "thread-new",
    items: [{
      id: "turn-old",
      provider: "codex",
      threadId: "thread-old",
      completed: true,
      answer: "Одинаковый финал",
    }],
  }, task), false);
});

test("active stage always identifies the whole turn as running", () => {
  assert.equal(lifecycle.activeStageLabel(""), "Ход выполняется");
  assert.equal(
    lifecycle.activeStageLabel("✓ Анализ завершён."),
    "Ход выполняется · ✓ Анализ завершён.",
  );
  assert.equal(
    lifecycle.activeStageLabel("Ход выполняется · проверка"),
    "Ход выполняется · проверка",
  );
});

test("remote attachment retries upload again while local VSC paths remain reusable", () => {
  const previous = ["remote-attachment:old"];
  assert.deepEqual(
    [...lifecycle.reusableAttachmentPaths(previous, 1, { remote: true })],
    [],
  );
  assert.deepEqual(
    [...lifecycle.reusableAttachmentPaths(["C:\\AgentHub\\image.png"], 1)],
    ["C:\\AgentHub\\image.png"],
  );
  assert.deepEqual([...lifecycle.reusableAttachmentPaths(previous, 2)], []);
});

test("only tagged transport failures change the Hub connection state", () => {
  const applicationError = new Error("remote attachment not found");
  assert.equal(lifecycle.isConnectionFailure(applicationError), false);
  const transportError = lifecycle.markConnectionFailure(new Error("fetch failed"));
  assert.equal(lifecycle.isConnectionFailure(transportError), true);
  assert.equal(transportError.message, "fetch failed");
});

test("remote attachment failures are shown in Russian", () => {
  assert.equal(
    lifecycle.hubErrorMessage(new Error("remote attachment not found")),
    "Вложение недоступно. Повторите отправку.",
  );
  assert.equal(lifecycle.hubErrorMessage(new Error("Другая ошибка")), "Другая ошибка");
});

test("named-pipe transport errors are recognized and hidden from the interface", () => {
  const error = new Error(
    "connect ENOENT \\\\.\\pipe\\agent-hub-desktop-" + "a".repeat(64),
  );
  assert.equal(lifecycle.looksLikeConnectionFailure(error), true);
  assert.equal(lifecycle.hubErrorMessage(error), "Нет связи с Agent Hub.");
  assert.doesNotMatch(lifecycle.hubErrorMessage(error), /pipe|ENOENT/iu);
});

test("returning to a busy task keeps its deferred user card only in the queue", () => {
  const activeUser = {
    ...message("active-client", "Первый вопрос"),
    turnId: "active-turn",
    itemId: "active-user",
  };
  const activeAgent = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "active-turn",
    itemId: "active-agent",
    role: "agent",
    text: "Работа продолжается",
  };
  const deferredUser = {
    ...message("deferred-client", "Следующий вопрос"),
    turnId: "",
    itemId: "",
    deliveryState: "queued",
  };
  const visible = lifecycle.visibleConversationMessages(
    [activeUser, activeAgent, deferredUser],
    {
      deferredClientUserMessageIds: ["deferred-client"],
      liveProbe: { ...activeAgent, text: undefined },
    },
  );
  assert.deepEqual(visible, [activeUser]);
});

test("rotation completion waits for maintenance and keeps its post-answer position", () => {
  assert.match(
    hubClientSource,
    /pendingStreamRotations\.set\([\s\S]*sourceThreadId: transition\.sourceThreadId[\s\S]*time: transition\.time/u,
  );
  assert.match(hubClientSource, /if \(rotationMaintenanceActive\(task\)\) continue;/u);
  assert.match(hubClientSource, /placement: "after-source-turn"/u);
  assert.match(hubClientSource, /!String\(entry\.message\?\.sourceThreadId \?\? ""\)\.trim\(\)/u);
});

test("context compaction start identifies the task and completion stays in chat", () => {
  const sandbox = vm.createContext({});
  vm.runInContext(clientFunctionSource("taskDisplayTitle"), sandbox);
  assert.equal(sandbox.taskDisplayTitle({ workspaceName: "Workspace", streamName: "S2" }), "Workspace - S2");
  assert.equal(sandbox.taskDisplayTitle({ displayTitle: "Exact Task", title: "Historical Thread" }), "Exact Task");
  // Exact completion identity and unknown measurement projection are exercised
  // by the executable compaction observer cases below.
});

test("compaction markers keep exact operation identity before provider turn acceptance", () => {
  const sandbox = vm.createContext({ taskId: () => "task-1" });
  vm.runInContext(clientFunctionSource("rotationMaintenanceActive", "function syncActiveMaintenanceMessages"), sandbox);
  const marker = sandbox.activeMaintenanceMessage({
    provider: "codex", threadId: "thread-1",
    context: { compaction: {
      operationId: "operation-1", status: "running", turnId: null,
      startedAt: "2026-09-09T20:10:00.000Z", origin: "automatic",
    } },
  });
  assert.equal(marker.turnId, null);
  assert.equal(marker.id, "maintenance:compaction:operation-1:active");
  assert.equal(marker.text, "Автосвёртка контекста…");
  const visible = projection.projectCanonicalMessages(lifecycle.visibleConversationMessages([marker]));
  assert.equal(visible.length, 1);
  assert.equal(visible[0].role, "system");
});

test("unknown and legacy timeout compaction replace false failure and settle by exact operation", () => {
  const events = new Map();
  const sandbox = vm.createContext({
    taskId: () => "task-1", maintenanceEventsByTask: events,
    observedContextCompactions: new Map(), requestedContextCompactions: new Set(),
    contextPercent: (value) => value == null ? null : Number(value),
    storedMaintenancePercent: () => null,
    latestMaintenanceMessages: (values) => values,
    persistMaintenanceEvents: () => {},
    agentHub: { toast: () => {} },
    window: {},
  });
  vm.runInContext(clientFunctionSource("rememberMaintenanceEvent", "function taskIdentity"), sandbox);
  vm.runInContext(clientFunctionSource("observeContextCompactions", "function observeStreamRotations"), sandbox);
  const compaction = {
    operationId: "operation-1", origin: "automatic", turnId: null,
    startedAt: "2026-09-09T20:10:00.000Z", beforePercent: 77,
  };
  const observe = (details) => sandbox.observeContextCompactions([{
    provider: "codex", threadId: "thread-1", context: { compaction: { ...compaction, ...details } },
  }]);
  observe({ status: "failed" });
  for (const status of ["unknown", "timeout"]) {
    observe({ status });
    const markers = events.get("task-1");
    assert.equal(markers.length, 1);
    assert.equal(markers[0].id, "maintenance:compaction:operation-1");
    assert.equal(markers[0].maintenanceStatus, "unknown");
    assert.equal(markers[0].text, "Статус свёртки неизвестен");
  }
  observe({ status: "completed", measurementStatus: "completed", afterPercent: 14 });
  const markers = events.get("task-1");
  assert.equal(markers.length, 1);
  assert.equal(markers[0].maintenanceStatus, "completed");
  assert.equal(markers[0].afterPercent, 14);
  observe({ status: "failed" });
  observe({ status: "completed", measurementStatus: "completed", afterPercent: 14 });
  assert.equal(events.get("task-1").length, 1);
  assert.equal(events.get("task-1")[0].maintenanceStatus, "completed");

  observe({ status: "completed", measurementStatus: "completed", measurementKind: "estimated", afterPercent: 14 });
  const estimated = events.get("task-1")[0];
  assert.equal(estimated.measurementKind, "estimated");
  assert.match(estimated.text, /77% → ≈14%/u);
  assert.match(estimated.maintenanceDetail, /Предварительная оценка провайдера/u);

  sandbox.observeContextCompactions([{
    provider: "codex", threadId: "thread-1", streamId: "stream-1",
    context: { compaction: { ...compaction, status: "completed", measurementStatus: "completed",
      measurementKind: "estimated", afterPercent: 14,
      rotationStatus: "failed", rotationMessage: "Целевой Thread недоступен",
    } },
  }]);
  const rotationFailure = events.get("task-1").find((item) => item.maintenanceType === "rotation");
  assert.equal(rotationFailure.maintenanceStatus, "failed");
  assert.match(rotationFailure.text, /Исходный Thread сохранён/u);
  assert.match(rotationFailure.maintenanceDetail, /Целевой Thread недоступен/u);
  assert.equal(events.get("task-1").find((item) => item.maintenanceType === "compaction").maintenanceStatus, "completed");
  events.set("task-1", events.get("task-1").filter((item) => item.maintenanceType === "compaction"));

  // Neither a previous marker nor a current usage value proves a new measurement.
  for (const details of [
    { measurementStatus: "completed", measurementKind: "estimated", afterPercent: null },
    { measurementStatus: "failed", afterPercent: 14 },
    { afterPercent: 14 },
  ]) {
    observe({ status: "completed", ...details });
    const missing = events.get("task-1")[0];
    assert.equal(missing.afterPercent, null);
    assert.doesNotMatch(missing.text, /(?:≈14%|успешно)/u);
    assert.ok(missing.maintenanceDetail);
  }
});

test("workspace task panel follows the effective local Stream selection", () => {
  assert.doesNotMatch(
    hubClientSource,
    /selectedWorkspaceId: snapshot\.selected\?\.workspaceId/u,
  );
  assert.match(
    hubClientSource,
    /const selectedTask = tasks\.find\(\(task\) => task\.id === effectiveSelectedId\);[\s\S]*const selectedWorkspaceId = String\(selectedTask\?\.workspaceId \?\? ""\)\.trim\(\) \|\| null;[\s\S]*AgentHubTaskBoard\?\.setSnapshot\(\{[\s\S]*selectedWorkspaceId,/u,
  );
});

test("completed history attaches the turn trace to its visible final answer", () => {
  const source = clientFunctionSource("historyMessages", "function mergeNewestHistory");
  const sandbox = vm.createContext({
    attachmentViews: () => [],
    conversationMessageAuthor: (_message, provider) => provider,
    focusedTurnAlreadyVisible: () => true,
    focusedTurnTaskThreadId: () => "",
    canonicalProjectionState: projection.projectionState,
    historicalMessagesForDisplay: lifecycle.historicalMessagesForDisplay,
  });
  vm.runInContext(`${source}; globalThis.mapHistory = historyMessages;`, sandbox);
  const messages = sandbox.mapHistory({
    provider: "codex",
    threadId: "thread-1",
    items: [{
      id: "turn-1",
      completed: true,
      activities: [{ id: "tool-1" }],
      activityGroups: [{ id: "reasoning-1", reasoning: "Проверяю причину.", activities: [] }],
      messages: [
        { itemId: "user-1", role: "user", text: "Почему?" },
        { itemId: "commentary-1", role: "agent", text: "Проверяю" },
        { itemId: "final-1", role: "agent", phase: "final_answer", text: "Причина найдена" },
      ],
    }],
  });

  assert.deepEqual(Array.from(messages[0].activityGroups), []);
  assert.equal(messages[1].text, "Причина найдена");
  assert.equal(messages[1].activityGroups[0].reasoning, "Проверяю причину.");
  assert.equal(messages[1].activities[0].id, "tool-1");
});

test("Stream UI keeps the selected live Thread instead of a historical duplicate", () => {
  assert.match(streamTabsSource, /function representativeSnapshotTasks\(tasks\)/u);
  assert.match(
    streamTabsSource,
    /task\?\.selected[\s\S]*task\?\.running && String\(task\?\.run\?\.turnId/u,
  );
  assert.match(
    hubClientSource,
    /const representativeTasks = representativeSnapshotTasks\(snapshot\.tasks\)/u,
  );
  assert.match(
    hubClientSource,
    /representativeTasks\.map\(\(task\) => modelTask/u,
  );
  assert.match(
    hubClientSource,
    /for \(const task of representativeTasks\) \{\s*const stableTaskId[\s\S]*agentHub\.setLive/u,
  );
  assert.match(
    hubClientSource,
    /function taskIdentity\(id\)[\s\S]*representativeSnapshotTasks\(lastSnapshot\?\.tasks\)/u,
  );
});

test("Hub compaction delegates targeted completion to its context maintenance owner", () => {
  assert.match(
    codexEventSource,
    /if \(d\.isCompactionItem\(params\.item\)\) \{[\s\S]*?d\.beginCompactionCleanup/u,
  );
  assert.match(
    codexContextMaintenanceSource,
    /if \(result\.applied \|\| result\.reason === "below-threshold"\) \{\s*this\.compactions\.complete/u,
  );
  assert.match(serverSource, /codexContextMaintenance\.beginCompactionCleanup/u);
  assert.doesNotMatch(
    serverSource,
    /contextCompactions\.complete/u,
  );
  assert.match(
    serverSource,
    /isMaintenanceActive: \(target\) => streamContextMaintenance\.isActive\(target\)/u,
  );
});

test("completed live card uses a newly recorded final even before durable history catches up", () => {
  const previous = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-2",
    text: "",
    snapshotLastAnswerAt: "2026-08-02T09:00:00.000Z",
  };
  assert.equal(lifecycle.completedLiveAnswer(previous, {
    lastAnswer: "Готовый ответ",
    lastAnswerAt: "2026-08-02T10:00:01.000Z",
    lastAnswerTurnId: "turn-2",
  }), "Готовый ответ");
  assert.equal(lifecycle.completedLiveAnswer(previous, {
    lastAnswer: "Legacy final",
    lastAnswerAt: "2026-08-02T10:00:01.000Z",
  }), "Legacy final");
});

test("terminal history clears a pre-turn live card by exact client identity", () => {
  const taskId = "stream:s5";
  const provider = "codex";
  const threadId = "10000000-0000-4000-8000-000000000020";
  const turnId = "20000000-0000-4000-8000-000000000028";
  const clientUserMessageId = "qa-28";
  const history = [
    {
      provider, threadId, turnId, itemId: `${turnId}:user`, role: "user",
      clientUserMessageId, text: "QA-28", projectionState: "completed",
    },
    {
      provider, threadId, turnId, itemId: `${turnId}:agent:final`, role: "agent",
      text: "Принято", projectionState: "completed", terminalRevision: 1,
    },
  ];
  assert.deepEqual(
    { ...lifecycle.completedLiveTurnIdentity(history, {
      provider,
      threadId,
      turnId: "",
      clientUserMessageIds: [clientUserMessageId],
    }) },
    { provider, threadId, turnId },
  );

  const liveCardsByTask = new Map([[taskId, { provider, threadId, turnId: "" }]]);
  const liveProbeByTask = new Map([[taskId, { provider, threadId, turnId: "" }]]);
  const liveUserMessagesByTask = new Map([[taskId, {
    provider,
    threadId,
    turnId: "",
    clientUserMessageId,
    userMessages: [{ clientUserMessageId }],
  }]]);
  const cleared = [];
  const sandbox = vm.createContext({
    liveCardsByTask,
    liveProbeByTask,
    liveUserMessagesByTask,
    historyByTask: new Map([[taskId, history]]),
    completedLiveTurnIdentity: lifecycle.completedLiveTurnIdentity,
    lastSnapshot: { tasks: [] },
    agentHub: { setLive: (...args) => cleared.push(args) },
  });
  const clearSource = clientFunctionSource(
    "clearDurablyCompletedLiveCard",
    "function exactSelectedTaskParams",
  );
  vm.runInContext(`${clearSource}; globalThis.clearLive = clearDurablyCompletedLiveCard;`, sandbox);

  assert.equal(sandbox.clearLive(taskId), true);
  assert.equal(liveCardsByTask.has(taskId), false);
  assert.equal(liveProbeByTask.has(taskId), false);
  assert.equal(liveUserMessagesByTask.has(taskId), false);
  assert.deepEqual(cleared, [[taskId, null]]);
});

test("an inactive snapshot clears a retained user live card after queued turns drain", () => {
  const taskId = "stream:burst";
  const liveCardsByTask = new Map([[taskId, {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-last",
    operationKind: "user-turn",
    projectionAuthority: "live",
    projectionState: "active",
    stage: "Поток принят.",
  }]]);
  const liveProbeByTask = new Map([[taskId, { turnId: "turn-last" }]]);
  const liveUserMessagesByTask = new Map([[taskId, {
    clientUserMessageId: "client-last",
  }]]);
  const rendered = [];
  const sandbox = vm.createContext({
    activeTaskRun: lifecycle.activeTaskRun,
    isUserRunningProjection: projection.isUserRunningProjection,
    projectedActiveUserRun: (_id, task) => lifecycle.activeTaskRun(task),
    promoteLiveCompletion: () => false,
    rememberSnapshotCompletion: () => false,
    clearInternalContextProbe: () => {},
    liveCardsByTask,
    liveProbeByTask,
    liveUserMessagesByTask,
    renderTaskMessages: (...args) => rendered.push(args),
  });
  const source = clientFunctionSource(
    "updateLiveMessage",
    "function authorizationHeaders",
  );
  vm.runInContext(`${source}; globalThis.updateLive = updateLiveMessage;`, sandbox);

  assert.equal(sandbox.updateLive(taskId, { running: false, run: null }), null);
  assert.equal(liveCardsByTask.has(taskId), false);
  assert.equal(liveProbeByTask.has(taskId), false);
  assert.equal(liveUserMessagesByTask.has(taskId), false);
  assert.deepEqual(rendered, [[taskId]]);
});

test("pre-turn live cleanup never crosses provider Thread identity", () => {
  const turnId = "20000000-0000-4000-8000-000000000028";
  assert.equal(lifecycle.completedLiveTurnIdentity([
    {
      provider: "codex", threadId: "thread-old", turnId, role: "user",
      clientUserMessageId: "qa-28", text: "QA-28",
    },
    {
      provider: "codex", threadId: "thread-old", turnId, role: "agent",
      text: "Принято", projectionState: "completed", terminalRevision: 1,
    },
  ], {
    provider: "codex",
    threadId: "thread-current",
    clientUserMessageIds: ["qa-28"],
  }), null);
});

test("terminal live promotion keeps the complete activity trace", () => {
  const activities = [{ id: "tool-1", type: "command" }];
  const activityGroups = [{ id: "group-1", reasoning: "Проверяю.", activities }];
  const attachments = [{ id: "generated-one.png", type: "image/png" }];
  const message = lifecycle.completedLiveAgentMessage({
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-2",
    itemId: "agent-live",
    author: "Codex",
    text: "Финальный ответ",
    responsePhase: "final_answer",
    activities,
    activityGroups,
    attachments,
    turnStartedAt: "2026-08-24T01:00:00.000Z",
  }, {
    lastAnswer: "",
    lastAnswerAt: "2026-08-24T01:01:00.000Z",
    lastAnswerTurnId: "turn-2",
  });

  assert.equal(message.text, "Финальный ответ");
  assert.equal(message.time, "2026-08-24T01:01:00.000Z");
  assert.equal(message.turnCompletedAt, "2026-08-24T01:01:00.000Z");
  assert.deepEqual(message.activities, activities);
  assert.deepEqual(message.activityGroups, activityGroups);
  assert.deepEqual(JSON.parse(JSON.stringify(message.attachments)), attachments);
  assert.notEqual(message.attachments[0], attachments[0]);
});

test("live snapshot projects generated response attachments into the current card", () => {
  const taskId = "stream:imagegen-live";
  const liveCardsByTask = new Map();
  const sandbox = vm.createContext({
    window: { AgentHubMessageProjection: projection },
    activeTaskRun: lifecycle.activeTaskRun,
    isUserRunningProjection: () => true,
    projectedActiveUserRun: (_id, task) => lifecycle.activeTaskRun(task),
    promoteLiveCompletion: () => false,
    rememberSnapshotCompletion: () => false,
    clearInternalContextProbe: () => {},
    activeRunSubmissionTiming: () => ({ submittedAt: null, startedAt: null }),
    attachmentViews: (values) => (Array.isArray(values) ? values : [])
      .map((attachment) => ({ ...attachment, projected: true })),
    liveUserMessagesSignature: () => "signature",
    mergeLiveMaintenance: (live) => live,
    activeStageLabel: (stage) => stage,
    liveCardsByTask,
    liveProbeByTask: new Map(),
    liveUserMessagesByTask: new Map(),
    maintenanceEventsByTask: new Map(),
    renderTaskMessages: () => {},
  });
  const source = clientFunctionSource("updateLiveMessage", "function authorizationHeaders");
  vm.runInContext(`${source}; globalThis.updateLive = updateLiveMessage;`, sandbox);

  const live = sandbox.updateLive(taskId, {
    provider: "codex",
    threadId: "thread-imagegen-live",
    running: true,
    run: {
      turnId: "turn-imagegen-live",
      responseAttachments: [{ id: "generated-one.png", type: "image/png" }],
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(live.attachments)), [{
    id: "generated-one.png",
    type: "image/png",
    projected: true,
  }]);
  assert.equal(liveCardsByTask.get(taskId), live);
});

test("terminal catch-up reads local history before waiting for provider hydration", () => {
  assert.equal(lifecycle.historyRefreshSourceRequired({
    answerTransition: true,
    catchUpPending: true,
  }), false);
  assert.equal(lifecycle.historyRefreshSourceRequired({
    answerTransition: false,
    catchUpPending: true,
  }), true);
});

test("compact snapshot never promotes commentary as the final answer", () => {
  const previous = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-2",
    text: "Последний progress перед завершением",
    responsePhase: "commentary",
    snapshotLastAnswerAt: "2026-08-19T14:40:00.000Z",
  };
  const compactCompletion = {
    lastAnswer: "",
    lastAnswerAt: "2026-08-19T14:51:09.674Z",
    lastAnswerTurnId: "turn-2",
  };

  assert.equal(lifecycle.completedLiveAnswer(previous, compactCompletion), "");
  assert.equal(lifecycle.completedLiveAnswer({
    ...previous,
    text: "Финальный ответ",
    responsePhase: "final_answer",
  }, compactCompletion), "Финальный ответ");
});

test("snapshot completion survives a new run when the previous live card is already gone", () => {
  const selected = {
    provider: "codex",
    threadId: "thread-1",
    lastAnswer: "Финальный ответ",
    lastAnswerAt: "2026-08-16T22:29:34.987Z",
    lastAnswerTurnId: "turn-completed",
  };
  assert.deepEqual(
    { ...lifecycle.snapshotCompletionCandidate(selected, "turn-next") },
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-completed",
      answer: "Финальный ответ",
      time: "2026-08-16T22:29:34.987Z",
    },
  );
  assert.equal(lifecycle.snapshotCompletionCandidate(selected, "turn-completed"), null);
});

test("late snapshot final replaces an earlier terminal commentary overlay", () => {
  const completion = lifecycle.snapshotCompletionCandidate({
    provider: "codex",
    threadId: "thread-1",
    lastAnswer: "Финальный ответ",
    lastAnswerAt: "2026-08-19T07:06:37.541Z",
    lastAnswerTurnId: "turn-completed",
  });

  assert.deepEqual(
    { ...lifecycle.snapshotCompletionReplacement({
      answer: "Последний progress перед завершением",
    }, completion) },
    { ...completion },
  );
  assert.equal(lifecycle.snapshotCompletionReplacement({
    answer: "Финальный ответ",
  }, completion), null);
});

test("terminal snapshot run cannot mask its own final answer", () => {
  const terminal = {
    provider: "codex",
    threadId: "thread-1",
    running: false,
    lastAnswer: "Финальный ответ",
    lastAnswerAt: "2026-08-17T17:11:43.988Z",
    lastAnswerTurnId: "turn-completed",
    run: {
      turnId: "turn-completed",
      response: "Промежуточный commentary",
    },
  };

  assert.equal(lifecycle.activeTaskRun(terminal), null);
  assert.deepEqual(
    { ...lifecycle.snapshotCompletionCandidate(
      terminal,
      lifecycle.activeTaskRun(terminal)?.turnId,
    ) },
    {
      provider: "codex",
      threadId: "thread-1",
      turnId: "turn-completed",
      answer: "Финальный ответ",
      time: "2026-08-17T17:11:43.988Z",
    },
  );
  assert.equal(
    lifecycle.activeTaskRun({ ...terminal, running: true }),
    terminal.run,
  );
});

test("run completion starts history catch-up even when answer metadata has not changed yet", () => {
  const previous = {
    provider: "codex",
    threadId: "thread-1",
    running: true,
    lastAnswerAt: "",
  };
  const current = { ...previous, running: false };
  assert.equal(lifecycle.latestAnswerTransition(previous, current), true);
  assert.equal(lifecycle.latestAnswerTransition(current, current), false);
});

test("snapshot before history cannot acknowledge a final before render", () => {
  const taskId = "codex:thread-1";
  const final = {
    provider: "codex",
    threadId: "thread-1",
    turnId: "turn-1",
    revision: 2,
  };
  const terminal = {
    ...final,
    role: "agent",
    terminalRevision: 2,
    projectionState: "completed",
  };
  assert.equal(lifecycle.displayedFinalAcknowledgement({
    messages: [],
    final,
    selectTask: true,
    taskId,
  }), false);
  assert.equal(lifecycle.displayedFinalAcknowledgement({
    messages: [terminal],
    final,
    selectTask: true,
    taskId,
  }), true);
  assert.equal(lifecycle.displayedFinalAcknowledgement({
    messages: [terminal],
    final,
    selectedTaskId: taskId,
    taskId,
  }), true);
  assert.equal(lifecycle.displayedFinalAcknowledgement({
    messages: [terminal],
    final,
    selectedTaskId: "codex:thread-2",
    taskId,
  }), false);
  assert.equal(lifecycle.displayedFinalAcknowledgement({
    messages: [{ ...terminal, terminalRevision: 1 }],
    final,
    selectTask: true,
    taskId,
  }), false);
});

test("an active run is authoritative acceptance evidence for its client message", () => {
  const receipts = lifecycle.activeRunMessageReceipts([
    {
      provider: "codex",
      threadId: "thread-1",
      streamId: "stream-1",
      running: true,
      run: {
        turnId: "turn-1",
        clientUserMessageId: "client-1",
        submittedAt: "2026-08-25T22:14:00.000Z",
        startedAt: "2026-08-25T22:15:28.000Z",
        userMessages: [{
          itemId: "user-1",
          clientUserMessageId: "client-1",
          submittedAt: "2026-08-25T22:14:00.000Z",
          startedAt: "2026-08-25T22:15:28.000Z",
          time: "2026-08-25T22:14:00.000Z",
          attachments: [{ id: "attachment-1" }],
        }],
      },
    },
    {
      provider: "terra",
      threadId: "thread-idle",
      running: false,
      run: { clientUserMessageId: "client-idle" },
    },
  ]);

  assert.deepEqual(JSON.parse(JSON.stringify(receipts)), [{
    accepted: true,
    provider: "codex",
    threadId: "thread-1",
    streamId: "stream-1",
    clientUserMessageId: "client-1",
    turnId: "turn-1",
    itemId: "user-1",
    submittedAt: "2026-08-25T22:14:00.000Z",
    startedAt: "2026-08-25T22:15:28.000Z",
    deliveredAt: "2026-08-25T22:15:28.000Z",
    started: true,
    unknown: false,
    providerConnection: null,
    attachments: [{ id: "attachment-1" }],
  }]);
});

test("history catch-up waits for the completed turn instead of accepting the previous answer", () => {
  const previous = {
    provider: "codex",
    threadId: "thread-1",
    running: true,
    run: { turnId: "turn-current" },
    lastAnswerTurnId: "turn-old",
    lastAnswer: "Старый финал",
    lastAnswerAt: "2026-08-24T11:30:00.000Z",
  };
  const current = { ...previous, running: false, run: null };
  const history = {
    provider: "codex",
    threadId: "thread-1",
    items: [{
      id: "turn-old",
      completed: true,
      prompt: "Старый вопрос",
      answer: "Старый финал",
      messages: [{ role: "agent", phase: "final_answer", text: "Старый финал" }],
    }],
  };

  const expectedTurnId = lifecycle.completionCatchUpTurnId(previous, current);
  assert.equal(expectedTurnId, "turn-current");
  assert.equal(lifecycle.historyContainsLatestAnswer(history, current), true);
  assert.equal(lifecycle.historyContainsLatestAnswer(history, current, { expectedTurnId }), false);
  history.items.push({
    id: "turn-current",
    completed: true,
    prompt: "Новый вопрос",
    answer: "Новый финал",
    messages: [{ role: "agent", phase: "final_answer", text: "Новый финал" }],
  });
  assert.equal(lifecycle.historyContainsLatestAnswer(history, current, { expectedTurnId }), true);
});

test("a stale provider history keeps automatic catch-up active after restart", () => {
  assert.equal(lifecycle.nextHistoryCatchUpDeadline({
    sourceFresh: false,
    containsLatestAnswer: false,
    currentDeadline: 1_200,
    now: 2_000,
    timeoutMs: 30_000,
  }), 32_000);
  assert.equal(lifecycle.nextHistoryCatchUpDeadline({
    sourceFresh: true,
    containsLatestAnswer: true,
    currentDeadline: 1_200,
    now: 2_000,
    timeoutMs: 30_000,
  }), null);
  assert.equal(lifecycle.nextHistoryCatchUpDeadline({
    sourceFresh: true,
    containsLatestAnswer: false,
    currentDeadline: 1_200,
    now: 2_000,
    timeoutMs: 30_000,
  }), 1_200);
});

test("outgoing receipt lookup survives a task thread rebind", () => {
  const outgoingByTask = new Map([
    ["codex:thread-before", new Map([["client-1", { text: "Сообщение" }]])],
  ]);
  assert.equal(
    lifecycle.outgoingTaskId(outgoingByTask, "client-1", "codex:thread-after"),
    "codex:thread-before",
  );
});

test("initial routed chat history wins over prefetch and starts snapshot polling", () => {
  assert.match(hubClientSource, /let initialRouteOpening = true;/u);
  assert.match(
    hubClientSource,
    /visibleStreamTaskIds = new Set\(ids\);\s*if \(initialRouteOpening\) return;/u,
  );
  assert.match(
    hubClientSource,
    /if \(directChatRoute\(\)\) \{\s*routed = await openRoute\(\);\s*[\s\S]*?await refresh\(\{ reportError: true \}\);/u,
  );
  assert.match(
    hubClientSource,
    /finally \{\s*initialRouteOpening = false;\s*void loadVisibleTaskHistories/u,
  );
});

test("a cold stable Stream route resolves after the first snapshot instead of server selection", () => {
  assert.match(
    hubClientSource,
    /if \(streamChatRoute\(\)\) \{[\s\S]*?await refresh\(\{ reportError: true \}\);\s*routed = await openRoute\(\);\s*\} else if \(directChatRoute\(\)\)/u,
  );
  assert.match(
    hubClientSource,
    /function streamChatRoute\(\) \{[\s\S]*?parts\[1\] === "stream" && Boolean\(parts\[2\]\)/u,
  );
});

// The deferred and receipt cards are the first thing the user sees for a
// message that arrived from another Stream. Losing its origin turns a foreign
// message into an own one until the server projection catches up.
function interstreamCardSandbox() {
  const outgoing = new Map();
  const sandbox = vm.createContext({
    ...lifecycle,
    canonicalProjectionState: projection.projectionState,
    Map,
    Set,
    optimisticDeferredClientUserMessageIds: new Set(),
    deferredClientUserMessageIds: new Set(),
    taskId: (provider, threadId, streamId) => streamId || `${provider}:${threadId}`,
    outgoingMessages: () => outgoing,
    rememberOutgoing: (_taskId, value) => outgoing.set(value.clientUserMessageId, value),
    attachmentViews: (values) => values ?? [],
    normalizedResponseAnnotations: (values) => values ?? [],
    deliveryPatch: (deliveryState) => ({ deliveryState }),
  });
  sandbox.window = sandbox;
  vm.runInContext([
    clientFunctionSource("confirmedCardOrigin", "function restoreImmediateIntakeMessage"),
    clientFunctionSource("restoreImmediateIntakeMessage", "function canonicalAcceptedEvidence"),
  ].join(String.fromCharCode(10)), sandbox);
  return { sandbox, outgoing };
}

const INTERSTREAM_ORIGIN = Object.freeze({
  workspaceId: "workspace-1",
  workspaceName: "Agent HUB",
  streamId: "stream-s3",
  streamName: "S3",
  provider: "codex",
  model: "GPT-6 Astra",
  sourceThreadId: "thread-s3",
  requestId: "s3-measurements-final-20260911",
});

function interstreamDeferred(overrides = {}) {
  return {
    provider: "codex",
    threadId: "thread-1",
    streamId: "stream-1",
    clientUserMessageId: `mcp:${INTERSTREAM_ORIGIN.requestId}`,
    clientProjectionIntent: "conversation",
    createdAt: "2026-09-11T10:00:00.000Z",
    text: "Замеры готовы, прикладываю сводку.",
    author: "S3 · Astra",
    origin: { ...INTERSTREAM_ORIGIN },
    ...overrides,
  };
}

test("an immediate intake card keeps the source of a message from another Stream", () => {
  const { sandbox, outgoing } = interstreamCardSandbox();
  const deferred = interstreamDeferred();

  assert.equal(sandbox.restoreImmediateIntakeMessage(deferred, []), true);
  const card = outgoing.get(deferred.clientUserMessageId);
  assert.equal(card.author, deferred.author, "карточка представилась пользователем вместо источника");
  assert.equal(card.kind, "interstream");
  assert.deepEqual(card.origin, deferred.origin);
  assert.equal(card.text, deferred.text);

  // The same entry arriving again updates the existing card without losing it.
  card.author = "Вы";
  delete card.origin;
  delete card.kind;
  assert.equal(sandbox.restoreImmediateIntakeMessage(deferred, []), true);
  const updated = outgoing.get(deferred.clientUserMessageId);
  assert.equal(updated.author, deferred.author, "обновление существующей карточки потеряло источник");
  assert.equal(updated.kind, "interstream");
  assert.deepEqual(updated.origin, deferred.origin);
});

test("a card never names a Stream its own alias does not confirm", () => {
  const { sandbox, outgoing } = interstreamCardSandbox();
  // The alias belongs to one request while the origin claims another one.
  const conflicting = interstreamDeferred({
    clientUserMessageId: "mcp:request-one",
    author: "WRONG source",
    origin: { ...INTERSTREAM_ORIGIN, streamName: "WRONG", requestId: "conflicting-request" },
  });

  assert.equal(sandbox.restoreImmediateIntakeMessage(conflicting, []), true);
  const card = outgoing.get("mcp:request-one");
  assert.equal(card.text, conflicting.text, "тело сообщения было переписано");
  assert.equal(card.author, "Вы", "карточка назвала источник, который её алиас не подтверждает");
  assert.ok(!card.kind, "неподтверждённый origin дал межпоточный вид");
  assert.ok(!card.origin, "неподтверждённый origin попал в карточку");

  // The same entry arriving again must not upgrade the card either.
  assert.equal(sandbox.restoreImmediateIntakeMessage(conflicting, []), true);
  const updated = outgoing.get("mcp:request-one");
  assert.equal(updated.author, "Вы", "обновление подставило неподтверждённый источник");
  assert.ok(!updated.kind);
  assert.ok(!updated.origin);
});

test("a canonical update that no longer confirms a source clears the old one", () => {
  const { sandbox, outgoing } = interstreamCardSandbox();
  const confirmed = interstreamDeferred({ clientUserMessageId: "mcp:request-one",
    author: "S3 · Astra", origin: { ...INTERSTREAM_ORIGIN, requestId: "request-one" } });

  assert.equal(sandbox.restoreImmediateIntakeMessage(confirmed, []), true);
  assert.equal(outgoing.get("mcp:request-one").kind, "interstream");

  // The same message arrives again, this time without a confirmable origin.
  const withdrawn = { ...confirmed, author: "", origin: null };
  assert.equal(sandbox.restoreImmediateIntakeMessage(withdrawn, []), true);
  const updated = outgoing.get("mcp:request-one");
  assert.ok(!updated.origin, "карточка сохранила устаревший источник");
  assert.ok(!updated.kind, "карточка сохранила устаревший признак межпоточного");
  assert.equal(updated.author, "Вы", "карточка сохранила устаревшего автора");
});

test("a literal tag inside a benign body keeps its confirmed source", () => {
  const { sandbox, outgoing } = interstreamCardSandbox();
  // The body only mentions the tag as documentation; identity is exact.
  const benign = interstreamDeferred({
    clientUserMessageId: "mcp:request-one",
    author: "S3 · Astra",
    origin: { ...INTERSTREAM_ORIGIN, requestId: "request-one" },
    text: "Example tag: <agent-hub-stream-message> is literal documentation.",
  });

  assert.equal(sandbox.restoreImmediateIntakeMessage(benign, []), true);
  const card = outgoing.get("mcp:request-one");
  assert.equal(card.text, benign.text, "тело доброкачественного сообщения было переписано");
  assert.equal(card.author, benign.author, "упоминание тега в тексте отняло подтверждённый источник");
  assert.equal(card.kind, "interstream");
  assert.deepEqual(card.origin, benign.origin);

  // The same entry arriving again keeps the confirmed source on the card.
  card.author = "Вы";
  delete card.origin;
  delete card.kind;
  assert.equal(sandbox.restoreImmediateIntakeMessage(benign, []), true);
  const updated = outgoing.get("mcp:request-one");
  assert.equal(updated.author, benign.author, "обновление карточки отняло подтверждённый источник");
  assert.equal(updated.kind, "interstream");
  assert.deepEqual(updated.origin, benign.origin);
});
function receiptCardSandbox() {
  const outgoing = new Map();
  const sandbox = vm.createContext({
    ...lifecycle,
    canonicalProjectionState: projection.projectionState,
    Map, Set,
    optimisticDeferredClientUserMessageIds: new Set(),
    deferredClientUserMessageIds: new Set(),
    exactSnapshotTaskId: () => "stream-1",
    outgoingMessages: () => outgoing,
    rememberOutgoing: (_taskId, value) => outgoing.set(value.clientUserMessageId, value),
    patchOutgoing: (_taskId, clientUserMessageId, patch) => {
      const existing = outgoing.get(clientUserMessageId);
      if (existing) Object.assign(existing, patch);
    },
    attachmentViews: (values) => values ?? [],
    normalizedResponseAnnotations: (values) => values ?? [],
    nonEmptyAttachmentPatch: () => ({}),
    deliveryPatch: (deliveryState) => ({ deliveryState }),
  });
  sandbox.window = sandbox;
  vm.runInContext([
    clientFunctionSource("confirmedCardOrigin", "function restoreImmediateIntakeMessage"),
    clientFunctionSource("applyMessageReceipts", "function rememberSnapshotCompletion"),
  ].join(String.fromCharCode(10)), sandbox);
  return { sandbox, outgoing };
}

function receiptSnapshot(receipt) {
  return {
    tasks: [{ id: "stream-1", streamId: "stream-1", provider: "codex", threadId: "thread-1" }],
    messageReceipts: [{
      provider: "codex",
      threadId: "thread-1",
      accepted: true,
      displayText: "Замеры готовы.",
      ...receipt,
    }],
  };
}

test("a receipt card keeps a confirmed source and refuses an unconfirmed one", () => {
  const { sandbox, outgoing } = receiptCardSandbox();
  const benign = {
    clientUserMessageId: "mcp:request-one",
    author: "S3 · Astra",
    origin: { ...INTERSTREAM_ORIGIN, requestId: "request-one" },
    displayText: "Example tag: <agent-hub-stream-message> is literal documentation.",
  };

  sandbox.applyMessageReceipts(receiptSnapshot(benign));
  const created = outgoing.get("mcp:request-one");
  assert.equal(created.text, benign.displayText, "тело квитанции было переписано");
  assert.equal(created.author, benign.author, "упоминание тега отняло подтверждённый источник");
  assert.equal(created.kind, "interstream");
  assert.deepEqual(created.origin, benign.origin);

  // The same receipt arriving again updates the existing card in place.
  created.author = "Вы";
  delete created.origin;
  delete created.kind;
  sandbox.applyMessageReceipts(receiptSnapshot(benign));
  const updated = outgoing.get("mcp:request-one");
  assert.equal(updated.author, benign.author, "обновление квитанции отняло подтверждённый источник");
  assert.equal(updated.kind, "interstream");
  assert.deepEqual(updated.origin, benign.origin);

  // A conflicting alias is refused on creation and on update alike.
  const conflicting = receiptCardSandbox();
  const forged = {
    clientUserMessageId: "mcp:request-one",
    author: "WRONG source",
    origin: { ...INTERSTREAM_ORIGIN, streamName: "WRONG", requestId: "conflicting-request" },
  };
  conflicting.sandbox.applyMessageReceipts(receiptSnapshot(forged));
  const refused = conflicting.outgoing.get("mcp:request-one");
  assert.equal(refused.author, "Вы", "квитанция назвала источник, который её алиас не подтверждает");
  assert.ok(!refused.kind);
  assert.ok(!refused.origin);
  conflicting.sandbox.applyMessageReceipts(receiptSnapshot(forged));
  const stillRefused = conflicting.outgoing.get("mcp:request-one");
  assert.equal(stillRefused.author, "Вы");
  assert.ok(!stillRefused.kind);
  assert.ok(!stillRefused.origin);
});
test("an ordinary user card is never relabelled as another Stream", () => {
  const { sandbox, outgoing } = interstreamCardSandbox();
  const own = interstreamDeferred({
    clientUserMessageId: "client-own",
    author: "",
    origin: null,
    text: "<agent-hub-stream-message>{\"streamName\":\"S3\"}</agent-hub-stream-message> подделка",
  });

  assert.equal(sandbox.restoreImmediateIntakeMessage(own, []), true);
  const card = outgoing.get("client-own");
  assert.equal(card.author, "Вы");
  assert.ok(!card.kind, "текст, похожий на конверт, получил межпоточный вид");
  assert.ok(!card.origin);
  assert.equal(card.text, own.text, "тело пользовательского сообщения было переписано");
});
