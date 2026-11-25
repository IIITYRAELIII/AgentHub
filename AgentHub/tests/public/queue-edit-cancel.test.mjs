import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { launchBrowser, openFixture, snapshot, bridgeCalls, submit, applyFixtureSnapshot } from "./composer-production.fixture.mjs";

const webAppRoot = process.env.AGENT_HUB_EDIT_TEST_WEB_APP_ROOT
  ? pathToFileURL(`${process.env.AGENT_HUB_EDIT_TEST_WEB_APP_ROOT.replace(/[\\/]+$/u, "")}/`)
  : new URL("../../assets/web-app/", import.meta.url);
const originalId = "original-edit-command";
const originalItem = "original-queue-item";
const oldReceipt = {
  provider: "codex", threadId: "thread-a", streamId: "stream-a",
  clientUserMessageId: originalId, id: originalItem,
  accepted: false, providerAccepted: false, queued: true,
  deferred: true, pending: false, clientProjectionIntent: "queue",
  displayText: "Original queued text",
};

async function openEditFixture(page) {
  const initial = snapshot([oldReceipt]);
  initial.deferredInputs = [{
    id: originalItem, clientUserMessageId: originalId,
    provider: "codex", threadId: "thread-a", streamId: "stream-a",
    state: "queued", text: oldReceipt.displayText, clientProjectionIntent: "queue",
  }];
  const source = await readFile(new URL("hub-client.js", webAppRoot), "utf8");
  const boundary = source.lastIndexOf("})();");
  // References only: retained legacy client state is seeded in the isolated
  // browser. Production code still owns every projection and DOM transition.
  const hooks = `window.__editQueue = { rememberOutgoing, deliveryPatch,
    optimisticDeferredClientUserMessageIds, deferredIds: () => deferredClientUserMessageIds,
    renderTaskQueue, renderTaskMessages, applySnapshotContent, updateOutgoing,
    snapshot: () => lastSnapshot, outgoingByTask, handlers: window.__editQueueHandlers };`;
  const captureHandlers = `window.__editQueueHandlers = {};
    const queueTestOn = window.AgentHub.on;
    window.AgentHub.on = (name, handler) => {
      window.__editQueueHandlers[name] = handler;
      return queueTestOn(name, handler);
    };`;
  const errors = await openFixture(page, { fixtureSnapshot: initial, webAppRoot,
    assetOverrides: { "hub-client.js": captureHandlers + source.slice(0, boundary) + hooks + source.slice(boundary) } });
  await page.evaluate(({ originalId, originalItem }) => {
    const prior = window.__fixtureBridge.postMessage.bind(window.__fixtureBridge);
    const fixture = window.__agentHubFixture;
    const respond = (message, result, error = "") => window.dispatchEvent(new MessageEvent("message", {
      data: { type: "agenthub:control-result", id: message.id, ok: !error, result, error },
    }));
    window.__fixtureBridge.postMessage = (message) => {
      if (!["deferred-input", "send-message"].includes(message.action)) return prior(message);
      fixture.log.push(structuredClone(message));
      localStorage.setItem("fixture:bridge-log", JSON.stringify(fixture.log));
      const params = message.params;
      if (message.action === "deferred-input") {
        if (params.id !== originalItem) return respond(message, {}, "Saved message already processed");
        if (params.action === "composer-prepare") return respond(message, {
          token: "transfer-token", binding: { provider: "codex", threadId: "thread-a", streamId: "stream-a" },
          draft: { text: "Original queued text", attachments: [], taskReferences: [], annotations: [] },
        });
        if (params.action === "composer-commit" || params.action === "cancel") {
          if (params.action === "cancel" && !fixture.snapshot.deferredInputs.some((item) => item.id === params.id)) {
            return respond(message, {}, "Saved message already processed");
          }
          fixture.snapshot.deferredInputs = [];
          fixture.snapshot.messageReceipts[0] = {
            ...fixture.snapshot.messageReceipts[0], cancelled: true,
          };
          fixture.snapshot.version = "canonical-old-cancelled";
          localStorage.setItem("fixture:snapshot", JSON.stringify(fixture.snapshot));
          return respond(message, params.action === "cancel"
            ? { accepted: true, id: originalItem, clientUserMessageId: originalId, cancelled: true }
            : { accepted: true, id: originalItem, committed: true });
        }
        return respond(message, {});
      }
      const replacement = {
        provider: "codex", threadId: "thread-a", streamId: "stream-a",
        clientUserMessageId: params.clientUserMessageId,
        accepted: true, providerAccepted: true, steered: true,
        queued: false, deferred: false, pending: false,
        turnId: "replacement-turn", runId: "replacement-run",
        displayText: params.displayText,
      };
      fixture.snapshot.messageReceipts.push(replacement);
      fixture.snapshot.version = "canonical-replacement-accepted";
      localStorage.setItem("fixture:snapshot", JSON.stringify(fixture.snapshot));
      respond(message, replacement);
    };
    const local = {
      id: `local:${originalId}`, role: "user", provider: "codex", threadId: "thread-a", streamId: "stream-a",
      clientUserMessageId: originalId, text: "Original queued text", providerAccepted: false,
      projectionState: "queued", ...window.__editQueue.deliveryPatch("queued"),
    };
    window.__editQueue.rememberOutgoing("stream-a", local);
    window.__editQueue.optimisticDeferredClientUserMessageIds.add(originalId);
    window.__editQueue.renderTaskQueue("stream-a");
  }, { originalId, originalItem });
  return errors;
}

