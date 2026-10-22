import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import vm from "node:vm";
import {
  launchBrowser, openFixture, snapshot, applyFixtureSnapshot, submit,
} from "./composer-production.fixture.mjs";

const assets = process.env.AGENT_HUB_TEST_WEB_APP_ROOT
  ? pathToFileURL(`${process.env.AGENT_HUB_TEST_WEB_APP_ROOT.replace(/[\\/]+$/u, "")}/`)
  : new URL("../../assets/web-app/", import.meta.url);
const context = vm.createContext({ Date, URL });
for (const relative of ["messages/projection.js", "messages/lifecycle.js"]) {
  vm.runInContext(await readFile(new URL(relative, assets), "utf8"), context);
}
const lifecycle = context.AgentHubMessageLifecycle;
const projection = context.AgentHubMessageProjection;
const plain = (value) => JSON.parse(JSON.stringify(value));

test("immediate durable ACK uses the accepted label while explicit queued intent stays queued", () => {
  const intake = { accepted: true, deferred: true, queued: true,
    reason: "message-intake", clientProjectionIntent: "conversation" };
  const accepted = lifecycle.queueHistoryReceiptProjection(intake);
  assert.equal(accepted.deliveryState, "accepted");
  assert.match(accepted.delivery, /^Сохранено в Hub/u);
  assert.equal(accepted.providerAccepted, false);
  assert.equal(accepted.ownsDeferredQueue, false);
  const queued = lifecycle.queueHistoryReceiptProjection({ ...intake, clientProjectionIntent: "queue" });
  assert.equal(queued.deliveryState, "queued");
  assert.match(queued.delivery, /^В очереди/u);
  assert.equal(queued.ownsDeferredQueue, true);
  const unknown = lifecycle.queueHistoryReceiptProjection({ ...intake, unknown: true });
  assert.equal(unknown.deliveryState, "unconfirmed");
  assert.equal(unknown.ownsDeferredQueue, true);
});

test("provider preparation keeps occupancy but actual exact acceptance starts running before text", () => {
  const run = { id: "run", operationKind: "user-turn", projectionState: "active",
    clientUserMessageId: "client", turnId: null, providerStart: { state: "requesting", turnId: null } };
  assert.deepEqual(plain(projection.userRunActivity(run)), {
    running: false, canStop: true, unknown: false, preparing: true,
  });
  const accepted = { ...run, turnId: "turn", response: "", providerStart: {
    state: "accepted-awaiting-first-event", turnId: "turn", clientUserMessageId: "client",
  } };
  assert.deepEqual(plain(projection.userRunActivity(accepted)), { running: true, canStop: true, unknown: false });
  const foreign = { ...accepted, providerStart: { ...accepted.providerStart, turnId: "other" } };
  assert.equal(projection.userRunActivity(foreign).running, false);
  assert.equal(projection.userRunActivity(foreign).canStop, true);
  assert.equal(projection.userRunActivity({ ...accepted, projectionState: "completed" }).canStop, false);
  const unknown = projection.userRunActivity({ ...run, activityUnknown: true });
  assert.equal(unknown.running, false);
  assert.equal(unknown.canStop, true);
  assert.equal(unknown.unknown, true);
  assert.equal(lifecycle.activeRunSubmissionTiming({ ...accepted, startedAt: "2026-10-21T09:00:00Z",
    providerStart: { ...accepted.providerStart, acceptedAt: "2026-10-21T09:01:00Z" } }).startedAt,
  "2026-10-21T09:01:00Z");
  assert.equal(lifecycle.activeRunSubmissionTiming(run).startedAt, null);
});

