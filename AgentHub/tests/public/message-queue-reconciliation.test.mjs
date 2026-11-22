import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot, bridgeCalls } from "./composer-production.fixture.mjs";

const clientId = "confirmed-old-command";
const accepted = {
  provider: "codex", threadId: "thread-old", streamId: "stream-a",
  clientUserMessageId: clientId, accepted: true, providerAccepted: true,
  pending: false, deferred: false, queued: false, clientProjectionIntent: "conversation",
  runId: "run-original", turnId: "turn-original",
};

async function openQueueFixture(page, options = {}) {
  const errors = await openFixture(page, options);
  const source = await readFile(new URL("../../assets/web-app/hub-client.js", import.meta.url), "utf8");
  // Export references only in the isolated fixture to seed a state retained by
  // an older client. The complete production client still owns reconciliation.
  const end = source.lastIndexOf("})();");
  const hooks = `window.__queueHarness = { rememberOutgoing, deliveryPatch,
    optimisticDeferredClientUserMessageIds, historyByTask, renderTaskQueue,
    renderTaskMessages, updateOutgoing, applySnapshotContent,
    snapshot: () => lastSnapshot, deferredIds: () => deferredClientUserMessageIds };`;
  await page.route("**/hub-client.js", (route) => route.fulfill({
    contentType: "text/javascript", body: source.slice(0, end) + hooks + source.slice(end),
  }));
  await page.reload({ waitUntil: "load" });
  await page.waitForFunction(() => window.__queueHarness
    && window.AgentHub?.composerRecoveryDiagnostics?.().restored === true);
  return errors;
}

async function seedGhost(page, { proven = false } = {}) {
  await page.evaluate(({ id, proven }) => {
    const { rememberOutgoing, deliveryPatch, optimisticDeferredClientUserMessageIds,
      renderTaskQueue, renderTaskMessages } = window.__queueHarness;
    rememberOutgoing("stream-a", {
      id: `local:${id}`, role: "user", provider: "codex", threadId: "thread-old", streamId: "stream-a",
      clientUserMessageId: id, text: "Confirmed historical submission",
      providerAccepted: proven, turnId: proven ? "turn-original" : "",
      projectionState: proven ? "active" : "queued", ...deliveryPatch("accepted"),
    });
    optimisticDeferredClientUserMessageIds.add(id);
    window.__queueHarness.deferredIds().add(id);
    renderTaskQueue("stream-a"); renderTaskMessages("stream-a");
  }, { id: clientId, proven });
}

test("full client retires a restored old-Thread ghost on cached receipt reconciliation and reload", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  try {
    const initial = snapshot([accepted]);
    initial.version = "receipt-before-local-restoration";
    const errors = await openQueueFixture(page, { fixtureSnapshot: initial });
    assert.ok((await page.title()).trim());
    assert.equal(page.url(), "http://agent-hub.test/");
    await seedGhost(page);
    assert.equal(await page.locator(".queue-item").count(), 1);
    // Same collection objects: no intermediate snapshot containing the active
    // source Thread was observed, and the old history is outside the loaded page.
    await page.evaluate(() => window.__queueHarness.applySnapshotContent(window.__queueHarness.snapshot(), { materialized: true }));
    assert.equal(await page.locator(".queue-item").count(), 0);
    assert.equal(await page.locator(".msg-user").filter({ hasText: "Confirmed historical submission" }).count(), 1);
    await page.evaluate((id) => {
      const { optimisticDeferredClientUserMessageIds, updateOutgoing, deliveryPatch,
        renderTaskQueue, renderTaskMessages } = window.__queueHarness;
      optimisticDeferredClientUserMessageIds.add(id);
      window.__queueHarness.deferredIds().add(id);
      updateOutgoing("stream-a", id, { providerAccepted: false, turnId: "", projectionState: "unknown",
        ...deliveryPatch("unconfirmed"), retryRequest: { old: true } });
      renderTaskQueue("stream-a"); renderTaskMessages("stream-a");
    }, clientId);
    assert.equal(await page.locator(".queue-item").count(), 0);
    const next = snapshot([]); next.version = "receipt-evicted-after-reconnect";
    await applyFixtureSnapshot(page, next);
    await page.waitForFunction(() => window.__queueHarness.snapshot().version === "receipt-evicted-after-reconnect");
    assert.equal(await page.locator(".queue-item").count(), 0);
    await page.locator("[data-composer-input]").fill("Unsent unrelated draft");
    for (const width of [1366, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) await page.locator('[data-mobile-button="chat"]').click();
      assert.equal(await page.locator(".queue-item").count(), 0);
      if (process.env.AGENT_HUB_QUEUE_QA_DIR) {
        await mkdir(process.env.AGENT_HUB_QUEUE_QA_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_QUEUE_QA_DIR, `reconciled-${width}.png`) });
      }
    }
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.AgentHub?.composerRecoveryDiagnostics?.().restored === true);
    assert.equal(await page.locator(".queue-item").count(), 0);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "Unsent unrelated draft");
    assert.equal((await bridgeCalls(page, "send-message")).length, 0, "reconciliation and reload never send");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