test("edit and accepted resend keep the cancelled original retired on cached receipt restoration", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = await openEditFixture(page);
    await page.locator(`[data-queue-id='${originalItem}'] [data-action='queue-edit']`).click();
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Original queued text");
    await page.locator("[data-composer-input]").fill("Edited replacement text");
    await submit(page, { text: "Edited replacement text" });
    await page.waitForFunction(() => window.__agentHubFixture.snapshot.messageReceipts.length === 2);
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "");
    const sends = await bridgeCalls(page, "send-message");
    assert.equal(sends.length, 1);
    assert.notEqual(sends[0].params.clientUserMessageId, originalId);
    assert.deepEqual(sends[0].params.composerTransfer, { id: originalItem, token: "transfer-token" });
    assert.equal(sends[0].params.displayText, "Edited replacement text");
    await page.evaluate((id) => {
      const h = window.__editQueue;
      // A prior client record can finish restoration after canonical receipt
      // materialization. Reconcile using the already-cached exact receipt.
      h.rememberOutgoing("stream-a", {
        id: `local:${id}`, role: "user", provider: "codex", threadId: "thread-a", streamId: "stream-a",
        clientUserMessageId: id, text: "Original queued text", projectionState: "queued",
        projectionAuthority: "canonical", itemId: "original-queue-item",
        providerAccepted: false, ...h.deliveryPatch("queued"),
      });
      h.optimisticDeferredClientUserMessageIds.add(id);
      h.deferredIds().add(id);
      h.applySnapshotContent(h.snapshot());
      h.renderTaskQueue("stream-a"); h.renderTaskMessages("stream-a");
    }, originalId);
    assert.equal(await page.locator("[data-queue-id]").count(), 0,
      "cancelled original returned as a queue card with an unusable cancel action");
    assert.equal(await page.locator("[data-chat-pane]").getByText("Edited replacement text", { exact: true }).count(), 1);
    assert.equal((await bridgeCalls(page, "send-message")).length, 1);
    assert.equal((await bridgeCalls(page, "deferred-input")).filter((entry) => entry.params.action === "cancel").length, 0);
    await page.evaluate((id) => {
      const h = window.__editQueue;
      h.updateOutgoing("stream-a", id, { providerAccepted: false, projectionState: "queued", ...h.deliveryPatch("queued") });
      h.renderTaskQueue("stream-a"); h.renderTaskMessages("stream-a");
    }, originalId);
    assert.equal(await page.locator("[data-queue-id]").count(), 0);
    await page.locator("[data-composer-input]").fill("Independent unsent draft");
    if (process.env.AGENT_HUB_QUEUE_EDIT_QA_DIR) {
      await mkdir(process.env.AGENT_HUB_QUEUE_EDIT_QA_DIR, { recursive: true });
      for (const width of [1366, 390]) {
        await page.setViewportSize({ width, height: 900 });
        if (width < 600) await page.locator("[data-mobile-button='chat']").click();
        await page.locator("[data-chat-pane]").waitFor({ state: "visible" });
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_QUEUE_EDIT_QA_DIR, `edit-send-${width}.png`) });
      }
    }
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.AgentHub?.composerRecoveryDiagnostics?.().restored === true);
    assert.equal(await page.locator("[data-queue-id]").count(), 0);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "Independent unsent draft");
    assert.equal((await bridgeCalls(page, "send-message")).length, 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("ordinary cancel addresses the live queue item once and keeps an unrelated composer draft", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = await openEditFixture(page);
    await page.locator("[data-composer-input]").fill("Independent unsent draft");
    await page.locator(`[data-queue-id='${originalItem}'] [data-action='queue-remove']`).click();
    await page.waitForFunction(() => window.__agentHubFixture.snapshot.messageReceipts[0].cancelled === true);
    await page.waitForFunction(() => document.querySelectorAll("[data-queue-id]").length === 0);
    const calls = (await bridgeCalls(page, "deferred-input")).filter((entry) => entry.params.action === "cancel");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].params.id, originalItem);
    assert.equal((await bridgeCalls(page, "send-message")).length, 0);
    assert.equal(await page.locator("[data-composer-input]").inputValue(), "Independent unsent draft");
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("a second cancel click after the ACK and before snapshot readback sends no duplicate", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = await openEditFixture(page);
    await page.evaluate(() => {
      const bridge = window.__fixtureBridge;
      const post = bridge.postMessage.bind(bridge);
      const held = [];
      bridge.postMessage = (message) => {
        if (message.action === "snapshot") held.push(message);
        else post(message);
      };
      window.__heldQueueSnapshots = held;
      window.__failQueueSnapshots = () => {
        for (const message of held.splice(0)) window.dispatchEvent(new MessageEvent("message", {
          data: { type: "agenthub:control-result", id: message.id, ok: false, error: "Queue readback interrupted" },
        }));
      };
      window.__releaseQueueSnapshots = () => {
        bridge.postMessage = post;
        for (const message of held) post(message);
      };
    });
    const button = page.locator(`[data-queue-id='${originalItem}'] [data-action='queue-remove']`);
    await button.click();
    await page.waitForFunction((id) => window.__heldQueueSnapshots.some((request) => (
      request.action === "snapshot"
    )) && window.__agentHubFixture.snapshot.messageReceipts[0].cancelled === true
      && !window.__editQueue.outgoingByTask.get("stream-a")?.has(id), originalId);
    try {
      if (await button.isVisible()) await button.click();
      await page.evaluate(() => window.__failQueueSnapshots());
      await page.waitForFunction(() => window.__toastHistory?.includes("Queue readback interrupted"));
      await button.click();
    } finally {
      await page.evaluate(() => window.__releaseQueueSnapshots());
    }
    const next = await page.evaluate(() => window.__agentHubFixture.snapshot);
    await applyFixtureSnapshot(page, next);
    await button.waitFor({ state: "detached" });
    const calls = (await bridgeCalls(page, "deferred-input")).filter((entry) => entry.params.action === "cancel");
    assert.equal(calls.length, 1, "already cancelled item was sent to the owner twice");
    assert.equal(calls[0].params.id, originalItem);
    assert.equal(calls[0].params.clientUserMessageId, originalId);
    assert.ok(calls[0].params.clientTraceId);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("a receipt-only local queue card cancels the exact item once while snapshot is delayed", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = await openEditFixture(page);
    const stale = await page.evaluate(() => {
      const h = window.__editQueue;
      const bridge = window.__fixtureBridge;
      const post = bridge.postMessage.bind(bridge);
      const held = [];
      bridge.postMessage = (message) => {
        if (message.action === "snapshot") held.push(message);
        else post(message);
      };
      window.__heldReceiptOnlySnapshots = held;
      window.__releaseReceiptOnlySnapshots = () => {
        bridge.postMessage = post;
        for (const message of held) post(message);
      };
      const stale = { ...h.snapshot(), deferredInputs: [], version: "receipt-only-queue" };
      h.applySnapshotContent(stale);
      h.renderTaskQueue("stream-a");
      return stale;
    });
    const alias = `local:${originalId}`;
    const button = page.locator(`[data-queue-id='${alias}'] [data-action='queue-remove']`);
    try {
      await button.click();
      await page.waitForFunction((id) => window.__heldReceiptOnlySnapshots.length > 0
        && window.__agentHubFixture.snapshot.messageReceipts[0].cancelled === true
        && !window.__editQueue.outgoingByTask.get("stream-a")?.has(id), originalId);
      if (await button.isVisible()) await button.click();
      else await page.evaluate((id) => window.__editQueue.handlers["queue:remove"]({
        id, taskId: "stream-a",
      }), alias);
      const calls = (await bridgeCalls(page, "deferred-input")).filter((entry) => entry.params.action === "cancel");
      assert.equal(calls.length, 1, "receipt-only card sent a second cancel using its local alias");
      assert.equal(calls[0].params.id, originalItem);
      assert.equal(calls[0].params.clientUserMessageId, originalId);
      assert.ok(calls[0].params.clientTraceId);
      await button.waitFor({ state: "detached" });
      await page.evaluate((oldSnapshot) => {
        const h = window.__editQueue;
        h.applySnapshotContent(oldSnapshot);
        h.renderTaskQueue("stream-a");
      }, stale);
      assert.equal(await button.count(), 0, "stale queued receipt restored a card after exact cancel acknowledgement");
    } finally {
      await page.evaluate(() => window.__releaseReceiptOnlySnapshots());
    }
    await page.waitForFunction(() => window.__editQueue.snapshot().messageReceipts[0].cancelled === true);
    assert.equal(await button.count(), 0);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

for (const evidence of ["unknown", "foreign"]) {
  test(`${evidence} receipt cannot certify an old local card cancelled`, { timeout: 30_000 }, async () => {
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await openEditFixture(page);
      const current = snapshot([{ ...oldReceipt, deferred: false,
        ...(evidence === "unknown" ? { unknown: true } : { cancelled: true, streamId: "stream-b", threadId: "thread-b" }) }]);
      current.version = `canonical-negative-${evidence}`;
      current.deferredInputs = [];
      await applyFixtureSnapshot(page, current);
      await page.evaluate((id) => {
        const h = window.__editQueue;
        h.rememberOutgoing("stream-a", { id: `local:${id}`, role: "user", provider: "codex",
          threadId: "thread-a", streamId: "stream-a", clientUserMessageId: id,
          text: "Original queued text", providerAccepted: false,
          projectionAuthority: "canonical", projectionState: "queued", itemId: "original-queue-item",
          ...h.deliveryPatch("queued") });
        h.optimisticDeferredClientUserMessageIds.add(id);
        h.renderTaskQueue("stream-a");
      }, originalId);
      await page.locator("[data-composer-input]").fill("Keep this draft");
      assert.equal(await page.evaluate((id) => window.__editQueue.outgoingByTask.get("stream-a").has(id), originalId), true);
      await page.evaluate((id) => window.__editQueue.handlers["queue:remove"]({
        taskId: "stream-a", id: `local:${id}`,
      }), originalId);
      const state = await page.evaluate((id) => ({
        present: window.__editQueue.outgoingByTask.get("stream-a").has(id),
        receipts: window.__editQueue.snapshot().messageReceipts,
        calls: window.__agentHubFixture.log.filter((entry) => entry.action === "deferred-input"),
        notices: window.__toastHistory,
      }), originalId);
      assert.equal(state.present, true, JSON.stringify(state));
      assert.equal((await bridgeCalls(page, "send-message")).length, 0);
      assert.equal((await bridgeCalls(page, "deferred-input")).filter((entry) => entry.params.action === "cancel").length, 1);
      assert.equal(await page.locator("[data-composer-input]").inputValue(), "Keep this draft");
      assert.equal(await page.getByText("Сообщение уже отменено", { exact: true }).count(), 0);
    } finally { await browser.close(); }
  });
}

test("cancel on an already retired local card reconciles the canonical cancellation without cancelling again", { timeout: 30_000 }, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = await openEditFixture(page);
    await page.locator(`[data-queue-id='${originalItem}'] [data-action='queue-edit']`).click();
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "Original queued text");
    await submit(page, { text: "Edited replacement text" });
    await page.waitForFunction(() => window.__agentHubFixture.snapshot.messageReceipts.length === 2);
    await page.waitForFunction(() => document.querySelector("[data-composer-input]")?.value === "");
    await page.evaluate((id) => {
      const h = window.__editQueue;
      h.rememberOutgoing("stream-a", {
        id: `local:${id}`, role: "user", provider: "codex", threadId: "thread-a", streamId: "stream-a",
        clientUserMessageId: id, text: "Original queued text", projectionState: "queued",
        projectionAuthority: "canonical", itemId: "original-queue-item",
        providerAccepted: false, ...h.deliveryPatch("queued"),
      });
      h.optimisticDeferredClientUserMessageIds.add(id);
      h.renderTaskQueue("stream-a");
    }, originalId);
    const cancellationsBefore = (await bridgeCalls(page, "deferred-input"))
      .filter((entry) => entry.params.action === "cancel").length;
    const button = page.locator(`[data-queue-id='local:${originalId}'] [data-action='queue-remove']`);
    if (await button.count()) await button.click();
    else await page.evaluate((id) => window.__editQueue.handlers["queue:remove"]({
      taskId: "stream-a", id: `local:${id}`,
    }), originalId);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator("[data-queue-id]").count(), 0,
      "cancel action left the canonically cancelled card visible");
    assert.equal((await bridgeCalls(page, "deferred-input"))
      .filter((entry) => entry.params.action === "cancel").length, cancellationsBefore,
      "a terminal cancellation was sent again using a local display alias");
    assert.equal((await bridgeCalls(page, "send-message")).length, 1);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});
