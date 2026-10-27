import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFixtureSnapshot, bridgeCalls, launchBrowser, openFixture, snapshot,
} from "./composer-production.fixture.mjs";

test("shipped client retains an active card after history and traces its rendered position", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const batches = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/command-trace/client-events")) {
        batches.push(request.postDataJSON());
      }
    });
    const active = snapshot();
    active.version = "history-live-v1";
    const providerAt = new Date(Date.now() - 4_300).toISOString();
    active.tasks[0] = { ...active.tasks[0], running: true, run: {
      turnId: "turn-active", clientUserMessageId: "client-active",
      operationKind: "user-turn", projectionState: "active",
      stage: "working", progress: "Private progress",
      startedAt: "2026-10-05T07:31:04.403Z",
      providerStart: {
        turnId: "turn-active", state: "observed", phase: "working",
        requestedAt: providerAt, acceptedAt: providerAt, firstEventAt: providerAt,
      },
      userMessages: [{ role: "user", itemId: "user-active",
        clientUserMessageId: "client-active", text: "Private user message" }],
    } };
    const history = {
      provider: "codex", threadId: "thread-a", streamId: "stream-a",
      start: 0, end: 2, total: 2, messageTotal: 3, version: "history-live-v1",
      items: [
        { id: "turn-previous", completed: true, terminalRevision: 1,
          messages: [{ role: "user", itemId: "previous-user", text: "Previous question" },
            { role: "agent", itemId: "previous-final", phase: "final", text: "Previous answer" }] },
        { id: "turn-active", active: true, completed: false,
          messages: [{ role: "user", itemId: "user-active", clientUserMessageId: "client-active",
            text: "Private user message" }] },
      ],
    };
    const errors = await openFixture(page, { fixtureSnapshot: active, fixtureHistory: history });
    await page.locator("[data-stream-task-id='stream-a']").first().click();
    await page.waitForFunction(() => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.some((entry) => entry.action === "task-history" || entry.action === "open-task");
    });
    await page.waitForFunction(() => document.querySelector("[data-chat-log]")?.textContent.includes("Previous answer"));
    await page.waitForFunction(() => {
      const card = document.querySelector("[data-chat-live]");
      return card?.isConnected && !card.hidden && card.getClientRects().length > 0;
    });
    await page.waitForFunction(() => document.querySelector("[data-provider-connection-quality]")
      ?.dataset.linkState !== "unknown");
    await page.locator("[data-stream-task-id='stream-b']").first().click();
    await page.waitForFunction(() => document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "stream-b");
    await page.locator("[data-stream-task-id='stream-a']").first().click();
    await page.waitForFunction(() => document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "stream-a");
    await page.waitForFunction(() => window.AgentHubCommandTrace.diagnostics().pending > 0);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.evaluate(() => window.AgentHubCommandTrace.flush());
      if (batches.flatMap((batch) => batch.events).some((event) => (
        event.metadata?.action === "history-live-dom"
      ))) break;
      await page.waitForTimeout(50);
    }
    const events = batches.flatMap((batch) => batch.events);
    const decision = events.find((event) => event.metadata?.action === "history-live-decision"
      && event.metadata?.render === "retained" && event.metadata?.trigger === "active");
    assert.ok(decision, `active current history retains the cached live card: ${JSON.stringify(
      events.map((event) => ({ stage: event.stage, action: event.metadata?.action,
        render: event.metadata?.render, trigger: event.metadata?.trigger })),
    )}`);
    const historyRequests = await bridgeCalls(page, "task-history");
    assert.ok(historyRequests.some((request) => request.params.clientTraceId === decision.commandId),
      "render decision keeps the original history control identity");
    assert.ok(events.some((event) => event.commandId === decision.commandId
      && event.metadata?.action === "history-live-dom"
      && ["viewport", "superseded"].includes(event.metadata?.render)),
    "a later projection may supersede the history paint while the active card remains visible");
    const firstDocument = events.find((event) => event.metadata?.action === "client-document"
      && event.metadata?.render === "created");
    assert.ok(firstDocument?.metadata?.documentInstanceId);
    assert.equal(firstDocument.metadata.clientAssetRevision, "hub283.client.4");
    assert.ok(events.some((event) => event.metadata?.action === "selected-gate"
      && event.metadata?.decision === "applied"
      && event.metadata?.documentInstanceId === firstDocument.metadata.documentInstanceId
      && event.commandId === "client-active" && event.metadata?.turnId === "turn-active"));
    const noRun = structuredClone(active);
    noRun.version = "history-live-v2";
    noRun.tasks[0].running = false;
    delete noRun.tasks[0].run;
    await applyFixtureSnapshot(page, noRun);
    await page.waitForFunction(() => document.querySelector("[data-provider-connection-quality]")
      ?.dataset.linkState === "unknown"
      && document.querySelector("[data-chat-live]")?.hidden === true);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.evaluate(() => window.AgentHubCommandTrace.flush());
      if (batches.flatMap((batch) => batch.events).some((event) => (
        event.metadata?.action === "snapshot-live-dom"
        && event.metadata?.snapshotVersion === "history-live-v2"
      ))) break;
      await page.waitForTimeout(50);
    }
    const lostRun = batches.flatMap((batch) => batch.events).find((event) => (
      event.metadata?.action === "selected-gate"
      && event.metadata?.snapshotVersion === "history-live-v2"
    ));
    assert.equal(lostRun?.metadata.beforeRun, "active");
    assert.equal(lostRun?.metadata.afterRun, "idle");
    assert.equal(lostRun?.metadata.beforeProviderStart, "present");
    assert.equal(lostRun?.metadata.afterProviderStart, "missing");
    assert.equal(lostRun?.commandId, "client-active");
    assert.equal(lostRun?.metadata.beforeTurnId, "turn-active");
    assert.equal(lostRun?.metadata.afterTurnId, "");
    assert.equal(lostRun?.metadata.threadId, "thread-a");
    assert.equal(lostRun?.metadata.streamId, "stream-a");
    assert.ok(batches.flatMap((batch) => batch.events).some((event) => (
      event.commandId === "client-active"
      && event.metadata?.action === "snapshot-live-dom"
      && event.metadata?.snapshotVersion === "history-live-v2"
      && event.metadata?.render === "absent"
      && event.metadata?.providerLink === "unknown"
    )));
    const oldFinal = structuredClone(active);
    oldFinal.version = "history-live-v3";
    oldFinal.tasks[0].latestFinal = {
      provider: "codex", threadId: "thread-a", turnId: "turn-previous", revision: 1,
    };
    await applyFixtureSnapshot(page, oldFinal);
    await page.waitForFunction(() => !document.querySelector("[data-chat-live]")?.hidden
      && document.querySelector("[data-provider-connection-quality]")?.dataset.linkState !== "unknown");
    const staleFinal = structuredClone(active);
    staleFinal.version = "history-live-v4";
    staleFinal.tasks[0].latestFinal = {
      provider: "codex", threadId: "thread-a", turnId: "turn-active", revision: 0,
    };
    await applyFixtureSnapshot(page, staleFinal);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.evaluate(() => window.AgentHubCommandTrace.flush());
      if (batches.flatMap((batch) => batch.events).some((event) => (
        event.metadata?.action === "snapshot-live-dom"
        && event.metadata?.snapshotVersion === "history-live-v4"
      ))) break;
      await page.waitForTimeout(50);
    }
    assert.ok(batches.flatMap((batch) => batch.events).some((event) => (
      event.metadata?.action === "selected-gate"
      && event.metadata?.snapshotVersion === "history-live-v4"
      && event.metadata?.afterRun === "active"
      && event.metadata?.finalTurnId === "turn-active"
      && event.metadata?.finalRevision === "0"
    )));
    assert.ok(batches.flatMap((batch) => batch.events).some((event) => (
      event.metadata?.action === "snapshot-live-dom"
      && event.metadata?.snapshotVersion === "history-live-v4"
      && event.metadata?.render === "viewport"
    )));
    const restored = structuredClone(active);
    restored.version = "history-live-v5";
    await page.evaluate((value) => localStorage.setItem("fixture:snapshot", JSON.stringify(value)), restored);
    await page.reload();
    await page.waitForFunction(() => !document.querySelector("[data-chat-live]")?.hidden
      && document.querySelector("[data-provider-connection-quality]")?.dataset.linkState !== "unknown");
    const noTiming = structuredClone(active);
    noTiming.version = "history-live-v6";
    delete noTiming.tasks[0].run.providerStart;
    await applyFixtureSnapshot(page, noTiming);
    await page.waitForFunction(() => {
      const card = document.querySelector("[data-chat-live]");
      return card && !card.hidden && card.getClientRects().length > 0
        && document.querySelector("[data-provider-connection-quality]")?.dataset.linkState === "unknown";
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.evaluate(() => window.AgentHubCommandTrace.flush());
      if (batches.flatMap((batch) => batch.events).some((event) => (
        event.metadata?.action === "snapshot-live-dom"
        && event.metadata?.snapshotVersion === "history-live-v6"
      ))) break;
      await page.waitForTimeout(50);
    }
    assert.ok(batches.flatMap((batch) => batch.events).some((event) => (
      event.metadata?.action === "selected-gate"
      && event.metadata?.snapshotVersion === "history-live-v6"
      && event.metadata?.beforeRun === "active"
      && event.metadata?.afterRun === "active"
      && event.metadata?.beforeProviderStart === "present"
      && event.metadata?.afterProviderStart === "missing"
    )));
    assert.ok(batches.flatMap((batch) => batch.events).some((event) => (
      event.metadata?.action === "snapshot-live-dom"
      && event.metadata?.snapshotVersion === "history-live-v6"
      && event.metadata?.render === "viewport"
      && event.metadata?.providerLink === "unknown"
    )));
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.evaluate(() => window.AgentHubCommandTrace.flush());
      if (batches.flatMap((batch) => batch.events).filter((event) => (
        event.metadata?.action === "client-document" && event.metadata?.render === "created"
      )).length >= 2) break;
      await page.waitForTimeout(50);
    }
    const documentEvents = batches.flatMap((batch) => batch.events)
      .filter((event) => event.metadata?.action === "client-document"
        && event.metadata?.render === "created");
    const documentIds = documentEvents.map((event) => event.metadata.documentInstanceId);
    assert.equal(new Set(documentIds).size, 2, "a reload creates a new client document identity");
    assert.equal(documentEvents[1].metadata.previousDocumentInstanceId,
      documentEvents[0].metadata.documentInstanceId,
      "the next document identifies its predecessor even if pagehide telemetry is lost");
    assert.doesNotMatch(JSON.stringify(events), /Private user message|Private progress/u);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
});

