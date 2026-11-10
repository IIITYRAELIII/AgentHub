import assert from "node:assert/strict";
import test from "node:test";
import { createDesktopTaskHistoryFactory } from "../../src/interfaces/desktop/desktop-task-history.mjs";
import { mergeActiveTaskHistory, mergeCompletedTaskHistory } from "../../src/application/task-history.mjs";
import { launchBrowser, snapshot, submit, bridgeCalls, applyFixtureSnapshot } from "./composer-production.fixture.mjs";
import { openClientEventFixture } from "./client-event.fixture.mjs";

for (const count of [1, 25]) {
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
        fixtureHistory: await backend({ ...identity, limit: 20 }) });
      await page.route("**/api/control", async route => {
        const request = route.request().postDataJSON();
        if (request.action !== "task-history" || request.params.streamId !== identity.streamId) return route.fallback();
        return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result: await backend(request.params) }) });
      });
      await page.evaluate(() => { window.__agentHubFixture.mode = "accept"; });
      await submit(page, { text: "Accepted question" });
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
      if (count > 20) {
        await page.evaluate(() => window.__dispatchClientFixture("history:load-older", { taskId: "stream-a" }));
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
      if (count > 20) assert.ok(reads.some(read => read.before !== null), "older page goes through the real Desktop read factory");
      assert.deepEqual(errors, []);
    } finally { await browser.close(); }
  });
}
