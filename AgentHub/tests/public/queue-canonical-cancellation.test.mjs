import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RuntimeStateStore } from "../../src/infrastructure/persistence/runtime-state-store.mjs";
import { MessageCommandLedgerStore } from "../../src/infrastructure/persistence/message-command-ledger-store.mjs";
import { MessageReceiptRegistry } from "../../src/infrastructure/persistence/message-receipts.mjs";
import { DesktopDeferredInputService } from "../../src/interfaces/desktop/desktop-deferred-input-service.mjs";
import { DeferredComposerTransferRegistry } from "../../src/application/deferred-composer-transfer-registry.mjs";
import { launchBrowser, openFixture, snapshot, applyFixtureSnapshot, submit } from "./composer-production.fixture.mjs";

async function renderedCancellation(mode, surface = "vscode") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hub422-rendered-cancel-"));
  const store = new RuntimeStateStore({ dataDir: directory });
  const external = new MessageCommandLedgerStore({ dataDir: directory });
  const registry = new MessageReceiptRegistry();
  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const ids = ["release:original:1441:operation.resumed", "release:original:1444:operation.resumed"];
  const items = ids.map((clientUserMessageId, index) => ({
    id: `retained-event-${index}`, clientUserMessageId,
    provider: "codex", threadId: "thread-a", streamId: "stream-a", projectRoot: directory,
    input: `Synthetic retained event ${index}`, createdAt: new Date().toISOString(),
    conflictKind: "message-intake", temporaryFiles: [], persistentFiles: true,
  }));
  const cancellations = new Map();
  const wire = id => {
    const receipt = store.projectMessageReceipt({ clientUserMessageId: id });
    if (receipt.result?.cancelled && !cancellations.has(id)) cancellations.set(id, {
      clientUserMessageId: id, canonicalCommittedAtMs: store.messageCommand(id).terminalAtMs,
      canonicalProjectionAtMs: Date.now(),
    });
    return { ...receipt.result, provider: receipt.provider, threadId: receipt.threadId,
      clientUserMessageId: id, createdAt: receipt.createdAt };
  };
  try {
    for (const item of items) {
      registry.reserve(item, `fingerprint-${item.id}`, { id: item.id, streamId: item.streamId,
        accepted: true, queued: true, deferred: true, providerAccepted: false, displayText: item.input });
      await store.saveDeferredIntake({ item, destination: "queued", receipt: registry.get(item) });
    }
    const initial = snapshot(ids.map(wire));
    const assetOverrides = process.env.AGENT_HUB_TEST_CANCEL_PARENT_CLIENT
      ? { "hub-client.js": await readFile(process.env.AGENT_HUB_TEST_CANCEL_PARENT_CLIENT, "utf8") } : {};
    const diagnostics = await openFixture(page, { fixtureSnapshot: initial, assetOverrides, surface });
    await page.waitForFunction(() => document.querySelectorAll("[data-queue-id]").length >= 2, undefined, { timeout: 5000 });
    const requests = [];
    let sequence = 0;
    let projectedAt = null;
    const unused = () => assert.fail("Cancellation cannot launch or retarget a provider command");
    const service = new DesktopDeferredInputService({
      pendingInputs: new Map(), queuedInputs: new Map(),
      findDurableInput: identity => store.deferredInputForCancellation(identity),
      persistCancellation: item => store.cancelDeferredInput(item),
      isProcessing: () => false, cancelSchedule: () => false,
      saveState: unused, updateReceipt: () => {}, cleanupFiles: async () => {},
      updateMessage: async () => {}, scheduleNext: () => {}, scheduleQueued: unused,
      selectTask: unused, clientContext: unused, startTurn: unused, startDeferred: unused,
      runForTask: unused, describeAttachments: unused, selectedTask: unused,
      dispatchCommand: unused, activeTitle: unused, snapshot: unused,
      composerTransfers: new DeferredComposerTransferRegistry(),
    });
    const cancelInput = async params => {
      assert.equal(params.action, "cancel");
      const original = items.find(item => item.id === params.id);
      assert.equal(params.clientUserMessageId, original?.clientUserMessageId);
      const result = await service.handle(params);
      wire(params.clientUserMessageId);
      return result;
    };
    const readSnapshot = params => {
      requests.push(params.messageReceiptIds ?? []);
      // These 120 later receipts are the bounded recent projection. Neither
      // original is present unless the real client requests its exact identity.
      const recent = Array.from({ length: 120 }, (_, index) => ({ provider: "codex", threadId: "thread-b",
        streamId: "stream-b", clientUserMessageId: `later-${index}`, accepted: true }));
      projectedAt ??= Date.now();
      const result = snapshot([...recent.slice(-100), ...(params.messageReceiptIds ?? []).map(wire)]);
      result.version = `canonical-${++sequence}`;
      return result;
    };
    await page.exposeFunction("cancelCanonicalQueueInput", cancelInput);
    await page.exposeFunction("readCanonicalQueueSnapshot", readSnapshot);
    if (surface === "web") await page.route("**/api/control", async route => {
      const { action, params } = route.request().postDataJSON();
      if (!["snapshot", "deferred-input"].includes(action)) return route.fallback();
      const result = action === "snapshot" ? readSnapshot(params) : await cancelInput(params);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, result }) });
    });
    if (surface === "web") await page.route("**/api/snapshot*", route => route.fulfill({
      contentType: "application/json", body: JSON.stringify(readSnapshot({})),
    }));
    if (surface === "vscode") await page.evaluate(() => {
      const original = window.__agentHubVscode.postMessage;
      window.__agentHubVscode.postMessage = message => {
        if (!["snapshot", "deferred-input"].includes(message.action)) return original(message);
        const result = message.action === "snapshot"
          ? window.readCanonicalQueueSnapshot(message.params) : window.cancelCanonicalQueueInput(message.params);
        void result.then(result => {
          window.dispatchEvent(new MessageEvent("message", {
            data: { type: "agenthub:control-result", id: message.id, ok: true, result },
          }));
          window.__canonicalQueueReplies = (window.__canonicalQueueReplies ?? 0) + 1;
        });
      };
    });
    const committedAt = Date.now();
    if (mode === "external") {
      for (const item of items) external.cancelQueuedInput(item);
      assert.ok(items.every(item => store.messageCommand(item.clientUserMessageId).state === "cancelled"));
      await page.locator("[data-provider-connection-retry]").evaluate(button => button.click());
    } else {
      for (const id of ids) await page.locator(`[data-action="queue-remove"][data-queue-id="local:${id}"]`).click();
    }
    await page.waitForFunction(() => document.querySelectorAll("[data-queue-id]").length === 0, undefined, { timeout: 5000 });
    const removedAt = Date.now();
    if (mode === "external") assert.ok(requests.some(requested => ids.every(id => requested.includes(id))));
    assert.equal(await page.locator(".queue-head:visible").count(), 0);
    assert.equal(await page.locator("[data-queue-id]").count(), 0);
    assert.ok(projectedAt >= committedAt);
    assert.equal(diagnostics.length, 0);
    // A subsequent snapshot cannot turn explicit cancellations back into queue
    // entries. Existing response-generation fencing owns late response ordering.
    const previousReplies = surface === "vscode" ? await page.evaluate(() => window.__canonicalQueueReplies) : 0;
    const httpRefresh = surface === "web" ? page.waitForResponse(response => response.url().includes("/api/snapshot")) : null;
    await page.locator("[data-provider-connection-retry]").evaluate(button => button.click());
    if (surface === "vscode") await page.waitForFunction(previous => window.__canonicalQueueReplies > previous,
      previousReplies, { timeout: 5000 });
    if (httpRefresh) await httpRefresh;
    await page.waitForFunction(() => document.querySelectorAll("[data-queue-id]").length === 0);
    assert.ok(items.every(item => store.messageCommand(item.clientUserMessageId).state === "cancelled"));
    if (process.env.AGENT_HUB_TEST_ARTIFACT_DIR) {
      await mkdir(process.env.AGENT_HUB_TEST_ARTIFACT_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.AGENT_HUB_TEST_ARTIFACT_DIR, `queue-cancelled-${surface}-${mode}.png`), fullPage: true });
    }
    const observed = [...cancellations.values()].map(value => ({ ...value,
      renderedRemovalUpperBoundAtMs: removedAt, canonicalToRenderedUpperBoundMs: removedAt - value.canonicalCommittedAtMs,
    }));
    assert.equal(observed.length, ids.length);
    assert.ok(observed.every(value => value.canonicalCommittedAtMs <= value.canonicalProjectionAtMs
      && value.canonicalProjectionAtMs <= value.renderedRemovalUpperBoundAtMs));
    console.log(JSON.stringify({ cancellationStartedAtMs: committedAt, receiptProjectionAtMs: projectedAt,
      renderedRemovalAtMs: removedAt, observed, mode, surface, retainedQueueCards: 0 }));
  } finally {
    await page.close();
    await browser.close();
    external.close();
    await store.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("rendered queue reconciles exact cancellations beyond the recent receipt window", { timeout: 30000 },
  () => renderedCancellation("external"));
test("rendered canonical queue cancels through the public owner when its RAM projection is absent", { timeout: 30000 },
  () => renderedCancellation("public"));
test("browser HTTP snapshots carry addressed receipt IDs through the existing control POST", { timeout: 30000 },
  () => renderedCancellation("external", "web"));

for (const surface of ["vscode", "web"]) {
  test(`provider acceptance before the original ACK cannot revive a saved queue card (${surface})`, { timeout: 45000 }, async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "hub474-receipt-order-"));
    const store = new RuntimeStateStore({ dataDir: directory });
    const browser = await launchBrowser();
    const viewport = surface === "web" ? { width: 390, height: 844 } : { width: 1280, height: 900 };
    const page = await browser.newPage({ viewport, hasTouch: surface === "web" });
    const traceEvents = [];
    page.on("request", request => {
      if (request.url().endsWith("/api/command-trace/client-events")) {
        traceEvents.push(...(request.postDataJSON()?.events ?? []));
      }
    });
    const text = "Synthetic equal text, distinct commands";
    const identity = { provider: "codex", threadId: "thread-a", streamId: "stream-a" };
    const base = { ...identity, accepted: true, queued: true, deferred: true, providerAccepted: false,
      clientProjectionIntent: "queue", displayText: text };
    const controls = [
      { ...base, clientUserMessageId: "equal-text-twin", id: "twin", state: "queued" },
      { ...base, clientUserMessageId: "unknown-original", id: "unknown", state: "unknown", unknown: true },
      { ...base, clientUserMessageId: "paused-original", id: "paused", state: "paused", paused: true },
    ];
    let current = snapshot(controls);
    current.deferredInputs = controls.map(value => ({ ...value, text, createdAt: "2026-11-18T04:00:00.000Z" }));
    const refresh = async value => {
      if (surface === "vscode") return applyFixtureSnapshot(page, value);
      const received = page.waitForResponse(response => response.url().includes("/api/snapshot")
        || response.url().endsWith("/api/control") && response.request().postDataJSON()?.action === "snapshot");
      await page.evaluate(next => {
        window.__agentHubFixture.snapshot = next;
        localStorage.setItem("fixture:snapshot", JSON.stringify(next));
        document.querySelector("[data-provider-connection-retry]").click();
      }, value);
      await (await received).finished();
    };
    try {
      const assetOverrides = process.env.AGENT_HUB_TEST_CANCEL_PARENT_CLIENT
        ? { "hub-client.js": await readFile(process.env.AGENT_HUB_TEST_CANCEL_PARENT_CLIENT, "utf8") } : {};
      const errors = await openFixture(page, { fixtureSnapshot: current, surface, assetOverrides });
      if (surface === "web") await page.evaluate(() => window.AgentHub.showSelectedTask());
      assert.equal(new URL(page.url()).hostname, "agent-hub.test");
      assert.ok((await page.title()).includes("Agent Hub"));
      await page.locator(".queue-item[data-queue-id='twin']").waitFor({ state: "visible" });
      await page.evaluate(() => {
        const bridge = window.__fixtureBridge;
        const original = bridge.postMessage.bind(bridge);
        bridge.postMessage = message => {
          if (message.action === "snapshot" && message.params.knownVersion === window.__agentHubFixture.snapshot.version) {
            window.__cached474 = (window.__cached474 ?? 0) + 1;
            window.dispatchEvent(new MessageEvent("message", { data: {
              type: "agenthub:control-result", id: message.id, ok: true,
              result: { notModified: true, version: window.__agentHubFixture.snapshot.version },
            } }));
            return;
          }
          if (message.action === "send-message") {
            window.__held474 = message;
            localStorage.setItem("fixture:held-474-count", String(Number(localStorage.getItem("fixture:held-474-count")) + 1));
            return;
          }
          original(message);
        };
      });
      if (surface === "web") await page.route("**/api/snapshot*", async route => {
        const knownVersion = new URL(route.request().url()).searchParams.get("knownVersion");
        const result = await page.evaluate(known => {
          const current = window.__agentHubFixture.snapshot;
          if (known !== current.version) return current;
          window.__cached474 = (window.__cached474 ?? 0) + 1;
          return { notModified: true, version: current.version };
        }, knownVersion);
        await route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
      });
      await submit(page, { text });
      await page.waitForFunction(() => Boolean(window.__held474));
      const clientUserMessageId = await page.evaluate(() => window.__held474.params.clientUserMessageId);
      const queued = { ...base, clientUserMessageId, id: "original-intake" };
      const item = { ...identity, clientUserMessageId, id: queued.id, input: text, projectRoot: directory,
        createdAt: "2026-11-18T04:13:45.320Z", temporaryFiles: [], persistentFiles: true };
      await store.saveDeferredIntake({ item, destination: "queued", receipt: {
        ...identity, clientUserMessageId, fingerprint: "exact-test-command", result: queued,
      } });
      const accepted = { ...queued, queued: false, deferred: false, providerAccepted: true,
        steered: true, runId: "actual-test-run", turnId: "actual-test-turn" };
      const committed = await store.transitionMessageCommand({ clientUserMessageId, state: "started", result: accepted });
      assert.equal(committed.changed, true);
      const durable = store.projectMessageReceipt({ ...identity, clientUserMessageId });
      assert.equal(durable.result.providerAccepted, true);
      const wire = { ...durable.result, ...identity, clientUserMessageId, createdAt: durable.createdAt };
      current = { ...current, version: "provider-accepted-before-ack", messageReceipts: [...controls, wire] };
      const receiptAt = Date.now();
      await refresh(current);
      await page.locator(`.msg[data-delivery-state='running']`).waitFor({ state: "visible" });
      // The delayed response is the genuine earlier intake shape, not a new send.
      const cachedBeforeAck = await page.evaluate(() => window.__cached474 ?? 0);
      await page.evaluate(result => {
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: window.__held474.id, ok: true, result,
        } }));
      }, queued);
      await page.waitForFunction(before => window.__cached474 > before, cachedBeforeAck);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.locator(`[data-queue-id="local:${clientUserMessageId}"]`).count(), 0);
      await page.evaluate(async () => {
        while (window.AgentHubCommandTrace.diagnostics().pending) await window.AgentHubCommandTrace.flush();
      });
      assert.ok(traceEvents.some(event => event.commandId === clientUserMessageId
        && event.stage === "ui-render" && event.metadata?.action === "message-ack-projection"
        && event.metadata.render === "conversation" && event.outcome === "succeeded"));
      const paintedAt = Date.now();
      assert.equal(await page.locator(".queue-item").count(), controls.length);
      assert.equal(await page.locator(`.msg[data-delivery-state='running']`).count(), 1);
      assert.equal((await page.locator(`.msg[data-delivery-state='running'] .msg-body`).innerText()).trim(), text);
      await refresh({ ...current, version: "reconnect-repeated-positive" });
      await page.reload();
      if (surface === "web") await page.evaluate(() => window.AgentHub.showSelectedTask());
      await page.locator(".queue-item[data-queue-id='twin']").waitFor({ state: "visible" });
      await page.locator(`.msg[data-delivery-state='running']`).waitFor({ state: "visible" });
      assert.equal(await page.locator(".queue-item").count(), controls.length);
      assert.equal(await page.locator(`.msg[data-delivery-state='running']`).count(), 1);
      assert.equal(store.messageCommand(clientUserMessageId).state, "started");
      assert.equal(await page.evaluate(() => Number(localStorage.getItem("fixture:held-474-count"))), 1);
      assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]")
        .filter(message => message.action === "send-message").length), 0);
      assert.deepEqual(errors, []);
      if (process.env.AGENT_HUB_TEST_ARTIFACT_DIR) {
        await mkdir(process.env.AGENT_HUB_TEST_ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AGENT_HUB_TEST_ARTIFACT_DIR, `accepted-receipt-${surface}.png`) });
      }
      console.log(JSON.stringify({ surface, viewport, clientUserMessageId, receiptAt, paintedAt,
        receiptToPaintUpperBoundMs: paintedAt - receiptAt, retainedUnconfirmedCards: controls.length, providerDispatches: 0 }));
    } finally {
      await browser.close();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
