import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopTaskHistoryFactory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { mergeActiveTaskHistory, mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";
import { launchBrowser, snapshot, submit, bridgeCalls, applyFixtureSnapshot } from "./composer-production.fixture.mjs";
import { openClientEventFixture } from "./client-event.fixture.mjs";

for (const count of [1, 35]) {
  test(`complete client retains the accepted live-only question across paged refresh (${count} durable turns)`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    const identity = { streamId: "stream-a", provider: "codex", threadId: "thread-a" };
    const startedAt = new Date(Date.now() - 1000).toISOString();
    const durable = Array.from({ length: count }, (_, i) => ({ id: `old-${i}`, completed: true, status: "completed",
      startedAt: new Date(Date.parse(startedAt) - (count-i)*60_000).toISOString(),
      messages: [{ role: "user", itemId: `old-user-${i}`, clientUserMessageId: `old-client-${i}`, text: `Question ${i}` }] }));
    let run = null;
    const reads = [];
    const backend = createDesktopTaskHistoryFactory({
      selection: { activeProvider: () => identity.provider, threadId: () => identity.threadId, chatId: () => 1 },
      catalog: { entries: () => [{ ...identity, title: "Active chat", projectRoot: "fixture" }] },
      historyReader: { readPage: async (_bindings, { before, limit }) => {
        reads.push({ before: before ?? null, limit });
        const end = before == null ? durable.length : Math.min(before, durable.length);
        const start = Math.max(0, end-limit);
        return { start, end, total: durable.length, messageTotal: durable.length,
          items: durable.slice(start,end).map(turn => ({ ...identity, turn: structuredClone(turn) })) };
      } },
      runs: { forTask: () => run },
      historyMerger: { mergeActive: mergeActiveTaskHistory, mergeCompleted: mergeCompletedTaskHistory },
      responseBudget: { fit: payload => payload },
    });
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
      const initial = snapshot();
      const errors = await openClientEventFixture(page, { surface: "web", fixtureSnapshot: initial,
        fixtureHistory: await backend({ ...identity, limit: 30 }) });
      await page.route("**/api/control", async route => {
        const request = route.request().postDataJSON();
        if (request.action !== "task-history" || request.params.streamId !== identity.streamId) return route.fallback();
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: await backend(request.params) }) });
      });
      await page.evaluate(() => { window.__agentHubFixture.mode = "accept"; });
      await submit(page, { text: "Accepted question" });
      await page.waitForFunction(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
        .some(request => request.action === "send-message"));
      const clientId = (await bridgeCalls(page,"send-message")).at(-1).params.clientUserMessageId;
      run = { ...identity, id: "run-active", turnId: "turn-active", operationKind: "user-turn", projectionState: "active",
        promptPreview: "Accepted question", responseText: "Unfinished answer", clientUserMessageId: clientId, startedAt,
        userMessages: [{ role: "user", itemId: "user-active", clientUserMessageId: clientId, text: "Accepted question", submittedAt: startedAt, time: startedAt }],
        responseItemId: "agent-active", providerStart: { state: "observed", turnId: "turn-active", acceptedAt: startedAt } };
      const active = structuredClone(initial);
      active.version = "accepted-active-question";
      active.tasks[0] = { ...active.tasks[0], running: true, run };
      await applyFixtureSnapshot(page, active);
      await page.evaluate(() => window.__dispatchClientFixture("task:select", { id: "stream-a" }));
      await page.waitForFunction(id => window.__clientProjectionFixture.messages["stream-a"]?.some(m => m.clientUserMessageId === id && m.projectionAuthority === "canonical"), clientId);
      if (count > 30) {
        await page.locator("[data-history-load]").evaluate(button => button.click());
        await page.waitForFunction(total => window.__clientProjectionFixture.messages["stream-a"]?.length === total, count+1);
      }
      const before = await page.evaluate(() => structuredClone(window.__clientProjectionFixture));
      const messages = before.messages["stream-a"];
      assert.equal(messages.length, count+1);
      assert.equal(messages.filter(m => m.clientUserMessageId === clientId).length, 1);
      assert.equal(messages.filter(m => m.clientUserMessageId === clientId)[0].projectionAuthority, "canonical",
        "accepted question no longer depends on its optimistic projection");
      assert.equal(messages.filter(m => m.role === "agent").length, 0);
      assert.equal(messages.filter(m => m.clientUserMessageId === "old-client-0").length, 1);
      await page.evaluate(() => window.__dispatchClientFixture("task:select", { id: "stream-a" }));
      const after = await page.evaluate(() => structuredClone(window.__clientProjectionFixture));
      assert.deepEqual(after.messages["stream-a"].map(m => m.clientUserMessageId), messages.map(m => m.clientUserMessageId));
      assert.equal(after.pagination["stream-a"].hasOlder, before.pagination["stream-a"].hasOlder);
      assert.equal(after.messages["stream-a"].filter(m => m.role === "agent").length, 0, "unfinished response remains on the live surface");
      assert.equal(await page.getByText("Accepted question", { exact: true }).count(), 1);
      if (count > 30) assert.ok(reads.some(read => read.before === count - 30 && read.limit === 30),
        `older button sends the exact cursor and bound through the real Desktop read factory: ${JSON.stringify(reads)}`);
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}