test("history paint reports superseded when a newer snapshot replaces the same Stream card", {
  timeout: 30_000,
}, async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const batches = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/api/command-trace/client-events")) {
        batches.push(request.postDataJSON());
      }
    });
    const inactive = snapshot();
    inactive.version = "history-race-v0";
    const active = structuredClone(inactive);
    active.version = "history-race-v1";
    active.tasks[0] = { ...active.tasks[0], running: true, run: {
      turnId: "turn-race", clientUserMessageId: "client-race",
      operationKind: "user-turn", projectionState: "active",
      stage: "working", progress: "Private progress",
    } };
    const history = {
      provider: "codex", threadId: "thread-a", streamId: "stream-a",
      start: 0, end: 1, total: 1, messageTotal: 1, version: "history-race-v1",
      items: [{ id: "turn-race", active: true, completed: false,
        messages: [{ role: "user", itemId: "user-race", clientUserMessageId: "client-race",
          text: "Private user message" }] }],
    };
    const errors = await openFixture(page, { fixtureSnapshot: inactive, fixtureHistory: history });
    await page.locator("[data-stream-task-id='stream-b']").first().click();
    await page.waitForFunction(() => document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "stream-b");
    const openedBefore = (await bridgeCalls(page, "open-task")).length;
    await page.evaluate((value) => {
      window.__agentHubFixture.snapshot = value;
      localStorage.setItem("fixture:snapshot", JSON.stringify(value));
      window.__heldFrames = [];
      window.requestAnimationFrame = (callback) => {
        window.__heldFrames.push(callback);
        return window.__heldFrames.length;
      };
    }, active);
    await page.locator("[data-stream-task-id='stream-a']").first().click();
    await page.waitForFunction((count) => {
      const log = JSON.parse(localStorage.getItem("fixture:bridge-log") ?? "[]");
      return log.filter((entry) => entry.action === "open-task").length > count
        && document.querySelector("[data-chat-pane]")?.dataset.streamChatTaskId === "stream-a"
        && window.__heldFrames.length > 0;
    }, openedBefore);
    const opened = (await bridgeCalls(page, "open-task")).at(-1);
    const hasOriginalDecision = (batch) => batch?.events?.some((event) => (
      event.commandId === opened.params.clientTraceId
      && event.metadata?.action === "history-live-decision"
    ));
    // The bridge logs a request before delivering its asynchronous response.
    // Hold the exact history decision's paint, not an unrelated shell frame.
    if (!batches.some(hasOriginalDecision)) {
      await page.waitForRequest((request) => (
        request.url().endsWith("/api/command-trace/client-events")
        && hasOriginalDecision(request.postDataJSON())
      ));
    }
    const newer = structuredClone(active);
    newer.version = "history-race-v2";
    newer.tasks[0].running = false;
    delete newer.tasks[0].run;
    await applyFixtureSnapshot(page, newer);
    await page.waitForFunction(() => document.querySelector("[data-chat-live]")?.hidden === true);
    await page.evaluate(() => {
      for (let round = 0; round < 4; round += 1) {
        const pending = window.__heldFrames.splice(0);
        for (const callback of pending) callback(performance.now());
      }
    });
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await page.evaluate(() => window.AgentHubCommandTrace.flush());
      if (batches.flatMap((batch) => batch.events).some((event) => (
        event.commandId === opened.params.clientTraceId
        && event.metadata?.action === "history-live-dom"
      ))) break;
      await page.waitForTimeout(50);
    }
    const historyPaints = batches.flatMap((batch) => batch.events).filter((event) => (
      event.commandId === opened.params.clientTraceId
      && event.metadata?.action === "history-live-dom"
    ));
    assert.ok(historyPaints.length > 0, "the original history command has a post-paint outcome");
    assert.ok(historyPaints.every((event) => event.metadata.render === "superseded"),
      "the old history request must not own newer card DOM");
    assert.deepEqual(errors, []);
    await page.close();
  } finally {
    await browser.close();
  }
});