test("legacy actual accepted-bound replies and terminal monotonicity keep their authority", () => {
  const receipt = { accepted: true, runId: "legacy-run", turnId: "legacy-turn" };
  assert.equal(lifecycle.queueHistoryReceiptProjection(receipt).providerAccepted, true);
  assert.equal(lifecycle.queueHistoryReceiptProjection(receipt).deliveryState, "running");
  const explicitlyUnaccepted = lifecycle.queueHistoryReceiptProjection({ ...receipt,
    providerAccepted: false, started: true });
  assert.equal(explicitlyUnaccepted.providerAccepted, false);
  assert.equal(explicitlyUnaccepted.deliveryState, "accepted");
  const run = { operationKind: "user-turn", projectionState: "active", turnId: "legacy-turn" };
  assert.equal(projection.userRunActivity(run).running, true);
  const terminal = { role: "user", provider: "codex", threadId: "thread", turnId: "turn",
    clientUserMessageId: "client", projectionAuthority: "canonical", projectionState: "completed",
    terminalRevision: 2, deliveryState: "completed", delivery: "Ход завершён" };
  const late = { ...terminal, projectionAuthority: "live", projectionState: "active",
    terminalRevision: null, deliveryState: "running", delivery: "Ход выполняется" };
  assert.equal(projection.reduceProjectionEntity(terminal, late).projectionState, "completed");
});

async function screenshot(page, name) {
  const directory = process.env.AGENT_HUB_TEST_SCREENSHOTS;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, `${name}.png`), fullPage: false });
}