for (const focusedOnly of [false, true]) test(`canonical ${focusedOnly ? "focused message" : "history page"} retires the ghost without reload`, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const errors = await openQueueFixture(page);
    await page.evaluate((focusedOnly) => {
      const bridge = window.__agentHubVscode;
      const original = bridge.postMessage.bind(bridge);
      bridge.postMessage = (request) => {
        if (request.action !== "open-turn") return original(request);
        window.__agentHubFixture.log.push(structuredClone(request));
        localStorage.setItem("fixture:bridge-log", JSON.stringify(window.__agentHubFixture.log));
        const history = { provider: "codex", threadId: "thread-old", streamId: "stream-a",
          items: [], start: 0, end: 0, total: 0, messageTotal: 0, version: "focused-old-source" };
        if (!focusedOnly) history.items = [{
          provider: "codex", threadId: "thread-old", id: "turn-original", completed: true, status: "completed",
          messages: [{ role: "user", itemId: "original-item", clientUserMessageId: "confirmed-old-command",
            text: "Confirmed historical submission" }],
        }];
        const result = { history, snapshot: window.__agentHubFixture.snapshot, focusedTurn: {
          provider: "codex", taskThreadId: "thread-old", threadId: "thread-old", turnThreadId: "thread-old",
          turnId: "turn-original", status: "completed", completed: true,
          messages: [{ role: "user", itemId: "original-item", clientUserMessageId: "confirmed-old-command",
            text: "Confirmed historical submission" }],
        } };
        setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: request.id, ok: true, result,
        } })), 0);
      };
    }, focusedOnly);
    await seedGhost(page);
    assert.equal(await page.locator(".queue-item").count(), 1);
    await page.evaluate(() => { location.hash = "#/chat/codex/thread-old/turn/thread-old/turn-original"; });
    await page.waitForFunction(() => document.querySelector(".msg-user")?.textContent.includes("Confirmed historical submission"));
    await page.waitForFunction(() => !document.querySelector(".queue-item"));
    assert.equal(await page.locator(".msg-user").filter({ hasText: "Confirmed historical submission" }).count(), 1);
    const calls = await bridgeCalls(page, "open-turn");
    const { clientTraceId, clientTiming, ...target } = calls.at(-1).params;
    assert.deepEqual(target, { provider: "codex", taskThreadId: "thread-old",
      turnThreadId: "thread-old", turnId: "turn-original", limit: 20 });
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("full client uses exact history evidence while preserving an unrelated unknown command", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const errors = await openQueueFixture(page);
    await seedGhost(page);
    await page.evaluate(() => {
      const { rememberOutgoing, deliveryPatch, historyByTask, renderTaskMessages,
        renderTaskQueue } = window.__queueHarness;
      rememberOutgoing("stream-a", {
        id: "local:unconfirmed-other", role: "user", provider: "codex", threadId: "thread-a",
        clientUserMessageId: "unconfirmed-other", text: "Unconfirmed separate submission",
        providerAccepted: false, projectionState: "unknown", ...deliveryPatch("unconfirmed"),
      });
      historyByTask.set("stream-a", [{
        id: "historical-item", role: "user", provider: "codex", threadId: "thread-old",
        turnId: "turn-original", itemId: "item-original", clientUserMessageId: "confirmed-old-command",
        text: "Confirmed historical submission",
      }]);
      renderTaskMessages("stream-a"); renderTaskQueue("stream-a");
    });
    assert.equal(await page.locator(".queue-item").count(), 1);
    assert.match(await page.locator(".queue-item").innerText(), /Unconfirmed separate submission/u);
    assert.equal(await page.locator(".msg-user").filter({ hasText: "Confirmed historical submission" }).count(), 1);
    await applyFixtureSnapshot(page, { ...snapshot([accepted]), version: "history-before-receipt" });
    assert.equal(await page.locator(".queue-item").count(), 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("full client retires both cached same-turn steers and absorbs their late ACKs", async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  const ids = ["first-steer", "second-steer"];
  try {
    const initial = snapshot(ids.map((clientUserMessageId) => ({
      ...accepted, threadId: "thread-a", clientUserMessageId, steered: true,
    })));
    const errors = await openQueueFixture(page, { fixtureSnapshot: initial });
    await page.evaluate((ids) => {
      const h = window.__queueHarness;
      for (const id of ids) {
        h.rememberOutgoing("stream-a", {id:`local:${id}`,role:"user",provider:"codex",threadId:"thread-a",
          streamId:"stream-a",clientUserMessageId:id,text:`Steer ${id}`,providerAccepted:false,
          projectionState:"queued",...h.deliveryPatch("queued")});
        h.optimisticDeferredClientUserMessageIds.add(id); h.deferredIds().add(id);
      }
      h.renderTaskQueue("stream-a");h.renderTaskMessages("stream-a");
    }, ids);
    assert.equal(await page.locator(".queue-item").count(), 2);
    await page.evaluate(() => window.__queueHarness.applySnapshotContent(
      window.__queueHarness.snapshot(), {materialized:true}));
    assert.equal(await page.locator(".queue-item").count(), 0);
    for (const id of ids) assert.equal(await page.locator(".msg-user").filter({hasText:`Steer ${id}`}).count(), 1);
    if (process.env.AGENT_HUB_QUEUE_QA_DIR) {
      await mkdir(process.env.AGENT_HUB_QUEUE_QA_DIR,{recursive:true});
      await page.screenshot({path:path.join(process.env.AGENT_HUB_QUEUE_QA_DIR,"two-steers-reconciled.png")});
    }
    await page.evaluate((ids) => {
      const h = window.__queueHarness;
      for (const id of ids) {
        h.optimisticDeferredClientUserMessageIds.add(id);h.deferredIds().add(id);
        h.updateOutgoing("stream-a",id,{providerAccepted:false,turnId:"",projectionState:"queued",
          ...h.deliveryPatch("queued")});
      }
      h.renderTaskQueue("stream-a");h.renderTaskMessages("stream-a");
    }, ids);
    assert.equal(await page.locator(".queue-item").count(), 0);
    for (const id of ids) assert.equal(await page.locator(".msg-user").filter({hasText:`Steer ${id}`}).count(), 1);
    assert.equal((await bridgeCalls(page,"send-message")).length, 0);
    assert.equal((await bridgeCalls(page,"cancel-deferred-input")).length, 0);
    assert.deepEqual(errors, []);
  } finally {await browser.close();}
});
