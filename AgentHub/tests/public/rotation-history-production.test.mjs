import assert from "node:assert/strict";
import test from "node:test";
import { DesktopTaskService } from "../../src/interfaces/desktop/desktop-task-service.mjs";
import { clientPerformanceTraceSpans } from "../../src/application/client-performance-trace.mjs";
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot } from "./composer-production.fixture.mjs";

function turn(threadId, id, answer, completed = true) {
  return { id, provider: "codex", threadId, operationKind: "user-turn", completed,
    active: !completed, terminalRevision: completed ? 1 : 0,
    startedAt: "2026-10-09T22:00:00.000Z", completedAt: completed ? "2026-10-09T22:01:00.000Z" : null,
    messages: [{ role: "user", itemId: `${id}-user`, clientUserMessageId: `${id}-client`,
      turnUserSlot: "root", text: `${id} prompt` },
    ...(answer ? [{ role: "agent", itemId: `${id}-answer`, phase: "final_answer", text: answer }] : [])] };
}

async function setup(page) {
  const state = { snapshot: snapshot(), calls: [], turns: new Map(), held: null, traces: [], pages: new Map() };
  Object.assign(state.snapshot.tasks[0], { lastAnswerTurnId: "old-turn", lastAnswerRevision: 1,
    latestFinal: { provider: "codex", threadId: "thread-a", turnId: "old-turn", revision: 1 } });
  state.turns.set("thread-a", [turn("thread-a", "old-turn", "Yesterday answer")]);
  const service = new DesktopTaskService({
    catalog: () => state.snapshot.tasks,
    refreshCatalog: async () => state.snapshot.tasks,
    currentThread: (streamId) => state.snapshot.tasks.filter((entry) => entry.streamId === streamId)
      .sort((a, b) => b.threadPosition - a.threadPosition)[0],
    threadsForStream: (streamId) => state.snapshot.tasks.filter((entry) => entry.streamId === streamId),
    activateBinding: async () => ({ changed: true }), snapshot: async () => state.snapshot,
    commandTaskTarget: (value) => value, samePath: (a, b) => a === b, chatId: () => null,
    readTurn: async ({ threadId, turnId }) => ({ taskThreadId: threadId, projectRoot: undefined,
      body: state.turns.get(threadId)?.find((entry) => entry.id === turnId)?.messages.at(-1)?.text }),
    dispatchCommand: (_kind, params) => service.select(params),
    taskHistory: async (params) => {
      state.calls.push({ kind: "history", ...params });
      const forced = state.pages.get(`${params.threadId}:${params.before ?? "latest"}`);
      const items = structuredClone(forced?.items ?? state.turns.get(params.threadId) ?? []);
      if (state.held) { const held = state.held; state.held = null; held.started(); await held.promise; }
      return { ...params, items, start: 0, end: items.length, total: items.length,
        messageTotal: items.reduce((n, item) => n + item.messages.length, 0), nextBefore: null,
        sourceFresh: true, version: JSON.stringify(items.map((item) => [item.id, item.completed])), ...forced };
    },
  });
  const diagnostics = await openFixture(page, { fixtureSnapshot: state.snapshot });
  await page.route("**/api/command-trace/client-events", async (route) => {
    state.traces.push(...clientPerformanceTraceSpans(route.request().postDataJSON()));
    await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
  });
  await page.exposeFunction("rotationDesktopControl", async (message) => {
    state.calls.push({ kind: message.action, ...message.params });
    try {
      const result = message.action === "open-task" ? await service.openTask(message.params)
        : message.action === "open-turn" ? await service.openTurn(message.params)
        : await service.taskHistory(message.params);
      return { type: "agenthub:control-result", id: message.id, ok: true, result };
    } catch (error) { return { type: "agenthub:control-result", id: message.id, ok: false, error: error.message }; }
  });
  await page.evaluate(() => {
    const original = window.__agentHubVscode.postMessage;
    window.__agentHubVscode.postMessage = (message) => {
      if (!["open-task", "open-turn", "task-history"].includes(message.action)) return original(message);
      void window.rotationDesktopControl(message).then((data) => {
        window.dispatchEvent(new MessageEvent("message", { data }));
        window.__rotationResponses ??= [];
        window.__rotationResponses.push(message.action);
      });
    };
  });
  await page.locator('.stream-tab[data-stream-task-id="stream-b"]').click();
  await page.waitForFunction(() => document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "stream-b");
  await page.locator('.stream-tab[data-stream-task-id="stream-a"]').click();
  await page.getByText("Yesterday answer", { exact: true }).waitFor();
  return { state, diagnostics, async advance(next) { state.snapshot = next; await applyFixtureSnapshot(page, next); } };
}

