import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { RunCoordinator } from "../../src/application/run-coordinator.mjs";
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot, submit } from "./composer-production.fixture.mjs";

const context = vm.createContext({ Date });
vm.runInContext(await readFile(new URL("../../assets/web-app/messages/lifecycle.js", import.meta.url), "utf8"), context);
const lifecycle = context.AgentHubMessageLifecycle;

async function restartReceipt(clientUserMessageId = "restart-original") {
  let launches = 0;
  const coordinator = new RunCoordinator({
    taskRuns: { forTask: () => null }, providers: { call: () => { throw new Error("Unexpected provider call"); } },
    isRuntimeStopping: () => true, externalActivity: async () => ({ state: "inactive" }),
    repositoryConflict: async () => null,
    deferInput: async (_input, _files, options) => ({ id: "restart-deferred", item: { ...options }, duplicate: false }),
    beginRun: async () => { throw new Error("Unexpected run"); }, rollbackAdmission: async () => {},
    launchTurn: async () => { launches += 1; },
  });
  const receipt = await coordinator.acceptClientInput({
    input: "restart question", target: { provider: "codex", threadId: "thread-a", streamId: "stream-a" },
    clientUserMessageId, clientProjectionIntent: "conversation",
  });
  assert.equal(launches, 0);
  assert.equal(receipt.reason, "runtime-restart");
  assert.equal(receipt.providerAccepted, false);
  return receipt;
}

test("actual restart barrier ACK stays queue-owned despite conversation intent", async () => {
  const receipt = await restartReceipt();
  const projected = lifecycle.queueHistoryReceiptProjection(receipt);
  assert.equal(projected.ownsDeferredQueue, true);
  assert.equal(projected.ownsOptimisticConversation, false);
  assert.equal(projected.deliveryState, "queued");
  assert.equal(projected.providerAccepted, false);
  assert.match(projected.delivery, /Ожидает перезапуска Hub/u);
  const row = { id: "restart-deferred", ...receipt, conflictKind: receipt.reason, state: "queued" };
  assert.equal(lifecycle.queuedCommandUsesQueue(row, [receipt]), true);
  assert.equal(lifecycle.queuedCommandUsesQueue(row, []), true);
});

test("explicit waiting conflicts override intent without weakening intake, unknown or terminal authority", async () => {
  const receipt = await restartReceipt();
  for (const reason of ["task-running", "final-answer-active", "context-maintenance"]) {
    assert.equal(lifecycle.queueHistoryReceiptProjection({ ...receipt, reason }).ownsDeferredQueue, true);
  }
  const intake = { ...receipt, reason: "message-intake" };
  assert.equal(lifecycle.queueHistoryReceiptProjection(intake).ownsOptimisticConversation, true);
  assert.equal(lifecycle.queueHistoryReceiptProjection({ ...intake, clientProjectionIntent: "queue" }).ownsDeferredQueue, true);
  assert.equal(lifecycle.queueHistoryReceiptProjection({ ...receipt, queued: false, deferred: false, reason: "" }).ownsOptimisticConversation, true);
  const unknown = lifecycle.queueHistoryReceiptProjection({ ...receipt, unknown: true });
  assert.equal(unknown.deliveryState, "unconfirmed");
  assert.doesNotMatch(unknown.delivery, /Ожидает перезапуска/u);
  for (const terminal of ["completed", "failed", "cancelled"]) {
    const value = lifecycle.queueHistoryReceiptProjection({ ...receipt, [terminal]: true });
    assert.equal(value.ownsDeferredQueue, false);
    assert.equal(value.deliveryState, terminal);
    assert.doesNotMatch(value.delivery, /Ожидает перезапуска/u);
  }
  const accepted = lifecycle.queueHistoryReceiptProjection({ ...receipt, providerAccepted: true, turnId: "turn", runId: "run" });
  assert.equal(accepted.ownsDeferredQueue, false);
  assert.equal(accepted.deliveryState, "running");
  assert.doesNotMatch(accepted.delivery, /Ожидает перезапуска/u);
});

