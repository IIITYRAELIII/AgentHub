import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { launchBrowser, snapshot, submit, bridgeCalls, applyFixtureSnapshot } from "./composer-production.fixture.mjs";
import { openClientEventFixture } from "./client-event.fixture.mjs";

const identity = { provider: "codex", threadId: "thread-a", streamId: "stream-a" };
const previousTurn = "01a209c2-ea7c-78f0-ba34-1c95377dc758";
const nextTurn = "01a209c8-b840-72a1-baa6-f72f668c91e3";
const submittedAt = "2026-11-23T19:00:16.313Z";
const completedAt = "2026-11-23T19:01:05.613Z";
const startedAt = "2026-11-23T19:01:13.299Z";
const finalText = "Previous final";
const sentText = "Queued input accepted in next turn";
const previousRoot = { role: "user", itemId: "previous-root", clientUserMessageId: "previous-client",
  text: "Previous root", turnUserSlot: "root", submittedAt: "2026-11-23T18:59:01.000Z" };
const previousSteer = { role: "user", itemId: "previous-steer", clientUserMessageId: "steer-original",
  text: "Same-turn clarification", turnUserSlot: "steer", author: "Reviewer",
  submittedAt: "2026-11-23T19:00:41.000Z" };
const imageUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==";
const attachments = ["first.png", "second.png"].map((name) => ({
  id: name, name, type: "image/png", url: imageUrl, thumbnailUrl: imageUrl,
}));
const previousTurnHistory = { id: previousTurn, completed: true, status: "completed", terminalRevision: 1,
  startedAt: "2026-11-23T18:59:02.000Z", completedAt, messages: [previousRoot, previousSteer,
    { role: "agent", itemId: previousTurn + ":rollout-agent:final", text: finalText, phase: "final", time: null }] };

function history(version, items) {
  return { ...identity, version, start: 0, end: items.length, total: items.length,
    messageTotal: items.reduce((count, item) => count + item.messages.length, 0), nextBefore: null, items };
}

async function readHistory(page, value) {
  await page.evaluate((next) => {
    window.__agentHubFixture.history = next;
    location.hash = "#/chat/codex/thread-a";
  }, value);
  const lastTurn = value.items.at(-1).id;
  await page.waitForFunction((id) => window.__clientProjectionFixture.messages["stream-a"]?.some(
    (message) => message.turnId === id && Number.isFinite(message.historyOrder)), lastTurn);
}

async function assertOrder(page, clientId, label) {
  const selector = '[data-chat-pane] [data-turn-id][data-role]';
  const visible = await page.locator(selector).evaluateAll((nodes) => nodes.map((node) => [
    node.dataset.turnId, node.dataset.role, node.querySelector(".msg-body")?.textContent.trim(),
  ]));
  const finalIndex = visible.findIndex((row) => row[0] === previousTurn && row[1] === "agent" && row[2] === finalText);
  const nextIndex = visible.findIndex((row) => row[0] === nextTurn && row[1] === "user" && row[2] === sentText);
  assert.ok(finalIndex >= 0 && nextIndex >= 0, JSON.stringify({ label, visible }));
  if (process.env.HUB523_QA_DIR) {
    await page.screenshot({ path: path.join(process.env.HUB523_QA_DIR, label + ".png") });
  }
  assert.ok(finalIndex < nextIndex, JSON.stringify({ label, visible }));
  const steerIndex = visible.findIndex((row) => row[0] === previousTurn && row[2] === previousSteer.text);
  assert.ok(steerIndex > 0 && steerIndex < finalIndex, label);
  const models = await page.evaluate(() => window.__clientProjectionFixture.messages["stream-a"]);
  const matching = models.filter((message) => message.clientUserMessageId === clientId);
  assert.equal(matching.length, 1, label);
  assert.equal(matching[0].time, submittedAt, label);
  assert.equal(matching[0].submittedAt, submittedAt, label);
  assert.deepEqual(matching[0].attachments.map((attachment) => attachment.name), ["first.png", "second.png"]);
  const steer = models.find((message) => message.clientUserMessageId === previousSteer.clientUserMessageId);
  assert.equal(steer?.author, previousSteer.author, label);
  assert.equal(steer?.time, previousSteer.submittedAt, label);
}