// Hold only the target diagnostic's existing RAF chain. Production history,
// rendering, navigation and the trace implementation remain executable.
async function holdTerminalPaint(page) {
  await page.addInitScript(() => {
    const nativeFrame = window.requestAnimationFrame.bind(window);
    const frames = [];
    let installed;
    let armed = true;
    const capture = (callback) => { frames.push(callback); return -frames.length; };
    Object.defineProperty(window, "AgentHubCommandTrace", {
      configurable: true, get: () => installed,
      set: (trace) => {
        installed = { ...trace, afterPaint(...args) {
          if (!armed || args[1] !== "history-terminal-paint" || args[3] !== "new-turn-client"
            || args[4]?.terminalRevision !== 1) return trace.afterPaint(...args);
          armed = false;
          window.requestAnimationFrame = capture;
          try { return trace.afterPaint(...args); }
          finally { window.requestAnimationFrame = nativeFrame; }
        } };
      },
    });
    window.__releaseTerminalPaint = async () => {
      while (frames.length) {
        await new Promise((resolve) => nativeFrame(resolve));
        const callback = frames.shift();
        window.requestAnimationFrame = capture;
        try { callback(performance.now()); }
        finally { window.requestAnimationFrame = nativeFrame; }
      }
    };
    window.__terminalPaintHeld = () => frames.length > 0;
  });
}

for (const destination of ["unchanged", "stream", "dashboard", "historical", "revision"]) {
  test(`terminal paint completion revalidates owner: ${destination}`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser(); const page = await browser.newPage();
    try {
      await holdTerminalPaint(page);
      const { state, advance, diagnostics } = await setup(page);
      const old = state.snapshot.tasks[0];
      const head = { ...old, selected: false, threadId: "thread-new", threadPosition: 2,
        lastAnswerTurnId: "new-turn", lastAnswerRevision: 1,
        latestFinal: { provider: "codex", threadId: "thread-new", turnId: "new-turn", revision: 1 } };
      state.turns.set("thread-new", [turn("thread-new", "new-turn", "Held terminal answer")]);
      await advance({ ...state.snapshot, version: "paint-new-head", tasks: [old, head, state.snapshot.tasks[1]] });
      await page.getByText("Held terminal answer", { exact: true }).waitFor();
      await page.waitForFunction(() => window.__terminalPaintHeld());
      const drain = () => page.evaluate(async () => {
        while (window.AgentHubCommandTrace.diagnostics().pending) await window.AgentHubCommandTrace.flush();
      });
      await drain();
      const started = state.traces.find((span) => span.commandId === "new-turn-client"
        && span.metadata.action === "history-terminal-paint" && span.outcome === "started");
      assert.ok(started);
      if (destination === "stream") {
        await page.locator('.stream-tab[data-stream-task-id="stream-b"]').click();
        await page.waitForFunction(() => document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "stream-b");
      } else if (destination === "dashboard") {
        await page.locator('[data-view-button="dashboard"]').click();
        await page.waitForFunction(() => document.documentElement.dataset.view === "dashboard");
      } else if (destination === "historical") {
        state.turns.get("thread-new").unshift(turn("thread-new", "earlier-new", "Same Stream historical answer"));
        await page.evaluate(() => { location.hash = "#/chat/codex/thread-new/turn/thread-new/earlier-new"; });
        await page.getByText("Same Stream historical answer", { exact: true }).waitFor();
        await page.waitForFunction(() => window.__rotationResponses?.includes("open-turn"));
      } else if (destination === "revision") {
        const revised = { ...turn("thread-new", "new-turn", "Revised terminal answer"), terminalRevision: 2 };
        state.turns.set("thread-new", [revised]);
        await advance({ ...state.snapshot, version: "paint-new-revision", tasks: [old,
          { ...head, lastAnswerRevision: 2, latestFinal: { ...head.latestFinal, revision: 2 } }, state.snapshot.tasks[2]] });
        await page.getByText("Revised terminal answer", { exact: true }).waitFor();
      }
      assert.equal(await page.evaluate(() => document.hidden), false);
      await page.evaluate(() => window.__releaseTerminalPaint());
      await drain();
      const paired = state.traces.filter((span) => span.metadata.operationSpanId === started.metadata.operationSpanId);
      assert.deepEqual(paired.map((span) => span.outcome), ["started", destination === "unchanged" ? "succeeded" : "cancelled"]);
      assert.equal(paired[1].commandId, "new-turn-client");
      assert.equal(paired[1].metadata.terminalRevision, 1);
      if (destination !== "unchanged") assert.equal(paired[1].metadata.failureKind, "superseded");
      assert.deepEqual(diagnostics, []);
    } finally { await page.close(); await browser.close(); }
  });
}

