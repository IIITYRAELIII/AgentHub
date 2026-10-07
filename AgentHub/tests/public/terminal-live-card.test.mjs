import assert from "node:assert/strict";
import test from "node:test";
import { applyFixtureSnapshot, launchBrowser, openFixture, snapshot } from "./composer-production.fixture.mjs";

function activeSnapshot(version, turnId = "turn-finished") {
  const value = snapshot();
  value.version = version;
  value.tasks[0] = { ...value.tasks[0], running: true, run: {
    turnId, clientUserMessageId: `client-${turnId}`,
    operationKind: "user-turn", projectionState: "active", stage: "working",
    startedAt: new Date(Date.now() - 180_000).toISOString(),
    userMessages: [{ role: "user", itemId: `user-${turnId}`,
      clientUserMessageId: `client-${turnId}`, text: "Question" }],
  } };
  return value;
}

const finalHistory = {
  provider: "codex", threadId: "thread-a", streamId: "stream-a",
  version: "durable-final", start: 0, end: 1, total: 1, messageTotal: 2,
  items: [{ id: "turn-finished", completed: true, terminalRevision: 3,
    messages: [
      { role: "user", itemId: "user-turn-finished", text: "Question",
        clientUserMessageId: "client-turn-finished" },
      { role: "agent", itemId: "answer-turn-finished", phase: "final", text: "Full final answer" },
    ] }],
};

async function afterPaint(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

test("durable exact history absorbs a late active snapshot, while the next real turn remains active", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pendingHistory = structuredClone(finalHistory);
    pendingHistory.version = "active-history";
    pendingHistory.items[0] = { id: "turn-finished", active: true, completed: false,
      messages: [finalHistory.items[0].messages[0]] };
    const errors = await openFixture(page, {
      fixtureSnapshot: activeSnapshot("terminal-live-v1"), fixtureHistory: pendingHistory,
    });
    await page.locator("[data-stream-task-id='stream-a']").first().click();
    await page.waitForFunction(() => !document.querySelector("[data-chat-live]")?.hidden);
    await page.evaluate((value) => { window.__agentHubFixture.history = value; }, finalHistory);
    await page.locator("[data-stream-task-id='stream-b']").first().click();
    await page.locator("[data-stream-task-id='stream-a']").first().click();
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Full final answer"));
    await afterPaint(page);
    assert.equal(await page.locator("[data-chat-live]").evaluate((node) => node.hidden), true,
      "canonical active-to-final history clears the live projection immediately");
    await applyFixtureSnapshot(page, activeSnapshot("terminal-live-v2"));
    await afterPaint(page);
    assert.equal(await page.locator("[data-chat-live]").evaluate((node) => node.hidden), true,
      "same exact completed turn cannot recreate an empty working card");
    assert.equal(await page.locator("[data-chat-pane]").evaluate((node) => node.textContent.includes("Ход идёт")), false,
      "the selected composer also stops projecting the completed run");

    const next = activeSnapshot("terminal-live-v3", "turn-new");
    await applyFixtureSnapshot(page, next);
    await page.waitForFunction(() => !document.querySelector("[data-chat-live]")?.hidden);
    assert.ok((await page.locator("[data-chat-live]").evaluate((node) => node.dataset.messageKey)).includes("turn-new"),
      "the visible card belongs to the new exact turn");
    const terminalRun = structuredClone(next);
    terminalRun.version = "terminal-run-revision";
    terminalRun.tasks[0].run.terminalRevision = 4;
    await applyFixtureSnapshot(page, terminalRun);
    await afterPaint(page);
    assert.equal(await page.locator("[data-chat-live]").evaluate((node) => node.hidden), true);
    const idle = structuredClone(next);
    idle.version = "terminal-live-v4";
    idle.tasks[0].running = false;
    delete idle.tasks[0].run;
    await applyFixtureSnapshot(page, idle);
    await page.waitForFunction(() => document.querySelector("[data-chat-live]")?.hidden === true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("exact positive snapshot final absorbs its run without hiding foreign or unknown finals", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const initial = activeSnapshot("snapshot-final-v1");
    const errors = await openFixture(page, { fixtureSnapshot: initial });
    await page.waitForFunction(() => !document.querySelector("[data-chat-live]")?.hidden);
    for (const [index, final] of [
      { provider: "codex", threadId: "thread-a", turnId: "previous", revision: 3 },
      { provider: "codex", threadId: "other-thread", turnId: "turn-finished", revision: 3 },
      { provider: "claude", threadId: "thread-a", turnId: "turn-finished", revision: 3 },
      { provider: "codex", threadId: "thread-a", turnId: "turn-finished", revision: 0 },
    ].entries()) {
      const next = activeSnapshot(`snapshot-final-control-${index}`);
      next.tasks[0].latestFinal = final;
      await applyFixtureSnapshot(page, next);
      await afterPaint(page);
      assert.equal(await page.locator("[data-chat-live]").evaluate((node) => node.hidden), false);
    }
    const completed = activeSnapshot("snapshot-final-completed");
    completed.tasks[0].latestFinal = {
      provider: "codex", threadId: "thread-a", turnId: "turn-finished", revision: 3,
    };
    await applyFixtureSnapshot(page, completed);
    await afterPaint(page);
    assert.equal(await page.locator("[data-chat-live]").evaluate((node) => node.hidden), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