for (const first of ["snapshot", "history"]) {
  test("previous final precedes accepted next input with " + first + " first", { timeout: 45_000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, timezoneId: "UTC" });
    try {
      await page.clock.setFixedTime(submittedAt);
      const live = snapshot();
      live.tasks[0] = { ...live.tasks[0], running: true, run: {
        id: "previous-run", turnId: previousTurn, clientUserMessageId: previousRoot.clientUserMessageId,
        operationKind: "user-turn", projectionState: "active",
        submittedAt: previousRoot.submittedAt, prompt: previousRoot.text,
        response: finalText, responsePhase: "final", userMessages: [previousRoot, previousSteer],
        providerStart: { state: "observed", turnId: previousTurn, acceptedAt: previousTurnHistory.startedAt },
      } };
      const errors = await openClientEventFixture(page, { surface: "web", fixtureSnapshot: live,
        fixtureHistory: history("no-terminal-yet", []) });
      await page.waitForFunction((id) => window.__clientProjectionFixture.live["stream-a"]?.turnId === id, previousTurn);
      await page.evaluate(() => {
        const bridge = window.__fixtureBridge;
        const before = bridge.postMessage.bind(bridge);
        bridge.postMessage = (request) => {
          if (request.action !== "send-message") return before(request);
          const { provider, threadId, streamId, clientUserMessageId } = request.params;
          const record = window.__agentHubFixture.log;
          record.push(request);
          localStorage.setItem("fixture:bridge-log", JSON.stringify(record));
          window.dispatchEvent(new MessageEvent("message", { data: {
            type: "agenthub:control-result", id: request.id, ok: true,
            result: { provider, threadId, streamId, clientUserMessageId, id: "queue-original",
              accepted: true, providerAccepted: false, deferred: true, queued: true,
              reason: "task-running", clientProjectionIntent: "queue" },
          } }));
        };
      });
      await submit(page, { text: sentText });
      await page.locator('[data-queue-id]').filter({ hasText: sentText }).waitFor({ state: "visible" });
      const sends = await bridgeCalls(page, "send-message");
      assert.equal(sends.length, 1);
      assert.equal(sends[0].params.followUpMode, "queue");
      const clientId = sends[0].params.clientUserMessageId;

      const nowAccepted = structuredClone(live);
      nowAccepted.version = "next-provider-accepted";
      nowAccepted.tasks[0] = { ...nowAccepted.tasks[0], running: true, lastAnswer: finalText,
        lastAnswerAt: completedAt, lastAnswerTurnId: previousTurn, lastAnswerRevision: 1,
        run: { id: "next-run", turnId: nextTurn, operationKind: "user-turn", projectionState: "active",
          clientUserMessageId: clientId, prompt: sentText, startedAt, submittedAt, attachments,
          providerStart: { state: "observed", turnId: nextTurn, acceptedAt: startedAt },
        },
      };
      nowAccepted.messageReceipts = [{ ...identity, clientUserMessageId: clientId, id: "queue-original",
        turnId: nextTurn, runId: "next-run", accepted: true, providerAccepted: true, queued: false,
        submittedAt, startedAt, displayText: sentText, attachments }];
      if (first === "history") {
        await readHistory(page, history("previous-durable", [previousTurnHistory]));
        await page.waitForFunction((id) => window.__clientProjectionFixture.messages["stream-a"]?.some(
          (message) => message.turnId === id && message.role === "agent" && Number.isFinite(message.historyOrder)), previousTurn);
      }
      await applyFixtureSnapshot(page, nowAccepted);
      await page.waitForFunction((id) => window.__clientProjectionFixture.live["stream-a"]?.turnId === id, nextTurn);
      await page.locator('[data-chat-pane] [data-turn-id="' + previousTurn + '"][data-role="agent"]').waitFor({ state: "attached" });
      await page.locator('[data-chat-pane] [data-turn-id="' + nextTurn + '"][data-role="user"]').waitFor({ state: "attached" });
      const mixedEvidence = await page.evaluate((id) => window.__clientProjectionFixture.messages["stream-a"]
        .find((message) => message.turnId === id && message.role === "agent")?.historyOrder, previousTurn);
      assert.equal(Number.isFinite(mixedEvidence), first === "history");
      await assertOrder(page, clientId, first + "-mixed");
      assert.equal(await page.locator('[data-queue-id]').filter({ hasText: sentText }).count(), 0);

      const persisted = history("both-exact-turns", [previousTurnHistory,
        { id: nextTurn, active: true, status: "inProgress", startedAt, messages: [
          { role: "user", itemId: "next-root", clientUserMessageId: clientId, text: sentText,
            turnUserSlot: "root", time: submittedAt, submittedAt, attachments }] }]);
      await readHistory(page, persisted);
      await assertOrder(page, clientId, first + "-durable");
      await page.evaluate((next) => {
        window.AgentHub.setConnection("connecting");
        window.__agentHubFixture.snapshot = next;
        return window.__dispatchClientFixture("connection:retry");
      }, { ...nowAccepted, version: "reconnected" });
      await page.waitForFunction(() => window.__clientAppliedVersion === "reconnected");
      await assertOrder(page, clientId, first + "-reconnect");
      await page.evaluate((model) => {
        localStorage.setItem("fixture:snapshot", JSON.stringify(model));
      }, nowAccepted);
      await page.reload({ waitUntil: "load" });
      await readHistory(page, persisted);
      await page.locator('[data-chat-pane] [data-turn-id="' + nextTurn + '"][data-role="user"]').waitFor({ state: "attached" });
      await assertOrder(page, clientId, first + "-reload");
      assert.equal((await bridgeCalls(page, "send-message")).length, 1);
      assert.deepEqual(errors, []);
      assert.equal(await page.evaluate(() => window.__clientProjectionFixture.toasts.some(
        (message) => message.includes("не ту страницу истории"))), false);
    } finally { await browser.close(); }
  });
}