for (const oldFirst of [true, false]) test(`production Desktop → representative → history → DOM follows rotation (${oldFirst ? "old-first" : "new-first"})`, { timeout: 30_000 }, async (context) => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const { state, diagnostics, advance } = await setup(page);
    const old = state.snapshot.tasks[0];
    const head = { ...old, selected: false, threadId: "thread-new", threadPosition: 2,
      lastAnswerAt: null, running: true, run: { turnId: "new-turn", clientUserMessageId: "new-turn-client",
        executionOwner: "hub", operationKind: "user-turn", projectionState: "active",
        startedAt: "2026-10-09T22:00:00.000Z", prompt: "new-turn prompt" } };
    const active = { ...state.snapshot, version: "rotated-running", tasks: oldFirst
      ? [old, head, state.snapshot.tasks[1]] : [head, old, state.snapshot.tasks[1]] };
    state.turns.set("thread-new", [turn("thread-new", "new-turn", "", false)]);
    await advance(active);
    await page.waitForFunction(() => document.querySelector('.stream-tab[data-stream-task-id="stream-a"]')?.dataset.state === "running");
    await page.getByText("new-turn prompt", { exact: true }).waitFor();
    assert.ok(state.calls.some((call) => call.kind === "task-history" && call.threadId === "thread-new"));
    state.turns.set("thread-new", [turn("thread-new", "new-turn", "Fresh rotated answer")]);
    const done = { ...head, running: false, run: null, lastAnswerTurnId: "new-turn",
      lastAnswerAt: "2026-10-09T22:01:00.000Z", lastAnswerRevision: 1,
      latestFinal: { provider: "codex", threadId: "thread-new", turnId: "new-turn", revision: 1 } };
    await advance({ ...active, version: "rotated-completed", tasks: active.tasks.map((item) => item.threadId === "thread-new" ? done : item) });
    await page.getByText("Fresh rotated answer", { exact: true }).waitFor();
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(async () => {
      while (window.AgentHubCommandTrace.diagnostics().pending) await window.AgentHubCommandTrace.flush();
    });
    const correlated = state.traces.filter((span) => span.commandId === "new-turn-client");
    const retrieval = correlated.find((span) => span.metadata.action === "history-retrieved");
    const paint = correlated.find((span) => span.metadata.action === "history-terminal-paint" && span.outcome === "succeeded");
    assert.ok(retrieval, "history retrieval must join the original durable client identity");
    assert.ok(paint, "selected terminal DOM must reach a separate paint opportunity");
    assert.equal(paint.metadata.threadId, "thread-new");
    assert.equal(paint.metadata.turnId, "new-turn");
    assert.equal(paint.metadata.terminalRevision, 1);
    assert.ok(paint.observedAtMs >= retrieval.observedAtMs);
    context.diagnostic(`history retrieval→paint opportunity ${paint.observedAtMs - retrieval.observedAtMs}ms; client projection→paint ${paint.monotonicDurationMs.toFixed(1)}ms (isolated Edge fixture, not production latency)`);
    assert.equal(JSON.stringify(correlated).includes("Fresh rotated answer"), false);
    const acknowledgements = await page.evaluate(() => window.__agentHubFixture.log
      .filter((entry) => entry.action === "mark-task-read").map((entry) => entry.params.final));
    assert.ok(acknowledgements.some((final) => final.threadId === "thread-new" && final.turnId === "new-turn"),
      "rendered head final, not first historical catalog entry, owns read acknowledgement");
    if (oldFirst && process.env.HUB301_QA_SCREENSHOT) await page.screenshot({ path: process.env.HUB301_QA_SCREENSHOT });
    assert.equal(await page.getByText("new-turn prompt", { exact: true }).count(), 1);
    assert.equal(new URL(page.url()).hash, "#/chat/stream/stream-a");
    await page.locator('.stream-tab[data-stream-task-id="stream-b"]').click();
    await page.waitForFunction(() => document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "stream-b");
    await page.locator('.stream-tab[data-stream-task-id="stream-a"]').click();
    await page.getByText("Fresh rotated answer", { exact: true }).waitFor();
    assert.equal(await page.getByText("Fresh rotated answer", { exact: true }).count(), 1);
    assert.equal(state.calls.filter((call) => call.kind === "open-task" && call.streamId === "stream-a").at(-1).threadId, "thread-new");
    assert.deepEqual(diagnostics, []);
  } finally { await page.close(); await browser.close(); }
});