for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
  test(`complete client shows restart wait from ACK through reload and exact provider acceptance (${viewport.width})`, { timeout: 45_000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport });
    try {
      const diagnostics = await openFixture(page);
      if (viewport.width < 600) await page.locator("[data-mobile-button='chat']").click();
      assert.equal(new URL(page.url()).hostname, "agent-hub.test");
      assert.ok((await page.title()).length > 0);
      assert.ok((await page.locator("body").innerText()).length > 100);
      await page.evaluate(() => {
        const original = window.__agentHubVscode.postMessage.bind(window.__agentHubVscode);
        window.__agentHubVscode.postMessage = (message) => {
          if (message.action === "send-message") { window.__restartSend = message; window.__restartSends = (window.__restartSends ?? 0) + 1; return; }
          if (message.action === "snapshot" && window.__holdRestartSnapshot) { window.__restartSnapshot = message; return; }
          original(message);
        };
      });
      await submit(page, { text: "restart question" });
      await page.waitForFunction(() => Boolean(window.__restartSend));
      const clientId = await page.evaluate(() => window.__restartSend.params.clientUserMessageId);
      const receipt = await restartReceipt(clientId);
      await page.evaluate((result) => {
        window.__holdRestartSnapshot = true;
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: window.__restartSend.id, ok: true, result,
        } }));
      }, receipt);
      const rows = page.locator(".queue-item").filter({ hasText: "restart question" });
      await rows.waitFor({ state: "visible" });
      assert.match(await rows.innerText(), /Ожидает перезапуска Hub/u);
      assert.equal(await page.locator(".msg-body").filter({ hasText: "restart question" }).count(), 0);
      assert.equal(await page.locator("[data-chat-stop]:visible").count(), 0);
      assert.equal(await page.evaluate(() => window.__restartSends), 1);
      const queued = snapshot([{ ...receipt, displayText: "restart question" }]);
      queued.version = "restart-waiting";
      queued.deferredInputs = [{ ...receipt, id: "restart-deferred", text: "restart question", state: "queued",
        conflictKind: "runtime-restart", waitReason: "runtime-restart", createdAt: "2026-10-21T14:40:30.136Z" }];
      await page.evaluate((value) => {
        window.__holdRestartSnapshot = false;
        window.__agentHubFixture.snapshot = value;
        const held = window.__restartSnapshot;
        if (held) window.dispatchEvent(new MessageEvent("message", { data: { type: "agenthub:control-result", id: held.id, ok: true, result: value } }));
      }, queued);
      await applyFixtureSnapshot(page, queued);
      const canonicalRow = page.locator(".queue-item[data-queue-id='restart-deferred']");
      await canonicalRow.waitFor({ state: "visible" });
      assert.match(await canonicalRow.locator(".queue-status").innerText(), /Ожидает перезапуска Hub/u);
      assert.equal(await rows.count(), 1);
      for (const update of [{ waitReason: "task-running" }, { state: "dispatching" }]) {
        const progressed = structuredClone(queued);
        progressed.version = `restart-progress-${JSON.stringify(update)}`;
        Object.assign(progressed.deferredInputs[0], update);
        await applyFixtureSnapshot(page, progressed);
        assert.doesNotMatch(await canonicalRow.innerText(), /Ожидает перезапуска Hub/u);
        assert.equal(await rows.count(), 1);
      }
      const evicted = { ...queued, version: "restart-receipt-evicted", messageReceipts: [] };
      await applyFixtureSnapshot(page, evicted);
      await page.locator("[data-composer-input]").fill("unrelated saved draft");
      await page.reload();
      if (viewport.width < 600) await page.locator("[data-mobile-button='chat']").click();
      await canonicalRow.waitFor({ state: "visible" });
      assert.match(await canonicalRow.innerText(), /Ожидает перезапуска Hub/u);
      assert.equal(await rows.count(), 1);
      assert.equal(await page.locator("[data-composer-input]").inputValue(), "unrelated saved draft");
      assert.equal(await page.locator("[data-chat-stop]:visible").count(), 0);
      if (process.env.AGENT_HUB_TEST_SCREENSHOTS) {
        await mkdir(process.env.AGENT_HUB_TEST_SCREENSHOTS, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_TEST_SCREENSHOTS, `restart-wait-${viewport.width}.png`) });
      }
      const accepted = snapshot([{ ...receipt, queued: false, deferred: false, providerAccepted: true, turnId: "accepted-turn", runId: "accepted-run" }]);
      accepted.version = "restart-provider-accepted";
      await applyFixtureSnapshot(page, accepted);
      await canonicalRow.waitFor({ state: "hidden" });
      await page.evaluate(({ clientId }) => window.AgentHub.setMessages("stream-a", [{
        id: "provider-item", itemId: "provider-item", clientUserMessageId: clientId, provider: "codex", threadId: "thread-a",
        turnId: "accepted-turn", role: "user", text: "restart question", providerAccepted: true, projectionState: "history",
      }]), { clientId });
      await page.locator(".msg-body").filter({ hasText: "restart question" }).waitFor({ state: "visible" });
      assert.equal(await page.locator(".msg-body").filter({ hasText: "restart question" }).count(), 1);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]").filter((m) => m.action === "send-message").length), 0);
      assert.deepEqual(diagnostics, []);
    } finally { await browser.close(); }
  });
}