for (const viewport of [{ width: 1366, height: 900 }, { width: 390, height: 844 }]) {
  test(`complete client exposes local sending and ACK before held snapshot (${viewport.width})`, { timeout: 45_000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport });
    try {
      const diagnostics = await openFixture(page);
      if (viewport.width < 600) await page.locator("[data-mobile-button='chat']").click();
      assert.equal(new URL(page.url()).hostname, "agent-hub.test");
      assert.ok((await page.title()).length > 0);
      assert.ok((await page.locator("body").textContent()).length > 100);
      await page.evaluate(() => {
        window.__feedbackTimes = {};
        const original = window.__agentHubVscode.postMessage.bind(window.__agentHubVscode);
        window.__agentHubVscode.postMessage = (message) => {
          if (message.action === "send-message") {
            window.__heldFeedbackSend = message;
            window.__feedbackTimes.submittedAt = message.params.clientTiming.submittedMonotonicMs;
            window.__feedbackTimes.transportAt = performance.now();
            window.__feedbackSends = (window.__feedbackSends ?? 0) + 1;
            return;
          }
          if (message.action === "snapshot" && window.__holdFeedbackSnapshot) {
            window.__heldFeedbackSnapshot = message;
            return;
          }
          original(message);
        };
      });
      await submit(page, { text: "feedback original" });
      await page.waitForFunction(() => Boolean(window.__heldFeedbackSend));
      const card = page.locator(".msg").filter({ has: page.locator(".msg-body", { hasText: "feedback original" }) });
      assert.equal(await card.count(), 1);
      assert.match(await card.locator(".msg-delivery").textContent(), /Отправляется|Подготовка/u);
      await page.evaluate(() => { window.__feedbackTimes.sendingObservedAt = performance.now(); });
      const clientId = await page.evaluate(() => window.__heldFeedbackSend.params.clientUserMessageId);
      await screenshot(page, `sending-${viewport.width}`);
      await page.evaluate(() => {
        window.__holdFeedbackSnapshot = true;
        const message = window.__heldFeedbackSend;
        window.__feedbackTimes.ackAt = performance.now();
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: message.id, ok: true, result: {
            accepted: true, deferred: true, queued: true, reason: "message-intake",
            clientProjectionIntent: "conversation", provider: "codex", threadId: "thread-a",
            streamId: "stream-a", clientUserMessageId: message.params.clientUserMessageId,
          },
        } }));
      });
      await page.waitForFunction(() => Boolean(window.__heldFeedbackSnapshot));
      await screenshot(page, `ack-before-assert-${viewport.width}`);
      assert.match(await card.locator(".msg-delivery").textContent(), /^Сохранено в Hub/u);
      assert.equal(await card.getAttribute("data-delivery-state"), "accepted");
      await page.evaluate(() => { window.__feedbackTimes.acceptedObservedAt = performance.now(); });
      assert.equal(await page.evaluate(() => window.__feedbackSends), 1);
      await screenshot(page, `durable-ack-${viewport.width}`);
      const pending = snapshot();
      pending.version = "feedback-preparing";
      pending.messageReceipts = [{ accepted: true, deferred: true, queued: true, reason: "message-intake",
        clientProjectionIntent: "conversation", provider: "codex", threadId: "thread-a", streamId: "stream-a",
        clientUserMessageId: clientId, displayText: "feedback original" }];
      pending.tasks[0] = { ...pending.tasks[0], running: true, run: {
        id: "feedback-run", operationKind: "user-turn", projectionState: "active", turnId: null,
        clientUserMessageId: clientId, prompt: "feedback original", response: "",
        providerStart: { state: "requesting", turnId: null, clientUserMessageId: clientId },
      } };
      await page.evaluate((value) => {
        window.__holdFeedbackSnapshot = false;
        window.__agentHubFixture.snapshot = value;
        const held = window.__heldFeedbackSnapshot;
        window.dispatchEvent(new MessageEvent("message", { data: {
          type: "agenthub:control-result", id: held.id, ok: true, result: value,
        } }));
      }, pending);
      await applyFixtureSnapshot(page, pending);
      const stop = page.locator("[data-chat-stop]").filter({ visible: true });
      assert.ok(await stop.count() > 0);
      assert.ok((await page.locator(".stream-tab[data-stream-task-id='stream-a']").getAttribute("title"))?.includes("Подготовка"));
      await screenshot(page, `preparing-${viewport.width}`);
      const started = structuredClone(pending);
      started.version = "feedback-provider-accepted";
      started.tasks[0].run.turnId = "feedback-turn";
      started.tasks[0].run.providerStart = { state: "accepted-awaiting-first-event", turnId: "feedback-turn",
        clientUserMessageId: clientId, acceptedAt: "2026-10-21T10:00:00.000Z" };
      started.messageReceipts = [{ ...pending.messageReceipts[0], deferred: false, queued: false,
        providerAccepted: true, turnId: "feedback-turn", runId: "feedback-run" }];
      await page.evaluate(() => { window.__feedbackTimes.providerAcceptedAt = performance.now(); });
      await applyFixtureSnapshot(page, started);
      assert.ok((await page.locator(".stream-tab[data-stream-task-id='stream-a']").getAttribute("title"))?.includes("Ход выполняется"));
      assert.equal(await card.count(), 1);
      await page.evaluate(async () => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.__feedbackTimes.runningPaintObservedAt = performance.now();
      });
      await screenshot(page, `running-empty-${viewport.width}`);
      const finished = structuredClone(started);
      finished.version = "feedback-completed-without-commentary";
      finished.tasks[0].running = false;
      finished.tasks[0].run = null;
      finished.messageReceipts = [{ ...started.messageReceipts[0], completed: true, commandState: "completed",
        terminalRevision: 1 }];
      await applyFixtureSnapshot(page, finished);
      assert.match(await card.locator(".msg-delivery").textContent(), /Ход завершён/u);
      assert.equal(await page.locator("[data-chat-stop]").filter({ visible: true }).count(), 0);
      assert.equal(await page.evaluate(() => window.__feedbackSends), 1);
      const staleIntake = structuredClone(finished);
      staleIntake.version = "feedback-late-intake";
      staleIntake.messageReceipts = pending.messageReceipts;
      await applyFixtureSnapshot(page, staleIntake);
      assert.match(await card.locator(".msg-delivery").textContent(), /Ход завершён/u);
      const times = await page.evaluate(() => window.__feedbackTimes);
      const measurement = { viewport, kind: "isolated-canonical-event-dom-observation",
        milliseconds: {
          submitToObservedSending: times.sendingObservedAt - times.submittedAt,
          ackToObservedAccepted: times.acceptedObservedAt - times.ackAt,
          providerAcceptanceInjectionToRunningPaintObservation: times.runningPaintObservedAt - times.providerAcceptedAt,
        },
        limits: "Controlled provider receipt/snapshot injection; includes fixture refresh and browser roundtrips; not live provider latency or production SLO.",
      };
      if (process.env.AGENT_HUB_TEST_SCREENSHOTS) await writeFile(path.join(process.env.AGENT_HUB_TEST_SCREENSHOTS,
        `observations-${viewport.width}.json`), `${JSON.stringify(measurement, null, 2)}\n`);
      console.log(`feedback-DOM ${JSON.stringify(measurement)}`);
      assert.deepEqual(diagnostics, []);
    } finally { await page.close(); await browser.close(); }
  });
}