test("historical pagination uses its exact page binding, not the live Stream head", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser(); const page = await browser.newPage();
  try {
    const { state, advance, diagnostics } = await setup(page);
    const old = state.snapshot.tasks[0];
    const head = { ...old, selected: false, threadId: "thread-new", threadPosition: 2 };
    await advance({ ...state.snapshot, version: "pagination-head", tasks: [old, head, state.snapshot.tasks[1]] });
    state.pages.set("thread-a:latest", { items: [turn("thread-a", "old-turn", "Yesterday answer")],
      start: 1, end: 2, total: 2, nextBefore: 1 });
    state.pages.set("thread-a:1", { items: [turn("thread-a", "earlier-turn", "Earlier historical answer")],
      start: 0, end: 1, total: 2, nextBefore: null });
    await page.evaluate(() => { location.hash = "#/chat/codex/thread-a/turn/thread-a/old-turn"; });
    await page.waitForFunction(() => window.__rotationResponses?.includes("open-turn"));
    // The production history owner automatically fills this short viewport
    // through the same history:load-older path as its visible load button.
    await page.getByText("Earlier historical answer", { exact: true }).waitFor();
    assert.equal(state.calls.filter((entry) => entry.kind === "task-history").at(-1).threadId, "thread-a");
    assert.equal(await page.getByText("Yesterday answer", { exact: true }).count(), 1);
    assert.deepEqual(diagnostics, []);
  } finally { await page.close(); await browser.close(); }
});