for (const priorStart of [previousTurnHistory.startedAt, completedAt]) {
  test(`a completed successor stays below the durable turn with start ${priorStart}`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, timezoneId: "UTC" });
    const successor = "01a209c2-ea7c-7000-8000-000000000001";
    assert.ok(successor < previousTurn);
    const originalId = "38181ce8-1621-40c0-9a4f-8340b20b4765";
    try {
      await page.clock.setFixedTime(completedAt);
      const initial = snapshot();
      const prior = history("prior-durable", [{ ...previousTurnHistory, startedAt: priorStart }]);
      const errors = await openClientEventFixture(page, { surface: "web", fixtureSnapshot: initial, fixtureHistory: prior });
      await readHistory(page, prior);
      const next = structuredClone(initial);
      next.version = "equal-boundary-terminal-overlay";
      next.tasks[0] = { ...next.tasks[0], lastAnswer: "Next terminal overlay", lastAnswerAt: completedAt,
        lastAnswerTurnId: successor, lastAnswerRevision: 1 };
      next.messageReceipts = [{ ...identity, clientUserMessageId: originalId, id: "retained-outgoing",
        turnId: successor, runId: "successor-run", accepted: true, providerAccepted: true,
        submittedAt, startedAt: completedAt, completed: true, completedAt, displayText: sentText }];
      await page.evaluate((value) => {
        window.__agentHubFixture.snapshot = value;
        return window.__dispatchClientFixture("connection:retry");
      }, next);
      await page.getByText("Next terminal overlay", { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
      const rows = await page.locator('[data-chat-pane] [data-turn-id][data-role]').evaluateAll((nodes) => nodes.map(
        (node) => [node.dataset.turnId, node.dataset.role]));
      assert.deepEqual(rows, [[previousTurn, "user"], [previousTurn, "user"], [previousTurn, "agent"],
        [successor, "user"], [successor, "agent"]]);
      const root = await page.evaluate((id) => window.__clientProjectionFixture.messages["stream-a"].find(
        (message) => message.clientUserMessageId === id), originalId);
      assert.equal(root.submittedAt, submittedAt);
      assert.equal(root.time, submittedAt);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

test("a page for the later equal-time turn preserves the preceding snapshot final", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  const priorTurn = "01a209c2-ea7c-7000-8000-000000000001";
  const priorReceipt = { ...identity, clientUserMessageId: previousRoot.clientUserMessageId,
    id: "previous-outgoing", runId: "previous-run", turnId: priorTurn,
    accepted: true, providerAccepted: true, submittedAt: previousRoot.submittedAt,
    startedAt: completedAt, completed: true, completedAt, displayText: previousRoot.text };
  const nextReceipt = { ...priorReceipt, clientUserMessageId: "next-outgoing", id: "next-intake",
    runId: "next-run", turnId: previousTurn, submittedAt, displayText: sentText };
  const nextFinal = "Next terminal overlay";
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, timezoneId: "UTC" });
    const initial = snapshot();
    initial.version = "previous-terminal-only";
    initial.messageReceipts = [priorReceipt];
    initial.tasks[0] = { ...initial.tasks[0], lastAnswer: finalText, lastAnswerAt: completedAt,
      lastAnswerTurnId: priorTurn, lastAnswerRevision: 1 };
    const errors = await openClientEventFixture(page, { surface: "web", fixtureSnapshot: initial,
      fixtureHistory: history("empty", []) });
    await page.getByText(finalText, { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    const next = structuredClone(initial);
    next.version = "both-terminals-before-history";
    next.messageReceipts.push(nextReceipt);
    next.tasks[0] = { ...next.tasks[0], lastAnswer: nextFinal, lastAnswerTurnId: previousTurn };
    await page.evaluate((value) => {
      window.__agentHubFixture.snapshot = value;
      return window.__dispatchClientFixture("connection:retry");
    }, next);
    await page.getByText(nextFinal, { exact: true }).waitFor({ state: "visible", timeout: 5_000 });
    const expected = [[priorTurn, "user"], [priorTurn, "agent"], [previousTurn, "user"], [previousTurn, "agent"]];
    const visibleTurns = () => page.locator('[data-chat-pane] [data-turn-id][data-role]').evaluateAll(
      (nodes) => nodes.map((node) => [node.dataset.turnId, node.dataset.role]));
    assert.deepEqual(await visibleTurns(), expected);

    const nextHistory = { id: previousTurn, status: "completed", completed: true, terminalRevision: 1,
      startedAt: completedAt, completedAt, messages: [
        { role: "user", itemId: "next-root", clientUserMessageId: nextReceipt.clientUserMessageId,
          turnUserSlot: "root", text: sentText, submittedAt },
        { role: "agent", itemId: "next-final", phase: "final", text: nextFinal, time: completedAt },
      ] };
    await readHistory(page, { ...history("next-history-only", [nextHistory]),
      start: 1, end: 2, total: 2, nextBefore: 1 });
    assert.deepEqual(await visibleTurns(), expected);
    assert.deepEqual(await page.evaluate(() => window.__clientProjectionFixture.messages["stream-a"]
      .filter((message) => message.role === "user").map((message) => message.submittedAt)),
    [previousRoot.submittedAt, submittedAt]);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