test("preparing admission keeps second input queued and provider rejection never claims running", { timeout: 40_000 }, async () => {
  const browser = await launchBrowser();
  const page = await browser.newPage();
  try {
    const initial = snapshot();
    initial.tasks[0] = { ...initial.tasks[0], running: true, run: {
      id: "pending-run", operationKind: "user-turn", projectionState: "active", turnId: null,
      clientUserMessageId: "first", prompt: "first pending", response: "",
      providerStart: { state: "requesting", turnId: null, clientUserMessageId: "first" },
    } };
    const diagnostics = await openFixture(page, { fixtureSnapshot: initial });
    await page.evaluate(() => {
      const original = window.__agentHubVscode.postMessage.bind(window.__agentHubVscode);
      window.__agentHubVscode.postMessage = (message) => {
        if (message.action === "send-message") { window.__secondPreparingSend = message; return; }
        original(message);
      };
    });
    await submit(page, { text: "second queued" });
    await page.waitForFunction(() => Boolean(window.__secondPreparingSend));
    const params = await page.evaluate(() => window.__secondPreparingSend.params);
    assert.equal(params.clientProjectionIntent, "queue");
    assert.equal(params.followUpMode, "queue");
    const failed = structuredClone(initial);
    failed.version = "provider-rejected";
    failed.tasks[0].running = false;
    failed.tasks[0].run = null;
    failed.messageReceipts = [{ provider: "codex", threadId: "thread-a", streamId: "stream-a",
      clientUserMessageId: "first", displayText: "first pending", accepted: true,
      failed: true, commandState: "failed", providerAccepted: false, clientProjectionIntent: "conversation" }];
    await applyFixtureSnapshot(page, failed);
    assert.doesNotMatch(await page.locator(".stream-tab[data-stream-task-id='stream-a']").getAttribute("title"), /Ход выполняется/u);
    assert.deepEqual(diagnostics, []);
  } finally { await page.close(); await browser.close(); }
});

for (const state of ["completed", "failed", "cancelled"]) {
  test(`exact ${state} original absorbs late no-turn preparation but a new command remains occupied`, { timeout: 40_000 }, async () => {
    const browser = await launchBrowser();
    const page = await browser.newPage();
    try {
      const receipt = { provider: "codex", threadId: "thread-a", streamId: "stream-a",
        clientUserMessageId: "terminal-command", runId: "terminal-run", turnId: "terminal-turn",
        accepted: true, [state]: true, commandState: state, terminalRevision: 1,
        displayText: "terminal original" };
      const final = snapshot([receipt]);
      const diagnostics = await openFixture(page, { fixtureSnapshot: final });
      const late = structuredClone(final);
      late.version = `late-${state}-preparation`;
      late.tasks[0] = { ...late.tasks[0], running: true, run: {
        id: "terminal-run", provider: "codex", threadId: "thread-a", operationKind: "user-turn",
        clientUserMessageId: "terminal-command", projectionState: "active", turnId: null,
        prompt: "terminal original", response: "", providerStart: { state: "requesting", turnId: null },
      } };
      await applyFixtureSnapshot(page, late);
      const stop = page.locator("[data-chat-stop]").filter({ visible: true });
      assert.equal(await stop.count(), 0);
      assert.doesNotMatch(await page.locator("[data-chat-live]").innerText(), /Подготовка хода/u);
      for (const control of ["new-command", "different-run", "foreign-thread", "unknown"]) {
        const current = structuredClone(late);
        current.version = `${state}-${control}`;
        if (control === "new-command") {
          current.tasks[0].run.id = "new-run";
          current.tasks[0].run.clientUserMessageId = "new-command";
          current.tasks[0].run.prompt = "new preparation";
        } else if (control === "different-run") current.messageReceipts[0].runId = "other-run";
        else if (control === "foreign-thread") current.messageReceipts[0].threadId = "other-thread";
        else current.messageReceipts = [{ ...receipt, [state]: false, commandState: "unknown", unknown: true }];
        await applyFixtureSnapshot(page, current);
        assert.equal(await stop.count(), 1, control);
        assert.match(await page.locator("[data-chat-live]").innerText(), /Подготовка хода/u, control);
      }
      assert.deepEqual(diagnostics, []);
    } finally { await page.close(); await browser.close(); }
  });
}