test("explicit historical turn remains bound while the live head completes", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser(); const page = await browser.newPage();
  try {
    const { state, diagnostics, advance } = await setup(page);
    const old = state.snapshot.tasks[0];
    const head = { ...old, threadId: "thread-new", threadPosition: 2, selected: false };
    await advance({ ...state.snapshot, version: "historical-head", tasks: [old, head, state.snapshot.tasks[1]] });
    await page.evaluate(() => { location.hash = "#/chat/codex/thread-a/turn/thread-a/old-turn"; });
    await page.waitForFunction(() => window.__rotationResponses?.includes("open-turn"));
    await page.getByText("Yesterday answer", { exact: true }).waitFor();
    const before = state.calls.filter((call) => call.kind === "task-history").length;
    state.turns.set("thread-new", [turn("thread-new", "new-turn", "Live answer while browsing history")]);
    await advance({ ...state.snapshot, version: "head-new-final", tasks: [old, { ...head,
      lastAnswerAt: "2026-10-09T22:01:00.000Z", lastAnswerTurnId: "new-turn", lastAnswerRevision: 1,
      latestFinal: { provider: "codex", threadId: "thread-new", turnId: "new-turn", revision: 1 } }, state.snapshot.tasks[2]] });
    await page.waitForFunction(() => document.querySelector('.stream-tab[data-stream-task-id="stream-a"]')?.dataset.state === "idle");
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.getByText("Yesterday answer", { exact: true }).count(), 1);
    assert.equal(state.calls.filter((call) => call.kind === "task-history").length, before);
    assert.equal(new URL(page.url()).hash, "#/chat/codex/thread-a/turn/thread-a/old-turn");
    assert.deepEqual(diagnostics, []);
  } finally { await page.close(); await browser.close(); }
});

test("history response held across rotation cannot replace the new binding", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser(); const page = await browser.newPage();
  try {
    const { state, advance, diagnostics } = await setup(page);
    const started = Promise.withResolvers(); const release = Promise.withResolvers();
    state.held = { started: started.resolve, promise: release.promise };
    const old = { ...state.snapshot.tasks[0], lastAnswerTurnId: "old-turn", lastAnswerRevision: 2 };
    await advance({ ...state.snapshot, version: "old-history-request", tasks: [old, state.snapshot.tasks[1]] });
    await started.promise;
    state.turns.set("thread-new", [turn("thread-new", "new-turn", "New binding after held history")]);
    const head = { ...old, selected: false, threadId: "thread-new", threadPosition: 2,
      lastAnswerTurnId: "new-turn", lastAnswerRevision: 1 };
    await advance({ ...state.snapshot, version: "new-binding", tasks: [old, head, state.snapshot.tasks[1]] });
    release.resolve();
    await page.getByText("New binding after held history", { exact: true }).waitFor();
    assert.equal(await page.getByText("Yesterday answer", { exact: true }).count(), 0);
    assert.equal(await page.getByText("new-turn prompt", { exact: true }).count(), 1);
    assert.deepEqual(diagnostics, []);
  } finally { await page.close(); await browser.close(); }
});

test("an already in-flight head history cannot replace an explicit historical turn", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser(); const page = await browser.newPage();
  try {
    const { state, advance, diagnostics } = await setup(page);
    const started = Promise.withResolvers(); const release = Promise.withResolvers();
    state.held = { started: started.resolve, promise: release.promise };
    state.turns.set("thread-new", [turn("thread-new", "new-turn", "Head answer from pending read")]);
    const old = state.snapshot.tasks[0];
    const head = { ...old, selected: false, threadId: "thread-new", threadPosition: 2, lastAnswerTurnId: "new-turn" };
    await advance({ ...state.snapshot, version: "held-head", tasks: [old, head, state.snapshot.tasks[1]] });
    await started.promise;
    await page.evaluate(() => { location.hash = "#/chat/codex/thread-a/turn/thread-a/old-turn"; });
    await page.waitForFunction(() => window.__rotationResponses?.includes("open-turn"));
    release.resolve();
    await page.waitForFunction(() => window.__rotationResponses?.filter((action) => action === "task-history").length >= 2);
    assert.equal(await page.getByText("Yesterday answer", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Head answer from pending read", { exact: true }).count(), 0);
    assert.deepEqual(diagnostics, []);
  } finally { await page.close(); await browser.close(); }
});