test("older page refuses a cursor crossing reply, then prepends the valid page without moving the reader", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  let page;
  const identity = { provider: "codex", threadId: "thread-a", streamId: "stream-a" };
  const turns = Array.from({ length: 40 }, (_, i) => ({ id: `old-${i}`, completed: true, status: "completed",
    messages: [{ role: "user", itemId: `user-${i}`, clientUserMessageId: `client-${i}`, text: `Question ${i} ${"visible history ".repeat(40)}` }] }));
  const history = { ...identity, start: 20, end: 40, total: 40, nextBefore: 20, messageTotal: 40, version: "all-forty", items: turns.slice(20) };
  const requests = [];
  try {
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = await openClientEventFixture(page, { surface: "web", fixtureHistory: history });
    await page.route("**/api/control", async route => {
      const request = route.request().postDataJSON();
      if (request.action !== "task-history" || request.params.streamId !== identity.streamId || request.params.before == null) return route.fallback();
      requests.push(request.params);
      const result = requests.length === 1
        ? { ...history, start: 20, end: 21, items: [{ id: "past-cursor", completed: true,
          messages: [{ role: "user", itemId: "bad-item", text: "Must not enter history" }] }] }
        : { ...history, start: 0, end: 20, nextBefore: null, items: turns.slice(0,20) };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result }) });
    });
    await page.locator('[data-stream-task-id="stream-a"]:visible').first().click();
    await page.waitForFunction(() => window.__clientProjectionFixture.messages["stream-a"]?.length === 20);
    const before = await page.evaluate(() => window.__clientProjectionFixture.messages["stream-a"].map(item => item.id));
    await page.evaluate(() => window.__dispatchClientFixture("history:load-older", { taskId: "stream-a" }));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].before, 20);
    assert.equal(requests[0].limit, 30);
    assert.deepEqual(await page.evaluate(() => window.__clientProjectionFixture.messages["stream-a"].map(item => item.id)), before);
    assert.equal(await page.getByText("Must not enter history", { exact: true }).count(), 0);
    await page.evaluate(() => { document.querySelector("[data-chat-pane] .chat-scroll").scrollTop = 200; });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const anchor = page.locator('[data-role="user"][data-turn-id="old-25"]');
    const top = await anchor.evaluate(node => node.getBoundingClientRect().top);
    await page.evaluate(() => window.__dispatchClientFixture("history:load-older", { taskId: "stream-a" }));
    await page.waitForFunction(() => window.__clientProjectionFixture.messages["stream-a"]?.length === 40);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(requests.length, 2);
    assert.equal(requests[1].before, 20);
    assert.equal(requests[1].limit, 30);
    assert.ok(Math.abs(await anchor.evaluate(node => node.getBoundingClientRect().top) - top) < 2, "the same retained message stays at the same reader offset");
    const after = await page.evaluate(() => window.__clientProjectionFixture.messages["stream-a"]);
    assert.deepEqual(after.slice(20).map(item => item.id), before);
    assert.equal(new Set(after.map(item => item.id)).size, 40);
    assert.deepEqual(errors, []);
  } finally { await page?.unrouteAll({ behavior: "wait" }); await browser.close(); }
});
